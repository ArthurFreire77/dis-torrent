//! Conjunto de confiança embutido, verificação 2-de-3 e rotação de chaves.
//!
//! As chaves privadas NUNCA existem neste repositório: o arquivo
//! `trust_keys.rs` nasce vazio e a cerimônia offline
//! (`tools/release-trust/ceremony.mjs`) o preenche fora do Git. Enquanto estiver
//! vazio, o cliente opera fail-closed: nenhuma release é considerada
//! verificada.

use serde::{Deserialize, Serialize};

use super::manifest::{ManifestSignature, SignedManifest, MANIFEST_MAGIC, MAX_MANIFEST_BYTES};
use crate::{DistorrentError, Result};

/// Mínimo de assinaturas de chaves DIFERENTES para autorizar qualquer coisa.
pub const MIN_THRESHOLD: u8 = 2;
pub const TRUST_EPOCH_MAX: u64 = 1_000_000;
pub const TRUST_KEYS_MAX: usize = 5;
pub const ROTATION_DOMAIN: &[u8] = b"distorrent/v1|trust-rotation|";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustedKey {
    /// blake3(pubkey)[..8] hex — só identificador, não é segredo.
    pub key_id: String,
    pub pubkey_hex: String,
}

impl TrustedKey {
    pub fn from_pubkey_hex(pubkey_hex: &str) -> Result<Self> {
        let bytes = hex::decode(pubkey_hex).map_err(|_| err("pubkey da autoridade não é hex"))?;
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| err("pubkey da autoridade precisa ter 32 bytes"))?;
        let hash = blake3::hash(&arr);
        Ok(Self {
            key_id: hex::encode(&hash.as_bytes()[..8]),
            pubkey_hex: hex::encode(arr),
        })
    }

    fn validate(&self) -> Result<()> {
        let derived = Self::from_pubkey_hex(&self.pubkey_hex)?;
        if derived.key_id != self.key_id {
            return Err(err("key_id não corresponde à pubkey"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustSet {
    pub epoch: u64,
    pub threshold: u8,
    pub keys: Vec<TrustedKey>,
}

impl TrustSet {
    pub fn validate(&self) -> Result<()> {
        if self.epoch == 0 || self.epoch > TRUST_EPOCH_MAX {
            return Err(err("epoch do conjunto de confiança fora da faixa"));
        }
        if self.keys.len() < MIN_THRESHOLD as usize || self.keys.len() > TRUST_KEYS_MAX {
            return Err(err("quantidade de chaves de confiança fora da faixa"));
        }
        if self.threshold < MIN_THRESHOLD || self.threshold as usize > self.keys.len() {
            return Err(err("limiar de assinaturas inválido"));
        }
        for k in &self.keys {
            k.validate()?;
        }
        for w in self.keys.windows(2) {
            if w[0].key_id >= w[1].key_id {
                return Err(err("chaves fora de ordem/duplicadas"));
            }
        }
        Ok(())
    }

    pub fn key(&self, key_id: &str) -> Option<&TrustedKey> {
        self.keys.iter().find(|k| k.key_id == key_id)
    }

    pub fn has_key(&self, key_id: &str) -> bool {
        self.key(key_id).is_some()
    }

    /// Verifica as assinaturas de um manifesto contra ESTE conjunto.
    ///
    /// Regras:
    /// - assinatura de chave desconhecida é ignorada (e contada);
    /// - duas entradas com o mesmo key_id contam UMA vez (senão 2 entradas da
    ///   mesma chave passariam o limiar);
    /// - assinatura inválida de chave conhecida derruba a verificação inteira,
    ///   porque presença de assinatura falsa indica adulteração, não ruído.
    pub fn verify_signatures(&self, payload: &[u8; 32], sigs: &[ManifestSignature]) -> Result<u8> {
        let mut seen: Vec<&str> = Vec::new();
        let mut valid = 0u8;
        for s in sigs {
            let Some(key) = self.key(&s.key_id) else {
                continue;
            };
            if seen.contains(&key.key_id.as_str()) {
                continue;
            }
            let ok = crate::identity::Keypair::verify(&key.pubkey_hex, payload, &s.sig)?;
            if !ok {
                return Err(err("assinatura de release inválida"));
            }
            seen.push(&key.key_id);
            valid += 1;
        }
        Ok(valid)
    }
}

/// Atualização assinada do conjunto de confiança (rotação/revogação).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrustUpdate {
    /// Epoch do conjunto que assina (precisa ser o atual).
    pub from_epoch: u64,
    pub new_set: TrustSet,
    /// Versões revogadas por esta autoridade, somadas às do manifesto.
    pub revoked_versions: Vec<String>,
    pub effective_ms: i64,
    pub reason: String,
    pub signatures: Vec<ManifestSignature>,
}

impl TrustUpdate {
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.new_set.validate()?;
        if self.from_epoch == 0 {
            return Err(err("epoch de origem da rotação inválida"));
        }
        if self.new_set.epoch <= self.from_epoch {
            return Err(err("rotação precisa avançar a epoch"));
        }
        if !valid_text(&self.reason, 512) {
            return Err(err("justificativa da rotação inválida"));
        }
        if self.revoked_versions.len() > 512 {
            return Err(err("lista de revogação grande demais"));
        }
        let mut w = Vec::new();
        w.extend_from_slice(MANIFEST_MAGIC);
        w.extend_from_slice(b"ROT");
        w.extend_from_slice(&self.from_epoch.to_be_bytes());
        w.extend_from_slice(&self.new_set.epoch.to_be_bytes());
        w.push(self.new_set.threshold);
        w.extend_from_slice(&(self.new_set.keys.len() as u32).to_be_bytes());
        for k in &self.new_set.keys {
            push_str(&mut w, &k.key_id);
            push_str(&mut w, &k.pubkey_hex);
        }
        w.extend_from_slice(&(self.revoked_versions.len() as u32).to_be_bytes());
        for v in &self.revoked_versions {
            push_str(&mut w, v);
        }
        w.extend_from_slice(&self.effective_ms.to_be_bytes());
        push_str(&mut w, &self.reason);
        Ok(w)
    }

    pub fn signing_payload(&self) -> Result<[u8; 32]> {
        let mut h = blake3::Hasher::new();
        h.update(ROTATION_DOMAIN);
        h.update(&self.canonical_bytes()?);
        Ok(*h.finalize().as_bytes())
    }

    /// Decodifica o arquivo produzido por `tools/release-trust/rotate-keys.mjs`:
    /// `canonical_bytes` (payload) seguido do bloco de assinaturas
    /// (`u32 count`, e por assinatura `u32 len + key_id`, `u32 len + sig hex`).
    ///
    /// O payload sozinho é recusado — uma rotação sem assinatura nunca deve
    /// nem entrar no fluxo de aplicação.
    pub fn from_wire(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(err("rotação acima do limite"));
        }
        let mut d = WireDec::new(bytes);
        if d.take(5)? != MANIFEST_MAGIC {
            return Err(err("magic da rotação inválido"));
        }
        if d.take(3)? != b"ROT" {
            return Err(err("tag de rotação inválida"));
        }
        let from_epoch = d.u64()?;
        let new_epoch = d.u64()?;
        let threshold = d.u8()?;
        let n_keys = d.u32()? as usize;
        if n_keys < MIN_THRESHOLD as usize || n_keys > TRUST_KEYS_MAX {
            return Err(err("quantidade de chaves da rotação fora da faixa"));
        }
        let mut keys = Vec::with_capacity(n_keys);
        for _ in 0..n_keys {
            let key_id = d.str()?;
            let pubkey_hex = d.str()?;
            keys.push(TrustedKey { key_id, pubkey_hex });
        }
        keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
        let n_rev = d.u32()? as usize;
        if n_rev > 512 {
            return Err(err("lista de revogação grande demais"));
        }
        let mut revoked_versions = Vec::with_capacity(n_rev);
        for _ in 0..n_rev {
            revoked_versions.push(d.str()?);
        }
        revoked_versions.sort();
        let effective_ms = d.i64()?;
        let reason = d.str()?;

        // Bloco de assinaturas: obrigatório e do mesmo formato do manifesto.
        let n_sigs = d.u32()? as usize;
        if n_sigs == 0 || n_sigs > crate::release::manifest::MAX_SIGNATURES {
            return Err(err("quantidade de assinaturas da rotação fora da faixa"));
        }
        let mut signatures = Vec::with_capacity(n_sigs);
        for _ in 0..n_sigs {
            signatures.push(ManifestSignature {
                key_id: d.str()?,
                sig: d.str()?,
            });
        }
        d.expect_end()?;

        let up = TrustUpdate {
            from_epoch,
            new_set: TrustSet {
                epoch: new_epoch,
                threshold,
                keys,
            },
            revoked_versions,
            effective_ms,
            reason,
            signatures,
        };
        // Fecha a porta para divergência entre "o que leu" e "o que assinou".
        if up.canonical_bytes()? != bytes[..bytes.len() - signature_block_len(&up)?] {
            return Err(err("rotação não está na forma canônica"));
        }
        Ok(up)
    }

    /// Aplica a rotação: as assinaturas precisam vir do conjunto ATUAL
    /// (2-de-3), a epoch precisa avançar e o novo conjunto precisa ser válido.
    pub fn verify_and_apply(&self, current: &TrustSet) -> Result<TrustSet> {
        if self.from_epoch != current.epoch {
            return Err(err("rotação não parte da epoch atual"));
        }
        let payload = self.signing_payload()?;
        let valid = current.verify_signatures(&payload, &self.signatures)?;
        if valid < current.threshold {
            return Err(err("rotação sem assinaturas suficientes"));
        }
        if self.new_set.threshold < MIN_THRESHOLD {
            return Err(err("rotação não pode reduzir o limiar"));
        }
        if !self.new_set.keys.iter().any(|k| current.has_key(&k.key_id)) {
            return Err(err("rotação sem continuidade com o conjunto atual"));
        }
        Ok(self.new_set.clone())
    }
}

fn push_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s.as_bytes());
}

