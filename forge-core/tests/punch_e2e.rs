//! E2E HOLE PUNCH (estilo torrent/Radmin) — dois nós que só se falam via
//! relay coordenam furo TCP simultâneo e UPGRADEIAM para direta, sem servidor
//! no caminho de dados. Inclui compat: Hello legado (sem proto_v) = 0.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use forge_core::net::relay::{MemRelay, MultiRelay};

#[test]
fn hello_legado_sem_proto_v_parseia_como_zero() {
    // peers 5.2.x mandam Hello sem proto_v — tem que continuar valendo.
    let old = r#"{"fp":"abc","pubkey_hex":"00","nickname":"x","nonce":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"eph_pub":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"tcp_port":1234}"#;
    let h: forge_core::protocol::Hello = serde_json::from_str(old).unwrap();
    assert_eq!(h.proto_v, 0);
    let new = serde_json::json!({"fp":"abc","pubkey_hex":"00","nickname":"x","nonce":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"eph_pub":[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],"tcp_port":1234,"proto_v":1});
    let h2: forge_core::protocol::Hello = serde_json::from_value(new).unwrap();
    assert_eq!(h2.proto_v, 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn punch_upgrade_relay_para_direta() {
    let hub = MemRelay::new();
    let mk = |nick: &str| {
        let dir = tempfile::tempdir().unwrap();
        let store =
            Arc::new(forge_core::storage::Store::open(&dir.path().join("forge.db")).unwrap());
        let kp = forge_core::identity::Keypair::generate();
        let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
        e.set_relay_backend(Arc::new(MultiRelay::of(vec![Arc::new(hub.clone())])));
        // endpoint "público" = loopback (fura local; prova a mecânica fim a fim)
        e.start_with_discovery(false).unwrap();
        // listener liga assíncrono — espera a porta real
        let port = {
            let t0 = std::time::Instant::now();
            loop {
                let p = e.listen_port();
                if p != 0 {
                    break p;
                }
                assert!(t0.elapsed() < Duration::from_secs(10), "listener não ligou");
                std::thread::sleep(Duration::from_millis(50));
            }
        };
        e.set_public_addr(format!("127.0.0.1:{port}"));
        std::thread::sleep(Duration::from_millis(150));
        (e, dir)
    };
    let (a, _da) = mk("PunchA");
    let (b, _db) = mk("PunchB");
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // amizade 100% via relay (sem TCP direto prévio)
    a.friend_request(&fp_b).unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    let mut accepted_a = false;
    let mut online_b = false;
    while !(accepted_a && online_b) {
        assert!(
            tokio::time::Instant::now() < deadline,
            "amizade via relay não completou"
        );
        tokio::select! {
            Ok(ev) = ev_a.recv() => {
                if matches!(&ev, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b) { accepted_a = true; }
            }
            Ok(ev) = ev_b.recv() => {
                match &ev {
                    EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a => { b.friend_respond(&fp_a, true).unwrap(); }
                    EngineEvent::PeerOnline { fp, .. } if fp == &fp_a => { online_b = true; }
                    _ => {}
                }
            }
        }
    }
    // A primeira sessão PODE ser relay (caso clássico, sem endpoint público)
    // OU já direta (se o announce de endpoint público do bootstrap chegou
    // antes e o NAT/loopback deixou furar — direta é preferida por design).
    // O que o teste prova é o resultado final: direta em ambos os lados.
    let first_state = b.peer_state(&fp_a);
    assert!(
        first_state == NetworkState::Connected,
        "amizade deve completar com sessão estabelecida (veio {first_state:?})"
    );
    let first_via_relay = b.is_peer_via_relay(&fp_a);
    if !first_via_relay {
        eprintln!("nota: 1ª sessão já foi DIRETA (announce venceu o relay) — válido");
    }

    // Punch automático no register → furo loopback → UPGRADE para direta
    // NOS DOIS LADOS antes de conversar (enviar com um lado ainda no relay
    // velho cai no receiver morto do peer = buraco negro; o sweeper cobre
    // em produção, mas o teste prova o caminho limpo).
    // (at_ms = +2500ms + dial + handshake; tolerância folgada.)
    let deadline2 = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let b_direct =
            b.peer_state(&fp_a) == NetworkState::Connected && !b.is_peer_via_relay(&fp_a);
        let a_direct =
            a.peer_state(&fp_b) == NetworkState::Connected && !a.is_peer_via_relay(&fp_b);
        if b_direct && a_direct {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline2,
            "punch não upgradeou para direta (a={a_direct} b={b_direct})"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    // conversa segue na direta (sem relay no caminho)
    let (before_a, _) = a.relay_stats();
    let dm = a.open_dm(&fp_b, "PunchB").unwrap();
    let _m1 = a.send_dm(&dm.id, "oi pela direta furada!").unwrap();
    // direção oposta também (isola lado)
    let dm_b = b.open_dm(&fp_a, "PunchA").unwrap();
    let _m2 = b.send_dm(&dm_b.id, "resposta pela direta!").unwrap();
    let deadline3 = tokio::time::Instant::now() + Duration::from_secs(20);
    let (mut got_ab, mut got_ba) = (false, false);
    while !(got_ab && got_ba) {
        if tokio::time::Instant::now() >= deadline3 {
            panic!("DM pós-punch não chegou (ab={got_ab} ba={got_ba})");
        }
        // timeout nos branches: select sem evento nunca pode travar o teste
        tokio::select! {
            res = tokio::time::timeout(Duration::from_secs(2), ev_b.recv()) => {
                if let Ok(Ok(ev)) = res {
                    // receptor gera id próprio — casa pelo corpo
                    if matches!(&ev, EngineEvent::MessageNew(m) if m.body == "oi pela direta furada!") {
                        got_ab = true;
                    }
                }
            }
            res = tokio::time::timeout(Duration::from_secs(2), ev_a.recv()) => {
                if let Ok(Ok(ev)) = res {
                    if matches!(&ev, EngineEvent::MessageNew(m) if m.body == "resposta pela direta!") {
                        got_ba = true;
                    }
                }
            }
        }
    }
    let (after_a, _) = a.relay_stats();
    assert_eq!(after_a, before_a, "DM pós-upgrade não pode usar o relay");
}
