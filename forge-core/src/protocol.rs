//! Protocolo de rede FORGE v1.
//!
//! Transporte: TCP com frames length-prefixed (u32 big-endian + JSON).
//! Handshake autenticado: challenge-response ed25519 + troca X25519 efêmera
//! → chave de sessão ChaCha20Poly1305 (HKDF-SHA256). Anti-replay via nonces
//! frescos por conexão; anti-MITM porque as assinaturas cobrem o transcript
//! completo (fps + nonces + chaves efêmeras).
//!
//! Mensagens: envelope assinado (ed25519 sobre bytes canônicos).

use blake3::Hasher;
use serde::{Deserialize, Serialize};

use crate::identity::Keypair;

pub const PROTOCOL_NAME: &str = "forge/v1";
pub const MAGIC: &[u8; 4] = b"FGE1";

/// Bytes canônicos assinados de uma mensagem. Qualquer alteração de campo
/// invalida a assinatura — o receptor SEMPRE re-verifica.
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

    /// Verifica assinatura + vínculo fingerprint↔pubkey.
    /// A pubkey do autor vem do PeerBook (preenchida no handshake autenticado).
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

/// Frames de controle do handshake (plaintext, antes da sessão AEAD).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    pub fp: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub nonce: [u8; 16],
    pub eph_pub: [u8; 32], // X25519 efêmero
    pub tcp_port: u16,     // porta de escuta, p/ peers registrarem addr
    /// Versão do protocolo de sessão (0 = legado). Campos com default:
    /// peers antigos ignoram, novos detectam capacidade (ex.: Punch).
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
    pub sig: String, // sign(transcript) do respondente
    #[serde(default)]
    pub proto_v: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloOk {
    pub sig: String, // sign(transcript) do iniciador
}

/// Transcript assinado por ambos os lados — cobre identidades, nonces e
/// chaves efêmeras. Reuso de nonce invalida a assinatura (replay).
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

