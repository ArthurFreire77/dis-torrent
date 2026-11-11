//! Roster do canal de voz: o que estava fazendo "todo mundo sumir da call".
//!
//! O relatório do dono: saiu do app, voltou, entrou no canal e só via uma
//! pessoa — os outros continuavam na call para o restante do grupo. A leitura
//! do roster apagava as linhas com carimbo velho, e a UI lê a cada 10 s.

use std::sync::Arc;

use distorrent_core::net::engine::NetworkEngine;
use distorrent_core::storage::Store;
use tempfile::TempDir;

fn engine(nick: &str) -> (Arc<NetworkEngine>, Arc<Store>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let e = NetworkEngine::new(
        store.clone(),
        kp,
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    (e, store, dir)
}

#[test]
fn ler_o_roster_nao_apaga_quem_esta_na_call() {
    let (e, store, _d) = engine("host");
    let cid = e.create_community("Sala", &[]).unwrap();
    let ch = store.channel_rows(&cid).unwrap()[0].id.clone();

    e.voice_join(&cid, &ch).unwrap();
    let me = e.identity().fingerprint.clone();
    let antes = e.list_voice_states(&cid, &ch);
    assert_eq!(antes.len(), 1, "eu estou na call");

    // Envelhece o carimbo como se o re-anúncio tivesse atrasado, e LÊ de novo
    // (é o que a UI faz a cada 10 s). A leitura não pode destruir o roster.
    e.store
        .set_voice_state(&cid, &ch, &me, false, false)
        .unwrap();
    e.store
        .envelhecer_voice_state_para_teste(&me, 10 * 60 * 1000);
    let depois = e.list_voice_states(&cid, &ch);
    assert_eq!(
        depois.len(),
        1,
        "um poll da UI não pode remover quem está na call"
    );
}

#[test]
fn manutencao_remove_so_quem_parou_de_anunciar() {
    let (e, store, _d) = engine("host");
    let cid = e.create_community("Sala", &[]).unwrap();
    let ch = store.channel_rows(&cid).unwrap()[0].id.clone();
    let morto = "aaaaaaaaaaaa";
    let vivo = "bbbbbbbbbbbb";

    store
        .set_voice_state(&cid, &ch, morto, false, false)
        .unwrap();
    store
        .set_voice_state(&cid, &ch, vivo, false, false)
        .unwrap();
    store.envelhecer_voice_state_para_teste(morto, 10 * 60 * 1000);

    let limite = distorrent_core::identity::now_ms()
        - (distorrent_core::storage::Store::VOICE_PRESENCE_TTL_MS as i64);
    let removidos = store.purge_stale_voice_states(&cid, &ch, limite).unwrap();
    assert_eq!(removidos, vec![morto.to_string()]);
    let restantes: Vec<String> = e
        .list_voice_states(&cid, &ch)
        .into_iter()
        .map(|(fp, _, _)| fp)
        .collect();
    assert_eq!(restantes, vec![vivo.to_string()], "quem anuncia fica");
}

#[test]
fn rejoin_nao_duplica_e_sair_remove_so_a_mim() {
    let (e, store, _d) = engine("host");
    let cid = e.create_community("Sala", &[]).unwrap();
    let ch = store.channel_rows(&cid).unwrap()[0].id.clone();
    let outro = "cccccccccccc";
    store
        .set_voice_state(&cid, &ch, outro, false, false)
        .unwrap();

    e.voice_join(&cid, &ch).unwrap();
    e.voice_join(&cid, &ch).unwrap();
    assert_eq!(
        e.list_voice_states(&cid, &ch).len(),
        2,
        "reentrar no mesmo canal não duplica a própria linha"
    );

    e.voice_leave(&cid, &ch).unwrap();
    let restantes: Vec<String> = e
        .list_voice_states(&cid, &ch)
        .into_iter()
        .map(|(fp, _, _)| fp)
        .collect();
    assert_eq!(
        restantes,
        vec![outro.to_string()],
        "sair não pode remover as outras pessoas"
    );
}

#[test]
fn estado_de_mute_sobrevive_ao_reanuncio() {
    let (e, store, _d) = engine("host");
    let cid = e.create_community("Sala", &[]).unwrap();
    let ch = store.channel_rows(&cid).unwrap()[0].id.clone();
    let peer = "dddddddddddd";

    store.set_voice_state(&cid, &ch, peer, true, false).unwrap();
    // Reanúncio do mesmo peer (VoiceJoin repetido) não pode "desmutar".
    store.touch_voice_state(&cid, &ch, peer).unwrap();
    let linha = e
        .list_voice_states(&cid, &ch)
        .into_iter()
        .find(|(fp, _, _)| fp == peer)
        .expect("peer continua na lista");
    assert!(linha.1, "mute do peer não pode ser zerado pelo reanúncio");
}
