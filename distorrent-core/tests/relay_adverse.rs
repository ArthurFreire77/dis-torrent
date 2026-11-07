use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use distorrent_core::net::engine::{
    EngineEvent, NetworkEngine, NetworkState, RELAY_DIAL_ATTEMPT, RELAY_HANDSHAKE_TIMEOUT,
};
use distorrent_core::net::relay::{MultiRelay, RelayBackend};
use distorrent_core::storage::Store;
use distorrent_core::{DistorrentError, Result};

#[derive(Clone)]
struct DelayedLeg {
    hub: Arc<StdMutex<HashMap<String, Vec<String>>>>,
    post_delay: Duration,
    #[allow(dead_code)]
    label: &'static str,
}

impl RelayBackend for DelayedLeg {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            tokio::time::sleep(self.post_delay).await;
            self.hub
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(topic.to_string())
                .or_default()
                .push(body.to_string());
            Ok(())
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move {
            Ok(self
                .hub
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(topic)
                .unwrap_or_default())
        })
    }
}

struct FlakyLeg {
    hub: Arc<StdMutex<HashMap<String, Vec<String>>>>,
    posts: AtomicUsize,
    max_ok_posts: usize,
}

impl FlakyLeg {
    fn new(hub: Arc<StdMutex<HashMap<String, Vec<String>>>>, max_ok_posts: usize) -> Self {
        Self {
            hub,
            posts: AtomicUsize::new(0),
            max_ok_posts,
        }
    }
    fn posts_feitos(&self) -> usize {
        self.posts.load(Ordering::SeqCst)
    }
}

impl RelayBackend for FlakyLeg {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            let n = self.posts.fetch_add(1, Ordering::SeqCst);
            if n < self.max_ok_posts {
                self.hub
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .entry(topic.to_string())
                    .or_default()
                    .push(body.to_string());
                Ok(())
            } else {
                Err(DistorrentError::Protocol(
                    "perna morta: post falhou (radio 4G caiu)".into(),
                ))
            }
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move {
            if self.posts.load(Ordering::SeqCst) >= self.max_ok_posts {
                return Err(DistorrentError::Protocol("perna morta: poll falhou".into()));
            }
            Ok(self
                .hub
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(topic)
                .unwrap_or_default())
        })
    }
}

fn spawn_with_backend(
    nick: &str,
    backend: Arc<dyn RelayBackend>,
) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.set_relay_backend(backend);
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

