//! Cofre portável `.stormvault` — a conta INTEIRA (identidade + histórico +
//! contatos + comunidades + configurações) num único arquivo cifrado,
//! migrável entre dispositivos SEM servidor central.
//!
//! Formato (v1):
//! ```text
//! magic "DSVT" | versão u16be | hdr_len u32be | header JSON | payload
//! payload = salt(16) || nonce(12) || ciphertext(ChaCha20Poly1305)
//! ```
//! - Header é plaintext (versionado) e entra como AAD do AEAD — trocar
//!   qualquer campo do header invalida a cifra (anti-adulteração).
//! - `payload_hash` (blake3 do body — plaintext comprimido) é verificado
//!   PÓS-decrypt como defesa em profundidade (o AEAD já autenticou);
//!   `payload_len` dá detecção rápida de truncamento ANTES da KDF
//!   (arquivo truncado/bitrot não gasta Argon2).
//! - Chave: Argon2id (m=19MiB, t=2, p=1 — OWASP, igual ao vault local) →
//!   HKDF-SHA256 com domínio separada (`stormvault/v1`). Modo "key" (backup
//!   automático): deriva de chave em RAM (ver `backup_key_for`), sem KDF
//!   cara — o cofre local continua sendo o fator de proteção.
//! - Payload comprimido com zstd quando vale a pena (histórico em JSON
//!   comprime ~10x). Voz/vídeo já comprimidos não são afetados (não entram).
//!
//! Merge na importação: NÃO sobrescreve dados mais recentes — mensagens são
//! deduplicadas por id (INSERT OR IGNORE, id = hash do conteúdo+autor+ts),
//! amigos/canais/cargos entram por upsert "novo valor não-vazio vence",
//! configurações locais têm precedência. Conflito de identidade com
//! fingerprint DIFERENTE é recusado (multi-conta existe para isso).

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{ChaCha20Poly1305, KeyInit, Nonce};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::storage::Store;
use crate::{ForgeError, Result};

pub const MAGIC: [u8; 4] = *b"DSVT";
pub const FORMAT_VERSION: u16 = 1;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const HKDF_INFO: &[u8] = b"distorrent/stormvault/v1";
/// Compressão só quando o ganho passa esse limiar (evita crescer payload já denso).
const COMPRESS_MIN_GAIN: f64 = 0.15;
/// Teto de mensagens por export (padrão de segurança contra cofres gigantes;
/// None = sem limite, escolha explícita do usuário na UI).
pub const DEFAULT_MAX_MESSAGES: usize = 200_000;

/// Chaves kv que migram entre dispositivos. Segredos NUNCA entram aqui.
const SETTINGS_WHITELIST: &[&str] = &["privacy.mode", "privacy.proxy_addr"];

// ---------------- header (plaintext, versionado) ----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StormVaultHeader {
    pub v: u16,
    pub app: String,
    pub created_ms: i64,
    /// Fingerprint da identidade — permite identificar o cofre ANTES de abrir
    /// (é um hash público, não segredo).
    pub fp: String,
    pub nickname: String,
    pub msg_count: usize,
    /// "argon2id" (senha) | "key" (chave derivada em RAM — backup automático)
    pub kdf: String,
    #[serde(default)]
    pub kdf_params: serde_json::Value,
    pub cipher: String,
    pub compressed: bool,
    pub payload_len: u64,
    pub payload_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StormVaultMeta {
    pub app_version: Option<String>,
    pub messages_truncated: bool,
}