/// Frames cifrados (após handshake).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SecureFrame {
    Msg(MessageEnvelope),
    Ack {
        msg_id: String,
    },
    /// Pedido de amizade (remetente já autenticado pela sessão).
    FriendRequest {
        nickname: String,
    },
    FriendAccept {
        nickname: String,
    },
    FriendReject,
    FriendRemove,
    /// Hole punching coordenado (estilo torrent/Radmin): "fura teu NAT para
    /// meu endpoint em T". Só enviado se o peer anunciou proto_v>=1 no
    /// handshake (peers legados derrubariam a sessão no deserialize).
    Punch {
        /// "ip:porta" público de quem pede (UPnP/ipify).
        endpoint: String,
        /// unix_ms desejado para o dial simultâneo (tolerância ±10s).
        at_ms: u64,
        /// amarração anti-replay (ecoado só em log; handshake autentica).
        nonce: [u8; 16],
    },
    /// Túnel virtual (LAN estilo Radmin, Fase 1+): oferta de handshake X25519
    /// efêmero autenticada por ed25519. SÓ enviar se `peer_proto_v >= 2`
    /// (variante desconhecida derruba sessão legada no deserialize).
    TunnelOffer {
        /// efêmera X25519 de quem oferece (hex 64).
        eph_pub_hex: String,
        /// nonce anti-replay da oferta (hex 32).
        nonce_hex: String,
        /// ed25519(identidade) sobre o transcript do túnel.
        sig: String,
    },
    /// Resposta à oferta (mesmo gate de versão).
    TunnelAnswer {
        /// efêmera X25519 de quem responde (hex 64).
        eph_pub_hex: String,
        /// nonce anti-replay da resposta (hex 32).
        nonce_hex: String,
        /// nonce da oferta que esta resposta atende (hex 32).
        for_nonce_hex: String,
        /// ed25519(identidade) sobre o transcript do túnel.
        sig: String,
    },
    /// Datagrama cifrado do túnel (ChaCha20Poly1305, nonce u64 crescente).
    TunnelData {
        nonce: u64,
        ct_b64: String,
    },
    /// Membro → Host: entrar numa comunidade (token assinado pelo dono)
    JoinCommunity {
        community_id: String,
        token: String,
    },
    /// Host → Membro: estado completo da comunidade (canais, cargos, bots,
    /// assignments e membros). Campos novos com #[serde(default)] para
    /// tolerar hosts legados sem essas seções.
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
        /// Metadados do wizard (v6): descrição/categoria/ícone.
        #[serde(default)]
        description: String,
        #[serde(default)]
        category: String,
        #[serde(default)]
        icon: String,
    },
    /// Host → Membro expulso: remova a comunidade localmente.
    CommunityKicked {
        community_id: String,
    },
    /// Membro → Host → Membros: mensagem de canal assinada
    ChannelMsg {
        community_id: String,
        channel_id: String,
        env: MessageEnvelope,
        /// v6: não-vazio = mensagem postada POR UM BOT (id do BotRow). O autor
        /// real (assinatura) continua sendo o host — o bot_id é só display.
        #[serde(default)]
        bot_id: String,
    },
    /// Host → autor: confirmação de relay
    ChannelAck {
        env_id: String,
    },
    /// Criador → membros: estado completo de um grupo DM (sincroniza a
    /// conversa e a lista de membros; reenviado a cada reconexão).
    GroupCreated {
        conv_id: String,
        title: String,
        members: Vec<(String, String)>,
    },
    /// Criador → membros existentes: novo integrante no grupo.
    GroupMemberAdded {
        conv_id: String,
        fp: String,
        nickname: String,
    },
    // ---------- chamadas (WebRTC signaling via P2P cifrado) ----------
    CallInvite {
        call_id: String,
        kind: String,
        target_fp: String,
    },
    CallAccept {
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
        /// v6: não-vazio = deve TOCAR no receptor (ring do convidado);
        /// vazio = só aviso de roster para quem já está na chamada.
        #[serde(default)]
        kind: String,
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
    // ---------- swarm de arquivos (BitTorrent-like) ----------
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
    // PEX: gossip de peers para Internet P2P sem tracker central (v3.1)
    PeerExchange {
        peers: Vec<crate::storage::PeerRecord>,
    },
    // ---------- peer-relay: circuito por peer intermediário (v0) ----------
    // Um peer ONLINE (pode ser NÃO-amigo) atua como intermediário: guarda e
    // repassa bytes OPACOS entre dois peers atrás de CGNAT quando a direta
    // falha. O intermediário só vê ciphertext da sessão A↔B (E2E já cifrada).
    // Peers antigos NUNCA enviam estas variantes (compatibilidade retroativa).
    /// A → intermediário: guarde `body` no tópico `topic` (broker em memória).
    PeerRelayPut {
        topic: String,
        body: String,
    },
    /// B → intermediário: devolva (drenando) o que houver no tópico `topic`.
    PeerRelayGet {
        topic: String,
        req_id: u32,
    },
    /// intermediário → B: resposta ao `PeerRelayGet` (correlaciona por `req_id`).
    PeerRelayData {
        req_id: u32,
        bodies: Vec<String>,
    },
    // ---------- camada social v3 (paridade Discord) ----------
    // Todas abaixo viajam DENTRO da sessão AEAD (autenticadas) e o motor
    // valida autor/permissão antes de aplicar — a UI não decide nada.
    /// Reação em mensagem. `add=false` remove. O `reactor_fp` é sempre o
    /// autor da conexão (o motor sobrescreve com o peer real).
    React {
        conv_id: String,
        msg_id: String,
        emoji: String,
        add: bool,
        #[serde(default)]
        reactor_fp: String,
    },
    /// Citação: liga a mensagem nova (`msg_id`) à mensagem citada. `conv_id` é
    /// redundante com o da mensagem, mas sem ele o receptor não consegue provar
    /// que a citação pertence à mesma conversa — por isso o motor valida.
    Reply {
        #[serde(default)]
        conv_id: String,
        msg_id: String,
        reply_to: String,
    },
    /// Edição — só o autor original (motor confere `author_fp` da mensagem).
    MsgEdit {
        conv_id: String,
        msg_id: String,
        body: String,
    },
    /// Exclusão lógica (mostra "mensagem apagada").
    MsgDelete {
        conv_id: String,
        msg_id: String,
    },
    /// Fixar/desafixar mensagem.
    MsgPin {
        conv_id: String,
        msg_id: String,
        pinned: bool,
    },
    /// Encaminhar: reenvia o CONTEÚDO (assinado de novo pelo autor) para
    /// outro destino, com a origem anotada para o receptor mostrar o cabeçalho.
    Forward {
        conv_id: String,
        channel_id: String,
        env: MessageEnvelope,
        /// "canal:geral" | "dm:peer" | "thread:id"
        from_label: String,
    },
    /// Presença estendida (online/idle/dnd/invisible) + status personalizado.
    PresenceSet {
        status: String,
        custom: String,
        custom_emoji: String,
    },
    /// Perfil público: display name, bio, avatar, banner, cor de destaque.
    ProfileSet {
        display_name: String,
        about: String,
        avatar_b64: String,
        banner_b64: String,
        accent: String,
    },
    /// Thread criada a partir de uma mensagem (ou post de fórum).
    ThreadCreate {
        community_id: String,
        thread_id: String,
        parent_channel: String,
        name: String,
        kind: String,
        tags: String,
    },
    /// Mensagem dentro de uma thread (canal próprio, como no Discord).
    ThreadMsg {
        community_id: String,
        thread_id: String,
        parent_channel: String,
        env: MessageEnvelope,
    },
    /// Moderador → membros: ban (0 = permanente) e timeout.
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
    /// Dono → membros: config do canal (slowmode/NSFW).
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
    /// Pergunta "você está online?" → resposta automática com presença.
    PresencePing,
    /// "Estou digitando" — efêmero por natureza: NÃO é persistido, NÃO entra em
    /// ack nem em retransmissão. O motor só o repassa para quem compartilha a
    /// conversa e a UI o expira sozinho. `until_ms` é o prazo que o próprio
    /// remetente trava: o receptor nunca mostra "digitando" além dele.
    Typing {
        conv_id: String,
        until_ms: i64,
    },
    /// Reordenação de canais pelo dono/moderador. `ids` é a ordem final
    /// completa dentro de uma categoria; o motor valida que os ids pertencem
    /// todos à mesma comunidade antes de gravar qualquer posição.
    ChannelReorder {
        community_id: String,
        ids: Vec<String>,
    },
    Bye,
}

