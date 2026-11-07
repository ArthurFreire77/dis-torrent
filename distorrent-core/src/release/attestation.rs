//! Atestação de build trocada entre peers DEPOIS do handshake.
//!
//! A identidade Ed25519 do handshake prova posse de uma chave, não que o
//! executável está intacto. Esta camada acrescenta uma segunda prova, amarrada
//! à conexão:
//!
//! - um nonce novo por consulta (impede replay entre conexões e entre peers);
//! - `blake3(transcript)` do handshake (impede colar a prova em outra sessão);
//! - o fingerprint do peer (impede reaproveitar prova de outra identidade);
//! - o manifesto ASSINADO completo, se o peer quiser provar procedência — o
//!   receptor verifica com as próprias chaves embutidas, nunca "confia".
//!
//! Nada aqui substitui a verificação local: um peer que responde "sou oficial"
//! sem assinatura válida continua NAO_VERIFICADO.

use serde::{Deserialize, Serialize};

use super::manifest::{SignedManifest, MAX_MANIFEST_BYTES};
use super::trust::{verify_manifest, ReleaseStatus, TrustSet};
use crate::{DistorrentError, Result};

pub const ATTEST_DOMAIN: &[u8] = b"distorrent/v1|build-attestation|";
/// Proto mínimo que entende os frames de atestação.
pub const ATTEST_PROTO_V: u32 = 5;
/// Janela para o peer responder ao desafio. Curta de propósito: um cliente
/// honesto responde em milissegundos; quem não responde conta como não
/// verificado (não fica "pendente" para sempre).
pub const ATTEST_TIMEOUT_MS: i64 = 15_000;
pub const MAX_VERSION_CHARS: usize = 64;
pub const MAX_ID_CHARS: usize = 128;
pub const MAX_CHANNEL_CHARS: usize = 32;
pub const MAX_MANIFEST_HEX: usize = MAX_MANIFEST_BYTES * 2;

/// O que o peer DECLARA sobre si.
///
/// Nenhum campo daqui é prova. O receptor usa estes valores de duas formas
/// apenas:
/// - conferir se batem com o manifesto ASSINADO que ele mesmo verificou
///   (divergência = inconsistência, rebaixa);
/// - como sinal NEGATIVO (o peer admite divergência de integridade).
///
/// Nunca para promover o estado de confiança. "Meu cliente é original" não é
/// resposta aceitável: ou existem assinaturas que o RECEPTOR confere, ou o
/// peer fica NAO_VERIFICADO.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildClaim {
    pub version: String,
    /// blake3 dos bytes canônicos do manifesto de release (64 hex).
    pub manifest_hash: String,
    /// Identificador do build; declarado, não verificável pelo receptor.
    pub build_id: String,
    /// SHA-1 do commit de origem declarado (40 hex).
    pub commit: String,
    pub channel: String,
    pub protocol_version: u32,
    pub security_epoch: u64,
    /// Autoavaliação do peer. Só pode REBAIXAR (se ele admite divergência);
    /// jamais promove, porque quem diz "estou íntegro" é o próprio réu.
    pub self_integrity: SelfIntegrityState,
}

impl BuildClaim {
    pub fn validate(&self) -> Result<()> {
        if !valid_version(&self.version) {
            return Err(err("versão do build inválida"));
        }
        if !valid_hex(&self.manifest_hash, 64) {
            return Err(err("hash de manifesto inválido"));
        }
        if !valid_text(&self.build_id, MAX_ID_CHARS) {
            return Err(err("build_id inválido"));
        }
        if !valid_hex(&self.commit, 40) {
            return Err(err("commit do build inválido"));
        }
        if !valid_text(&self.channel, MAX_CHANNEL_CHARS) {
            return Err(err("canal do build inválido"));
        }
        if self.protocol_version == 0 {
            return Err(err("versão de protocolo inválida"));
        }
        Ok(())
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut out = Vec::with_capacity(256);
        for s in [
            self.version.as_str(),
            self.manifest_hash.as_str(),
            self.build_id.as_str(),
            self.commit.as_str(),
            self.channel.as_str(),
            self.self_integrity.as_str(),
        ] {
            out.extend_from_slice(&(s.len() as u32).to_be_bytes());
            out.extend_from_slice(s.as_bytes());
        }
        out.extend_from_slice(&self.protocol_version.to_be_bytes());
        out.extend_from_slice(&self.security_epoch.to_be_bytes());
        Ok(out)
    }
}

