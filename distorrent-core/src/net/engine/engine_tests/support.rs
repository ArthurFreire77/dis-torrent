// Testes do motor (declarados por #[path] em engine.rs): usam os internos
// privados do modulo, por isso moram no mesmo pai.

use super::*;

/// Fingerprint de mentira usado nos testes de amizade/perfil.
pub(super) const PEER: &str = "peer-web";
use crate::net::relay::MemRelay;
use crate::storage::Store;
pub(super) fn mk_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

pub(super) fn engine_com_amigo(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let (e, d) = mk_engine(nick);
    e.store.set_friend(PEER, "Peer", "accepted").unwrap();
    (e, d)
}

#[cfg(target_os = "linux")]
pub(super) fn proximo_evento(rx: &mut broadcast::Receiver<EngineEvent>) -> Option<String> {
    rx.try_recv().ok().map(|e| format!("{e:?}"))
}

#[cfg(target_os = "linux")]
pub(super) fn block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}

#[cfg(target_os = "linux")]
pub(super) fn offer_frame(call_id: &str, sdp: String) -> SecureFrame {
    SecureFrame::CallOffer {
        call_id: call_id.into(),
        sdp,
    }
}

pub(super) fn perfil_block_on<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(f)
}