async fn wait_both_not_online(
    a: &Arc<NetworkEngine>,
    fp_b: &str,
    b: &Arc<NetworkEngine>,
    fp_a: &str,
    secs: u64,
) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if a.peer_state(fp_b) != NetworkState::Connected
            && b.peer_state(fp_a) != NetworkState::Connected
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "peers não caíram após disconnect em {secs}s"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn wait_both_online(
    a: &Arc<NetworkEngine>,
    fp_b: &str,
    b: &Arc<NetworkEngine>,
    fp_a: &str,
    secs: u64,
) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if a.peer_state(fp_b) == NetworkState::Connected
            && b.peer_state(fp_a) == NetworkState::Connected
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "peers não (re)conectaram em {secs}s"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_asymmetric_latency_4s_vs_200ms() {
    std::env::set_var("DISTORRENT_NO_ANNOUNCE", "1");
    eprintln!("=== ANGULO 1: latência assimétrica A→B=4s / B→A=200ms ===");
    eprintln!("consts: RELAY_DIAL_ATTEMPT={RELAY_DIAL_ATTEMPT:?} RELAY_HANDSHAKE_TIMEOUT={RELAY_HANDSHAKE_TIMEOUT:?}");
    eprintln!("consts internas (src/net/transport.rs): HANDSHAKE_TIMEOUT=8s por read_frame, handshake_stream total=16s");
    eprintln!(
        "poller: relay_manager_loop 1-1.5s (latência efetiva 1 voo = post_delay + 0..1.5s poll)"
    );

    let hub: Arc<StdMutex<HashMap<String, Vec<String>>>> = Arc::new(StdMutex::new(HashMap::new()));
    let leg_a: Arc<dyn RelayBackend> = Arc::new(DelayedLeg {
        hub: hub.clone(),
        post_delay: Duration::from_secs(4),
        label: "A-post-4s",
    });
    let leg_b: Arc<dyn RelayBackend> = Arc::new(DelayedLeg {
        hub: hub.clone(),
        post_delay: Duration::from_millis(200),
        label: "B-post-200ms",
    });
    let (a, _da) = spawn_with_backend("AsymA", leg_a);
    let (b, _db) = spawn_with_backend("AsymB", leg_b);
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let t0 = Instant::now();
    let outcome = a.friend_request(&fp_b).unwrap();
    eprintln!(
        "t+{:?}: A friend_request -> {outcome:?} (esperado QueuedOffline)",
        t0.elapsed()
    );

    let req = wait_event(
        &mut ev_b,
        "B recebe pedido com latência assimétrica",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        100,
    )
    .await;
    let t_req = t0.elapsed();
    let EngineEvent::FriendRequestIn { fp, nickname } = req else {
        unreachable!()
    };
    assert_eq!(nickname, "AsymA");
    eprintln!("t+{t_req:?}: B recebeu FriendRequestIn de {fp}");
    eprintln!("  -> pedido levou {t_req:?} (handshake 3 voos + 1 frame pedido). RTT ideal ~= (4+2)+(0.2+2)+(4+2) + pedido(4+2) ~= 20s");

    b.friend_respond(&fp, true).unwrap();
    wait_event(
        &mut ev_a,
        "A vê aceite com latência assimétrica",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        100,
    )
    .await;
    let t_acc = t0.elapsed();
    eprintln!("t+{t_acc:?}: A recebeu FriendAccepted");

    wait_both_online(&a, &fp_b, &b, &fp_a, 30).await;
    let t_on = t0.elapsed();
    eprintln!(
        "t+{t_on:?}: ambos ONLINE via_relay={} / {}",
        a.is_peer_via_relay(&fp_b),
        b.is_peer_via_relay(&fp_a)
    );
    assert!(a.is_peer_via_relay(&fp_b), "sessão A→B deve ser relay");
    assert!(b.is_peer_via_relay(&fp_a), "sessão B→A deve ser relay");

    let dm = a.open_dm(&fp_b, "AsymB").unwrap();
    let t_dm0 = Instant::now();
    let m1 = a.send_dm(&dm.id, "oi 4G assimétrico: A→B 4s!").unwrap();
    let rec = wait_event(
        &mut ev_b,
        "B recebe DM pela perna lenta",
        |e| matches!(e, EngineEvent::MessageNew(_)),
        60,
    )
    .await;
    let t_dm = t_dm0.elapsed();
    let EngineEvent::MessageNew(in_b) = rec else {
        unreachable!()
    };
    assert_eq!(in_b.body, "oi 4G assimétrico: A→B 4s!");
    eprintln!("DM A→B entregue em {t_dm:?} (esperado ~4s post + 0..2s poll ~= 4..6s)");
    assert!(
        t_dm >= Duration::from_secs(3),
        "DM deveria custar >=3s na perna de 4s (sanity da latência injetada)"
    );

    wait_event(
        &mut ev_a,
        "ACK delivered volta pela perna rápida",
        |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m1.id && status == "delivered"),
        60,
    )
    .await;
    let t_ack = t_dm0.elapsed();
    eprintln!("ACK B→A (perna 200ms) fechou em {t_ack:?} total (DM+ACK)");

    eprintln!("--- VEREDITO ANGULO 1 ---");
    eprintln!(
        "pedido A→B (handshake+pedido): {t_req:?} | aceite completo: {t_acc:?} | online: {t_on:?}"
    );
    if t_req > RELAY_DIAL_ATTEMPT {
        eprintln!("GARGALO: pedido levou {t_req:?} > RELAY_DIAL_ATTEMPT ({RELAY_DIAL_ATTEMPT:?}): a 1ª tentativa de DIAL estourou, precisou redial (backoff 3s→5s→...). Em 4G real o dial cai 1x antes de conectar.");
    } else {
        eprintln!("RELAY_DIAL_ATTEMPT ({RELAY_DIAL_ATTEMPT:?}) AGUENTOU o handshake assimétrico de 1ª (pedido em {t_req:?}). Margem: {:?}.", RELAY_DIAL_ATTEMPT.saturating_sub(t_req));
    }
    if t_acc > Duration::from_secs(16) {
        eprintln!("GARGALO INTERNO: aceite em {t_acc:?} > 16s (HANDSHAKE_TIMEOUT*2 do transport). O handshake_stream interno estourou pelo menos 1x mesmo com RELAY_* folgados — o timeout que manda no 4G é o interno de 8s/16s, não o de 25s/90s.");
    }
    eprintln!("RELAY_HANDSHAKE_TIMEOUT ({RELAY_HANDSHAKE_TIMEOUT:?}) nunca é o gargalo aqui (respondente tem 90s; handshake fecha em ~10-20s).");
    eprintln!("=== FIM ANGULO 1 em {:?} ===", t0.elapsed());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_simultaneous_redial_burst_3x() {
    std::env::set_var("DISTORRENT_NO_ANNOUNCE", "1");
    use distorrent_core::net::relay::MemRelay;
    eprintln!("=== ANGULO 2: redial simultâneo bilateral 3x ===");

    let hub = MemRelay::new();
    let (a, _da) = spawn_with_backend("BurstA", Arc::new(hub.clone()));
    let (b, _db) = spawn_with_backend("BurstB", Arc::new(hub.clone()));
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let t0 = Instant::now();
    let r1 = a.friend_request(&fp_b).unwrap();
    eprintln!(
        "t+{:?}: setup inicial A→B={r1:?} (single-dial, sem colisão)",
        t0.elapsed()
    );

    let got = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            match tokio::time::timeout(Duration::from_secs(60), ev_b.recv()).await {
                Ok(Ok(EngineEvent::FriendRequestIn { fp, .. })) if fp == fp_a => return true,
                Ok(Ok(_)) => continue,
                _ => return false,
            }
        }
    })
    .await
    .unwrap_or(false);
    eprintln!("t+{:?}: B viu pedido de A? {got}", t0.elapsed());
    let _ = b.friend_respond(&fp_a, true);
    let _ = a.friend_respond(&fp_b, true);

    wait_both_online(&a, &fp_b, &b, &fp_a, 60).await;
    eprintln!(
        "t+{:?}: sessão inicial eleita (via_relay A={} B={})",
        t0.elapsed(),
        a.is_peer_via_relay(&fp_b),
        b.is_peer_via_relay(&fp_a)
    );
    assert!(a.is_peer_via_relay(&fp_b));
    assert!(b.is_peer_via_relay(&fp_a));

    for round in 0u8..3 {
        let t_r = Instant::now();
        tokio::join!(async { a.disconnect_peer(&fp_b) }, async {
            b.disconnect_peer(&fp_a)
        });
        eprintln!(
            "round {round}: t+{:?} disconnect bilateral enviado",
            t_r.elapsed()
        );

        wait_both_not_online(&a, &fp_b, &b, &fp_a, 15).await;
        let t_down = t_r.elapsed();
        eprintln!("round {round}: sessão caiu em {t_down:?} (ambos != Connected) — redial bilateral em curso");

        wait_both_online(&a, &fp_b, &b, &fp_a, 60).await;
        let t_re = t_r.elapsed();
        eprintln!(
            "round {round}: reconectou em {t_re:?} (queda+reeleição; via_relay A={} B={})",
            a.is_peer_via_relay(&fp_b),
            b.is_peer_via_relay(&fp_a)
        );
        assert_eq!(
            a.peer_state(&fp_b),
            NetworkState::Connected,
            "round {round}: A deve estar Connected"
        );
        assert_eq!(
            b.peer_state(&fp_a),
            NetworkState::Connected,
            "round {round}: B deve estar Connected"
        );

        let body_ab = format!("burst-{round} A→B ping-{round}-x7");
        let body_ba = format!("burst-{round} B→A pong-{round}-y9");
        let dm_a = a.open_dm(&fp_b, "BurstB").unwrap();
        let dm_b = b.open_dm(&fp_a, "BurstA").unwrap();
        assert_eq!(
            dm_a.id, dm_b.id,
            "round {round}: DM deve ser determinística por fp"
        );

        let m_ab = a.send_dm(&dm_a.id, &body_ab).unwrap();
        let m_ba = b.send_dm(&dm_b.id, &body_ba).unwrap();

        let desc_b = format!("B recebe burst-{round} A→B");
        let desc_a = format!("A recebe burst-{round} B→A");
        let (rec_b, rec_a) = tokio::join!(
            wait_event(
                &mut ev_b,
                &desc_b,
                |e| matches!(e, EngineEvent::MessageNew(m) if m.body == body_ab),
                60
            ),
            wait_event(
                &mut ev_a,
                &desc_a,
                |e| matches!(e, EngineEvent::MessageNew(m) if m.body == body_ba),
                60
            )
        );
        let EngineEvent::MessageNew(got_b) = rec_b else {
            unreachable!()
        };
        let EngineEvent::MessageNew(got_a) = rec_a else {
            unreachable!()
        };
        assert_eq!(got_b.body, body_ab, "round {round}: DM A→B corrompida!");
        assert_eq!(got_a.body, body_ba, "round {round}: DM B→A corrompida!");
        assert_eq!(got_b.author_fp, fp_a);
        assert_eq!(got_a.author_fp, fp_b);

        let desc_ack_a = format!("ACK burst-{round} A→B");
        let desc_ack_b = format!("ACK burst-{round} B→A");
        let (ack_a, ack_b) = tokio::join!(
            wait_event(
                &mut ev_a,
                &desc_ack_a,
                |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m_ab.id && status == "delivered"),
                60
            ),
            wait_event(
                &mut ev_b,
                &desc_ack_b,
                |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m_ba.id && status == "delivered"),
                60
            )
        );
        let _ = (ack_a, ack_b);
        eprintln!(
            "round {round}: DMs íntegros + ACKs OK em {:?} (sem panic, sem corrupção)",
            t_r.elapsed()
        );
    }
    eprintln!(
        "=== FIM ANGULO 2 em {:?}: 3/3 bursts sem corrupção ===",
        t0.elapsed()
    );
}

