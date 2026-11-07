use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use distorrent_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
use distorrent_core::net::relay::{MemRelay, MultiRelay, RelayBackend};
use distorrent_core::storage::Store;
use distorrent_core::Result;

#[derive(Clone)]
struct LossyRelay {
    inner: MemRelay,
}

impl LossyRelay {
    fn new(inner: MemRelay) -> Self {
        Self { inner }
    }
}

impl RelayBackend for LossyRelay {
    fn post<'a>(
        &'a self,
        topic: &'a str,
        body: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>> {
        Box::pin(async move {
            if rand::random::<f32>() < 0.20 {
                return Ok(());
            }
            let delay_ms: u64 = {
                use rand::Rng;
                rand::thread_rng().gen_range(0..3000)
            };
            if delay_ms == 0 {
                self.inner.post(topic, body).await
            } else {
                let inner = self.inner.clone();
                let topic = topic.to_string();
                let body = body.to_string();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    let _ = inner.post(&topic, &body).await;
                });
                Ok(())
            }
        })
    }

    fn poll<'a>(
        &'a self,
        topic: &'a str,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<String>>> + Send + 'a>> {
        Box::pin(async move {
            let mut msgs = self.inner.poll(topic).await?;
            use rand::seq::SliceRandom;
            msgs.shuffle(&mut rand::thread_rng());
            Ok(msgs)
        })
    }
}

fn spawn_user(nick: &str, hub: MemRelay) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.set_relay_backend(Arc::new(MultiRelay::of(vec![
        Arc::new(LossyRelay::new(hub.clone())),
        Arc::new(LossyRelay::new(hub.clone())),
        Arc::new(LossyRelay::new(hub.clone())),
        Arc::new(LossyRelay::new(hub.clone())),
        Arc::new(LossyRelay::new(hub.clone())),
        Arc::new(LossyRelay::new(hub.clone())),
    ])));
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

async fn wait_event_opt<F: Fn(&EngineEvent) -> bool>(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    matches: F,
    secs: u64,
) -> Option<EngineEvent> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return None;
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) if matches(&ev) => return Some(ev),
            Ok(Ok(_)) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return None,
            Err(_) => return None,
        }
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
            "peers não ficaram online (lossy) em {secs}s"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_lossy_friend_and_dm_with_ack() {
    std::env::set_var("DISTORRENT_NO_ANNOUNCE", "1");
    let t0 = Instant::now();
    eprintln!("=== LOSSY: 20% drop + 0-3s delay + reorder (6 pernas) ===");
    let hub = MemRelay::new();
    let (a, _da) = spawn_user("LossyA", hub.clone());
    let (b, _db) = spawn_user("LossyB", hub.clone());
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    assert_ne!(fp_a, fp_b);

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    a.friend_request(&fp_b).unwrap();
    let mut req_fp: Option<String> = None;
    for round in 0..5 {
        if let Some(ev) = wait_event_opt(
            &mut ev_b,
            |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fp_a),
            45,
        )
        .await
        {
            let EngineEvent::FriendRequestIn { fp, nickname } = ev else {
                unreachable!()
            };
            assert_eq!(nickname, "LossyA");
            eprintln!("t+{:?}: B recebeu pedido (round {round})", t0.elapsed());
            req_fp = Some(fp);
            break;
        }
        eprintln!(
            "t+{:?}: round {round} sem pedido — re-solicita (frame perdido na rede lossy)",
            t0.elapsed()
        );
        let _ = a.friend_request(&fp_b);
    }
    let req_fp = req_fp.expect("B deveria receber o pedido apesar de 20% loss (5 rounds)");

    b.friend_respond(&req_fp, true).unwrap();
    let mut accepted = false;
    for round in 0..5 {
        if wait_event_opt(
            &mut ev_a,
            |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fp_b),
            45,
        )
        .await
        .is_some()
        {
            eprintln!("t+{:?}: A viu aceite (round {round})", t0.elapsed());
            accepted = true;
            break;
        }
        eprintln!(
            "t+{:?}: aceite perdido (round {round}) — B reenvia",
            t0.elapsed()
        );
        let _ = b.friend_respond(&fp_a, true);
    }
    assert!(accepted, "A deveria ver o aceite apesar de 20% loss");

    wait_both_online(&a, &fp_b, &b, &fp_a, 120).await;
    eprintln!(
        "t+{:?}: ambos ONLINE via_relay={} / {}",
        t0.elapsed(),
        a.is_peer_via_relay(&fp_b),
        b.is_peer_via_relay(&fp_a)
    );
    assert!(a.is_peer_via_relay(&fp_b), "sessão A→B deve ser relay");
    assert!(b.is_peer_via_relay(&fp_a), "sessão B→A deve ser relay");

    let dm = a.open_dm(&fp_b, "LossyB").unwrap();
    let mut delivered: Option<String> = None;
    for attempt in 0..5 {
        wait_both_online(&a, &fp_b, &b, &fp_a, 90).await;
        let body = format!("oi lossy 20%! tentativa {attempt}");
        let m = a.send_dm(&dm.id, &body).unwrap();
        let body_c = body.clone();
        let msg_id = m.id.clone();
        let got = wait_event_opt(
            &mut ev_b,
            |e| matches!(e, EngineEvent::MessageNew(mm) if mm.body == body_c),
            45,
        )
        .await;
        if got.is_none() {
            eprintln!(
                "t+{:?}: DM tentativa {attempt} perdida (A→B) — retenta",
                t0.elapsed()
            );
            continue;
        }
        let ack = wait_event_opt(
            &mut ev_a,
            |e| matches!(e, EngineEvent::MessageStatus { msg_id: id, status } if id == &msg_id && status == "delivered"),
            45,
        )
        .await;
        if ack.is_some() {
            eprintln!(
                "t+{:?}: DM tentativa {attempt} ENTREGUE + ACK delivered",
                t0.elapsed()
            );
            assert_eq!(body, format!("oi lossy 20%! tentativa {attempt}"));
            delivered = Some(body);
            break;
        }
        eprintln!(
            "t+{:?}: DM tentativa {attempt} chegou mas ACK perdeu — retenta",
            t0.elapsed()
        );
    }
    assert!(
        delivered.is_some(),
        "alguma DM deveria entregar+ACK apesar de 20% loss (5 tentativas)"
    );
    eprintln!(
        "=== FIM LOSSY em {:?}: amizade+DM+ACK OK sob 20% loss ===",
        t0.elapsed()
    );
}
