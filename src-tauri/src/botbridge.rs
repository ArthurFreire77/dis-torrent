//! Ponte local do bot: `http://127.0.0.1:<porta>`.
//!
//! O bot (um programa do usuário, em qualquer linguagem) fala com o servidor
//! por aqui: recebe eventos, publica mensagens e pede ações administrativas.
//! O app é o único que fala P2P — a ponte nunca abre porta pública, escuta só
//! em loopback e exige o segredo que o app gerou no caminho da URL.
//!
//! Não é um painel: não edita bot, não lista servidores, não desenha nada.
//! Sem esse segredo, um site aberto no navegador não consegue nem descobrir o que
//! existe aqui.

use std::collections::VecDeque;
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

use distorrent_core::net::engine::NetworkEngine;
use distorrent_core::EngineEvent;

pub const MAX_BODY: usize = 64 * 1024;
pub const MAX_EVENTS_BUFFER: usize = 500;
/// Eventos por resposta do long-poll. Sem teto, um `since=0` devolvia o buffer
/// inteiro (até ~32 MB) de uma vez.
pub const MAX_EVENTS_PER_POLL: usize = 50;
pub const MAX_POST_CHARS: usize = 1900;
/// Balde global: protege o processo do app de um plugin descontrolado.
const RATE_PER_MIN: u32 = 120;
/// Balde por rota: o long-poll de `/v1/events` não come o orçamento de escrita.
const RATE_EVENTS_PER_MIN: u32 = 120;
const RATE_WRITE_PER_MIN: u32 = 120;