/// Integridade do executável EM EXECUÇÃO, medida localmente.
///
/// Isto NÃO é atestação de hardware: é o hash do próprio binário comparado com
/// o asset de binário do manifesto assinado. Se o manifesto não publicar esse
/// asset, o estado é `Unavailable` — nunca "ok" por omissão.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SelfIntegrityState {
    Confere,
    Diverge,
    Unavailable,
}

impl SelfIntegrityState {
    fn as_str(self) -> &'static str {
        match self {
            Self::Confere => "CONFERE",
            Self::Diverge => "DIVERGE",
            Self::Unavailable => "UNAVAILABLE",
        }
    }
}

/// O que o device oferece de atestação de plataforma.
///
/// **Nunca vem do peer.** Este struct é calculado pelo RECEPTOR sobre a própria
/// máquina (`attest_local_hardware`) e só serve para ele saber o que *ele*
/// consegue verificar. Um peer não tem campo para "provar" atestação de
/// hardware: ou existe uma cadeia criptográfica que o receptor valida sozinho
/// (não implementada aqui), ou o estado fica abaixo de
/// `ATESTACAO_DE_HARDWARE`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HardwareStatus {
    /// `none` | `tpm2` | `secure_boot` | `android_key_attestation`
    pub mechanism: String,
    /// Só `true` quando o receptor conseguiu validar uma prova de verdade.
    pub proof_available: bool,
    pub reason: String,
}

impl HardwareStatus {
    pub fn none(reason: &str) -> Self {
        Self {
            mechanism: "none".into(),
            proof_available: false,
            reason: reason.into(),
        }
    }
}

/// Prova de build enviada ao peer desafiante.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildAttestation {
    pub claim: BuildClaim,
    /// Nonce do desafio, ecoado — amarra a resposta à pergunta.
    pub nonce: [u8; 32],
    /// blake3(transcript) do handshake desta conexão, hex.
    pub transcript_hash: String,
    /// Manifesto assinado (wire hex) ou vazio quando o peer não tem um.
    pub manifest_hex: String,
    /// Assinatura Ed25519 da identidade do peer sobre o payload abaixo.
    pub sig: String,
}

impl BuildAttestation {
    pub fn signing_payload(
        transcript_hash: &str,
        nonce: &[u8; 32],
        fp: &str,
        claim: &BuildClaim,
    ) -> Result<[u8; 32]> {
        let mut h = blake3::Hasher::new();
        h.update(ATTEST_DOMAIN);
        h.update(transcript_hash.as_bytes());
        h.update(nonce);
        h.update(&(fp.len() as u32).to_be_bytes());
        h.update(fp.as_bytes());
        h.update(&claim.canonical_bytes()?);
        Ok(*h.finalize().as_bytes())
    }

    pub fn sign(
        kp: &crate::identity::Keypair,
        transcript_hash: &str,
        nonce: &[u8; 32],
        claim: BuildClaim,
        manifest: Option<&SignedManifest>,
    ) -> Result<Self> {
        let fp = kp.fingerprint();
        let payload = Self::signing_payload(transcript_hash, nonce, &fp, &claim)?;
        let manifest_hex = match manifest {
            Some(m) => hex::encode(m.to_wire()?),
            None => String::new(),
        };
        Ok(Self {
            claim,
            nonce: *nonce,
            transcript_hash: transcript_hash.to_string(),
            manifest_hex,
            sig: kp.sign(&payload),
        })
    }
}

/// Estados de confiança de um peer, na ordem em que a política decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PeerTrustState {
    /// Sem provas suficientes, assinatura falhou ou dados inconsistentes.
    NaoVerificado,
    /// Manifesto com 2 assinaturas válidas; procedência comprovada, execução não.
    ReleaseVerificada,
    /// Prova de plataforma adicional realmente validada.
    AtestacaoDeHardware,
    /// Versão/chave revogada pela autoridade.
    Revogado,
    /// Abaixo da epoch mínima de segurança.
    Obsoleto,
}

