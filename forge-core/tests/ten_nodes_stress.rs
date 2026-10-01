//! STRESS REAL — 10 NÓS NetworkEngine com TempDir distintos, discovery desligado,
//! malha completa via add_manual_peer, friend_request/accept em cadeia,
//! DM com ACK delivered, latência e taxa de entrega.
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use forge_core::net::engine::{EngineEvent, NetworkEngine, NetworkState};
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

async fn wait_until<F: FnMut() -> bool>(desc: &str, mut cond: F, secs: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if cond() {
            return;
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timeout: {desc}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn ten_nodes_mesh_stress() {
    const N: usize = 10;
    let mut engines: Vec<Arc<NetworkEngine>> = Vec::new();
    let mut dirs: Vec<tempfile::TempDir> = Vec::new();
    let mut fps: Vec<String> = Vec::new();
    let mut ports: Vec<u16> = Vec::new();

    // ---------- spawn 10 nós reais ----------
    for i in 0..N {
        let nick = format!("node{i}");
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
        let kp = forge_core::identity::Keypair::generate();
        let eng = NetworkEngine::new(store, kp, nick, dir.path().to_path_buf());
        eng.start_with_discovery(false).unwrap();
        // espera listener subir
        let mut p = 0u16;
        for _ in 0..50 {
            p = eng.listen_port();
            if p != 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(p != 0, "nó {i} sem porta de escuta");
        fps.push(eng.identity().fingerprint.clone());
        ports.push(p);
        engines.push(eng);
        dirs.push(dir);
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    // fps únicos?
    {
        let mut s = fps.clone();
        s.sort();
        s.dedup();
        assert_eq!(s.len(), N, "fingerprints devem ser únicos");
    }
    println!("[10nos] spawn ok. fps={fps:?}");
    println!("[10nos] ports={ports:?}");

    // subscribe ANTES de discar
    let mut rxs: Vec<tokio::sync::broadcast::Receiver<EngineEvent>> =
        engines.iter().map(|e| e.subscribe()).collect();

    // ---------- malha completa: i disca j (i<j) ----------
    let addrs: Vec<SocketAddr> = ports
        .iter()
        .map(|p| format!("127.0.0.1:{p}").parse().unwrap())
        .collect();
    let mut dials = 0u32;
    for i in 0..N {
        for j in (i + 1)..N {
            engines[i].add_manual_peer(addrs[j], Some(fps[j].clone()));
            dials += 1;
        }
    }
    println!("[10nos] dials iniciados: {dials} (malha i->j)");

    // ---------- espera handshake total (cada nó vê 9 online) ----------
    wait_until(
        "malha completa 10x9",
        || engines.iter().all(|e| e.online_peer_fps().len() == N - 1),
        40,
    )
    .await;
    // checagem extra de estado
    for i in 0..N {
        for j in 0..N {
            if i == j {
                continue;
            }
            assert_eq!(
                engines[i].peer_state(&fps[j]),
                NetworkState::Connected,
                "nó {i} deve ver {j} Connected"
            );
        }
    }
    let directed: usize = engines.iter().map(|e| e.online_peer_fps().len()).sum();
    println!("[10nos] HANDSHAKE OK: directed_links={directed} (esperado 90), por_no=9");

    // ---------- friend_request/accept em cadeia 0->1->...->9 ----------
    let t_friends = Instant::now();
    let mut friends_ok = 0u32;
    for i in 0..(N - 1) {
        let a = i;
        let b = i + 1;
        engines[a].friend_request(&fps[b]).unwrap();
        wait_event(
            &mut rxs[b],
            &format!("pedido {a}->{b}"),
            |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fps[a]),
            15,
        )
        .await;
        engines[b].friend_respond(&fps[a], true).unwrap();
        wait_event(
            &mut rxs[a],
            &format!("aceite {b}->{a}"),
            |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fps[b]),
            15,
        )
        .await;
        friends_ok += 1;
    }
    println!(
        "[10nos] FRIENDS cadeia OK: {friends_ok}/9 em {:?} (todos accepted?)",
        t_friends.elapsed()
    );
    for i in 0..(N - 1) {
        assert!(
            engines[i]
                .friends(Some("accepted"))
                .iter()
                .any(|p| p.fp == fps[i + 1]),
            "nó {i} deve ter {} accepted",
            fps[i + 1]
        );
        assert!(
            engines[i + 1]
                .friends(Some("accepted"))
                .iter()
                .any(|p| p.fp == fps[i]),
            "nó {} deve ter {} accepted",
            i + 1,
            fps[i]
        );
    }

    // ---------- DM em cadeia com ACK delivered + latência ----------
    let mut latencias: Vec<u128> = Vec::new();
    let mut entregues = 0u32;
    let mut falhas = 0u32;
    for i in 0..(N - 1) {
        let a = i;
        let b = i + 1;
        let body = format!("dm-{a}-para-{b} ola {}", i * 1000 + 7);
        let dm = engines[a].open_dm(&fps[b], &format!("node{b}")).unwrap();
        let t0 = Instant::now();
        let m = engines[a].send_dm(&dm.id, &body).unwrap();
        assert_eq!(m.status, "sent", "DM {a}->{b} deve ir sent (online)");
        // receptor recebe
        let rec = wait_event(
            &mut rxs[b],
            &format!("DM {a}->{b}"),
            |e| matches!(e, EngineEvent::MessageNew(mm) if mm.body == body),
            15,
        )
        .await;
        if let EngineEvent::MessageNew(mm) = rec {
            assert_eq!(mm.author_fp, fps[a]);
            assert_eq!(mm.conv_id, dm.id, "DM id determinístico");
        }
        // sender vê delivered
        match tokio::time::timeout(Duration::from_secs(15), async {
            wait_event(&mut rxs[a], &format!("ACK {a}->{b}"), |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m.id && status == "delivered"), 15).await
        }).await {
            Ok(_) => {
                let dt = t0.elapsed().as_millis();
                latencias.push(dt);
                entregues += 1;
                println!("[10nos] DM {a}->{b} delivered em {dt}ms id={} body={body}", &m.id[..8]);
            }
            Err(_) => {
                falhas += 1;
                println!("[10nos] FALHA DM {a}->{b} sem ACK id={}", m.id);
            }
        }
    }
    let avg = if !latencias.is_empty() {
        latencias.iter().sum::<u128>() as f64 / latencias.len() as f64
    } else {
        0.0
    };
    let min = latencias.iter().min().copied().unwrap_or(0);
    let max = latencias.iter().max().copied().unwrap_or(0);
    println!("[10nos] DM cadeia: entregues={entregues}/9 falhas={falhas} lat_avg={avg:.1}ms min={min}ms max={max}ms latencias={latencias:?}");

    // ---------- fingerprint estável ----------
    let mut fp_estavel = true;
    for i in 0..N {
        if engines[i].identity().fingerprint != fps[i] {
            fp_estavel = false;
        }
    }
    println!("[10nos] fingerprint estável: {fp_estavel}");

    // ---------- resumo final ----------
    let total_directed: usize = engines.iter().map(|e| e.online_peer_fps().len()).sum();
    println!("[10nos] RESUMO nós=10 conectados_por_no=9 directed={total_directed}/90 dials={dials} friends_cadeia={friends_ok}/9 dms_entregues={entregues}/9 falhas={falhas} lat_media_ms={avg:.1} fp_estavel={fp_estavel}");

    assert_eq!(total_directed, 90, "malha deve ter 90 links direcionados");
    assert_eq!(friends_ok, 9);
    assert_eq!(
        entregues, 9,
        "todas as 9 DMs da cadeia devem entregar com ACK"
    );
    assert_eq!(falhas, 0);
    assert!(fp_estavel);

    // mantém TempDirs vivos até aqui
    drop(dirs);
}
