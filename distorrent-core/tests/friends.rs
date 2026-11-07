use std::sync::Arc;
use std::time::Duration;

use distorrent_core::net::engine::{EngineEvent, NetworkEngine};
use distorrent_core::storage::Store;
use tempfile::TempDir;

fn spawn_engine(
    nick: &str,
) -> (
    Arc<NetworkEngine>,
    distorrent_core::identity::Keypair,
    TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(
        store,
        kp.clone(),
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, kp, dir)
}

async fn wait_event<F: Fn(&EngineEvent) -> bool>(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    matches: F,
    timeout: Duration,
) -> EngineEvent {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timeout esperando evento");
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) if matches(&ev) => return ev,
            Ok(Ok(_)) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("erro no canal de eventos: {e}"),
            Err(_) => panic!("timeout esperando evento"),
        }
    }
}

fn connect(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>) {
    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(b.identity().fingerprint.clone()));
}

fn spawn_engine_store(nick: &str) -> (Arc<NetworkEngine>, Arc<Store>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(
        store.clone(),
        kp,
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, store, dir)
}

fn friend_status(engine: &Arc<NetworkEngine>, fp: &str) -> String {
    for status in ["pending_in", "pending_out", "accepted", "blocked"] {
        if engine.friends(Some(status)).iter().any(|f| f.fp == fp) {
            return status.to_string();
        }
    }
    "none".into()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn friend_request_accept_flow() {
    let (a, _ka, _da) = spawn_engine("Alice");
    let (b, _kb, _db) = spawn_engine("Bob");
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    connect(&a, &b);
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;

    a.friend_request(&b.identity().fingerprint).unwrap();
    let req = wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::FriendRequestIn { .. }),
        Duration::from_secs(10),
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, nickname } = req else {
        unreachable!()
    };
    assert_eq!(fp, a.identity().fingerprint);
    assert_eq!(nickname, "Alice");

    assert_eq!(friend_status(&b, &fp), "pending_in");
    assert_eq!(friend_status(&a, &b.identity().fingerprint), "pending_out");

    b.friend_respond(&fp, true).unwrap();
    let acc = wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::FriendAccepted { .. }),
        Duration::from_secs(10),
    )
    .await;
    let EngineEvent::FriendAccepted { fp: fp2, nickname } = acc else {
        unreachable!()
    };
    assert_eq!(fp2, b.identity().fingerprint);
    assert_eq!(nickname, "Bob");

    assert_eq!(friend_status(&a, &b.identity().fingerprint), "accepted");
    assert_eq!(friend_status(&b, &a.identity().fingerprint), "accepted");
    assert_eq!(a.friends(Some("accepted")).len(), 1);
    assert_eq!(b.friends(Some("accepted")).len(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn friend_request_reject_flow() {
    let (a, _ka, _da) = spawn_engine("Alice");
    let (b, _kb, _db) = spawn_engine("Bob");
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    connect(&a, &b);
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;

    a.friend_request(&b.identity().fingerprint).unwrap();
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::FriendRequestIn { .. }),
        Duration::from_secs(10),
    )
    .await;

    b.friend_respond(&a.identity().fingerprint, false).unwrap();
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::FriendRemoved { .. }),
        Duration::from_secs(10),
    )
    .await;
    assert_eq!(friend_status(&a, &b.identity().fingerprint), "none");
    assert_eq!(friend_status(&b, &a.identity().fingerprint), "none");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn friend_request_queued_when_offline_and_flushed_on_connect() {
    let (a, _ka, _da) = spawn_engine("Alice");
    let kp_b = distorrent_core::identity::Keypair::generate();
    let fp_b = kp_b.identity("Bob").fingerprint;

    a.friend_request(&fp_b).unwrap();
    assert_eq!(friend_status(&a, &fp_b), "pending_out");

    let dir = tempfile::tempdir().unwrap();
    let store_b = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let engine_b = NetworkEngine::new(store_b, kp_b, "Bob".into(), dir.path().to_path_buf());
    engine_b.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    let mut ev_b = engine_b.subscribe();

    connect(&a, &engine_b);
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;
    let req = wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::FriendRequestIn { .. }),
        Duration::from_secs(15),
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, .. } = req else {
        unreachable!()
    };
    assert_eq!(fp, a.identity().fingerprint);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn blocked_peer_messages_are_rejected() {
    let (a, _ka, _da) = spawn_engine("Alice");
    let (b, _kb, _db) = spawn_engine("Bob");
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    connect(&a, &b);
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;

    b.friend_block(&a.identity().fingerprint).unwrap();
    assert!(b.is_blocked(&a.identity().fingerprint));

    let conv = a.open_dm(&b.identity().fingerprint, "Bob").unwrap();
    a.send_dm(&conv.id, "você não deveria receber isso")
        .unwrap();

    let mut got = false;
    for _ in 0..10 {
        match tokio::time::timeout(Duration::from_millis(100), ev_b.recv()).await {
            Ok(Ok(EngineEvent::MessageNew(_))) => {
                got = true;
                break;
            }
            _ => continue,
        }
    }
    assert!(!got, "mensagem de bloqueado não pode chegar");

    let conv_b_id = Store::dm_conversation_id(&a.identity().fingerprint, &b.identity().fingerprint);
    assert!(b.messages(&conv_b_id).is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn friend_request_cruzado_aceita_sozinho() {
    let (a, _ka, _da) = spawn_engine("Alice");
    let (b, _kb, _db) = spawn_engine("Bob");
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();
    connect(&a, &b);
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;

    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    a.friend_request(&fp_b).unwrap();
    b.friend_request(&fp_a).unwrap();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if friend_status(&a, &fp_b) == "accepted" && friend_status(&b, &fp_a) == "accepted" {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "pedido cruzado não convergiu: a={} b={}",
            friend_status(&a, &fp_b),
            friend_status(&b, &fp_a)
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn friend_resync_apos_aceite_perdido() {
    let (a, sa, _da) = spawn_engine_store("Alice");
    let (b, _sb, _db) = spawn_engine_store("Bob");
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    connect(&a, &b);
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        Duration::from_secs(10),
    )
    .await;

    a.friend_request(&fp_b).unwrap();
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::FriendRequestIn { .. }),
        Duration::from_secs(10),
    )
    .await;
    b.friend_respond(&fp_a, true).unwrap();
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::FriendAccepted { .. }),
        Duration::from_secs(10),
    )
    .await;
    assert_eq!(friend_status(&a, &fp_b), "accepted");
    assert_eq!(friend_status(&b, &fp_a), "accepted");

    sa.set_friend(&fp_b, "", "pending_out").unwrap();
    assert_eq!(friend_status(&a, &fp_b), "pending_out");

    a.friend_request(&fp_b).unwrap();
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::FriendAccepted { .. }),
        Duration::from_secs(10),
    )
    .await;

    assert_eq!(friend_status(&a, &fp_b), "accepted");
    assert_eq!(
        friend_status(&b, &fp_a),
        "accepted",
        "B não pode ser rebaixado para pending_in"
    );
}
