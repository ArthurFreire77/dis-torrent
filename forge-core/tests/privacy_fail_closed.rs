//! PRIVACIDADE FAIL-CLOSED — testes de integração do comportamento real dos
//! modos `proxy`/`full` (Tor), que a UI vende como "esconde seu IP".
//!
//! O que cada caso PROVA (sem nada disto o modo estaria mentindo):
//! 1. Proxy MORTO ⇒ NENHUMA conexão direta de fallback (o bug original:
//!    `connect_and_maintain` caía silenciosamente em TCP direto quando o
//!    SOCKS5 falhava — vazando o IP real no pior momento possível).
//! 2. Trocar para proxy ⇒ sessões DIRETAS vivas são derrubadas na hora
//!    (nada continua fora da política nova esperando reconexão).
//! 3. Inbound DIRETO recusado em modo anônimo (port-scanner não ganha o
//!    Hello em claro com fp+nickname no IP real).
//! 4. Discovery UDP CALADO em modo anônimo — o broadcaster não anuncia
//!    presença na LAN (gate na fonte, não no handler).
//!
//! Roda em qualquer SO (engines em localhost, sem Tor real: o fail-closed
//! é justamente o que acontece QUANDO o proxy não está lá). Env serializado
//! por Mutex (mesma lição do auto_proxy_fallback.rs: env é do processo).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use forge_core::net::engine::{EngineEvent, NetworkEngine};
use forge_core::storage::Store;
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// Serializa o acesso ao env do processo entre os testes deste binário.
static ENV_LOCK: Mutex<()> = Mutex::new(()());

fn spawn_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    // Relay OFF nos dois lados: o teste é sobre o caminho DIRETO — sem isto
    // o backend MQTT público tentaria brokers reais e poluiria o assert.
    engine.set_relay_disabled(true);
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

/// Espera `secs` SEM que o evento ocorra (o negativo é o teste).
async fn assert_no_event<F: Fn(&EngineEvent) -> bool>(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    desc: &str,
    matches: F,
    secs: u64,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return; // janela passou sem o evento — é o esperado
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) => assert!(
                !matches(&ev),
                "evento que NÃO devia acontecer aconteceu ({desc}): {ev:?}"
            ),
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(_)) => return,
            Err(_) => return,
        }
    }
}

/// 1) Proxy morto ⇒ NUNCA cai para conexão direta (fail-closed, o IP não vaza).
/// B escuta numa porta REAL; A em modo proxy com FORGE_PROXY_ADDR morto disca
/// B. Se existisse fallback, B veria handshake. O certo: B continua sozinho.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_morto_nunca_conecta_direto() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("FORGE_PROXY_ADDR", "127.0.0.1:1"); // porta 1: nada escuta
    std::env::remove_var("FORGE_AUTO_PROXY");

    let (a, _da) = spawn_engine("Ana");
    let (b, _db) = spawn_engine("Bia");
    let fp_b = b.identity().fingerprint.clone();

    // spy: conta quantas conexões B aceitou (fallback direto apareceria aqui)
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let spy_addr: SocketAddr = listener.local_addr().unwrap();
    let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let acc = accepted.clone();
    tokio::spawn(async move {
        loop {
            if listener.accept().await.is_ok() {
                acc.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
    });

    let mut ev_a = a.subscribe();
    a.privacy_set_mode("proxy").unwrap();
    // dial direto para o endpoint REAL de B — em modo proxy tem que sair
    // PELO SOCKS (morto) e falhar; JAMAIS abrir TCP ao endpoint real.
    a.add_manual_peer(spy_addr, Some(fp_b));

    assert_no_event(
        &mut ev_a,
        "peer online via fallback direto",
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        8,
    )
    .await;
    assert_eq!(
        accepted.load(std::sync::atomic::Ordering::Relaxed),
        0,
        "fallback direto abriu TCP ao endpoint real — vazamento de IP"
    );
    std::env::remove_var("FORGE_PROXY_ADDR");
}

/// 2) Trocar para proxy DERRUBA a sessão direta viva (política vale na hora;
/// conexões antigas não continuam fora dela esperando reconexão).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn trocar_para_proxy_derruba_sessao_direta() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("FORGE_PROXY_ADDR", "127.0.0.1:1");
    std::env::remove_var("FORGE_AUTO_PROXY");

    let (a, _da) = spawn_engine("Ana");
    let (b, _db) = spawn_engine("Bia");
    let fp_b = b.identity().fingerprint.clone();
    let addr_b: SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();

    let mut ev_a = a.subscribe();
    a.add_manual_peer(addr_b, Some(fp_b.clone()));
    wait_event(
        &mut ev_a,
        "sessão direta A→B antes da troca de modo",
        |e| matches!(e, EngineEvent::PeerOnline { fp, via_relay: false, .. } if fp == &fp_b),
        15,
    )
    .await;

    // TROCA de modo em runtime: a sessão DIRETA viva tem que cair AGORA.
    a.privacy_set_mode("proxy").unwrap();
    wait_event(
        &mut ev_a,
        "sessão direta encerrada pela política anônima",
        |e| matches!(e, EngineEvent::PeerOffline { fp } if fp == &fp_b),
        10,
    )
    .await;
    assert_eq!(a.privacy_mode(), "proxy");
    std::env::remove_var("FORGE_PROXY_ADDR");
}

