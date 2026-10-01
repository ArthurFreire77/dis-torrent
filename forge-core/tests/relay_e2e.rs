//! E2E RELAY PURO (v4.3) — dois usuários que NUNCA se alcançam por TCP
//! (sem add_manual_peer, sem discovery) conversam 100% pelo relay.
//!
//! Cobre: dial via relay → handshake autenticado sobre stream virtual →
//! FriendRequest/Accept pelo relay → DM com ACK delivered → flag via_relay.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine};
use forge_core::net::relay::MemRelay;

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

use forge_core::storage::Store;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_only_friend_and_dm() {
    // Relay-only determinístico (ver tests/relay_adverse.rs).
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let hub = MemRelay::new();
    let (a, _da) = spawn_user("RelayA", hub.clone());
    let (b, _db) = spawn_user("RelayB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // NENHUM add_manual_peer, NENHUM endereço trocado: só relay.
    // O pedido sai QueuedOffline e o loop de announce disca via relay.
    let outcome = a.friend_request(&fp_b).unwrap();
    assert_eq!(format!("{outcome:?}"), "QueuedOffline");

    // B recebe o pedido PELO RELAY e aceita
    let req = wait_event(
        &mut ev_b,
        "B recebe pedido via relay",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, nickname } = req else {
        unreachable!()
    };
    assert_eq!(nickname, "RelayA");
    b.friend_respond(&fp, true).unwrap();

    // A vê o aceite PELO RELAY
    wait_event(
        &mut ev_a,
        "A vê aceite via relay",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        60,
    )
    .await;

    // ambos ONLINE — e via relay (sem porta aberta em nenhum lado).
    // (PeerOnline dispara no registro, ANTES do aceite — já foi consumido
    // pelos waits acima; aqui vale o ESTADO, não um segundo evento.)
    assert_eq!(
        a.peer_state(&fp_b),
        forge_core::net::engine::NetworkState::Connected
    );
    assert_eq!(
        b.peer_state(&fp_a),
        forge_core::net::engine::NetworkState::Connected
    );
    assert!(a.is_peer_via_relay(&fp_b), "sessão A→B deve ser relay");
    assert!(b.is_peer_via_relay(&fp_a), "sessão B→A deve ser relay");

    // DM com ACK delivered — tudo pelo relay
    let dm = a.open_dm(&fp_b, "RelayB").unwrap();
    let m1 = a
        .send_dm(&dm.id, "oi pelo relay, sem porta aberta!")
        .unwrap();
    let rec = wait_event(
        &mut ev_b,
        "B recebe DM via relay",
        |e| matches!(e, EngineEvent::MessageNew(_)),
        60,
    )
    .await;
    let EngineEvent::MessageNew(in_b) = rec else {
        unreachable!()
    };
    assert_eq!(in_b.body, "oi pelo relay, sem porta aberta!");
    wait_event(&mut ev_a, "ACK delivered via relay", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m1.id && status == "delivered"), 60).await;

    // resposta volta pelo mesmo túnel
    let dm_b = b.open_dm(&fp_a, "RelayA").unwrap();
    assert_eq!(dm_b.id, dm.id);
    b.send_dm(&dm_b.id, "chegou limpo pelo relay!").unwrap();
    let rec2 = wait_event(
        &mut ev_a,
        "A recebe resposta via relay",
        |e| matches!(e, EngineEvent::MessageNew(m) if m.author_fp == fp_b),
        60,
    )
    .await;
    let EngineEvent::MessageNew(in_a) = rec2 else {
        unreachable!()
    };
    assert_eq!(in_a.body, "chegou limpo pelo relay!");
}
