use distorrent_core::identity::Keypair;
use distorrent_core::protocol::MessageEnvelope;
use distorrent_core::storage::Store;

fn store() -> (Store, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("social.db")).unwrap();
    (s, dir)
}

#[test]
fn apagar_conversa_nao_deixa_lixo_nas_tabelas_satelites() {
    let (s, _d) = store();
    let kp = Keypair::generate();
    let me = kp.fingerprint();
    let peer = "a1b2c3d4e5f6";
    let conv = s.ensure_dm_conversation(&me, peer, "peer").unwrap();

    let env = MessageEnvelope::new(&kp, &conv.id, "oi");
    s.insert_message(&env, "out", "sent").unwrap();
    s.enqueue_outbox(&env.id, peer).unwrap();
    s.reaction_toggle(&env.id, &conv.id, "🔥", &me).unwrap();
    s.msg_set_reply(&env.id, &conv.id, &env.id).unwrap();
    s.read_set(&conv.id, 123).unwrap();
    s.conv_read_set(&conv.id, &me, 123).unwrap();
    s.dm_intro_take(&conv.id, &me, 3).unwrap();
    s.mention_add(&env.id, &conv.id, peer).unwrap();

    s.delete_conversation(&conv.id).unwrap();

    assert!(s.get_conversation(&conv.id).unwrap().is_none());
    assert_eq!(s.outbox_len_for_peer(peer), 0, "outbox ficou órfão");
    assert!(s.reactions_for_msg(&env.id).unwrap().is_empty());
    assert!(s.msg_meta(&env.id).unwrap().is_none());
    assert!(
        s.dm_intro_used(&conv.id, &me).unwrap() > 0,
        "apagar a conversa não pode devolver crédito de introdução"
    );
    assert_eq!(s.unread_mentions_for(peer).unwrap(), 0);
    assert_eq!(s.read_cursor(&conv.id).unwrap(), 0);
    assert_eq!(s.conv_read_cursor(&conv.id, &me).unwrap(), 0);
}

#[test]
fn apagar_e_reabrir_a_dm_nao_devolve_credito_de_introducao() {
    let (s, _d) = store();
    let kp = Keypair::generate();
    let me = kp.fingerprint();
    let peer = "f1f2f3f4f5f6";
    let conv = s.ensure_dm_conversation(&me, peer, "peer").unwrap();
    for _ in 0..3 {
        assert!(s
            .dm_intro_take(&conv.id, &me, distorrent_core::social::DM_INTRO_LIMIT)
            .unwrap());
    }
    s.delete_conversation(&conv.id).unwrap();
    let reaberta = s.ensure_dm_conversation(&me, peer, "peer").unwrap();
    assert_eq!(reaberta.id, conv.id);
    assert!(
        !s.dm_intro_take(&reaberta.id, &me, distorrent_core::social::DM_INTRO_LIMIT)
            .unwrap(),
        "apagar/reabrir não pode zerar o limite de mensagens iniciais"
    );
}

#[test]
fn migracao_preserva_amizades_e_cria_as_tabelas_novas() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legado.db");
    {
        let s = Store::open(&path).unwrap();
        s.set_friend("c1c2c3c4c5c6", "Amigo", "accepted").unwrap();
    }
    let s2 = Store::open(&path).unwrap();
    assert_eq!(
        s2.get_friend("c1c2c3c4c5c6").unwrap().map(|(_, st)| st),
        Some("accepted".into()),
        "a migração não pode perder amizade existente"
    );
    let tabelas = s2.table_names();
    for t in [
        "dm_intro",
        "conv_read",
        "mentions",
        "group_owners",
        "friends",
        "messages",
    ] {
        assert!(
            tabelas.iter().any(|x| x == t),
            "tabela {t} ausente depois da migração: {tabelas:?}"
        );
    }
}

#[test]
fn bloqueio_sobrevive_a_remocao_e_desbloqueio_e_explicito() {
    let (s, _d) = store();
    let peer = "d1d2d3d4d5d6";
    s.set_friend(peer, "", "blocked").unwrap();
    s.clear_friendship(peer).unwrap();
    assert!(s.is_blocked_fp(peer), "remover não desbloqueia");

    s.unblock_friend(peer).unwrap();
    assert!(!s.is_blocked_fp(peer));
    assert_eq!(
        s.get_friend(peer).unwrap().map(|(_, st)| st),
        Some("removed".into())
    );
}

#[test]
fn pedido_pendente_nao_fica_eterno_na_lista() {
    let (s, _d) = store();
    let peer = "e1e2e3e4e5e6";
    s.set_friend_request_in(peer, "peer").unwrap();
    assert_eq!(s.list_friends(Some("pending_in")).unwrap().len(), 1);

    // Envelhece além do TTL usando a API pública de manutenção.
    s.age_friend_request_for_test(peer, distorrent_core::social::FRIEND_REQUEST_TTL_MS + 1)
        .unwrap();
    assert!(
        s.list_friends(Some("pending_in")).unwrap().is_empty(),
        "pedido vencido não pode continuar pedindo ação"
    );
}
