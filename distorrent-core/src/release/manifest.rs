//! Formato canônico do manifesto de release.
//!
//! Não existe JSON canônico aqui de propósito: JSON aberto tem ambiguidade de
//! parser (duplicata, float, ordem de chave) e uma assinatura sobre bytes
//! "canonicalizados" por duas implementações diferentes já quebrou sistemas
//! reais. O invólucro abaixo é um encoding binário fechado, de ordem fixa, com
//! tags crescentes e comprimentos explícitos. O decodificador exige a forma
//! canônica e rejeita qualquer coisa que, reencodada, não seja byte-a-byte
//! igual ao que chegou.

use serde::{Deserialize, Serialize};

use crate::{DistorrentError, Result};

pub const MANIFEST_MAGIC: &[u8; 5] = b"DTMF1";
pub const MANIFEST_SCHEMA: u16 = 1;
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;
pub const MAX_ASSETS: usize = 32;
pub const MAX_REVOKED: usize = 512;
pub const MAX_STRING: usize = 2048;
pub const MAX_SIGNATURES: usize = 3;
pub const SIGN_DOMAIN: &[u8] = b"distorrent/v1|release-manifest|";
pub const PROJECT_ID: &str = "distorrent";

/// Nome de arquivo/URL nunca pode conter caminho, esquema ou controle.
fn valid_text(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && !s.chars().any(|c| c.is_control()) && !s.contains('\u{0}')
}

fn valid_asset_name(s: &str) -> bool {
    valid_text(s, 255) && !s.contains('/') && !s.contains('\\') && s != "." && s != ".."
}

/// Versão no formato `N.N.N` com sufixo opcional `-pre-alpha`, sem espaços.
fn valid_version(s: &str) -> bool {
    let core = s.split('-').next().unwrap_or("");
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
        && s.len() <= 64
}

fn valid_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn valid_key_id(s: &str) -> bool {
    valid_hex(s, 16)
}

fn valid_sha256(s: &str) -> bool {
    valid_hex(s, 64)
}

fn valid_commit(s: &str) -> bool {
    valid_hex(s, 40)
}

fn valid_https_url(s: &str) -> bool {
    valid_text(s, 1024) && s.starts_with("https://")
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestAsset {
    pub name: String,
    /// `windows` | `linux` | `android` | `macos` | `freebsd`
    pub os: String,
    /// `x86_64` | `aarch64` | `universal`
    pub arch: String,
    pub size: u64,
    /// SHA-256 do instalador, 64 hex minúsculos.
    pub sha256: String,
    pub url: String,
}

impl ManifestAsset {
    fn validate(&self) -> Result<()> {
        if !valid_asset_name(&self.name) {
            return Err(err("nome de asset inválido"));
        }
        if !valid_text(&self.os, 32) || !valid_text(&self.arch, 32) {
            return Err(err("os/arch inválidos no asset"));
        }
        if !valid_sha256(&self.sha256) {
            return Err(err("sha256 do asset não é 64 hex"));
        }
        if !valid_https_url(&self.url) {
            return Err(err("URL do asset precisa ser https"));
        }
        // Tamanho zero não é release válida e 4 GiB é teto de sanidade para
        // qualquer instalador deste projeto; acima disso é manifesto forjado.
        if self.size == 0 || self.size > 4 * 1024 * 1024 * 1024 {
            return Err(err("tamanho de asset fora da faixa"));
        }
        Ok(())
    }
}

/// Campos cobertos pela assinatura.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestBody {
    pub schema: u16,
    pub project: String,
    pub version: String,
    pub channel: String,
    pub tag: String,
    pub commit: String,
    pub published_at_ms: i64,
    pub protocol_version: u32,
    pub min_protocol_version: u32,
    /// Contador monotônico global. Nunca regride numa release nova.
    pub security_epoch: u64,
    /// Versões abaixo desta época são OBSOLETAS (bloqueadas na rede).
    pub min_security_epoch: u64,
    /// Versões explicitamente revogadas por esta autoridade.
    pub revoked_versions: Vec<String>,
    /// Ids de chave revogados; o conjunto de confiança precisa refletir isto.
    pub revoked_key_ids: Vec<String>,
    pub assets: Vec<ManifestAsset>,
}

