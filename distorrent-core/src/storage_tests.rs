// Testes do Store: usam helpers internos (migrate, with_conn) por isso ficam no mesmo modulo, declarados por #[path] em storage.rs.
use super::*;
use rusqlite::params;

#[test]
fn identity_persist() {
    let store = Store::open_in_memory().unwrap();
    assert!(store.load_identity().is_none());
    let kp = crate::identity::Keypair::generate();
    let id = kp.identity("Arthur");
    store.save_identity(&id, &kp.secret_hex()).unwrap();
    let loaded = store.load_identity().unwrap();
    assert_eq!(loaded.nickname, "Arthur");
    assert_eq!(loaded.fingerprint, kp.fingerprint());
    let secret = store.load_secret_hex().unwrap();
    let kp2 = crate::identity::Keypair::from_secret_hex(&secret).unwrap();
    assert_eq!(kp2.public_hex(), kp.public_hex());
}

#[test]
fn dm_conversation_id_symmetric() {
    let a = "aaaaaaaaaaaa";
    let b = "bbbbbbbbbbbb";
    assert_eq!(
        Store::dm_conversation_id(a, b),
        Store::dm_conversation_id(b, a)
    );
    let c = "cccccccccccc";
    assert_ne!(
        Store::dm_conversation_id(a, b),
        Store::dm_conversation_id(a, c)
    );
}

#[test]
fn outbox_respeita_backoff_e_teto_de_tentativas() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "oi");
    store.insert_message(&env, "out", "pending").unwrap();
    store.enqueue_outbox(&env.id, "peerfp000001").unwrap();

    assert_eq!(
        store.pending_outbox("peerfp000001").unwrap(),
        vec![env.id.clone()]
    );

    store.bump_outbox(&env.id).unwrap();
    assert!(
        store.pending_outbox("peerfp000001").unwrap().is_empty(),
        "com backoff ativo o mesmo flush não pode reenviar"
    );

    for _ in 0..Store::OUTBOX_MAX_ATTEMPTS {
        store.bump_outbox(&env.id).unwrap();
    }
    let gave_up = store.give_up_outbox("peerfp000001").unwrap();
    assert_eq!(gave_up, vec![env.id.clone()]);
    assert!(store.pending_outbox("peerfp000001").unwrap().is_empty());
    let m = store.message_by_id(&env.id).unwrap().unwrap();
    assert_eq!(
        m.status, "failed",
        "mensagem sem confirmação precisa ficar visível como falha"
    );
}

#[test]
fn failed_volta_pra_fila_quando_o_amigo_reconecta() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let peer = "peerfp000003";
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, peer, "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "oi");
    store.insert_message(&env, "out", "sent").unwrap();
    store.enqueue_outbox(&env.id, peer).unwrap();
    for _ in 0..=Store::OUTBOX_MAX_ATTEMPTS {
        store.bump_outbox(&env.id).unwrap();
    }
    assert_eq!(store.give_up_outbox(peer).unwrap(), vec![env.id.clone()]);
    assert_eq!(
        store.message_by_id(&env.id).unwrap().unwrap().status,
        "failed"
    );
    assert!(
        store.outbox_len_for_peer(peer) == 0,
        "desistiu saiu da fila"
    );

    // Reconexão: a falha volta para pending e ganha nova tentativa.
    assert_eq!(store.requeue_failed_for_peer(peer).unwrap(), 1);
    let m = store.message_by_id(&env.id).unwrap().unwrap();
    assert_eq!(
        m.status, "pending",
        "failed antigo não fica preso para sempre"
    );
    assert_eq!(store.pending_outbox(peer).unwrap(), vec![env.id.clone()]);
}

#[test]
fn outbox_peers_inclui_quem_esta_offline() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let peer = "peerfp000004";
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, peer, "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "pendente");
    store.insert_message(&env, "out", "pending").unwrap();
    store.enqueue_outbox(&env.id, peer).unwrap();
    // Sem link Online, o flush antigo nunca olhava este outbox.
    assert_eq!(store.outbox_peers().unwrap(), vec![peer.to_string()]);
}

#[test]
fn sending_preso_sem_link_volta_para_pending() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let peer = "peerfp000005";
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, peer, "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "enviando");
    store.insert_message(&env, "out", "sending").unwrap();
    store.enqueue_outbox(&env.id, peer).unwrap();
    let futuro = crate::identity::now_ms() + 5_000;
    let ids = store.revert_stuck_outbox_sending(futuro).unwrap();
    assert_eq!(ids, vec![env.id.clone()]);
    assert_eq!(
        store.message_by_id(&env.id).unwrap().unwrap().status,
        "pending"
    );
}

