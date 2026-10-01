//! E2E SINALIZACAO DE CHAMADA VIA RELAY (v4.3) — dois nos que NUNCA se
//! alcancam por TCP (sem add_manual_peer, sem discovery) trocam sinalizacao
//! WebRTC 100% pelo relay.
//!
//! Cobre: friend_request -> accept pelo relay (base de relay_e2e.rs) ->
//! call_invite (só CallIncoming) -> call_accept
//! (CallAcceptedEv) -> call_signal offer -> answer -> ice nos dois sentidos,
//! com integridade de call_id/from_fp/sdp/candidate/mid ponta a ponta.
//!
//! Backend: MemRelay compartilhado dentro de MultiRelay::of + set_relay_backend
//! (padrao de relay_e2e.rs, com multicamada explicita).

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine};
use forge_core::net::relay::{MemRelay, MultiRelay, RelayBackend};
use forge_core::protocol::SecureFrame;
use forge_core::storage::Store;

fn spawn_user(nick: &str, hub: MemRelay) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    // MultiRelay::of com perna unica MemRelay compartilhada (in-memory, sem rede).
    let leg: Arc<dyn RelayBackend> = Arc::new(hub);
    engine.set_relay_backend(Arc::new(MultiRelay::of(vec![leg])));
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
async fn call_signaling_offer_answer_ice_via_relay() {
    // Relay-only determinístico (ver tests/relay_adverse.rs).
    std::env::set_var("FORGE_NO_ANNOUNCE", "1");
    let hub = MemRelay::new();
    let (a, _da) = spawn_user("CallA", hub.clone());
    let (b, _db) = spawn_user("CallB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    // 1) Amizade pelo relay (base): NENHUM add_manual_peer, NENHUM endereco.
    let outcome = a.friend_request(&fp_b).unwrap();
    assert_eq!(format!("{outcome:?}"), "QueuedOffline");

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
    assert_eq!(nickname, "CallA");
    b.friend_respond(&fp, true).unwrap();

    wait_event(
        &mut ev_a,
        "A ve aceite via relay",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        60,
    )
    .await;

    // Ambos ONLINE via relay.
    assert_eq!(
        a.peer_state(&fp_b),
        forge_core::net::engine::NetworkState::Connected
    );
    assert_eq!(
        b.peer_state(&fp_a),
        forge_core::net::engine::NetworkState::Connected
    );
    assert!(a.is_peer_via_relay(&fp_b), "sessao A->B deve ser relay");
    assert!(b.is_peer_via_relay(&fp_a), "sessao B->A deve ser relay");

    // 2) call_invite de A -> B (voz). Envia só CallIncoming.
    let call_id = a.call_invite(&fp_b, "voice").unwrap();
    assert!(!call_id.is_empty(), "call_id nao pode ser vazio");
    assert!(
        call_id.starts_with("call-"),
        "call_id tem prefixo call-: {call_id}"
    );

    // B recebe CallIncoming integro.
    let incoming = wait_event(
        &mut ev_b,
        "B recebe CallIncoming via relay",
        |e| {
            matches!(e, EngineEvent::CallIncoming { call_id: cid, from_fp, kind }
                if cid == &call_id && from_fp == &fp_a && kind == "voice")
        },
        60,
    )
    .await;
    if let EngineEvent::CallIncoming {
        call_id: cid,
        from_fp,
        kind,
    } = incoming
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_a);
        assert_eq!(kind, "voice");
    } else {
        unreachable!();
    }

    // Sem CallOffer dummy: invite envia só CallIncoming; a offer real chega via call_signal abaixo.
    // 3) call_accept de B -> A.
    b.call_accept(&call_id, &fp_a).unwrap();
    let accepted = wait_event(
        &mut ev_a,
        "A recebe CallAcceptedEv via relay",
        |e| {
            matches!(e, EngineEvent::CallAcceptedEv { call_id: cid, from_fp }
                if cid == &call_id && from_fp == &fp_b)
        },
        60,
    )
    .await;
    if let EngineEvent::CallAcceptedEv {
        call_id: cid,
        from_fp,
    } = accepted
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_b);
    } else {
        unreachable!();
    }

    // 4) call_signal offer A -> B (explicito, sdp unico).
    let sdp_offer_ab = "v=0\r\noffer-a-to-b-111";
    a.call_signal(
        &fp_b,
        SecureFrame::CallOffer {
            call_id: call_id.clone(),
            sdp: sdp_offer_ab.to_string(),
        },
    )
    .unwrap();
    let offer_ab = wait_event(
        &mut ev_b,
        "B recebe CallOfferEv A->B via relay",
        |e| {
            matches!(e, EngineEvent::CallOfferEv { call_id: cid, from_fp, sdp }
                if cid == &call_id && from_fp == &fp_a && sdp == sdp_offer_ab)
        },
        60,
    )
    .await;
    if let EngineEvent::CallOfferEv {
        call_id: cid,
        from_fp,
        sdp,
    } = offer_ab
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_a);
        assert_eq!(sdp, sdp_offer_ab);
    } else {
        unreachable!();
    }

    // 5) call_signal answer B -> A.
    let sdp_answer_ba = "v=0\r\nanswer-b-to-a-222";
    b.call_signal(
        &fp_a,
        SecureFrame::CallAnswer {
            call_id: call_id.clone(),
            sdp: sdp_answer_ba.to_string(),
        },
    )
    .unwrap();
    let answer_ba = wait_event(
        &mut ev_a,
        "A recebe CallAnswerEv B->A via relay",
        |e| {
            matches!(e, EngineEvent::CallAnswerEv { call_id: cid, from_fp, sdp }
                if cid == &call_id && from_fp == &fp_b && sdp == sdp_answer_ba)
        },
        60,
    )
    .await;
    if let EngineEvent::CallAnswerEv {
        call_id: cid,
        from_fp,
        sdp,
    } = answer_ba
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_b);
        assert_eq!(sdp, sdp_answer_ba);
    } else {
        unreachable!();
    }

    // 6) call_signal ICE A -> B.
    let cand_ab = "candidate:a-to-b-1";
    a.call_signal(
        &fp_b,
        SecureFrame::CallIce {
            call_id: call_id.clone(),
            candidate: cand_ab.to_string(),
            mid: "0".to_string(),
        },
    )
    .unwrap();
    let ice_ab = wait_event(
        &mut ev_b,
        "B recebe CallIceEv A->B via relay",
        |e| {
            matches!(e, EngineEvent::CallIceEv { call_id: cid, from_fp, candidate, mid }
                if cid == &call_id && from_fp == &fp_a && candidate == cand_ab && mid == "0")
        },
        60,
    )
    .await;
    if let EngineEvent::CallIceEv {
        call_id: cid,
        from_fp,
        candidate,
        mid,
    } = ice_ab
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_a);
        assert_eq!(candidate, cand_ab);
        assert_eq!(mid, "0");
    } else {
        unreachable!();
    }

    // 7) call_signal ICE B -> A (outro sentido).
    let cand_ba = "candidate:b-to-a-1";
    b.call_signal(
        &fp_a,
        SecureFrame::CallIce {
            call_id: call_id.clone(),
            candidate: cand_ba.to_string(),
            mid: "0".to_string(),
        },
    )
    .unwrap();
    let ice_ba = wait_event(
        &mut ev_a,
        "A recebe CallIceEv B->A via relay",
        |e| {
            matches!(e, EngineEvent::CallIceEv { call_id: cid, from_fp, candidate, mid }
                if cid == &call_id && from_fp == &fp_b && candidate == cand_ba && mid == "0")
        },
        60,
    )
    .await;
    if let EngineEvent::CallIceEv {
        call_id: cid,
        from_fp,
        candidate,
        mid,
    } = ice_ba
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_b);
        assert_eq!(candidate, cand_ba);
        assert_eq!(mid, "0");
    } else {
        unreachable!();
    }

    // 8) Sentido reverso completo: offer B -> A + answer A -> B.
    let sdp_offer_ba = "v=0\r\noffer-b-to-a-333";
    b.call_signal(
        &fp_a,
        SecureFrame::CallOffer {
            call_id: call_id.clone(),
            sdp: sdp_offer_ba.to_string(),
        },
    )
    .unwrap();
    let offer_ba = wait_event(
        &mut ev_a,
        "A recebe CallOfferEv B->A via relay",
        |e| {
            matches!(e, EngineEvent::CallOfferEv { call_id: cid, from_fp, sdp }
                if cid == &call_id && from_fp == &fp_b && sdp == sdp_offer_ba)
        },
        60,
    )
    .await;
    if let EngineEvent::CallOfferEv {
        call_id: cid,
        from_fp,
        sdp,
    } = offer_ba
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_b);
        assert_eq!(sdp, sdp_offer_ba);
    } else {
        unreachable!();
    }

    let sdp_answer_ab = "v=0\r\nanswer-a-to-b-444";
    a.call_signal(
        &fp_b,
        SecureFrame::CallAnswer {
            call_id: call_id.clone(),
            sdp: sdp_answer_ab.to_string(),
        },
    )
    .unwrap();
    let answer_ab = wait_event(
        &mut ev_b,
        "B recebe CallAnswerEv A->B via relay",
        |e| {
            matches!(e, EngineEvent::CallAnswerEv { call_id: cid, from_fp, sdp }
                if cid == &call_id && from_fp == &fp_a && sdp == sdp_answer_ab)
        },
        60,
    )
    .await;
    if let EngineEvent::CallAnswerEv {
        call_id: cid,
        from_fp,
        sdp,
    } = answer_ab
    {
        assert_eq!(cid, call_id);
        assert_eq!(from_fp, fp_a);
        assert_eq!(sdp, sdp_answer_ab);
    } else {
        unreachable!();
    }

    // ICE reverso extra com mid distinto (audio/video) — integridade de mid.
    let cand_ab2 = "candidate:a-to-b-2-audio";
    a.call_signal(
        &fp_b,
        SecureFrame::CallIce {
            call_id: call_id.clone(),
            candidate: cand_ab2.to_string(),
            mid: "audio".to_string(),
        },
    )
    .unwrap();
    let ice_ab2 = wait_event(
        &mut ev_b,
        "B recebe 2o CallIceEv A->B (mid audio)",
        |e| {
            matches!(e, EngineEvent::CallIceEv { call_id: cid, from_fp, candidate, mid }
                if cid == &call_id && from_fp == &fp_a && candidate == cand_ab2 && mid == "audio")
        },
        60,
    )
    .await;
    if let EngineEvent::CallIceEv { candidate, mid, .. } = ice_ab2 {
        assert_eq!(candidate, cand_ab2);
        assert_eq!(mid, "audio");
    } else {
        unreachable!();
    }

    let cand_ba2 = "candidate:b-to-a-2-video";
    b.call_signal(
        &fp_a,
        SecureFrame::CallIce {
            call_id: call_id.clone(),
            candidate: cand_ba2.to_string(),
            mid: "video".to_string(),
        },
    )
    .unwrap();
    let ice_ba2 = wait_event(
        &mut ev_a,
        "A recebe 2o CallIceEv B->A (mid video)",
        |e| {
            matches!(e, EngineEvent::CallIceEv { call_id: cid, from_fp, candidate, mid }
                if cid == &call_id && from_fp == &fp_b && candidate == cand_ba2 && mid == "video")
        },
        60,
    )
    .await;
    if let EngineEvent::CallIceEv { candidate, mid, .. } = ice_ba2 {
        assert_eq!(candidate, cand_ba2);
        assert_eq!(mid, "video");
    } else {
        unreachable!();
    }
}