/// Frame plaintext do handshake.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum HandshakeFrame {
    Hello(Hello),
    HelloAck(HelloAck),
    HelloOk(HelloOk),
}

/// Deriva a chave de sessão compartilhada (32 bytes).
/// `nonce_initiator`/`nonce_responder` são explícitos — ambos os lados derivam
/// a mesma chave sem ambiguidade de papel.
pub fn session_key(
    eph_secret: &x25519_dalek::StaticSecret,
    peer_eph: &[u8; 32],
    nonce_initiator: &[u8; 16],
    nonce_responder: &[u8; 16],
) -> Result<[u8; 32], crate::ForgeError> {
    use hkdf::Hkdf;
    use sha2::Sha256;
    let peer_arr: [u8; 32] = *peer_eph;
    let shared = eph_secret.diffie_hellman(&x25519_dalek::PublicKey::from(peer_arr));
    if !shared.was_contributory() {
        return Err(crate::ForgeError::Crypto("X25519 all-zero shared".into()));
    }
    let mut salt = [0u8; 32];
    salt[..16].copy_from_slice(nonce_initiator);
    salt[16..].copy_from_slice(nonce_responder);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared.as_bytes());
    let mut okm = [0u8; 32];
    hk.expand(b"forge/v1/session-chacha20poly1305", &mut okm)
        .map_err(|e| crate::ForgeError::Crypto(format!("hkdf: {e}")))?;
    Ok(okm)
}

/// Token de convite: base64(host_fp|community_id|member_fp|exp_ms|sig_hex)
/// sig = ed25519 do dono sobre "forge/v1|invite|community_id|member_fp|exp".
/// Vínculo ao fingerprint do convidado + expiração — sem segredo permanente em URL.
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
    b64_encode(raw.as_bytes())
}

pub fn parse_invite_token(
    token: &str,
) -> Result<(String, String, String, i64, String), crate::ForgeError> {
    let raw =
        b64_decode(token).ok_or_else(|| crate::ForgeError::Protocol("token inválido".into()))?;
    let raw = std::str::from_utf8(&raw)
        .map_err(|_| crate::ForgeError::Protocol("token inválido".into()))?;
    let parts: Vec<&str> = raw.split('|').collect();
    if parts.len() != 5 {
        return Err(crate::ForgeError::Protocol("token inválido".into()));
    }
    Ok((
        parts[0].to_string(),
        parts[1].to_string(),
        parts[2].to_string(),
        parts[3]
            .parse()
            .map_err(|_| crate::ForgeError::Protocol("token inválido".into()))?,
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
        // token violado não passa na verificação de assinatura
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
    fn b64_e_token_malformado_nao_panica() {
        // b64_encode: chunks(3) nunca produz chunk vazio → chunk[0] é seguro;
        // índices 1/2 usam .get().unwrap_or(&0). Prova com todos os tamanhos.
        assert_eq!(b64_encode(&[]), "");
        for len in 1..=8usize {
            let data = vec![0xABu8; len];
            let _ = b64_encode(&data);
        }
        // b64_decode: chars inválidos → None (via ?), nunca index out of bounds
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
            // token de convite com chars estranhos: erro limpo, sem panic
            assert!(parse_invite_token(s).is_err());
        }
        // token bem-formado mas com '|' estranho no payload interno → 5 partes ou erro
        let raw = b64_encode(b"a|b|c|d|e|f");
        let _ = parse_invite_token(&raw); // 6 partes → erro, sem panic
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