// ---------------- dados do cofre (plaintext interno) ----------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FriendRow {
    pub fp: String,
    pub nickname: String,
    pub status: String,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommunityExport {
    pub id: String,
    pub name: String,
    pub owner_fp: String,
    pub created_at: i64,
    pub description: String,
    pub category: String,
    pub icon: String,
    pub channels: Vec<crate::storage::ChannelMetaRow>,
    pub roles: Vec<crate::storage::RoleRow>,
    pub bots: Vec<crate::storage::BotRow>,
    pub members: Vec<(String, String, String)>,
    pub member_roles: Vec<(String, Vec<String>)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReputationRow {
    pub fp: String,
    pub trust: String,
    pub score: i32,
    pub reports: u32,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportRow {
    pub id: String,
    pub reporter_fp: String,
    pub target_fp: String,
    pub community_id: String,
    pub reason: String,
    pub status: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupExport {
    pub conv: crate::storage::Conversation,
    pub members: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StormVaultData {
    pub identity: crate::identity::Identity,
    /// Chave privada (hex) — presente só quando o usuário exportou COM
    /// identidade. Fica cifrada no arquivo; nunca em texto plano no disco.
    pub secret_hex: Option<String>,
    pub conversations: Vec<crate::storage::Conversation>,
    pub messages: Vec<crate::storage::StoredMessage>,
    pub friends: Vec<FriendRow>,
    pub peers: Vec<crate::storage::PeerRecord>,
    pub communities: Vec<CommunityExport>,
    pub rules: Vec<crate::moderation::ServerRules>,
    pub reputations: Vec<ReputationRow>,
    pub audit: Vec<crate::moderation::AuditEntry>,
    pub reports: Vec<ReportRow>,
    pub groups: Vec<GroupExport>,
    pub settings: Vec<(String, String)>,
    pub meta: StormVaultMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportReport {
    pub fp: String,
    pub nickname: String,
    pub created_ms: i64,
    pub identity_installed: bool,
    pub messages_merged: usize,
    pub message_conflicts: usize,
    pub conversations_added: usize,
    pub friends_merged: usize,
    pub peers_merged: usize,
    pub communities_merged: usize,
    pub rules_merged: usize,
    pub reputations_merged: usize,
    pub audit_merged: usize,
    pub reports_merged: usize,
    pub groups_merged: usize,
    pub settings_imported: usize,
    pub messages_truncated: bool,
}

// ---------------- coleta (export) ----------------

/// Chave de backup automático: deriva da secret da identidade em RAM.
/// Qualquer device que desbloqueie a MESMA conta deriva a mesma chave —
/// backups são portáveis junto com a identidade, e o fator de proteção
/// continua sendo a senha do cofre local (ninguém sem a senha chega aqui).
pub fn backup_key_for(secret_hex: &str) -> [u8; 32] {
    let mut h = blake3::Hasher::new();
    h.update(b"distorrent/stormvault/backup-key/v1");
    h.update(secret_hex.to_lowercase().as_bytes());
    let out = *h.finalize().as_bytes();
    out
}

/// Coleta a conta inteira do Store para o payload do cofre.
/// `secret_hex`: chave privada se o export deve carregar a identidade
/// (None = export de dados sem a chave — mesclável num device que já tem a conta).
pub fn collect(
    store: &Store,
    secret_hex: Option<String>,
    max_messages: Option<usize>,
) -> Result<StormVaultData> {
    store.stormvault_collect(secret_hex, max_messages, SETTINGS_WHITELIST)
}

/// Serializa → comprime (se valer a pena) → cifra → monta o container.
pub fn seal_with_password(data: &StormVaultData, password: &str) -> Result<Vec<u8>> {
    if password.chars().count() < 8 {
        return Err(ForgeError::Crypto(
            "senha muito curta (mínimo 8 caracteres)".into(),
        ));
    }
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let master = derive_password_key(password, &salt)?;
    let key = hkdf_expand(&master, &salt);
    seal_container(
        data,
        &key,
        &salt,
        "argon2id",
        serde_json::json!({"m": 19_456, "t": 2, "p": 1}),
    )
}

/// Cifra com chave direta (backup automático — sem KDF cara no caminho).
pub fn seal_with_key(data: &StormVaultData, key: &[u8; 32]) -> Result<Vec<u8>> {
    let mut salt = [0u8; SALT_LEN];
    rand::thread_rng().fill_bytes(&mut salt);
    let derived = hkdf_expand(key, &salt);
    seal_container(data, &derived, &salt, "key", serde_json::Value::Null)
}

fn seal_container(
    data: &StormVaultData,
    key: &[u8; 32],
    salt: &[u8; SALT_LEN],
    kdf: &str,
    kdf_params: serde_json::Value,
) -> Result<Vec<u8>> {
    let plain = serde_json::to_vec(data)
        .map_err(|e| ForgeError::Protocol(format!("serializar cofre: {e}")))?;
    // compressão adaptativa: só quando o ganho é real
    let (body, compressed) = {
        let z = zstd::stream::encode_all(plain.as_slice(), 3).map_err(ForgeError::Io)?;
        if plain.len() > 4096 && (z.len() as f64) < plain.len() as f64 * (1.0 - COMPRESS_MIN_GAIN) {
            (z, true)
        } else {
            (plain, false)
        }
    };
    let mut nonce = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce);

    // header ANTES do ciphertext: entra no AAD (anti-tamper de cabeçalho).
    // payload_hash cobre o BODY (plaintext comprimido): detecta adulteração
    // de conteúdo mesmo que o AEAD passe (defesa em profundidade).
    let header = StormVaultHeader {
        v: FORMAT_VERSION,
        app: "distorrent".into(),
        created_ms: crate::identity::now_ms(),
        fp: data.identity.fingerprint.clone(),
        nickname: data.identity.nickname.clone(),
        msg_count: data.messages.len(),
        kdf: kdf.into(),
        kdf_params,
        cipher: "chacha20poly1305".into(),
        compressed,
        payload_len: (SALT_LEN + NONCE_LEN + body.len() + 16) as u64,
        payload_hash: blake3_hex(&body),
    };
    let header_json = serde_json::to_vec(&header)
        .map_err(|e| ForgeError::Protocol(format!("serializar header: {e}")))?;

    let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(key));
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &body,
                aad: &aad_bytes(&header_json),
            },
        )
        .map_err(|_| ForgeError::Crypto("falha ao cifrar cofre".into()))?;

    let payload = [salt.as_ref(), nonce.as_ref(), ct.as_slice()].concat();
    let mut out = Vec::with_capacity(4 + 2 + 4 + header_json.len() + payload.len());
    out.extend_from_slice(&MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    out.extend_from_slice(&(header_json.len() as u32).to_be_bytes());
    out.extend_from_slice(&header_json);
    out.extend_from_slice(&payload);
    Ok(out)
}

fn aad_bytes(header_json: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(10 + header_json.len());
    aad.extend_from_slice(&MAGIC);
    aad.extend_from_slice(&FORMAT_VERSION.to_be_bytes());
    aad.extend_from_slice(&(header_json.len() as u32).to_be_bytes());
    aad.extend_from_slice(header_json);
    aad
}

/// Lê o header sem descriptografar — para a UI mostrar de quem é o cofre
/// antes de pedir a senha. Não expõe nada sensível (fp é hash público).
pub fn read_header(bytes: &[u8]) -> Result<StormVaultHeader> {
    let (header_json, _payload) = split_container(bytes)?;
    serde_json::from_slice(&header_json)
        .map_err(|e| ForgeError::Protocol(format!("header inválido: {e}")))
}

fn split_container(bytes: &[u8]) -> Result<(&[u8], &[u8])> {
    if bytes.len() < 4 + 2 + 4 || bytes[..4] != MAGIC {
        return Err(ForgeError::Protocol("não é um cofre .stormvault".into()));
    }
    let version = u16::from_be_bytes([bytes[4], bytes[5]]);
    if version > FORMAT_VERSION {
        return Err(ForgeError::Protocol(format!(
            "cofre versão {version} — atualize o app (formato mais novo)"
        )));
    }
    let hdr_len = u32::from_be_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]) as usize;
    let hdr_end = 10usize
        .checked_add(hdr_len)
        .ok_or_else(|| ForgeError::Protocol("cofre corrompido (header gigante)".into()))?;
    if bytes.len() < hdr_end + SALT_LEN + NONCE_LEN + 16 {
        return Err(ForgeError::Protocol("cofre corrompido (truncado)".into()));
    }
    Ok((&bytes[10..hdr_end], &bytes[hdr_end..]))
}

