//! Testes de servidor (v4): canais completos, cargos, bots, sync P2P do
//! estado da comunidade e mensagens de grupo — tudo sobre SQLite real.

use std::sync::Arc;

use forge_core::net::engine::NetworkEngine;
use forge_core::protocol::{MessageEnvelope, SecureFrame};
use forge_core::storage::{BotPatch, ChannelMetaRow, RoleRow, Store};
use tempfile::TempDir;

/// Engine SEM start(): os métodos de servidor tocam apenas store e canais
/// internos — nada de sockets, testes ficam determinísticos.
fn engine_for(nick: &str) -> (Arc<NetworkEngine>, forge_core::identity::Keypair, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(
        store,
        kp.clone(),
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    (engine, kp, dir)
}

#[test]
fn channel_create_exige_dono_e_comunidade_existente() {
    let (a, _ka, _da) = engine_for("Alice");
    let cid = a.create_community("Servidor da Alice", &[]).unwrap();

    // comunidade inexistente → erro real
    assert!(a
        .channel_create("nao-existe-000", "geral", "", "", "text")
        .is_err());

    // dono cria: nome normalizado, id prefixado, kind válido
    let ch = a
        .channel_create(&cid, "Meu Canal", "tópico legal", "", "text")
        .unwrap();
    assert_eq!(ch.name, "meu-canal");
    assert_eq!(ch.topic, "tópico legal");
    assert_eq!(ch.kind, "text");
    assert!(ch.id.starts_with(&format!("{cid}-ch-")));

    // kind fora de text|voice → erro
    assert!(a.channel_create(&cid, "x", "", "", "video").is_err());

    // membro NÃO dono (estado sincronizado no store dele) não altera servidor
    let dir_b = tempfile::tempdir().unwrap();
    let store_b = Arc::new(Store::open(&dir_b.path().join("forge.db")).unwrap());
    if let SecureFrame::CommunityState {
        community_id,
        name,
        owner_fp,
        channels,
        roles,
        bots,
        member_roles,
        members,
        description,
        category,
        icon,
    } = a.community_state_payload(&cid, None).unwrap()
    {
        store_b
            .community_full_sync(
                &community_id,
                &name,
                &owner_fp,
                &channels,
                &roles,
                &bots,
                &member_roles,
                &members,
                &(description, category, icon),
            )
            .unwrap();
    } else {
        unreachable!()
    }
    let b = NetworkEngine::new(
        store_b,
        forge_core::identity::Keypair::generate(),
        "Bob".into(),
        dir_b.path().to_path_buf(),
    );
    assert!(b.channel_create(&cid, "invasão", "", "", "text").is_err());
}

#[test]
fn channel_crud_reflete_em_channel_list() {
    let (a, _ka, _da) = engine_for("Alice");
    let cid = a.create_community("Serv", &[]).unwrap();

    let c1 = a
        .channel_create(&cid, "Anúncios", "avisos", "INFORMAÇÕES", "text")
        .unwrap();
    let c2 = a
        .channel_create(&cid, "Lounge", "", "CANAIS DE VOZ", "voice")
        .unwrap();

    let list = a.channel_list(&cid).unwrap();
    assert_eq!(list.len(), 3, "geral + 2 novos");
    assert_eq!(list[1].id, c1.id);
    assert_eq!(list[2].id, c2.id);
    assert_eq!(list[2].kind, "voice");

    a.channel_rename(&cid, &c1.id, "Avisos Gerais").unwrap();
    a.channel_set_topic(&cid, &c1.id, "novo tópico").unwrap();
    a.channel_set_category(&cid, &c1.id, "SUPORTE").unwrap();

    let c1b = a
        .channel_list(&cid)
        .unwrap()
        .into_iter()
        .find(|c| c.id == c1.id)
        .unwrap();
    assert_eq!(c1b.name, "avisos-gerais");
    assert_eq!(c1b.topic, "novo tópico");
    assert_eq!(c1b.category, "SUPORTE");

    a.channel_delete(&cid, &c2.id).unwrap();
    assert!(a.channel_list(&cid).unwrap().iter().all(|c| c.id != c2.id));
    // apagar canal que já foi embora → erro
    assert!(a.channel_delete(&cid, &c2.id).is_err());
}

#[test]
fn roles_crud_e_assignments() {
    let (a, ka, _da) = engine_for("Alice");
    let cid = a.create_community("Serv", &[]).unwrap();
    let me = ka.fingerprint();

    let role = a
        .role_create(&cid, "Mod", "#eb459e", 96, true, false)
        .unwrap();
    assert!(role.id.starts_with(&format!("{cid}-role-")));
    assert_eq!(role.position, 0);
    let role2 = a
        .role_create(&cid, "Admin", "#ed4245", 8, false, false)
        .unwrap();
    assert_eq!(role2.position, 1);

    // patch parcial
    a.role_update(
        &cid,
        &role.id,
        Some("Moderador"),
        None,
        Some(31),
        None,
        Some(true),
        None,
    )
    .unwrap();
    let r = a
        .roles_list(&cid)
        .unwrap()
        .into_iter()
        .find(|r| r.id == role.id)
        .unwrap();
    assert_eq!(r.name, "Moderador");
    assert_eq!(r.permissions, 31);
    assert!(r.mentionable);
    assert!(r.hoist, "hoist não mexido continua true");

    // assign/unassign (dono é membro da comunidade)
    a.member_assign_role(&cid, &me, &role.id).unwrap();
    assert_eq!(a.member_roles(&cid, &me).unwrap(), vec![role.id.clone()]);
    a.member_unassign_role(&cid, &me, &role.id).unwrap();
    assert!(a.member_roles(&cid, &me).unwrap().is_empty());

    // cargo inexistente / membro inexistente → erro
    assert!(a.member_assign_role(&cid, &me, "cargo-falso").is_err());
    assert!(a
        .member_assign_role(&cid, "ffffffffffff", &role.id)
        .is_err());

    // role_delete limpa assignments e desvincula bots
    a.member_assign_role(&cid, &me, &role.id).unwrap();
    let bot = a.bot_create(&cid, "Robô", None, Some(&role.id)).unwrap();
    assert_eq!(bot.role_id.as_deref(), Some(role.id.as_str()));

    a.role_delete(&cid, &role.id).unwrap();
    assert!(
        a.member_roles(&cid, &me).unwrap().is_empty(),
        "assignments sumiram com o cargo"
    );
    assert!(a.roles_list(&cid).unwrap().iter().all(|r| r.id != role.id));
    let bot = a
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .unwrap();
    assert!(bot.role_id.is_none(), "bot ficou sem cargo");

    // @everyone é intocável
    assert!(a.role_delete(&cid, &format!("{cid}-everyone")).is_err());
}

#[test]
fn bots_crud() {
    let (a, _ka, _da) = engine_for("Alice");
    let cid = a.create_community("Serv", &[]).unwrap();
    let role = a
        .role_create(&cid, "BotRole", "#5865f2", 96, false, false)
        .unwrap();

    let bot = a
        .bot_create(&cid, "Música", Some("🎵"), Some(&role.id))
        .unwrap();
    assert!(bot.id.starts_with(&format!("{cid}-bot-")));
    assert_eq!(bot.discriminator.len(), 4);
    assert!(bot.token.starts_with("bot_"));
    assert!(bot.online);
    assert_eq!(bot.owner_fp, a.identity().fingerprint);
    assert_eq!(bot.role_id.as_deref(), Some(role.id.as_str()));

    // update: renomeia + limpa cargo com "" + offline
    a.bot_update(
        &cid,
        &bot.id,
        BotPatch {
            name: Some("DJ".into()),
            role_id: Some(Some("".into())),
            online: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    let b = a
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .unwrap();
    assert_eq!(b.name, "DJ");
    assert!(b.role_id.is_none(), "string vazia limpa o cargo");
    assert!(!b.online);

    // cargo volta via Some(Some)
    a.bot_update(
        &cid,
        &bot.id,
        BotPatch {
            role_id: Some(Some(role.id.clone())),
            ..Default::default()
        },
    )
    .unwrap();
    let b = a
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .unwrap();
    assert_eq!(b.role_id.as_deref(), Some(role.id.as_str()));

    // cargo inexistente no create → erro
    assert!(a.bot_create(&cid, "X", None, Some("cargo-falso")).is_err());

    a.bot_delete(&cid, &bot.id).unwrap();
    assert!(a.bots_list(&cid).unwrap().iter().all(|b| b.id != bot.id));
    assert!(a.bot_delete(&cid, &bot.id).is_err());
}

#[test]
fn community_full_sync_replica_estado_do_host() {
    let (a, ka, _da) = engine_for("Alice");
    let cid = a
        .create_community("Origem", &["Geral".to_string(), "Projetos".to_string()])
        .unwrap();
    let role = a
        .role_create(&cid, "Mod", "#eb459e", 96, true, false)
        .unwrap();
    let _bot = a.bot_create(&cid, "Keeper", None, None).unwrap();
    let me = ka.fingerprint();
    a.member_assign_role(&cid, &me, &role.id).unwrap();

    // store do membro aplica o estado do host
    let dir_b = tempfile::tempdir().unwrap();
    let store_b = Arc::new(Store::open(&dir_b.path().join("forge.db")).unwrap());
    let apply = |store_b: &Store| {
        if let SecureFrame::CommunityState {
            community_id,
            name,
            owner_fp,
            channels,
            roles,
            bots,
            member_roles,
            members,
            description,
            category,
            icon,
        } = a.community_state_payload(&cid, None).unwrap()
        {
            store_b
                .community_full_sync(
                    &community_id,
                    &name,
                    &owner_fp,
                    &channels,
                    &roles,
                    &bots,
                    &member_roles,
                    &members,
                    &(description, category, icon),
                )
                .unwrap();
        } else {
            unreachable!()
        }
    };
    apply(&store_b);

    // canais, cargos, bots e assignments batem com o host
    assert_eq!(
        store_b.channel_rows(&cid).unwrap(),
        a.channel_list(&cid).unwrap()
    );
    assert_eq!(
        store_b.roles_list(&cid).unwrap(),
        a.roles_list(&cid).unwrap()
    );
    assert_eq!(store_b.bots_list(&cid).unwrap(), a.bots_list(&cid).unwrap());
    assert_eq!(
        store_b.member_roles_list(&cid, &me).unwrap(),
        vec![role.id.clone()]
    );
    let (_, _, owner_fp) = store_b.get_community(&cid).unwrap().unwrap();
    assert_eq!(owner_fp, a.identity().fingerprint);
    let member_fps: Vec<String> = store_b
        .list_members(&cid)
        .unwrap()
        .into_iter()
        .map(|(fp, _, _)| fp)
        .collect();
    assert!(member_fps.contains(&me));

    // host remove o primeiro canal e cria outro; membro re-sincroniza
    let removed = a.channel_list(&cid).unwrap().first().unwrap().id.clone();
    a.channel_delete(&cid, &removed).unwrap();
    a.channel_create(&cid, "Novo Canal", "", "", "text")
        .unwrap();
    apply(&store_b);

    let names: Vec<String> = store_b
        .channel_rows(&cid)
        .unwrap()
        .into_iter()
        .map(|c| c.name)
        .collect();
    assert!(names.contains(&"novo-canal".to_string()));
    assert!(
        !names.iter().any(|n| n == &"geral".to_string()),
        "canal removido no host desaparece no membro"
    );
    assert_eq!(
        store_b.channel_rows(&cid).unwrap().len(),
        a.channel_list(&cid).unwrap().len()
    );
}

#[test]
fn send_dm_em_grupo_fica_pendente_sem_erro() {
    let (a, _ka, _da) = engine_for("Alice");
    let kp_b = forge_core::identity::Keypair::generate();
    let fp_b = kp_b.identity("Bob").fingerprint;

    // registra B como contato local (sem conexão) para o create_group aceitar
    a.friend_request(&fp_b).unwrap();

    let conv = a.create_group("Equipe", vec![fp_b]).unwrap();
    assert_eq!(conv.kind, "group");

    // sem peer online: PENDING — e NUNCA o erro "apenas DM nesta fase"
    let m = a.send_dm(&conv.id, "oi grupo").unwrap();
    assert_eq!(m.status, "pending");
    assert_eq!(m.direction, "out");
}

#[test]
fn pending_group_messages_e_revert_no_store() {
    let store = Store::open_in_memory().unwrap();
    let kp = forge_core::identity::Keypair::generate();
    let me = kp.fingerprint();

    let conv = store
        .create_group_dm(&me, &["b00000000000".into()], "grupo")
        .unwrap();
    let dm = store
        .ensure_dm_conversation(&me, "c00000000000", "dm")
        .unwrap();

    let env_dm = MessageEnvelope::new(&kp, &dm.id, "msg de dm");
    store.insert_message(&env_dm, "out", "pending").unwrap();
    let env_g = MessageEnvelope::new(&kp, &conv.id, "msg de grupo");
    store.insert_message(&env_g, "out", "pending").unwrap();

    // flush de grupo só enxerga mensagens de conversas group
    let pend = store.pending_group_messages().unwrap();
    assert_eq!(pend.len(), 1);
    assert_eq!(pend[0].id, env_g.id);

    store.set_message_status(&env_g.id, "sent").unwrap();
    assert!(store.pending_group_messages().unwrap().is_empty());

    // queda de link: grupos em sending/sent voltam a PENDING (DM não mexe)
    let ids = store.revert_unacked_groups_to_pending().unwrap();
    assert_eq!(ids, vec![env_g.id.clone()]);
    assert_eq!(
        store.message_by_id(&env_g.id).unwrap().unwrap().status,
        "pending"
    );
    assert!(store.pending_group_messages().unwrap().len() == 1);
}

#[test]
fn community_state_frame_serializa_com_campos_novos() {
    let frame = SecureFrame::CommunityState {
        community_id: "cid".into(),
        name: "Serv".into(),
        owner_fp: "host00000000".into(),
        channels: vec![ChannelMetaRow {
            id: "cid-ch-1".into(),
            name: "geral".into(),
            topic: "t".into(),
            category: "CANAIS DE TEXTO".into(),
            kind: "text".into(),
            position: 0,
        }],
        roles: vec![RoleRow {
            id: "cid-role-1".into(),
            community_id: "cid".into(),
            name: "Mod".into(),
            color: "#eb459e".into(),
            permissions: 96,
            hoist: true,
            mentionable: false,
            position: 0,
        }],
        bots: vec![],
        member_roles: vec![("fp0000000001".into(), vec!["cid-role-1".into()])],
        members: vec![("host00000000".into(), "Host".into(), "owner".into())],
        description: "servidor de teste".into(),
        category: "jogos".into(),
        icon: "game".into(),
    };
    let json = serde_json::to_string(&frame).unwrap();
    let back: SecureFrame = serde_json::from_str(&json).unwrap();
    match back {
        SecureFrame::CommunityState {
            channels,
            roles,
            bots,
            member_roles,
            ..
        } => {
            assert_eq!(channels.len(), 1);
            assert_eq!(roles.len(), 1);
            assert!(bots.is_empty());
            assert_eq!(member_roles.len(), 1);
        }
        _ => unreachable!(),
    }

    // frame de host LEGADO (sem campos novos) carrega com defaults — compat
    let legacy = r#"{"CommunityState":{"community_id":"cid","name":"S","owner_fp":"h","channels":[],"members":[]}}"#;
    let back: SecureFrame = serde_json::from_str(legacy).unwrap();
    match back {
        SecureFrame::CommunityState {
            roles,
            bots,
            member_roles,
            ..
        } => {
            assert!(roles.is_empty());
            assert!(bots.is_empty());
            assert!(member_roles.is_empty());
        }
        _ => unreachable!(),
    }
}
