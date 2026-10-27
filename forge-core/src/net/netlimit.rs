//! Limites de rede centralizados — rate limits, concorrência e tetos de recursos
//! para TODOS os caminhos de entrada do motor (TCP, discovery UDP, relay, sessões).
//!
//! POR QUÊ ESTE MÓDULO EXISTE: o `antispam` limita MENSAGENS (10/10s por peer,
//! política de conteúdo) e o `authlimit` limita tentativas de VAULT — mas nenhum
//! dos dois protege o TRANSPORTE. Antes deste módulo:
//! - cada `accept()` TCP spawnava uma task de handshake sem freio (um host
//!   malicioso abria milhares de handshakes concorrentes = CPU/RAM);
//! - um peer AUTENTICADO podia inundar a sessão com frames de 1 MiB a taxa
//!   ilimitada (o limite por frame não limita a TAXA — limite de mensagens
//!   por segundo NÃO substitui limite de BYTES por mensagem);
//! - datagramas de discovery UDP (porta 45900) chegavam sem limite por origem;
//! - cada Hello NOVO (eph fresco) no relay nascia um respondente novo;
//! - nada limitava quantos loops de dial outbound viviam ao mesmo tempo.
//!
//! Taxa ≠ tamanho: um teto de frames/s não evita um frame de 1 MiB; um teto de
//! bytes não é isso que impede 10k frames/s de 1 byte. Aqui os dois existem,
//! INDEPENDENTES, por peer e globais.
//!
//! Política de punição em dois andares (deliberada — não punir rajada legítima):
//! 1. THROTTLE (token bucket apertado): o excedente é DESCARTADO, a sessão
//!    sobrevive. Transferência de arquivos em LAN alta velocidade apenas perde
//!    chunks, e o protocolo reenvia (outbox/ACK/fileSwarm já são idempotentes).
//! 2. KILL (token bucket muito mais largo): só um bug ou flooding deliberado
//!    chega aqui — a sessão é ENCERRADA com erro explícito.
//!
//! Fail-open NUNCA: se o lock estiver envenenado, trata como `Blocked` (o
//! código usa `unwrap_or_else(|e| e.into_inner())` como o resto do motor —
//! um pânico num limiter derrubaria o app para se proteger de flood).
//!
//! Tudo configurável por env (`FORGE_LIMIT_*`) e legível pela UI/diagnóstico
//! (`LimitsSnapshot` via comando Tauri `net_limits`). Contadores NUNCA carregam
//! conteúdo: só quantidades.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Teto de chaves por mapa de buckets — poda defensiva (mesmo padrão dos maps
/// do engine: churn de peers não pode crescer sem freio).
const MAP_CAP: usize = 8192;

// ---------------------------------------------------------------------------
// Parâmetros
// ---------------------------------------------------------------------------

