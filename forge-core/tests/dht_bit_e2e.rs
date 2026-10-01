//! DHT MAINLINE BITTORRENT (e2e REAL, internet): prova o RENDEZVOUS
//! descentralizado — dois motores que NUNCA trocaram endereço se acham SÓ
//! pela rede BitTorrent (BEP-5). Relay DESLIGADO (kill-switch), announce
//! desligado, discovery desligado: a ÚNICA fonte é a mainline DHT.
//!
//! O que se prova: o lookup DHT de A no infohash da identidade de B
//! DEVOLVE o endpoint que B anunciou. (Fechar a sessão TCP depois disso
//! depende de reachabilidade — em double-CGNAT nem o BitTorrent conecta
//! sem relay/punch, coberto por outros testes.)
//! Ignorado por padrão (propagação real ~1-3min):
//! `cargo test --test dht_bit_e2e -- --ignored --nocapture`

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::NetworkEngine;
use forge_core::storage::Store;

fn spawn_user(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.start_with_discovery(false).unwrap();
    // relay FORA da equação: a ÚNICA via de descoberta é a DHT BitTorrent.
    engine.set_relay_disabled(true);
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "e2e real na DHT mainline (~1-3min de propagação)"]
async fn dht_bittorrent_entrega_o_endpoint_do_amigo() {
    std::env::set_var("FORGE_DHT", "1"); // liga a DHT (default nos binários)
    std::env::set_var("FORGE_NO_ANNOUNCE", "1"); // sem announce: SÓ a DHT

    let (a, _da) = spawn_user("DhtA");
    let (b, _db) = spawn_user("DhtB");
    let fp_b = b.identity().fingerprint.clone();

    // A pede amizade SEM conhecer endereço nenhum de B — engine enfileira o
    // lookup DHT (infohash derivado do fingerprint de B, blake3-v1).
    a.friend_request(&fp_b).unwrap();

    // Espera o rendezvous: a DHT de A encontra o endpoint anunciado por B.
    // Propagação mainline real: announce (B) → k-maiores nós do infohash →
    // get_peers (A). Normalmente <60s; teto 240s.
    let t0 = std::time::Instant::now();
    loop {
        // lookup direto (mesma API que o loop usa; rate-limit 20s entre chamadas)
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
