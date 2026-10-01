//! NetworkEngine: orquestra listener TCP, descoberta LAN, conexões por peer
//! (heartbeat, reconexão com backoff), outbox e eventos para a UI.
//!
//! Estados REAIS por peer e agregados — nada de texto fixo "connected".

#[cfg(target_os = "linux")]
use std::collections::HashSet;
use std::collections::{HashMap, VecDeque};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use crate::net::socks5::{socks5_connect, split_host_port, SocksTarget};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, Notify};
use tokio::task::JoinHandle;
use tokio::time::{interval, sleep, timeout};
use tracing::{debug, info, warn};

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
    decode_envelope, encode_frag, encode_full, tunnel_key, tunnel_transcript, virtual_ipv6,
    TunMsg, TunnelPending, TunnelReassembler, TunnelSession, TUN_FRAME_MAX, TUN_FRAG_MAX,
};
use crate::protocol::{HandshakeFrame, MessageEnvelope, SecureFrame};
use crate::storage::{
    BotPatch, BotRow, ChannelMetaRow, Conversation, PeerRecord, RoleRow, Store, StoredMessage,
};
use crate::{ForgeError, Result};

pub const PING_INTERVAL: Duration = Duration::from_secs(10);
pub const PING_TIMEOUT: Duration = Duration::from_secs(25);
/// Heartbeat do relay: detecção de sessão morta em ~60s (antes 120s).
/// Poll + POST têm latência de segundos, mas 60s de silêncio é morte certa —
/// rediala rápido em vez de segurar mensagem como "sending" à toa.
/// VOZ (frames pequenos/frequentes): o reader usa `timeout(ping_timeout,
/// recv)` — QUALQUER frame (voz/sinalização/Ping) prova liveness, então rajada
/// de voz mantém a sessão viva sem Pings extras. 20s/120s: tolera rádio
/// móvel (sleep/Doze do 4G) sem flapping conecta/desconecta — 60s matava
/// sessão saudável cujo celular dormiu; 120s de silêncio real é morte certa
/// e o redial continua rápido após a queda.
pub const RELAY_PING_INTERVAL: Duration = Duration::from_secs(20);
pub const RELAY_PING_TIMEOUT: Duration = Duration::from_secs(120);
/// Timeout do handshake pelo relay (várias rodadas de poll).
pub const RELAY_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);
/// Tentativa de DIAL: janela para o handshake relay fechar sob 4G lento.
/// 20s (era 40s): com Hello retransmitido a cada 1,5s dá ~13 Hellos por
/// tentativa; se não fechou, rediala MAIS RÁPIDO (backoff 1s→10s) em vez de
/// segurar 40s numa sessão que não vai nascer — era isso que dava o delay.
pub const RELAY_DIAL_ATTEMPT: Duration = Duration::from_secs(20);
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);

/// Duração padrão do silenciamento de conta quando o moderador não informa
/// um prazo. 10 minutos é o mesmo piso do Discord: suficiente para a
/// situação, curto o bastante para um engano não custar o dia do usuário.
pub const MUTE_DEFAULT_MS: i64 = 10 * 60 * 1000;
pub const RECONNECT_BACKOFF_MAX: Duration = Duration::from_secs(15);
/// Keepalive do mapeamento NAT (UPnP/NAT-PMP): renova antes do lease de 1h
/// expirar. 15min dá margem folgada p/ roteador lento e mantém o pinhole vivo.
pub const NAT_RENEW_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Corrente de fallback automática (degrau 3): nº de falhas de estabelecimento
/// (direto/relay) por peer que dispara a queda para o modo `proxy` (SOCKS5).
pub const AUTO_PROXY_FAILURE_THRESHOLD: u32 = 6;

/// Apos esta quantidade de falhas DIRETAS seguidas (e sem tempo de sucesso),
/// o motor para de insistir na rota direta e passa a usar relay/tunel.
/// Antes o redial repetia indefinidamente (20+ timeouts por peer atras de
/// CGNAT), queimando CPU e deixando a UI presa em "CONECTANDO" sem Said a.
pub const DIRECT_UNREACHABLE_THRESHOLD: u32 = 8;
/// Tempo minimo sem sucesso antes de declarar a rota direta inutil.
pub const DIRECT_UNREACHABLE_STALL_MS: i64 = 20_000;
/// Janela sem sessão online (desde a 1ª falha do peer) que também dispara o
/// fallback, mesmo com menos de `AUTO_PROXY_FAILURE_THRESHOLD` falhas.
pub const AUTO_PROXY_STALL_MS: i64 = 40_000;
/// Cooldown por peer da troca automática: evita flapping (não troca de novo
/// para o MESMO peer nesse intervalo). O usuário pode reverter manualmente.
pub const AUTO_PROXY_COOLDOWN_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum NetworkState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FriendOutcome {
    Sent,          // peer online — pedido transmitido agora
    QueuedOffline, // peer offline — será enviado ao conectar
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
        /// v6: não-vazio = o receptor deve TOCAR (ring do convidado).
        kind: String,
    },
    /// Túnel virtual com o peer ESTABELECIDO (handshake X25519 via relay ok).
    /// `virtual_ip` = fd9d::/8 determinístico do fp (Fase 1: pacotes via relay;
    /// Fase 2+: UDP direto quando o furo abrir).
    TunnelUp { fp: String, virtual_ip: String },
    /// Pong do túnel (resposta ao ping): prova ponta a ponta cifrada.
    TunnelPong { fp: String, id: u64, rtt_ms: i64 },
    /// Endpoint NAT próprio (re)descoberto no tick de announce — a UI usa
    /// para o degrau da mídia. `source`: "upnp" (local, sem servidor) ou
    /// "stun" (reflexo público). Serializa como `nat_endpoint` (sem sufixo
    /// Ev, sem alias no TS).
    NatEndpoint { addr: String, source: String },
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
    FileAnnounceEv {
        file_id: String,
        name: String,
        size: u64,
        chunks: u32,
        hash: String,
        from_fp: String,
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
    /// Troca AUTOMÁTICA de modo de privacidade (corrente de fallback).
    /// Informativo p/ a UI; o modo vigente segue em `privacy.mode` (kv).
    ModeAutoSwitched {
        to: String,
        reason: String,
    },
    // ---------- camada social (v3) ----------
    /// Uma reação mudou (add/remove) — a UI recarrega as resumo.
    ReactionChanged {
        msg_id: String,
        conv_id: String,
        emoji: String,
        add: bool,
        reactor_fp: String,
    },
    /// Mensagem editada (novo corpo + ts de edição).
    MessageEdited {
        msg_id: String,
        conv_id: String,
        body: String,
    },
    /// Mensagem apagada (exclusão lógica).
    MessageDeleted {
        msg_id: String,
        conv_id: String,
    },
    /// Mensagem fixada/desfixada.
    MessagePinned {
        msg_id: String,
        conv_id: String,
        pinned: bool,
    },
    /// Uma mensagem passou a responder a outra.
    MessageReply {
        msg_id: String,
        reply_to: String,
    },
    /// Presença de um peer mudou.
    PresenceChanged {
        fp: String,
        status: String,
        custom: String,
        custom_emoji: String,
    },
    /// Perfil de um peer mudou.
    ProfileChanged {
        fp: String,
        profile: crate::social::ProfileView,
    },
    /// Thread criada.
    ThreadCreated {
        community_id: String,
        thread: crate::social::ThreadRow,
    },
    /// Moderador aplicou ban/timeout em alguém.
    ModerationApplied {
        community_id: String,
        target_fp: String,
        kind: String,
        until_ms: i64,
        reason: String,
    },
    /// Enquete criada/votada.
    PollUpdated {
        community_id: String,
        channel_id: String,
        poll_id: String,
    },
    /// Evento agendado criado/atualizado.
    EventUpdated {
        community_id: String,
        event_id: String,
    },
    /// Emoji do servidor criado.
    EmojiUpdated {
        community_id: String,
        emoji_id: String,
    },
    /// Moderação msg: alguém foi impedido de falar (slowmode/timeout/ban).
    Muted {
        context: String,
        reason: String,
        until_ms: i64,
    },
    /// "Fp está digitando em conv_id até until_ms" — puramente efêmero, a UI
    /// expira pelo prazo e nunca persiste.
    PeerTyping {
        fp: String,
        conv_id: String,
        until_ms: i64,
    },
    Error {
        context: String,
    },
}

// ── v6: opções do WIZARD de criação de servidor (desserializadas do Tauri) ──

/// Canal inicial com tipo/categoria (text|voice|video).
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(default)]
pub struct CommunityChannelSeed {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub category: String,
}

/// Cargo inicial do wizard (presets admin/moderador/membro).
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

/// Tudo opcional — o fluxo legado (nome + CSV de canais) continua válido.
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PeerLinkState {
    Connecting,
    Online,
    Reconnecting,
}
struct PeerLink {
    state: StdMutex<PeerLinkState>,
    /// comandos → writer task, com classe de prioridade QoS (menor = primeiro).
    tx: Option<mpsc::UnboundedSender<(u8, SecureFrame)>>,
    drop_notify: Notify,
    via_relay: bool, // true = sessão sobre relay (fallback sem porta aberta)
}

/// QoS: classifica o frame em classe de prioridade (menor número = sai antes).
/// Reordenar ENTRE classes é seguro para o protocolo (subsistemas distintos,
/// receptor dedupa/ordena por id/nonce); dentro da classe a ordem é FIFO.
/// Voz/sinalização nunca espera atrás de chunk de arquivo; ping nunca morre
/// atrás de nada (liveness é o que detecta peer morto).
pub fn frame_class(frame: &SecureFrame) -> u8 {
    use SecureFrame::*;
    match frame {
        // 0 — realtime: chamada, voz, liveness
        CallInvite { .. }
        | CallAccept { .. }
        | CallReject { .. }
        | CallEnd { .. }
        | CallOffer { .. }
        | CallAnswer { .. }
        | CallIce { .. }
        | CallAddParticipant { .. }
        | ScreenShareOffer { .. }
        | ScreenShareAnswer { .. }
            | VoiceJoin { .. }
            | VoiceLeave { .. }
            | VoiceState { .. }
            | TunnelOffer { .. }
            | TunnelAnswer { .. }
            | TunnelData { .. }
            | Ping { .. }
            | Pong { .. } => 0,
        // 1 — controle social/conexão
        FriendRequest { .. }
        | FriendAccept { .. }
        | FriendReject
        | FriendRemove
        | Punch { .. }
        | JoinCommunity { .. }
        | CommunityKicked { .. }
        | GroupCreated { .. }
        | GroupMemberAdded { .. }
        | PeerExchange { .. }
        | PeerRelayPut { .. }
        | PeerRelayGet { .. }
        | PeerRelayData { .. }
        // camada social: mesma prioridade do controle social (nunca atrás de
        // bulk de arquivos — uma reação não pode esperar 2MB de chunk).
        | React { .. }
        | Reply { .. }
        | MsgEdit { .. }
        | MsgDelete { .. }
        | MsgPin { .. }
        | Forward { .. }
        | PresenceSet { .. }
        | PresencePing
        | ProfileSet { .. }
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
        // `Typing` é descartável por natureza (o receptor expira sozinho em
        // ~6s): vai na mais baixa prioridade de forma proposital, para nunca
        // disputar fila com mensagem, reação ou chunk.
        | Typing { .. }
        | ChannelReorder { .. }
        | Bye => 1,
        // 2 — mensagens + acks
        Msg(_) | ChannelMsg { .. } | ChannelAck { .. } | Ack { .. } => 2,
        // 3 — bulk: arquivos + estado completo de comunidade
        FileAnnounce { .. }
        | FileChunkRequest { .. }
        | FileChunkData { .. }
        | FileHave { .. }
        | CommunityState { .. } => 3,
    }
}

/// Diagnóstico POR PEER — por que está (ou não) conectado. Sem isto a UI só
/// mostra "CONECTANDO" pra sempre sem motivo técnico. Preenchido pelos laços
/// de dial (direto/relay) e pelo lookup de announce.
#[derive(Clone, Debug, Default)]
pub struct PeerDiagInfo {
    /// Último erro do dial DIRETO (io/timeout/handshake) — None se nunca tentou.
    pub last_direct_err: Option<String>,
    /// Último dial direto bem-sucedido (epoch ms) — 0 = nunca.
    pub last_direct_ok_ms: i64,
    /// Último erro do dial RELAY ("timeout — peer offline?" etc).
    pub last_relay_err: Option<String>,
    /// Última sessão relay estabelecida (epoch ms) — 0 = nunca.
    pub last_relay_ok_ms: i64,
    /// Vezes que vimos o anúncio de endpoint do peer (epoch ms do último).
    pub announce_seen_ms: i64,
    /// Contadores de tentativa (direto/relay) para a UI mostrar esforço real.
    pub direct_attempts: u64,
    pub relay_attempts: u64,
    /// Túnel virtual estabelecido? (Fase 1+)
    pub tunnel_up: bool,
    /// IP virtual fd9d:: do peer (determinístico do fp; Some com túnel).
    pub virtual_ip: Option<String>,
    /// Frames recebidos/enviados PELO túnel (prova de uso real na UI).
    pub tunnel_rx_frames: u64,
    pub tunnel_tx_frames: u64,
    /// Último toque em qualquer campo (epoch ms) — base do bound LRU do mapa.
    pub last_seen_ms: i64,
}

