use std::sync::Arc;
use std::time::Duration;

use distorrent_core::net::engine::NetworkEngine;
use distorrent_core::storage::Store;

fn spawn_user(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.start_with_discovery(false).unwrap();
    engine.set_relay_disabled(true);
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "e2e real na DHT mainline (~1-3min de propagação)"]
async fn dht_bittorrent_entrega_o_endpoint_do_amigo() {
    std::env::set_var("DISTORRENT_DHT", "1");
    std::env::set_var("DISTORRENT_NO_ANNOUNCE", "1");

    let (a, _da) = spawn_user("DhtA");
    let (b, _db) = spawn_user("DhtB");
    let fp_b = b.identity().fingerprint.clone();

    a.friend_request(&fp_b).unwrap();

    let t0 = std::time::Instant::now();
    loop {
        let found = tokio::task::spawn_blocking({
            let a = a.clone();
            let fp = fp_b.clone();
            move || a.bit_dht_lookup_and_dial(fp)
        })
        .await
        .unwrap();
        if found > 0 {
            eprintln!(
                "DHT entregou {found} endpoint(s) de B em {:?}",
                t0.elapsed()
            );
            break;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(240),
            "DHT não entregou o endpoint de B em 240s — rendezvous falhou"
        );
        tokio::time::sleep(Duration::from_secs(10)).await;
    }
}
