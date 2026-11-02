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

/// LINK MEIO-VIVO: Ping/Pong mantém a sessão `Online`, mas nenhum `Ack` volta e
/// há mensagem nossa presa. O reaper precisa derrubar a sessão — sem isto o
/// outbox reenvia para o mesmo caminho morto até estourar o orçamento (o
/// relato "aparece online mas a mensagem fica no relógio").
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

    // Ping recente (a bolinha verde continua) e Ack velho (dado não volta).
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

    // Saiu do mapa (ou virou Reconnecting): o maintain rediala.
    let estado = e.links.lock().unwrap().get(peer).map(|l| l.get_state());
    assert_ne!(
        estado,
        Some(PeerLinkState::Online),
        "link sem confirmação de dados não pode continuar Online"
    );
    // A mensagem continua na fila: será reenviada na sessão nova.
    assert_eq!(e.store.outbox_len_for_peer(peer), 1);
}

/// Sem mensagem presa o link ocioso (sem Ack nunca) NÃO pode ser derrubado —
/// senão todo contato logado entraria em churn de reconexão.
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
        d.last_rx_ms = 1; // vida vinda de ping, muito antiga
        d.last_ack_ms = 0;
    });

    e.reap_half_open_links();

    let estado = e.links.lock().unwrap().get(peer).map(|l| l.get_state());
    assert_eq!(estado, Some(PeerLinkState::Online));
}

/// Sessão recém-criada com outbox presa: `last_ack`/`last_rx` zerados não
/// podem ser lidos como "2 minutos sem Ack" (subtração de zero). Já houve um
/// descarte imediato do link por causa disso.
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