/// 3) Inbound DIRETO recusado em modo anônimo: B (modo comum) disca A (proxy)
/// — o accept de A tem que recusar antes do handshake (o Hello em claro
/// entrega fp+nickname a quem escanear a porta).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn inbound_direto_recusado_em_modo_proxy() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    std::env::set_var("FORGE_PROXY_ADDR", "127.0.0.1:1");
    std::env::remove_var("FORGE_AUTO_PROXY");

    let (a, _da) = spawn_engine("Ana"); // alvo em modo anônimo
    let (b, _db) = spawn_engine("Bia"); // atacante/escanner em modo comum
    let fp_a = a.identity().fingerprint.clone();
    a.privacy_set_mode("proxy").unwrap();

    let mut ev_b = b.subscribe();
    let addr_a: SocketAddr = format!("127.0.0.1:{}", a.listen_port()).parse().unwrap();
    b.add_manual_peer(addr_a, Some(fp_a.clone()));

    assert_no_event(
        &mut ev_b,
        "handshake inbound aceito no IP real do par anônimo",
        |e| matches!(e, EngineEvent::PeerOnline { fp, .. } if fp == &fp_a),
        8,
    )
    .await;
    std::env::remove_var("FORGE_PROXY_ADDR");
}

/// 4) Discovery UDP CALADO em modo anônimo (gate na FONTE): broadcaster não
/// envia NADA — nem no alvo custom (FORGE_DISCOVERY_BROADCASTS), que sem o
/// gate receberia o anúncio em segundos. Contraste: gate aberto ⇒ chega.
/// Não usa NetworkEngine (Discovery::spawn aceita gate + limiter direto).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn discovery_udp_silencioso_em_modo_anonimo() {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // spy numa porta livre: recebe os broadcasts via target custom
    let spy = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let spy_port = spy.local_addr().unwrap().port();
    std::env::set_var(
        "FORGE_DISCOVERY_BROADCASTS",
        format!("127.0.0.1:{spy_port}"),
    );

    let kp = Arc::new(forge_core::identity::Keypair::generate());
    let limiter = forge_core::net::netlimit::NetLimiter::from_env();
    let (_tx, rx) = mpsc::unbounded_channel();

    // 4a) gate FECHADO (modo anônimo): 8s de silêncio absoluto no spy.
    let allowed_off: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| false);
    let _d = forge_core::net::discovery::Discovery::spawn(
        kp.clone(),
        "Silencioso".into(),
        45900,
        rx.clone(),
        allowed_off,
        limiter.clone(),
    )
    .await
    .unwrap();
    let mut buf = [0u8; 4096];
    match tokio::time::timeout(Duration::from_secs(8), spy.recv_from(&mut buf)).await {
        Ok(_) => panic!("broadcaster vazou anúncio com o gate fechado (modo anônimo)"),
        Err(_) => {} // silêncio: é o esperado
    }

    // 4b) mesmo setup, gate ABERTO (modo comum): o anúncio chega < 5s.
    let allowed_on: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(|| true);
    let (_tx2, rx2) = mpsc::unbounded_channel();
    let _d2 = forge_core::net::discovery::Discovery::spawn(
        kp.clone(),
        "Falante".into(),
        45900,
        rx2,
        allowed_on,
        limiter,
    )
    .await
    .unwrap();
    match tokio::time::timeout(Duration::from_secs(5), spy.recv_from(&mut buf)).await {
        Ok(Ok((n, _))) => {
            let ann: forge_core::net::discovery::Announcement =
                serde_json::from_slice(&buf[..n]).unwrap();
            assert_eq!(ann.fp, kp.fingerprint(), "anúncio com fp de outra identidade");
        }
        _ => panic!("gate aberto deveria anunciar (contraste do 4a)"),
    }
    std::env::remove_var("FORGE_DISCOVERY_BROADCASTS");
}
