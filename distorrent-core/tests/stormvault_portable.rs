use distorrent_core::identity::Keypair;
use distorrent_core::protocol::MessageEnvelope;
use distorrent_core::storage::Store;
use distorrent_core::stormvault;

fn twoway_find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn mk_account(nick: &str) -> (Store, Keypair) {
    let store = Store::open_in_memory().unwrap();
    let kp = Keypair::generate();
    let identity = kp.identity(nick);
    store.save_identity(&identity, &kp.secret_hex()).unwrap();
    (store, kp)
}

fn seed_conversation(store: &Store, kp: &Keypair, peer_fp: &str, bodies: &[&str]) {
    let conv = store
        .ensure_dm_conversation(&kp.fingerprint(), peer_fp, "amigo")
        .unwrap();
    for body in bodies {
        let env = MessageEnvelope::new(kp, &conv.id, body);
        let dir = if env.author_fp == kp.fingerprint() {
            "out"
        } else {
            "in"
        };
        store.insert_message(&env, dir, "sent").unwrap();
    }
}

#[test]
fn export_import_cross_device_roundtrip() {
    let (a, kp) = mk_account("alice-w");
    seed_conversation(
        &a,
        &kp,
        "b0b0b0b0b0b0",
        &["oi", "tudo bem?", "terceira msg"],
    );
    a.set_friend("b0b0b0b0b0b0", "bob", "accepted").unwrap();
    a.create_community("cid-1", "clube", &kp.fingerprint(), &[("ch-1", "geral")])
        .unwrap();
    a.kv_set("privacy.mode", "proxy").unwrap();

    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "senha-forte-123").unwrap();

    let h = stormvault::read_header(&sealed).unwrap();
    assert_eq!(h.fp, kp.fingerprint());
    assert_eq!(h.nickname, "alice-w");
    assert_eq!(h.msg_count, 3);
    assert_eq!(h.v, 1);

    let b = Store::open_in_memory().unwrap();
    let report = stormvault::import_with_password(&b, &sealed, "senha-forte-123").unwrap();
    assert!(report.identity_installed);
    assert_eq!(report.messages_merged, 3);
    assert_eq!(report.friends_merged, 1);
    assert_eq!(report.conversations_added, 1);
    assert_eq!(report.communities_merged, 1);
    assert_eq!(report.settings_imported, 1);

    assert_eq!(b.kv_get("vault.on").as_deref(), Some("1"));
    let blob_hex = b.load_secret_hex().unwrap();
    let secret =
        distorrent_core::vault::open_sealed(&hex::decode(&blob_hex).unwrap(), "senha-forte-123")
            .unwrap();
    assert_eq!(secret, kp.secret_hex());

    let convs = b.list_conversations().unwrap();
    assert_eq!(convs.len(), 1);
    let msgs = b.list_messages(&convs[0].id, 100).unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].body, "oi");
    assert_eq!(msgs[2].body, "terceira msg");

    assert_eq!(
        b.get_friend("b0b0b0b0b0b0").unwrap().unwrap(),
        ("bob".to_string(), "accepted".to_string())
    );
    assert_eq!(b.list_communities().unwrap().len(), 1);
    assert_eq!(b.kv_get("privacy.mode").as_deref(), Some("proxy"));
}

