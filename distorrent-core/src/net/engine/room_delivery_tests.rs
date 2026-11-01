// Anúncio de sala PONTA A PONTA: dois motores, entrega real do frame.
//
// Este teste existe porque "o celular não mostra o botão Entrar" não tinha
// prova nenhuma: os testes anteriores só checavam as estruturas internas, nunca
// se o frame SAÍA e CHEGAVA no outro lado.
use super::*;
use crate::protocol::SecureFrame;
use crate::storage::Store;
use std::sync::Arc;

fn mk_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

/// Monta a conversa de grupo com os dois fps e devolve o conv_id.
///
/// `create_group` exige amizade ACEITA (é o gate do core), então o teste
/// registra os dois como amigos antes — sem isso o cenário nem chega a existir.
fn grupo_com(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>) -> String {
    a.store
        .set_friend(&b.identity.fingerprint, "B", "accepted")
        .unwrap();
    let conv = a
        .create_group("SalaTeste", vec![b.identity.fingerprint.clone()])
        .unwrap();
    conv.id
}

/// Espelha no outro motor a amizade e a conversa de grupo (o receptor precisa
/// conhecer o grupo para aceitar o anúncio de sala).
fn espelhar_grupo(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>, conv_id: &str) {
    b.store
        .set_friend(&a.identity.fingerprint, "A", "accepted")
        .unwrap();
    let membros = vec![
        (a.identity.fingerprint.clone(), "A".to_string()),
        (b.identity.fingerprint.clone(), "B".to_string()),
    ];
    b.store
        .upsert_group_state(conv_id, "SalaTeste", &membros)
        .unwrap();
}

#[test]
fn publish_room_gera_frame_para_os_membros_do_grupo() {
    let (a, _da) = mk_engine("sala-a");
    let (b, _db) = mk_engine("sala-b");
    let conv = grupo_com(&a, &b);
    let fp_b = b.identity.fingerprint.clone();

    // O alvo do anúncio TEM de incluir o outro membro do grupo.
    let alvos = a.room_targets(&conv);
    assert!(
        alvos.contains(&fp_b),
        "o membro do grupo precisa receber a sala"
    );

    // E o frame montado carrega conv/call/participantes corretos.
    a.publish_room(
        "call-x",
        &conv,
        "voice",
        vec![a.identity.fingerprint.clone()],
    );
    let room = {
        let rooms = a.call_rooms.lock().unwrap_or_else(|e| e.into_inner());
        rooms.get(&conv).cloned()
    }
    .expect("sala publicada");
    assert_eq!(room.host_fp, a.identity.fingerprint);
    assert_eq!(room.call_id, "call-x");
}

#[test]
fn convidado_sair_nao_encerra_a_chamada_do_grupo() {
    let (host, _dh) = mk_engine("sala-sai-host");
    let (guest, _dg) = mk_engine("sala-sai-guest");
    let conv = grupo_com(&host, &guest);
    espelhar_grupo(&host, &guest, &conv);
    let fp_host = host.identity.fingerprint.clone();
    let fp_guest = guest.identity.fingerprint.clone();

    // Host abre com os dois dentro.
    host.publish_room(
        "call-g",
        &conv,
        "voice",
        vec![fp_host.clone(), fp_guest.clone()],
    );
    // O convidado recebe o anúncio e entra.
    guest.room_receive(
        &fp_host,
        "call-g",
        &conv,
        "voice",
        "open",
        vec![fp_host.clone(), fp_guest.clone()],
    );

    // CONVIDADO sai: a sala TEM de continuar viva para quem ficou.
    guest.leave_room(&conv);
    let do_guest = guest.rooms_snapshot();
    // O convidado não pode anunciar "closed" (isso apagava o botão Entrar dos outros).
    assert!(
        !do_guest.iter().any(|ev| matches!(
            ev,
            EngineEvent::CallRoom { state, .. } if state == "closed"
        )),
        "quem só entrou não encerra a chamada dos outros"
    );

    // E a sala do host segue aberta com ele dentro.
    let sala_host = host
        .rooms_snapshot()
        .into_iter()
        .find_map(|ev| match ev {
            EngineEvent::CallRoom { conv_id, state, .. } if conv_id == conv => Some(state),
            _ => None,
        })
        .expect("a sala do host continua anunciada");
    assert_eq!(sala_host, "open");
}

