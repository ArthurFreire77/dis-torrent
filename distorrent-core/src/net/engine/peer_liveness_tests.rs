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
fn peer_sem_registro_nao_conta_como_vivo() {
    // Antes `last_rx == 0` devolvia `true` para sempre: um par que nunca mandou
    // um único frame era apresentado como "Conectado". Vivo exige evidência.
    let (e, _d) = mk_engine("vida-novo");
    assert!(!e.peer_alive("peer-sem-diag"));
}

#[test]
fn link_recem_online_tem_graca_para_o_primeiro_frame() {
    // Logo depois de conectar ainda não chegou frame: isso não é "morto",
    // é "não provado ainda". A carência existe só para não derrubar na hora.
    let (e, _d) = mk_engine("vida-graca");
    let agora = crate::identity::now_ms();
    e.diag_update("peer-novo", |d| {
        d.last_rx_ms = 0;
        d.last_direct_ok_ms = agora;
    });
    assert!(e.peer_alive("peer-novo"), "recém-online dentro da carência");

    let velho = agora - (FIRST_FRAME_GRACE.as_millis() as i64) - 1_000;
    e.diag_update("peer-mudo", |d| {
        d.last_rx_ms = 0;
        d.last_direct_ok_ms = velho;
    });
    assert!(
        !e.peer_alive("peer-mudo"),
        "passou a carência sem um frame: não está vivo"
    );
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

#[test]
fn link_online_sem_ack_com_outbox_preso_e_derrubado() {
    let (e, _d) = mk_engine("vida-meio-aberto");
    let peer = "peer-meio-aberto";
    let agora = crate::identity::now_ms();

    let link = Arc::new(PeerLink {
        state: StdMutex::new(PeerLinkState::Online),
        tx: None,
        drop_notify: Notify::new(),
        via_relay: true,
        initiator: false,
    });
    e.links.lock().unwrap().insert(peer.to_string(), link);

    let velho = agora - 600_000;
    e.diag_update(peer, |d| {
        d.last_rx_ms = agora;
        d.last_ack_ms = velho;
    });

    let conv = e
        .store
        .ensure_dm_conversation(&e.identity.fingerprint, peer, "MeioAberto")
        .unwrap();
    let env = MessageEnvelope::new(&e.keypair, &conv.id, "preso");
    e.store.insert_message(&env, "out", "sending").unwrap();
    e.store.enqueue_outbox(&env.id, peer).unwrap();
    assert_eq!(e.store.outbox_len_for_peer(peer), 1);

    e.reap_half_open_links();

    let estado = e.links.lock().unwrap().get(peer).map(|l| l.get_state());
    assert_ne!(
        estado,
        Some(PeerLinkState::Online),
        "link sem confirmação de dados não pode continuar Online"
    );
    assert_eq!(e.store.outbox_len_for_peer(peer), 1);
}

#[test]
fn link_ocioso_sem_ack_nao_e_derrubado() {
    let (e, _d) = mk_engine("vida-ocioso");
    let peer = "peer-ocioso";
    let link = Arc::new(PeerLink {
        state: StdMutex::new(PeerLinkState::Online),
        tx: None,
        drop_notify: Notify::new(),
        via_relay: true,
        initiator: false,
    });
    e.links.lock().unwrap().insert(peer.to_string(), link);
    e.diag_update(peer, |d| {
        d.last_rx_ms = 1;
        d.last_ack_ms = 0;
    });

    e.reap_half_open_links();

    let estado = e.links.lock().unwrap().get(peer).map(|l| l.get_state());
    assert_eq!(estado, Some(PeerLinkState::Online));
}

#[test]
fn sessao_nova_com_outbox_nao_e_derrubada_na_hora() {
    let (e, _d) = mk_engine("vida-nova-outbox");
    let peer = "peer-novo-outbox";
    let link = Arc::new(PeerLink {
        state: StdMutex::new(PeerLinkState::Online),
        tx: None,
        drop_notify: Notify::new(),
        via_relay: true,
        initiator: false,
    });
    e.links.lock().unwrap().insert(peer.to_string(), link);
    e.diag_update(peer, |d| {
        d.last_rx_ms = 0;
        d.last_ack_ms = 0;
    });

    let conv = e
        .store
        .ensure_dm_conversation(&e.identity.fingerprint, peer, "Novo")
        .unwrap();
    let env = MessageEnvelope::new(&e.keypair, &conv.id, "recém-enviada");
    e.store.insert_message(&env, "out", "sent").unwrap();
    e.store.enqueue_outbox(&env.id, peer).unwrap();

    e.reap_half_open_links();

    let estado = e.links.lock().unwrap().get(peer).map(|l| l.get_state());
    assert_eq!(
        estado,
        Some(PeerLinkState::Online),
        "sessão nova precisa do prazo completo antes de ser acusada"
    );
}