/// Abre com senha (export manual / import).
pub fn open_with_password(bytes: &[u8], password: &str) -> Result<StormVaultData> {
    let (header_json, payload) = split_container(bytes)?;
    let header: StormVaultHeader = serde_json::from_slice(&header_json)
        .map_err(|e| ForgeError::Protocol(format!("header inválido: {e}")))?;
    verify_container_shape(&header, &payload)?;
    if header.kdf != "argon2id" {
        return Err(ForgeError::Crypto(
            "cofre foi selado com chave de backup — restaure pelo app já desbloqueado".into(),
        ));
    }
    let (salt, rest) = payload.split_at(SALT_LEN);
    let (m, t, p) = kdf_params_from(&header)?;
    let master = derive_password_key_with_params(password, salt, m, t, p)?;
    let key = hkdf_expand(&master, salt);
    open_payload(&header, &key, rest, &header_json)
}

/// Abre com chave derivada (backup automático).
pub fn open_with_key(bytes: &[u8], key: &[u8; 32]) -> Result<StormVaultData> {
    let (header_json, payload) = split_container(bytes)?;
    let header: StormVaultHeader = serde_json::from_slice(&header_json)
        .map_err(|e| ForgeError::Protocol(format!("header inválido: {e}")))?;
    verify_container_shape(&header, &payload)?;
    if header.kdf != "key" {
        return Err(ForgeError::Crypto(
            "cofre protegido por senha — informe a senha".into(),
        ));
    }
    let (salt, rest) = payload.split_at(SALT_LEN);
    let derived = hkdf_expand(key, salt);
    open_payload(&header, &derived, rest, &header_json)
}

