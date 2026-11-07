use super::*;
use crate::protocol::SecureFrame;

fn offer(n: usize) -> SecureFrame {
    SecureFrame::CallOffer {
        call_id: format!("c{n}"),
        sdp: format!("sdp{n}"),
    }
}
fn answer(n: usize) -> SecureFrame {
    SecureFrame::CallAnswer {
        call_id: format!("c{n}"),
        sdp: format!("sdp{n}"),
    }
}
fn ice(n: usize) -> SecureFrame {
    SecureFrame::CallIce {
        call_id: "c".into(),
        candidate: format!("cand{n}"),
        mid: "0".into(),
    }
}
fn is_ice(f: &SecureFrame) -> bool {
    matches!(f, SecureFrame::CallIce { .. })
}

pub(super) fn mk(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

#[test]
fn invite_reenviado_nao_reacende_o_ring() {
    let (e, _d) = mk("ring-dedup");
    assert!(e.ring_is_new("call-x", "peer-a"), "primeiro invite toca");
    assert!(
        !e.ring_is_new("call-x", "peer-a"),
        "reenvio do MESMO invite nao pode tocar de novo"
    );
    assert!(
        e.ring_is_new("call-y", "peer-a"),
        "chamada nova precisa tocar mesmo com o mesmo peer"
    );
    assert!(
        e.ring_is_new("call-x", "peer-b"),
        "o mesmo id em outro peer e' outro convite"
    );
}

#[test]
fn call_frame_enfileirado_sobrevive_sem_link() {
    let (e, _d) = mk("call-queue-offline");
    e.enqueue_call_frame("peer-b", offer(1));
    {
        let mapa = e.pending_calls.lock().unwrap();
        let q = mapa.get("peer-b").expect("fila do peer precisa existir");
        assert!(
            q.iter().any(NetworkEngine::is_offer_frame),
            "offer enfileirada nao pode sumir"
        );
    }
    e.flush_pending_calls("peer-b");
    let mapa = e.pending_calls.lock().unwrap();
    assert!(
        mapa.get("peer-b").map(|q| q.is_empty()).unwrap_or(true),
        "o flush precisa drenar a fila da chamada"
    );
}

#[test]
fn peer_offline_nao_apaga_presenca_de_quem_nao_esta_no_canal() {
    let (e, _d) = mk("voice-presence");
    assert!(e
        .store
        .peer_voice_states("peer-sem-voz")
        .unwrap()
        .is_empty());
    e.drop_voice_presence_of("peer-sem-voz");
    assert!(e
        .store
        .peer_voice_states("peer-sem-voz")
        .unwrap()
        .is_empty());
}

#[test]
fn limpeza_de_presenca_e_por_canal() {
    let (e, _d) = mk("voice-presence-2");
    e.store
        .set_voice_state("c1", "canal-a", "peer-x", false, false)
        .unwrap();
    e.store
        .set_voice_state("c2", "canal-b", "peer-x", false, false)
        .unwrap();
    assert_eq!(e.store.peer_voice_states("peer-x").unwrap().len(), 2);
    e.store
        .drop_peer_voice_state("c1", "canal-a", "peer-x")
        .unwrap();
    let restou = e.store.peer_voice_states("peer-x").unwrap();
    assert_eq!(restou.len(), 1, "o outro canal precisa sobreviver");
    assert_eq!(restou[0], ("c2".to_string(), "canal-b".to_string()));
}

#[test]
fn descarte_nunca_derruba_offer_nem_answer() {
    let mut q: Vec<SecureFrame> = vec![offer(0), ice(0), answer(0), ice(1), ice(2), ice(3)];
    for _ in 0..10 {
        NetworkEngine::evict_call_frame(&mut q);
    }
    assert!(
        q.iter().any(NetworkEngine::is_offer_frame),
        "CallOffer jamais pode ser descartado"
    );
    assert!(
        q.iter().any(NetworkEngine::is_answer_frame),
        "CallAnswer jamais pode ser descartado"
    );
}

#[test]
fn descarte_prioriza_descartar_ice_mais_velho() {
    let mut q: Vec<SecureFrame> = vec![offer(0), ice(0), ice(1), ice(2)];
    NetworkEngine::evict_call_frame(&mut q);
    assert_eq!(q.len(), 3);
    assert!(!q
        .iter()
        .any(|f| matches!(f, SecureFrame::CallIce { candidate, .. } if candidate == "cand0")));
    assert!(q.iter().any(NetworkEngine::is_offer_frame));
}

#[test]
fn descarte_so_com_ice_nao_entra_em_panico() {
    let mut q: Vec<SecureFrame> = vec![ice(0), ice(1)];
    NetworkEngine::evict_call_frame(&mut q);
    NetworkEngine::evict_call_frame(&mut q);
    assert!(q.len() <= 1);
    let mut empty: Vec<SecureFrame> = Vec::new();
    NetworkEngine::evict_call_frame(&mut empty);
    assert!(empty.is_empty());
}

#[test]
fn fila_aclada_so_derruba_candidatos() {
    let mut q: Vec<SecureFrame> = vec![offer(0)];
    for i in 0..(NetworkEngine::PENDING_CALL_MAX * 2) {
        if q.len() >= NetworkEngine::PENDING_CALL_MAX {
            NetworkEngine::evict_call_frame(&mut q);
        }
        q.push(ice(i));
    }
    assert_eq!(q.len(), NetworkEngine::PENDING_CALL_MAX);
    assert!(
        q.iter().any(NetworkEngine::is_offer_frame),
        "a offer sobrevive a {} candidatos ICE acumulados",
        NetworkEngine::PENDING_CALL_MAX * 2
    );
}

#[test]
fn par_offer_answer_e_intocavel() {
    let mut q: Vec<SecureFrame> = vec![offer(0), answer(0)];
    for _ in 0..5 {
        NetworkEngine::evict_call_frame(&mut q);
    }
    assert_eq!(q.len(), 2, "par essencial nao pode ser reduzido");
    assert!(q.iter().any(NetworkEngine::is_offer_frame));
    assert!(q.iter().any(NetworkEngine::is_answer_frame));
    assert!(!q.iter().any(is_ice));
}
