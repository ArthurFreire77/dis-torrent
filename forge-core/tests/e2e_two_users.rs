//! E2E REAL — dois usuários completos ("Arthur" e "Bruna") em redes
//! DIFERENTES, conectados exclusivamente através de um PROXY TCP (relay
//! público simulado). Nada de localhost direto: todo tráfego passa pelo
//! proxy — igual à internet, onde um lado alcança o outro via endereço
//! público (UPnP/port-forward/relay).
//!
//! Jornada coberta:
//!   1. Handshake autenticado ATRAVÉS do proxy (identidade não pode ser forjada)
//!   2. Pedido de amizade → aceito → ambos veem "accepted"
//!   3. DM ida e volta com ACK "delivered" criptográfico
//!   4. Grupo DM sincronizado (GroupCreated) + mensagens dos dois lados
//!   5. Comunidade: criar → convite assinado → entrar → canais sincronizam
//!   6. Canal novo no host replica no membro; mensagem de canal via relay do host
//!   7. Cargos: criar → atribuir → membro enxerga
//!   8. Kick: membro expulso recebe CommunityKicked e perde o servidor
//!   9. Queda de rede (proxy morto) → mensagem fica PENDING → volta → entrega
//!  10. Reinício do app de Bruna: MESMA identidade (fp estável), histórico intacto

use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::sleep;

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use forge_core::storage::Store;

// ---------------- proxy TCP (relay simulado) ----------------

struct Proxy {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    listener_task: JoinHandle<()>,
    conns: Arc<StdMutex<Vec<JoinHandle<()>>>>,
}

