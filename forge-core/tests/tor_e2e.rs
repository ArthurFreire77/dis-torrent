//! E2E REAL pela REDE TOR — nada local: o tráfego sai pelo daemon Tor,
//! atravessa circuitos reais da rede onion e chega num SERVIÇO ONION.
//!
//! Setup:
//!   1. Engine B escuta localmente; o daemon Tor publica um serviço onion
//!      apontando para ele (assim B fica alcançável SEM IP público/NAT —
//!      é o NAT traversal do Tor).
//!   2. Engine A em privacidade "full" (Tor 7 nós) conecta a
//!      `<onion>.onion:80` via SOCKS5 do Tor — o hostname NUNCA resolve
//!      localmente, vai ao proxy e a rede resolve dentro dos circuitos.
//!   3. Handshake autenticado + DM ida-e-volta com ACK entregue.
//!
//! Requer: binário `tor` + internet (bootstrap de consenso). Rodar com:
//!   cargo test --test tor_e2e -- --ignored --nocapture

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine};
use forge_core::storage::Store;

fn spawn_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
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
        assert!(!remaining.is_zero(), "timeout esperando: {desc}");
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) if matches(&ev) => return ev,
            Ok(Ok(_)) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("canal de eventos ({desc}): {e}"),
            Err(_) => panic!("timeout esperando: {desc}"),
        }
    }
}

struct TorDaemon {
    child: std::process::Child,
    _dir: tempfile::TempDir,
}

impl Drop for TorDaemon {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn spawn_tor(target_port: u16, dir: &std::path::Path) -> TorDaemon {
    std::fs::create_dir_all(dir.join("hs")).unwrap();
    {
        // Tor recusa HiddenServiceDir com permissões permissivas
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir.join("hs"), std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let torrc = dir.join("torrc");
    std::fs::write(
        &torrc,
        format!(
            "SocksPort 127.0.0.1:9500\n\
             HiddenServiceDir {}/hs/\n\
             HiddenServicePort 80 127.0.0.1:{target_port}\n\
             DataDirectory {}/data\n\
             Log notice file {}/tor.log\n",
            dir.display(),
            dir.display(),
            dir.display()
        ),
    )
    .unwrap();
    let child = std::process::Command::new("tor")
        .arg("-f")
        .arg(&torrc)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("tor não encontrado — instale o pacote tor para rodar este teste");
    TorDaemon {
        child,
        _dir: tempfile::tempdir_in(dir.parent().unwrap())
            .unwrap_or_else(|_| tempfile::tempdir().unwrap()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requer binário tor + internet — rode com: cargo test --test tor_e2e -- --ignored"]
async fn e2e_dm_via_rede_tor_onion_service() {
    // ── 1) Bruna (destino) — engine B normal ──
    let (bruna, _db) = spawn_engine("Bruna");
    let fp_b = bruna.identity().fingerprint.clone();
    let b_port = bruna.listen_port();

    // ── 2) Tor publica o serviço onion de Bruna ──
    let tordir = tempfile::tempdir().unwrap();
    let mut tor = spawn_tor(b_port, tordir.path());
    let hostfile = tordir.path().join("hs/hostname");
    let mut onion = String::new();
    for _ in 0..60 {
        if let Ok(h) = std::fs::read_to_string(&hostfile) {
            let h = h.trim().to_string();
            if h.ends_with(".onion") {
                onion = h;
                break;
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    assert!(
        !onion.is_empty(),
        "tor não publicou o serviço onion a tempo"
    );
    println!("[tor-e2e] serviço onion publicado: {onion}:80 → 127.0.0.1:{b_port}");

    // ── 3) Arthur em privacidade "full" (Tor) conecta ao onion ──
    let (arthur, _da) = spawn_engine("Arthur");
    let fp_a = arthur.identity().fingerprint.clone();
    arthur.privacy_set_mode("full").unwrap();
    std::env::set_var("FORGE_TOR_ADDR", "127.0.0.1:9500");
    let mut ev_a = arthur.subscribe();
    let mut ev_b = bruna.subscribe();

    arthur
        .connect_host(&format!("{onion}:80"), Some(fp_b.clone()))
        .unwrap();
    println!("[tor-e2e] Arthur conectando via Tor SOCKS5 127.0.0.1:9500 …");

    wait_event(
        &mut ev_a,
        "Arthur online via rede Tor",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_b),
        120,
    )
    .await;
    wait_event(
        &mut ev_b,
        "Bruna vê Arthur pela rede Tor",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_a),
        30,
    )
    .await;
    println!("[tor-e2e] handshake autenticado completo ATRAVÉS da rede Tor ✓");

    // ── 4) DM real com ACK entregue ──
    let conv = arthur.open_dm(&fp_b, "Bruna").unwrap();
    let m = arthur
        .send_dm(&conv.id, "mensagem via rede Tor — sem IP exposto")
        .unwrap();
    let rec = wait_event(
        &mut ev_b,
        "Bruna recebe a DM via Tor",
        |e| matches!(e, EngineEvent::MessageNew(_)),
        30,
    )
    .await;
    let EngineEvent::MessageNew(in_b) = rec else {
        unreachable!()
    };
    assert_eq!(in_b.body, "mensagem via rede Tor — sem IP exposto");
    wait_event(&mut ev_a, "ACK entregue", |e| matches!(e, EngineEvent::MessageStatus { msg_id, status } if msg_id == &m.id && status == "delivered"), 30).await;
    println!("[tor-e2e] DM entregue com ACK criptográfico ✓ — teste Tor 100% real");

    let _ = tor.child.kill(); // Drop também cobre
}
