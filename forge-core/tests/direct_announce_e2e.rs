//! E2E DIRETA VIA ANÚNCIO (v4.3.6) — B descobre o endpoint de A pelo tópico
//! de anúncio (`distorrent_a_<fp>`) e disca DIRETO (via_relay=false).
//! Prova: descoberta multi-estrada → dial direta → eleição prefere direta.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use forge_core::net::relay::{announce_topic, MemRelay, MultiRelay, RelayBackend};
use forge_core::storage::Store;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn direct_via_mqtt_announce() {
    let hub = MemRelay::new();
    let mk = |nick: &str| {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
        let kp = forge_core::identity::Keypair::generate();
        let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
        e.set_relay_backend(Arc::new(MultiRelay::of(vec![Arc::new(hub.clone())])));
        e.start_with_discovery(false).unwrap();
        (e, dir)
    };
    let (a, _da) = mk("DirA");
    let (b, _db) = mk("DirB");
    let fp_a = a.identity().fingerprint.clone();
    let _fp_b = b.identity().fingerprint.clone();

    // A é "alcançável direto": publica o endpoint real no tópico de anúncio
    // (é o que o tick de announce faz a cada 5s quando há IP público).
    let addr_a = format!("127.0.0.1:{}", a.listen_port());
    let ann = serde_json::json!({ "fp": fp_a, "addr": addr_a, "nickname": "DirA" }).to_string();
    hub.post(&announce_topic(&fp_a), &ann).await.unwrap();

    // B quer A como amigo: lookup imediato + tick acham o anúncio e
    // discam DIRETO (a direta vence o relay na eleição, pode levar 1 ciclo).
    b.friend_request(&fp_a).unwrap();
    let mut ev_b = b.subscribe();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
    loop {
        if b.peer_state(&fp_a) == NetworkState::Connected && !b.is_peer_via_relay(&fp_a) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "B não conectou direto via anúncio"
        );
        match tokio::time::timeout(Duration::from_secs(1), ev_b.recv()).await {
            Ok(Ok(EngineEvent::PeerOnline { fp, .. })) if fp == fp_a => continue,
            _ => continue,
        }
    }
}