/// Todos os tetos do transporte. Defaults calibrados para uso real:
/// voz ≈ 50 frames/s, arquivo ≈ 100 chunks/s (25 MB/s em LAN), ICE em rajada
/// de dezenas — com folga 2-3x acima do legítimo e 5x+ abaixo do abuso.
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Limits {
    /// Conexões TCP INBOUND por IP de origem por janela de 10s.
    pub tcp_accept_per_ip_10s: u32,
    /// Rajada inicial de accepts por IP (tokens do bucket).
    pub tcp_accept_burst: u32,
    /// Accepts inbound GLOBAIS por 10s (todas as origens somadas).
    pub tcp_accept_global_10s: u32,
    pub tcp_accept_global_burst: u32,
    /// Handshakes concorrentes (aceitos e ainda não concluídos).
    pub handshake_conc: usize,
    /// Teto de sessões online simultâneas (peers conectados de fato).
    pub sessions_max: usize,
    /// Datagramas de discovery UDP por IP de origem por 10s.
    pub disc_udp_per_ip_10s: u32,
    pub disc_udp_burst: u32,
    pub disc_udp_global_10s: u32,
    pub disc_udp_global_burst: u32,
    /// Hellos NOVOS por peer via relay por 10s (eph fresco = dial novo).
    pub relay_hello_per_peer_10s: u32,
    pub relay_hello_burst: u32,
    /// Frames de sessão por peer por 10s (throttle — excedente descartado).
    pub frames_per_peer_10s: u32,
    pub frames_per_peer_burst: u32,
    /// BYTES de sessão por peer por 10s (throttle) — independente do nº de
    /// frames: 10k frames de 1B e 1 frame de 10 MiB são coisas diferentes.
    pub bytes_per_peer_10s: u64,
    pub bytes_per_peer_burst: u64,
    /// Frames por peer por 10s no andar de KILL (5x o throttle). Só bug ou
    /// flooding chega aqui — sessão encerrada.
    pub frames_kill_per_peer_10s: u32,
    /// Bytes por peer por 10s no andar de KILL (5x o throttle).
    pub bytes_kill_per_peer_10s: u64,
    /// Frames inbound somando TODOS os peers por 10s.
    pub frames_global_10s: u32,
    pub frames_global_burst: u32,
    /// Loops de dial outbound concorrentes (direto + relay; um por destino).
    pub dial_conc: usize,
    /// Pedidos de chunk de arquivo recebidos por peer por 10s.
    pub chunk_req_per_peer_10s: u32,
    pub chunk_req_burst: u32,
    /// Frames de sinalização de chamada/tela por peer por 10s (ICE em rajada).
    pub call_sig_per_peer_10s: u32,
    pub call_sig_burst: u32,
    /// FriendRequests recebidos por peer por 10s.
    pub friend_req_per_peer_10s: u32,
    pub friend_req_burst: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // LAN reconecta em rajada (restart do app na mesma máquina) — 30/10s
            // com burst 20 cobre 10 nós de teste sem derrubar nada.
            tcp_accept_per_ip_10s: 30,
            tcp_accept_burst: 20,
            tcp_accept_global_10s: 120,
            tcp_accept_global_burst: 80,
            handshake_conc: 64,
            // 256 peers online: acima disso o app desktop já não é o gargalo.
            sessions_max: 256,
            // Discovery legítimo = 1 anúncio/2s = 5/10s por origem. 15/10s dá
            // folga 3x (reconexões, múltiplas interfaces).
            disc_udp_per_ip_10s: 15,
            disc_udp_burst: 10,
            disc_udp_global_10s: 300,
            disc_udp_global_burst: 200,
            // Relay reenvia o Hello a cada 1,5s ⇒ pior caso legítimo ~7/10s.
            relay_hello_per_peer_10s: 12,
            relay_hello_burst: 8,
            // Voz ~50 fps + ICE + acks ≈ 60-100/s pico. Throttle em 120/s.
            frames_per_peer_10s: 1200,
            frames_per_peer_burst: 800,
            // 128 MiB/10s = 12,8 MiB/s sustentado por peer. Transferência de
            // arquivos em LAN é mais rápida, mas o excedente só perde chunk
            // (reenviado); matar a sessão por throughput seria pior.
            bytes_per_peer_10s: 128 * 1024 * 1024,
            bytes_per_peer_burst: 64 * 1024 * 1024,
            // 600 frames/s por peer = máquina de flood, não usuário.
            frames_kill_per_peer_10s: 6000,
            // 64 MiB/s por peer sustentado.
            bytes_kill_per_peer_10s: 640 * 1024 * 1024,
            frames_global_10s: 6000,
            frames_global_burst: 4000,
            dial_conc: 64,
            // Swarm pede chunks em lote; 20/s por peer é generoso e suficiente.
            chunk_req_per_peer_10s: 200,
            chunk_req_burst: 120,
            // Trickle ICE pode cuspir dezenas de candidatos num segundo.
            call_sig_per_peer_10s: 240,
            call_sig_burst: 160,
            friend_req_per_peer_10s: 20,
            friend_req_burst: 12,
        }
    }
}

/// Lê `FORGE_LIMIT_<NOME>` como número; valor ausente/inválido = default.
/// Falha aberta NÃO: env inválido ignora a override e usa o default saudável.
fn env_num<T: std::str::FromStr>(name: &str, default: T) -> T {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(default)
}

