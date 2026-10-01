//! Trava a política dos 4 modos de privacidade (`normal`, `encrypted`,
//! `proxy`, `full`) em relação ao peer-relay (intermediário por peer).
//!
//! Usa engines REAIS em localhost, no padrão dos testes existentes:
//! `NetworkEngine::new` + `start_with_discovery(false)` + `add_manual_peer`.
//! NÃO injeta backend de relay (`set_relay_backend`) justamente para exercitar
//! o caminho de produção de `peer_relay_enabled()`/`peer_relay_serving_enabled()`
//! (backend injetado desliga o peer-relay por política).
//!
//! (F7) O peer-relay é OPT-IN: em produção liga via `FORGE_RELAY=1` ou
//! `FORGE_PEER_RELAY=1`. Aqui usamos `set_peer_relay_enabled(true)` para
//! simular o opt-in e exercitar a política de modo/kill-switch/seleção.
//!
//! Política verificada:
//! - normal / encrypted (+ opt-in) → permitido USAR e SERVIR (peer direto).
//! - proxy / full       → PROIBIDO usar e servir (não vaza IP).
//! - kill-switch        → desliga mesmo em encrypted; religar reabilita.
//! - ativar peer-relay  → NÃO cria amizade e NÃO emite evento de UI/social.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::{peer_relay_policy, EngineEvent, NetworkEngine};
use forge_core::storage::Store;

/// Sobe um engine real em localhost (sem discovery), como `friends.rs`.
fn spawn_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

/// Disca A→B em 127.0.0.1 (padrão `friends.rs`).
fn connect(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>) {
    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(b.identity().fingerprint.clone()));
}

/// Espera o peer `fp` ficar ONLINE no engine `a` (até `secs`).
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

/// Evento de UI/social que o peer-relay NUNCA deve provocar ao ser ativado.
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

/// Tabela pura: modo → (usar, servir). Fail-closed para modo desconhecido.
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

/// Modos liberam/negam o peer-relay e a troca de modo reavalia a seleção.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn modos_liberam_e_negam_peer_relay() {
    let (a, _da) = spawn_engine("PrivModosA");
    let (b, _db) = spawn_engine("PrivModosB");
    let fp_b = b.identity().fingerprint.clone();
    connect(&a, &b);
    wait_online(&a, &fp_b, 15).await;

    // (F7) peer-relay é opt-in: liga explicitamente (em produção via
    // FORGE_RELAY/FORGE_PEER_RELAY) para exercitar modo/seleção.
    a.set_peer_relay_enabled(true);
    // encrypted (default): usa e serve; seleciona o peer direto.
    assert_eq!(a.privacy_mode(), "encrypted", "default deve ser encrypted");
    assert!(a.peer_relay_enabled(), "encrypted: usar permitido");
    assert!(
        a.peer_relay_serving_enabled(),
        "encrypted: servir permitido"
    );
    // Redefinir o modo (mesmo o atual) já dispara a reavaliação da seleção.
    a.privacy_set_mode("encrypted").unwrap();
    assert_eq!(
        a.peer_relay_fp().as_deref(),
        Some(fp_b.as_str()),
        "encrypted seleciona o peer direto como intermediário"
    );

    // normal: também permite usar e servir.
    a.privacy_set_mode("normal").unwrap();
    assert!(a.peer_relay_enabled(), "normal: usar permitido");
    assert!(a.peer_relay_serving_enabled(), "normal: servir permitido");

    // proxy: nega ambos e derruba a seleção na hora.
    a.privacy_set_mode("proxy").unwrap();
    assert!(!a.peer_relay_enabled(), "proxy: usar proibido");
    assert!(!a.peer_relay_serving_enabled(), "proxy: servir proibido");
    assert_eq!(a.peer_relay_fp(), None, "proxy derruba o intermediário");

    // volta encrypted: reabilita e reseleciona o peer direto.
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

    // full: nega ambos e derruba a seleção.
    a.privacy_set_mode("full").unwrap();
    assert!(!a.peer_relay_enabled(), "full: usar proibido");
    assert!(!a.peer_relay_serving_enabled(), "full: servir proibido");
    assert_eq!(a.peer_relay_fp(), None, "full derruba o intermediário");

    a.shutdown();
    b.shutdown();
}

/// Kill-switch explícito desliga o peer-relay mesmo em encrypted; religar volta.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_switch_desliga_e_religa_peer_relay() {
    let (a, _da) = spawn_engine("PrivKillA");
    let (b, _db) = spawn_engine("PrivKillB");
    let fp_b = b.identity().fingerprint.clone();
    connect(&a, &b);
    wait_online(&a, &fp_b, 15).await;

    // (F7) peer-relay é opt-in.
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

    // Ligar o kill-switch derruba usar/servir e a seleção, mesmo em encrypted.
    a.set_relay_disabled(true);
    assert!(!a.peer_relay_enabled(), "kill-switch: usar proibido");
    assert!(
        !a.peer_relay_serving_enabled(),
        "kill-switch: servir proibido"
    );
    assert_eq!(a.peer_relay_fp(), None, "kill-switch dropa o intermediário");

    // Desligar o kill-switch reabilita e reseleciona.
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

/// Ativar o peer-relay não cria amizade nem emite evento de UI/social.
/// Usa TRÊS engines diretos p/ provar também a seleção determinística (menor fp).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
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

    // Nenhuma amizade antes de ativar o peer-relay.
    assert!(a.friends(None).is_empty(), "nenhuma amizade inicial");
    assert!(
        a.friends(Some("accepted")).is_empty(),
        "nenhum amigo aceito inicial"
    );

    // Só observa eventos a partir daqui; drena o backlog de conexão.
    let mut rx = a.subscribe();
    tokio::time::sleep(Duration::from_millis(100)).await;
    while rx.try_recv().is_ok() {}

    // (F7) peer-relay é opt-in; ativa a seleção (encrypted = permitido).
    a.set_peer_relay_enabled(true);
    a.privacy_set_mode("encrypted").unwrap();
    let esperado = std::cmp::min(fp_b.clone(), fp_c.clone());
    assert_eq!(
        a.peer_relay_fp().as_deref(),
        Some(esperado.as_str()),
        "seleciona o peer direto de MENOR fp (determinístico)"
    );

    // Janela curta p/ qualquer evento assíncrono indevido aparecer.
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Ativar o peer-relay NUNCA emite evento de UI/social.
    while let Ok(ev) = rx.try_recv() {
        assert!(
            !is_ui_social(&ev),
            "peer-relay não deve emitir evento de UI/social: {ev:?}"
        );
    }
    // E NUNCA cria amizade (nem coloca algo em listas de UI).
    assert!(a.friends(None).is_empty(), "peer-relay não cria amizade");
    assert!(a.friends(Some("accepted")).is_empty());
    assert!(a.friends(Some("pending_out")).is_empty());
    assert!(a.friends(Some("pending_in")).is_empty());

    a.shutdown();
    b.shutdown();
    c.shutdown();
}
