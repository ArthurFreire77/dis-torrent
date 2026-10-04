//! Teste E2E da camada social (paridade Discord) — 2 nós reais em localhost.
//!
//! Cobre: reações (toggle/idempotência), respostas, edição (só autor),
//! exclusão lógica, fixar, encaminhamento, busca com filtros, cursor de
//! leitura/não-lidas, presença estendida, perfil, threads, ban/timeout,
//! slowmode, enquetes (voto), eventos e emojis.

use std::time::Duration;

use forge_core::identity::Keypair;
use forge_core::protocol::SecureFrame;
use forge_core::social::{EventRow, PollRow, SearchQuery, ThreadRow};
use forge_core::storage::Store;
use std::sync::Arc;
use tempfile::TempDir;

fn fx(_name: &str) -> Keypair {
    Keypair::generate()
}

fn env_for(kp: &Keypair, conv: &str, body: &str) -> forge_core::MessageEnvelope {
    forge_core::MessageEnvelope::new(kp, conv, body)
}

#[test]
fn reacoes_toggle_e_agregacao() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    let b = fx("bob");
    let env = env_for(&a, "dm1", "olá");
    s.insert_message(&env, "out", "delivered").unwrap();

    // toggle: 1ª vez adiciona, 2ª remove
    assert!(s
        .reaction_toggle(&env.id, "dm1", "🔥", &a.fingerprint())
        .unwrap());
    assert!(s
        .reaction_toggle(&env.id, "dm1", "🔥", &b.fingerprint())
        .unwrap());
    assert!(!s
        .reaction_toggle(&env.id, "dm1", "🔥", &b.fingerprint())
        .unwrap());

    let sum = s.reactions_for_msg(&env.id).unwrap();
    assert_eq!(sum.len(), 1);
    assert_eq!(sum[0].count, 1);
    assert_eq!(sum[0].emoji, "🔥");

    // "mine" reflete a identidade de quem pergunta
    let mine = s.mark_reactions_mine(sum, &a.fingerprint());
    assert!(mine[0].mine);
    let not_mine = s.mark_reactions_mine(s.reactions_for_msg(&env.id).unwrap(), "outro");
    assert!(!not_mine[0].mine);
}

#[test]
fn resposta_edicao_exclusao_e_pin() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    let p1 = env_for(&a, "c1", "primeira");
    let p2 = env_for(&a, "c1", "segunda");
    s.insert_message(&p1, "out", "delivered").unwrap();
    s.insert_message(&p2, "out", "delivered").unwrap();

    // resposta
    s.msg_set_reply(&p2.id, "c1", &p1.id).unwrap();
    let meta = s.msg_meta(&p2.id).unwrap().unwrap();
    assert_eq!(meta.reply_to, p1.id);

    // edição
    s.msg_edit(&p2.id, "c1", "segunda (editada)").unwrap();
    assert_eq!(
        s.effective_body(&p2.id, "segunda").unwrap(),
        "segunda (editada)"
    );
    assert!(s.msg_meta(&p2.id).unwrap().unwrap().edited_at > 0);

    // pin
    s.msg_pin(&p1.id, "c1", true, &a.fingerprint()).unwrap();
    let pins = s.pins_list("c1").unwrap();
    assert_eq!(pins.len(), 1);
    assert_eq!(pins[0].msg_id, p1.id);

    // exclusão lógica: some da busca mas o registro continua
    s.msg_delete(&p2.id, "c1").unwrap();
    assert!(s.msg_meta(&p2.id).unwrap().unwrap().deleted);
    let hits = s
        .message_search(&SearchQuery {
            text: "editada".into(),
            ..Default::default()
        })
        .unwrap();
    assert!(
        hits.is_empty(),
        "mensagem apagada não pode aparecer na busca"
    );
}