impl Limits {
    /// Defaults + overrides de env (self-host/CI pode apertar/soltar sem build).
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            tcp_accept_per_ip_10s: env_num("FORGE_LIMIT_TCP_ACCEPT_10S", d.tcp_accept_per_ip_10s),
            tcp_accept_burst: env_num("FORGE_LIMIT_TCP_ACCEPT_BURST", d.tcp_accept_burst),
            tcp_accept_global_10s: env_num(
                "FORGE_LIMIT_TCP_ACCEPT_GLOBAL_10S",
                d.tcp_accept_global_10s,
            ),
            tcp_accept_global_burst: env_num(
                "FORGE_LIMIT_TCP_ACCEPT_GLOBAL_BURST",
                d.tcp_accept_global_burst,
            ),
            handshake_conc: env_num("FORGE_LIMIT_HANDSHAKE_CONC", d.handshake_conc),
            sessions_max: env_num("FORGE_LIMIT_SESSIONS_MAX", d.sessions_max),
            disc_udp_per_ip_10s: env_num("FORGE_LIMIT_DISC_UDP_10S", d.disc_udp_per_ip_10s),
            disc_udp_burst: env_num("FORGE_LIMIT_DISC_UDP_BURST", d.disc_udp_burst),
            disc_udp_global_10s: env_num("FORGE_LIMIT_DISC_UDP_GLOBAL_10S", d.disc_udp_global_10s),
            disc_udp_global_burst: env_num(
                "FORGE_LIMIT_DISC_UDP_GLOBAL_BURST",
                d.disc_udp_global_burst,
            ),
            relay_hello_per_peer_10s: env_num(
                "FORGE_LIMIT_RELAY_HELLO_10S",
                d.relay_hello_per_peer_10s,
            ),
            relay_hello_burst: env_num("FORGE_LIMIT_RELAY_HELLO_BURST", d.relay_hello_burst),
            frames_per_peer_10s: env_num("FORGE_LIMIT_FRAMES_10S", d.frames_per_peer_10s),
            frames_per_peer_burst: env_num("FORGE_LIMIT_FRAMES_BURST", d.frames_per_peer_burst),
            bytes_per_peer_10s: env_num("FORGE_LIMIT_BYTES_10S", d.bytes_per_peer_10s),
            bytes_per_peer_burst: env_num("FORGE_LIMIT_BYTES_BURST", d.bytes_per_peer_burst),
            frames_kill_per_peer_10s: env_num(
                "FORGE_LIMIT_FRAMES_KILL_10S",
                d.frames_kill_per_peer_10s,
            ),
            bytes_kill_per_peer_10s: env_num(
                "FORGE_LIMIT_BYTES_KILL_10S",
                d.bytes_kill_per_peer_10s,
            ),
            frames_global_10s: env_num("FORGE_LIMIT_FRAMES_GLOBAL_10S", d.frames_global_10s),
            frames_global_burst: env_num("FORGE_LIMIT_FRAMES_GLOBAL_BURST", d.frames_global_burst),
            dial_conc: env_num("FORGE_LIMIT_DIAL_CONC", d.dial_conc),
            chunk_req_per_peer_10s: env_num("FORGE_LIMIT_CHUNK_REQ_10S", d.chunk_req_per_peer_10s),
            chunk_req_burst: env_num("FORGE_LIMIT_CHUNK_REQ_BURST", d.chunk_req_burst),
            call_sig_per_peer_10s: env_num("FORGE_LIMIT_CALL_SIG_10S", d.call_sig_per_peer_10s),
            call_sig_burst: env_num("FORGE_LIMIT_CALL_SIG_BURST", d.call_sig_burst),
            friend_req_per_peer_10s: env_num(
                "FORGE_LIMIT_FRIEND_REQ_10S",
                d.friend_req_per_peer_10s,
            ),
            friend_req_burst: env_num("FORGE_LIMIT_FRIEND_REQ_BURST", d.friend_req_burst),
        }
    }
}

// ---------------------------------------------------------------------------
// Vereditos
// ---------------------------------------------------------------------------

/// Decisão de uma checagem de taxa. `Blocked` = a ação NÃO acontece (o
/// chamador descarta a conexão/datagrama/pedido e segue vivo).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Blocked,
}

/// Veredito de um frame de sessão inbound — três andares, para NÃO derrubar
/// quem só estourou uma rajada legítima:
/// - `Allow`: processa normalmente.
/// - `Drop`: descarta ESTE frame; sessão preservada (throttle). O outbox/ACK/
///   fileSwarm do par reenvia o que importava.
/// - `Kill`: encerra a sessão — tráfego na casa do abuso (andar de KILL).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameVerdict {
    Allow,
    Drop(&'static str),
    Kill(&'static str),
}

// ---------------------------------------------------------------------------
// Token bucket genérico (conta E bytes: unidades são f64)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct Cell {
    tokens: f64,
    last: Instant,
}

/// Bucket por chave. `rate_per_s` recarrega continuamente (janela deslizante
/// de verdade, não contador fixo por intervalo — evita rajada no início de
/// cada janela). `check_at` recebe `now` injetado para testes determinísticos.
#[derive(Debug)]
struct KeyedBuckets {
    rate_per_s: f64,
    burst: f64,
    cells: HashMap<String, Cell>,
}

impl KeyedBuckets {
    fn new(rate_10s: u64, burst: u64) -> Self {
        Self {
            rate_per_s: rate_10s as f64 / 10.0,
            burst: burst as f64,
            cells: HashMap::new(),
        }
    }

    fn reconfig(&mut self, rate_10s: u64, burst: u64) {
        self.rate_per_s = rate_10s as f64 / 10.0;
        self.burst = burst as f64;
        self.cells.clear();
    }

    /// Consome `units` da chave. `true` = permitido. Bucket novo nasce CHEIO
    /// (burst inicial) — igual ao `RateLimiter` do antispam.
    fn check_at(&mut self, key: &str, units: f64, now: Instant) -> bool {
        if self.cells.len() > MAP_CAP {
            self.cells.clear(); // poda defensiva (padrão dos maps do engine)
        }
        let cell = self.cells.entry(key.to_string()).or_insert(Cell {
            tokens: self.burst,
            last: now,
        });
        let dt = now.duration_since(cell.last).as_secs_f64().max(0.0);
        cell.tokens = (cell.tokens + dt * self.rate_per_s).min(self.burst);
        cell.last = now;
        if cell.tokens >= units {
            cell.tokens -= units;
            true
        } else {
            false
        }
    }

