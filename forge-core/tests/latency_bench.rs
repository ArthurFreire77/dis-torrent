//! LATENCY BENCH (DisTorrent) — mede RTT send→delivered nos 3 caminhos.
//!
//! Padrão seguido de `relay_e2e.rs`: `start_with_discovery(false)`, befriend
//! via API (`friend_request` → `FriendRequestIn` → `friend_respond` →
//! `FriendAccepted`), depois `send_dm` + espera `MessageStatus{delivered}`
//! cronometrando `Instant::now()` → evento.
//!
//! - `direct_localhost_rtt`: 2 nós via `add_manual_peer(127.0.0.1)` (TCP
//!   direto, sem relay — hubs `MemRelay` ISOLADOS por nó p/ impossibilitar
//!   rendezvous). 10 DMs ida. Reporta médio/p50/p99.
//! - `relay_mem_rtt`: 2 nós via `MemRelay` COMPARTILHADO, SEM contato TCP
//!   (padrão `relay_e2e.rs`). 5 DMs. Reporta médio/p50/p99 (inclui polls/push).
//! - `relay_mqtt_real_rtt`: 2 nós via brokers públicos reais (padrão
//!   `relay_mqtt_e2e.rs`, `MultiRelay` MQTT). 3 DMs. Reporta médio/p50/p99.
//!
//! Rode com: `cargo test --test latency_bench -- --nocapture --test-threads=1`
//! (serializado p/ não contaminar a latência entre os 3 caminhos).

use std::sync::Arc;
use std::time::{Duration, Instant};

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use forge_core::net::relay::{MemRelay, MqttRelay, MultiRelay};
use forge_core::storage::Store;

// ---------------- helpers ----------------

async fn wait_event<F: Fn(&EngineEvent) -> bool>(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    desc: &str,
    matches: F,
    secs: u64,
) -> EngineEvent {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timeout esperando evento: {desc}");
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) if matches(&ev) => return ev,
            Ok(Ok(_)) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("erro no canal de eventos ({desc}): {e}"),
            Err(_) => panic!("timeout esperando evento: {desc}"),
        }
    }
}

/// (mean_ms, p50_ms, p99_ms, sorted_ms)
fn stats_ms(samples: &[Duration]) -> (f64, f64, f64, Vec<f64>) {
    assert!(!samples.is_empty(), "sem amostras");
    let mut v: Vec<f64> = samples.iter().map(|d| d.as_secs_f64() * 1000.0).collect();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    let mean = v.iter().sum::<f64>() / n as f64;
    let p50 = v[(n * 50 / 100).min(n - 1)];
    let idx99 = ((n as f64 * 0.99).ceil() as usize)
        .saturating_sub(1)
        .min(n - 1);
    let p99 = v[idx99];
    (mean, p50, p99, v)
}

fn report(path: &str, samples: &[Duration]) {
    let (mean, p50, p99, sorted) = stats_ms(samples);
    println!(
        "[latency][{path}] n={} mean={:.2}ms p50={:.2}ms p99={:.2}ms raw_ms={:.2?}",
        samples.len(),
        mean,
        p50,
        p99,
        sorted
            .iter()
            .map(|x| (x * 100.0).round() / 100.0)
            .collect::<Vec<_>>(),
    );
}

fn spawn_direct(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    // Hub ISOLADO por nó => rendezvous via relay impossível; garante TCP direto.
    // Também sobrescreve as rotas MQTT públicas padrão (sem internet neste teste).
    e.set_relay_backend(Arc::new(MemRelay::new()));
    e.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (e, dir)
}

fn spawn_mem(nick: &str, hub: MemRelay) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    e.set_relay_backend(Arc::new(hub));
    e.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (e, dir)
}

fn spawn_mqtt(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    e.set_relay_backend(Arc::new(MultiRelay::of(vec![
        Arc::new(MqttRelay::new("broker.emqx.io", 1883)),
        Arc::new(MqttRelay::new("test.mosquitto.org", 1883)),
    ])));
    e.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (e, dir)
}

/// Befriend via API (padrão relay_e2e.rs). `timeout_s` = espera por etapa.
async fn befriend_via_api(
    a: &Arc<NetworkEngine>,
    b: &Arc<NetworkEngine>,
    ev_a: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    ev_b: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    timeout_s: u64,
) {
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    let _ = a.friend_request(&fp_b).unwrap();
    let req = wait_event(
        ev_b,
        "B recebe FriendRequestIn",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        timeout_s,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, .. } = req else {
        unreachable!()
    };
    b.friend_respond(&fp, true).unwrap();
    wait_event(
        ev_a,
        "A vê FriendAccepted",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        timeout_s,
    )
    .await;
}