#[derive(Debug, Clone, Serialize)]
pub struct BridgeInfo {
    pub bot_id: String,
    pub community_id: String,
    /// URL **completa e secreta** (`http://127.0.0.1:<porta>/b/<segredo>`).
    /// O plugin usa isso e nada mais — não existe token para colar.
    pub url: String,
    pub port: u16,
    pub started_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BridgeStatus {
    pub running: bool,
    pub url: Option<String>,
    pub port: Option<u16>,
    pub events_pending: usize,
    pub requests: u64,
    pub dropped: u64,
}

#[derive(Debug, Clone, Serialize)]
struct QueuedEvent {
    seq: u64,
    event: String,
    data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct MessageBody {
    channel: String,
    body: String,
}

#[derive(Debug, Deserialize)]
struct AdminBody {
    action: String,
    #[serde(default)]
    target: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    number: Option<i64>,
    #[serde(default)]
    channel: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LogBody {
    #[serde(default)]
    level: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ConfigBody {
    config: String,
}

struct Shared {
    bot_id: String,
    community_id: String,
    /// Prefixo secreto do caminho desta ponte (`/b/<32 hex>`). Só quem recebeu
    /// a URL do app consegue falar aqui: não há token para digitar nem colar.
    path: String,
    port: u16,
    started_at: i64,
    stop: AtomicBool,
    events: Mutex<VecDeque<QueuedEvent>>,
    seq: Mutex<u64>,
    requests: AtomicU32,
    dropped: AtomicU32,
    window: Mutex<(Instant, u32)>,
    /// Baldes separados: long-poll e escrita não disputam o mesmo orçamento.
    window_events: Mutex<(Instant, u32)>,
    window_write: Mutex<(Instant, u32)>,
    /// `Idempotency-Key` já vista → (status, corpo) para repetir a resposta sem
    /// duplicar mensagem/auditoria. Janela curta e tamanho limitado.
    idem: Mutex<VecDeque<(String, Instant, u16, String)>>,
}

pub struct Bridge {
    shared: Arc<Shared>,
    server: Mutex<Option<Arc<Server>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    pump: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl Bridge {
    pub fn info(&self) -> BridgeInfo {
        BridgeInfo {
            bot_id: self.shared.bot_id.clone(),
            community_id: self.shared.community_id.clone(),
            // A URL já contém o segredo: o plugin só usa o que o app entrega.
            url: format!("http://127.0.0.1:{}{}", self.shared.port, self.shared.path),
            port: self.shared.port,
            started_at: self.shared.started_at,
        }
    }

    pub fn status(&self) -> BridgeStatus {
        BridgeStatus {
            running: !self.shared.stop.load(Ordering::Relaxed),
            url: Some(format!(
                "http://127.0.0.1:{}{}",
                self.shared.port, self.shared.path
            )),
            port: Some(self.shared.port),
            events_pending: self.shared.events.lock().map(|q| q.len()).unwrap_or(0),
            requests: self.shared.requests.load(Ordering::Relaxed) as u64,
            dropped: self.shared.dropped.load(Ordering::Relaxed) as u64,
        }
    }

    /// Fecha a ponte e espera as threads saírem, sem deixar socket preso.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::SeqCst);
        // Acorda o `recv_timeout` e destrava um long-poll pendente.
        if let Some(server) = self
            .server
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
        {
            server.unblock();
        }
        let _ = std::net::TcpStream::connect(("127.0.0.1", self.shared.port));
        if let Ok(mut t) = self.thread.lock() {
            if let Some(h) = t.take() {
                let _ = h.join();
            }
        }
        if let Ok(mut p) = self.pump.lock() {
            if let Some(h) = p.take() {
                let _ = h.join();
            }
        }
        // DROP do `Server` fecha o listener. Sem isso a porta segue aceitando
        // conexão e o bot continuaria achando que o servidor está no ar.
        self.server.lock().unwrap_or_else(|e| e.into_inner()).take();
    }
}

/// Segredo da ponte: 128 bits em hex, do gerador do próprio core.
fn secret_hex() -> String {
    // `bot_create` já usa esse mesmo gerador para token; reaproveitar evita
    // arrastar `rand`/`hex` como dependência nova no shell.
    distorrent_core::bots::random_secret(32)
}

/// Abre a ponte numa porta (0 = efêmera) e começa a enfileirar eventos.
///
/// Não existe token: o app gera um caminho secreto (`/b/<32 hex>`) e entrega a
/// URL completa ao plugin. Só quem recebeu essa URL fala com a ponte.
pub fn start(
    engine: Arc<NetworkEngine>,
    community_id: String,
    bot_id: String,
    port: u16,
) -> Result<Bridge, String> {
    let server = Server::http(("127.0.0.1", port))
        .map_err(|e| format!("não foi possível abrir 127.0.0.1:{port}: {e}"))?;
    // `ListenAddr` tem variante `Unix` só no Unix: o catch-all cobre as duas
    // plataformas sem deixar o match não-exaustivo no Linux.
    let real_port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => return Err("a ponte só escuta em TCP loopback".to_string()),
    };
    let secret = secret_hex();
    let server = Arc::new(server);
    let shared = Arc::new(Shared {
        bot_id: bot_id.clone(),
        community_id: community_id.clone(),
        path: format!("/b/{secret}"),
        port: real_port,
        started_at: distorrent_core::identity::now_ms(),
        stop: AtomicBool::new(false),
        events: Mutex::new(VecDeque::new()),
        seq: Mutex::new(0),
        requests: AtomicU32::new(0),
        dropped: AtomicU32::new(0),
        window: Mutex::new((Instant::now(), 0)),
        window_events: Mutex::new((Instant::now(), 0)),
        window_write: Mutex::new((Instant::now(), 0)),
        idem: Mutex::new(VecDeque::new()),
    });

    // Pump de eventos: assina o motor e filtra o que interessa a este bot.
    let mut rx = engine.subscribe();
    let pump_shared = shared.clone();
    let pump_bot = bot_id.clone();
    let pump = std::thread::Builder::new()
        .name(format!("botbridge-pump-{bot_id}"))
        .spawn(move || {
            // `blocking_recv` não acorda quando pedimos para parar: o laço vira
            // polling curto, senão o `stop()` ficaria preso no join para sempre.
            while !pump_shared.stop.load(Ordering::Relaxed) {
                match rx.try_recv() {
                    Ok(ev) => {
                        if let Some(q) = to_queued(&community_id, &pump_bot, &ev) {
                            let mut seq = pump_shared.seq.lock().unwrap_or_else(|e| e.into_inner());
                            *seq += 1;
                            let e = QueuedEvent {
                                seq: *seq,
                                event: q.0,
                                data: q.1,
                            };
                            drop(seq);
                            let mut buf =
                                pump_shared.events.lock().unwrap_or_else(|e| e.into_inner());
                            if buf.len() >= MAX_EVENTS_BUFFER {
                                buf.pop_front();
                                pump_shared.dropped.fetch_add(1, Ordering::Relaxed);
                            }
                            buf.push_back(e);
                        }
                    }
                    Err(e) => match e {
                        // Lag significa "perdi eventos": segue vivo.
                        distorrent_core::BroadcastTryRecvError::Lagged(_) => continue,
                        distorrent_core::BroadcastTryRecvError::Empty => {
                            std::thread::sleep(Duration::from_millis(80));
                        }
                        distorrent_core::BroadcastTryRecvError::Closed => break,
                    },
                }
            }
        })
        .map_err(|e| format!("thread de eventos da ponte: {e}"))?;

    let loop_shared = shared.clone();
    let loop_server = server.clone();
    let loop_engine = engine;
    let thread = std::thread::Builder::new()
        .name(format!("botbridge-{bot_id}"))
        .spawn(move || {
            while !loop_shared.stop.load(Ordering::Relaxed) {
                match loop_server.recv_timeout(Duration::from_millis(400)) {
                    Ok(Some(req)) => handle(req, &loop_shared, &loop_engine),
                    Ok(None) => continue,
                    Err(_) => break,
                }
            }
        })
        .map_err(|e| format!("thread da ponte: {e}"))?;

    Ok(Bridge {
        shared,
        server: Mutex::new(Some(server)),
        thread: Mutex::new(Some(thread)),
        pump: Mutex::new(Some(pump)),
    })
}

fn to_queued(cid: &str, bot_id: &str, ev: &EngineEvent) -> Option<(String, serde_json::Value)> {
    use EngineEvent as E;
    let value = serde_json::to_value(ev).ok()?;
    let name = match ev {
        E::MessageNew(_) => "message_new",
        E::MessageStatus { .. } => "message_status",
        E::MemberJoined { .. } => "member_joined",
        E::MemberLeft { .. } => "member_left",
        E::ChannelCreated { .. } => "channel_created",
        E::ChannelDeleted { .. } => "channel_deleted",
        E::ReactionChanged { .. } => "reaction_changed",
        E::MessageEdited { .. } => "message_edited",
        E::MessageDeleted { .. } => "message_deleted",
        E::MessagePinned { .. } => "message_pinned",
        E::VoiceJoined { .. } => "voice_joined",
        E::VoiceLeft { .. } => "voice_left",
        E::VoiceStateChanged { .. } => "voice_state_changed",
        E::CallRoom { .. } => "call_room",
        E::ModerationApplied { .. } => "moderation_applied",
        E::BotCreated { .. } => "bot_created",
        _ => return None,
    };
    // Só eventos do servidor deste bot: o bot não deve ver outro servidor.
    let ev_cid = value
        .get("community_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !ev_cid.is_empty() && ev_cid != cid {
        return None;
    }
    // A mensagem que o PRÓPRIO bot postou volta no stream. Sem este filtro o
    // plugin que responde a `message_new` conversa consigo mesmo até o 429.
    let ev_bot = value.get("bot_id").and_then(|v| v.as_str()).unwrap_or("");
    if matches!(name, "message_new") && !ev_bot.is_empty() && ev_bot == bot_id {
        return None;
    }
    if matches!(name, "message_status") {
        return None;
    }
    Some((name.to_string(), value))
}

fn header(req: &Request, name: &'static str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.equiv(name))
        .map(|h| h.value.as_str().to_string())
}

fn respond(req: Request, status: u16, body: serde_json::Value) {
    let code = StatusCode(status);
    let text = body.to_string();
    let ct = Header::from_bytes(
        &b"content-type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .expect("content-type fixo");
    let nc =
        Header::from_bytes(&b"cache-control"[..], &b"no-store"[..]).expect("cache-control fixo");
    let _ = req.respond(
        Response::from_string(text)
            .with_status_code(code)
            .with_header(ct)
            .with_header(nc),
    );
}

/// Responde e guarda a resposta para a `Idempotency-Key`, quando houver.
fn respond_idem(
    req: Request,
    shared: &Shared,
    key: Option<&String>,
    status: u16,
    body: serde_json::Value,
) {
    if let Some(k) = key {
        idem_store(shared, k, status, &body.to_string());
    }
    respond(req, status, body);
}

fn rate_ok(window: &Mutex<(Instant, u32)>, limit: u32) -> bool {
    let mut w = window.lock().unwrap_or_else(|e| e.into_inner());
    if w.0.elapsed() > Duration::from_secs(60) {
        *w = (Instant::now(), 0);
    }
    w.1 += 1;
    w.1 <= limit
}

/// Comparação em tempo constante do segredo do caminho.
///
/// `str::starts_with` curtocircuita no primeiro byte diferente, então o tempo
/// de resposta vazava o tamanho do prefixo correto — o comentário antigo dizia
/// "tempo constante" sem ser. XOR acumulado sobre o comprimento inteiro não
/// vaza posição.
fn secret_matches(raw: &str, path: &str) -> bool {
    let a = raw.as_bytes();
    let b = path.as_bytes();
    if a.len() < b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..b.len() {
        diff |= a[i] ^ b[i];
    }
    if diff != 0 {
        return false;
    }
    // O que vem depois do segredo tem que ser fronteira de rota, e não parte
    // de outro caminho que só começa igual.
    match a.get(b.len()) {
        None => true,
        Some(c) => *c == b'/' || *c == b'?',
    }
}

/// Resposta idempotente: devolve o que já foi respondido para esta chave.
fn idem_lookup(shared: &Shared, key: &str) -> Option<(u16, String)> {
    let mut q = shared.idem.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    q.retain(|(_, at, _, _)| now.duration_since(*at) < Duration::from_secs(300));
    q.iter()
        .find(|(k, _, _, _)| k == key)
        .map(|(_, _, s, b)| (*s, b.clone()))
}

fn idem_store(shared: &Shared, key: &str, status: u16, body: &str) {
    let mut q = shared.idem.lock().unwrap_or_else(|e| e.into_inner());
    if q.len() >= 200 {
        q.pop_front();
    }
    // 8 KB por resposta é folga suficiente para o corpo de `/v1/message`.
    q.push_back((
        key.to_string(),
        Instant::now(),
        status,
        body.chars().take(8192).collect(),
    ));
}

fn read_json<T: for<'de> Deserialize<'de>>(req: &mut Request) -> Result<T, String> {
    let mut buf = Vec::new();
    req.as_reader()
        .take(MAX_BODY as u64)
        .read_to_end(&mut buf)
        .map_err(|e| format!("corpo ilegível: {e}"))?;
    if buf.len() >= MAX_BODY {
        return Err(format!("corpo grande demais (máx {MAX_BODY} bytes)"));
    }
    serde_json::from_slice(&buf).map_err(|e| format!("JSON inválido: {e}"))
}

fn handle(mut req: Request, shared: &Arc<Shared>, engine: &Arc<NetworkEngine>) {
    shared.requests.fetch_add(1, Ordering::Relaxed);

    // Um navegador manda `Origin` sempre; um programa local, nunca. Bloquear
    // Origin é o que impede uma página aberta de falar com a ponte.
    if header(&req, "origin").is_some() {
        return respond(
            req,
            403,
            serde_json::json!({"error": "origem de navegador não é aceita pela ponte local"}),
        );
    }
    // Anti DNS-rebinding: o Host tem que ser o loopback desta porta.
    let host_ok = header(&req, "host")
        .map(|h| {
            let h = h.to_ascii_lowercase();
            h == format!("127.0.0.1:{}", shared.port) || h == format!("localhost:{}", shared.port)
        })
        .unwrap_or(false);
    if !host_ok {
        return respond(req, 421, serde_json::json!({"error": "Host inválido"}));
    }
    // Segredo no caminho: é a única credencial. Fica fora de qualquer log e é
    // comparado em tempo constante. Sem ele, 404 (não confirma que existe).
    let raw_url = req.url().to_string();
    if !secret_matches(&raw_url, &shared.path) {
        return respond(req, 404, serde_json::json!({"error": "rota inexistente"}));
    }

    // Remove o prefixo secreto: as rotas continuam `/v1/...`.
    let rest_of_url = raw_url[shared.path.len()..].to_string();
    let path = rest_of_url.split('?').next().unwrap_or("").to_string();
    let query = rest_of_url
        .split_once('?')
        .map(|(_, q)| q.to_string())
        .unwrap_or_default();
    let method = req.method().clone();

    // Três baldes: global (protege o processo), long-poll de eventos e escrita.
    // Sem separar, um `/v1/events?wait=25000` em laço consumia o orçamento todo
    // e o bot não conseguia postar nem pedir `/v1/stop`.
    let per_route = if path == "/v1/events" {
        RATE_EVENTS_PER_MIN
    } else {
        RATE_WRITE_PER_MIN
    };
    let route_bucket = if path == "/v1/events" {
        &shared.window_events
    } else {
        &shared.window_write
    };
    if !rate_ok(&shared.window, RATE_PER_MIN) || !rate_ok(route_bucket, per_route) {
        shared.dropped.fetch_add(1, Ordering::Relaxed);
        return respond(
            req,
            429,
            serde_json::json!({
                "error": "limite de requisições por minuto",
                "hint": "respeite o Retry-After e diminua a frequência",
                "retry_after": 60,
            }),
        );
    }

    // `Idempotency-Key`: repetir o mesmo POST (retry de rede do plugin) não pode
    // duplicar mensagem nem entrada de auditoria. Vale só para escrita.
    let idem_key = if method == Method::Post {
        header(&req, "idempotency-key")
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty() && k.len() <= 128)
    } else {
        None
    };
    if let Some(key) = &idem_key {
        if let Some((status, body)) = idem_lookup(shared, key) {
            let value = serde_json::from_str(&body)
                .unwrap_or_else(|_| serde_json::json!({"ok": true, "replayed": true}));
            return respond(req, status, value);
        }
    }

    match (&method, path.as_str()) {
        (Method::Get, "/v1/info") => {
            let channels = engine
                .store
                .channel_rows(&shared.community_id)
                .map(|rows| {
                    rows.into_iter()
                        .map(|c| serde_json::json!({"id": c.id, "name": c.name, "kind": c.kind}))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let members = engine
                .store
                .list_members(&shared.community_id)
                .map(|rows| {
                    rows.into_iter()
                        .map(|(fp, nick, role)| {
                            serde_json::json!({"fp": fp, "nickname": nick, "role": role})
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let me = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| {
                    serde_json::json!({
                        "id": b.id, "name": b.name, "discriminator": b.discriminator,
                        "perms": b.perms, "online": b.online,
                    })
                });
            let community = engine
                .store
                .get_community(&shared.community_id)
                .ok()
                .flatten()
                .map(|(id, name, owner)| {
                    serde_json::json!({"id": id, "name": name, "owner_fp": owner})
                });
            // O plugin descobre o repertório daqui em vez de adivinhar nomes.
            let actions = distorrent_core::moderation::BOT_ACTIONS
                .iter()
                .map(|a| {
                    serde_json::json!({
                        "action": a.action, "perm": a.perm, "args": a.args, "label": a.label,
                    })
                })
                .collect::<Vec<_>>();
            respond(
                req,
                200,
                serde_json::json!({
                    "api": "distorrent-bot/1",
                    "bot": me,
                    "community": community,
                    "channels": channels,
                    "members": members,
                    "actions": actions,
                }),
            );
        }
        (Method::Get, "/v1/events") => {
            let since: u64 = query
                .split('&')
                .find_map(|p| p.strip_prefix("since="))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let wait_ms: u64 = query
                .split('&')
                .find_map(|p| p.strip_prefix("wait="))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
                .min(25_000);
            let deadline = Instant::now() + Duration::from_millis(wait_ms);

            loop {
                {
                    let buf = shared.events.lock().unwrap_or_else(|e| e.into_inner());
                    // Teto por resposta: o cliente pagina pelo `since`, então um
                    // buffer cheio não vira uma resposta de dezenas de MB.
                    let items: Vec<&QueuedEvent> = buf
                        .iter()
                        .filter(|e| e.seq > since)
                        .take(MAX_EVENTS_PER_POLL)
                        .collect();
                    if !items.is_empty() {
                        return respond(
                            req,
                            200,
                            serde_json::json!({"events": items, "since": items.last().map(|e| e.seq)}),
                        );
                    }
                }
                if shared.stop.load(Ordering::Relaxed) {
                    return respond(req, 503, serde_json::json!({"error": "ponte encerrada"}));
                }
                if Instant::now() >= deadline {
                    return respond(req, 200, serde_json::json!({"events": [], "since": null}));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
        }
        (Method::Get, "/v1/limits") => {
            // O criador descobre os limites REAIS da plataforma por aqui, em vez
            // de adivinhar. `implemented:false` é o combinado do §13: não fingir.
            let cfg = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| b.config)
                .unwrap_or_default();
            let parsed = distorrent_core::bots::parse_config(&cfg).unwrap_or_default();
            let prims: Vec<serde_json::Value> = parsed
                .primitives
                .iter()
                .into_iter()
                .map(|(id, on, implemented)| {
                    serde_json::json!({"id": id, "enabled": on, "implemented": implemented})
                })
                .collect();
            respond(
                req,
                200,
                serde_json::json!({
                    "api": "distorrent-bot/1",
                    "mode": parsed.mode.as_str(),
                    "runtime": parsed.runtime.as_str(),
                    "limits": {
                        "requestsPerMinute": RATE_PER_MIN,
                        "eventsPerPoll": MAX_EVENTS_PER_POLL,
                        "maxBodyBytes": MAX_BODY,
                        "maxMessageChars": MAX_POST_CHARS,
                        "maxRepliesPerMinute": parsed.max_replies_per_min,
                        "maxHttpPerMinute": parsed.max_http_per_min,
                        "maxMessagesPerExecution": parsed.max_messages_per_exec,
                        "retentionHours": parsed.retention_hours,
                    },
                    "primitives": prims,
                }),
            );
        }
        (Method::Get, "/v1/health") => {
            let pending = shared.events.lock().map(|q| q.len()).unwrap_or(0);
            let online = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| b.online)
                .unwrap_or(false);
            respond(
                req,
                200,
                serde_json::json!({
                    "ok": !shared.stop.load(Ordering::Relaxed),
                    "online": online,
                    "events_pending": pending,
                    "dropped": shared.dropped.load(Ordering::Relaxed),
                    "requests": shared.requests.load(Ordering::Relaxed),
                }),
            );
        }
        (Method::Get, "/v1/config") => {
            // O próprio bot lê a config dele. Não expõe token de outro bot nem
            // de outro servidor: só este `bot_id`.
            let cfg = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| b.config)
                .unwrap_or_default();
            let parsed = distorrent_core::bots::parse_config(&cfg).unwrap_or_default();
            respond(
                req,
                200,
                serde_json::json!({
                    "prefix": parsed.prefix,
                    "commands": parsed.commands.iter().map(|c| serde_json::json!({
                        "name": c.name,
                        "aliases": c.aliases,
                        "exec": c.exec.as_str(),
                        "permission": c.need.as_str(),
                    })).collect::<Vec<_>>(),
                    "events": parsed.events,
                    "channels": parsed.channels,
                }),
            );
        }
        (Method::Post, "/v1/commands") => {
            // O bot registra/edita os PRÓPRIOS comandos em tempo de execução
            // (um plugin que descobriu rotas novas, por exemplo). A config
            // inteira é revalidada pelo core antes de gravar: o bot não
            // consegue gravar config quebrada nem permissão além da dele.
            let body: ConfigBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            match engine.bot_replace_config(&shared.community_id, &shared.bot_id, &body.config) {
                Ok(n) => {
                    let _ = engine.store.bot_log(
                        &shared.community_id,
                        &shared.bot_id,
                        "info",
                        &format!("o bot atualizou a própria config ({n} comando(s))"),
                    );
                    respond(req, 200, serde_json::json!({"ok": true, "commands": n}))
                }
                Err(e) => respond(req, 400, serde_json::json!({"error": e.to_string()})),
            }
        }
        (Method::Post, "/v1/message") => {
            let body: MessageBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            let text = body.body.trim();
            if text.is_empty() {
                return respond(req, 400, serde_json::json!({"error": "mensagem vazia"}));
            }
            if text.chars().count() > MAX_POST_CHARS {
                return respond(
                    req,
                    400,
                    serde_json::json!({"error": format!("mensagem acima de {MAX_POST_CHARS} caracteres")}),
                );
            }
            // O texto do bot passa pela mesma limpeza de qualquer mensagem.
            let clean = distorrent_core::names::sanitize_text(text, MAX_POST_CHARS);
            if clean.is_empty() {
                return respond(req, 400, serde_json::json!({"error": "mensagem vazia"}));
            }
            let channel = match engine.resolve_channel(&shared.community_id, &body.channel) {
                Some(c) => c,
                None => {
                    return respond_idem(
                        req,
                        shared,
                        idem_key.as_ref(),
                        404,
                        serde_json::json!({"error": format!("canal `{}` não existe", body.channel)}),
                    )
                }
            };
            match engine.bot_post_message(&shared.community_id, &channel, &shared.bot_id, &clean) {
                Ok(m) => respond_idem(
                    req,
                    shared,
                    idem_key.as_ref(),
                    200,
                    serde_json::json!({"ok": true, "message_id": m.id, "channel": channel}),
                ),
                Err(e) => respond_idem(
                    req,
                    shared,
                    idem_key.as_ref(),
                    409,
                    serde_json::json!({"error": e.to_string()}),
                ),
            }
        }
        (Method::Post, "/v1/admin") => {
            let body: AdminBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            match engine.bot_action_in(
                &shared.community_id,
                &shared.bot_id,
                body.action.trim(),
                &body.target,
                &body.reason,
                body.number,
                body.channel.as_deref(),
            ) {
                Ok(text) => {
                    let _ =
                        engine
                            .store
                            .bot_log(&shared.community_id, &shared.bot_id, "info", &text);
                    respond_idem(
                        req,
                        shared,
                        idem_key.as_ref(),
                        200,
                        serde_json::json!({"ok": true, "result": text}),
                    )
                }
                Err(e) => respond_idem(
                    req,
                    shared,
                    idem_key.as_ref(),
                    403,
                    serde_json::json!({"error": e.to_string()}),
                ),
            }
        }
        (Method::Post, "/v1/log") => {
            let body: LogBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            match engine.bot_log_append(
                &shared.community_id,
                &shared.bot_id,
                body.level.trim(),
                &body.message,
            ) {
                Ok(()) => respond(req, 200, serde_json::json!({"ok": true})),
                Err(e) => respond(req, 409, serde_json::json!({"error": e.to_string()})),
            }
        }
        (Method::Post, "/v1/stop") => {
            shared.stop.store(true, Ordering::SeqCst);
            respond(req, 200, serde_json::json!({"ok": true, "stopping": true}));
        }
        _ => respond(
            req,
            404,
            serde_json::json!({
                "error": "rota inexistente",
                "routes": ["GET /v1/info", "GET /v1/events?since=&wait=", "GET /v1/config",
                           "GET /v1/limits", "GET /v1/health",
                           "POST /v1/commands", "POST /v1/message", "POST /v1/admin",
                           "POST /v1/log", "POST /v1/stop"],
            }),
        ),
    }
}

/// Manifesto do bot em pasta: `<pasta>/bot.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotManifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub avatar: String,
    /// A config que já vai para `bots.config` (prefix, commands, events...).
    #[serde(default)]
    pub config: serde_json::Value,
    /// Permissões administrativas declaradas pelo autor do bot.
    #[serde(default)]
    pub perms: i64,
    /// Programa externo opcional. Sem isso, o app executa a DSL embutida.
    #[serde(default, rename = "run")]
    pub run: Option<String>,
    #[serde(default)]
    pub requires: Vec<String>,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImportedFolder {
    pub dir: String,
    pub name: String,
    pub avatar: String,
    pub config: String,
    pub run: Option<String>,
    pub requires: Vec<String>,
    pub description: String,
    /// Permissões que o autor do bot PEDIU. Nunca são aplicadas sozinhas: o
    /// painel mostra e o dono confirma na aba Permissões.
    pub perms: i64,
    /// Caminhos relativos encontrados, para o painel mostrar o que vai rodar.
    pub files: Vec<String>,
}

/// Lê uma pasta de bot, valida o `bot.json` e devolve o que seria importado.
/// Não grava nada: o painel mostra e o dono confirma.
pub fn read_bot_folder(dir: &std::path::Path) -> Result<ImportedFolder, String> {
    let meta = std::fs::metadata(dir).map_err(|e| format!("pasta inacessível: {e}"))?;
    if !meta.is_dir() {
        return Err("selecione uma PASTA de bot (com bot.json dentro)".into());
    }
    let manifest_path = dir.join("bot.json");
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("bot.json não encontrado/ilegível: {e}"))?;
    if raw.len() > 256 * 1024 {
        return Err("bot.json grande demais (máx 256KB)".into());
    }
    let manifest: BotManifest =
        serde_json::from_str(&raw).map_err(|e| format!("bot.json inválido: {e}"))?;
    let name = manifest.name.trim();
    if name.len() < 2 {
        return Err("bot.json precisa de um `name` com pelo menos 2 caracteres".into());
    }
    let config = if manifest.config.is_null() {
        "{}".to_string()
    } else {
        if !manifest.config.is_object() {
            return Err("`config` do bot.json precisa ser um objeto".into());
        }
        manifest.config.to_string()
    };
    // A config passa pelo MESMO parser do core; se ele recusa, o import recusa.
    let parsed = distorrent_core::bots::parse_config(&config)
        .map_err(|e| format!("config do bot.json inválida: {e}"))?;
    if parsed.commands.is_empty() && parsed.events.is_empty() && parsed.webhook.is_none() {
        return Err("o bot não faz nada: declare `commands` (prefixo+comando) ou `events`".into());
    }
    let mut files = Vec::new();
    collect_files(dir, dir, &mut files, 0)?;
    Ok(ImportedFolder {
        dir: dir.display().to_string(),
        name: name.chars().take(32).collect(),
        avatar: if manifest.avatar.trim().is_empty() {
            "🤖".to_string()
        } else {
            manifest.avatar.trim().to_string()
        },
        config,
        run: manifest
            .run
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty()),
        requires: manifest.requires.into_iter().take(16).collect(),
        description: manifest.description.chars().take(500).collect(),
        // Mascarado por PERM_ALL: um bot.json não pode pedir bit que não existe.
        perms: manifest.perms & distorrent_core::moderation::PERM_ALL,
        files,
    })
}

fn collect_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<String>,
    depth: usize,
) -> Result<(), String> {
    if depth > 4 {
        return Ok(());
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("ler pasta: {e}"))?;
    for entry in entries.take(200) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        // Nunca lista segredo nem lixo de build.
        if matches!(name, ".env" | "node_modules" | "target" | ".git" | "dist")
            || name.ends_with(".env")
        {
            continue;
        }
        if path.is_dir() {
            collect_files(root, &path, out, depth + 1)?;
        } else if out.len() < 200 {
            out.push(rel);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Diretório temporário sem `tempfile`: o Cargo.toml do app proíbe
    /// `dev-dependencies` (teste `shareBar` trava isso).
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tempdir() -> TempDir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "distorrent-bottest-{}-{}-{n}",
            std::process::id(),
            distorrent_core::identity::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("tmp");
        TempDir(dir)
    }

    #[test]
    fn pasta_sem_bot_json_e_recusada() {
        let dir = tempdir();
        let erro = read_bot_folder(dir.path()).unwrap_err();
        assert!(erro.contains("bot.json"), "{erro}");
    }

    #[test]
    fn pasta_com_config_vazia_e_recusada() {
        let dir = tempdir();
        std::fs::write(
            dir.path().join("bot.json"),
            r#"{"name":"Vazio","config":{}}"#,
        )
        .unwrap();
        let erro = read_bot_folder(dir.path()).unwrap_err();
        assert!(erro.contains("não faz nada"), "{erro}");
    }

    #[test]
    fn pasta_valida_devolve_config_do_core() {
        let dir = tempdir();
        std::fs::write(
            dir.path().join("bot.json"),
            r#"{"name":"FreireBot","avatar":"🤖","description":"ajuda","config":{"prefix":"!","commands":[{"name":"ajuda","reply":"olá"}]}}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("bot.js"), "// código").unwrap();
        std::fs::write(dir.path().join(".env"), "TOKEN=x").unwrap();
        let imp = read_bot_folder(dir.path()).unwrap();
        assert_eq!(imp.name, "FreireBot");
        assert!(imp.config.contains("ajuda"));
        assert!(imp.files.iter().any(|f| f == "bot.js"));
        assert!(
            !imp.files.iter().any(|f| f.contains(".env")),
            "segredo não entra na lista"
        );
    }

    #[test]
    fn importar_bot_pede_permissao_mas_nao_concede() {
        // `perms` no bot.json e um PEDIDO do autor. O import devolve o valor
        // mascarado por PERM_ALL e nunca grava sozinho: quem concede e o dono.
        let dir = tempdir();
        std::fs::write(
            dir.path().join("bot.json"),
            r#"{"name":"Moderador","perms":999999,"config":{"commands":[{"name":"ping","reply":"pong"}]}}"#,
        )
        .unwrap();
        let imp = read_bot_folder(dir.path()).unwrap();
        assert_eq!(
            imp.perms & !distorrent_core::moderation::PERM_ALL,
            0,
            "bit fora de PERM_ALL nao pode entrar"
        );
        assert_eq!(
            imp.perms,
            999_999 & distorrent_core::moderation::PERM_ALL,
            "o valor e mascarado, nao arredondado"
        );
    }

    #[test]
    fn bot_com_url_invalida_nao_importa() {
        let dir = tempdir();
        std::fs::write(
            dir.path().join("bot.json"),
            r#"{"name":"Ruim","config":{"commands":[{"name":"x","url":"file:///etc/passwd"}]}}"#,
        )
        .unwrap();
        let erro = read_bot_folder(dir.path()).unwrap_err();
        assert!(erro.contains("não faz nada"), "{erro}");
    }

    // --- Ponte HTTP real ---------------------------------------------------

    use std::io::Write;
    use std::net::TcpStream;

    struct Ctx {
        engine: Arc<NetworkEngine>,
        bridge: Bridge,
        cid: String,
        bot_id: String,
        /// Caminho secreto (`/b/<hex>`), entregue pronto ao plugin.
        prefix: String,
        _dir: TempDir,
    }

    fn ctx() -> Ctx {
        let dir = tempdir();
        let store =
            Arc::new(distorrent_core::storage::Store::open(&dir.path().join("db.sqlite")).unwrap());
        let kp = distorrent_core::identity::Keypair::generate();
        let engine = NetworkEngine::new(store, kp, "Dono".into(), dir.path().to_path_buf());
        let cid = engine
            .create_community("Servidor", &["geral".to_string()])
            .unwrap();
        let bot = engine.bot_create(&cid, "Ponte", None, None).unwrap();
        let bridge = start(engine.clone(), cid.clone(), bot.id.clone(), 0).expect("ponte");
        let prefix = bridge
            .info()
            .url
            .split("://")
            .nth(1)
            .and_then(|r| r.find('/').map(|i| r[i..].to_string()))
            .expect("segredo no caminho");
        Ctx {
            engine,
            bridge,
            cid,
            bot_id: bot.id,
            prefix,
            _dir: dir,
        }
    }

    fn request(port: u16, raw: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).expect("conecta");
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s.write_all(raw.as_bytes()).unwrap();
        let mut buf = Vec::new();
        let _ = s.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).to_string()
    }

    fn get(port: u16, prefix: &str, path: &str) -> String {
        request(
            port,
            &format!(
                "GET {prefix}{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            ),
        )
    }

    fn post(port: u16, prefix: &str, path: &str, body: &str) -> String {
        request(
            port,
            &format!(
                "POST {prefix}{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    #[test]
    fn ponte_exige_segredo_no_caminho_e_host_de_loopback() {
        let c = ctx();
        let port = c.bridge.info().port;
        // Sem o caminho secreto a rota nem existe.
        let sem_segredo = get(port, "", "/v1/info");
        assert!(sem_segredo.contains("404"), "{sem_segredo}");
        let segredo_errado = get(port, "/b/00000000000000000000000000000000", "/v1/info");
        assert!(segredo_errado.contains("404"), "{segredo_errado}");
        // Host que não é loopback (DNS rebinding) é recusado.
        let host_errado = request(
            port,
            &format!(
                "GET {}/v1/info HTTP/1.1\r\nHost: evil.example:{port}\r\nConnection: close\r\n\r\n",
                c.prefix
            ),
        );
        assert!(host_errado.contains("421"), "{host_errado}");
        // Navegador manda Origin; a ponte recusa.
        let com_origin = request(
            port,
            &format!(
                "GET {}/v1/info HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: https://evil.example\r\nConnection: close\r\n\r\n",
                c.prefix
            ),
        );
        assert!(com_origin.contains("403"), "{com_origin}");
    }

    #[test]
    fn ponte_serve_info_do_servidor() {
        let c = ctx();
        let res = get(c.bridge.info().port, &c.prefix, "/v1/info");
        assert!(res.contains("200"), "{res}");
        assert!(res.contains("distorrent-bot/1"));
        assert!(res.contains("Ponte"), "nome do bot");
        assert!(res.contains("geral"), "lista de canais");
    }

    #[test]
    fn ponte_publica_mensagem_como_o_bot() {
        let c = ctx();
        let port = c.bridge.info().port;
        let res = post(
            port,
            &c.prefix,
            "/v1/message",
            r#"{"channel":"geral","body":"oi do bot"}"#,
        );
        assert!(res.contains("200"), "{res}");
        let canal = c.engine.resolve_channel(&c.cid, "geral").expect("canal");
        let msgs = c.engine.store.list_messages(&canal, 10).unwrap();
        assert!(
            msgs.iter()
                .any(|m| m.body == "oi do bot" && m.bot_id == c.bot_id),
            "a mensagem precisa sair assinada pelo bot"
        );
    }

    #[test]
    fn ponte_recusa_mensagem_vazia_e_canal_inexistente() {
        let c = ctx();
        let port = c.bridge.info().port;
        let vazia = post(
            port,
            &c.prefix,
            "/v1/message",
            r#"{"channel":"geral","body":"  "}"#,
        );
        assert!(vazia.contains("400"), "{vazia}");
        let sem_canal = post(
            port,
            &c.prefix,
            "/v1/message",
            r#"{"channel":"nao-existe","body":"oi"}"#,
        );
        assert!(sem_canal.contains("404"), "{sem_canal}");
    }

    #[test]
    fn ponte_executa_admin_respeitando_permissao() {
        let c = ctx();
        let port = c.bridge.info().port;
        c.engine
            .store
            .upsert_member(&c.cid, "ffffffffffff", "Alvo", "member")
            .unwrap();
        // Sem permissão: a ponte devolve 403 e não bane ninguém.
        let negado = post(
            port,
            &c.prefix,
            "/v1/admin",
            r#"{"action":"ban","target":"ffffffffffff","reason":"teste"}"#,
        );
        assert!(negado.contains("403"), "{negado}");
        // O dono concede: agora passa.
        c.engine
            .bot_update(
                &c.cid,
                &c.bot_id,
                distorrent_core::storage::BotPatch {
                    perms: Some(distorrent_core::moderation::PERM_BAN),
                    ..Default::default()
                },
            )
            .unwrap();
        let ok = post(
            port,
            &c.prefix,
            "/v1/admin",
            r#"{"action":"ban","target":"ffffffffffff","reason":"teste"}"#,
        );
        assert!(ok.contains("200"), "{ok}");
        assert!(c
            .engine
            .store
            .list_members(&c.cid)
            .unwrap()
            .iter()
            .all(|(fp, _, _)| fp != "ffffffffffff"));
    }

    #[test]
    fn ponte_entrega_eventos_do_servidor() {
        let c = ctx();
        let port = c.bridge.info().port;
        let canal = c.engine.resolve_channel(&c.cid, "geral").unwrap();
        // Um evento de outro servidor NÃO pode aparecer aqui.
        c.engine
            .store
            .upsert_member(&c.cid, "abababababab", "Novo", "member")
            .unwrap();
        c.engine.emit_for_test(EngineEvent::MemberJoined {
            community_id: c.cid.clone(),
            fp: "abababababab".into(),
            nickname: "Novo".into(),
        });
        let res = get(port, &c.prefix, "/v1/events?since=0&wait=3000");
        assert!(res.contains("200"), "{res}");
        assert!(res.contains("member_joined"), "{res}");
        assert!(res.contains("abababababab"), "{res}");
        let _ = canal;
    }

    #[test]
    fn parar_a_ponte_libera_a_porta() {
        let c = ctx();
        let port = c.bridge.info().port;
        c.bridge.stop();
        std::thread::sleep(Duration::from_millis(120));
        assert!(
            std::net::TcpStream::connect(("127.0.0.1", port)).is_err(),
            "o socket precisa fechar ao parar, senão o bot fica falando sozinho"
        );
    }

    fn post_with_key(port: u16, prefix: &str, path: &str, key: &str, body: &str) -> String {
        request(
            port,
            &format!(
                "POST {prefix}{path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nIdempotency-Key: {key}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
    }

    #[test]
    fn idempotency_key_nao_duplica_mensagem() {
        let c = ctx();
        let port = c.bridge.info().port;
        let body = r#"{"channel":"geral","body":"uma vez so"}"#;
        let a = post_with_key(port, &c.prefix, "/v1/message", "k-1", body);
        let b = post_with_key(port, &c.prefix, "/v1/message", "k-1", body);
        assert!(a.contains("200"), "{a}");
        assert!(b.contains("200"), "{b}");
        let canal = c.engine.resolve_channel(&c.cid, "geral").unwrap();
        let msgs = c.engine.store.list_messages(&canal, 20).unwrap();
        let n = msgs.iter().filter(|m| m.body == "uma vez so").count();
        assert_eq!(n, 1, "retry com a mesma chave nao pode duplicar a mensagem");
    }

    #[test]
    fn sem_idempotency_key_duas_chamadas_sao_duas_mensagens() {
        let c = ctx();
        let port = c.bridge.info().port;
        let body = r#"{"channel":"geral","body":"duas vezes"}"#;
        post(port, &c.prefix, "/v1/message", body);
        post(port, &c.prefix, "/v1/message", body);
        let canal = c.engine.resolve_channel(&c.cid, "geral").unwrap();
        let msgs = c.engine.store.list_messages(&canal, 20).unwrap();
        assert_eq!(
            msgs.iter().filter(|m| m.body == "duas vezes").count(),
            2,
            "sem chave, o cliente pediu duas mensagens de proposito"
        );
    }

    #[test]
    fn ponte_nao_devolve_ao_bot_a_mensagem_que_ele_mesmo_postou() {
        let c = ctx();
        let port = c.bridge.info().port;
        post(
            port,
            &c.prefix,
            "/v1/message",
            r#"{"channel":"geral","body":"eco do bot"}"#,
        );
        let res = get(port, &c.prefix, "/v1/events?since=0&wait=1500");
        assert!(res.contains("200"), "{res}");
        assert!(
            !res.contains("eco do bot"),
            "a propria mensagem voltaria como evento e criaria loop: {res}"
        );
    }

    #[test]
    fn ponte_responde_health_e_limits() {
        let c = ctx();
        let port = c.bridge.info().port;
        let health = get(port, &c.prefix, "/v1/health");
        assert!(health.contains("200"), "{health}");
        assert!(
            health.contains("\"ok\": true") || health.contains("\"ok\":true"),
            "{health}"
        );
        let limits = get(port, &c.prefix, "/v1/limits");
        assert!(limits.contains("200"), "{limits}");
        assert!(limits.contains("requestsPerMinute"), "{limits}");
        assert!(
            limits.contains("\"implemented\": false") || limits.contains("\"implemented\":false"),
            "primitiva nao implementada precisa aparecer como tal: {limits}"
        );
    }

    #[test]
    fn ponte_recusa_corpo_acima_do_limite() {
        let c = ctx();
        let port = c.bridge.info().port;
        let gordo = "x".repeat(MAX_BODY + 16);
        let res = post(
            port,
            &c.prefix,
            "/v1/log",
            &format!(r#"{{"level":"info","message":"{gordo}"}}"#),
        );
        assert!(
            res.contains("400") || res.contains("413"),
            "corpo acima do teto tem que ser recusado"
        );
    }

    #[test]
    fn segredo_so_casa_no_caminho_inteiro() {
        assert!(secret_matches("/b/abc123/v1/info", "/b/abc123"));
        assert!(secret_matches("/b/abc123", "/b/abc123"));
        assert!(secret_matches("/b/abc123?x=1", "/b/abc123"));
        assert!(!secret_matches("/b/abc124/v1/info", "/b/abc123"));
        assert!(!secret_matches("/b/abc12/v1/info", "/b/abc123"));
        assert!(!secret_matches("/b/abc1234/v1/info", "/b/abc123"));
        assert!(!secret_matches("/v1/info", "/b/abc123"));
    }
}