#[test]
fn backoff_do_outbox_cresce_e_da_janela_util() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, "peerfp000002", "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "oi");
    store.insert_message(&env, "out", "pending").unwrap();
    store.enqueue_outbox(&env.id, "peerfp000002").unwrap();

    let mut esperas: Vec<i64> = Vec::new();
    for _ in 0..Store::OUTBOX_MAX_ATTEMPTS {
        let antes = crate::identity::now_ms();
        store.bump_outbox(&env.id).unwrap();
        let (next, _): (i64, i64) = store
            .locked()
            .query_row(
                "SELECT next_try, attempts FROM outbox WHERE msg_id=?1",
                params![env.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        esperas.push(next - antes);
    }

    let crescimento: Vec<i64> = esperas.iter().copied().filter(|e| *e < 480_000).collect();
    assert!(
        crescimento.windows(2).all(|w| w[0] <= w[1]),
        "backoff precisa crescer até o teto, veio {esperas:?}"
    );
    assert!(
        esperas[0] < 20_000 && esperas.iter().any(|e| *e >= 60_000),
        "começa curto e cresce de verdade, veio {esperas:?}"
    );
    let total: i64 = esperas.iter().sum();
    assert!(
        total >= 30 * 60 * 1000,
        "a janela total precisa passar de 30 min para sobreviver a uma \
             reconexão por relay (era ~3 min com +15s fixo), veio {total} ms"
    );
}

#[test]
fn retransmissao_da_mesma_mensagem_nao_penaliza() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "mesma");
    store.insert_message(&env, "in", "ok").unwrap();
    store.insert_message(&env, "in", "ok").unwrap();
    let msgs = store.list_messages(&conv.id, 100).unwrap();
    assert_eq!(msgs.len(), 1, "o id é a chave: reentrega não duplica linha");
}

#[test]
fn reenvio_preserva_o_id_e_zera_o_orcamento() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "reenviar");
    store.insert_message(&env, "out", "failed").unwrap();

    store.enqueue_outbox(&env.id, "peerfp000001").unwrap();
    for _ in 0..Store::OUTBOX_MAX_ATTEMPTS {
        store.bump_outbox(&env.id).unwrap();
    }
    assert!(
        store.pending_outbox("peerfp000001").unwrap().is_empty(),
        "estourada não sai no flush normal"
    );

    store.requeue_outbox(&env.id, "peerfp000001").unwrap();
    let prontas = store.pending_outbox("peerfp000001").unwrap();
    assert_eq!(prontas, vec![env.id.clone()], "o MESMO id volta a sair");

    let msgs = store.list_messages(&conv.id, 100).unwrap();
    assert_eq!(msgs.len(), 1, "reenviar não cria outra linha");
}

#[test]
fn conversations_and_messages_flow() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let me = kp.identity("me");
    let conv = store
        .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
        .unwrap();
    let env = MessageEnvelope::new(&kp, &conv.id, "oi");
    store.insert_message(&env, "out", "pending").unwrap();
    store.set_message_status(&env.id, "sent").unwrap();

    let msgs = store.list_messages(&conv.id, 100).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].status, "sent");
    assert_eq!(msgs[0].direction, "out");

    let convs = store.list_conversations().unwrap();
    assert_eq!(convs.len(), 1);
    assert_eq!(convs[0].peer_fp, "peerfp000001");

    store.enqueue_outbox(&env.id, "peerfp000001").unwrap();
    assert_eq!(
        store.pending_outbox("peerfp000001").unwrap(),
        vec![env.id.clone()]
    );
    store.dequeue_outbox(&env.id).unwrap();
    assert!(store.pending_outbox("peerfp000001").unwrap().is_empty());
}

#[test]
fn channel_message_without_conversation_row() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let env = MessageEnvelope::new(&kp, "canal-fake-1", "oi canal");
    store.insert_message(&env, "out", "sent").unwrap();
    assert_eq!(store.list_messages("canal-fake-1", 10).unwrap().len(), 1);
}