/// Uma ida send→delivered cronometrada.
async fn dm_rtt(
    sender: &Arc<NetworkEngine>,
    ev_sender: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    dm_id: &str,
    body: &str,
    timeout_s: u64,
) -> Duration {
    let t0 = Instant::now();
    let m = sender.send_dm(dm_id, body).unwrap();
    let mid = m.id.clone();
    wait_event(
        ev_sender,
        "ACK delivered",
        |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &mid && status == "delivered"),
        timeout_s,
    )
    .await;
    t0.elapsed()
}

// ---------------- 1) direta localhost ----------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_localhost_rtt() {
    let (a, _da) = spawn_direct("BenchDirectA");
    let (b, _db) = spawn_direct("BenchDirectB");
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // TCP direto: A disca no listener real de B via 127.0.0.1 (sem relay).
    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(fp_b.clone()));

    wait_event(
        &mut ev_a,
        "A vê B online (direta)",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_b),
        15,
    )
    .await;
    wait_event(
        &mut ev_b,
        "B vê A online (direta)",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_a),
        15,
    )
    .await;
    assert_eq!(a.peer_state(&fp_b), NetworkState::Connected);
    assert_eq!(b.peer_state(&fp_a), NetworkState::Connected);

    befriend_via_api(&a, &b, &mut ev_a, &mut ev_b, 15).await;

    // Prova de caminho direto (não relay).
    assert!(
        !a.is_peer_via_relay(&fp_b),
        "sessão A→B deveria ser DIRETA (via_relay=false)"
    );
    assert!(
        !b.is_peer_via_relay(&fp_a),
        "sessão B→A deveria ser DIRETA (via_relay=false)"
    );

    let dm = a.open_dm(&fp_b, "BenchDirectB").unwrap();
    const N: usize = 10;
    let mut samples = Vec::with_capacity(N);
    for i in 0..N {
        let d = dm_rtt(&a, &mut ev_a, &dm.id, &format!("bench direct {i}"), 15).await;
        println!(
            "[latency][direct_localhost] msg {i} rtt={:.2}ms",
            d.as_secs_f64() * 1000.0
        );
        samples.push(d);
    }
    report("direct_localhost", &samples);
}

// ---------------- 2) relay em memória ----------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_mem_rtt() {
    // Relay-only determinístico (ver tests/relay_adverse.rs).
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let hub = MemRelay::new();
    let (a, _da) = spawn_mem("BenchMemA", hub.clone());
    let (b, _db) = spawn_mem("BenchMemB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // SEM add_manual_peer, SEM discovery: só relay (padrão relay_e2e.rs).
    befriend_via_api(&a, &b, &mut ev_a, &mut ev_b, 60).await;

    assert_eq!(a.peer_state(&fp_b), NetworkState::Connected);
    assert_eq!(b.peer_state(&fp_a), NetworkState::Connected);
    assert!(a.is_peer_via_relay(&fp_b), "sessão A→B deve ser relay");
    assert!(b.is_peer_via_relay(&fp_a), "sessão B→A deve ser relay");

    let dm = a.open_dm(&fp_b, "BenchMemB").unwrap();
    const N: usize = 5;
    let mut samples = Vec::with_capacity(N);
    for i in 0..N {
        let d = dm_rtt(&a, &mut ev_a, &dm.id, &format!("bench mem {i}"), 60).await;
        println!(
            "[latency][relay_mem] msg {i} rtt={:.2}ms",
            d.as_secs_f64() * 1000.0
        );
        samples.push(d);
    }
    report("relay_mem", &samples);
}

// ---------------- 3) relay MQTT real (brokers públicos) ----------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_mqtt_real_rtt() {
    let (a, _da) = spawn_mqtt("BenchMqttA");
    let (b, _db) = spawn_mqtt("BenchMqttB");
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // SEM TCP direto (padrão relay_mqtt_e2e.rs): tudo via brokers públicos.
    befriend_via_api(&a, &b, &mut ev_a, &mut ev_b, 120).await;

    // Estado online via relay (evento já consumido acima — checa estado c/ poll).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        if a.peer_state(&fp_b) == NetworkState::Connected
            && b.peer_state(&fp_a) == NetworkState::Connected
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "peers não ficaram online via MQTT"
        );
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(a.is_peer_via_relay(&fp_b));
    assert!(b.is_peer_via_relay(&fp_a));

    let dm = a.open_dm(&fp_b, "BenchMqttB").unwrap();
    const N: usize = 3;
    let mut samples = Vec::with_capacity(N);
    for i in 0..N {
        let d = dm_rtt(&a, &mut ev_a, &dm.id, &format!("bench mqtt {i}"), 120).await;
        println!(
            "[latency][relay_mqtt_real] msg {i} rtt={:.2}ms",
            d.as_secs_f64() * 1000.0
        );
        samples.push(d);
    }
    report("relay_mqtt_real", &samples);
}
