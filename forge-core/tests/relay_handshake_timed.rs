//! HANDSHAKE RELAY CRONOMETRADO POR FASE (MemRelay) — mede o caminho feliz:
//! dial→Hello→Ack→Ok→Online→flush→RequestIn→Accepted→DM→ACK.
//!
//! `TimedRelay` embrulha `MemRelay` e classifica cada POST decodificando o
//! envelope (1 chunk = frame completo p/ Hello/Ack/Ok): registra o instante
//! do 1º Hello, 1º Ack, 1º HelloOk e 1º frame de sessão (flush). Eventos do
//! engine dão Online/RequestIn/Accepted/DM/ACK. Tudo impresso em ms desde o
//! `friend_request` (t0 = dial). Sem sleeps próprios — mede o motor puro.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use forge_core::net::engine::{EngineEvent, NetworkEngine};
use forge_core::net::relay::{MemRelay, RelayBackend};
use forge_core::storage::Store;
use forge_core::Result;

#[derive(Debug, Default)]
struct PhaseTimes {
    t_hello: Option<Duration>,
    t_ack: Option<Duration>,
    t_ok: Option<Duration>,
    t_session: Option<Duration>,
}

#[derive(Clone)]
struct TimedRelay {
    inner: MemRelay,
    t0: Arc<StdMutex<Option<Instant>>>,
    phases: Arc<StdMutex<PhaseTimes>>,
}

impl TimedRelay {
    fn new(inner: MemRelay) -> Self {
        Self {
            inner,
            t0: Arc::new(StdMutex::new(None)),
            phases: Arc::new(StdMutex::new(PhaseTimes::default())),
        }
    }
    fn arm(&self, t0: Instant) {
        *self.t0.lock().unwrap_or_else(|e| e.into_inner()) = Some(t0);
    }
    /// Classifica um chunk postado: Hello / HelloAck / HelloOk / sessão.
    fn classify(&self, body: &str) {
        let t0opt = self.t0.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let t0 = match t0opt {
            Some(t) => t,
            None => return,
        };
        let env: serde_json::Value = match serde_json::from_str(body) {
            Ok(v) => v,
            Err(_) => return,
        };
        // Só frames de 1 chunk têm o frame completo neste post.
        if env.get("total").and_then(|v| v.as_u64()) != Some(1) {
            return;
        }
        let data = match env.get("data").and_then(|v| v.as_str()) {
            Some(d) => d,
            None => return,
        };
        let raw = match base64_decode(data) {
            Ok(r) => r,
            Err(_) => return,
        };
        if raw.len() < 4 {
            return;
        }
        let len = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]) as usize;
        if raw.len() != 4 + len {
            return;
        }
        let frame: serde_json::Value = match serde_json::from_slice(&raw[4..]) {
            Ok(f) => f,
            // ciphertext de sessão (não parseia como HandshakeFrame)
            Err(_) => {
                let mut ph = self.phases.lock().unwrap_or_else(|e| e.into_inner());
                if ph.t_session.is_none() {
                    ph.t_session = Some(t0.elapsed());
                }
                return;
            }
        };
        let mut ph = self.phases.lock().unwrap_or_else(|e| e.into_inner());
        let el = t0.elapsed();
        if frame.get("Hello").is_some() && ph.t_hello.is_none() {
            ph.t_hello = Some(el);
        } else if frame.get("HelloAck").is_some() && ph.t_ack.is_none() {
            ph.t_ack = Some(el);
        } else if frame.get("HelloOk").is_some() && ph.t_ok.is_none() {
            ph.t_ok = Some(el);
        }
    }
}

fn base64_decode(s: &str) -> std::result::Result<Vec<u8>, ()> {
    // base64 padrão sem dependência extra (tabela manual, só p/ teste)
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lut = [255u8; 256];
    for (i, c) in T.iter().enumerate() {
        lut[*c as usize] = i as u8;
    }
    let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits = 0;
    for b in bytes {
        let v = lut[b as usize];
        if v == 255 {
            return Err(());
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8 & 0xFF);
        }
    }
    Ok(out)
}

