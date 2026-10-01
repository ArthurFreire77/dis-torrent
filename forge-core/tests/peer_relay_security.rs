//! Testes de segurança do "peer relay" (correções da auditoria F1..F7).
//!
//! Fica fora do módulo p/ exercitar a API PÚBLICA do broker/engine:
//! - (c) o broker não serve um tópico sem o token/dono correto (F1);
//! - (d) o peer-relay é OPT-IN: off por padrão sem FORGE_RELAY/FORGE_PEER_RELAY (F7);
//! - (F3) o envelope do peer-relay é opaco (sem from/to/msg_id);
//! - (F6) o `PeerRelayData` serializado cabe sob o teto seguro.

use std::sync::Arc;
use std::time::Duration;

use forge_core::net::engine::NetworkEngine;
use forge_core::net::peer_relay::{fit_relay_data, PeerRelayBroker, MAX_RELAY_DATA_BYTES};
use forge_core::net::relay::chunk_frame_opaque;
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

/// (F1)/(c) O broker só serve um tópico ao seu DONO (token/capability =
/// fingerprint autenticada). Um peer que não é dono não drena e o conteúdo
/// permanece intacto.
#[test]
fn broker_nao_serve_topico_de_outro_par() {
    let b = PeerRelayBroker::new();
    // A publica no tópico de B.
    assert!(b.put("A", "distorrent_r_B", "ciphertext-de-A-para-B"));

    // C (qualquer peer, mesmo conhecendo o fp de B) NÃO drena.
    assert!(
        b.get("C", "distorrent_r_B", 1).is_empty(),
        "não-dono não pode drenar tópico alheio"
    );
    assert_eq!(b.topic_count(), 1, "tópico intacto após a tentativa");

    // B (dono) drena normalmente.
    assert_eq!(
        b.get("B", "distorrent_r_B", 2),
        vec!["ciphertext-de-A-para-B".to_string()]
    );
}

/// (F7)/(d) Peer-relay é OPT-IN: sem FORGE_RELAY/FORGE_PEER_RELAY fica OFF.
#[tokio::test]
async fn peer_relay_off_por_padrao() {
    std::env::remove_var("FORGE_RELAY");
    std::env::remove_var("FORGE_PEER_RELAY");
    std::env::remove_var("FORGE_NO_RELAY");
    let (engine, _dir) = spawn_engine("RelayDefaultOn");

    // AUTO: o intermediário por PEER nasce LIGADO (não é o relay público).
    assert!(
        engine.peer_relay_optin_enabled(),
        "intermediário por peer é automático (on)"
    );
    assert!(engine.peer_relay_enabled(), "peer-relay ligado por padrão");
    assert!(
        engine.peer_relay_serving_enabled(),
        "serve como intermediário por padrão"
    );

    // Kill-switch desliga.
    engine.set_relay_disabled(true);
    assert!(
        !engine.peer_relay_enabled(),
        "kill-switch desliga o peer-relay"
    );
    assert!(
        !engine.peer_relay_serving_enabled(),
        "kill-switch para de servir"
    );
    engine.set_relay_disabled(false);
    assert!(
        engine.peer_relay_enabled(),
        "reabilita ao desligar o kill-switch"
    );

    engine.shutdown();
}

/// (F3) O envelope do peer-relay não carrega identidade ao intermediário.
#[test]
fn envelope_peer_relay_opaco() {
    let payload = b"frame-opaco-do-peer-relay".to_vec();
    let mut prefixed = (payload.len() as u32).to_be_bytes().to_vec();
    prefixed.extend_from_slice(&payload);
    let chunks = chunk_frame_opaque(&prefixed);
    assert!(!chunks.is_empty());
    for c in &chunks {
        for marker in ["\"from\"", "\"to\"", "\"msg_id\"", "\"author\""] {
            assert!(!c.contains(marker), "envelope opaco vazou {marker}: {c}");
        }
    }
}

/// (F6) Um tópico cheio gera `PeerRelayData` que cabe sob o teto seguro.
#[test]
fn relay_data_respeita_teto() {
    let b = PeerRelayBroker::new();
    let t = "distorrent_r_dono";
    // Bytes de controle inflam o JSON (~6x ao escapar).
    let chunk = "\u{0007}".repeat(48 * 1024);
    for _ in 0..64 {
        let _ = b.put("A", t, &chunk);
    }
    let bodies = b.get("dono", t, 1);
    let fitted = fit_relay_data(bodies);
    let raw = serde_json::to_vec(&forge_core::SecureFrame::PeerRelayData {
        req_id: 0,
        bodies: fitted,
    })
    .unwrap();
    assert!(
        raw.len() <= MAX_RELAY_DATA_BYTES,
        "PeerRelayData ({}) deve respeitar o teto {}",
        raw.len(),
        MAX_RELAY_DATA_BYTES
    );
    assert!(raw.len() < (1 << 20), "deve caber em MAX_FRAME (1 MiB)");
}
