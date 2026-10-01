//! PROVA DIRETA SEM RELAY — quando há TCP direta, NENHUM byte de DM passa pelo servidor.
//!
//! Dois nós com `MemRelay` compartilhado conectam DIRETO via `add_manual_peer`
//! (127.0.0.1, como `e2e_two_users.rs`), viram amigos e trocam 5 DMs com ACK.
//! Assert: `via_relay==false` E delta de `RelayStats` zerado durante a janela
//! das 5 DMs (`posts==0` e `poll_hits==0`). O manager polla o tópico de relay
//! a cada ~1s, mas poll vazio NÃO conta como hit; anúncio `distorrent_a_*`
//! (descoberta) também NÃO conta — só o plano de dados `distorrent_r_*`.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use forge_core::net::relay::MemRelay;
use forge_core::storage::Store;

fn spawn_user(nick: &str, hub: MemRelay) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.set_relay_backend(Arc::new(hub));
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

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

async fn wait_direct(
    a: &Arc<NetworkEngine>,
    b: &Arc<NetworkEngine>,
    fp_a: &str,
    fp_b: &str,
    secs: u64,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let a_ok = a.peer_state(fp_b) == NetworkState::Connected && !a.is_peer_via_relay(fp_b);
        let b_ok = b.peer_state(fp_a) == NetworkState::Connected && !b.is_peer_via_relay(fp_a);
        if a_ok && b_ok {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "direta não estabeleceu: a_state={:?} a_via={} b_state={:?} b_via={}",
            a.peer_state(fp_b),
            a.is_peer_via_relay(fp_b),
            b.peer_state(fp_a),
            b.is_peer_via_relay(fp_a),
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_no_relay_traffic() {
    let hub = MemRelay::new();
    let (a, _da) = spawn_user("DirNoRelayA", hub.clone());
    let (b, _db) = spawn_user("DirNoRelayB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // DIRETA via 127.0.0.1 (como e2e_two_users.rs) — sem depender de anúncio.
    let addr_a: std::net::SocketAddr = format!("127.0.0.1:{}", a.listen_port()).parse().unwrap();
    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(fp_b.clone()));
    b.add_manual_peer(addr_a, Some(fp_a.clone()));

    // Espera a direta dos dois lados (via_relay==false).
    wait_direct(&a, &b, &fp_a, &fp_b, 20).await;
    assert!(!a.is_peer_via_relay(&fp_b), "A→B deve ser direta");
    assert!(!b.is_peer_via_relay(&fp_a), "B→A deve ser direta");

    // Amizade pela DIRETA (já online: o maintain de relay vê online e não disca).
    a.friend_request(&fp_b).unwrap();
    let req = wait_event(
        &mut ev_b,
        "B recebe pedido direto",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        15,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, nickname } = req else {
        unreachable!()
    };
    assert_eq!(nickname, "DirNoRelayA");
    b.friend_respond(&fp, true).unwrap();
    wait_event(
        &mut ev_a,
        "A vê aceite direto",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        15,
    )
    .await;
    assert!(
        !a.is_peer_via_relay(&fp_b),
        "sessão segue direta após amizade"
    );
    assert!(
        !b.is_peer_via_relay(&fp_a),
        "sessão segue direta após amizade"
    );

    // Janela de medida: delta durante as 5 DMs (manager idle polla vazio, sem hits).
    let (p0, h0) = a.relay_stats();
    let (p0b, h0b) = b.relay_stats();
    println!("[direct_norelay] baseline relay_stats A=({p0},{h0}) B=({p0b},{h0b})");

    let dm = a.open_dm(&fp_b, "DirNoRelayB").unwrap();
    for i in 0..5 {
        let body = format!("direct sem relay {i}");
        let m = a.send_dm(&dm.id, &body).unwrap();
        let rec = wait_event(
            &mut ev_b,
            "B recebe DM direta",
            |e| matches!(e, EngineEvent::MessageNew(m) if m.body == body),
            15,
        )
        .await;
        let EngineEvent::MessageNew(got) = rec else {
            unreachable!()
        };
        assert_eq!(got.body, body);
        wait_event(
            &mut ev_a,
            "ACK delivered direto",
            |e| {
                matches!(e, EngineEvent::MessageStatus { msg_id, status }
                if msg_id == &m.id && status == "delivered")
            },
            15,
        )
        .await;
        assert!(
            !a.is_peer_via_relay(&fp_b),
            "DM {i} deve ir pela direta (A→B)"
        );
        assert!(
            !b.is_peer_via_relay(&fp_a),
            "DM {i} deve ir pela direta (B→A)"
        );
    }

    let (p1, h1) = a.relay_stats();
    let (p1b, h1b) = b.relay_stats();
    let dp = p1.saturating_sub(p0);
    let dh = h1.saturating_sub(h0);
    let dpb = p1b.saturating_sub(p0b);
    let dhb = h1b.saturating_sub(h0b);
    println!(
        "[direct_norelay] durante 5 DMs diretas: A posts_delta={dp} poll_hits_delta={dh} abs=({p1},{h1}) | B posts_delta={dpb} poll_hits_delta={dhb} abs=({p1b},{h1b})"
    );
    assert_eq!(a.peer_state(&fp_b), NetworkState::Connected);
    assert!(!a.is_peer_via_relay(&fp_b), "via_relay==false no fim");
    assert!(!b.is_peer_via_relay(&fp_a), "via_relay==false no fim");
    assert_eq!(dp, 0, "nenhum post no relay durante DMs diretas");
    assert_eq!(dh, 0, "nenhum poll-hit no relay durante DMs diretas");
    assert_eq!(dpb, 0, "nenhum post no relay (B) durante DMs diretas");
    assert_eq!(dhb, 0, "nenhum poll-hit no relay (B) durante DMs diretas");
}