#[test]
fn busca_com_filtros_estilo_discord() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    let b = fx("bob");
    for body in [
        "olá mundo",
        "segunda com link https://exemplo.dev",
        "terceira @alguem",
        "quarta",
    ] {
        let e = env_for(&a, "c1", body);
        s.insert_message(&e, "out", "delivered").unwrap();
    }
    let mine = env_for(&b, "c1", "resposta do bob");
    s.insert_message(&mine, "in", "ok").unwrap();

    let all = s
        .message_search(&SearchQuery {
            text: String::new(),
            limit: 50,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(all.len(), 5);

    let links = s
        .message_search(&SearchQuery {
            text: String::new(),
            has: "link".into(),
            limit: 50,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(links.len(), 1);
    assert!(links[0].body.contains("https://"));

    let mentions = s
        .message_search(&SearchQuery {
            text: String::new(),
            has: "mention".into(),
            limit: 50,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(mentions.len(), 1);

    let by_author = s
        .message_search(&SearchQuery {
            text: String::new(),
            from: b.fingerprint(),
            limit: 50,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(by_author.len(), 1);
    assert_eq!(by_author[0].author_fp, b.fingerprint());

    let text = s
        .message_search(&SearchQuery {
            text: "terceira".into(),
            limit: 50,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(text.len(), 1);
    assert!(text[0].body.contains("terceira"));
}

#[test]
fn cursor_de_leitura_gera_nao_lidas() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    for i in 0..5 {
        let e = env_for(&a, "c1", &format!("msg {i}"));
        s.insert_message(&e, "in", "ok").unwrap();
    }
    // cursor capturado DEPOIS das mensagens = tudo lido
    let now = forge_core::identity::now_ms();
    assert_eq!(s.unread_count("c1").unwrap(), 5);
    s.read_set("c1", now).unwrap();
    assert_eq!(s.unread_count("c1").unwrap(), 0);
    // cursor nunca retrocede
    s.read_set("c1", now - 10_000).unwrap();
    assert_eq!(s.read_cursor("c1").unwrap(), now);
    assert_eq!(s.read_all().unwrap().len(), 1);
}

#[test]
fn presenca_extendida_e_perfil() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    s.presence_set(&a.fingerprint(), "dnd", "programando", "🦀")
        .unwrap();
    let p = s.presence_get(&a.fingerprint()).unwrap();
    assert_eq!(p.status, "dnd");
    assert_eq!(p.custom, "programando");
    assert_eq!(p.custom_emoji, "🦀");

    s.presence_offline(&a.fingerprint()).unwrap();
    assert_eq!(s.presence_get(&a.fingerprint()).unwrap().status, "offline");

    s.profile_set(&a.fingerprint(), "Alice B", "bio", "", "", "#ff0000")
        .unwrap();
    let prof = s.profile_get(&a.fingerprint()).unwrap();
    assert_eq!(prof.display_name, "Alice B");
    assert_eq!(prof.accent, "#ff0000");
    // avatar vazio NÃO apaga o anterior
    s.profile_set(&a.fingerprint(), "Alice", "", "AVATAR_B64", "", "")
        .unwrap();
    s.profile_set(&a.fingerprint(), "Alice2", "", "", "", "")
        .unwrap();
    assert_eq!(
        s.profile_get(&a.fingerprint()).unwrap().avatar_b64,
        "AVATAR_B64"
    );
}

#[test]
fn threads_criacao_e_mensagem() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    let t = ThreadRow {
        id: "th1".into(),
        community_id: "com1".into(),
        parent_channel: "ch1".into(),
        name: "sobre rust".into(),
        author_fp: a.fingerprint(),
        created_at: forge_core::identity::now_ms(),
        archived: false,
        kind: "thread".into(),
        tags: String::new(),
    };
    s.thread_upsert(&t).unwrap();
    assert_eq!(s.threads_list("com1", "ch1").unwrap().len(), 1);
    assert_eq!(s.thread_get("th1").unwrap().unwrap().name, "sobre rust");

    let env = env_for(&a, "th1", "opinião sobre X");
    s.insert_message_in_thread(&env, "th1", "out", "delivered")
        .unwrap();
    let msgs = s.list_messages_thread("th1", 50).unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].thread_id, "th1");

    s.thread_archive("th1", true).unwrap();
    assert!(s.thread_get("th1").unwrap().unwrap().archived);
}

#[test]
fn ban_temporario_expira_e_timeout_limpa() {
    let s = Store::open_in_memory().unwrap();
    let now = forge_core::identity::now_ms();
    // ban temporário já expirado →Some(none)
    s.ban_set("com1", "spam", "spam", "dono", now - 1000)
        .unwrap();
    assert!(s.ban_get("com1", "spam").unwrap().is_none());
    // ban permanente
    s.ban_set("com1", "mal", "malware", "dono", 0).unwrap();
    assert!(s.ban_get("com1", "mal").unwrap().is_some());
    assert_eq!(s.ban_list("com1").unwrap().len(), 1);
    s.ban_remove("com1", "mal").unwrap();
    assert!(s.ban_get("com1", "mal").unwrap().is_none());

    // timeout ativo e depois expirado
    s.timeout_set("com1", "ruim", now + 60_000, "fala demais", "mod")
        .unwrap();
    assert!(s.timeout_active("com1", "ruim").unwrap() > 0);
    s.timeout_set("com1", "ruim", now - 1, "", "mod").unwrap();
    assert_eq!(s.timeout_active("com1", "ruim").unwrap(), 0);
    assert_eq!(s.timeout_list("com1").unwrap().len(), 0);
}

#[test]
fn slowmode_bloqueia_segunda_mensagem() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    s.channel_cfg_set("ch1", 30, false, false).unwrap();
    assert_eq!(s.channel_cfg_slowmode("ch1").unwrap(), 30);
    // 1ª liberada
    assert_eq!(s.slowmode_gate("ch1", &a.fingerprint(), 30).unwrap(), 0);
    // 2ª bloqueada com espera real
    let wait = s.slowmode_gate("ch1", &a.fingerprint(), 30).unwrap();
    assert!(
        wait > 0 && wait <= 30_000,
        "slowmode deve devolver espera: {wait}"
    );
    // outro fingerprint não é afetado
    assert_eq!(s.slowmode_gate("ch1", "outro-fp", 30).unwrap(), 0);
}

#[test]
fn enquete_votos_e_apuracao() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    let p = PollRow {
        id: "pl1".into(),
        community_id: "com1".into(),
        channel_id: "ch1".into(),
        question: "Rust ou Go?".into(),
        options: vec!["Rust".into(), "Go".into()],
        multi: false,
        author_fp: a.fingerprint(),
        created_at: forge_core::identity::now_ms(),
        ends_at: 0,
        closed: false,
    };
    s.poll_upsert(&p).unwrap();
    assert_eq!(s.poll_list("com1", "ch1").unwrap().len(), 1);
    s.poll_vote("pl1", &a.fingerprint(), 0).unwrap();
    s.poll_vote("pl1", "bob", 0).unwrap();
    s.poll_vote("pl1", "carla", 1).unwrap();
    let (counts, total) = s.poll_tally("pl1").unwrap();
    assert_eq!(counts, vec![2, 1]);
    assert_eq!(total, 3);
    assert_eq!(s.poll_my_votes("pl1", &a.fingerprint()).unwrap(), vec![0]);
    // voto simples substitui o anterior
    s.poll_vote("pl1", "bob", 1).unwrap();
    let (counts, total) = s.poll_tally("pl1").unwrap();
    assert_eq!(counts, vec![1, 2]);
    assert_eq!(total, 3);
}

#[test]
fn eventos_agendados_e_interesse() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    let now = forge_core::identity::now_ms();
    let mut e = EventRow {
        id: "ev1".into(),
        community_id: "com1".into(),
        name: "Release party".into(),
        description: "v7".into(),
        location: "canal de voz".into(),
        starts_at: now + 3600_000,
        ends_at: now + 7200_000,
        channel_id: "ch1".into(),
        entity_fp: a.fingerprint(),
        status: "scheduled".into(),
        interested: vec![],
    };
    s.event_upsert(&e).unwrap();
    s.event_interest("com1", "ev1", "bob").unwrap();
    e = s.event_list("com1").unwrap().pop().unwrap();
    assert_eq!(e.interested, vec!["bob".to_string()]);
    // toggla
    s.event_interest("com1", "ev1", "bob").unwrap();
    e = s.event_list("com1").unwrap().pop().unwrap();
    assert!(e.interested.is_empty());
    s.event_delete("com1", "ev1").unwrap();
    assert!(s.event_list("com1").unwrap().is_empty());
}

#[test]
fn emojis_do_servidor() {
    let s = Store::open_in_memory().unwrap();
    let e = forge_core::social::EmojiRow {
        id: "em1".into(),
        community_id: "com1".into(),
        name: "forge".into(),
        char: "🦀".into(),
        created_at: forge_core::identity::now_ms(),
    };
    s.emoji_upsert(&e).unwrap();
    assert_eq!(s.emoji_list("com1").unwrap().len(), 1);
    s.emoji_delete("com1", "em1").unwrap();
    assert!(s.emoji_list("com1").unwrap().is_empty());
}

#[test]
fn marcadores_e_purga_de_conversa() {
    let s = Store::open_in_memory().unwrap();
    let a = fx("alice");
    let env = env_for(&a, "c1", "para marcar");
    s.insert_message(&env, "out", "delivered").unwrap();
    s.reaction_toggle(&env.id, "c1", "👍", &a.fingerprint())
        .unwrap();
    s.msg_pin(&env.id, "c1", true, &a.fingerprint()).unwrap();
    s.read_set("c1", 1).unwrap();
    s.bookmark_set("c1", "importante", &env.id).unwrap();
    assert_eq!(s.bookmark_list("c1").unwrap().len(), 1);

    s.purge_conv("c1").unwrap();
    assert!(s.reactions_for_msg(&env.id).unwrap().is_empty());
    assert!(s.pins_list("c1").unwrap().is_empty());
    assert!(s.bookmark_list("c1").unwrap().is_empty());
    assert_eq!(s.read_cursor("c1").unwrap(), 0);
}

#[test]
fn frames_sociais_resserializam() {
    // round-trip do enum: variantes novas precisam sobreviver ao serde
    let cases = vec![
        SecureFrame::React {
            conv_id: "c".into(),
            msg_id: "m".into(),
            emoji: "🔥".into(),
            add: true,
            reactor_fp: "f".into(),
        },
        SecureFrame::MsgEdit {
            conv_id: "c".into(),
            msg_id: "m".into(),
            body: "novo".into(),
        },
        SecureFrame::MsgDelete {
            conv_id: "c".into(),
            msg_id: "m".into(),
        },
        SecureFrame::MsgPin {
            conv_id: "c".into(),
            msg_id: "m".into(),
            pinned: true,
        },
        SecureFrame::PresenceSet {
            status: "dnd".into(),
            custom: "x".into(),
            custom_emoji: "🦀".into(),
        },
        SecureFrame::PresencePing,
        SecureFrame::ThreadCreate {
            community_id: "c".into(),
            thread_id: "t".into(),
            parent_channel: "p".into(),
            name: "n".into(),
            kind: "thread".into(),
            tags: String::new(),
        },
        SecureFrame::MemberBan {
            community_id: "c".into(),
            target_fp: "t".into(),
            until_ms: 0,
            reason: "r".into(),
        },
        SecureFrame::MemberTimeout {
            community_id: "c".into(),
            target_fp: "t".into(),
            until_ms: 10,
            reason: String::new(),
        },
        SecureFrame::ChannelCfg {
            community_id: "c".into(),
            channel_id: "ch".into(),
            slowmode_secs: 5,
            nsfw: false,
        },
        SecureFrame::EventInterest {
            community_id: "c".into(),
            event_id: "e".into(),
        },
    ];
    for f in cases {
        let json = serde_json::to_string(&f).unwrap();
        let back: SecureFrame = serde_json::from_str(&json).unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), json);
    }
}

