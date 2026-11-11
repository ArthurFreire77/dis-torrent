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
        #[allow(dead_code)]
        is_super: bool,
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
        BuildChallenge { .. }
        | BuildAttestResponse { .. }
        | BuildManifestPush { .. }
        | UpdateHint { .. } => 1,
    }
}

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

#[path = "engine/lifecycle.rs"]
mod lifecycle;

#[path = "engine/privacy.rs"]
mod privacy;

#[path = "engine/diagnostics.rs"]
mod diagnostics;

#[path = "engine/bitdht.rs"]
mod bitdht;

#[path = "engine/relay.rs"]
mod relay;

#[path = "engine/release_trust.rs"]
mod release_trust;

#[path = "engine/tunnel.rs"]
mod tunnel;

#[path = "engine/read_models.rs"]
mod read_models;

#[path = "engine/community.rs"]
mod community;

#[path = "engine/moderation.rs"]
mod moderation;

#[path = "engine/channels_roles.rs"]
mod channels_roles;

#[path = "engine/bots.rs"]
mod bots;

#[path = "engine/bots_actions.rs"]
mod bots_actions;

#[path = "engine/friends.rs"]
mod friends;

#[path = "engine/groups.rs"]
mod groups;

#[path = "engine/social.rs"]
mod social;

#[path = "engine/calls.rs"]
mod calls;

#[path = "engine/voice.rs"]
mod voice;

#[path = "engine/calls_queue.rs"]
mod calls_queue;

#[path = "engine/voice_channels.rs"]
mod voice_channels;

#[path = "engine/files.rs"]
mod files;

#[path = "engine/frames.rs"]
mod frames;

#[path = "engine/f_message.rs"]
mod f_message;

#[path = "engine/f_peer.rs"]
mod f_peer;

#[path = "engine/f_friends.rs"]
mod f_friends;

#[path = "engine/f_community.rs"]
mod f_community;

#[path = "engine/f_groups.rs"]
mod f_groups;

#[path = "engine/f_calls.rs"]
mod f_calls;

#[path = "engine/f_voice.rs"]
mod f_voice;

#[path = "engine/f_files.rs"]
mod f_files;

#[path = "engine/f_attest.rs"]
mod f_attest;

#[path = "engine/f_social.rs"]
mod f_social;

#[path = "engine/f_tunnel.rs"]
mod f_tunnel;

#[path = "engine/runtime.rs"]
mod runtime;

#[path = "engine/session.rs"]
mod session;

#[path = "engine/dial.rs"]
mod dial;

#[path = "engine/dial2.rs"]
mod dial2;

#[path = "engine/relay_loop.rs"]
mod relay_loop;

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
    /// Alvos do toque por chamada; o `call_end` avisa quem ainda não aceitou.
    call_targets: StdMutex<HashMap<String, Vec<String>>>,
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

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
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
    const PENDING_CALL_MAX: usize = 512;
}

fn local_lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

fn privacy_allows_lan(engine: &Arc<NetworkEngine>) -> bool {
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
                    session::register_and_run(
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
                session::register_and_run(
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
                session::register_and_run(
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
    if !privacy_allows_lan(&engine) {
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
            if !privacy_allows_lan(&engine) {
                debug!(%peer_fp, "punch upgrade encerrado: modo anônimo em runtime");
                break;
            }
            let current_endpoint = engine
                .public_addr
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let my_endpoint = match current_endpoint {
                Some(a) => Some(a),
                None if privacy_allows_lan(&engine) => {
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
    if !privacy_allows_lan(&engine) {
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
            session::register_and_run(
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

/// Temas de perfil aceitos. Lista fechada: o receptor não renderiza CSS arbitrário.
pub const PROFILE_THEMES: &[&str] = &["none", "aurora", "sunset", "ocean", "neon", "forest"];

/// Efeitos de avatar aceitos. Qualquer outro valor vira vazio (= sem efeito).
pub const AVATAR_EFFECTS: &[&str] = &["none", "glow", "pulse", "rainbow", "sparkle"];

fn normalize_style(value: &str, allowed: &[&str]) -> String {
    let v = value.trim().to_ascii_lowercase();
    if v.is_empty() || v == "none" {
        return String::new();
    }
    if allowed.contains(&v.as_str()) {
        v
    } else {
        String::new()
    }
}

fn cap_style(value: &str, max_bytes: usize) -> String {
    let v: String = value.trim().chars().take(16).collect();
    if v.len() <= max_bytes {
        v
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
        profile_theme: p.profile_theme.clone(),
        avatar_effect: p.avatar_effect.clone(),
        decoration: p.decoration.clone(),
    }
}

pub const PROFILE_SYNC_INTERVAL_SECS: u64 = 600;

const PROFILE_IMG_B64_MAX: usize = 80_000;
const PROFILE_BANNER_B64_MAX: usize = 110_000;

pub const PROFILE_IMAGE_MAX_BYTES: usize = PROFILE_IMG_B64_MAX * 3 / 4;
pub const PROFILE_BANNER_MAX_BYTES: usize = PROFILE_BANNER_B64_MAX * 3 / 4;

const ANNOUNCE_REPUBLISH_MS: i64 = 60 * 1000;

pub const MAX_ANNOUNCED_FILE_BYTES: u64 = 500 * 1024 * 1024 * 1024;

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
    is_super: bool,
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

    let applied = engine
        .store
        .reaction_apply_full(msg_id, conv_id, emoji, peer_fp, add_from_peer, is_super)
        .map_err(reaction_storage_error)?;
    drop(limiter);

    let _ = engine.events.send(EngineEvent::ReactionChanged {
        msg_id: msg_id.to_string(),
        conv_id: conv_id.to_string(),
        emoji: emoji.to_string(),
        add: applied,
        reactor_fp: peer_fp.to_string(),
        is_super,
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
                        is_super,
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
            None => self
                .store
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
                .unwrap_or(false),
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
        if let Err(e) =
            frames::handle_frame(&engine_inner, &fp_owned, &tun_pubkey, &tun_nick, frame).await
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

static PROCESS_PORTS: std::sync::OnceLock<StdMutex<std::collections::HashSet<u16>>> =
    std::sync::OnceLock::new();

fn process_ports() -> &'static StdMutex<std::collections::HashSet<u16>> {
    PROCESS_PORTS.get_or_init(|| StdMutex::new(std::collections::HashSet::new()))
}

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
#[path = "engine/engine_tests/support.rs"]
mod engine_tests_support;

#[cfg(test)]
#[path = "engine/engine_tests/part1.rs"]
mod engine_tests_part1;

#[cfg(test)]
#[path = "engine/engine_tests/part2.rs"]
mod engine_tests_part2;

#[cfg(test)]
#[path = "engine/engine_relay_lock_tests.rs"]
mod relay_lock_tests;

#[cfg(test)]
#[path = "engine/engine_call_queue_tests.rs"]
mod call_queue_tests;