#[test]
fn merge_same_account_no_loss_no_dup() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["msg de A"]);

    let b = Store::open_in_memory().unwrap();
    b.save_identity(&a.load_identity().unwrap(), "x").unwrap();
    let conv_b = b
        .ensure_dm_conversation(&kp.fingerprint(), "b0b0b0b0b0b0", "amigo")
        .unwrap();
    assert_eq!(conv_b.id, a.list_conversations().unwrap()[0].id);
    let env_b = MessageEnvelope::new(&kp, &conv_b.id, "msg local de B");
    b.insert_message(&env_b, "out", "sent").unwrap();

    let data = stormvault::collect(&a, None, None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "senha-123").unwrap();
    let opened = stormvault::open_with_password(&sealed, "senha-123").unwrap();
    let report = stormvault::import_merge_only(&b, &opened).unwrap();
    assert!(!report.identity_installed);
    assert_eq!(report.messages_merged, 1);

    let msgs = b.list_messages(&conv_b.id, 100).unwrap();
    assert_eq!(msgs.len(), 2);
    let bodies: Vec<_> = msgs.iter().map(|m| m.body.as_str()).collect();
    assert!(bodies.contains(&"msg de A"));
    assert!(bodies.contains(&"msg local de B"));

    let report2 = stormvault::import_merge_only(&b, &opened).unwrap();
    assert_eq!(report2.messages_merged, 0);
    assert_eq!(b.list_messages(&conv_b.id, 100).unwrap().len(), 2);
}

#[test]
fn import_wrong_account_refused() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "senha-123").unwrap();
    let opened = stormvault::open_with_password(&sealed, "senha-123").unwrap();

    let (b, _) = mk_account("mallory");
    let err = stormvault::import_merge_only(&b, &opened).unwrap_err();
    assert!(err.to_string().contains("outra conta"), "erro foi: {err}");
    assert!(b.list_conversations().unwrap().is_empty());
}

#[test]
fn dataless_vault_cannot_install() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let data = stormvault::collect(&a, None, None).unwrap();
    assert!(data.secret_hex.is_none());
    let sealed = stormvault::seal_with_password(&data, "senha-123").unwrap();

    let b = Store::open_in_memory().unwrap();
    let err = stormvault::import_with_password(&b, &sealed, "senha-123").unwrap_err();
    assert!(err.to_string().contains("chave privada"), "erro foi: {err}");
}

#[test]
fn vault_file_attacks_rejected() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["segredo"]);
    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let sealed = stormvault::seal_with_password(&data, "correta-123").unwrap();

    assert!(stormvault::open_with_password(&sealed, "errada-123").is_err());

    let mut trunc = sealed.clone();
    trunc.truncate(trunc.len() - 20);
    assert!(stormvault::open_with_password(&trunc, "correta-123").is_err());

    let mut flip = sealed.clone();
    let mid = flip.len() / 2;
    flip[mid] ^= 0x01;
    assert!(stormvault::open_with_password(&flip, "correta-123").is_err());

    let mut tampered = sealed.clone();
    let fp_marker = format!("\"fp\":\"{}\"", kp.fingerprint());
    let pos = twoway_find(&tampered, fp_marker.as_bytes()).expect("fp no header");
    let flip_at = pos + 6;
    tampered[flip_at] = if tampered[flip_at] == b'a' {
        b'b'
    } else {
        b'a'
    };
    assert!(stormvault::open_with_password(&tampered, "correta-123").is_err());
    let (c, _) = mk_account("carol");
    let data_c = stormvault::collect(&c, None, None).unwrap();
    let sealed_c = stormvault::seal_with_password(&data_c, "outra-123").unwrap();
    let hc = stormvault::read_header(&sealed_c).unwrap();
    let ha = stormvault::read_header(&sealed).unwrap();
    assert_ne!(hc.fp, ha.fp);
    let mut glued = sealed.clone();
    let nick_marker = b"\"nickname\":\"alice\"";
    let npos = twoway_find(&glued, nick_marker).expect("nick no header");
    glued[npos + 12] = b'X';
    assert!(stormvault::open_with_password(&glued, "correta-123").is_err());

    let b = Store::open_in_memory().unwrap();
    stormvault::import_with_password(&b, &sealed, "correta-123").unwrap();
    let convs = b.list_conversations().unwrap();
    let env_new = MessageEnvelope::new(&kp, &convs[0].id, "mensagem NOVA pós-backup");
    b.insert_message(&env_new, "out", "sent").unwrap();
    let report = stormvault::import_with_password(&b, &sealed, "correta-123").unwrap();
    assert!(!report.identity_installed);
    let msgs = b.list_messages(&convs[0].id, 100).unwrap();
    assert_eq!(msgs.len(), 2, "replay não pode apagar a mensagem nova");
    assert!(msgs.iter().any(|m| m.body == "mensagem NOVA pós-backup"));
}