#[tokio::test]
async fn multirelay_dead_leg_unit() {
    eprintln!("=== ANGULO 3a (unit): MultiRelay com perna morta ===");
    let good_hub: Arc<StdMutex<HashMap<String, Vec<String>>>> =
        Arc::new(StdMutex::new(HashMap::new()));
    let flaky_hub: Arc<StdMutex<HashMap<String, Vec<String>>>> =
        Arc::new(StdMutex::new(HashMap::new()));
    let flaky = Arc::new(FlakyLeg::new(flaky_hub.clone(), 1));
    let good: Arc<dyn RelayBackend> = Arc::new(DelayedLeg {
        hub: good_hub.clone(),
        post_delay: Duration::from_millis(1),
        label: "good",
    });
    let multi = MultiRelay::of(vec![flaky.clone(), good.clone()]);

    multi
        .post("topico-x", "hello-1")
        .await
        .expect("1º post deve passar");
    assert_eq!(flaky.posts_feitos(), 1);
    let t = Instant::now();
    multi
        .post("topico-x", "hello-2")
        .await
        .expect("2º post deve passar PELA OUTRA PERNA");
    multi
        .post("topico-x", "hello-3")
        .await
        .expect("3º post deve passar PELA OUTRA PERNA");
    eprintln!(
        "posts 2-3 via perna boa em {:?} (sem travar apesar da perna morta)",
        t.elapsed()
    );

    let msgs = multi
        .poll("topico-x")
        .await
        .expect("poll não pode falhar com 1 perna viva");
    eprintln!("poll retornou {} msgs: {msgs:?}", msgs.len());
    assert!(
        msgs.contains(&"hello-2".to_string()),
        "perna boa deve ter carregado hello-2"
    );
    assert!(
        msgs.contains(&"hello-3".to_string()),
        "perna boa deve ter carregado hello-3"
    );

    let dead1 = Arc::new(FlakyLeg::new(Arc::new(StdMutex::new(HashMap::new())), 0));
    let dead2 = Arc::new(FlakyLeg::new(Arc::new(StdMutex::new(HashMap::new())), 0));
    let multi_dead = MultiRelay::of(vec![dead1, dead2]);
    let r = multi_dead.post("t", "x").await;
    assert!(
        r.is_err(),
        "sem perna viva o post deve falhar (limite documentado)"
    );
    eprintln!("limite: MultiRelay com TODAS as pernas mortas retorna Err (ok, sem hang)");
    eprintln!("=== FIM ANGULO 3a ===");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multirelay_dead_leg_engine_e2e() {
    std::env::set_var("DISTORRENT_NO_ANNOUNCE", "1");
    eprintln!("=== ANGULO 3b (e2e): handshake+DM com perna morrendo no meio ===");
    let good_hub: Arc<StdMutex<HashMap<String, Vec<String>>>> =
        Arc::new(StdMutex::new(HashMap::new()));
    let flaky_hub: Arc<StdMutex<HashMap<String, Vec<String>>>> =
        Arc::new(StdMutex::new(HashMap::new()));
    let mk_multi = || -> Arc<dyn RelayBackend> {
        let flaky: Arc<dyn RelayBackend> = Arc::new(FlakyLeg::new(flaky_hub.clone(), 1));
        let good: Arc<dyn RelayBackend> = Arc::new(DelayedLeg {
            hub: good_hub.clone(),
            post_delay: Duration::from_millis(5),
            label: "good",
        });
        Arc::new(MultiRelay::of(vec![flaky, good]))
    };
    let (a, _da) = spawn_with_backend("LegA", mk_multi());
    let (b, _db) = spawn_with_backend("LegB", mk_multi());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let t0 = Instant::now();
    a.friend_request(&fp_b).unwrap();
    wait_event(
        &mut ev_b,
        "B recebe pedido apesar da perna morta",
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
        60,
    )
    .await;
    let t_req = t0.elapsed();
    eprintln!("t+{t_req:?}: pedido atravessou com 1 perna morta (MultiRelay failover OK)");

    b.friend_respond(&fp_a, true).unwrap();
    wait_event(
        &mut ev_a,
        "A vê aceite apesar da perna morta",
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
        60,
    )
    .await;
    wait_both_online(&a, &fp_b, &b, &fp_a, 30).await;
    eprintln!(
        "t+{:?}: ambos ONLINE via_relay (failover no handshake provado)",
        t0.elapsed()
    );

    let dm = a.open_dm(&fp_b, "LegB").unwrap();
    let m1 = a.send_dm(&dm.id, "sobrevivi à perna morta!").unwrap();
    let rec = wait_event(
        &mut ev_b,
        "B recebe DM só pela perna boa",
        |e| matches!(e, EngineEvent::MessageNew(_)),
        60,
    )
    .await;
    let EngineEvent::MessageNew(in_b) = rec else {
        unreachable!()
    };
    assert_eq!(in_b.body, "sobrevivi à perna morta!");
    wait_event(
        &mut ev_a,
        "ACK volta só pela perna boa",
        |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m1.id && status == "delivered"),
        60,
    )
    .await;
    eprintln!(
        "t+{:?}: DM+ACK íntegros só pela perna boa (sem travar) === FIM ANGULO 3b ===",
        t0.elapsed()
    );
}
