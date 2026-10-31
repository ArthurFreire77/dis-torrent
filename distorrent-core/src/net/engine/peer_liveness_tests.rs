// Online HONESTO: link vivo na memória não pode virar bolinha verde se o
// outro lado parou de responder. `peer_state` cai para Reconnecting quando o
// último frame recebido passou da janela de heartbeat.
use super::*;
use crate::storage::Store;
use std::sync::Arc;

fn mk_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

#[test]
fn sem_frame_recebido_o_peer_conta_como_vivo() {
    // Sessão recém-criada: o primeiro frame pode estar a caminho. Não pode
    // piscar "reconectando" na UI antes de dar chance ao handshake.
    let (e, _d) = mk_engine("vida-novo");
    assert!(e.peer_alive("peer-sem-diag"));
}

#[test]
fn frame_recente_mantem_vivo_e_frame_antigo_derruba() {
    let (e, _d) = mk_engine("vida-janela");
    let agora = crate::identity::now_ms();
    e.diag_update("peer-ok", |d| d.last_rx_ms = agora);
    assert!(e.peer_alive("peer-ok"));

    let velho = agora - (RELAY_PING_TIMEOUT.as_millis() as i64) - 1_000;
    e.diag_update("peer-zumbi", |d| d.last_rx_ms = velho);
    assert!(!e.peer_alive("peer-zumbi"));
}

#[test]
fn peer_sem_link_nao_e_conectado() {
    let (e, _d) = mk_engine("vida-link");
    assert_eq!(e.peer_state("ninguem"), NetworkState::Disconnected);
}