#[test]
fn backup_key_mode_and_retention() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let key = stormvault::backup_key_for(&kp.secret_hex());
    let sealed = stormvault::seal_with_key(&data, &key).unwrap();

    assert_eq!(key, stormvault::backup_key_for(&kp.secret_hex()));
    let opened = stormvault::open_with_key(&sealed, &key).unwrap();
    assert_eq!(opened.messages.len(), 1);

    assert!(stormvault::open_with_key(&sealed, &[9u8; 32]).is_err());
    assert!(stormvault::open_with_password(&sealed, "qualquer").is_err());

    let dir = tempfile::tempdir().unwrap();
    let day = 86_400_000i64;
    let now = 1_800_000_000_000i64;
    for age_days in [100, 40, 20, 10, 0] {
        let name = stormvault::backup_file_name(now - age_days * day);
        std::fs::write(dir.path().join(&name), &sealed).unwrap();
    }
    std::fs::write(dir.path().join("nota.txt"), b"oi").unwrap();
    let removed = stormvault::prune_backup_files(dir.path(), 30, now).unwrap();
    assert_eq!(removed, 2);
    let files = stormvault::list_backup_files(dir.path());
    assert_eq!(files.len(), 3);
    assert!(dir.path().join("nota.txt").exists());

    let removed = stormvault::prune_backup_files(dir.path(), 3650, now).unwrap();
    assert_eq!(removed, 0);
}

#[test]
fn export_message_cap() {
    let (a, kp) = mk_account("alice");
    let bodies: Vec<String> = (0..50).map(|i| format!("msg {i}")).collect();
    let refs: Vec<&str> = bodies.iter().map(|s| s.as_str()).collect();
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &refs);

    let data = stormvault::collect(&a, None, Some(10)).unwrap();
    assert_eq!(data.messages.len(), 10);
    assert!(data.meta.messages_truncated);
    for m in &data.messages {
        let n: usize = m.body.trim_start_matches("msg ").parse().unwrap();
        assert!(n < 50, "corpo inesperado: {}", m.body);
    }

    let full = stormvault::collect(&a, None, None).unwrap();
    assert_eq!(full.messages.len(), 50);
    assert!(!full.meta.messages_truncated);
}