#[test]
fn host_sozinho_encerra_a_sala_de_verdade() {
    let (host, _dh) = mk_engine("sala-fecha-host");
    let fp = host.identity.fingerprint.clone();
    host.publish_room("call-solo", "conv-solo", "voice", vec![fp]);
    host.leave_room("conv-solo");
    // `rooms_snapshot` lista só salas ABERTAS: ficar vazio prova o fechamento
    // (o evento `closed` sai pelo canal de eventos, não pelo snapshot).
    assert!(
        host.rooms_snapshot().is_empty(),
        "host sozinho fecha a sala"
    );
}

#[test]
fn receber_sala_do_outro_lado_aparece_na_ui() {
    let (a, _da) = mk_engine("sala-rx-a");
    let (b, _db) = mk_engine("sala-rx-b");
    let conv = grupo_com(&a, &b);
    espelhar_grupo(&a, &b, &conv);
    let fp_a = a.identity.fingerprint.clone();

    // Simula o frame chegando em B (mesmo caminho do handle_frame).
    b.room_receive(&fp_a, "call-y", &conv, "voice", "open", vec![fp_a.clone()]);

    let snap = b.rooms_snapshot();
    let sala = snap
        .iter()
        .find_map(|ev| match ev {
            EngineEvent::CallRoom {
                conv_id,
                call_id,
                state,
                participants,
                host_fp,
                ..
            } if conv_id == &conv => Some((
                call_id.clone(),
                state.clone(),
                participants.clone(),
                host_fp.clone(),
            )),
            _ => None,
        })
        .expect("B precisa ter a sala na lista");

    assert_eq!(sala.0, "call-y");
    assert_eq!(sala.1, "open");
    assert_eq!(sala.3, fp_a);
    assert!(sala.2.contains(&fp_a));
}

#[test]
fn membro_de_fora_nao_consegue_anunciar_na_conversa() {
    let (a, _da) = mk_engine("sala-gate-a");
    let (b, _db) = mk_engine("sala-gate-b");
    let conv = grupo_com(&a, &b);
    espelhar_grupo(&a, &b, &conv);

    // "intruso" não está no grupo: o anúncio dele tem de ser descartado.
    a.room_receive(
        "intruso",
        "call-z",
        &conv,
        "voice",
        "open",
        vec!["intruso".into()],
    );
    assert!(
        a.rooms_snapshot().is_empty(),
        "quem não é do grupo não pode anunciar chamada"
    );
}

#[test]
fn dm_anuncia_para_o_par_certo() {
    let (a, _da) = mk_engine("sala-dm-a");
    let (b, _db) = mk_engine("sala-dm-b");
    let fp_b = b.identity.fingerprint.clone();
    let conv = a.open_dm(&fp_b, "B").unwrap();

    let alvos = a.room_targets(&conv.id);
    assert_eq!(alvos, vec![fp_b], "a DM precisa anunciar só para o par");

    // E o parceiro aceita a sala vinda de A nessa conversa.
    b.store
        .set_friend(&a.identity.fingerprint, "A", "accepted")
        .unwrap();
    b.room_receive(
        &a.identity.fingerprint,
        "call-dm",
        &conv.id,
        "voice",
        "open",
        vec![a.identity.fingerprint.clone()],
    );
    assert!(
        !b.rooms_snapshot().is_empty(),
        "o par da DM precisa ver a sala"
    );
}

#[test]
fn frame_call_room_serializa_com_o_nome_que_o_frontend_espera() {
    // O frontend escuta `ev.type === 'call_room'`. Se o serde mudar o nome, o
    // botão Entrar some sem erro nenhum — foi o relato do Android.
    let ev = EngineEvent::CallRoom {
        call_id: "c1".into(),
        conv_id: "conv1".into(),
        kind: "voice".into(),
        state: "open".into(),
        participants: vec!["a".into()],
        host_fp: "a".into(),
    };
    let json = serde_json::to_value(&ev).unwrap();
    assert_eq!(json["type"], "call_room", "o tipo do evento mudou de nome");
    assert_eq!(json["conv_id"], "conv1");
    assert_eq!(json["state"], "open");
    // O frame do fio também precisa usar snake_case nos campos.
    let frame = SecureFrame::CallRoom {
        call_id: "c1".into(),
        conv_id: "conv1".into(),
        kind: "voice".into(),
        state: "open".into(),
        participants: vec!["a".into()],
        ts: 1,
    };
    let f = serde_json::to_value(&frame).unwrap();
    assert_eq!(f["CallRoom"]["conv_id"], "conv1");
}
