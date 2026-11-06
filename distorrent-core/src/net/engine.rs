#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use crate::net::netlimit::{Decision, FrameVerdict, NetLimiter};
use crate::net::reaction_limit::ReactionLimiter;
use crate::net::socks5::{socks5_connect, split_host_port, SocksTarget};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, Notify};
use tokio::task::JoinHandle;
use tokio::time::{interval, sleep, timeout};
use tracing::{debug, info, warn};

#[cfg(target_os = "linux")]
use super::voice_gate::HeldCall;
use crate::identity::{Identity, Keypair};
use crate::net::discovery::{DiscoveredPeer, Discovery};
#[cfg(target_os = "linux")]
use crate::net::media_voice::{OutboundSignal, VoiceMedia, VoiceStats};
use crate::net::relay::{
    relay_post_loop, relay_topic, MultiRelay, PeerRelayBackend, Reassembler, RelayBackend,
    RelayStream,
};
use crate::net::transport::Session;
use crate::net::vtunnel::{
    decode_envelope, encode_frag, encode_full, tunnel_key, tunnel_transcript, virtual_ipv6, TunMsg,
    TunnelPending, TunnelReassembler, TunnelSession, TUN_FRAG_MAX, TUN_FRAME_MAX,
};
use crate::protocol::{HandshakeFrame, MessageEnvelope, SecureFrame};
use crate::storage::{
    BotPatch, BotRow, ChannelMetaRow, Conversation, PeerRecord, RoleRow, Store, StoredMessage,
};
use crate::{DistorrentError, Result};

pub const PING_INTERVAL: Duration = Duration::from_secs(10);
// Detecção de rota morta: 12 s em vez de 25 s. Com heartbeat de 10 s ainda
// tolera um pacote perdido, mas não deixa o par "Conectado" por 75 s.
pub const PING_TIMEOUT: Duration = Duration::from_secs(12);
pub const RELAY_PING_INTERVAL: Duration = Duration::from_secs(20);
// Relay é mais lento, mas 120 s escondia peer morto por dois minutos.
pub const RELAY_PING_TIMEOUT: Duration = Duration::from_secs(45);
/// Tempo para o primeiro frame chegar depois de o link ficar online. Passou
/// disso sem receber nada, o par não está vivo (ver `peer_alive`).
pub const FIRST_FRAME_GRACE: Duration = Duration::from_secs(15);
pub const RELAY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);
pub const RELAY_DIAL_ATTEMPT: Duration = Duration::from_secs(20);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

pub const MUTE_DEFAULT_MS: i64 = 10 * 60 * 1000;
pub const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(15);

pub const TUNNEL_PROVE_GRACE_MS: i64 = 8_000;
pub const TUNNEL_PROVE_TTL_MS: i64 = 45_000;
pub const TUNNEL_PROVE_WINDOW_MS: i64 = 10_000;
pub const TUNNEL_DEAD_MS: i64 = 120_000;

pub const NAT_RENEW_INTERVAL: Duration = Duration::from_secs(15 * 60);

pub const AUTO_PROXY_FAILURE_THRESHOLD: u32 = 6;

pub const DIRECT_UNREACHABLE_THRESHOLD: u32 = 8;
pub const DIRECT_UNREACHABLE_STALL_MS: i64 = 20_000;
pub const AUTO_PROXY_STALL_MS: i64 = 40_000;
pub const AUTO_PROXY_COOLDOWN_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum NetworkState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct MemberPairing {
    pub fp: String,
    pub nickname: String,
    pub role: String,
    pub state: String,
    pub via_relay: bool,
    pub is_owner: bool,
    pub is_self: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendOutcome {
    Sent,
    QueuedOffline,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    StateChanged {
        state: NetworkState,
        online_peers: usize,
    },
    PeerOnline {
        fp: String,
        nickname: String,
        via_relay: bool,
    },
    PeerOffline {
        fp: String,
    },
    PeerDiscovered {
        fp: String,
        nickname: String,
        addr: String,
    },
    MessageNew(StoredMessage),
    MessageStatus {
        msg_id: String,
        status: String,
    },
    FriendRequestIn {
        fp: String,
        nickname: String,
    },
    FriendAccepted {
        fp: String,
        nickname: String,
    },
    FriendRemoved {
        fp: String,
    },
    CommunityJoined {
        community_id: String,
        name: String,
    },
    CommunityRemoved {
        community_id: String,
    },
    GroupSynced {
        conv_id: String,
        title: String,
    },
    CallIncoming {
        call_id: String,
        from_fp: String,
        kind: String,
    },
    CallAcceptedEv {
        call_id: String,
        from_fp: String,
    },
    CallRingingEv {
        call_id: String,
        from_fp: String,
    },
    CallRejected {
        call_id: String,
        from_fp: String,
        reason: String,
    },
    CallEnded {
        call_id: String,
        from_fp: String,
    },
    CallOfferEv {
        call_id: String,
        from_fp: String,
        sdp: String,
    },
    CallAnswerEv {
        call_id: String,
        from_fp: String,
        sdp: String,
    },
    CallIceEv {
        call_id: String,
        from_fp: String,
        candidate: String,
        mid: String,
    },
    CallParticipantAdded {
        call_id: String,
        fp: String,
        kind: String,
    },
    TunnelUp {
        fp: String,
        virtual_ip: String,
    },
    TunnelPong {
        fp: String,
        id: u64,
        rtt_ms: i64,
    },
    NatEndpoint {
        addr: String,
        source: String,
    },
    VoiceJoined {
        community_id: String,
        channel_id: String,
        fp: String,
    },
    VoiceLeft {
        community_id: String,
        channel_id: String,
        fp: String,
    },
    VoiceStateChanged {
        community_id: String,
        channel_id: String,
        fp: String,
        muted: bool,
        deafened: bool,
    },
    CallRoom {
        call_id: String,
        conv_id: String,
        kind: String,
        state: String,
        participants: Vec<String>,
        host_fp: String,
    },
    FileAnnounceEv {
        file_id: String,
        name: String,
        size: u64,
        chunks: u32,
        hash: String,
        from_fp: String,
        // Seção 1: serde
        #[serde(default)]
        chunk_hashes: Vec<String>,
    },
    FileChunkRequestEv {
        file_id: String,
        index: u32,
        from_fp: String,
    },
    FileChunkDataEv {
        file_id: String,
        index: u32,
        data_b64: String,
        from_fp: String,
    },
    ScreenShareOfferEv {
        call_id: String,
        from_fp: String,
        sdp: String,
    },
    ModeAutoSwitched {
        to: String,
        reason: String,
    },
    ReactionChanged {
        msg_id: String,
        conv_id: String,
        emoji: String,
        add: bool,
        reactor_fp: String,
    },
    MessageEdited {
        msg_id: String,
        conv_id: String,
        body: String,
    },
    MessageDeleted {
        msg_id: String,
        conv_id: String,
    },
    MessagePinned {
        msg_id: String,
        conv_id: String,
        pinned: bool,
    },
    MessageReply {
        msg_id: String,
        reply_to: String,
    },
    PresenceChanged {
        fp: String,
        status: String,
        custom: String,
        custom_emoji: String,
    },
    ProfileChanged {
        fp: String,
        profile: crate::social::ProfileView,
    },
    ThreadCreated {
        community_id: String,
        thread: crate::social::ThreadRow,
    },
    ModerationApplied {
        community_id: String,
        target_fp: String,
        kind: String,
        until_ms: i64,
        reason: String,
    },
    PollUpdated {
        community_id: String,
        channel_id: String,
        poll_id: String,
    },
    EventUpdated {
        community_id: String,
        event_id: String,
    },
    EmojiUpdated {
        community_id: String,
        emoji_id: String,
    },
    Muted {
        context: String,
        reason: String,
        until_ms: i64,
    },
    PeerTyping {
        fp: String,
        conv_id: String,
        until_ms: i64,
    },
    /// Veredito de autenticidade de build do peer (re-verificado localmente).
    PeerTrustChanged {
        fp: String,
        state: String,
        version: String,
        manifest_hash: String,
        build_id: String,
        commit: String,
        channel: String,
        valid_signatures: u8,
        self_integrity: String,
        hardware_proof: bool,
        hardware_reason: String,
        reason: String,
        verification_available: bool,
        quarantined: bool,
        quarantine_reason: String,
    },
    /// Entrou de fato no servidor (após convite aceito ou entrada pública).
    MemberJoined {
        community_id: String,
        fp: String,
        nickname: String,
    },
    MemberLeft {
        community_id: String,
        fp: String,
        nickname: String,
    },
    ChannelCreated {
        community_id: String,
        channel_id: String,
        name: String,
    },
    ChannelDeleted {
        community_id: String,
        channel_id: String,
    },
    BotCreated {
        community_id: String,
        bot_id: String,
    },
    Error {
        context: String,
    },
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CommunityChannelSeed {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub category: String,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CommunityRoleSeed {
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub permissions: i64,
    #[serde(default)]
    pub hoist: bool,
    #[serde(default)]
    pub mentionable: bool,
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CommunityCreateOptions {
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub icon: String,
    #[serde(rename = "rulesText", alias = "rules_text", default)]
    pub rules_text: String,
    #[serde(rename = "channelsMeta", alias = "channels_meta", default)]
    pub channels_meta: Vec<CommunityChannelSeed>,
    #[serde(default)]
    pub roles: Vec<CommunityRoleSeed>,
    /// Público: qualquer um entra, com rate limit. Privado: só por convite.
    #[serde(rename = "isPublic", alias = "is_public", default)]
    pub is_public: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerLinkState {
    Connecting,
    Online,
    Reconnecting,
}
struct PeerLink {
    state: StdMutex<PeerLinkState>,
    tx: Option<mpsc::UnboundedSender<(u8, SecureFrame)>>,
    drop_notify: Notify,
    via_relay: bool,
    initiator: bool,
}

pub fn frame_class(frame: &SecureFrame) -> u8 {
    use SecureFrame::*;
    match frame {
        CallInvite { .. }
        | CallAccept { .. }
        | CallRinging { .. }
        | CallReject { .. }
        | CallEnd { .. }
        | CallOffer { .. }
        | CallAnswer { .. }
        | CallIce { .. }
        | CallAddParticipant { .. }
        | CallRoom { .. }
        | ScreenShareOffer { .. }
        | ScreenShareAnswer { .. }
        | VoiceJoin { .. }
        | VoiceLeave { .. }
        | VoiceState { .. }
        | TunnelOffer { .. }
        | TunnelAnswer { .. }
        | Ping { .. }
        | Pong { .. } => 0,
        FriendRequest { .. }
        | FriendAccept { .. }
        | FriendReject
        | FriendRemove
        | Punch { .. }
        | JoinCommunity { .. }
        | CommunitySyncRequest { .. }
        | CommunityKicked { .. }
        | GroupCreated { .. }
        | GroupMemberAdded { .. }
        | GroupDeleted { .. }
        | PeerExchange { .. }
        | PeerRelayPut { .. }
        | PeerRelayGet { .. }
        | PeerRelayData { .. }
        | React { .. }
        | Reply { .. }
        | MsgEdit { .. }
        | MsgDelete { .. }
        | MsgPin { .. }
        | Forward { .. }
        | PresenceSet { .. }
        | PresencePing
        | ProfileSet { .. }
        | ProfileQuery { .. }
        | ThreadCreate { .. }
        | ThreadMsg { .. }
        | MemberBan { .. }
        | MemberTimeout { .. }
        | ChannelCfg { .. }
        | PollCreate { .. }
        | PollVote { .. }
        | EventUpsert { .. }
        | EventInterest { .. }
        | EmojiUpsert { .. }
        | Typing { .. }
        | ChannelReorder { .. }
        | Bye => 1,
        Msg(_) | ChannelMsg { .. } | ChannelAck { .. } | Ack { .. } | Read { .. } => 2,
        FileAnnounce { .. }
        | FileChunkRequest { .. }
        | FileChunkData { .. }
        | FileHave { .. }
        | TunnelData { .. }
        | CommunityState { .. } => 3,
        // Autenticidade de build: classe própria (baixa prioridade, volume
        // baixo) para não competir com mensagens nem com sinalização de voz.
        BuildChallenge { .. }
        | BuildAttestResponse { .. }
        | BuildManifestPush { .. }
        | UpdateHint { .. } => 1,
    }
}

// Seção 2: derive
#[derive(Clone, Debug, Default)]
pub struct PeerDiagInfo {
    pub last_direct_err: Option<String>,
    pub last_direct_ok_ms: i64,
    pub last_relay_err: Option<String>,
    pub last_relay_ok_ms: i64,
    pub announce_seen_ms: i64,
    pub direct_attempts: u64,
    pub relay_attempts: u64,
    pub tunnel_up: bool,
    pub virtual_ip: Option<String>,
    pub tunnel_rx_frames: u64,
    pub tunnel_tx_frames: u64,
    pub last_reject: Option<String>,
    pub last_reject_ms: i64,
    pub send_gave_up: u64,
    pub last_seen_ms: i64,
    pub last_rx_ms: i64,
    pub last_ack_ms: i64,
}

#[derive(Clone, Debug, Default)]
pub struct NetDiagInfo {
    pub stun_ok: Option<bool>,
    pub stun_addr: Option<String>,
    pub stun_ms: i64,
    pub announce_addr: Option<String>,
    pub announce_ms: i64,
    pub nat_source: Option<String>,
    pub dht_ok: Option<bool>,
    pub dht_ms: i64,
}

impl PeerLink {
    fn set_state(&self, s: PeerLinkState) {
        if let Ok(mut guard) = self.state.lock() {
            *guard = s;
        }
    }
    fn get_state(&self) -> PeerLinkState {
        *self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

mod community_pair;
#[cfg(test)]
mod peer_liveness_tests;
mod room_announce;
#[cfg(test)]
mod room_announce_tests;
#[cfg(test)]
mod room_delivery_tests;
#[cfg(test)]
mod room_join_tests;
#[cfg(test)]
mod session_election_tests;

pub struct NetworkEngine {
    pub store: Arc<Store>,
    keypair: Arc<Keypair>,
    identity: Identity,
    nickname: String,
    #[allow(dead_code)]
    data_dir: PathBuf,
    links: StdMutex<HashMap<String, Arc<PeerLink>>>,
    events: broadcast::Sender<EngineEvent>,
    cmd_tx: mpsc::UnboundedSender<EngineCmd>,
    cmd_rx: StdMutex<Option<mpsc::UnboundedReceiver<EngineCmd>>>,
    pending_joins: StdMutex<HashMap<String, String>>,
    join_retry: StdMutex<HashMap<String, (i64, u32)>>,
    community_sync_at: StdMutex<HashMap<String, i64>>,
    member_dial_at: StdMutex<HashMap<String, i64>>,
    listen_port: AtomicU16,
    started: StdMutex<bool>,
    shutdown: Arc<Notify>,
    handles: StdMutex<Vec<JoinHandle<()>>>,
    cancel_tx: tokio::sync::watch::Sender<bool>,
    relay_in: StdMutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>,
    relay_backend: StdMutex<Arc<dyn RelayBackend>>,
    relay_backend_custom: AtomicBool,
    relay_proxied: AtomicBool,
    relay_disabled: AtomicBool,
    peer_relay_disabled: AtomicBool,
    peer_relay_optin: AtomicBool,
    peer_relay: Arc<StdMutex<Option<String>>>,
    peer_relay_backend: StdMutex<Option<(String, Arc<PeerRelayBackend>)>>,
    relay_maintains: StdMutex<std::collections::HashSet<String>>,
    direct_maintains: StdMutex<std::collections::HashSet<String>>,
    punch_upgrades: StdMutex<HashMap<String, u64>>,
    punch_rate: StdMutex<HashMap<String, i64>>,
    pending_calls: StdMutex<HashMap<String, Vec<SecureFrame>>>,
    ring_seen: StdMutex<std::collections::HashSet<String>>,
    call_rooms: StdMutex<super::call_room::Rooms>,
    public_addr: StdMutex<Option<String>>,
    nat_external_port: Arc<AtomicU16>,
    punch_enabled: AtomicBool,
    dial_failures: StdMutex<HashMap<String, (u32, i64)>>,
    peer_diag: StdMutex<HashMap<String, PeerDiagInfo>>,
    net_diag: StdMutex<NetDiagInfo>,
    bit_dht: StdMutex<Option<Arc<mainline::Dht>>>,
    dht_lookups: StdMutex<HashMap<String, i64>>,
    dht_queue: StdMutex<Vec<String>>,
    auto_proxy_switched: StdMutex<HashMap<String, i64>>,
    tunnel_sessions: StdMutex<HashMap<String, TunnelSession>>,
    tunnel_pending: StdMutex<HashMap<String, TunnelPending>>,
    peer_protos: StdMutex<HashMap<String, u32>>,
    tor_timeouts: StdMutex<HashMap<String, u32>>,
    tunnel_pings: StdMutex<HashMap<(String, u64), i64>>,
    tunnel_meta: StdMutex<HashMap<String, (String, String)>>,
    tunnel_reasm: StdMutex<TunnelReassembler>,
    tunnel_disabled: AtomicBool,
    spam_flood: StdMutex<HashMap<String, (u32, i64)>>,
    spam_dup: StdMutex<HashMap<String, (String, i64, u32)>>,
    reaction_limiter: StdMutex<ReactionLimiter>,
    /// Conjunto de confiança + cache de manifestos verificados + piso de epoch.
    release_trust: StdMutex<crate::release::ReleaseTrust>,
    /// Confiança apurada por peer (RELEASE_VERIFICADA etc.) nesta sessão.
    peer_trust: StdMutex<HashMap<String, crate::release::PeerTrust>>,
    /// Nonce do desafio de atestação pendente, por peer.
    attest_nonce: StdMutex<HashMap<String, [u8; 32]>>,
    /// Quando o desafio foi enviado (ms), para o timeout de resposta.
    attest_sent_at: StdMutex<HashMap<String, i64>>,
    /// Transcript desta sessão, para assinar a própria atestação.
    attest_transcript: StdMutex<HashMap<String, String>>,
    pub(crate) netlimiter: Arc<NetLimiter>,
    #[cfg(target_os = "linux")]
    pub(super) voice: StdMutex<Option<Arc<VoiceMedia>>>,
    #[cfg(target_os = "linux")]
    pub(super) voice_calls: StdMutex<HashMap<String, HashSet<String>>>,
    #[cfg(target_os = "linux")]
    pub(super) held_calls: StdMutex<HashMap<String, HeldCall>>,
    #[cfg(target_os = "linux")]
    pub(super) voice_channel_calls: StdMutex<HashMap<String, (String, String)>>,
}

enum EngineCmd {
    ConnectTo(SocketAddr, Option<String>),
    ConnectHost {
        host: String,
        port: u16,
        expected_fp: Option<String>,
    },
    ConnectRelay(String),
    LookupAnnounce(String),
    PunchDial {
        fp: String,
        endpoint: String,
        at_ms: u64,
    },
    SendToPeer(String, SecureFrame),
    FlushOutbox(String),
}

pub fn peer_relay_policy(mode: &str) -> (bool, bool) {
    match mode {
        "normal" | "encrypted" => (true, true),
        "proxy" | "full" => (false, false),
        _ => (false, false),
    }
}

pub fn auto_proxy_should_switch(
    mode: &str,
    has_proxy: bool,
    enabled: bool,
    already_switched: bool,
    failures: u32,
) -> bool {
    if !enabled || !has_proxy || already_switched {
        return false;
    }
    if failures < AUTO_PROXY_FAILURE_THRESHOLD {
        return false;
    }
    matches!(mode, "normal" | "encrypted")
}

#[cfg(target_os = "linux")]
// Seção 3: inline
#[inline]
fn native_voice_platform_ok() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(target_os = "linux")]
#[inline]
fn in_multi_thread_runtime() -> bool {
    tokio::runtime::Handle::try_current().is_ok_and(|h| {
        matches!(
            h.runtime_flavor(),
            tokio::runtime::RuntimeFlavor::MultiThread
        )
    })
}

#[cfg(target_os = "linux")]
#[inline]
pub fn native_voice_capable() -> bool {
    native_voice_platform_ok() && native_voice_env_ok()
}

fn native_voice_env_ok() -> bool {
    !matches!(
        std::env::var("DISTORRENT_NO_NATIVE_VOICE")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

#[cfg(target_os = "linux")]
pub(super) fn build_voice_media() -> Option<Arc<VoiceMedia>> {
    if !(native_voice_platform_ok() && native_voice_env_ok()) {
        return None;
    }
    match VoiceMedia::new() {
        Ok(v) => {
            eprintln!(
                "[distorrent] voz nativa: ATIVA (microfone: {})",
                if v.has_capture() {
                    "sim"
                } else {
                    "não — somente recebendo"
                }
            );
            info!(
                "voz nativa: ativa (microfone: {})",
                if v.has_capture() {
                    "sim"
                } else {
                    "não — só recebendo"
                }
            );
            Some(v)
        }
        Err(e) => {
            eprintln!("[distorrent] voz nativa: INDISPONIVEL ({e}) — o WebRTC do navegador assume");
            warn!("voz nativa: indisponível ({e}) — o WebRTC do navegador assume");
            None
        }
    }
}

impl NetworkEngine {
    pub fn new(
        store: Arc<Store>,
        keypair: Keypair,
        nickname: String,
        data_dir: PathBuf,
    ) -> Arc<Self> {
        let identity = keypair.identity(&nickname);
        let relay_fp = identity.fingerprint.clone();
        let (events, _) = broadcast::channel(256);
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Arc::new(Self {
            store: store.clone(),
            keypair: Arc::new(keypair),
            identity: identity.clone(),
            nickname,
            data_dir,
            links: StdMutex::new(HashMap::new()),
            events,
            cmd_tx,
            cmd_rx: StdMutex::new(Some(cmd_rx)),
            pending_joins: StdMutex::new(HashMap::new()),
            join_retry: StdMutex::new(HashMap::new()),
            community_sync_at: StdMutex::new(HashMap::new()),
            member_dial_at: StdMutex::new(HashMap::new()),
            listen_port: AtomicU16::new(0),
            started: StdMutex::new(false),
            shutdown: Arc::new(Notify::new()),
            handles: StdMutex::new(Vec::new()),
            relay_in: StdMutex::new(HashMap::new()),
            relay_backend: StdMutex::new(Arc::new(MultiRelay::routes_from_env_or_default(
                &relay_fp,
            ))),
            relay_backend_custom: AtomicBool::new(false),
            relay_proxied: AtomicBool::new(false),
            relay_disabled: AtomicBool::new(!env_relay_enabled()),
            peer_relay_disabled: AtomicBool::new(env_no_relay()),
            peer_relay_optin: AtomicBool::new(env_peer_relay_enabled()),
            peer_relay: Arc::new(StdMutex::new(None)),
            peer_relay_backend: StdMutex::new(None),
            relay_maintains: StdMutex::new(std::collections::HashSet::new()),
            direct_maintains: StdMutex::new(std::collections::HashSet::new()),
            punch_upgrades: StdMutex::new(HashMap::new()),
            punch_rate: StdMutex::new(HashMap::new()),
            pending_calls: StdMutex::new(HashMap::new()),
            ring_seen: StdMutex::new(std::collections::HashSet::new()),
            call_rooms: StdMutex::new(super::call_room::Rooms::default()),
            cancel_tx: tokio::sync::watch::channel(false).0,
            public_addr: StdMutex::new(None),
            nat_external_port: Arc::new(AtomicU16::new(0)),
            punch_enabled: AtomicBool::new(env_punch_enabled()),
            dial_failures: StdMutex::new(HashMap::new()),
            peer_diag: StdMutex::new(HashMap::new()),
            net_diag: StdMutex::new(NetDiagInfo::default()),
            bit_dht: StdMutex::new(None),
            dht_lookups: StdMutex::new(HashMap::new()),
            dht_queue: StdMutex::new(Vec::new()),
            auto_proxy_switched: StdMutex::new(HashMap::new()),
            tunnel_sessions: StdMutex::new(HashMap::new()),
            tunnel_pending: StdMutex::new(HashMap::new()),
            peer_protos: StdMutex::new(HashMap::new()),
            tor_timeouts: StdMutex::new(HashMap::new()),
            tunnel_pings: StdMutex::new(HashMap::new()),
            tunnel_meta: StdMutex::new(HashMap::new()),
            tunnel_reasm: StdMutex::new(TunnelReassembler::new()),
            tunnel_disabled: AtomicBool::new(matches!(
                std::env::var("DISTORRENT_NO_TUNNEL")
                    .ok()
                    .as_deref()
                    .map(|s| s.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1" | "true" | "yes" | "on")
            )),
            spam_flood: StdMutex::new(HashMap::new()),
            spam_dup: StdMutex::new(HashMap::new()),
            reaction_limiter: StdMutex::new(ReactionLimiter::new()),
            release_trust: StdMutex::new(crate::release::ReleaseTrust::empty("inicializando")),
            peer_trust: StdMutex::new(HashMap::new()),
            attest_nonce: StdMutex::new(HashMap::new()),
            attest_sent_at: StdMutex::new(HashMap::new()),
            attest_transcript: StdMutex::new(HashMap::new()),
            netlimiter: NetLimiter::from_env(),
            #[cfg(target_os = "linux")]
            voice: StdMutex::new(build_voice_media()),
            #[cfg(target_os = "linux")]
            voice_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            held_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            voice_channel_calls: StdMutex::new(HashMap::new()),
        })
    }

    pub fn new_with_identity(
        store: Arc<Store>,
        keypair: Keypair,
        identity: Identity,
        // Seção 4: data_dir
        data_dir: PathBuf,
    ) -> Arc<Self> {
        let nickname = identity.nickname.clone();
        let relay_fp = identity.fingerprint.clone();
        let (events, _) = broadcast::channel(256);
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();
        Arc::new(Self {
            store,
            keypair: Arc::new(keypair),
            identity,
            nickname,
            data_dir,
            links: StdMutex::new(HashMap::new()),
            events,
            cmd_tx,
            cmd_rx: StdMutex::new(Some(cmd_rx)),
            pending_joins: StdMutex::new(HashMap::new()),
            join_retry: StdMutex::new(HashMap::new()),
            community_sync_at: StdMutex::new(HashMap::new()),
            member_dial_at: StdMutex::new(HashMap::new()),
            listen_port: AtomicU16::new(0),
            started: StdMutex::new(false),
            shutdown: Arc::new(Notify::new()),
            handles: StdMutex::new(Vec::new()),
            relay_in: StdMutex::new(HashMap::new()),
            relay_backend: StdMutex::new(Arc::new(MultiRelay::routes_from_env_or_default(
                &relay_fp,
            ))),
            relay_backend_custom: AtomicBool::new(false),
            relay_proxied: AtomicBool::new(false),
            relay_disabled: AtomicBool::new(!env_relay_enabled()),
            peer_relay_disabled: AtomicBool::new(env_no_relay()),
            peer_relay_optin: AtomicBool::new(env_peer_relay_enabled()),
            peer_relay: Arc::new(StdMutex::new(None)),
            peer_relay_backend: StdMutex::new(None),
            relay_maintains: StdMutex::new(std::collections::HashSet::new()),
            direct_maintains: StdMutex::new(std::collections::HashSet::new()),
            punch_upgrades: StdMutex::new(HashMap::new()),
            punch_rate: StdMutex::new(HashMap::new()),
            pending_calls: StdMutex::new(HashMap::new()),
            ring_seen: StdMutex::new(std::collections::HashSet::new()),
            call_rooms: StdMutex::new(super::call_room::Rooms::default()),
            cancel_tx: tokio::sync::watch::channel(false).0,
            public_addr: StdMutex::new(None),
            nat_external_port: Arc::new(AtomicU16::new(0)),
            punch_enabled: AtomicBool::new(env_punch_enabled()),
            dial_failures: StdMutex::new(HashMap::new()),
            peer_diag: StdMutex::new(HashMap::new()),
            net_diag: StdMutex::new(NetDiagInfo::default()),
            bit_dht: StdMutex::new(None),
            dht_lookups: StdMutex::new(HashMap::new()),
            dht_queue: StdMutex::new(Vec::new()),
            auto_proxy_switched: StdMutex::new(HashMap::new()),
            tunnel_sessions: StdMutex::new(HashMap::new()),
            tunnel_pending: StdMutex::new(HashMap::new()),
            peer_protos: StdMutex::new(HashMap::new()),
            tor_timeouts: StdMutex::new(HashMap::new()),
            tunnel_pings: StdMutex::new(HashMap::new()),
            tunnel_meta: StdMutex::new(HashMap::new()),
            tunnel_reasm: StdMutex::new(TunnelReassembler::new()),
            tunnel_disabled: AtomicBool::new(matches!(
                std::env::var("DISTORRENT_NO_TUNNEL")
                    .ok()
                    .as_deref()
                    .map(|s| s.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1" | "true" | "yes" | "on")
            )),
            spam_flood: StdMutex::new(HashMap::new()),
            spam_dup: StdMutex::new(HashMap::new()),
            reaction_limiter: StdMutex::new(ReactionLimiter::new()),
            release_trust: StdMutex::new(crate::release::ReleaseTrust::empty("inicializando")),
            peer_trust: StdMutex::new(HashMap::new()),
            attest_nonce: StdMutex::new(HashMap::new()),
            attest_sent_at: StdMutex::new(HashMap::new()),
            attest_transcript: StdMutex::new(HashMap::new()),
            netlimiter: NetLimiter::from_env(),
            #[cfg(target_os = "linux")]
            voice: StdMutex::new(build_voice_media()),
            #[cfg(target_os = "linux")]
            voice_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            held_calls: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            voice_channel_calls: StdMutex::new(HashMap::new()),
        })
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    pub fn store_ref(&self) -> &Store {
        &self.store
    }

    pub fn keypair(&self) -> Keypair {
        (*self.keypair).clone()
    }

    pub fn secret_hex(&self) -> String {
        self.keypair.secret_hex()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }

    /// Emite um evento interno. Existe para testes de integração (ponte local do
    /// bot) conseguirem simular entradas sem abrir socket real.
    pub fn emit_for_test(&self, ev: EngineEvent) {
        let _ = self.events.send(ev);
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port.load(Ordering::Relaxed)
    }

    pub fn dht_announce_port(&self) -> Option<u16> {
        if let Some(addr) = self
            .public_addr
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
        {
            if let Ok(sa) = addr.parse::<std::net::SocketAddr>() {
                if sa.port() != 0 {
                    return Some(sa.port());
                }
            }
        }
        let ext = self.nat_external_port.load(Ordering::Relaxed);
        if ext != 0 {
            return Some(ext);
        }
        None
    }

    pub fn start(self: &Arc<Self>) -> Result<()> {
        self.start_with_discovery(true)
    }

    pub fn start_with_discovery(self: &Arc<Self>, discovery: bool) -> Result<()> {
        {
            let mut s = self.started.lock().unwrap_or_else(|e| e.into_inner());
            if *s {
                return Err(DistorrentError::AlreadyStarted);
            }
            *s = true;
        }
        let engine = self.clone();
        let handle = tokio::spawn(async move {
            let cmd_rx = engine
                .cmd_rx
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            let cmd_handle = cmd_rx.map(|rx| tokio::spawn(command_loop(engine.clone(), rx)));
            let shutdown = engine.shutdown.clone();
            tokio::select! {
                r = run_engine(engine.clone(), discovery) => {
                    if let Err(e) = r {
                        tracing::error!("engine parou: {e}");
                    }
                }
                _ = shutdown.notified() => {
                    tracing::info!("engine shutdown solicitado");
                }
            }
            if let Some(h) = cmd_handle {
                h.abort();
            }
        });
        self.handles
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(handle);
        Ok(())
    }

    // Seção 5: shutdown
    pub fn shutdown(&self) {
        let _ = self.cancel_tx.send(true);
        let port = self.listen_port.load(Ordering::Relaxed);
        if port != 0 {
            process_ports()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&port);
        }
        self.shutdown.notify_waiters();
        for fp in self.online_peer_fps() {
            self.disconnect_peer(&fp);
        }
        let mut hs = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for h in hs.drain(..) {
            h.abort();
        }
        *self.started.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }

    pub fn privacy_set_mode(&self, mode: &str) -> Result<()> {
        match mode {
            "normal" | "encrypted" | "proxy" | "full" => {
                self.store.kv_set("privacy.mode", mode)?;
                self.refresh_relay_for_privacy();
                self.refresh_peer_relay();
                if matches!(mode, "proxy" | "full") {
                    let direct: Vec<String> = {
                        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
                        links
                            .iter()
                            .filter(|(_, l)| l.get_state() == PeerLinkState::Online && !l.via_relay)
                            .map(|(fp, _)| fp.clone())
                            .collect()
                    };
                    for fp in direct {
                        info!(%fp, "sessão direta encerrada: política anônima em vigor");
                        self.disconnect_peer(&fp);
                    }
                    *self.public_addr.lock().unwrap_or_else(|e| e.into_inner()) = None;
                }
                Ok(())
            }
            _ => Err(DistorrentError::Protocol(format!(
                "modo de privacidade inválido: {mode}"
            ))),
        }
    }

    pub fn privacy_mode(&self) -> String {
        self.store
            .kv_get("privacy.mode")
            .unwrap_or_else(|| "encrypted".to_string())
    }

    fn anonymity_addr_key(mode: &str) -> &'static str {
        if mode == "full" {
            "privacy.tor_addr"
        } else {
            "privacy.proxy_addr"
        }
    }

    pub fn anonymity_proxy(&self) -> Option<String> {
        let mode = self.privacy_mode();
        match mode.as_str() {
            "full" => {
                if let Some(addr) = self.store.kv_get(Self::anonymity_addr_key(&mode)) {
                    if !addr.trim().is_empty() {
                        return Some(addr);
                    }
                }
                Some(
                    std::env::var("DISTORRENT_TOR_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:9050".to_string()),
                )
            }
            "proxy" => {
                if let Some(addr) = self.store.kv_get(Self::anonymity_addr_key(&mode)) {
                    if !addr.trim().is_empty() {
                        return Some(addr);
                    }
                }
                Some(
                    std::env::var("DISTORRENT_PROXY_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:1080".to_string()),
                )
            }
            _ => None,
        }
    }

    pub fn set_anonymity_addr(&self, mode: &str, addr: &str) -> Result<()> {
        let key = Self::anonymity_addr_key(mode);
        let addr = addr.trim();
        if addr.is_empty() {
            self.store.kv_delete(key)?;
        } else {
            let _ = crate::net::socks5::split_host_port(addr)?;
            self.store.kv_set(key, addr)?;
        }
        self.refresh_relay_for_privacy();
        Ok(())
    }

    pub fn set_proxy_addr(&self, addr: &str) -> Result<()> {
        self.set_anonymity_addr("proxy", addr)
    }

    fn proxy_configured(&self) -> bool {
        if let Ok(v) = std::env::var("DISTORRENT_PROXY_ADDR") {
            if !v.trim().is_empty() {
                return true;
            }
        }
        self.store
            .kv_get("privacy.proxy_addr")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    }

    fn record_dial_failure(&self, peer_fp: &str) {
        if peer_fp.is_empty() {
            return;
        }
        let now = crate::identity::now_ms();
        let mut map = self.dial_failures.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 4096 {
            map.clear();
        }
        let e = map.entry(peer_fp.to_string()).or_insert((0, now));
        e.0 = e.0.saturating_add(1);
        if e.0 == 1 {
            e.1 = now;
        }
    }

    fn reset_dial_failures(&self, peer_fp: &str) {
        self.dial_failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_fp);
    }

    pub fn note_dial_failure(&self, peer_fp: &str) {
        self.record_dial_failure(peer_fp);
        if self.direct_unreachable(peer_fp) {
            self.request_peer_path(peer_fp);
        }
        self.maybe_auto_fallback_proxy(peer_fp);
    }

    pub fn direct_unreachable(&self, peer_fp: &str) -> bool {
        let (count, first_ms) = {
            let map = self.dial_failures.lock().unwrap_or_else(|e| e.into_inner());
            map.get(peer_fp).copied().unwrap_or((0, 0))
        };
        if count < DIRECT_UNREACHABLE_THRESHOLD {
            return false;
        }
        let now = crate::identity::now_ms();
        first_ms > 0 && now.saturating_sub(first_ms) >= DIRECT_UNREACHABLE_STALL_MS
    }

    // Seção 6: request_peer_path
    fn request_peer_path(&self, peer_fp: &str) {
        if peer_fp.is_empty() || peer_fp == self.identity.fingerprint {
            return;
        }
        self.diag_update(peer_fp, |d| {
            d.last_direct_err = Some(format!(
                "sem porta TCP aberta dos dois lados ({} falhas) — usando relay/tunel",
                d.direct_attempts
            ));
        });
        self.tunnel_request(peer_fp);
    }

    fn diag_update(&self, fp: &str, f: impl FnOnce(&mut PeerDiagInfo)) {
        let mut map = self.peer_diag.lock().unwrap_or_else(|e| e.into_inner());
        let now = crate::identity::now_ms();
        let entry = map.entry(fp.to_string()).or_default();
        f(entry);
        entry.last_seen_ms = now;
        if map.len() > 512 {
            let mut recent: Vec<(String, i64)> = map
                .iter()
                .map(|(k, v)| (k.clone(), v.last_seen_ms))
                .collect();
            recent.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
            let keep: std::collections::HashSet<String> =
                recent.into_iter().take(512).map(|(k, _)| k).collect();
            map.retain(|k, _| keep.contains(k));
        }
    }

    pub fn peer_diag(&self, fp: &str) -> PeerDiagInfo {
        self.peer_diag
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .cloned()
            .unwrap_or_default()
    }

    pub fn net_diag(&self) -> NetDiagInfo {
        self.net_diag
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn diag_record_direct_err(&self, fp: &str, err: &str) {
        self.diag_update(fp, |d| {
            d.last_direct_err = Some(short_diag_err(err));
            d.direct_attempts = d.direct_attempts.saturating_add(1);
        });
    }

    fn diag_record_direct_ok(&self, fp: &str) {
        self.diag_update(fp, |d| {
            d.last_direct_err = None;
            d.last_direct_ok_ms = crate::identity::now_ms();
        });
    }

    fn diag_record_relay_err(&self, fp: &str, err: &str) {
        self.diag_update(fp, |d| {
            d.last_relay_err = Some(short_diag_err(err));
            d.relay_attempts = d.relay_attempts.saturating_add(1);
        });
    }

    fn diag_record_relay_ok(&self, fp: &str) {
        self.diag_update(fp, |d| {
            d.last_relay_err = None;
            d.last_relay_ok_ms = crate::identity::now_ms();
        });
    }

    fn diag_record_announce_seen(&self, fp: &str) {
        self.diag_update(fp, |d| {
            d.announce_seen_ms = crate::identity::now_ms();
        });
    }

    pub fn diag_record_net(&self, f: impl FnOnce(&mut NetDiagInfo)) {
        let mut d = self.net_diag.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut d);
    }

    pub fn ensure_bit_dht(&self) -> Result<()> {
        let mut guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Ok(());
        }
        match mainline::Dht::client() {
            Ok(dht) => {
                *guard = Some(Arc::new(dht));
                debug!("DHT BitTorrent: nó mainline iniciado (descoberta descentralizada)");
                Ok(())
            }
            Err(e) => {
                debug!("DHT BitTorrent: falhou ao subir nó ({e}) — tenta de novo");
                Err(DistorrentError::Protocol(format!("dht node: {e}")))
            }
        }
    }

    pub fn shutdown_bit_dht(&self) {
        let mut guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dht) = guard.take() {
            let _ = Arc::try_unwrap(dht).map(|mut d| d.shutdown());
        }
    }

    pub fn bit_dht_announce(&self, infohash: mainline::Id, port: u16) -> Result<()> {
        let guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        let dht = guard
            .as_ref()
            .ok_or_else(|| DistorrentError::Protocol("dht não iniciada".into()))?;
        dht.announce_peer(infohash, Some(port))
            .map(|_| ())
            .map_err(|e| DistorrentError::Protocol(format!("announce_peer: {e}")))
    }

    pub fn bit_dht_lookup_and_dial(&self, peer_fp: String) -> usize {
        self.dht_lookups
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(peer_fp.clone(), crate::identity::now_ms());
        let guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        let Some(dht) = guard.as_ref().cloned() else {
            return 0;
        };
        drop(guard);
        let ih = crate::net::dht::identity_infohash(&peer_fp);
        let mut found: Vec<std::net::SocketAddr> = Vec::new();
        if let Ok(iter) = dht.get_peers(ih) {
            for batch in iter {
                for a in batch {
                    if found.len() >= 8 {
                        break;
                    }
                    found.push(a);
                }
                if found.len() >= 8 {
                    break;
                }
            }
        }
        if found.is_empty() {
            self.diag_update(&peer_fp, |d| {
                d.last_direct_err = Some("DHT: sem peers no infohash (amigo offline?)".into());
                d.direct_attempts = d.direct_attempts.saturating_add(1);
            });
            return 0;
        }
        info!(fp=%peer_fp, addrs=?found, "DHT BitTorrent: endpoints descobertos — dial direto");
        self.diag_update(&peer_fp, |d| {
            d.announce_seen_ms = crate::identity::now_ms();
        });
        let n = found.len();
        for a in found {
            self.cmd_tx
                .send(EngineCmd::ConnectTo(a, Some(peer_fp.clone())))
                .ok();
        }
        n
    }

    // Seção 7: dht_probe
    pub fn dht_probe(&self, peer_fp: &str) {
        if !crate::net::dht::bit_dht_enabled() {
            return;
        }
        let mut q = self.dht_queue.lock().unwrap_or_else(|e| e.into_inner());
        if q.len() < 64 {
            q.push(peer_fp.to_string());
        }
    }

    pub fn dht_queue_pop(&self, max: usize) -> Vec<String> {
        let mut q = self.dht_queue.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        while out.len() < max && !q.is_empty() {
            let fp = q.remove(0);
            if !out.contains(&fp) {
                out.push(fp);
            }
        }
        out
    }

    pub fn dht_lookup_due(&self, peer_fp: &str, min_ms: i64) -> bool {
        let map = self.dht_lookups.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(peer_fp) {
            Some(t) => crate::identity::now_ms().saturating_sub(*t) >= min_ms,
            None => true,
        }
    }

    pub fn friends_without_session(&self, max: usize) -> Vec<String> {
        let accepted = self
            .store
            .list_friends(Some("accepted"))
            .unwrap_or_default();
        let pending = self
            .store
            .list_friends(Some("pending_out"))
            .unwrap_or_default();
        let friends: Vec<String> = accepted.into_iter().chain(pending).map(|p| p.fp).collect();
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        friends
            .into_iter()
            .filter(|fp| {
                links
                    .get(fp)
                    .map(|l| l.get_state() != PeerLinkState::Online)
                    .unwrap_or(true)
            })
            .take(max)
            .collect()
    }

    pub fn maybe_auto_fallback_proxy(&self, peer_fp: &str) {
        if self.peer_relay_fp().is_some() {
            return;
        }
        let now = crate::identity::now_ms();
        let (count, first_ms) = {
            let map = self.dial_failures.lock().unwrap_or_else(|e| e.into_inner());
            map.get(peer_fp).copied().unwrap_or((0, 0))
        };
        let stalled = first_ms > 0 && now.saturating_sub(first_ms) >= AUTO_PROXY_STALL_MS;
        let failures = if stalled {
            count.max(AUTO_PROXY_FAILURE_THRESHOLD)
        } else {
            count
        };
        let already_switched = {
            let map = self
                .auto_proxy_switched
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.get(peer_fp)
                .map(|ts| now.saturating_sub(*ts) < AUTO_PROXY_COOLDOWN_MS)
                .unwrap_or(false)
        };
        let mode = self.privacy_mode();
        if !auto_proxy_should_switch(
            &mode,
            self.proxy_configured(),
            auto_proxy_enabled(),
            already_switched,
            failures,
        ) {
            return;
        }
        self.auto_proxy_switched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(peer_fp.to_string(), now);
        let reason = format!(
            "sem conexão direta nem intermediário após {failures} falhas — roteando por SOCKS5"
        );
        match self.privacy_set_mode("proxy") {
            Ok(()) => {
                let _ = self.store.kv_set("privacy.auto_switched", "1");
                let _ = self.store.kv_set("privacy.auto_switched.peer", peer_fp);
                let _ = self.store.kv_set("privacy.auto_switched.reason", &reason);
                info!(peer_fp, %reason, "fallback automático: modo de privacidade → proxy (SOCKS5)");
                let _ = self.events.send(EngineEvent::ModeAutoSwitched {
                    to: "proxy".to_string(),
                    reason,
                });
            }
            Err(e) => warn!(peer_fp, "fallback automático para proxy falhou: {e}"),
        }
    }

    pub async fn relay_diagnostics(&self) -> Vec<crate::net::relay::RelayLegStatus> {
        let proxy = self.anonymity_proxy();
        crate::net::relay::check_relay_legs_via(proxy.as_deref()).await
    }

    pub fn connect_host(&self, host_port: &str, expected_fp: Option<String>) -> Result<()> {
        let (host, port) = split_host_port(host_port)?;
        self.cmd_tx
            .send(EngineCmd::ConnectHost {
                host,
                port,
                expected_fp,
            })
            .ok();
        Ok(())
    }

    pub fn add_manual_peer(&self, addr: SocketAddr, expected_fp: Option<String>) {
        self.cmd_tx
            .send(EngineCmd::ConnectTo(addr, expected_fp))
            .ok();
    }

    pub fn set_relay_backend(&self, backend: Arc<dyn RelayBackend>) {
        *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) = backend;
        self.relay_backend_custom.store(true, Ordering::Relaxed);
        self.relay_proxied.store(false, Ordering::Relaxed);
        self.relay_disabled.store(false, Ordering::Relaxed);
    }

    pub fn set_relay_disabled(&self, disabled: bool) {
        self.relay_disabled.store(disabled, Ordering::Relaxed);
        self.peer_relay_disabled.store(disabled, Ordering::Relaxed);
        self.refresh_peer_relay();
        debug!(disabled, "relay: kill-switch atualizado");
    }

    pub fn relay_is_disabled(&self) -> bool {
        self.relay_disabled.load(Ordering::Relaxed)
    }

    pub fn relay_is_proxied(&self) -> bool {
        self.relay_proxied.load(Ordering::Relaxed)
    }

    pub fn net_limits_snapshot(&self) -> crate::net::netlimit::LimitsSnapshot {
        self.netlimiter.snapshot()
    }

    pub fn net_limits_reconfigure(&self, l: crate::net::netlimit::Limits) {
        self.netlimiter.reconfigure(l);
    }

    pub fn punch_enabled(&self) -> bool {
        self.punch_enabled.load(Ordering::Relaxed)
    }

    // Seção 8: set_punch_enabled
    pub fn set_punch_enabled(&self, on: bool) {
        self.punch_enabled.store(on, Ordering::Relaxed);
        debug!(on, "hole punch: kill-flag atualizado");
    }

    fn refresh_relay_for_privacy(&self) {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return;
        }
        let mode = self.privacy_mode();
        let proxy_mode = matches!(mode.as_str(), "proxy" | "full");
        let currently_proxied = self.relay_proxied.load(Ordering::Relaxed);
        if proxy_mode {
            let proxy = self
                .anonymity_proxy()
                .unwrap_or_else(|| "127.0.0.1:1080".to_string());
            match MultiRelay::proxied_routes_with_fp(&proxy, &self.identity.fingerprint) {
                Ok(b) => {
                    *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(b);
                    self.relay_proxied.store(true, Ordering::Relaxed);
                    debug!(%proxy, "relay: modo anônimo — MQTT via túneis SOCKS5 (sem abrir porta, sem vazar IP)");
                }
                Err(e) => {
                    self.relay_proxied.store(false, Ordering::Relaxed);
                    debug!("relay: proxy SOCKS5 inválido ({e}) — relay desligado no modo anônimo (fail-closed)");
                }
            }
        } else if currently_proxied {
            *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(
                MultiRelay::routes_from_env_or_default(&self.identity.fingerprint),
            );
            self.relay_proxied.store(false, Ordering::Relaxed);
            debug!("relay: modo normal/encrypted — rotas públicas diretas restauradas");
        }
    }

    pub fn set_public_addr(&self, addr: String) {
        *self.public_addr.lock().unwrap_or_else(|e| e.into_inner()) = Some(addr);
    }

    pub fn is_peer_via_relay(&self, fp: &str) -> bool {
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| l.via_relay && l.get_state() == PeerLinkState::Online)
            .unwrap_or(false)
    }

    pub fn relay_stats(&self) -> (u64, u64) {
        let backend = self
            .relay_backend
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let s = backend.stats();
        (s.posts, s.poll_hits)
    }

    pub fn peer_relay_fp(&self) -> Option<String> {
        self.peer_relay
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn peer_relay_serving_enabled(&self) -> bool {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return false;
        }
        if !self.peer_relay_optin.load(Ordering::Relaxed) {
            return false;
        }
        if self.peer_relay_disabled.load(Ordering::Relaxed) {
            return false;
        }
        peer_relay_policy(&self.privacy_mode()).1
    }

    pub fn peer_relay_enabled(&self) -> bool {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return false;
        }
        if !self.peer_relay_optin.load(Ordering::Relaxed) {
            return false;
        }
        if self.peer_relay_disabled.load(Ordering::Relaxed) {
            return false;
        }
        peer_relay_policy(&self.privacy_mode()).0
    }

    pub fn peer_relay_optin_enabled(&self) -> bool {
        self.peer_relay_optin.load(Ordering::Relaxed)
    }

    pub fn set_peer_relay_enabled(&self, on: bool) {
        self.peer_relay_optin.store(on, Ordering::Relaxed);
        if on {
            self.peer_relay_disabled.store(false, Ordering::Relaxed);
        }
        self.refresh_peer_relay();
        debug!(on, "peer-relay: opt-in atualizado");
    }

    fn refresh_peer_relay(&self) {
        let new = if self.peer_relay_enabled() {
            let me = self.identity.fingerprint.clone();
            let mut cands: Vec<String> = self
                .links
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter(|(fp, l)| {
                    fp.as_str() != me.as_str()
                        && l.get_state() == PeerLinkState::Online
                        && !l.via_relay
                })
                .map(|(fp, _)| fp.clone())
                .collect();
            cands.retain(|fp| !self.is_blocked(fp));
            cands.sort();
            cands.into_iter().next()
        } else {
            None
        };
        let mut cur = self.peer_relay.lock().unwrap_or_else(|e| e.into_inner());
        if *cur != new {
            match &new {
                Some(fp) => debug!(%fp, "peer-relay: intermediário direto selecionado"),
                None => debug!("peer-relay: sem intermediário — usa relay configurado"),
            }
            *cur = new;
        }
    }

    fn peer_relay_backend_for(self: &Arc<Self>, relay_fp: &str) -> Arc<PeerRelayBackend> {
        let mut cache = self
            .peer_relay_backend
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some((fp, b)) = cache.as_ref() {
            if fp == relay_fp {
                return b.clone();
            }
        }
        let b = Arc::new(PeerRelayBackend::new(
            Arc::downgrade(self),
            relay_fp.to_string(),
        ));
        *cache = Some((relay_fp.to_string(), b.clone()));
        b
    }

    pub fn peers(&self) -> Vec<PeerRecord> {
        self.store.list_peers().unwrap_or_default()
    }

    // ---------------------------------------------------------------------
    // Autenticidade de build (attestation)
    // ---------------------------------------------------------------------

    /// Carrega o conjunto de confiança do banco local (uma vez no boot).
    pub fn init_release_trust(self: &Arc<Self>) {
        let loaded = super::release_trust::load(&self.store);
        let mut guard = self.release_trust.lock().unwrap_or_else(|e| e.into_inner());
        *guard = loaded;
    }

    pub fn release_trust_snapshot(&self) -> crate::release::ReleaseTrust {
        self.release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn peer_trust_snapshot(&self, fp: &str) -> Option<crate::release::PeerTrust> {
        self.peer_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .cloned()
    }

    pub fn peer_trust_all(&self) -> Vec<(String, crate::release::PeerTrust)> {
        self.peer_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub fn memory_floor(&self) -> u64 {
        self.release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .epoch_floor()
    }

    /// Registra o transcript da conexão para assinar a própria atestação.
    pub fn set_attest_transcript(&self, fp: &str, transcript_hash: &str) {
        let mut m = self
            .attest_transcript
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if m.len() > 4096 {
            m.clear();
        }
        m.insert(fp.to_string(), transcript_hash.to_string());
    }

    /// Envia o desafio de atestação para um peer que fala proto_v >= 5.
    pub fn send_build_challenge(self: &Arc<Self>, peer_fp: &str) {
        if self.peer_proto(peer_fp) < crate::release::ATTEST_PROTO_V {
            return;
        }
        let Some(transcript) = self
            .attest_transcript
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_fp)
            .cloned()
        else {
            return;
        };
        let mut nonce = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        {
            let mut m = self.attest_nonce.lock().unwrap_or_else(|e| e.into_inner());
            if m.len() > 4096 {
                m.clear();
            }
            m.insert(peer_fp.to_string(), nonce);
        }
        {
            let mut m = self
                .attest_sent_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if m.len() > 4096 {
                m.clear();
            }
            m.insert(peer_fp.to_string(), crate::identity::now_ms());
        }
        let policy = super::release_trust::peer_policy(&self.store);
        self.send_to_peer(
            peer_fp.to_string(),
            SecureFrame::BuildChallenge {
                nonce_hex: hex::encode(nonce),
                transcript_hash: transcript,
                policy: policy.as_str().to_string(),
            },
        );
    }

    /// Monta a própria atestação para responder a um desafio.
    fn own_build_attestation(
        &self,
        nonce: [u8; 32],
        transcript_hash: &str,
    ) -> Option<crate::release::BuildAttestation> {
        let trust = self.release_trust_snapshot();
        let self_integrity = super::release_trust::self_integrity(&self.store);
        let manifest = trust.latest_verified().map(|v| v.manifest.clone());
        let claim = crate::release::BuildClaim {
            version: env!("CARGO_PKG_VERSION").to_string(),
            manifest_hash: manifest
                .as_ref()
                .map(|m| m.body.hash_hex().unwrap_or_default())
                .unwrap_or_default(),
            build_id: super::release_trust::build_id(
                &self.identity.pubkey_hex,
                env!("CARGO_PKG_VERSION"),
            ),
            commit: manifest
                .as_ref()
                .map(|m| m.body.commit.clone())
                .unwrap_or_default(),
            channel: manifest
                .as_ref()
                .map(|m| m.body.channel.clone())
                .unwrap_or_else(|| "unknown".into()),
            protocol_version: crate::net::transport::PROTO_V,
            security_epoch: trust.epoch_floor(),
            self_integrity,
        };
        crate::release::BuildAttestation::sign(
            &self.keypair,
            transcript_hash,
            &nonce,
            claim,
            manifest.as_ref(),
        )
        .ok()
    }

    /// Grava o veredito do peer e decide a quarentena.
    fn record_peer_trust(
        self: &Arc<Self>,
        peer_fp: &str,
        trust: crate::release::PeerTrust,
    ) -> bool {
        let policy = super::release_trust::peer_policy(&self.store);
        let verification_available = self
            .release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .verification_available();
        let blocked = policy
            .decision(&trust, verification_available)
            .map(str::to_string);
        let state = trust.state;
        let version = trust.version.clone();
        let manifest_hash = trust.manifest_hash.clone();
        let build_id = trust.build_id.clone();
        let commit = trust.commit.clone();
        let channel = trust.channel.clone();
        let valid_signatures = trust.valid_signatures;
        let reason = trust.reason.clone();
        let hardware = trust.hardware.clone();
        let self_integrity = trust.self_integrity;
        {
            let mut m = self.peer_trust.lock().unwrap_or_else(|e| e.into_inner());
            if m.len() > 4096 {
                m.clear();
            }
            m.insert(peer_fp.to_string(), trust);
        }
        let _ = self.events.send(EngineEvent::PeerTrustChanged {
            fp: peer_fp.into(),
            state: state.as_str().into(),
            version,
            manifest_hash,
            build_id,
            commit,
            channel,
            valid_signatures,
            self_integrity: match self_integrity {
                crate::release::SelfIntegrityState::Confere => "CONFERE",
                crate::release::SelfIntegrityState::Diverge => "DIVERGE",
                crate::release::SelfIntegrityState::Unavailable => "UNAVAILABLE",
            }
            .into(),
            hardware_proof: hardware.proof_available,
            hardware_reason: hardware.reason,
            reason: reason.clone(),
            verification_available,
            quarantined: blocked.is_some(),
            quarantine_reason: blocked.clone().unwrap_or_default(),
        });
        if let Some(r) = &blocked {
            debug!(peer_fp, reason = %r, "peer em quarentena (política de autenticidade)");
        }
        blocked.is_none()
    }

    /// `true` quando o peer está em quarentena e só pode falar o mínimo.
    ///
    /// Enquanto a atestação está PENDENTE dentro da janela de tolerância, o
    /// peer não é bloqueado (a resposta está a caminho). Passada a janela sem
    /// resposta, ele passa a contar como NAO_VERIFICADO — não fica "no limbo"
    /// para sempre, que era a brecha de um peer que simplesmente não responde.
    pub fn peer_quarantined(&self, peer_fp: &str) -> bool {
        let map = self.peer_trust.lock().unwrap_or_else(|e| e.into_inner());
        let policy = super::release_trust::peer_policy(&self.store);
        let available = self
            .release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .verification_available();
        match map.get(peer_fp) {
            Some(t) => policy.decision(t, available).is_some(),
            None => {
                // Sem veredito AINDA: se há desafio pendente e ele é recente,
                // deixa passar (a prova está a caminho). Se venceu, trata como
                // não verificado e aplica a política.
                if !available {
                    return false;
                }
                let sent = self
                    .attest_sent_at
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(peer_fp)
                    .copied();
                let agora = crate::identity::now_ms();
                let vencido = match sent {
                    Some(t) => agora.saturating_sub(t) > crate::release::ATTEST_TIMEOUT_MS,
                    // Nenhum desafio foi enviado (peer proto_v < 5): não há
                    // prova possível, então é NAO_VERIFICADO de fato.
                    None => self.peer_proto(peer_fp) < crate::release::ATTEST_PROTO_V,
                };
                if !vencido {
                    return false;
                }
                policy
                    .decision(
                        &crate::release::PeerTrust::unavailable("sem prova"),
                        available,
                    )
                    .is_some()
            }
        }
    }

    pub fn peer_proto(&self, fp: &str) -> u32 {
        self.peer_protos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .copied()
            .unwrap_or(0)
    }

    /// Aceita um manifesto recebido de peer: RE-VERIFICA com as chaves locais
    /// e só então guarda. Manifesto de peer nunca é ordem de nada.
    pub fn accept_peer_manifest(&self, peer_fp: &str, hex_wire: &str) -> Result<bool> {
        if hex_wire.len() > crate::release::MAX_MANIFEST_BYTES * 2 {
            return Err(DistorrentError::Protocol(
                "manifesto de peer acima do limite".into(),
            ));
        }
        let wire = hex::decode(hex_wire)
            .map_err(|_| DistorrentError::Protocol("manifesto de peer não é hex".into()))?;
        let signed = crate::release::SignedManifest::from_wire(&wire)?;
        let kv = super::release_trust::StoreKv(self.store.clone());
        let mut trust = self.release_trust.lock().unwrap_or_else(|e| e.into_inner());
        let verified = trust.accept(&kv, &signed)?;
        let ok = verified.is_verified();
        if ok {
            debug!(
                peer_fp,
                version = %verified.manifest.body.version,
                "manifesto de peer verificado e guardado"
            );
        } else {
            debug!(peer_fp, reason = %verified.reason, "manifesto de peer recusado");
        }
        Ok(ok)
    }

    pub fn send_to_peer(&self, peer_fp: String, frame: SecureFrame) {
        if !matches!(
            frame,
            SecureFrame::TunnelOffer { .. }
                | SecureFrame::TunnelAnswer { .. }
                | SecureFrame::TunnelData { .. }
        ) && self.tunnel_should_carry(&peer_fp)
        {
            if self.tunnel_send_frame(&peer_fp, &frame) {
                return;
            }
        }
        self.cmd_tx.send(EngineCmd::SendToPeer(peer_fp, frame)).ok();
    }

    // Seção 9: tunnel_should_carry
    fn tunnel_should_carry(&self, peer_fp: &str) -> bool {
        if !self.tunnel_enabled() || !self.tunnel_established(peer_fp) {
            return false;
        }
        if self.peer_state(peer_fp) != NetworkState::Connected || !self.is_peer_via_relay(peer_fp) {
            return false;
        }
        let agora = crate::identity::now_ms();
        let map = self
            .tunnel_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match map.get(peer_fp) {
            Some(s) => s.is_proven(
                agora,
                TUNNEL_PROVE_GRACE_MS,
                TUNNEL_PROVE_TTL_MS,
                TUNNEL_PROVE_WINDOW_MS,
            ),
            None => false,
        }
    }

    fn tunnel_drop(&self, peer_fp: &str, motivo: &str) {
        let tinha = {
            let mut map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.remove(peer_fp).is_some()
        };
        if !tinha {
            return;
        }
        {
            let mut meta = self.tunnel_meta.lock().unwrap_or_else(|e| e.into_inner());
            meta.remove(peer_fp);
        }
        {
            let mut pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pend.remove(peer_fp);
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_up = false;
        });
        debug!(peer_fp, motivo, "tunel: sessão descartada");
    }

    pub fn tunnel_reap_stale(&self) {
        let agora = crate::identity::now_ms();
        let mortos: Vec<String> = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.iter()
                .filter(|(_, s)| s.is_dead(agora, TUNNEL_PROVE_GRACE_MS, TUNNEL_DEAD_MS))
                .map(|(fp, _)| fp.clone())
                .collect()
        };
        for fp in mortos {
            self.tunnel_drop(&fp, "sem prova de vida (varredura)");
            self.tunnel_request(&fp);
        }
    }

    pub fn reap_half_open_links(&self) {
        const SEM_ACK_MS: i64 = 120_000;
        let agora = crate::identity::now_ms();
        let candidatos: Vec<String> = {
            let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
            links
                .iter()
                .filter(|(_, l)| l.get_state() == PeerLinkState::Online)
                .map(|(fp, _)| fp.clone())
                .collect()
        };
        for fp in candidatos {
            if self.store.peer_in_active_call(&fp) {
                continue;
            }
            let presas = self.store.outbox_len_for_peer(&fp);
            if presas == 0 {
                continue;
            }
            let (last_ack, last_rx) = {
                let diag = self.peer_diag.lock().unwrap_or_else(|e| e.into_inner());
                match diag.get(&fp) {
                    Some(d) => (d.last_ack_ms, d.last_rx_ms),
                    None => continue,
                }
            };
            let referencia = if last_ack > 0 { last_ack } else { last_rx };
            if referencia == 0 || agora.saturating_sub(referencia) < SEM_ACK_MS {
                continue;
            }
            warn!(
                peer_fp = %fp,
                presas,
                sem_ack_ms = agora.saturating_sub(last_ack),
                "link meio-vivo: online sem confirmação de dados — refazendo sessão"
            );
            self.diag_update(&fp, |d| {
                d.last_reject = Some(format!(
                    "link online porém sem confirmação há {}s — sessão refeita",
                    agora.saturating_sub(referencia) / 1000
                ));
                d.last_reject_ms = agora;
            });
            {
                let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(old) = links.remove(&fp) {
                    old.drop_notify.notify_one();
                }
                if self.should_keep_dialing(&fp) {
                    links.insert(
                        fp.clone(),
                        Arc::new(PeerLink {
                            state: StdMutex::new(PeerLinkState::Reconnecting),
                            tx: None,
                            drop_notify: Notify::new(),
                            via_relay: false,
                            initiator: false,
                        }),
                    );
                }
            }
            self.note_dial_failure(&fp);
            self.emit_state();
        }
    }

    fn tunnel_send_frame(&self, peer_fp: &str, frame: &SecureFrame) -> bool {
        let json = match serde_json::to_vec(frame) {
            Ok(v) if v.len() <= TUN_FRAME_MAX => v,
            _ => return false,
        };
        static FRAG_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let (nonce_list, sealed) = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let sess = match map.get(peer_fp) {
                Some(s) => s,
                None => return false,
            };
            let my_fp = self.identity.fingerprint.clone();
            if json.len() <= TUN_FRAG_MAX {
                let pt = encode_full(&json);
                match sess.seal(&my_fp, peer_fp, &pt) {
                    Ok((n, ct)) => (vec![n], vec![ct]),
                    Err(_) => return false,
                }
            } else {
                // Seção 10: id
                let id = FRAG_ID.fetch_add(1, Ordering::SeqCst);
                let chunks: Vec<&[u8]> = json.chunks(TUN_FRAG_MAX).collect();
                let total = chunks.len() as u16;
                let mut out = Vec::with_capacity(chunks.len());
                for (i, ch) in chunks.iter().enumerate() {
                    let pt = encode_frag(id, i as u16, total, ch);
                    match sess.seal(&my_fp, peer_fp, &pt) {
                        Ok((n, ct)) => out.push((n, ct)),
                        Err(_) => return false,
                    }
                }
                let (ns, cts): (Vec<u64>, Vec<Vec<u8>>) = out.into_iter().unzip();
                (ns, cts)
            }
        };
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        for (n, ct) in nonce_list.into_iter().zip(sealed.into_iter()) {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::TunnelData {
                        nonce: n,
                        ct_b64: B64.encode(&ct),
                    },
                ))
                .ok();
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_tx_frames = d.tunnel_tx_frames.saturating_add(1);
        });
        self.tunnel_housekeep(peer_fp);
        true
    }

    fn tunnel_housekeep(&self, peer_fp: &str) {
        const REKEY_BYTES: u64 = 256 * 1024 * 1024;
        const REKEY_AGE_MS: i64 = 24 * 60 * 60 * 1000;
        let stale = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match map.get(peer_fp) {
                Some(s) => {
                    s.tx_bytes.load(Ordering::SeqCst) >= REKEY_BYTES
                        || crate::identity::now_ms() - s.created_ms >= REKEY_AGE_MS
                }
                None => false,
            }
        };
        if stale {
            debug!(peer_fp, "tunel: rekey por volume/idade");
            self.tunnel_rotate(peer_fp);
        }
    }

    pub fn tunnel_rotate(&self, peer_fp: &str) {
        {
            let mut map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.remove(peer_fp);
        }
        {
            let mut pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pend.remove(peer_fp);
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_up = false;
        });
        self.tunnel_request(peer_fp);
    }

    pub fn tunnel_enabled(&self) -> bool {
        !self.tunnel_disabled.load(Ordering::Relaxed)
    }

    pub fn peer_proto_v(&self, fp: &str) -> u32 {
        self.peer_protos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .copied()
            .unwrap_or(0)
    }

    pub fn tunnel_established(&self, fp: &str) -> bool {
        self.tunnel_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(fp)
    }

    pub fn tunnel_virtual_ip(fp: &str) -> String {
        virtual_ipv6(fp).to_string()
    }

    pub fn tunnel_request(&self, peer_fp: &str) {
        if !self.tunnel_enabled() || peer_fp.is_empty() {
            return;
        }
        if peer_fp == self.identity.fingerprint {
            return;
        }
        if self.tunnel_established(peer_fp) {
            return;
        }
        if self.peer_proto_v(peer_fp) < 2 {
            return;
        }
        {
            let pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(p) = pend.get(peer_fp) {
                if crate::identity::now_ms() - p.created_ms < 60_000 {
                    return;
                }
            }
        }
        let secret = x25519_dalek::StaticSecret::random_from_rng(rand::thread_rng());
        let eph_pub = x25519_dalek::PublicKey::from(&secret).to_bytes();
        let mut nonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        let my_fp = self.identity.fingerprint.clone();
        let transcript =
            tunnel_transcript(&my_fp, &eph_pub, &nonce, peer_fp, &[0u8; 32], &[0u8; 16]);
        let sig = self.keypair.sign(&transcript);
        {
            let mut pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if pend.len() > 256 {
                pend.clear();
            }
            pend.insert(
                peer_fp.to_string(),
                TunnelPending {
                    secret,
                    nonce,
                    created_ms: crate::identity::now_ms(),
                },
            );
        }
        debug!(peer_fp, "tunel: oferta enviada");
        self.send_to_peer(
            peer_fp.to_string(),
            SecureFrame::TunnelOffer {
                eph_pub_hex: hex::encode(eph_pub),
                nonce_hex: hex::encode(nonce),
                sig,
            },
        );
    }

    // Seção 11: tunnel_ping
    pub fn tunnel_ping(&self, peer_fp: &str) -> Result<u64> {
        static PING_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = PING_ID.fetch_add(1, Ordering::SeqCst);
        let msg = format!("ping:{id}");
        let sealed = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let sess = map
                .get(peer_fp)
                .ok_or_else(|| DistorrentError::Protocol("tunel: sem sessão com o peer".into()))?;
            sess.seal(
                &self.identity.fingerprint,
                peer_fp,
                &encode_full(msg.as_bytes()),
            )?
        };
        let (nonce, ct) = sealed;
        {
            let mut p = self.tunnel_pings.lock().unwrap_or_else(|e| e.into_inner());
            if p.len() > 256 {
                p.clear();
            }
            p.insert((peer_fp.to_string(), id), crate::identity::now_ms());
        }
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        self.send_to_peer(
            peer_fp.to_string(),
            SecureFrame::TunnelData {
                nonce,
                ct_b64: B64.encode(ct),
            },
        );
        Ok(id)
    }

    fn tunnel_store_session(&self, peer_fp: &str, key: [u8; 32]) {
        {
            let mut map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if map.len() > 512 {
                map.clear();
            }
            map.insert(
                peer_fp.to_string(),
                TunnelSession::new(peer_fp.to_string(), key),
            );
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_up = true;
            d.virtual_ip = Some(Self::tunnel_virtual_ip(peer_fp));
        });
        let _ = self.events.send(EngineEvent::TunnelUp {
            fp: peer_fp.to_string(),
            virtual_ip: Self::tunnel_virtual_ip(peer_fp),
        });
        info!(
            peer_fp,
            "tunel: sessão ESTABELECIDA (via relay; UDP direto na Fase 2)"
        );
    }

    fn tunnel_peer_nick(&self, peer_fp: &str) -> String {
        if let Some(p) = self
            .store
            .list_peers()
            .unwrap_or_default()
            .into_iter()
            .find(|p| p.fp == peer_fp)
        {
            if !p.nickname.is_empty() {
                return p.nickname;
            }
        }
        peer_fp.chars().take(8).collect()
    }

    fn parse_tunnel_hs(eph_hex: &str, nonce_hex: &str) -> Option<([u8; 32], [u8; 16])> {
        let eph: [u8; 32] = hex::decode(eph_hex).ok()?.try_into().ok()?;
        let nonce: [u8; 16] = hex::decode(nonce_hex).ok()?.try_into().ok()?;
        if eph == [0u8; 32] {
            return None;
        }
        Some((eph, nonce))
    }

    pub fn pex_peers(&self, limit: usize) -> Vec<PeerRecord> {
        let mut v = self.peers();
        v.retain(|p| p.fp != self.identity.fingerprint && p.addr.is_some());
        v.truncate(limit);
        v
    }

    pub fn online_peer_fps(&self) -> Vec<String> {
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, l)| l.get_state() == PeerLinkState::Online)
            .map(|(fp, _)| fp.clone())
            .collect()
    }

    pub fn online_friend_fps(&self) -> Vec<String> {
        let accepted: std::collections::HashSet<String> = self
            .store
            .list_friends(Some("accepted"))
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.fp)
            .collect();
        self.online_peer_fps()
            .into_iter()
            .filter(|fp| accepted.contains(fp))
            .collect()
    }

    pub fn peer_state(&self, fp: &str) -> NetworkState {
        let st = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| match l.get_state() {
                PeerLinkState::Online => NetworkState::Connected,
                PeerLinkState::Connecting => NetworkState::Connecting,
                PeerLinkState::Reconnecting => NetworkState::Reconnecting,
            })
            .unwrap_or(NetworkState::Disconnected);
        if st == NetworkState::Connected && !self.peer_alive(fp) {
            return NetworkState::Reconnecting;
        }
        st
    }

    pub fn peer_alive(&self, fp: &str) -> bool {
        let now = crate::identity::now_ms();
        let diag = self.peer_diag.lock().unwrap_or_else(|e| e.into_inner());
        let info = match diag.get(fp) {
            Some(d) => d,
            None => return false,
        };
        let last_rx = info.last_rx_ms;
        let online_desde = info.last_direct_ok_ms.max(info.last_relay_ok_ms);
        drop(diag);
        // Um link recém-conectado ainda não recebeu nada: isso NÃO é "vivo",
        // é "não provado". Antes `last_rx == 0` devolvia `true` para sempre e a
        // UI mostrava Conectado num par que nunca entregou um único frame.
        if last_rx == 0 {
            let graca_ms = FIRST_FRAME_GRACE.as_millis() as i64;
            return online_desde > 0 && now.saturating_sub(online_desde) <= graca_ms;
        }
        let via_relay = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| l.via_relay)
            .unwrap_or(false);
        let janela_ms = if via_relay {
            RELAY_PING_TIMEOUT.as_millis() as i64
        } else {
            PING_TIMEOUT.as_millis() as i64
        };
        now.saturating_sub(last_rx) <= janela_ms
    }

    // Seção 12: aggregated_state
    pub fn aggregated_state(&self) -> NetworkState {
        self.network_snapshot().0
    }

    /// Estado agregado e contagem de online na MESMA leitura.
    ///
    /// Antes a UI chamava `aggregated_state()` e `online_peer_fps().len()` em
    /// dois locks diferentes: entre um e outro o conjunto de links mudava e a
    /// pílula mostrava o par impossível "DISCONNECTED com 1 pessoa online".
    pub fn network_snapshot(&self) -> (NetworkState, usize) {
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        let mut online = 0usize;
        let mut reconnecting = false;
        let mut connecting = false;
        for l in links.values() {
            match l.get_state() {
                PeerLinkState::Online => online += 1,
                PeerLinkState::Reconnecting => reconnecting = true,
                PeerLinkState::Connecting => connecting = true,
            }
        }
        let state = if online > 0 {
            NetworkState::Connected
        } else if reconnecting {
            NetworkState::Reconnecting
        } else if connecting {
            NetworkState::Connecting
        } else {
            NetworkState::Disconnected
        };
        (state, online)
    }

    pub fn store_list_communities(&self) -> Vec<(String, String, String)> {
        self.store.list_communities().unwrap_or_default()
    }
    pub fn store_list_channels(&self, cid: &str) -> Vec<(String, String)> {
        self.store.list_channels(cid).unwrap_or_default()
    }
    pub fn store_list_members(&self, cid: &str) -> Vec<(String, String, String)> {
        self.store.list_members(cid).unwrap_or_default()
    }

    pub fn community_member_states(&self, community_id: &str) -> Vec<MemberPairing> {
        let owner = self
            .store
            .get_community(community_id)
            .ok()
            .flatten()
            .map(|(_, _, o)| o)
            .unwrap_or_default();
        let pending_join = self
            .pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(community_id);
        let me = &self.identity.fingerprint;
        let mut out = Vec::new();
        for (fp, nick, role) in self.store.list_members(community_id).unwrap_or_default() {
            let (state, via_relay) = if fp == *me {
                ("connected".to_string(), false)
            } else {
                let link = self
                    .links
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&fp)
                    .map(|l| (l.get_state(), l.via_relay));
                match link {
                    Some((PeerLinkState::Online, relay)) => {
                        (if relay { "relay" } else { "connected" }.to_string(), relay)
                    }
                    Some((PeerLinkState::Reconnecting, relay)) => {
                        ("reconnecting".to_string(), relay)
                    }
                    Some((PeerLinkState::Connecting, relay)) => ("connecting".to_string(), relay),
                    None => {
                        if fp == owner && pending_join {
                            ("pending_join".to_string(), false)
                        } else {
                            ("offline".to_string(), false)
                        }
                    }
                }
            };
            out.push(MemberPairing {
                is_owner: fp == owner,
                is_self: fp == *me,
                fp,
                nickname: nick,
                role,
                state,
                via_relay,
            });
        }
        out
    }

    pub fn conversations(&self) -> Vec<Conversation> {
        self.store.list_conversations().unwrap_or_default()
    }

    pub fn messages(&self, conv_id: &str) -> Vec<StoredMessage> {
        self.store.list_messages(conv_id, 500).unwrap_or_default()
    }

    pub fn messages_window(
        &self,
        conv_id: &str,
        before_ts: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredMessage>> {
        self.store.list_messages_window(conv_id, before_ts, limit)
    }

    pub fn peer_rtt_ms(&self, fp: &str) -> Option<u64> {
        crate::metrics::metrics().rtt_of(fp)
    }

    pub fn open_dm(&self, peer_fp: &str, peer_nick: &str) -> Result<Conversation> {
        if peer_fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "não é possível abrir DM consigo".into(),
            ));
        }
        let title = if peer_nick.is_empty() {
            peer_fp.to_string()
        } else {
            peer_nick.to_string()
        };
        let conv =
            self.store
                .ensure_dm_conversation(&self.identity.fingerprint, peer_fp, &title)?;
        let current = self.store.get_conversation(&conv.id)?.unwrap_or(conv);
        if !title.is_empty() && current.title != title {
            self.store.update_conversation_title(&current.id, &title)?;
            let mut c = current;
            c.title = title;
            Ok(c)
        } else {
            Ok(current)
        }
    }

    pub fn notify_read(&self, conv_id: &str, up_to_ts: i64) {
        use std::time::{SystemTime, UNIX_EPOCH};
        static LAST_SENT: std::sync::OnceLock<StdMutex<HashMap<String, u64>>> =
            std::sync::OnceLock::new();
        let map = LAST_SENT.get_or_init(|| StdMutex::new(HashMap::new()));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        {
            let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
            if m.get(conv_id).copied().unwrap_or(0) + 1000 > now {
                return;
            }
            m.insert(conv_id.to_string(), now);
        }
        let peers = self.social_peers_of(conv_id);
        for fp in peers {
            if self.peer_proto_v(&fp) < 4 {
                continue;
            }
            self.send_to_peer(
                fp,
                SecureFrame::Read {
                    conv_id: conv_id.to_string(),
                    up_to_ts,
                },
            );
        }
    }

    pub fn send_dm(&self, conv_id: &str, body: &str) -> Result<StoredMessage> {
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        // Seção 13: conv
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("conversa inexistente".into()))?;
        let env = MessageEnvelope::new(&self.keypair, conv_id, body);
        match conv.kind.as_str() {
            "dm" => {
                let is_friend = self
                    .store
                    .get_friend(&conv.peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false);
                if self.store.is_blocked_fp(&conv.peer_fp) {
                    return Err(DistorrentError::Protocol(
                        "peer bloqueado — desbloqueie para conversar".into(),
                    ));
                }
                // Sem amizade, a conversa é uma INTRODUÇÃO: no máximo três
                // mensagens por direção. O contador é consumido só depois de
                // a mensagem existir, para retry não queimar crédito.
                let intro = !is_friend;
                if intro
                    && !self.store.dm_intro_take(
                        conv_id,
                        &self.identity.fingerprint,
                        crate::social::DM_INTRO_LIMIT,
                    )?
                {
                    return Err(DistorrentError::Protocol(format!(
                        "limite de {} mensagens antes da amizade — envie uma solicitação para continuar",
                        crate::social::DM_INTRO_LIMIT
                    )));
                }
                if let Err(e) = self.store.insert_message(&env, "out", "sending") {
                    if intro {
                        let _ = self
                            .store
                            .dm_intro_refund(conv_id, &self.identity.fingerprint);
                    }
                    return Err(e);
                }
                crate::metrics::metrics().message_out();
                let online = self.link_tx(&conv.peer_fp).is_some();
                // Amigo ou introdução: os dois caminham pelo mesmo transporte.
                // A diferença é que a introdução só tem crédito finito.
                if online {
                    self.store.enqueue_outbox(&env.id, &conv.peer_fp)?;
                    if self
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            conv.peer_fp.clone(),
                            SecureFrame::Msg(env.clone()),
                        ))
                        .is_err()
                    {
                        self.store.set_message_status(&env.id, "pending")?;
                        let _ = self.events.send(EngineEvent::MessageStatus {
                            msg_id: env.id.clone(),
                            status: "pending".into(),
                        });
                        self.cmd_tx
                            .send(EngineCmd::ConnectRelay(conv.peer_fp.clone()))
                            .ok();
                        return self.store.message_by_id(&env.id)?.ok_or_else(|| {
                            DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows)
                        });
                    }
                    self.store.set_message_status(&env.id, "sent")?;
                    let _ = self.events.send(EngineEvent::MessageStatus {
                        msg_id: env.id.clone(),
                        status: "sent".into(),
                    });
                } else {
                    self.store.enqueue_outbox(&env.id, &conv.peer_fp)?;
                    self.store.set_message_status(&env.id, "pending")?;
                    let _ = self.events.send(EngineEvent::MessageStatus {
                        msg_id: env.id.clone(),
                        status: "pending".into(),
                    });
                    self.cmd_tx
                        .send(EngineCmd::ConnectRelay(conv.peer_fp.clone()))
                        .ok();
                }
            }
            "group" => {
                self.store.insert_message(&env, "out", "sending")?;
                crate::metrics::metrics().message_out();
                let me = self.identity.fingerprint.clone();
                let mut sent_any = false;
                for (fp, _) in self.store.list_group_members(conv_id)? {
                    if fp == me {
                        continue;
                    }
                    if self.link_tx(&fp).is_some() {
                        self.cmd_tx
                            .send(EngineCmd::SendToPeer(
                                fp.clone(),
                                SecureFrame::Msg(env.clone()),
                            ))
                            .ok();
                        sent_any = true;
                    } else {
                        self.cmd_tx.send(EngineCmd::ConnectRelay(fp)).ok();
                    }
                }
                let status = if sent_any { "sent" } else { "pending" };
                self.store.set_message_status(&env.id, status)?;
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: env.id.clone(),
                    status: status.into(),
                });
            }
            other => {
                return Err(DistorrentError::Protocol(format!(
                    "tipo de conversa desconhecido: {other}"
                )))
            }
        }
        self.store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn resend_message(self: &Arc<Self>, msg_id: &str) -> Result<StoredMessage> {
        let m = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if m.direction != "out" {
            return Err(DistorrentError::Protocol(
                "só dá para reenviar mensagem enviada por você".into(),
            ));
        }
        let conv = self
            .store
            .get_conversation(&m.conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("conversa inexistente".into()))?;
        let env = MessageEnvelope {
            id: m.id.clone(),
            conv_id: m.conv_id.clone(),
            author_fp: m.author_fp.clone(),
            body: m.body.clone(),
            ts: m.ts,
            sig: m.sig.clone(),
        };
        match conv.kind.as_str() {
            "dm" => {
                self.store.requeue_outbox(&m.id, &conv.peer_fp)?;
                self.store.set_message_status(&m.id, "pending")?;
                if self.link_tx(&conv.peer_fp).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            conv.peer_fp.clone(),
                            SecureFrame::Msg(env),
                        ))
                        .ok();
                    self.store.set_message_status(&m.id, "sent").ok();
                }
                self.cmd_tx
                    .send(EngineCmd::ConnectRelay(conv.peer_fp.clone()))
                    .ok();
                let status = self
                    .store
                    .message_by_id(&m.id)?
                    .map(|x| x.status)
                    .unwrap_or_else(|| "pending".into());
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: m.id.clone(),
                    status,
                });
            }
            "group" => {
                self.store.set_message_status(&m.id, "pending")?;
                let me = self.identity.fingerprint.clone();
                let mut sent_any = false;
                for (fp, _) in self.store.list_group_members(&m.conv_id)? {
                    if fp == me {
                        continue;
                    }
                    if self.link_tx(&fp).is_some() {
                        self.cmd_tx
                            .send(EngineCmd::SendToPeer(fp, SecureFrame::Msg(env.clone())))
                            .ok();
                        sent_any = true;
                    }
                }
                let status = if sent_any { "sent" } else { "pending" };
                self.store.set_message_status(&m.id, status)?;
                // Seção 14: _
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: m.id.clone(),
                    status: status.into(),
                });
            }
            other => {
                let mut achou = false;
                for (cid, _, owner) in self.store.list_communities().unwrap_or_default() {
                    if !self
                        .store
                        .list_channels(&cid)
                        .unwrap_or_default()
                        .iter()
                        .any(|(ch, _)| ch == &m.conv_id)
                    {
                        continue;
                    }
                    achou = true;
                    if owner == self.identity.fingerprint {
                        self.host_relay(&cid, &m.conv_id, &env, "")?;
                        self.store.set_message_status(&m.id, "sent")?;
                    } else if self.link_tx(&owner).is_some() {
                        self.cmd_tx
                            .send(EngineCmd::SendToPeer(
                                owner.clone(),
                                SecureFrame::ChannelMsg {
                                    community_id: cid.clone(),
                                    channel_id: m.conv_id.clone(),
                                    env: env.clone(),
                                    bot_id: String::new(),
                                },
                            ))
                            .ok();
                        self.store.set_message_status(&m.id, "sent")?;
                    } else {
                        self.store.requeue_outbox(&m.id, &owner)?;
                        self.store.set_message_status(&m.id, "pending")?;
                    }
                    break;
                }
                if !achou {
                    return Err(DistorrentError::Protocol(format!(
                        "reenvio não suportado para conversa do tipo {other}"
                    )));
                }
                let status = self
                    .store
                    .message_by_id(&m.id)?
                    .map(|x| x.status)
                    .unwrap_or_else(|| "sent".into());
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: m.id.clone(),
                    status,
                });
            }
        }
        self.store
            .message_by_id(&m.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    fn rand_hex(n: usize) -> String {
        use rand::RngCore;
        let mut buf = vec![0u8; n];
        rand::thread_rng().fill_bytes(&mut buf);
        hex::encode(buf)
    }

    fn normalize_channel_name(name: &str) -> String {
        name.trim().to_lowercase().replace(' ', "-")
    }

    fn require_owner(&self, community_id: &str) -> Result<()> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "apenas o dono pode alterar o servidor".into(),
            ));
        }
        Ok(())
    }

    fn spam_gate(&self, peer_fp: &str, body: &str) -> Result<()> {
        let now = crate::identity::now_ms();
        let eh_amigo = self
            .store
            .get_friend(peer_fp)
            .ok()
            .flatten()
            .map(|(_, s)| s == "accepted")
            .unwrap_or(false);
        let teto_flood = if eh_amigo { 40 } else { 10 };
        {
            let mut flood = self.spam_flood.lock().unwrap_or_else(|e| e.into_inner());
            let e = flood.entry(peer_fp.to_string()).or_insert((0, now));
            if now - e.1 > 10_000 {
                *e = (0, now);
            }
            e.0 += 1;
            if e.0 > teto_flood {
                drop(flood);
                let _ = self.store.bump_reputation(peer_fp, -5, false);
                crate::metrics::metrics().spam_rejected();
                return Err(DistorrentError::Protocol(format!(
                    "flood detectado: mensagem descartada (limite {teto_flood}/10s)"
                )));
            }
        }
        {
            let h = crate::antispam::DuplicateDetector::content_hash(peer_fp, body);
            let mut dup = self.spam_dup.lock().unwrap_or_else(|e| e.into_inner());
            let (mesma, n) = match dup.get(peer_fp) {
                Some((last_h, last_ts, reps)) => {
                    let igual = *last_h == h && now - *last_ts < 60_000;
                    (igual, if igual { reps + 1 } else { 1 })
                }
                None => (false, 1),
            };
            if mesma && n > 5 {
                drop(dup);
                let _ = self.store.bump_reputation(peer_fp, -2, false);
                crate::metrics::metrics().spam_rejected();
                return Err(DistorrentError::Protocol(
                    "mensagem repetida descartada (spam: 6+ cópias idênticas em 60s)".into(),
                ));
            }
            dup.insert(peer_fp.to_string(), (h, now, n));
        }
        if let crate::antispam::LinkVerdict::Malicious(d) = crate::antispam::check_links(body, &[])
        {
            let _ = d;
            let _ = self.store.bump_reputation(peer_fp, -8, false);
            return Err(DistorrentError::Protocol("link malicioso bloqueado".into()));
        }
        Ok(())
    }

    fn server_rules_gate(&self, community_id: &str, author_fp: &str, body: &str) -> Result<()> {
        let rules = self.store.get_server_rules(community_id)?;
        if rules.is_shadow_banned(author_fp) {
            return Err(DistorrentError::Protocol(
                "mensagem removida pela moderação".into(),
            ));
        }
        if let Some(reason) = crate::moderation::check_text_against_rules(body, &rules) {
            let _ = self.store.bump_reputation(author_fp, -3, false);
            return Err(DistorrentError::Protocol(reason));
        }
        Ok(())
    }

    fn validate_name_gate(
        kind: crate::names::NameKind,
        raw: &str,
        existing: &[String],
    ) -> Result<String> {
        // Seção 15: policy
        let policy = crate::names::NamePolicy::for_kind(kind);
        let check = crate::names::validate_name(kind, raw, existing, &policy);
        if check.ok {
            return Ok(check.normalized);
        }
        Err(DistorrentError::Protocol(format!(
            "nome inválido: {}",
            check.errors.first().cloned().unwrap_or_default()
        )))
    }

    pub fn community_state_payload(
        &self,
        community_id: &str,
        for_fp: Option<&str>,
    ) -> Result<SecureFrame> {
        let (id, name, owner_fp) = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        let channels = self.store.channel_rows(community_id)?;
        let roles = self.store.roles_list(community_id)?;
        let mut bots = self.store.bots_list(community_id)?;
        let members = self.store.list_members(community_id)?;
        let mut member_roles = Vec::with_capacity(members.len());
        for (fp, _, _) in &members {
            member_roles.push((fp.clone(), self.store.member_roles_list(community_id, fp)?));
        }
        let is_owner_target = for_fp.map(|f| f == owner_fp).unwrap_or(true);
        if !is_owner_target {
            for b in bots.iter_mut() {
                b.token = String::new();
                // Segredo de assinatura é credencial: quem não é dono não vê.
                b.webhook_secret = String::new();
            }
        }
        let (description, category, icon) = self.store.community_meta(&id).unwrap_or_default();
        let is_public = self.store.community_is_public(&id).unwrap_or(false);
        Ok(SecureFrame::CommunityState {
            community_id: id,
            name,
            owner_fp,
            channels,
            roles,
            bots,
            member_roles,
            members,
            description,
            category,
            icon,
            is_public,
        })
    }

    fn broadcast_community_state(&self, community_id: &str) {
        let members = match self.store.list_members(community_id) {
            Ok(m) => m,
            Err(_) => return,
        };
        for (fp, _, _) in members {
            if fp == self.identity.fingerprint {
                continue;
            }
            let frame = match self.community_state_payload(community_id, Some(&fp)) {
                Ok(f) => f,
                Err(e) => {
                    debug!("broadcast do estado falhou para {community_id}/{fp}: {e}");
                    continue;
                }
            };
            if self.link_tx(&fp).is_some() {
                self.cmd_tx.send(EngineCmd::SendToPeer(fp, frame)).ok();
            }
        }
    }

    pub fn channel_create(
        &self,
        community_id: &str,
        name: &str,
        topic: &str,
        category: &str,
        kind: &str,
    ) -> Result<ChannelMetaRow> {
        self.require_owner(community_id)?;
        let existing: Vec<String> = self
            .store
            .list_channels(community_id)?
            .into_iter()
            .map(|(_, n)| n)
            .collect();
        let valid = Self::validate_name_gate(
            crate::names::NameKind::Channel,
            &Self::normalize_channel_name(name),
            &existing,
        )?;
        if valid.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do canal não pode ser vazio".into(),
            ));
        }
        let kind = if kind.is_empty() { "text" } else { kind };
        if kind != "text" && kind != "voice" && kind != "video" {
            return Err(DistorrentError::Protocol(
                "tipo de canal inválido (text|voice|video)".into(),
            ));
        }
        let id = format!("{community_id}-ch-{}", Self::rand_hex(4));
        let position = self.store.channel_rows(community_id)?.len() as i64;
        let default_cat = match kind {
            "voice" => "CANAIS DE VOZ",
            "video" => "CANAIS DE VÍDEO",
            _ => "CANAIS DE TEXTO",
        };
        let row = ChannelMetaRow {
            id,
            name: valid,
            topic: topic.trim().to_string(),
            category: if category.trim().is_empty() {
                default_cat.into()
            } else {
                category.trim().to_string()
            },
            kind: kind.into(),
            position,
        };
        self.store.upsert_channel(community_id, &row)?;
        let _ = self.events.send(EngineEvent::ChannelCreated {
            community_id: community_id.into(),
            channel_id: row.id.clone(),
            name: row.name.clone(),
        });
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    pub fn channel_delete(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.delete_channel(community_id, channel_id)? == 0 {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.store.delete_messages_by_conv(channel_id)?;
        let _ = self.events.send(EngineEvent::ChannelDeleted {
            community_id: community_id.into(),
            channel_id: channel_id.into(),
        });
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn channel_rename(
        &self,
        community_id: &str,
        channel_id: &str,
        new_name: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        let others: Vec<String> = self
            .store
            .list_channels(community_id)?
            .into_iter()
            .filter(|(id, _)| id != channel_id)
            .map(|(_, n)| n)
            .collect();
        let valid = Self::validate_name_gate(
            crate::names::NameKind::Channel,
            &Self::normalize_channel_name(new_name),
            &others,
        )?;
        if valid.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do canal não pode ser vazio".into(),
            ));
        }
        if self
            .store
            .update_channel(community_id, channel_id, Some(&valid), None, None)?
            == 0
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    // Seção 16: channel_set_topic
    pub fn channel_set_topic(
        &self,
        community_id: &str,
        channel_id: &str,
        topic: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .update_channel(community_id, channel_id, None, Some(topic), None)?
            == 0
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn channel_set_category(
        &self,
        community_id: &str,
        channel_id: &str,
        category: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        let category = category.trim();
        if category.is_empty() {
            return Err(DistorrentError::Protocol(
                "categoria não pode ser vazia".into(),
            ));
        }
        if self
            .store
            .set_channel_category(community_id, channel_id, category)?
            == 0
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn channel_list(&self, community_id: &str) -> Result<Vec<ChannelMetaRow>> {
        self.store.channel_rows(community_id)
    }

    pub fn community_rename(&self, community_id: &str, name: &str) -> Result<()> {
        self.require_owner(community_id)?;
        let others: Vec<String> = self
            .store
            .list_communities()
            .unwrap_or_default()
            .into_iter()
            .filter(|(id, _, _)| id != community_id)
            .map(|(_, n, _)| n)
            .collect();
        let name = Self::validate_name_gate(crate::names::NameKind::Server, name, &others)?;
        if self.store.community_set_name(community_id, &name)? == 0 {
            return Err(DistorrentError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn role_create(
        &self,
        community_id: &str,
        name: &str,
        color: &str,
        permissions: i64,
        hoist: bool,
        mentionable: bool,
    ) -> Result<RoleRow> {
        self.require_owner(community_id)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do cargo não pode ser vazio".into(),
            ));
        }
        let row = RoleRow {
            id: format!("{community_id}-role-{}", Self::rand_hex(3)),
            community_id: community_id.to_string(),
            name: name.to_string(),
            color: if color.trim().is_empty() {
                "#949ba4".into()
            } else {
                color.trim().to_string()
            },
            permissions,
            hoist,
            mentionable,
            position: self.store.next_role_position(community_id)?,
        };
        self.store.role_upsert(&row)?;
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn role_update(
        &self,
        community_id: &str,
        role_id: &str,
        name: Option<&str>,
        color: Option<&str>,
        permissions: Option<i64>,
        hoist: Option<bool>,
        mentionable: Option<bool>,
        position: Option<i64>,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if !self.store.role_update_patch(
            community_id,
            role_id,
            name,
            color,
            permissions,
            hoist,
            mentionable,
            position,
        )? {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn role_delete(&self, community_id: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if role_id.ends_with("-everyone") {
            return Err(DistorrentError::Protocol(
                "@everyone não pode ser apagado".into(),
            ));
        }
        if self.store.role_delete(community_id, role_id)? == 0 {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn roles_list(&self, community_id: &str) -> Result<Vec<RoleRow>> {
        self.store.roles_list(community_id)
    }

    pub fn member_roles(&self, community_id: &str, fp: &str) -> Result<Vec<String>> {
        self.store.member_roles_list(community_id, fp)
    }

    pub fn member_assign_role(&self, community_id: &str, fp: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if !self
            .store
            .roles_list(community_id)?
            .iter()
            .any(|r| r.id == role_id)
        {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        if self
            .store
            .list_members(community_id)?
            .iter()
            .all(|(m, _, _)| m != fp)
        {
            return Err(DistorrentError::Protocol("membro inexistente".into()));
        }
        self.store.member_role_assign(community_id, fp, role_id)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    // Seção 17: member_unassign_role
    pub fn member_unassign_role(&self, community_id: &str, fp: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if !self
            .store
            .roles_list(community_id)?
            .iter()
            .any(|r| r.id == role_id)
        {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        self.store.member_role_unassign(community_id, fp, role_id)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn member_kick(&self, community_id: &str, fp: &str) -> Result<()> {
        self.require_owner(community_id)?;
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if fp == comm.2 {
            return Err(DistorrentError::Protocol(
                "o dono não pode ser expulso".into(),
            ));
        }
        if self
            .store
            .list_members(community_id)?
            .iter()
            .all(|(m, _, _)| m != fp)
        {
            return Err(DistorrentError::Protocol("membro inexistente".into()));
        }
        self.store.remove_member(community_id, fp)?;
        self.store.member_roles_remove_all(community_id, fp)?;
        let _ = self.events.send(EngineEvent::MemberLeft {
            community_id: community_id.into(),
            fp: fp.into(),
            nickname: String::new(),
        });
        if self.link_tx(fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp.to_string(),
                    SecureFrame::CommunityKicked {
                        community_id: community_id.to_string(),
                    },
                ))
                .ok();
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn server_rules_get(&self, community_id: &str) -> Result<crate::moderation::ServerRules> {
        self.store.get_server_rules(community_id)
    }

    pub fn server_rules_set(&self, mut rules: crate::moderation::ServerRules) -> Result<()> {
        self.require_owner(&rules.community_id)?;
        rules.spam_level = match rules.spam_level.as_str() {
            "low" | "high" => rules.spam_level.clone(),
            _ => "medium".into(),
        };
        let clean_list = |xs: Vec<String>| -> Vec<String> {
            xs.into_iter()
                .map(|w| crate::names::sanitize_text(&w, 64).to_lowercase())
                .filter(|w| !w.is_empty())
                .take(200)
                .collect()
        };
        rules.banned_words = clean_list(rules.banned_words);
        rules.blocked_domains = clean_list(rules.blocked_domains);
        rules.moderators = rules.moderators.into_iter().take(50).collect();
        rules.shadow_banned = rules.shadow_banned.into_iter().take(500).collect();
        self.store.set_server_rules(&rules)?;
        let audit = crate::moderation::AuditEntry::new(
            &rules.community_id,
            &self.identity.fingerprint,
            "rules",
            "",
            "regras atualizadas",
        );
        self.store.append_audit(&audit)?;
        Ok(())
    }

    pub fn audit_list(
        &self,
        community_id: &str,
        limit: i64,
    ) -> Result<Vec<crate::moderation::AuditEntry>> {
        self.store.list_audit(community_id, limit)
    }

    pub fn reputation_get(&self, fp: &str) -> Result<(String, i32, u32)> {
        self.store.get_reputation(fp)
    }

    pub fn safety_number(&self, peer_fp: &str) -> Result<String> {
        let me = &self.identity;
        let peer = self
            .store
            .get_peer(peer_fp)?
            .ok_or_else(|| DistorrentError::Protocol("peer desconhecido".into()))?;
        Ok(crate::names::safety_number(
            &me.fingerprint,
            &me.pubkey_hex,
            peer_fp,
            &peer.pubkey_hex,
        ))
    }

    pub fn moderate(
        &self,
        community_id: &str,
        action: &str,
        target: &str,
        reason: &str,
    ) -> Result<()> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        let me = self.identity.fingerprint.clone();
        let is_owner = comm.2 == me;
        let rules = self.store.get_server_rules(community_id)?;
        let is_mod = rules.moderators.iter().any(|m| m == &me);
        let my_roles = self.store.member_roles_list(community_id, &me)?;
        let mut role_perms: i64 = 0;
        if !my_roles.is_empty() {
            if let Ok(all) = self.store.roles_list(community_id) {
                for r in all {
                    if my_roles.iter().any(|rid| rid == &r.id) {
                        role_perms |= r.permissions;
                    }
                }
            }
        }
        if target == comm.2 || target == me {
            return Err(DistorrentError::Protocol(
                "alvo inválido para moderação".into(),
            ));
        }
        let need = match action {
            "ban" | "unban" | "shadow_ban" | "unshadow" => crate::moderation::PERM_BAN,
            "mute" | "unmute" => crate::moderation::PERM_MUTE,
            "delete_msg" => crate::moderation::PERM_DELETE,
            _ => return Err(DistorrentError::Protocol("ação inválida".into())),
        };
        if !crate::moderation::can_moderate(is_owner, is_mod, role_perms, need) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        match action {
            "ban" => {
                self.store.set_reputation(
                    target,
                    "banned",
                    -100,
                    self.store.get_reputation(target)?.2,
                )?;
                self.store.remove_member(community_id, target).ok();
                if self.link_tx(target).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            target.to_string(),
                            SecureFrame::CommunityKicked {
                                community_id: community_id.to_string(),
                            },
                        ))
                        .ok();
                }
            }
            "unban" => {
                self.store.set_reputation(
                    target,
                    "new",
                    0,
                    self.store.get_reputation(target)?.2,
                )?;
            }
            "mute" => {
                // Seção 18: until
                let until = match reason.trim().parse::<i64>() {
                    Ok(ms) if ms > crate::identity::now_ms() => ms,
                    _ => crate::identity::now_ms() + MUTE_DEFAULT_MS,
                };
                self.store.mute_set(target, until)?;
                self.store.bump_reputation(target, -15, false)?;
            }
            "unmute" => {
                self.store.mute_set(target, 0)?;
                let (_, score, reports) = self.store.get_reputation(target)?;
                if score < 0 {
                    self.store.set_reputation(target, "new", 0, reports)?;
                }
            }
            "shadow_ban" => {
                let mut r = rules.clone();
                if !r.shadow_banned.iter().any(|x| x == target) {
                    r.shadow_banned.push(target.to_string());
                    self.store.set_server_rules(&r)?;
                }
            }
            "unshadow" => {
                let mut r = rules.clone();
                r.shadow_banned.retain(|x| x != target);
                self.store.set_server_rules(&r)?;
            }
            "delete_msg" => {
                let msg = self
                    .store
                    .message_by_id_raw(target)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                let owner_cid = self.store.channel_community(&msg.conv_id)?.ok_or_else(|| {
                    DistorrentError::Protocol("mensagem fora deste servidor".into())
                })?;
                if owner_cid != community_id {
                    return Err(DistorrentError::Protocol(
                        "mensagem fora deste servidor".into(),
                    ));
                }
                self.store.delete_message_by_id(target)?;
            }
            _ => unreachable!(),
        }
        let audit = crate::moderation::AuditEntry::new(community_id, &me, action, target, reason);
        self.store.append_audit(&audit)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn report_user(&self, target_fp: &str, community_id: &str, reason: &str) -> Result<()> {
        if target_fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "não é possível denunciar a si mesmo".into(),
            ));
        }
        let id = format!("rep-{}", Self::rand_hex(8));
        self.store.file_report(
            &id,
            &self.identity.fingerprint,
            target_fp,
            community_id,
            reason,
        )?;
        let open = self.store.open_reports_for(target_fp)?.len() as u32;
        let (_, score, _) = self.store.bump_reputation(target_fp, -10, true)?;
        let _ = (open, score);
        let audit = crate::moderation::AuditEntry::new(
            community_id,
            &self.identity.fingerprint,
            "report",
            target_fp,
            reason,
        );
        if self
            .store
            .get_community(community_id)
            .ok()
            .flatten()
            .is_some()
        {
            self.store.append_audit(&audit)?;
        }
        Ok(())
    }

    pub fn bot_create(
        &self,
        community_id: &str,
        name: &str,
        avatar: Option<&str>,
        role_id: Option<&str>,
    ) -> Result<BotRow> {
        self.require_owner(community_id)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do bot não pode ser vazio".into(),
            ));
        }
        let role_id = match role_id.map(str::trim) {
            Some("") | None => None,
            Some(r) => {
                let exists = self
                    .store
                    .roles_list(community_id)
                    .map(|rs| rs.iter().any(|x| x.id == r))
                    .unwrap_or(false);
                if !exists {
                    return Err(DistorrentError::Protocol(format!(
                        "cargo {r} não existe nesta comunidade"
                    )));
                }
                Some(r.to_string())
            }
        };
        let discriminator: String = {
            use rand::Rng;
            format!("{:04}", rand::thread_rng().gen_range(0..10000))
        };
        let row = BotRow {
            id: format!("{community_id}-bot-{}", Self::rand_hex(6)),
            community_id: community_id.to_string(),
            name: name.to_string(),
            discriminator,
            avatar: avatar
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .unwrap_or("🤖")
                .to_string(),
            role_id,
            token: format!("bot_{}_{}", Self::rand_hex(12), Self::rand_hex(4)),
            online: true,
            owner_fp: self.identity.fingerprint.clone(),
            created_at: crate::identity::now_ms(),
            config: String::new(),
            perms: 0,
            webhook_secret: String::new(),
        };
        self.store.bot_upsert(&row)?;
        let _ = self.events.send(EngineEvent::BotCreated {
            community_id: community_id.into(),
            bot_id: row.id.clone(),
        });
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    pub fn bot_update(&self, community_id: &str, bot_id: &str, patch: BotPatch) -> Result<()> {
        self.require_owner(community_id)?;
        if !self.store.bot_update_patch(community_id, bot_id, &patch)? {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn bot_delete(&self, community_id: &str, bot_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.bot_delete(community_id, bot_id)? == 0 {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    // Seção 19: bots_list
    pub fn bots_list(&self, community_id: &str) -> Result<Vec<BotRow>> {
        self.store.bots_list(community_id)
    }

    pub fn bot_regen_token(&self, community_id: &str, bot_id: &str) -> Result<String> {
        self.require_owner(community_id)?;
        let all = self.store.bots_list(community_id)?;
        let Some(mut b) = all.into_iter().find(|x| x.id == bot_id) else {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        };
        b.token = format!("bot_{}_{}", Self::rand_hex(12), Self::rand_hex(4));
        self.store.bot_upsert(&b)?;
        self.broadcast_community_state(community_id);
        Ok(b.token)
    }

    pub fn bot_post_message(
        &self,
        community_id: &str,
        channel_id: &str,
        bot_id: &str,
        body: &str,
    ) -> Result<crate::storage::StoredMessage> {
        self.require_owner(community_id)?;
        let bot_id = bot_id.trim();
        if bot_id.is_empty() {
            return Err(DistorrentError::Protocol("bot_id vazio".into()));
        }
        if !self
            .store
            .bots_list(community_id)?
            .iter()
            .any(|b| b.id == bot_id)
        {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        if !self
            .store
            .list_channels(community_id)?
            .iter()
            .any(|(id, _)| id == channel_id)
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        if let Some(b) = self
            .store
            .bots_list(community_id)?
            .into_iter()
            .find(|x| x.id == bot_id)
        {
            if !b.online {
                return Err(DistorrentError::Protocol(
                    "bot está offline — ative-o no painel".into(),
                ));
            }
        }
        let env = MessageEnvelope::new(&self.keypair, channel_id, body);
        self.store
            .insert_message_as_bot(&env, "out", "sending", bot_id)?;
        crate::metrics::metrics().message_out();
        self.host_relay(community_id, channel_id, &env, bot_id)?;
        self.store.set_message_status(&env.id, "sent")?;
        self.store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    /// Executa uma ação administrativa em nome de um bot.
    ///
    /// A autorização é conferida AQUI, não na UI: o bot precisa existir, estar
    /// online e ter a permissão específica que o dono concedeu. Um bot nunca
    /// alcança o dono do servidor nem age além do que lhe foi dado, e toda
    /// ação vira audit log com o `bot_id` como autor.
    pub fn bot_admin(
        &self,
        community_id: &str,
        bot_id: &str,
        action: &str,
        target: &str,
        reason: &str,
        number: Option<i64>,
    ) -> Result<String> {
        self.bot_action_in(community_id, bot_id, action, target, reason, number, None)
    }

    /// Igual a [`Self::bot_admin`], mas com o canal de contexto. Ações que
    /// dependem de canal (`poll_create`, `thread_create`, `typing`) usam este
    /// valor; sem ele, caem no primeiro canal de texto do servidor.
    #[allow(clippy::too_many_arguments)]
    pub fn bot_action_in(
        &self,
        community_id: &str,
        bot_id: &str,
        action: &str,
        target: &str,
        reason: &str,
        number: Option<i64>,
        channel: Option<&str>,
    ) -> Result<String> {
        self.require_owner(community_id)?;
        let Some(bot) = self
            .store
            .bots_list(community_id)?
            .into_iter()
            .find(|b| b.id == bot_id)
        else {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        };
        if !bot.online {
            return Err(DistorrentError::Protocol(
                "bot está offline — ative-o no painel".into(),
            ));
        }
        let need = crate::moderation::perm_for_action(action)
            .ok_or_else(|| DistorrentError::Protocol(format!("ação inválida: {action}")))?;
        if !crate::moderation::perm_satisfied(bot.perms, need) {
            return Err(DistorrentError::Protocol(format!(
                "o bot não tem permissão para `{action}` — conceda no painel de Bots"
            )));
        }
        let (_, name, owner) = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        let target = target.trim();
        let reason = crate::names::sanitize_text(reason.trim(), 280);
        let needs_target = matches!(
            action,
            "ban"
                | "unban"
                | "kick"
                | "mute"
                | "unmute"
                | "warn"
                | "warnings"
                | "warnings_clear"
                | "userinfo"
        );
        if needs_target && target.is_empty() {
            return Err(DistorrentError::Protocol("informe o membro alvo".into()));
        }
        let resolved = if target.is_empty() {
            None
        } else {
            self.resolve_member(community_id, target)
        };
        if needs_target {
            let Some(fp) = resolved.clone() else {
                return Err(DistorrentError::Protocol(format!(
                    "membro `{target}` não encontrado neste servidor"
                )));
            };
            if fp == owner {
                return Err(DistorrentError::Protocol(
                    "o dono do servidor não pode ser alvo de moderação".into(),
                ));
            }
        }
        let fp = resolved.unwrap_or_else(|| target.to_string());
        // Leitura não suja a auditoria: só o que muda estado vira registro.
        if !matches!(
            action,
            "userinfo"
                | "serverinfo"
                | "ping"
                | "audit"
                | "bans"
                | "timeouts"
                | "channels"
                | "roles"
        ) {
            self.store
                .append_audit(&crate::moderation::AuditEntry::new(
                    community_id,
                    &bot.id,
                    &format!("bot:{action}"),
                    &fp,
                    &reason,
                ))?;
        }
        match action {
            "ban" => {
                let until = number.unwrap_or(0).max(0);
                self.store
                    .ban_set(community_id, &fp, &reason, &bot.id, until)?;
                self.store.remove_member(community_id, &fp).ok();
                self.store.member_roles_remove_all(community_id, &fp)?;
                if self.link_tx(&fp).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp.clone(),
                            SecureFrame::CommunityKicked {
                                community_id: community_id.to_string(),
                            },
                        ))
                        .ok();
                }
                self.emit_moderation(community_id, &fp, "ban", until, &reason);
                self.broadcast_community_state(community_id);
                Ok(format!("{fp} foi banido do servidor"))
            }
            "unban" => {
                self.store.ban_remove(community_id, &fp)?;
                Ok(format!("{fp} não está mais banido"))
            }
            "kick" => {
                if self
                    .store
                    .list_members(community_id)?
                    .iter()
                    .all(|(m, _, _)| m != &fp)
                {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                }
                self.store.remove_member(community_id, &fp)?;
                self.store.member_roles_remove_all(community_id, &fp)?;
                if self.link_tx(&fp).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp.clone(),
                            SecureFrame::CommunityKicked {
                                community_id: community_id.to_string(),
                            },
                        ))
                        .ok();
                }
                self.emit_moderation(community_id, &fp, "kick", 0, &reason);
                self.broadcast_community_state(community_id);
                Ok(format!("{fp} foi expulso do servidor"))
            }
            "mute" => {
                let mins = number.unwrap_or(10).clamp(1, 10_080);
                let until = crate::identity::now_ms() + mins * 60_000;
                self.store
                    .timeout_set(community_id, &fp, until, &reason, &bot.id)?;
                self.emit_moderation(community_id, &fp, "mute", until, &reason);
                Ok(format!("{fp} silenciado por {mins} min"))
            }
            "unmute" => {
                self.store.timeout_clear(community_id, &fp)?;
                self.emit_moderation(community_id, &fp, "unmute", 0, &reason);
                Ok(format!("{fp} pode falar de novo"))
            }
            "warn" => {
                self.store.warn_add(community_id, &fp, &reason, &bot.id)?;
                let total = self.store.warnings_for(community_id, &fp)?.len();
                Ok(format!("{fp} recebeu um aviso — total: {total}"))
            }
            "warnings" => {
                let list = self.store.warnings_for(community_id, &fp)?;
                if list.is_empty() {
                    return Ok(format!("{fp} não tem avisos ativos"));
                }
                let mut out = format!("{fp}: {} aviso(s)", list.len());
                for w in list.iter().take(5) {
                    out.push_str(&format!(
                        "\n• {}",
                        if w.reason.is_empty() {
                            "(sem motivo)"
                        } else {
                            &w.reason
                        }
                    ));
                }
                Ok(out)
            }
            "clear" => {
                let n = number.unwrap_or(10).clamp(1, 100);
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let ids = self.store.recent_message_ids(&conv, n)?;
                let mut removed = 0usize;
                for id in ids {
                    if self.social_delete(&conv, &id).is_ok() {
                        removed += 1;
                    }
                }
                Ok(format!("{removed} mensagem(ns) apagada(s) em {conv}"))
            }
            "lock" | "unlock" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let slow = self.store.channel_cfg_slowmode(&conv).unwrap_or(0);
                self.store
                    .channel_cfg_set(&conv, slow, false, action == "lock")?;
                Ok(if action == "lock" {
                    format!("canal {conv} trancado")
                } else {
                    format!("canal {conv} destrancado")
                })
            }
            "slowmode" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let secs = number.unwrap_or(0).clamp(0, 21_600);
                self.store.channel_cfg_set(&conv, secs, false, false)?;
                Ok(if secs == 0 {
                    format!("slowmode desligado em {conv}")
                } else {
                    format!("slowmode de {secs}s em {conv}")
                })
            }
            "channel_create" => {
                let name = target;
                if name.trim().is_empty() {
                    return Err(DistorrentError::Protocol(
                        "informe o nome do canal (ex.: `avisos`)".into(),
                    ));
                }
                let kind = if reason.trim().is_empty() {
                    "text"
                } else {
                    reason.trim()
                };
                let row = self.channel_create(community_id, name, "", "", kind)?;
                Ok(format!("canal #{} criado", row.name))
            }
            "channel_delete" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                self.channel_delete(community_id, &conv)?;
                Ok(format!("canal {conv} excluído"))
            }
            "role_create" => {
                let name = target;
                if name.trim().is_empty() {
                    return Err(DistorrentError::Protocol("informe o nome do cargo".into()));
                }
                // Cor vem em `reason` (opcional, formato #RRGGBB).
                let color = if reason.trim().starts_with('#') {
                    reason.trim()
                } else {
                    ""
                };
                let row = self.role_create(community_id, name, color, 0, false, true)?;
                Ok(format!("cargo {} criado", row.name))
            }
            "role_delete" => {
                let raw = target.trim();
                if raw.is_empty() {
                    return Err(DistorrentError::Protocol("informe o cargo".into()));
                }
                let role_id = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == raw || r.name.eq_ignore_ascii_case(raw))
                    .map(|r| r.id)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{raw}` não existe"))
                    })?;
                self.role_delete(community_id, &role_id)?;
                Ok(format!("cargo {raw} excluído"))
            }
            "role_assign" => {
                // `target` = cargo, `reason` = membro. Assim o mesmo comando
                // serve para dar e tirar e o alvo é explícito.
                let role_raw = target.trim();
                let member_raw = reason.trim();
                if role_raw.is_empty() || member_raw.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /role_assign <cargo> <membro>".into(),
                    ));
                }
                let role_id = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == role_raw || r.name.eq_ignore_ascii_case(role_raw))
                    .map(|r| r.id)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{role_raw}` não existe"))
                    })?;
                // O bot só distribui o poder que ele próprio tem: um cargo com
                // `ban`/`mute` criado pelo dono não pode ser dado por um bot que
                // só recebeu `manage`, senão ele escala moderação de lado.
                let role_perms = self
                    .store
                    .roles_list(community_id)?
                    .iter()
                    .find(|r| r.id == role_id)
                    .map(|r| r.permissions)
                    .unwrap_or(0);
                if !crate::moderation::perm_can_grant(bot.perms, role_perms) {
                    return Err(DistorrentError::Protocol(
                        "o bot não pode dar um cargo com permissões que ele não tem".into(),
                    ));
                }
                let Some(member) = self.resolve_member(community_id, member_raw) else {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                };
                if self
                    .store
                    .list_members(community_id)?
                    .iter()
                    .all(|(m, _, _)| m != &member)
                {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                }
                self.member_assign_role(community_id, &member, &role_id)?;
                Ok(format!("cargo {role_raw} dado a {member}"))
            }
            "role_unassign" => {
                let role_raw = target.trim();
                let member_raw = reason.trim();
                if role_raw.is_empty() || member_raw.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /role_unassign <cargo> <membro>".into(),
                    ));
                }
                let role_id = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == role_raw || r.name.eq_ignore_ascii_case(role_raw))
                    .map(|r| r.id)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{role_raw}` não existe"))
                    })?;
                let Some(member) = self.resolve_member(community_id, member_raw) else {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                };
                self.member_unassign_role(community_id, &member, &role_id)?;
                Ok(format!("cargo {role_raw} removido de {member}"))
            }
            "channel_edit" => {
                // `target` = canal, `reason` = novo nome.
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let new_name = reason.trim();
                if new_name.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /channel_edit <canal> <novo-nome>".into(),
                    ));
                }
                self.channel_rename(community_id, &conv, new_name)?;
                Ok(format!("canal {conv} renomeado para {new_name}"))
            }
            "server_edit" => {
                if target.trim().is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /server_edit <novo-nome>".into(),
                    ));
                }
                self.community_rename(community_id, target)?;
                Ok(format!("servidor renomeado para {}", target.trim()))
            }
            "userinfo" => {
                let (mfp, nick, role) = self
                    .store
                    .list_members(community_id)?
                    .into_iter()
                    .find(|(m, _, _)| m == &fp)
                    .ok_or_else(|| DistorrentError::Protocol("membro inexistente".into()))?;
                let role_ids = self.store.member_roles_list(community_id, &mfp)?;
                let names: Vec<String> = self
                    .store
                    .roles_list(community_id)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|r| role_ids.iter().any(|id| id == &r.id))
                    .map(|r| r.name)
                    .collect();
                let warns = self.store.warnings_for(community_id, &mfp)?.len();
                Ok(format!(
                    "**{nick}** (`{mfp}`)\nfunção: {role}\ncargos: {}\navisos: {warns}",
                    if names.is_empty() {
                        "nenhum".to_string()
                    } else {
                        names.join(", ")
                    }
                ))
            }
            "serverinfo" => {
                let channels = self.store.channel_rows(community_id)?.len();
                let members = self.store.list_members(community_id)?.len();
                let roles = self.store.roles_list(community_id)?.len();
                let bots = self.store.bots_list(community_id)?.len();
                let public = self.store.community_is_public(community_id)?;
                Ok(format!(
                    "**{name}**\ndono: {owner}\ncanais: {channels}\nmembros: {members}\ncargos: {roles}\nbots: {bots}\nentrada: {}",
                    if public { "pública" } else { "por convite" }
                ))
            }
            "ping" => Ok("pong".to_string()),
            "audit" => {
                let n = number.unwrap_or(10).clamp(1, 50);
                let rows = self.store.list_audit(community_id, n)?;
                if rows.is_empty() {
                    return Ok("auditoria vazia".into());
                }
                let mut out = format!("{} ação(ões) recentes:", rows.len());
                for a in rows.iter().take(n as usize) {
                    out.push_str(&format!(
                        "\n• {} → {} ({})",
                        a.action,
                        if a.target_fp.is_empty() {
                            "—"
                        } else {
                            &a.target_fp
                        },
                        if a.reason.is_empty() {
                            "sem motivo"
                        } else {
                            &a.reason
                        }
                    ));
                }
                Ok(out)
            }
            "bans" => {
                let rows = self.store.ban_list(community_id)?;
                if rows.is_empty() {
                    return Ok("ninguém está banido".into());
                }
                let mut out = format!("{} banido(s):", rows.len());
                for b in rows.iter().take(20) {
                    out.push_str(&format!("\n• {}", b.fp));
                }
                Ok(out)
            }
            "timeouts" => {
                let rows = self.store.timeout_list(community_id)?;
                if rows.is_empty() {
                    return Ok("ninguém está silenciado".into());
                }
                let mut out = format!("{} silenciado(s):", rows.len());
                for b in rows.iter().take(20) {
                    out.push_str(&format!("\n• {}", b.fp));
                }
                Ok(out)
            }
            "channels" => {
                let rows = self.store.channel_rows(community_id)?;
                let mut out = format!("{} canal(is):", rows.len());
                for c in rows.iter().take(60) {
                    out.push_str(&format!("\n• #{} ({})", c.name, c.kind));
                }
                Ok(out)
            }
            "roles" => {
                let rows = self.store.roles_list(community_id)?;
                let mut out = format!("{} cargo(s):", rows.len());
                for r in rows.iter().take(60) {
                    out.push_str(&format!("\n• {} {}", r.name, r.color));
                }
                Ok(out)
            }
            "warnings_clear" => {
                let n = self.store.warnings_clear(community_id, &fp)?;
                Ok(format!("{n} aviso(s) removido(s) de {fp}"))
            }
            "delete_msg" => {
                let msg_id = target.trim();
                if msg_id.is_empty() {
                    return Err(DistorrentError::Protocol("informe o id da mensagem".into()));
                }
                let alvo = self
                    .store
                    .message_by_id(msg_id)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                self.social_delete(&alvo.conv_id, msg_id)?;
                Ok(format!("mensagem {msg_id} apagada"))
            }
            "react" => {
                let msg_id = target.trim();
                let emoji = reason.trim();
                if msg_id.is_empty() || emoji.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /react <id-da-mensagem> <emoji>".into(),
                    ));
                }
                let alvo = self
                    .store
                    .message_by_id(msg_id)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                let added = self.social_react(&alvo.conv_id, msg_id, emoji)?;
                Ok(format!(
                    "reação {emoji} {} em {msg_id}",
                    if added { "adicionada" } else { "removida" }
                ))
            }
            "pin" | "unpin" => {
                let msg_id = target.trim();
                if msg_id.is_empty() {
                    return Err(DistorrentError::Protocol("informe o id da mensagem".into()));
                }
                let alvo = self
                    .store
                    .message_by_id(msg_id)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                let pinned = action == "pin";
                self.social_pin(&alvo.conv_id, msg_id, pinned)?;
                Ok(format!(
                    "mensagem {msg_id} {}",
                    if pinned { "fixada" } else { "desafixada" }
                ))
            }
            "channel_topic" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                self.channel_set_topic(community_id, &conv, reason.trim())?;
                Ok(format!("tópico de {conv} atualizado"))
            }
            "channel_category" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                if reason.trim().is_empty() {
                    return Err(DistorrentError::Protocol("informe a categoria".into()));
                }
                self.channel_set_category(community_id, &conv, reason.trim())?;
                Ok(format!("categoria de {conv} agora é {}", reason.trim()))
            }
            "role_edit" => {
                let raw = target.trim();
                if raw.is_empty() {
                    return Err(DistorrentError::Protocol("informe o cargo".into()));
                }
                let role = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == raw || r.name.eq_ignore_ascii_case(raw))
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{raw}` não existe"))
                    })?;
                // Cor é o token `#RRGGBB`; o resto (se houver) é o novo nome.
                let mut new_name = String::new();
                let mut new_color = String::new();
                for tok in reason.split_whitespace() {
                    if tok.starts_with('#') && tok.len() == 7 {
                        new_color = tok.to_string();
                    } else {
                        if !new_name.is_empty() {
                            new_name.push(' ');
                        }
                        new_name.push_str(tok);
                    }
                }
                self.role_update(
                    community_id,
                    &role.id,
                    if new_name.is_empty() {
                        None
                    } else {
                        Some(new_name.as_str())
                    },
                    if new_color.is_empty() {
                        None
                    } else {
                        Some(new_color.as_str())
                    },
                    None,
                    None,
                    None,
                    None,
                )?;
                Ok(format!("cargo {} atualizado", role.name))
            }
            "server_meta" => {
                let desc = target.trim();
                self.community_set_meta(community_id, Some(desc), None, None)?;
                Ok("descrição do servidor atualizada".to_string())
            }
            "server_public" => {
                let on = matches!(
                    target.trim().to_ascii_lowercase().as_str(),
                    "on" | "1" | "true" | "sim" | "publico" | "público"
                );
                self.community_set_public(community_id, on)?;
                Ok(if on {
                    "entrada pública ligada".to_string()
                } else {
                    "entrada pública desligada".to_string()
                })
            }
            "make_invite" => {
                let horas = number.unwrap_or(24).clamp(1, 24 * 30);
                let alvo = if target.trim().is_empty() {
                    "000000000000".to_string()
                } else {
                    self.resolve_member(community_id, target).ok_or_else(|| {
                        DistorrentError::Protocol(format!(
                            "membro `{target}` não encontrado neste servidor"
                        ))
                    })?
                };
                let token = self.make_invite(community_id, &alvo, horas * 3_600_000)?;
                Ok(format!("convite válido por {horas}h: {token}"))
            }
            "thread_create" => {
                let Some(parent) = self.resolve_channel(community_id, channel.unwrap_or("")) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal onde a thread nasce".into(),
                    ));
                };
                let nome = target.trim();
                if nome.is_empty() {
                    return Err(DistorrentError::Protocol("informe o nome da thread".into()));
                }
                let t = self.social_thread_create(
                    community_id,
                    &parent,
                    nome,
                    "thread",
                    reason.trim(),
                )?;
                Ok(format!("thread {} criada em {parent}", t.name))
            }
            "thread_archive" => {
                let id = target.trim();
                if id.is_empty() {
                    return Err(DistorrentError::Protocol("informe o id da thread".into()));
                }
                let archived = !matches!(
                    reason.trim().to_ascii_lowercase().as_str(),
                    "off" | "0" | "false" | "nao" | "não" | "abrir"
                );
                self.social_thread_archive(id, archived)?;
                Ok(format!(
                    "thread {id} {}",
                    if archived { "arquivada" } else { "reaberta" }
                ))
            }
            "poll_create" => {
                let Some(conv) = self.resolve_channel(community_id, channel.unwrap_or("")) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal da enquete".into(),
                    ));
                };
                let question = target.trim();
                let options: Vec<String> = reason
                    .split('|')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if question.is_empty() || options.len() < 2 {
                    return Err(DistorrentError::Protocol(
                        "uso: /poll <pergunta> | <opção> | <opção>".into(),
                    ));
                }
                let p = self.social_poll_create(
                    community_id,
                    &conv,
                    question,
                    options,
                    false,
                    crate::identity::now_ms() + 24 * 3_600_000,
                )?;
                Ok(format!("enquete criada: {}", p.question))
            }
            "emoji_add" => {
                let nome = target.trim();
                let ch = reason.trim();
                if nome.is_empty() || ch.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /emoji_add <nome> <emoji>".into(),
                    ));
                }
                let id = format!("em_{}", crate::bots::random_secret(6));
                self.social_emoji_upsert(crate::social::EmojiRow {
                    id,
                    community_id: community_id.into(),
                    name: nome.into(),
                    char: ch.into(),
                    created_at: crate::identity::now_ms(),
                })?;
                Ok(format!("emoji :{nome}: adicionado"))
            }
            "emoji_del" => {
                let nome = target.trim();
                if nome.is_empty() {
                    return Err(DistorrentError::Protocol("informe o nome do emoji".into()));
                }
                let row = self
                    .store
                    .emoji_list(community_id)?
                    .into_iter()
                    .find(|e| e.id == nome || e.name.eq_ignore_ascii_case(nome))
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("emoji `{nome}` não existe"))
                    })?;
                self.social_emoji_delete(community_id, &row.id)?;
                Ok(format!("emoji :{}: removido", row.name))
            }
            "typing" => {
                let Some(conv) = self.resolve_channel(community_id, channel.unwrap_or("")) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal para o \"digitando\"".into(),
                    ));
                };
                self.social_typing(&conv)?;
                Ok("digitando…".to_string())
            }
            other => Err(DistorrentError::Protocol(format!("ação inválida: {other}"))),
        }
    }

    /// Resolve `fp`, `<@fp>` ou apelido para o fingerprint de um membro.
    pub fn resolve_member(&self, community_id: &str, raw: &str) -> Option<String> {
        let t = raw.trim();
        if t.is_empty() {
            return None;
        }
        let t = t
            .strip_prefix("<@")
            .and_then(|s| s.strip_suffix('>'))
            .unwrap_or(t);
        if let Ok(members) = self.store.list_members(community_id) {
            if let Some((fp, _, _)) = members.iter().find(|(fp, _, _)| fp == t) {
                return Some(fp.clone());
            }
            let lower = t.to_lowercase();
            if let Some((fp, _, _)) = members
                .iter()
                .find(|(_, nick, _)| nick.to_lowercase() == lower)
            {
                return Some(fp.clone());
            }
        }
        Some(t.to_string())
    }

    /// Resolve `#nome`, id de canal ou o primeiro canal de texto quando vazio.
    pub fn resolve_channel(&self, community_id: &str, raw: &str) -> Option<String> {
        let t = raw.trim().trim_start_matches('#');
        let channels = self.store.channel_rows(community_id).ok()?;
        if t.is_empty() {
            return channels
                .iter()
                .find(|c| c.kind == "text")
                .map(|c| c.id.clone());
        }
        channels
            .iter()
            .find(|c| c.id == t || c.name.eq_ignore_ascii_case(t))
            .map(|c| c.id.clone())
    }

    fn emit_moderation(
        &self,
        community_id: &str,
        target: &str,
        kind: &str,
        until_ms: i64,
        reason: &str,
    ) {
        let _ = self.events.send(EngineEvent::ModerationApplied {
            community_id: community_id.into(),
            target_fp: target.into(),
            kind: kind.into(),
            until_ms,
            reason: reason.into(),
        });
    }

    pub fn bot_logs(
        &self,
        community_id: &str,
        bot_id: &str,
        limit: i64,
    ) -> Result<Vec<crate::storage::BotLogRow>> {
        self.require_owner(community_id)?;
        self.store.bot_logs(community_id, bot_id, limit)
    }

    pub fn bot_logs_clear(&self, community_id: &str, bot_id: &str) -> Result<usize> {
        self.require_owner(community_id)?;
        self.store.bot_logs_clear(community_id, bot_id)
    }

    /// O runtime roda na máquina do dono; log/variável exigem que o bot exista.
    pub fn bot_log_append(
        &self,
        community_id: &str,
        bot_id: &str,
        level: &str,
        message: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .bots_list(community_id)?
            .iter()
            .all(|b| b.id != bot_id)
        {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.store.bot_log(community_id, bot_id, level, message)
    }

    pub fn bot_vars_list(&self, community_id: &str, bot_id: &str) -> Result<Vec<(String, String)>> {
        self.require_owner(community_id)?;
        self.store.bot_vars_list(community_id, bot_id)
    }

    pub fn bot_var_set(
        &self,
        community_id: &str,
        bot_id: &str,
        key: &str,
        value: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .bots_list(community_id)?
            .iter()
            .all(|b| b.id != bot_id)
        {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.store.bot_var_set(community_id, bot_id, key, value)
    }

    /// O bot troca a **própria** config em tempo de execução (rota
    /// `POST /v1/commands` da ponte). Regras que não podem cair:
    ///
    /// - a config inteira é revalidada pelo parser do core;
    /// - `perms` **não** muda por aqui: um bot nunca se concede poder;
    /// - o bot precisa existir e estar online, como em qualquer ação.
    pub fn bot_replace_config(&self, community_id: &str, bot_id: &str, raw: &str) -> Result<usize> {
        self.require_owner(community_id)?;
        let Some(bot) = self
            .store
            .bots_list(community_id)?
            .into_iter()
            .find(|b| b.id == bot_id)
        else {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        };
        if !bot.online {
            return Err(DistorrentError::Protocol(
                "bot está offline — ative-o no painel".into(),
            ));
        }
        let mut parsed = crate::bots::parse_config(raw).map_err(DistorrentError::Protocol)?;
        // Política do DONO, não do bot: um `POST /v1/commands` não pode religar
        // rede privada nem trocar o webhook por um endereço próprio. Sem isto o
        // bot desfazia o opt-in do dono e abria o SSRF que a guarda fecha.
        let atual = crate::bots::parse_config(&bot.config).unwrap_or_default();
        parsed.block_private = atual.block_private;
        parsed.http_allow = atual.http_allow.clone();
        // Segredo: vem da coluna local (nunca do JSON sincronizado) e o bot não
        // consegue trocá-lo pela ponte.
        parsed.webhook_secret = Some(bot.webhook_secret.clone());
        // Grava a forma NORMALIZADA (v3): o que o parser descartou não volta, e
        // os campos novos não somem quando o bot edita o próprio comando.
        let normalized = crate::bots::normalize(&parsed).to_string();
        let n = parsed.commands.len();
        // `perms: None` de propósito: o bot NÃO altera as próprias permissões.
        self.store.bot_update_patch(
            community_id,
            bot_id,
            &crate::storage::BotPatch {
                config: Some(normalized),
                ..Default::default()
            },
        )?;
        self.broadcast_community_state(community_id);
        Ok(n)
    }

    pub fn disconnect_peer(&self, peer_fp: &str) {
        let link = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_fp)
            .cloned();
        if let Some(l) = link {
            if let Some(tx) = &l.tx {
                let _ = tx.send((0, SecureFrame::Bye));
            }
            l.drop_notify.notify_one();
        }
    }

    pub fn friends(&self, status: Option<&str>) -> Vec<PeerRecord> {
        self.store.list_friends(status).unwrap_or_default()
    }

    pub fn is_blocked(&self, peer_fp: &str) -> bool {
        matches!(self.store.get_friend(peer_fp).ok().flatten(), Some((_, s)) if s == "blocked")
    }

    /// Normaliza um identificador de peer digitado/colado.
    /// Aceita os dois formatos que a UI oferece para copiar: o fingerprint de 12
    /// hex e a chave pública de 64 hex. Recusar o formato longo fazia quem
    /// colava "certo" ver "fingerprint deve ter 12 hex chars".
    pub fn normalize_peer_id(input: &str) -> Result<String> {
        let v = input.trim().to_lowercase();
        let v = v.strip_prefix("distorrent:").unwrap_or(&v).to_string();
        if v.len() == 12 && v.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(v);
        }
        if v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(crate::identity::fingerprint_of_pubkey_hex(&v));
        }
        Err(DistorrentError::Protocol(
            "identificador inválido: use o fingerprint de 12 caracteres ou a chave pública de 64"
                .into(),
        ))
    }

    pub fn friend_request(&self, peer_fp: &str) -> Result<FriendOutcome> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        let peer_fp = peer_fp.as_str();
        if peer_fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "não é possível adicionar a si mesmo".into(),
            ));
        }
        match self.store.friend_state(peer_fp)? {
            // Amizade já vale dos dois lados: repetir o pedido é no-op, não
            // reenvia frame nem mexe no carimbo.
            Some(s) if s.status == "accepted" => return Ok(FriendOutcome::Sent),
            Some(s) if s.status == "blocked" => {
                return Err(DistorrentError::Protocol("peer bloqueado".into()))
            }
            // Pedido dele chegou enquanto eu também pedia: aceitar os dois é
            // o único desfecho que não deixa um lado "amigo" e o outro não.
            Some(s) if s.status == "pending_in" => {
                return self
                    .friend_respond(peer_fp, true)
                    .map(|_| FriendOutcome::Sent)
            }
            _ => {}
        }
        self.store
            .set_friend_request_out(peer_fp, &self.identity.nickname)?;
        let sent = self.deliver_friend_frame(
            peer_fp,
            SecureFrame::FriendRequest {
                nickname: self.identity.nickname.clone(),
            },
        );
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
            .ok();
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
            .ok();
        self.dht_probe(peer_fp);
        Ok(sent)
    }

    pub fn friend_respond(&self, peer_fp: &str, accept: bool) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        let peer_fp = peer_fp.as_str();
        let state = self.store.friend_state(peer_fp)?;
        match state.as_ref().map(|s| s.status.as_str()) {
            Some("pending_in") => {}
            Some("blocked") => {
                return Err(DistorrentError::Protocol("peer bloqueado".into()));
            }
            Some(status) => {
                return Err(DistorrentError::Protocol(format!(
                    "não há pedido pendente para responder (status: {status})"
                )))
            }
            None => return Err(DistorrentError::Protocol("não há pedido pendente".into())),
        }
        if accept {
            let nick = state
                .as_ref()
                .map(|s| s.nickname.clone())
                .unwrap_or_default();
            // Grava aceito ANTES de avisar: se o frame falhar, o outro lado
            // reenvia o pedido no próximo tick e recebe FriendAccept.
            self.store.accept_friend(peer_fp, &nick)?;
            self.reset_dm_intro_for_peer(peer_fp);
            let _ = self.deliver_friend_frame(
                peer_fp,
                SecureFrame::FriendAccept {
                    nickname: self.identity.nickname.clone(),
                },
            );
            self.cmd_tx
                .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
                .ok();
            self.cmd_tx
                .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
                .ok();
            let _ = self.events.send(EngineEvent::FriendAccepted {
                fp: peer_fp.into(),
                nickname: nick,
            });
        } else {
            self.store.reject_friend(peer_fp)?;
            self.deliver_friend_frame(peer_fp, SecureFrame::FriendReject);
            let _ = self
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }
        Ok(())
    }

    /// Zera o crédito de introdução da DM com o peer quando a amizade é aceita.
    fn reset_dm_intro_for_peer(&self, peer_fp: &str) {
        let conv = crate::storage::Store::dm_conversation_id(&self.identity.fingerprint, peer_fp);
        let _ = self.store.dm_intro_reset(&conv);
    }

    // Seção 20: friend_remove
    pub fn friend_remove(&self, peer_fp: &str) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        self.store.clear_friendship(&peer_fp)?;
        self.deliver_friend_frame(&peer_fp, SecureFrame::FriendRemove);
        let _ = self.events.send(EngineEvent::FriendRemoved {
            fp: peer_fp.clone(),
        });
        Ok(())
    }

    pub fn friend_block(&self, peer_fp: &str) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        self.store.set_friend(&peer_fp, "", "blocked")?;
        self.deliver_friend_frame(&peer_fp, SecureFrame::FriendRemove);
        // Bloqueio é local e imediato: a UI precisa ver o peer sair da lista
        // e da conversa sem esperar o próximo refresh.
        let _ = self.events.send(EngineEvent::FriendRemoved {
            fp: peer_fp.clone(),
        });
        Ok(())
    }

    pub fn friend_unblock(&self, peer_fp: &str) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        // Desbloquear NÃO recria amizade: volta ao estado neutro e o próximo
        // pedido passa pelo fluxo normal. Antes um `DELETE` deixava o peer
        // sem memória nenhuma e o próximo ProfileSet o "amigava" de novo.
        self.store.unblock_friend(&peer_fp)?;
        let _ = self.events.send(EngineEvent::FriendRemoved {
            fp: peer_fp.clone(),
        });
        Ok(())
    }

    fn deliver_friend_frame(&self, peer_fp: &str, frame: SecureFrame) -> FriendOutcome {
        if self.link_tx(peer_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
                .ok();
            FriendOutcome::Sent
        } else {
            FriendOutcome::QueuedOffline
        }
    }

    pub fn create_community(&self, name: &str, channels: &[String]) -> Result<String> {
        self.create_community_with_options(name, channels, &CommunityCreateOptions::default())
    }

    pub fn create_community_with_options(
        &self,
        name: &str,
        channels: &[String],
        opts: &CommunityCreateOptions,
    ) -> Result<String> {
        let existing: Vec<String> = self
            .store
            .list_communities()
            .unwrap_or_default()
            .into_iter()
            .map(|(_, n, _)| n)
            .collect();
        let name = Self::validate_name_gate(crate::names::NameKind::Server, name, &existing)?;
        let mut seen: Vec<String> = vec![];
        let cid = crate::protocol::new_message_id(
            &self.identity.fingerprint,
            &name,
            crate::identity::now_ms(),
            "community",
        )[..16]
            .to_string();

        let chan_rows: Vec<ChannelMetaRow> = if !opts.channels_meta.is_empty() {
            let mut rows = Vec::with_capacity(opts.channels_meta.len());
            for c in &opts.channels_meta {
                let kind = match c.kind.as_str() {
                    "" | "text" => "text",
                    "voice" => "voice",
                    "video" => "video",
                    other => {
                        return Err(DistorrentError::Protocol(format!(
                            "tipo de canal inválido ({other}) — use text|voice|video"
                        )))
                    }
                };
                let v = Self::validate_name_gate(
                    crate::names::NameKind::Channel,
                    &Self::normalize_channel_name(&c.name),
                    &seen,
                )?;
                seen.push(v.clone());
                let default_cat = match kind {
                    "voice" => "CANAIS DE VOZ",
                    "video" => "CANAIS DE VÍDEO",
                    _ => "CANAIS DE TEXTO",
                };
                let category = if c.category.trim().is_empty() {
                    default_cat.to_string()
                } else {
                    crate::names::sanitize_text(c.category.trim(), 64)
                };
                rows.push(ChannelMetaRow {
                    id: format!("{cid}-{}", v.to_lowercase().replace(' ', "-")),
                    name: v,
                    topic: String::new(),
                    category,
                    kind: kind.into(),
                    position: rows.len() as i64,
                });
            }
            rows
        } else {
            let mut clean: Vec<String> = Vec::with_capacity(channels.len());
            for c in channels {
                let v = Self::validate_name_gate(
                    crate::names::NameKind::Channel,
                    &Self::normalize_channel_name(c),
                    &seen,
                )?;
                seen.push(v.clone());
                clean.push(v);
            }
            if clean.is_empty() {
                clean.push("geral".into());
            }
            clean
                .into_iter()
                .enumerate()
                .map(|(i, c)| ChannelMetaRow {
                    id: format!("{cid}-{}", c.to_lowercase().replace(' ', "-")),
                    name: c,
                    topic: String::new(),
                    category: "CANAIS DE TEXTO".into(),
                    kind: "text".into(),
                    position: i as i64,
                })
                .collect()
        };

        let empty: Vec<(&str, &str)> = vec![];
        self.store
            .create_community(&cid, &name, &self.identity.fingerprint, &empty)?;
        for row in &chan_rows {
            self.store.upsert_channel(&cid, row)?;
        }
        self.store.upsert_member(
            &cid,
            &self.identity.fingerprint,
            &self.identity.nickname,
            "owner",
        )?;

        for (i, r) in opts.roles.iter().take(12).enumerate() {
            let clean_name = crate::names::sanitize_text(&r.name, 64);
            if clean_name.is_empty() {
                continue;
            }
            let color = crate::names::sanitize_text(&r.color, 16);
            let row = crate::storage::RoleRow {
                id: format!("{cid}-role-{}", Self::rand_hex(6)),
                community_id: cid.clone(),
                name: clean_name,
                color,
                permissions: r.permissions & 0x3FF,
                hoist: r.hoist,
                mentionable: r.mentionable,
                position: i as i64,
            };
            self.store.role_upsert(&row)?;
        }

        self.store.community_meta_set(
            &cid,
            Some(opts.description.trim()),
            Some(opts.category.trim()),
            Some(opts.icon.trim()),
        )?;
        if opts.is_public {
            self.store.community_set_public(&cid, true)?;
        }
        if !opts.rules_text.trim().is_empty() {
            self.store.kv_set(
                &format!("rules:text:{cid}"),
                &crate::names::sanitize_text(opts.rules_text.trim(), 4096),
            )?;
        }

        // Seção 21: _
        let _ = self.events.send(EngineEvent::CommunityJoined {
            community_id: cid.clone(),
            name: name.into(),
        });
        Ok(cid)
    }

    pub fn community_set_meta(
        &self,
        community_id: &str,
        description: Option<&str>,
        category: Option<&str>,
        icon: Option<&str>,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .community_meta_set(community_id, description, category, icon)?
            == 0
        {
            return Err(DistorrentError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn community_meta(&self, community_id: &str) -> Result<(String, String, String)> {
        self.store.community_meta(community_id)
    }

    /// Liga/desliga o servidor público. Só o dono muda; o estado vai para todos
    /// na mesma hora para ninguém ficar com a regra antiga na tela.
    pub fn community_set_public(&self, community_id: &str, is_public: bool) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.community_set_public(community_id, is_public)? == 0 {
            return Err(DistorrentError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn community_is_public(&self, community_id: &str) -> Result<bool> {
        self.store.community_is_public(community_id)
    }

    pub fn make_invite(&self, community_id: &str, member_fp: &str, ttl_ms: i64) -> Result<String> {
        const WILDCARD: &str = "000000000000";
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "apenas o dono gera convites".into(),
            ));
        }
        let fp = member_fp.trim().to_lowercase();
        if fp != WILDCARD && (fp.len() != 12 || !fp.chars().all(|c| c.is_ascii_hexdigit())) {
            return Err(DistorrentError::Protocol("fingerprint inválido".into()));
        }
        let exp = crate::identity::now_ms() + ttl_ms;
        Ok(crate::protocol::make_invite_token(
            &self.keypair,
            community_id,
            &fp,
            exp,
        ))
    }

    pub fn join_community(&self, token: &str) -> Result<String> {
        let normalized = crate::protocol::extract_invite_token(token);
        let (host_fp, cid, member_fp, exp, sig) = crate::protocol::parse_invite_token(&normalized)?;
        if crate::identity::now_ms() > exp {
            return Err(DistorrentError::Protocol("convite expirado".into()));
        }
        const WILDCARD: &str = "000000000000";
        if member_fp != WILDCARD && member_fp != self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "convite é para outro fingerprint".into(),
            ));
        }
        if let Some(host) = self.store.get_peer(&host_fp)? {
            if !Keypair::verify(
                &host.pubkey_hex,
                &crate::protocol::invite_sign_bytes(&cid, &member_fp, exp),
                &sig,
            )
            .map_err(|e| DistorrentError::Crypto(e.to_string()))?
            {
                return Err(DistorrentError::Protocol(
                    "convite com assinatura inválida".into(),
                ));
            }
        }
        if self
            .store
            .member_role(&cid, &self.identity.fingerprint)
            .is_some()
        {
            self.persist_pending_join(&cid, &normalized);
            self.connect_to_community_peer(&host_fp);
            self.request_community_sync(&cid);
            return Ok(cid);
        }
        self.pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cid.clone(), normalized.clone());
        self.persist_pending_join(&cid, &normalized);
        self.send_join_to_host(&host_fp, &cid, &normalized);
        self.connect_to_community_peer(&host_fp);
        Ok(cid)
    }

    /// Entra num servidor PÚBLICO sem convite: o host aceita direto (com rate
    /// limit). Se o servidor for privado, o host recusa com erro honesto.
    pub fn join_public_community(&self, host_fp: &str, community_id: &str) -> Result<String> {
        let host = host_fp.trim().to_lowercase();
        let cid = community_id.trim().to_string();
        if host.is_empty() || cid.is_empty() {
            return Err(DistorrentError::Protocol(
                "servidor público precisa de host e id".into(),
            ));
        }
        if self
            .store
            .member_role(&cid, &self.identity.fingerprint)
            .is_some()
        {
            self.connect_to_community_peer(&host);
            self.request_community_sync(&cid);
            return Ok(cid);
        }
        self.pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cid.clone(), String::new());
        self.send_join_to_host(&host, &cid, "");
        self.connect_to_community_peer(&host);
        Ok(cid)
    }

    fn persist_pending_join(&self, community_id: &str, token: &str) {
        let key = format!("join.pending.{community_id}");
        if let Err(e) = self.store.kv_set(&key, token) {
            tracing::warn!(%community_id, "não consegui persistir o convite pendente: {e}");
        }
    }

    fn clear_pending_join(&self, community_id: &str) {
        self.pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(community_id);
        self.join_retry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(community_id);
        let _ = self
            .store
            .kv_delete(&format!("join.pending.{community_id}"));
    }

    fn send_join_to_host(&self, host_fp: &str, cid: &str, token: &str) {
        if self.link_tx(host_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    host_fp.to_string(),
                    SecureFrame::JoinCommunity {
                        community_id: cid.to_string(),
                        token: token.to_string(),
                    },
                ))
                .ok();
        }
    }

    pub fn should_keep_dialing(&self, fp: &str) -> bool {
        if fp.is_empty() || fp == self.identity.fingerprint {
            return false;
        }
        if self
            .store
            .get_friend(fp)
            .ok()
            .flatten()
            .map(|(_, s)| s == "accepted" || s == "pending_out" || s == "pending_in")
            .unwrap_or(false)
        {
            return true;
        }
        for (cid, _, _) in self.store.list_communities().unwrap_or_default() {
            if self
                .store
                .list_members(&cid)
                .unwrap_or_default()
                .iter()
                .any(|(m, _, _)| m == fp)
            {
                return true;
            }
        }
        for conv in self.store.list_conversations().unwrap_or_default() {
            if conv.kind != "group" {
                continue;
            }
            if self
                .store
                .list_group_members(&conv.id)
                .unwrap_or_default()
                .iter()
                .any(|(m, _)| m == fp)
            {
                return true;
            }
        }
        false
    }

    // Seção 22: group_pair_now
    pub fn group_pair_now(&self, conv_id: &str) {
        let me = self.identity.fingerprint.clone();
        let membros = self.store.list_group_members(conv_id).unwrap_or_default();
        if membros.iter().all(|(fp, _)| fp != &me) {
            return;
        }
        for (fp, _nick) in membros {
            if fp == me || self.link_tx(&fp).is_some() {
                continue;
            }
            self.connect_to_community_peer(&fp);
        }
    }

    pub fn pair_all_groups_now(&self) {
        let me = self.identity.fingerprint.clone();
        for conv in self.store.list_conversations().unwrap_or_default() {
            if conv.kind != "group" {
                continue;
            }
            let membros = self.store.list_group_members(&conv.id).unwrap_or_default();
            if membros.iter().all(|(fp, _)| fp != &me) {
                continue;
            }
            for (fp, _nick) in membros {
                if fp == me || self.link_tx(&fp).is_some() {
                    continue;
                }
                self.connect_to_community_peer(&fp);
            }
        }
    }

    fn connect_to_community_peer(&self, fp: &str) {
        if fp == self.identity.fingerprint {
            return;
        }
        self.member_dial_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(fp.to_string(), crate::identity::now_ms());
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(fp.to_string()))
            .ok();
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(fp.to_string()))
            .ok();
        self.dht_probe(fp);
    }

    pub fn request_community_sync(&self, community_id: &str) {
        if self
            .store
            .member_role(community_id, &self.identity.fingerprint)
            .is_none()
        {
            return;
        }
        let now = crate::identity::now_ms();
        {
            let mut seen = self
                .community_sync_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = seen.get(community_id) {
                if now.saturating_sub(*prev) < 45_000 {
                    return;
                }
            }
            seen.insert(community_id.to_string(), now);
        }
        let mut targets: Vec<String> = Vec::new();
        if let Ok(Some((_, _, owner))) = self.store.get_community(community_id) {
            if owner != self.identity.fingerprint {
                targets.push(owner);
            }
        }
        let mut seen: std::collections::HashSet<String> = targets.iter().cloned().collect();
        for fp in self.online_peer_fps() {
            if fp == self.identity.fingerprint || !seen.insert(fp.clone()) {
                continue;
            }
            if self.store.member_role(community_id, &fp).is_some() {
                targets.push(fp);
            }
        }
        for fp in targets {
            if self.link_tx(&fp).is_none() {
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::CommunitySyncRequest {
                        community_id: community_id.to_string(),
                    },
                ))
                .ok();
        }
    }

    pub fn maintain_communities(&self) {
        let now = crate::identity::now_ms();
        let communities = self.store.list_communities().unwrap_or_default();
        for (cid, _name, owner) in communities {
            if self
                .store
                .member_role(&cid, &self.identity.fingerprint)
                .is_none()
            {
                continue;
            }
            if owner != self.identity.fingerprint && self.link_tx(&owner).is_none() {
                self.connect_to_community_peer_throttled(&owner, now, 30_000);
            }
            for (fp, _nick, _role) in self.store.list_members(&cid).unwrap_or_default() {
                if fp == self.identity.fingerprint || fp == owner {
                    continue;
                }
                if self.link_tx(&fp).is_some() {
                    continue;
                }
                self.connect_to_community_peer_throttled(&fp, now, 45_000);
            }
            self.request_community_sync(&cid);
        }
        self.retry_pending_joins();
    }

    fn connect_to_community_peer_throttled(&self, fp: &str, now: i64, min_ms: i64) {
        {
            let mut seen = self
                .member_dial_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = seen.get(fp) {
                if now.saturating_sub(*prev) < min_ms {
                    return;
                }
            }
            if seen.len() > 4096 {
                seen.clear();
            }
            seen.insert(fp.to_string(), now);
        }
        self.connect_to_community_peer(fp);
    }

    pub fn maintain_groups(&self) {
        let now = crate::identity::now_ms();
        let me = self.identity.fingerprint.clone();
        let convs = self.store.list_conversations().unwrap_or_default();
        for conv in convs {
            if conv.kind != "group" {
                continue;
            }
            // Seção 23: membros
            let membros = self.store.list_group_members(&conv.id).unwrap_or_default();
            if membros.iter().all(|(fp, _)| fp != &me) {
                continue;
            }
            for (fp, _nick) in membros {
                if fp == me {
                    continue;
                }
                if self.link_tx(&fp).is_some() {
                    continue;
                }
                self.connect_to_community_peer_throttled(&fp, now, 45_000);
            }
        }
    }

    pub fn send_channel_message(
        &self,
        community_id: &str,
        channel_id: &str,
        body: &str,
    ) -> Result<StoredMessage> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if self
            .store
            .member_role(community_id, &self.identity.fingerprint)
            .is_none()
        {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        if !self
            .store
            .list_channels(community_id)?
            .iter()
            .any(|(id, _)| id == channel_id)
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        self.gate_speech(community_id, channel_id)?;
        let env = MessageEnvelope::new(&self.keypair, channel_id, body);
        self.store.insert_message(&env, "out", "sending")?;
        let my = &self.identity.fingerprint;
        let targets = self.store.mention_targets(body);
        if targets.iter().any(|t| t == my) {
            self.store.msg_set_mentioned(&env.id, channel_id, true).ok();
        }
        for target in &targets {
            if target.len() == 12 {
                self.store.mention_add(&env.id, channel_id, target).ok();
            }
        }
        if targets.iter().any(|t| t == "everyone") {
            for (fp, _, _) in self.store.list_members(community_id)? {
                if &fp != my {
                    self.store.mention_add(&env.id, channel_id, &fp).ok();
                }
            }
        }
        crate::metrics::metrics().message_out();
        if comm.2 == self.identity.fingerprint {
            self.host_relay(community_id, channel_id, &env, "")?;
            self.store.set_message_status(&env.id, "sent")?;
        } else {
            let host_fp = comm.2;
            if self.link_tx(&host_fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        host_fp.clone(),
                        SecureFrame::ChannelMsg {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                            env: env.clone(),
                            bot_id: String::new(),
                        },
                    ))
                    .ok();
                self.store.set_message_status(&env.id, "sent")?;
            } else {
                self.store.enqueue_outbox(&env.id, &host_fp)?;
                self.store.set_message_status(&env.id, "pending")?;
            }
        }
        self.store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn gate_speech(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.gate_speech_for(community_id, channel_id, &self.identity.fingerprint)
    }

    pub fn gate_speech_for(
        &self,
        community_id: &str,
        channel_id: &str,
        author_fp: &str,
    ) -> Result<()> {
        let me = author_fp;
        let mute_until = self.store.mute_active(me).unwrap_or(0);
        if mute_until > crate::identity::now_ms() {
            let mins = ((mute_until - crate::identity::now_ms()) as f64 / 60_000.0).ceil() as i64;
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!("você está silenciado por mais {mins} min"),
                until_ms: mute_until,
            });
            return Err(DistorrentError::Protocol(format!(
                "você está silenciado por mais {mins} min"
            )));
        }
        if let Some(b) = self.store.ban_get(community_id, me).ok().flatten() {
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!(
                    "você está banido{}",
                    if b.reason.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", b.reason)
                    }
                ),
                until_ms: b.until_ms,
            });
            return Err(DistorrentError::Protocol(
                "você está banido deste servidor".into(),
            ));
        }
        let until = self.store.timeout_active(community_id, me).unwrap_or(0);
        if until > 0 {
            let mins = ((until - crate::identity::now_ms()) as f64 / 60_000.0).ceil() as i64;
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!("silenciado por mais {} min", mins),
                until_ms: until,
            });
            return Err(DistorrentError::Protocol(format!(
                "você está silenciado por mais {} min",
                mins
            )));
        }
        let slow = self.store.channel_cfg_slowmode(channel_id).unwrap_or(0);
        if slow > 0 && !self.is_moderator(community_id, me) {
            let wait = self.store.slowmode_gate(channel_id, me, slow).unwrap_or(0);
            if wait > 0 {
                let secs = (wait as f64 / 1000.0).ceil() as i64;
                let _ = self.events.send(EngineEvent::Muted {
                    context: channel_id.into(),
                    reason: format!("slowmode: aguarde {}s", secs),
                    until_ms: crate::identity::now_ms() + wait,
                });
                return Err(DistorrentError::Protocol(format!(
                    "slowmode: aguarde {}s",
                    secs
                )));
            }
        }
        Ok(())
    }

    // Seção 24: to_social_peers
    fn to_social_peers(&self, conv_id: &str, frame: SecureFrame) {
        for fp in self.social_peers_of(conv_id) {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(fp, frame.clone()))
                .ok();
        }
    }

    pub fn social_react(&self, conv_id: &str, msg_id: &str, emoji: &str) -> Result<bool> {
        let me = self.identity.fingerprint.clone();
        let added = self
            .store
            .reaction_toggle(msg_id, conv_id, emoji, &me)
            .unwrap_or(false);
        self.events
            .send(EngineEvent::ReactionChanged {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
                emoji: emoji.into(),
                add: added,
                reactor_fp: me.clone(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::React {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                emoji: emoji.into(),
                add: added,
                reactor_fp: me.clone(),
            },
        );
        for fp in self.social_peers_of(conv_id) {
            if self.link_tx(&fp).is_none() {
                let _ = self
                    .store
                    .queue_pending_react(&fp, conv_id, msg_id, emoji, added);
            }
        }
        Ok(added)
    }

    pub fn social_reply(&self, conv_id: &str, msg_id: &str, reply_to: &str) -> Result<()> {
        let alvo = self
            .store
            .message_by_id(reply_to)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem citada não existe".into()))?;
        if alvo.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "a mensagem citada está em outra conversa".into(),
            ));
        }
        let portadora = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if portadora.conv_id != conv_id {
            return Err(DistorrentError::Protocol("conversa divergente".into()));
        }
        self.store.msg_set_reply(msg_id, conv_id, reply_to)?;
        self.events
            .send(EngineEvent::MessageReply {
                msg_id: msg_id.into(),
                reply_to: reply_to.into(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::Reply {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                reply_to: reply_to.into(),
            },
        );
        Ok(())
    }

    pub fn social_edit(&self, conv_id: &str, msg_id: &str, body: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let orig = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if orig.author_fp != me {
            return Err(DistorrentError::Protocol("só o autor edita".into()));
        }
        if orig.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "mensagem de outra conversa".into(),
            ));
        }
        let nb = cap_str(body, 4000);
        if nb.trim().is_empty() {
            return Err(DistorrentError::Protocol("corpo vazio".into()));
        }
        self.store.msg_edit(msg_id, conv_id, &nb)?;
        self.events
            .send(EngineEvent::MessageEdited {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
                body: nb.clone(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::MsgEdit {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                body: nb,
            },
        );
        Ok(())
    }

    pub fn social_delete(&self, conv_id: &str, msg_id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let orig = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if orig.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "mensagem de outra conversa".into(),
            ));
        }
        let is_author = orig.author_fp == me;
        // `is_moderator` espera community_id; em DM/grupo a permissão vem do
        // conv. Antes, passar o conv_id fazia `is_moderator` devolver false
        // sempre e o autor de grupo não conseguia apagar a própria mensagem
        // se o conv não fosse um canal.
        if !is_author && !self.can_moderate_conv(conv_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão para apagar".into(),
            ));
        }
        self.store.msg_delete(msg_id, conv_id)?;
        self.events
            .send(EngineEvent::MessageDeleted {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::MsgDelete {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
            },
        );
        Ok(())
    }

    pub fn social_pin(&self, conv_id: &str, msg_id: &str, pinned: bool) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.can_pin_conv(conv_id, &me) {
            return Err(DistorrentError::Protocol("sem permissão para fixar".into()));
        }
        let orig = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if orig.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "mensagem de outra conversa".into(),
            ));
        }
        self.store.msg_pin(msg_id, conv_id, pinned, &me)?;
        self.events
            .send(EngineEvent::MessagePinned {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
                pinned,
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::MsgPin {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                pinned,
            },
        );
        Ok(())
    }

    // Seção 25: social_forward
    pub fn social_forward(
        &self,
        src_msg_id: &str,
        target_conv: &str,
        target_channel: &str,
        from_label: &str,
    ) -> Result<StoredMessage> {
        let src = self
            .store
            .message_by_id(src_msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        let body = self.store.effective_body(src_msg_id, &src.body)?;
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol("mensagem longa demais".into()));
        }
        let env = MessageEnvelope::new(&self.keypair, target_conv, &body);
        self.store.insert_message(&env, "out", "sending")?;
        self.store
            .msg_set_forward(&env.id, target_conv, from_label)?;
        if let Some(sm) = self.store.message_by_id(&env.id)? {
            self.events.send(EngineEvent::MessageNew(sm)).ok();
        }
        let frame = SecureFrame::Forward {
            conv_id: target_conv.into(),
            channel_id: target_channel.into(),
            env: env.clone(),
            from_label: from_label.into(),
        };
        if let Some(comm) = self.store.channel_community(target_channel)? {
            self.broadcast_social(&comm, frame);
        } else {
            self.to_social_peers(target_conv, frame);
        }
        Ok(self
            .store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Protocol("falha ao gravar".into()))?)
    }

    pub fn social_presence_set(&self, status: &str, custom: &str, emoji: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let st = normalize_presence(status);
        self.store
            .presence_set(&me, st, &cap_str(custom, 128), &cap_str(emoji, 16))?;
        self.events
            .send(EngineEvent::PresenceChanged {
                fp: me,
                status: st.into(),
                custom: cap_str(custom, 128),
                custom_emoji: cap_str(emoji, 16),
            })
            .ok();
        self.announce_presence();
        Ok(())
    }

    pub fn social_profile_set(
        &self,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
    ) -> Result<crate::social::ProfileView> {
        self.social_profile_set_full(
            display_name,
            about,
            avatar_b64,
            banner_b64,
            accent,
            false,
            false,
        )
    }

    pub fn social_profile_set_full(
        &self,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
        clear_avatar: bool,
        clear_banner: bool,
    ) -> Result<crate::social::ProfileView> {
        let me = self.identity.fingerprint.clone();
        let dn = cap_str(display_name, 48);
        let ab = cap_str(about, 400);
        let ac = normalize_accent(accent);
        let av = cap_b64(avatar_b64, PROFILE_IMG_B64_MAX);
        let bn = cap_b64(banner_b64, PROFILE_BANNER_B64_MAX);

        let changed = self.store.profile_set_local(
            &me,
            &dn,
            &ab,
            &av,
            &bn,
            &ac,
            clear_avatar,
            clear_banner,
        )?;
        let profile = self.store.profile_get(&me)?;
        self.events
            .send(EngineEvent::ProfileChanged {
                fp: me.clone(),
                profile: profile.clone(),
            })
            .ok();

        if changed.is_some() {
            self.broadcast_profile(&profile);
        }
        Ok(profile)
    }

    pub fn broadcast_profile(&self, profile: &crate::social::ProfileView) {
        let me = self.identity.fingerprint.clone();
        let frame = profile_frame(profile);
        let mut alvos: std::collections::HashSet<String> = self
            .store
            .list_peers()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.fp)
            .collect();
        alvos.extend(self.online_peer_fps());
        alvos.remove(&me);
        for fp in alvos {
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(fp, frame.clone()))
                    .ok();
            }
        }
    }

    pub fn sync_profiles_with_peers(&self) {
        let me = self.identity.fingerprint.clone();
        for fp in self.online_peer_fps() {
            if fp == me {
                continue;
            }
            let known_rev = self.store.profile_get(&fp).map(|p| p.rev).unwrap_or(0);
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::ProfileQuery { known_rev },
                ))
                .ok();
        }
    }

    pub fn social_thread_create(
        &self,
        community_id: &str,
        parent_channel: &str,
        name: &str,
        kind: &str,
        tags: &str,
    ) -> Result<crate::social::ThreadRow> {
        // Seção 26: me
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        let id = format!(
            "th_{}",
            &crate::protocol::new_message_id(&me, community_id, crate::identity::now_ms(), name)
                [..24]
        );
        let t = crate::social::ThreadRow {
            id,
            community_id: community_id.into(),
            parent_channel: parent_channel.into(),
            name: cap_str(name, 80),
            author_fp: me,
            created_at: crate::identity::now_ms(),
            archived: false,
            kind: if kind == "forum" {
                "forum".into()
            } else {
                "thread".into()
            },
            tags: cap_str(tags, 200),
        };
        self.store.thread_upsert(&t)?;
        self.events
            .send(EngineEvent::ThreadCreated {
                community_id: community_id.into(),
                thread: t.clone(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::ThreadCreate {
                community_id: community_id.into(),
                thread_id: t.id.clone(),
                parent_channel: parent_channel.into(),
                name: t.name.clone(),
                kind: t.kind.clone(),
                tags: t.tags.clone(),
            },
        );
        Ok(t)
    }

    pub fn social_thread_archive(&self, thread_id: &str, archived: bool) -> Result<()> {
        self.store.thread_archive(thread_id, archived)?;
        Ok(())
    }

    pub fn social_thread_send(
        &self,
        community_id: &str,
        thread_id: &str,
        body: &str,
    ) -> Result<StoredMessage> {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        let t = self
            .store
            .thread_get(thread_id)?
            .ok_or_else(|| DistorrentError::Protocol("thread inexistente".into()))?;
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        self.gate_speech(community_id, &t.parent_channel)?;
        let env = MessageEnvelope::new(&self.keypair, thread_id, body);
        self.store
            .insert_message_in_thread(&env, thread_id, "out", "sending")?;
        if body.contains(&me) {
            self.store.msg_set_mentioned(&env.id, thread_id, true).ok();
        }
        if let Some(sm) = self.store.message_by_id(&env.id)? {
            self.events.send(EngineEvent::MessageNew(sm)).ok();
        }
        self.broadcast_social(
            community_id,
            SecureFrame::ThreadMsg {
                community_id: community_id.into(),
                thread_id: thread_id.into(),
                parent_channel: t.parent_channel,
                env: env.clone(),
            },
        );
        Ok(self
            .store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Protocol("falha ao gravar".into()))?)
    }

    pub fn social_ban(
        &self,
        community_id: &str,
        target: &str,
        until_ms: i64,
        reason: &str,
    ) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me && !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        if target == comm.2 {
            return Err(DistorrentError::Protocol(
                "o dono não pode ser banido".into(),
            ));
        }
        self.store
            .ban_set(community_id, target, &cap_str(reason, 300), &me, until_ms)?;
        self.store.remove_member(community_id, target).ok();
        self.events
            .send(EngineEvent::ModerationApplied {
                community_id: community_id.into(),
                target_fp: target.into(),
                kind: "ban".into(),
                until_ms,
                reason: reason.into(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::MemberBan {
                community_id: community_id.into(),
                target_fp: target.into(),
                until_ms,
                reason: cap_str(reason, 300),
            },
        );
        Ok(())
    }

    pub fn social_unban(&self, community_id: &str, target: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        self.store.ban_remove(community_id, target)?;
        Ok(())
    }

    pub fn social_timeout(
        &self,
        community_id: &str,
        target: &str,
        until_ms: i64,
        reason: &str,
    ) -> Result<()> {
        // Seção 27: me
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        self.store
            .timeout_set(community_id, target, until_ms, &cap_str(reason, 300), &me)?;
        self.events
            .send(EngineEvent::ModerationApplied {
                community_id: community_id.into(),
                target_fp: target.into(),
                kind: "timeout".into(),
                until_ms,
                reason: reason.into(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::MemberTimeout {
                community_id: community_id.into(),
                target_fp: target.into(),
                until_ms,
                reason: cap_str(reason, 300),
            },
        );
        Ok(())
    }

    pub fn social_channel_cfg(
        &self,
        community_id: &str,
        channel_id: &str,
        slowmode_secs: i64,
        nsfw: bool,
    ) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(DistorrentError::Protocol(
                "só o dono configura o canal".into(),
            ));
        }
        self.store
            .channel_cfg_set(channel_id, slowmode_secs.clamp(0, 21_600), nsfw, false)?;
        self.broadcast_social(
            community_id,
            SecureFrame::ChannelCfg {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                slowmode_secs,
                nsfw,
            },
        );
        Ok(())
    }

    pub fn social_poll_create(
        &self,
        community_id: &str,
        channel_id: &str,
        question: &str,
        options: Vec<String>,
        multi: bool,
        ends_at: i64,
    ) -> Result<crate::social::PollRow> {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        let opts: Vec<String> = options.iter().take(10).map(|o| cap_str(o, 80)).collect();
        if opts.len() < 2 {
            return Err(DistorrentError::Protocol(
                "enquete precisa de 2+ opções".into(),
            ));
        }
        let id = format!(
            "pl_{}",
            &crate::protocol::new_message_id(
                &me,
                community_id,
                crate::identity::now_ms(),
                question
            )[..24]
        );
        let p = crate::social::PollRow {
            id: id.clone(),
            community_id: community_id.into(),
            channel_id: channel_id.into(),
            question: cap_str(question, 200),
            options: opts.clone(),
            multi,
            author_fp: me,
            created_at: crate::identity::now_ms(),
            ends_at,
            closed: false,
        };
        self.store.poll_upsert(&p)?;
        self.events
            .send(EngineEvent::PollUpdated {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: id.clone(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::PollCreate {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: id,
                question: p.question.clone(),
                options: opts,
                multi,
                ends_at,
            },
        );
        Ok(p)
    }

    pub fn social_poll_vote(
        &self,
        community_id: &str,
        channel_id: &str,
        poll_id: &str,
        option_idx: i64,
    ) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let poll = self
            .store
            .poll_list(community_id, channel_id)?
            .into_iter()
            .find(|p| p.id == poll_id)
            .ok_or_else(|| DistorrentError::Protocol("enquete inexistente".into()))?;
        if poll.closed {
            return Err(DistorrentError::Protocol("enquete encerrada".into()));
        }
        if option_idx < 0 || option_idx as usize >= poll.options.len() {
            return Err(DistorrentError::Protocol("opção inválida".into()));
        }
        self.store.poll_vote(poll_id, &me, option_idx)?;
        self.events
            .send(EngineEvent::PollUpdated {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: poll_id.into(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::PollVote {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: poll_id.into(),
                option_idx,
            },
        );
        Ok(())
    }

    // Seção 28: social_event_upsert
    pub fn social_event_upsert(&self, ev: crate::social::EventRow) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(&ev.community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(DistorrentError::Protocol("só o dono cria eventos".into()));
        }
        let mut e = ev.clone();
        e.entity_fp = me;
        e.name = cap_str(&e.name, 100);
        e.location = cap_str(&e.location, 120);
        e.description = cap_str(&e.description, 500);
        self.store.event_upsert(&e)?;
        self.events
            .send(EngineEvent::EventUpdated {
                community_id: e.community_id.clone(),
                event_id: e.id.clone(),
            })
            .ok();
        let comm_id = e.community_id.clone();
        let frame_comm = comm_id.clone();
        self.broadcast_social(
            &comm_id,
            SecureFrame::EventUpsert {
                community_id: frame_comm,
                event: e,
            },
        );
        Ok(())
    }

    pub fn social_event_interest(&self, community_id: &str, event_id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        self.store.event_interest(community_id, event_id, &me)?;
        self.broadcast_social(
            community_id,
            SecureFrame::EventInterest {
                community_id: community_id.into(),
                event_id: event_id.into(),
            },
        );
        Ok(())
    }

    pub fn social_event_delete(&self, community_id: &str, event_id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(DistorrentError::Protocol("só o dono exclui eventos".into()));
        }
        self.store.event_delete(community_id, event_id)?;
        self.events
            .send(EngineEvent::EventUpdated {
                community_id: community_id.into(),
                event_id: event_id.into(),
            })
            .ok();
        Ok(())
    }

    pub fn social_emoji_upsert(&self, e: crate::social::EmojiRow) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(&e.community_id, &me) {
            return Err(DistorrentError::Protocol("sem permissão".into()));
        }
        let mut row = e;
        row.name = cap_str(&row.name, 32);
        row.char = cap_str(&row.char, 8);
        if row.name.is_empty() || row.char.is_empty() {
            return Err(DistorrentError::Protocol("emoji incompleto".into()));
        }
        self.store.emoji_upsert(&row)?;
        self.events
            .send(EngineEvent::EmojiUpdated {
                community_id: row.community_id.clone(),
                emoji_id: row.id.clone(),
            })
            .ok();
        let comm_id = row.community_id.clone();
        let frame_comm = comm_id.clone();
        self.broadcast_social(
            &comm_id,
            SecureFrame::EmojiUpsert {
                community_id: frame_comm,
                emoji: row,
            },
        );
        Ok(())
    }

    pub fn social_emoji_delete(&self, community_id: &str, id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol("sem permissão".into()));
        }
        self.store.emoji_delete(community_id, id)?;
        Ok(())
    }

    pub fn social_typing(&self, conv_id: &str) -> Result<()> {
        let until = crate::identity::now_ms() + 6_000;
        let frame = SecureFrame::Typing {
            conv_id: conv_id.to_string(),
            until_ms: until,
        };
        self.to_social_peers(conv_id, frame);
        Ok(())
    }

    pub fn reorder_channels(&self, community_id: &str, ids: &[String]) -> Result<()> {
        let me = &self.identity.fingerprint;
        let is_owner = self
            .store
            .get_community(community_id)
            .ok()
            .flatten()
            .map(|(_, _, owner)| owner == *me)
            .unwrap_or(false);
        if !is_owner && !self.is_moderator(community_id, me) {
            return Err(DistorrentError::Protocol(
                "sem permissão para reordenar".into(),
            ));
        }
        self.store.channels_reorder(community_id, ids)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    fn host_relay(
        &self,
        community_id: &str,
        channel_id: &str,
        env: &MessageEnvelope,
        bot_id: &str,
    ) -> Result<()> {
        for (fp, _nick, _role) in self.store.list_members(community_id)? {
            if fp == env.author_fp || fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::ChannelMsg {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                            env: env.clone(),
                            bot_id: bot_id.into(),
                        },
                    ))
                    .ok();
            }
        }
        if env.author_fp != self.identity.fingerprint && self.link_tx(&env.author_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    env.author_fp.clone(),
                    SecureFrame::ChannelAck {
                        env_id: env.id.clone(),
                    },
                ))
                .ok();
        }
        Ok(())
    }

    // Seção 29: flush_joins
    fn flush_joins(&self, peer_fp: &str) {
        let joins: Vec<(String, String)> = self
            .pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let now = crate::identity::now_ms();
        for (cid, token) in joins {
            let Some((host_fp, token_cid, member_fp, exp, sig)) =
                crate::protocol::parse_invite_token(&token).ok()
            else {
                self.clear_pending_join(&cid);
                continue;
            };
            const WILDCARD: &str = "000000000000";
            if token_cid != cid || (member_fp != WILDCARD && member_fp != self.identity.fingerprint)
            {
                self.clear_pending_join(&cid);
                continue;
            }
            if now > exp {
                self.clear_pending_join(&cid);
                let _ = self.events.send(EngineEvent::Error {
                    context: format!(
                        "o convite do servidor expirou antes de o dono responder — peça um novo token"
                    ),
                });
                continue;
            }
            if host_fp != peer_fp {
                continue;
            }
            let Some(host) = self.store.get_peer(peer_fp).ok().flatten() else {
                continue;
            };
            let valid_signature = Keypair::verify(
                &host.pubkey_hex,
                &crate::protocol::invite_sign_bytes(&cid, &member_fp, exp),
                &sig,
            )
            .unwrap_or(false);
            if !valid_signature {
                debug!(%peer_fp, %cid, "convite pendente descartado: assinatura inválida");
                self.clear_pending_join(&cid);
                let _ = self.events.send(EngineEvent::Error {
                    context: "o convite guardado não corresponde à chave do dono do servidor — peça um novo token".into(),
                });
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::JoinCommunity {
                        community_id: cid,
                        token,
                    },
                ))
                .ok();
        }
    }

    fn retry_pending_joins(&self) {
        let now = crate::identity::now_ms();
        let pending: Vec<(String, String)> = self
            .pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (cid, token) in pending {
            let Ok((host_fp, _token_cid, _member_fp, exp, _sig)) =
                crate::protocol::parse_invite_token(&token)
            else {
                self.clear_pending_join(&cid);
                continue;
            };
            if now > exp {
                self.clear_pending_join(&cid);
                continue;
            }
            if self.link_tx(&host_fp).is_none() {
                self.connect_to_community_peer(&host_fp);
                continue;
            }
            let should_send = {
                let mut retry = self.join_retry.lock().unwrap_or_else(|e| e.into_inner());
                let (last, tries) = retry.get(&cid).copied().unwrap_or((0, 0));
                let wait = 15_000i64.saturating_mul(1 << tries.min(3));
                if now.saturating_sub(last) >= wait {
                    retry.insert(cid.clone(), (now, tries.saturating_add(1)));
                    true
                } else {
                    false
                }
            };
            if should_send {
                self.send_join_to_host(&host_fp, &cid, &token);
            }
        }
    }

    fn flush_friend_requests(&self, peer_fp: &str) {
        if let Some((_, status)) = self.store.get_friend(peer_fp).ok().flatten() {
            match status.as_str() {
                "pending_out" => {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendRequest {
                                nickname: self.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                }
                "accepted" => {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendAccept {
                                nickname: self.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                }
                _ => {}
            }
        }
    }

    fn flush_pending_reacts(&self, peer_fp: &str) {
        let pending = self.store.take_pending_reacts(peer_fp).unwrap_or_default();
        if pending.is_empty() {
            return;
        }
        let me = self.identity.fingerprint.clone();
        for (conv_id, msg_id, emoji, add) in pending {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::React {
                        conv_id,
                        msg_id,
                        emoji,
                        add,
                        reactor_fp: me.clone(),
                    },
                ))
                .ok();
        }
    }

    // Seção 30: retry_pending_friend_request
    fn retry_pending_friend_request(&self, peer_fp: &str, incluir_aceite: bool) {
        let Some((_, status)) = self.store.get_friend(peer_fp).ok().flatten() else {
            return;
        };
        let frame = match status.as_str() {
            "pending_out" => SecureFrame::FriendRequest {
                nickname: self.identity.nickname.clone(),
            },
            "accepted" if incluir_aceite => SecureFrame::FriendAccept {
                nickname: self.identity.nickname.clone(),
            },
            _ => return,
        };
        self.cmd_tx
            .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
            .ok();
    }

    fn link_tx(&self, fp: &str) -> Option<mpsc::UnboundedSender<(u8, SecureFrame)>> {
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        let l = links.get(fp)?;
        if l.get_state() == PeerLinkState::Online {
            l.tx.clone()
        } else {
            None
        }
    }

    fn emit_state(&self) {
        let _ = self.events.send(EngineEvent::StateChanged {
            state: self.aggregated_state(),
            online_peers: self.online_peer_fps().len(),
        });
    }

    pub fn create_group(&self, title: &str, members: Vec<String>) -> Result<Conversation> {
        if members.is_empty() {
            return Err(DistorrentError::Protocol(
                "selecione ao menos 1 pessoa".into(),
            ));
        }
        if members.len() > 9 {
            return Err(DistorrentError::Protocol(
                "máximo 9 membros + você (10 total)".into(),
            ));
        }
        for fp in &members {
            let f = fp.trim();
            if f.is_empty() || f == self.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "fingerprint inválido para o grupo".into(),
                ));
            }
        }
        let conv = self
            .store
            .create_group_dm(&self.identity.fingerprint, &members, title)?;
        self.broadcast_group_created(&conv.id);
        Ok(conv)
    }

    fn broadcast_group_created(&self, conv_id: &str) {
        let members = self.store.list_group_members(conv_id).unwrap_or_default();
        let title = self
            .store
            .get_conversation(conv_id)
            .ok()
            .flatten()
            .map(|c| c.title)
            .unwrap_or_default();
        let me = self.identity.fingerprint.clone();
        let dono = self
            .store
            .group_owner(conv_id)
            .ok()
            .flatten()
            .unwrap_or_default();
        for (fp, _) in &members {
            if *fp == me {
                continue;
            }
            if self.link_tx(fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp.clone(),
                        SecureFrame::GroupCreated {
                            conv_id: conv_id.to_string(),
                            title: title.clone(),
                            members: members.clone(),
                            owner_fp: dono.clone(),
                        },
                    ))
                    .ok();
            }
        }
    }

    /// Só quem criou o grupo gerencia roster e nome. Antes, qualquer membro
    /// (ou o próprio peer removido, reenviando o frame) mudava o grupo de
    /// todos — a autorização ficava só na UI.
    fn require_group_owner(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let me = &self.identity.fingerprint;
        let dono = self.store.group_owner(conv_id)?.unwrap_or_default();
        if &dono != me {
            return Err(DistorrentError::Protocol(
                "só quem criou o grupo pode alterar membros".into(),
            ));
        }
        Ok(())
    }

    pub fn group_members(&self, conv_id: &str) -> Vec<(String, String)> {
        self.store.list_group_members(conv_id).unwrap_or_default()
    }

    pub fn group_add(&self, conv_id: &str, fp: &str) -> Result<()> {
        self.require_group_owner(conv_id)?;
        let fp = Self::normalize_peer_id(fp)?;
        if fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol("você já está no grupo".into()));
        }
        if self.store.is_blocked_fp(&fp) {
            return Err(DistorrentError::Protocol(
                "não é possível adicionar um peer bloqueado".into(),
            ));
        }
        let atuais = self.store.list_group_members(conv_id)?;
        if atuais.len() >= 10 {
            return Err(DistorrentError::Protocol(
                "máximo 9 membros + você (10 total)".into(),
            ));
        }
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        self.store.add_group_member(conv_id, &fp, "")?;
        let _ = crate::group_trash::restore(&self.store, conv_id);
        let members = self.store.list_group_members(conv_id)?;
        let title = conv.title.clone();
        let me = self.identity.fingerprint.clone();
        for (mfp, _) in &members {
            if *mfp == me {
                continue;
            }
            if self.link_tx(mfp).is_some() {
                if *mfp == fp {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            mfp.clone(),
                            SecureFrame::GroupCreated {
                                conv_id: conv_id.to_string(),
                                title: title.clone(),
                                members: members.clone(),
                                owner_fp: self.store.group_owner(conv_id)?.unwrap_or_default(),
                            },
                        ))
                        .ok();
                } else {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            mfp.clone(),
                            SecureFrame::GroupMemberAdded {
                                conv_id: conv_id.to_string(),
                                fp: fp.to_string(),
                                nickname: String::new(),
                            },
                        ))
                        .ok();
                }
            }
        }
        Ok(())
    }

    pub fn group_remove(&self, conv_id: &str, fp: &str) -> Result<()> {
        self.require_group_owner(conv_id)?;
        if fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "o criador não pode sair do próprio grupo".into(),
            ));
        }
        self.store.remove_group_member(conv_id, fp)?;
        self.broadcast_group_created(conv_id);
        Ok(())
    }

    // Seção 31: group_leave
    pub fn group_leave(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let me = self.identity.fingerprint.clone();
        let membros = self.store.list_group_members(conv_id)?;
        let sou_criador = self
            .store
            .group_owner(conv_id)?
            .map(|d| d == me)
            .unwrap_or(false);
        if sou_criador {
            return Err(DistorrentError::Protocol(
                "você criou este grupo — escolha apagar para todos ou só para você".into(),
            ));
        }
        let restantes: Vec<(String, String)> = membros
            .iter()
            .filter(|(fp, _)| fp != &me)
            .cloned()
            .collect();
        let titulo = conv.title.clone();
        for (fp, _) in &restantes {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp.clone(),
                    SecureFrame::GroupCreated {
                        conv_id: conv_id.to_string(),
                        title: titulo.clone(),
                        members: restantes.clone(),
                        owner_fp: self.store.group_owner(conv_id)?.unwrap_or_default(),
                    },
                ))
                .ok();
        }
        self.store.leave_group_local(conv_id)?;
        // Sair do grupo precisa marcar como dispensado como apagar "só para mim".
        // Sem isto, o próximo GroupCreated/sync de qualquer membro recriava o
        // grupo minutos depois — era o "saio e ele volta". O criador vai junto
        // porque a conversa some e só ele pode me readicionar de propósito.
        let dono = self.store.group_owner(conv_id)?.unwrap_or_default();
        let _ = crate::group_trash::dismiss_owned(&self.store, conv_id, &dono);
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: String::new(),
        });
        Ok(())
    }

    pub fn group_delete(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let me = self.identity.fingerprint.clone();
        let membros = self.store.list_group_members(conv_id)?;
        let sou_criador = self
            .store
            .group_owner(conv_id)?
            .map(|d| d == me)
            .unwrap_or(false);
        if !sou_criador {
            return Err(DistorrentError::Protocol(
                "só quem criou o grupo pode apagar para todos".into(),
            ));
        }
        for (fp, _) in membros.iter().filter(|(fp, _)| fp != &me) {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp.clone(),
                    SecureFrame::GroupDeleted {
                        conv_id: conv_id.to_string(),
                    },
                ))
                .ok();
        }
        self.store.leave_group_local(conv_id)?;
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: String::new(),
        });
        Ok(())
    }

    pub fn group_delete_local(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let membros = self.store.list_group_members(conv_id).unwrap_or_default();
        let dono = self.store.group_owner(conv_id)?.unwrap_or_default();
        self.store.leave_group_local(conv_id)?;
        let _ = crate::group_trash::dismiss_owned(&self.store, conv_id, &dono);
        let _ = membros;
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: String::new(),
        });
        Ok(())
    }

    pub fn group_rename(&self, conv_id: &str, title: &str) -> Result<()> {
        self.require_group_owner(conv_id)?;
        let nome = crate::names::sanitize_text(title, 64).trim().to_string();
        if nome.is_empty() {
            return Err(DistorrentError::Protocol("título vazio".into()));
        }
        self.store.update_conversation_title(conv_id, &nome)?;
        self.broadcast_group_created(conv_id);
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: nome,
        });
        Ok(())
    }

    pub fn call_invite(self: &Arc<Self>, target_fp: &str, kind: &str) -> Result<String> {
        let short = self
            .identity
            .fingerprint
            .get(..6)
            .unwrap_or(&self.identity.fingerprint)
            .to_string();
        let call_id = format!("call-{short}-{}", crate::identity::now_ms());
        self.store
            .create_call(&call_id, kind, target_fp, &self.identity.fingerprint)?;
        let _ = self.store.join_call(&call_id, &self.identity.fingerprint);
        self.queue_or_send_call_frame(
            target_fp,
            SecureFrame::CallInvite {
                call_id: call_id.clone(),
                kind: kind.into(),
                target_fp: target_fp.into(),
            },
        );
        #[cfg(target_os = "linux")]
        {
            self.voice_rearm();
            self.voice_retry_mic();
        }
        #[cfg(target_os = "linux")]
        if let Some(sdp) = self.voice_begin_offer(&call_id, target_fp)? {
            self.call_signal(
                target_fp,
                SecureFrame::CallOffer {
                    call_id: call_id.clone(),
                    sdp,
                },
            )?;
        }
        Ok(call_id)
    }

    pub fn call_ring_retry(&self, call_id: &str, target_fp: &str, kind: &str) -> Result<()> {
        if call_id.trim().is_empty() || target_fp.trim().is_empty() {
            return Err(DistorrentError::Protocol("call_id/alvo vazios".into()));
        }
        self.queue_or_send_call_frame(
            target_fp,
            SecureFrame::CallInvite {
                call_id: call_id.into(),
                kind: kind.into(),
                target_fp: target_fp.into(),
            },
        );
        Ok(())
    }

    // Seção 32: call_accept
    pub fn call_accept(self: &Arc<Self>, call_id: &str, from_fp: &str) -> Result<()> {
        self.store.join_call(call_id, &self.identity.fingerprint)?;
        self.store.join_call(call_id, from_fp)?;
        #[cfg(target_os = "linux")]
        self.voice_register(call_id, from_fp);
        self.queue_or_send_call_frame(
            from_fp,
            SecureFrame::CallAccept {
                call_id: call_id.into(),
            },
        );
        #[cfg(target_os = "linux")]
        {
            self.voice_rearm();
            self.voice_retry_mic();
        }
        #[cfg(target_os = "linux")]
        let _ = self.events.send(EngineEvent::CallAcceptedEv {
            call_id: call_id.into(),
            from_fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    pub fn call_reject(&self, call_id: &str, from_fp: &str, reason: &str) -> Result<()> {
        #[cfg(target_os = "linux")]
        self.forget_held_call(call_id);
        self.queue_or_send_call_frame(
            from_fp,
            SecureFrame::CallReject {
                call_id: call_id.into(),
                reason: reason.into(),
            },
        );
        Ok(())
    }

    pub fn call_end(&self, call_id: &str) -> Result<()> {
        #[cfg(target_os = "linux")]
        self.forget_held_call(call_id);
        let participants = self.store.call_participants(call_id).unwrap_or_default();
        for fp in participants {
            if fp == self.identity.fingerprint {
                continue;
            }
            self.queue_or_send_call_frame(
                &fp,
                SecureFrame::CallEnd {
                    call_id: call_id.into(),
                },
            );
        }
        self.store.end_call(call_id)?;
        #[cfg(target_os = "linux")]
        self.voice_hangup(call_id);
        let _ = self.events.send(EngineEvent::CallEnded {
            call_id: call_id.into(),
            from_fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    pub fn call_signal(&self, target_fp: &str, frame: SecureFrame) -> Result<()> {
        self.queue_or_send_call_frame(target_fp, frame);
        Ok(())
    }

    pub fn call_add_participant(
        self: &Arc<Self>,
        target_fp: &str,
        call_id: &str,
        fp: &str,
        kind: &str,
    ) -> Result<()> {
        let call_id = call_id.trim();
        let fp = fp.trim();
        if call_id.is_empty() || fp.is_empty() {
            return Err(DistorrentError::Protocol("call_id/fp vazios".into()));
        }
        let kind = crate::names::sanitize_text(kind.trim(), 16);
        let _ = self.store.join_call(call_id, fp);
        let _ = self.store.join_call(call_id, target_fp);
        #[cfg(target_os = "linux")]
        if self.voice_register(call_id, target_fp) && self.voice_register(call_id, fp) {
            if let Some(sdp) = self.voice_begin_offer(call_id, target_fp)? {
                self.call_signal(
                    target_fp,
                    SecureFrame::CallOffer {
                        call_id: call_id.into(),
                        sdp,
                    },
                )?;
            }
        }
        self.queue_or_send_call_frame(
            target_fp,
            SecureFrame::CallAddParticipant {
                call_id: call_id.into(),
                fp: fp.into(),
                kind,
            },
        );
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn voice(&self) -> Option<Arc<VoiceMedia>> {
        self.voice_media()
    }

    #[cfg(target_os = "linux")]
    pub(super) fn voice_media(&self) -> Option<Arc<VoiceMedia>> {
        self.voice.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[cfg(target_os = "linux")]
    pub fn native_voice_available(&self) -> bool {
        self.voice_media().is_some()
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_test_start(&self) -> Result<u64> {
        self.voice_media()
            .ok_or_else(|| DistorrentError::Protocol("voz nativa indisponível".into()))?
            .mic_test_start()
            .map_err(DistorrentError::Protocol)
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_test_level(&self, id: u64) -> f32 {
        self.voice_media()
            .map(|v| v.mic_test_level(id))
            .unwrap_or(0.0)
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_test_stop(&self, id: u64) {
        if let Some(v) = self.voice_media() {
            v.mic_test_stop(id);
        }
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_name(&self) -> String {
        self.voice_media().map(|v| v.mic_name()).unwrap_or_default()
    }

    #[cfg(target_os = "linux")]
    pub(super) fn voice_is_native(&self, call_id: &str, peer_fp: &str) -> bool {
        self.voice_media().is_some()
            && self
                .voice_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(call_id)
                .is_some_and(|peers| peers.contains(peer_fp))
    }

    #[cfg(target_os = "linux")]
    fn voice_register(self: &Arc<Self>, call_id: &str, peer_fp: &str) -> bool {
        if self.voice_media().is_none() {
            return false;
        }
        // Seção 33: first
        let first = self
            .voice_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(call_id.to_string())
            .or_default()
            .insert(peer_fp.to_string());
        if first {
            self.spawn_voice_signal_drainer(call_id, peer_fp);
        }
        true
    }

    #[cfg(target_os = "linux")]
    fn voice_forget_call(&self, call_id: &str) {
        self.voice_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(call_id);
    }

    #[cfg(target_os = "linux")]
    pub(super) fn auto_register_voice_channel(
        self: &Arc<Self>,
        call_id: &str,
        peer_fp: &str,
    ) -> bool {
        let Some((community_id, _channel_id)) = self
            .voice_channel_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(call_id)
            .cloned()
        else {
            return false;
        };
        if self.store.member_role(&community_id, peer_fp).is_none() {
            return false;
        }
        self.voice_register(call_id, peer_fp)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn native_pair_begin(self: &Arc<Self>, call_id: &str, peer_fp: &str) {
        if !self.voice_register(call_id, peer_fp) {
            return;
        }
        if self.identity.fingerprint.as_str() <= peer_fp {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            if let Ok(Some(sdp)) = self.voice_begin_offer(call_id, peer_fp) {
                let _ = self.call_signal(
                    peer_fp,
                    SecureFrame::CallOffer {
                        call_id: call_id.into(),
                        sdp,
                    },
                );
            }
            return;
        }
        let engine = self.clone();
        let cid = call_id.to_string();
        let peer = peer_fp.to_string();
        tokio::spawn(async move {
            let e2 = engine.clone();
            let (c, p) = (cid.clone(), peer.clone());
            let r = tokio::task::spawn_blocking(move || e2.voice_begin_offer(&c, &p)).await;
            if let Ok(Ok(Some(sdp))) = r {
                let _ = engine.call_signal(&peer, SecureFrame::CallOffer { call_id: cid, sdp });
            }
        });
    }

    #[cfg(target_os = "linux")]
    pub(super) fn voice_flush_signals(&self, call_id: &str, peer_fp: &str) {
        let Some(v) = self.voice_media() else { return };
        let signals = v.drain_outbound(call_id, peer_fp);
        if signals.is_empty() {
            return;
        }
        for s in signals {
            let frame = match s {
                OutboundSignal::Offer { sdp } => SecureFrame::CallOffer {
                    call_id: call_id.into(),
                    sdp,
                },
                OutboundSignal::Answer { sdp } => SecureFrame::CallAnswer {
                    call_id: call_id.into(),
                    sdp,
                },
                OutboundSignal::Ice { candidate, mid } => SecureFrame::CallIce {
                    call_id: call_id.into(),
                    candidate,
                    mid,
                },
            };
            let _ = self.call_signal(peer_fp, frame);
        }
    }

    #[cfg(target_os = "linux")]
    fn voice_begin_offer(self: &Arc<Self>, call_id: &str, peer_fp: &str) -> Result<Option<String>> {
        if !self.voice_register(call_id, peer_fp) {
            return Ok(None);
        }
        let Some(v) = self.voice_media() else {
            return Ok(None);
        };
        let offer = match in_multi_thread_runtime() {
            true => tokio::task::block_in_place(move || v.create_offer(call_id, peer_fp)),
            false => v.create_offer(call_id, peer_fp),
        };
        match offer {
            Ok(sdp) => {
                self.voice_flush_signals(call_id, peer_fp);
                Ok(Some(sdp))
            }
            Err(e) => {
                warn!("voz nativa: offer falhou para {peer_fp} ({e}) — sinalização segue no navegador");
                let sessao_viva = self
                    .voice_media()
                    .map(|v| v.stats_peer(call_id, peer_fp).is_some())
                    .unwrap_or(false);
                if sessao_viva {
                    warn!("voz nativa: {call_id}/{peer_fp} mantém a sessão apesar da offer falhar");
                } else if let Some(peers) = self
                    .voice_calls
                    .lock()
                    .unwrap_or_else(|x| x.into_inner())
                    .get_mut(call_id)
                {
                    peers.remove(peer_fp);
                }
                Ok(None)
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) async fn voice_absorb_offer(
        &self,
        call_id: &str,
        peer_fp: &str,
        sdp: &str,
    ) -> Result<bool> {
        if !self.voice_is_native(call_id, peer_fp) {
            return Ok(false);
        }
        let Some(v) = self.voice_media() else {
            return Ok(false);
        };
        let (cid, pfp, s) = (
            call_id.to_string(),
            peer_fp.to_string(),
            unwrap_wire_sdp(sdp),
        );
        // Seção 34: res
        let res = tokio::task::spawn_blocking(move || v.handle_offer(&cid, &pfp, &s)).await;
        match res {
            Ok(Ok(answer)) => {
                let _ = self.call_signal(
                    peer_fp,
                    SecureFrame::CallAnswer {
                        call_id: call_id.into(),
                        sdp: answer,
                    },
                );
                self.voice_flush_signals(call_id, peer_fp);
                Ok(true)
            }
            _ => {
                warn!("voz nativa: offer rejeitado de {peer_fp} — devolvendo ao navegador");
                Ok(false)
            }
        }
    }

    #[cfg(target_os = "linux")]
    async fn voice_absorb_answer(&self, call_id: &str, peer_fp: &str, sdp: &str) -> bool {
        if !self.voice_is_native(call_id, peer_fp) {
            return false;
        }
        let Some(v) = self.voice_media() else {
            return false;
        };
        let (cid, pfp, s) = (
            call_id.to_string(),
            peer_fp.to_string(),
            unwrap_wire_sdp(sdp),
        );
        let res = tokio::task::spawn_blocking(move || v.handle_answer(&cid, &pfp, &s)).await;
        let ok = matches!(res, Ok(Ok(())));
        self.voice_flush_signals(call_id, peer_fp);
        ok
    }

    #[cfg(target_os = "linux")]
    pub(super) async fn voice_absorb_ice(
        &self,
        call_id: &str,
        peer_fp: &str,
        cand: &str,
        mid: &str,
    ) -> bool {
        if !self.voice_is_native(call_id, peer_fp) {
            return false;
        }
        let Some(v) = self.voice_media() else {
            return false;
        };
        let (cand, mid) = unwrap_wire_candidate(cand, mid);
        let mid_log = mid.clone();
        let (cid, pfp) = (call_id.to_string(), peer_fp.to_string());
        let res =
            tokio::task::spawn_blocking(move || v.add_ice_candidate(&cid, &pfp, &cand, &mid)).await;
        let ok = matches!(res, Ok(Ok(())));
        if !ok {
            tracing::debug!(
                call_id = %call_id,
                peer = %peer_fp,
                mid = %mid_log,
                "candidato ICE nativo recusado (formato do fio inválido)"
            );
        }
        self.voice_flush_signals(call_id, peer_fp);
        ok
    }

    #[cfg(target_os = "linux")]
    pub fn voice_media_available(&self) -> bool {
        self.native_voice_available()
    }

    #[cfg(target_os = "linux")]
    pub fn voice_media_stats(&self, call_id: &str) -> Option<VoiceStats> {
        self.voice_media().and_then(|v| v.stats_agg(call_id))
    }

    #[cfg(target_os = "linux")]
    pub fn voice_set_muted(&self, call_id: &str, muted: bool) {
        if let Some(v) = self.voice_media() {
            v.set_muted(call_id, muted);
        }
    }

    #[cfg(target_os = "linux")]
    pub fn voice_hangup(&self, call_id: &str) {
        if let Some(v) = self.voice_media() {
            v.hangup(call_id);
        }
        self.voice_forget_call(call_id);
    }

    #[cfg(target_os = "linux")]
    pub fn native_video_start(
        &self,
        call_id: &str,
        peer_fp: &str,
        source: &str,
        monitor_id: Option<u32>,
    ) -> std::result::Result<String, String> {
        let v = self
            .voice_media()
            .ok_or_else(|| "voz nativa indisponivel".to_string())?;
        v.video_start(call_id, peer_fp, source, monitor_id)
    }

    #[cfg(target_os = "linux")]
    pub fn native_video_stop(&self, call_id: &str, peer_fp: &str) {
        if let Some(v) = self.voice_media() {
            v.video_stop(call_id, peer_fp);
        }
    }

    #[cfg(target_os = "linux")]
    pub fn native_video_frame(
        &self,
        call_id: &str,
        peer_fp: &str,
    ) -> Option<crate::net::media_voice::VideoFrame> {
        self.voice_media()
            .and_then(|v| v.video_frame(call_id, peer_fp))
    }

    #[cfg(target_os = "linux")]
    pub fn voice_retry_mic(&self) {
        if let Some(v) = self.voice_media() {
            v.retry_mic();
        }
    }

    fn is_call_frame(frame: &SecureFrame) -> bool {
        matches!(
            frame,
            SecureFrame::CallInvite { .. }
                | SecureFrame::CallAccept { .. }
                | SecureFrame::CallReject { .. }
                | SecureFrame::CallEnd { .. }
                | SecureFrame::CallOffer { .. }
                | SecureFrame::CallAnswer { .. }
                | SecureFrame::CallIce { .. }
                | SecureFrame::CallAddParticipant { .. }
                | SecureFrame::CallRoom { .. }
                | SecureFrame::ScreenShareOffer { .. }
                | SecureFrame::ScreenShareAnswer { .. }
        )
    }

    const PENDING_CALL_MAX: usize = 512;

    fn evict_call_frame(q: &mut Vec<SecureFrame>) {
        if Self::evict_one(q, |f| matches!(f, SecureFrame::CallIce { .. })) {
            return;
        }
        if Self::evict_one(q, |f| {
            matches!(
                f,
                SecureFrame::CallEnd { .. } | SecureFrame::CallInvite { .. }
            )
        }) {
            return;
        }
        // Seção 35: newest_offer
        let newest_offer = q.iter().rposition(Self::is_offer_frame);
        let newest_answer = q.iter().rposition(Self::is_answer_frame);
        let victim = (0..q.len()).find(|i| {
            if Self::is_offer_frame(&q[*i]) {
                Some(*i) != newest_offer
            } else if Self::is_answer_frame(&q[*i]) {
                Some(*i) != newest_answer
            } else {
                true
            }
        });
        if let Some(pos) = victim {
            q.remove(pos);
        }
    }

    fn evict_one(q: &mut Vec<SecureFrame>, pred: fn(&SecureFrame) -> bool) -> bool {
        match q.iter().position(pred) {
            Some(pos) => {
                q.remove(pos);
                true
            }
            None => false,
        }
    }

    fn is_offer_frame(f: &SecureFrame) -> bool {
        matches!(f, SecureFrame::CallOffer { .. })
    }

    fn is_answer_frame(f: &SecureFrame) -> bool {
        matches!(f, SecureFrame::CallAnswer { .. })
    }

    fn queue_or_send_call_frame(&self, peer_fp: &str, frame: SecureFrame) {
        if self.link_tx(peer_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.to_string(), frame))
                .ok();
            return;
        }
        self.enqueue_call_frame(peer_fp, frame);
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
            .ok();
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
            .ok();
    }

    fn ring_is_new(&self, call_id: &str, peer_fp: &str) -> bool {
        let mut vistos = self.ring_seen.lock().unwrap_or_else(|e| e.into_inner());
        if vistos.len() > 512 {
            vistos.clear();
        }
        vistos.insert(format!("{call_id}|{peer_fp}"))
    }

    fn enqueue_call_frame(&self, peer_fp: &str, frame: SecureFrame) {
        let mut map = self.pending_calls.lock().unwrap_or_else(|e| e.into_inner());
        let q = map.entry(peer_fp.to_string()).or_default();
        if q.len() >= Self::PENDING_CALL_MAX {
            Self::evict_call_frame(q);
            if q.len() >= Self::PENDING_CALL_MAX {
                q.remove(0);
            }
        }
        q.push(frame);
    }

    fn flush_pending_calls(&self, peer_fp: &str) {
        let frames: Vec<SecureFrame> = self
            .pending_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_fp)
            .unwrap_or_default();
        for f in frames {
            let _ = Self::is_call_frame(&f);
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.to_string(), f))
                .ok();
        }
    }

    pub fn voice_join(self: &Arc<Self>, community_id: &str, channel_id: &str) -> Result<()> {
        self.store.set_voice_state(
            community_id,
            channel_id,
            &self.identity.fingerprint,
            false,
            false,
        )?;
        let call_id = format!("voice-{}-{}", community_id, channel_id);
        self.voice_leave_other_channels(&call_id);
        #[cfg(target_os = "linux")]
        self.voice_channel_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                call_id.clone(),
                (community_id.to_string(), channel_id.to_string()),
            );
        for (fp, _, _) in self.store.list_members(community_id)? {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceJoin {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                        },
                    ))
                    .ok();
            }
        }
        let _ = self.events.send(EngineEvent::VoiceJoined {
            community_id: community_id.into(),
            channel_id: channel_id.into(),
            fp: self.identity.fingerprint.clone(),
        });
        #[cfg(target_os = "linux")]
        if self.native_voice_available() {
            for (fp, _, _) in self.store.list_voice_states(community_id, channel_id)? {
                if fp == self.identity.fingerprint {
                    continue;
                }
                self.voice_mesh_maybe_offer(community_id, channel_id, &fp);
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn voice_mesh_maybe_offer(
        self: &Arc<Self>,
        community_id: &str,
        channel_id: &str,
        peer_fp: &str,
    ) {
        if !self.native_voice_available() {
            return;
        }
        if self.identity.fingerprint.as_str() <= peer_fp {
            return;
        }
        let call_id = format!("voice-{community_id}-{channel_id}");
        if self.voice_is_native(&call_id, peer_fp) {
            return;
        }
        if !self.auto_register_voice_channel(&call_id, peer_fp) {
            return;
        }
        let engine = self.clone();
        let peer = peer_fp.to_string();
        tokio::spawn(async move {
            // Seção 36: e2
            let e2 = engine.clone();
            let cid = call_id.clone();
            let p = peer.clone();
            let r = tokio::task::spawn_blocking(move || e2.voice_begin_offer(&cid, &p)).await;
            if let Ok(Ok(Some(sdp))) = r {
                let _ = engine.call_signal(&peer, SecureFrame::CallOffer { call_id, sdp });
            }
        });
    }

    pub fn voice_leave(self: &Arc<Self>, community_id: &str, channel_id: &str) -> Result<()> {
        self.store
            .leave_voice(community_id, channel_id, &self.identity.fingerprint)?;
        let call_id = format!("voice-{}-{}", community_id, channel_id);
        #[cfg(not(target_os = "linux"))]
        let _ = &call_id;
        #[cfg(target_os = "linux")]
        {
            self.voice_channel_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&call_id);
            if self
                .voice_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&call_id)
            {
                self.voice_hangup(&call_id);
                self.voice_forget_call(&call_id);
            }
        }
        for (fp, _, _) in self.store.list_members(community_id)? {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceLeave {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                        },
                    ))
                    .ok();
            }
        }
        let _ = self.events.send(EngineEvent::VoiceLeft {
            community_id: community_id.into(),
            channel_id: channel_id.into(),
            fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    fn voice_leave_other_channels(&self, keep_call_id: &str) {
        let me = self.identity.fingerprint.clone();
        let mine = match self.store.my_voice_states(&me) {
            Ok(v) => v,
            Err(_) => return,
        };
        for (community_id, channel_id, _, _) in mine {
            let call_id = format!("voice-{community_id}-{channel_id}");
            if call_id == keep_call_id {
                continue;
            }
            #[cfg(target_os = "linux")]
            {
                self.voice_hangup(&call_id);
                self.voice_forget_call(&call_id);
                self.voice_channel_calls
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&call_id);
            }
            let _ = self.store.leave_voice(&community_id, &channel_id, &me);
            for (fp, _, _) in self.store.list_members(&community_id).unwrap_or_default() {
                if fp == me {
                    continue;
                }
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceLeave {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                        },
                    ))
                    .ok();
            }
            let _ = self.events.send(EngineEvent::VoiceLeft {
                community_id,
                channel_id,
                fp: me.clone(),
            });
        }
    }

    fn flush_voice_state_to(&self, peer_fp: &str) {
        let me = self.identity.fingerprint.clone();
        let Ok(mine) = self.store.my_voice_states(&me) else {
            return;
        };
        for (community_id, channel_id, muted, deafened) in mine {
            if self.store.member_role(&community_id, peer_fp).is_none() {
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::VoiceJoin {
                        community_id: community_id.clone(),
                        channel_id: channel_id.clone(),
                    },
                ))
                .ok();
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::VoiceState {
                        community_id: community_id.clone(),
                        channel_id: channel_id.clone(),
                        muted,
                        deafened,
                        speaking: false,
                    },
                ))
                .ok();
        }
    }

    fn reannounce_voice_channels(self: &Arc<Self>) {
        let me = self.identity.fingerprint.clone();
        let mine = match self.store.my_voice_states(&me) {
            Ok(v) => v,
            Err(_) => return,
        };
        for (community_id, channel_id, muted, deafened) in mine {
            for (fp, _, _) in self.store.list_members(&community_id).unwrap_or_default() {
                if fp == me {
                    continue;
                }
                if self.link_tx(&fp).is_none() {
                    continue;
                }
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp.clone(),
                        SecureFrame::VoiceJoin {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                        },
                    ))
                    .ok();
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceState {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                            muted,
                            deafened,
                            speaking: false,
                        },
                    ))
                    .ok();
            }
            #[cfg(target_os = "linux")]
            if self.native_voice_available() {
                for (fp, _, _) in self
                    .store
                    .list_voice_states(&community_id, &channel_id)
                    .unwrap_or_default()
                {
                    if fp == me {
                        continue;
                    }
                    self.voice_mesh_maybe_offer(&community_id, &channel_id, &fp);
                }
            }
        }
    }

    // Seção 37: drop_voice_presence_of
    fn drop_voice_presence_of(&self, peer_fp: &str) {
        let Ok(canais) = self.store.peer_voice_states(peer_fp) else {
            return;
        };
        for (community_id, channel_id) in canais {
            #[cfg(target_os = "linux")]
            let rota_viva = {
                let call_id = format!("voice-{community_id}-{channel_id}");
                let viva = self
                    .voice_media()
                    .and_then(|v| v.stats_peer(&call_id, peer_fp))
                    .map(|s| s.state == "connected")
                    .unwrap_or(false);
                if !viva {
                    self.voice_hangup_peer(&call_id, peer_fp);
                    self.voice_forget_peer(&call_id, peer_fp);
                }
                viva
            };
            #[cfg(not(target_os = "linux"))]
            let rota_viva = false;
            if rota_viva {
                continue;
            }
            let _ = self
                .store
                .drop_peer_voice_state(&community_id, &channel_id, peer_fp);
            let _ = self.events.send(EngineEvent::VoiceLeft {
                community_id,
                channel_id,
                fp: peer_fp.to_string(),
            });
        }
    }

    pub fn voice_state_update(
        &self,
        community_id: &str,
        channel_id: &str,
        muted: bool,
        deafened: bool,
    ) -> Result<()> {
        self.store.set_voice_state(
            community_id,
            channel_id,
            &self.identity.fingerprint,
            muted,
            deafened,
        )?;
        for (fp, _, _) in self.store.list_members(community_id)? {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceState {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                            muted,
                            deafened,
                            speaking: false,
                        },
                    ))
                    .ok();
            }
        }
        Ok(())
    }

    pub fn list_voice_states(
        &self,
        community_id: &str,
        channel_id: &str,
    ) -> Vec<(String, bool, bool)> {
        self.store
            .list_voice_states(community_id, channel_id)
            .unwrap_or_default()
    }

    pub fn file_announce(
        &self,
        file_id: &str,
        name: &str,
        size: u64,
        chunks: u32,
        hash: &str,
    ) -> Result<()> {
        self.store.announce_file(
            file_id,
            name,
            size as i64,
            chunks as i64,
            hash,
            &self.identity.fingerprint,
        )?;
        for fp in self.online_peer_fps() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::FileAnnounce {
                        file_id: file_id.into(),
                        name: name.into(),
                        size,
                        chunks,
                        hash: hash.into(),
                        chunk_hashes: None,
                    },
                ))
                .ok();
        }
        let _ = self
            .store
            .touch_file_seeded(file_id, crate::identity::now_ms());
        Ok(())
    }

    pub fn file_announce_with_chunks(
        &self,
        file_id: &str,
        name: &str,
        size: u64,
        chunks: u32,
        hash: &str,
        chunk_hashes: Vec<String>,
    ) -> Result<()> {
        self.store.announce_file(
            file_id,
            name,
            size as i64,
            chunks as i64,
            hash,
            &self.identity.fingerprint,
        )?;
        for fp in self.online_peer_fps() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::FileAnnounce {
                        file_id: file_id.into(),
                        name: name.into(),
                        size,
                        chunks,
                        hash: hash.into(),
                        chunk_hashes: Some(chunk_hashes.clone()),
                    },
                ))
                .ok();
        }
        let _ = self
            .store
            .touch_file_seeded(file_id, crate::identity::now_ms());
        Ok(())
    }

    // Seção 38: reannounce_files
    pub fn reannounce_files(&self) {
        let me = self.identity.fingerprint.clone();
        let Ok(arquivos) = self.store.my_seed_files(&me) else {
            return;
        };
        if arquivos.is_empty() {
            return;
        }
        let online = self.online_peer_fps();
        if online.is_empty() {
            return;
        }
        let now = crate::identity::now_ms();
        for (file_id, name, size, chunks, hash, seeded_at) in arquivos {
            if now.saturating_sub(seeded_at) < 30_000 && seeded_at != 0 {
                continue;
            }
            for fp in &online {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp.clone(),
                        SecureFrame::FileAnnounce {
                            file_id: file_id.clone(),
                            name: name.clone(),
                            size: size.max(0) as u64,
                            chunks: chunks.max(0) as u32,
                            hash: hash.clone(),
                            chunk_hashes: None,
                        },
                    ))
                    .ok();
            }
            let _ = self.store.touch_file_seeded(&file_id, now);
        }
    }

    pub fn flush_files_to(&self, peer_fp: &str) {
        let me = self.identity.fingerprint.clone();
        let Ok(arquivos) = self.store.my_seed_files(&me) else {
            return;
        };
        for (file_id, name, size, chunks, hash, _) in arquivos {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::FileAnnounce {
                        file_id,
                        name,
                        size: size.max(0) as u64,
                        chunks: chunks.max(0) as u32,
                        hash,
                        chunk_hashes: None,
                    },
                ))
                .ok();
        }
    }

    pub fn file_request_chunk(&self, file_id: &str, index: u32, holder_fp: &str) -> Result<()> {
        if self.link_tx(holder_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    holder_fp.into(),
                    SecureFrame::FileChunkRequest {
                        file_id: file_id.into(),
                        index,
                    },
                ))
                .ok();
            Ok(())
        } else {
            Err(DistorrentError::PeerNotConnected(holder_fp.into()))
        }
    }

    pub fn file_send_chunk(
        &self,
        target_fp: &str,
        file_id: &str,
        index: u32,
        data_b64: &str,
    ) -> Result<()> {
        if data_b64.len() > MAX_CHUNK_BYTES * 4 / 3 + 8 {
            return Err(DistorrentError::Protocol(
                "file_send_chunk: bloco acima do tamanho máximo".into(),
            ));
        }
        if self.link_tx(target_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    target_fp.into(),
                    SecureFrame::FileChunkData {
                        file_id: file_id.into(),
                        index,
                        data_b64: data_b64.into(),
                    },
                ))
                .ok();
            Ok(())
        } else {
            Err(DistorrentError::PeerNotConnected(target_fp.into()))
        }
    }
}

fn local_lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

fn stun_allowed(engine: &Arc<NetworkEngine>) -> bool {
    !matches!(engine.privacy_mode().as_str(), "proxy" | "full")
}

fn direct_inbound_allowed(engine: &Arc<NetworkEngine>) -> bool {
    !matches!(engine.privacy_mode().as_str(), "proxy" | "full")
}

fn punch_allowed_by_privacy(engine: &Arc<NetworkEngine>) -> bool {
    !matches!(engine.privacy_mode().as_str(), "proxy" | "full")
}

fn env_no_relay() -> bool {
    std::env::var("DISTORRENT_NO_RELAY")
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn env_relay_enabled() -> bool {
    if env_no_relay() {
        return false;
    }
    !matches!(
        std::env::var("DISTORRENT_RELAY")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0" | "false" | "no" | "off")
    )
}

pub fn peer_relay_optin_value(relay: Option<&str>, peer: Option<&str>, no_relay: bool) -> bool {
    if no_relay {
        return false;
    }
    fn off(v: Option<&str>) -> bool {
        matches!(
            v.map(|s| s.trim().to_ascii_lowercase()),
            Some(s) if matches!(s.as_str(), "0" | "false" | "no" | "off")
        )
    }
    if off(relay) || off(peer) {
        return false;
    }
    true
}

// Seção 39: env_peer_relay_enabled
fn env_peer_relay_enabled() -> bool {
    peer_relay_optin_value(
        std::env::var("DISTORRENT_RELAY").ok().as_deref(),
        std::env::var("DISTORRENT_PEER_RELAY").ok().as_deref(),
        env_no_relay(),
    )
}

fn env_punch_enabled() -> bool {
    let v = std::env::var("DISTORRENT_PUNCH").ok();
    punch_flag_value(v.as_deref())
}

fn punch_flag_value(v: Option<&str>) -> bool {
    match v {
        None => true,
        Some(s) => !matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
    }
}

fn auto_proxy_flag_value(v: Option<&str>) -> bool {
    match v {
        None => false,
        Some(s) => matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
    }
}

fn auto_proxy_enabled() -> bool {
    auto_proxy_flag_value(std::env::var("DISTORRENT_AUTO_PROXY").ok().as_deref())
}

fn announce_flag_value(v: Option<&str>) -> bool {
    match v {
        None => true,
        Some(s) => !matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
    }
}

fn announce_discovery_enabled() -> bool {
    announce_flag_value(std::env::var("DISTORRENT_NO_ANNOUNCE").ok().as_deref())
}

async fn nat_map_port(port: u16, ext_port: Arc<AtomicU16>) {
    let res = timeout(
        Duration::from_secs(8),
        tokio::task::spawn_blocking(move || -> std::result::Result<u16, String> {
            let opts = igd::SearchOptions {
                timeout: Some(Duration::from_secs(3)),
                ..Default::default()
            };
            match igd::search_gateway(opts) {
                Ok(gateway) => {
                    if let Ok(ext_ip) = gateway.get_external_ip() {
                        info!(%ext_ip, port, "UPnP: IP externo descoberto");
                    }
                    let socket = std::net::SocketAddrV4::new(std::net::Ipv4Addr::UNSPECIFIED, port);
                    match gateway.add_port(
                        igd::PortMappingProtocol::TCP,
                        port,
                        socket,
                        3600,
                        "DisTorrent P2P",
                    ) {
                        Ok(()) => Ok(port),
                        Err(e) => {
                            debug!("UPnP add_port falhou ({e}) — tentando NAT-PMP");
                            crate::net::natpmp::map_tcp(port, 3600)
                                .ok_or_else(|| format!("UPnP add_port: {e}; NAT-PMP sem resposta"))
                        }
                    }
                }
                Err(e) => {
                    debug!("UPnP indisponível ({e}) — tentando NAT-PMP");
                    crate::net::natpmp::map_tcp(port, 3600)
                        .ok_or_else(|| format!("UPnP: {e}; NAT-PMP sem resposta"))
                }
            }
        }),
    )
    .await;
    match res {
        Ok(Ok(Ok(ext))) => {
            ext_port.store(ext, Ordering::Relaxed);
            info!(
                internal = port,
                external = ext,
                "NAT: porta mapeada/renovada — direto sem abrir manual"
            );
        }
        Ok(Ok(Err(e))) => debug!("NAT map falhou (sem UPnP/NAT-PMP): {e}"),
        Ok(Err(e)) => debug!("NAT map spawn_blocking falhou: {e}"),
        Err(_) => debug!("NAT map timeout — segue hole punch/relay"),
    }
}

async fn tracker_lookup_and_dial(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    trackers: &[String],
) -> bool {
    for tr in trackers {
        let url = format!("{tr}/peers/{peer_fp}");
        let Ok(resp) = reqwest::Client::new()
            .get(&url)
            .timeout(Duration::from_secs(5))
            .send()
            .await
        else {
            tracing::debug!(tracker=%tr, fp=%peer_fp, "tracker sem resposta — segue para a próxima fonte de peers");
            continue;
        };
        if let Ok(body) = resp.json::<serde_json::Value>().await {
            let addr_opt = body
                .get("lan")
                .and_then(|v| v.as_str())
                .or_else(|| body.get("addr").and_then(|v| v.as_str()));
            if let Some(addr_str) = addr_opt {
                if let Ok(sock) = addr_str.parse::<SocketAddr>() {
                    info!(fp=%peer_fp, %addr_str, tracker=%tr, "outbound-first: peer no tracker — dial direto");
                    engine
                        .cmd_tx
                        .send(EngineCmd::ConnectTo(sock, Some(peer_fp.to_string())))
                        .ok();
                    return true;
                }
            }
        }
        tracing::debug!(tracker=%tr, fp=%peer_fp, "tracker respondeu sem endpoint utilizável");
    }
    false
}

async fn run_engine(engine: Arc<NetworkEngine>, discovery_enabled: bool) -> Result<()> {
    engine.refresh_relay_for_privacy();

    if let Err(e) = engine
        .store
        .clear_my_voice_states(&engine.identity.fingerprint)
    {
        tracing::debug!(error = %e, "não consegui limpar presença de voz antiga");
    }

    {
        for p in engine.store.list_peers().unwrap_or_default() {
            if let Some(addr) = p.addr.as_deref().and_then(|a| a.parse::<SocketAddr>().ok()) {
                if addr.port() != 0 {
                    engine
                        .cmd_tx
                        .send(EngineCmd::ConnectTo(addr, Some(p.fp.clone())))
                        .ok();
                }
            }
        }
        for status in ["accepted", "pending_out", "pending_in"] {
            for f in engine.store.list_friends(Some(status)).unwrap_or_default() {
                engine
                    .cmd_tx
                    .send(EngineCmd::ConnectRelay(f.fp.clone()))
                    .ok();
                engine
                    .cmd_tx
                    .send(EngineCmd::LookupAnnounce(f.fp.clone()))
                    .ok();
            }
        }
        engine.pair_all_groups_now();
        for (key, token) in engine
            .store
            .kv_list_prefix("join.pending.")
            .unwrap_or_default()
        {
            let Some(cid) = key.strip_prefix("join.pending.") else {
                continue;
            };
            // Seção 40: Ok
            let Ok((host_fp, token_cid, member_fp, exp, _sig)) =
                crate::protocol::parse_invite_token(&token)
            else {
                let _ = engine.store.kv_delete(&key);
                continue;
            };
            const WILDCARD: &str = "000000000000";
            if token_cid != cid
                || (member_fp != WILDCARD && member_fp != engine.identity.fingerprint)
                || crate::identity::now_ms() > exp
            {
                let _ = engine.store.kv_delete(&key);
                continue;
            }
            engine
                .pending_joins
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(cid.to_string(), token);
            engine.connect_to_community_peer(&host_fp);
        }
    }

    let listener = {
        let preferred: u16 = std::env::var("DISTORRENT_PORT")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|p: &u16| *p != 0)
            .unwrap_or(51413);
        let mut candidates: Vec<u16> = (0..10).map(|i| preferred.wrapping_add(i)).collect();
        candidates.push(0);
        let mut bound = None;
        for p in candidates {
            if p != 0
                && process_ports()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains(&p)
            {
                continue;
            }
            let attempt = (|| -> Result<tokio::net::TcpListener> {
                let sock = tokio::net::TcpSocket::new_v4()?;
                #[cfg(unix)]
                sock.set_reuseport(true)?;
                #[cfg(windows)]
                sock.set_reuseaddr(true)?;
                sock.bind(
                    format!("0.0.0.0:{p}")
                        .parse::<SocketAddr>()
                        .map_err(|e| DistorrentError::Protocol(format!("bind inválido: {e}")))?,
                )?;
                Ok(sock.listen(128)?)
            })();
            match attempt {
                Ok(l) => {
                    if p != 0 {
                        process_ports()
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(p);
                    }
                    bound = Some(l);
                    break;
                }
                Err(_) => continue,
            }
        }
        bound.ok_or_else(|| DistorrentError::Protocol("sem porta TCP livre".into()))?
    };
    let port = listener.local_addr()?.port();
    engine.listen_port.store(port, Ordering::Relaxed);
    info!(port, "listener TCP ativo");

    {
        let port_upnp = port;
        let ext_port = engine.nat_external_port.clone();
        let engine_nat = engine.clone();
        tokio::spawn(async move {
            let mut cancel = engine_nat.cancel_tx.subscribe();
            loop {
                if cancelled(&cancel) {
                    break;
                }
                if matches!(engine_nat.privacy_mode().as_str(), "proxy" | "full") {
                    debug!("upnp/nat-pmp suspenso: modo anônimo (proxy/full)");
                } else {
                    nat_map_port(port_upnp, ext_port.clone()).await;
                }
                tokio::select! {
                    _ = cancel.changed() => break,
                    _ = sleep(NAT_RENEW_INTERVAL) => {}
                }
            }
        });
    }

    {
        let engine_clone = engine.clone();
        let port_clone = port;
        tokio::spawn(async move {
            let trackers: Vec<String> = std::env::var("DISTORRENT_BOOTSTRAP_URL")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| s.starts_with("http"))
                .collect();
            if trackers.is_empty() {
                debug!(
                    "bootstrap: sem trackers HTTP — descoberta 100% P2P (LAN/mDNS/MQTT/hole-punch)"
                );
            } else {
                info!(
                    ?trackers,
                    "bootstrap: anunciando em {} tracker(s)",
                    trackers.len()
                );
            }
            let mut cancel = engine_clone.cancel_tx.subscribe();
            let mut tick = interval(Duration::from_secs(30));
            let last_announce = StdMutex::new(0i64);
            loop {
                if cancelled(&cancel) {
                    break;
                }
                tokio::select! {
                    _ = cancel.changed() => break,
                    _ = tick.tick() => {}
                }
                let privacy_mode = engine_clone
                    .store
                    .kv_get("privacy.mode")
                    .unwrap_or_else(|| "encrypted".to_string());
                if matches!(privacy_mode.as_str(), "proxy" | "full") {
                    continue;
                }
                let fp = engine_clone.identity.fingerprint.clone();
                let nickname = engine_clone.identity.nickname.clone();
                let public_ip: Option<String> = {
                    static UPNP_CACHE: std::sync::OnceLock<StdMutex<(Option<String>, i64)>> =
                        std::sync::OnceLock::new();
                    let cached = UPNP_CACHE
                        .get_or_init(|| StdMutex::new((None, 0)))
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    if crate::identity::now_ms() - cached.1 < 5 * 60 * 1000 {
                        cached.0
                    } else {
                        let upnp_ip = tokio::time::timeout(
                            Duration::from_secs(4),
                            tokio::task::spawn_blocking(|| {
                                igd::search_gateway(Default::default())
                                    .ok()
                                    .and_then(|g| g.get_external_ip().ok())
                            }),
                        )
                        .await
                        .ok()
                        .and_then(|r| r.ok())
                        .flatten()
                        .map(|ip| ip.to_string());
                        *UPNP_CACHE
                            .get_or_init(|| StdMutex::new((None, 0)))
                            .lock()
                            .unwrap_or_else(|e| e.into_inner()) =
                            (upnp_ip.clone(), crate::identity::now_ms());
                        upnp_ip
                    }
                };
                // Seção 41: announce_on
                let announce_on = announce_discovery_enabled();
                let ext_port = engine_clone.nat_external_port.load(Ordering::Relaxed);
                let stun_addr = if !announce_on {
                    None
                } else if ext_port == 0 {
                    let sa = crate::net::stun::stun_external_addr().await;
                    engine_clone.diag_record_net(|d| {
                        d.stun_ok = Some(sa.is_some());
                        d.stun_addr = sa.map(|s| s.to_string());
                        d.stun_ms = crate::identity::now_ms();
                    });
                    sa
                } else {
                    None
                };
                let announced: Option<(String, u16)> = if ext_port != 0 {
                    let ip = public_ip.or_else(|| stun_addr.map(|s| s.ip().to_string()));
                    ip.map(|ip| (format!("{ip}:{ext_port}"), ext_port))
                } else if let Some(ip) = public_ip {
                    Some((format!("{ip}:{port_clone}"), port_clone))
                } else {
                    None
                };
                engine_clone.diag_record_net(|d| {
                    d.announce_addr = announced.as_ref().map(|(a, _)| a.clone());
                    d.announce_ms = crate::identity::now_ms();
                    d.nat_source = announced.as_ref().map(|_| {
                        if ext_port != 0 {
                            "upnp".to_string()
                        } else {
                            "public-ip".to_string()
                        }
                    });
                });
                if relay_allowed(&engine_clone) {
                    let agora = crate::identity::now_ms();
                    if agora - *last_announce.lock().unwrap_or_else(|e| e.into_inner())
                        >= ANNOUNCE_REPUBLISH_MS
                    {
                        *last_announce.lock().unwrap_or_else(|e| e.into_inner()) = agora;
                        let lan = local_lan_ip().map(|ip| format!("{ip}:{port_clone}"));
                        let (pub_addr, pub_port) = announced
                            .as_ref()
                            .map(|(a, p)| (Some(a.clone()), Some(*p)))
                            .unwrap_or((None, None));
                        let ann = serde_json::json!({
                            "fp": fp, "addr": pub_addr, "lan": lan,
                            "nickname": nickname, "port": pub_port,
                        })
                        .to_string();
                        let ann_topic = crate::net::relay::announce_topic(&fp);
                        let abackend = active_relay_backend(&engine_clone);
                        tokio::spawn(async move {
                            abackend.post(&ann_topic, &ann).await.ok();
                        });
                    }
                }
                if let Some((addr, announced_port)) = announced {
                    if !trackers.is_empty() {
                        let payload = serde_json::json!({ "fp": fp, "addr": addr, "nickname": nickname, "port": announced_port });
                        let trackers_c = trackers.clone();
                        tokio::spawn(async move {
                            let client = reqwest::Client::new();
                            for tr in &trackers_c {
                                let url = format!("{tr}/announce");
                                match client
                                    .post(&url)
                                    .json(&payload)
                                    .timeout(Duration::from_secs(5))
                                    .send()
                                    .await
                                {
                                    Ok(_) => {
                                        tracing::debug!(tracker=%tr, "tracker: anúncio aceito")
                                    }
                                    Err(e) => {
                                        tracing::debug!(tracker=%tr, "tracker falhou ({e}) — descoberta segue por MQTT/LAN/hole-punch")
                                    }
                                }
                            }
                        });
                    }
                    debug!(%fp, %addr, stun = stun_addr.is_some(), "bootstrap announce");
                    *engine_clone
                        .public_addr
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some(addr.clone());
                    let nat_source = if stun_addr.is_some() { "stun" } else { "upnp" };
                    let _ = engine_clone.events.send(EngineEvent::NatEndpoint {
                        addr: addr.clone(),
                        source: nat_source.into(),
                    });
                }
                if let Ok(pending) = engine_clone.store.list_friends(Some("pending_out")) {
                    for peer in pending {
                        if announce_on && relay_allowed(&engine_clone) {
                            let ann_topic = crate::net::relay::announce_topic(&peer.fp);
                            let abackend = active_relay_backend(&engine_clone);
                            if let Ok(msgs) = abackend.poll(&ann_topic).await {
                                for raw in msgs.iter().rev().take(3) {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
                                        let f = v.get("fp").and_then(|x| x.as_str()).unwrap_or("");
                                        if f == peer.fp {
                                            let lan = v.get("lan").and_then(|x| x.as_str());
                                            let pubip = v.get("addr").and_then(|x| x.as_str());
                                            for cand in [lan, pubip].into_iter().flatten() {
                                                if cand.is_empty() || cand == "null" {
                                                    continue;
                                                }
                                                if let Ok(sock) = cand.parse::<SocketAddr>() {
                                                    info!(fp=%peer.fp, %sock, "direta: endpoint via anúncio — sem relay");
                                                    engine_clone
                                                        .cmd_tx
                                                        .send(EngineCmd::ConnectTo(
                                                            sock,
                                                            Some(peer.fp.clone()),
                                                        ))
                                                        .ok();
                                                    break;
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        let has_link = engine_clone
                            .links
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .contains_key(&peer.fp);
                        if !has_link {
                            engine_clone
                                .cmd_tx
                                .send(EngineCmd::ConnectRelay(peer.fp.clone()))
                                .ok();
                        }
                        tracker_lookup_and_dial(&engine_clone, &peer.fp, &trackers).await;
                    }
                }
                if let Ok(friends) = engine_clone.store.list_friends(Some("accepted")) {
                    for peer in friends {
                        if peer.fp == engine_clone.identity.fingerprint {
                            continue;
                        }
                        let (has_link, is_direct_online) = {
                            let links =
                                engine_clone.links.lock().unwrap_or_else(|e| e.into_inner());
                            match links.get(&peer.fp) {
                                None => (false, false),
                                Some(l) => {
                                    // Seção 42: online
                                    let online = l.get_state() == PeerLinkState::Online;
                                    (true, online && !l.via_relay)
                                }
                            }
                        };
                        if !is_direct_online {
                            tracker_lookup_and_dial(&engine_clone, &peer.fp, &trackers).await;
                            engine_clone
                                .cmd_tx
                                .send(EngineCmd::LookupAnnounce(peer.fp.clone()))
                                .ok();
                            engine_clone.dht_probe(&peer.fp);
                        }
                        if !has_link {
                            engine_clone
                                .cmd_tx
                                .send(EngineCmd::ConnectRelay(peer.fp.clone()))
                                .ok();
                        }
                    }
                }
            }
        });
    }

    {
        let engine = engine.clone();
        tokio::spawn(async move {
            let mut cancel = engine.cancel_tx.subscribe();
            loop {
                if cancelled(&cancel) {
                    break;
                }
                let conn = tokio::select! {
                    _ = cancel.changed() => break,
                    c = listener.accept() => c,
                };
                match conn {
                    Ok((stream, peer)) => {
                        if !direct_inbound_allowed(&engine) {
                            debug!("inbound direto recusado: modo anônimo (proxy/full)");
                            continue;
                        }
                        if engine.netlimiter.allow_tcp_accept(peer.ip()) == Decision::Blocked {
                            debug!(%peer, "accept descartado: rate limit de TCP inbound");
                            continue;
                        }
                        let Some(hs_slot) = engine.netlimiter.try_handshake_slot() else {
                            debug!(%peer, "accept descartado: teto de handshakes concorrentes");
                            continue;
                        };
                        let engine = engine.clone();
                        tokio::spawn(async move {
                            let _hs_slot = hs_slot;
                            match crate::net::transport::handshake_with_fp(
                                stream,
                                engine.keypair.clone(),
                                &engine.nickname,
                                engine.listen_port(),
                                false,
                                Some(engine.identity.fingerprint.clone()),
                            )
                            .await
                            {
                                Ok(hs) => {
                                    register_and_run(
                                        engine,
                                        hs.session,
                                        &hs.peer_fp,
                                        &hs.peer_pubkey_hex,
                                        &hs.peer_nickname,
                                        false,
                                        false,
                                        hs.peer_proto_v,
                                        hs.transcript_hash.clone(),
                                    )
                                    .await;
                                }
                                Err(e) => debug!("handshake inbound falhou: {e}"),
                            }
                        });
                    }
                    Err(e) => {
                        warn!("accept erro: {e}");
                        sleep(Duration::from_millis(300)).await;
                    }
                }
            }
        });
    }

    let (disc_tx, mut disc_rx) = mpsc::unbounded_channel::<DiscoveredPeer>();
    let disc_allowed: Arc<dyn Fn() -> bool + Send + Sync> = {
        let engine = engine.clone();
        Arc::new(move || !matches!(engine.privacy_mode().as_str(), "proxy" | "full"))
    };
    let _discovery = if discovery_enabled {
        Some(
            Discovery::spawn(
                engine.keypair.clone(),
                engine.nickname.clone(),
                port,
                disc_tx.clone(),
                disc_allowed.clone(),
                engine.netlimiter.clone(),
            )
            .await?,
        )
    } else {
        None
    };

    #[cfg(not(target_os = "android"))]
    let _mdns = if discovery_enabled {
        match crate::net::mdns::MdnsDiscovery::spawn(
            engine.keypair.clone(),
            engine.nickname.clone(),
            port,
            disc_tx,
            disc_allowed,
        ) {
            Ok(m) => Some(m),
            Err(e) => {
                warn!("mDNS indisponível ({e}) — seguindo só com discovery UDP");
                None
            }
        }
    } else {
        None
    };

    {
        let engine_pex = engine.clone();
        tokio::spawn(crate::net::dht::spawn_pex(engine_pex));
    }

    {
        let engine_dht = engine.clone();
        tokio::spawn(crate::net::dht::spawn_bit_dht(engine_dht));
    }

    {
        let engine_relay = engine.clone();
        tokio::spawn(relay_manager_loop(engine_relay));
    }

    {
        let engine_prewarm = engine.clone();
        tokio::spawn(async move {
            if !relay_allowed(&engine_prewarm) {
                return;
            }
            let backend = active_relay_backend(&engine_prewarm);
            let my_fp = engine_prewarm.identity.fingerprint.clone();
            let _ = backend.poll(&relay_topic(&my_fp)).await;
            debug!("relay prewarm ok");
        });
    }

    // Seção 43: mut
    let mut flush_tick = interval(Duration::from_secs(5));
    let mut friend_tick = interval(Duration::from_secs(5));
    let mut friend_retry_tick: u32 = 0;
    let mut community_tick = interval(Duration::from_secs(15));
    let mut presence_tick = interval(Duration::from_secs(30));
    let mut profile_tick = interval(Duration::from_secs(PROFILE_SYNC_INTERVAL_SECS));
    loop {
        tokio::select! {
            Some(peer) = disc_rx.recv() => {
                if peer.fp == engine.identity.fingerprint { continue; }
                if matches!(engine.privacy_mode().as_str(), "proxy" | "full") {
                    continue;
                }
                let addr_str = peer.addr.to_string();
                let record = PeerRecord {
                    fp: peer.fp.clone(),
                    pubkey_hex: peer.pubkey_hex.clone(),
                    nickname: peer.nickname.clone(),
                    addr: Some(addr_str.clone()),
                    last_seen: crate::identity::now_ms(),
                    origin: "discovery".into(),
                };
                let _ = engine.store.upsert_peer(&record);
                let should_dial_direct = {
                    match engine.links.lock().unwrap_or_else(|e| e.into_inner()).get(&peer.fp) {
                        None => true,
                        Some(l) => l.via_relay && l.get_state() == PeerLinkState::Online,
                    }
                };
                let _ = engine.events.send(EngineEvent::PeerDiscovered {
                    fp: peer.fp.clone(),
                    nickname: peer.nickname.clone(),
                    addr: addr_str,
                });
                if should_dial_direct {
                    engine.cmd_tx.send(EngineCmd::ConnectTo(peer.addr, Some(peer.fp))).ok();
                }
            }
            _ = flush_tick.tick() => {
                engine.tunnel_reap_stale();
                engine.reap_half_open_links();
                let cutoff = crate::identity::now_ms() - 20_000;
                for fp in engine.online_peer_fps() {
                    if let Ok(ids) = engine.store.revert_stale_sent_to_pending(&fp, cutoff) {
                        for id in ids {
                            let _ = engine.events.send(EngineEvent::MessageStatus { msg_id: id, status: "pending".into() });
                        }
                    }
                    engine.cmd_tx.send(EngineCmd::FlushOutbox(fp)).ok();
                }
            }
            _ = friend_tick.tick() => {
                friend_retry_tick = friend_retry_tick.wrapping_add(1);
                let reaceita = friend_retry_tick % 3 == 0;
                for fp in engine.online_peer_fps() {
                    engine.retry_pending_friend_request(&fp, reaceita);
                }
            }
            _ = community_tick.tick() => {
                engine.maintain_communities();
                engine.maintain_groups();
                engine.reannounce_voice_channels();
                engine.reannounce_files();
                engine.room_tick_arc();
            }
            _ = presence_tick.tick() => {
                let me = engine.identity.fingerprint.clone();
                if let Ok(mut presence) = engine.store.presence_get_live(&me) {
                    let status = if presence.status.is_empty() || presence.status == "offline" {
                        "online".to_string()
                    } else {
                        presence.status.clone()
                    };
                    presence.status = status.clone();
                    if engine.store.presence_set(
                        &me,
                        &status,
                        &presence.custom,
                        &presence.custom_emoji,
                    ).is_ok() {
                        engine.announce_presence();
                    }
                }
            }
            _ = profile_tick.tick() => {
                engine.sync_profiles_with_peers();
            }
        }
    }
}

async fn command_loop(engine: Arc<NetworkEngine>, mut rx: mpsc::UnboundedReceiver<EngineCmd>) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            EngineCmd::ConnectTo(addr, expected_fp) => {
                let key = format!("{}@{addr}", expected_fp.as_deref().unwrap_or(""));
                let fresh = {
                    let mut set = engine
                        .direct_maintains
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if set.len() > 4096 {
                        set.clear();
                    }
                    set.insert(key)
                };
                if fresh {
                    let engine = engine.clone();
                    tokio::spawn(async move {
                        connect_and_maintain(engine, ConnTarget::Addr(addr), expected_fp).await
                    });
                }
            }
            EngineCmd::ConnectHost {
                host,
                port,
                expected_fp,
            } => {
                let key = format!("{}@{host}:{port}", expected_fp.as_deref().unwrap_or(""));
                let fresh = {
                    let mut set = engine
                        .direct_maintains
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if set.len() > 4096 {
                        set.clear();
                    }
                    set.insert(key)
                };
                if fresh {
                    let engine = engine.clone();
                    tokio::spawn(async move {
                        connect_and_maintain(engine, ConnTarget::Host(host, port), expected_fp)
                            .await
                    });
                }
            }
            EngineCmd::ConnectRelay(fp) => {
                let fresh = engine
                    .relay_maintains
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(fp.clone());
                if fresh {
                    let engine = engine.clone();
                    tokio::spawn(async move { connect_relay_and_maintain(engine, fp).await });
                }
            }
            EngineCmd::LookupAnnounce(fp) => {
                announce_lookup_once(engine.clone(), fp);
            }
            EngineCmd::PunchDial {
                fp,
                endpoint,
                at_ms,
            } => {
                // Seção 44: engine
                let engine = engine.clone();
                tokio::spawn(async move { punch_and_register(engine, fp, endpoint, at_ms).await });
            }
            EngineCmd::SendToPeer(fp, frame) => {
                if !matches!(
                    frame,
                    SecureFrame::TunnelOffer { .. }
                        | SecureFrame::TunnelAnswer { .. }
                        | SecureFrame::TunnelData { .. }
                ) && engine.tunnel_should_carry(&fp)
                {
                    if engine.tunnel_send_frame(&fp, &frame) {
                        continue;
                    }
                }
                let link = engine
                    .links
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&fp)
                    .cloned();
                let msg_falhou = match &frame {
                    SecureFrame::Msg(env) => engine
                        .store
                        .get_conversation(&env.conv_id)
                        .ok()
                        .flatten()
                        .map(|c| (env.id.clone(), c.peer_fp, c.kind)),
                    SecureFrame::ChannelMsg { env, .. } => {
                        Some((env.id.clone(), fp.clone(), "channel".to_string()))
                    }
                    _ => None,
                };
                let mut entregue = false;
                let reserva = if NetworkEngine::is_call_frame(&frame) {
                    Some(frame.clone())
                } else {
                    None
                };
                if let Some(l) = link {
                    if let Some(tx) = &l.tx {
                        entregue = tx.send((frame_class(&frame), frame)).is_ok();
                    }
                }
                if !entregue {
                    if let Some((msg_id, peer, kind)) = msg_falhou {
                        match kind.as_str() {
                            "dm" => {
                                let _ = engine.store.enqueue_outbox_kind(&msg_id, &peer, "dm");
                                let _ = engine.store.set_message_status(&msg_id, "pending");
                                let _ = engine.events.send(EngineEvent::MessageStatus {
                                    msg_id,
                                    status: "pending".into(),
                                });
                            }
                            "channel" if !peer.is_empty() => {
                                let _ = engine.store.enqueue_outbox_kind(&msg_id, &peer, "channel");
                                let _ = engine.store.set_message_status(&msg_id, "pending");
                                let _ = engine.events.send(EngineEvent::MessageStatus {
                                    msg_id,
                                    status: "pending".into(),
                                });
                            }
                            _ => {
                                let _ = engine.store.set_message_status(&msg_id, "pending");
                                let _ = engine.events.send(EngineEvent::MessageStatus {
                                    msg_id,
                                    status: "pending".into(),
                                });
                            }
                        }
                    }
                    drop_link_if_dead(&engine, &fp);
                    if let Some(f) = reserva {
                        engine.enqueue_call_frame(&fp, f);
                    }
                }
            }
            EngineCmd::FlushOutbox(fp) => {
                for id in engine.store.give_up_outbox(&fp).unwrap_or_default() {
                    engine.diag_update(&fp, |d| {
                        d.send_gave_up = d.send_gave_up.saturating_add(1);
                    });
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id: id,
                        status: "failed".into(),
                    });
                }
                let pending = engine.store.pending_outbox(&fp).unwrap_or_default();
                for msg_id in pending {
                    let Some(m) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                        continue;
                    };
                    let env = MessageEnvelope {
                        id: m.id.clone(),
                        conv_id: m.conv_id.clone(),
                        author_fp: m.author_fp.clone(),
                        body: m.body.clone(),
                        ts: m.ts,
                        sig: m.sig.clone(),
                    };
                    let frame = if engine.store.outbox_kind(&m.id) == "channel" {
                        let community = engine
                            .store
                            .channel_community(&m.conv_id)
                            .ok()
                            .flatten()
                            .unwrap_or_default();
                        if community.is_empty() {
                            continue;
                        }
                        SecureFrame::ChannelMsg {
                            community_id: community,
                            channel_id: m.conv_id.clone(),
                            env,
                            bot_id: String::new(),
                        }
                    } else {
                        SecureFrame::Msg(env)
                    };
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(fp.clone(), frame))
                        .ok();
                    engine.store.bump_outbox(&m.id).ok();
                    engine.store.set_message_status(&m.id, "sending").ok();
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id: m.id,
                        status: "sending".into(),
                    });
                }
                flush_group_to_peer(&engine, &fp);
                engine.flush_pending_reacts(&fp);
            }
        }
    }
}

fn flush_group_to_peer(engine: &Arc<NetworkEngine>, peer_fp: &str) {
    let me = engine.identity.fingerprint.clone();
    if let Ok(groups) = engine.store.group_convs_with_peer(peer_fp) {
        for (conv_id, title, members) in groups {
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::GroupCreated {
                        conv_id: conv_id.clone(),
                        title,
                        members,
                        owner_fp: engine
                            .store
                            .group_owner(&conv_id)
                            .ok()
                            .flatten()
                            .unwrap_or_default(),
                    },
                ))
                .ok();
        }
    }
    // Seção 45: pending
    let pending = match engine.store.pending_group_messages() {
        Ok(p) => p,
        Err(_) => return,
    };
    for m in pending {
        if m.author_fp != me {
            continue;
        }
        let members = engine
            .store
            .list_group_members(&m.conv_id)
            .unwrap_or_default();
        if members.iter().all(|(fp, _)| fp != peer_fp) {
            continue;
        }
        let env = MessageEnvelope {
            id: m.id.clone(),
            conv_id: m.conv_id.clone(),
            author_fp: m.author_fp.clone(),
            body: m.body.clone(),
            ts: m.ts,
            sig: m.sig.clone(),
        };
        engine
            .cmd_tx
            .send(EngineCmd::SendToPeer(
                peer_fp.to_string(),
                SecureFrame::Msg(env),
            ))
            .ok();
        engine.store.set_message_status(&m.id, "sending").ok();
        let _ = engine.events.send(EngineEvent::MessageStatus {
            msg_id: m.id,
            status: "sending".into(),
        });
    }
}

#[derive(Debug, Clone)]
enum ConnTarget {
    Addr(SocketAddr),
    Host(String, u16),
}

async fn resolve_and_connect(host: &str, port: u16) -> Result<TcpStream> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| DistorrentError::Protocol(format!("DNS de {host} falhou: {e}")))?
        .collect();
    let mut last = DistorrentError::Protocol("sem endereço".into());
    for sa in addrs {
        match timeout(CONNECT_TIMEOUT, TcpStream::connect(sa)).await {
            Ok(Ok(s)) => return Ok(s),
            Ok(Err(e)) => last = DistorrentError::Protocol(format!("connect {sa}: {e}")),
            Err(_) => last = DistorrentError::Protocol("connect timeout".into()),
        }
    }
    Err(last)
}

async fn connect_and_maintain(
    engine: Arc<NetworkEngine>,
    target: ConnTarget,
    expected_fp: Option<String>,
) {
    let mut backoff = Duration::from_secs(1);
    let cancel = engine.cancel_tx.subscribe();
    loop {
        if cancelled(&cancel) {
            return;
        }
        let dial_slot = match engine.netlimiter.try_dial_slot() {
            Some(g) => g,
            None => {
                sleep(Duration::from_millis(400)).await;
                continue;
            }
        };
        if let Some(fp) = &expected_fp {
            set_link_state(&engine, fp, PeerLinkState::Connecting);
        }

        let attempt = async {
            let privacy_mode = engine
                .store
                .kv_get("privacy.mode")
                .unwrap_or_else(|| "encrypted".to_string());
            let use_tor = privacy_mode == "full";
            let use_proxy = privacy_mode == "proxy" || use_tor;
            let socks_target = match &target {
                ConnTarget::Addr(sa) => SocksTarget::Addr(*sa),
                ConnTarget::Host(h, p) => SocksTarget::Host(h.clone(), *p),
            };
            let stream: TcpStream = if use_proxy {
                let proxy_addr = if use_tor {
                    std::env::var("DISTORRENT_TOR_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:9050".to_string())
                } else {
                    std::env::var("DISTORRENT_PROXY_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:1080".to_string())
                };
                match timeout(CONNECT_TIMEOUT, socks5_connect(&proxy_addr, &socks_target)).await {
                    Ok(Ok(s)) => s,
                    Ok(Err(e)) => {
                        debug!(
                            proxy = %proxy_addr,
                            "proxy falhou ({e}) — SEM fallback direto (modo anônimo fail-closed)"
                        );
                        return Err(e);
                    }
                    Err(_) => {
                        return Err(DistorrentError::Protocol("proxy connect timeout".into()))
                    }
                }
            } else {
                match &target {
                    ConnTarget::Addr(sa) => timeout(CONNECT_TIMEOUT, TcpStream::connect(*sa))
                        .await
                        .map_err(|_| DistorrentError::Protocol("connect timeout".into()))??,
                    ConnTarget::Host(h, p) => resolve_and_connect(h, *p).await?,
                }
            };
            let hs = crate::net::transport::handshake_with_fp(
                stream,
                engine.keypair.clone(),
                &engine.nickname,
                engine.listen_port(),
                true,
                Some(engine.identity.fingerprint.clone()),
            )
            .await?;
            if let Some(want) = &expected_fp {
                if &hs.peer_fp != want {
                    return Err(DistorrentError::Protocol(format!(
                        "peer apresentou {} mas esperávamos {want}",
                        hs.peer_fp
                    )));
                }
            }
            Ok::<_, DistorrentError>(hs)
        };

        match attempt.await {
            Ok(hs) => {
                backoff = Duration::from_secs(1);
                let fp = hs.peer_fp.clone();
                engine.diag_record_direct_ok(&fp);
                {
                    let mut m = engine
                        .tor_timeouts
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    m.remove(&fp);
                }
                let registered = register_and_run(
                    engine.clone(),
                    hs.session,
                    &fp,
                    &hs.peer_pubkey_hex,
                    &hs.peer_nickname,
                    true,
                    false,
                    hs.peer_proto_v,
                    hs.transcript_hash.clone(),
                )
                .await;
                if !registered {
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
                set_link_state(&engine, &fp, PeerLinkState::Reconnecting);
            }
            Err(e) => {
                debug!(target = ?target, "conexão falhou: {e}");
                if let Some(fp) = &expected_fp {
                    engine.diag_record_direct_err(
                        fp,
                        &match &e {
                            DistorrentError::Protocol(p) => p.clone(),
                            other => other.to_string(),
                        },
                    );
                }
                if let Some(fp) = &expected_fp {
                    engine.note_dial_failure(fp);
                }
                if let Some(fp) = &expected_fp {
                    // Seção 46: mode
                    let mode = engine
                        .store
                        .kv_get("privacy.mode")
                        .unwrap_or_else(|| "encrypted".to_string());
                    let err_s = match &e {
                        DistorrentError::Protocol(p) => p.clone(),
                        other => other.to_string(),
                    };
                    if mode == "full" && err_s.contains("timeout") {
                        let n = {
                            let mut m = engine
                                .tor_timeouts
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            if m.len() > 4096 {
                                m.clear();
                            }
                            let c = m.get(fp).copied().unwrap_or(0) + 1;
                            m.insert(fp.clone(), c);
                            c
                        };
                        if n >= 3 {
                            {
                                let mut m = engine
                                    .tor_timeouts
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                m.remove(fp);
                            }
                            debug!(fp, "tor: 3 timeouts seguidos — caindo para o túnel virtual");
                            engine.diag_record_direct_err(
                                fp,
                                "tor: 3 timeouts — tentando túnel virtual",
                            );
                            engine.tunnel_request(fp);
                        }
                    }
                }
            }
        }
        drop(dial_slot);
        sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX);
    }
}

fn relay_allowed(engine: &Arc<NetworkEngine>) -> bool {
    if engine.relay_disabled.load(Ordering::Relaxed) {
        return false;
    }
    match engine.privacy_mode().as_str() {
        "proxy" | "full" => engine.relay_proxied.load(Ordering::Relaxed),
        _ => true,
    }
}

fn active_relay_backend(engine: &Arc<NetworkEngine>) -> Arc<dyn RelayBackend> {
    let configured = engine
        .relay_backend
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if relay_allowed(engine) {
        return configured;
    }
    if engine.peer_relay_enabled() {
        let selected = engine
            .peer_relay
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(fp) = selected {
            if !fp.is_empty() {
                return engine.peer_relay_backend_for(&fp);
            }
        }
    }
    configured
}

fn is_online(engine: &Arc<NetworkEngine>, fp: &str) -> bool {
    engine
        .links
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(fp)
        .map(|l| l.get_state() == PeerLinkState::Online)
        .unwrap_or(false)
}

fn is_relay_handshake_frame(frame: &[u8]) -> bool {
    if frame.len() < 4 {
        return false;
    }
    let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if frame.len() != 4 + len {
        return false;
    }
    matches!(
        serde_json::from_slice::<HandshakeFrame>(&frame[4..]),
        Ok(HandshakeFrame::Hello(_))
            | Ok(HandshakeFrame::HelloAck(_))
            | Ok(HandshakeFrame::HelloOk(_))
    )
}

fn parse_relay_hello_full(frame: &[u8]) -> Option<crate::protocol::Hello> {
    if frame.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if frame.len() != 4 + len {
        return None;
    }
    match serde_json::from_slice::<HandshakeFrame>(&frame[4..]) {
        Ok(HandshakeFrame::Hello(h)) => Some(h),
        _ => None,
    }
}

fn parse_relay_hello(frame: &[u8]) -> Option<String> {
    if frame.len() < 4 {
        return None;
    }
    let len = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if frame.len() != 4 + len {
        return None;
    }
    match serde_json::from_slice::<HandshakeFrame>(&frame[4..]) {
        Ok(HandshakeFrame::Hello(h)) => Some(h.fp),
        _ => None,
    }
}

fn relay_dial_stream(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
) -> Option<(RelayStream, mpsc::UnboundedSender<Vec<u8>>)> {
    {
        let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = map.get(peer_fp) {
            if !tx.is_closed() {
                return None;
            }
            map.remove(peer_fp);
        }
    }
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    engine
        .relay_in
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(peer_fp.to_string(), in_tx.clone());
    let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let backend = active_relay_backend(engine);
    tokio::spawn(relay_post_loop(
        backend,
        engine.identity.fingerprint.clone(),
        peer_fp.to_string(),
        out_rx,
    ));
    Some((RelayStream::new(in_rx, out_tx), in_tx))
}

// Seção 47: liberar_entrada_relay
fn liberar_entrada_relay(
    engine: &Arc<NetworkEngine>,
    fp: &str,
    meu: &mpsc::UnboundedSender<Vec<u8>>,
) {
    let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tx) = map.get(fp) {
        if tx.same_channel(meu) {
            map.remove(fp);
        }
    }
}

async fn connect_relay_and_maintain(engine: Arc<NetworkEngine>, fp: String) {
    let cancel = engine.cancel_tx.subscribe();
    let mut backoff = Duration::from_secs(1);
    loop {
        if cancelled(&cancel) {
            return;
        }
        let online = engine
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&fp)
            .map(|l| l.get_state() == PeerLinkState::Online)
            .unwrap_or(false);
        if online {
            sleep(Duration::from_secs(4)).await;
            continue;
        }
        engine.refresh_peer_relay();
        if relay_allowed(&engine) || engine.peer_relay_fp().is_some() {
            let dial_slot = match engine.netlimiter.try_dial_slot() {
                Some(g) => g,
                None => {
                    sleep(Duration::from_millis(400)).await;
                    continue;
                }
            };
            set_link_state(&engine, &fp, PeerLinkState::Connecting);
            debug!(%fp, "relay: discando (sem porta aberta)");
            let dial_t0 = std::time::Instant::now();
            let Some((stream, my_in_tx)) = relay_dial_stream(&engine, &fp) else {
                debug!(%fp, "relay: handshake já em curso — aguarda");
                sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(10));
                continue;
            };
            let attempt = timeout(
                RELAY_DIAL_ATTEMPT,
                crate::net::transport::handshake_stream_relay(
                    stream,
                    engine.keypair.clone(),
                    &engine.nickname,
                    engine.listen_port(),
                    true,
                    Some(engine.identity.fingerprint.clone()),
                ),
            )
            .await;
            match attempt {
                Ok(Ok(hs)) if hs.peer_fp == fp => {
                    backoff = Duration::from_secs(2);
                    engine.diag_record_relay_ok(&fp);
                    info!(%fp, dial_ms = dial_t0.elapsed().as_millis() as u64, via_relay = true, "relay: dial→online");
                    register_and_run(
                        engine.clone(),
                        hs.session,
                        &fp,
                        &hs.peer_pubkey_hex,
                        &hs.peer_nickname,
                        true,
                        true,
                        hs.peer_proto_v,
                        hs.transcript_hash.clone(),
                    )
                    .await;
                    liberar_entrada_relay(&engine, &fp, &my_in_tx);
                    set_link_state(&engine, &fp, PeerLinkState::Reconnecting);
                }
                Ok(Ok(hs)) => {
                    debug!(esperado = %fp, apresentou = %hs.peer_fp, "relay: fp inesperado — descarta");
                    engine.diag_record_relay_err(
                        &fp,
                        &format!("relay respondeu fp estranho ({})", hs.peer_fp),
                    );
                    engine.note_dial_failure(&fp);
                    liberar_entrada_relay(&engine, &fp, &my_in_tx);
                }
                Ok(Err(e)) => {
                    debug!(%fp, "relay dial falhou ({e}) — tenta de novo no backoff");
                    engine.diag_record_relay_err(&fp, &format!("relay handshake: {e}"));
                    engine.note_dial_failure(&fp);
                    liberar_entrada_relay(&engine, &fp, &my_in_tx);
                }
                Err(_) => {
                    debug!(%fp, "relay dial timeout — peer offline? tenta de novo no backoff");
                    engine.diag_record_relay_err(
                        &fp,
                        "sem resposta no relay — peer offline ou relay bloqueado",
                    );
                    engine.note_dial_failure(&fp);
                    liberar_entrada_relay(&engine, &fp, &my_in_tx);
                }
            }
            drop(dial_slot);
        } else {
            engine
                .diag_record_relay_err(&fp, "relay desligado neste modo (kill-switch/privacidade)");
            engine.note_dial_failure(&fp);
        }
        let jitter_ms = {
            use rand::Rng;
            rand::thread_rng().gen_range(0..1000)
        };
        sleep(backoff + Duration::from_millis(jitter_ms)).await;
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
}

fn spawn_relay_responder_force(engine: Arc<NetworkEngine>, from: String, first_frame: Vec<u8>) {
    {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = links.remove(&from) {
            old.drop_notify.notify_one();
        }
    }
    engine.emit_state();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(from.clone(), in_tx.clone());
    }
    if in_tx.send(first_frame).is_err() {
        return;
    }
    tokio::spawn(async move {
        let backend = active_relay_backend(&engine);
        let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(relay_post_loop(
            backend,
            engine.identity.fingerprint.clone(),
            from.clone(),
            out_rx,
        ));
        let stream = RelayStream::new(in_rx, out_tx);
        let res = timeout(
            RELAY_HANDSHAKE_TIMEOUT,
            crate::net::transport::handshake_stream_relay(
                stream,
                engine.keypair.clone(),
                &engine.nickname,
                engine.listen_port(),
                false,
                Some(engine.identity.fingerprint.clone()),
            ),
        )
        .await;
        match res {
            Ok(Ok(hs)) if hs.peer_fp == from => {
                register_and_run(
                    engine.clone(),
                    hs.session,
                    &from,
                    &hs.peer_pubkey_hex,
                    &hs.peer_nickname,
                    false,
                    true,
                    hs.peer_proto_v,
                    hs.transcript_hash.clone(),
                )
                .await;
            }
            _ => {
                debug!(%from, "relay respondente (force) falhou/timeout");
            }
        }
    });
}

// Seção 48: spawn_relay_responder
fn spawn_relay_responder(engine: Arc<NetworkEngine>, from: String, first_frame: Vec<u8>) {
    let online = engine
        .links
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&from)
        .map(|l| l.get_state() == PeerLinkState::Online)
        .unwrap_or(false);
    if online {
        return;
    }
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = map.get(&from) {
            if !tx.is_closed() {
                return;
            }
            map.remove(&from);
        }
        map.insert(from.clone(), in_tx.clone());
    }
    if in_tx.send(first_frame).is_err() {
        engine
            .relay_in
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&from);
        return;
    }
    tokio::spawn(async move {
        let backend = active_relay_backend(&engine);
        let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(relay_post_loop(
            backend,
            engine.identity.fingerprint.clone(),
            from.clone(),
            out_rx,
        ));
        let stream = RelayStream::new(in_rx, out_tx);
        let res = timeout(
            RELAY_HANDSHAKE_TIMEOUT,
            crate::net::transport::handshake_stream_relay(
                stream,
                engine.keypair.clone(),
                &engine.nickname,
                engine.listen_port(),
                false,
                Some(engine.identity.fingerprint.clone()),
            ),
        )
        .await;
        match res {
            Ok(Ok(hs)) if hs.peer_fp == from => {
                register_and_run(
                    engine.clone(),
                    hs.session,
                    &from,
                    &hs.peer_pubkey_hex,
                    &hs.peer_nickname,
                    false,
                    true,
                    hs.peer_proto_v,
                    hs.transcript_hash.clone(),
                )
                .await;
            }
            _ => {
                debug!(%from, "relay respondente falhou/timeout");
            }
        }
    });
}

async fn relay_manager_loop(engine: Arc<NetworkEngine>) {
    let mut reasm = Reassembler::new();
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut last_hello: std::collections::HashMap<String, ([u8; 32], [u8; 16])> =
        std::collections::HashMap::new();
    let mut first = true;
    let (wake_tx, mut wake_rx) = mpsc::unbounded_channel::<()>();
    {
        let backend = active_relay_backend(&engine);
        for note in backend.wakes() {
            let wake_tx = wake_tx.clone();
            tokio::spawn(async move {
                loop {
                    note.notified().await;
                    if wake_tx.send(()).is_err() {
                        break;
                    }
                }
            });
        }
    }
    let cancel = engine.cancel_tx.subscribe();
    loop {
        if cancelled(&cancel) {
            break;
        }
        if !first {
            let has_push = {
                let backend = active_relay_backend(&engine);
                !backend.wakes().is_empty()
            };
            let (base_ms, jitter_max) = if has_push {
                (1000u64, 500u64)
            } else {
                (800, 400)
            };
            let jitter_ms = {
                use rand::Rng;
                rand::thread_rng().gen_range(0..jitter_max)
            };
            tokio::select! {
                _ = sleep(Duration::from_millis(base_ms + jitter_ms)) => {}
                _ = wake_rx.recv() => {
                    while wake_rx.try_recv().is_ok() {}
                }
            }
        }
        first = false;
        engine.refresh_peer_relay();
        if !relay_allowed(&engine) && engine.peer_relay_fp().is_none() {
            continue;
        }
        let backend = active_relay_backend(&engine);
        let my_fp = engine.identity.fingerprint.clone();
        let msgs = match backend.poll(&relay_topic(&my_fp)).await {
            Ok(m) => m,
            Err(e) => {
                debug!("relay poll falhou: {e}");
                continue;
            }
        };
        for raw in msgs {
            let h = {
                use std::hash::{Hash, Hasher};
                let mut s = std::collections::hash_map::DefaultHasher::new();
                raw.hash(&mut s);
                s.finish()
            };
            if !seen.insert(h) {
                continue;
            }
            if seen.len() > 1024 {
                seen.clear();
            }
            let Some((from_raw, frame)) = reasm.feed(&my_fp, &raw) else {
                continue;
            };
            let hello = parse_relay_hello_full(&frame);
            // Seção 49: from
            let from = if !from_raw.is_empty() {
                from_raw
            } else if let Some(h) = &hello {
                h.fp.clone()
            } else {
                String::new()
            };
            if from == my_fp {
                continue;
            }
            if let Some(hello) = &hello {
                if !from.is_empty() && hello.fp != from {
                    continue;
                }
                let key = (hello.eph_pub, hello.nonce);
                let dup = last_hello.get(&from) == Some(&key);
                if dup {
                    if is_online(&engine, &from) {
                        continue;
                    }
                } else {
                    last_hello.insert(from.clone(), key);
                    if last_hello.len() > 512 {
                        last_hello.clear();
                    }
                    if engine.netlimiter.allow_relay_hello(&from) == Decision::Blocked {
                        debug!(%from, "relay: Hello descartado — rate limit por peer");
                        continue;
                    }
                    if is_online(&engine, &from) {
                        debug!(%from, "relay: redial novo com sessão viva — novo respondente");
                        spawn_relay_responder_force(engine.clone(), from.clone(), frame.clone());
                        continue;
                    }
                }
            } else if !from.is_empty()
                && is_online(&engine, &from)
                && is_relay_handshake_frame(&frame)
            {
                continue;
            }
            if from.is_empty() {
                let map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
                for tx in map.values() {
                    let _ = tx.send(frame.clone());
                }
                continue;
            }
            let routed = {
                let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
                match map.get(&from) {
                    Some(tx) => match tx.send(frame.clone()) {
                        Ok(()) => true,
                        Err(_) => {
                            map.remove(&from);
                            false
                        }
                    },
                    None => false,
                }
            };
            if routed {
                continue;
            }
            if let Some(hello_fp) = parse_relay_hello(&frame) {
                if hello_fp == from {
                    if engine.netlimiter.allow_relay_hello(&from) == Decision::Blocked {
                        debug!(%from, "relay: Hello (sem sessão) descartado — rate limit");
                        continue;
                    }
                    debug!(%from, "relay: Hello recebido — atendendo");
                    spawn_relay_responder(engine.clone(), from, frame);
                }
            }
        }
    }
}

fn nova_sessao_substitui(
    atual_via_relay: bool,
    atual_initiator: bool,
    novo_via_relay: bool,
    novo_initiator: bool,
    prefiro_outbound: bool,
) -> bool {
    if atual_via_relay == novo_via_relay {
        if atual_initiator == novo_initiator {
            return false;
        }
        return novo_initiator == prefiro_outbound;
    }
    !novo_via_relay
}

async fn register_and_run(
    engine: Arc<NetworkEngine>,
    session: Session,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    initiator: bool,
    via_relay: bool,
    peer_proto_v: u32,
    transcript_hash: String,
) -> bool {
    let my_fp = engine.identity.fingerprint.clone();
    let prefiro_outbound = my_fp.as_str() < peer_fp;

    {
        let links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        let online = links
            .values()
            .filter(|l| l.get_state() == PeerLinkState::Online)
            .count();
        if online >= engine.netlimiter.limits().sessions_max {
            debug!(
                peer_fp,
                online, "sessão recusada: teto global de sessões online"
            );
            return false;
        }
    }

    {
        let links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = links.get(peer_fp) {
            if existing.get_state() == PeerLinkState::Online
                && !nova_sessao_substitui(
                    existing.via_relay,
                    existing.initiator,
                    via_relay,
                    initiator,
                    prefiro_outbound,
                )
            {
                debug!(peer_fp, via_relay, "sessão descartada (a atual fica)");
                return false;
            }
            if existing.get_state() == PeerLinkState::Online {
                debug!(peer_fp, "eleição: sessão preferida substitui a atual");
            }
        }
    }

    let _ = engine.store.upsert_peer(&PeerRecord {
        fp: peer_fp.to_string(),
        pubkey_hex: peer_pubkey.to_string(),
        nickname: peer_nick.to_string(),
        addr: None,
        last_seen: crate::identity::now_ms(),
        origin: "handshake".into(),
    });

    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    let link = Arc::new(PeerLink {
        state: StdMutex::new(PeerLinkState::Online),
        tx: Some(frame_tx.clone()),
        drop_notify: Notify::new(),
        via_relay,
        initiator,
    });
    // Seção 50: replaced
    let replaced = {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        links
            .insert(peer_fp.to_string(), link.clone())
            .filter(|old| old.get_state() == PeerLinkState::Online)
    };
    if let Some(old) = replaced {
        old.drop_notify.notify_one();
    }
    info!(peer_fp, %peer_nick, via_relay, "peer ONLINE");
    engine.reset_dial_failures(peer_fp);
    {
        // ORDEM IMPORTA: `peer_proto` é populado abaixo. Desafiar antes disso
        // fazia `send_build_challenge` sair cedo e a primeira conexão de cada
        // peer nunca era verificada.
        let mut map = engine.peer_protos.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(peer_fp.to_string())
            .and_modify(|v| {
                if peer_proto_v > *v {
                    *v = peer_proto_v;
                }
            })
            .or_insert(peer_proto_v);
    }
    {
        // Atestação de build: guarda o transcript desta sessão e desafia o
        // peer (só quem fala proto_v >= 5 entende). Sem isso o peer fica
        // NAO_VERIFICADO, que é o estado honesto.
        engine.set_attest_transcript(peer_fp, &transcript_hash);
        engine.send_build_challenge(peer_fp);
    }
    let _ = engine.events.send(EngineEvent::PeerOnline {
        fp: peer_fp.into(),
        nickname: peer_nick.into(),
        via_relay,
    });
    engine.emit_state();

    engine
        .cmd_tx
        .send(EngineCmd::SendToPeer(
            peer_fp.to_string(),
            SecureFrame::ProfileQuery {
                known_rev: engine
                    .store
                    .profile_get(peer_fp)
                    .map(|p| p.rev)
                    .unwrap_or(0),
            },
        ))
        .ok();

    engine.flush_files_to(peer_fp);

    if via_relay && peer_proto_v >= 1 && engine.punch_enabled() {
        spawn_punch_upgrade(engine.clone(), peer_fp.to_string());
    }

    {
        {
            let cutoff = crate::identity::now_ms() - 20_000;
            if let Ok(ids) = engine.store.revert_stale_sent_to_pending(peer_fp, cutoff) {
                for id in ids {
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id: id,
                        status: "pending".into(),
                    });
                }
            }
        }
        engine
            .cmd_tx
            .send(EngineCmd::FlushOutbox(peer_fp.to_string()))
            .ok();
        engine.flush_friend_requests(peer_fp);
        engine.flush_joins(peer_fp);
        engine.flush_pending_calls(peer_fp);
        engine.flush_pending_reacts(peer_fp);
        engine.flush_voice_state_to(peer_fp);
        engine.flush_community_state_to(peer_fp);
        engine.flush_rooms_to(peer_fp);
        engine.announce_presence();
    }

    let (mut reader, mut writer_session) = session.split();
    let writer: JoinHandle<()> = tokio::spawn(async move {
        let mut queues: [VecDeque<SecureFrame>; 4] = [
            VecDeque::new(),
            VecDeque::new(),
            VecDeque::new(),
            VecDeque::new(),
        ];
        const BATCH_CAP: usize = 16;
        const CLASS_CAP: [usize; 4] = [8, 4, 12, 4];
        loop {
            if queues.iter().all(|q| q.is_empty()) {
                match frame_rx.recv().await {
                    Some((p, f)) => queues[(p as usize).min(3)].push_back(f),
                    None => break,
                }
            }
            while let Ok((p, f)) = frame_rx.try_recv() {
                queues[(p as usize).min(3)].push_back(f);
            }
            let mut batch: Vec<(u8, SecureFrame)> = Vec::with_capacity(BATCH_CAP);

            for (class, q) in queues.iter_mut().enumerate() {
                let take = CLASS_CAP[class].min(q.len()).min(BATCH_CAP - batch.len());
                for _ in 0..take {
                    if let Some(f) = q.pop_front() {
                        batch.push((class as u8, f));
                    }
                }
            }
            if batch.is_empty() {
                continue;
            }
            let mut frames: Vec<SecureFrame> = Vec::with_capacity(batch.len());
            let mut classes: Vec<u8> = Vec::with_capacity(batch.len());
            for (c, f) in batch {
                classes.push(c);
                frames.push(f);
            }
            match writer_session.send_batch(&frames).await {
                Ok(sizes) => {
                    for (c, s) in classes.iter().zip(sizes.iter()) {
                        crate::metrics::metrics()
                            .frame_tx(crate::metrics::FrameClass::by_index(*c), *s as u64);
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (base_interval, base_timeout, steps) = if via_relay {
        (
            RELAY_PING_INTERVAL,
            RELAY_PING_TIMEOUT,
            [
                RELAY_PING_INTERVAL,
                RELAY_PING_INTERVAL * 2,
                RELAY_PING_INTERVAL * 4,
                RELAY_PING_INTERVAL * 6,
            ],
        )
    } else {
        (
            PING_INTERVAL,
            PING_TIMEOUT,
            [
                PING_INTERVAL,
                PING_INTERVAL * 2,
                PING_INTERVAL * 3,
                PING_INTERVAL * 3,
            ],
        )
    };
    let mut idle_step = 0usize;
    let mut ping_at = tokio::time::Instant::now() + base_interval;
    // Teto para a escalada de timeout: sem ele, um par parado ficava até 75 s
    // (ou 120 s no relay) sem ser declarado morto — "Conectado" mentiroso.
    let max_idle = base_timeout * 2;

    let read_result = loop {
        let cur_interval = steps[idle_step.min(steps.len() - 1)];
        let cur_timeout = std::cmp::max(base_timeout, cur_interval.mul_f64(2.5)).min(max_idle);
        tokio::select! {
            res = timeout(cur_timeout, reader.recv_sized::<SecureFrame>()) => {
                match res {
                    Err(_) => break Err(DistorrentError::Protocol(format!("ping timeout ({:?} sem frames)", cur_timeout))),
                    Ok(Err(e)) => break Err(e),
                    Ok(Ok((frame, wire))) => {
                        idle_step = 0;
                        ping_at = tokio::time::Instant::now() + base_interval;
                        crate::metrics::metrics().frame_rx(
                            crate::metrics::FrameClass::by_index(frame_class(&frame)),
                            wire as u64,
                        );
                        match engine.netlimiter.allow_frame_in(peer_fp, wire as u64) {
                            FrameVerdict::Allow => {}
                            FrameVerdict::Drop(reason) => {
                                debug!("frame de {peer_fp} descartado: {reason}");
                                continue;
                            }
                            FrameVerdict::Kill(reason) => {
                                warn!(peer_fp, "sessão encerrada por limite: {reason}");
                                break Err(DistorrentError::Protocol(reason.to_string()));
                            }
                        }
                        if engine.peer_quarantined(peer_fp)
                            && !crate::release::frame_allowed_in_quarantine(&frame)
                        {
                            // Quarentena: o peer continua vivo (Ping/Bye e os
                            // frames de atualização), mas nada de mensagem,
                            // arquivo, chamada ou estado entra na rede.
                            debug!(peer_fp, "frame bloqueado pela quarentena de autenticidade");
                            continue;
                        }
                        if let Err(e) = handle_frame(&engine, peer_fp, peer_pubkey, peer_nick, frame).await {
                            // Seção 51: motivo
                            let motivo = e.to_string();
                            warn!(peer_fp, "frame rejeitado: {motivo}");
                            engine.diag_update(peer_fp, |d| {
                                d.last_reject = Some(motivo);
                                d.last_reject_ms = crate::identity::now_ms();
                            });
                        }
                    }
                }
            }
            _ = tokio::time::sleep_until(ping_at) => {
                if engine.store.peer_in_active_call(peer_fp) {
                    idle_step = 0;
                } else {
                    idle_step = (idle_step + 1).min(steps.len() - 1);
                }
                ping_at = tokio::time::Instant::now() + steps[idle_step];
                if frame_tx.send((0, SecureFrame::Ping { ts: crate::identity::now_ms() })).is_err() {
                    break Err(DistorrentError::PeerNotConnected(peer_fp.into()));
                }
            }
            _ = link.drop_notify.notified() => break Ok(()),
        }
    };

    writer.abort();
    let removed = {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        match links.get(peer_fp) {
            Some(current) if Arc::ptr_eq(current, &link) => links.remove(peer_fp).is_some(),
            _ => false,
        }
    };
    if removed {
        engine.netlimiter.forget_peer(peer_fp);
        {
            // Estado de confiança é POR SESSÃO: reconectar sem nova prova não
            // herda o veredito antigo.
            let mut m = engine.peer_trust.lock().unwrap_or_else(|e| e.into_inner());
            m.remove(peer_fp);
            let mut n = engine
                .attest_nonce
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            n.remove(peer_fp);
            let mut sa = engine
                .attest_sent_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            sa.remove(peer_fp);
            let mut t = engine
                .attest_transcript
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            t.remove(peer_fp);
        }
        if engine.should_keep_dialing(peer_fp) {
            set_link_state(&engine, peer_fp, PeerLinkState::Reconnecting);
        }
        engine.tunnel_drop(peer_fp, "link caiu");
        if let Ok(ids) = engine.store.revert_unacked_to_pending(peer_fp) {
            for id in ids {
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: id,
                    status: "pending".into(),
                });
            }
        }
        if let Ok(ids) = engine.store.revert_unacked_groups_to_pending() {
            for id in ids {
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: id,
                    status: "pending".into(),
                });
            }
        }
        info!(
            peer_fp,
            "peer OFFLINE ({})",
            read_result
                .as_ref()
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "desconectado".into())
        );
        let _ = engine.events.send(EngineEvent::PeerOffline {
            fp: peer_fp.to_string(),
        });
        // Presença persistida: sem isso o peer continuava "online" na UI por
        // até 90 s (TTL) depois de a conexão cair — o clássico verde mentiroso.
        let _ = engine.store.presence_offline(peer_fp);
        let _ = engine.events.send(EngineEvent::PresenceChanged {
            fp: peer_fp.to_string(),
            status: "offline".into(),
            custom: String::new(),
            custom_emoji: String::new(),
        });
        engine.drop_voice_presence_of(peer_fp);
        engine.emit_state();
    }
    true
}

fn announce_lookup_once(engine: Arc<NetworkEngine>, peer_fp: String) {
    tokio::spawn(async move {
        if !relay_allowed(&engine) {
            return;
        }
        if !announce_discovery_enabled() {
            return;
        }
        let backend = active_relay_backend(&engine);
        let ann_topic = crate::net::relay::announce_topic(&peer_fp);
        if let Ok(msgs) = backend.poll(&ann_topic).await {
            for raw in msgs.iter().rev().take(3) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
                    let f = v.get("fp").and_then(|x| x.as_str()).unwrap_or("");
                    if f == peer_fp {
                        let lan = v.get("lan").and_then(|x| x.as_str());
                        let pubip = v.get("addr").and_then(|x| x.as_str());
                        for cand in [lan, pubip].into_iter().flatten() {
                            if cand.is_empty() || cand == "null" {
                                continue;
                            }
                            if let Ok(sock) = cand.parse::<SocketAddr>() {
                                info!(fp=%peer_fp, %sock, "direta imediata: endpoint via anúncio");
                                engine.diag_record_announce_seen(&peer_fp);
                                engine
                                    .cmd_tx
                                    .send(EngineCmd::ConnectTo(sock, Some(peer_fp.clone())))
                                    .ok();
                                return;
                            }
                        }
                        engine.diag_record_announce_seen(&peer_fp);
                    }
                }
            }
        }
    });
}

fn spawn_punch_upgrade(engine: Arc<NetworkEngine>, peer_fp: String) {
    if !engine.punch_enabled() {
        return;
    }
    if !punch_allowed_by_privacy(&engine) {
        debug!(%peer_fp, "punch upgrade suspenso: modo anônimo (proxy/full)");
        return;
    }
    let generation = {
        let mut map = engine
            .punch_upgrades
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if map.len() > 4096 {
            map.clear();
        }
        let g = map.entry(peer_fp.clone()).or_insert(0);
        *g += 1;
        *g
    };
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(2);
        let cancel = engine.cancel_tx.subscribe();
        loop {
            if cancelled(&cancel) {
                break;
            }
            let cur_gen = *engine
                .punch_upgrades
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&peer_fp)
                .unwrap_or(&generation);
            if cur_gen != generation {
                break;
            }
            let (online, via_relay) = {
                let links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
                match links.get(&peer_fp) {
                    Some(l) => (l.get_state() == PeerLinkState::Online, l.via_relay),
                    None => (false, false),
                }
            };
            if !online || !via_relay {
                break;
            }
            if !engine.punch_enabled() {
                break;
            }
            if !punch_allowed_by_privacy(&engine) {
                debug!(%peer_fp, "punch upgrade encerrado: modo anônimo em runtime");
                break;
            }
            // Seção 52: current_endpoint
            let current_endpoint = engine
                .public_addr
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let my_endpoint = match current_endpoint {
                Some(a) => Some(a),
                None if stun_allowed(&engine) => {
                    let tcp_port = {
                        let ext = engine.nat_external_port.load(Ordering::Relaxed);
                        if ext != 0 {
                            ext
                        } else {
                            engine.listen_port()
                        }
                    };
                    crate::net::stun::stun_external_addr()
                        .await
                        .map(|a| format!("{}:{tcp_port}", a.ip()))
                }
                None => None,
            };
            let Some(my_endpoint) = my_endpoint else {
                sleep(Duration::from_secs(5)).await;
                continue;
            };
            use rand::RngCore;
            let mut nonce = [0u8; 16];
            RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
            let at_ms = (crate::identity::now_ms().max(0) as u64).saturating_add(1500);
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.clone(),
                    SecureFrame::Punch {
                        endpoint: my_endpoint,
                        at_ms,
                        nonce,
                    },
                ))
                .ok();
            let jitter_ms = {
                use rand::Rng;
                rand::thread_rng().gen_range(0..750u64)
            };
            sleep(backoff + Duration::from_millis(jitter_ms)).await;
            backoff = (backoff + Duration::from_secs(1)).min(Duration::from_secs(8));
        }
        let mut map = engine
            .punch_upgrades
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if map.get(&peer_fp) == Some(&generation) {
            map.remove(&peer_fp);
        }
    });
}

async fn punch_and_register(
    engine: Arc<NetworkEngine>,
    want_fp: String,
    endpoint: String,
    at_ms: u64,
) {
    if !engine.punch_enabled() {
        return;
    }
    if !punch_allowed_by_privacy(&engine) {
        debug!(%want_fp, "punch dial ignorado: modo anônimo (proxy/full)");
        return;
    }
    let Ok(remote) = endpoint.parse::<SocketAddr>() else {
        return;
    };
    let now = crate::identity::now_ms();
    let wait = (at_ms as i64 - now).clamp(0, 10_000) as u64;
    sleep(Duration::from_millis(wait)).await;
    if engine.peer_state(&want_fp) == NetworkState::Connected && !engine.is_peer_via_relay(&want_fp)
    {
        return;
    }
    tokio::spawn(crate::net::transport::udp_punch_probe(remote));
    const PUNCH_PARALLEL: usize = 3;
    const PUNCH_ROUNDS: usize = 2;
    for round in 0..PUNCH_ROUNDS {
        if !engine.punch_enabled() {
            return;
        }
        if engine.peer_state(&want_fp) == NetworkState::Connected
            && !engine.is_peer_via_relay(&want_fp)
        {
            return;
        }
        let mut tasks = Vec::with_capacity(PUNCH_PARALLEL);
        for i in 0..PUNCH_PARALLEL {
            let engine = engine.clone();
            let want_fp = want_fp.clone();
            tasks.push(tokio::spawn(async move {
                if i > 0 {
                    sleep(Duration::from_millis(200 * i as u64)).await;
                }
                punch_once(&engine, &want_fp, remote).await;
            }));
        }
        for t in tasks {
            let _ = t.await;
        }
        if round + 1 < PUNCH_ROUNDS {
            sleep(Duration::from_millis(400)).await;
        }
    }
}

async fn punch_once(engine: &Arc<NetworkEngine>, want_fp: &str, remote: SocketAddr) -> bool {
    if engine.peer_state(want_fp) == NetworkState::Connected && !engine.is_peer_via_relay(want_fp) {
        return false;
    }
    let local_port = engine.listen_port();
    let Ok(stream) = crate::net::transport::punch_dial(local_port, remote).await else {
        debug!(%want_fp, %remote, "hole punch: dial falhou (NAT não colaborou)");
        return false;
    };
    match crate::net::transport::handshake_with_fp(
        stream,
        engine.keypair.clone(),
        &engine.nickname,
        engine.listen_port(),
        true,
        Some(engine.identity.fingerprint.clone()),
    )
    .await
    {
        Ok(hs) if hs.peer_fp == want_fp => {
            info!(%want_fp, "hole punch: DIRETA estabelecida sem servidor");
            register_and_run(
                engine.clone(),
                hs.session,
                want_fp,
                &hs.peer_pubkey_hex,
                &hs.peer_nickname,
                true,
                false,
                hs.peer_proto_v,
                hs.transcript_hash.clone(),
            )
            .await
        }
        Ok(hs) => {
            debug!(esperado = %want_fp, apresentou = %hs.peer_fp, "punch: fp inesperado — descarta");
            false
        }
        Err(e) => {
            debug!(%want_fp, "punch handshake falhou: {e}");
            false
        }
    }
}

// Seção 53: cap_str
fn cap_str(s: &str, max: usize) -> String {
    crate::names::sanitize_text(s, max)
}

fn cap_b64(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
        .take(max)
        .collect()
}

fn normalize_accent(accent: &str) -> String {
    if accent.starts_with('#')
        && accent.len() == 7
        && accent[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        accent.to_ascii_lowercase()
    } else {
        String::new()
    }
}

fn profile_frame(p: &crate::social::ProfileView) -> SecureFrame {
    SecureFrame::ProfileSet {
        display_name: p.display_name.clone(),
        about: p.about.clone(),
        avatar_b64: p.avatar_b64.clone(),
        banner_b64: p.banner_b64.clone(),
        accent: p.accent.clone(),
        rev: p.rev,
        content_hash: p.content_hash.clone(),
    }
}

pub const PROFILE_SYNC_INTERVAL_SECS: u64 = 600;

const PROFILE_IMG_B64_MAX: usize = 80_000;
const PROFILE_BANNER_B64_MAX: usize = 110_000;

pub const PROFILE_IMAGE_MAX_BYTES: usize = PROFILE_IMG_B64_MAX * 3 / 4;
pub const PROFILE_BANNER_MAX_BYTES: usize = PROFILE_BANNER_B64_MAX * 3 / 4;

const ANNOUNCE_REPUBLISH_MS: i64 = 60 * 1000;

pub const MAX_ANNOUNCED_FILE_BYTES: u64 = 50 * 1024 * 1024 * 1024;

const MAX_CHUNK_BYTES: usize = 512 * 1024;

const MAX_REACTION_ID_CHARS: usize = 128;
const MAX_REACTION_EMOJI_CHARS: usize = 16;
const MAX_REACTION_EMOJI_BYTES: usize = 64;
const MAX_REACTION_EMOJIS_PER_MESSAGE: usize = 20;
const MAX_REACTIONS_PER_MESSAGE: i64 = 128;
const MAX_REACTIONS_PER_PARTICIPANT: usize = 20;
const MAX_REACTORS_PER_EMOJI: i64 = 64;

fn valid_reaction_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REACTION_ID_CHARS
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn valid_reaction_emoji(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REACTION_EMOJI_BYTES
        && value.chars().count() <= MAX_REACTION_EMOJI_CHARS
        && value.chars().all(|c| {
            !c.is_control()
                && !c.is_whitespace()
                && !matches!(
                    c,
                    '\u{200B}'
                        | '\u{200C}'
                        | '\u{202A}'..='\u{202E}'
                        | '\u{2066}'..='\u{2069}'
                        | '\u{00AD}'
                        | '\u{FEFF}'
                )
        })
}

fn reaction_storage_error(error: String) -> DistorrentError {
    DistorrentError::Storage(rusqlite::Error::ToSqlConversionFailure(Box::new(
        std::io::Error::new(std::io::ErrorKind::Other, error),
    )))
}

fn receive_reaction(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    conv_id: &str,
    msg_id: &str,
    emoji: &str,
    add_from_peer: bool,
    now: std::time::Instant,
) -> Result<()> {
    if engine.is_blocked(peer_fp) {
        return Ok(());
    }
    if !valid_reaction_id(conv_id) || !valid_reaction_id(msg_id) || !valid_reaction_emoji(emoji) {
        debug!(%peer_fp, "reação descartada: identificador ou emoji inválido");
        return Ok(());
    }

    let shared = engine
        .store
        .get_conversation(conv_id)
        .ok()
        .flatten()
        .is_some()
        || engine
            .store
            .list_group_members(conv_id)
            .map(|v| !v.is_empty())
            .unwrap_or(false);
    let is_friend = engine
        .store
        .get_friend(peer_fp)
        .ok()
        .flatten()
        .map(|(_, status)| status == "accepted")
        .unwrap_or(false);
    if !shared && !is_friend {
        return Err(DistorrentError::Protocol(
            "reação fora de conversa compartilhada".into(),
        ));
    }

    let message_matches = engine
        .store
        .message_by_id_raw(msg_id)?
        .map(|message| message.conv_id == conv_id)
        .unwrap_or(false);
    if !message_matches {
        debug!(%peer_fp, %conv_id, %msg_id, "reação descartada: mensagem ausente ou de outra conversa");
        return Ok(());
    }

    let mut limiter = engine
        .reaction_limiter
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let current = engine
        .store
        .reactions_for_msg(msg_id)
        .map_err(reaction_storage_error)?;
    let current_emoji = current.iter().find(|r| r.emoji == emoji);
    let already_applied = current_emoji
        .map(|r| r.reactors.iter().any(|fp| fp == peer_fp))
        .unwrap_or(false);

    if already_applied == add_from_peer {
        return Ok(());
    }

    if add_from_peer {
        let total_reactions: i64 = current.iter().map(|r| r.count).sum();
        let participant_reactions = current
            .iter()
            .filter(|r| r.reactors.iter().any(|fp| fp == peer_fp))
            .count();
        let emoji_count = current_emoji.map(|r| r.count).unwrap_or(0);
        let is_new_emoji = current_emoji.is_none();
        if total_reactions >= MAX_REACTIONS_PER_MESSAGE
            || participant_reactions >= MAX_REACTIONS_PER_PARTICIPANT
            || emoji_count >= MAX_REACTORS_PER_EMOJI
            || (is_new_emoji && current.len() >= MAX_REACTION_EMOJIS_PER_MESSAGE)
        {
            debug!(%peer_fp, "reação descartada: limite de reações persistidas atingido");
            return Ok(());
        }
    }

    if let Err(reason) = limiter.allow_at(peer_fp, conv_id, msg_id, now) {
        debug!(%peer_fp, %reason, "reação descartada por rate limit");
        return Ok(());
    }

    // Seção 54: applied
    let applied = engine
        .store
        .reaction_apply(msg_id, conv_id, emoji, peer_fp, add_from_peer)
        .map_err(reaction_storage_error)?;
    drop(limiter);

    let _ = engine.events.send(EngineEvent::ReactionChanged {
        msg_id: msg_id.to_string(),
        conv_id: conv_id.to_string(),
        emoji: emoji.to_string(),
        add: applied,
        reactor_fp: peer_fp.to_string(),
    });
    for fp in engine.social_peers_of(conv_id) {
        if fp != peer_fp {
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::React {
                        conv_id: conv_id.to_string(),
                        msg_id: msg_id.to_string(),
                        emoji: emoji.to_string(),
                        add: applied,
                        reactor_fp: peer_fp.to_string(),
                    },
                ))
                .ok();
        }
    }
    Ok(())
}

fn normalize_presence(s: &str) -> &'static str {
    match s {
        "online" => "online",
        "idle" => "idle",
        "dnd" => "dnd",
        "invisible" => "invisible",
        _ => "online",
    }
}

impl NetworkEngine {
    pub fn is_moderator(&self, community_id: &str, fp: &str) -> bool {
        let Ok(Some(comm)) = self.store.get_community(community_id) else {
            return false;
        };
        if comm.2 == fp {
            return true;
        }
        let is_mod = self
            .store
            .get_server_rules(community_id)
            .map(|r| r.moderators.iter().any(|m| m == fp))
            .unwrap_or(false);
        if is_mod {
            return true;
        }
        let Ok(role_ids) = self.store.member_roles_list(community_id, fp) else {
            return false;
        };
        self.store
            .roles_list(community_id)
            .map(|roles| {
                roles.iter().any(|r| {
                    role_ids.iter().any(|rid| rid == &r.id)
                        && (r.permissions
                            & (crate::moderation::PERM_BAN
                                | crate::moderation::PERM_MUTE
                                | crate::moderation::PERM_DELETE))
                            != 0
                })
            })
            .unwrap_or(false)
    }

    pub fn community_of_conv(&self, conv_id: &str) -> Option<String> {
        self.store.channel_community(conv_id).ok().flatten()
    }

    pub fn social_peers_of(&self, conv_id: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        let me = &self.identity.fingerprint;
        if let Ok(Some(c)) = self.store.get_conversation(conv_id) {
            if !c.peer_fp.is_empty() && &c.peer_fp != me {
                out.push(c.peer_fp);
            }
        }
        if let Ok(members) = self.store.list_group_members(conv_id) {
            for (fp, _) in members {
                if &fp != me && !out.contains(&fp) {
                    out.push(fp);
                }
            }
        }
        if let Some(cid) = self.community_of_conv(conv_id) {
            if let Ok(members) = self.store.list_members(&cid) {
                for (fp, _, _) in members {
                    if &fp != me && !out.contains(&fp) {
                        out.push(fp);
                    }
                }
            }
        }
        out
    }

    pub fn can_moderate_conv(&self, conv_id: &str, fp: &str) -> bool {
        match self.community_of_conv(conv_id) {
            Some(cid) => self.is_moderator(&cid, fp),
            None => {
                // DM/grupo: NÃO existe moderador de conversa. O autor mexe na
                // própria mensagem (checado antes por quem chama); o criador
                // do grupo gerencia roster, não o conteúdo dos outros. Antes
                // "estar no conv" era tratado como permissão de moderação.
                self.store
                    .get_conversation(conv_id)
                    .ok()
                    .flatten()
                    .filter(|c| c.kind == "group")
                    .map(|_| {
                        self.store
                            .list_group_members(conv_id)
                            .map(|m| m.first().map(|(owner, _)| owner == fp).unwrap_or(false))
                            .unwrap_or(false)
                    })
                    .unwrap_or(false)
            }
        }
    }

    /// Fixar é anotação compartilhada: qualquer participante da conversa pode.
    /// Diferente de apagar/editar, não destrói conteúdo de terceiro.
    pub fn can_pin_conv(&self, conv_id: &str, fp: &str) -> bool {
        match self.store.get_conversation(conv_id).ok().flatten() {
            Some(c) if c.kind == "dm" => {
                c.peer_fp == fp || (fp == self.identity.fingerprint && !c.peer_fp.is_empty())
            }
            Some(c) if c.kind == "group" => self
                .store
                .list_group_members(conv_id)
                .map(|m| m.iter().any(|(m_fp, _)| m_fp == fp))
                .unwrap_or(false),
            Some(_) => match self.community_of_conv(conv_id) {
                Some(cid) => self.store.member_role(&cid, fp).is_some(),
                None => false,
            },
            None => false,
        }
    }

    pub fn broadcast_social(&self, community_id: &str, frame: SecureFrame) {
        let Ok(members) = self.store.list_members(community_id) else {
            return;
        };
        for (fp, _, _) in members {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(fp, frame.clone()))
                    .ok();
            }
        }
    }

    /// Quem pode ver meu status: amigos aceitos, membros de grupo e de
    /// servidor em comum. Presença não é broadcast para todo peer conhecido —
    /// isso vazava "estou online" para quem nunca foi contato.
    pub fn is_social_contact(&self, fp: &str) -> bool {
        if fp == self.identity.fingerprint {
            return false;
        }
        if matches!(
            self.store.get_friend(fp).ok().flatten(),
            Some((_, s)) if s == "accepted"
        ) {
            return true;
        }
        if self
            .store
            .group_convs_with_peer(fp)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
        {
            return true;
        }
        self.store
            .list_communities()
            .map(|cs| {
                cs.iter()
                    .any(|(id, _, _)| self.store.member_role(id, fp).is_some())
            })
            .unwrap_or(false)
    }

    pub fn announce_presence(&self) {
        let Ok(p) = self.store.presence_get_live(&self.identity.fingerprint) else {
            return;
        };
        // Invisível: os contatos que já me viam precisam receber o offline,
        // senão eu continuo verde para eles até o TTL vencer.
        let frame = if p.status == "invisible" {
            SecureFrame::PresenceSet {
                status: "offline".into(),
                custom: String::new(),
                custom_emoji: String::new(),
            }
        } else {
            SecureFrame::PresenceSet {
                status: p.status,
                custom: p.custom,
                custom_emoji: p.custom_emoji,
            }
        };
        for fp in self.online_peer_fps() {
            if !self.is_social_contact(&fp) {
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(fp, frame.clone()))
                .ok();
        }
    }
}

fn handle_tunnel_offer(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    eph_hex: &str,
    nonce_hex: &str,
    sig: &str,
) {
    if !engine.tunnel_enabled() || engine.tunnel_established(peer_fp) {
        return;
    }
    // Seção 55: let
    let (eph, nonce) = match NetworkEngine::parse_tunnel_hs(eph_hex, nonce_hex) {
        Some(v) => v,
        None => return,
    };
    let transcript = tunnel_transcript(
        peer_fp,
        &eph,
        &nonce,
        &engine.identity.fingerprint,
        &[0u8; 32],
        &[0u8; 16],
    );
    if Keypair::verify(peer_pubkey, &transcript, sig).unwrap_or(false) != true {
        debug!(peer_fp, "tunel: oferta com assinatura inválida — ignora");
        return;
    }
    {
        let mut meta = engine.tunnel_meta.lock().unwrap_or_else(|e| e.into_inner());
        if meta.len() > 512 {
            meta.clear();
        }
        meta.insert(
            peer_fp.to_string(),
            (peer_pubkey.to_string(), engine.tunnel_peer_nick(peer_fp)),
        );
    }
    let secret = x25519_dalek::StaticSecret::random_from_rng(rand::thread_rng());
    let my_eph = x25519_dalek::PublicKey::from(&secret).to_bytes();
    let mut my_nonce = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut my_nonce);
    let key = match tunnel_key(&secret, &eph, &nonce, &my_nonce) {
        Ok(k) => k,
        Err(_) => return,
    };
    let my_fp = engine.identity.fingerprint.clone();
    let answer_transcript = tunnel_transcript(peer_fp, &eph, &nonce, &my_fp, &my_eph, &my_nonce);
    let answer_sig = engine.keypair.sign(&answer_transcript);
    engine.tunnel_store_session(peer_fp, key);
    debug!(peer_fp, "tunel: oferta aceita, resposta enviada");
    engine.send_to_peer(
        peer_fp.to_string(),
        SecureFrame::TunnelAnswer {
            eph_pub_hex: hex::encode(my_eph),
            nonce_hex: hex::encode(my_nonce),
            for_nonce_hex: hex::encode(nonce),
            sig: answer_sig,
        },
    );
}

fn handle_tunnel_answer(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    eph_hex: &str,
    nonce_hex: &str,
    for_nonce_hex: &str,
    sig: &str,
) {
    if !engine.tunnel_enabled() || engine.tunnel_established(peer_fp) {
        return;
    }
    let (eph, nonce) = match NetworkEngine::parse_tunnel_hs(eph_hex, nonce_hex) {
        Some(v) => v,
        None => return,
    };
    let for_nonce: [u8; 16] = match hex::decode(for_nonce_hex)
        .ok()
        .and_then(|v| v.try_into().ok())
    {
        Some(v) => v,
        None => return,
    };
    let pending = {
        let mut pend = engine
            .tunnel_pending
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match pend.remove(peer_fp) {
            Some(p)
                if p.nonce == for_nonce && crate::identity::now_ms() - p.created_ms < 120_000 =>
            {
                p
            }
            _ => return,
        }
    };
    let my_fp = engine.identity.fingerprint.clone();
    let transcript = tunnel_transcript(
        &my_fp,
        &x25519_dalek::PublicKey::from(&pending.secret).to_bytes(),
        &pending.nonce,
        peer_fp,
        &eph,
        &nonce,
    );
    if Keypair::verify(peer_pubkey, &transcript, sig).unwrap_or(false) != true {
        debug!(peer_fp, "tunel: resposta com assinatura inválida — ignora");
        return;
    }
    {
        let mut meta = engine.tunnel_meta.lock().unwrap_or_else(|e| e.into_inner());
        if meta.len() > 512 {
            meta.clear();
        }
        meta.insert(
            peer_fp.to_string(),
            (peer_pubkey.to_string(), engine.tunnel_peer_nick(peer_fp)),
        );
    }
    let key = match tunnel_key(&pending.secret, &eph, &pending.nonce, &nonce) {
        Ok(k) => k,
        Err(_) => return,
    };
    debug!(peer_fp, "tunel: resposta válida, sessão pronta");
    engine.tunnel_store_session(peer_fp, key);
}

fn handle_tunnel_data(engine: &Arc<NetworkEngine>, peer_fp: &str, nonce: u64, ct_b64: &str) {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
    if !engine.tunnel_enabled() {
        return;
    }
    let ct = match B64.decode(ct_b64.as_bytes()) {
        Ok(v) if v.len() <= 64 * 1024 => v,
        _ => return,
    };
    let pt = {
        let map = engine
            .tunnel_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let sess = match map.get(peer_fp) {
            Some(s) => s,
            None => return,
        };
        match sess.open(
            &peer_fp.to_string(),
            &engine.identity.fingerprint,
            nonce,
            &ct,
        ) {
            Ok(v) => v,
            Err(_) => return,
        }
    };
    let payload = match decode_envelope(&pt) {
        TunMsg::Full(v) => v,
        TunMsg::Frag {
            id,
            idx,
            total,
            chunk,
        } => {
            // Seção 56: full
            let full = {
                let mut reasm = engine
                    .tunnel_reasm
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                reasm.insert(peer_fp, id, idx, total, chunk, crate::identity::now_ms())
            };
            match full {
                Some(v) => v,
                None => return,
            }
        }
        TunMsg::Invalid => return,
    };
    if let Some(id_s) = payload
        .strip_prefix(b"ping:")
        .and_then(|r| std::str::from_utf8(r).ok())
    {
        if let Ok(id) = id_s.parse::<u64>() {
            let msg = format!("pong:{id}");
            let sealed = {
                let map = engine
                    .tunnel_sessions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                map.get(peer_fp).and_then(|sess| {
                    sess.seal(
                        &engine.identity.fingerprint,
                        peer_fp,
                        &encode_full(msg.as_bytes()),
                    )
                    .ok()
                })
            };
            if let Some((n, sealed_ct)) = sealed {
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.to_string(),
                        SecureFrame::TunnelData {
                            nonce: n,
                            ct_b64: B64.encode(sealed_ct),
                        },
                    ))
                    .ok();
            }
        }
        return;
    }
    if let Some(id_s) = payload
        .strip_prefix(b"pong:")
        .and_then(|r| std::str::from_utf8(r).ok())
    {
        if let Ok(id) = id_s.parse::<u64>() {
            let sent = {
                let mut p = engine
                    .tunnel_pings
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                p.remove(&(peer_fp.to_string(), id))
            };
            if let Some(t0) = sent {
                let _ = engine.events.send(EngineEvent::TunnelPong {
                    fp: peer_fp.to_string(),
                    id,
                    rtt_ms: crate::identity::now_ms() - t0,
                });
            }
        }
        return;
    }
    let frame: SecureFrame = match serde_json::from_slice(&payload) {
        Ok(f) => f,
        Err(_) => return,
    };
    engine.diag_update(peer_fp, |d| {
        d.tunnel_rx_frames = d.tunnel_rx_frames.saturating_add(1);
    });
    let (tun_pubkey, tun_nick) = {
        let meta = engine.tunnel_meta.lock().unwrap_or_else(|e| e.into_inner());
        meta.get(peer_fp)
            .cloned()
            .unwrap_or_else(|| (String::new(), peer_fp.chars().take(8).collect()))
    };
    let engine_inner = engine.clone();
    let fp_owned = peer_fp.to_string();
    tokio::spawn(async move {
        if let Err(e) = handle_frame(&engine_inner, &fp_owned, &tun_pubkey, &tun_nick, frame).await
        {
            debug!(%fp_owned, "tunel: frame interno falhou: {e}");
        }
    });
    engine.tunnel_housekeep(peer_fp);
}

#[cfg(target_os = "linux")]
fn unwrap_wire_sdp(sdp: &str) -> String {
    let t = sdp.trim_start();
    if t.starts_with('{') {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
            if let Some(s) = v.get("sdp").and_then(|x| x.as_str()) {
                if !s.is_empty() {
                    return s.to_string();
                }
            }
        }
    }
    sdp.to_string()
}

#[cfg(target_os = "linux")]
fn unwrap_wire_candidate(raw: &str, frame_mid: &str) -> (String, String) {
    let t = raw.trim();
    if !t.starts_with('{') {
        return (raw.to_string(), frame_mid.to_string());
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
        return (raw.to_string(), frame_mid.to_string());
    };
    let cand = v
        .get("candidate")
        .and_then(|x| x.as_str())
        .unwrap_or_default()
        .to_string();
    let mid = v
        .get("sdpMid")
        .and_then(|x| x.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            v.get("sdpMLineIndex")
                .and_then(|x| x.as_u64())
                .map(|n| n.to_string())
        })
        .unwrap_or_else(|| frame_mid.to_string());
    (cand, mid)
}

async fn handle_frame(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    engine.diag_update(peer_fp, |d| {
        d.last_rx_ms = crate::identity::now_ms();
    });
    if let SecureFrame::CallRoom {
        call_id,
        conv_id,
        kind,
        state,
        participants,
        ..
    } = &frame
    {
        engine.room_receive(peer_fp, call_id, conv_id, kind, state, participants.clone());
        return Ok(());
    }
    if matches!(
        frame,
        SecureFrame::CallInvite { .. }
            | SecureFrame::CallAccept { .. }
            | SecureFrame::CallReject { .. }
            | SecureFrame::CallEnd { .. }
            | SecureFrame::CallOffer { .. }
            | SecureFrame::CallAnswer { .. }
            | SecureFrame::CallIce { .. }
            | SecureFrame::CallAddParticipant { .. }
            | SecureFrame::ScreenShareOffer { .. }
            | SecureFrame::ScreenShareAnswer { .. }
    ) {
        if engine.netlimiter.allow_call_signal(peer_fp) == Decision::Blocked {
            return Err(DistorrentError::Protocol(
                "sinalização de chamada descartada (rate limit)".into(),
            ));
        }
        // Seção 57: is_friend
        let is_friend = engine
            .store
            .get_friend(peer_fp)
            .ok()
            .flatten()
            .map(|(_, s)| s == "accepted")
            .unwrap_or(false);
        let shares_chamada = call_id_do_frame(&frame)
            .map(|cid| engine.store.is_in_call(&cid, &engine.identity.fingerprint))
            .unwrap_or(false);
        let shares_group = engine
            .store
            .group_convs_with_peer(peer_fp)
            .map(|v| !v.is_empty())
            .unwrap_or(false)
            || shares_chamada;
        let shares_comm = engine
            .store
            .list_communities()
            .map(|cs| {
                cs.iter()
                    .any(|(id, _, _)| engine.store.member_role(id, peer_fp).is_some())
            })
            .unwrap_or(false);
        if !is_friend && !shares_group && !shares_comm {
            if let SecureFrame::CallInvite { call_id, .. } = &frame {
                let _ = engine.queue_or_send_call_frame(
                    peer_fp,
                    SecureFrame::CallReject {
                        call_id: call_id.clone(),
                        reason: "não é amigo".into(),
                    },
                );
            }
            return Err(DistorrentError::Protocol(
                "sinalização de chamada de quem não é amigo".into(),
            ));
        }
    }
    match frame {
        SecureFrame::Msg(env) => {
            if engine.is_blocked(peer_fp) {
                return Err(DistorrentError::Protocol("peer bloqueado".into()));
            }
            if env.author_fp != peer_fp {
                return Err(DistorrentError::Protocol(
                    "author != peer da conexão".into(),
                ));
            }
            if !env.verify_with_pubkey(peer_pubkey) {
                return Err(DistorrentError::Protocol(
                    "assinatura da mensagem inválida".into(),
                ));
            }
            if engine.store.message_by_id(&env.id)?.is_some() {
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
                return Ok(());
            }
            engine.spam_gate(peer_fp, &env.body)?;
            let conv_kind = engine.store.get_conversation(&env.conv_id)?.map(|c| c.kind);
            if conv_kind.as_deref() == Some("group") {
                let is_member = engine
                    .store
                    .list_group_members(&env.conv_id)?
                    .iter()
                    .any(|(fp, _)| fp == &env.author_fp);
                if !is_member {
                    return Err(DistorrentError::Protocol(
                        "autor não é membro do grupo".into(),
                    ));
                }
                engine.store.insert_message(&env, "in", "ok")?;
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: String::new(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
            } else if conv_kind.is_none()
                && engine
                    .store
                    .get_friend(peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false)
                && env.conv_id
                    != crate::storage::Store::dm_conversation_id(
                        &engine.identity.fingerprint,
                        peer_fp,
                    )
                && !crate::group_trash::is_dismissed(&engine.store, &env.conv_id)
            {
                // Só vira grupo se o conv_id NÃO é a DM determinística deste
                // peer. Antes, apagar a conversa local e receber uma mensagem
                // de amigo recriava um "grupo" chamado "Grupo" com uma pessoa
                // — e a DM de verdade nunca voltava.
                engine.store.upsert_group_state(
                    &env.conv_id,
                    "Grupo",
                    &[(peer_fp.to_string(), peer_nick.to_string())],
                )?;
                engine.store.insert_message(&env, "in", "ok")?;
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: String::new(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
            } else {
                let is_friend = engine
                    .store
                    .get_friend(peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false);
                // Seção 58: conv
                let conv = engine.open_dm(peer_fp, peer_nick)?;
                if env.conv_id != conv.id {
                    return Err(DistorrentError::Protocol(
                        "conv_id não corresponde à DM deste peer".into(),
                    ));
                }
                // Introdução: o RECEPTOR também conta. Se o cliente do outro
                // lado foi alterado (ou a mensagem é replay), o limite vale
                // aqui — sem isso o gate do emissor seria a única barreira.
                let intro = !is_friend;
                if intro
                    && !engine.store.dm_intro_take(
                        &env.conv_id,
                        peer_fp,
                        crate::social::DM_INTRO_LIMIT,
                    )?
                {
                    return Err(DistorrentError::Protocol(format!(
                        "limite de {} mensagens iniciais deste peer atingido",
                        crate::social::DM_INTRO_LIMIT
                    )));
                }
                if let Err(e) = engine.store.insert_message(&env, "in", "ok") {
                    if intro {
                        let _ = engine.store.dm_intro_refund(&env.conv_id, peer_fp);
                    }
                    return Err(e);
                }
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: String::new(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
            }
        }
        SecureFrame::Ack { msg_id } => {
            engine.diag_update(peer_fp, |d| {
                d.last_ack_ms = crate::identity::now_ms();
            });
            if let Some(m) = engine.store.message_by_id(&msg_id)? {
                if m.direction == "out" {
                    let ack_ok = match engine
                        .store
                        .get_conversation(&m.conv_id)?
                        .map(|c| (c.kind, c.peer_fp))
                    {
                        Some((kind, peer)) if kind == "dm" => peer == peer_fp,
                        Some((kind, _)) if kind == "group" => engine
                            .store
                            .list_group_members(&m.conv_id)?
                            .iter()
                            .any(|(fp, _)| fp == peer_fp),
                        _ => false,
                    };
                    if !ack_ok {
                        return Err(DistorrentError::Protocol(
                            "Ack de peer não autorizado".into(),
                        ));
                    }
                    engine.store.set_message_status(&msg_id, "delivered")?;
                    let is_group = engine
                        .store
                        .get_conversation(&m.conv_id)?
                        .map(|c| c.kind == "group")
                        .unwrap_or(false);
                    if !is_group {
                        engine.store.dequeue_outbox(&msg_id)?;
                    }
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id,
                        status: "delivered".into(),
                    });
                }
            }
        }
        SecureFrame::Read { conv_id, up_to_ts } => {
            engine.diag_update(peer_fp, |d| {
                d.last_ack_ms = crate::identity::now_ms();
            });
            let ack_ok = match engine
                .store
                .get_conversation(&conv_id)?
                .map(|c| (c.kind, c.peer_fp))
            {
                Some((kind, peer)) if kind == "dm" => peer == peer_fp,
                Some((kind, _)) if kind == "group" => engine
                    .store
                    .list_group_members(&conv_id)?
                    .iter()
                    .any(|(fp, _)| fp == peer_fp),
                _ => false,
            };
            if !ack_ok {
                return Err(DistorrentError::Protocol(
                    "Read de peer não autorizado".into(),
                ));
            }
            // Recibo POR MEMBRO: num grupo/canal, o `read` de um participante
            // não pode marcar a mensagem como lida para todos.
            let _ = engine
                .store
                .record_read_receipt(&conv_id, peer_fp, up_to_ts)?;
            let esperados = engine.social_peers_of(&conv_id);
            let ids = engine
                .store
                .messages_read_by_all(&conv_id, up_to_ts, &esperados)?;
            for msg_id in ids {
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id,
                    status: "read".into(),
                });
            }
        }
        SecureFrame::Ping { ts } => {
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::Pong { ts },
                ))
                .ok();
        }
        SecureFrame::Pong { ts } => {
            let now = crate::identity::now_ms();
            if now >= ts {
                let rtt = (now - ts) as u64;
                if rtt <= RELAY_PING_TIMEOUT.as_millis() as u64 {
                    crate::metrics::metrics().rtt_sample(peer_fp, rtt);
                }
            }
        }
        SecureFrame::FriendRequest { nickname } => {
            if engine.netlimiter.allow_friend_request(peer_fp) == Decision::Blocked {
                return Err(DistorrentError::Protocol(
                    "friend request descartado (rate limit)".into(),
                ));
            }
            if engine.is_blocked(peer_fp) {
                // Não confirma nem nega: um bloqueado não pode descobrir que
                // está bloqueado pela resposta.
                return Ok(());
            }
            let nick = cap_str(&nickname, 64);
            let state = engine.store.friend_state(peer_fp)?;
            match state.as_ref().map(|s| s.status.as_str()) {
                Some("accepted") => {
                    // Já somos amigos (o outro lado perdeu o estado): basta
                    // reconfirmar. Não recria linha nem "re-aceita".
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendAccept {
                                nickname: engine.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                }
                // Pedido cruzado: os dois pediram. Aceitar aqui é o único
                // desfecho simétrico; sem isto um lado ficava pendente para
                // sempre enquanto o outro recebia FriendAccept.
                Some("pending_out") | Some("pending_in") => {
                    engine.store.accept_friend(peer_fp, &nick)?;
                    engine.reset_dm_intro_for_peer(peer_fp);
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendAccept {
                                nickname: engine.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                    let _ = engine.events.send(EngineEvent::FriendAccepted {
                        fp: peer_fp.into(),
                        nickname: nick,
                    });
                }
                _ => {
                    // `rejected`/`removed` voltam a ser pendentes, mas o
                    // carimbo de quando o pedido chegou é renovado.
                    engine.store.set_friend_request_in(peer_fp, &nick)?;
                    let _ = engine.events.send(EngineEvent::FriendRequestIn {
                        fp: peer_fp.into(),
                        nickname: nick,
                    });
                }
            }
        }
        SecureFrame::FriendAccept { nickname } => {
            let state = engine.store.friend_state(peer_fp)?;
            let status = state.as_ref().map(|s| s.status.as_str());
            // Bloqueado: aceite atrasado é ignorado sem derrubar a sessão.
            if status == Some("blocked") {
                return Ok(());
            }
            if !matches!(status, Some("pending_out") | Some("accepted")) {
                // Frame antigo/replay: não é motivo para romper a conexão.
                return Ok(());
            }
            if status == Some("accepted") {
                return Ok(());
            }
            let nick = cap_str(&nickname, 64);
            engine.store.accept_friend(peer_fp, &nick)?;
            engine.reset_dm_intro_for_peer(peer_fp);
            let _ = engine.events.send(EngineEvent::FriendAccepted {
                fp: peer_fp.into(),
                nickname: nick,
            });
        }
        SecureFrame::FriendReject => {
            // Recusa é do PEDIDO, não da amizade: preserva histórico e o
            // carimbo de bloqueio. Antes um `DELETE` apagava tudo e o
            // próximo ProfileSet recriava a amizade sozinho.
            engine.store.reject_friend(peer_fp)?;
            let _ = engine
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }
        SecureFrame::FriendRemove => {
            // Quem bloqueou não pode ser "desamigado" pelo outro lado: o
            // bloqueio é local e soberano.
            if !engine.store.is_blocked_fp(peer_fp) {
                engine.store.clear_friendship(peer_fp)?;
            }
            let _ = engine
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }
        SecureFrame::JoinCommunity {
            community_id,
            token,
        } => {
            let comm = engine
                .store
                .get_community(&community_id)?
                .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
            // Servidor PÚBLICO: entrada livre, sem convite e sem aprovação.
            // O rate limit é o que impede "qualquer um entra" virar flood.
            if token.trim().is_empty() {
                if !engine.store.community_is_public(&community_id)? {
                    return Err(DistorrentError::Protocol(
                        "este servidor é privado — peça um convite".into(),
                    ));
                }
                if engine.netlimiter.allow_public_join(peer_fp) == Decision::Blocked {
                    return Err(DistorrentError::Protocol(
                        "muitas tentativas de entrada — aguarde um pouco".into(),
                    ));
                }
                engine
                    .store
                    .upsert_member(&community_id, peer_fp, peer_nick, "member")?;
                let _ = engine.events.send(EngineEvent::MemberJoined {
                    community_id: community_id.clone(),
                    fp: peer_fp.into(),
                    nickname: peer_nick.into(),
                });
                let frame = engine.community_state_payload(&community_id, Some(peer_fp))?;
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
                    .ok();
                engine.broadcast_community_state(&community_id);
                return Ok(());
            }
            let (tok_host, _cid, member_fp, exp, sig) =
                crate::protocol::parse_invite_token(&token)?;
            const WILDCARD: &str = "000000000000";
            let bound = member_fp == WILDCARD || member_fp == peer_fp;
            if _cid != community_id || !bound || comm.2 != tok_host {
                return Err(DistorrentError::Protocol(
                    "token não corresponde ao servidor ou peer".into(),
                ));
            }
            let is_owner = comm.2 == engine.identity.fingerprint;
            if !is_owner
                && !engine
                    .store
                    .list_members(&community_id)?
                    .iter()
                    .any(|(fp, _, _)| fp == &engine.identity.fingerprint)
            {
                return Err(DistorrentError::Protocol(
                    "membro não autorizado como seed deste servidor".into(),
                ));
            }
            if crate::identity::now_ms() > exp {
                return Err(DistorrentError::Protocol("convite expirado".into()));
            }
            let owner_key = if is_owner {
                engine.keypair.public_hex()
            } else {
                engine
                    .store
                    .get_peer(&tok_host)?
                    .map(|p| p.pubkey_hex)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(
                            "chave pública do dono ainda não foi sincronizada".into(),
                        )
                    })?
            };
            if !Keypair::verify(
                &owner_key,
                &crate::protocol::invite_sign_bytes(&community_id, &member_fp, exp),
                &sig,
            )? {
                return Err(DistorrentError::Protocol(
                    "convite com assinatura inválida".into(),
                ));
            }
            engine
                .store
                .upsert_member(&community_id, peer_fp, peer_nick, "member")?;
            engine.clear_pending_join(&community_id);
            let _ = engine.events.send(EngineEvent::MemberJoined {
                community_id: community_id.clone(),
                fp: peer_fp.into(),
                nickname: peer_nick.into(),
            });
            let frame = engine.community_state_payload(&community_id, Some(peer_fp))?;
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
                .ok();
            engine.broadcast_community_state(&community_id);
        }
        SecureFrame::CommunityState {
            community_id,
            name,
            owner_fp,
            channels,
            roles,
            bots,
            member_roles,
            members,
            description,
            category,
            icon,
            is_public,
        } => {
            let allowed = match engine
                .store
                .get_community(&community_id)?
                .map(|(_, _, o)| o)
            {
                Some(stored_owner) => {
                    if stored_owner != owner_fp {
                        false
                    } else if peer_fp == owner_fp {
                        true
                    } else {
                        engine
                            .store
                            .list_members(&community_id)
                            .map(|members| {
                                members.iter().any(|(fp, _, _)| {
                                    fp == &peer_fp && fp != &engine.identity.fingerprint
                                })
                            })
                            .unwrap_or(false)
                    }
                }
                None => {
                    let pending = engine
                        .pending_joins
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&community_id)
                        .cloned();
                    // Seção 60: Some
                    let Some(token) = pending else {
                        return Err(DistorrentError::Protocol(
                            "CommunityState sem convite pendente".into(),
                        ));
                    };
                    // Entrada em servidor PÚBLICO vai sem token: o host já
                    // aceitou e provou ser o dono assinando o próprio estado.
                    if token.trim().is_empty() {
                        peer_fp == owner_fp
                    } else {
                        let (host_fp, token_cid, member_fp, exp, sig) =
                            crate::protocol::parse_invite_token(&token)?;
                        const WILDCARD: &str = "000000000000";
                        let member_bound =
                            member_fp == WILDCARD || member_fp == engine.identity.fingerprint;
                        let host_key = engine.store.get_peer(&host_fp)?.map(|p| p.pubkey_hex);
                        if host_fp != owner_fp
                            || token_cid != community_id
                            || !member_bound
                            || crate::identity::now_ms() > exp
                        {
                            false
                        } else if let Some(host_key) = host_key {
                            Keypair::verify(
                                &host_key,
                                &crate::protocol::invite_sign_bytes(&community_id, &member_fp, exp),
                                &sig,
                            )
                            .unwrap_or(false)
                        } else {
                            false
                        }
                    }
                }
            };
            if !allowed {
                return Err(DistorrentError::Protocol(
                    "CommunityState fora do host".into(),
                ));
            }
            engine.store.community_full_sync(
                &community_id,
                &name,
                &owner_fp,
                &channels,
                &roles,
                &bots,
                &member_roles,
                &members,
                &(description, category, icon),
                is_public,
            )?;
            engine.clear_pending_join(&community_id);
            let _ = engine
                .events
                .send(EngineEvent::CommunityJoined { community_id, name });
        }
        SecureFrame::CommunityKicked { community_id } => {
            let (is_host, name) = engine
                .store
                .get_community(&community_id)?
                .map(|(_, n, owner)| (owner == peer_fp, n))
                .unwrap_or((false, community_id.clone()));
            if !is_host {
                return Err(DistorrentError::Protocol(
                    "CommunityKicked fora do host".into(),
                ));
            }
            engine.store.community_remove_local(&community_id)?;
            engine.clear_pending_join(&community_id);
            let _ = engine.events.send(EngineEvent::CommunityRemoved {
                community_id: community_id.clone(),
            });
            let _ = engine.events.send(EngineEvent::Error {
                context: format!("você foi removido do servidor {name}"),
            });
        }
        SecureFrame::GroupCreated {
            conv_id,
            title,
            members,
            owner_fp,
        } => {
            if !members.iter().any(|(fp, _)| fp == peer_fp) {
                return Err(DistorrentError::Protocol(
                    "GroupCreated sem o criador na lista".into(),
                ));
            }
            if members.len() > 10 {
                return Err(DistorrentError::Protocol(
                    "GroupCreated com roster acima do limite".into(),
                ));
            }
            let eu = &engine.identity.fingerprint;
            let me_incluiu = members.iter().any(|(fp, _)| fp == eu);
            // Só o CRIADOR do grupo pode reescrever o roster. Antes qualquer
            // membro mandava GroupCreated e mudava (ou esvaziava) o grupo de
            // todos, e um peer removido reentrava sozinho reenviando o frame.
            let dono_conhecido = engine
                .store
                .group_owner(&conv_id)?
                .or_else(|| {
                    if owner_fp.is_empty() {
                        None
                    } else {
                        Some(owner_fp.clone())
                    }
                })
                .or_else(|| crate::group_trash::owner_of(&engine.store, &conv_id))
                .or_else(|| members.first().map(|(fp, _)| fp.clone()));
            if let Some(dono) = dono_conhecido.filter(|d| !d.is_empty()) {
                if dono != peer_fp {
                    // Roster reenviado por quem não criou é ignorado em
                    // silêncio: derrubar a sessão puniria o mensageiro e não
                    // impede nada (o próximo tick reenviaria).
                    return Ok(());
                }
            }
            // Grava o dono. `owner_fp` do frame é a fonte nova; frames antigos
            // vêm com vazio e a convenção do primeiro membro vale como antes.
            let dono = if owner_fp.is_empty() {
                peer_fp.to_string()
            } else {
                owner_fp.clone()
            };
            if dono != peer_fp {
                return Err(DistorrentError::Protocol(
                    "GroupCreated com owner_fp divergente do remetente".into(),
                ));
            }
            if !members.is_empty() {
                let _ = engine.store.group_owner_set(&conv_id, &dono);
            }
            if crate::group_trash::is_dismissed(&engine.store, &conv_id) {
                if !me_incluiu {
                    return Ok(());
                }
                // Só o criador me readiciona de propósito. Sem esta checagem
                // qualquer membro que reenviasse o roster antigo (rename,
                // add-membro, flush de reconexão) ressuscitava o grupo que eu
                // deixei — era o "saio e ele volta minutos depois".
                let criador = crate::group_trash::owner_of(&engine.store, &conv_id);
                let primeiro_do_roster = members
                    .first()
                    .map(|(fp, _)| fp.clone())
                    .unwrap_or_default();
                // Criador gravado que sumiu do roster é dado velho: cai para a
                // convenção do resto do grupo (criador = primeiro da lista),
                // senão eu nunca mais conseguiria voltar.
                let dono_conhecido = criador
                    .filter(|fp| members.iter().any(|(m, _)| m == fp))
                    .unwrap_or_else(|| primeiro_do_roster.clone());
                if dono_conhecido != peer_fp {
                    return Ok(());
                }
                let _ = crate::group_trash::restore(&engine.store, &conv_id);
            }
            engine
                .store
                .upsert_group_state(&conv_id, &title, &members)?;
            let _ = engine
                .events
                .send(EngineEvent::GroupSynced { conv_id, title });
        }
        SecureFrame::GroupMemberAdded {
            conv_id,
            fp,
            nickname,
        } => {
            let membros = engine.store.list_group_members(&conv_id)?;
            if !membros.iter().any(|(f, _)| f == peer_fp) {
                return Err(DistorrentError::Protocol(
                    "GroupMemberAdded de fora do grupo".into(),
                ));
            }
            // Só o criador adiciona. "Estar no grupo" não é permissão.
            let dono = engine
                .store
                .group_owner(&conv_id)?
                .unwrap_or_else(|| membros.first().map(|(f, _)| f.clone()).unwrap_or_default());
            if dono != peer_fp {
                return Err(DistorrentError::Protocol(
                    "só quem criou o grupo adiciona membros".into(),
                ));
            }
            if membros.len() >= 10 && !membros.iter().any(|(f, _)| f == &fp) {
                return Err(DistorrentError::Protocol(
                    "GroupMemberAdded acima do limite".into(),
                ));
            }
            engine.store.add_group_member(&conv_id, &fp, &nickname)?;
            let _ = engine.events.send(EngineEvent::GroupSynced {
                conv_id,
                title: String::new(),
            });
        }
        SecureFrame::GroupDeleted { conv_id } => {
            let membros = engine.store.list_group_members(&conv_id)?;
            let dono = engine
                .store
                .group_owner(&conv_id)?
                .unwrap_or_else(|| membros.first().map(|(f, _)| f.clone()).unwrap_or_default());
            if dono != peer_fp {
                return Err(DistorrentError::Protocol(
                    "GroupDeleted de quem não criou o grupo".into(),
                ));
            }
            engine.store.leave_group_local(&conv_id)?;
            let _ = engine.events.send(EngineEvent::GroupSynced {
                conv_id,
                title: String::new(),
            });
        }
        SecureFrame::ChannelMsg {
            community_id,
            channel_id,
            env,
            bot_id,
        } => {
            let comm = engine
                .store
                .get_community(&community_id)?
                .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
            let is_host = comm.2 == engine.identity.fingerprint;
            // Seção 61: bot_id
            let bot_id = if bot_id.trim().is_empty() {
                String::new()
            } else {
                if !is_host {
                    return Err(DistorrentError::Protocol(
                        "mensagem de bot fora do host".into(),
                    ));
                }
                if !engine
                    .store
                    .bots_list(&community_id)?
                    .iter()
                    .any(|b| b.id == bot_id)
                {
                    return Err(DistorrentError::Protocol("bot inexistente".into()));
                }
                bot_id.trim().to_string()
            };
            if is_host {
                if engine
                    .store
                    .member_role(&community_id, &env.author_fp)
                    .is_none()
                {
                    return Err(DistorrentError::Protocol("autor não é membro".into()));
                }
                if !engine
                    .store
                    .list_channels(&community_id)?
                    .iter()
                    .any(|(id, _)| *id == channel_id)
                {
                    return Err(DistorrentError::Protocol("canal inexistente".into()));
                }
                if env.conv_id != channel_id {
                    return Err(DistorrentError::Protocol("env.conv_id != canal".into()));
                }
                if !env.verify_with_pubkey(peer_pubkey) {
                    return Err(DistorrentError::Protocol("assinatura inválida".into()));
                }
                if env.author_fp != peer_fp {
                    return Err(DistorrentError::Protocol(
                        "author != peer da conexão".into(),
                    ));
                }
                engine.spam_gate(peer_fp, &env.body)?;
                engine.server_rules_gate(&community_id, &env.author_fp, &env.body)?;
                engine.gate_speech_for(&community_id, &channel_id, &env.author_fp)?;
                if engine.store.message_by_id(&env.id)?.is_some() {
                    engine.host_relay(&community_id, &channel_id, &env, &bot_id)?;
                    return Ok(());
                }
                if bot_id.is_empty() {
                    engine.store.insert_message(&env, "in", "ok")?;
                } else {
                    engine
                        .store
                        .insert_message_as_bot(&env, "in", "ok", &bot_id)?;
                }
                // Menções são registradas no host para TODOS os membros: é
                // dele que sai o contador de "menções não lidas" de cada um.
                for target in engine.store.mention_targets(&env.body) {
                    if target == "everyone" {
                        for (fp, _, _) in engine.store.list_members(&community_id)? {
                            if fp != env.author_fp {
                                engine.store.mention_add(&env.id, &channel_id, &fp).ok();
                            }
                        }
                    } else {
                        engine.store.mention_add(&env.id, &channel_id, &target).ok();
                    }
                }
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: bot_id.clone(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine.host_relay(&community_id, &channel_id, &env, &bot_id)?;
            } else {
                if peer_fp != comm.2 {
                    return Err(DistorrentError::Protocol("ChannelMsg fora do host".into()));
                }
                if env.conv_id != channel_id {
                    return Err(DistorrentError::Protocol("env.conv_id != canal".into()));
                }
                if engine
                    .store
                    .member_role(&community_id, &env.author_fp)
                    .is_none()
                {
                    return Err(DistorrentError::Protocol("autor não é membro".into()));
                }
                let sig_ok = if env.author_fp == peer_fp {
                    env.verify_with_pubkey(peer_pubkey)
                } else {
                    match engine.store.get_peer(&env.author_fp)?.map(|p| p.pubkey_hex) {
                        Some(author_pub) => env.verify_with_pubkey(&author_pub),
                        // Sem a chave do autor não há como provar que foi ele.
                        // Antes isso era aceito com um `warn` — uma mensagem
                        // forjada em nome de um membro passava pelo host.
                        None => false,
                    }
                };
                if !sig_ok {
                    return Err(DistorrentError::Protocol("assinatura inválida".into()));
                }
                if engine.store.message_by_id(&env.id)?.is_some() {
                    return Ok(());
                }
                if bot_id.is_empty() {
                    engine.store.insert_message(&env, "in", "ok")?;
                } else {
                    engine
                        .store
                        .insert_message_as_bot(&env, "in", "ok", &bot_id)?;
                }
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: bot_id.clone(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
            }
        }
        SecureFrame::ChannelAck { env_id } => {
            if engine.store.message_by_id(&env_id)?.map(|m| m.direction) == Some("out".into()) {
                let ack_ok = engine
                    .store
                    .message_by_id(&env_id)?
                    .map(|m| m.conv_id)
                    .and_then(|conv| engine.store.channel_community(&conv).ok().flatten())
                    .and_then(|cid| engine.store.get_community(&cid).ok().flatten())
                    .map(|(_, _, owner)| owner == peer_fp)
                    .unwrap_or(false);
                if !ack_ok {
                    return Err(DistorrentError::Protocol("ChannelAck fora do host".into()));
                }
                engine.store.set_message_status(&env_id, "delivered")?;
                engine.store.dequeue_outbox(&env_id)?;
                // Seção 62: _
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: env_id,
                    status: "delivered".into(),
                });
            }
        }
        SecureFrame::CallInvite {
            call_id,
            kind,
            target_fp,
        } => {
            // `target_fp` vazio em versões antigas. Quando vem preenchido,
            // precisa ser eu: um convite endereçado a outra pessoa não pode
            // tocar a minha campainha.
            if !target_fp.is_empty() && target_fp != engine.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "CallInvite endereçado a outro peer".into(),
                ));
            }
            if engine.ring_is_new(&call_id, peer_fp) {
                let _ = engine.events.send(EngineEvent::CallIncoming {
                    call_id: call_id.clone(),
                    from_fp: peer_fp.into(),
                    kind,
                });
            }
            engine.queue_or_send_call_frame(
                peer_fp,
                SecureFrame::CallRinging {
                    call_id: call_id.clone(),
                },
            );
        }
        SecureFrame::CallRinging { call_id } => {
            if engine.store.get_call_host(&call_id)?.as_deref()
                != Some(engine.identity.fingerprint.as_str())
            {
                return Err(DistorrentError::Protocol(
                    "CallRinging para chamada não iniciada por mim".into(),
                ));
            }
            engine.store.join_call(&call_id, peer_fp)?;
            let _ = engine.events.send(EngineEvent::CallRingingEv {
                call_id,
                from_fp: peer_fp.into(),
            });
        }
        SecureFrame::CallAccept { call_id } => {
            if engine.store.get_call_host(&call_id)?.as_deref()
                != Some(engine.identity.fingerprint.as_str())
            {
                return Err(DistorrentError::Protocol(
                    "CallAccept para chamada não iniciada por mim".into(),
                ));
            }
            engine.store.join_call(&call_id, peer_fp)?;
            let _ = engine.events.send(EngineEvent::CallAcceptedEv {
                call_id,
                from_fp: peer_fp.into(),
            });
        }
        SecureFrame::CallReject { call_id, reason } => {
            let _ = engine.events.send(EngineEvent::CallRejected {
                call_id,
                from_fp: peer_fp.into(),
                reason,
            });
        }
        SecureFrame::CallEnd { call_id } => {
            engine.store.leave_call(&call_id, peer_fp)?;
            let sozinho = engine
                .store
                .call_participants(&call_id)
                .unwrap_or_default()
                .iter()
                .filter(|f| **f != engine.identity.fingerprint)
                .count()
                == 0;
            if sozinho {
                engine.store.end_call(&call_id)?;
            }
            #[cfg(target_os = "linux")]
            if engine.voice_is_native(&call_id, peer_fp) {
                engine.voice_hangup_peer(&call_id, peer_fp);
                engine.voice_forget_peer(&call_id, peer_fp);
            }
            #[cfg(target_os = "linux")]
            engine.forget_held_call(&call_id);
            let _ = engine.events.send(EngineEvent::CallEnded {
                call_id,
                from_fp: peer_fp.into(),
            });
        }
        SecureFrame::CallOffer { call_id, sdp } => {
            #[cfg(target_os = "linux")]
            {
                if !engine.voice_is_native(&call_id, peer_fp) && engine.native_voice_available() {
                    engine.auto_register_voice_channel(&call_id, peer_fp);
                }
                if !engine.voice_is_native(&call_id, peer_fp) && engine.native_voice_available() {
                    if engine.hold_call_offer(&call_id, peer_fp, &sdp) {
                        return Ok(());
                    }
                }
                if engine.voice_absorb_offer(&call_id, peer_fp, &sdp).await? {
                    return Ok(());
                }
            }
            let _ = engine.events.send(EngineEvent::CallOfferEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }
        SecureFrame::CallAnswer { call_id, sdp } => {
            #[cfg(target_os = "linux")]
            if engine.voice_absorb_answer(&call_id, peer_fp, &sdp).await {
                return Ok(());
            }
            let _ = engine.events.send(EngineEvent::CallAnswerEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }
        SecureFrame::CallIce {
            call_id,
            candidate,
            mid,
        } => {
            #[cfg(target_os = "linux")]
            {
                if !engine.voice_is_native(&call_id, peer_fp)
                    && engine.native_voice_available()
                    && engine.hold_call_ice(&call_id, peer_fp, &candidate, &mid)
                {
                    return Ok(());
                }
                if engine
                    .voice_absorb_ice(&call_id, peer_fp, &candidate, &mid)
                    .await
                {
                    return Ok(());
                }
            }
            let _ = engine.events.send(EngineEvent::CallIceEv {
                call_id,
                from_fp: peer_fp.into(),
                candidate,
                mid,
            });
        }
        SecureFrame::CallAddParticipant { call_id, fp, kind } => {
            // Quem adiciona precisa ter relação comigo (amigo/grupo/servidor),
            // e a sala precisa ser de uma conversa em que eu esteja. Antes
            // qualquer peer "adicionava" um terceiro à minha chamada.
            if !engine
                .store
                .is_in_call(&call_id, &engine.identity.fingerprint)
            {
                return Err(DistorrentError::Protocol(
                    "CallAddParticipant numa chamada em que não estou".into(),
                ));
            }
            if fp != peer_fp && !engine.is_social_contact(&fp) && !engine.is_social_contact(peer_fp)
            {
                return Err(DistorrentError::Protocol(
                    "CallAddParticipant de quem não é contato".into(),
                ));
            }
            #[cfg(target_os = "linux")]
            {
                let ja_na_chamada = engine.voice_is_native(&call_id, peer_fp);
                if !ja_na_chamada {
                    engine.native_pair_begin(&call_id, peer_fp);
                }
            }
            // Seção 63: _
            let _ = engine.events.send(EngineEvent::CallParticipantAdded {
                call_id: call_id.clone(),
                fp,
                kind: kind.clone(),
            });
            if !kind.is_empty() {
                let _ = engine.events.send(EngineEvent::CallIncoming {
                    call_id,
                    from_fp: peer_fp.into(),
                    kind,
                });
            }
        }
        SecureFrame::VoiceJoin {
            community_id,
            channel_id,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol(
                    "não é membro da comunidade".into(),
                ));
            }
            engine
                .store
                .set_voice_state(&community_id, &channel_id, peer_fp, false, false)?;
            #[cfg(target_os = "linux")]
            {
                engine.voice_mesh_maybe_offer(&community_id, &channel_id, peer_fp);
            }
            if engine.identity.fingerprint.as_str() < peer_fp {
                let estou_no_canal = engine
                    .store
                    .my_voice_states(&engine.identity.fingerprint)
                    .map(|v| {
                        v.iter()
                            .any(|(c, ch, _, _)| c == &community_id && ch == &channel_id)
                    })
                    .unwrap_or(false);
                if estou_no_canal {
                    let (muted, deafened) = engine
                        .store
                        .my_voice_states(&engine.identity.fingerprint)
                        .ok()
                        .and_then(|v| {
                            v.into_iter()
                                .find(|(c, ch, _, _)| c == &community_id && ch == &channel_id)
                                .map(|(_, _, m, d)| (m, d))
                        })
                        .unwrap_or((false, false));
                    let _ = engine.cmd_tx.send(EngineCmd::SendToPeer(
                        peer_fp.to_string(),
                        SecureFrame::VoiceState {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                            muted,
                            deafened,
                            speaking: false,
                        },
                    ));
                }
            }
            let _ = engine.events.send(EngineEvent::VoiceJoined {
                community_id,
                channel_id,
                fp: peer_fp.into(),
            });
        }
        SecureFrame::VoiceLeave {
            community_id,
            channel_id,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol(
                    "não é membro da comunidade".into(),
                ));
            }
            engine
                .store
                .leave_voice(&community_id, &channel_id, peer_fp)?;
            #[cfg(target_os = "linux")]
            {
                let call_id = format!("voice-{}-{}", community_id, channel_id);
                if engine.voice_is_native(&call_id, peer_fp) {
                    engine.voice_hangup_peer(&call_id, peer_fp);
                    engine.voice_forget_peer(&call_id, peer_fp);
                }
            }
            let _ = engine.events.send(EngineEvent::VoiceLeft {
                community_id,
                channel_id,
                fp: peer_fp.into(),
            });
        }
        SecureFrame::VoiceState {
            community_id,
            channel_id,
            muted,
            deafened,
            speaking: _,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol(
                    "não é membro da comunidade".into(),
                ));
            }
            engine
                .store
                .set_voice_state(&community_id, &channel_id, peer_fp, muted, deafened)?;
            #[cfg(target_os = "linux")]
            engine.voice_mesh_maybe_offer(&community_id, &channel_id, peer_fp);
            let _ = engine.events.send(EngineEvent::VoiceStateChanged {
                community_id,
                channel_id,
                fp: peer_fp.into(),
                muted,
                deafened,
            });
        }
        SecureFrame::CallRoom { .. } => {}
        SecureFrame::FileAnnounce {
            file_id,
            name,
            size,
            chunks,
            hash,
            chunk_hashes,
        } => {
            if file_id.len() > 128 || name.len() > 255 || hash.len() > 128 {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com campos gigantes".into(),
                ));
            }
            if chunks > 1_000_000 {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com chunks excessivos".into(),
                ));
            }
            const CHUNK_BYTES: u64 = 256 * 1024;
            let expected_chunks = std::cmp::max(1, size.div_ceil(CHUNK_BYTES));
            if chunks as u64 != expected_chunks && size > 0 {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com chunks incompatíveis com o tamanho".into(),
                ));
            }
            if size > MAX_ANNOUNCED_FILE_BYTES {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com tamanho acima do teto".into(),
                ));
            }
            if let Some(hs) = &chunk_hashes {
                if hs.len() != chunks as usize {
                    return Err(DistorrentError::Protocol(
                        "FileAnnounce com chunk_hashes fora de cardinalidade".into(),
                    ));
                }
                if hs.iter().any(|h| h.is_empty() || h.len() > 128) {
                    return Err(DistorrentError::Protocol(
                        "FileAnnounce com chunk_hash inválido".into(),
                    ));
                }
            }
            // Seção 64: name
            let name = cap_str(&name, 255);
            let _ = engine.store.announce_file(
                &file_id,
                &name,
                size as i64,
                chunks as i64,
                &hash,
                peer_fp,
            );
            if let Some(hs) = &chunk_hashes {
                let hs_json = serde_json::to_string(hs).unwrap_or_else(|_| "[]".into());
                let _ = engine
                    .store
                    .kv_set(&format!("file:chunk_hashes:{file_id}"), &hs_json);
            }
            let _ = engine.events.send(EngineEvent::FileAnnounceEv {
                file_id: file_id.clone(),
                name: name.clone(),
                size,
                chunks,
                hash: hash.clone(),
                from_fp: peer_fp.into(),
                chunk_hashes: chunk_hashes.clone().unwrap_or_default(),
            });
        }
        SecureFrame::FileChunkRequest { file_id, index } => {
            if engine.netlimiter.allow_chunk_request(peer_fp) == Decision::Blocked {
                return Err(DistorrentError::Protocol(
                    "chunk request descartado (rate limit)".into(),
                ));
            }
            let _ = engine.events.send(EngineEvent::FileChunkRequestEv {
                file_id,
                index,
                from_fp: peer_fp.into(),
            });
        }
        SecureFrame::FileChunkData {
            file_id,
            index,
            data_b64,
        } => {
            if data_b64.len() > MAX_CHUNK_BYTES * 4 / 3 + 8 {
                return Err(DistorrentError::Protocol(
                    "FileChunkData acima do tamanho de bloco".into(),
                ));
            }
            if index > 16_777_216 {
                return Err(DistorrentError::Protocol(
                    "FileChunkData com índice absurdo".into(),
                ));
            }
            let _ = engine.events.send(EngineEvent::FileChunkDataEv {
                file_id,
                index,
                data_b64,
                from_fp: peer_fp.into(),
            });
        }
        SecureFrame::FileHave {
            file_id: _,
            indices: _,
        } => {}
        SecureFrame::ScreenShareOffer { call_id, sdp } => {
            let _ = engine.events.send(EngineEvent::ScreenShareOfferEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }
        SecureFrame::ScreenShareAnswer { call_id, sdp } => {
            let _ = engine.events.send(EngineEvent::CallAnswerEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }
        SecureFrame::PeerExchange { peers } => {
            for p in peers {
                if p.fp == engine.identity.fingerprint {
                    continue;
                }
                if !crate::identity::fingerprint_matches(&p.fp, &p.pubkey_hex) {
                    continue;
                }
                if p.addr.is_none() {
                    continue;
                }
                let online = engine.online_peer_fps().contains(&p.fp);
                let via_relay = online && engine.is_peer_via_relay(&p.fp);
                if online && !via_relay {
                    continue;
                }
                if !online
                    && engine.peer_state(&p.fp) != crate::net::engine::NetworkState::Disconnected
                {
                    continue;
                }
                let _ = engine.store.upsert_peer(&p);
                if let Some(addr_str) = p.addr {
                    if let Ok(addr) = addr_str.parse::<std::net::SocketAddr>() {
                        engine
                            .cmd_tx
                            .send(EngineCmd::ConnectTo(addr, Some(p.fp)))
                            .ok();
                    }
                }
            }
        }
        SecureFrame::PeerRelayPut { topic, body } => {
            if engine.peer_relay_serving_enabled() {
                let _ = crate::net::peer_relay::put(peer_fp, &topic, &body);
            }
        }
        SecureFrame::PeerRelayGet { req_id, topic } => {
            if engine.peer_relay_serving_enabled() {
                let bodies = crate::net::peer_relay::get(peer_fp, &topic, req_id);
                let bodies = crate::net::peer_relay::fit_relay_data(bodies);
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.to_string(),
                        SecureFrame::PeerRelayData { req_id, bodies },
                    ))
                    .ok();
            }
        }
        SecureFrame::PeerRelayData { req_id, bodies } => {
            if engine.peer_relay_fp().as_deref() != Some(peer_fp) {
                debug!(%peer_fp, "peer-relay: PeerRelayData ignorado (não é o intermediário)");
                return Ok(());
            }
            let backend = engine.peer_relay_backend_for(peer_fp);
            if !backend.deliver(req_id, bodies) {
                debug!("peer-relay: PeerRelayData órfão (req_id={req_id})");
            }
        }
        SecureFrame::Bye => return Err(DistorrentError::Protocol("peer encerrou (Bye)".into())),
        // ------------------------------------------------------------------
        // Autenticidade de build
        // ------------------------------------------------------------------
        SecureFrame::BuildChallenge {
            nonce_hex,
            transcript_hash,
            ..
        } => {
            if engine.netlimiter.allow_attest(peer_fp) == Decision::Blocked {
                debug!(peer_fp, "desafio de atestação descartado (rate limit)");
                return Ok(());
            }
            let nonce_bytes = hex::decode(&nonce_hex).ok();
            let Some(nonce_arr) = nonce_bytes.and_then(|v| <[u8; 32]>::try_from(v).ok()) else {
                debug!(
                    peer_fp,
                    "desafio de atestação com nonce inválido — ignorado"
                );
                return Ok(());
            };
            // O hash do transcript é conferido aqui: um peer não pode desafiar
            // em nome de outra sessão.
            let meu = engine
                .attest_transcript
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(peer_fp)
                .cloned();
            if meu.as_deref() != Some(transcript_hash.as_str()) {
                debug!(
                    peer_fp,
                    "desafio de atestação com transcript de outra sessão — ignorado"
                );
                return Ok(());
            }
            let Some(att) = engine.own_build_attestation(nonce_arr, &transcript_hash) else {
                return Ok(());
            };
            let Ok(wire) = serde_json::to_vec(&att) else {
                return Ok(());
            };
            engine.send_to_peer(
                peer_fp.to_string(),
                SecureFrame::BuildAttestResponse {
                    attestation_hex: hex::encode(wire),
                },
            );
        }
        SecureFrame::BuildAttestResponse { attestation_hex } => {
            if engine.netlimiter.allow_attest(peer_fp) == Decision::Blocked {
                debug!(peer_fp, "resposta de atestação descartada (rate limit)");
                return Ok(());
            }
            // Desafio que ESTE lado enviou: sem ele, não há o que verificar.
            let expected = engine
                .attest_nonce
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(peer_fp)
                .copied();
            let Some(expected_nonce) = expected else {
                debug!(peer_fp, "resposta de atestação sem desafio pendente");
                return Ok(());
            };
            let Some(transcript) = engine
                .attest_transcript
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(peer_fp)
                .cloned()
            else {
                return Ok(());
            };
            if attestation_hex.len() > 256 * 1024 {
                debug!(peer_fp, "resposta de atestação acima do limite");
                return Ok(());
            }
            let Ok(bytes) = hex::decode(&attestation_hex) else {
                debug!(peer_fp, "resposta de atestação não é hex");
                return Ok(());
            };
            let att: crate::release::BuildAttestation = match serde_json::from_slice(&bytes) {
                Ok(a) => a,
                Err(_) => {
                    debug!(peer_fp, "resposta de atestação malformada");
                    return Ok(());
                }
            };
            // Sem orçamento de falhas: descarta ANTES de gastar CPU. Um peer
            // que só manda assinatura inválida não escolhe quanto trabalho o
            // receptor faz.
            if !engine.netlimiter.attest_failure_budget(peer_fp) {
                debug!(
                    peer_fp,
                    "orçamento de atestação esgotado — resposta ignorada"
                );
                return Ok(());
            }
            // Trabalho criptográfico com teto: um atacante não escolhe quanto
            // de CPU o receptor gasta.
            let Some(_slot) = engine.netlimiter.try_attest_slot() else {
                debug!(peer_fp, "resposta de atestação descartada (teto global)");
                return Ok(());
            };
            let trust = engine
                .release_trust
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .trust()
                .cloned();
            let floor = engine.memory_floor();
            let verdict = crate::release::verify_attestation(
                trust.as_ref(),
                &att,
                peer_fp,
                peer_pubkey,
                &transcript,
                &expected_nonce,
                floor,
            );
            let veredito_ok = verdict.is_verified();
            if !veredito_ok && !engine.netlimiter.note_attest_failure(peer_fp) {
                debug!(
                    peer_fp,
                    "assinaturas inválidas repetidas — ignorando novas respostas"
                );
            }
            engine.record_peer_trust(peer_fp, verdict);
            // O nonce foi consumido: a próxima resposta precisa de novo desafio.
            engine
                .attest_nonce
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(peer_fp);
        }
        SecureFrame::BuildManifestPush { manifest_hex } => {
            if engine.netlimiter.allow_manifest_push(peer_fp) == Decision::Blocked {
                debug!(peer_fp, "push de manifesto descartado (rate limit)");
                return Ok(());
            }
            match engine.accept_peer_manifest(peer_fp, &manifest_hex) {
                Ok(true) => {}
                Ok(false) => debug!(peer_fp, "manifesto de peer recusado na verificação"),
                Err(e) => debug!(peer_fp, "manifesto de peer inválido: {e}"),
            }
        }
        SecureFrame::UpdateHint {
            version,
            manifest_hash,
        } => {
            // Aviso só. Nada é baixado nem executado por causa dele; o
            // atualizador decide contra o manifesto verificado localmente.
            if engine.peer_proto(peer_fp) >= crate::release::ATTEST_PROTO_V {
                debug!(peer_fp, %version, %manifest_hash, "peer avisou de atualização");
            }
        }
        SecureFrame::React {
            conv_id,
            msg_id,
            emoji,
            add: add_from_peer,
            reactor_fp: _,
        } => {
            receive_reaction(
                engine,
                peer_fp,
                &conv_id,
                &msg_id,
                &emoji,
                add_from_peer,
                std::time::Instant::now(),
            )?;
        }
        SecureFrame::Reply {
            conv_id,
            msg_id,
            reply_to,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            // Seção 65: Some
            let Some(mine) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(DistorrentError::Protocol(
                    "citação de mensagem inexistente".into(),
                ));
            };
            if mine.conv_id != *conv_id {
                return Err(DistorrentError::Protocol(
                    "citação de conversa divergente".into(),
                ));
            }
            if mine.author_fp != peer_fp {
                return Err(DistorrentError::Protocol("só o autor cita assim".into()));
            }
            let target = engine.store.message_by_id(&reply_to).ok().flatten();
            if target.as_ref().map(|t| &t.conv_id) != Some(&conv_id) {
                return Err(DistorrentError::Protocol(
                    "alvo de citação inexistente".into(),
                ));
            }
            engine.store.msg_set_reply(&msg_id, &conv_id, &reply_to)?;
            let _ = engine.events.send(EngineEvent::MessageReply {
                msg_id: msg_id.clone(),
                reply_to: reply_to.clone(),
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::Reply {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                                reply_to: reply_to.clone(),
                            },
                        ))
                        .ok();
                }
            }
        }
        SecureFrame::MsgEdit {
            conv_id,
            msg_id,
            body,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let Some(orig) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(DistorrentError::Protocol(
                    "edição de mensagem inexistente".into(),
                ));
            };
            if orig.conv_id != conv_id {
                return Err(DistorrentError::Protocol("conversa divergente".into()));
            }
            if orig.author_fp != peer_fp {
                return Err(DistorrentError::Protocol("só o autor edita".into()));
            }
            let nb = cap_str(&body, 4000);
            if nb.trim().is_empty() {
                return Err(DistorrentError::Protocol("corpo vazio".into()));
            }
            let _ = engine.store.msg_edit(&msg_id, &conv_id, &nb);
            let _ = engine.events.send(EngineEvent::MessageEdited {
                msg_id: msg_id.clone(),
                conv_id: conv_id.clone(),
                body: nb.clone(),
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::MsgEdit {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                                body: nb.clone(),
                            },
                        ))
                        .ok();
                }
            }
        }
        SecureFrame::MsgDelete { conv_id, msg_id } => {
            let Some(orig) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Ok(());
            };
            if orig.conv_id != conv_id {
                return Ok(());
            }
            let is_author = orig.author_fp == peer_fp;
            if !is_author && !engine.can_moderate_conv(&conv_id, peer_fp) {
                return Err(DistorrentError::Protocol(
                    "sem permissão para apagar".into(),
                ));
            }
            let _ = engine.store.msg_delete(&msg_id, &conv_id);
            let _ = engine.events.send(EngineEvent::MessageDeleted {
                msg_id: msg_id.clone(),
                conv_id: conv_id.clone(),
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::MsgDelete {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                            },
                        ))
                        .ok();
                }
            }
        }
        SecureFrame::MsgPin {
            conv_id,
            msg_id,
            pinned,
        } => {
            if !engine.can_moderate_conv(&conv_id, peer_fp) {
                return Err(DistorrentError::Protocol("sem permissão para fixar".into()));
            }
            let Some(orig) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(DistorrentError::Protocol(
                    "pin de mensagem inexistente".into(),
                ));
            };
            if orig.conv_id != conv_id {
                return Err(DistorrentError::Protocol(
                    "pin de conversa divergente".into(),
                ));
            }
            engine.store.msg_pin(&msg_id, &conv_id, pinned, peer_fp)?;
            let _ = engine.events.send(EngineEvent::MessagePinned {
                msg_id: msg_id.clone(),
                conv_id: conv_id.clone(),
                pinned,
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::MsgPin {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                                pinned,
                            },
                        ))
                        .ok();
                }
            }
        }
        SecureFrame::Forward {
            conv_id,
            channel_id,
            env,
            from_label,
        } => {
            if env.author_fp != peer_fp || !env.verify_with_pubkey(peer_pubkey) {
                return Err(DistorrentError::Protocol("encaminhamento inválido".into()));
            }
            // Encaminhar para um CANAL passa pelo host, como qualquer
            // ChannelMsg. Antes um amigo injetava `Forward` direto no meu
            // banco com conv_id de canal alheio, sem o host validar.
            if !channel_id.is_empty() {
                if let Some(cid) = engine.store.channel_community(&channel_id)? {
                    let host = engine
                        .store
                        .get_community(&cid)?
                        .map(|(_, _, owner)| owner)
                        .unwrap_or_default();
                    if engine.identity.fingerprint != host {
                        return Err(DistorrentError::Protocol(
                            "Forward para canal fora do host".into(),
                        ));
                    }
                    if engine.store.member_role(&cid, peer_fp).is_none() {
                        return Err(DistorrentError::Protocol(
                            "Forward de quem não é membro".into(),
                        ));
                    }
                }
            } else if !engine.is_social_contact(peer_fp) {
                return Err(DistorrentError::Protocol(
                    "Forward de quem não é contato".into(),
                ));
            }
            // Seção 66: label
            let label = cap_str(&from_label, 120);
            if engine.store.message_by_id(&env.id)?.is_some() {
                return Ok(());
            }
            let _ = engine.store.msg_set_forward(&env.id, &conv_id, &label);
            let _ = engine.store.insert_message(&env, "in", "ok");
            let stored = engine.store.message_by_id(&env.id).ok().flatten();
            if let Some(sm) = stored {
                let _ = engine.events.send(EngineEvent::MessageNew(sm));
            }
        }
        SecureFrame::PresenceSet {
            status,
            custom,
            custom_emoji,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            if !engine.is_social_contact(peer_fp) {
                // Presença de quem não é contato é ruído (ou sonda): ignorar.
                return Ok(());
            }
            let st = normalize_presence(&status);
            let _ = engine.store.presence_set(
                peer_fp,
                st,
                &cap_str(&custom, 128),
                &cap_str(&custom_emoji, 16),
            );
            let _ = engine.events.send(EngineEvent::PresenceChanged {
                fp: peer_fp.to_string(),
                status: st.to_string(),
                custom: cap_str(&custom, 128),
                custom_emoji: cap_str(&custom_emoji, 16),
            });
        }
        SecureFrame::PresencePing => {
            let p = engine
                .store
                .presence_get_live(&engine.identity.fingerprint)
                .unwrap_or_default();
            let st = if p.status == "offline" {
                "online".to_string()
            } else {
                p.status.clone()
            };
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::PresenceSet {
                        status: st,
                        custom: p.custom,
                        custom_emoji: p.custom_emoji,
                    },
                ))
                .ok();
        }
        SecureFrame::Typing { conv_id, until_ms } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            if !engine
                .social_peers_of(&conv_id)
                .iter()
                .any(|p| p == peer_fp)
            {
                return Ok(());
            }
            let now = crate::identity::now_ms();
            let until = until_ms.clamp(now, now + 15_000);
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::Typing {
                                conv_id: conv_id.clone(),
                                until_ms: until,
                            },
                        ))
                        .ok();
                }
            }
            let _ = engine.events.send(EngineEvent::PeerTyping {
                fp: peer_fp.to_string(),
                conv_id,
                until_ms: until,
            });
        }
        SecureFrame::ChannelReorder { community_id, ids } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner && !engine.is_moderator(&community_id, peer_fp) {
                return Err(DistorrentError::Protocol(
                    "sem permissão para reordenar".into(),
                ));
            }
            engine.reorder_channels(&community_id, &ids)?;
            engine.broadcast_community_state(&community_id);
        }
        SecureFrame::ProfileSet {
            display_name,
            about,
            avatar_b64,
            banner_b64,
            accent,
            rev,
            content_hash,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let dn = cap_str(&display_name, 48);
            let ab = cap_str(&about, 400);
            let av = cap_b64(&avatar_b64, PROFILE_IMG_B64_MAX);
            let bn = cap_b64(&banner_b64, PROFILE_BANNER_B64_MAX);
            let ac = normalize_accent(&accent);

            let calculado = crate::social::profile_content_hash(&dn, &ab, &av, &bn, &ac);
            if !content_hash.is_empty() && content_hash != calculado {
                return Err(DistorrentError::Protocol(
                    "ProfileSet com content_hash divergente do conteúdo".into(),
                ));
            }

            if rev < 0 {
                return Err(DistorrentError::Protocol(
                    "ProfileSet com rev negativo".into(),
                ));
            }
            let applied = engine
                .store
                .profile_apply_remote(peer_fp, &dn, &ab, &av, &bn, &ac, rev)?;
            if !applied {
                return Ok(());
            }
            // Perfil NUNCA cria amizade. Antes, receber um `ProfileSet` com
            // nome preenchido marcava `accepted` dos dois lados — qualquer
            // peer que conseguisse abrir uma sessão virava "amigo" e ganhava
            // permissão de DM e chamada sem ninguém aceitar nada.
            let p = engine.store.profile_get(peer_fp).unwrap_or_default();
            let _ = engine.events.send(EngineEvent::ProfileChanged {
                fp: peer_fp.to_string(),
                profile: p,
            });
        }
        SecureFrame::ProfileQuery { known_rev } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            // Seção 67: me
            let me = engine.identity.fingerprint.clone();
            let Ok(p) = engine.store.profile_get(&me) else {
                return Ok(());
            };
            if p.rev > known_rev {
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.to_string(),
                        profile_frame(&p),
                    ))
                    .ok();
            }
        }
        SecureFrame::ThreadCreate {
            community_id,
            thread_id,
            parent_channel,
            name,
            kind,
            tags,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol("thread só para membro".into()));
            }
            let t = crate::social::ThreadRow {
                id: cap_str(&thread_id, 64),
                community_id: community_id.clone(),
                parent_channel: parent_channel.clone(),
                name: cap_str(&name, 80),
                author_fp: peer_fp.to_string(),
                created_at: crate::identity::now_ms(),
                archived: false,
                kind: if kind == "forum" {
                    "forum".into()
                } else {
                    "thread".into()
                },
                tags: cap_str(&tags, 200),
            };
            let _ = engine.store.thread_upsert(&t);
            let _ = engine.events.send(EngineEvent::ThreadCreated {
                community_id: community_id.clone(),
                thread: t,
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::ThreadCreate {
                    community_id: community_id.clone(),
                    thread_id: thread_id.clone(),
                    parent_channel: parent_channel.clone(),
                    name: name.clone(),
                    kind: kind.clone(),
                    tags: tags.clone(),
                },
            );
        }
        SecureFrame::ThreadMsg {
            community_id,
            thread_id,
            parent_channel,
            env,
        } => {
            if env.author_fp != peer_fp || !env.verify_with_pubkey(peer_pubkey) {
                return Err(DistorrentError::Protocol(
                    "mensagem de thread inválida".into(),
                ));
            }
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol("thread só para membro".into()));
            }
            if engine.store.message_by_id(&env.id)?.is_some() {
                return Ok(());
            }
            let _ = engine
                .store
                .insert_message_in_thread(&env, &thread_id, "in", "ok");
            let _ = engine
                .store
                .msg_set_forward(&env.id, &thread_id, &parent_channel);
            if let Some(sm) = engine.store.message_by_id(&env.id).ok().flatten() {
                let _ = engine.events.send(EngineEvent::MessageNew(sm));
            }
            engine.broadcast_social(
                &community_id,
                SecureFrame::ThreadMsg {
                    community_id: community_id.clone(),
                    thread_id: thread_id.clone(),
                    parent_channel: parent_channel.clone(),
                    env: env.clone(),
                },
            );
        }
        SecureFrame::MemberBan {
            community_id,
            target_fp,
            until_ms,
            reason,
        } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(DistorrentError::Protocol("só o dono baneia".into()));
            }
            // Banir a si mesmo ou alguém fora do servidor não faz sentido e
            // era aceito: o frame chegava com qualquer target_fp.
            if target_fp == peer_fp || target_fp == engine.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "não é possível banir a si ou ao dono".into(),
                ));
            }
            if engine
                .store
                .member_role(&community_id, &target_fp)
                .is_none()
            {
                return Err(DistorrentError::Protocol("alvo não é membro".into()));
            }
            let _ = engine.store.ban_set(
                &community_id,
                &target_fp,
                &cap_str(&reason, 300),
                peer_fp,
                until_ms,
            );
            let _ = engine.store.remove_member(&community_id, &target_fp);
            let _ = engine.events.send(EngineEvent::ModerationApplied {
                community_id: community_id.clone(),
                target_fp: target_fp.clone(),
                kind: "ban".into(),
                until_ms,
                reason: reason.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::MemberBan {
                    community_id: community_id.clone(),
                    target_fp: target_fp.clone(),
                    until_ms,
                    reason: reason.clone(),
                },
            );
        }
        SecureFrame::MemberTimeout {
            community_id,
            target_fp,
            until_ms,
            reason,
        } => {
            if !engine.is_moderator(&community_id, peer_fp) {
                return Err(DistorrentError::Protocol(
                    "sem permissão de moderação".into(),
                ));
            }
            if target_fp == peer_fp || target_fp == engine.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "não é possível silenciar a si ou ao dono".into(),
                ));
            }
            if engine
                .store
                .member_role(&community_id, &target_fp)
                .is_none()
            {
                return Err(DistorrentError::Protocol("alvo não é membro".into()));
            }
            let _ = engine.store.timeout_set(
                &community_id,
                &target_fp,
                until_ms,
                &cap_str(&reason, 300),
                peer_fp,
            );
            // Seção 68: _
            let _ = engine.events.send(EngineEvent::ModerationApplied {
                community_id: community_id.clone(),
                target_fp: target_fp.clone(),
                kind: "timeout".into(),
                until_ms,
                reason: reason.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::MemberTimeout {
                    community_id: community_id.clone(),
                    target_fp: target_fp.clone(),
                    until_ms,
                    reason: reason.clone(),
                },
            );
        }
        SecureFrame::ChannelCfg {
            community_id,
            channel_id,
            slowmode_secs,
            nsfw,
        } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(DistorrentError::Protocol("só o dono configura".into()));
            }
            let _ = engine.store.channel_cfg_set(
                &channel_id,
                slowmode_secs.clamp(0, 21_600),
                nsfw,
                false,
            );
            engine.broadcast_social(
                &community_id,
                SecureFrame::ChannelCfg {
                    community_id: community_id.clone(),
                    channel_id: channel_id.clone(),
                    slowmode_secs,
                    nsfw,
                },
            );
        }
        SecureFrame::PollCreate {
            community_id,
            channel_id,
            poll_id,
            question,
            options,
            multi,
            ends_at,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol("só membro cria enquete".into()));
            }
            let opts: Vec<String> = options.iter().take(10).map(|o| cap_str(o, 80)).collect();
            if opts.len() < 2 {
                return Err(DistorrentError::Protocol(
                    "enquete precisa de 2+ opções".into(),
                ));
            }
            let p = crate::social::PollRow {
                id: cap_str(&poll_id, 64),
                community_id: community_id.clone(),
                channel_id: channel_id.clone(),
                question: cap_str(&question, 200),
                options: opts,
                multi,
                author_fp: peer_fp.to_string(),
                created_at: crate::identity::now_ms(),
                ends_at,
                closed: false,
            };
            let _ = engine.store.poll_upsert(&p);
            let _ = engine.events.send(EngineEvent::PollUpdated {
                community_id: community_id.clone(),
                channel_id: channel_id.clone(),
                poll_id: poll_id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::PollCreate {
                    community_id: community_id.clone(),
                    channel_id: channel_id.clone(),
                    poll_id: poll_id.clone(),
                    question: question.clone(),
                    options: p.options.clone(),
                    multi,
                    ends_at,
                },
            );
        }
        SecureFrame::PollVote {
            community_id,
            channel_id,
            poll_id,
            option_idx,
        } => {
            let Some(poll) = engine
                .store
                .poll_list(&community_id, &channel_id)
                .ok()
                .and_then(|v| v.into_iter().find(|p| p.id == poll_id))
            else {
                return Ok(());
            };
            if poll.closed {
                return Err(DistorrentError::Protocol("enquete encerrada".into()));
            }
            if option_idx < 0 || option_idx as usize >= poll.options.len() {
                return Err(DistorrentError::Protocol("opção inválida".into()));
            }
            let _ = engine.store.poll_vote(&poll_id, peer_fp, option_idx);
            let _ = engine.events.send(EngineEvent::PollUpdated {
                community_id: community_id.clone(),
                channel_id: channel_id.clone(),
                poll_id: poll_id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::PollVote {
                    community_id: community_id.clone(),
                    channel_id: channel_id.clone(),
                    poll_id: poll_id.clone(),
                    option_idx,
                },
            );
        }
        SecureFrame::EventUpsert {
            community_id,
            event,
        } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(DistorrentError::Protocol("só o dono cria evento".into()));
            }
            let mut ev = event.clone();
            ev.entity_fp = peer_fp.to_string();
            ev.name = cap_str(&ev.name, 100);
            ev.location = cap_str(&ev.location, 120);
            ev.description = cap_str(&ev.description, 500);
            // Seção 69: _
            let _ = engine.store.event_upsert(&ev);
            let _ = engine.events.send(EngineEvent::EventUpdated {
                community_id: community_id.clone(),
                event_id: ev.id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::EventUpsert {
                    community_id: community_id.clone(),
                    event: ev,
                },
            );
        }
        SecureFrame::EventInterest {
            community_id,
            event_id,
        } => {
            let _ = engine
                .store
                .event_interest(&community_id, &event_id, peer_fp);
            let _ = engine.events.send(EngineEvent::EventUpdated {
                community_id: community_id.clone(),
                event_id: event_id.clone(),
            });
        }
        SecureFrame::EmojiUpsert {
            community_id,
            emoji,
        } => {
            if !engine.is_moderator(&community_id, peer_fp) {
                return Err(DistorrentError::Protocol("sem permissão".into()));
            }
            let mut e = emoji.clone();
            e.id = cap_str(&e.id, 64);
            e.name = cap_str(&e.name, 32);
            e.char = cap_str(&e.char, 8);
            if e.name.is_empty() || e.char.is_empty() {
                return Ok(());
            }
            let _ = engine.store.emoji_upsert(&e);
            let _ = engine.events.send(EngineEvent::EmojiUpdated {
                community_id: community_id.clone(),
                emoji_id: e.id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::EmojiUpsert {
                    community_id: community_id.clone(),
                    emoji: e,
                },
            );
        }
        SecureFrame::Punch {
            endpoint,
            at_ms,
            nonce: _,
        } => {
            if !engine.punch_enabled() {
                return Ok(());
            }
            let Ok(remote) = endpoint.parse::<SocketAddr>() else {
                debug!("punch com endpoint inválido — ignora");
                return Ok(());
            };
            if remote.ip().is_unspecified() || remote.port() == 0 {
                debug!("punch para endereço inválido — ignora");
                return Ok(());
            }
            if engine.peer_state(peer_fp) == NetworkState::Connected
                && !engine.is_peer_via_relay(peer_fp)
            {
                return Ok(());
            }
            {
                let now = crate::identity::now_ms();
                let mut map = engine.punch_rate.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(last) = map.get(peer_fp) {
                    if now - *last < 1000 {
                        return Ok(());
                    }
                }
                if map.len() > 4096 {
                    map.clear();
                }
                map.insert(peer_fp.to_string(), now);
            }
            engine
                .cmd_tx
                .send(EngineCmd::PunchDial {
                    fp: peer_fp.to_string(),
                    endpoint,
                    at_ms,
                })
                .ok();
        }
        SecureFrame::TunnelOffer {
            eph_pub_hex,
            nonce_hex,
            sig,
        } => {
            handle_tunnel_offer(engine, peer_fp, peer_pubkey, &eph_pub_hex, &nonce_hex, &sig);
        }
        SecureFrame::TunnelAnswer {
            eph_pub_hex,
            nonce_hex,
            for_nonce_hex,
            sig,
        } => {
            handle_tunnel_answer(
                engine,
                peer_fp,
                peer_pubkey,
                &eph_pub_hex,
                &nonce_hex,
                &for_nonce_hex,
                &sig,
            );
        }
        SecureFrame::TunnelData { nonce, ct_b64 } => {
            handle_tunnel_data(engine, peer_fp, nonce, &ct_b64);
        }
        SecureFrame::CommunitySyncRequest { community_id } => {
            let is_member = engine.store.member_role(&community_id, peer_fp).is_some();
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_member && !is_owner {
                return Err(DistorrentError::Protocol(
                    "CommunitySyncRequest de quem não é membro".into(),
                ));
            }
            if let Ok(frame) = engine.community_state_payload(&community_id, Some(peer_fp)) {
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(peer_fp.to_string(), frame))
                    .ok();
            }
        }
    }
    Ok(())
}

static PROCESS_PORTS: std::sync::OnceLock<StdMutex<std::collections::HashSet<u16>>> =
    std::sync::OnceLock::new();

fn process_ports() -> &'static StdMutex<std::collections::HashSet<u16>> {
    PROCESS_PORTS.get_or_init(|| StdMutex::new(std::collections::HashSet::new()))
}

// Seção 70: cancelled
fn cancelled(cancel: &tokio::sync::watch::Receiver<bool>) -> bool {
    *cancel.borrow()
}

impl NetworkEngine {
    pub(crate) fn cancel_subscribe(&self) -> tokio::sync::watch::Receiver<bool> {
        self.cancel_tx.subscribe()
    }

    pub(crate) fn is_cancelled(&self, cancel: &tokio::sync::watch::Receiver<bool>) -> bool {
        *cancel.borrow()
    }
}

fn short_diag_err(s: &str) -> String {
    let mut t = s.trim().replace('\n', " ");
    if let Some(rest) = t.strip_prefix("os error ") {
        t = format!("erro de soquete: {rest}");
    }
    if t.len() > 120 {
        t.truncate(120);
    }
    t
}

fn drop_link_if_dead(engine: &Arc<NetworkEngine>, fp: &str) {
    let morto = {
        let links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        match links.get(fp) {
            Some(l) => l.tx.as_ref().map(|t| t.is_closed()).unwrap_or(true),
            None => false,
        }
    };
    if !morto {
        return;
    }
    {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = links.remove(fp) {
            old.drop_notify.notify_one();
        }
    }
    debug!(%fp, "canal da sessão fechado — derrubando para redial");
    engine.note_dial_failure(fp);
    set_link_state(engine, fp, PeerLinkState::Reconnecting);
    engine.emit_state();
}

fn call_id_do_frame(frame: &SecureFrame) -> Option<String> {
    match frame {
        SecureFrame::CallInvite { call_id, .. }
        | SecureFrame::CallAccept { call_id }
        | SecureFrame::CallReject { call_id, .. }
        | SecureFrame::CallEnd { call_id }
        | SecureFrame::CallOffer { call_id, .. }
        | SecureFrame::CallAnswer { call_id, .. }
        | SecureFrame::CallIce { call_id, .. }
        | SecureFrame::CallAddParticipant { call_id, .. }
        | SecureFrame::ScreenShareOffer { call_id, .. } => Some(call_id.clone()),
        _ => None,
    }
}

fn set_link_state(engine: &Arc<NetworkEngine>, fp: &str, state: PeerLinkState) {
    if fp.is_empty() {
        return;
    }
    {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = links.get(fp) {
            if existing.get_state() == PeerLinkState::Online
                && (state == PeerLinkState::Connecting || state == PeerLinkState::Reconnecting)
            {
                return;
            }
        }
        let link = links.entry(fp.to_string()).or_insert_with(|| {
            Arc::new(PeerLink {
                state: StdMutex::new(state),
                tx: None,
                drop_notify: Notify::new(),
                via_relay: false,
                initiator: false,
            })
        });
        link.set_state(state);
    }
    engine.emit_state();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::relay::MemRelay;
    use crate::storage::Store;

    fn mk_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
        let kp = Keypair::generate();
        let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
        (e, dir)
    }

    #[tokio::test]
    async fn reacoes_rejeitadas_nao_persistem_nem_sao_ecoada() {
        let (e, _dir) = mk_engine("ReactionLimit");
        let peer = "peer-autenticado";
        let outro_membro = "peer-destino";
        e.store.set_friend(peer, "", "accepted").unwrap();
        let conv = e
            .store
            .create_group_dm(
                &e.identity.fingerprint,
                &[peer.to_string(), outro_membro.to_string()],
                "teste de rate limit",
            )
            .unwrap();
        let mut events = e.subscribe();
        let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();

        let msg_ids: Vec<String> = (0..6)
            .map(|i| {
                let message = crate::protocol::MessageEnvelope::new(
                    &e.keypair,
                    &conv.id,
                    &format!("mensagem {i}"),
                );
                e.store.insert_message(&message, "in", "ok").unwrap();
                message.id
            })
            .collect();

        for msg_id in msg_ids.iter().take(5) {
            handle_frame(
                &e,
                peer,
                "",
                "peer",
                SecureFrame::React {
                    conv_id: conv.id.clone(),
                    msg_id: msg_id.clone(),
                    emoji: "🔥".into(),
                    add: true,
                    reactor_fp: "vitima-falsificada".into(),
                },
            )
            .await
            .unwrap();
        }

        handle_frame(
            &e,
            peer,
            "",
            "peer",
            SecureFrame::React {
                conv_id: conv.id.clone(),
                msg_id: msg_ids[0].clone(),
                emoji: "🔥".into(),
                add: true,
                reactor_fp: "vitima-falsificada".into(),
            },
        )
        .await
        .unwrap();

        handle_frame(
            &e,
            peer,
            "",
            "peer",
            SecureFrame::React {
                conv_id: conv.id.clone(),
                msg_id: "msg-inexistente".into(),
                emoji: "🔥".into(),
                add: true,
                reactor_fp: "vitima-falsificada".into(),
            },
        )
        .await
        .unwrap();

        handle_frame(
            &e,
            peer,
            "",
            "peer",
            SecureFrame::React {
                conv_id: conv.id.clone(),
                msg_id: msg_ids[5].clone(),
                emoji: "🔥".into(),
                add: true,
                reactor_fp: "vitima-falsificada".into(),
            },
        )
        .await
        .unwrap();

        // Seção 71: stored
        let stored = e.store.reactions_for_msg(&msg_ids[0]).unwrap();
        assert_eq!(stored[0].reactors, vec![peer.to_string()]);
        assert!(e
            .store
            .reactions_for_msg("msg-inexistente")
            .unwrap()
            .is_empty());
        assert!(e.store.reactions_for_msg(&msg_ids[5]).unwrap().is_empty());

        let mut emitted = 0;
        while let Ok(event) = events.try_recv() {
            if matches!(event, EngineEvent::ReactionChanged { .. }) {
                emitted += 1;
            }
        }
        assert_eq!(emitted, 5, "duplicata e rejeição não emitem eventos");

        let mut relayed = 0;
        while let Ok(command) = commands.try_recv() {
            if matches!(command, EngineCmd::SendToPeer(_, SecureFrame::React { .. })) {
                relayed += 1;
            }
        }
        assert_eq!(relayed, 5, "duplicata e rejeição não são retransmitidas");
    }

    #[test]
    fn relay_kill_switch_desliga_e_religa() {
        let (e, _d) = mk_engine("KillSwitch");
        assert!(
            !e.relay_is_disabled(),
            "relay deve vir LIGADO por padrao (fallback CGNAT)"
        );
        assert!(relay_allowed(&e), "default: relay ligado");
        e.set_relay_disabled(true);
        assert!(!relay_allowed(&e), "flag deve desligar o relay");
        e.set_relay_disabled(false);
        assert!(relay_allowed(&e), "flag desligada religa o relay");
    }

    #[test]
    fn relay_default_fail_open() {
        assert!(env_relay_enabled(), "sem DISTORRENT_RELAY: relay LIGADO");
        for v in ["0", "false", "no", "off"] {
            std::env::set_var("DISTORRENT_RELAY", v);
            assert!(!env_relay_enabled(), "DISTORRENT_RELAY={v} desliga");
        }
        std::env::set_var("DISTORRENT_RELAY", "1");
        assert!(env_relay_enabled(), "DISTORRENT_RELAY=1 liga");
        std::env::remove_var("DISTORRENT_RELAY");
        std::env::set_var("DISTORRENT_NO_RELAY", "1");
        assert!(!env_relay_enabled(), "DISTORRENT_NO_RELAY=1 kill-switch");
        std::env::remove_var("DISTORRENT_NO_RELAY");
    }

    #[test]
    fn backend_injetado_nao_desliga_sozinho() {
        let (e, _d) = mk_engine("Injected");
        e.set_relay_backend(Arc::new(MemRelay::new()));
        assert!(relay_allowed(&e));
        e.set_relay_disabled(true);
        assert!(!relay_allowed(&e));
    }

    #[test]
    fn punch_kill_switch_liga_e_desliga() {
        let (e, _d) = mk_engine("PunchSwitch");
        assert!(e.punch_enabled());
        e.set_punch_enabled(false);
        assert!(
            !e.punch_enabled(),
            "DISTORRENT_PUNCH=0 deve desligar o furo"
        );
        e.set_punch_enabled(true);
        assert!(e.punch_enabled(), "deve religar");
    }

    #[test]
    fn punch_flag_value_parsing() {
        assert!(punch_flag_value(None), "default = ligado");
        assert!(punch_flag_value(Some("1")));
        assert!(punch_flag_value(Some("yes")));
        assert!(punch_flag_value(Some("TRUE")));
        assert!(!punch_flag_value(Some("0")));
        assert!(!punch_flag_value(Some("false")));
        assert!(!punch_flag_value(Some("no")));
        assert!(!punch_flag_value(Some("off")));
        assert!(!punch_flag_value(Some(" OFF ")));
    }

    #[test]
    fn keepalive_direto_dentro_de_30s() {
        assert!(PING_INTERVAL <= Duration::from_secs(30));
        assert!(NAT_RENEW_INTERVAL < Duration::from_secs(3600));
    }

    #[tokio::test]
    async fn peer_relay_intermediario_put_get_data() {
        let (relay, _d) = mk_engine("PeerRelayC");
        relay.set_peer_relay_enabled(true);
        relay.start_with_discovery(false).unwrap();
        let topic = "distorrent_r_peerB";

        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        relay.links.lock().unwrap().insert(
            "peerB".into(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx_b),
                drop_notify: Notify::new(),
                via_relay: false,
                initiator: false,
            }),
        );

        handle_frame(
            &relay,
            "peerA",
            "pkA",
            "A",
            SecureFrame::PeerRelayPut {
                topic: topic.into(),
                body: "CIFRADO".into(),
            },
        )
        .await
        .unwrap();

        handle_frame(
            &relay,
            "peerB",
            "pkB",
            "B",
            SecureFrame::PeerRelayGet {
                req_id: 42,
                topic: topic.into(),
            },
        )
        .await
        .unwrap();
        let mut resp = None;
        for _ in 0..200 {
            match rx_b.try_recv() {
                Ok((_, SecureFrame::PeerRelayData { req_id: 42, bodies })) => {
                    resp = Some(bodies);
                    break;
                }
                Ok(_) => continue,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        assert_eq!(
            resp.expect("C deveria responder"),
            vec!["CIFRADO".to_string()]
        );

        handle_frame(
            &relay,
            "peerB",
            "pkB",
            "B",
            SecureFrame::PeerRelayGet {
                req_id: 43,
                topic: topic.into(),
            },
        )
        .await
        .unwrap();
        // Seção 72: mut
        let mut resp2 = None;
        for _ in 0..200 {
            match rx_b.try_recv() {
                Ok((_, SecureFrame::PeerRelayData { req_id: 43, bodies })) => {
                    resp2 = Some(bodies);
                    break;
                }
                Ok(_) => continue,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        assert!(resp2.expect("C deveria responder vazio").is_empty());
        relay.shutdown();
    }

    #[tokio::test]
    async fn peer_relay_backend_post_e_deliver() {
        let (a, _d) = mk_engine("PeerRelayClient");
        a.set_relay_backend(Arc::new(MemRelay::new()));
        a.start_with_discovery(false).unwrap();

        let (tx_c, mut rx_c) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        a.links.lock().unwrap().insert(
            "relayC".into(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx_c),
                drop_notify: Notify::new(),
                via_relay: false,
                initiator: false,
            }),
        );

        let backend = Arc::new(PeerRelayBackend::new(Arc::downgrade(&a), "relayC".into()));
        backend.post("distorrent_r_dest", "opaco").await.unwrap();
        let mut put = None;
        for _ in 0..100 {
            if let Ok((_, f)) = rx_c.try_recv() {
                put = Some(f);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        match put.expect("intermediário deveria receber PeerRelayPut") {
            SecureFrame::PeerRelayPut { topic, body } => {
                assert_eq!(topic, "distorrent_r_dest");
                assert_eq!(body, "opaco");
            }
            other => panic!("frame inesperado: {other:?}"),
        }

        let b2 = backend.clone();
        let handle = tokio::spawn(async move { b2.poll("distorrent_r_meu").await });
        let mut req_id = None;
        for _ in 0..100 {
            if let Ok((_, SecureFrame::PeerRelayGet { req_id: r, topic })) = rx_c.try_recv() {
                assert_eq!(topic, "distorrent_r_meu");
                req_id = Some(r);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let req_id = req_id.expect("deveria haver PeerRelayGet");
        assert!(
            backend.pending_len() >= 1,
            "poll deveria ter oneshot pendente"
        );
        assert!(backend.deliver(req_id, vec!["resposta".into()]));
        let out = handle.await.unwrap().unwrap();
        assert_eq!(out, vec!["resposta".to_string()]);
        a.shutdown();
    }

    #[test]
    fn peer_relay_selecao_respeita_privacidade_e_kill_switch() {
        let (e, _d) = mk_engine("PeerRelaySelect");
        let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        e.links.lock().unwrap().insert(
            "peerC".into(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx),
                drop_notify: Notify::new(),
                via_relay: false,
                initiator: false,
            }),
        );

        e.set_peer_relay_enabled(true);
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));

        e.privacy_set_mode("proxy").unwrap();
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp(), None, "proxy nao usa peer-relay");

        e.privacy_set_mode("encrypted").unwrap();
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));

        e.set_relay_disabled(true);
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp(), None, "kill-switch desliga peer-relay");
        e.set_relay_disabled(false);
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));
    }

    #[tokio::test]
    async fn peer_relay_data_so_do_intermediario() {
        let (e, _d) = mk_engine("DataGuard");
        e.set_peer_relay_enabled(true);
        let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        e.links.lock().unwrap().insert(
            "mid".into(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx),
                drop_notify: Notify::new(),
                via_relay: false,
                initiator: false,
            }),
        );
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("mid"));
        e.start_with_discovery(false).unwrap();

        let backend = e.peer_relay_backend_for("mid");
        let fut = backend.poll("distorrent_r_mid");
        let ids = backend.pending_req_ids();
        assert_eq!(ids.len(), 1, "deveria haver 1 pedido pendente");
        let req_id = ids[0];

        handle_frame(
            &e,
            "atacante",
            "pkX",
            "X",
            SecureFrame::PeerRelayData {
                req_id,
                bodies: vec!["roubado".into()],
            },
        )
        .await
        .unwrap();
        assert_eq!(backend.pending_len(), 1, "não-intermediário não entrega");

        handle_frame(
            &e,
            "mid",
            "pkM",
            "M",
            SecureFrame::PeerRelayData {
                req_id,
                bodies: vec!["ok".into()],
            },
        )
        .await
        .unwrap();
        assert_eq!(backend.pending_len(), 0, "intermediário entrega");
        assert_eq!(fut.await.unwrap(), vec!["ok".to_string()]);
    }

    #[test]
    // Seção 73: peer_relay_nao_elege_bloqueado
    fn peer_relay_nao_elege_bloqueado() {
        let (e, _d) = mk_engine("BlockElect");
        e.set_peer_relay_enabled(true);
        let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        e.links.lock().unwrap().insert(
            "blockedPeer".into(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx),
                drop_notify: Notify::new(),
                via_relay: false,
                initiator: false,
            }),
        );
        e.store.set_friend("blockedPeer", "", "blocked").unwrap();
        e.refresh_peer_relay();
        assert_eq!(
            e.peer_relay_fp(),
            None,
            "bloqueado não pode ser intermediário"
        );
    }

    #[test]
    fn nat_endpoint_serializa_sem_sufixo_ev() {
        let ev = EngineEvent::NatEndpoint {
            addr: "203.0.113.7:51234".into(),
            source: "upnp".into(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("nat_endpoint"));
        assert_eq!(
            v.get("addr").and_then(|a| a.as_str()),
            Some("203.0.113.7:51234")
        );
        assert_eq!(v.get("source").and_then(|s| s.as_str()), Some("upnp"));
    }

    #[test]
    fn dht_announce_port_so_externa_confirmada() {
        let (e, _d) = mk_engine("DhtPort");
        assert_eq!(e.dht_announce_port(), None);
        e.nat_external_port.store(45678, Ordering::Relaxed);
        assert_eq!(e.dht_announce_port(), Some(45678));
        assert_ne!(e.dht_announce_port(), Some(e.listen_port()));
        e.set_public_addr("203.0.113.7:51234".to_string());
        assert_eq!(e.dht_announce_port(), Some(51234));
        e.set_public_addr("lixo".to_string());
        assert_eq!(e.dht_announce_port(), Some(45678));
    }

    #[test]
    fn peer_diag_bound_512_mantem_recentes() {
        let (e, _d) = mk_engine("DiagBound");
        for i in 0..600 {
            e.diag_update(&format!("fp{i:04}"), |d| {
                d.direct_attempts = i as u64;
            });
        }
        let len = e.peer_diag.lock().unwrap().len();
        assert_eq!(len, 512, "mapa deve ficar em 512, achou {len}");
        let map = e.peer_diag.lock().unwrap();
        assert!(map.contains_key("fp0599"), "mais recente fica");
        assert!(!map.contains_key("fp0000"), "mais antigo sai");
    }

    // Sem `cfg`: `engine_com_amigo` compila em todo alvo e usa esta constante.
    // Com `#[cfg(target_os = "linux")]` o build no Windows quebrava com
    // "cannot find value PEER" e nenhum teste de engine rodava lá.
    const PEER: &str = "peer-web";

    fn engine_com_amigo(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
        let (e, d) = mk_engine(nick);
        e.store.set_friend(PEER, "Peer", "accepted").unwrap();
        (e, d)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn identificador_de_amigo_aceita_fingerprint_e_chave_publica() {
        // 12 hex = já é o fingerprint: passa como está.
        assert_eq!(
            NetworkEngine::normalize_peer_id("  A1B2C3D4E5F6 ").unwrap(),
            "a1b2c3d4e5f6"
        );
        // 64 hex = chave pública: o fingerprint é derivado dela (é o que a tela
        // de perfil oferece em "copiar identidade").
        let kp = Keypair::generate();
        let pk = kp.public_hex();
        assert_eq!(
            NetworkEngine::normalize_peer_id(&pk).unwrap(),
            kp.fingerprint(),
            "colar a chave pública tem de achar o mesmo peer"
        );
        // Prefixo do esquema de convite também é aceito.
        assert_eq!(
            NetworkEngine::normalize_peer_id(&format!("distorrent:{pk}")).unwrap(),
            kp.fingerprint()
        );
        // Lixo continua recusado com mensagem que diz o que fazer.
        let erro = NetworkEngine::normalize_peer_id("abc")
            .unwrap_err()
            .to_string();
        assert!(
            erro.contains("12"),
            "a recusa precisa explicar o formato: {erro}"
        );
    }

    #[cfg(target_os = "linux")]
    fn proximo_evento(rx: &mut broadcast::Receiver<EngineEvent>) -> Option<String> {
        rx.try_recv().ok().map(|e| format!("{e:?}"))
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn call_offer_sem_sessao_nativa_vai_para_o_js() {
        let (e, _d) = engine_com_amigo("CoexistBrowser");
        let mut rx = e.subscribe();
        let call_id = "call-browser";
        let r = block_on(handle_frame(
            &e,
            PEER,
            "pubkey",
            "Peer",
            offer_frame(call_id, "v=0\r\n".into()),
        ));
        assert!(r.is_ok(), "frame rejeitado: {r:?}");
        assert!(
            !e.voice_is_native(call_id, PEER),
            "par não registrado não pode virar sessão nativa"
        );
        if e.native_voice_available() {
            assert!(
                proximo_evento(&mut rx).is_none(),
                "offer pré-aceite retida não pode vazar para o JS"
            );
            assert!(e.voice_register(call_id, PEER));
            block_on(e.resume_held_call(call_id, PEER));
            assert!(
                proximo_evento(&mut rx).is_none(),
                "offer absorvida pela nativa não gera evento"
            );
            e.voice_hangup(call_id);
        } else {
            let ev = proximo_evento(&mut rx).expect("deve haver evento para o JS");
            assert!(
                ev.contains("CallOfferEv"),
                "sem sessão nativa o evento tem que ser CallOfferEv, veio: {ev}"
            );
        }
    }

    #[cfg(target_os = "linux")]
    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[cfg(target_os = "linux")]
    fn offer_frame(call_id: &str, sdp: String) -> SecureFrame {
        SecureFrame::CallOffer {
            call_id: call_id.into(),
            sdp,
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn call_offer_com_sessao_nativa_nao_vai_para_o_js() {
        let (e, _d) = engine_com_amigo("CoexistNative");
        let Some(v) = e.voice_media() else {
            return;
        };
        let mut rx = e.subscribe();
        let call_id = "call-native";
        e.voice_register(call_id, PEER);
        assert!(e.voice_is_native(call_id, PEER), "registro falhou");

        let oferta = v.create_offer("outra-call", "peer-fantasma").unwrap();
        let r = block_on(handle_frame(
            &e,
            PEER,
            "pubkey",
            "Peer",
            offer_frame(call_id, oferta),
        ));
        assert!(r.is_ok(), "frame rejeitado: {r:?}");
        assert!(
            proximo_evento(&mut rx).is_none(),
            "sessão nativa absorveu o offer — o JS NÃO pode criar RTCPeerConnection"
        );
        v.hangup("outra-call");
        e.voice_hangup(call_id);
    }

    // Seção 74: test
    #[test]
    #[cfg(target_os = "linux")]
    fn offer_invalido_na_regressa_para_o_navegador() {
        let (e, _d) = engine_com_amigo("CoexistFallback");
        if e.voice_media().is_none() {
            return;
        }
        let mut rx = e.subscribe();
        let call_id = "call-lixo";
        e.voice_register(call_id, PEER);
        let r = block_on(handle_frame(
            &e,
            PEER,
            "pubkey",
            "Peer",
            offer_frame(call_id, "isto-nao-e-um-sdp".into()),
        ));
        assert!(r.is_ok(), "frame rejeitado: {r:?}");
        let ev = proximo_evento(&mut rx).expect("SDP recusado tem de voltar ao JS");
        assert!(ev.contains("CallOfferEv"), "veio: {ev}");
        e.voice_hangup(call_id);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn registro_por_call_nao_vaza_para_outra() {
        let (e, _d) = engine_com_amigo("CoexistScope");
        if !e.voice_register("call-a", PEER) {
            return;
        }
        assert!(e.voice_is_native("call-a", PEER));
        assert!(
            !e.voice_is_native("call-b", PEER),
            "call_id diferente = sessão diferente"
        );
        assert!(
            !e.voice_is_native("call-a", "outro-peer"),
            "peer diferente = sessão diferente"
        );
        e.voice_hangup("call-a");
        assert!(
            !e.voice_is_native("call-a", PEER),
            "hangup limpa o registro"
        );
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn sem_midia_nativa_nada_e_registrado() {
        let (e, _d) = mk_engine("SemMidia");
        if e.voice_media().is_some() {
            assert!(e.voice_register("c", "p"));
        } else {
            assert!(
                !e.voice_register("c", "p"),
                "sem mídia nativa nada pode ser registrado — o navegador assume"
            );
            assert!(!e.voice_is_native("c", "p"));
        }
    }

    #[test]
    fn peer_relay_optin_value_parsing() {
        assert!(
            peer_relay_optin_value(None, None, false),
            "AUTO: ligado por padrão"
        );
        assert!(peer_relay_optin_value(Some("1"), None, false));
        assert!(peer_relay_optin_value(None, Some("true"), false));
        assert!(peer_relay_optin_value(Some("on"), None, false));
        assert!(
            !peer_relay_optin_value(Some("0"), None, false),
            "relay=0 desliga"
        );
        assert!(
            !peer_relay_optin_value(None, Some("off"), false),
            "peer=off desliga"
        );
        assert!(
            !peer_relay_optin_value(Some("1"), Some("1"), true),
            "no_relay desliga"
        );
    }

    fn perfil_block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn profile_set_remoto_emite_evento_quando_muda() {
        let (e, _d) = mk_engine("perfil-remoto");
        let autor = "fp-autor";
        let mut rx = e.subscribe();
        let r = perfil_block_on(handle_frame(
            &e,
            autor,
            "pubkey",
            "Autor",
            SecureFrame::ProfileSet {
                display_name: "Autor Novo".into(),
                about: "bio".into(),
                avatar_b64: "QUJD".into(),
                banner_b64: String::new(),
                accent: "#ff0000".into(),
                rev: 1,
                content_hash: crate::social::profile_content_hash(
                    "Autor Novo",
                    "bio",
                    "QUJD",
                    "",
                    "#ff0000",
                ),
            },
        ));
        assert!(r.is_ok(), "frame rejeitado: {r:?}");
        let p = e.store.profile_get(autor).unwrap();
        assert_eq!(p.display_name, "Autor Novo");
        assert_eq!(p.rev, 1);
        assert_eq!(p.accent, "#ff0000");
        let ev = rx
            .try_recv()
            .ok()
            .map(|e| format!("{e:?}"))
            .unwrap_or_default();
        assert!(ev.contains("ProfileChanged"), "evento esperado, veio: {ev}");
    }

    #[test]
    fn profile_set_remoto_revisao_antiga_nao_emite_nem_sobrescreve() {
        let (e, _d) = mk_engine("perfil-antigo");
        let autor = "fp-autor2";
        for (rev, nome) in [(2i64, "Versão 2"), (1i64, "Versão 1 atrasada")] {
            let _ = perfil_block_on(handle_frame(
                &e,
                autor,
                "pubkey",
                "Autor",
                SecureFrame::ProfileSet {
                    display_name: nome.into(),
                    about: String::new(),
                    avatar_b64: String::new(),
                    banner_b64: String::new(),
                    accent: String::new(),
                    rev,
                    content_hash: String::new(),
                },
            ));
        }
        let p = e.store.profile_get(autor).unwrap();
        assert_eq!(p.display_name, "Versão 2", "rev antiga não pode vencer");
        assert_eq!(p.rev, 2);
    }

    // Seção 75: test
    #[test]
    fn profile_set_com_hash_divergente_e_rejeitado() {
        let (e, _d) = mk_engine("perfil-hash");
        let autor = "fp-autor3";
        let r = perfil_block_on(handle_frame(
            &e,
            autor,
            "pubkey",
            "Autor",
            SecureFrame::ProfileSet {
                display_name: "Nome".into(),
                about: String::new(),
                avatar_b64: String::new(),
                banner_b64: String::new(),
                accent: String::new(),
                rev: 1,
                content_hash: "0".repeat(32),
            },
        ));
        assert!(r.is_err(), "hash divergente tem que ser rejeitado");
        assert_eq!(
            e.store.profile_get(autor).unwrap().display_name,
            "",
            "perfil armazenado não pode ser corrompido"
        );
    }

    #[test]
    fn profile_set_de_peer_bloqueado_e_ignorado() {
        let (e, _d) = mk_engine("perfil-bloqueio");
        // Fingerprint precisa ser hex de 12: o frame agora rejeita id
        // inválido antes de qualquer escrita, e o teste precisa exercitar o
        // caminho de BLOQUEIO, não o de validação.
        let autor = "b10c0ad00001";
        e.friend_block(autor).unwrap();
        let r = perfil_block_on(handle_frame(
            &e,
            autor,
            "pubkey",
            "Bloqueado",
            SecureFrame::ProfileSet {
                display_name: "Invasor".into(),
                about: String::new(),
                avatar_b64: String::new(),
                banner_b64: String::new(),
                accent: String::new(),
                rev: 99,
                content_hash: String::new(),
            },
        ));
        assert!(r.is_ok(), "frame de bloqueado não derruba a sessão");
        assert_eq!(
            e.store.profile_get(autor).unwrap().display_name,
            "",
            "peer bloqueado não pode gravar perfil"
        );
    }

    #[test]
    fn profile_set_no_teto_cabe_no_frame_e_no_relay() {
        let (e, _d) = mk_engine("perfil-frame");
        let avatar = "A".repeat(PROFILE_IMG_B64_MAX);
        let banner = "B".repeat(PROFILE_BANNER_B64_MAX);
        e.social_profile_set(
            "Nome de exibição",
            &"bio".repeat(100),
            &avatar,
            &banner,
            "#5865f2",
        )
        .unwrap();
        let p = e.store.profile_get(&e.identity.fingerprint).unwrap();
        let frame = profile_frame(&p);
        let json = serde_json::to_string(&frame).unwrap();

        assert!(
            json.len() < crate::net::transport::MAX_FRAME as usize,
            "ProfileSet de {} bytes estoura MAX_FRAME ({}): a sessão cai",
            json.len(),
            crate::net::transport::MAX_FRAME,
        );
        assert!(
            json.len() < crate::net::peer_relay::MAX_TOPIC_BYTES,
            "ProfileSet de {} bytes passa do orçamento por tópico do relay ({})",
            json.len(),
            crate::net::peer_relay::MAX_TOPIC_BYTES,
        );
        assert_eq!(p.avatar_b64.len(), PROFILE_IMG_B64_MAX);
        assert_eq!(p.banner_b64.len(), PROFILE_BANNER_B64_MAX);
    }

    #[test]
    fn profile_query_responde_so_quando_temos_revisao_maior() {
        let (e, _d) = mk_engine("perfil-query");
        let me = e.identity.fingerprint.clone();
        e.social_profile_set("Meu Nome", "bio", "", "", "").unwrap();
        let minha_rev = e.store.profile_get(&me).unwrap().rev;
        assert!(minha_rev >= 1);

        let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();
        let _ = perfil_block_on(handle_frame(
            &e,
            "peer-query",
            "pubkey",
            "Peer",
            SecureFrame::ProfileQuery {
                known_rev: minha_rev,
            },
        ));
        assert!(
            commands.try_recv().is_err(),
            "sem mudança não pode haver ProfileSet na fila"
        );

        let _ = perfil_block_on(handle_frame(
            &e,
            "peer-query",
            "pubkey",
            "Peer",
            SecureFrame::ProfileQuery { known_rev: 0 },
        ));
        let mut enviou = false;
        while let Ok(cmd) = commands.try_recv() {
            if let EngineCmd::SendToPeer(_, SecureFrame::ProfileSet { .. }) = cmd {
                enviou = true;
            }
        }
        assert!(enviou, "peer desatualizado precisa receber o ProfileSet");
    }

    #[test]
    fn profile_query_leva_a_revisao_do_peer_e_nao_a_minha() {
        let (e, _d) = mk_engine("perfil-known-rev");
        let me = e.identity.fingerprint.clone();
        let peer = "peer-alvo".to_string();

        for i in 0..3 {
            let _ =
                e.store
                    .profile_set_local(&me, "eu", &format!("bio {i}"), "", "", "", false, false);
        }
        let _ = e
            .store
            .profile_set_local(&peer, "amigo", "bio do amigo", "", "", "", false, false);
        assert_eq!(e.store.profile_get(&me).unwrap().rev, 3);
        assert_eq!(e.store.profile_get(&peer).unwrap().rev, 1);

        let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        e.links.lock().unwrap().insert(
            peer.clone(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx),
                drop_notify: Notify::new(),
                via_relay: false,
                initiator: false,
            }),
        );

        let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();
        e.sync_profiles_with_peers();
        let mut known = None;
        while let Ok(cmd) = commands.try_recv() {
            if let EngineCmd::SendToPeer(dest, SecureFrame::ProfileQuery { known_rev }) = cmd {
                if dest == peer {
                    known = Some(known_rev);
                }
            }
        }
        assert_eq!(
            known,
            Some(1),
            "a pergunta deve citar a revisão DO PEER (1), nunca a minha (3) — \
             com a minha o peer não responde e o perfil/foto nunca chega"
        );
    }

    // Seção 76: test
    #[test]
    fn social_profile_set_local_emite_evento_e_incrementa_revisao() {
        let (e, _d) = mk_engine("perfil-local");
        let mut rx = e.subscribe();
        let p = e.social_profile_set("Eu Mesmo", "bio", "", "", "").unwrap();
        assert_eq!(p.rev, 1);
        let ev = rx
            .try_recv()
            .ok()
            .map(|e| format!("{e:?}"))
            .unwrap_or_default();
        assert!(
            ev.contains("ProfileChanged"),
            "o próprio usuário precisa ser notificado (causa do avatar velho): {ev}"
        );
        let p2 = e.social_profile_set("Eu Mesmo", "bio", "", "", "").unwrap();
        assert_eq!(p2.rev, 1);
    }

    #[tokio::test]
    async fn foto_do_perfil_chega_inteira_no_outro_lado() {
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

        let (a, _da) = mk_engine("perfil-foto-a");
        let (b, _db) = mk_engine("perfil-foto-b");
        let fp_a = a.identity.fingerprint.clone();

        let bytes: Vec<u8> = (0..40_000u32).map(|i| (i % 251) as u8).collect();
        let avatar = B64.encode(&bytes);
        assert!(
            avatar.len() < PROFILE_IMG_B64_MAX,
            "o teste precisa caber no teto"
        );

        let p = a
            .social_profile_set("Eu Mesmo", "minha bio", &avatar, "", "#5865f2")
            .unwrap();
        assert_eq!(
            p.avatar_b64, avatar,
            "o store precisa devolver a foto inteira"
        );

        match profile_frame(&p) {
            SecureFrame::ProfileSet {
                avatar_b64,
                content_hash,
                rev,
                ..
            } => {
                assert_eq!(avatar_b64, avatar, "o frame perdeu a foto");
                assert_eq!(rev, 1);
                let esperado = crate::social::profile_content_hash(
                    "Eu Mesmo",
                    "minha bio",
                    &avatar,
                    "",
                    "#5865f2",
                );
                assert_eq!(content_hash, esperado);
            }
            other => panic!("frame inesperado: {other:?}"),
        }

        handle_frame(&b, &fp_a, "pubkey", "Eu Mesmo", profile_frame(&p))
            .await
            .unwrap();
        let recebido = b.store.profile_get(&fp_a).unwrap();
        assert_eq!(recebido.avatar_b64, avatar, "a foto não chegou íntegra");
        assert_eq!(recebido.display_name, "Eu Mesmo");
    }

    #[test]
    fn repeticao_normal_nao_e_spam_mas_massa_e() {
        let (e, _d) = mk_engine("spam-dup");
        let peer = "peer-spam";
        for _ in 0..5 {
            assert!(
                e.spam_gate(peer, "sim").is_ok(),
                "repetir a mesma palavra numa conversa não pode virar erro"
            );
        }
        assert!(e.spam_gate(peer, "sim").is_err(), "massa de cópias é spam");
        assert!(e.spam_gate(peer, "outra coisa").is_ok());
    }

    #[test]
    fn conversa_rapida_com_amigo_nao_dispara_flood() {
        let (e, _d) = mk_engine("spam-flood");
        let peer = "peer-amigo";
        e.store.set_friend(peer, "Amigo", "accepted").unwrap();
        for i in 0..12 {
            assert!(
                e.spam_gate(peer, &format!("msg {i}")).is_ok(),
                "mensagem {i} de uma conversa normal foi bloqueada como flood"
            );
        }
        let estranho = "peer-estranho";
        let mut bloqueou = false;
        for i in 0..20 {
            if e.spam_gate(estranho, &format!("m{i}")).is_err() {
                bloqueou = true;
                break;
            }
        }
        assert!(
            bloqueou,
            "o teto apertado precisa continuar valendo contra abuso"
        );
    }

    #[tokio::test]
    async fn grupo_dispensado_nao_volta_com_roster_reenviado() {
        let (e, _d) = mk_engine("grupo-nao-volta");
        let criador = "c0c0c0c00001";
        let outro_membro = "c0c0c0c00002";
        let conv = e
            .store
            .create_group_dm(
                &e.identity.fingerprint,
                &[criador.to_string(), outro_membro.to_string()],
                "Grupo que eu saí",
            )
            .unwrap();
        // O grupo foi criado por `criador` (não por mim): é o cenário real de
        // quem recebe um convite e depois sai.
        e.store.group_owner_set(&conv.id, criador).unwrap();
        let membros = e.store.list_group_members(&conv.id).unwrap();
        e.store.leave_group_local(&conv.id).unwrap();
        crate::group_trash::dismiss_owned(&e.store, &conv.id, criador).unwrap();

        // Um membro comum reenvia o roster antigo — completo, comigo dentro.
        handle_frame(
            &e,
            outro_membro,
            "",
            "Outro",
            SecureFrame::GroupCreated {
                conv_id: conv.id.clone(),
                title: "Grupo que eu saí".into(),
                members: membros.clone(),
                owner_fp: criador.into(),
            },
        )
        .await
        .unwrap();

        assert!(
            e.store.get_conversation(&conv.id).unwrap().is_none(),
            "roster reenviado por quem não é criador não pode ressuscitar o grupo"
        );
        assert!(
            crate::group_trash::is_dismissed(&e.store, &conv.id),
            "o bloqueio tem de continuar valendo depois do reenvio"
        );
    }

    #[tokio::test]
    async fn grupo_dispensado_volta_quando_o_criador_me_adiciona() {
        let (e, _d) = mk_engine("grupo-volta");
        let criador = "c0c0c0c00003";
        let outro_membro = "c0c0c0c00004";
        let conv = e
            .store
            .create_group_dm(
                &e.identity.fingerprint,
                &[criador.to_string(), outro_membro.to_string()],
                "Grupo de volta",
            )
            .unwrap();
        e.store.group_owner_set(&conv.id, criador).unwrap();
        let membros = e.store.list_group_members(&conv.id).unwrap();
        e.store.leave_group_local(&conv.id).unwrap();
        crate::group_trash::dismiss_owned(&e.store, &conv.id, criador).unwrap();

        // O criador reenvia o roster me incluindo de novo: readição de propósito.
        handle_frame(
            &e,
            criador,
            "",
            "Criador",
            SecureFrame::GroupCreated {
                conv_id: conv.id.clone(),
                title: "Grupo de volta".into(),
                members: membros.clone(),
                owner_fp: criador.into(),
            },
        )
        .await
        .unwrap();

        assert!(
            e.store.get_conversation(&conv.id).unwrap().is_some(),
            "o criador me adicionando de novo tem de recriar o grupo"
        );
        assert!(
            !crate::group_trash::is_dismissed(&e.store, &conv.id),
            "a readição do criador limpa o bloqueio"
        );
    }

    #[test]
    fn sair_do_grupo_marca_como_dispensado() {
        let (e, _d) = mk_engine("sair-dispensa");
        let criador = "c0c0c0c00005";
        let eu = e.identity.fingerprint.clone();
        let conv = e
            .store
            .create_group_dm(&eu, &[criador.to_string()], "Grupo para sair")
            .unwrap();
        // O convite veio do criador: ele é o dono, não eu (que apenas recebi).
        e.store.group_owner_set(&conv.id, criador).unwrap();
        let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();

        e.group_leave(&conv.id).unwrap();

        assert!(
            e.store.get_conversation(&conv.id).unwrap().is_none(),
            "sair tem de remover a conversa local"
        );
        assert!(
            crate::group_trash::is_dismissed(&e.store, &conv.id),
            "sair sem marcar como dispensado deixava o grupo voltar no sync seguinte"
        );
        while commands.try_recv().is_ok() {}
    }

    #[test]
    fn call_invite_registra_o_chamador_como_participante() {
        let (e, _d) = mk_engine("call-invite-parte");
        let me = e.identity.fingerprint.clone();
        let call_id = e.call_invite("peer-alvo", "voice").unwrap();
        assert!(
            e.store.is_in_call(&call_id, &me),
            "sem isto o gate de grupo não reconhece a própria chamada do chamador"
        );
        assert!(e.store.call_participants(&call_id).unwrap().contains(&me));
    }

    #[test]
    fn is_in_call_so_vale_para_a_chamada_e_o_participante_certos() {
        let (e, _d) = mk_engine("is-in-call");
        let me = e.identity.fingerprint.clone();
        e.store.join_call("call-a", &me).unwrap();
        assert!(e.store.is_in_call("call-a", &me));
        assert!(
            !e.store.is_in_call("call-b", &me),
            "outra chamada não conta"
        );
        assert!(
            !e.store.is_in_call("call-a", "outro-fp"),
            "outro fp não é participante"
        );
    }

    // Seção 79: ciclo de vida social
    fn peer_hex(n: u8) -> String {
        format!("{n:02x}").repeat(6)
    }

    #[test]
    fn profile_set_nao_cria_amizade() {
        let (e, _d) = mk_engine("perfil-nao-amiga");
        let peer = peer_hex(0x11);
        perfil_block_on(handle_frame(
            &e,
            &peer,
            "pk",
            "Estranho",
            SecureFrame::ProfileSet {
                display_name: "Estranho".into(),
                about: String::new(),
                avatar_b64: String::new(),
                banner_b64: String::new(),
                accent: String::new(),
                rev: 1,
                content_hash: String::new(),
            },
        ))
        .unwrap();
        assert_eq!(
            e.store.profile_get(&peer).unwrap().display_name,
            "Estranho",
            "perfil é aceito"
        );
        assert_eq!(
            e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
            None,
            "receber perfil NÃO pode virar amizade"
        );
    }

    #[test]
    fn pedido_cruzado_vira_amizade_dos_dois_lados() {
        let a = mk_engine("a").0;
        let b = mk_engine("b").0;
        let fp_a = a.identity.fingerprint.clone();
        let fp_b = b.identity.fingerprint.clone();

        // Os dois pedem ao mesmo tempo; cada um recebe o pedido do outro.
        a.store.set_friend_request_out(&fp_b, "b").unwrap();
        b.store.set_friend_request_out(&fp_a, "a").unwrap();

        perfil_block_on(handle_frame(
            &b,
            &fp_a,
            "pk",
            "a",
            SecureFrame::FriendRequest {
                nickname: "a".into(),
            },
        ))
        .unwrap();

        assert_eq!(
            b.store.get_friend(&fp_a).unwrap().map(|(_, s)| s),
            Some("accepted".into()),
            "quem recebeu o pedido cruzado aceita"
        );
        assert_eq!(
            a.store.get_friend(&fp_b).unwrap().map(|(_, s)| s),
            Some("pending_out".into()),
            "o outro lado só muda quando o FriendAccept chegar"
        );

        perfil_block_on(handle_frame(
            &a,
            &fp_b,
            "pk",
            "b",
            SecureFrame::FriendAccept {
                nickname: "b".into(),
            },
        ))
        .unwrap();
        assert_eq!(
            a.store.get_friend(&fp_b).unwrap().map(|(_, s)| s),
            Some("accepted".into())
        );
    }

    #[test]
    fn aceite_atrasado_nao_recria_amizade_bloqueada() {
        let (e, _d) = mk_engine("aceite-atrasado");
        let peer = peer_hex(0x22);
        e.friend_block(&peer).unwrap();
        perfil_block_on(handle_frame(
            &e,
            &peer,
            "pk",
            "peer",
            SecureFrame::FriendAccept {
                nickname: "peer".into(),
            },
        ))
        .unwrap();
        assert_eq!(
            e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
            Some("blocked".into()),
            "FriendAccept não desfaz bloqueio"
        );
    }

    /// Recusa de um pedido vindo de quem já me bloqueou não rebaixa o
    /// bloqueio — senão um "reject" atrasado me liberava para o abuso.
    #[test]
    fn recusa_preserva_bloqueio_e_nao_apaga_historico() {
        let (e, _d) = mk_engine("recusa");
        let peer = peer_hex(0x33);
        e.store.set_friend_request_in(&peer, "peer").unwrap();
        perfil_block_on(handle_frame(
            &e,
            &peer,
            "pk",
            "peer",
            SecureFrame::FriendReject,
        ))
        .unwrap();
        assert_eq!(
            e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
            Some("rejected".into())
        );
        e.friend_block(&peer).unwrap();
        perfil_block_on(handle_frame(
            &e,
            &peer,
            "pk",
            "peer",
            SecureFrame::FriendReject,
        ))
        .unwrap();
        assert_eq!(
            e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
            Some("blocked".into())
        );
    }

    #[test]
    fn remover_amigo_bloqueado_nao_desbloqueia() {
        let (e, _d) = mk_engine("remover-bloqueado");
        let peer = peer_hex(0x44);
        e.friend_block(&peer).unwrap();
        e.friend_remove(&peer).unwrap();
        assert!(
            e.store.is_blocked_fp(&peer),
            "remover não pode apagar a memória do bloqueio"
        );
    }

    #[test]
    fn desbloquear_nao_recria_amizade() {
        let (e, _d) = mk_engine("desbloquear");
        let peer = peer_hex(0x55);
        e.friend_block(&peer).unwrap();
        e.friend_unblock(&peer).unwrap();
        assert_eq!(
            e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
            Some("removed".into()),
            "desbloqueado volta ao neutro, não a amigo"
        );
    }

    #[test]
    fn pedido_vencido_some_das_listas() {
        let (e, d) = mk_engine("pedido-vencido");
        let peer = peer_hex(0x66);
        e.store.set_friend_request_in(&peer, "velho").unwrap();
        {
            let conn = e.store.locked();
            conn.execute(
                "UPDATE friends SET requested_at=?2 WHERE fp=?1",
                rusqlite::params![
                    peer,
                    crate::identity::now_ms() - crate::social::FRIEND_REQUEST_TTL_MS - 1000
                ],
            )
            .unwrap();
        }
        assert!(e.friends(Some("pending_in")).is_empty());
        drop(d);
    }

    #[test]
    fn gate_de_tres_mensagens_e_por_direcao_e_persistente() {
        let (e, d) = mk_engine("intro");
        let peer = peer_hex(0x77);
        let conv = e.open_dm(&peer, "peer").unwrap();
        e.social_profile_set("Eu", "", "", "", "").unwrap();

        for i in 0..crate::social::DM_INTRO_LIMIT {
            let m = e.send_dm(&conv.id, &format!("oi {i}")).unwrap();
            assert!(m.id.len() > 8);
        }
        let err = e.send_dm(&conv.id, "quarta").unwrap_err().to_string();
        assert!(
            err.contains("limite"),
            "quarta mensagem tem de falhar: {err}"
        );

        // Reabrir o app/banco não devolve crédito.
        let store2 = crate::storage::Store::open(&d.path().join("distorrent.db")).unwrap();
        assert_eq!(
            store2
                .dm_intro_used(&conv.id, &e.identity.fingerprint)
                .unwrap(),
            crate::social::DM_INTRO_LIMIT
        );

        // Aceitar a amizade libera a conversa e zera o contador.
        e.store.accept_friend(&peer, "peer").unwrap();
        e.reset_dm_intro_for_peer(&peer);
        assert!(e.send_dm(&conv.id, "agora pode").is_ok());
    }

    #[test]
    fn aceitar_amizade_zera_o_gate_da_dm() {
        let (e, _d) = mk_engine("intro-aceite");
        let peer = peer_hex(0x88);
        let conv = e.open_dm(&peer, "peer").unwrap();
        e.store.set_friend_request_in(&peer, "peer").unwrap();
        assert!(e
            .store
            .dm_intro_take(
                &conv.id,
                &e.identity.fingerprint,
                crate::social::DM_INTRO_LIMIT
            )
            .unwrap());
        e.friend_respond(&peer, true).unwrap();
        assert_eq!(
            e.store
                .dm_intro_used(&conv.id, &e.identity.fingerprint)
                .unwrap(),
            0
        );
        assert_eq!(
            e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
            Some("accepted".into())
        );
    }

    #[test]
    fn mensagem_bloqueada_nao_sai() {
        let (e, _d) = mk_engine("dm-bloqueada");
        let peer = peer_hex(0x99);
        let conv = e.open_dm(&peer, "peer").unwrap();
        e.friend_block(&peer).unwrap();
        let err = e.send_dm(&conv.id, "oi").unwrap_err().to_string();
        assert!(err.contains("bloqueado"), "{err}");
    }

    #[test]
    fn contadores_por_membro_nao_vazam_entre_grupo() {
        let (e, _d) = mk_engine("contadores");
        let peer_a = peer_hex(0xaa);
        let peer_b = peer_hex(0xbb);
        let conv = e
            .store
            .create_group_dm(
                &e.identity.fingerprint,
                &[peer_a.clone(), peer_b.clone()],
                "g",
            )
            .unwrap();
        // Autoria do OUTRO membro: a própria mensagem nunca conta como não
        // lida para quem a escreveu.
        let msg = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, "oi");
        let mut recebida = msg.clone();
        recebida.author_fp = peer_a.clone();
        e.store.insert_message(&recebida, "in", "ok").unwrap();

        let me = &e.identity.fingerprint;
        assert_eq!(e.store.unread_count_for(&conv.id, me).unwrap(), 1);
        e.store.conv_read_set(&conv.id, me, recebida.ts).unwrap();
        assert_eq!(e.store.unread_count_for(&conv.id, me).unwrap(), 0);
        assert_eq!(
            e.store.unread_count_for(&conv.id, &peer_b).unwrap(),
            1,
            "a leitura de um membro não marca para o outro"
        );
    }

    #[test]
    fn mencao_e_registrada_por_destinatario() {
        let (e, _d) = mk_engine("mencoes");
        let alvo = peer_hex(0xcc);
        let autor = peer_hex(0xcc + 1);
        let meu = e.identity.fingerprint.clone();
        let conv = e
            .store
            .create_group_dm(&meu, &[alvo.clone(), autor.clone()], "g")
            .unwrap();
        let body = format!("oi @{alvo} e @{meu}");
        let mut msg = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, &body);
        msg.author_fp = autor;
        e.store.insert_message(&msg, "in", "ok").unwrap();
        for t in e.store.mention_targets(&body) {
            e.store.mention_add(&msg.id, &conv.id, &t).unwrap();
        }
        assert_eq!(e.store.unread_mentions_for(&meu).unwrap(), 1);
        assert_eq!(e.store.unread_mentions_for(&alvo).unwrap(), 1);
        e.store.conv_read_set(&conv.id, &meu, msg.ts).unwrap();
        assert_eq!(e.store.unread_mentions_for(&meu).unwrap(), 0);
    }

    #[test]
    fn busca_unread_respeita_cursor_por_conversa() {
        let (e, _d) = mk_engine("busca-unread");
        let peer = peer_hex(0xd0);
        let conv = e.open_dm(&peer, "peer").unwrap();
        let mut antes = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, "antiga");
        antes.ts = 1_000;
        antes.author_fp = peer.clone();
        let mut depois = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, "nova");
        depois.ts = 2_000;
        depois.author_fp = peer.clone();
        e.store.insert_message(&antes, "in", "ok").unwrap();
        e.store.insert_message(&depois, "in", "ok").unwrap();

        let mut q = crate::social::SearchQuery {
            has: "unread".into(),
            me: e.identity.fingerprint.clone(),
            ..Default::default()
        };
        assert_eq!(e.store.message_search(&q).unwrap().len(), 2);

        e.store
            .conv_read_set(&conv.id, &e.identity.fingerprint, antes.ts)
            .unwrap();
        let hits = e.store.message_search(&q).unwrap();
        assert_eq!(hits.len(), 1, "só a mensagem posterior ao cursor");
        assert_eq!(hits[0].id, depois.id);

        q.has.clear();
        q.text = "antiga".into();
        assert_eq!(
            e.store.message_search(&q).unwrap().len(),
            1,
            "busca textual continua enxergando o histórico lido"
        );
    }

    #[test]
    fn mensagem_de_amigo_com_conversa_apagada_recria_a_dm_nao_um_grupo() {
        let (e, _d) = mk_engine("dm-apagada");
        // Peer real: a assinatura é verificada contra a pubkey da sessão.
        let kp_amigo = Keypair::generate();
        let amigo = kp_amigo.fingerprint();
        e.store.accept_friend(&amigo, "amigo").unwrap();
        let conv = e.open_dm(&amigo, "amigo").unwrap();
        // Usuário apaga a conversa local; a amizade continua.
        e.store.delete_conversation(&conv.id).unwrap();
        assert!(e.store.get_conversation(&conv.id).unwrap().is_none());

        let env = crate::protocol::MessageEnvelope::new(&kp_amigo, &conv.id, "oi");
        perfil_block_on(handle_frame(
            &e,
            &amigo,
            &kp_amigo.public_hex(),
            "amigo",
            SecureFrame::Msg(env),
        ))
        .unwrap();

        let recriada = e
            .store
            .get_conversation(&conv.id)
            .unwrap()
            .expect("DM volta");
        assert_eq!(recriada.kind, "dm", "não pode virar grupo de 1 pessoa");
    }

    #[test]
    fn grupo_so_e_gerenciado_pelo_criador() {
        let (e, _d) = mk_engine("dono-grupo");
        let outro = peer_hex(0xdd);
        let conv = e
            .store
            .create_group_dm(&e.identity.fingerprint, &[outro.clone()], "g")
            .unwrap();
        // O dono é quem criou (eu), não o primeiro do roster ordenado. Um
        // membro comum tentando reescrever o grupo tem de ser ignorado.
        let r = handle_frame(
            &e,
            &outro,
            "pk",
            "outro",
            SecureFrame::GroupCreated {
                conv_id: conv.id.clone(),
                title: "sequestrado".into(),
                members: vec![(outro.clone(), "outro".into())],
                owner_fp: outro.clone(),
            },
        );
        assert!(perfil_block_on(r).is_ok());
        assert_ne!(
            e.store.get_conversation(&conv.id).unwrap().unwrap().title,
            "sequestrado"
        );
    }

    #[test]
    fn forward_de_canal_exige_host_e_membro() {
        let (e, _d) = mk_engine("forward-guard");
        let estranho = peer_hex(0xee);
        let env = crate::protocol::MessageEnvelope::new(&e.keypair, "canal-alheio", "x");
        // Sem canal no banco, o frame cai no ramo de "contato": um desconhecido
        // não pode injetar mensagem.
        let r = handle_frame(
            &e,
            &estranho,
            "pk",
            "estranho",
            SecureFrame::Forward {
                conv_id: "conv".into(),
                channel_id: String::new(),
                env,
                from_label: "label".into(),
            },
        );
        assert!(perfil_block_on(r).is_err());
    }

    #[test]
    fn adicionar_participante_exige_estar_na_chamada() {
        let (e, _d) = mk_engine("call-add-guard");
        let amigo = peer_hex(0xef);
        e.store.accept_friend(&amigo, "amigo").unwrap();
        let r = handle_frame(
            &e,
            &amigo,
            "pk",
            "amigo",
            SecureFrame::CallAddParticipant {
                call_id: "call-inexistente".into(),
                fp: peer_hex(0xf0),
                kind: String::new(),
            },
        );
        assert!(
            perfil_block_on(r).is_err(),
            "sem estar na chamada, ninguém adiciona participante"
        );
    }

    #[test]
    fn banir_exige_alvo_membro_e_nao_o_proprio() {
        let (e, _d) = mk_engine("ban-guard");
        let meu = e.identity.fingerprint.clone();
        let outsider = peer_hex(0xf1);
        // Eu sou o dono do servidor; recebo um ban de mim mesmo (frame forjado
        // por um peer que se diz dono não passa, mas o alvo tem de ser válido).
        e.store
            .create_community("cid1", "Servidor", &meu, &[])
            .unwrap();
        let r = handle_frame(
            &e,
            &meu,
            "pk",
            "eu",
            SecureFrame::MemberBan {
                community_id: "cid1".into(),
                target_fp: outsider,
                until_ms: 0,
                reason: String::new(),
            },
        );
        assert!(
            perfil_block_on(r).is_err(),
            "banir quem não é membro tem de falhar"
        );
    }

    /// Fluxo completo com dois motores reais: pedido de A, aviso em B,
    /// aceite em B e confirmação em A. Cada passo usa o MESMO frame que o
    /// transporte usaria, então uma quebra de simetria aparece aqui.
    #[tokio::test]
    async fn ciclo_de_amizade_entre_dois_motores_termina_igual_nos_dois() {
        let (a, _da) = mk_engine("amizade-a");
        let (b, _db) = mk_engine("amizade-b");
        let fp_a = a.identity.fingerprint.clone();
        let fp_b = b.identity.fingerprint.clone();

        let outcome = a.friend_request(&fp_b).unwrap();
        assert_eq!(outcome, FriendOutcome::QueuedOffline, "sem link: enfileira");
        assert_eq!(
            a.store.get_friend(&fp_b).unwrap().map(|(_, s)| s),
            Some("pending_out".into())
        );

        // O pedido chega em B (o transporte entregaria este frame).
        handle_frame(
            &b,
            &fp_a,
            "pk-a",
            "a",
            SecureFrame::FriendRequest {
                nickname: "a".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            b.store.get_friend(&fp_a).unwrap().map(|(_, s)| s),
            Some("pending_in".into())
        );

        // B aceita pelo comando local (que também emite o FriendAccept).
        b.friend_respond(&fp_a, true).unwrap();
        assert_eq!(
            b.store.get_friend(&fp_a).unwrap().map(|(_, s)| s),
            Some("accepted".into())
        );

        // O aceite chega em A.
        handle_frame(
            &a,
            &fp_b,
            "pk-b",
            "b",
            SecureFrame::FriendAccept {
                nickname: "b".into(),
            },
        )
        .await
        .unwrap();

        for (quem, e, peer) in [("a", &a, &fp_b), ("b", &b, &fp_a)] {
            assert_eq!(
                e.store.get_friend(peer).unwrap().map(|(_, s)| s),
                Some("accepted".into()),
                "{quem} precisa terminar como amigo"
            );
        }
    }

    /// Remover de um lado chega ao outro e os dois terminam sem amizade.
    #[tokio::test]
    async fn remocao_propaga_e_nao_deixa_amizade_unilateral() {
        let (a, _da) = mk_engine("rm-a");
        let (b, _db) = mk_engine("rm-b");
        let fp_a = a.identity.fingerprint.clone();
        let fp_b = b.identity.fingerprint.clone();
        a.store.accept_friend(&fp_b, "b").unwrap();
        b.store.accept_friend(&fp_a, "a").unwrap();

        a.friend_remove(&fp_b).unwrap();
        handle_frame(&b, &fp_a, "pk-a", "a", SecureFrame::FriendRemove)
            .await
            .unwrap();

        for (quem, e, peer) in [("a", &a, &fp_b), ("b", &b, &fp_a)] {
            assert!(
                !matches!(
                    e.store.get_friend(peer).unwrap().map(|(_, s)| s),
                    Some(s) if s == "accepted"
                ),
                "{quem} não pode continuar amigo depois da remoção"
            );
        }
    }
}

#[cfg(test)]
mod relay_lock_tests {
    use super::*;

    fn mk(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
        let kp = Keypair::generate();
        let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
        (e, dir)
    }

    #[tokio::test]
    async fn liberar_entrada_relay_remove_a_entrada() {
        let (engine, _dir) = mk("relay-lock");
        let fp = "aa11bb22cc33";

        let (_stream, meu) = relay_dial_stream(&engine, fp).expect("primeiro dial cria stream");
        {
            let mapa = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
            assert!(mapa.get(fp).is_some(), "o dial registra a ponta de entrada");
        }

        liberar_entrada_relay(&engine, fp, &meu);

        let mapa = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            mapa.get(fp).is_none(),
            "depois de liberar, a trava some e o peer volta a ser discavel"
        );
    }

    // Seção 77: tokio
    #[tokio::test]
    async fn liberar_nao_remove_entrada_de_outro_dono() {
        let (engine, _dir) = mk("relay-lock2");
        let fp = "dd44ee55ff66";

        let (_stream, _meu) = relay_dial_stream(&engine, fp).expect("cria stream");

        let (outro, _rx) = mpsc::unbounded_channel::<Vec<u8>>();
        liberar_entrada_relay(&engine, fp, &outro);

        let mapa = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        assert!(
            mapa.get(fp).is_some(),
            "a entrada de outro dono tem de sobreviver"
        );
    }
}

#[cfg(test)]
mod call_queue_tests {
    use super::*;
    use crate::protocol::SecureFrame;

    fn offer(n: usize) -> SecureFrame {
        SecureFrame::CallOffer {
            call_id: format!("c{n}"),
            sdp: format!("sdp{n}"),
        }
    }
    fn answer(n: usize) -> SecureFrame {
        SecureFrame::CallAnswer {
            call_id: format!("c{n}"),
            sdp: format!("sdp{n}"),
        }
    }
    fn ice(n: usize) -> SecureFrame {
        SecureFrame::CallIce {
            call_id: "c".into(),
            candidate: format!("cand{n}"),
            mid: "0".into(),
        }
    }
    fn is_ice(f: &SecureFrame) -> bool {
        matches!(f, SecureFrame::CallIce { .. })
    }

    fn mk(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
        let kp = Keypair::generate();
        let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
        (e, dir)
    }

    #[test]
    fn invite_reenviado_nao_reacende_o_ring() {
        let (e, _d) = mk("ring-dedup");
        assert!(e.ring_is_new("call-x", "peer-a"), "primeiro invite toca");
        assert!(
            !e.ring_is_new("call-x", "peer-a"),
            "reenvio do MESMO invite nao pode tocar de novo"
        );
        assert!(
            e.ring_is_new("call-y", "peer-a"),
            "chamada nova precisa tocar mesmo com o mesmo peer"
        );
        assert!(
            e.ring_is_new("call-x", "peer-b"),
            "o mesmo id em outro peer e' outro convite"
        );
    }

    #[test]
    fn call_frame_enfileirado_sobrevive_sem_link() {
        let (e, _d) = mk("call-queue-offline");
        e.enqueue_call_frame("peer-b", offer(1));
        {
            let mapa = e.pending_calls.lock().unwrap();
            let q = mapa.get("peer-b").expect("fila do peer precisa existir");
            assert!(
                q.iter().any(NetworkEngine::is_offer_frame),
                "offer enfileirada nao pode sumir"
            );
        }
        e.flush_pending_calls("peer-b");
        let mapa = e.pending_calls.lock().unwrap();
        assert!(
            mapa.get("peer-b").map(|q| q.is_empty()).unwrap_or(true),
            "o flush precisa drenar a fila da chamada"
        );
    }

    #[test]
    fn peer_offline_nao_apaga_presenca_de_quem_nao_esta_no_canal() {
        let (e, _d) = mk("voice-presence");
        assert!(e
            .store
            .peer_voice_states("peer-sem-voz")
            .unwrap()
            .is_empty());
        e.drop_voice_presence_of("peer-sem-voz");
        assert!(e
            .store
            .peer_voice_states("peer-sem-voz")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn limpeza_de_presenca_e_por_canal() {
        let (e, _d) = mk("voice-presence-2");
        e.store
            .set_voice_state("c1", "canal-a", "peer-x", false, false)
            .unwrap();
        e.store
            .set_voice_state("c2", "canal-b", "peer-x", false, false)
            .unwrap();
        assert_eq!(e.store.peer_voice_states("peer-x").unwrap().len(), 2);
        e.store
            .drop_peer_voice_state("c1", "canal-a", "peer-x")
            .unwrap();
        let restou = e.store.peer_voice_states("peer-x").unwrap();
        assert_eq!(restou.len(), 1, "o outro canal precisa sobreviver");
        assert_eq!(restou[0], ("c2".to_string(), "canal-b".to_string()));
    }

    #[test]
    fn descarte_nunca_derruba_offer_nem_answer() {
        let mut q: Vec<SecureFrame> = vec![offer(0), ice(0), answer(0), ice(1), ice(2), ice(3)];
        for _ in 0..10 {
            NetworkEngine::evict_call_frame(&mut q);
        }
        assert!(
            q.iter().any(NetworkEngine::is_offer_frame),
            "CallOffer jamais pode ser descartado"
        );
        assert!(
            q.iter().any(NetworkEngine::is_answer_frame),
            "CallAnswer jamais pode ser descartado"
        );
    }

    #[test]
    fn descarte_prioriza_descartar_ice_mais_velho() {
        let mut q: Vec<SecureFrame> = vec![offer(0), ice(0), ice(1), ice(2)];
        NetworkEngine::evict_call_frame(&mut q);
        assert_eq!(q.len(), 3);
        assert!(!q
            .iter()
            .any(|f| matches!(f, SecureFrame::CallIce { candidate, .. } if candidate == "cand0")));
        assert!(q.iter().any(NetworkEngine::is_offer_frame));
    }

    #[test]
    fn descarte_so_com_ice_nao_entra_em_panico() {
        let mut q: Vec<SecureFrame> = vec![ice(0), ice(1)];
        NetworkEngine::evict_call_frame(&mut q);
        NetworkEngine::evict_call_frame(&mut q);
        assert!(q.len() <= 1);
        let mut empty: Vec<SecureFrame> = Vec::new();
        NetworkEngine::evict_call_frame(&mut empty);
        assert!(empty.is_empty());
    }

    // Seção 78: test
    #[test]
    fn fila_aclada_so_derruba_candidatos() {
        let mut q: Vec<SecureFrame> = vec![offer(0)];
        for i in 0..(NetworkEngine::PENDING_CALL_MAX * 2) {
            if q.len() >= NetworkEngine::PENDING_CALL_MAX {
                NetworkEngine::evict_call_frame(&mut q);
            }
            q.push(ice(i));
        }
        assert_eq!(q.len(), NetworkEngine::PENDING_CALL_MAX);
        assert!(
            q.iter().any(NetworkEngine::is_offer_frame),
            "a offer sobrevive a {} candidatos ICE acumulados",
            NetworkEngine::PENDING_CALL_MAX * 2
        );
    }

    #[test]
    fn par_offer_answer_e_intocavel() {
        let mut q: Vec<SecureFrame> = vec![offer(0), answer(0)];
        for _ in 0..5 {
            NetworkEngine::evict_call_frame(&mut q);
        }
        assert_eq!(q.len(), 2, "par essencial nao pode ser reduzido");
        assert!(q.iter().any(NetworkEngine::is_offer_frame));
        assert!(q.iter().any(NetworkEngine::is_answer_frame));
        assert!(!q.iter().any(is_ice));
    }
}