impl Proxy {
    fn start(bind: SocketAddr, target: SocketAddr) -> Self {
        // bind com retry: a porta pode demorar alguns ms a ser liberada após stop()
        let listener = {
            let mut attempts = 0;
            loop {
                match std::net::TcpListener::bind(bind) {
                    Ok(l) => break l,
                    Err(_) if attempts < 50 => {
                        attempts += 1;
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    Err(e) => panic!("bind {bind} falhou: {e}"),
                }
            }
        };
        listener.set_nonblocking(true).unwrap();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let addr = listener.local_addr().unwrap();
        let (shutdown, mut rx) = watch::channel(false);
        let conns: Arc<StdMutex<Vec<JoinHandle<()>>>> = Arc::default();
        let conns_task = conns.clone();
        let listener_task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = rx.changed() => break,
                    accepted = listener.accept() => match accepted {
                        Ok((down, _)) => {
                            let conns = conns_task.clone();
                            let t = tokio::spawn(async move {
                                let mut down = down;
                                // encaminha byte a byte nos dois sentidos — o proxy
                                // NÃO entende o protocolo (só vê bytes cifrados)
                                if let Ok(mut up) = tokio::net::TcpStream::connect(target).await {
                                    let _ = tokio::io::copy_bidirectional(&mut down, &mut up).await;
                                }
                            });
                            conns.lock().unwrap().push(t);
                        }
                        Err(_) => break,
                    },
                }
            }
        });
        Self {
            addr,
            shutdown,
            listener_task,
            conns,
        }
    }

    fn stop(&self) {
        let _ = self.shutdown.send(true);
        self.listener_task.abort();
        for t in self.conns.lock().unwrap().drain(..) {
            t.abort();
        }
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------- helpers ----------------

fn spawn_user(
    nick: &str,
) -> (
    Arc<NetworkEngine>,
    forge_core::identity::Keypair,
    tempfile::TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(
        store,
        kp.clone(),
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, kp, dir)
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

async fn wait_offline_of(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    fp: &str,
    secs: u64,
) {
    wait_event(
        rx,
        "PeerOffline",
        |e| matches!(e, EngineEvent::PeerOffline { fp: f } if f == fp),
        secs,
    )
    .await;
}

/// Espera por CONDIÇÃO DE ESTADO REAL (polling) — imune a eventos repetidos/stale.
async fn wait_until<F: FnMut() -> bool>(desc: &str, mut cond: F, secs: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if cond() {
            return;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timeout: {desc}");
        sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_two_users_via_proxy_full_journey() {
    // ---------- 1) dois usuários, redes diferentes ----------
    let (arthur, _kp_a, _da) = spawn_user("Arthur");
    let (bruna, kp_b, db_b) = spawn_user("Bruna");
    let fp_a = arthur.identity().fingerprint.clone();
    let fp_b = bruna.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b, "identidades devem ser distintas");

    let mut ev_a = arthur.subscribe();
    let mut ev_b = bruna.subscribe();

    // ---------- 2) proxy TCP: Arthur só alcança Bruna via relay ----------
    let target_b: SocketAddr = format!("127.0.0.1:{}", bruna.listen_port())
        .parse()
        .unwrap();
    let proxy = Proxy::start("127.0.0.1:0".parse().unwrap(), target_b);
    println!("[e2e] proxy relay em {} → bruna {}", proxy.addr, target_b);

    arthur.add_manual_peer(proxy.addr, Some(fp_b.clone()));
    wait_event(
        &mut ev_a,
        "Arthur vê Bruna online via proxy",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_b),
        15,
    )
    .await;
    wait_event(
        &mut ev_b,
        "Bruna vê Arthur online",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_a),
        15,
    )
    .await;
    assert_eq!(arthur.peer_state(&fp_b), NetworkState::Connected);
    assert_eq!(bruna.peer_state(&fp_a), NetworkState::Connected);

    // ---------- 3) amizade real A→B→aceite----------
    arthur.friend_request(&fp_b).unwrap();
    let req = wait_event(
        &mut ev_b,
        "Bruna recebe pedido",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        10,
    )
    .await;
    let EngineEvent::FriendRequestIn { fp, nickname } = req else {
        unreachable!()
    };
    assert_eq!(nickname, "Arthur");
    bruna.friend_respond(&fp, true).unwrap();
    wait_event(
        &mut ev_a,
        "Arthur vê aceite",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        10,
    )
    .await;
    assert!(
        arthur
            .friends(Some("accepted"))
            .iter()
            .any(|p| p.fp == fp_b),
        "Arthur tem Bruna como amiga"
    );
    assert!(
        bruna.friends(Some("accepted")).iter().any(|p| p.fp == fp_a),
        "Bruna tem Arthur como amiga"
    );

    // ---------- 4) DM ida e volta (com ACK real) ----------
    let dm = arthur.open_dm(&fp_b, "Bruna").unwrap();
    let m1 = arthur.send_dm(&dm.id, "oi Bruna, tudo bem?").unwrap();
    assert_eq!(m1.status, "sent");
    let rec = wait_event(
        &mut ev_b,
        "Bruna recebe DM",
        |e| matches!(e, EngineEvent::MessageNew(_)),
        10,
    )
    .await;
    let EngineEvent::MessageNew(in_b) = rec else {
        unreachable!()
    };
    assert_eq!(in_b.body, "oi Bruna, tudo bem?");
    wait_event(&mut ev_a, "ACK delivered", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m1.id && status == "delivered"), 10).await;

    let dm_b = bruna.open_dm(&fp_a, "Arthur").unwrap();
    assert_eq!(dm_b.id, dm.id, "id de DM determinístico nos dois lados");
    bruna.send_dm(&dm_b.id, "tudo ótimo, Arthur!").unwrap();
    let rec2 = wait_event(
        &mut ev_a,
        "Arthur recebe resposta",
        |e| matches!(e, EngineEvent::MessageNew(m) if m.author_fp == fp_b),
        10,
    )
    .await;
    let EngineEvent::MessageNew(in_a) = rec2 else {
        unreachable!()
    };
    assert_eq!(in_a.body, "tudo ótimo, Arthur!");
    assert_eq!(arthur.messages(&dm.id).len(), 2);

    // ---------- 5) grupo DM sincronizado ----------
    let grupo = arthur.create_group("Dupla", vec![fp_b.clone()]).unwrap();
    let sync = wait_event(
        &mut ev_b,
        "Bruna recebe GroupCreated",
        |e| matches!(e, EngineEvent::GroupSynced { conv_id, .. } if conv_id == &grupo.id),
        10,
    )
    .await;
    let EngineEvent::GroupSynced { conv_id, title } = sync else {
        unreachable!()
    };
    assert_eq!(title, "Dupla");
    assert_eq!(
        bruna.group_members(&conv_id).len(),
        2,
        "roster do grupo sincronizado"
    );
    arthur.send_dm(&grupo.id, "bem-vinda ao grupo!").unwrap();
    let gm = wait_event(
        &mut ev_b,
        "Bruna recebe msg do grupo",
        |e| matches!(e, EngineEvent::MessageNew(m) if m.conv_id == grupo.id),
        10,
    )
    .await;
    let EngineEvent::MessageNew(gmsg) = gm else {
        unreachable!()
    };
    assert_eq!(gmsg.body, "bem-vinda ao grupo!");
    bruna.send_dm(&grupo.id, "obrigada pelo convite").unwrap();
    let gm2 = wait_event(
        &mut ev_a,
        "Arthur recebe msg do grupo",
        |e| matches!(e, EngineEvent::MessageNew(m) if m.conv_id == grupo.id && m.author_fp == fp_b),
        10,
    )
    .await;
    let EngineEvent::MessageNew(gmsg2) = gm2 else {
        unreachable!()
    };
    assert_eq!(gmsg2.body, "obrigada pelo convite");

    // ---------- 6) comunidade: criar → convite → entrar ----------
    let cid = arthur
        .create_community("Guilda Teste", &["geral".into(), "projetos".into()])
        .unwrap();
    let token = arthur.make_invite(&cid, &fp_b, 60_000).unwrap();
    let joined = bruna.join_community(&token).unwrap();
    assert_eq!(joined, cid);
    wait_event(
        &mut ev_b,
        "Bruna entrou na comunidade",
        |e| matches!(e, EngineEvent::CommunityJoined { community_id, .. } if community_id == &cid),
        10,
    )
    .await;
    assert_eq!(
        bruna.channel_list(&cid).unwrap().len(),
        2,
        "canais iniciais sincronizados"
    );

    // ---------- 7) canal novo no host replica no membro ----------
    let novo = arthur
        .channel_create(&cid, "Memes", "", "DIVERSÃO", "text")
        .unwrap();
    let cid2 = cid.clone();
    let novo_id = novo.id.clone();
    wait_until(
        "Bruna vê canal novo sincronizado",
        || {
            bruna
                .channel_list(&cid2)
                .map(|l| l.iter().any(|c| c.id == novo_id && c.name == "memes"))
                .unwrap_or(false)
        },
        10,
    )
    .await;

    // ---------- 8) mensagem de canal via relay do host ----------
    let geral_id = arthur
        .channel_list(&cid)
        .unwrap()
        .into_iter()
        .find(|c| c.name == "geral")
        .unwrap()
        .id;
    let cm = bruna
        .send_channel_message(&cid, &geral_id, "olá guilda!")
        .unwrap();
    assert_eq!(cm.status, "sent");
    let cmrecv = wait_event(
        &mut ev_a,
        "Arthur recebe msg de canal",
        |e| matches!(e, EngineEvent::MessageNew(m) if m.conv_id == geral_id),
        10,
    )
    .await;
    let EngineEvent::MessageNew(cmsg) = cmrecv else {
        unreachable!()
    };
    assert_eq!(cmsg.body, "olá guilda!");
    assert_eq!(cmsg.author_fp, fp_b);
    wait_event(&mut ev_b, "Bruna vê delivered (ChannelAck)", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &cm.id && status == "delivered"), 10).await;

    // ---------- 9) cargos reais ----------
    let vip = arthur
        .role_create(&cid, "VIP", "#fee75c", 96, true, true)
        .unwrap();
    arthur.member_assign_role(&cid, &fp_b, &vip.id).unwrap();
    let cid3 = cid.clone();
    let vip_id = vip.id.clone();
    let fp_b2 = fp_b.clone();
    wait_until(
        "Bruna sincroniza o cargo VIP",
        || {
            bruna
                .member_roles(&cid3, &fp_b2)
                .map(|r| r.contains(&vip_id))
                .unwrap_or(false)
        },
        10,
    )
    .await;

    // ---------- 10) kick real ----------
    arthur.member_kick(&cid, &fp_b).unwrap();
    wait_event(
        &mut ev_b,
        "Bruna recebe CommunityKicked",
        |e| matches!(e, EngineEvent::CommunityRemoved { community_id } if community_id == &cid),
        10,
    )
    .await;
    assert!(
        !bruna.channel_list(&cid).is_ok() || bruna.channel_list(&cid).unwrap().is_empty() || {
            // comunidade removida localmente: get_community não encontra
            bruna_channel_gone(&bruna, &cid)
        },
        "comunidade deve sumir do lado de Bruna"
    );
    assert!(
        !arthur
            .store_list_members(&cid)
            .iter()
            .any(|(fp, _, _)| fp == &fp_b),
        "Bruna saiu do roster do host"
    );

    // ---------- 11) queda de rede → PENDING → reconexão → entrega ----------
    proxy.stop();
    println!("[e2e] proxy derrubado — simulando queda de internet");
    wait_offline_of(&mut ev_a, &fp_b, 40).await;
    assert_eq!(arthur.peer_state(&fp_b), NetworkState::Reconnecting);
    let pend = arthur.send_dm(&dm.id, "mensagem durante a queda").unwrap();
    assert_eq!(pend.status, "pending", "sem conexão → pendente real");

    let proxy2 = Proxy::start(proxy.addr, target_b); // mesmo endereço público "volta"
    println!("[e2e] proxy restaurado em {}", proxy2.addr);
    wait_event(
        &mut ev_a,
        "reconexão automática via backoff",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_b),
        40,
    )
    .await;
    wait_event(&mut ev_a, "pendente entregue após reconexão", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &pend.id && status == "delivered"), 15).await;
    wait_event(
        &mut ev_b,
        "Bruna recebe a mensagem da queda",
        |e| matches!(e, EngineEvent::MessageNew(m) if m.body == "mensagem durante a queda"),
        15,
    )
    .await;

    // ---------- 12) reinício do app de Bruna: identidade estável ----------
    drop(bruna);
    sleep(Duration::from_millis(300)).await;
    // MESMA chave + MESMO banco = mesma identidade, fingerprint NUNCA muda
    let store_b2 = Arc::new(Store::open(&db_b.path().join("forge.db")).unwrap());
    let bruna2 = Arc::new(NetworkEngine::new(
        store_b2,
        kp_b.clone(),
        "Bruna".into(),
        db_b.path().to_path_buf(),
    ));
    bruna2.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(
        bruna2.identity().fingerprint,
        fp_b,
        "fingerprint estável após reinício"
    );
    let mut ev_b2 = bruna2.subscribe();
    proxy2.stop();
    let proxy3 = Proxy::start(
        proxy.addr,
        format!("127.0.0.1:{}", bruna2.listen_port())
            .parse()
            .unwrap(),
    );
    arthur.add_manual_peer(proxy3.addr, Some(fp_b.clone()));
    wait_event(
        &mut ev_a,
        "reconexão com a nova instância de Bruna",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_b),
        20,
    )
    .await;
    wait_event(
        &mut ev_b2,
        "Bruna2 vê Arthur online",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_a),
        20,
    )
    .await;
    // amizade sobrevive ao reinício (flush reenvia aceite)
    wait_event(
        &mut ev_a,
        "amizade re-sincronizada",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        10,
    )
    .await;
    assert!(arthur
        .friends(Some("accepted"))
        .iter()
        .any(|p| p.fp == fp_b));
    assert!(
        bruna2
            .friends(Some("accepted"))
            .iter()
            .any(|p| p.fp == fp_a),
        "amizade persistida no banco de Bruna"
    );
    // histórico persistido no host
    let hist = arthur.messages(&dm.id);
    assert!(
        hist.iter().any(|m| m.body == "mensagem durante a queda"),
        "histórico intacto após reinício do peer"
    );
}

fn bruna_channel_gone(bruna: &Arc<NetworkEngine>, cid: &str) -> bool {
    bruna
        .store_list_communities()
        .iter()
        .all(|(id, _, _)| id != cid)
}