impl RelayBackend for TimedRelay {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            self.classify(body);
            self.inner.post(topic, body).await
        })
    }
    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move { self.inner.poll(topic).await })
    }
    fn wakes(&self) -> Vec<Arc<tokio::sync::Notify>> {
        self.inner.wakes()
    }
}

fn spawn_user(nick: &str, backend: TimedRelay) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.set_relay_backend(Arc::new(backend));
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

async fn wait_event<F: Fn(&EngineEvent) -> bool>(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    desc: &str,
    matches: F,
    secs: u64,
    t0: Instant,
) -> (EngineEvent, Duration) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timeout esperando evento: {desc}");
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) if matches(&ev) => return (ev, t0.elapsed()),
            Ok(Ok(_)) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("erro no canal de eventos ({desc}): {e}"),
            Err(_) => panic!("timeout esperando evento: {desc}"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_handshake_phases_timed() {
    // Relay-only determinístico (ver tests/relay_adverse.rs).
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let hub = MemRelay::new();
    let timed = TimedRelay::new(hub);
    let (a, _da) = spawn_user("TimedA", timed.clone());
    let (b, _db) = spawn_user("TimedB", timed.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let t0 = Instant::now();
    timed.arm(t0);
    let outcome = a.friend_request(&fp_b).unwrap();
    assert_eq!(format!("{outcome:?}"), "QueuedOffline");

    let (_, t_online_a) = wait_event(
        &mut ev_a,
        "A online",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_b),
        60,
        t0,
    )
    .await;
    let (_, t_online_b) = wait_event(
        &mut ev_b,
        "B online",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_a),
        60,
        t0,
    )
    .await;
    let (_, t_req) = wait_event(
        &mut ev_b,
        "B recebe pedido",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        60,
        t0,
    )
    .await;

    // B aceita; A vê o aceite (flush imediato/atrasado do respondente)
    b.friend_respond(&fp_a, true).unwrap();
    let (_, t_acc) = wait_event(
        &mut ev_a,
        "A vê aceite",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        60,
        t0,
    )
    .await;

    // DM + ACK pelo relay
    let dm = a.open_dm(&fp_b, "TimedB").unwrap();
    let m1 = a.send_dm(&dm.id, "fase cronometrada").unwrap();
    let (_, t_dm) = wait_event(
        &mut ev_b,
        "B recebe DM",
        |e| matches!(e, EngineEvent::MessageNew(m) if m.body == "fase cronometrada"),
        60,
        t0,
    )
    .await;
    let (_, t_deliv) = wait_event(&mut ev_a, "ACK delivered", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m1.id && status == "delivered"), 60, t0).await;

    assert!(a.is_peer_via_relay(&fp_b));
    assert!(b.is_peer_via_relay(&fp_a));

    let ph = timed.phases.lock().unwrap_or_else(|e| e.into_inner());
    let ms = |o: Option<Duration>| o.map(|d| d.as_millis());
    eprintln!("=== FASES RELAY MemRelay (ms desde dial) ===");
    eprintln!("dial->Hello(post)   : {:?}", ms(ph.t_hello));
    eprintln!(
        "Hello->Ack(post)    : {:?}",
        ph.t_hello.zip(ph.t_ack).map(|(h, k)| (k - h).as_millis())
    );
    eprintln!(
        "Ack->Ok(post)       : {:?}",
        ph.t_ack.zip(ph.t_ok).map(|(k, o)| (o - k).as_millis())
    );
    eprintln!(
        "Ok->1aSessao(flush) : {:?}",
        ph.t_ok.zip(ph.t_session).map(|(o, s)| (s - o).as_millis())
    );
    eprintln!("dial->A_online      : {}ms", t_online_a.as_millis());
    eprintln!("dial->B_online      : {}ms", t_online_b.as_millis());
    eprintln!(
        "dial->RequestIn     : {}ms (primeiro contato)",
        t_req.as_millis()
    );
    eprintln!("dial->Accepted      : {}ms", t_acc.as_millis());
    eprintln!("dial->DM_recebida   : {}ms", t_dm.as_millis());
    eprintln!("dial->ACK_delivered : {}ms", t_deliv.as_millis());
    eprintln!("=== FIM FASES ===");
}