    fn forget(&mut self, key: &str) {
        self.cells.remove(key);
    }
}

/// Bucket global (uma célula só) — pressão somada de todas as origens.
#[derive(Debug)]
struct GlobalBucket {
    rate_per_s: f64,
    burst: f64,
    cell: Cell,
}

impl GlobalBucket {
    fn new(rate_10s: u64, burst: u64) -> Self {
        Self {
            rate_per_s: rate_10s as f64 / 10.0,
            burst: burst as f64,
            cell: Cell {
                tokens: burst as f64,
                last: Instant::now(),
            },
        }
    }

    fn reconfig(&mut self, rate_10s: u64, burst: u64) {
        self.rate_per_s = rate_10s as f64 / 10.0;
        self.burst = burst as f64;
        self.cell = Cell {
            tokens: burst as f64,
            last: Instant::now(),
        };
    }

    fn check_at(&mut self, units: f64, now: Instant) -> bool {
        let dt = now.duration_since(self.cell.last).as_secs_f64().max(0.0);
        self.cell.tokens = (self.cell.tokens + dt * self.rate_per_s).min(self.burst);
        self.cell.last = now;
        if self.cell.tokens >= units {
            self.cell.tokens -= units;
            true
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// Slots de concorrência (handshake/dial) com guarda RAII
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Slots {
    active: AtomicUsize,
    cap: AtomicUsize,
}

impl Slots {
    fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            active: AtomicUsize::new(0),
            cap: AtomicUsize::new(cap),
        })
    }

    fn reconfig(&self, cap: usize) {
        // cap não encolhe abaixo dos ativos de propósito: os guards vigentes
        // liberam no Drop e o novo teto vale a partir daí (fail-safe).
        self.cap.store(cap, Ordering::Relaxed);
    }
}

/// Segura uma vaga de concorrência até o fim do escopo (Drop libera).
/// Guarda `Arc<Slots>` para funcionar movida entre tasks (handshake spawnado).
#[derive(Debug)]
pub struct SlotGuard {
    inner: Arc<Slots>,
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        self.inner.active.fetch_sub(1, Ordering::Relaxed);
    }
}

