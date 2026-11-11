//! Sala de chamada anunciada: entrada e saída precisam refletir no roster.
//! Bug do dono: entrou no canal, só via uma pessoa; e quem saía continuava
//! aparecendo para quem ficou.

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

fn grupo_com_dois() -> (Arc<NetworkEngine>, Arc<NetworkEngine>, TempDir, TempDir) {
    let (a, da) = engine("host");
    let (b, db) = engine("guest");
    (a, b, da, db)
}

fn preparar_grupo(a: &Arc<NetworkEngine>, b: &Arc<NetworkEngine>) -> String {
    let conv = a
        .create_group("Sala", vec![b.identity().fingerprint.clone()])
        .unwrap();
    b.store
        .upsert_group_state(
            &conv.id,
            "Sala",
            &[
                (a.identity().fingerprint.clone(), "host".into()),
                (b.identity().fingerprint.clone(), "guest".into()),
            ],
        )
        .unwrap();
    conv.id
}

/// Lê a sala publicada pelo engine (API pública, sem bisbilhotar campo privado).
fn sala_de(e: &Arc<NetworkEngine>, conv: &str) -> Option<(Vec<String>, String)> {
    for ev in e.rooms_snapshot() {
        if let distorrent_core::EngineEvent::CallRoom {
            conv_id,
            participants,
            host_fp,
            state,
            ..
        } = ev
        {
            if conv_id == conv && state == "open" {
                return Some((participants, host_fp));
            }
        }
    }
    None
}

#[test]
fn entrar_na_sala_anunciada_adiciona_o_novo_participante() {
    let (a, b, _da, _db) = grupo_com_dois();
    let conv = preparar_grupo(&a, &b);
    let host = a.identity().fingerprint.clone();
    let guest = b.identity().fingerprint.clone();

    a.room_open("call-1", &conv, "voice", vec![host.clone()]);
    // O convidado só conhece a sala porque RECEBEU o anúncio do host.
    b.room_receive(&host, "call-1", &conv, "voice", "open", vec![host.clone()]);

    let (call_id, alvos) = b.room_join(&conv, "voice").expect("entra na sala");
    assert_eq!(call_id, "call-1");
    assert!(alvos.contains(&host), "o alvo é o host");

    // O host recebe a entrada do convidado (é o que o app faz no join).
    a.room_receive(
        &guest,
        "call-1",
        &conv,
        "voice",
        "open",
        vec![guest.clone()],
    );

    let (participantes, _host) = sala_de(&a, &conv).expect("sala viva no host");
    assert!(
        participantes.contains(&guest),
        "o recém-chegado precisa aparecer na lista de quem já estava: {participantes:?}"
    );
}

#[test]
fn sair_da_sala_atualiza_a_lista_para_quem_ficou() {
    let (a, b, _da, _db) = grupo_com_dois();
    let conv = preparar_grupo(&a, &b);
    let host = a.identity().fingerprint.clone();
    let guest = b.identity().fingerprint.clone();

    a.room_open("call-1", &conv, "voice", vec![host.clone()]);
    b.room_receive(&host, "call-1", &conv, "voice", "open", vec![host.clone()]);
    b.room_join(&conv, "voice").expect("convidado entra");
    // O host recebe a entrada.
    a.room_receive(
        &guest,
        "call-1",
        &conv,
        "voice",
        "open",
        vec![host.clone(), guest.clone()],
    );
    assert_eq!(
        sala_de(&a, &conv).expect("host vê os dois").0.len(),
        2,
        "pré-condição: host vê os dois"
    );

    // O convidado sai e o app dele anuncia a lista SEM ele (fluxo real).
    b.leave_room(&conv);
    a.room_receive(&guest, "call-1", &conv, "voice", "open", vec![host.clone()]);

    let (participantes, _) = sala_de(&a, &conv).expect("a sala continua porque o host ficou");
    assert!(
        !participantes.contains(&guest),
        "quem saiu não pode continuar na lista: {participantes:?}"
    );
    assert_eq!(participantes, vec![host]);
}

#[test]
fn room_join_sem_ninguem_nao_promete_entrada() {
    let (a, b, _da, _db) = grupo_com_dois();
    let conv = preparar_grupo(&a, &b);
    let host = a.identity().fingerprint.clone();
    // Anúncio REAL de sala vazia: host vazio e ninguém na lista.
    b.room_receive(&host, "call-1", &conv, "voice", "open", vec![]);
    let r = b.room_join(&conv, "voice");
    assert!(
        r.is_err(),
        "sala vazia (nem o host) não pode prometer entrada"
    );
}

#[test]
fn room_join_com_host_sozinho_na_lista_permite_entrar() {
    let (a, b, _da, _db) = grupo_com_dois();
    let conv = preparar_grupo(&a, &b);
    let host = a.identity().fingerprint.clone();
    b.room_receive(&host, "call-1", &conv, "voice", "open", vec![host.clone()]);
    let (_, alvos) = b.room_join(&conv, "voice").expect("host está na sala");
    assert_eq!(alvos, vec![host]);
}

#[test]
fn sala_desconhecida_nao_abre() {
    let (b, _db) = engine("guest");
    let r = b.room_join("conv-fantasma", "voice");
    assert!(r.is_err(), "não inventa sala que ninguém anunciou");
}

#[test]
fn host_que_sai_passa_o_comando_e_a_sala_nao_morre() {
    let (a, b, _da, _db) = grupo_com_dois();
    let conv = preparar_grupo(&a, &b);
    let host = a.identity().fingerprint.clone();
    let guest = b.identity().fingerprint.clone();

    a.room_open("call-1", &conv, "voice", vec![host.clone()]);
    b.room_receive(&host, "call-1", &conv, "voice", "open", vec![host.clone()]);
    b.room_join(&conv, "voice").expect("convidado entra");
    a.room_receive(
        &guest,
        "call-1",
        &conv,
        "voice",
        "open",
        vec![host.clone(), guest.clone()],
    );
    // O convidado também precisa saber que está na sala (com ele mesmo).
    b.room_receive(
        &host,
        "call-1",
        &conv,
        "voice",
        "open",
        vec![host.clone(), guest.clone()],
    );

    // Host sai e anuncia a lista sem ele.
    a.leave_room(&conv);
    b.room_receive(&host, "call-1", &conv, "voice", "open", vec![guest.clone()]);

    let (participantes, dono) = sala_de(&b, &conv).expect("a sala sobrevive ao host");
    assert_eq!(dono, guest, "o comando passa para quem ficou");
    assert_eq!(participantes, vec![guest]);
}
