//! forge-host — Community Host headless + tracker bootstrap (v1: nó P2P texto).
//!
//! Roda o mesmo motor do app (forge-core) SEM interface gráfica:
//!
//!   forge-host --nick NodeA --db /tmp/forge-a
//!   forge-host --nick NodeB --db /tmp/forge-b
//!
//! Na mesma rede, os dois se descobrem (UDP) e conectam (TCP autenticado).
//! stdin:
//!   status                      → estado real da rede
//!   peers                       → peers conhecidos + estado
//!   msg <fp|prefixo> <texto>    → envia DM assinada
//!   quit
//!
//! stdout: eventos JSON por linha (peer_online, message_new, message_status...).
//! É a base do Community Host completo (F7): comunidades/convites entram no mesmo binário.
//!
//! ── Tracker bootstrap self-hosted ───────────────────────────────────────────
//! `forge-host --bootstrap 8090` sobe um tracker HTTP para descoberta pela
//! INTERNET (o app anuncia ip:porta e consulta amigos pelo fingerprint —
//! igual torrent num tracker). Ponha num VPS público e aponte os clientes:
//!   FORGE_BOOTSTRAP_URL=http://seu-vps:8090
//! Endpoints: POST /announce · GET /peers/<fp> · GET /healthz (TTL 15 min).

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use forge_core::net::engine::{NetworkEngine, NetworkState};
use forge_core::storage::Store;
use forge_core::Keypair;

/// Entrada anunciada por um peer no tracker.
#[derive(Clone)]
struct Announce {
    addr: String,
    nickname: String,
    ts: std::time::Instant,
}

const TTL: std::time::Duration = std::time::Duration::from_secs(15 * 60);

// ─────────────────────────── tracker bootstrap HTTP ─────────────────────────

async fn bootstrap_server(port: u16) {
    let table: Arc<tokio::sync::Mutex<HashMap<String, Announce>>> = Arc::default();
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("bootstrap: bind :{port} falhou: {e}");
            eprintln!("dica: porta já em uso — tente outra porta com --bootstrap PORTA");
            return;
        }
    };
    println!(
        "{}",
        serde_json::json!({"event":"bootstrap_listening","port": port})
    );

    // limpeza periódica de entradas expiradas (TTL — peers somem se não re-anunciam)
    {
        let table = table.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                table.lock().await.retain(|_, a| a.ts.elapsed() < TTL);
            }
        });
    }

    loop {
        let Ok((mut stream, _)) = listener.accept().await else { break };
        let table = table.clone();
        tokio::spawn(async move {
            let _ = serve_http(&mut stream, table).await;
        });
    }
}

async fn serve_http(
    stream: &mut tokio::net::TcpStream,
    table: Arc<tokio::sync::Mutex<HashMap<String, Announce>>>,
) -> std::io::Result<()> {
    let mut reader = tokio::io::BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await? == 0 {
        return Ok(());
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let path = parts.next().unwrap_or("/").to_string();
    // headers (só precisamos de Content-Length)
    let mut content_len = 0usize;
    loop {
        let mut h = String::new();
        if reader.read_line(&mut h).await? == 0 {
            break;
        }
        let t = h.trim();
        if t.is_empty() {
            break;
        }
        if let Some(v) = t.to_ascii_lowercase().strip_prefix("content-length:") {
            content_len = v.trim().parse().unwrap_or(0);
        }
    }
    if content_len > 64 * 1024 {
        return respond(reader.get_mut(), 413, "payload grande demais").await;
    }
    let mut body = vec![0u8; content_len];
    if content_len > 0 {
        reader.read_exact(&mut body).await?;
    }

    let w = reader.get_mut();
    match (method.as_str(), path.as_str()) {
        ("GET", "/healthz") => respond(w, 200, "ok").await,
        ("POST", "/announce") => {
            let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) else {
                return respond(w, 400, "json inválido").await;
            };
            let fp = v.get("fp").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let addr = v.get("addr").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let nickname = v.get("nickname").and_then(|x| x.as_str()).unwrap_or("").to_string();
            // validação dura: fp hex 12, addr "ip:porta" parseável — nada de lixo na tabela
            if fp.len() != 12 || !fp.chars().all(|c| c.is_ascii_hexdigit()) {
                return respond(w, 400, "fp inválido").await;
            }
            if addr.parse::<std::net::SocketAddr>().is_err() {
                return respond(w, 400, "addr inválido").await;
            }
            table.lock().await.insert(
                fp,
                Announce { addr, nickname, ts: std::time::Instant::now() },
            );
            respond(w, 200, "announced").await
        }
        ("GET", p) if p.starts_with("/peers/") => {
            let fp = p.trim_start_matches("/peers/").to_string();
            let ent = table.lock().await.get(&fp).cloned();
            match ent.filter(|a| a.ts.elapsed() < TTL) {
                Some(a) => {
                    let json = serde_json::json!({"fp": fp, "addr": a.addr, "nickname": a.nickname});
                    respond_json(w, 200, &json).await
                }
                None => respond(w, 404, "peer não anunciado").await,
            }
        }
        _ => respond(w, 404, "não encontrado").await,
    }
}

async fn respond(stream: &mut tokio::net::TcpStream, code: u16, _msg: &str) -> std::io::Result<()> {
    let body = format!("{{\"ok\":{}}}", code == 200);
    respond_raw(stream, code, format!("Content-Type: application/json\r\n"), body).await
}

async fn respond_json(stream: &mut tokio::net::TcpStream, code: u16, json: &serde_json::Value) -> std::io::Result<()> {
    respond_raw(stream, code, "Content-Type: application/json\r\n".to_string(), json.to_string()).await
}