/// Tamanho do bloco de assinaturas (count + entradas) no fim do wire.
fn signature_block_len(up: &TrustUpdate) -> Result<usize> {
    let mut n = 4usize;
    for s in &up.signatures {
        n = n
            .checked_add(4 + s.key_id.len() + 4 + s.sig.len())
            .ok_or_else(|| err("rotação grande demais"))?;
    }
    Ok(n)
}

/// Serializa `TrustUpdate` para o arquivo de rotação: payload + assinaturas.
pub fn encode_trust_update(up: &TrustUpdate) -> Result<Vec<u8>> {
    let mut out = up.canonical_bytes()?;
    if up.signatures.is_empty() || up.signatures.len() > super::manifest::MAX_SIGNATURES {
        return Err(err("quantidade de assinaturas da rotação fora da faixa"));
    }
    out.extend_from_slice(&(up.signatures.len() as u32).to_be_bytes());
    for s in &up.signatures {
        push_str(&mut out, &s.key_id);
        push_str(&mut out, &s.sig);
    }
    Ok(out)
}

struct WireDec<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> WireDec<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| err("rotação truncada"))?;
        if end > self.buf.len() {
            return Err(err("rotação truncada"));
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64> {
        Ok(u64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn str(&mut self) -> Result<String> {
        let n = self.u32()? as usize;
        if n > MAX_MANIFEST_BYTES {
            return Err(err("string da rotação acima do limite"));
        }
        let b = self.take(n)?;
        String::from_utf8(b.to_vec()).map_err(|_| err("string da rotação não é UTF-8"))
    }
    fn expect_end(&self) -> Result<()> {
        if self.pos != self.buf.len() {
            return Err(err("bytes sobrando na rotação"));
        }
        Ok(())
    }
}

fn valid_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control())
}

