use blake3::Hasher;
use serde::{Deserialize, Serialize};

use crate::identity::Keypair;

pub const PROTOCOL_NAME: &str = "distorrent/v1";
pub const MAGIC: &[u8; 4] = b"FGE1";

pub fn message_sign_bytes(
    id: &str,
    conv_id: &str,
    author_fp: &str,
    body: &str,
    ts: i64,
) -> Vec<u8> {
    let mut h = Hasher::new();
    h.update(PROTOCOL_NAME.as_bytes());
    h.update(b"|msg|");
    h.update(id.as_bytes());
    h.update(b"|");
    h.update(conv_id.as_bytes());
    h.update(b"|");
    h.update(author_fp.as_bytes());
    h.update(b"|");
    h.update(body.as_bytes());
    h.update(b"|");
    h.update(&ts.to_be_bytes());
    h.finalize().as_bytes().to_vec()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MessageEnvelope {
    pub id: String,
    pub conv_id: String,
    pub author_fp: String,
    pub body: String,
    pub ts: i64,
    pub sig: String,
}

impl MessageEnvelope {
    pub fn new(kp: &Keypair, conv_id: &str, body: &str) -> Self {
        let ts = crate::identity::now_ms();
        let id = new_message_id(&kp.fingerprint(), conv_id, ts, body);
        let sig = kp.sign(&message_sign_bytes(
            &id,
            conv_id,
            &kp.fingerprint(),
            body,
            ts,
        ));
        Self {
            id,
            conv_id: conv_id.to_string(),
            author_fp: kp.fingerprint(),
            body: body.to_string(),
            ts,
            sig,
        }
    }

    pub fn verify_with_pubkey(&self, pubkey_hex: &str) -> bool {
        if !crate::identity::fingerprint_matches(&self.author_fp, pubkey_hex) {
            return false;
        }
        Keypair::verify(
            pubkey_hex,
            &message_sign_bytes(
                &self.id,
                &self.conv_id,
                &self.author_fp,
                &self.body,
                self.ts,
            ),
            &self.sig,
        )
        .unwrap_or(false)
    }
}

pub fn new_message_id(author_fp: &str, conv_id: &str, ts: i64, body: &str) -> String {
    let mut h = Hasher::new();
    let mut rnd = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut rnd);
    h.update(author_fp.as_bytes());
    h.update(conv_id.as_bytes());
    h.update(&ts.to_be_bytes());
    h.update(body.as_bytes());
    h.update(&rnd);
    hex::encode(h.finalize().as_bytes())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub fp: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub nonce: [u8; 16],
    pub eph_pub: [u8; 32],
    pub tcp_port: u16,
    #[serde(default)]
    pub proto_v: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloAck {
    pub fp: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub nonce: [u8; 16],
    pub eph_pub: [u8; 32],
    pub sig: String,
    #[serde(default)]
    pub proto_v: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloOk {
    pub sig: String,
}

pub fn handshake_transcript(
    fp_a: &str,
    eph_a: &[u8; 32],
    nonce_a: &[u8; 16],
    fp_b: &str,
    eph_b: &[u8; 32],
    nonce_b: &[u8; 16],
) -> Vec<u8> {
    let mut h = Hasher::new();
    h.update(PROTOCOL_NAME.as_bytes());
    h.update(b"|hs|");
    h.update(fp_a.as_bytes());
    h.update(eph_a);
    h.update(nonce_a);
    h.update(fp_b.as_bytes());
    h.update(eph_b);
    h.update(nonce_b);
    h.finalize().as_bytes().to_vec()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SecureFrame {
    Msg(MessageEnvelope),
    Ack {
        msg_id: String,
    },
    Read {
        conv_id: String,
        up_to_ts: i64,
    },
    FriendRequest {
        nickname: String,
    },
    FriendAccept {
        nickname: String,
    },
    FriendReject,
    FriendRemove,
    Punch {
        endpoint: String,
        at_ms: u64,
        nonce: [u8; 16],
    },
    TunnelOffer {
        eph_pub_hex: String,
        nonce_hex: String,
        sig: String,
    },
    TunnelAnswer {
        eph_pub_hex: String,
        nonce_hex: String,
        for_nonce_hex: String,
        sig: String,
    },
    TunnelData {
        nonce: u64,
        ct_b64: String,
    },
    JoinCommunity {
        community_id: String,
        token: String,
    },
    CommunitySyncRequest {
        community_id: String,
    },
    CommunityState {
        community_id: String,
        name: String,
        owner_fp: String,
        channels: Vec<crate::storage::ChannelMetaRow>,
        #[serde(default)]
        roles: Vec<crate::storage::RoleRow>,
        #[serde(default)]
        bots: Vec<crate::storage::BotRow>,
        #[serde(default)]
        member_roles: Vec<(String, Vec<String>)>,
        members: Vec<(String, String, String)>,
        #[serde(default)]
        description: String,
        #[serde(default)]
        category: String,
        #[serde(default)]
        icon: String,
        /// Público = qualquer um entra (com rate limit). Ausente em frames
        /// antigos = privado, que é o comportamento seguro.
        #[serde(default)]
        is_public: bool,
    },
    CommunityKicked {
        community_id: String,
    },
    ChannelMsg {
        community_id: String,
        channel_id: String,
        env: MessageEnvelope,
        #[serde(default)]
        bot_id: String,
    },
    ChannelAck {
        env_id: String,
    },
    GroupCreated {
        conv_id: String,
        title: String,
        members: Vec<(String, String)>,
        /// Quem criou. Ausente em frames antigos (0.0 lê como vazio) — nesse
        /// caso o receptor cai na convenção do primeiro membro do roster.
        #[serde(default)]
        owner_fp: String,
    },
    GroupMemberAdded {
        conv_id: String,
        fp: String,
        nickname: String,
    },
    CallInvite {
        call_id: String,
        kind: String,
        target_fp: String,
    },
    CallAccept {
        call_id: String,
    },
    CallRinging {
        call_id: String,
    },
    CallReject {
        call_id: String,
        reason: String,
    },
    CallEnd {
        call_id: String,
    },
    CallOffer {
        call_id: String,
        sdp: String,
    },
    CallAnswer {
        call_id: String,
        sdp: String,
    },
    CallIce {
        call_id: String,
        candidate: String,
        mid: String,
    },
    CallAddParticipant {
        call_id: String,
        fp: String,
        #[serde(default)]
        kind: String,
    },
    GroupDeleted {
        conv_id: String,
    },
    CallRoom {
        call_id: String,
        conv_id: String,
        kind: String,
        state: String,
        #[serde(default)]
        participants: Vec<String>,
        #[serde(default)]
        ts: i64,
    },
    VoiceJoin {
        community_id: String,
        channel_id: String,
    },
    VoiceLeave {
        community_id: String,
        channel_id: String,
    },
    VoiceState {
        community_id: String,
        channel_id: String,
        muted: bool,
        deafened: bool,
        speaking: bool,
    },
    FileAnnounce {
        file_id: String,
        name: String,
        size: u64,
        chunks: u32,
        hash: String,
        chunk_hashes: Option<Vec<String>>,
    },
    FileChunkRequest {
        file_id: String,
        index: u32,
    },
    FileChunkData {
        file_id: String,
        index: u32,
        data_b64: String,
    },
    FileHave {
        file_id: String,
        indices: Vec<u32>,
    },
    ProfileQuery {
        known_rev: i64,
    },
    ScreenShareOffer {
        call_id: String,
        sdp: String,
    },
    ScreenShareAnswer {
        call_id: String,
        sdp: String,
    },
    Ping {
        ts: i64,
    },
    Pong {
        ts: i64,
    },
    PeerExchange {
        peers: Vec<crate::storage::PeerRecord>,
    },
    PeerRelayPut {
        topic: String,
        body: String,
    },
    PeerRelayGet {
        topic: String,
        req_id: u32,
    },
    PeerRelayData {
        req_id: u32,
        bodies: Vec<String>,
    },
    React {
        conv_id: String,
        msg_id: String,
        emoji: String,
        add: bool,
        #[serde(default)]
        reactor_fp: String,
        /// Reação "super" (efeito visual na UI). Ausente em frames antigos.
        #[serde(default)]
        is_super: bool,
    },
    Reply {
        #[serde(default)]
        conv_id: String,
        msg_id: String,
        reply_to: String,
    },
    MsgEdit {
        conv_id: String,
        msg_id: String,
        body: String,
    },
    MsgDelete {
        conv_id: String,
        msg_id: String,
    },
    MsgPin {
        conv_id: String,
        msg_id: String,
        pinned: bool,
    },
    Forward {
        conv_id: String,
        channel_id: String,
        env: MessageEnvelope,
        from_label: String,
    },
    PresenceSet {
        status: String,
        custom: String,
        custom_emoji: String,
    },
    ProfileSet {
        display_name: String,
        about: String,
        avatar_b64: String,
        banner_b64: String,
        accent: String,
        #[serde(default)]
        rev: i64,
        #[serde(default)]
        content_hash: String,
        /// Customizações visuais. Fora do `content_hash` v1 para não invalidar
        /// frames antigos; convergem por `profile_style_key`.
        #[serde(default)]
        profile_theme: String,
        #[serde(default)]
        avatar_effect: String,
        #[serde(default)]
        decoration: String,
    },
    ThreadCreate {
        community_id: String,
        thread_id: String,
        parent_channel: String,
        name: String,
        kind: String,
        tags: String,
    },
    ThreadMsg {
        community_id: String,
        thread_id: String,
        parent_channel: String,
        env: MessageEnvelope,
    },
    MemberBan {
        community_id: String,
        target_fp: String,
        until_ms: i64,
        reason: String,
    },
    MemberTimeout {
        community_id: String,
        target_fp: String,
        until_ms: i64,
        reason: String,
    },
    ChannelCfg {
        community_id: String,
        channel_id: String,
        slowmode_secs: i64,
        nsfw: bool,
    },
    PollCreate {
        community_id: String,
        channel_id: String,
        poll_id: String,
        question: String,
        options: Vec<String>,
        multi: bool,
        ends_at: i64,
    },
    PollVote {
        community_id: String,
        channel_id: String,
        poll_id: String,
        option_idx: i64,
    },
    EventUpsert {
        community_id: String,
        event: crate::social::EventRow,
    },
    EventInterest {
        community_id: String,
        event_id: String,
    },
    EmojiUpsert {
        community_id: String,
        emoji: crate::social::EmojiRow,
    },
    PresencePing,
    /// Desafio de atestação de build (proto_v >= 5). O nonce impede replay
    /// entre conexões e o hash do transcript amarra a resposta a ESTA sessão.
    BuildChallenge {
        nonce_hex: String,
        transcript_hash: String,
        #[serde(default)]
        policy: String,
    },
    /// Resposta assinada ao desafio, com o manifesto assinado (wire hex).
    BuildAttestResponse {
        attestation_hex: String,
    },
    /// Push de manifesto recebido de um peer. O receptor RE-VERIFICA com as
    /// próprias chaves antes de guardar; nunca é ordem de atualização.
    BuildManifestPush {
        manifest_hex: String,
    },
    /// Aviso de que existe atualização oficial. É só um aviso — o download é
    /// decidido localmente, contra o manifesto verificado.
    UpdateHint {
        version: String,
        manifest_hash: String,
    },
    Typing {
        conv_id: String,
        until_ms: i64,
    },
    ChannelReorder {
        community_id: String,
        ids: Vec<String>,
    },
    Bye,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HandshakeFrame {
    Hello(Hello),
    HelloAck(HelloAck),
    HelloOk(HelloOk),
}

pub fn session_key(
    eph_secret: &x25519_dalek::StaticSecret,
    peer_eph: &[u8; 32],
    nonce_initiator: &[u8; 16],
    nonce_responder: &[u8; 16],
) -> Result<[u8; 32], crate::DistorrentError> {
    use hkdf::Hkdf;
    use sha2::Sha256;
    let peer_arr: [u8; 32] = *peer_eph;
    let shared = eph_secret.diffie_hellman(&x25519_dalek::PublicKey::from(peer_arr));
    if !shared.was_contributory() {
        return Err(crate::DistorrentError::Crypto(
            "X25519 all-zero shared".into(),
        ));
    }
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(nonce_initiator);
    salt[16..].copy_from_slice(nonce_responder);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"distorrent/v1/session-chacha20poly1305", &mut okm)
        .map_err(|e| crate::DistorrentError::Crypto(format!("hkdf: {e}")))?;
    Ok(okm)
}

pub fn make_invite_token(
    host: &Keypair,
    community_id: &str,
    member_fp: &str,
    exp_ms: i64,
) -> String {
    use std::fmt::Write as _;
    let msg = invite_sign_bytes(community_id, member_fp, exp_ms);
    let sig = host.sign(&msg);
    let mut raw = String::new();
    let _ = write!(
        raw,
        "{}|{}|{}|{}|{}",
        host.fingerprint(),
        community_id,
        member_fp,
        exp_ms,
        sig
    );
    b64url_encode(raw.as_bytes())
}

pub fn extract_invite_token(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains("://") || trimmed.starts_with('/') {
        if let Some(q) = trimmed.split_once('?').map(|(_, q)| q) {
            for pair in q.split('&') {
                if let Some((k, v)) = pair.split_once('=') {
                    if k.eq_ignore_ascii_case("invite") || k.eq_ignore_ascii_case("token") {
                        return percent_decode(v);
                    }
                }
            }
        }
        let path = trimmed.split('?').next().unwrap_or(trimmed);
        if let Some(seg) = path.rsplit('/').find(|s| !s.is_empty()) {
            return percent_decode(seg);
        }
        return String::new();
    }
    percent_decode(trimmed)
}

fn percent_decode(s: &str) -> String {
    if !s.contains('%') {
        return s.to_string();
    }
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

pub fn parse_invite_token(
    token: &str,
) -> Result<(String, String, String, i64, String), crate::DistorrentError> {
    let cleaned = extract_invite_token(token);
    if cleaned.is_empty() {
        return Err(crate::DistorrentError::Protocol(
            "nenhum token encontrado — cole o link de convite ou o token".into(),
        ));
    }
    let raw = b64url_decode(&cleaned)
        .or_else(|| b64_decode(&cleaned))
        .ok_or_else(|| {
            crate::DistorrentError::Protocol(format!(
                "token de convite ilegível ({cleaned:?} não é base64) — cole o link \
                 completo ou o token, sem espaços"
            ))
        })?;
    let raw = std::str::from_utf8(&raw).map_err(|_| {
        crate::DistorrentError::Protocol("token de convite corrompido (não é texto válido)".into())
    })?;
    let parts: Vec<&str> = raw.split('|').collect();
    if parts.len() != 5 {
        return Err(crate::DistorrentError::Protocol(format!(
            "token de convite incompleto ({}/5 campos) — regene o convite",
            parts.len()
        )));
    }
    let exp = parts[3].parse().map_err(|_| {
        crate::DistorrentError::Protocol(
            "token de convite com data inválida — regene o convite".into(),
        )
    })?;
    Ok((
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2].to_string(),
        exp,
        parts[4].to_string(),
    ))
}

pub fn invite_sign_bytes(community_id: &str, member_fp: &str, exp_ms: i64) -> Vec<u8> {
    let mut h = Hasher::new();
    h.update(PROTOCOL_NAME.as_bytes());
    h.update(b"|invite|");
    h.update(community_id.as_bytes());
    h.update(b"|");
    h.update(member_fp.as_bytes());
    h.update(b"|");
    h.update(&exp_ms.to_be_bytes());
    h.finalize().as_bytes().to_vec()
}

fn b64_encode(data: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in data.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn b64_decode(s: &str) -> Option<Vec<u8>> {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut vals = Vec::new();
    for c in s.bytes() {
        if c == b'=' {
            break;
        }
        vals.push(T.iter().position(|&t| t == c)? as u32);
    }
    let mut out = Vec::new();
    for chunk in vals.chunks(4) {
        let mut n = 0u32;
        for (i, v) in chunk.iter().enumerate() {
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

fn b64url_encode(data: &[u8]) -> String {
    b64_encode(data)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

fn b64url_decode(s: &str) -> Option<Vec<u8>> {
    let mut norm = String::with_capacity(s.len() + 3);
    for c in s.chars() {
        match c {
            '-' => norm.push('+'),
            '_' => norm.push('/'),
            '=' => {}
            ' ' | '\n' | '\r' | '\t' => {}
            other => norm.push(other),
        }
    }
    while norm.len() % 4 != 0 {
        norm.push('=');
    }
    b64_decode(&norm)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_roundtrip() {
        let kp = Keypair::generate();
        let env = MessageEnvelope::new(&kp, "conv1", "olá mundo");
        assert!(env.verify_with_pubkey(&kp.public_hex()));

        let json = serde_json::to_string(&env).unwrap();
        let back: MessageEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back, env);
        assert!(back.verify_with_pubkey(&kp.public_hex()));
    }

    #[test]
    fn envelope_tamper_body_fails() {
        let kp = Keypair::generate();
        let mut env = MessageEnvelope::new(&kp, "conv1", "original");
        env.body = "forjado".into();
        assert!(!env.verify_with_pubkey(&kp.public_hex()));
    }

    #[test]
    fn envelope_wrong_key_fails() {
        let kp = Keypair::generate();
        let other = Keypair::generate();
        let env = MessageEnvelope::new(&kp, "conv1", "x");
        assert!(!env.verify_with_pubkey(&other.public_hex()));
    }

    #[test]
    fn invite_token_roundtrip() {
        let host = Keypair::generate();
        let tok = make_invite_token(&host, "cid123", "memberfp001", 999999);
        let (fp, cid, member, exp, sig) = parse_invite_token(&tok).unwrap();
        assert_eq!(fp, host.fingerprint());
        assert_eq!(cid, "cid123");
        assert_eq!(member, "memberfp001");
        assert_eq!(exp, 999999);
        assert!(Keypair::verify(
            &host.public_hex(),
            &invite_sign_bytes("cid123", "memberfp001", 999999),
            &sig
        )
        .unwrap());
        let (fp2, _cid2, member2, exp2, sig2) = parse_invite_token(&tok).unwrap();
        assert!(!Keypair::verify(
            &host.public_hex(),
            &invite_sign_bytes("cid123", "OUTRO", exp2),
            &sig2
        )
        .unwrap());
        assert_eq!(fp2, host.fingerprint());
        assert_eq!(member2, "memberfp001");
    }

    #[test]
    fn invite_token_e_url_safe() {
        let ids = [
            "local-abc123",
            "x~cid",
            "cid/with/slash",
            "cid+plus",
            "a b c",
            "ção-ünïcode",
        ];

        for (i, cid) in ids.iter().enumerate() {
            let host = Keypair::generate();
            let exp = 1_000_000 + i as i64;
            let tok = make_invite_token(&host, cid, "memberfp001", exp);

            for c in tok.chars() {
                assert!(
                    c.is_ascii_alphanumeric() || c == '-' || c == '_',
                    "token contém {c:?}, que quebra URL (id={cid:?}, token={tok})"
                );
            }
            assert!(!tok.contains('='), "padding '=' quebra URL: {tok}");

            let esperado = parse_invite_token(&tok).unwrap();
            assert_eq!(esperado.1, *cid, "community_id não sobreviveu ao token");
            assert_eq!(
                parse_invite_token(&format!("http://localhost:5173/invite/{tok}")).unwrap(),
                esperado,
                "token com id={cid:?} não sobreviveu dentro de uma URL"
            );
        }

        let host = Keypair::generate();
        let (cid, exp) = ("x~cid", 1_000_000i64);
        use std::fmt::Write as _;
        let mut raw = String::new();
        let _ = write!(
            raw,
            "{}|{}|memberfp001|{}|{}",
            host.fingerprint(),
            cid,
            exp,
            host.sign(&invite_sign_bytes(cid, "memberfp001", exp))
        );
        assert!(
            b64_encode(raw.as_bytes()).contains(['+', '/']),
            "o caso de teste parou de exercitar escaping — não prova mais nada"
        );
    }

    #[test]
    fn invite_token_aceita_url_completa_e_query() {
        let host = Keypair::generate();
        let tok = make_invite_token(&host, "cid123", "000000000000", 999999);

        let esperado = parse_invite_token(&tok).unwrap();

        let by_path = parse_invite_token(&format!("http://localhost:5173/invite/{tok}")).unwrap();
        assert_eq!(esperado, by_path);

        let by_query =
            parse_invite_token(&format!("http://192.168.0.10:5173/?invite={tok}")).unwrap();
        assert_eq!(esperado, by_query);

        let encoded: String = tok
            .chars()
            .flat_map(|c| {
                let mut buf = [0u8; 4];
                c.encode_utf8(&mut buf).as_bytes().to_vec()
            })
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' => {
                    vec![b]
                }
                other => format!("%{other:02X}").into_bytes(),
            })
            .flatten()
            .collect::<Vec<u8>>()
            .iter()
            .map(|&b| b as char)
            .collect();
        let by_encoded = parse_invite_token(&encoded).unwrap();
        assert_eq!(esperado, by_encoded);

        let spaced = format!("  {}\n", tok);
        assert_eq!(esperado, parse_invite_token(&spaced).unwrap());
    }

    #[test]
    fn invite_token_aceita_base64_padrao_antigo() {
        let host = Keypair::generate();
        use std::fmt::Write as _;
        let mut raw = String::new();
        let _ = write!(
            raw,
            "{}|cid123|000000000000|999999|{}",
            host.fingerprint(),
            host.sign(&invite_sign_bytes("cid123", "000000000000", 999999))
        );
        let legacy = b64_encode(raw.as_bytes());
        let (fp, cid, _m, exp, _s) = parse_invite_token(&legacy).unwrap();
        assert_eq!(fp, host.fingerprint());
        assert_eq!(cid, "cid123");
        assert_eq!(exp, 999999);
    }

    #[test]
    fn invite_token_erro_e_especifico() {
        let vazio = parse_invite_token("").unwrap_err().to_string();
        assert!(vazio.contains("nenhum token"), "vazio: {vazio}");

        let lixo = parse_invite_token("isto não é um token")
            .unwrap_err()
            .to_string();
        assert!(
            lixo.contains("ilegível") || lixo.contains("base64"),
            "lixo: {lixo}"
        );

        let curto = b64url_encode(b"a|b|c");
        let e = parse_invite_token(&curto).unwrap_err().to_string();
        assert!(e.contains("incompleto"), "curto: {e}");
    }

    #[test]
    fn b64_e_token_malformado_nao_panica() {
        assert_eq!(b64_encode(&[]), "");
        for len in 1..=8usize {
            let data = vec![0xABu8; len];
            let _ = b64_encode(&data);
        }
        for s in [
            "",
            "!!!!",
            "=",
            "A",
            "AB",
            "ABC",
            "ABCDE",
            "A=B",
            "++++//",
            "A A",
            "\u{7f}\u{80}\u{ff}",
        ] {
            let _ = b64_decode(s);
            assert!(parse_invite_token(s).is_err());
        }
        let raw = b64_encode(b"a|b|c|d|e|f");
        let _ = parse_invite_token(&raw);
    }

    #[test]
    fn session_key_symmetric() {
        let a_sec = x25519_dalek::StaticSecret::random_from_rng(rand::rngs::OsRng);
        let b_sec = x25519_dalek::StaticSecret::random_from_rng(rand::rngs::OsRng);
        let a_pub = x25519_dalek::PublicKey::from(&a_sec).to_bytes();
        let b_pub = x25519_dalek::PublicKey::from(&b_sec).to_bytes();
        let na = [1u8; 16];
        let nb = [2u8; 16];
        let ka = session_key(&a_sec, &b_pub, &na, &nb).unwrap();
        let kb = session_key(&b_sec, &a_pub, &na, &nb).unwrap();
        assert_eq!(ka, kb);
    }
}