async fn respond_raw(stream: &mut tokio::net::TcpStream, code: u16, ctype: String, body: String) -> std::io::Result<()> {
    let reason = match code { 200 => "OK", 400 => "Bad Request", 404 => "Not Found", 413 => "Payload Too Large", _ => "Error" };
    let resp = format!(
        "HTTP/1.1 {code} {reason}\r\n{ctype}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(resp.as_bytes()).await?;
    stream.flush().await
}

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

#[tokio::main]
async fn main() {
    // PRODUÇÃO: liga a DHT mainline BitTorrent (descoberta descentralizada).
    std::env::set_var("FORGE_DHT", "1");
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,forge_core=info")),
        )
        .init();

    let nick = arg("--nick").unwrap_or_else(|| "Host".into());
    let db = arg("--db").unwrap_or_else(|| "forge-host.db".into());
    let bootstrap_port = arg("--bootstrap").and_then(|p| p.parse::<u16>().ok());

    // tracker bootstrap (opcional): descoberta pela internet, self-hosted
    if let Some(port) = bootstrap_port {
        tokio::spawn(bootstrap_server(port));
    }

    // identidade persistente no db do host (mesma lógica do app)
    let store = Arc::new(Store::open(&PathBuf::from(&db)).expect("abrir db"));
    let keypair = match store.load_identity() {
        Some(_id) => {
            let secret = store.load_secret_hex().expect("secret não encontrada no db");
            Keypair::from_secret_hex(&secret).unwrap_or_else(|e| panic!("secret inválida: {e}"))
        }
        None => {
            let kp = Keypair::generate();
            let id = kp.identity(&nick);
            store.save_identity(&id, &kp.secret_hex()).expect("salvar identidade");
            println!(
                "{}",
                serde_json::json!({"event":"identity_created","fingerprint": id.fingerprint, "nickname": id.nickname})
            );
            kp
        }
    };

    let engine = NetworkEngine::new(store.clone(), keypair.clone(), nick.clone(), PathBuf::from(&db));
    engine.start().expect("iniciar engine");

    // eventos → stdout (JSON lines)
    let mut rx = engine.subscribe();
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    match serde_json::to_string(&ev) {
                        Ok(s) => println!("{s}"),
                        Err(e) => eprintln!("serialização do evento falhou: {e}"),
                    }
                }
                Err(_) => break,
            }
        }
    });

    // info inicial
    println!(
        "{}",
        serde_json::json!({
            "event":"host_ready",
            "nickname": engine.identity().nickname,
            "fingerprint": engine.identity().fingerprint,
            "db": db,
        })
    );

    // stdin: comandos. EOF (daemon/systemd) ≠ saída — host continua rodando.
    let stdin = tokio::io::stdin();
    let mut lines = tokio::io::BufReader::new(stdin).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(l)) => l,
            Ok(None) => {
                tracing::info!("stdin EOF — modo daemon (só 'kill' encerra)");
                std::future::pending::<()>().await;
                unreachable!()
            }
            Err(_) => {
                std::future::pending::<()>().await;
                unreachable!()
            }
        };
        let parts: Vec<&str> = line.trim().splitn(3, ' ').collect();
        match parts.as_slice() {
            ["status"] => {
                let s = engine.aggregated_state();
                println!(
                    "{}",
                    serde_json::json!({
                        "state": match s { NetworkState::Connected => "CONNECTED", NetworkState::Connecting => "CONNECTING", NetworkState::Reconnecting => "RECONNECTING", NetworkState::Disconnected => "DISCONNECTED" },
                        "online_peers": engine.online_peer_fps().len(),
                        "listen_port": engine.listen_port(),
                    })
                );
            }
            ["peers"] => {
                for p in engine.peers() {
                    println!(
                        "{}",
                        serde_json::json!({
                            "fp": p.fp, "nickname": p.nickname, "addr": p.addr,
                            "state": format!("{:?}", engine.peer_state(&p.fp)).to_uppercase(),
                            "origin": p.origin,
                        })
                    );
                }
            }
            ["msg", who, text] => {
                let fp = resolve_peer(&engine, who);
                match fp {
                    Some(fp) => {
                        match engine.open_dm(&fp, "") {
                            Ok(conv) => {
                                match engine.send_dm(&conv.id, text) {
                                    Ok(m) => println!(
                                        "{}",
                                        serde_json::json!({"event":"sent","msg_id": m.id, "status": m.status})
                                    ),
                                    Err(e) => println!("{}", serde_json::json!({"event":"error","context": e.to_string()})),
                                }
                            }
                            Err(e) => println!("{}", serde_json::json!({"event":"error","context": format!("abrir dm: {e}")})),
                        }
                    }
                    None => println!("{}", serde_json::json!({"event":"error","context":"peer desconhecido — use 'peers'"})),
                }
            }
            ["quit"] | ["exit"] => break,
            [] => {}
            _ => println!(
                "{}",
                serde_json::json!({"event":"error","context":"comandos: status | peers | msg <fp|prefixo|nick> <texto> | quit"})
            ),
        }
    }
}

/// Resolve por fingerprint completo, prefixo ou nickname.
fn resolve_peer(engine: &Arc<NetworkEngine>, who: &str) -> Option<String> {
    let peers = engine.peers();
    if let Some(p) = peers.iter().find(|p| p.fp == who) {
        return Some(p.fp.clone());
    }
    if let Some(p) = peers.iter().find(|p| p.fp.starts_with(who)) {
        return Some(p.fp.clone());
    }
    peers
        .iter()
        .find(|p| p.nickname.eq_ignore_ascii_case(who))
        .map(|p| p.fp.clone())
}