fn err(msg: &str) -> DistorrentError {
    DistorrentError::Protocol(format!("release: {msg}"))
}

/// Conjunto de confiança embutido.
///
/// Não existe override por variável de ambiente, arquivo ou comando: a raiz de
/// confiança é a constante compilada. Qualquer "jeito de apontar para outro
/// conjunto" seria exatamente o botão que um atacante usaria para trocar a
/// autoridade — e um app que aceita isso não verifica nada de verdade.
pub fn bootstrap_trust_set() -> Result<TrustSet> {
    let raw = super::trust_keys::TRUST_SET_BOOTSTRAP.trim();
    if raw.is_empty() {
        return Err(err(
            "este build não tem chaves de confiança embutidas (cerimônia não executada)",
        ));
    }
    parse_trust_set(raw)
}

/// Formato textual da cerimônia, uma linha, campos separados por `|`:
/// `epoch|threshold|key_id:pubkey_hex,key_id:pubkey_hex,...`
pub fn parse_trust_set(raw: &str) -> Result<TrustSet> {
    let mut parts = raw.split('|');
    let epoch: u64 = parts
        .next()
        .ok_or_else(|| err("conjunto de confiança vazio"))?
        .trim()
        .parse()
        .map_err(|_| err("epoch do conjunto de confiança inválido"))?;
    let threshold: u8 = parts
        .next()
        .ok_or_else(|| err("conjunto de confiança incompleto"))?
        .trim()
        .parse()
        .map_err(|_| err("limiar do conjunto de confiança inválido"))?;
    if threshold < MIN_THRESHOLD {
        return Err(err("limiar de confiança abaixo do mínimo"));
    }
    let keys_raw = parts
        .next()
        .ok_or_else(|| err("conjunto de confiança sem chaves"))?
        .trim();
    if parts.next().is_some() {
        return Err(err("conjunto de confiança com campos extras"));
    }
    let mut keys = Vec::new();
    for item in keys_raw.split(',') {
        let (id, pubkey) = item
            .split_once(':')
            .ok_or_else(|| err("chave de confiança malformada"))?;
        let derived = TrustedKey::from_pubkey_hex(pubkey.trim())?;
        if derived.key_id != id.trim() {
            return Err(err("key_id do conjunto de confiança não bate"));
        }
        keys.push(derived);
    }
    keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
    let set = TrustSet {
        epoch,
        threshold,
        keys,
    };
    set.validate()?;
    Ok(set)
}

