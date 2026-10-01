//! Testes de integração P2P REAIS: dois nós, sockets TCP localhost reais,
//! handshake autenticado, mensagens assinadas, ACK, persistência e
//! sincronização de outbox após reconexão.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use forge_core::storage::Store;
use tempfile::TempDir;
use tokio::sync::broadcast;

fn tmp_store() -> (Arc<Store>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    (store, dir)
}

fn spawn_engine(
    nick: &str,
    discovery: bool,
) -> (Arc<NetworkEngine>, forge_core::identity::Keypair, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(
        store,
        kp.clone(),
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    engine.start_with_discovery(discovery).unwrap();
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

/// Estabelece amizade pelo fluxo real do produto (pedido → aceite).
/// Regra v4.3: DM só entre amigos aceitos — todo teste de DM befriend antes.
async fn befriend(
    a: &Arc<NetworkEngine>,
    b: &Arc<NetworkEngine>,
    ev_a: &mut broadcast::Receiver<EngineEvent>,
    ev_b: &mut broadcast::Receiver<EngineEvent>,
) {
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    a.friend_request(&fp_b).unwrap();
    wait_event(
        ev_b,
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        Duration::from_secs(10),
    )
    .await;
    b.friend_respond(&fp_a, true).unwrap();
    wait_event(
        ev_a,
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        Duration::from_secs(10),
    )
    .await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_nodes_handshake_and_dm_roundtrip() {
    let (a, _kp_a, _da) = spawn_engine("NodeA", false);
    let (b, _kp_b, _db) = spawn_engine("NodeB", false);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(b.identity().fingerprint.clone()));

    // handshake: ambos veem o peer ONLINE
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
    assert_eq!(a.aggregated_state(), NetworkState::Connected);

    // amizade antes de conversar (regra v4.3)
    befriend(&a, &b, &mut ev_a, &mut ev_b).await;

    // A abre DM e envia mensagem REAL
    let conv = a.open_dm(&b.identity().fingerprint, "NodeB").unwrap();
    let stored = a
        .send_dm(&conv.id, "olá Node B — mensagem real via TCP")
        .unwrap();
    assert_eq!(stored.status, "sent"); // transportado → SENT

    // B recebe, valida assinatura e persiste
    let received = wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::MessageNew(_)),
        Duration::from_secs(10),
    )
    .await;
    let EngineEvent::MessageNew(msg_in_b) = received else {
        unreachable!()
    };
    assert_eq!(msg_in_b.body, "olá Node B — mensagem real via TCP");
    assert_eq!(msg_in_b.author_fp, a.identity().fingerprint);
    assert_eq!(msg_in_b.direction, "in");
    // assinatura re-verificada do lado B
    assert!(forge_core::protocol::MessageEnvelope {
        id: msg_in_b.id.clone(),
        conv_id: msg_in_b.conv_id.clone(),
        author_fp: msg_in_b.author_fp.clone(),
        body: msg_in_b.body.clone(),
        ts: msg_in_b.ts,
        sig: msg_in_b.sig.clone(),
    }
    .verify_with_pubkey(&a.identity().pubkey_hex));

    // ACK real: A vê DELIVERED
    let ack = wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::MessageStatus { status, .. } if status == "delivered"),
        Duration::from_secs(10),
    )
    .await;
    let EngineEvent::MessageStatus { msg_id, status } = ack else {
        unreachable!()
    };
    assert_eq!(msg_id, stored.id);
    assert_eq!(status, "delivered");

    // persistência nos DOIS lados
    let msgs_a = a.messages(&conv.id);
    let msgs_b = b.messages(&msg_in_b.conv_id);
    assert_eq!(msgs_a.len(), 1);
    assert_eq!(msgs_b.len(), 1);
    assert_eq!(msgs_a[0].status, "delivered");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reply_roundtrip_both_directions() {
    let (a, _ka, _da) = spawn_engine("Alice", false);
    let (b, _kb, _db) = spawn_engine("Bob", false);
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(b.identity().fingerprint.clone()));
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

    befriend(&a, &b, &mut ev_a, &mut ev_b).await;

    let conv_a = a.open_dm(&b.identity().fingerprint, "Bob").unwrap();
    a.send_dm(&conv_a.id, "pergunta").unwrap();
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::MessageNew(_)),
        Duration::from_secs(10),
    )
    .await;

    // B responde pela SUA conversa (id determinístico — mesmo dos dois lados)
    let conv_b = b.open_dm(&a.identity().fingerprint, "Alice").unwrap();
    assert_eq!(conv_b.id, conv_a.id, "id de DM determinístico por par");
    b.send_dm(&conv_b.id, "resposta").unwrap();

    let reply = wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::MessageNew(_)),
        Duration::from_secs(10),
    )
    .await;
    let EngineEvent::MessageNew(m) = reply else {
        unreachable!()
    };
    assert_eq!(m.body, "resposta");
    assert_eq!(m.author_fp, b.identity().fingerprint);
    assert_eq!(a.messages(&conv_a.id).len(), 2, "histórico completo em A");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn offline_message_is_queued_and_delivered_on_reconnect() {
    let (a, kp_a, _da) = spawn_engine("Sender", false);
    // B ainda NÃO existe — apenas conhecemos o fingerprint dele
    let kp_b = forge_core::identity::Keypair::generate();
    let fp_b = kp_b.identity("Receiver").fingerprint;

    let mut ev_a = a.subscribe();

    // enviar com peer offline → PENDING real (outbox)
    let conv = a.open_dm(&fp_b, "Receiver").unwrap();
    let m1 = a.send_dm(&conv.id, "mensagem enquanto offline 1").unwrap();
    let m2 = a.send_dm(&conv.id, "mensagem enquanto offline 2").unwrap();
    assert_eq!(m1.status, "pending");
    assert_eq!(m2.status, "pending");
    assert_eq!(a.messages(&conv.id).len(), 2);

    // B entra no ar JÁ tendo A como amigo (amizade pré-existente, ex.:
    // backup restaurado) — sem isso o gate v4.3 (DM só de amigo) rejeita
    // o flush, corretamente.
    let (store_b, _dirb) = tmp_store();
    store_b
        .set_friend(&a.identity().fingerprint, "Sender", "accepted")
        .unwrap();
    let engine_b = NetworkEngine::new(store_b, kp_b, "Receiver".into(), std::env::temp_dir());
    engine_b.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    let mut ev_b = engine_b.subscribe();

    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", engine_b.listen_port())
        .parse()
        .unwrap();
    a.add_manual_peer(addr_b, Some(fp_b.clone()));

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

    // outbox flush: B recebe TODAS as pendências
    let r1 = wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::MessageNew(_)),
        Duration::from_secs(15),
    )
    .await;
    let EngineEvent::MessageNew(m1b) = r1 else {
        unreachable!()
    };
    let r2 = wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::MessageNew(_)),
        Duration::from_secs(15),
    )
    .await;
    let EngineEvent::MessageNew(m2b) = r2 else {
        unreachable!()
    };
    let bodies = [m1b.body.clone(), m2b.body.clone()];
    assert!(bodies.contains(&"mensagem enquanto offline 1".to_string()));
    assert!(bodies.contains(&"mensagem enquanto offline 2".to_string()));

    // A recebe ACKs de entrega real
    for _ in 0..2 {
        let _ = wait_event(
            &mut ev_a,
            |e| matches!(e, EngineEvent::MessageStatus { status, .. } if status == "delivered"),
            Duration::from_secs(15),
        )
        .await;
    }
    let final_a = a.messages(&conv.id);
    assert!(
        final_a.iter().all(|m| m.status == "delivered"),
        "todas entregues após reconexão"
    );
    assert_eq!(a.identity().fingerprint, kp_a.fingerprint());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_expected_fingerprint_is_rejected() {
    let (a, _ka, _da) = spawn_engine("A", false);
    let (b, _kb, _db) = spawn_engine("B", false);
    let (c, _kc, _dc) = spawn_engine("C", false);

    // A pede B mas o endereço é do C → verificação de identidade falha e
    // NENHUM evento PeerOnline pode ocorrer (conexão é derrubada pós-handshake).
    let addr_c: std::net::SocketAddr = format!("127.0.0.1:{}", c.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_c, Some(b.identity().fingerprint.clone()));

    tokio::time::sleep(Duration::from_secs(2)).await;

    // o fingerprint esperado (B) NÃO pode constar como conectado
    assert_ne!(
        a.peer_state(&b.identity().fingerprint),
        NetworkState::Connected
    );
    // e o peer autenticado (C) também não foi registrado como online para B's fp
    assert!(!a.online_peer_fps().contains(&b.identity().fingerprint));
}