impl PeerTrustState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NaoVerificado => "NAO_VERIFICADO",
            Self::ReleaseVerificada => "RELEASE_VERIFICADA",
            Self::AtestacaoDeHardware => "ATESTACAO_DE_HARDWARE",
            Self::Revogado => "REVOGADO",
            Self::Obsoleto => "OBSOLETO",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerTrust {
    pub state: PeerTrustState,
    pub version: String,
    pub manifest_hash: String,
    pub build_id: String,
    pub commit: String,
    pub channel: String,
    pub security_epoch: u64,
    pub valid_signatures: u8,
    pub self_integrity: SelfIntegrityState,
    pub hardware: HardwareStatus,
    pub reason: String,
    /// `true` só quando a verificação local pôde ser feita (há chaves).
    pub verification_available: bool,
    pub checked_at_ms: i64,
}

impl PeerTrust {
    pub fn unavailable(reason: &str) -> Self {
        Self {
            state: PeerTrustState::NaoVerificado,
            version: String::new(),
            manifest_hash: String::new(),
            build_id: String::new(),
            commit: String::new(),
            channel: String::new(),
            security_epoch: 0,
            valid_signatures: 0,
            self_integrity: SelfIntegrityState::Unavailable,
            hardware: HardwareStatus::none("não avaliado"),
            reason: reason.into(),
            verification_available: false,
            checked_at_ms: crate::identity::now_ms(),
        }
    }

    /// Bloqueio de funcionalidades normais (quarentena).
    pub fn is_blocked(&self) -> bool {
        matches!(
            self.state,
            PeerTrustState::Revogado | PeerTrustState::Obsoleto
        )
    }

    pub fn is_verified(&self) -> bool {
        matches!(
            self.state,
            PeerTrustState::ReleaseVerificada | PeerTrustState::AtestacaoDeHardware
        )
    }
}

/// Verifica uma atestação recebida.
///
/// **Regra de ouro desta função:** o estado de saída é decidido por provas que
/// o RECEPTOR calcula. Nada que o peer declara promove o estado — declaração só
/// serve para detectar inconsistência (e rebaixar). Um peer que mentir sobre a
/// própria integridade não ganha nada; um que mentir sobre a versão é pego
/// porque a versão tem de bater com o manifesto assinado.
///
/// `trust` é o conjunto de confiança DO RECEPTOR. `transcript_hash` é o da
/// conexão atual, calculado localmente. `expected_nonce` é o desafio que ESTE
/// lado enviou. `min_epoch_floor` é o contador monotônico local.
pub fn verify_attestation(
    trust: Option<&TrustSet>,
    att: &BuildAttestation,
    peer_fp: &str,
    peer_pubkey_hex: &str,
    transcript_hash: &str,
    expected_nonce: &[u8; 32],
    min_epoch_floor: u64,
) -> PeerTrust {
    let mut out = PeerTrust::unavailable("sem prova");
    out.version = att.claim.version.clone();
    out.manifest_hash = att.claim.manifest_hash.clone();
    out.build_id = att.claim.build_id.clone();
    out.commit = att.claim.commit.clone();
    out.channel = att.claim.channel.clone();
    out.security_epoch = att.claim.security_epoch;
    out.self_integrity = att.claim.self_integrity;
    // Hardware é o que ESTE device consegue verificar — nunca o que o peer diz.
    out.hardware = local_hardware_capability();

    // 1. A prova tem de ser DESTA conexão.
    if att.nonce != *expected_nonce {
        out.reason = "nonce do desafio não confere (replay?)".into();
        return out;
    }
    if att.transcript_hash != transcript_hash {
        out.reason = "prova amarrada a outro handshake".into();
        return out;
    }
    // 2. A prova tem de ser DESTA identidade.
    let payload = match BuildAttestation::signing_payload(
        transcript_hash,
        expected_nonce,
        peer_fp,
        &att.claim,
    ) {
        Ok(p) => p,
        Err(e) => {
            out.reason = e.to_string();
            return out;
        }
    };
    match crate::identity::Keypair::verify(peer_pubkey_hex, &payload, &att.sig) {
        Ok(true) => {}
        _ => {
            out.reason = "assinatura da atestação inválida".into();
            return out;
        }
    }
    let Some(trust) = trust else {
        out.reason = "receptor sem chaves de confiança (verificação indisponível)".into();
        return out;
    };
    out.verification_available = true;
    if att.manifest_hex.is_empty() {
        out.reason = "peer não apresentou manifesto assinado".into();
        return out;
    }
    if att.manifest_hex.len() > MAX_MANIFEST_HEX {
        out.reason = "manifesto apresentado acima do limite".into();
        return out;
    }
    let wire = match hex::decode(&att.manifest_hex) {
        Ok(w) => w,
        Err(_) => {
            out.reason = "manifesto não é hex".into();
            return out;
        }
    };
    let signed = match SignedManifest::from_wire(&wire) {
        Ok(m) => m,
        Err(e) => {
            out.reason = e.to_string();
            return out;
        }
    };
    let verified = match verify_manifest(trust, &signed, min_epoch_floor) {
        Ok(v) => v,
        Err(e) => {
            out.reason = e.to_string();
            return out;
        }
    };
    out.valid_signatures = verified.valid_signatures;
    out.state = match verified.status {
        ReleaseStatus::ReleaseVerificada => PeerTrustState::ReleaseVerificada,
        ReleaseStatus::Revogado => PeerTrustState::Revogado,
        ReleaseStatus::Obsoleto => PeerTrustState::Obsoleto,
        ReleaseStatus::NaoVerificado => PeerTrustState::NaoVerificado,
    };
    out.reason = verified.reason.clone();
    if out.state != PeerTrustState::ReleaseVerificada {
        return out;
    }
    // 4. O que o peer DISSE tem de bater com o manifesto VERIFICADO.
    let b = &signed.body;
    if att.claim.version != b.version
        || att.claim.manifest_hash != verified.manifest_hash
        || att.claim.commit != b.commit
        || att.claim.channel != b.channel
        || att.claim.security_epoch != b.security_epoch
    {
        out.state = PeerTrustState::NaoVerificado;
        out.reason = "declaração do peer não bate com o manifesto assinado".into();
        return out;
    }
    if att.claim.self_integrity == SelfIntegrityState::Diverge {
        // Só sinal NEGATIVO: o peer admite que o próprio executável diverge.
        out.state = PeerTrustState::NaoVerificado;
        out.reason = "o peer admite executável divergente do manifesto".into();
        return out;
    }
    out.checked_at_ms = crate::identity::now_ms();
    out
}