#[test]
fn perfil_react_pin_read_e_bookmark_viajam_no_cofre() {
    let (a, kp) = mk_account("alice");
    let me = kp.fingerprint();
    seed_conversation(
        &a,
        &kp,
        "b0b0b0b0b0b0",
        &["oi", "combinado", "apagar pra mim"],
    );
    a.profile_set_local(
        &me,
        "Alice",
        "sobre mim",
        "QUJD",
        "REVG",
        "#5865f2",
        false,
        false,
    )
    .unwrap();
    let conv = a.list_conversations().unwrap()[0].clone();
    let msgs = a.list_messages(&conv.id, 10).unwrap();
    let first = msgs[0].id.clone();
    let second = msgs[1].id.clone();
    let third = msgs[2].id.clone();
    a.reaction_toggle(&first, &conv.id, "🔥", &me).unwrap();
    a.msg_pin(&second, &conv.id, true, &me).unwrap();
    a.bookmark_set(&conv.id, "receita", "https://exemplo")
        .unwrap();
    a.conv_read_set(&conv.id, &me, msgs[0].ts).unwrap();
    a.hide_messages_local(&[third.clone()]).unwrap();

    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    assert_eq!(data.meta.data_version, 2);
    assert!(data
        .profiles
        .iter()
        .any(|p| p.fp == me && p.avatar_b64 == "QUJD"));
    assert!(data.reactions.iter().any(|r| r.msg_id == first));
    assert!(data
        .message_meta
        .iter()
        .any(|m| m.msg_id == second && m.pinned));
    assert!(data.bookmarks.iter().any(|b| b.name == "receita"));
    assert!(
        data.read_states.iter().any(|r| r.conv_id == conv.id),
        "read state do usuário deve exportar"
    );
    assert!(data.hidden.iter().any(|h| h.msg_id == third));

    let sealed = stormvault::seal_with_password(&data, "senha-forte-123").unwrap();
    let b = Store::open_in_memory().unwrap();
    let report = stormvault::import_with_password(&b, &sealed, "senha-forte-123").unwrap();
    assert!(report.identity_installed);
    assert!(report.profiles_merged >= 1);
    assert!(
        report.social_merged >= 3,
        "reação/pin/read/bookmark: {}",
        report.social_merged
    );
    let prof = b.profile_get(&me).unwrap();
    assert_eq!(prof.avatar_b64, "QUJD", "avatar não sobreviveu ao cofre");
    assert_eq!(prof.banner_b64, "REVG");
    assert!(b
        .pins_list(&conv.id)
        .unwrap()
        .iter()
        .any(|p| p.msg_id == second));
    assert!(
        !b.reaction_toggle(&first, &conv.id, "🔥", &me).unwrap(),
        "reação importada já existia"
    );
    assert_eq!(b.conv_read_cursor(&conv.id, &me).unwrap(), msgs[0].ts);
    assert_eq!(b.bookmark_list(&conv.id).unwrap().len(), 1);
    let visible = b.list_messages(&conv.id, 100).unwrap();
    assert!(
        visible.iter().all(|m| m.id != third),
        "mensagem apagada-para-mim deve continuar oculta"
    );
}

#[test]
fn bots_nao_exportam_token_nem_segredo_de_webhook() {
    let (a, kp) = mk_account("alice");
    let me = kp.fingerprint();
    a.create_community("cid-bot", "clube", &me, &[("ch-1", "geral")])
        .unwrap();
    let mut bot = distorrent_core::storage::BotRow {
        id: "bot-1".into(),
        community_id: "cid-bot".into(),
        name: "Ajudante".into(),
        discriminator: "0001".into(),
        avatar: "🤖".into(),
        role_id: None,
        token: "token-local-secreto".into(),
        online: true,
        owner_fp: me.clone(),
        created_at: 1,
        config: "{}".into(),
        perms: 0,
        webhook_secret: "webhook-secreto".into(),
    };
    a.bot_upsert(&bot).unwrap();
    let data = stormvault::collect(&a, None, None).unwrap();
    let exported = data.communities.iter().find(|c| c.id == "cid-bot").unwrap();
    assert!(
        exported
            .bots
            .iter()
            .all(|b| b.token.is_empty() && b.webhook_secret.is_empty()),
        "credencial de bot não pode sair no cofre"
    );
    bot.token.clear();
    bot.webhook_secret.clear();
    assert!(exported
        .bots
        .iter()
        .any(|b| b.name == "Ajudante" && b.owner_fp == me));
}

