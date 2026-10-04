//! E2E TÚNEL VIRTUAL (Fase 1) — dois usuários que só se alcançam pelo relay
//! estabelecem sessão X25519 (oferta/resposta via relay) e trocam ping/pong
//! cifrado pelo túnel. Prova: handshake sem IP/porta + datagrama AEAD + RTT.
//!
//! Cobre: TunnelOffer → TunnelAnswer → TunnelUp nos dois lados → ping/pong
//! com `TunnelPong` (rtt_ms >= 0) → IP virtual determinístico `fd9d::/8`.

use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine};
use forge_core::net::relay::MemRelay;
use forge_core::net::vtunnel::virtual_ipv6;

fn spawn_user(nick: &str, hub: MemRelay) -> (std::sync::Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.set_relay_backend(std::sync::Arc::new(hub));
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
async fn tunel_handshake_ping_via_relay() {
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let hub = MemRelay::new();
    let (a, _da) = spawn_user("TunelA", hub.clone());
    let (b, _db) = spawn_user("TunelB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    // IP virtual determinístico: calculável sem rede, único por fp.
    let vip_a = virtual_ipv6(&fp_a);
    let vip_b = virtual_ipv6(&fp_b);
    assert_ne!(vip_a, vip_b);
    assert_eq!(vip_a.segments()[0], 0xfd9d);
    assert_eq!(
        NetworkEngine::tunnel_virtual_ip(&fp_b),
        vip_b.to_string(),
        "engine expõe o mesmo IP determinístico"
    );

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // amizade pelo relay (sessão online nos dois lados)
    let outcome = a.friend_request(&fp_b).unwrap();
    assert_eq!(format!("{outcome:?}"), "QueuedOffline");
    let req = wait_event(
        &mut ev_b,
        "B recebe pedido via relay",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, .. } = req else {
        unreachable!()
    };
    b.friend_respond(&fp, true).unwrap();
    wait_event(
        &mut ev_a,
        "A vê aceite via relay",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        60,
    )
    .await;
    assert_eq!(
        a.peer_state(&fp_b),
        forge_core::net::engine::NetworkState::Connected
    );

    // A pede o túnel: oferta viaja pela sessão relay existente.
    assert!(!a.tunnel_established(&fp_b));
    a.tunnel_request(&fp_b);

    // TunnelUp nos DOIS lados (B estabelece ao aceitar a oferta).
    let up_b = wait_event(
        &mut ev_b,
        "B estabelece o túnel",
        |e| matches!(e, EngineEvent::TunnelUp { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    let EngineEvent::TunnelUp { virtual_ip, .. } = up_b else {
        unreachable!()
    };
    assert_eq!(virtual_ip, vip_a.to_string());
    wait_event(
        &mut ev_a,
        "A estabelece o túnel",
        |e| matches!(e, EngineEvent::TunnelUp { fp, .. } if fp == &fp_b),
        60,
    )
    .await;
    assert!(a.tunnel_established(&fp_b));
    assert!(b.tunnel_established(&fp_a));

    // Ping cifrado ponta a ponta pelo túnel → pong com RTT.
    let id = a.tunnel_ping(&fp_b).unwrap();
    let pong = wait_event(
        &mut ev_a,
        "A recebe pong do túnel",
        |e| matches!(e, EngineEvent::TunnelPong { fp, .. } if fp == &fp_b),
        60,
    )
    .await;
    let EngineEvent::TunnelPong {
        id: got, rtt_ms, ..
    } = pong
    else {
        unreachable!()
    };
    assert_eq!(got, id);
    assert!(rtt_ms >= 0, "RTT honesto e não-negativo");
}

// ─────────── Fase 2: DM e sinalização viajando PELO túnel ───────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunel_dm_e_chamada_via_tunnel() {
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let hub = MemRelay::new();
    let (a, _da) = spawn_user("TunelA", hub.clone());
    let (b, _db) = spawn_user("TunelB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let outcome = a.friend_request(&fp_b).unwrap();
    assert_eq!(format!("{outcome:?}"), "QueuedOffline");
    let req = wait_event(
        &mut ev_b,
        "B recebe pedido via relay",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, .. } = req else {
        unreachable!()
    };
    b.friend_respond(&fp, true).unwrap();
    wait_event(
        &mut ev_a,
        "aceite",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        60,
    )
    .await;

    // túnel sobe (handshake via relay)
    a.tunnel_request(&fp_b);
    wait_event(
        &mut ev_b,
        "túnel B",
        |e| matches!(e, EngineEvent::TunnelUp { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    wait_event(
        &mut ev_a,
        "túnel A",
        |e| matches!(e, EngineEvent::TunnelUp { fp, .. } if fp == &fp_b),
        60,
    )
    .await;
    assert!(a.tunnel_established(&fp_b));

    // Baseline: antes, sessão é via relay e ninguém usou o túnel ainda.
    assert!(
        a.is_peer_via_relay(&fp_b),
        "sessão A→B é relay (carrier do túnel)"
    );
    let before_rx = b.peer_diag(&fp_a).tunnel_rx_frames;
    let before_tx = a.peer_diag(&fp_b).tunnel_tx_frames;

    // DM: send_dm → SendToPeer → com peer só-via-relay, DEVE tunelizar.
    let dm = a.open_dm(&fp_b, "TunelB").unwrap();
    let m1 = a.send_dm(&dm.id, "oi via TÚNEL!").unwrap();
    let rec = wait_event(
        &mut ev_b,
        "B recebe DM via túnel",
        |e| matches!(e, EngineEvent::MessageNew(_)),
        60,
    )
    .await;
    let EngineEvent::MessageNew(in_b) = rec else {
        unreachable!()
    };
    assert_eq!(in_b.body, "oi via TÚNEL!");
    wait_event(&mut ev_a, "ACK volta via túnel", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m1.id && status == "delivered"), 60).await;

    // Prova Material: o tráfego do DM passou PELA sessão do túnel (cifrado
    // + replay-window + AAD), não pelo corpo livre do relay.
    let d_b = b.peer_diag(&fp_a);
    let d_a = a.peer_diag(&fp_b);
    assert!(
        d_b.tunnel_rx_frames > before_rx,
        "B deve ter RECEBIDO frame via túnel"
    );
    assert!(
        d_a.tunnel_tx_frames > before_tx,
        "A deve ter ENVIADO frame via túnel"
    );

    // Sinalização de CHAMADA pelo mesmo caminho: CallInvite via túnel.
    let call_id = a.call_invite(&fp_b, "voice").unwrap();
    let inc = wait_event(
        &mut ev_b,
        "B recebe CallInvite",
        |e| matches!(e, EngineEvent::CallIncoming { from_fp, .. } if from_fp == &fp_a),
        60,
    )
    .await;
    let EngineEvent::CallIncoming { call_id: got, .. } = inc else {
        unreachable!()
    };
    assert_eq!(got, call_id);
    b.call_reject(&call_id, &fp_a, "teste").unwrap();
    wait_event(
        &mut ev_a,
        "A recebe CallReject",
        |e| matches!(e, EngineEvent::CallRejected { call_id: c, .. } if c == &call_id),
        60,
    )
    .await;

    // PONG de um ping pelo túnel mostra RTT real do caminho completo.
    let _ = a.tunnel_ping(&fp_b).unwrap();
    wait_event(
        &mut ev_a,
        "pong final",
        |e| matches!(e, EngineEvent::TunnelPong { fp, .. } if fp == &fp_b),
        60,
    )
    .await;
}

/// Frame GRANDE de sinalização (SDP real tem ~2KB) fragmenta e remonta pelo
/// túnel — valida a remontagem no e2e real (não só unitário).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tunel_fragmenta_frame_grande() {
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let hub = MemRelay::new();
    let (a, _da) = spawn_user("TunelA", hub.clone());
    let (b, _db) = spawn_user("TunelB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let outcome = a.friend_request(&fp_b).unwrap();
    assert_eq!(format!("{outcome:?}"), "QueuedOffline");
    let req = wait_event(
        &mut ev_b,
        "pedido B",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, .. } = req else {
        unreachable!()
    };
    b.friend_respond(&fp, true).unwrap();
    wait_event(
        &mut ev_a,
        "aceite",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        60,
    )
    .await;

    a.tunnel_request(&fp_b);
    wait_event(
        &mut ev_b,
        "túnel B",
        |e| matches!(e, EngineEvent::TunnelUp { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    wait_event(
        &mut ev_a,
        "túnel A",
        |e| matches!(e, EngineEvent::TunnelUp { fp, .. } if fp == &fp_b),
        60,
    )
    .await;

    // SDP grande (200KB > frag 48KB): fragmenta e remonta.
    let sdp = "v=0 ".to_string() + &"a=".repeat(200_000);
    a.call_signal(
        &fp_b,
        forge_core::protocol::SecureFrame::CallOffer {
            call_id: "dummy-call".into(),
            sdp: sdp.clone(),
        },
    )
    .unwrap();
    let ev_offer = wait_event(
        &mut ev_b,
        "B recebe CallOffer grande via túnel",
        |e| matches!(e, EngineEvent::CallOfferEv { sdp, .. } if sdp.len() > 199_000),
        90,
    )
    .await;
    assert!(matches!(ev_offer, EngineEvent::CallOfferEv { .. }));
}