/// Capacidade de atestação de hardware DESTE dispositivo.
///
/// Calculada localmente e nunca alimentada por dado vindo da rede. Hoje é
/// sempre `none` porque nenhuma plataforma deste build produz uma prova que o
/// receptor saiba validar sozinho (TPM exige cadeia de EK/endosso e admin; IMA
/// exige root; Key Attestation exige a raiz da Google embutida).
fn local_hardware_capability() -> HardwareStatus {
    #[cfg(target_os = "windows")]
    {
        HardwareStatus::none(
            "TPM 2.0/Secure Boot podem existir, mas um quote verificável exige \
             cadeia de EK/endosso e política de PCR que o app não possui sem admin",
        )
    }
    #[cfg(target_os = "linux")]
    {
        HardwareStatus::none(
            "IMA/TPM quote exige root e chaves de endosso; o AppImage não tem \
             como produzir prova verificável por peers",
        )
    }
    #[cfg(target_os = "android")]
    {
        HardwareStatus::none(
            "Key Attestation do AndroidKeyStore não é verificada por este build \
             (sem a cadeia raiz da Google embutida); não é apresentada como prova",
        )
    }
    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "android")))]
    {
        HardwareStatus::none("plataforma sem mecanismo de atestação implementado")
    }
}

/// Política de bloqueio configurada pelo usuário.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerPolicy {
    /// Bloqueia tudo que não esteja RELEASE_VERIFICADA/ATESTACAO.
    BlockUnverified,
    /// Bloqueia só REVOGADO/OBSOLETO; marca o resto e limita o tráfego.
    BlockRevoked,
    /// Não bloqueia nada; só informa (diagnóstico).
    Warn,
}

impl PeerPolicy {
    pub fn parse(raw: &str) -> Self {
        match raw.trim() {
            "block_unverified" => Self::BlockUnverified,
            "warn" => Self::Warn,
            _ => Self::BlockRevoked,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::BlockUnverified => "block_unverified",
            Self::BlockRevoked => "block_revoked",
            Self::Warn => "warn",
        }
    }

    /// `None` = sem restrição. `Some(reason)` = quarentena.
    pub fn decision(self, trust: &PeerTrust, verification_available: bool) -> Option<&'static str> {
        if trust.state == PeerTrustState::Revogado {
            return Some("versão revogada pela autoridade");
        }
        if trust.state == PeerTrustState::Obsoleto {
            return Some("versão abaixo da epoch mínima de segurança");
        }
        if !verification_available {
            return None;
        }
        match self {
            Self::BlockUnverified => {
                if trust.is_verified() {
                    None
                } else {
                    Some("cliente não comprovou release assinada")
                }
            }
            Self::BlockRevoked | Self::Warn => None,
        }
    }
}