impl ManifestBody {
    pub fn validate(&self) -> Result<()> {
        if self.schema != MANIFEST_SCHEMA {
            return Err(err("schema de manifesto não suportado"));
        }
        if self.project != PROJECT_ID {
            return Err(err("manifesto de outro projeto"));
        }
        if !valid_version(&self.version) {
            return Err(err("versão inválida no manifesto"));
        }
        if !valid_text(&self.channel, 32) {
            return Err(err("canal inválido no manifesto"));
        }
        if self.tag.trim_start_matches('v') != self.version.split('-').next().unwrap_or("") {
            return Err(err("tag e versão não batem"));
        }
        if !valid_commit(&self.commit) {
            return Err(err("commit do manifesto não é SHA-1 de 40 hex"));
        }
        if self.published_at_ms <= 0 {
            return Err(err("data de publicação inválida"));
        }
        if self.protocol_version == 0 || self.protocol_version > 1_000_000 {
            return Err(err("protocol_version inválida"));
        }
        if self.min_protocol_version > self.protocol_version {
            return Err(err("min_protocol_version maior que a versão"));
        }
        if self.min_security_epoch > self.security_epoch {
            return Err(err("epoch mínima maior que a epoch do manifesto"));
        }
        if self.assets.is_empty() || self.assets.len() > MAX_ASSETS {
            return Err(err("quantidade de assets fora da faixa"));
        }
        if self.revoked_versions.len() > MAX_REVOKED || self.revoked_key_ids.len() > MAX_REVOKED {
            return Err(err("lista de revogação grande demais"));
        }
        for a in &self.assets {
            a.validate()?;
        }
        // Listas ordenadas e sem repetição são parte da forma canônica: duas
        // codificações do mesmo conteúdo assinariam hashes diferentes.
        for list in [&self.revoked_versions, &self.revoked_key_ids] {
            if !is_sorted_unique(list) {
                return Err(err("lista de revogação fora de ordem"));
            }
        }
        if !self
            .assets
            .windows(2)
            .all(|w| asset_key(&w[0]) < asset_key(&w[1]))
        {
            return Err(err("assets fora de ordem canônica"));
        }
        Ok(())
    }

    /// Bytes que as assinaturas cobrem. Inclui TODOS os campos do body.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>> {
        self.validate()?;
        let mut w = Enc::new();
        w.bytes(MANIFEST_MAGIC);
        w.u16(self.schema);
        w.str(&self.project);
        w.str(&self.version);
        w.str(&self.channel);
        w.str(&self.tag);
        w.str(&self.commit);
        w.i64(self.published_at_ms);
        w.u32(self.protocol_version);
        w.u32(self.min_protocol_version);
        w.u64(self.security_epoch);
        w.u64(self.min_security_epoch);
        w.str_list(&self.revoked_versions);
        w.str_list(&self.revoked_key_ids);
        w.u32(self.assets.len() as u32);
        for a in &self.assets {
            w.str(&a.name);
            w.str(&a.os);
            w.str(&a.arch);
            w.u64(a.size);
            w.str(&a.sha256);
            w.str(&a.url);
        }
        Ok(w.finish())
    }

    pub fn parse_canonical(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(err("manifesto acima do limite"));
        }
        let body = Dec::new(bytes).body()?;
        body.validate()?;
        // Fecha a porta para qualquer divergência entre "o que leu" e "o que
        // assinou": só a forma canônica exata é aceita.
        if body.canonical_bytes()? != bytes {
            return Err(err("manifesto não está na forma canônica"));
        }
        Ok(body)
    }

    pub fn hash_hex(&self) -> Result<String> {
        Ok(hex::encode(
            blake3::hash(&self.canonical_bytes()?).as_bytes(),
        ))
    }

    /// Bytes assinados por cada chave: domínio + hash do body.
    pub fn signing_payload(&self) -> Result<[u8; 32]> {
        let mut h = blake3::Hasher::new();
        h.update(SIGN_DOMAIN);
        h.update(&self.canonical_bytes()?);
        Ok(*h.finalize().as_bytes())
    }
}

fn asset_key(a: &ManifestAsset) -> (&str, &str, &str) {
    (a.os.as_str(), a.arch.as_str(), a.name.as_str())
}

fn is_sorted_unique(v: &[String]) -> bool {
    v.windows(2).all(|w| w[0] < w[1])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestSignature {
    /// blake3(pubkey)[..8] em hex (16 chars).
    pub key_id: String,
    /// Assinatura Ed25519 (64 bytes) em hex.
    pub sig: String,
}

impl ManifestSignature {
    fn validate_shape(&self) -> Result<()> {
        if !valid_key_id(&self.key_id) {
            return Err(err("key_id de assinatura inválido"));
        }
        if !valid_hex(&self.sig, 128) {
            return Err(err("assinatura não é 64 bytes hex"));
        }
        Ok(())
    }
}

/// Manifesto como circula no fio: body + assinaturas.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedManifest {
    pub body: ManifestBody,
    pub signatures: Vec<ManifestSignature>,
}

