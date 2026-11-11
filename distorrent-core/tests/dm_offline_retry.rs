//! Caso real do relatório: amigo online na presença, mas sem rota (direta e
//! relay falhando). A mensagem não pode ficar presa em "sending" nem virar
//! "failed" definitivo: ela precisa voltar para a fila e sair ao reconectar.

use std::sync::Arc;

use distorrent_core::net::engine::NetworkEngine;
use distorrent_core::storage::Store;
use tempfile::TempDir;

fn engine(nick: &str) -> (Arc<NetworkEngine>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

#[test]
fn dm_para_amigo_sem_rota_fica_pendente_e_sai_da_fila_ao_reconectar() {
    let (a, _da) = engine("remetente");
    let peer = "0badc0ffee11";

    // Amizade aceita e DM aberta, mas SEM link: é o peer que falha direto e
    // por relay no relatório (visto no DHT, sem sessão).
    a.store.set_friend(peer, "amigo", "accepted").unwrap();
    let conv = a.open_dm(peer, "amigo").unwrap();

    let m = a.send_dm(&conv.id, "teste de fila").unwrap();
    assert_eq!(
        m.status, "pending",
        "sem rota a mensagem fica pendente, não some"
    );
    assert_eq!(
        a.store.outbox_len_for_peer(peer),
        1,
        "o outbox precisa guardar a mensagem"
    );

    // Simula as tentativas que falharam e desistiram (o caso do banco real).
    for _ in 0..=Store::OUTBOX_MAX_ATTEMPTS {
        a.store.bump_outbox(&m.id).unwrap();
    }
    let desistiram = a.store.give_up_outbox(peer).unwrap();
    assert_eq!(desistiram, vec![m.id.clone()]);
    assert_eq!(
        a.store.message_by_id(&m.id).unwrap().unwrap().status,
        "failed"
    );

    // Ao reconectar, o flush reenfileira o failed e ele volta a ser tentado.
    let reenfileirados = a.store.requeue_failed_for_peer(peer).unwrap();
    assert_eq!(
        reenfileirados, 1,
        "amigo já tem a mensagem de volta na fila"
    );
    let depois = a.store.message_by_id(&m.id).unwrap().unwrap();
    assert_eq!(
        depois.status, "pending",
        "failed antigo não pode ficar preso para sempre"
    );
    assert_eq!(
        a.store.pending_outbox(peer).unwrap(),
        vec![m.id.clone()],
        "e o outbox volta a entregar"
    );
}

#[test]
fn envio_manual_para_amigo_sem_rota_nao_quebra_o_historico() {
    let (a, _da) = engine("historico");
    let peer = "0badc0ffee22";
    a.store.set_friend(peer, "amigo", "accepted").unwrap();
    let conv = a.open_dm(peer, "amigo").unwrap();

    let primeira = a.send_dm(&conv.id, "primeira").unwrap();
    let segunda = a.send_dm(&conv.id, "segunda").unwrap();
    assert_ne!(primeira.id, segunda.id);
    assert_eq!(a.messages(&conv.id).len(), 2, "nada de mensagem duplicada");
    // O limite de 3 é só para NÃO-amigo; amigo não é limitado.
    let terceira = a.send_dm(&conv.id, "terceira").unwrap();
    let quarta = a.send_dm(&conv.id, "quarta").unwrap();
    assert_eq!(terceira.status, "pending");
    assert_eq!(quarta.status, "pending");
    assert_eq!(a.messages(&conv.id).len(), 4);
}

#[test]
fn contato_nao_amigo_respeita_as_tres_mensagens() {
    let (a, _da) = engine("intro");
    let peer = "0badc0ffee33";
    let conv = a.open_dm(peer, "contato").unwrap();
    for i in 0..3 {
        let m = a.send_dm(&conv.id, &format!("msg {i}")).unwrap();
        assert_eq!(m.status, "pending");
    }
    let err = a.send_dm(&conv.id, "quarta").unwrap_err();
    assert!(
        err.to_string().contains("limite"),
        "a quarta mensagem de contato precisa ser recusada: {err}"
    );
    assert_eq!(
        a.messages(&conv.id).len(),
        3,
        "a recusa não pode gravar a mensagem"
    );

    // Amizade aceita zera o limite e preserva o histórico.
    a.store.accept_friend(peer, "contato").unwrap();
    let amigo = a.send_dm(&conv.id, "agora sim").unwrap();
    assert_eq!(amigo.status, "pending");
    assert_eq!(a.messages(&conv.id).len(), 4, "histórico preservado");
}

#[test]
fn presenca_persistida_nao_sobrevive_ao_peer_offline() {
    let (a, _da) = engine("presenca");
    let peer = "0badc0ffee44";
    a.store.set_friend(peer, "amigo", "accepted").unwrap();
    a.store.presence_set(peer, "online", "", "").unwrap();
    assert_eq!(
        a.store.presence_get(peer).unwrap().status,
        "online",
        "pré-condição: presença gravada"
    );
    // A sessão que cai grava offline — o verde não pode sobreviver ao link.
    a.store.presence_offline(peer).unwrap();
    assert_eq!(a.store.presence_get(peer).unwrap().status, "offline");
}