/// Verificação completa de um manifesto assinado.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReleaseStatus {
    /// Assinaturas válidas de chaves distintas ≥ limiar e versão autorizada.
    /// Comprova a PROCEDÊNCIA do artefato, não o processo em execução.
    ReleaseVerificada,
    /// Sem provas suficientes / assinatura inválida / dados inconsistentes.
    NaoVerificado,
    /// Versão ou chave revogada pela autoridade.
    Revogado,
    /// Abaixo da epoch mínima de segurança.
    Obsoleto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedManifest {
    pub manifest: SignedManifest,
    pub status: ReleaseStatus,
    /// Assinaturas válidas contadas (0..=3).
    pub valid_signatures: u8,
    /// Hash blake3 dos bytes canônicos do body — é o `manifest_hash` que os
    /// peers anunciam e que identifica o release.
    pub manifest_hash: String,
    pub trust_epoch: u64,
    pub reason: String,
}

impl VerifiedManifest {
    pub fn is_verified(&self) -> bool {
        self.status == ReleaseStatus::ReleaseVerificada
    }
}

/// Verifica um manifesto contra o conjunto de confiança do receptor.
///
/// `min_epoch_floor` é o contador monotônico local: uma release com epoch
/// menor que a já vista é rollback e é recusada mesmo com assinatura válida.
pub fn verify_manifest(
    trust: &TrustSet,
    signed: &SignedManifest,
    min_epoch_floor: u64,
) -> Result<VerifiedManifest> {
    let body = &signed.body;
    body.validate()?;
    let hash = body.hash_hex()?;
    let payload = body.signing_payload()?;
    let base = |status: ReleaseStatus, valid: u8, reason: &str| VerifiedManifest {
        manifest: signed.clone(),
        status,
        valid_signatures: valid,
        manifest_hash: hash.clone(),
        trust_epoch: trust.epoch,
        reason: reason.to_string(),
    };

    // Revogação declarada pela própria release e pela autoridade.
    if body.revoked_versions.iter().any(|v| v == &body.version) {
        return Ok(base(
            ReleaseStatus::Revogado,
            0,
            "versão revogada no manifesto",
        ));
    }
    // Chave que assinou e está revogada pelo próprio manifesto: a assinatura
    // não conta (o autor da release disse que aquela chave não vale mais).
    let effective_sigs: Vec<ManifestSignature> = signed
        .signatures
        .iter()
        .filter(|s| !body.revoked_key_ids.iter().any(|id| id == &s.key_id))
        .cloned()
        .collect();
    let valid = match trust.verify_signatures(&payload, &effective_sigs) {
        Ok(v) => v,
        Err(e) => return Ok(base(ReleaseStatus::NaoVerificado, 0, &e.to_string())),
    };
    if valid < trust.threshold {
        return Ok(base(
            ReleaseStatus::NaoVerificado,
            valid,
            "assinaturas válidas abaixo do limiar",
        ));
    }
    // Piso de segurança: o maior entre o que este cliente já viu (rollback) e
    // o declarado pela autoridade no manifesto (`min_security_epoch`).
    let piso = min_epoch_floor.max(body.min_security_epoch);
    if body.security_epoch < piso {
        return Ok(base(
            ReleaseStatus::Obsoleto,
            valid,
            "epoch de segurança abaixo do mínimo autorizado",
        ));
    }
    Ok(base(
        ReleaseStatus::ReleaseVerificada,
        valid,
        "duas assinaturas válidas",
    ))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::identity::Keypair;
    use crate::release::manifest::*;

    pub(crate) struct Fixture {
        pub keys: Vec<Keypair>,
        pub trust: TrustSet,
    }

    pub(crate) fn fixture() -> Fixture {
        let keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
        let mut trusted: Vec<TrustedKey> = keys
            .iter()
            .map(|k| TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap())
            .collect();
        trusted.sort_by(|a, b| a.key_id.cmp(&b.key_id));
        Fixture {
            keys,
            trust: TrustSet {
                epoch: 1,
                threshold: 2,
                keys: trusted,
            },
        }
    }

    pub(crate) fn body() -> ManifestBody {
        ManifestBody {
            schema: MANIFEST_SCHEMA,
            project: PROJECT_ID.into(),
            version: "1.2.3".into(),
            channel: "stable".into(),
            tag: "v1.2.3".into(),
            commit: "b".repeat(40),
            published_at_ms: 1_700_000_000_000,
            protocol_version: 5,
            min_protocol_version: 4,
            security_epoch: 7,
            min_security_epoch: 5,
            revoked_versions: vec![],
            revoked_key_ids: vec![],
            assets: vec![ManifestAsset {
                name: "DisTorrent_1.2.3_x64_setup.exe".into(),
                os: "windows".into(),
                arch: "x86_64".into(),
                size: 5_000_000,
                sha256: "a".repeat(64),
                url: "https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/DisTorrent_1.2.3_x64_setup.exe".into(),
            }],
        }
    }
    pub(crate) fn sign(f: &Fixture, body: ManifestBody, with: &[usize]) -> SignedManifest {
        let payload = body.signing_payload().unwrap();
        let signatures = with
            .iter()
            .map(|&i| {
                let k = &f.keys[i];
                let tk = TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap();
                ManifestSignature {
                    key_id: tk.key_id,
                    sig: k.sign(&payload),
                }
            })
            .collect();
        SignedManifest { body, signatures }
    }

    #[test]
    fn tres_assinaturas_validas() {
        let f = fixture();
        let m = sign(&f, body(), &[0, 1, 2]);
        let v = verify_manifest(&f.trust, &m, 0).unwrap();
        assert_eq!(v.status, ReleaseStatus::ReleaseVerificada);
        assert_eq!(v.valid_signatures, 3);
    }

    #[test]
    fn duas_assinaturas_validas() {
        let f = fixture();
        let m = sign(&f, body(), &[0, 2]);
        let v = verify_manifest(&f.trust, &m, 0).unwrap();
        assert!(v.is_verified());
        assert_eq!(v.valid_signatures, 2);
    }

    #[test]
    fn uma_assinatura_so_e_nao_verificada() {
        let f = fixture();
        let m = sign(&f, body(), &[1]);
        let v = verify_manifest(&f.trust, &m, 0).unwrap();
        assert_eq!(v.status, ReleaseStatus::NaoVerificado);
    }

    #[test]
    fn sem_assinatura_e_nao_verificado() {
        let f = fixture();
        let m = SignedManifest {
            body: body(),
            signatures: vec![],
        };
        assert_eq!(
            verify_manifest(&f.trust, &m, 0).unwrap().status,
            ReleaseStatus::NaoVerificado
        );
    }

    #[test]
    fn assinatura_adulterada_derruba() {
        let f = fixture();
        let mut m = sign(&f, body(), &[0, 1]);
        let last = m.signatures[0].sig.pop().unwrap();
        let flip = if last == '0' { '1' } else { '0' };
        m.signatures[0].sig.push(flip);
        assert_eq!(
            verify_manifest(&f.trust, &m, 0).unwrap().status,
            ReleaseStatus::NaoVerificado
        );
    }

    #[test]
    fn chave_desconhecida_nao_conta() {
        let f = fixture();
        let stranger = Keypair::generate();
        let mut m = sign(&f, body(), &[0]);
        let payload = m.body.signing_payload().unwrap();
        m.signatures.push(ManifestSignature {
            key_id: TrustedKey::from_pubkey_hex(&stranger.public_hex())
                .unwrap()
                .key_id,
            sig: stranger.sign(&payload),
        });
        let v = verify_manifest(&f.trust, &m, 0).unwrap();
        assert_eq!(v.status, ReleaseStatus::NaoVerificado);
        assert_eq!(v.valid_signatures, 1);
    }

    #[test]
    fn mesma_chave_duas_vezes_conta_uma() {
        let f = fixture();
        let mut m = sign(&f, body(), &[0]);
        let dup = m.signatures[0].clone();
        m.signatures.push(dup);
        let v = verify_manifest(&f.trust, &m, 0).unwrap();
        assert_eq!(v.status, ReleaseStatus::NaoVerificado);
        assert_eq!(v.valid_signatures, 1);
    }

    #[test]
    fn versao_alterada_sem_reassinar_falha() {
        let f = fixture();
        let mut m = sign(&f, body(), &[0, 1]);
        m.body.version = "1.2.4".into();
        m.body.tag = "v1.2.4".into();
        assert_eq!(
            verify_manifest(&f.trust, &m, 0).unwrap().status,
            ReleaseStatus::NaoVerificado
        );
    }

    #[test]
    fn hash_commit_arch_url_alterados_falham() {
        let f = fixture();
        let base = sign(&f, body(), &[0, 1]);
        let mut cases = Vec::new();
        let mut b = base.body.clone();
        b.assets[0].sha256 = "c".repeat(64);
        cases.push(b);
        let mut b = base.body.clone();
        b.commit = "d".repeat(40);
        cases.push(b);
        let mut b = base.body.clone();
        b.assets[0].arch = "aarch64".into();
        cases.push(b);
        let mut b = base.body.clone();
        b.assets[0].url = "https://evil.example/x.exe".into();
        cases.push(b);
        let mut b = base.body.clone();
        b.assets[0].name = "outro.exe".into();
        cases.push(b);
        for body in cases {
            let m = SignedManifest {
                body,
                signatures: base.signatures.clone(),
            };
            assert_eq!(
                verify_manifest(&f.trust, &m, 0).unwrap().status,
                ReleaseStatus::NaoVerificado
            );
        }
    }

    #[test]
    fn release_revogada_e_revogada() {
        let f = fixture();
        let mut b = body();
        b.revoked_versions = vec!["1.2.3".into()];
        let m = sign(&f, b, &[0, 1]);
        assert_eq!(
            verify_manifest(&f.trust, &m, 0).unwrap().status,
            ReleaseStatus::Revogado
        );
    }

    #[test]
    fn rollback_de_epoch_e_obsoleto() {
        let f = fixture();
        let m = sign(&f, body(), &[0, 1]);
        assert_eq!(
            verify_manifest(&f.trust, &m, 8).unwrap().status,
            ReleaseStatus::Obsoleto
        );
    }

    #[test]
    fn min_security_epoch_do_manifesto_bloqueia_versao_antiga() {
        // Autoridade declara "nada abaixo da epoch 6 é aceito"; a release está
        // na epoch 7, então passa.
        let f = fixture();
        let mut b = body();
        b.security_epoch = 7;
        b.min_security_epoch = 6;
        assert!(verify_manifest(&f.trust, &sign(&f, b, &[0, 1]), 0)
            .unwrap()
            .is_verified());

        // Uma release antiga (epoch 5) legítima chega DEPOIS: cai pelo piso
        // efetivo (6, vindo do manifesto anterior), mesmo com 2 assinaturas.
        let mut velho = body();
        velho.security_epoch = 5;
        velho.min_security_epoch = 1;
        let v = verify_manifest(&f.trust, &sign(&f, velho, &[0, 1]), 6).unwrap();
        assert_eq!(v.status, ReleaseStatus::Obsoleto);
        assert!(!v.is_verified());
    }

    #[test]
    fn chave_revogada_no_manifesto_nao_contribui_para_o_limiar() {
        // Manifesto revoga a chave que assinou (0) e é assinado por 0+1:
        // sobra só a assinatura da chave 1, abaixo do limiar.
        let f = fixture();
        let mut b = body();
        let revoked_id = TrustedKey::from_pubkey_hex(&f.keys[0].public_hex())
            .unwrap()
            .key_id;
        assert!(
            f.trust.has_key(&revoked_id),
            "a chave assina e está no conjunto"
        );
        b.revoked_key_ids = vec![revoked_id];
        let m = sign(&f, b, &[0, 1]);
        let v = verify_manifest(&f.trust, &m, 0).unwrap();
        assert_eq!(v.status, ReleaseStatus::NaoVerificado);
        assert_eq!(v.valid_signatures, 1);
    }

    #[test]
    fn assinatura_de_chave_revogada_nao_conta() {
        let f = fixture();
        // Conjunto novo sem a chave 0 (revogada): assinaturas 0+1 sobram só 1.
        let rest: Vec<TrustedKey> = f.trust.keys.iter().filter(|_| true).cloned().collect();
        let revoked_id = TrustedKey::from_pubkey_hex(&f.keys[0].public_hex())
            .unwrap()
            .key_id;
        let set = TrustSet {
            epoch: 2,
            threshold: 2,
            keys: rest
                .into_iter()
                .filter(|k| k.key_id != revoked_id)
                .collect(),
        };
        set.validate().unwrap();
        let m = sign(&f, body(), &[0, 1]);
        assert_eq!(
            verify_manifest(&set, &m, 0).unwrap().status,
            ReleaseStatus::NaoVerificado
        );
    }

    #[test]
    fn rotacao_autorizada_por_duas_chaves() {
        let f = fixture();
        let new_keys: Vec<Keypair> = (0..3).map(|_| Keypair::generate()).collect();
        let mut keys: Vec<TrustedKey> = new_keys
            .iter()
            .enumerate()
            .map(|(i, k)| {
                if i == 0 {
                    // continuidade: mantém uma chave antiga
                    f.trust.keys[0].clone()
                } else {
                    TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap()
                }
            })
            .collect();
        keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
        let new_set = TrustSet {
            epoch: 2,
            threshold: 2,
            keys,
        };
        let mut up = TrustUpdate {
            from_epoch: 1,
            new_set: new_set.clone(),
            revoked_versions: vec!["1.0.0".into()],
            effective_ms: 1_700_000_000_000,
            reason: "rotação anual".into(),
            signatures: vec![],
        };
        let payload = up.signing_payload().unwrap();
        up.signatures = vec![
            ManifestSignature {
                key_id: f.trust.keys[0].key_id.clone(),
                sig: key_for(&f, &f.trust.keys[0].key_id).sign(&payload),
            },
            ManifestSignature {
                key_id: f.trust.keys[1].key_id.clone(),
                sig: key_for(&f, &f.trust.keys[1].key_id).sign(&payload),
            },
        ];
        assert_eq!(up.verify_and_apply(&f.trust).unwrap(), new_set);
    }

    fn key_for<'a>(f: &'a Fixture, key_id: &str) -> &'a Keypair {
        f.keys
            .iter()
            .find(|k| TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap().key_id == key_id)
            .unwrap()
    }

    #[test]
    fn rotacao_nao_autorizada_falha() {
        let f = fixture();
        let new_set = TrustSet {
            epoch: 2,
            threshold: 2,
            keys: f.trust.keys.clone(),
        };
        let mut up = TrustUpdate {
            from_epoch: 1,
            new_set,
            revoked_versions: vec![],
            effective_ms: 1,
            reason: "sem assinatura".into(),
            signatures: vec![],
        };
        assert!(up.verify_and_apply(&f.trust).is_err());
        up.signatures = vec![ManifestSignature {
            key_id: f.trust.keys[0].key_id.clone(),
            sig: key_for(&f, &f.trust.keys[0].key_id).sign(&up.signing_payload().unwrap()),
        }];
        assert!(up.verify_and_apply(&f.trust).is_err());
    }

    #[test]
    fn rotacao_sem_continuidade_falha() {
        let f = fixture();
        let strangers: Vec<TrustedKey> = (0..3)
            .map(|_| TrustedKey::from_pubkey_hex(&Keypair::generate().public_hex()).unwrap())
            .collect();
        let mut keys = strangers;
        keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
        let mut up = TrustUpdate {
            from_epoch: 1,
            new_set: TrustSet {
                epoch: 2,
                threshold: 3,
                keys,
            },
            revoked_versions: vec![],
            effective_ms: 1,
            reason: "tomada de controle".into(),
            signatures: vec![],
        };
        let payload = up.signing_payload().unwrap();
        up.signatures = vec![
            ManifestSignature {
                key_id: f.trust.keys[0].key_id.clone(),
                sig: key_for(&f, &f.trust.keys[0].key_id).sign(&payload),
            },
            ManifestSignature {
                key_id: f.trust.keys[1].key_id.clone(),
                sig: key_for(&f, &f.trust.keys[1].key_id).sign(&payload),
            },
        ];
        assert!(up.verify_and_apply(&f.trust).is_err());
    }

    #[test]
    fn rotacao_wire_roundtrip_preserva_assinaturas() {
        let f = fixture();
        let new_keys: Vec<Keypair> = (0..2).map(|_| Keypair::generate()).collect();
        let mut keys = vec![f.trust.keys[0].clone()];
        for k in &new_keys {
            keys.push(TrustedKey::from_pubkey_hex(&k.public_hex()).unwrap());
        }
        keys.sort_by(|a, b| a.key_id.cmp(&b.key_id));
        let new_set = TrustSet {
            epoch: 2,
            threshold: 2,
            keys,
        };
        let mut up = TrustUpdate {
            from_epoch: 1,
            new_set: new_set.clone(),
            revoked_versions: vec!["1.0.0".into()],
            effective_ms: 1_700_000_000_000,
            reason: "rotação de teste".into(),
            signatures: vec![],
        };
        let payload = up.signing_payload().unwrap();
        up.signatures = vec![
            ManifestSignature {
                key_id: f.trust.keys[0].key_id.clone(),
                sig: key_for(&f, &f.trust.keys[0].key_id).sign(&payload),
            },
            ManifestSignature {
                key_id: f.trust.keys[1].key_id.clone(),
                sig: key_for(&f, &f.trust.keys[1].key_id).sign(&payload),
            },
        ];

        let wire = encode_trust_update(&up).unwrap();
        let back = TrustUpdate::from_wire(&wire).unwrap();
        assert_eq!(back, up, "assinaturas precisam sobreviver ao arquivo");
        assert_eq!(back.verify_and_apply(&f.trust).unwrap(), new_set);
    }

    #[test]
    fn rotacao_sem_bloco_de_assinaturas_e_recusada_no_parse() {
        let f = fixture();
        let up = TrustUpdate {
            from_epoch: 1,
            new_set: TrustSet {
                epoch: 2,
                threshold: 2,
                keys: f.trust.keys.clone(),
            },
            revoked_versions: vec![],
            effective_ms: 1,
            reason: "sem assinatura".into(),
            signatures: vec![],
        };
        // Payload sozinho (sem o bloco) não decodifica.
        assert!(TrustUpdate::from_wire(&up.canonical_bytes().unwrap()).is_err());
        // E um bloco com 0 assinaturas também não.
        let mut sem = up.canonical_bytes().unwrap();
        sem.extend_from_slice(&0u32.to_be_bytes());
        assert!(TrustUpdate::from_wire(&sem).is_err());
    }

    #[test]
    fn parse_do_formato_da_cerimonia() {
        let f = fixture();
        let raw = format!(
            "{}|{}|{}",
            f.trust.epoch,
            f.trust.threshold,
            f.trust
                .keys
                .iter()
                .map(|k| format!("{}:{}", k.key_id, k.pubkey_hex))
                .collect::<Vec<_>>()
                .join(",")
        );
        assert_eq!(parse_trust_set(&raw).unwrap(), f.trust.clone());
        assert!(parse_trust_set("1|1|").is_err());
        assert!(parse_trust_set("1|2|").is_err());
        assert!(parse_trust_set("x|2|a:b").is_err());
        assert!(parse_trust_set("1|2|abc:def").is_err());
    }
}