#[test]
fn recibo_de_um_membro_nao_marca_lida_para_o_grupo_todo() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let env = MessageEnvelope::new(&kp, "grupo-1", "oi grupo");
    store.insert_message(&env, "out", "sent").unwrap();
    let ts = env.ts;
    let esperados = vec!["peer-a".to_string(), "peer-b".to_string()];

    store.record_read_receipt("grupo-1", "peer-a", ts).unwrap();
    let todos = store
        .messages_read_by_all("grupo-1", ts, &esperados)
        .unwrap();
    assert!(
        todos.is_empty(),
        "com um membro faltando a mensagem NÃO está lida por todos: {todos:?}"
    );

    store.record_read_receipt("grupo-1", "peer-b", ts).unwrap();
    let todos = store
        .messages_read_by_all("grupo-1", ts, &esperados)
        .unwrap();
    assert_eq!(todos, vec![env.id.clone()], "agora todos visualizaram");
}

#[test]
fn recibos_listam_quem_visualizou_com_horario() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let env = MessageEnvelope::new(&kp, "grupo-2", "oi");
    store.insert_message(&env, "out", "sent").unwrap();
    store
        .record_read_receipt("grupo-2", "peer-z", env.ts)
        .unwrap();

    let linhas = store.receipts_for(&[env.id.clone()]).unwrap();
    assert_eq!(linhas.len(), 1);
    assert_eq!(linhas[0].0, env.id);
    assert_eq!(linhas[0].1, "peer-z");
    assert!(linhas[0].2 > 0, "o instante precisa ser real, não zero");
}

#[test]
fn recibo_nao_duplica_por_membro() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let env = MessageEnvelope::new(&kp, "grupo-3", "oi");
    store.insert_message(&env, "out", "sent").unwrap();
    store
        .record_read_receipt("grupo-3", "peer-a", env.ts)
        .unwrap();
    store
        .record_read_receipt("grupo-3", "peer-a", env.ts)
        .unwrap();
    assert_eq!(store.receipts_for(&[env.id.clone()]).unwrap().len(), 1);
}

#[test]
fn sem_membros_esperados_ninguem_esta_lido() {
    let store = Store::open_in_memory().unwrap();
    let kp = crate::identity::Keypair::generate();
    let env = MessageEnvelope::new(&kp, "grupo-4", "oi");
    store.insert_message(&env, "out", "sent").unwrap();
    store
        .record_read_receipt("grupo-4", "peer-a", env.ts)
        .unwrap();
    assert!(store
        .messages_read_by_all("grupo-4", env.ts, &[])
        .unwrap()
        .is_empty());
}

#[test]
fn peers_upsert() {
    let store = Store::open_in_memory().unwrap();
    let p = PeerRecord {
        fp: "fp0000000001".into(),
        pubkey_hex: "ab".repeat(32),
        nickname: "Node A".into(),
        addr: Some("192.168.0.5:40000".into()),
        last_seen: 1,
        origin: "discovery".into(),
    };
    store.upsert_peer(&p).unwrap();
    let mut p2 = p.clone();
    p2.nickname = "".into();
    p2.last_seen = 2;
    p2.addr = None;
    store.upsert_peer(&p2).unwrap();
    let got = store.get_peer("fp0000000001").unwrap().unwrap();
    assert_eq!(got.nickname, "Node A");
    assert_eq!(got.addr.as_deref(), Some("192.168.0.5:40000"));
    assert_eq!(got.last_seen, 2);
    // A chave NÃO pode trocar para o mesmo fingerprint.
    let mut trocado = p.clone();
    trocado.pubkey_hex = "cd".repeat(32);
    assert!(
        store.upsert_peer(&trocado).is_err(),
        "troca de pubkey para o mesmo fp precisa ser recusada"
    );
    assert_eq!(
        store.get_peer("fp0000000001").unwrap().unwrap().pubkey_hex,
        p.pubkey_hex
    );
    // Sem pubkey conhecida ainda, a primeira chave vale; depois fica travada.
    let vazio = PeerRecord {
        fp: "fp0000000002".into(),
        pubkey_hex: String::new(),
        nickname: "sem chave".into(),
        addr: None,
        last_seen: 1,
        origin: "discovery".into(),
    };
    store.upsert_peer(&vazio).unwrap();
    let mut depois = vazio.clone();
    depois.pubkey_hex = p.pubkey_hex.clone();
    store.upsert_peer(&depois).unwrap();
    assert_eq!(
        store.get_peer("fp0000000002").unwrap().unwrap().pubkey_hex,
        p.pubkey_hex
    );
}
