use std::sync::Arc;
use std::time::Duration;

use distorrent_core::net::engine::{peer_relay_policy, EngineEvent, NetworkEngine};
use distorrent_core::storage::Store;

fn spawn_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

fn connect(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>) {
    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(b.identity().fingerprint.clone()));
}

async fn wait_online(a: &Arc<NetworkEngine>, fp: &str, secs: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    loop {
        if a.online_peer_fps().iter().any(|f| f == fp) {
            return;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "peer {fp} não ficou online a tempo"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn is_ui_social(ev: &EngineEvent) -> bool {
    matches!(
        ev,
        EngineEvent::FriendRequestIn { .. }
            | EngineEvent::FriendAccepted { .. }
            | EngineEvent::FriendRemoved { .. }
            | EngineEvent::MessageNew(_)
            | EngineEvent::MessageStatus { .. }
            | EngineEvent::CommunityJoined { .. }
            | EngineEvent::CommunityRemoved { .. }
            | EngineEvent::GroupSynced { .. }
            | EngineEvent::CallIncoming { .. }
            | EngineEvent::CallAcceptedEv { .. }
            | EngineEvent::CallRejected { .. }
            | EngineEvent::CallEnded { .. }
            | EngineEvent::CallOfferEv { .. }
            | EngineEvent::CallAnswerEv { .. }
            | EngineEvent::CallIceEv { .. }
            | EngineEvent::CallParticipantAdded { .. }
            | EngineEvent::VoiceJoined { .. }
            | EngineEvent::VoiceLeft { .. }
            | EngineEvent::VoiceStateChanged { .. }
            | EngineEvent::FileAnnounceEv { .. }
            | EngineEvent::FileChunkRequestEv { .. }
            | EngineEvent::FileChunkDataEv { .. }
            | EngineEvent::ScreenShareOfferEv { .. }
    )
}

#[test]
fn tabela_politica_por_modo() {
    assert_eq!(
        peer_relay_policy("normal"),
        (true, true),
        "normal permite usar/servir"
    );
    assert_eq!(
        peer_relay_policy("encrypted"),
        (true, true),
        "encrypted permite usar/servir"
    );
    assert_eq!(
        peer_relay_policy("proxy"),
        (false, false),
        "proxy nega usar/servir"
    );
    assert_eq!(
        peer_relay_policy("full"),
        (false, false),
        "full nega usar/servir"
    );
    assert_eq!(
        peer_relay_policy("desconhecido"),
        (false, false),
        "modo desconhecido = fail-closed"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn modos_liberam_e_negam_peer_relay() {
    let (a, _da) = spawn_engine("PrivModosA");
    let (b, _db) = spawn_engine("PrivModosB");
    let fp_b = b.identity().fingerprint.clone();
    connect(&a, &b);
    wait_online(&a, &fp_b, 15).await;

    a.set_peer_relay_enabled(true);
    assert_eq!(a.privacy_mode(), "encrypted", "default deve ser encrypted");
    assert!(a.peer_relay_enabled(), "encrypted: usar permitido");
    assert!(
        a.peer_relay_serving_enabled(),
        "encrypted: servir permitido"
    );
    a.privacy_set_mode("encrypted").unwrap();
    assert_eq!(
        a.peer_relay_fp().as_deref(),
        Some(fp_b.as_str()),
        "encrypted seleciona o peer direto como intermediário"
    );

    a.privacy_set_mode("normal").unwrap();
    assert!(a.peer_relay_enabled(), "normal: usar permitido");
    assert!(a.peer_relay_serving_enabled(), "normal: servir permitido");

    a.privacy_set_mode("proxy").unwrap();
    assert!(!a.peer_relay_enabled(), "proxy: usar proibido");
    assert!(!a.peer_relay_serving_enabled(), "proxy: servir proibido");
    assert_eq!(a.peer_relay_fp(), None, "proxy derruba o intermediário");

    a.privacy_set_mode("encrypted").unwrap();
    assert!(a.peer_relay_enabled(), "volta a encrypted: usar permitido");
    assert!(
        a.peer_relay_serving_enabled(),
        "volta a encrypted: servir permitido"
    );
    assert_eq!(
        a.peer_relay_fp().as_deref(),
        Some(fp_b.as_str()),
        "volta a encrypted reseleciona o intermediário"
    );

    a.privacy_set_mode("full").unwrap();
    assert!(!a.peer_relay_enabled(), "full: usar proibido");
    assert!(!a.peer_relay_serving_enabled(), "full: servir proibido");
    assert_eq!(a.peer_relay_fp(), None, "full derruba o intermediário");

    a.shutdown();
    b.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_switch_desliga_e_religa_peer_relay() {
    let (a, _da) = spawn_engine("PrivKillA");
    let (b, _db) = spawn_engine("PrivKillB");
    let fp_b = b.identity().fingerprint.clone();
    connect(&a, &b);
    wait_online(&a, &fp_b, 15).await;

    a.set_peer_relay_enabled(true);
    a.privacy_set_mode("encrypted").unwrap();
    assert!(
        a.peer_relay_enabled(),
        "encrypted sem kill-switch: usar permitido"
    );
    assert!(
        a.peer_relay_serving_enabled(),
        "encrypted sem kill-switch: servir permitido"
    );
    assert_eq!(a.peer_relay_fp().as_deref(), Some(fp_b.as_str()));

    a.set_relay_disabled(true);
    assert!(!a.peer_relay_enabled(), "kill-switch: usar proibido");
    assert!(
        !a.peer_relay_serving_enabled(),
        "kill-switch: servir proibido"
    );
    assert_eq!(a.peer_relay_fp(), None, "kill-switch dropa o intermediário");

    a.set_relay_disabled(false);
    assert!(a.peer_relay_enabled(), "kill-switch off: usar reabilitado");
    assert!(
        a.peer_relay_serving_enabled(),
        "kill-switch off: servir reabilitado"
    );
    assert_eq!(
        a.peer_relay_fp().as_deref(),
        Some(fp_b.as_str()),
        "kill-switch off reseleciona o intermediário"
    );

    a.shutdown();
    b.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
// Seção 1: ativar_peer_relay_nao_cria_amizade_nem_evento
async fn ativar_peer_relay_nao_cria_amizade_nem_evento() {
    let (a, _da) = spawn_engine("PrivQuietA");
    let (b, _db) = spawn_engine("PrivQuietB");
    let (c, _dc) = spawn_engine("PrivQuietC");
    let fp_b = b.identity().fingerprint.clone();
    let fp_c = c.identity().fingerprint.clone();
    connect(&a, &b);
    connect(&a, &c);
    wait_online(&a, &fp_b, 15).await;
    wait_online(&a, &fp_c, 15).await;

    assert!(a.friends(None).is_empty(), "nenhuma amizade inicial");
    assert!(
        a.friends(Some("accepted")).is_empty(),
        "nenhum amigo aceito inicial"
    );

    let mut rx = a.subscribe();
    tokio::time::sleep(Duration::from_millis(100)).await;
    while rx.try_recv().is_ok() {}

    a.set_peer_relay_enabled(true);
    a.privacy_set_mode("encrypted").unwrap();
    let esperado = std::cmp::min(fp_b.clone(), fp_c.clone());
    assert_eq!(
        a.peer_relay_fp().as_deref(),
        Some(esperado.as_str()),
        "seleciona o peer direto de MENOR fp (determinístico)"
    );

    tokio::time::sleep(Duration::from_millis(300)).await;

    while let Ok(ev) = rx.try_recv() {
        assert!(
            !is_ui_social(&ev),
            "peer-relay não deve emitir evento de UI/social: {ev:?}"
        );
    }
    assert!(a.friends(None).is_empty(), "peer-relay não cria amizade");
    assert!(a.friends(Some("accepted")).is_empty());
    assert!(a.friends(Some("pending_out")).is_empty());
    assert!(a.friends(Some("pending_in")).is_empty());

    a.shutdown();
    b.shutdown();
    c.shutdown();
}