fn open_payload(
    header: &StormVaultHeader,
    key: &[u8; 32],
    nonce_and_ct: &[u8],
    header_json: &[u8],
) -> Result<StormVaultData> {
    let (nonce, ct) = nonce_and_ct.split_at(NONCE_LEN);
    let cipher = ChaCha20Poly1305::new(chacha20poly1305::Key::from_slice(key));
    let body = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ct,
                aad: &aad_bytes(header_json),
            },
        )
        .map_err(|_| ForgeError::Crypto("senha incorreta ou cofre adulterado".into()))?;
    // hash do body (defesa em profundidade: AEAD já autenticou)
    if header.payload_hash != blake3_hex(&body) {
        return Err(ForgeError::Protocol(
            "cofre adulterado (hash do conteúdo não confere)".into(),
        ));
    }
    let plain = if header.compressed {
        zstd::stream::decode_all(body.as_slice()).map_err(ForgeError::Io)?
    } else {
        body
    };
    serde_json::from_slice(&plain)
        .map_err(|e| ForgeError::Protocol(format!("conteúdo do cofre inválido: {e}")))
}

/// Checagem de forma ANTES da KDF: tamanho declarado no header confere com o
/// arquivo real (truncamento/concatenação de cofres não gasta Argon2 à toa).
fn verify_container_shape(header: &StormVaultHeader, payload: &[u8]) -> Result<()> {
    if header.payload_len != payload.len() as u64 {
        return Err(ForgeError::Protocol(
            "cofre truncado ou colado (tamanho não confere com o header)".into(),
        ));
    }
    Ok(())
}

// ---------------- mesclagem (import) ----------------

/// Importa um arquivo `.stormvault` aberto com senha. Se o device está limpo,
/// instala a identidade (a senha do arquivo vira a senha do cofre local);
/// se já tem a MESMA conta, só mescla os dados. Conta diferente → recusa.
/// Importa um arquivo `.stormvault` aberto com senha. Se o device está limpo,
/// instala a identidade (a senha do arquivo vira a senha do cofre local);
/// se já tem a MESMA conta, só mescla os dados. Conta diferente → recusa.
pub fn import_with_password(store: &Store, bytes: &[u8], password: &str) -> Result<ImportReport> {
    let data = open_with_password(bytes, password)?;
    let installing = store.load_identity().is_none();
    if installing {
        let secret = data.secret_hex.clone().ok_or_else(|| {
            ForgeError::Protocol(
                "cofre sem chave privada — não dá para instalar a identidade".into(),
            )
        })?;
        let blob = crate::vault::seal_secret(&secret, password)?;
        store.save_identity(&data.identity, &hex::encode(&blob))?;
        store.kv_set("vault.on", "1")?;
    }
    let mut report = import_merge_only(store, &data)?;
    if installing {
        report.identity_installed = true;
    }
    Ok(report)
}

/// Mescla sem instalar identidade (device já tem a mesma conta).
pub fn import_merge_only(store: &Store, data: &StormVaultData) -> Result<ImportReport> {
    let mut report = ImportReport {
        fp: data.identity.fingerprint.clone(),
        nickname: data.identity.nickname.clone(),
        created_ms: crate::identity::now_ms(),
        identity_installed: false,
        messages_merged: 0,
        message_conflicts: 0,
        conversations_added: 0,
        friends_merged: 0,
        peers_merged: 0,
        communities_merged: 0,
        rules_merged: 0,
        reputations_merged: 0,
        audit_merged: 0,
        reports_merged: 0,
        groups_merged: 0,
        settings_imported: 0,
        messages_truncated: data.meta.messages_truncated,
    };
    let Some(local) = store.load_identity() else {
        return Err(ForgeError::Protocol(
            "nenhuma conta neste device — importe o cofre completo (com identidade)".into(),
        ));
    };
    if local.fingerprint != data.identity.fingerprint {
        return Err(ForgeError::Protocol(format!(
            "cofre de outra conta ({}) — este device usa {}",
            data.identity.fingerprint, local.fingerprint
        )));
    }
    store.stormvault_merge(data, &mut report)?;
    Ok(report)
}

