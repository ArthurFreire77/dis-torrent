// Sala de chamada no fio — testes de comportamento do anúncio.
//
// O que precisa ficar travado:
//   1. abrir/renovar/fechar a sala emite o evento certo para a UI;
//   2. anúncio de quem NÃO é da conversa é recusado (sem isso qualquer nó
//      "inventaria" chamada na conversa dos outros);
//   3. o alvo do anúncio é a conversa (grupo: membros; DM: o par), nunca eu.
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

#[test]
fn publicar_sala_emite_open_com_participantes() {
    let (e, _d) = mk_engine("sala-host");
    let me = e.identity.fingerprint.clone();
    e.publish_room("call-1", "conv-1", "voice", vec![me.clone()]);
    let ev = e
        .rooms_snapshot()
        .into_iter()
        .find(|ev| matches!(ev, EngineEvent::CallRoom { conv_id, .. } if conv_id == "conv-1"));
    match ev {
        Some(EngineEvent::CallRoom { state, host_fp, .. }) => {
            assert_eq!(state, "open");
            assert_eq!(host_fp, me);
        }
        _ => panic!("esperava CallRoom open da sala publicada"),
    }
}

#[test]
fn fechar_sala_remove_do_snapshot() {
    let (e, _d) = mk_engine("sala-close");
    e.publish_room("call-1", "conv-1", "voice", vec![]);
    e.unpublish_room("conv-1");
    assert!(!e
        .rooms_snapshot()
        .iter()
        .any(|ev| matches!(ev, EngineEvent::CallRoom { conv_id, .. } if conv_id == "conv-1")));
}

#[test]
fn anuncio_de_fora_da_conversa_e_ignorado() {
    let (e, _d) = mk_engine("sala-intruso");
    e.room_receive(
        "fp-desconhecido",
        "call-x",
        "conv-alheia",
        "voice",
        "open",
        vec!["fp-desconhecido".into()],
    );
    assert!(e.rooms_snapshot().is_empty());
}

#[test]
fn dm_anuncia_para_o_par_e_nunca_para_mim() {
    let (a, _da) = mk_engine("sala-dm-a");
    let (b, _db) = mk_engine("sala-dm-b");
    let fp_b = b.identity.fingerprint.clone();
    let conv = a.open_dm(&fp_b, "B").unwrap();
    let alvos = a.room_targets(&conv.id);
    assert_eq!(alvos, vec![fp_b.clone()]);
    assert!(!alvos.contains(&a.identity.fingerprint));
}

#[test]
fn join_de_sala_inexistente_falha_com_erro_honesto() {
    let (e, _d) = mk_engine("sala-vazia");
    let err = e.room_join("conv-fantasma", "voice").unwrap_err();
    assert!(err.to_string().contains("encerrou") || err.to_string().contains("anunciada"));
}

#[test]
fn call_room_no_fio_sobrevive_ao_json() {
    let frame = SecureFrame::CallRoom {
        call_id: "call-1".into(),
        conv_id: "conv-1".into(),
        kind: "voice".into(),
        state: "open".into(),
        participants: vec!["a".into(), "b".into()],
        ts: 42,
    };
    let json = serde_json::to_string(&frame).unwrap();
    let back: SecureFrame = serde_json::from_str(&json).unwrap();
    match back {
        SecureFrame::CallRoom {
            participants, ts, ..
        } => {
            assert_eq!(participants.len(), 2);
            assert_eq!(ts, 42);
        }
        _ => panic!("frame voltou com variante errada"),
    }
}