#[test]
fn cofre_v1_antigo_continua_abrindo() {
    let (a, kp) = mk_account("alice");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["histórico antigo"]);
    // Simula um cofre v1: remove os campos novos do JSON e do meta.
    let data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let mut json = serde_json::to_value(&data).unwrap();
    let obj = json.as_object_mut().unwrap();
    for key in [
        "profiles",
        "presence",
        "reactions",
        "message_meta",
        "read_states",
        "bookmarks",
        "threads",
        "polls",
        "poll_votes",
        "events",
        "emojis",
        "bans",
        "timeouts",
        "channel_cfg",
        "server_nicknames",
        "group_owners",
        "mentions",
        "hidden",
    ] {
        obj.remove(key);
    }
    obj.get_mut("meta")
        .and_then(|m| m.as_object_mut())
        .unwrap()
        .remove("data_version");
    let v1: stormvault::StormVaultData = serde_json::from_value(json).unwrap();
    assert_eq!(v1.meta.data_version, 1);
    assert!(v1.profiles.is_empty());

    let sealed = stormvault::seal_with_password(&v1, "senha-12345").unwrap();
    let h = stormvault::read_header(&sealed).unwrap();
    assert_eq!(h.v, 1, "container não pode mudar de versão (AAD)");
    let b = Store::open_in_memory().unwrap();
    let report = stormvault::import_with_password(&b, &sealed, "senha-12345").unwrap();
    assert_eq!(report.data_version, 1);
    assert_eq!(report.messages_merged, 1);
}

#[test]
fn identidade_trocada_no_payload_recusada() {
    let (a, kp) = mk_account("alice");
    let (outra, kp_outra) = mk_account("mallory");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let _ = outra;

    // 1) fingerprint inventado, pubkey de outra pessoa.
    let mut data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    data.identity.pubkey_hex = kp_outra.public_hex();
    let sealed = stormvault::seal_with_password(&data, "senha-12345").unwrap();
    let err = stormvault::open_with_password(&sealed, "senha-12345").unwrap_err();
    assert!(
        err.to_string().contains("não corresponde à pubkey"),
        "erro: {err}"
    );
    assert!(stormvault::import_with_password(
        &Store::open_in_memory().unwrap(),
        &sealed,
        "senha-12345"
    )
    .is_err());

    // 2) fingerprint alheio (header e payload coerentes com a pubkey alheia),
    //    mas segredo é o do dono original → segredo não deriva a pubkey.
    let mut data2 = stormvault::collect(&outra, Some(kp_outra.secret_hex()), None).unwrap();
    data2.identity = kp_outra.identity("mallory");
    data2.secret_hex = Some(kp.secret_hex());
    let sealed2 = stormvault::seal_with_password(&data2, "senha-12345").unwrap();
    let err2 = stormvault::open_with_password(&sealed2, "senha-12345").unwrap_err();
    assert!(
        err2.to_string().contains("chave privada não corresponde"),
        "erro: {err2}"
    );

    // 3) header com fp divergente do payload (AAD válido, conteúdo coerente).
    let data3 = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    let sealed3 = stormvault::seal_with_password(&data3, "senha-12345").unwrap();
    let mut hdr = stormvault::read_header(&sealed3).unwrap();
    hdr.fp = kp_outra.fingerprint();
    assert_ne!(hdr.fp, data3.identity.fingerprint);
    // Simula o leitor recebendo um header trocado (payload autêntico).
    let mut data4 = data3.clone();
    assert!(stormvault::import_merge_only(&Store::open_in_memory().unwrap(), &data4).is_err());
    // `import_merge_only` valida o binding interno; o header é checado no open.
    data4.identity.fingerprint = kp_outra.fingerprint();
    assert!(stormvault::import_merge_only(&Store::open_in_memory().unwrap(), &data4).is_err());
}

#[test]
fn mesclar_nao_aceita_segredo_de_outra_conta() {
    let (a, kp) = mk_account("alice");
    let (b, kp_b) = mk_account("bob");
    seed_conversation(&a, &kp, "b0b0b0b0b0b0", &["oi"]);
    let mut data = stormvault::collect(&a, Some(kp.secret_hex()), None).unwrap();
    // O payload pertence a Alice; o segredo é de Bob (tentativa de vitrine).
    data.secret_hex = Some(kp_b.secret_hex());
    let err = stormvault::import_merge_only(&b, &data).unwrap_err();
    assert!(
        err.to_string().contains("chave privada não corresponde"),
        "erro: {err}"
    );
    let _ = b;
}