// ---------------- cripto helpers ----------------

fn derive_password_key(password: &str, salt: &[u8]) -> Result<[u8; 32]> {
    derive_password_key_with_params(password, salt, 19_456, 2, 1)
}

/// Parâmetros lidos do header ( Cofres futuros com m/t/p diferentes abrem
/// certo; valores absurdos viram erro honesto em vez de OOM).
fn kdf_params_from(header: &StormVaultHeader) -> Result<(u32, u32, u32)> {
    let v = &header.kdf_params;
    let m = v.get("m").and_then(|x| x.as_u64()).unwrap_or(19_456) as u32;
    let t = v.get("t").and_then(|x| x.as_u64()).unwrap_or(2) as u32;
    let p = v.get("p").and_then(|x| x.as_u64()).unwrap_or(1) as u32;
    if !(1_024..=262_144).contains(&m) || !(1..=10).contains(&t) || !(1..=8).contains(&p) {
        return Err(ForgeError::Crypto(
            "cofre com parâmetros KDF fora do suportado — atualize o app".into(),
        ));
    }
    Ok((m, t, p))
}

fn derive_password_key_with_params(
    password: &str,
    salt: &[u8],
    m: u32,
    t: u32,
    p: u32,
) -> Result<[u8; 32]> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let params = Params::new(m, t, p, Some(32))
        .map_err(|e| ForgeError::Crypto(format!("argon2 params: {e}")))?;
    let a2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut okm = [0u8; 32];
    a2.hash_password_into(password.as_bytes(), salt, &mut okm)
        .map_err(|e| ForgeError::Crypto(format!("argon2: {e}")))?;
    Ok(okm)
}

fn hkdf_expand(master: &[u8; 32], salt: &[u8]) -> [u8; 32] {
    use hkdf::Hkdf;
    use sha2::Sha256;
    let hk = Hkdf::<Sha256>::new(Some(salt), master);
    let mut okm = [0u8; 32];
    let _ = hk.expand(HKDF_INFO, &mut okm); // 32 bytes: nunca falha
    okm
}

fn blake3_hex(bytes: &[u8]) -> String {
    hex::encode(blake3::hash(bytes).as_bytes())
}

/// Helper: nome canônico do arquivo de backup para um instante.
pub fn backup_file_name(unix_ms: i64) -> String {
    format!("stormvault-{unix_ms}.stormvault")
}

/// Lista os snapshots `.stormvault` de um diretório (mais novos primeiro).
pub fn list_backup_files(dir: &std::path::Path) -> Vec<(String, i64, u64)> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("stormvault-") || !name.ends_with(".stormvault") {
            continue;
        }
        let Ok(ts): std::result::Result<i64, std::num::ParseIntError> = name
            .trim_start_matches("stormvault-")
            .trim_end_matches(".stormvault")
            .parse()
        else {
            continue;
        };
        let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push((name, ts, bytes));
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.1));
    out
}