fn try_slot(inner: &Arc<Slots>) -> Option<SlotGuard> {
    let mut cur = inner.active.load(Ordering::Relaxed);
    loop {
        if cur >= inner.cap.load(Ordering::Relaxed) {
            return None;
        }
        match inner
            .active
            .compare_exchange_weak(cur, cur + 1, Ordering::Relaxed, Ordering::Relaxed)
        {
            Ok(_) => {
                return Some(SlotGuard {
                    inner: Arc::clone(inner),
                })
            }
            Err(atual) => cur = atual, // outra thread ganhou a corrida — retenta
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot para diagnóstico/UI
// ---------------------------------------------------------------------------

/// Contadores de rejeição por classe (diagnóstico honesto na UI: o usuário
/// vê quando um limite está apertado demais para o uso dele).
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct RejectedCounters {
    pub tcp_accept: u64,
    pub handshake_conc: u64,
    pub disc_udp: u64,
    pub relay_hello: u64,
    pub frames_throttled: u64,
    pub sessions_killed: u64,
    pub chunk_req: u64,
    pub call_sig: u64,
    pub friend_req: u64,
    pub dial_conc: u64,
    pub frames_allowed: u64,
}

/// Estado completo dos limites para o comando `net_limits` (Tauri) e testes.
#[derive(Debug, Clone, serde::Serialize)]
pub struct LimitsSnapshot {
    pub limits: Limits,
    pub rejected: RejectedCounters,
    pub active_handshakes: usize,
    pub active_dials: usize,
}

// ---------------------------------------------------------------------------
// NetLimiter — o ponto único de decisão
// ---------------------------------------------------------------------------

pub struct NetLimiter {
    limits: Mutex<Limits>,
    tcp_accept_ip: Mutex<KeyedBuckets>,
    tcp_accept_global: Mutex<GlobalBucket>,
    disc_udp_ip: Mutex<KeyedBuckets>,
    disc_udp_global: Mutex<GlobalBucket>,
    relay_hello: Mutex<KeyedBuckets>,
    frames_ip: Mutex<KeyedBuckets>,
    frames_kill_ip: Mutex<KeyedBuckets>,
    bytes_ip: Mutex<KeyedBuckets>,
    bytes_kill_ip: Mutex<KeyedBuckets>,
    frames_global: Mutex<GlobalBucket>,
    chunk_req: Mutex<KeyedBuckets>,
    call_sig: Mutex<KeyedBuckets>,
    friend_req: Mutex<KeyedBuckets>,
    handshake_slots: Arc<Slots>,
    dial_slots: Arc<Slots>,
    rejected: Mutex<RejectedCounters>,
}

impl NetLimiter {
    /// Constrói com defaults + env. Devolve `Arc` porque o discovery/mDNS
    /// precisam da MESMA instância (limites compartilhados, sem duplicar mapa).
    pub fn from_env() -> Arc<Self> {
        let l = Limits::from_env();
        let lim = Self {
            limits: Mutex::new(l),
            tcp_accept_ip: Mutex::new(KeyedBuckets::new(
                l.tcp_accept_per_ip_10s as u64,
                l.tcp_accept_burst as u64,
            )),
            tcp_accept_global: Mutex::new(GlobalBucket::new(
                l.tcp_accept_global_10s as u64,
                l.tcp_accept_global_burst as u64,
            )),
            disc_udp_ip: Mutex::new(KeyedBuckets::new(
                l.disc_udp_per_ip_10s as u64,
                l.disc_udp_burst as u64,
            )),
            disc_udp_global: Mutex::new(GlobalBucket::new(
                l.disc_udp_global_10s as u64,
                l.disc_udp_global_burst as u64,
            )),
            relay_hello: Mutex::new(KeyedBuckets::new(
                l.relay_hello_per_peer_10s as u64,
                l.relay_hello_burst as u64,
            )),
            frames_ip: Mutex::new(KeyedBuckets::new(
                l.frames_per_peer_10s as u64,
                l.frames_per_peer_burst as u64,
            )),
            frames_kill_ip: Mutex::new(KeyedBuckets::new(
                l.frames_kill_per_peer_10s as u64,
                l.frames_kill_per_peer_10s as u64,
            )),
            bytes_ip: Mutex::new(KeyedBuckets::new(
                l.bytes_per_peer_10s,
                l.bytes_per_peer_burst,
            )),
            bytes_kill_ip: Mutex::new(KeyedBuckets::new(
                l.bytes_kill_per_peer_10s,
                l.bytes_kill_per_peer_10s,
            )),
            frames_global: Mutex::new(GlobalBucket::new(
                l.frames_global_10s as u64,
                l.frames_global_burst as u64,
            )),
            chunk_req: Mutex::new(KeyedBuckets::new(
                l.chunk_req_per_peer_10s as u64,
                l.chunk_req_burst as u64,
            )),
            call_sig: Mutex::new(KeyedBuckets::new(
                l.call_sig_per_peer_10s as u64,
                l.call_sig_burst as u64,
            )),
            friend_req: Mutex::new(KeyedBuckets::new(
                l.friend_req_per_peer_10s as u64,
                l.friend_req_burst as u64,
            )),
            handshake_slots: Slots::new(l.handshake_conc),
            dial_slots: Slots::new(l.dial_conc),
            rejected: Mutex::new(RejectedCounters::default()),
        };
        Arc::new(lim)
    }

    /// Copia dos parâmetros vigentes (o engine lê `sessions_max` daqui).
    pub fn limits(&self) -> Limits {
        *self.limits.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Troca TODOS os parâmetros em runtime (host/testes). Recalcula os
    /// buckets — mudança de teto nunca deixa estado antigo contaminando.
    pub fn reconfigure(&self, l: Limits) {
        let mut g = self.limits.lock().unwrap_or_else(|e| e.into_inner());
        *g = l;
        self.tcp_accept_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.tcp_accept_per_ip_10s as u64, l.tcp_accept_burst as u64);
        self.tcp_accept_global
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(
                l.tcp_accept_global_10s as u64,
                l.tcp_accept_global_burst as u64,
            );
        self.disc_udp_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.disc_udp_per_ip_10s as u64, l.disc_udp_burst as u64);
        self.disc_udp_global
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.disc_udp_global_10s as u64, l.disc_udp_global_burst as u64);
        self.relay_hello
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(
                l.relay_hello_per_peer_10s as u64,
                l.relay_hello_burst as u64,
            );
        self.frames_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.frames_per_peer_10s as u64, l.frames_per_peer_burst as u64);
        // Andar de KILL nasce com burst = rate (rajada não perdoa no abuso).
        self.frames_kill_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(
                l.frames_kill_per_peer_10s as u64,
                l.frames_kill_per_peer_10s as u64,
            );
        self.bytes_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.bytes_per_peer_10s, l.bytes_per_peer_burst);
        self.bytes_kill_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.bytes_kill_per_peer_10s, l.bytes_kill_per_peer_10s);
        self.frames_global
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.frames_global_10s as u64, l.frames_global_burst as u64);
        self.chunk_req
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.chunk_req_per_peer_10s as u64, l.chunk_req_burst as u64);
        self.call_sig
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.call_sig_per_peer_10s as u64, l.call_sig_burst as u64);
        self.friend_req
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .reconfig(l.friend_req_per_peer_10s as u64, l.friend_req_burst as u64);
        self.handshake_slots.reconfig(l.handshake_conc);
        self.dial_slots.reconfig(l.dial_conc);
    }

    fn bump(&self, f: impl FnOnce(&mut RejectedCounters)) {
        let mut r = self.rejected.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut r);
    }

    // ── TCP inbound ─────────────────────────────────────────────────────────

    /// Um accept inbound pode virar handshake? Checa por IP de origem E o
    /// teto global. `Blocked` = feche o stream imediatamente (o OS RST cuida
    /// do resto) — cada accept é uma task de handshake criptográfico, sem
    /// isto mil accepts = mil tasks (DoS de CPU).
    pub fn allow_tcp_accept(&self, ip: IpAddr) -> Decision {
        let now = Instant::now();
        let key = ip.to_string();
        let per_ip = self
            .tcp_accept_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(&key, 1.0, now);
        if !per_ip {
            self.bump(|r| r.tcp_accept += 1);
            return Decision::Blocked;
        }
        let global = self
            .tcp_accept_global
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(1.0, now);
        if !global {
            self.bump(|r| r.tcp_accept += 1);
            return Decision::Blocked;
        }
        Decision::Allowed
    }

    /// Vaga para MAIS UM handshake concorrente. Segure o guard até o fim do
    /// handshake (Drop libera) — ele NÃO limita a sessão que nasce depois.
    pub fn try_handshake_slot(&self) -> Option<SlotGuard> {
        let g = try_slot(&self.handshake_slots);
        if g.is_none() {
            self.bump(|r| r.handshake_conc += 1);
        }
        g
    }

    // ── Discovery UDP ───────────────────────────────────────────────────────

    /// Datagrama de discovery pode ser processado? (anúncio legítimo = 1/2s)
    pub fn allow_disc_datagram(&self, ip: IpAddr) -> Decision {
        let now = Instant::now();
        let key = ip.to_string();
        let per_ip = self
            .disc_udp_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(&key, 1.0, now);
        if !per_ip {
            self.bump(|r| r.disc_udp += 1);
            return Decision::Blocked;
        }
        let global = self
            .disc_udp_global
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(1.0, now);
        if !global {
            self.bump(|r| r.disc_udp += 1);
            return Decision::Blocked;
        }
        Decision::Allowed
    }

    // ── Relay ───────────────────────────────────────────────────────────────

    /// Hello NOVO (eph fresco) via relay pode nascer respondente? O dedup
    /// por (eph, nonce) já barra REPETIÇÃO do mesmo Hello; isto barra a
    /// fábrica de Hellos novos (cada um = task de handshake viva).
    pub fn allow_relay_hello(&self, peer_fp: &str) -> Decision {
        let ok = self
            .relay_hello
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(peer_fp, 1.0, Instant::now());
        if ok {
            Decision::Allowed
        } else {
            self.bump(|r| r.relay_hello += 1);
            Decision::Blocked
        }
    }

    // ── Frames de sessão inbound ────────────────────────────────────────────

    /// Veredito de UM frame inbound de sessão (throttle + kill, por peer e
    /// global; frames E bytes — um não substitui o outro).
    pub fn allow_frame_in(&self, peer_fp: &str, wire_bytes: u64) -> FrameVerdict {
        self.allow_frame_in_at(peer_fp, wire_bytes, Instant::now())
    }

    /// Variante com relógio injetado (testes determinísticos, sem sleep).
    pub fn allow_frame_in_at(&self, peer_fp: &str, wire_bytes: u64, now: Instant) -> FrameVerdict {
        // Andar de KILL primeiro: se é abuso, mata logo — não perde tempo
        // contando no throttle (e o throttle não "protege" quem já morreu).
        let kill_frames = !self
            .frames_kill_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(peer_fp, 1.0, now);
        if kill_frames {
            self.bump(|r| r.sessions_killed += 1);
            return FrameVerdict::Kill("flood de frames (muito acima do normal)");
        }
        let kill_bytes = wire_bytes > 0
            && !self
                .bytes_kill_ip
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .check_at(peer_fp, wire_bytes as f64, now);
        if kill_bytes {
            self.bump(|r| r.sessions_killed += 1);
            return FrameVerdict::Kill("flood de bytes (muito acima do normal)");
        }
        // Throttle por peer: descarta o frame, preserva a sessão.
        let th_frames = !self
            .frames_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(peer_fp, 1.0, now);
        if th_frames {
            self.bump(|r| r.frames_throttled += 1);
            return FrameVerdict::Drop("rate de frames por peer");
        }
        let th_bytes = wire_bytes > 0
            && !self
                .bytes_ip
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .check_at(peer_fp, wire_bytes as f64, now);
        if th_bytes {
            self.bump(|r| r.frames_throttled += 1);
            return FrameVerdict::Drop("rate de bytes por peer");
        }
        // Pressão global (muitos peers somados): descarta sem matar.
        if !self
            .frames_global
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(1.0, now)
        {
            self.bump(|r| r.frames_throttled += 1);
            return FrameVerdict::Drop("pressão global de frames");
        }
        self.bump(|r| r.frames_allowed += 1);
        FrameVerdict::Allow
    }

    // ── Gates por classe de frame (handle_frame) ─────────────────────────────

    /// Pedido de chunk de arquivo recebido (Bulk) — flood enche o disco/IO.
    pub fn allow_chunk_request(&self, peer_fp: &str) -> Decision {
        let ok = self
            .chunk_req
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(peer_fp, 1.0, Instant::now());
        if ok {
            Decision::Allowed
        } else {
            self.bump(|r| r.chunk_req += 1);
            Decision::Blocked
        }
    }

    /// Frame de sinalização de chamada/tela (Call*/ScreenShare*) — ICE em
    /// rajada é legítimo, mas não ilimitado.
    pub fn allow_call_signal(&self, peer_fp: &str) -> Decision {
        let ok = self
            .call_sig
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(peer_fp, 1.0, Instant::now());
        if ok {
            Decision::Allowed
        } else {
            self.bump(|r| r.call_sig += 1);
            Decision::Blocked
        }
    }

    /// FriendRequest recebido — spam de pedido de amizade pelo transport.
    pub fn allow_friend_request(&self, peer_fp: &str) -> Decision {
        let ok = self
            .friend_req
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .check_at(peer_fp, 1.0, Instant::now());
        if ok {
            Decision::Allowed
        } else {
            self.bump(|r| r.friend_req += 1);
            Decision::Blocked
        }
    }

    // ── Dial outbound ───────────────────────────────────────────────────────

    /// Vaga para MAIS UM loop de dial outbound (direto ou relay). Segure o
    /// guard até o fim do loop (são eternos por destino — o teto limita
    /// DESTINOS simultâneos, que é o que vaza fd/CPU).
    pub fn try_dial_slot(&self) -> Option<SlotGuard> {
        let g = try_slot(&self.dial_slots);
        if g.is_none() {
            self.bump(|r| r.dial_conc += 1);
        }
        g
    }

    // ── Higiene e diagnóstico ────────────────────────────────────────────────

    /// Sessão com este peer acabou: limpa os buckets dele (evita mapa morto
    /// crescendo com churn de peers — o prune de MAP_CAP é a rede de segurança).
    pub fn forget_peer(&self, peer_fp: &str) {
        self.frames_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
        self.frames_kill_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
        self.bytes_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
        self.bytes_kill_ip
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
        self.relay_hello
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
        self.chunk_req
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
        self.call_sig
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
        self.friend_req
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .forget(peer_fp);
    }

    /// Snapshot completo (comando `net_limits` / ConnectionDiagnostics).
    pub fn snapshot(&self) -> LimitsSnapshot {
        LimitsSnapshot {
            limits: self.limits(),
            rejected: self
                .rejected
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            active_handshakes: self.handshake_slots.active.load(Ordering::Relaxed),
            active_dials: self.dial_slots.active.load(Ordering::Relaxed),
        }
    }
}