/// Diagnóstico GLOBAL da rede: STUN, anúncio de endpoint e DHT BitTorrent.
#[derive(Clone, Debug, Default)]
pub struct NetDiagInfo {
    /// STUN funcionou? None = ainda não testado.
    pub stun_ok: Option<bool>,
    pub stun_addr: Option<String>,
    pub stun_ms: i64,
    /// Endpoint próprio anunciado (addr + quando) — None = não anunciou
    /// (CGNAT sem UPnP: direto só se o PAR puder receber).
    pub announce_addr: Option<String>,
    pub announce_ms: i64,
    /// Origem do endpoint anunciado: "upnp" (mapeamento local UPnP/NAT-PMP,
    /// sem servidor) ou "stun" (reflexo via STUN público). None = sem endpoint.
    pub nat_source: Option<String>,
    /// DHT mainline BitTorrent: None = não testada/fora do modo; true = nó
    /// anunciando na rede BitTorrent.
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

pub struct NetworkEngine {
    pub store: Arc<Store>,
    keypair: Arc<Keypair>,
    identity: Identity,
    nickname: String,
    #[allow(dead_code)] // usado por backup/Host (fase seguinte)
    data_dir: PathBuf,
    links: StdMutex<HashMap<String, Arc<PeerLink>>>,
    events: broadcast::Sender<EngineEvent>,
    cmd_tx: mpsc::UnboundedSender<EngineCmd>,
    /// Consumido por `run_engine` no boot — new() não pode spawnar porque
    /// pode ser chamado fora de um runtime tokio (ex.: commands síncronos do Tauri).
    cmd_rx: StdMutex<Option<mpsc::UnboundedReceiver<EngineCmd>>>,
    pending_joins: StdMutex<HashMap<String, String>>,
    listen_port: AtomicU16,
    started: StdMutex<bool>,
    shutdown: Arc<Notify>,
    handles: StdMutex<Vec<JoinHandle<()>>>,
    /// Entradas de frames do relay por peer (poller → sessão). Quando vazio,
    /// o poller cria sessão respondente para Hello recém-chegado.
    relay_in: StdMutex<HashMap<String, mpsc::UnboundedSender<Vec<u8>>>>,
    /// Backend do relay (padrão: MultiRelay público; testes injetam MemRelay).
    relay_backend: StdMutex<Arc<dyn RelayBackend>>,
    /// Backend foi injetado externamente (testes/host)? Nesse caso o engine
    /// NÃO o sobrescreve ao (re)aplicar o modo de privacidade.
    relay_backend_custom: AtomicBool,
    /// Backend atual roteia por SOCKS5 (proxy/Tor): habilita o relay nesses
    /// modos SEM vazar o IP real (fail-closed quando não há proxy configurado).
    relay_proxied: AtomicBool,
    /// Kill-switch do relay (`FORGE_NO_RELAY=1` ou `set_relay_disabled(true)`):
    /// `relay_allowed()` vira false e nenhum post/poll de relay acontece; a
    /// rota DIRETA (TCP, hole punch, UPnP, LAN) segue normal. Ativado por env
    /// no boot e alternável em runtime — nunca sobrescreve backend injetado.
    relay_disabled: AtomicBool,
    /// Kill-switch PRÓPRIO do peer-relay. Diferente do relay público (OPT-IN,
    /// desligado por padrão), o peer-relay é um transporte p2p que NÃO usa
    /// broker público — por isso nasce LIGADO (só modo anônimo/backend
    /// injetado o desabilitam). `FORGE_NO_RELAY`/`set_relay_disabled(true)`
    /// desligam ambos; o default `relay_disabled=true` NÃO o desliga.
    peer_relay_disabled: AtomicBool,
    /// (F7) Intermediário por PEER: **AUTOMÁTICO (ligado por padrão)** — quando
    /// o direto falha, um peer online encaminha os frames cifrados E2E.
    /// Desliga com `FORGE_NO_RELAY=1` ou `FORGE_PEER_RELAY=0`; off em proxy/full.
    peer_relay_optin: AtomicBool,
    /// Peer ONLINE escolhido como intermediário do circuito peer-relay (v0).
    /// `None` = sem intermediário → usa o backend de relay configurado.
    /// Nunca vira amigo, nunca entra em lista de UI, nunca gera evento.
    peer_relay: Arc<StdMutex<Option<String>>>,
    /// Cache do backend peer-relay p/ o intermediário atual. PRECISA ser
    /// estável: o oneshot do `poll` só é resolvido pelo MESMO objeto.
    peer_relay_backend: StdMutex<Option<(String, Arc<PeerRelayBackend>)>>,
    /// Guards de maintain do relay (um por peer, eterno): evita tempestade de
    /// dials duplicados (bootstrap reenvia ConnectRelay a cada 5s sem link;
    /// sem guard, cada redial após disconnect gerava +1 maintain concorrente
    /// com Hello/eph distintos — livelock de dial cruzado).
    relay_maintains: StdMutex<std::collections::HashSet<String>>,
    /// Dedup dos dials DIRETOS (`connect_and_maintain`), chave `fp@addr`.
    /// Sem isto, cada evento de descoberta re-engatilhava um novo laço direto
    /// (milhares de tarefas/redial em LAN), porque o loop de discovery reenvia
    /// ConnectTo enquanto o relay está online. Uma tarefa por destino conhecido.
    direct_maintains: StdMutex<std::collections::HashSet<String>>,
    /// Upgrades relay→direta: peer → geração do loop de Punch. O contador
    /// evita corrida (o loop antigo NÃO remove a chave de um loop novo) e
    /// impede empilhar vários loops de furo para a mesma sessão.
    punch_upgrades: StdMutex<HashMap<String, u64>>,
    /// Rate-limit do `Punch` RECEBIDO por peer (unix_ms do último): evita
    /// que um peer autenticado nos use como amplificador de dials/SYNs.
    punch_rate: StdMutex<HashMap<String, i64>>,
    /// Fila de sinalização de chamada por peer (Call*/ScreenShare* quando
    /// offline): `call_invite/accept/reject/end/signal` enfileiram aqui + disparam
    /// dial imediato (ConnectRelay + LookupAnnounce, igual a friend_request);
    /// `register_and_run` drena via FLUSH IMEDIATO na sessão recém-criada
    /// (mesmo padrão de flush_friend_requests/flush_joins — sem esperar o tick
    /// de 5s). Cap 64/peer (voz/sinalização é efêmera; além disso descarta a
    /// mais antiga). NÃO havia fila antes — frames offline eram descartados.
    pending_calls: StdMutex<HashMap<String, Vec<SecureFrame>>>,
    /// Último endpoint público anunciado (UPnP/ipify) — usado no Punch.
    public_addr: StdMutex<Option<String>>,
    /// Porta EXTERNA mapeada no roteador (UPnP/NAT-PMP) que DEVE ser anunciada.
    /// 0 = desconhecida (usa a porta interna do listener). NAT-PMP pode atribuir
    /// uma porta externa diferente da interna; anunciar a interna quebraria o
    /// inbound (o peer disca o endpoint publicado).
    nat_external_port: Arc<AtomicU16>,
    /// Kill-flag do hole punching (`FORGE_PUNCH=0` desliga). A direta normal
    /// (dial outbound/UPnP/LAN) continua; só o furo coordenado para.
    punch_enabled: AtomicBool,
    /// Falhas de estabelecimento por peer: `(contagem, 1ª falha unix_ms)`.
    /// Alimenta o fallback automático para proxy (degrau 3).
    dial_failures: StdMutex<HashMap<String, (u32, i64)>>,
    /// Diagnóstico por peer (por que conecta ou não) — lido pela UI.
    peer_diag: StdMutex<HashMap<String, PeerDiagInfo>>,
    /// Diagnóstico global (STUN/announce/DHT) — lido pela UI.
    net_diag: StdMutex<NetDiagInfo>,
    /// Nó DHT mainline BitTorrent (BEP-5) — descoberta descentralizada.
    bit_dht: StdMutex<Option<Arc<mainline::Dht>>>,
    /// Último lookup DHT por peer (epoch ms) — rate-limit por peer.
    dht_lookups: StdMutex<HashMap<String, i64>>,
    /// Fila urgente de lookups DHT (friend_request, maintain) — pop no loop.
    dht_queue: StdMutex<Vec<String>>,
    /// Última troca AUTOMÁTICA para proxy por peer (unix_ms) — cooldown
    /// anti-flapping; nunca reverte sozinho.
    auto_proxy_switched: StdMutex<HashMap<String, i64>>,
    /// Túnel virtual (LAN estilo Radmin): sessões estabelecidas por peer.
    tunnel_sessions: StdMutex<HashMap<String, TunnelSession>>,
    /// Ofertas de túnel que EU fiz, aguardando resposta (segredo efêmero).
    tunnel_pending: StdMutex<HashMap<String, TunnelPending>>,
    /// proto_v do handshake por peer (gate dos frames do túnel: >= 2).
    peer_protos: StdMutex<HashMap<String, u32>>,
    /// Timeouts Tor consecutivos por peer (modo full): 3 → tenta o túnel.
    tor_timeouts: StdMutex<HashMap<String, u32>>,
    /// Pings do túnel aguardando pong: (fp, id) → enviado_ms (RTT honesto).
    tunnel_pings: StdMutex<HashMap<(String, u64), i64>>,
    /// Credenciais do peer no túnel (fp → (pubkey_hex, nick)): dispatch de
    /// frames que chegam PELO túnel precisa autenticar o contexto.
    tunnel_meta: StdMutex<HashMap<String, (String, String)>>,
    /// Remontagem de frames fragmentados do túnel.
    tunnel_reasm: StdMutex<TunnelReassembler>,
    /// Kill-flag do túnel (`FORGE_NO_TUNNEL=1` desliga). Direto/relay seguem.
    tunnel_disabled: AtomicBool,
    /// Anti-spam (Storm camada de segurança): flood por peer
    /// `(contagem, início_da_janela_ms)` — janela 10s, teto 10 msgs (Medium).
    /// Estourar = mensagem descartada (sessão preservada) + reputação cai.
    spam_flood: StdMutex<HashMap<String, (u32, i64)>>,
    /// Anti-spam: último `(hash_do_conteúdo, ts_ms)` por peer — repetida
    /// em <60s é descartada.
    spam_dup: StdMutex<HashMap<String, (String, i64)>>,
    /// Mídia de voz NATIVA (webrtc-rs + cpal + Opus). `None` = indisponível
    /// (sem microfone, sem device, ou desligado por `FORGE_NO_NATIVE_VOICE=1`)
    /// — e aí o WebRTC do navegador é o dono das chamadas, como antes.
    #[cfg(target_os = "linux")]
    voice: Option<Arc<VoiceMedia>>,
    /// PARES `(call_id, peer_fp)` cuja sinalização é DESTA camada nativa.
    ///
    /// Esta é a REGRA DE COEXISTÊNCIA, e é ela sozinha que mantém o navegador
    /// no comando: um `CallOffer`/`CallAnswer`/`CallIce` só é absorvido pela
    /// mídia nativa se o par estiver AQUI. Sem registro, o frame segue intacto
    /// para o JS e a WebView cria a `RTCPeerConnection` como sempre. Nada mais
    /// no motor precisa saber disso.
    #[cfg(target_os = "linux")]
    voice_calls: StdMutex<HashMap<String, HashSet<String>>>,
}

enum EngineCmd {
    ConnectTo(SocketAddr, Option<String>), // addr, fp esperado
    ConnectHost {
        host: String,
        port: u16,
        expected_fp: Option<String>,
    }, // domínio/IP/.onion
    ConnectRelay(String),                  // fp — handshake via relay (sem porta aberta)
    LookupAnnounce(String),                // fp — lookup único de endpoint (direta imediata)
    PunchDial {
        fp: String,
        endpoint: String,
        at_ms: u64,
    }, // furo TCP simultâneo coordenado
    SendToPeer(String, SecureFrame),       // peer fp, frame
    FlushOutbox(String),                   // peer fp
}

/// Política do peer-relay por modo de privacidade: `(usar, servir)`.
/// - `normal`/`encrypted`: PERMITE usar como cliente e atuar como intermediário.
/// - `proxy`/`full`: NEGA ambos — o intermediário veria o IP real de quem o
///   contacta (e o cliente exporia sua origem ao intermediário).
/// - qualquer outro valor: fail-closed (nega ambos).
pub fn peer_relay_policy(mode: &str) -> (bool, bool) {
    match mode {
        "normal" | "encrypted" => (true, true),
        "proxy" | "full" => (false, false),
        _ => (false, false),
    }
}

/// Regra PURA do degrau 3 da corrente de fallback: devemos trocar para o modo
/// `proxy` (SOCKS5) agora? Fail-closed — qualquer dúvida retorna `false`.
///
/// - `enabled`: `FORGE_AUTO_PROXY` ligado (default DESLIGADO — opt-in manual).
/// - `has_proxy`: existe SOCKS5 configurado (`FORGE_PROXY_ADDR`/kv).
/// - só troca a partir de `normal`/`encrypted`; NUNCA de `full` (Tor) nem de
///   `proxy` (já está lá).
/// - `already_switched`: já houve troca automática p/ este peer (anti-flapping).
/// - `failures`: falhas de estabelecimento acumuladas; limiar claro (>= 6).
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

// ============================================================ voz nativa (LINUX)
//
// WebRTC do navegador (WebView) é o caminho de voz que já funciona em
// Windows/Android/macOS e não se mexe. Por isso tudo abaixo é `cfg(linux)`: nas
// outras plataformas este arquivo não tem uma linha sequer de mídia nativa, e
// as dependências (webrtc-rs, cpal, libopus) nem entram no build. A camada Rust abaixo é um SEGUNDO
// caminho, opt-in, que existe porque o WebKitGTK não expõe `RTCPeerConnection`
// de forma confiável.
//
// A coexistência não é feita por condição espalhada: é feita por REGISTRO. O
// motor só marca um par `(call_id, peer_fp)` como nativo quando ELE MESMO
// iniciou essa chamada por aqui (`call_invite`/`call_accept`/
// `call_add_participant`). Todo `CallOffer`/`CallAnswer`/`CallIce` que chega
// sem registro correspondente atravessa o motor intacto e vira
// `EngineEvent::Call*` — que é exatamente o que a WebView já consome hoje.

/// A camada nativa de áudio só entra em cena no Linux.
///
/// Windows, Android e macOS já têm WebRTC do navegador funcionando e medido.
/// Trocar esse caminho por cpal+opus nessas plataformas seria trocar algo
/// validado por algo que ninguém mediu lá — e o requisito de não quebrar esses
/// três sistemas manda mais que a paridade de código.
#[cfg(target_os = "linux")]
#[inline]
fn native_voice_platform_ok() -> bool {
    cfg!(target_os = "linux")
}

/// Estamos DENTRO de um runtime tokio multi-thread? (único que aceita
/// `block_in_place`).
#[cfg(target_os = "linux")]
#[inline]
fn in_multi_thread_runtime() -> bool {
    tokio::runtime::Handle::try_current()
        .is_ok_and(|h| matches!(h.runtime_flavor(), tokio::runtime::RuntimeFlavor::MultiThread))
}

/// Kill-switch de emergência (`FORGE_NO_NATIVE_VOICE=1`): desliga a mídia
/// nativa sem recompilar. Útil para comparar os dois caminhos lado a lado.
#[cfg(target_os = "linux")]
#[inline]
/// Este BUILD tem voz nativa? — independente do motor existir.
///
/// BUG que isto corrige: `voice_media_available` consultava o motor, que é
/// `None` enquanto o cofre está trancado. O app perguntava no boot, recebia
/// `false`, e o JS cacheava "indisponível" para sempre — mesmo depois de
/// desbloquear, quando a voz já estava de pé. Capacidade é propriedade do
/// build, não do estado.
pub fn native_voice_capable() -> bool {
    native_voice_platform_ok() && native_voice_env_ok()
}

fn native_voice_env_ok() -> bool {
    !matches!(
        std::env::var("FORGE_NO_NATIVE_VOICE")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

/// Constrói o gerenciador de mídia, ou `None` se não der.
///
/// TOLERANTE DE FALHA de propósito: sem microfone, sem alto-falante, sem
/// device, ou até sem runtime — nada disso pode derrubar o motor, porque o
/// motor também é o caminho de texto/arquivos. Com `None` o app continua
/// sinalizando chamada normalmente e a WebView faz a voz como sempre.
#[cfg(target_os = "linux")]
fn build_voice_media() -> Option<Arc<VoiceMedia>> {
    if !(native_voice_platform_ok() && native_voice_env_ok()) {
        return None;
    }
    match VoiceMedia::new() {
        Ok(v) => {
            // eprintln e não tracing: o subscriber não escreve em stdout, e este
            // é o log que responde "por que a chamada não usa voz nativa?".
            eprintln!(
                "[forge] voz nativa: ATIVA (microfone: {})",
                if v.has_capture() { "sim" } else { "não — somente recebendo" }
            );
            info!(
                "voz nativa: ativa (microfone: {})",
                if v.has_capture() { "sim" } else { "não — só recebendo" }
            );
            Some(v)
        }
        Err(e) => {
            eprintln!("[forge] voz nativa: INDISPONIVEL ({e}) — o WebRTC do navegador assume");
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
            listen_port: AtomicU16::new(0),
            started: StdMutex::new(false),
            shutdown: Arc::new(Notify::new()),
            handles: StdMutex::new(Vec::new()),
            relay_in: StdMutex::new(HashMap::new()),
            relay_backend: StdMutex::new(Arc::new(MultiRelay::default_routes_with_fp(
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
            tunnel_disabled: AtomicBool::new(
                matches!(
                    std::env::var("FORGE_NO_TUNNEL")
                        .ok()
                        .as_deref()
                        .map(|s| s.trim().to_ascii_lowercase())
                        .as_deref(),
                    Some("1" | "true" | "yes" | "on")
                ),
            ),
            spam_flood: StdMutex::new(HashMap::new()),
            spam_dup: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            voice: build_voice_media(),
            #[cfg(target_os = "linux")]
            voice_calls: StdMutex::new(HashMap::new()),
        })
    }

    pub fn new_with_identity(
        store: Arc<Store>,
        keypair: Keypair,
        identity: Identity,
        data_dir: PathBuf,
    ) -> Arc<Self> {
        // usa identidade armazenada (preserva fingerprint legado d9a8cb... para não quebrar mensagens)
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
            listen_port: AtomicU16::new(0),
            started: StdMutex::new(false),
            shutdown: Arc::new(Notify::new()),
            handles: StdMutex::new(Vec::new()),
            relay_in: StdMutex::new(HashMap::new()),
            relay_backend: StdMutex::new(Arc::new(MultiRelay::default_routes_with_fp(
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
            tunnel_disabled: AtomicBool::new(
                matches!(
                    std::env::var("FORGE_NO_TUNNEL")
                        .ok()
                        .as_deref()
                        .map(|s| s.trim().to_ascii_lowercase())
                        .as_deref(),
                    Some("1" | "true" | "yes" | "on")
                ),
            ),
            spam_flood: StdMutex::new(HashMap::new()),
            spam_dup: StdMutex::new(HashMap::new()),
            #[cfg(target_os = "linux")]
            voice: build_voice_media(),
            #[cfg(target_os = "linux")]
            voice_calls: StdMutex::new(HashMap::new()),
        })
    }

    pub fn identity(&self) -> &Identity {
        &self.identity
    }

    /// Acesso ao repositório para as FACHADAS acima.
    ///
    /// Existe para que o resto do crate (e os testes de integração) leia pelo
    /// mesmo caminho que a escrita — não para expor storage cru. As operações
    /// que decidem permissão (`social_*`) continuam todas no motor: quem chama
    /// isto ainda tem de passar por elas para mudar alguma coisa.
    pub fn store_ref(&self) -> &Store {
        &self.store
    }

    /// Cópia do par de chaves do usuário local.
    ///
    /// Existe para o caminho de ENTRADA: assinar um envelope com a identidade
    /// local é a operação de escrita mais básica da API pública (abrir DM,
    /// mandar mensagem). Sem isto, todo chamador teria de chegar ao par de
    /// outro jeito, e a maioria acabaria usando a chave de outro peer —
    /// o que produziria mensagens com assinatura inválida em vez de um erro
    /// claro. Nunca sai do processo.
    pub fn keypair(&self) -> Keypair {
        (*self.keypair).clone()
    }

    /// Segredo da identidade em RAM (só existe com o app desbloqueado).
    /// Uso restrito: export do cofre portátil e backups automáticos — o
    /// chamador (camada Tauri) nunca expõe isto à WebView nem a logs.
    pub fn secret_hex(&self) -> String {
        self.keypair.secret_hex()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<EngineEvent> {
        self.events.subscribe()
    }

    pub fn listen_port(&self) -> u16 {
        self.listen_port.load(Ordering::Relaxed)
    }

    /// Porta EXTERNA confirmada para anunciar na DHT BitTorrent.
    /// Ordem: `public_addr` (cache STUN/UPnP do tick de announce) → porta
    /// externa mapeada (UPnP/NAT-PMP). `None` = sem endpoint externo conhecido
    /// → NÃO anuncie (anunciar a TCP interna gera dials mortos e polui a DHT).
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

    /// Inicia listener TCP + discovery + loops. Idempotente por instância.
    pub fn start(self: &Arc<Self>) -> Result<()> {
        self.start_with_discovery(true)
    }

    /// Modo solo (sem discovery LAN) — usado por testes e por hosts com peers
    /// configurados manualmente.
    pub fn start_with_discovery(self: &Arc<Self>, discovery: bool) -> Result<()> {
        {
            let mut s = self.started.lock().unwrap_or_else(|e| e.into_inner());
            if *s {
                return Err(ForgeError::AlreadyStarted);
            }
            *s = true;
        }
        let engine = self.clone();
        let handle = tokio::spawn(async move {
            // command_loop precisa de runtime — vive dentro desta task
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

    /// Encerra o engine limpamente: aborta tasks, fecha conexões, libera portas.
    /// Chamado por `restart_engine` e no Drop do AppState.
    pub fn shutdown(&self) {
        self.shutdown.notify_waiters();
        // desconecta todos os peers
        for fp in self.online_peer_fps() {
            self.disconnect_peer(&fp);
        }
        // aborta handles registrados
        let mut hs = self.handles.lock().unwrap_or_else(|e| e.into_inner());
        for h in hs.drain(..) {
            h.abort();
        }
        *self.started.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }

    // ---------- API pública (Tauri / Host / CLI) ----------

    /// Modo de privacidade persistido e lido PELO MOTOR em cada conexão
    /// (normal | encrypted | proxy | full). API pública — o app e o host usam.
    pub fn privacy_set_mode(&self, mode: &str) -> Result<()> {
        match mode {
            "normal" | "encrypted" | "proxy" | "full" => {
                self.store.kv_set("privacy.mode", mode)?;
                // Relay acompanha o modo: em proxy/full as pernas MQTT passam
                // a sair por túneis SOCKS5 (Tor/proxy) para continuar
                // funcionando sem abrir porta e SEM vazar o IP; voltando a
                // normal/encrypted, restaura as rotas públicas diretas.
                self.refresh_relay_for_privacy();
                // Reavalia o intermediário peer-relay: em proxy/full (ou sob
                // kill-switch) a seleção cai para None na hora.
                self.refresh_peer_relay();
                Ok(())
            }
            _ => Err(ForgeError::Protocol(format!(
                "modo de privacidade inválido: {mode}"
            ))),
        }
    }

    pub fn privacy_mode(&self) -> String {
        self.store
            .kv_get("privacy.mode")
            .unwrap_or_else(|| "encrypted".to_string())
    }

    /// Endereço SOCKS5 `host:porta` usado no modo anônimo atual, ou `None`
    /// quando o tráfego é direto. `full` (Tor) usa `FORGE_TOR_ADDR` (9050);
    /// `proxy` usa o endereço salvo pelo usuário (`privacy.proxy_addr`) ou
    /// `FORGE_PROXY_ADDR` (1080). É a ÚNICA fonte dessa decisão — relay
    /// (`refresh_relay_for_privacy`) e diagnóstico (`relay_diagnostics`)
    /// leem daqui para nunca divergirem (ex.: um vazar IP e o outro não).
    pub fn anonymity_proxy(&self) -> Option<String> {
        match self.privacy_mode().as_str() {
            "full" => Some(
                std::env::var("FORGE_TOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9050".to_string()),
            ),
            "proxy" => {
                // 1) endereço digitado pelo usuário na UI (privacidade → proxy)
                if let Some(addr) = self.store.kv_get("privacy.proxy_addr") {
                    if !addr.trim().is_empty() {
                        return Some(addr);
                    }
                }
                // 2) env (self-host/CI); 3) default local
                Some(
                    std::env::var("FORGE_PROXY_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:1080".to_string()),
                )
            }
            _ => None,
        }
    }

    /// Salva o endereço do proxy SOCKS5 digitado pelo usuário e aplica na
    /// hora (se já estiver em modo proxy, o relay re-rotas os túneis; se
    /// não, fica guardado para quando ativar). Formato `host:porta`.
    pub fn set_proxy_addr(&self, addr: &str) -> Result<()> {
        let addr = addr.trim();
        if addr.is_empty() {
            self.store.kv_delete("privacy.proxy_addr")?;
        } else {
            // valida ANTES de persistir — sem porta/env tudo vira "inválido"
            let _ = crate::net::socks5::split_host_port(addr)?;
            self.store.kv_set("privacy.proxy_addr", addr)?;
        }
        // em modo proxy o backend troca de túnel AGORA (mesma semântica do
        // privacy_set_mode — nunca exige reboot para valer).
        self.refresh_relay_for_privacy();
        Ok(())
    }

    /// Existe um SOCKS5 configurado? `FORGE_PROXY_ADDR` não-vazio OU um
    /// endereço persistido pelo usuário em `privacy.proxy_addr`. Fail-closed:
    /// ausência = sem proxy (não inventa o 127.0.0.1:1080 do caminho de fallback).
    fn proxy_configured(&self) -> bool {
        if let Ok(v) = std::env::var("FORGE_PROXY_ADDR") {
            if !v.trim().is_empty() {
                return true;
            }
        }
        self.store
            .kv_get("privacy.proxy_addr")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    }

    /// Registra uma falha de estabelecimento (direto ou relay) para o peer.
    /// A 1ª falha marca o início da janela `AUTO_PROXY_STALL_MS`.
    fn record_dial_failure(&self, peer_fp: &str) {
        if peer_fp.is_empty() {
            return;
        }
        let now = crate::identity::now_ms();
        let mut map = self.dial_failures.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 4096 {
            map.clear(); // poda defensiva (churn de peers)
        }
        let e = map.entry(peer_fp.to_string()).or_insert((0, now));
        e.0 = e.0.saturating_add(1);
        if e.0 == 1 {
            e.1 = now;
        }
    }

    /// Sessão online com o peer: zera o contador de falhas (corrente recomposta).
    fn reset_dial_failures(&self, peer_fp: &str) {
        self.dial_failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_fp);
    }

    /// Registra uma falha de estabelecimento e tenta o degrau 3 (proxy).
    /// Público para testes de integração; os laços de dial usam este caminho.
    pub fn note_dial_failure(&self, peer_fp: &str) {
        self.record_dial_failure(peer_fp);
        // Com o relay por peer disponivel, `maybe_auto_fallback_proxy` retorna
        // cedo (o degrau 2 ja cobre). Mas a COBERTURA do relay e lenta
        // (Handshake por MQTT): sem este nudge, o laco de dial direto insistia
        // numa rota que nunca vai existir (NAT simetrico dos dois lados) — 20+
        // timeouts por peer, gastando CPU e deixando a UI presa em
        // "CONECTANDO" para sempre. Aqui, passado o limiar, pedimos relay/tunel
        // NA HORA e o diagnostico para de dizer "conectando".
        if self.direct_unreachable(peer_fp) {
            self.request_peer_path(peer_fp);
        }
        self.maybe_auto_fallback_proxy(peer_fp);
    }

    /// O peer ja falhou tantas vezes na rota direta que insistir e desperdicio?
    ///
    /// Antes nao existia limite: o laco de redial repetia indefinidamente e o
    /// relatorio mostrava "CONNECTING (23 tentativas)" para sempre, sem acao.
    /// Agora, passado o limiar, o motor para de insistir no direto e espera a
    /// rota alternativa (relay/tunel) — o caminho real atras de CGNAT.
    pub fn direct_unreachable(&self, peer_fp: &str) -> bool {
        let (count, first_ms) = {
            let map = self
                .dial_failures
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.get(peer_fp).copied().unwrap_or((0, 0))
        };
        if count < DIRECT_UNREACHABLE_THRESHOLD {
            return false;
        }
        let now = crate::identity::now_ms();
        // Contagem sozinha nao basta: peer que ja esteve online e caiu pode ser
        // problema passageiro. Exige tambem tempo sem sucesso.
        first_ms > 0 && now.saturating_sub(first_ms) >= DIRECT_UNREACHABLE_STALL_MS
    }

    /// Pede a rota alternativa (relay por peer + tunel virtual) para o peer.
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

    // ── Diagnóstico por peer/rede (por que 0 peers — nunca mudo) ──────────────

    /// Atualiza o diagnóstico de um peer com mutação atômica (fn fecha o lock).
    fn diag_update(&self, fp: &str, f: impl FnOnce(&mut PeerDiagInfo)) {
        let mut map = self.peer_diag.lock().unwrap_or_else(|e| e.into_inner());
        let now = crate::identity::now_ms();
        let entry = map.entry(fp.to_string()).or_default();
        f(entry);
        entry.last_seen_ms = now;
        // Bound LRU: mantém só os 512 tocados mais recentemente.
        if map.len() > 512 {
            let mut recent: Vec<(String, i64)> = map
                .iter()
                .map(|(k, v)| (k.clone(), v.last_seen_ms))
                .collect();
            // Desempate determinístico por fp (mesmo ms → inserção posterior
            // tem fp maior nos testes e, em produção, qualquer ordem total basta).
            recent.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
            let keep: std::collections::HashSet<String> =
                recent.into_iter().take(512).map(|(k, _)| k).collect();
            map.retain(|k, _| keep.contains(k));
        }
    }

    /// Snapshot do diagnóstico do peer (para a UI/relatório de suporte).
    pub fn peer_diag(&self, fp: &str) -> PeerDiagInfo {
        self.peer_diag
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .cloned()
            .unwrap_or_default()
    }

    /// Snapshot do diagnóstico global (STUN/announce).
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

    /// Atualiza o diagnóstico de rede global (STUN/announce/DHT) — mutação sob lock.
    pub fn diag_record_net(&self, f: impl FnOnce(&mut NetDiagInfo)) {
        let mut d = self.net_diag.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut d);
    }

    // ── DHT mainline BitTorrent (descoberta descentralizada) ─────────────────

    /// Garante um nó DHT mainline vivo (bind UDP + bootstrap público).
    /// Idempotente; erro = sem UDP/bootstrap (rede bloqueada) — loga só.
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
                Err(ForgeError::Protocol(format!("dht node: {e}")))
            }
        }
    }

    /// Derruba o nó DHT (modo proxy/Tor: UDP vazaria o IP).
    pub fn shutdown_bit_dht(&self) {
        let mut guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dht) = guard.take() {
            let _ = Arc::try_unwrap(dht).map(|mut d| d.shutdown());
        }
    }

    /// Anuncia o próprio endpoint no infohash da identidade (bloqueante —
    /// chamar via spawn_blocking). `port` DEVE ser a externa confirmada
    /// (`dht_announce_port()`); nunca a TCP interna efêmera.
    pub fn bit_dht_announce(&self, infohash: mainline::Id, port: u16) -> Result<()> {
        let guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        let dht = guard
            .as_ref()
            .ok_or_else(|| ForgeError::Protocol("dht não iniciada".into()))?;
        dht.announce_peer(infohash, Some(port))
            .map(|_| ())
            .map_err(|e| ForgeError::Protocol(format!("announce_peer: {e}")))
    }

    /// `get_peers` no infohash do amigo e dial direto nos endereços achados
    /// (bloqueante — chamar via spawn_blocking). bounded: no máx. 8 addrs.
    /// Devolve quantos endpoints a DHT entregou (rendezvous BitTorrent).
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
                // motivo técnico honesto: DHT viva mas sem peers p/ esse hash
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

    /// Enfileira um lookup DHT urgente (chamado por friend_request/maintain).
    pub fn dht_probe(&self, peer_fp: &str) {
        if !crate::net::dht::bit_dht_enabled() {
            return;
        }
        let mut q = self.dht_queue.lock().unwrap_or_else(|e| e.into_inner());
        if q.len() < 64 {
            q.push(peer_fp.to_string());
        }
    }

    /// Pop da fila urgente (sem repetir fp).
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

    /// Rate-limit: pode fazer lookup DHT deste peer agora? (min_ms desde o último)
    pub fn dht_lookup_due(&self, peer_fp: &str, min_ms: i64) -> bool {
        let map = self.dht_lookups.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(peer_fp) {
            Some(t) => crate::identity::now_ms().saturating_sub(*t) >= min_ms,
            None => true,
        }
    }

    /// Amigos (aceitos ou pendentes de saída) SEM sessão online — alvo do
    /// rodízio de lookups DHT.
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

    /// Corrente de fallback automática — degrau 3. Chamado pelos laços de dial
    /// quando o direto falha e não há intermediário peer-relay disponível:
    /// se houver SOCKS5 configurado, liga o modo de privacidade `proxy`
    /// (relay/diagnóstico passam a rotear pelo SOCKS5) e avisa a UI.
    ///
    /// Anti-flapping: só troca uma vez por peer dentro de `AUTO_PROXY_COOLDOWN_MS`;
    /// NUNCA sai de `full` (Tor) e NUNCA reverte sozinho — o usuário troca o
    /// modo manualmente. Não segura guard algum ao chamar `privacy_set_mode`.
    pub fn maybe_auto_fallback_proxy(&self, peer_fp: &str) {
        // Degrau 2 (intermediário por peer) ainda disponível? Não pula p/ proxy.
        if self.peer_relay_fp().is_some() {
            return;
        }
        let now = crate::identity::now_ms();
        // Snapshot sob lock — solta ANTES de reconfigurar o relay.
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
        // Marca ANTES de trocar: se `privacy_set_mode` falhar, não reentra em loop.
        self.auto_proxy_switched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(peer_fp.to_string(), now);
        let reason = format!(
            "sem conexão direta nem intermediário após {failures} falhas — roteando por SOCKS5"
        );
        match self.privacy_set_mode("proxy") {
            Ok(()) => {
                // Flag lida pela UI (já observa `privacy.mode` + eventos).
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

    /// Diagnóstico das pernas do relay respeitando o modo de privacidade:
    /// em `proxy`/`full` o probe também passa pelo SOCKS5 — ver o IP real nos
    /// hosts públicos seria justamente o vazamento que o modo evita.
    pub async fn relay_diagnostics(&self) -> Vec<crate::net::relay::RelayLegStatus> {
        let proxy = self.anonymity_proxy();
        crate::net::relay::check_relay_legs_via(proxy.as_deref()).await
    }

    /// Conecta a "host:porta" — aceita IP, domínio DNS e .onion (Tor).
    /// Em modo proxy/Tor o hostname vai ao SOCKS5 SEM resolução local
    /// (a rede resolve — nada de DNS que vaza o alvo).
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

    /// Injeta backend de relay (testes usam MemRelay compartilhado).
    /// Marca como custom: o engine não o sobrescreve ao trocar de privacidade.
    pub fn set_relay_backend(&self, backend: Arc<dyn RelayBackend>) {
        *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) = backend;
        self.relay_backend_custom.store(true, Ordering::Relaxed);
        self.relay_proxied.store(false, Ordering::Relaxed);
        // Injetar um backend implica QUERER relay (testes/host): reabilita.
        self.relay_disabled.store(false, Ordering::Relaxed);
    }

    /// Kill-switch do relay: com `true`, `relay_allowed()` retorna false e
    /// nenhum post/poll de relay é feito — só a DIRETA (TCP/hole punch/LAN)
    /// transporta dados. Com `false`, volta ao normal. Um backend injetado
    /// por teste (`set_relay_backend`) NÃO desliga por si só: só desliga
    /// quando esta flag é setada (default já lê `FORGE_NO_RELAY`).
    pub fn set_relay_disabled(&self, disabled: bool) {
        self.relay_disabled.store(disabled, Ordering::Relaxed);
        // O kill-switch explícito derruba TAMBÉM o peer-relay (transporte p2p).
        self.peer_relay_disabled.store(disabled, Ordering::Relaxed);
        // Reavalia a seleção do intermediário imediatamente (dropa/religa).
        self.refresh_peer_relay();
        debug!(disabled, "relay: kill-switch atualizado");
    }

    /// Relay está desligado por flag/env? (não considera modo de privacidade).
    pub fn relay_is_disabled(&self) -> bool {
        self.relay_disabled.load(Ordering::Relaxed)
    }

    /// Hole punching (furo TCP coordenado) está ligado? Default sim;
    /// `FORGE_PUNCH=0` desliga. A direta outbound/UPnP/LAN segue normal.
    pub fn punch_enabled(&self) -> bool {
        self.punch_enabled.load(Ordering::Relaxed)
    }

    /// Liga/desliga o furo em runtime (diagnóstico; espelha `FORGE_PUNCH`).
    pub fn set_punch_enabled(&self, on: bool) {
        self.punch_enabled.store(on, Ordering::Relaxed);
        debug!(on, "hole punch: kill-flag atualizado");
    }

    /// (Re)seleciona o backend de relay conforme o modo de privacidade.
    /// - normal/encrypted → rotas públicas diretas (4 brokers MQTT), menor latência;
    /// - proxy/full → os MESMOS brokers MQTT, cada um pelo PRÓPRIO túnel
    ///   SOCKS5 (`SocksTunnel`, hostname resolvido PELO proxy — sem DNS
    ///   local). Nada sai direto: o broker só vê o IP do proxy/Tor.
    ///
    /// Fail-closed: se o proxy não puder ser configurado, `relay_proxied=false`
    /// e `relay_allowed` desliga o relay nesses modos (nunca vaza).
    /// Backend injetado por teste (`relay_backend_custom`) nunca é sobrescrito.
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
            *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) =
                Arc::new(MultiRelay::default_routes_with_fp(
                    &self.identity.fingerprint,
                ));
            self.relay_proxied.store(false, Ordering::Relaxed);
            debug!("relay: modo normal/encrypted — rotas públicas diretas restauradas");
        }
    }

    /// Fixa endpoint público (testes; produção preenche via tick de announce).
    /// É o endereço que vai no Punch para o peer furar até aqui.
    pub fn set_public_addr(&self, addr: String) {
        *self.public_addr.lock().unwrap_or_else(|e| e.into_inner()) = Some(addr);
    }

    /// true se a sessão online com este peer roda sobre o relay.
    pub fn is_peer_via_relay(&self, fp: &str) -> bool {
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| l.via_relay && l.get_state() == PeerLinkState::Online)
            .unwrap_or(false)
    }

    /// Contadores do plano de dados do relay (`distorrent_r_*`): `(posts, poll_hits)`.
    /// `posts` = nº de `post()` no tópico de relay; `poll_hits` = nº de `poll()`
    /// com dados (poll vazio do manager idle não conta; anúncio `distorrent_a_*`
    /// não conta — ver `RelayStats`). Agrega todas as pernas (MultiRelay soma).
    pub fn relay_stats(&self) -> (u64, u64) {
        let backend = self
            .relay_backend
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let s = backend.stats();
        (s.posts, s.poll_hits)
    }

    /// Fingerprint do intermediário peer-relay selecionado (diagnóstico/UI
    /// NÃO usa; serve para logs/testes).
    pub fn peer_relay_fp(&self) -> Option<String> {
        self.peer_relay
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Pode ATUAR como intermediário agora? Não depende do relay público.
    /// normal/encrypted → sim; proxy/full → não (o intermediário veria o IP
    /// real de quem o contacta). Kill-switch (`set_relay_disabled`/env
    /// `FORGE_NO_RELAY`) e backend injetado (testes/host) desligam.
    pub fn peer_relay_serving_enabled(&self) -> bool {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return false;
        }
        // (F7) Exige opt-in explícito (FORGE_RELAY/FORGE_PEER_RELAY).
        if !self.peer_relay_optin.load(Ordering::Relaxed) {
            return false;
        }
        if self.peer_relay_disabled.load(Ordering::Relaxed) {
            return false;
        }
        peer_relay_policy(&self.privacy_mode()).1
    }

    /// Peer-relay pode ser USADO como cliente agora? Exige modo normal/encrypted
    /// (em proxy/full o intermediário veria o IP de quem o contacta) e backend
    /// NÃO-injetado (testes preservam o backend custom). Kill-switch desliga.
    pub fn peer_relay_enabled(&self) -> bool {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return false;
        }
        // (F7) Exige opt-in explícito (FORGE_RELAY/FORGE_PEER_RELAY).
        if !self.peer_relay_optin.load(Ordering::Relaxed) {
            return false;
        }
        if self.peer_relay_disabled.load(Ordering::Relaxed) {
            return false;
        }
        peer_relay_policy(&self.privacy_mode()).0
    }

    /// (F7) Peer-relay está com opt-in? (independe de modo/backend).
    pub fn peer_relay_optin_enabled(&self) -> bool {
        self.peer_relay_optin.load(Ordering::Relaxed)
    }

    /// (F7) Liga/desliga o opt-in do peer-relay em runtime (host/testes) e
    /// reelege o intermediário. Não afeta o relay público.
    pub fn set_peer_relay_enabled(&self, on: bool) {
        self.peer_relay_optin.store(on, Ordering::Relaxed);
        // Desliga o kill-switch próprio só se estamos LIGANDO o opt-in; ao
        // desligar o opt-in a eleição já cai para None.
        if on {
            self.peer_relay_disabled.store(false, Ordering::Relaxed);
        }
        self.refresh_peer_relay();
        debug!(on, "peer-relay: opt-in atualizado");
    }

    /// Reescolhe UM peer ONLINE conectado DIRETO (não via relay) como
    /// intermediário. Determinístico (menor fp) p/ dois peers tenderem ao
    /// mesmo intermediário. Só mexe no campo `peer_relay` — nunca em amigos,
    /// listas de UI ou eventos.
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
            // (F4) Exclui peers bloqueados (consulta ao store FORA do lock de
            // `links`) e mantém só diretos online (já filtrado acima).
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

    /// Backend peer-relay ESTÁVEL para o intermediário `relay_fp` (recria só
    /// quando o intermediário muda; preserva os oneshots pendentes no caso
    /// comum).
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

    /// Envia frame diretamente via link online (usado por PEX/DHT).
    /// Preferência de caminho (Fase 2/3): direta TCP crua > túnel > sessão
    /// relay crua. O túnel viaja DENTRO da sessão atual — sobre direta não
    /// adiciona nada (mesmo socket, cripto dupla), então só tuneliza quando o
    /// peer está via relay: o relay cru carrega pacotes, o túnel carrega
    /// SESSÃO (replay/reordenação por peer, não por perna).
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
            // caiu aqui = frame grande demais ou sem sessão: caminho normal.
        }
        self.cmd_tx.send(EngineCmd::SendToPeer(peer_fp, frame)).ok();
    }

    /// Deve este frame ir PELO túnel? Sessão de túnel pronta + peer só
    /// alcançável via relay (direta crua continua direta).
    fn tunnel_should_carry(&self, peer_fp: &str) -> bool {
        if !self.tunnel_enabled() || !self.tunnel_established(peer_fp) {
            return false;
        }
        self.peer_state(peer_fp) == NetworkState::Connected
            && self.is_peer_via_relay(peer_fp)
    }

    /// Serializa → fragmenta → cifra → emite como TunnelData (via sessão
    /// atual, por `send_to_peer` recursivo no 1º nível). Devolve false se o
    /// frame excede o teto (emissor usa o caminho normal).
    fn tunnel_send_frame(&self, peer_fp: &str, frame: &SecureFrame) -> bool {
        let json = match serde_json::to_vec(frame) {
            Ok(v) if v.len() <= TUN_FRAME_MAX => v,
            _ => return false,
        };
        static FRAG_ID: std::sync::atomic::AtomicU32 =
            std::sync::atomic::AtomicU32::new(1);
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

    /// Rekey oportunista (Fase 4): volume ou idade estourados → novo handshake
    /// (substitui a sessão; pacotes in-flight com a chave velha morrem e as
    /// camadas acima retentam por ACK). Limites honestos, sem surpresa.
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

    /// Força novo handshake do túnel (rekey manual/teste). Sessão velha sai,
    /// oferta nova entra — o peer responde e tudo segue sem redial TCP.
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

    // ---------- túnel virtual (LAN estilo Radmin) ----------
    /// Túnel ligado? Kill-flag `FORGE_NO_TUNNEL=1` desliga.
    pub fn tunnel_enabled(&self) -> bool {
        !self.tunnel_disabled.load(Ordering::Relaxed)
    }

    /// proto_v conhecido do peer (0 = nunca vimos handshake).
    pub fn peer_proto_v(&self, fp: &str) -> u32 {
        self.peer_protos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .copied()
            .unwrap_or(0)
    }

    /// Sessão de túnel estabelecida com o peer?
    pub fn tunnel_established(&self, fp: &str) -> bool {
        self.tunnel_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(fp)
    }

    /// IP virtual determinístico do fp (sempre calculável, sem rede).
    pub fn tunnel_virtual_ip(fp: &str) -> String {
        virtual_ipv6(fp).to_string()
    }

    /// Pede túnel ao peer: oferta X25519 efêmera assinada via sessão atual.
    /// Idempotente (já tem sessão/oferta pendente recente = não reenvia).
    /// Só para peers com `proto_v >= 2` — legado derrubaria a sessão.
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
        // Assina transcript COM placeholder zeros no lado do peer (ele ainda
        // não tem efêmera/nonce nossos conhecidos? NÃO — ele tem: a oferta
        // carrega nossa efêmera+nonce; o transcript da oferta usa zeros no
        // lado respondente porque a resposta ainda não existe).
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

    /// Ping pelo túnel (prova ponta a ponta cifrada). Devolve o id.
    pub fn tunnel_ping(&self, peer_fp: &str) -> Result<u64> {
        static PING_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = PING_ID.fetch_add(1, Ordering::SeqCst);
        let msg = format!("ping:{id}");
        let sealed = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let sess = map.get(peer_fp).ok_or_else(|| {
                ForgeError::Protocol("tunel: sem sessão com o peer".into())
            })?;
            sess.seal(
                &self.identity.fingerprint,
                peer_fp,
                &encode_full(msg.as_bytes()),
            )?
        };
        let (nonce, ct) = sealed;
        {
            let mut p = self
                .tunnel_pings
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if p.len() > 256 {
                p.clear();
            }
            p.insert(
                (peer_fp.to_string(), id),
                crate::identity::now_ms(),
            );
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
        info!(peer_fp, "tunel: sessão ESTABELECIDA (via relay; UDP direto na Fase 2)");
    }

    /// Apelido conhecido do peer (para dispatch de frames vindos pelo túnel):
    /// peers do handshake (upsert com nickname real), senão prefixo do fp.
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

    /// PEX: lista de peers conhecidos para gossip (filtra self e sem addr)
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

    /// Peers ONLINE que são AMIGOS ACEITOS. PEX só gossipa endereços para
    /// amigos — nunca vaza a lista de peers para um conectado aleatório.
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
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| match l.get_state() {
                PeerLinkState::Online => NetworkState::Connected,
                PeerLinkState::Connecting => NetworkState::Connecting,
                PeerLinkState::Reconnecting => NetworkState::Reconnecting,
            })
            .unwrap_or(NetworkState::Disconnected)
    }

    pub fn aggregated_state(&self) -> NetworkState {
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        let any = |s: PeerLinkState| links.values().any(|l| l.get_state() == s);
        if any(PeerLinkState::Online) {
            NetworkState::Connected
        } else if any(PeerLinkState::Reconnecting) {
            NetworkState::Reconnecting
        } else if any(PeerLinkState::Connecting) {
            NetworkState::Connecting
        } else {
            NetworkState::Disconnected
        }
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

    pub fn conversations(&self) -> Vec<Conversation> {
        self.store.list_conversations().unwrap_or_default()
    }

    pub fn messages(&self, conv_id: &str) -> Vec<StoredMessage> {
        self.store.list_messages(conv_id, 500).unwrap_or_default()
    }

    /// Janela de mensagens (paginação por ts) — o caminho da UI.
    /// `before_ts = None` devolve as `limit` mais recentes.
    pub fn messages_window(
        &self,
        conv_id: &str,
        before_ts: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredMessage>> {
        self.store.list_messages_window(conv_id, before_ts, limit)
    }

    /// RTT estimado (EMA, ms) do peer — None se ainda sem amostra.
    pub fn peer_rtt_ms(&self, fp: &str) -> Option<u64> {
        crate::metrics::metrics().rtt_of(fp)
    }

    /// Abre (ou recupera) a DM com um peer. Determinística por fingerprint.
    pub fn open_dm(&self, peer_fp: &str, peer_nick: &str) -> Result<Conversation> {
        if peer_fp == self.identity.fingerprint {
            return Err(ForgeError::Protocol(
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

    /// Envia mensagem real: assina, persiste (SENDING/PENDING), transmite ou enfileira.
    /// Em grupos: best-effort para todos os membros online (sem outbox por peer —
    /// o flush de grupo cuida das pendências na reconexão).
    pub fn send_dm(&self, conv_id: &str, body: &str) -> Result<StoredMessage> {
        let body = body.trim();
        if body.is_empty() {
            return Err(ForgeError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(ForgeError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| ForgeError::Protocol("conversa inexistente".into()))?;
        let env = MessageEnvelope::new(&self.keypair, conv_id, body);
        match conv.kind.as_str() {
            "dm" => {
                self.store.insert_message(&env, "out", "sending")?;
                crate::metrics::metrics().message_out();
                // Só entrega de verdade para AMIGO ACEITO: o receptor rejeita DM
                // de quem ainda não aceitou (anti-spam). Sem esta checagem a msg
                // ficava "sent" no remetente mas era descartada no destino — o
                // usuário via "enviado" e nada chegava até aceitar.
                let is_friend = self
                    .store
                    .get_friend(&conv.peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false);
                let online = self.link_tx(&conv.peer_fp).is_some();
                if online && is_friend {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            conv.peer_fp.clone(),
                            SecureFrame::Msg(env.clone()),
                        ))
                        .map_err(|_| ForgeError::PeerNotConnected(conv.peer_fp.clone()))?;
                    self.store.set_message_status(&env.id, "sent")?;
                    let _ = self.events.send(EngineEvent::MessageStatus {
                        msg_id: env.id.clone(),
                        status: "sent".into(),
                    });
                } else {
                    // Offline OU amizade ainda não aceita → fica PENDING e sai
                    // sozinha ao aceitar/conectar (FlushOutbox no aceite).
                    self.store.enqueue_outbox(&env.id, &conv.peer_fp)?;
                    self.store.set_message_status(&env.id, "pending")?;
                    let _ = self.events.send(EngineEvent::MessageStatus {
                        msg_id: env.id.clone(),
                        status: "pending".into(),
                    });
                    if !online {
                        self.cmd_tx
                            .send(EngineCmd::ConnectRelay(conv.peer_fp.clone()))
                            .ok();
                    }
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
                            .send(EngineCmd::SendToPeer(fp, SecureFrame::Msg(env.clone())))
                            .ok();
                        sent_any = true;
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
                return Err(ForgeError::Protocol(format!(
                    "tipo de conversa desconhecido: {other}"
                )))
            }
        }
        self.store
            .message_by_id(&env.id)?
            .ok_or_else(|| ForgeError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    // ---------------- servidor: canais, cargos e bots (v4) ----------------

    /// Hex aleatório de n bytes — sufixo curto de ids de canal/cargo/bot.
    fn rand_hex(n: usize) -> String {
        use rand::RngCore;
        let mut buf = vec![0u8; n];
        rand::thread_rng().fill_bytes(&mut buf);
        hex::encode(buf)
    }

    /// Normaliza nome de canal igual Discord: minúsculas e espaços → '-'.
    fn normalize_channel_name(name: &str) -> String {
        name.trim().to_lowercase().replace(' ', "-")
    }

    /// Gate de dono: comm.2 == meu fingerprint, senão erro.
    fn require_owner(&self, community_id: &str) -> Result<()> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != self.identity.fingerprint {
            return Err(ForgeError::Protocol(
                "apenas o dono pode alterar o servidor".into(),
            ));
        }
        Ok(())
    }

    /// Gate anti-spam de ENTRADA — chamar SEMPRE DEPOIS da verificação de
    /// assinatura (autenticidade primeiro, spam depois). Flood (10 msgs/10s),
    /// duplicada (60s) e link malicioso derrubam SÓ a mensagem (`Err`) — a
    /// sessão é preservada (o chamador apenas loga). Reputação do peer cai.
    fn spam_gate(&self, peer_fp: &str, body: &str) -> Result<()> {
        let now = crate::identity::now_ms();
        // 1. flood: 10 msgs por janela de 10s
        {
            let mut flood = self.spam_flood.lock().unwrap_or_else(|e| e.into_inner());
            let e = flood.entry(peer_fp.to_string()).or_insert((0, now));
            if now - e.1 > 10_000 {
                *e = (0, now);
            }
            e.0 += 1;
            if e.0 > 10 {
                drop(flood);
                let _ = self.store.bump_reputation(peer_fp, -5, false);
                crate::metrics::metrics().spam_rejected();
                return Err(ForgeError::Protocol(
                    "flood detectado: mensagem descartada (limite 10/10s)".into(),
                ));
            }
        }
        // 2. duplicada: mesmo conteúdo em <60s
        {
            let h = crate::antispam::DuplicateDetector::content_hash(peer_fp, body);
            let mut dup = self.spam_dup.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((last_h, last_ts)) = dup.get(peer_fp) {
                if *last_h == h && now - *last_ts < 60_000 {
                    drop(dup);
                    let _ = self.store.bump_reputation(peer_fp, -2, false);
                    crate::metrics::metrics().spam_rejected();
                    return Err(ForgeError::Protocol(
                        "mensagem repetida descartada (janela 60s)".into(),
                    ));
                }
            }
            dup.insert(peer_fp.to_string(), (h, now));
        }
        // 3. link malicioso (encurtador só avisa — passa)
        if let crate::antispam::LinkVerdict::Malicious(d) = crate::antispam::check_links(body, &[])
        {
            let _ = d;
            let _ = self.store.bump_reputation(peer_fp, -8, false);
            return Err(ForgeError::Protocol("link malicioso bloqueado".into()));
        }
        Ok(())
    }

    /// Regras do servidor (canal) — chamar no HOST após assinatura+spam_gate.
    /// Shadow-ban e palavras/dominios do servidor derrubam só a mensagem.
    fn server_rules_gate(&self, community_id: &str, author_fp: &str, body: &str) -> Result<()> {
        let rules = self.store.get_server_rules(community_id)?;
        if rules.is_shadow_banned(author_fp) {
            return Err(ForgeError::Protocol(
                "mensagem removida pela moderação".into(),
            ));
        }
        if let Some(reason) = crate::moderation::check_text_against_rules(body, &rules) {
            let _ = self.store.bump_reputation(author_fp, -3, false);
            return Err(ForgeError::Protocol(reason));
        }
        Ok(())
    }

    /// Valida nome de servidor/canal no CORE (a UI valida antes p/ UX, mas o
    /// core re-valida — nunca confia na UI). `existing` = nomes do escopo.
    fn validate_name_gate(
        kind: crate::names::NameKind,
        raw: &str,
        existing: &[String],
    ) -> Result<String> {
        let policy = crate::names::NamePolicy::for_kind(kind);
        let check = crate::names::validate_name(kind, raw, existing, &policy);
        if check.ok {
            return Ok(check.normalized);
        }
        Err(ForgeError::Protocol(format!(
            "nome inválido: {}",
            check.errors.first().cloned().unwrap_or_default()
        )))
    }

    /// Estado oficial da comunidade como frame — usado no join e no broadcast.
    /// v6: `for_fp` define o DESTINATÁRIO — quem não é o dono recebe o TOKEN
    /// DOS BOTS MASCARADO (token é credential do dono; antes vazava no sync
    /// para todos os membros). O dono recebe o token real.
    pub fn community_state_payload(
        &self,
        community_id: &str,
        for_fp: Option<&str>,
    ) -> Result<SecureFrame> {
        let (id, name, owner_fp) = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
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
                b.token = String::new(); // MASCARADO — não viaja para membros
            }
        }
        let (description, category, icon) = self.store.community_meta(&id).unwrap_or_default();
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
        })
    }

    /// Envia o estado oficial a TODOS os membros online (o host não envia a si).
    /// v6: payload POR MEMBRO — dono recebe tokens reais, membros mascarados.
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
                    debug!("broadcast do estado falhou para {community_id}: {e}");
                    return;
                }
            };
            if self.link_tx(&fp).is_some() {
                self.cmd_tx.send(EngineCmd::SendToPeer(fp, frame)).ok();
            }
        }
    }

    // ---------- canais ----------

    pub fn channel_create(
        &self,
        community_id: &str,
        name: &str,
        topic: &str,
        category: &str,
        kind: &str,
    ) -> Result<ChannelMetaRow> {
        self.require_owner(community_id)?;
        // validação anti-spoof/anti-injeção no CORE (normaliza p/ minúsculas-hífen)
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
            return Err(ForgeError::Protocol(
                "nome do canal não pode ser vazio".into(),
            ));
        }
        let kind = if kind.is_empty() { "text" } else { kind };
        if kind != "text" && kind != "voice" && kind != "video" {
            return Err(ForgeError::Protocol(
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
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    pub fn channel_delete(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.delete_channel(community_id, channel_id)? == 0 {
            return Err(ForgeError::Protocol("canal inexistente".into()));
        }
        // histórico do canal morre junto com ele
        self.store.delete_messages_by_conv(channel_id)?;
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
            return Err(ForgeError::Protocol(
                "nome do canal não pode ser vazio".into(),
            ));
        }
        if self
            .store
            .update_channel(community_id, channel_id, Some(&valid), None, None)?
            == 0
        {
            return Err(ForgeError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

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
            return Err(ForgeError::Protocol("canal inexistente".into()));
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
            return Err(ForgeError::Protocol("categoria não pode ser vazia".into()));
        }
        if self
            .store
            .set_channel_category(community_id, channel_id, category)?
            == 0
        {
            return Err(ForgeError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    /// Leitura — não exige dono.
    pub fn channel_list(&self, community_id: &str) -> Result<Vec<ChannelMetaRow>> {
        self.store.channel_rows(community_id)
    }

    pub fn community_rename(&self, community_id: &str, name: &str) -> Result<()> {
        self.require_owner(community_id)?;
        // gate anti-spoof/anti-injeção (unicidade entre as demais comunidades)
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
            return Err(ForgeError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    // ---------- cargos ----------

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
            return Err(ForgeError::Protocol(
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

    /// Patch de cargo: None não mexe; "" em name/color não mexe.
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
            return Err(ForgeError::Protocol("cargo inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn role_delete(&self, community_id: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if role_id.ends_with("-everyone") {
            return Err(ForgeError::Protocol(
                "@everyone não pode ser apagado".into(),
            ));
        }
        // role_delete no store já limpa assignments e desvincula bots
        if self.store.role_delete(community_id, role_id)? == 0 {
            return Err(ForgeError::Protocol("cargo inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    /// Leitura — não exige dono.
    pub fn roles_list(&self, community_id: &str) -> Result<Vec<RoleRow>> {
        self.store.roles_list(community_id)
    }

    /// Leitura — não exige dono.
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
            return Err(ForgeError::Protocol("cargo inexistente".into()));
        }
        if self
            .store
            .list_members(community_id)?
            .iter()
            .all(|(m, _, _)| m != fp)
        {
            return Err(ForgeError::Protocol("membro inexistente".into()));
        }
        self.store.member_role_assign(community_id, fp, role_id)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn member_unassign_role(&self, community_id: &str, fp: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if !self
            .store
            .roles_list(community_id)?
            .iter()
            .any(|r| r.id == role_id)
        {
            return Err(ForgeError::Protocol("cargo inexistente".into()));
        }
        self.store.member_role_unassign(community_id, fp, role_id)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    /// Expulsa membro: some do roster, perde cargos e recebe CommunityKicked.
    pub fn member_kick(&self, community_id: &str, fp: &str) -> Result<()> {
        self.require_owner(community_id)?;
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if fp == comm.2 {
            return Err(ForgeError::Protocol("o dono não pode ser expulso".into()));
        }
        if self
            .store
            .list_members(community_id)?
            .iter()
            .all(|(m, _, _)| m != fp)
        {
            return Err(ForgeError::Protocol("membro inexistente".into()));
        }
        self.store.remove_member(community_id, fp)?;
        self.store.member_roles_remove_all(community_id, fp)?;
        // avisa o expulso ANTES do broadcast (estado novo não o inclui mais)
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

    // ---------- moderação (Storm camada de segurança) ----------
    //
    // Toda decisão é validada aqui no CORE: dono ou moderador listado ou
    // bit de permissão no cargo. A UI apenas reflete. Ações geram auditoria.

    /// Regras atuais do servidor (leitura liberada p/ membros; default medium).
    pub fn server_rules_get(&self, community_id: &str) -> Result<crate::moderation::ServerRules> {
        self.store.get_server_rules(community_id)
    }

    /// Salva regras — só dono. Nível validado, listas sanitizadas e limitadas.
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

    /// Histórico de auditoria (leitura p/ membros).
    pub fn audit_list(
        &self,
        community_id: &str,
        limit: i64,
    ) -> Result<Vec<crate::moderation::AuditEntry>> {
        self.store.list_audit(community_id, limit)
    }

    /// Reputação de um peer (leitura).
    pub fn reputation_get(&self, fp: &str) -> Result<(String, i32, u32)> {
        self.store.get_reputation(fp)
    }

    /// Safety Number estilo Signal com um peer (requer pubkey no peerbook,
    /// preenchida no handshake autenticado). Ordem-independente: ambas as
    /// partes calculam o mesmo número para comparar por voz/QR.
    pub fn safety_number(&self, peer_fp: &str) -> Result<String> {
        let me = &self.identity;
        let peer = self
            .store
            .get_peer(peer_fp)?
            .ok_or_else(|| ForgeError::Protocol("peer desconhecido".into()))?;
        Ok(crate::names::safety_number(
            &me.fingerprint,
            &me.pubkey_hex,
            peer_fp,
            &peer.pubkey_hex,
        ))
    }

    /// Ação de moderação: ban/unban/mute/unmute/shadow_ban/unshadow/delete_msg.
    /// `target` = fp do alvo (ou id da mensagem em delete_msg).
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
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
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
        // dono não pode ser moderado; ninguém modera a si mesmo
        if target == comm.2 || target == me {
            return Err(ForgeError::Protocol("alvo inválido para moderação".into()));
        }
        let need = match action {
            "ban" | "unban" | "shadow_ban" | "unshadow" => crate::moderation::PERM_BAN,
            "mute" | "unmute" => crate::moderation::PERM_MUTE,
            "delete_msg" => crate::moderation::PERM_DELETE,
            _ => return Err(ForgeError::Protocol("ação inválida".into())),
        };
        if !crate::moderation::can_moderate(is_owner, is_mod, role_perms, need) {
            return Err(ForgeError::Protocol("sem permissão de moderação".into()));
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
                // O mute precisa de um PRAZO. Sem ele a sanção era invisível:
                // a pontuação de reputação caía mas nada a consultava, então o
                // usuário continuava falando (ver `gate_speech_for`).
                let until = match reason.trim().parse::<i64>() {
                    Ok(ms) if ms > crate::identity::now_ms() => ms,
                    _ => crate::identity::now_ms() + MUTE_DEFAULT_MS,
                };
                self.store.mute_set(target, until)?;
                self.store.bump_reputation(target, -15, false)?;
                // Nenhum frame de aviso: um mute não pode mandar `CommunityKicked`
                // (o cliente apagaria a comunidade da lista ao recebê-lo). O
                // alvo descobre o silêncio na hora em que tenta falar, que é
                // quando a informação é útil de verdade.
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
                // apaga se a mensagem for de um canal DESTE servidor
                let msg = self
                    .store
                    .message_by_id_raw(target)?
                    .ok_or_else(|| ForgeError::Protocol("mensagem inexistente".into()))?;
                let owner_cid = self
                    .store
                    .channel_community(&msg.conv_id)?
                    .ok_or_else(|| ForgeError::Protocol("mensagem fora deste servidor".into()))?;
                if owner_cid != community_id {
                    return Err(ForgeError::Protocol("mensagem fora deste servidor".into()));
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

    /// Denunciar usuário: qualquer membro pode. Soma report, derruba score
    /// (-10) e registra auditoria. 3+ reports abertos = suspeito automático.
    pub fn report_user(&self, target_fp: &str, community_id: &str, reason: &str) -> Result<()> {
        if target_fp == self.identity.fingerprint {
            return Err(ForgeError::Protocol(
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
        // auditoria mesmo sem community_id válido (denúncia de DM usa "")
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

    // ---------- bots ----------

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
            return Err(ForgeError::Protocol(
                "nome do bot não pode ser vazio".into(),
            ));
        }
        let role_id = match role_id.map(str::trim) {
            Some("") | None => None,
            Some(r) => Some(r.to_string())
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
            config: String::new(), // v6 (outra sessão): config do runtime web do bot
        };
        self.store.bot_upsert(&row)?;
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    /// Patch de bot (storage::BotPatch): role_id Some(None) ou Some(Some("")) limpa.
    pub fn bot_update(&self, community_id: &str, bot_id: &str, patch: BotPatch) -> Result<()> {
        self.require_owner(community_id)?;
        if !self.store.bot_update_patch(community_id, bot_id, &patch)? {
            return Err(ForgeError::Protocol("bot inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn bot_delete(&self, community_id: &str, bot_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.bot_delete(community_id, bot_id)? == 0 {
            return Err(ForgeError::Protocol("bot inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    /// Leitura — não exige dono.
    pub fn bots_list(&self, community_id: &str) -> Result<Vec<BotRow>> {
        self.store.bots_list(community_id)
    }

    /// v6 — Gera novo token do bot (dono) e re-broadcasta o estado. O token
    /// antigo é invalidado na hora (credential novo no upsert).
    pub fn bot_regen_token(&self, community_id: &str, bot_id: &str) -> Result<String> {
        self.require_owner(community_id)?;
        let all = self.store.bots_list(community_id)?;
        let Some(mut b) = all.into_iter().find(|x| x.id == bot_id) else {
            return Err(ForgeError::Protocol("bot inexistente".into()));
        };
        b.token = format!("bot_{}_{}", Self::rand_hex(12), Self::rand_hex(4));
        self.store.bot_upsert(&b)?;
        self.broadcast_community_state(community_id);
        Ok(b.token)
    }

    /// v6 — Posta mensagem COMO O BOT. Só o DONO (o runtime web roda no
    /// host; membros recebem o post relayado com bot_id). A mensagem é
    /// assinada pelo host (autor real) e marcada com bot_id para display.
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
            return Err(ForgeError::Protocol("bot_id vazio".into()));
        }
        if !self
            .store
            .bots_list(community_id)?
            .iter()
            .any(|b| b.id == bot_id)
        {
            return Err(ForgeError::Protocol("bot inexistente".into()));
        }
        if !self
            .store
            .list_channels(community_id)?
            .iter()
            .any(|(id, _)| id == channel_id)
        {
            return Err(ForgeError::Protocol("canal inexistente".into()));
        }
        let body = body.trim();
        if body.is_empty() {
            return Err(ForgeError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(ForgeError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        // bot tem que estar "online" para postar (toggle do painel)
        if let Some(b) = self
            .store
            .bots_list(community_id)?
            .into_iter()
            .find(|x| x.id == bot_id)
        {
            if !b.online {
                return Err(ForgeError::Protocol(
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
            .ok_or_else(|| ForgeError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn disconnect_peer(&self, peer_fp: &str) {
        let link = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_fp)
            .cloned();
        if let Some(l) = link {
            l.drop_notify.notify_waiters();
        }
    }

    // ---------------- amigos (F10) ----------------

    pub fn friends(&self, status: Option<&str>) -> Vec<PeerRecord> {
        self.store.list_friends(status).unwrap_or_default()
    }

    pub fn is_blocked(&self, peer_fp: &str) -> bool {
        matches!(self.store.get_friend(peer_fp).ok().flatten(), Some((_, s)) if s == "blocked")
    }

    /// Envia pedido de amizade. Se peer offline, fica `pending_out` e sai no
    /// flush de conexão (mesma mecânica do outbox de mensagens).
    pub fn friend_request(&self, peer_fp: &str) -> Result<FriendOutcome> {
        if peer_fp == self.identity.fingerprint {
            return Err(ForgeError::Protocol(
                "não é possível adicionar a si mesmo".into(),
            ));
        }
        // Idempotência/robustez: não rebaixa um amigo já aceito; se já existe um
        // pedido DELES para mim, aceita na hora (pedido cruzado) em vez de virar
        // 'pending_out' — era isso que deixava o adicionamento "travado".
        match self.store.get_friend(peer_fp)?.map(|(_, s)| s).as_deref() {
            Some("accepted") => return Ok(FriendOutcome::Sent),
            Some("blocked") => return Err(ForgeError::Protocol("peer bloqueado".into())),
            Some("pending_in") => {
                return self
                    .friend_respond(peer_fp, true)
                    .map(|_| FriendOutcome::Sent)
            }
            _ => {}
        }
        self.store.set_friend(peer_fp, "", "pending_out")?;
        let sent = self.deliver_friend_frame(
            peer_fp,
            SecureFrame::FriendRequest {
                nickname: self.identity.nickname.clone(),
            },
        );
        // relay IMEDIATO (não espera o tick de 5s do announce): dial começa agora
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
            .ok();
        // direta IMEDIATA em paralelo: se o peer já anunciou, a direta sai
        // na hora e vence o relay na eleição (menor latência)
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
            .ok();
        // DHT BitTorrent: get_peers no infohash do amigo também AGORA
        // (rendezvous 100% descentralizado — a rede BitTorrent apresenta os dois)
        self.dht_probe(peer_fp);
        Ok(sent)
    }

    /// Responde um pedido recebido (accept/reject). Remove/bloqueio também notificam.
    pub fn friend_respond(&self, peer_fp: &str, accept: bool) -> Result<()> {
        // Só responde a um pedido ENTRANTE de verdade. Sem este gate, responder
        // uma linha obsoleta (ou um id digitado na UI) criava uma amizade
        // "aceita" do nada: o par saía da tela de amigos sem nenhum dos dois
        // ter pedido, e o outro lado recebia um `FriendAccept` para um pedido
        // que nunca fez — que é justamente o que o gate do inbound rejeita.
        match self.store.get_friend(peer_fp).ok().flatten() {
            Some((_, status)) if status == "pending_in" => {}
            Some((_, status)) => {
                return Err(ForgeError::Protocol(format!(
                    "não há pedido pendente para responder (status: {status})"
                )))
            }
            None => return Err(ForgeError::Protocol("não há pedido pendente".into())),
        }
        let status = if accept {
            "accepted"
        } else {
            "pending_in_rejected"
        };
        let frame = if accept {
            SecureFrame::FriendAccept {
                nickname: self.identity.nickname.clone(),
            }
        } else {
            SecureFrame::FriendReject
        };
        self.store.set_friend(peer_fp, "", status)?;
        if accept {
            let _ = self.deliver_friend_frame(peer_fp, frame);
            // relay IMEDIATO: o aceite precisa chegar agora, não no próximo tick
            self.cmd_tx
                .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
                .ok();
            self.cmd_tx
                .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
                .ok();
        } else {
            self.deliver_friend_frame(peer_fp, frame);
            self.store.remove_friend(peer_fp)?;
        }
        Ok(())
    }

    pub fn friend_remove(&self, peer_fp: &str) -> Result<()> {
        self.store.remove_friend(peer_fp)?;
        self.deliver_friend_frame(peer_fp, SecureFrame::FriendRemove);
        Ok(())
    }

    pub fn friend_block(&self, peer_fp: &str) -> Result<()> {
        self.store.set_friend(peer_fp, "", "blocked")?;
        self.deliver_friend_frame(peer_fp, SecureFrame::FriendRemove);
        Ok(())
    }

    pub fn friend_unblock(&self, peer_fp: &str) -> Result<()> {
        self.store.remove_friend(peer_fp)?;
        Ok(())
    }

    /// Envia frame de amizade se online. Retorna o desfecho real.
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

    // ---------------- comunidades (F8) ----------------

    /// Cria comunidade REAL: dono = este dispositivo. Canais padrão se vazio.
    /// Cria comunidade REAL: dono = este dispositivo. Canais padrão se vazio.
    /// (Assinatura legada — o wizard usa `create_community_with_options`.)
    pub fn create_community(&self, name: &str, channels: &[String]) -> Result<String> {
        self.create_community_with_options(name, channels, &CommunityCreateOptions::default())
    }

    /// v6 — cria comunidade com metadados do WIZARD: canais com tipo
    /// (texto/voz/vídeo), cargos iniciais (presets admin/mod/membro),
    /// descrição/categoria/ícone e texto de regras. Tudo validado no CORE —
    /// a UI é só sugestão.
    pub fn create_community_with_options(
        &self,
        name: &str,
        channels: &[String],
        opts: &CommunityCreateOptions,
    ) -> Result<String> {
        // nome do servidor validado no CORE (unicidade global entre comunidades)
        let existing: Vec<String> = self
            .store
            .list_communities()
            .unwrap_or_default()
            .into_iter()
            .map(|(_, n, _)| n)
            .collect();
        let name = Self::validate_name_gate(crate::names::NameKind::Server, name, &existing)?;
        // canais iniciais validados um a um (unicidade no escopo do novo servidor)
        let mut seen: Vec<String> = vec![];
        let cid = crate::protocol::new_message_id(
            &self.identity.fingerprint,
            &name,
            crate::identity::now_ms(),
            "community",
        )[..16]
            .to_string();

        // canais: wizard (com tipo/categoria) ou CSV legado (todos texto)
        let chan_rows: Vec<ChannelMetaRow> = if !opts.channels_meta.is_empty() {
            let mut rows = Vec::with_capacity(opts.channels_meta.len());
            for c in &opts.channels_meta {
                let kind = match c.kind.as_str() {
                    "" | "text" => "text",
                    "voice" => "voice",
                    "video" => "video",
                    other => {
                        return Err(ForgeError::Protocol(format!(
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

        // base: comunidade + dono (canais entram via upsert com tipo certo)
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

        // cargos do wizard (presets admin/moderador/membro) — cap defensivo
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
                permissions: r.permissions & 0x3FF, // só bits conhecidos (10)
                hoist: r.hoist,
                mentionable: r.mentionable,
                position: i as i64,
            };
            self.store.role_upsert(&row)?;
        }

        // metadados + regras (texto livre vai pro kv; regras de moderação
        // ficam com o default 'medium' — o painel Storm edita depois)
        self.store.community_meta_set(
            &cid,
            Some(opts.description.trim()),
            Some(opts.category.trim()),
            Some(opts.icon.trim()),
        )?;
        if !opts.rules_text.trim().is_empty() {
            self.store.kv_set(
                &format!("rules:text:{cid}"),
                &crate::names::sanitize_text(opts.rules_text.trim(), 4096),
            )?;
        }

        let _ = self.events.send(EngineEvent::CommunityJoined {
            community_id: cid.clone(),
            name: name.into(),
        });
        Ok(cid)
    }

    /// v6 — atualiza descrição/categoria/ícone (dono) e re-broadcasta o estado.
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
            return Err(ForgeError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    /// v6 — lê metadados (descrição, categoria, ícone).
    pub fn community_meta(&self, community_id: &str) -> Result<(String, String, String)> {
        self.store.community_meta(community_id)
    }

    /// Dono gera convite assinado para um fingerprint específico (com expiração).
    pub fn make_invite(&self, community_id: &str, member_fp: &str, ttl_ms: i64) -> Result<String> {
        const WILDCARD: &str = "000000000000"; // link genérico: qualquer portador entra
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != self.identity.fingerprint {
            return Err(ForgeError::Protocol("apenas o dono gera convites".into()));
        }
        let fp = member_fp.trim().to_lowercase();
        if fp != WILDCARD && (fp.len() != 12 || !fp.chars().all(|c| c.is_ascii_hexdigit())) {
            return Err(ForgeError::Protocol("fingerprint inválido".into()));
        }
        let exp = crate::identity::now_ms() + ttl_ms;
        Ok(crate::protocol::make_invite_token(
            &self.keypair,
            community_id,
            &fp,
            exp,
        ))
    }

    /// Entra numa comunidade via token do dono. Conecta ao host e envia JoinCommunity.
    pub fn join_community(&self, token: &str) -> Result<String> {
        let (host_fp, cid, member_fp, exp, sig) = crate::protocol::parse_invite_token(token)?;
        if crate::identity::now_ms() > exp {
            return Err(ForgeError::Protocol("convite expirado".into()));
        }
        const WILDCARD: &str = "000000000000";
        if member_fp != WILDCARD && member_fp != self.identity.fingerprint {
            return Err(ForgeError::Protocol(
                "convite é para outro fingerprint".into(),
            ));
        }
        // a pubkey do host precisa validar a assinatura — busco no peerbook
        let host_pub = self
            .store
            .get_peer(&host_fp)?
            .map(|p| p.pubkey_hex)
            .ok_or_else(|| {
                ForgeError::Protocol("host desconhecido — conecte-se a ele primeiro".into())
            })?;
        if !Keypair::verify(
            &host_pub,
            &crate::protocol::invite_sign_bytes(&cid, &member_fp, exp),
            &sig,
        )
        .map_err(|e| ForgeError::Crypto(e.to_string()))?
        {
            return Err(ForgeError::Protocol(
                "convite com assinatura inválida".into(),
            ));
        }
        self.pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cid.clone(), token.to_string());
        self.cmd_tx
            .send(EngineCmd::SendToPeer(
                host_fp.clone(),
                SecureFrame::JoinCommunity {
                    community_id: cid.clone(),
                    token: token.to_string(),
                },
            ))
            .ok();
        Ok(cid)
    }

    /// Mensagem de canal: dono relay para membros; membro envia ao dono (host).
    pub fn send_channel_message(
        &self,
        community_id: &str,
        channel_id: &str,
        body: &str,
    ) -> Result<StoredMessage> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if self
            .store
            .member_role(community_id, &self.identity.fingerprint)
            .is_none()
        {
            return Err(ForgeError::Protocol("você não é membro".into()));
        }
        if !self
            .store
            .list_channels(community_id)?
            .iter()
            .any(|(id, _)| id == channel_id)
        {
            return Err(ForgeError::Protocol("canal inexistente".into()));
        }
        let body = body.trim();
        if body.is_empty() {
            return Err(ForgeError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(ForgeError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        // MODERAÇÃO no core (a UI não decide): banido não fala, silenciado
        // espera, slowmode segura quem manda rápido demais.
        self.gate_speech(community_id, channel_id)?;
        let env = MessageEnvelope::new(&self.keypair, channel_id, body);
        self.store.insert_message(&env, "out", "sending")?;
        // menção a mim? (barra de menções do canal)
        let my = &self.identity.fingerprint;
        if body.contains(my) || body.contains(&format!("<@{my}>")) {
            self.store.msg_set_mentioned(&env.id, channel_id, true).ok();
        }
        crate::metrics::metrics().message_out();
        if comm.2 == self.identity.fingerprint {
            // sou o host: relay direto
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
            .ok_or_else(|| ForgeError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    /// Host: repassa mensagem válida a membros online (exceto autor).
    /// v6: `bot_id` propaga o post de bot para os membros (display).
    // ==================================================================
    // API SOCIAL v3 — chamada pelo shell Tauri. Toda escrita local acontece
    // AQUI (o shell não toca storage) e a difusão usa a sessão do peer.
    // ==================================================================

    /// Portão de fala: ban/timeout/slowmode. Emite `Muted` e devolve erro.
    pub fn gate_speech(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.gate_speech_for(community_id, channel_id, &self.identity.fingerprint)
    }

    /// Mesmo portão, para um autor arbitrário. O HOST precisa deste: a checagem
    /// de saída usa sempre o fingerprint local, mas quem envia inbound é outro,
    /// e sem validar o AUTOR o ban vira decoração — o banido contorna banindo
    /// o host diretamente em vez de falar pelo próprio cliente.
    pub fn gate_speech_for(
        &self,
        community_id: &str,
        channel_id: &str,
        author_fp: &str,
    ) -> Result<()> {
        let me = author_fp;
        // Silenciamento de CONTA tem precedência sobre tudo: é a única sanção
        // que sobrevive à troca de servidor, então consultá-la primeiro evita
        // um DM (que não tem comunidade) de servir de buraco no mute.
        let mute_until = self.store.mute_active(me).unwrap_or(0);
        if mute_until > crate::identity::now_ms() {
            let mins = ((mute_until - crate::identity::now_ms()) as f64 / 60_000.0).ceil() as i64;
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!("você está silenciado por mais {mins} min"),
                until_ms: mute_until,
            });
            return Err(ForgeError::Protocol(format!(
                "você está silenciado por mais {mins} min"
            )));
        }
        if let Some(b) = self.store.ban_get(community_id, me).ok().flatten() {
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!(
                    "você está banido{}",
                    if b.reason.is_empty() { String::new() } else { format!(": {}", b.reason) }
                ),
                until_ms: b.until_ms,
            });
            return Err(ForgeError::Protocol("você está banido deste servidor".into()));
        }
        let until = self.store.timeout_active(community_id, me).unwrap_or(0);
        if until > 0 {
            let mins = ((until - crate::identity::now_ms()) as f64 / 60_000.0).ceil() as i64;
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!("silenciado por mais {} min", mins),
                until_ms: until,
            });
            return Err(ForgeError::Protocol(format!(
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
                return Err(ForgeError::Protocol(format!("slowmode: aguarde {}s", secs)));
            }
        }
        Ok(())
    }

    fn to_social_peers(&self, conv_id: &str, frame: SecureFrame) {
        for fp in self.social_peers_of(conv_id) {
            self.cmd_tx.send(EngineCmd::SendToPeer(fp, frame.clone())).ok();
        }
    }

    /// Reação local + difusão (toggle: o motor calcula add/remove).
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
        // Reação não tem ACK: se o peer está offline, o SendToPeer acima cai
        // no vazio em silêncio (sem link, sem fila). Enfileira para os peers
        // sem link — o flush ao (re)conectar entrega. Sem isto, reagir com o
        // outro lado desconectado = reação perdida para sempre.
        for fp in self.social_peers_of(conv_id) {
            if self.link_tx(&fp).is_none() {
                let _ = self.store.queue_pending_react(&fp, conv_id, msg_id, emoji, added);
            }
        }
        Ok(added)
    }

    /// Resposta: vincula + difunde.
    pub fn social_reply(&self, conv_id: &str, msg_id: &str, reply_to: &str) -> Result<()> {
        // A citação aponta para OUTRA mensagem. Sem checá-la, um id inválido
        // fica gravado em `msg_meta` e a UI renderiza um bloco de citação
        // quebrado para sempre — não há como o usuário corrigir depois, porque
        // o composer não tem mais ação de "editar citação".
        let alvo = self
            .store
            .message_by_id(reply_to)?
            .ok_or_else(|| ForgeError::Protocol("mensagem citada não existe".into()))?;
        if alvo.conv_id != conv_id {
            return Err(ForgeError::Protocol(
                "a mensagem citada está em outra conversa".into(),
            ));
        }
        let portadora = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| ForgeError::Protocol("mensagem inexistente".into()))?;
        if portadora.conv_id != conv_id {
            return Err(ForgeError::Protocol("conversa divergente".into()));
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
            .ok_or_else(|| ForgeError::Protocol("mensagem inexistente".into()))?;
        if orig.author_fp != me {
            return Err(ForgeError::Protocol("só o autor edita".into()));
        }
        let nb = cap_str(body, 4000);
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
            .ok_or_else(|| ForgeError::Protocol("mensagem inexistente".into()))?;
        let is_author = orig.author_fp == me;
        if !is_author && !self.is_moderator(conv_id, &me) {
            return Err(ForgeError::Protocol("sem permissão para apagar".into()));
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

    /// Encaminha: re-assina o corpo no destino e anota a origem.
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
            .ok_or_else(|| ForgeError::Protocol("mensagem inexistente".into()))?;
        let body = self.store.effective_body(src_msg_id, &src.body)?;
        if body.len() > 64 * 1024 {
            return Err(ForgeError::Protocol("mensagem longa demais".into()));
        }
        // re-assinada por MIM: o destinatário valida minha assinatura
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
            .ok_or_else(|| ForgeError::Protocol("falha ao gravar".into()))?)
    }

    // ---------- presença / perfil ----------

    pub fn social_presence_set(&self, status: &str, custom: &str, emoji: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let st = normalize_presence(status);
        self.store.presence_set(
            &me,
            st,
            &cap_str(custom, 128),
            &cap_str(emoji, 16),
        )?;
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
        let me = self.identity.fingerprint.clone();
        let dn = cap_str(display_name, 48);
        let ab = cap_str(about, 400);
        self.store.profile_set(
            &me,
            &dn,
            &ab,
            &cap_b64(avatar_b64, 700_000),
            &cap_b64(banner_b64, 1_400_000),
            if accent.starts_with('#') && accent.len() == 7 {
                accent
            } else {
                ""
            },
        )?;
        if !dn.is_empty() {
            let _ = self.store.set_friend(&me, &dn, "accepted");
        }
        let frame = SecureFrame::ProfileSet {
            display_name: dn.clone(),
            about: ab.clone(),
            avatar_b64: cap_b64(avatar_b64, 700_000),
            banner_b64: cap_b64(banner_b64, 1_400_000),
            accent: accent.into(),
        };
        for peer in self.store.list_peers().unwrap_or_default() {
            if self.link_tx(&peer.fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(peer.fp, frame.clone()))
                    .ok();
            }
        }
        Ok(self.store.profile_get(&me)?)
    }

    // ---------- threads ----------

    pub fn social_thread_create(
        &self,
        community_id: &str,
        parent_channel: &str,
        name: &str,
        kind: &str,
        tags: &str,
    ) -> Result<crate::social::ThreadRow> {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(ForgeError::Protocol("você não é membro".into()));
        }
        let id = format!("th_{}", &crate::protocol::new_message_id(&me, community_id, crate::identity::now_ms(), name)[..24]);
        let t = crate::social::ThreadRow {
            id,
            community_id: community_id.into(),
            parent_channel: parent_channel.into(),
            name: cap_str(name, 80),
            author_fp: me,
            created_at: crate::identity::now_ms(),
            archived: false,
            kind: if kind == "forum" { "forum".into() } else { "thread".into() },
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

    /// Mensagem em thread (passa pelas mesmas travas: ban/timeout/slowmode).
    pub fn social_thread_send(
        &self,
        community_id: &str,
        thread_id: &str,
        body: &str,
    ) -> Result<StoredMessage> {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(ForgeError::Protocol("você não é membro".into()));
        }
        let t = self
            .store
            .thread_get(thread_id)?
            .ok_or_else(|| ForgeError::Protocol("thread inexistente".into()))?;
        let body = body.trim();
        if body.is_empty() {
            return Err(ForgeError::Protocol("mensagem vazia".into()));
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
            .ok_or_else(|| ForgeError::Protocol("falha ao gravar".into()))?)
    }

    // ---------- moderação ----------

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
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me && !self.is_moderator(community_id, &me) {
            return Err(ForgeError::Protocol("sem permissão de moderação".into()));
        }
        if target == comm.2 {
            return Err(ForgeError::Protocol("o dono não pode ser banido".into()));
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
            return Err(ForgeError::Protocol("sem permissão de moderação".into()));
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
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(community_id, &me) {
            return Err(ForgeError::Protocol("sem permissão de moderação".into()));
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
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(ForgeError::Protocol("só o dono configura o canal".into()));
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

    // ---------- enquetes / eventos / emojis ----------

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
            return Err(ForgeError::Protocol("você não é membro".into()));
        }
        let opts: Vec<String> = options.iter().take(10).map(|o| cap_str(o, 80)).collect();
        if opts.len() < 2 {
            return Err(ForgeError::Protocol("enquete precisa de 2+ opções".into()));
        }
        let id = format!("pl_{}", &crate::protocol::new_message_id(&me, community_id, crate::identity::now_ms(), question)[..24]);
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
            .ok_or_else(|| ForgeError::Protocol("enquete inexistente".into()))?;
        if poll.closed {
            return Err(ForgeError::Protocol("enquete encerrada".into()));
        }
        if option_idx < 0 || option_idx as usize >= poll.options.len() {
            return Err(ForgeError::Protocol("opção inválida".into()));
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

    pub fn social_event_upsert(&self, ev: crate::social::EventRow) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(&ev.community_id)?
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(ForgeError::Protocol("só o dono cria eventos".into()));
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
            .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(ForgeError::Protocol("só o dono exclui eventos".into()));
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
            return Err(ForgeError::Protocol("sem permissão".into()));
        }
        let mut row = e;
        row.name = cap_str(&row.name, 32);
        row.char = cap_str(&row.char, 8);
        if row.name.is_empty() || row.char.is_empty() {
            return Err(ForgeError::Protocol("emoji incompleto".into()));
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
            return Err(ForgeError::Protocol("sem permissão".into()));
        }
        self.store.emoji_delete(community_id, id)?;
        Ok(())
    }

    /// "Estou digitando" — só para quem compartilha a conversa, prazo de 6s.
    /// Nenhum tipo novo de frame: reusa o `Typing` inbound com o peer real.
    pub fn social_typing(&self, conv_id: &str) -> Result<()> {
        let until = crate::identity::now_ms() + 6_000;
        let frame = SecureFrame::Typing {
            conv_id: conv_id.to_string(),
            until_ms: until,
        };
        self.to_social_peers(conv_id, frame);
        Ok(())
    }

    /// Reordena canais (drag-and-drop na barra lateral). Exige autoridade na
    /// comunidade — a UI pode tentar, o motor é quem decide.
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
            return Err(ForgeError::Protocol("sem permissão para reordenar".into()));
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
        // confirma ao autor (se não sou eu)
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

    fn flush_joins(&self, peer_fp: &str) {
        let joins: Vec<(String, String)> = self
            .pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (cid, token) in joins {
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

    /// Ao conectar: reenvia pedidos pendentes de saída (e aceites locais que
    /// o outro lado pode ter perdido).
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

    /// Drena reações enfileiradas enquanto o peer estava offline. O receptor
    /// aplica com `add` explícito (idempotente), então re-entregar é seguro.
    /// Chamado ao (re)conectar e no flush periódico de online.
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

    /// Rede de segurança da amizade (chamada no tick de 15s): reenvia o pedido
    /// ainda `pending_out` a um peer ONLINE. Se o 1º FriendRequest (ou o
    /// FriendAccept da volta) se perdeu no relay/4G, o outro lado re-sincroniza
    /// sozinho; o usuário não precisa recomeçar. O receptor trata como
    /// idempotente (ver handler de FriendRequest).
    fn retry_pending_friend_request(&self, peer_fp: &str) {
        if let Some((_, status)) = self.store.get_friend(peer_fp).ok().flatten() {
            if status == "pending_out" {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::FriendRequest {
                            nickname: self.identity.nickname.clone(),
                        },
                    ))
                    .ok();
            }
        }
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

    // ---------- grupos DM ----------
    pub fn create_group(&self, title: &str, members: Vec<String>) -> Result<Conversation> {
        if members.is_empty() {
            return Err(ForgeError::Protocol("selecione ao menos 1 amigo".into()));
        }
        if members.len() > 9 {
            return Err(ForgeError::Protocol(
                "máximo 9 membros + você (10 total)".into(),
            ));
        }
        for fp in &members {
            if self.store.get_friend(fp)?.is_none() && self.store.get_peer(fp)?.is_none() {
                let has = self.store.list_friends(None)?.iter().any(|p| &p.fp == fp);
                if !has {
                    return Err(ForgeError::Protocol(format!("{fp} não é amigo")));
                }
            }
        }
        let conv = self
            .store
            .create_group_dm(&self.identity.fingerprint, &members, title)?;
        // sincroniza o grupo REAL para os membros online (offline recebe no flush)
        self.broadcast_group_created(&conv.id);
        Ok(conv)
    }

    /// Envia GroupCreated (estado completo do grupo) a todos os membros online.
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
                        },
                    ))
                    .ok();
            }
        }
    }

    pub fn group_members(&self, conv_id: &str) -> Vec<(String, String)> {
        self.store.list_group_members(conv_id).unwrap_or_default()
    }

    pub fn group_add(&self, conv_id: &str, fp: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| ForgeError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(ForgeError::Protocol("não é grupo".into()));
        }
        self.store.add_group_member(conv_id, fp, "")?;
        let members = self.store.list_group_members(conv_id)?;
        let title = conv.title.clone();
        let me = self.identity.fingerprint.clone();
        for (mfp, _) in &members {
            if *mfp == me {
                continue;
            }
            if self.link_tx(mfp).is_some() {
                if *mfp == fp {
                    // novo membro recebe o estado COMPLETO do grupo
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            mfp.clone(),
                            SecureFrame::GroupCreated {
                                conv_id: conv_id.to_string(),
                                title: title.clone(),
                                members: members.clone(),
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

    pub fn call_invite(&self, target_fp: &str, kind: &str) -> Result<String> {
        let short = self
            .identity
            .fingerprint
            .get(..6)
            .unwrap_or(&self.identity.fingerprint)
            .to_string();
        let call_id = format!("call-{short}-{}", crate::identity::now_ms());
        self.store
            .create_call(&call_id, kind, target_fp, &self.identity.fingerprint)?;
        self.queue_or_send_call_frame(
            target_fp,
            SecureFrame::CallInvite {
                call_id: call_id.clone(),
                kind: kind.into(),
                target_fp: target_fp.into(),
            },
        );
            #[cfg(target_os = "linux")]
        // Chamada NATIVA: eu sou o chamador, o offer nasce aqui. Se a mídia
        // nativa não existir, `voice_begin_offer` devolve None e a WebView faz
        // a offer dela normalmente — nenhum outro código muda de rota.
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

    pub fn call_accept(&self, call_id: &str, from_fp: &str) -> Result<()> {
        self.store.join_call(call_id, &self.identity.fingerprint)?;
        self.store.join_call(call_id, from_fp)?;
            #[cfg(target_os = "linux")]
        // Chamada NATIVA: eu sou o convidado. Só REGISTRO o par aqui — a offer
        // do outro lado ainda vai chegar, e é o arm de `CallOffer` que a
        // absorve. Se a mídia nativa não existir, o par não é registrado e o
        // `CallOffer` chega intacto para o JS.
        self.voice_register(call_id, from_fp);
        self.queue_or_send_call_frame(
            from_fp,
            SecureFrame::CallAccept {
                call_id: call_id.into(),
            },
        );
        let _ = self.events.send(EngineEvent::CallAcceptedEv {
            call_id: call_id.into(),
            from_fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    pub fn call_reject(&self, call_id: &str, from_fp: &str, reason: &str) -> Result<()> {
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
        // Encerra a mídia nativa ANTES do evento: se sobrasse sessão viva, o
        // alto-falante continuaria tocando áudio de uma chamada morta.
        self.voice_hangup(call_id);
        let _ = self.events.send(EngineEvent::CallEnded {
            call_id: call_id.into(),
            from_fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    pub fn call_signal(&self, target_fp: &str, frame: SecureFrame) -> Result<()> {
        // Online → envio imediato (writer task cifra na hora, sem tick).
        // Offline → enfileira + dial imediato; o flush na sessão nova entrega.
        // (Antes retornava PeerNotConnected e o frame se perdia.)
        self.queue_or_send_call_frame(target_fp, frame);
        Ok(())
    }

    /// v6 — GRUPO (mesh): notifica `target_fp` sobre novo participante `fp`
    /// da chamada `call_id`. `kind` não-vazio faz o ALVO TOCAR (ring do
    /// convidado — CallIncoming no receptor); vazio = só badge de roster
    /// para quem já está na chamada. Persiste o participante em call_participants.
    pub fn call_add_participant(
        &self,
        target_fp: &str,
        call_id: &str,
        fp: &str,
        kind: &str,
    ) -> Result<()> {
        let call_id = call_id.trim();
        let fp = fp.trim();
        if call_id.is_empty() || fp.is_empty() {
            return Err(ForgeError::Protocol("call_id/fp vazios".into()));
        }
        let kind = crate::names::sanitize_text(kind.trim(), 16);
        // registra o novo participante na chamada (host autoritativo)
        let _ = self.store.join_call(call_id, fp);
        let _ = self.store.join_call(call_id, target_fp);
            #[cfg(target_os = "linux")]
        // Grupo em modo nativo: o convidado e o host passam a trocar SDP/ICE
        // pela camada Rust. Sem registro, nada muda para o navegador.
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

    // ------------------------------------------------------- voz nativa (API)

    /// Gerenciador de mídia nativa, ou `None` quando ela não existe aqui.
    #[cfg(target_os = "linux")]
    pub fn voice(&self) -> Option<&Arc<VoiceMedia>> {
        self.voice.as_ref()
    }

    /// A camada nativa PODE assumir chamadas agora?
    ///
    /// Só há resposta positiva se o `VoiceMedia` foi construído (o que já
    /// implica plataforma Linux e kill-switch desligado). É o único portão de
    /// entrada: enquanto for `false`, nenhum registro é criado e, portanto,
    /// nenhum frame de sinalização é absorvido.
    #[cfg(target_os = "linux")]
    pub fn native_voice_available(&self) -> bool {
        self.voice.is_some()
    }

    /// `(call_id, peer_fp)` é uma sessão NATIVA? — a única pergunta que os
    /// arms de `CallOffer`/`CallAnswer`/`CallIce` fazem.
    #[cfg(target_os = "linux")]
    fn voice_is_native(&self, call_id: &str, peer_fp: &str) -> bool {
        self.voice.is_some()
            && self
                .voice_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(call_id)
                .is_some_and(|peers| peers.contains(peer_fp))
    }

    /// Marca o par como nativo. Devolve `false` (e não registra nada) se a
    /// mídia não existe — nesse caso a chamada é 100% navegador, de ponta a
    /// ponta, e nada mais precisa ser feito.
    #[cfg(target_os = "linux")]
    fn voice_register(&self, call_id: &str, peer_fp: &str) -> bool {
        if self.voice.is_none() {
            return false;
        }
        self.voice_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(call_id.to_string())
            .or_default()
            .insert(peer_fp.to_string());
        true
    }

    #[cfg(target_os = "linux")]
    fn voice_forget_call(&self, call_id: &str) {
        self.voice_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(call_id);
    }

    /// Envia o SDP/candidatos que a mídia nativa produziu, pelos MESMOS
    /// `SecureFrame::Call*` que o navegador usa — nenhum frame novo no
    /// protocolo, nenhum branch no peer distante.
    #[cfg(target_os = "linux")]
    fn voice_flush_signals(&self, call_id: &str, peer_fp: &str) {
        let Some(v) = self.voice.clone() else { return };
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

    /// Registra o par como nativo e devolve o offer da mídia, se houver.
    /// `Ok(None)` = chamada segue pelo navegador (mídia indisponível).
    #[cfg(target_os = "linux")]
    fn voice_begin_offer(&self, call_id: &str, peer_fp: &str) -> Result<Option<String>> {
        if !self.voice_register(call_id, peer_fp) {
            return Ok(None);
        }
        let Some(v) = self.voice.clone() else {
            return Ok(None);
        };
        // `create_offer` BLOQUEIA (espera o SDP local + o ICE). Se estivermos
        // dentro de uma task async, travar a worker thread seria errado —
        // `block_in_place` resolve, o runtime troca a thread e os timers dos
        // outros tasks continuam.
        //
        // Fora de runtime (comando Tauri síncrono, teste) `block_in_place`
        // PANICA: nesses casos chamamos direto. Os dois caminhos são
        // equivalentes em custo — o bloqueio é o mesmo.
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
                if let Some(peers) = self
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

    /// `true` = o offer foi absorvido pela mídia (o JS NÃO deve criar
    /// `RTCPeerConnection`). `false` = o offer não é nosso: o arm emite o
    /// `EngineEvent` de sempre.
            #[cfg(target_os = "linux")]
    async fn voice_absorb_offer(
        &self,
        call_id: &str,
        peer_fp: &str,
        sdp: &str,
    ) -> Result<bool> {
        if !self.voice_is_native(call_id, peer_fp) {
            return Ok(false);
        }
        let Some(v) = self.voice.clone() else {
            return Ok(false);
        };
        let (cid, pfp, s) = (call_id.to_string(), peer_fp.to_string(), sdp.to_string());
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

    /// Idem para `CallAnswer` e `CallIce`.
            #[cfg(target_os = "linux")]
    async fn voice_absorb_answer(&self, call_id: &str, peer_fp: &str, sdp: &str) -> bool {
        if !self.voice_is_native(call_id, peer_fp) {
            return false;
        }
        let Some(v) = self.voice.clone() else {
            return false;
        };
        let (cid, pfp, s) = (call_id.to_string(), peer_fp.to_string(), sdp.to_string());
        let res = tokio::task::spawn_blocking(move || v.handle_answer(&cid, &pfp, &s)).await;
        let ok = matches!(res, Ok(Ok(())));
        self.voice_flush_signals(call_id, peer_fp);
        ok
    }

            #[cfg(target_os = "linux")]
    async fn voice_absorb_ice(&self, call_id: &str, peer_fp: &str, cand: &str, mid: &str) -> bool {
        if !self.voice_is_native(call_id, peer_fp) {
            return false;
        }
        let Some(v) = self.voice.clone() else {
            return false;
        };
        let (cid, pfp, c, m) = (
            call_id.to_string(),
            peer_fp.to_string(),
            cand.to_string(),
            mid.to_string(),
        );
        let res = tokio::task::spawn_blocking(move || v.add_ice_candidate(&cid, &pfp, &c, &m)).await;
        let ok = matches!(res, Ok(Ok(())));
        self.voice_flush_signals(call_id, peer_fp);
        ok
    }

    // --------------------------------------- voz nativa (comandos da UI)

            #[cfg(target_os = "linux")]
    pub fn voice_media_available(&self) -> bool {
        self.native_voice_available()
    }

    /// Estado agregado da chamada. `None` quando não há sessão nativa — a UI
    /// então cai no relatório de `RTCPeerConnection` do navegador, que é o
    /// comportamento de sempre.
            #[cfg(target_os = "linux")]
    pub fn voice_media_stats(&self, call_id: &str) -> Option<VoiceStats> {
        self.voice.as_ref().and_then(|v| v.stats_agg(call_id))
    }

            #[cfg(target_os = "linux")]
    pub fn voice_set_muted(&self, call_id: &str, muted: bool) {
        if let Some(v) = self.voice.as_ref() {
            v.set_muted(call_id, muted);
        }
    }

            #[cfg(target_os = "linux")]
    pub fn voice_hangup(&self, call_id: &str) {
        if let Some(v) = self.voice.as_ref() {
            v.hangup(call_id);
        }
        self.voice_forget_call(call_id);
    }


    /// true se o frame é sinalização de chamada/voz efêmera (fila pending_calls).
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
                | SecureFrame::ScreenShareOffer { .. }
                | SecureFrame::ScreenShareAnswer { .. }
        )
    }

    /// Teto de frames de sinalização enfileirados por peer offline.
    /// Maior que o antigo 64: atrás de CGNAT a ligação P2P demora segundos
    /// para subir (relay + direta em paralelo), e é nesse intervalo que a
    /// sinalização da chamada inteira se acumula.
    const PENDING_CALL_MAX: usize = 512;

    /// Descarte a sinalização menos importante, nunca a essencial.
    ///
    /// BUG que isto corrige: a fila usava `q.remove(0)` — descartava o frame
    /// MAIS ANTIGO ao encher. A ordem de chegada numa chamada é
    /// invite → offer → **candidatos ICE** → answer, então o que caía era
    /// exatamente o `CallOffer` e os primeiros candidatos (o `srflx` do STUN).
    /// O peer recebia candidatos de uma offer que nunca chegou: nenhum
    /// RTCPeerConnection, chamada muda. Só acontecia quando a fila estourava —
    /// por isso "às vezes não pega", e pior no 4G/CGNAT, onde a ligação P2P é
    /// justamente o que demora.
    ///
    /// Ordem de descarte, do mais descartável ao mais valioso:
    /// 1. `CallIce` — reenviável; o chamador reenvia a lista inteira quando o
    ///    gathering termina, e o WebRTC ignora duplicata.
    /// 2. Convite/encerramento antigos — para o peer que reconecta, não têm valor.
    /// 3. Offer/answer DUPLICADOS antigos — protege-se o par mais recente, que
    ///    é a negociação vigente. Se já estiver protegido, não descarta nada:
    ///    perder a sinalização essencial é pior do que a fila crescer um frame.
    fn evict_call_frame(q: &mut Vec<SecureFrame>) {
        if Self::evict_one(q, |f| matches!(f, SecureFrame::CallIce { .. })) {
            return;
        }
        if Self::evict_one(
            q,
            |f| matches!(f, SecureFrame::CallEnd { .. } | SecureFrame::CallInvite { .. }),
        ) {
            return;
        }
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

    /// Remove o primeiro frame que casa com `pred`; devolve se removeu.
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

    /// Envia agora se online; senão enfileira (cap PENDING_CALL_MAX/peer,
    /// descartando o menos essencial) + dispara dial imediato via relay e
    /// direta em paralelo.
    /// Frames pequenos (offer/answer/ice cabem num chunk) têm latência de
    /// ~RTT + 1 poll após o online, sem esperar tick de 5s.
    fn queue_or_send_call_frame(&self, peer_fp: &str, frame: SecureFrame) {
        if self.link_tx(peer_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.to_string(), frame))
                .ok();
            return;
        }
        // Offline: fila para o flush imediato da sessão recém-criada.
        // (Qualquer frame via call_signal é enfileirado; o filtro Call* é
        // documental — o flush drena na ordem de chegada.)
        {
            let mut map = self.pending_calls.lock().unwrap_or_else(|e| e.into_inner());
            let q = map.entry(peer_fp.to_string()).or_default();
            if q.len() >= Self::PENDING_CALL_MAX {
                Self::evict_call_frame(q);
            }
            q.push(frame);
        }
        // Dial IMEDIATO (não espera o tick de 5s do bootstrap): relay primeiro,
        // direta em paralelo vence na eleição se o NAT deixar.
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
            .ok();
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
            .ok();
    }

    /// Drena a fila de chamadas na sessão recém-criada (FLUSH IMEDIATO, sem
    /// spawn: `cmd_tx` é unbounded e `frame_tx` bufferiza até a writer nascer
    /// logo abaixo — mesmo padrão de flush_friend_requests/flush_joins).
    fn flush_pending_calls(&self, peer_fp: &str) {
        let frames: Vec<SecureFrame> = self
            .pending_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_fp)
            .unwrap_or_default();
        for f in frames {
            // Drena na ordem de chegada (invite→offer→answer→ice preservada).
            let _ = Self::is_call_frame(&f); // documental: fila é de sinalização
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.to_string(), f))
                .ok();
        }
    }

    // ---------- voz (canal) ----------
    pub fn voice_join(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.store.set_voice_state(
            community_id,
            channel_id,
            &self.identity.fingerprint,
            false,
            false,
        )?;
        // broadcast para membros da comunidade
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
        Ok(())
    }

    pub fn voice_leave(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.store
            .leave_voice(community_id, channel_id, &self.identity.fingerprint)?;
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

    // ---------- arquivos swarm ----------
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
        Ok(())
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
            Err(ForgeError::PeerNotConnected(holder_fp.into()))
        }
    }

    pub fn file_send_chunk(
        &self,
        target_fp: &str,
        file_id: &str,
        index: u32,
        data_b64: &str,
    ) -> Result<()> {
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
            Err(ForgeError::PeerNotConnected(target_fp.into()))
        }
    }
}

/// IP da interface de saída (LAN). Truque do UDP: não envia pacote, só consulta
/// qual interface o kernel escolheria para a rota padrão. Sem dependência extra.
fn local_lan_ip() -> Option<std::net::IpAddr> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip())
}

/// STUN pode ser consultado no modo de privacidade atual? Em `proxy`/`full`
/// o IP real NÃO pode vazar para servidores STUN públicos (fail-closed).
fn stun_allowed(engine: &Arc<NetworkEngine>) -> bool {
    !matches!(engine.privacy_mode().as_str(), "proxy" | "full")
}

/// `FORGE_NO_RELAY` liga o kill-switch do relay no boot? Aceita
/// 1/true/yes/on (case-insensitive); qualquer outro valor = relay ligado.
fn env_no_relay() -> bool {
    std::env::var("FORGE_NO_RELAY")
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

/// Relay é **OPT-IN**: por padrão fica DESLIGADO (só DIRETA: TCP/hole punch/LAN).
/// Ligue explicitamente com `FORGE_RELAY=1`. `FORGE_NO_RELAY=1` força desligado.
fn env_relay_enabled() -> bool {
    if env_no_relay() {
        return false;
    }
    // DEFAULT LIGADO (fail-open): o relay MQTT é a via garantida sob CGNAT e
    // não pode exigir env var para existir — era o bug do "0 peers" (opt-in
    // silencioso que ninguém setava; só os testes injetavam backend e re-ligavam).
    // Desliga explicitamente com `FORGE_RELAY=0/false/no/off`.
    !matches!(
        std::env::var("FORGE_RELAY")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("0" | "false" | "no" | "off")
    )
}

/// (F7) Regra pura do "intermediário por peer" (testável sem env do processo).
/// **AUTOMÁTICO por padrão** (o intermediário é um PEER da rede, não o relay
/// público). Desliga com `FORGE_NO_RELAY=1` ou `FORGE_PEER_RELAY=0/false/off`.
/// `FORGE_RELAY=0/off` também desliga (compatibilidade).
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
    true // AUTO: intermediário por peer ligado por padrão
}

/// Intermediário por peer: **LIGADO por padrão** (automático quando o direto
/// falha). Desliga com `FORGE_NO_RELAY=1` ou `FORGE_PEER_RELAY=0`.
fn env_peer_relay_enabled() -> bool {
    peer_relay_optin_value(
        std::env::var("FORGE_RELAY").ok().as_deref(),
        std::env::var("FORGE_PEER_RELAY").ok().as_deref(),
        env_no_relay(),
    )
}

/// Hole punching ligado? Default LIGADO. `FORGE_PUNCH=0` (ou false/no/off)
/// desliga APENAS o furo coordenado — dial outbound, UPnP/LAN e relay seguem.
fn env_punch_enabled() -> bool {
    let v = std::env::var("FORGE_PUNCH").ok();
    punch_flag_value(v.as_deref())
}

/// Regra pura do kill-flag (testável sem mexer no env do processo).
fn punch_flag_value(v: Option<&str>) -> bool {
    match v {
        None => true,
        Some(s) => !matches!(
            s.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "no" | "off"
        ),
    }
}

/// Fallback AUTOMÁTICO para proxy ligado? Default DESLIGADO — o proxy nunca
/// é ativado silenciosamente: só o usuário liga (UI/`privacy.mode`) ou,
/// explicitamente opt-in, via `FORGE_AUTO_PROXY=1/true/yes/on`.
/// Quando desativado, NENHUMA conexão passa por proxy.
/// Regra pura separada para teste sem tocar no env do processo.
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
    auto_proxy_flag_value(std::env::var("FORGE_AUTO_PROXY").ok().as_deref())
}

/// Announce/descoberta de endpoint por tópico de anúncio (LAN/direta) ligada?
/// Default LIGADO na produção (direta é preferida — menor latência). Testes
/// que precisam exercitar SÓ o relay (adverso/lossy/mqtt) setam
/// `FORGE_NO_ANNOUNCE=1` para desligar a descoberta direta via anúncio e
/// deixar a eleição determinística (relay-only).
/// Regra pura separada para teste sem tocar no env do processo.
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
    announce_flag_value(std::env::var("FORGE_NO_ANNOUNCE").ok().as_deref())
}

/// Renova o mapeamento de porta no roteador. Tenta UPnP IGD (crate `igd`) e,
/// se indisponível, NAT-PMP (RFC 6886, ver `net::natpmp`) — muitos CGNATs só
/// falam NAT-PMP. Ao sucesso grava em `ext_port` a porta EXTERNA que deve ser
/// ANUNCIADA (regra torrent: o endpoint publicado tem que ser o mapeado).
/// Nunca panica nem bloqueia o engine: roda em thread bloqueante com timeout;
/// falha vira `debug!` e seguimos no hole punch/relay.
async fn nat_map_port(port: u16, ext_port: Arc<AtomicU16>) {
    let res = timeout(
        Duration::from_secs(8),
        tokio::task::spawn_blocking(move || -> std::result::Result<u16, String> {
            // Timeout CURTO no SSDP (default da crate é 10s): sem gateway o
            // search tem que desistir rápido para dar vez ao NAT-PMP.
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
                        "FORGE P2P",
                    ) {
                        // UPnP honra a porta pedida na esmagadora maioria dos IGDs.
                        Ok(()) => Ok(port),
                        Err(e) => {
                            // Gateway UPnP existe mas recusou o mapeamento —
                            // alguns só mapeiam via NAT-PMP.
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

/// OUTBOUND-FIRST (regra do torrent): SEMPRE tentamos SAIR para o endpoint
/// anunciado do peer. Quem está atrás de NAT/CGNAT só consegue SAIR; a conexão
/// de entrada vem do lado alcançável. Consulta trackers HTTP self-hosted (se
/// configurados via FORGE_BOOTSTRAP_URL) e disca DIRETO. Devolve true se
/// achou um endpoint e disparou o dial. Sem trackers configurados, nem tenta
/// (descoberta fica a cargo do MQTT announce / LAN / hole punch).
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
            // Tracker self-hosted devolve {"addr": "ip:porta", ...} (LAN opcional).
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
    // 0) Aplica o modo de privacidade ao relay ANTES de subir os loops: em
    // proxy/Tor o backend passa a MQTT-via-túnel-SOCKS5 (ou o relay fica
    // desligado, fail-closed) — sem isso o modo `proxy` iniciaria com as
    // rotas públicas diretas e vazaria o IP no primeiro frame de relay.
    engine.refresh_relay_for_privacy();

    // FAST-CONNECT no boot: não espera o 1º tick de descoberta. Disca já para
    // peers conhecidos (peerbook) e reengata o relay/announce dos amigos —
    // corta o tempo até a 1ª mensagem logo que o app abre.
    // OUTBOUND-FIRST no boot também: o tick de announce dispara IMEDIATAMENTE
    // (1º `tick()` do interval) e faz o lookup de endpoint anunciado (tracker/
    // tracker) dos amigos, sem depender do relay — quem tem NAT só SAI.
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
    }

    // 1) Listener TCP em porta FIXA estilo torrent (default 51413,
    // FORGE_PORT sobrescreve) com fallback: fixa+1..+9 e só então efêmera.
    // Porta estável = mapeamento CGNAT/UPnP estável + DHT/announce coerentes
    // entre restarts (porta efêmera (:0) mudava tudo a cada boot e invalidava
    // o endpoint anunciado — o torrent nunca faz isso).
    let listener = {
        let preferred: u16 = std::env::var("FORGE_PORT")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|p: &u16| *p != 0)
            .unwrap_or(51413);
        let mut candidates: Vec<u16> =
            (0..10).map(|i| preferred.wrapping_add(i)).collect();
        candidates.push(0);
        let mut bound = None;
        for p in candidates {
            let attempt = (|| -> Result<tokio::net::TcpListener> {
                let sock = tokio::net::TcpSocket::new_v4()?;
                #[cfg(unix)]
                sock.set_reuseport(true)?;
                #[cfg(windows)]
                sock.set_reuseaddr(true)?;
                sock.bind(
                    format!("0.0.0.0:{p}")
                        .parse::<SocketAddr>()
                        .map_err(|e| ForgeError::Protocol(format!("bind inválido: {e}")))?,
                )?;
                Ok(sock.listen(128)?)
            })();
            match attempt {
                Ok(l) => {
                    bound = Some(l);
                    break;
                }
                Err(_) => continue,
            }
        }
        bound.ok_or_else(|| ForgeError::Protocol("sem porta TCP livre".into()))?
    };
    let port = listener.local_addr()?.port();
    engine.listen_port.store(port, Ordering::Relaxed);
    info!(port, "listener TCP ativo");

    // NAT automático — igual torrent: abre a porta no roteador sem o usuário
    // fazer nada (UPnP e, se faltar, NAT-PMP). RENOVA a cada 15min (keepalive
    // do mapeamento; o lease é 1h) e re-descobre o gateway ao trocar de rede;
    // falha nunca trava (segue hole punch/relay).
    {
        let port_upnp = port;
        let ext_port = engine.nat_external_port.clone();
        tokio::spawn(async move {
            loop {
                nat_map_port(port_upnp, ext_port.clone()).await;
                sleep(NAT_RENEW_INTERVAL).await;
            }
        });
    }

    // Anúncio automático para bootstrap público (tracker) — não precisa digitar IP igual torrent via tracker/DHT
    {
        let engine_clone = engine.clone();
        let port_clone = port;
        tokio::spawn(async move {
            // Multi-tracker: FORGE_BOOTSTRAP_URL aceita lista separada por vírgula
            // (self-hostable via `forge-host --bootstrap PORTA`). Sem trackers
            // configurados, announce/descovery por tracker ficam DESLIGADOS —
            // UPnP e endereço manual continuam funcionando normalmente.
            let trackers: Vec<String> = std::env::var("FORGE_BOOTSTRAP_URL")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| s.starts_with("http"))
                .collect();
            // NÃO há fallback HTTP automático (ntfy.sh removido): a descoberta
            // principal é local-first/P2P — LAN (UDP/mDNS), MQTT announce
            // (push), STUN/UPnP/NAT-PMP para endpoint público e hole punching.
            // Trackers HTTP só existem se o usuário self-hostar via
            // FORGE_BOOTSTRAP_URL (opcional, nunca obrigatório).
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
            // 30s (era 5s): corta o tráfego para os brokers MQTT públicos
            // (bom cidadão — evita rate-limit/ban). O endpoint fica retido no
            // serviço por horas, então a descoberta direta continua funcionando;
            // o 1º tick é imediato (anuncia no boot) e o relay cobre o resto.
            let mut tick = interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                // PRIVACIDADE: announce/lookup só nos modos "normal"/"encrypted".
                // Em "proxy"/"full" (Tor/SOCKS5) o IP NUNCA vai a serviço de
                // terceiros — reqwest não passa pelo SOCKS5 do engine, então
                // este loop vazaria o IP real mesmo em modo anônimo.
                let privacy_mode = engine_clone
                    .store
                    .kv_get("privacy.mode")
                    .unwrap_or_else(|| "encrypted".to_string());
                if matches!(privacy_mode.as_str(), "proxy" | "full") {
                    continue;
                }
                let fp = engine_clone.identity.fingerprint.clone();
                let nickname = engine_clone.identity.nickname.clone();
                // IP público via UPnP (gateway da casa) — com CACHE de 5min:
                // search_gateway SSDP trava segundos a cada tick e atrasava o
                // gatilho do relay. Cache estático (IP muda raro).
                // NÃO há mais chamada a api.ipify.org/externos aqui: sob CGNAT o
                // IP externo do roteador é inútil (inbound nunca chega — quem
                // resolve é STUN + relay MQTT + hole punching); anunciar um IP
                // inalcançável só gerava dials condenados (o famoso "0 peers").
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
                // Kill-switch de teste (FORGE_NO_ANNOUNCE): desliga announce/
                // lookup de endpoint — eleição fica relay-only e determinística.
                let announce_on = announce_discovery_enabled();
                // Endpoint PÚBLICO a anunciar. Ordem de preferência:
                // 1) STUN — mapeamento REAL visto pelo NAT (funciona sob CGNAT
                //    mesmo sem UPnP/NAT-PMP; cache interno de ~60s);
                // 2) UPnP/NAT-PMP (porta externa mapeada) ou ip público + porta interna.
                // Sem nenhum dos dois: NÃO anuncia (comportamento legado intacto).
                let ext_port = engine_clone.nat_external_port.load(Ordering::Relaxed);
                let stun_addr = if !announce_on {
                    None
                } else if ext_port == 0 {
                    let sa = crate::net::stun::stun_external_addr().await;
                    // Diagnóstico global: STUN ok (tem binding NAT) ou não —
                    // sem isso a UI não sabe se o direto era sequer possível.
                    engine_clone.diag_record_net(|d| {
                        d.stun_ok = Some(sa.is_some());
                        d.stun_addr = sa.map(|s| s.to_string());
                        d.stun_ms = crate::identity::now_ms();
                    });
                    sa
                } else {
                    None
                };
                // Endpoint PÚBLICO a anunciar.
                //
                // REGRA (torrent/c.BitTorrent): só se anuncia um endpoint em que
                // o TCP realmente pode chegar. O STUN é UDP — ele prova que
                // existe IP público e um binding UDP, e NADA sobre o TCP. Por
                // isso:
                //  - ext_port != 0 (UPnP/NAT-PMP abriu o TCP de fato) → anuncia
                //    a porta externa mapeada. É o caminho confiável.
                //  - public_ip conhecido (ipify/HTTP) E sem NAT (bind 0.0.0.0
                //    alcançável) → anuncia ip:porta_escuta.
                //  - só STUN, sem porta externa comprovada → NÃO anuncia. Antes
                //    anunciava `ip_stun:porta_interna`, e o par fazia dial nesse
                //    endereço e recebia "Connection refused"/timeout em loop
                //    (14+ tentativas por peer, até cair no relay). Pior que
                //    anunciar nada: o tracker mentia sobre nossa alcançabilidade.
                //    Sem anúncio, o relay/DHT/túnel continuam funcionando — são
                //    rotas que não dependem de porta aberta.
                let announced: Option<(String, u16)> = if ext_port != 0 {
                    let ip = public_ip
                        .or_else(|| stun_addr.map(|s| s.ip().to_string()));
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
                        // Só anunciamos com porta TCP comprovada (UPnP/NAT-PMP),
                        // então a origem honesta é sempre upnp. ip público sem
                        // NAT é o outro caso válido (LAN/internet direto).
                        if ext_port != 0 {
                            "upnp".to_string()
                        } else {
                            "public-ip".to_string()
                        }
                    });
                });
                if let Some((addr, announced_port)) = announced {
                    // Trackers HTTP self-hosted (opcionais) — não-bloqueante,
                    // NUNCA no caminho crítico: falha de tracker não atrasa o
                    // anúncio MQTT nem o hole punching.
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
                    // guarda p/ Punch (hole punching precisa do próprio endpoint público)
                    *engine_clone
                        .public_addr
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some(addr.clone());
                    // A UI da mídia consome o endpoint NAT via evento (degrau
                    // real: "upnp" = mapeamento local sem servidor).
                    let nat_source = if stun_addr.is_some() { "stun" } else { "upnp" };
                    let _ = engine_clone.events.send(EngineEvent::NatEndpoint {
                        addr: addr.clone(),
                        source: nat_source.into(),
                    });
                    // ANÚNCIO multi-estrada (direto P2P): publica o endpoint
                    // também nas pernas MQTT — quem alcançar qualquer perna
                    // disca DIRETO (baixa latência); relay fica de fallback.
                    // Kill-switch: sem relay, NÃO publica no tópico de anúncio do
                    // backend (o anúncio por tracker self-hosted via reqwest segue,
                    // pois é o que descobre o endpoint DIRETO).
                    if relay_allowed(&engine_clone) {
                        // `addr` = endpoint público (hairpin NAT costuma falhar
                        // na MESMA LAN); `lan` = IP local:porta (direto garantido
                        // na mesma rede). Quem recebe tenta o LAN primeiro.
                        let lan = local_lan_ip().map(|ip| format!("{ip}:{port_clone}"));
                        let ann = serde_json::json!({ "fp": fp, "addr": addr, "lan": lan, "nickname": nickname, "port": announced_port }).to_string();
                        let ann_topic = crate::net::relay::announce_topic(&fp);
                        let abackend = active_relay_backend(&engine_clone);
                        tokio::spawn(async move {
                            abackend.post(&ann_topic, &ann).await.ok();
                        });
                    }
                }
                if let Ok(pending) = engine_clone.store.list_friends(Some("pending_out")) {
                    for peer in pending {
                        // DIRETA via anúncio multi-estrada (v4.3.6): endpoint
                        // publicado pelo peer em qualquer perna (MQTT) →
                        // dial direto de baixa latência. Relay continua em
                        // paralelo; a eleição prefere a direta.
                        if announce_on && relay_allowed(&engine_clone) {
                            let ann_topic = crate::net::relay::announce_topic(&peer.fp);
                            let abackend = active_relay_backend(&engine_clone);
                            if let Ok(msgs) = abackend.poll(&ann_topic).await {
                                for raw in msgs.iter().rev().take(3) {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
                                        let f = v.get("fp").and_then(|x| x.as_str()).unwrap_or("");
                                        if f == peer.fp {
                                            // LAN primeiro (mesma rede = direto garantido),
                                            // depois o endpoint público.
                                            let lan = v.get("lan").and_then(|x| x.as_str());
                                            let pubip = v.get("addr").and_then(|x| x.as_str());
                                            for cand in [lan, pubip].into_iter().flatten() {
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
                        // RELAY PRIMEIRO (v4.3): sem porta aberta a direta falha — o
                        // relay conecta na hora; se a direta funcionar, ela vence
                        // na eleição. Só disca se não há tentativa em curso.
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
                // RELAY para amigos aceitos offline (v4.3): outbox de DM e
                // flush de amizade precisam do peer ONLINE — sem porta aberta
                // só o relay alcança. Sem tentativa em curso → disca.
                // UPGRADE AGRESSIVO relay→direta: mesmo COM sessão relay viva,
                // tenta o endpoint direto em background a cada tick (o anúncio
                // `distorrent_a_<fp>` pode ter chegado depois do relay). O dial
                // direto não derruba o relay (anti-flap em set_link_state); se
                // fechar, a eleição em register_and_run promove a direta.
                // Não-bloqueante via LookupAnnounce (poll do anúncio numa task
                // à parte — o tick de 5s não espera a rede).
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
                                    let online = l.get_state() == PeerLinkState::Online;
                                    (true, online && !l.via_relay)
                                }
                            }
                        };
                        // Direta já online → nada a fazer. Relay online ou
                        // offline → tenta direta em background (novo anúncio?).
                        // OUTBOUND-FIRST: consulta o tracker SEMPRE (independe
                        // do relay) — quem tem NAT só SAI; o dial de entrada vem
                        // do lado alcançável. Sem isto, relay-off nunca rediscava
                        // o endpoint anunciado de amigo aceito.
                        if !is_direct_online {
                            tracker_lookup_and_dial(&engine_clone, &peer.fp, &trackers).await;
                            engine_clone
                                .cmd_tx
                                .send(EngineCmd::LookupAnnounce(peer.fp.clone()))
                                .ok();
                            // DHT BitTorrent: rodízio de get_peers no infohash
                            // do amigo (rendezvous descentralizado, sem relay).
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

    // REMOVIDO: poll legado de friend requests via ntfy.sh (15s). Era uma
    // dependência externa lenta e o relay MQTT (push, ~RTT) já entrega os
    // pedidos de amizade de forma confiável — o caminho MQTT é o principal.

    {
        let engine = engine.clone();
        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        let engine = engine.clone();
                        tokio::spawn(async move {
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

    // 2) Discovery LAN (opcional — off em testes/solo)
    let (disc_tx, mut disc_rx) = mpsc::unbounded_channel::<DiscoveredPeer>();
    let _discovery = if discovery_enabled {
        Some(
            Discovery::spawn(
                engine.keypair.clone(),
                engine.nickname.clone(),
                port,
                disc_tx.clone(),
            )
            .await?,
        )
    } else {
        None
    };

    // 2b) mDNS/DNS-SD na mesma LAN (igual torrent local): anuncia
    // `_distorrent._tcp.local.` e resolve peers no mesmo canal do UDP.
    // Mesmo flag do discovery UDP (`start_with_discovery(false)` desliga
    // ambos). Falha de multicast (ex.: Android sem permissão) é só logada —
    // nunca panica nem quebra o boot; o fallback é o UDP atual.
    let _mdns = if discovery_enabled {
        match crate::net::mdns::MdnsDiscovery::spawn(
            engine.keypair.clone(),
            engine.nickname.clone(),
            port,
            disc_tx,
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

    // 2.5) PEX gossip — Internet P2P sem central (v3.1)
    {
        let engine_pex = engine.clone();
        tokio::spawn(crate::net::dht::spawn_pex(engine_pex));
    }

    // DHT MAINLINE BITTORRENT — descoberta descentralizada (BEP-5): o app
    // anuncia o próprio endpoint no infohash da identidade e acha amigos via
    // get_peers na rede BitTorrent pública. Sem servidor, sem relay obrigatório.
    {
        let engine_dht = engine.clone();
        tokio::spawn(crate::net::dht::spawn_bit_dht(engine_dht));
    }

    // 2.6) Relay global — todo mundo na mesma rede, sem porta aberta (v4.3).
    // Roda sempre (inclusive com discovery off): o tópico é o endereço.
    {
        let engine_relay = engine.clone();
        tokio::spawn(relay_manager_loop(engine_relay));
    }

    // 2.6b) Prewarm do relay no boot: conecta (TCP+MQTT) e ASSINA o tópico
    // próprio ANTES do 1º dial — o subscribe era lazy (só no 1º poll) e o 1º
    // Hello caía no vazio (broker sem subscriber), custando +1 resend de 3s
    // no primeiro contato. `poll()` no MqttRelay garante client+pump+
    // subscribe (1ª vez); nas demais pernas é no-op barato. Roda em paralelo
    // com listener/discovery (não atrasa o boot).
    {
        let engine_prewarm = engine.clone();
        tokio::spawn(async move {
            // Kill-switch: sem relay, não pré-connecta/assina nada.
            if !relay_allowed(&engine_prewarm) {
                return;
            }
            let backend = active_relay_backend(&engine_prewarm);
            let my_fp = engine_prewarm.identity.fingerprint.clone();
            let _ = backend.poll(&relay_topic(&my_fp)).await;
            debug!("relay prewarm ok");
        });
    }

    // 3) Loop principal: descobertas + flush periódico do outbox
    let mut flush_tick = interval(Duration::from_secs(5));
    // Ticker de amizade: reenvia pedidos pendentes enquanto online (auto-cura
    // se um frame de amizade se perdeu no relay). 5s = recupera rápido sem
    // floodar (1 frame pequeno por peer pendente).
    let mut friend_tick = interval(Duration::from_secs(5));
    loop {
        tokio::select! {
            Some(peer) = disc_rx.recv() => {
                if peer.fp == engine.identity.fingerprint { continue; }
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
                // DIRETA AGRESSIVA: mesmo com sessão relay viva, tenta a direta
                // em background (eleição prefere direta; o dial paralelo não
                // derruba o relay — ver set_link_state anti-flap). Sem isso,
                // LAN com relay nunca upgradava (fresh==false bloqueava).
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
                // Reaper de DMs sem ACK: sessão relay agora sobrevive a perda
                // (não morre mais por 1 frame perdido), então uma DM que se
                // perdeu ficaria "sent" para sempre. A cada tick, mensagens
                // 'sent'/'sending' mais velhas que 20s voltam a PENDING e são
                // reenviadas pela sessão VIVA (dedup por id no receptor).
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
                // Auto-cura da amizade: reenvia pedidos 'pending_out' a peers
                // online. Cobre perda do FriendRequest OU do FriendAccept de volta
                // (o receptor reenvia o aceite — ver handler de FriendRequest).
                for fp in engine.online_peer_fps() {
                    engine.retry_pending_friend_request(&fp);
                }
            }
        }
    }
}

async fn command_loop(engine: Arc<NetworkEngine>, mut rx: mpsc::UnboundedReceiver<EngineCmd>) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            EngineCmd::ConnectTo(addr, expected_fp) => {
                // Dedup por destino: 1 laço direto por `fp@addr`. Sem isto, a
                // descoberta (mDNS/bootstrap/announce) re-engatilhava N laços
                // concorrentes para o mesmo peer (vazamento de tarefas + redial).
                let key = format!("{}@{addr}", expected_fp.as_deref().unwrap_or(""));
                let fresh = {
                    let mut set = engine
                        .direct_maintains
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if set.len() > 4096 {
                        set.clear();
                    } // anti-crescimento (addr muda raro)
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
                // Idempotente: um maintain eterno por peer (bootstrap insiste a
                // cada 5s; disconnect remove o link mas o maintain velho segue).
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
                let engine = engine.clone();
                tokio::spawn(async move { punch_and_register(engine, fp, endpoint, at_ms).await });
            }
            EngineCmd::SendToPeer(fp, frame) => {
                // Via de informação (Fase 2): com túnel pronto e peer só-via-
                // relay, o frame interno viaja CIFRADO pela sessão do túnel
                // (TunnelData → handle_tunnel_data → handle_frame), em vez de
                // livre no corpo da sessão relay. Frames do PRÓPRIO túnel
                // (TunnelOffer/Answer/Data) sempre vão crus (carrier).
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
                    // grande demais para o túnel? cai no caminho normal abaixo.
                }
                let link = engine
                    .links
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&fp)
                    .cloned();
                if let Some(l) = link {
                    if let Some(tx) = &l.tx {
                        // QoS: classifica e enfileira com prioridade — a writer
                        // task drena em rajadas priorizadas (ver register_and_run).
                        tx.send((frame_class(&frame), frame)).ok();
                    }
                }
            }
            EngineCmd::FlushOutbox(fp) => {
                // Antes de mandar: desiste das que estouraram o orçamento, para
                // a UI mostrar 'failed' em vez de a mensagem ficar 'enviando'
                // para sempre (o laço infinito de retransmissão).
                for id in engine.store.give_up_outbox(&fp).unwrap_or_default() {
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
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(fp.clone(), SecureFrame::Msg(env)))
                        .ok();
                    // Bump CONTA a tentativa e agenda o próximo com backoff —
                    // sem isto o reenvio é a cada flush (5s) indefinidamente.
                    engine.store.bump_outbox(&m.id).ok();
                    engine.store.set_message_status(&m.id, "sending").ok();
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id: m.id,
                        status: "sending".into(),
                    });
                }
                // após o flush de DM, grupos pendentes também saem
                flush_group_to_peer(&engine, &fp);
                // e as reações que ficaram presas no offline
                engine.flush_pending_reacts(&fp);
            }
        }
    }
}

/// Grupos não têm outbox por peer: no flush, cada mensagem pendente do autor
/// vai para o peer conectado SE ele for membro do grupo. Enquanto estiver
/// 'sending' (sem ACK) é reenviada; o ACK do receptor marca 'delivered'.
/// Antes das mensagens, reenvia o estado do grupo (GroupCreated) — quem ficou
/// offline na criação recebe a conversa completa ao reconectar.
fn flush_group_to_peer(engine: &Arc<NetworkEngine>, peer_fp: &str) {
    // 1) resync do estado dos grupos em que o peer participa
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
                    },
                ))
                .ok();
        }
    }
    // 2) mensagens pendentes do autor
    let pending = match engine.store.pending_group_messages() {
        Ok(p) => p,
        Err(_) => return,
    };
    for m in pending {
        if m.author_fp != me {
            continue; // só o autor reenvia
        }
        let members = engine
            .store
            .list_group_members(&m.conv_id)
            .unwrap_or_default();
        if members.iter().all(|(fp, _)| fp != peer_fp) {
            continue; // peer não pertence ao grupo
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

/// Alvo de conexão: IP:porta direto ou host:porta (domínio DNS / .onion).
#[derive(Debug, Clone)]
enum ConnTarget {
    Addr(SocketAddr),
    Host(String, u16),
}

/// DNS normal (modo sem proxy): resolve host e conecta na primeira resposta.
async fn resolve_and_connect(host: &str, port: u16) -> Result<TcpStream> {
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| ForgeError::Protocol(format!("DNS de {host} falhou: {e}")))?
        .collect();
    let mut last = ForgeError::Protocol("sem endereço".into());
    for sa in addrs {
        match timeout(CONNECT_TIMEOUT, TcpStream::connect(sa)).await {
            Ok(Ok(s)) => return Ok(s),
            Ok(Err(e)) => last = ForgeError::Protocol(format!("connect {sa}: {e}")),
            Err(_) => last = ForgeError::Protocol("connect timeout".into()),
        }
    }
    Err(last)
}

/// Conecta, mantém e reconecta com backoff exponencial (1s→15s). Loop eterno.
async fn connect_and_maintain(
    engine: Arc<NetworkEngine>,
    target: ConnTarget,
    expected_fp: Option<String>,
) {
    let mut backoff = Duration::from_secs(1);
    loop {
        if let Some(fp) = &expected_fp {
            set_link_state(&engine, fp, PeerLinkState::Connecting);
        }

        let attempt = async {
            // Proxy/Tor sério: se modo proxy (1 proxy) ou Tor 7 nós, roteia via SOCKS5 para esconder IP
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
                    std::env::var("FORGE_TOR_ADDR").unwrap_or_else(|_| "127.0.0.1:9050".to_string())
                } else {
                    std::env::var("FORGE_PROXY_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:1080".to_string())
                };
                match timeout(CONNECT_TIMEOUT, socks5_connect(&proxy_addr, &socks_target)).await {
                    Ok(Ok(s)) => s,
                    Ok(Err(e)) => {
                        // .onion NUNCA tem fallback direto (impossível sem Tor) — falha limpa
                        let is_onion =
                            matches!(&target, ConnTarget::Host(h, _) if h.ends_with(".onion"));
                        if is_onion {
                            return Err(e);
                        }
                        debug!("proxy {proxy_addr} falhou ({e}) — tentando direto (fallback)");
                        match &target {
                            ConnTarget::Addr(sa) => {
                                timeout(CONNECT_TIMEOUT, TcpStream::connect(*sa))
                                    .await
                                    .map_err(|_| ForgeError::Protocol("connect timeout".into()))??
                            }
                            ConnTarget::Host(h, p) => resolve_and_connect(h, *p).await?,
                        }
                    }
                    Err(_) => return Err(ForgeError::Protocol("proxy connect timeout".into())),
                }
            } else {
                match &target {
                    ConnTarget::Addr(sa) => timeout(CONNECT_TIMEOUT, TcpStream::connect(*sa))
                        .await
                        .map_err(|_| ForgeError::Protocol("connect timeout".into()))??,
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
                    return Err(ForgeError::Protocol(format!(
                        "peer apresentou {} mas esperávamos {want}",
                        hs.peer_fp
                    )));
                }
            }
            Ok::<_, ForgeError>(hs)
        };

        match attempt.await {
            Ok(hs) => {
                backoff = Duration::from_secs(1);
                let fp = hs.peer_fp.clone();
                engine.diag_record_direct_ok(&fp);
                // Tor voltou a funcionar (ou outro caminho fechou): zera a
                // contagem de timeouts do fallback para o túnel.
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
                )
                .await;
                if !registered {
                    // perdemos a eleição de sessão (o par mantém outra) —
                    // não mexe em estado; só espera e verifica de novo.
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
                set_link_state(&engine, &fp, PeerLinkState::Reconnecting);
            }
            Err(e) => {
                debug!(target = ?target, "conexão falhou: {e}");
                // Diagnóstico honesto na UI: por que o direto não fecha?
                if let Some(fp) = &expected_fp {
                    engine.diag_record_direct_err(
                        fp,
                        &match &e {
                            ForgeError::Protocol(p) => p.clone(),
                            other => other.to_string(),
                        },
                    );
                }
                // Direto falhou: alimenta a corrente de fallback (degrau 3).
                if let Some(fp) = &expected_fp {
                    engine.note_dial_failure(fp);
                }
                // TOR com 3 TIMEOUTS SEGUIDOS → cai para o túnel virtual
                // (handshake X25519 via relay, sem depender do Tor).
                // Só conta timeout de verdade; outro erro não entra.
                if let Some(fp) = &expected_fp {
                    let mode = engine
                        .store
                        .kv_get("privacy.mode")
                        .unwrap_or_else(|| "encrypted".to_string());
                    let err_s = match &e {
                        ForgeError::Protocol(p) => p.clone(),
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
        sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX);
    }
}

// ---------------- relay: todo mundo na mesma rede, sem abrir porta ----------------
//
// Igual torrent na experiência (zero config), mas sem depender de UPnP/DHT:
//
// - Cada identidade TEM um endereço global: o tópico `distorrent_r_<fp>`.
//   Quem sabe o fingerprint alcança — sem IP, sem porta, sem NAT traversal.
// - O handshake autenticado (ed25519 + transcript) e a sessão ChaCha20Poly1305
//   rodam POR CIMA do relay, byte a byte iguais ao TCP. O relay só vê bytes.
// - Direta sempre vence relay (eleição em register_and_run): o relay é rampa
//   de acesso, não substituto do P2P.
// - Privacidade: em modo proxy/full (Tor/SOCKS5) o relay só é permitido se
//   rotear por túnel SOCKS5 (ver `refresh_relay_for_privacy`).
//   Caso contrário fica DESLIGADO — reqwest direto vazaria o IP real.

/// Relay permitido agora? Em modos anônimos, somente com backend via SOCKS5.
fn relay_allowed(engine: &Arc<NetworkEngine>) -> bool {
    // Kill-switch explícito (FORGE_NO_RELAY / set_relay_disabled): desliga o
    // relay em QUALQUER backend/modo. A direta continua funcionando.
    if engine.relay_disabled.load(Ordering::Relaxed) {
        return false;
    }
    match engine.privacy_mode().as_str() {
        "proxy" | "full" => engine.relay_proxied.load(Ordering::Relaxed),
        _ => true,
    }
}

/// Backend de relay em uso AGORA: o peer-relay (se houver intermediário
/// selecionado e permitido) ou o backend configurado. Preserva o backend
/// injetado por testes (`relay_backend_custom`).
fn active_relay_backend(engine: &Arc<NetworkEngine>) -> Arc<dyn RelayBackend> {
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
    engine
        .relay_backend
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
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

/// true se o frame length-prefixed é Hello/HelloAck/HelloOk em claro (stray
/// de handshake). Sessão cifrada nunca produz isso — só handshake.
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

/// Extrai Hello completo (fp+eph+nonce) para dedupar retransmissão (mesmo
/// eph) vs redial novo (eph distinto). Só o primeiro frame do dial é claro.
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

/// Extrai o fp de um frame de Hello (só o primeiro frame de um dial é claro).
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

/// Prepara um RelayStream de SAÍDA para o peer (post loop + registro).
/// Retorna None se já há handshake vivo para o peer (dial ou respondente em
/// curso) — o maintain dorme e tenta depois, em vez de abrir 2 handshakes com
/// eph distintos (transcripts diferentes confundem o Ack/HelloOk e viram
/// half-open). Entrada obsoleta (receiver morto) é limpa e o dial prossegue.
fn relay_dial_stream(engine: &Arc<NetworkEngine>, peer_fp: &str) -> Option<RelayStream> {
    {
        let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = map.get(peer_fp) {
            if !tx.is_closed() {
                return None; // handshake em curso — não duplica
            }
            map.remove(peer_fp); // obsoleta — limpa e prossegue
        }
    }
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    engine
        .relay_in
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(peer_fp.to_string(), in_tx);
    let (out_tx, out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let backend = active_relay_backend(engine);
    tokio::spawn(relay_post_loop(
        backend,
        engine.identity.fingerprint.clone(),
        peer_fp.to_string(),
        out_rx,
    ));
    Some(RelayStream::new(in_rx, out_tx))
}

/// Disca via relay com maintain+backoff (espelho do connect_and_maintain).
/// Usa `handshake_stream_relay` (Hello retransmitido a cada 5s, leitura 30s)
/// — 1 Hello perdido não mata a tentativa. Backoff com jitter 0-1s para dois
/// lados não rediscarem em lockstep (evita Hello cruzado sistemático).
async fn connect_relay_and_maintain(engine: Arc<NetworkEngine>, fp: String) {
    // Backoff inicial curto (1s) e teto baixo (10s): no 4G a sessão cai com
    // frequência e o usuário sente cada segundo. Jitter evita redial em lockstep.
    let mut backoff = Duration::from_secs(1);
    loop {
        let online = engine
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&fp)
            .map(|l| l.get_state() == PeerLinkState::Online)
            .unwrap_or(false);
        if online {
            sleep(Duration::from_secs(4)).await; // vigia curto: detecta queda rápido
            continue;
        }
        engine.refresh_peer_relay();
        if relay_allowed(&engine) || engine.peer_relay_fp().is_some() {
            set_link_state(&engine, &fp, PeerLinkState::Connecting);
            debug!(%fp, "relay: discando (sem porta aberta)");
            // Métrica de primeiro contato: t0 do dial até o online.
            let dial_t0 = std::time::Instant::now();
            let Some(stream) = relay_dial_stream(&engine, &fp) else {
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
                    )
                    .await;
                    set_link_state(&engine, &fp, PeerLinkState::Reconnecting);
                }
                Ok(Ok(hs)) => {
                    debug!(esperado = %fp, apresentou = %hs.peer_fp, "relay: fp inesperado — descarta");
                    engine.diag_record_relay_err(
                        &fp,
                        &format!("relay respondeu fp estranho ({})", hs.peer_fp),
                    );
                    engine.note_dial_failure(&fp);
                }
                Ok(Err(e)) => {
                    debug!(%fp, "relay dial falhou ({e}) — tenta de novo no backoff");
                    engine.diag_record_relay_err(&fp, &format!("relay handshake: {e}"));
                    engine.note_dial_failure(&fp);
                }
                Err(_) => {
                    debug!(%fp, "relay dial timeout — peer offline? tenta de novo no backoff");
                    engine.diag_record_relay_err(
                        &fp,
                        "sem resposta no relay — peer offline ou relay bloqueado",
                    );
                    engine.note_dial_failure(&fp);
                }
            }
        } else {
            // Nem relay utilizável nem intermediário: degrau 2 esgotado —
            // alimenta a corrente de fallback (degrau 3).
            engine
                .diag_record_relay_err(&fp, "relay desligado neste modo (kill-switch/privacidade)");
            engine.note_dial_failure(&fp);
        }
        // Jitter 0-1000ms: quebra sincronia com o peer (ambos em backoff
        // idêntico 1s→2s→4s→8s rediscariam juntos para sempre).
        let jitter_ms = {
            use rand::Rng;
            rand::thread_rng().gen_range(0..1000)
        };
        sleep(backoff + Duration::from_millis(jitter_ms)).await;
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
}

/// Atende UM Hello chegado pelo relay (handshake respondente), FORÇANDO
/// substituição mesmo com sessão/handshake vivos (redial novo com peer ONLINE:
/// a sessão velha half-open será substituída via eleição em register_and_run).
fn spawn_relay_responder_force(engine: Arc<NetworkEngine>, from: String, first_frame: Vec<u8>) {
    // Mata a sessão velha ANTES do novo handshake: os Pings dela (ciphertext)
    // cairiam no inbound do respondente novo (que espera HelloOk em claro) e
    // matariam o handshake antes de nascer. register_and_run já faria a
    // substituição DEPOIS, mas o estrago ocorre DURANTE.
    {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = links.remove(&from) {
            old.drop_notify.notify_waiters();
        }
    }
    engine.emit_state();
    let (in_tx, in_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    {
        let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
        map.insert(from.clone(), in_tx.clone()); // sobrescreve a sessão velha
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
                )
                .await;
            }
            _ => {
                debug!(%from, "relay respondente (force) falhou/timeout");
            }
        }
    });
}

/// Atende UM Hello chegado pelo relay (handshake respondente).
fn spawn_relay_responder(engine: Arc<NetworkEngine>, from: String, first_frame: Vec<u8>) {
    // direta online? não gasta handshake à toa
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
                return; // outro respondente/dial já cuidando
            }
            map.remove(&from); // obsoleto — assume
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
                )
                .await;
            }
            _ => {
                debug!(%from, "relay respondente falhou/timeout");
            }
        }
        // sessão morta ou handshake falho: a entrada cai quando o manager
        // observar send falho — aqui só garante que ENTRADA VELHA não trave
        // redial futuro se o stream morreu sem frames pendentes.
    });
}

/// Poller do relay: remonta frames do próprio tópico e roteia para a sessão
/// do remetente; Hello sem sessão vira handshake respondente.
///
/// Poll com JITTER 1000-1500ms (não `interval` fixo): dois peers com loop
/// em fase travariam em Hello cruzado sistemático (mesma fase de poll + mesmo
/// backoff de dial = tentativa simultânea eterna). O jitter dessincroniza.
/// 1000-1500ms (era 2000-2800ms): cada voo do handshake custa ~1 poll, então
/// o caminho feliz cai de ~7s para ~3.5s de poll; pernas com push (MQTT)
/// acordam via wake em ~RTT de todo jeito.
/// Strays pós-handshake (Hello/Ack/Ok duplicados por retransmissão) com peer
/// já ONLINE são descartados aqui — senão cairiam no inbound da sessão como
/// ciphertext inválido e derrubariam um túnel saudável.
async fn relay_manager_loop(engine: Arc<NetworkEngine>) {
    let mut reasm = Reassembler::new();
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    // Último Hello por peer (eph+nonce): distingue retransmissão do MESMO
    // Hello (mesmo eph — dial reenvia a cada 5s) de redial NOVO (eph distinto,
    // ex.: após morte de sessão por perda). Duplicata com peer ONLINE é stray
    // (descarta); redial novo com peer ONLINE força respondente novo (substitui
    // a sessão half-open quebrada sem esperar o Ping timeout de 60s).
    let mut last_hello: std::collections::HashMap<String, ([u8; 32], [u8; 16])> =
        std::collections::HashMap::new();
    // Primeira volta imediata (sem esperar tick); depois dorme com jitter.
    let mut first = true;
    // Push das pernas MQTT: cada wake vira uma rodada de poll imediata
    // (recebimento em ~RTT em vez de até 2.8s do tick).
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
    loop {
        if !first {
            // Intervalo adaptativo (latência mínima sem abusar da infra):
            // pernas com push (MQTT, inclusive via túnel SOCKS5) mantêm o
            // tick original — o wake entrega em ~RTT e o tick é só fallback;
            // pernas sem push usam 400ms, cortando o pior caso de ~1,5s para
            // ~0,7s no recebimento.
            let has_push = {
                let backend = active_relay_backend(&engine);
                !backend.wakes().is_empty()
            };
            // Com push (MQTT) o wake entrega em ~RTT; sem push,
            // 0,8–1,2s — bom equilíbrio entre latência e não
            // sobrecarregar o serviço público (evita rate-limit/ban).
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
                    // drena rajadas: uma rodada cobre tudo que chegou
                    while wake_rx.try_recv().is_ok() {}
                }
            }
        }
        first = false;
        // Atualiza o intermediário peer-relay (menor fp direto online) antes
        // de decidir a rodada. O peer-relay funciona SEM broker público, então
        // a rodada acontece se o relay público está ligado OU há intermediário.
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
            // dedupe barato (poll pode repetir): hash do conteúdo, janela 1024
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
            // (F3) Envelope opaco do peer-relay não traz identidade. Deriva o
            // remetente do Hello em claro; frames de sessão sem identidade são
            // difundidos aos streams de relay (o AEAD só autentica no dono).
            let hello = parse_relay_hello_full(&frame);
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
            // Hello? Decide duplicata vs redial ANTES de rotear.
            if let Some(hello) = &hello {
                if !from.is_empty() && hello.fp != from {
                    continue; // envelope forjado (from != Hello.fp) — lixo
                }
                let key = (hello.eph_pub, hello.nonce);
                let dup = last_hello.get(&from) == Some(&key);
                if dup {
                    // Retransmissão do MESMO Hello: com peer ONLINE é stray
                    // pós-handshake (descarta — a sessão ignora de todo jeito);
                    // sem sessão/handshake em curso, entrega ao handshake vivo
                    // (ele reenvia o MESMO Ack).
                    if is_online(&engine, &from) {
                        continue;
                    }
                } else {
                    // Hello NOVO (primeiro ou redial com eph distinto).
                    last_hello.insert(from.clone(), key);
                    if last_hello.len() > 512 {
                        last_hello.clear();
                    }
                    if is_online(&engine, &from) {
                        // Redial com sessão (half-open?) viva: força respondente
                        // novo que SUBSTITUI via eleição (sem esperar 120s).
                        debug!(%from, "relay: redial novo com sessão viva — novo respondente");
                        spawn_relay_responder_force(engine.clone(), from.clone(), frame.clone());
                        continue;
                    }
                    // Sem sessão: cai no fluxo abaixo (roteia se handshake vivo,
                    // senão spawna respondente).
                }
            } else if !from.is_empty()
                && is_online(&engine, &from)
                && is_relay_handshake_frame(&frame)
            {
                // Ack/Ok duplicado (HelloOk 3x, Ack reenviado) com peer ONLINE:
                // stray — descarta sem matar a sessão (a SessionReader também
                // ignora, aqui é a primeira barreira).
                continue;
            }
            // (F3) Opaco sem identidade (frame de sessão peer-relay): difunde
            // a todos os streams de relay. Cada SessionReader tenta decifrar
            // dentro da janela de nonces; só o peer dono autentica o AEAD e os
            // demais apenas descartam (sem matar a sessão).
            if from.is_empty() {
                let map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
                for tx in map.values() {
                    let _ = tx.send(frame.clone());
                }
                continue;
            }
            // sessão relay existente? entrega
            let routed = {
                let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
                match map.get(&from) {
                    Some(tx) => match tx.send(frame.clone()) {
                        Ok(()) => true,
                        Err(_) => {
                            map.remove(&from); // stream morto — cai para Hello abaixo
                            false
                        }
                    },
                    None => false,
                }
            };
            if routed {
                continue;
            }
            // sem sessão: só Hello inicia conversa (ciphertext sem dono é lixo)
            if let Some(hello_fp) = parse_relay_hello(&frame) {
                if hello_fp == from {
                    debug!(%from, "relay: Hello recebido — atendendo");
                    spawn_relay_responder(engine.clone(), from, frame);
                }
            }
        }
    }
}

/// Sessão online de um peer: writer task + reader loop com heartbeat/timeito.
///
/// Eleição de sessão (dial simultâneo é comum: discovery + manual + inbound):
/// o peer com fingerprint MENOR mantém a sessão que ELE iniciou (outbound);
/// o maior mantém a inbound. Direta SEMPRE vence relay (relay é fallback).
/// Retorna `true` se esta sessão foi a registrada, `false` se foi descartada.
async fn register_and_run(
    engine: Arc<NetworkEngine>,
    session: Session,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    initiator: bool,
    via_relay: bool,
    peer_proto_v: u32,
) -> bool {
    let my_fp = engine.identity.fingerprint.clone();
    let i_prefer_outbound = my_fp.as_str() < peer_fp; // menor fp prefere a própria dial
    let this_is_my_preference = initiator == i_prefer_outbound;

    {
        let links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = links.get(peer_fp) {
            if existing.get_state() == PeerLinkState::Online {
                // direta vence relay nos dois sentidos
                if !existing.via_relay && via_relay {
                    debug!(peer_fp, "sessão relay descartada (direta já online)");
                    return false;
                }
                if this_is_my_preference || (existing.via_relay && !via_relay) {
                    debug!(peer_fp, "eleição: sessão preferida substitui a atual");
                } else {
                    debug!(
                        peer_fp,
                        "sessão descartada (par já online, preferência dele)"
                    );
                    return false;
                }
            }
        }
    }

    // peer autenticado pelo handshake — persiste
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
    });
    let replaced = {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        links
            .insert(peer_fp.to_string(), link.clone())
            .filter(|old| old.get_state() == PeerLinkState::Online)
    };
    if let Some(old) = replaced {
        old.drop_notify.notify_waiters(); // encerra a sessão antiga (substituída pela preferida)
    }
    info!(peer_fp, %peer_nick, via_relay, "peer ONLINE");
    // Sessão online: a corrente se recompôs — zera falhas do fallback automático.
    engine.reset_dial_failures(peer_fp);
    // Guarda o proto do peer (gate dos frames do túnel: Tunnel* exige >= 2).
    // MAX = nunca rebaixa por flapping de sessão (peer novo não vira legado).
    {
        let mut map = engine
            .peer_protos
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        map.entry(peer_fp.to_string())
            .and_modify(|v| {
                if peer_proto_v > *v {
                    *v = peer_proto_v;
                }
            })
            .or_insert(peer_proto_v);
    }
    let _ = engine.events.send(EngineEvent::PeerOnline {
        fp: peer_fp.into(),
        nickname: peer_nick.into(),
        via_relay,
    });
    engine.emit_state();

    // HOLE PUNCH (estilo torrent/Radmin): sessão relay viva + peer com
    // proto_v>=1 → pede furo TCP simultâneo para meu endpoint público. Não
    // é só 1x: um loop com backoff curto REENVIA o Punch enquanto a sessão
    // for relay (o TCP simultaneous open converge mesmo com perda/timing
    // ruim) e para sozinho quando a direta vence a eleição. Nunca envia a
    // peer legado (proto 0).
    if via_relay && peer_proto_v >= 1 && engine.punch_enabled() {
        spawn_punch_upgrade(engine.clone(), peer_fp.to_string());
    }

    // Flush IMEDIATO (era 5s de espera): frames de sessão que chegarem ao
    // respondente antes do HelloOk NÃO são mais descartados — o handshake
    // relay os guarda no stash e os replaya na sessão (ReplayRead no
    // transport), então postar Msg/Ping logo após o HelloOk não dessincroniza
    // o nonce ChaCha. Ganho medido: -5s no primeiro contato (MemRelay:
    // RequestIn 9.6s → ~4s). Sem spawn: `cmd_tx` é unbounded (nunca bloqueia)
    // e `frame_tx` bufferiza até a writer task nascer logo abaixo.
    {
        // Só flusha se ESTA sessão ainda é a vigente (evita ressuscitar
        // outbox numa sessão velha já substituída — aqui acabou de registrar,
        // então é sempre a vigente).
        // FLUSH IMEDIATO (sem spawn/tick): outbox + amizade + joins + CHAMADAS.
        // CallOffer/Answer/Ice enfileirados offline (pending_calls) saem agora,
        // na ordem, com latência de ~RTT — sem isso o invite pré-online se
        // perdia e o ICE inicial atrasava a chamada sobre relay.
        //
        // Antes do flush: varredor anti-buraco-negro — "sent" velho sem ACK
        // (ex.: saiu pelo relay milissegundos antes do peer upgradear para
        // direta, caindo no receiver morto dele) volta a pending e é reenviado
        // AGORA pela sessão nova. Corte 20s (relay RTT ~2s); receptor dedupa.
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
    }

    // writer task: drena comandos → cifra e envia. QoS em duas etapas:
    //   1) drena o canal para filas por classe (4 classes, FIFO dentro de cada)
    //   2) monta um lote ponderado (realtime primeiro, com cotas por classe
    //      para evitar inanição do bulk) e envia em UMA escrita TCP
    //    → menos syscalls (batching) e voz/sinalização nunca atrás de arquivo.
    let (mut reader, mut writer_session) = session.split();
    let writer: JoinHandle<()> = tokio::spawn(async move {
        let mut queues: [VecDeque<SecureFrame>; 4] = [
            VecDeque::new(),
            VecDeque::new(),
            VecDeque::new(),
            VecDeque::new(),
        ];
        // cota por classe no lote: realtime jamais monopoliza; bulk sempre
        // anda quando presente. Bulk tem teto menor por ser pesado (1MiB/frame).
        const BATCH_CAP: usize = 16;
        const CLASS_CAP: [usize; 4] = [8, 4, 12, 4];
        loop {
            if queues.iter().all(|q| q.is_empty()) {
                match frame_rx.recv().await {
                    Some((p, f)) => queues[(p as usize).min(3)].push_back(f),
                    None => break,
                }
            }
            // drena o que já chegou (sem bloquear) — agrupa rajadas em 1 write
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
                continue; // só drenagem de estado (não deve ocorrer)
            }
            // métricas por classe com o tamanho REAL do wire (send_batch reporta)
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

    // heartbeat ADAPTATIVO: começa no intervalo base; a cada intervalo sem
    // RECEBER nada, dobra (degraus) até o teto. Qualquer frame recebido
    // reseta ao base. Ocioso = menos pings = menos rádio/acordos (mobile).
    // Teto direto = 30s (pinhole NAT: requisito documentado — Ping <= ~30s
    // mantém mapeamento vivo); relay = 120s (não há pinhole TCP próprio).
    // Timeout escala com o intervalo atual: timeout = max(base_timeout, 2.5x intervalo).
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

    // reader: decifra/valida
    let read_result = loop {
        let cur_interval = steps[idle_step.min(steps.len() - 1)];
        let cur_timeout = std::cmp::max(base_timeout, cur_interval.mul_f64(2.5));
        tokio::select! {
            res = timeout(cur_timeout, reader.recv_sized::<SecureFrame>()) => {
                match res {
                    Err(_) => break Err(ForgeError::Protocol(format!("ping timeout ({:?} sem frames)", cur_timeout))),
                    Ok(Err(e)) => break Err(e),
                    Ok(Ok((frame, wire))) => {
                        idle_step = 0; // atividade: heartbeat volta ao mínimo
                        ping_at = tokio::time::Instant::now() + base_interval;
                        crate::metrics::metrics().frame_rx(
                            crate::metrics::FrameClass::by_index(frame_class(&frame)),
                            wire as u64,
                        );
                        if let Err(e) = handle_frame(&engine, peer_fp, peer_pubkey, peer_nick, frame).await {
                            debug!("frame rejeitado de {peer_fp}: {e}");
                        }
                    }
                }
            }
            _ = tokio::time::sleep_until(ping_at) => {
                // nada recebido desde o último evento → degrau de ociosidade
                idle_step = (idle_step + 1).min(steps.len() - 1);
                ping_at = tokio::time::Instant::now() + steps[idle_step];
                if frame_tx.send((0, SecureFrame::Ping { ts: crate::identity::now_ms() })).is_err() {
                    break Err(ForgeError::PeerNotConnected(peer_fp.into()));
                }
            }
            _ = link.drop_notify.notified() => break Ok(()),
        }
    };

    writer.abort();
    // só remove o link se ainda for ESTE (a eleição pode ter registrado outro)
    let removed = {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        match links.get(peer_fp) {
            Some(current) if Arc::ptr_eq(current, &link) => links.remove(peer_fp).is_some(),
            _ => false,
        }
    };
    if removed {
        // não confirmadas → PENDING again (outbox)
        if let Ok(ids) = engine.store.revert_unacked_to_pending(peer_fp) {
            for id in ids {
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: id,
                    status: "pending".into(),
                });
            }
        }
        // grupos: mensagens out não confirmadas voltam a PENDING (flush de
        // grupo reenvia ao reconectar)
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
        engine.emit_state();
    }
    true
}

/// Lookup único de endpoint (direta imediata, sem esperar o tick de 5s).
/// Usado no pedido/aceite: se o peer já anunciou, a direta sai na hora e
/// vence o relay na eleição.
fn announce_lookup_once(engine: Arc<NetworkEngine>, peer_fp: String) {
    tokio::spawn(async move {
        // Kill-switch: sem relay, nada a consultar no backend (a descoberta
        // direta segue pelo tracker self-hosted via reqwest, independente dele).
        if !relay_allowed(&engine) {
            return;
        }
        // Kill-switch de teste: FORGE_NO_ANNOUNCE desliga a descoberta direta
        // via anúncio (testes relay-only precisam da eleição determinística).
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
                        // LAN primeiro (mesma rede = direto garantido), depois público.
                        let lan = v.get("lan").and_then(|x| x.as_str());
                        let pubip = v.get("addr").and_then(|x| x.as_str());
                        for cand in [lan, pubip].into_iter().flatten() {
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
                    }
                }
            }
        }
    });
}

/// Upgrade relay→direta AGRESSIVO e REPETIDO: enquanto a sessão com
/// `peer_fp` estiver ONLINE via relay, reenvia `SecureFrame::Punch` (com
/// folga no `at_ms`) em backoff curto, para que AMBOS os lados furem o NAT
/// repetidamente até o TCP simultaneous open pegar. Encerra sozinho quando
/// a direta vence a eleição (link deixa de ser `via_relay`) ou a sessão cai
/// (o próximo `register_and_run` relança). Uma task por peer.
fn spawn_punch_upgrade(engine: Arc<NetworkEngine>, peer_fp: String) {
    // Kill-flag: desligado, nem cria o loop.
    if !engine.punch_enabled() {
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
        // Backoff curto e teto baixo (2s→3s→…→8s + jitter): o furo tem
        // janela de tempo; esperar demais deixa a sessão presa no relay.
        let mut backoff = Duration::from_secs(2);
        loop {
            // Parou? direta venceu (não é mais via_relay) ou sessão caiu.
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
            // Kill-flag pode ter ligado/desligado em runtime.
            if !engine.punch_enabled() {
                break;
            }
            // Endpoint público próprio. Normalmente o tick de announce já
            // preencheu `public_addr` (UPnP ou STUN). Se ainda não houver e o
            // modo de privacidade permitir, consulta STUN na hora (cacheado)
            // — sob CGNAT sem UPnP é a única forma de publicar nossa porta
            // externa REAL para o peer furar.
            // IMPORTANTE: solta o guard do `public_addr` ANTES do await —
            // MutexGuard (std) não é `Send` e não pode cruzar o ponto de
            // suspensão da task.
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
            // Folga de ~1,5s: dá tempo do peer armar o listener do furo
            // mesmo com relógios/CPU diferentes (receptor clampa [0,10s]).
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
        // Só remove se ainda for a MINHA geração: se um novo registro já
        // criou outro loop (geração maior), não rouba a chave dele.
        let mut map = engine
            .punch_upgrades
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if map.get(&peer_fp) == Some(&generation) {
            map.remove(&peer_fp);
        }
    });
}

/// Furo TCP simultâneo coordenado (hole punching estilo torrent/Radmin):
/// disca A PARTIR da porta de escuta local para o endpoint público do peer.
/// Se ambos furarem juntos, NATs full-cone/restricted deixam passar e a
/// direta nasce sem servidor no caminho (eleição prefere direta). Se o NAT
/// não colaborar (simétrico), falha rápido e o relay segue.
///
/// AGRESSIVO: em vez de 1 dial, dispara `PUNCH_PARALLEL` tentativas em
/// paralelo com stagger curto (o 1º SYN às vezes se perde). Cada
/// tentativa bem-sucedida registra a sessão; a eleição descarta duplicadas.
async fn punch_and_register(
    engine: Arc<NetworkEngine>,
    want_fp: String,
    endpoint: String,
    at_ms: u64,
) {
    if !engine.punch_enabled() {
        return;
    }
    let Ok(remote) = endpoint.parse::<SocketAddr>() else {
        return;
    };
    // espera o instante combinado (tolerância ±10s de relógio entre peers)
    let now = crate::identity::now_ms();
    let wait = (at_ms as i64 - now).clamp(0, 10_000) as u64;
    sleep(Duration::from_millis(wait)).await;
    // direta já nasceu por outro caminho? não gasta furo à toa
    if engine.peer_state(&want_fp) == NetworkState::Connected && !engine.is_peer_via_relay(&want_fp)
    {
        return;
    }
    // Furo UDP best-effort JUNTO do TCP (µTP/STUN-like): em paralelo, não
    // atrasa os dials TCP; pinhole UDP pode ajudar NATs endpoint-independent.
    tokio::spawn(crate::net::transport::udp_punch_probe(remote));
    const PUNCH_PARALLEL: usize = 3;
    // Reenvio com backoff DENTRO de um mesmo Punch (2 rodadas de 3 dials com
    // stagger): o 1º SYN às vezes se perde; o loop externo de `Punch` reenvia
    // a coordenação, mas 2 rodadas locais convergem mais rápido.
    const PUNCH_ROUNDS: usize = 2;
    for round in 0..PUNCH_ROUNDS {
        if !engine.punch_enabled() {
            return;
        }
        // outra tentativa/caminho já fechou direta → para
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

/// UMA tentativa de furo: dial a partir da porta de escuta, handshake e
/// registra se o fp conferir. Devolve true se uma direta foi registrada.
async fn punch_once(engine: &Arc<NetworkEngine>, want_fp: &str, remote: SocketAddr) -> bool {
    // direta já nasceu por outra tentativa/outro caminho?
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

/// Limita tamanho de string vinda de peer (anti-DoS de storage; safe em
/// boundary UTF-8 — nunca panica no meio de um codepoint).
/// Sanitiza strings de exibição vindas da rede (nicknames, tópicos):
/// corta, remove controles/invisíveis e colapsa espaços — anti-injeção.
/// Nunca recebe segredos/mensagens (só metadados de exibição).
fn cap_str(s: &str, max: usize) -> String {
    crate::names::sanitize_text(s, max)
}

/// Base64 de mídia: só o alfabeto válido e teto de tamanho (anti-abuso).
fn cap_b64(s: &str, max: usize) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=')
        .take(max)
        .collect()
}

/// Normaliza presença (allowlist — nunca string arbitrária do peer).
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
    /// O peer pode moderar esta comunidade? (dono, moderador listado ou cargo
    /// com a permissão). Usado por ban/timeout/delete.
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
                    role_ids.iter().any(|rid| rid == &r.id) && (r.permissions & (crate::moderation::PERM_BAN | crate::moderation::PERM_MUTE | crate::moderation::PERM_DELETE)) != 0
                })
            })
            .unwrap_or(false)
    }

    /// A comunidade dona deste `conv_id`, se ele for um canal de servidor.
    /// Para DM/grupo não existe comunidade — é o que separa os dois mundos de
    /// autorização (moderador de canal vs.participant de conversa).
    pub fn community_of_conv(&self, conv_id: &str) -> Option<String> {
        self.store.channel_community(conv_id).ok().flatten()
    }

    /// Peers que compartilham a mesma conversa — destino das difusões de
    /// reação/edição/pin/encaminhamento.
    ///
    /// Um `conv_id` tem TRÊS formatos possíveis e os três precisam resolver:
    ///   • DM 1:1   → linha em `conversations`
    ///   • grupo    → `group_members`
    ///   • canal    → `channels.community_id` → TODOS os membros online
    /// O caso do canal é o que a maior parte da UI usa: sem ele, uma reação
    /// numa mensagem de servidor é gravada localmente e nunca chega a ninguém.
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
        // canal de comunidade: difunde para os membros (o host é o relay, mas
        // um membro conectado direto também precisa receber).
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

    /// O peer tem alguma autoridade sobre este `conv_id`? Autor da conversa é
    /// moderator de DM/grupo; em canal, vale o moderador da COMUNIDADE.
    pub fn can_moderate_conv(&self, conv_id: &str, fp: &str) -> bool {
        match self.community_of_conv(conv_id) {
            Some(cid) => self.is_moderator(&cid, fp),
            None => self.social_peers_of(conv_id).iter().any(|p| p == fp),
        }
    }

    /// Envia um frame da camada social para TODOS os membros online da
    /// comunidade (dono → membros). É o canal de autoridade do servidor.
    pub fn broadcast_social(&self, community_id: &str, frame: SecureFrame) {
        let Ok(members) = self.store.list_members(community_id) else {
            return;
        };
        for (fp, _, _) in members {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx.send(EngineCmd::SendToPeer(fp, frame.clone())).ok();
            }
        }
    }

    /// Publica a NOSSA presença para todos os peers conectados (após mudança
    /// de status ou quando um peer novo entra).
    pub fn announce_presence(&self) {
        let Ok(p) = self.store.presence_get(&self.identity.fingerprint) else {
            return;
        };
        if p.status == "invisible" {
            return; // invisível = não sinaliza nada
        }
        let frame = SecureFrame::PresenceSet {
            status: p.status,
            custom: p.custom,
            custom_emoji: p.custom_emoji,
        };
        for peer in self.store.list_peers().unwrap_or_default() {
            if peer.fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&peer.fp).is_some() {
                self.cmd_tx.send(EngineCmd::SendToPeer(peer.fp, frame.clone())).ok();
            }
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
    // Transcript da oferta: zeros no lado respondente (resposta futura).
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
        let mut meta = engine
            .tunnel_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
    let answer_transcript =
        tunnel_transcript(peer_fp, &eph, &nonce, &my_fp, &my_eph, &my_nonce);
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
                if p.nonce == for_nonce
                    && crate::identity::now_ms() - p.created_ms < 120_000 =>
            {
                p
            }
            _ => return, // resposta órfã/tardia ou para outra oferta
        }
    };
    let my_fp = engine.identity.fingerprint.clone();
    let transcript =
        tunnel_transcript(&my_fp, &x25519_dalek::PublicKey::from(&pending.secret).to_bytes(), &pending.nonce, peer_fp, &eph, &nonce);
    if Keypair::verify(peer_pubkey, &transcript, sig).unwrap_or(false) != true {
        debug!(peer_fp, "tunel: resposta com assinatura inválida — ignora");
        return;
    }
    {
        let mut meta = engine
            .tunnel_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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

fn handle_tunnel_data(
    engine: &Arc<NetworkEngine>, peer_fp: &str, nonce: u64, ct_b64: &str) {
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
        match sess.open(&peer_fp.to_string(), &engine.identity.fingerprint, nonce, &ct) {
            Ok(v) => v,
            Err(_) => return, // replay/forjado — descarta em silêncio
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
                reasm.insert(
                    peer_fp,
                    id,
                    idx,
                    total,
                    chunk,
                    crate::identity::now_ms(),
                )
            };
            match full {
                Some(v) => v,
                None => return, // ainda remontando
            }
        }
        TunMsg::Invalid => return,
    };
    // ping/pong da Fase 1: prefixo no payload (mesma semântica, com RTT).
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
                engine.cmd_tx
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
    // Fase 2: payload = SecureFrame JSON — despacha pelo dispatch normal.
    let frame: SecureFrame = match serde_json::from_slice(&payload) {
        Ok(f) => f,
        Err(_) => return,
    };
    engine.diag_update(peer_fp, |d| {
        d.tunnel_rx_frames = d.tunnel_rx_frames.saturating_add(1);
    });
    let (tun_pubkey, tun_nick) = {
        let meta = engine
            .tunnel_meta
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        meta.get(peer_fp)
            .cloned()
            .unwrap_or_else(|| (String::new(), peer_fp.chars().take(8).collect()))
    };
    let engine_inner = engine.clone();
    let fp_owned = peer_fp.to_string();
    tokio::spawn(async move {
        if let Err(e) = handle_frame(
            &engine_inner,
            &fp_owned,
            &tun_pubkey,
            &tun_nick,
            frame,
        )
        .await
        {
            debug!(%fp_owned, "tunel: frame interno falhou: {e}");
        }
    });
    engine.tunnel_housekeep(peer_fp);
}


async fn handle_frame(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    // GATE anti-spam/segurança: sinalização de chamada/tela 1:1 só é aceita de
    // AMIGO JÁ ACEITO. Sem isto qualquer peer conectado (grupo/comunidade ou um
    // dial direto de estranho) podia te LIGAR (CallInvite → toca o telefone) e
    // injetar SDP/ICE numa chamada — vetor de spam/abuso. Espelha "DM só de amigo".
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
        let is_friend = engine
            .store
            .get_friend(peer_fp)
            .ok()
            .flatten()
            .map(|(_, s)| s == "accepted")
            .unwrap_or(false);
        // Chamada em GRUPO/canal de voz: o peer pode não ser "amigo" mas é do
        // mesmo grupo/comunidade — senão a sinalização de mídia do mesh era
        // bloqueada e a chamada de grupo não funcionava.
        let shares_group = engine
            .store
            .group_convs_with_peer(peer_fp)
            .map(|v| !v.is_empty())
            .unwrap_or(false);
        let shares_comm = engine
            .store
            .list_communities()
            .map(|cs| {
                cs.iter()
                    .any(|(id, _, _)| engine.store.member_role(id, peer_fp).is_some())
            })
            .unwrap_or(false);
        if !is_friend && !shares_group && !shares_comm {
            return Err(ForgeError::Protocol(
                "sinalização de chamada de quem não é amigo".into(),
            ));
        }
    }
    match frame {
        SecureFrame::Msg(env) => {
            // bloqueados não conversam — rejeitado no core, não na UI
            if engine.is_blocked(peer_fp) {
                return Err(ForgeError::Protocol("peer bloqueado".into()));
            }
            // identidade vinculada: autor DEVE ser o peer da conexão
            if env.author_fp != peer_fp {
                return Err(ForgeError::Protocol("author != peer da conexão".into()));
            }
            if !env.verify_with_pubkey(peer_pubkey) {
                return Err(ForgeError::Protocol(
                    "assinatura da mensagem inválida".into(),
                ));
            }
            // RETRANSMISSÃO = a MESMA mensagem de novo (o outbox reenvia a cada
            // backoff enquanto não vier Ack). Precisa ser IDEMPOTENTE: confirmar
            // e sair, sem penalizar o peer e sem gerar evento novo.
            //
            // BUG que isto corrige (o "recebo a mesma mensagem infinitas
            // vezes"): antes, a retransmissão caía no `spam_gate`, whose
            // duplicata-por-conteúdo (60s) rejeitava com Err — e a rejeição
            // acontecia ANTES do `Ack`, então o remetente nunca era avisado e
            // reenviava de novo, para sempre. Pior: o INSERT OR IGNORE
            // devolvia Ok nas tentativas futuras que passassem pelo gate, e o
            // `MessageNew` era emitido de novo a cada uma (som + badge +
            // lista piscando em rajada) — o dedupe real só existia na linha
            // do banco, nunca no evento.
            //
            // Aqui o id é a chave: já temos essa mensagem? Então é reenvio.
            // Confirma, não penaliza, não emite. O peer legítimo que mandou a
            // mesma mensagem DUAS VEZES de verdade tem id diferente, então
            // continua passando pelo spam_gate como antes.
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
            // anti-spam P2P (flood/duplicada/link) — depois da assinatura
            engine.spam_gate(peer_fp, &env.body)?;
            // grupo: autor precisa ser membro do grupo local; DM: conv_id determinístico
            let conv_kind = engine.store.get_conversation(&env.conv_id)?.map(|c| c.kind);
            if conv_kind.as_deref() == Some("group") {
                let is_member = engine
                    .store
                    .list_group_members(&env.conv_id)?
                    .iter()
                    .any(|(fp, _)| fp == &env.author_fp);
                if !is_member {
                    return Err(ForgeError::Protocol("autor não é membro do grupo".into()));
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
            {
                // lazy-join HONESTO: grupo desconhecido de um AMIGO aceito — cria
                // localmente com o autor como único membro (não forja outros).
                // O GroupCreated autoritativo chega no flush e corrige o roster.
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
                // GATE v4.3 (mesma rede, só amigos/servidores): DM de estranho
                // é rejeitada no core — mesmo conectado (LAN/relay), sem
                // amizade aceita não abre conversa. Grupos exigem membresia
                // (acima); comunidades exigem convite (JoinCommunity).
                let is_friend = engine
                    .store
                    .get_friend(peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false);
                if !is_friend {
                    return Err(ForgeError::Protocol("DM apenas de amigo aceito".into()));
                }
                let conv = engine.open_dm(peer_fp, peer_nick)?;
                if env.conv_id != conv.id {
                    return Err(ForgeError::Protocol(
                        "conv_id não corresponde à DM deste peer".into(),
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
            }
        }
        SecureFrame::Ack { msg_id } => {
            if let Some(m) = engine.store.message_by_id(&msg_id)? {
                if m.direction == "out" {
                    // GATE: apenas o destinatário confirma — DM ⇒ peer da
                    // conversa; grupo ⇒ membro do grupo. Canais de comunidade
                    // usam ChannelAck (gated no host). Sem isso, um peer
                    // qualquer falsifica "delivered" de mensagens de terceiros.
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
                        return Err(ForgeError::Protocol("Ack de peer não autorizado".into()));
                    }
                    engine.store.set_message_status(&msg_id, "delivered")?;
                    // grupo não usa outbox por peer — nada a remover da fila
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
            // RTT real medido sobre Ping/Pong (EMA no registry global) —
            // alimenta o painel dev e o diagnóstico por peer. Amostras acima
            // do timeout máximo de sessão são lixo (replay/ts zerado) e não
            // entram no EMA.
            let now = crate::identity::now_ms();
            if now >= ts {
                let rtt = (now - ts) as u64;
                if rtt <= RELAY_PING_TIMEOUT.as_millis() as u64 {
                    crate::metrics::metrics().rtt_sample(peer_fp, rtt);
                }
            }
        }
        SecureFrame::FriendRequest { nickname } => {
            if engine.is_blocked(peer_fp) {
                return Ok(()); // silenciosamente ignora bloqueados
            }
            let nick = cap_str(&nickname, 64);
            let existing = engine
                .store
                .get_friend(peer_fp)
                .ok()
                .flatten()
                .map(|(_, s)| s);
            match existing.as_deref() {
                // JÁ somos amigos: isto é um retry (rede de segurança). O ACEITE
                // pode ter se perdido no caminho → reenvia (idempotente).
                // NÃO rebaixa para pending_in (isso "desfaria" a amizade).
                Some("accepted") => {
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
                // Pedido CRUZADO (os dois se adicionaram): aceita na hora, igual
                // Discord — ninguém fica esperando o outro aceitar.
                Some("pending_out") => {
                    engine.store.set_friend(peer_fp, &nick, "accepted")?;
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
                        nickname,
                    });
                }
                _ => {
                    engine.store.set_friend(peer_fp, &nick, "pending_in")?;
                    let _ = engine.events.send(EngineEvent::FriendRequestIn {
                        fp: peer_fp.into(),
                        nickname,
                    });
                }
            }
        }
        SecureFrame::FriendAccept { nickname } => {
            // GATE: só vale como resposta a um pedido NOSSO pendente — sem isso
            // qualquer peer conectado se insere como "amigo aceito" na lista.
            // "accepted" também passa: flush_friend_requests reenvia o aceite
            // a cada reconexão (re-sync legítimo).
            let status = engine
                .store
                .get_friend(peer_fp)
                .ok()
                .flatten()
                .map(|(_, s)| s);
            if !matches!(status.as_deref(), Some("pending_out") | Some("accepted")) {
                return Err(ForgeError::Protocol(
                    "FriendAccept sem pedido pendente".into(),
                ));
            }
            engine
                .store
                .set_friend(peer_fp, &cap_str(&nickname, 64), "accepted")?;
            let _ = engine.events.send(EngineEvent::FriendAccepted {
                fp: peer_fp.into(),
                nickname,
            });
        }
        SecureFrame::FriendReject => {
            engine.store.remove_friend(peer_fp)?;
            let _ = engine
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }
        SecureFrame::FriendRemove => {
            engine.store.remove_friend(peer_fp)?;
            let _ = engine
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }
        SecureFrame::JoinCommunity {
            community_id,
            token,
        } => {
            // HOST: valida token assinado pelo DONO (eu, neste caso)
            let comm = engine
                .store
                .get_community(&community_id)?
                .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
            if comm.2 != engine.identity.fingerprint {
                return Err(ForgeError::Protocol("só o host aceita joins".into()));
            }
            let (tok_host, _cid, member_fp, exp, sig) =
                crate::protocol::parse_invite_token(&token)?;
            const WILDCARD: &str = "000000000000";
            let bound = member_fp == WILDCARD || member_fp == peer_fp;
            if tok_host != engine.identity.fingerprint || _cid != community_id || !bound {
                return Err(ForgeError::Protocol(
                    "token não corresponde a este peer".into(),
                ));
            }
            if crate::identity::now_ms() > exp {
                return Err(ForgeError::Protocol("convite expirado".into()));
            }
            if !Keypair::verify(
                &engine.keypair.public_hex(),
                &crate::protocol::invite_sign_bytes(&community_id, &member_fp, exp),
                &sig,
            )? {
                return Err(ForgeError::Protocol(
                    "convite com assinatura inválida".into(),
                ));
            }
            engine
                .store
                .upsert_member(&community_id, peer_fp, peer_nick, "member")?;
            // resposta direta ao joiner + sincroniza os demais membros online
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
        } => {
            // MEMBRO: só aceita estado vindo do HOST REAL. O `owner_fp` do
            // frame NÃO é confiável (vem do remetente) — a autoridade é o dono
            // GRAVADO localmente; no primeiro sync pós-join (comunidade ainda
            // inexistente), o host deve bater com o fp assinado no convite
            // pendente. Sem este gate, qualquer peer conectado sequestra a
            // comunidade (full sync sobrescreve owner/canais/cargos/bots).
            if peer_fp != owner_fp {
                return Err(ForgeError::Protocol(
                    "CommunityState com owner forjado".into(),
                ));
            }
            let allowed = match engine
                .store
                .get_community(&community_id)?
                .map(|(_, _, o)| o)
            {
                Some(stored_owner) => stored_owner == peer_fp,
                None => engine
                    .pending_joins
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&community_id)
                    .and_then(|tok| crate::protocol::parse_invite_token(tok).ok())
                    .map(|(host_fp, tok_cid, _, _, _)| {
                        host_fp == peer_fp && tok_cid == community_id
                    })
                    .unwrap_or(false),
            };
            if !allowed {
                return Err(ForgeError::Protocol("CommunityState fora do host".into()));
            }
            // sync completo em uma transação: canais (removidos no host somem
            // aqui), cargos, bots, assignments e membros + meta do wizard (v6)
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
            )?;
            engine
                .pending_joins
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&community_id);
            let _ = engine
                .events
                .send(EngineEvent::CommunityJoined { community_id, name });
        }
        SecureFrame::CommunityKicked { community_id } => {
            // frame só chega por sessão autenticada; checamos que veio do dono
            // e aproveitamos o nome para a mensagem de erro (antes de apagar)
            let (is_host, name) = engine
                .store
                .get_community(&community_id)?
                .map(|(_, n, owner)| (owner == peer_fp, n))
                .unwrap_or((false, community_id.clone()));
            if !is_host {
                return Err(ForgeError::Protocol("CommunityKicked fora do host".into()));
            }
            engine.store.community_remove_local(&community_id)?;
            engine
                .pending_joins
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&community_id);
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
        } => {
            // quem envia é o dono do grupo: precisa constar na lista dele mesmo
            if !members.iter().any(|(fp, _)| fp == peer_fp) {
                return Err(ForgeError::Protocol(
                    "GroupCreated sem o criador na lista".into(),
                ));
            }
            if members.len() > 10 {
                return Err(ForgeError::Protocol(
                    "GroupCreated com roster acima do limite".into(),
                ));
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
            // remetente precisa já ser membro do grupo local
            let known = engine
                .store
                .list_group_members(&conv_id)?
                .iter()
                .any(|(f, _)| f == peer_fp);
            if !known {
                return Err(ForgeError::Protocol(
                    "GroupMemberAdded de fora do grupo".into(),
                ));
            }
            engine.store.add_group_member(&conv_id, &fp, &nickname)?;
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
                .ok_or_else(|| ForgeError::Protocol("comunidade inexistente".into()))?;
            let is_host = comm.2 == engine.identity.fingerprint;
            // v6 GATE: mensagem "de bot" só vale vinda do HOST (quem executa
            // o bot) e o bot precisa existir — sem isto, um membro qualquer
            // falsifica posts de terceiros.
            let bot_id = if bot_id.trim().is_empty() {
                String::new()
            } else {
                if !is_host {
                    return Err(ForgeError::Protocol("mensagem de bot fora do host".into()));
                }
                if !engine
                    .store
                    .bots_list(&community_id)?
                    .iter()
                    .any(|b| b.id == bot_id)
                {
                    return Err(ForgeError::Protocol("bot inexistente".into()));
                }
                bot_id.trim().to_string()
            };
            if is_host {
                // HOST: autor membro + canal existente + assinatura + vínculo à conexão
                if engine
                    .store
                    .member_role(&community_id, &env.author_fp)
                    .is_none()
                {
                    return Err(ForgeError::Protocol("autor não é membro".into()));
                }
                if !engine
                    .store
                    .list_channels(&community_id)?
                    .iter()
                    .any(|(id, _)| *id == channel_id)
                {
                    return Err(ForgeError::Protocol("canal inexistente".into()));
                }
                // o envelope é assinado sobre conv_id — tem que ser o canal alvo
                if env.conv_id != channel_id {
                    return Err(ForgeError::Protocol("env.conv_id != canal".into()));
                }
                if !env.verify_with_pubkey(peer_pubkey) {
                    return Err(ForgeError::Protocol("assinatura inválida".into()));
                }
                if env.author_fp != peer_fp {
                    return Err(ForgeError::Protocol("author != peer da conexão".into()));
                }
                // anti-spam + regras do servidor (shadow-ban, palavras, domínios)
                engine.spam_gate(peer_fp, &env.body)?;
                engine.server_rules_gate(&community_id, &env.author_fp, &env.body)?;
                // ban / timeout / slowmode aplicados AO AUTOR — o portão de
                // saída roda no cliente de quem envia e não protege o host.
                engine.gate_speech_for(&community_id, &channel_id, &env.author_fp)?;
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
                engine.host_relay(&community_id, &channel_id, &env, &bot_id)?;
            } else {
                // MEMBRO: só aceita relayado PELO HOST
                if peer_fp != comm.2 {
                    return Err(ForgeError::Protocol("ChannelMsg fora do host".into()));
                }
                // o envelope assinado cobre conv_id — tem que ser o canal alvo
                if env.conv_id != channel_id {
                    return Err(ForgeError::Protocol("env.conv_id != canal".into()));
                }
                // autor precisa constar no roster local (sincronizado pelo host)
                if engine
                    .store
                    .member_role(&community_id, &env.author_fp)
                    .is_none()
                {
                    return Err(ForgeError::Protocol("autor não é membro".into()));
                }
                // Verificação de assinatura: a pubkey da SESSÃO é a do HOST —
                // validar com ela rejeitaria toda mensagem relayada de membros.
                // Mensagem do próprio host: valida com a chave da sessão.
                // Mensagem de membro: valida com a pubkey do AUTOR quando ela
                // está no peerbook; sem pubkey local, o relay do host (sessão
                // autenticada + roster) é a autoridade — mesma confiança de um
                // servidor central. NUNCA se valida com a chave errada.
                let sig_ok = if env.author_fp == peer_fp {
                    env.verify_with_pubkey(peer_pubkey)
                } else {
                    match engine.store.get_peer(&env.author_fp)?.map(|p| p.pubkey_hex) {
                        Some(author_pub) => env.verify_with_pubkey(&author_pub),
                        None => {
                            // Autor desconhecido localmente — aceita via confiança no
                            // relay do host (sessão autenticada + roster validado).
                            // Log de segurança para auditoria.
                            tracing::warn!(
                                channel_msg_no_author_key = %env.author_fp,
                                env_id = %env.id,
                                "channel msg aceita sem verificação de assinatura (autor não está no peerbook)"
                            );
                            true
                        }
                    }
                };
                if !sig_ok {
                    return Err(ForgeError::Protocol("assinatura inválida".into()));
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
                // GATE: quem confirma é o HOST da comunidade dona do canal —
                // um peer qualquer não pode falsificar entrega de canal alheio.
                let ack_ok = engine
                    .store
                    .message_by_id(&env_id)?
                    .map(|m| m.conv_id)
                    .and_then(|conv| engine.store.channel_community(&conv).ok().flatten())
                    .and_then(|cid| engine.store.get_community(&cid).ok().flatten())
                    .map(|(_, _, owner)| owner == peer_fp)
                    .unwrap_or(false);
                if !ack_ok {
                    return Err(ForgeError::Protocol("ChannelAck fora do host".into()));
                }
                engine.store.set_message_status(&env_id, "delivered")?;
                engine.store.dequeue_outbox(&env_id)?;
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: env_id,
                    status: "delivered".into(),
                });
            }
        }
        SecureFrame::CallInvite {
            call_id,
            kind,
            target_fp: _,
        } => {
            let _ = engine.events.send(EngineEvent::CallIncoming {
                call_id,
                from_fp: peer_fp.into(),
                kind,
            });
        }
        SecureFrame::CallAccept { call_id } => {
            // GATE: aceite só vale para chamada que EU criei (sou o host dela) —
            // evita que peer qualquer se insira em chamadas de terceiros.
            if engine.store.get_call_host(&call_id)?.as_deref()
                != Some(engine.identity.fingerprint.as_str())
            {
                return Err(ForgeError::Protocol(
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
            #[cfg(target_os = "linux")]
            // Saiu da chamada: derruba as sessões nativas daquele par. A
            // chamada em si continua existindo se OUTRO peer estiver nela, e
            // quem decide é o `CallEnd` do host.
            if engine.voice_is_native(&call_id, peer_fp) {
                engine.voice_hangup(&call_id);
            }
            let _ = engine.events.send(EngineEvent::CallEnded {
                call_id,
                from_fp: peer_fp.into(),
            });
        }
        SecureFrame::CallOffer { call_id, sdp } => {
            // PONTO DE INTERCEPTAÇÃO DA VOZ NATIVA.
            //
            // Se — e somente se — o par (call_id, peer_fp) foi registrado como
            // sessão nativa, a oferta é respondida aqui em Rust e o
            // `EngineEvent` NÃO é emitido: a WebView não deve criar
            // `RTCPeerConnection` para uma chamada que o core já está
            // conduzindo (duas RTP na mesma chamada = eco + 2x banda).
            //
            // Sem registro, o `if` nem existe e o comportamento é o de sempre,
            // byte a byte. É esta assimetria que preserva Windows/Android/macOS.
            #[cfg(target_os = "linux")]
            if engine.voice_absorb_offer(&call_id, peer_fp, &sdp).await? {
                return Ok(());
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
            if engine
                .voice_absorb_ice(&call_id, peer_fp, &candidate, &mid)
                .await
            {
                return Ok(());
            }
            let _ = engine.events.send(EngineEvent::CallIceEv {
                call_id,
                from_fp: peer_fp.into(),
                candidate,
                mid,
            });
        }
        SecureFrame::CallAddParticipant { call_id, fp, kind } => {
            let _ = engine.events.send(EngineEvent::CallParticipantAdded {
                call_id: call_id.clone(),
                fp,
                kind: kind.clone(),
            });
            // v6: kind não-vazio = este frame é o RING do convidado —
            // emite CallIncoming (UI toca o telefone) além do badge de roster.
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
            // GATE: apenas membros da comunidade mexem no voice state — sem
            // isso qualquer peer conectado injeta "usuários fantasma" em
            // qualquer canal de voz de qualquer servidor.
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(ForgeError::Protocol("não é membro da comunidade".into()));
            }
            engine
                .store
                .set_voice_state(&community_id, &channel_id, peer_fp, false, false)?;
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
                return Err(ForgeError::Protocol("não é membro da comunidade".into()));
            }
            engine
                .store
                .leave_voice(&community_id, &channel_id, peer_fp)?;
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
                return Err(ForgeError::Protocol("não é membro da comunidade".into()));
            }
            engine
                .store
                .set_voice_state(&community_id, &channel_id, peer_fp, muted, deafened)?;
            let _ = engine.events.send(EngineEvent::VoiceStateChanged {
                community_id,
                channel_id,
                fp: peer_fp.into(),
                muted,
                deafened,
            });
        }
        SecureFrame::FileAnnounce {
            file_id,
            name,
            size,
            chunks,
            hash,
            chunk_hashes,
        } => {
            // Limites anti-DoS: strings curtas e contagem de chunks sanável —
            // a UI itera `chunks` (Array.from) e o hash vira chave no kv.
            if file_id.len() > 128 || name.len() > 255 || hash.len() > 128 {
                return Err(ForgeError::Protocol(
                    "FileAnnounce com campos gigantes".into(),
                ));
            }
            if chunks > 1_000_000 {
                return Err(ForgeError::Protocol(
                    "FileAnnounce com chunks excessivos".into(),
                ));
            }
            let name = cap_str(&name, 255);
            let _ = engine.store.announce_file(
                &file_id,
                &name,
                size as i64,
                chunks as i64,
                &hash,
                peer_fp,
            );
            // persiste chunk_hashes para verificação se vier (compat: None = legado sem verificação)
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
            });
            // também envia evento estendido com chunk_hashes via kv (UI lê ao receber FileAnnounceEv)
        }
        SecureFrame::FileChunkRequest { file_id, index } => {
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
        } => { /* swarm have — UI usa */ }
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
            // PEX: peer confiável (sessão autenticada) compartilha peers que conhece.
            // Validamos cada peer e tentamos conectar nos que ainda não temos —
            // E nos que estão só via relay (upgrade agressivo: direta em
            // background sem derrubar o relay, eleição prefere direta).
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
                } // direta online → nada a fazer
                  // relay vivo (via_relay) → NÃO pula: tenta direta em background
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
        // ---------- peer-relay: intermediário (v0) ----------
        // Guarda o corpo OPACO (ciphertext A↔B) num broker em memória por
        // tópico. NUNCA persiste em disco, NUNCA emite evento de UI e NUNCA
        // cria amizade. Caps anti-DoS ficam no próprio broker. Em modo
        // anônimo (proxy/full) NÃO atua como intermediário.
        SecureFrame::PeerRelayPut { topic, body } => {
            if engine.peer_relay_serving_enabled() {
                // (F1) `put` é livre (qualquer peer publica no tópico de quem
                // lê); o ACL de drenagem fica no `get`.
                let _ = crate::net::peer_relay::put(peer_fp, &topic, &body);
            }
        }
        // Drena o tópico e responde com `PeerRelayData` (correlaciona por
        // req_id). Lista vazia fecha o poll do peer na hora, sem timeout.
        SecureFrame::PeerRelayGet { req_id, topic } => {
            if engine.peer_relay_serving_enabled() {
                // (F1) Só o dono do tópico (peer_fp autenticado) drena.
                let bodies = crate::net::peer_relay::get(peer_fp, &topic, req_id);
                // (F6) Garante que o `PeerRelayData` serializado caiba em MAX_FRAME.
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
        // Sou quem PEDIU: entrego ao backend peer-relay pendente (oneshot).
        SecureFrame::PeerRelayData { req_id, bodies } => {
            // (F2) Só aceita a resposta do INTERMEDIÁRIO ELETADO; um peer
            // qualquer que adivinhe/roube um req_id não entrega nada.
            if engine.peer_relay_fp().as_deref() != Some(peer_fp) {
                debug!(%peer_fp, "peer-relay: PeerRelayData ignorado (não é o intermediário)");
                return Ok(());
            }
            let backend = active_relay_backend(engine);
            if !backend.deliver_peer_relay(req_id, bodies) {
                debug!("peer-relay: PeerRelayData órfão (req_id={req_id})");
            }
        }
        SecureFrame::Bye => return Err(ForgeError::Protocol("peer encerrou (Bye)".into())),
        // ================= camada social v3 =================
        // Tudo aqui é autenticado pela sessão AEAD; ainda assim o motor
        // revalida AUTOR/PERMISSÃO no core (a UI não decide nada).
        SecureFrame::React {
            conv_id,
            msg_id,
            emoji,
            add: add_from_peer,
            reactor_fp: _,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let em = cap_str(&emoji, 16);
            if em.is_empty() {
                return Err(ForgeError::Protocol("reação vazia".into()));
            }
            // Autorização: o peer tem que COMPARTILHAR essa conversa (DM de
            // 1:1 ou grupo). NÃO exigimos que a mensagem já tenha chegado:
            // reação e mensagem viajam em frames diferentes e a ordem não é
            // garantida — exigir o msg aqui descartaria reações legítimas.
            let shared = engine
                .store
                .get_conversation(&conv_id)
                .ok()
                .flatten()
                .is_some()
                || engine
                    .store
                    .list_group_members(&conv_id)
                    .map(|v| !v.is_empty())
                    .unwrap_or(false);
            // AMIGO vale também: num DM a mensagem e a reação saem em frames
            // diferentes e a ordem não é garantida — exigir a conversa já
            // criada no receptor descartaria reações legítimas.
            let is_friend = engine
                .store
                .get_friend(peer_fp)
                .ok()
                .flatten()
                .map(|(_, s)| s == "accepted")
                .unwrap_or(false);
            if !shared && !is_friend {
                return Err(ForgeError::Protocol("reação fora de conversa compartilhada".into()));
            }
            // teto deente de reatores por emoji (anti-abuso)
            let mine = engine
                .store
                .reactions_for_msg(&msg_id)
                .ok()
                .unwrap_or_default()
                .into_iter()
                .find(|r| r.emoji == em)
                .map(|r| r.count)
                .unwrap_or(0);
            if mine >= 64 {
                return Ok(());
            }
            let added = engine
                .store
                .reaction_apply(&msg_id, &conv_id, &em, peer_fp, add_from_peer)
                .map_err(|e| ForgeError::Storage(rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))))?;
            let _ = engine.events.send(EngineEvent::ReactionChanged {
                msg_id: msg_id.clone(),
                conv_id: conv_id.clone(),
                emoji: em.clone(),
                add: added,
                reactor_fp: peer_fp.to_string(),
            });
            // ecoa pros demais membros do mesmo grupo/canal
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::React {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                                emoji: em.clone(),
                                add: added,
                                reactor_fp: peer_fp.to_string(),
                            },
                        ))
                        .ok();
                }
            }
        }
        SecureFrame::Reply { conv_id, msg_id, reply_to } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            // A citação é um metadado da mensagem que a carrega: ela precisa
            // EXISTIR, estar na MESMA conversa e ser do autor que vai citá-la.
            // Sem essas três checagens um peer citava mensagem de conversa
            // alheia (vazamento de contexto) ou fixava um id órfão que a UI
            // não resolvia nunca.
            let Some(mine) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(ForgeError::Protocol("citação de mensagem inexistente".into()));
            };
            if mine.conv_id != *conv_id {
                return Err(ForgeError::Protocol("citação de conversa divergente".into()));
            }
            if mine.author_fp != peer_fp {
                return Err(ForgeError::Protocol("só o autor cita assim".into()));
            }
            let target = engine.store.message_by_id(&reply_to).ok().flatten();
            if target.as_ref().map(|t| &t.conv_id) != Some(&conv_id) {
                return Err(ForgeError::Protocol("alvo de citação inexistente".into()));
            }
            engine.store.msg_set_reply(&msg_id, &conv_id, &reply_to)?;            let _ = engine.events.send(EngineEvent::MessageReply {
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
                return Err(ForgeError::Protocol("edição de mensagem inexistente".into()));
            };
            if orig.conv_id != conv_id {
                return Err(ForgeError::Protocol("conversa divergente".into()));
            }
            // SÓ O AUTOR edita (como no Discord).
            if orig.author_fp != peer_fp {
                return Err(ForgeError::Protocol("só o autor edita".into()));
            }
            let nb = cap_str(&body, 4000);
            if nb.trim().is_empty() {
                return Err(ForgeError::Protocol("corpo vazio".into()));
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
                return Err(ForgeError::Protocol("sem permissão para apagar".into()));
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
            // Fixar mensagem é ato de MODERAÇÃO no Discord. Sem este gate
            // qualquer peer conectado fixava/desfixava em qualquer conversa e o
            // estado se propagava — trancação de canal por terceiros.
            if !engine.can_moderate_conv(&conv_id, peer_fp) {
                return Err(ForgeError::Protocol("sem permissão para fixar".into()));
            }
            let Some(orig) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(ForgeError::Protocol("pin de mensagem inexistente".into()));
            };
            if orig.conv_id != conv_id {
                return Err(ForgeError::Protocol("pin de conversa divergente".into()));
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
            // Encaminhamento = o peer re-assina o conteúdo e entrega. O
            // receptor valida a assinatura dele e mostra a origem.
            if env.author_fp != peer_fp || !env.verify_with_pubkey(peer_pubkey) {
                return Err(ForgeError::Protocol("encaminhamento inválido".into()));
            }
            let label = cap_str(&from_label, 120);
            let _ = engine.store.msg_set_forward(&env.id, &conv_id, &label);
            let _ = engine.store.insert_message(&env, "in", "ok");
            let stored = engine.store.message_by_id(&env.id).ok().flatten();
            if let Some(sm) = stored {
                let _ = engine.events.send(EngineEvent::MessageNew(sm));
            }
            let _ = channel_id;
        }
        SecureFrame::PresenceSet {
            status,
            custom,
            custom_emoji,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let st = normalize_presence(&status);
            let _ = engine
                .store
                .presence_set(peer_fp, st, &cap_str(&custom, 128), &cap_str(&custom_emoji, 16));
            let _ = engine.events.send(EngineEvent::PresenceChanged {
                fp: peer_fp.to_string(),
                status: st.to_string(),
                custom: cap_str(&custom, 128),
                custom_emoji: cap_str(&custom_emoji, 16),
            });
        }
        SecureFrame::PresencePing => {
            let p = engine.store.presence_get(peer_fp).unwrap_or_default();
            let st = if p.status == "offline" { "online".to_string() } else { p.status.clone() };
            engine.cmd_tx.send(EngineCmd::SendToPeer(
                peer_fp.into(),
                SecureFrame::PresenceSet {
                    status: st,
                    custom: p.custom,
                    custom_emoji: p.custom_emoji,
                },
            )).ok();
        }
        SecureFrame::Typing { conv_id, until_ms } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            // Sanidade: só faz sentido para conversa/canal que o peer realmente
            // participa. Sem isto, qualquer peer conectado consegue "digitar" em
            // qualquer DM/canal e a UI mostra o nome de alguém que não está lá.
            if !engine.social_peers_of(&conv_id).iter().any(|p| p == peer_fp) {
                return Ok(());
            }
            // O prazo é do remetente, mas um relógio adiantado/esquecido não pode
            // deixar um "digitando" eterno no receptor: teto de 15s a partir de agora.
            let now = crate::identity::now_ms();
            let until = until_ms.clamp(now, now + 15_000);
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::Typing { conv_id: conv_id.clone(), until_ms: until },
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
                return Err(ForgeError::Protocol("sem permissão para reordenar".into()));
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
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let dn = cap_str(&display_name, 48);
            let ab = cap_str(&about, 400);
            let av = cap_b64(&avatar_b64, 700_000);
            let bn = cap_b64(&banner_b64, 1_400_000);
            let ac = if accent.starts_with('#') && accent.len() == 7 {
                accent
            } else {
                String::new()
            };
            let _ = engine.store.profile_set(peer_fp, &dn, &ab, &av, &bn, &ac);
            // display name vira o nome de exibição da amizade
            if !dn.is_empty() {
                let _ = engine.store.set_friend(peer_fp, &dn, "accepted");
            }
            let p = engine.store.profile_get(peer_fp).unwrap_or_default();
            let _ = engine.events.send(EngineEvent::ProfileChanged {
                fp: peer_fp.to_string(),
                profile: p,
            });
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
                return Err(ForgeError::Protocol("thread só para membro".into()));
            }
            let t = crate::social::ThreadRow {
                id: cap_str(&thread_id, 64),
                community_id: community_id.clone(),
                parent_channel: parent_channel.clone(),
                name: cap_str(&name, 80),
                author_fp: peer_fp.to_string(),
                created_at: crate::identity::now_ms(),
                archived: false,
                kind: if kind == "forum" { "forum".into() } else { "thread".into() },
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
                return Err(ForgeError::Protocol("mensagem de thread inválida".into()));
            }
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(ForgeError::Protocol("thread só para membro".into()));
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
            // Quem aplica é o DONO do servidor (autoridade = dono, como no
            // README: "toda operação validada pelo motor").
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(ForgeError::Protocol("só o dono baneia".into()));
            }
            let _ = engine
                .store
                .ban_set(&community_id, &target_fp, &cap_str(&reason, 300), peer_fp, until_ms);
            // tira o membro localmente (a comunidade já não é acessível)
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
                return Err(ForgeError::Protocol("sem permissão de moderação".into()));
            }
            let _ = engine
                .store
                .timeout_set(&community_id, &target_fp, until_ms, &cap_str(&reason, 300), peer_fp);
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
                return Err(ForgeError::Protocol("só o dono configura".into()));
            }
            let _ = engine
                .store
                .channel_cfg_set(&channel_id, slowmode_secs.clamp(0, 21_600), nsfw, false);
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
                return Err(ForgeError::Protocol("só membro cria enquete".into()));
            }
            let opts: Vec<String> = options.iter().take(10).map(|o| cap_str(o, 80)).collect();
            if opts.len() < 2 {
                return Err(ForgeError::Protocol("enquete precisa de 2+ opções".into()));
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
                return Err(ForgeError::Protocol("enquete encerrada".into()));
            }
            if option_idx < 0 || option_idx as usize >= poll.options.len() {
                return Err(ForgeError::Protocol("opção inválida".into()));
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
        SecureFrame::EventUpsert { community_id, event } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(ForgeError::Protocol("só o dono cria evento".into()));
            }
            let mut ev = event.clone();
            ev.entity_fp = peer_fp.to_string();
            ev.name = cap_str(&ev.name, 100);
            ev.location = cap_str(&ev.location, 120);
            ev.description = cap_str(&ev.description, 500);
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
        SecureFrame::EventInterest { community_id, event_id } => {
            let _ = engine.store.event_interest(&community_id, &event_id, peer_fp);
            let _ = engine.events.send(EngineEvent::EventUpdated {
                community_id: community_id.clone(),
                event_id: event_id.clone(),
            });
        }
        SecureFrame::EmojiUpsert { community_id, emoji } => {
            if !engine.is_moderator(&community_id, peer_fp) {
                return Err(ForgeError::Protocol("sem permissão".into()));
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
            // Kill-flag: sem furo, não diala; o listener segue aceitando um
            // dial inbound normal do peer (então não fechamos a porta).
            if !engine.punch_enabled() {
                return Ok(());
            }
            // Hole punching: o peer (autenticado nesta sessão) pede furo TCP
            // simultâneo para o endpoint público dele. Valida e fura a partir
            // da NOSSA porta de escuta (mesma que o listener usa — o NAT vê
            // saída e abre volta). Handshake valida o fp de verdade depois.
            let Ok(remote) = endpoint.parse::<SocketAddr>() else {
                debug!("punch com endpoint inválido — ignora");
                return Ok(());
            };
            // Loopback é permitido (testes + mesmo host); handshake valida o
            // fp de verdade depois, então endpoint mentiroso não impersona.
            if remote.ip().is_unspecified() || remote.port() == 0 {
                debug!("punch para endereço inválido — ignora");
                return Ok(());
            }
            // já tem direta? não gasta furo à toa
            if engine.peer_state(peer_fp) == NetworkState::Connected
                && !engine.is_peer_via_relay(peer_fp)
            {
                return Ok(());
            }
            // Rate-limit anti-amplificação: um peer autenticado não pode nos
            // forçar a disparar 3 dials (e SYNs) dezenas de vezes por segundo
            // para um alvo arbitrário. 1 Punch/s basta para o furo coordenado.
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
            // delega ao command_loop (PunchDial): fura a partir da NOSSA
            // porta de escuta no instante combinado; handshake valida o fp.
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
    }
    Ok(())
}

/// Erro curto e legível para a UI/diagnóstico (sem paths enormes).
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

fn set_link_state(engine: &Arc<NetworkEngine>, fp: &str, state: PeerLinkState) {
    if fp.is_empty() {
        return;
    }
    {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        // ANTI-FLAP (direta agressiva): dial direto em background NÃO pode
        // derrubar sessão relay viva. `connect_and_maintain` chama isto com
        // Connecting no topo de cada tentativa e com Reconnecting ao sair;
        // se a sessão relay (ou direta vencedora) está Online, o dial paralelo
        // não toca no estado — só a eleição em `register_and_run` troca de
        // sessão (relay→direta quando a direta fecha). Idem no sentido inverso
        // (maintain do relay não rebaixa direta Online).
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
        let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
        let kp = Keypair::generate();
        let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
        (e, dir)
    }

    #[test]
    fn relay_kill_switch_desliga_e_religa() {
        let (e, _d) = mk_engine("KillSwitch");
        // Relay DEFAULT LIGADO (fail-open): era o bug do "0 peers" — opt-in
        // silencioso que ninguém setava. Desliga explicitamente.
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

    /// Regra PURA do novo default: `FORGE_RELAY` ausente ⇒ LIGADO;
    /// `FORGE_RELAY=0/false/no/off` ⇒ desligado (opt-out explícito).
    #[test]
    fn relay_default_fail_open() {
        assert!(env_relay_enabled(), "sem FORGE_RELAY: relay LIGADO");
        for v in ["0", "false", "no", "off"] {
            std::env::set_var("FORGE_RELAY", v);
            assert!(!env_relay_enabled(), "FORGE_RELAY={v} desliga");
        }
        std::env::set_var("FORGE_RELAY", "1");
        assert!(env_relay_enabled(), "FORGE_RELAY=1 liga");
        std::env::remove_var("FORGE_RELAY");
        std::env::set_var("FORGE_NO_RELAY", "1");
        assert!(!env_relay_enabled(), "FORGE_NO_RELAY=1 kill-switch");
        std::env::remove_var("FORGE_NO_RELAY");
    }

    #[test]
    fn backend_injetado_nao_desliga_sozinho() {
        let (e, _d) = mk_engine("Injected");
        e.set_relay_backend(Arc::new(MemRelay::new()));
        // Backend custom nao desliga o relay por si so (testes dependem disso).
        assert!(relay_allowed(&e));
        // So o kill-switch explicito desliga, mesmo com backend injetado.
        e.set_relay_disabled(true);
        assert!(!relay_allowed(&e));
    }

    #[test]
    fn punch_kill_switch_liga_e_desliga() {
        let (e, _d) = mk_engine("PunchSwitch");
        // Default: furo ligado (opt-out só via FORGE_PUNCH=0).
        assert!(e.punch_enabled());
        e.set_punch_enabled(false);
        assert!(!e.punch_enabled(), "FORGE_PUNCH=0 deve desligar o furo");
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
        // Requisito: em sessão direta idle, Ping <= ~30s mantém o pinhole vivo.
        assert!(PING_INTERVAL <= Duration::from_secs(30));
        assert!(NAT_RENEW_INTERVAL < Duration::from_secs(3600));
    }

    /// Intermediário peer-relay: Put guarda ciphertext; Get drena e responde
    /// com PeerRelayData correlacionado por req_id. Nenhum evento de UI.
    #[tokio::test]
    async fn peer_relay_intermediario_put_get_data() {
        let (relay, _d) = mk_engine("PeerRelayC");
        // (F7) peer-relay é opt-in.
        relay.set_peer_relay_enabled(true);
        // command_loop precisa rodar p/ o handle_frame entregar via cmd_tx.
        relay.start_with_discovery(false).unwrap();
        // (F1) tópico precisa ser do DONO (peerB) p/ o get ser autorizado.
        let topic = "distorrent_r_peerB";

        // Link ONLINE DIRETO simulado p/ o peer B (captura o que C devolve).
        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        relay.links.lock().unwrap().insert(
            "peerB".into(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx_b),
                drop_notify: Notify::new(),
                via_relay: false,
            }),
        );

        // A deposita ciphertext no tópico do B (via intermediário C).
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

        // B consulta: C responde PeerRelayData com o conteúdo.
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
                // PeerRelayGet do manager peer-relay (mesmo link fake) — ignora.
                Ok(_) => continue,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        }
        assert_eq!(
            resp.expect("C deveria responder"),
            vec!["CIFRADO".to_string()]
        );

        // Segundo Get: tópico drenado → lista vazia (fecha o poll sem timeout).
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

    /// PeerRelayBackend: `post` vira `PeerRelayPut` no intermediário e `poll`
    /// vira `PeerRelayGet` + espera `PeerRelayData` (oneshot por req_id).
    #[tokio::test]
    async fn peer_relay_backend_post_e_deliver() {
        let (a, _d) = mk_engine("PeerRelayClient");
        a.set_relay_backend(Arc::new(MemRelay::new()));
        a.start_with_discovery(false).unwrap();

        // Link DIRETO Online fake p/ o intermediário C.
        let (tx_c, mut rx_c) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
        a.links.lock().unwrap().insert(
            "relayC".into(),
            Arc::new(PeerLink {
                state: StdMutex::new(PeerLinkState::Online),
                tx: Some(tx_c),
                drop_notify: Notify::new(),
                via_relay: false,
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

        // poll registra oneshot e envia PeerRelayGet; deliver resolve.
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

    /// Seleção do intermediário: direto online em normal/encrypted; DESLIGADO
    /// em proxy/full e sob kill-switch explícito.
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
            }),
        );

        // (F7) peer-relay é opt-in; habilita explicitamente p/ testar a eleição.
        e.set_peer_relay_enabled(true);
        // normal/encrypted (default) → seleciona o peer direto.
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));

        // proxy/full → NÃO usa peer-relay (o intermediário veria o IP real).
        e.privacy_set_mode("proxy").unwrap();
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp(), None, "proxy nao usa peer-relay");

        e.privacy_set_mode("encrypted").unwrap();
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));

        // kill-switch explícito desliga o peer-relay; religar volta.
        e.set_relay_disabled(true);
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp(), None, "kill-switch desliga peer-relay");
        e.set_relay_disabled(false);
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));
    }

    /// (F2) `PeerRelayData` de um peer que NÃO é o intermediário é ignorado
    /// (mesmo com o `req_id` correto).
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
            }),
        );
        e.refresh_peer_relay();
        assert_eq!(e.peer_relay_fp().as_deref(), Some("mid"));
        e.start_with_discovery(false).unwrap();

        let backend = e.peer_relay_backend_for("mid");
        // Registra um pedido pendente e descobre o req_id real.
        let fut = backend.poll("distorrent_r_mid");
        let ids = backend.pending_req_ids();
        assert_eq!(ids.len(), 1, "deveria haver 1 pedido pendente");
        let req_id = ids[0];

        // Atacante tenta entregar o req_id — deve ser ignorado.
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

        // O intermediário eleito entrega de verdade.
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

    /// (F4) Peer bloqueado nunca é eleito intermediário.
    #[test]
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

    /// Contrato do wire TS: NatEndpoint serializa como `nat_endpoint` (sem
    /// sufixo Ev — o alias do tauri.ts não precisa de entrada).
    #[test]
    fn nat_endpoint_serializa_sem_sufixo_ev() {
        let ev = EngineEvent::NatEndpoint {
            addr: "203.0.113.7:51234".into(),
            source: "upnp".into(),
        };
        let v = serde_json::to_value(&ev).unwrap();
        assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("nat_endpoint"));
        assert_eq!(v.get("addr").and_then(|a| a.as_str()), Some("203.0.113.7:51234"));
        assert_eq!(v.get("source").and_then(|s| s.as_str()), Some("upnp"));
    }

    /// BUG2: DHT nunca anuncia a TCP interna — só externa confirmada ou nada.
    #[test]
    fn dht_announce_port_so_externa_confirmada() {
        let (e, _d) = mk_engine("DhtPort");
        // Sem STUN/UPnP: nada para anunciar (não a porta interna!).
        assert_eq!(e.dht_announce_port(), None);
        // UPnP/NAT-PMP mapeou 45678: anuncia ela, não a interna.
        e.nat_external_port.store(45678, Ordering::Relaxed);
        assert_eq!(e.dht_announce_port(), Some(45678));
        assert_ne!(e.dht_announce_port(), Some(e.listen_port()));
        // Cache STUN (public_addr) tem precedência.
        e.set_public_addr("203.0.113.7:51234".to_string());
        assert_eq!(e.dht_announce_port(), Some(51234));
        // public_addr malformado cai de volta para a externa mapeada.
        e.set_public_addr("lixo".to_string());
        assert_eq!(e.dht_announce_port(), Some(45678));
    }

    /// BUG8: peer_diag limitado a 512, mantendo os tocados por último.
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

    // ------------------------------------------------------------ voz nativa
    //
    //
    // A REGRA DE COEXISTÊNCIA. Estes testes existem para que ninguém "simplifique"
    // a condição depois: sem sessão nativa registrada, a sinalização tem que
    // continuar indo para o JS — é isso que mantém Windows/Android/macOS com o
    // WebRTC do navegador funcionando como hoje.

    #[cfg(target_os = "linux")]
    const PEER: &str = "peer-web";

    #[cfg(target_os = "linux")]
    fn engine_com_amigo(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
        let (e, d) = mk_engine(nick);
        e.store.set_friend(PEER, "Peer", "accepted").unwrap();
        (e, d)
    }

    #[cfg(target_os = "linux")]
    fn proximo_evento(rx: &mut broadcast::Receiver<EngineEvent>) -> Option<String> {
        rx.try_recv().ok().map(|e| format!("{e:?}"))
    }

    /// SEM sessão nativa: `CallOffer` vira `EngineEvent::CallOfferEv` e o JS
    /// cria a `RTCPeerConnection`. Este é o caminho de Windows/Android/macOS.
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
        let ev = proximo_evento(&mut rx).expect("deve haver evento para o JS");
        assert!(
            ev.contains("CallOfferEv"),
            "sem sessão nativa o evento tem que ser CallOfferEv, veio: {ev}"
        );
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

    /// COM sessão nativa: o `CallOffer` é absorvido e NENHUM evento de
    /// `CallOfferEv` é emitido (duas RTP na mesma chamada = eco + 2x banda).
    #[test]
    #[cfg(target_os = "linux")]
    fn call_offer_com_sessao_nativa_nao_vai_para_o_js() {
        let (e, _d) = engine_com_amigo("CoexistNative");
        // Sem mídia nativa não há o que absorver — e aí o caminho é o de
        // cima, que é justamente o que este arquivo quer proteger.
        let Some(v) = e.voice.clone() else {
            return;
        };
        let mut rx = e.subscribe();
        let call_id = "call-native";
        e.voice_register(call_id, PEER);
        assert!(e.voice_is_native(call_id, PEER), "registro falhou");

        // Offer REAL, gerado pela mesma API que o par chamador usaria.
        let oferta = v.create_offer("outra-call", "peer-fantasma").unwrap();
        let r = block_on(handle_frame(&e, PEER, "pubkey", "Peer", offer_frame(call_id, oferta)));
        assert!(r.is_ok(), "frame rejeitado: {r:?}");
        assert!(
            proximo_evento(&mut rx).is_none(),
            "sessão nativa absorveu o offer — o JS NÃO pode criar RTCPeerConnection"
        );
        v.hangup("outra-call");
        e.voice_hangup(call_id);
    }

    /// O inverso do fallback: se a mídia nativa RECUSA o SDP (par legado,
    /// lixo na rede), a sinalização volta para o navegador em vez de virar
    /// chamada muda. Nada foi enviado ao par nesse caminho, então os dois lados
    /// continuam coerentes.
    #[test]
    #[cfg(target_os = "linux")]
    fn offer_invalido_na_regressa_para_o_navegador() {
        let (e, _d) = engine_com_amigo("CoexistFallback");
        if e.voice.is_none() {
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
        // (A ausência de assinatura de microfone pendurada é verificada em
        // `media_voice_contract.rs`: o hub de áudio é um singleton do
        // processo, então a contagem aqui seria corrida com os outros testes.)
        e.voice_hangup(call_id);
    }

    /// O par é o mesmo, mas em OUTRA chamada: o registro é por
    /// (call_id, peer_fp), então não há vazamento entre chamadas.
    #[test]
    #[cfg(target_os = "linux")]
    fn registro_por_call_nao_vaza_para_outra() {
        let (e, _d) = engine_com_amigo("CoexistScope");
        // Sem mídia nativa (outra plataforma, ou FORGE_NO_NATIVE_VOICE=1) não
        // existe registro nenhum — o cenário testado é impossível aí.
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

    /// `call_invite` só marca o par como nativo se a mídia existir. Sem mídia
    /// (build sem a camada, outra plataforma, `FORGE_NO_NATIVE_VOICE=1`) o
    /// registro é recusado e nada do resto muda.
    #[test]
    #[cfg(target_os = "linux")]
    fn sem_midia_nativa_nada_e_registrado() {
        let (e, _d) = mk_engine("SemMidia");
        if e.voice.is_some() {
            // Ambiente com áudio: o registro é aceito, como deve ser.
            assert!(e.voice_register("c", "p"));
        } else {
            assert!(
                !e.voice_register("c", "p"),
                "sem mídia nativa nada pode ser registrado — o navegador assume"
            );
            assert!(!e.voice_is_native("c", "p"));
        }
    }

    /// (F7) Regra pura do intermediário por peer (sem depender do env do processo).
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

    /// BUG do "as vezes nao pega": a fila descartava o frame MAIS ANTIGO
    /// (`q.remove(0)`), e a ordem de chegada de uma chamada e
    /// offer -> ICE -> answer. Ao estourar o teto, caia o `CallOffer` e os
    /// primeiros candidatos, e o peer recebia candidatos de uma offer que
    /// nunca chegou: nenhum RTCPeerConnection, chamada muda.
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

    /// O que DEVE sair e o CallIce mais velho (reenviavel pelo chamador).
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

    /// Fila so de ICE / fila vazia: descarta o mais velho, sem panico.
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

    /// Stream real de uma chamada atras de CGNAT: o link P2P demora, a
    /// sinalizacao inteira se acumula, e nada essencial pode se perder.
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

    /// No teto e sem ICE, o descarte nunca sacrifica o par offer+answer.
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