/// Apaga snapshots além da retenção (dias). Os 2 mais novos nunca saem.
/// Retorna quantos arquivos foram removidos.
pub fn prune_backup_files(
    dir: &std::path::Path,
    retention_days: i64,
    now_ms: i64,
) -> Result<usize> {
    let days = retention_days.clamp(1, 3650);
    let cutoff = now_ms - days * 86_400_000;
    let files = list_backup_files(dir);
    let mut removed = 0;
    for (i, (name, ts, _)) in files.iter().enumerate() {
        if i < 2 {
            continue;
        }
        if *ts < cutoff && std::fs::remove_file(dir.join(name)).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Store;

    fn sample_data(store: &Store) -> StormVaultData {
        collect(store, Some("ab".repeat(32)), None).unwrap()
    }

    fn seeded_store() -> Store {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let identity = kp.identity("tester");
        store.save_identity(&identity, &kp.secret_hex()).unwrap();
        // conversa + mensagem
        let conv = store
            .ensure_dm_conversation(&identity.fingerprint, "aabbccddeeff", "amigo")
            .unwrap();
        let env = crate::protocol::MessageEnvelope::new(&kp, &conv.id, "histórico portável");
        store.insert_message(&env, "out", "sent").unwrap();
        // amigo
        store
            .set_friend("aabbccddeeff", "amigo", "accepted")
            .unwrap();
        store
    }

    #[test]
    fn roundtrip_com_senha() {
        let store = seeded_store();
        let data = sample_data(&store);
        let sealed = seal_with_password(&data, "senha-forte-123").unwrap();
        // magic + versão
        assert_eq!(&sealed[..4], &MAGIC[..]);
        assert_eq!(u16::from_be_bytes([sealed[4], sealed[5]]), 1);
        let opened = open_with_password(&sealed, "senha-forte-123").unwrap();
        assert_eq!(opened.identity.fingerprint, data.identity.fingerprint);
        assert_eq!(opened.messages.len(), 1);
        assert_eq!(opened.messages[0].body, "histórico portável");
        assert_eq!(opened.secret_hex.as_deref(), Some("ab".repeat(32).as_str()));
        // chave privada não aparece em claro no arquivo
        assert!(!sealed.windows(16).any(|w| w == [0xabu8; 16]));
    }

    #[test]
    fn header_legivel_sem_senha() {
        let store = seeded_store();
        let data = sample_data(&store);
        let sealed = seal_with_password(&data, "senha-forte-123").unwrap();
        let h = read_header(&sealed).unwrap();
        assert_eq!(h.fp, data.identity.fingerprint);
        assert_eq!(h.nickname, "tester");
        assert_eq!(h.msg_count, 1);
        assert_eq!(h.v, 1);
    }

    #[test]
    fn senha_errada_falha() {
        let store = seeded_store();
        let sealed = seal_with_password(&sample_data(&store), "correta123").unwrap();
        assert!(open_with_password(&sealed, "errada123").is_err());
    }

    #[test]
    fn tamper_no_payload_e_no_header_falham() {
        let store = seeded_store();
        let sealed = seal_with_password(&sample_data(&store), "senha12345").unwrap();
        // bit flip no meio do ciphertext
        let mut bad = sealed.clone();
        let mid = bad.len() / 2;
        bad[mid] ^= 0xFF;
        assert!(open_with_password(&bad, "senha12345").is_err());
        // bit flip no header (AAD detecta)
        let mut bad2 = sealed;
        bad2[12] ^= 0x01;
        assert!(open_with_password(&bad2, "senha12345").is_err());
    }

    #[test]
    fn arquivo_truncado_ou_lixo_falha_rapido() {
        let store = seeded_store();
        let sealed = seal_with_password(&sample_data(&store), "senha12345").unwrap();
        assert!(open_with_password(&sealed[..sealed.len() - 10], "senha12345").is_err());
        let mut junk = vec![0u8; 200];
        junk[..4].copy_from_slice(&MAGIC);
        assert!(read_header(&junk).is_err());
        assert!(open_with_password(b"nao e um cofre", "senha12345").is_err());
    }

    #[test]
    fn versao_futura_rejeitada() {
        let store = seeded_store();
        let mut sealed = seal_with_password(&sample_data(&store), "senha12345").unwrap();
        sealed[5] = 0x63; // versão 299
        assert!(open_with_password(&sealed, "senha12345")
            .unwrap_err()
            .to_string()
            .contains("atualize"));
    }

    #[test]
    fn modo_key_backup_roundtrip_e_dominio_separado() {
        let store = seeded_store();
        let data = sample_data(&store);
        let key = backup_key_for(&"ab".repeat(32));
        let sealed = seal_with_key(&data, &key).unwrap();
        let opened = open_with_key(&sealed, &key).unwrap();
        assert_eq!(opened.identity.fingerprint, data.identity.fingerprint);
        // chave errada não abre
        let wrong = backup_key_for("outra");
        assert!(open_with_key(&sealed, &wrong).is_err());
        // cofre de senha não abre como key e vice-versa
        let pass_sealed = seal_with_password(&data, "senha12345").unwrap();
        assert!(open_with_key(&pass_sealed, &key).is_err());
        assert!(open_with_password(&sealed, "senha12345").is_err());
    }

    #[test]
    fn import_mescla_sem_perder_recentes() {
        // device A exporta
        let a = seeded_store();
        let data = sample_data(&a);
        // device B: MESMA conta (identidade do cofre), mensagem LOCAL que não pode sumir
        let b = Store::open_in_memory().unwrap();
        b.save_identity(&data.identity, "x").unwrap();
        let kp = crate::identity::Keypair::from_secret_hex("cd".repeat(32).as_str()).unwrap();
        let conv_b = b
            .ensure_dm_conversation(&data.identity.fingerprint, "aabbccddeeff", "amigo")
            .unwrap();
        let env_local = crate::protocol::MessageEnvelope::new(&kp, &conv_b.id, "msg local nova");
        b.insert_message(&env_local, "out", "sent").unwrap();
        // mesma ID da mensagem do cofre, mas com corpo LOCAL diferente:
        // simula edição local posterior — o merge NÃO pode sobrescrever
        let mut clash = crate::protocol::MessageEnvelope::new(&kp, &conv_b.id, "versão local de B");
        clash.id = data.messages[0].id.clone();
        b.insert_message(&clash, "out", "sent").unwrap();

        let report = import_merge_only(&b, &data).unwrap();
        assert_eq!(report.messages_merged, 0); // nada novo: id_Y é local, id_X conflita
        assert_eq!(report.message_conflicts, 1); // id_X: cópia local vence
        let msgs = b.list_messages(&conv_b.id, 100).unwrap();
        assert_eq!(msgs.len(), 2);
        assert!(msgs.iter().any(|m| m.body == "msg local nova"));
        assert!(msgs.iter().any(|m| m.body == "versão local de B"));
        assert!(!msgs.iter().any(|m| m.body == "histórico portável")); // cofre não sobrescreveu
    }

    #[test]
    fn import_em_device_limpo_instala_identidade() {
        let a = seeded_store();
        let data = sample_data(&a);
        let sealed = seal_with_password(&data, "senha-forte-123").unwrap();

        let b = Store::open_in_memory().unwrap();
        let report = import_with_password(&b, &sealed, "senha-forte-123").unwrap();
        assert!(report.identity_installed);
        assert_eq!(report.messages_merged, 1);
        // identidade instalada + cofre local ligado com a MESMA senha
        assert_eq!(b.kv_get("vault.on").as_deref(), Some("1"));
        let blob_hex = b.load_secret_hex().unwrap();
        let secret =
            crate::vault::open_sealed(&hex::decode(&blob_hex).unwrap(), "senha-forte-123").unwrap();
        assert_eq!(secret, data.secret_hex.unwrap());
        // mensagem presente
        let identity = b.load_identity().unwrap();
        let convs = b.list_conversations().unwrap();
        assert_eq!(convs.len(), 1);
        let msgs = b.list_messages(&convs[0].id, 100).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].body, "histórico portável");
        let _ = identity;
    }

    #[test]
    fn import_conta_diferente_recusado() {
        let a = seeded_store();
        let mut data = sample_data(&a);
        data.identity.fingerprint = "00000000ffff".into();
        let b = seeded_store();
        assert!(import_merge_only(&b, &data).is_err());
    }

    #[test]
    fn export_sem_chave_nao_instala_em_device_limpo() {
        let a = seeded_store();
        let data = collect(&a, None, None).unwrap();
        let b = Store::open_in_memory().unwrap();
        assert!(import_merge_only(&b, &data).is_err());
    }

    #[test]
    fn compressao_reduz_historico_grande() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let identity = kp.identity("bulk");
        store.save_identity(&identity, &kp.secret_hex()).unwrap();
        let conv = store
            .ensure_dm_conversation(&identity.fingerprint, "aabbccddeeff", "amigo")
            .unwrap();
        for i in 0..200 {
            let env = crate::protocol::MessageEnvelope::new(
                &kp,
                &conv.id,
                &format!("mensagem repetitiva número {i} do histórico para comprimir"),
            );
            store.insert_message(&env, "in", "ok").unwrap();
        }
        let data = collect(&store, None, None).unwrap();
        let sealed = seal_with_password(&data, "senha12345").unwrap();
        let h = read_header(&sealed).unwrap();
        assert!(h.compressed, "histórico grande deve comprimir");
        // payload cifrado+comprimido menor que o plaintext JSON
        let plain = serde_json::to_vec(&data).unwrap();
        assert!(sealed.len() < plain.len());
        let opened = open_with_password(&sealed, "senha12345").unwrap();
        assert_eq!(opened.messages.len(), 200);
    }

    #[test]
    fn backup_file_name_formatavel() {
        assert!(backup_file_name(123).ends_with("123.stormvault"));
    }
}