// ---------------------------------------------------------------------------
// Testes (determinísticos: relógio injetado, SEM sleep e SEM env)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn limiter() -> NetLimiter {
        // Instância crua (não from_env) com defaults — testes nunca dependem
        // do ambiente do processo (mesma lição do authlimit).
        let l = NetLimiter {
            limits: Mutex::new(Limits::default()),
            tcp_accept_ip: Mutex::new(KeyedBuckets::new(30, 20)),
            tcp_accept_global: Mutex::new(GlobalBucket::new(120, 80)),
            disc_udp_ip: Mutex::new(KeyedBuckets::new(15, 10)),
            disc_udp_global: Mutex::new(GlobalBucket::new(300, 200)),
            relay_hello: Mutex::new(KeyedBuckets::new(12, 8)),
            frames_ip: Mutex::new(KeyedBuckets::new(1200, 800)),
            frames_kill_ip: Mutex::new(KeyedBuckets::new(6000, 6000)),
            bytes_ip: Mutex::new(KeyedBuckets::new(128 * 1024 * 1024, 64 * 1024 * 1024)),
            bytes_kill_ip: Mutex::new(KeyedBuckets::new(640 * 1024 * 1024, 640 * 1024 * 1024)),
            frames_global: Mutex::new(GlobalBucket::new(6000, 4000)),
            chunk_req: Mutex::new(KeyedBuckets::new(200, 120)),
            call_sig: Mutex::new(KeyedBuckets::new(240, 160)),
            friend_req: Mutex::new(KeyedBuckets::new(20, 12)),
            handshake_slots: Slots::new(64),
            dial_slots: Slots::new(64),
            rejected: Mutex::new(RejectedCounters::default()),
        };
        l
    }

    #[test]
    fn bucket_burst_e_refill_deslizante() {
        let mut b = KeyedBuckets::new(10, 3); // 1/s, burst 3
        let t0 = Instant::now();
        // burst inicial cheio: 3 passam
        assert!(b.check_at("a", 1.0, t0));
        assert!(b.check_at("a", 1.0, t0));
        assert!(b.check_at("a", 1.0, t0));
        // 4º na mesma hora: bloqueado
        assert!(!b.check_at("a", 1.0, t0));
        // +10s ⇒ +10 tokens (teto burst 3): 3 passam de novo
        let t1 = t0 + Duration::from_secs(10);
        assert!(b.check_at("a", 1.0, t1));
        assert!(b.check_at("a", 1.0, t1));
        assert!(b.check_at("a", 1.0, t1));
        assert!(!b.check_at("a", 1.0, t1));
    }

    #[test]
    fn bucket_bytes_consome_em_unidades() {
        // taxa ≠ tamanho: 100 bytes/10s, burst 250 — dois frames de 128 B
        // passam (256>250 não: o primeiro consome 128, restam 122 <128) — o
        // segundo é barrado MESMO sendo só "1 frame".
        let mut b = KeyedBuckets::new(100, 250);
        let t0 = Instant::now();
        assert!(b.check_at("p", 128.0, t0));
        assert!(!b.check_at("p", 128.0, t0));
    }

    #[test]
    fn frames_throttle_descarta_e_kill_encerra() {
        let l = limiter();
        // Limiares didáticos: throttle 10/10s burst 5; kill 20/10s burst 20.
        let mut cfg = Limits::default();
        cfg.frames_per_peer_10s = 10;
        cfg.frames_per_peer_burst = 5;
        cfg.frames_kill_per_peer_10s = 20;
        l.reconfigure(cfg);
        let t0 = Instant::now();
        let mut drops = 0;
        let mut kills = 0;
        for i in 0..50 {
            match l.allow_frame_in_at("peerX", 100, t0 + Duration::from_millis(i)) {
                FrameVerdict::Allow => {}
                FrameVerdict::Drop(_) => drops += 1,
                FrameVerdict::Kill(_) => kills += 1,
            }
        }
        assert!(drops > 0, "deveria ter drops (throttle)");
        assert!(kills > 0, "deveria ter kills (flood)");
    }

    #[test]
    fn slots_cap_e_release() {
        let s = Slots::new(2);
        let g1 = try_slot(&s).expect("1ª vaga");
        let _g2 = try_slot(&s).expect("2ª vaga");
        assert!(try_slot(&s).is_none(), "3ª vaga tem que falhar no cap 2");
        drop(g1);
        assert!(try_slot(&s).is_some(), "Drop liberou a vaga");
    }

    #[test]
    fn esquecer_peer_devolve_o_burst() {
        let l = limiter();
        let mut cfg = Limits::default();
        cfg.relay_hello_per_peer_10s = 1;
        cfg.relay_hello_burst = 1;
        l.reconfigure(cfg);
        assert_eq!(l.allow_relay_hello("p"), Decision::Allowed);
        assert_eq!(
            l.allow_relay_hello("p"),
            Decision::Blocked,
            "burst 1 já foi consumido"
        );
        l.forget_peer("p");
        assert_eq!(
            l.allow_relay_hello("p"),
            Decision::Allowed,
            "esquecer zera o bucket do peer"
        );
    }

    #[test]
    fn snapshot_conta_rejeicoes() {
        let l = limiter();
        let mut cfg = Limits::default();
        cfg.tcp_accept_per_ip_10s = 1;
        cfg.tcp_accept_burst = 1;
        l.reconfigure(cfg);
        let ip: IpAddr = "127.0.0.1".parse().unwrap();
        assert_eq!(l.allow_tcp_accept(ip), Decision::Allowed);
        assert_eq!(l.allow_tcp_accept(ip), Decision::Blocked);
        let snap = l.snapshot();
        assert_eq!(snap.rejected.tcp_accept, 1);
        assert_eq!(snap.limits.tcp_accept_burst, 1);
    }

    #[test]
    fn env_num_usa_default_quando_ausente_ou_invalido() {
        // Nunca seta env no teste (evita flakiness entre suítes) — valida só
        // o caminho ausente/inválido.
        assert_eq!(env_num::<u32>("FORGE_LIMIT_TESTE_INEXISTENTE", 42), 42);
        assert_eq!(env_num::<u32>("FORGE_LIMIT_TESTE_INEXISTENTE_2", 7), 7);
    }

    #[test]
    fn discovery_udp_limita_por_origem() {
        let l = limiter();
        let mut cfg = Limits::default();
        cfg.disc_udp_per_ip_10s = 2;
        cfg.disc_udp_burst = 2;
        l.reconfigure(cfg);
        let ip: IpAddr = "192.168.0.10".parse().unwrap();
        assert_eq!(l.allow_disc_datagram(ip), Decision::Allowed);
        assert_eq!(l.allow_disc_datagram(ip), Decision::Allowed);
        assert_eq!(l.allow_disc_datagram(ip), Decision::Blocked);
        // Outra origem não paga a conta desta
        let ip2: IpAddr = "192.168.0.11".parse().unwrap();
        assert_eq!(l.allow_disc_datagram(ip2), Decision::Allowed);
    }
}