impl SignedManifest {
    /// Serializa body + assinaturas para transporte/cache. O body continua
    /// sendo exatamente o encoding canônico que foi assinado.
    pub fn to_wire(&self) -> Result<Vec<u8>> {
        let body = self.body.canonical_bytes()?;
        // Zero assinatura não é release: um manifesto não assinado não pode
        // nem circular (o receptor recusaria de qualquer forma).
        if self.signatures.is_empty() || self.signatures.len() > MAX_SIGNATURES {
            return Err(err("quantidade de assinaturas fora da faixa"));
        }
        let mut w = Enc::new();
        w.u32(body.len() as u32);
        w.bytes(&body);
        w.u32(self.signatures.len() as u32);
        for s in &self.signatures {
            s.validate_shape()?;
            w.str(&s.key_id);
            w.str(&s.sig);
        }
        let out = w.finish();
        if out.len() > MAX_MANIFEST_BYTES {
            return Err(err("manifesto assinado acima do limite"));
        }
        Ok(out)
    }

    pub fn from_wire(bytes: &[u8]) -> Result<Self> {
        if bytes.len() > MAX_MANIFEST_BYTES {
            return Err(err("manifesto assinado acima do limite"));
        }
        let mut d = Dec::new(bytes);
        let body_len = d.u32()? as usize;
        let body = ManifestBody::parse_canonical(d.take(body_len)?)?;
        let n = d.u32()? as usize;
        if n == 0 || n > MAX_SIGNATURES {
            return Err(err("quantidade de assinaturas fora da faixa"));
        }
        let mut signatures = Vec::with_capacity(n);
        for _ in 0..n {
            signatures.push(ManifestSignature {
                key_id: d.str()?,
                sig: d.str()?,
            });
        }
        d.expect_end()?;
        Ok(SignedManifest { body, signatures })
    }
}

fn err(msg: &str) -> DistorrentError {
    DistorrentError::Protocol(format!("release: {msg}"))
}

// ---------------------------------------------------------------------------
// Encoding primitivo
// ---------------------------------------------------------------------------

struct Enc {
    out: Vec<u8>,
}

impl Enc {
    fn new() -> Self {
        Self { out: Vec::new() }
    }
    fn bytes(&mut self, b: &[u8]) {
        self.out.extend_from_slice(b);
    }
    fn u16(&mut self, v: u16) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn u64(&mut self, v: u64) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn i64(&mut self, v: i64) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn str(&mut self, s: &str) {
        self.u32(s.len() as u32);
        self.bytes(s.as_bytes());
    }
    fn str_list(&mut self, v: &[String]) {
        self.u32(v.len() as u32);
        for s in v {
            self.str(s);
        }
    }
    fn finish(self) -> Vec<u8> {
        self.out
    }
}