fn spawn_engine(nick: &str) -> (Arc<forge_core::net::engine::NetworkEngine>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = Keypair::generate();
    let engine = forge_core::net::engine::NetworkEngine::new(
        store,
        kp,
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(Duration::from_millis(150));
    (engine, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn rede_social_reacoes_entre_dois_nos() {
    use forge_core::net::engine::EngineEvent;
    let (a, _da) = spawn_engine("Alice");
    let (b, _db) = spawn_engine("Bob");
    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(b.identity().fingerprint.clone()));

    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    async fn wait_online(rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>, who: &str) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(!left.is_zero(), "{who}: timeout esperando PeerOnline");
            match tokio::time::timeout(left, rx.recv()).await {
                Ok(Ok(EngineEvent::PeerOnline { .. })) => return,
                Ok(Ok(_)) => continue,
                Ok(Err(_)) => continue,
                Err(_) => panic!("{who}: timeout esperando PeerOnline"),
            }
        }
    }
    wait_online(&mut ev_a, "A").await;
    wait_online(&mut ev_b, "B").await;

    // amizade aceita nos DOIS lados (DM só de amigo)
    let fp_a = a.identity().fingerprint.clone();
    let fp_b = b.identity().fingerprint.clone();
    a.friend_request(&fp_b).unwrap();
    b.friend_respond(&fp_a, true).unwrap();
    b.friend_request(&fp_a).unwrap();
    a.friend_respond(&fp_b, true).unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let conv = Store::dm_conversation_id(&fp_a, &fp_b);
    a.store.ensure_dm_conversation(&fp_a, &fp_b, "Bob").unwrap();
    let m = a.send_dm(&conv, "oi bob").unwrap();
    assert_ne!(
        m.status, "pending",
        "DM ficou na outbox — sessão não Established"
    );

    a.social_react(&conv, &m.id, "\u{1f525}").unwrap();
    a.announce_presence();

    let mut got_react = false;
    let mut got_pres = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    while !(got_react && got_pres) {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!left.is_zero(), "react={got_react} pres={got_pres}");
        match tokio::time::timeout(left, ev_b.recv()).await {
            Ok(Ok(EngineEvent::ReactionChanged {
                emoji,
                add,
                reactor_fp,
                ..
            })) => {
                if emoji == "\u{1f525}" && add && reactor_fp == fp_a {
                    got_react = true;
                }
            }
            Ok(Ok(EngineEvent::PresenceChanged { status, .. })) => {
                if status == "online" || status == "idle" || status == "dnd" {
                    got_pres = true;
                }
            }
            Ok(Ok(_)) => continue,
            Ok(Err(_)) => continue,
            Err(_) => panic!("timeout na camada social"),
        }
    }
    let rx = b.store.reactions_for_msg(&m.id).unwrap();
    assert!(!rx.is_empty(), "reação não foi persistida em B");
    assert_eq!(b.store.presence_get(&fp_a).unwrap().status, "online");
}