/// Frames mínimos permitidos durante a quarentena: só o suficiente para o peer
/// descobrir que precisa atualizar e para o link não morrer em silêncio.
pub fn frame_allowed_in_quarantine(frame: &crate::protocol::SecureFrame) -> bool {
    use crate::protocol::SecureFrame as F;
    matches!(
        frame,
        F::Ping { .. }
            | F::Pong { .. }
            | F::Bye
            | F::BuildChallenge { .. }
            | F::BuildAttestResponse { .. }
            | F::BuildManifestPush { .. }
            | F::UpdateHint { .. }
    )
}

fn valid_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control())
}

fn valid_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_version(s: &str) -> bool {
    if s.len() > MAX_VERSION_CHARS {
        return false;
    }
    let core = s.split('-').next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

fn err(msg: &str) -> DistorrentError {
    DistorrentError::Protocol(format!("attest: {msg}"))
}

#[cfg(test)]
mod tests {
    use super::super::trust::tests::{body as manifest_body, fixture, sign, Fixture};
    use super::*;

    fn claim(_f: &Fixture, manifest: &SignedManifest) -> BuildClaim {
        BuildClaim {
            version: manifest.body.version.clone(),
            manifest_hash: manifest.body.hash_hex().unwrap(),
            build_id: "build-1".into(),
            commit: manifest.body.commit.clone(),
            channel: manifest.body.channel.clone(),
            protocol_version: 5,
            security_epoch: manifest.body.security_epoch,
            self_integrity: SelfIntegrityState::Confere,
        }
    }

    fn attest(f: &Fixture, nonce: [u8; 32], t: &str) -> BuildAttestation {
        let m = sign(f, manifest_body(), &[0, 1]);
        let c = claim(f, &m);
        BuildAttestation::sign(&f.keys[0], t, &nonce, c, Some(&m)).unwrap()
    }

    #[test]
    fn peer_que_se_declara_integro_nao_ganha_nada() {
        let f = fixture();
        let nonce = [8u8; 32];
        let t = "33".repeat(32);
        let mut c = claim(&f, &sign(&f, manifest_body(), &[0, 1]));
        c.self_integrity = SelfIntegrityState::Confere;
        let a = BuildAttestation::sign(&f.keys[0], &t, &nonce, c, None).unwrap();
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
        assert!(!tr.is_verified(), "declarar-se íntegro não é prova");
    }

    #[test]
    fn nunca_promove_para_atestacao_de_hardware_por_declaracao() {
        let f = fixture();
        let nonce = [9u8; 32];
        let t = "44".repeat(32);
        let a = attest(&f, nonce, &t);
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::ReleaseVerificada);
        assert!(!tr.hardware.proof_available);
        assert_ne!(tr.state, PeerTrustState::AtestacaoDeHardware);
    }

    #[test]
    fn atestacao_valida_vira_release_verificada() {
        let f = fixture();
        let nonce = [7u8; 32];
        let t = "aa".repeat(32);
        let a = attest(&f, nonce, &t);
        let fp = f.keys[0].fingerprint();
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &fp,
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::ReleaseVerificada);
        assert_eq!(tr.valid_signatures, 2);
        assert!(tr.verification_available);
    }

    #[test]
    fn prova_de_outra_conexao_e_barrada() {
        let f = fixture();
        let nonce = [7u8; 32];
        let t = "aa".repeat(32);
        let a = attest(&f, nonce, &t);
        let fp = f.keys[0].fingerprint();
        let outro_t = "bb".repeat(32);
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &fp,
            &f.keys[0].public_hex(),
            &outro_t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
        assert!(tr.reason.contains("handshake"));
    }

    #[test]
    fn nonce_antigo_replay_nao_cola() {
        let f = fixture();
        let nonce = [7u8; 32];
        let t = "aa".repeat(32);
        let a = attest(&f, nonce, &t);
        let fp = f.keys[0].fingerprint();
        let novo = [8u8; 32];
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &fp,
            &f.keys[0].public_hex(),
            &t,
            &novo,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
        assert!(tr.reason.contains("nonce"));
    }

    #[test]
    fn prova_de_outra_identidade_nao_cola() {
        let f = fixture();
        let nonce = [7u8; 32];
        let t = "aa".repeat(32);
        let a = attest(&f, nonce, &t);
        let outro = crate::identity::Keypair::generate();
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &outro.fingerprint(),
            &outro.public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
    }

    #[test]
    fn peer_que_so_diz_que_e_oficial_nao_passa() {
        let f = fixture();
        let nonce = [7u8; 32];
        let t = "aa".repeat(32);
        let mut a = attest(&f, nonce, &t);
        a.manifest_hex.clear();
        let fp = f.keys[0].fingerprint();
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &fp,
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
        assert!(tr.reason.contains("manifesto"));
    }

    #[test]
    fn versao_falsificada_na_claim_e_pegada() {
        let f = fixture();
        let nonce = [7u8; 32];
        let t = "aa".repeat(32);
        let m = sign(&f, manifest_body(), &[0, 1]);
        let mut c = claim(&f, &m);
        c.version = "9.9.9".into();
        let a = BuildAttestation::sign(&f.keys[0], &t, &nonce, c, Some(&m)).unwrap();
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
        assert!(tr.reason.contains("declaração"));
    }

    #[test]
    fn manifesto_revogado_bloqueia() {
        let f = fixture();
        let mut b = manifest_body();
        b.revoked_versions = vec![b.version.clone()];
        let m = sign(&f, b, &[0, 1]);
        let c = claim(&f, &m);
        let nonce = [1u8; 32];
        let t = "cc".repeat(32);
        let a = BuildAttestation::sign(&f.keys[0], &t, &nonce, c, Some(&m)).unwrap();
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::Revogado);
        assert!(PeerPolicy::Warn.decision(&tr, true).is_some());
    }

    #[test]
    fn rollback_para_epoch_antiga_e_obsoleto() {
        let f = fixture();
        let nonce = [2u8; 32];
        let t = "dd".repeat(32);
        let a = attest(&f, nonce, &t);
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            99,
        );
        assert_eq!(tr.state, PeerTrustState::Obsoleto);
    }

    #[test]
    fn sem_chaves_no_receptor_nao_ha_verificacao() {
        let f = fixture();
        let nonce = [3u8; 32];
        let t = "ee".repeat(32);
        let a = attest(&f, nonce, &t);
        let tr = verify_attestation(
            None,
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
        assert!(!tr.verification_available);
        // Não pode bloquear em massa só porque o build não tem chaves.
        assert_eq!(
            PeerPolicy::BlockUnverified.decision(&tr, tr.verification_available),
            None
        );
    }

    #[test]
    fn politica_bloqueia_nao_verificado_quando_ha_como_verificar() {
        let f = fixture();
        let nonce = [4u8; 32];
        let t = "ff".repeat(32);
        let mut a = attest(&f, nonce, &t);
        a.manifest_hex.clear();
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(
            PeerPolicy::BlockUnverified.decision(&tr, true),
            Some("cliente não comprovou release assinada")
        );
        assert_eq!(PeerPolicy::BlockRevoked.decision(&tr, true), None);
    }

    #[test]
    fn manifesto_gigante_e_recusado_antes_de_verificar() {
        let f = fixture();
        let nonce = [5u8; 32];
        let t = "11".repeat(32);
        let mut a = attest(&f, nonce, &t);
        a.manifest_hex = "a".repeat(MAX_MANIFEST_HEX + 2);
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
        assert!(tr.reason.contains("limite"));
    }

    #[test]
    fn claim_invalida_nao_panica_ao_verificar() {
        let f = fixture();
        let nonce = [6u8; 32];
        let t = "22".repeat(32);
        let m = sign(&f, manifest_body(), &[0, 1]);
        let mut c = claim(&f, &m);
        c.version = "não-é-versão".into();
        let a = BuildAttestation {
            claim: c,
            nonce,
            transcript_hash: t.clone(),
            manifest_hex: hex::encode(m.to_wire().unwrap()),
            sig: "00".repeat(64),
        };
        let tr = verify_attestation(
            Some(&f.trust),
            &a,
            &f.keys[0].fingerprint(),
            &f.keys[0].public_hex(),
            &t,
            &nonce,
            0,
        );
        assert_eq!(tr.state, PeerTrustState::NaoVerificado);
    }
}
