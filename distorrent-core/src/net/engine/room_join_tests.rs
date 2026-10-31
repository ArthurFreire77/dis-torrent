// ENTRAR numa sala anunciada: o fluxo inteiro, não só o anúncio.
//
// O relato "cliquei Entrar e não foi" pode ser:
//   a) o `room_join` não acha ninguém para avisar;
//   b) acha, mas os PCs ficam travados (quem entra faz offer, o host não responde);
//   c) a sala some antes do invite chegar.
// Este teste cobre (a) e (c), que dá para provar sem rede real.
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

fn grupo_com(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>) -> String {
    a.store
        .set_friend(&b.identity.fingerprint, "B", "accepted")
        .unwrap();
    a.create_group("SalaJoin", vec![b.identity.fingerprint.clone()])
        .unwrap()
        .id
}

fn espelhar(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>, conv_id: &str) {
    b.store
        .set_friend(&a.identity.fingerprint, "A", "accepted")
        .unwrap();
    b.store
        .upsert_group_state(
            conv_id,
            "SalaJoin",
            &[
                (a.identity.fingerprint.clone(), "A".into()),
                (b.identity.fingerprint.clone(), "B".into()),
            ],
        )
        .unwrap();
}

#[test]
fn entrar_na_sala_devolve_o_call_id_e_quem_avisar() {
    let (host, _d1) = mk_engine("join-host");
    let (quem_entra, _d2) = mk_engine("join-guest");
    let conv = grupo_com(&host, &quem_entra);
    espelhar(&host, &quem_entra, &conv);

    // Host abre a chamada e anuncia a sala (participante: só ele).
    host.publish_room(
        "call-sala-1",
        &conv,
        "voice",
        vec![host.identity.fingerprint.clone()],
    );

    // O outro lado recebe o anúncio (mesmo caminho do handle_frame).
    quem_entra.room_receive(
        &host.identity.fingerprint,
        "call-sala-1",
        &conv,
        "voice",
        "open",
        vec![host.identity.fingerprint.clone()],
    );
    assert!(
        !quem_entra.rooms_snapshot().is_empty(),
        "quem entra precisa VER a sala antes de clicar"
    );

    // Clicou Entrar.
    let (call_id, alvos) = quem_entra
        .room_join(&conv, "voice")
        .expect("join deveria funcionar");
    assert_eq!(call_id, "call-sala-1", "tem de entrar na MESMA sala");
    assert_eq!(
        alvos,
        vec![host.identity.fingerprint.clone()],
        "precisa avisar quem já estava na sala"
    );
}

#[test]
fn entrar_sem_sala_da_erro_honesto() {
    let (e, _d) = mk_engine("join-vazio");
    let err = e.room_join("conv-inexistente", "voice").unwrap_err();
    let msg = err.to_string();
    assert!(
        msg.contains("encerrou") || msg.contains("anunciada"),
        "erro precisa explicar que a sala não existe: {msg}"
    );
}

#[test]
fn entrar_em_sala_so_comigo_nao_avisa_ninguem() {
    // Sala publicada por mim mesmo, com meu fp como único participante: não há
    // ninguém para receber o invite — tem de falhar em vez de "conectar" sozinho.
    let (e, _d) = mk_engine("join-solo");
    e.publish_room(
        "call-solo",
        "conv-solo",
        "voice",
        vec![e.identity.fingerprint.clone()],
    );
    let err = e.room_join("conv-solo", "voice").unwrap_err();
    assert!(
        err.to_string().contains("ninguém"),
        "esperava 'ninguém na sala'"
    );
}

#[test]
fn sala_fechada_impede_entrar() {
    let (host, _d1) = mk_engine("join-close-host");
    let (guest, _d2) = mk_engine("join-close-guest");
    let conv = grupo_com(&host, &guest);
    espelhar(&host, &guest, &conv);

    host.publish_room(
        "call-x",
        &conv,
        "voice",
        vec![host.identity.fingerprint.clone()],
    );
    guest.room_receive(
        &host.identity.fingerprint,
        "call-x",
        &conv,
        "voice",
        "open",
        vec![host.identity.fingerprint.clone()],
    );
    // Host encerra: o anúncio de fechamento chega ao outro lado.
    guest.room_receive(
        &host.identity.fingerprint,
        "",
        &conv,
        "",
        "closed",
        Vec::new(),
    );

    let err = guest.room_join(&conv, "voice").unwrap_err();
    assert!(
        err.to_string().contains("encerrou") || err.to_string().contains("anunciada"),
        "sala fechada não pode aceitar entrada"
    );
}
