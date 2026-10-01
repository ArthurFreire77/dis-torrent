//! E2E MQTT REAL (broker público) — mesmo fluxo do relay_e2e, mas sobre a
//! internet de verdade via corretoras MQTT, sem nenhum TCP direto entre nós.
//! Ignorado por padrão em CI sem rede? Não — roda sempre; falha se sem net.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use forge_core::net::relay::{MqttRelay, MultiRelay};
use forge_core::storage::Store;

fn spawn_user(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.set_relay_backend(Arc::new(MultiRelay::of(vec![
        Arc::new(MqttRelay::new("broker.emqx.io", 1883)),
        Arc::new(MqttRelay::new("test.mosquitto.org", 1883)),
    ])));
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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_mqtt_real_internet() {
    // Relay-only determinístico (ver tests/relay_adverse.rs).
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let (a, _da) = spawn_user("MqttA");
    let (b, _db) = spawn_user("MqttB");
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    a.friend_request(&fp_b).unwrap();

    let req = wait_event(
        &mut ev_b,
        "B recebe pedido via MQTT",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        120,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, .. } = req else {
        unreachable!()
    };
    b.friend_respond(&fp, true).unwrap();

    wait_event(
        &mut ev_a,
        "A vê aceite via MQTT",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        120,
    )
    .await;

    // estado online via relay (evento já consumido acima — checa estado)
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

    let dm = a.open_dm(&fp_b, "MqttB").unwrap();
    let m1 = a.send_dm(&dm.id, "oi via MQTT público!").unwrap();
    let rec = wait_event(
        &mut ev_b,
        "B recebe DM via MQTT",
        |e| matches!(e, EngineEvent::MessageNew(_)),
        120,
    )
    .await;
    let EngineEvent::MessageNew(in_b) = rec else {
        unreachable!()
    };
    assert_eq!(in_b.body, "oi via MQTT público!");
    wait_event(&mut ev_a, "ACK delivered via MQTT", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m1.id && status == "delivered"), 120).await;
}