struct Dec<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Dec<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        let end = self
            .pos
            .checked_add(n)
            .ok_or_else(|| err("manifesto truncado"))?;
        if end > self.buf.len() {
            return Err(err("manifesto truncado"));
        }
        let s = &self.buf[self.pos..end];
        self.pos = end;
        Ok(s)
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
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
        if n > MAX_STRING {
            return Err(err("string acima do limite"));
        }
        let b = self.take(n)?;
        String::from_utf8(b.to_vec()).map_err(|_| err("string não é UTF-8"))
    }
    fn str_list(&mut self) -> Result<Vec<String>> {
        let n = self.u32()? as usize;
        if n > MAX_REVOKED {
            return Err(err("lista acima do limite"));
        }
        let mut out = Vec::with_capacity(n);
        for _ in 0..n {
            out.push(self.str()?);
        }
        Ok(out)
    }
    fn body(mut self) -> Result<ManifestBody> {
        if self.take(5)? != MANIFEST_MAGIC {
            return Err(err("magic do manifesto inválido"));
        }
        let body = ManifestBody {
            schema: self.u16()?,
            project: self.str()?,
            version: self.str()?,
            channel: self.str()?,
            tag: self.str()?,
            commit: self.str()?,
            published_at_ms: self.i64()?,
            protocol_version: self.u32()?,
            min_protocol_version: self.u32()?,
            security_epoch: self.u64()?,
            min_security_epoch: self.u64()?,
            revoked_versions: self.str_list()?,
            revoked_key_ids: self.str_list()?,
            assets: {
                let n = self.u32()? as usize;
                if n == 0 || n > MAX_ASSETS {
                    return Err(err("quantidade de assets fora da faixa"));
                }
                let mut v = Vec::with_capacity(n);
                for _ in 0..n {
                    v.push(ManifestAsset {
                        name: self.str()?,
                        os: self.str()?,
                        arch: self.str()?,
                        size: self.u64()?,
                        sha256: self.str()?,
                        url: self.str()?,
                    });
                }
                v
            },
        };
        self.expect_end()?;
        Ok(body)
    }
    fn expect_end(&self) -> Result<()> {
        if self.pos != self.buf.len() {
            return Err(err("bytes sobrando no manifesto"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, os: &str, arch: &str) -> ManifestAsset {
        ManifestAsset {
            name: name.into(),
            os: os.into(),
            arch: arch.into(),
            size: 1234,
            sha256: "a".repeat(64),
            url: format!(
                "https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/{name}"
            ),
        }
    }

    fn body() -> ManifestBody {
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
            revoked_versions: vec!["1.1.0".into(), "1.1.1".into()],
            revoked_key_ids: vec![],
            assets: vec![
                asset("DisTorrent_1.2.3_arm64.apk", "android", "aarch64"),
                asset("DisTorrent_1.2.3_amd64.AppImage", "linux", "x86_64"),
                asset("DisTorrent_1.2.3_x64_setup.exe", "windows", "x86_64"),
            ],
        }
    }

    #[test]
    fn canonical_roundtrip_e_deterministico() {
        let b = body();
        let a = b.canonical_bytes().unwrap();
        let parsed = ManifestBody::parse_canonical(&a).unwrap();
        assert_eq!(parsed, b);
        assert_eq!(parsed.canonical_bytes().unwrap(), a);
        assert_eq!(b.hash_hex().unwrap(), parsed.hash_hex().unwrap());
    }

    #[test]
    fn reordem_de_assets_quebra_a_forma_canonica() {
        let mut b = body();
        b.assets.reverse();
        assert!(b.canonical_bytes().is_err());
        // O `validate` sozinho não ordena, mas `canonical_bytes` rejeita; a
        // forma canônica é o que a assinatura cobre.
        assert!(b.validate().is_err());
    }

    #[test]
    fn versao_adulterada_sem_reassinar_muda_o_hash() {
        let b = body();
        let h1 = b.hash_hex().unwrap();
        let mut b2 = b.clone();
        b2.version = "9.9.9".into();
        b2.tag = "v9.9.9".into();
        assert_ne!(h1, b2.hash_hex().unwrap());
    }

    #[test]
    fn assinatura_trocada_muda_o_hash() {
        let b = body();
        let h1 = b.hash_hex().unwrap();
        let mut b2 = b.clone();
        b2.assets[0].sha256 = "c".repeat(64);
        assert_ne!(h1, b2.hash_hex().unwrap());
    }

    #[test]
    fn tag_divergente_da_versao_e_recusada() {
        let mut b = body();
        b.tag = "v1.2.4".into();
        assert!(b.canonical_bytes().is_err());
    }

    #[test]
    fn wire_roundtrip_preserva_body_e_assinaturas() {
        let m = SignedManifest {
            body: body(),
            signatures: vec![
                ManifestSignature {
                    key_id: "0123456789abcdef".into(),
                    sig: "d".repeat(128),
                },
                ManifestSignature {
                    key_id: "fedcba9876543210".into(),
                    sig: "e".repeat(128),
                },
            ],
        };
        let w = m.to_wire().unwrap();
        assert_eq!(SignedManifest::from_wire(&w).unwrap(), m);
    }

    #[test]
    fn wire_sem_assinatura_e_recusado() {
        let m = SignedManifest {
            body: body(),
            signatures: vec![],
        };
        assert!(m.to_wire().is_err());
    }

    #[test]
    fn manifesto_gigante_ou_truncado_nao_panica() {
        let m = SignedManifest {
            body: body(),
            signatures: vec![ManifestSignature {
                key_id: "0123456789abcdef".into(),
                sig: "d".repeat(128),
            }],
        };
        let w = m.to_wire().unwrap();
        for cut in 0..w.len() {
            let _ = SignedManifest::from_wire(&w[..cut]);
        }
        assert!(SignedManifest::from_wire(&vec![0u8; MAX_MANIFEST_BYTES + 1]).is_err());
    }

    #[test]
    fn url_http_pura_e_recusada() {
        let mut b = body();
        b.assets[0].url = "http://github.com/x".into();
        assert!(b.canonical_bytes().is_err());
    }

    #[test]
    fn epoch_minima_maior_que_a_epoch_e_recusada() {
        let mut b = body();
        b.min_security_epoch = b.security_epoch + 1;
        assert!(b.canonical_bytes().is_err());
    }
}
