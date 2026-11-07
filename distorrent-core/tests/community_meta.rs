use std::sync::Arc;

use distorrent_core::net::engine::{
    CommunityChannelSeed, CommunityCreateOptions, CommunityRoleSeed, NetworkEngine,
};
use distorrent_core::protocol::SecureFrame;
use distorrent_core::storage::Store;
use tempfile::TempDir;

fn engine_for(
    nick: &str,
) -> (
    Arc<NetworkEngine>,
    distorrent_core::identity::Keypair,
    Arc<Store>,
    TempDir,
) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = distorrent_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(
        store.clone(),
        kp.clone(),
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    (engine, kp, store, dir)
}

fn wizard_opts() -> CommunityCreateOptions {
    CommunityCreateOptions {
        description: "servidor de testes do wizard".into(),
        category: "games".into(),
        icon: "🎮".into(),
        rules_text: "seja gentil; sem spam".into(),
        channels_meta: vec![
            CommunityChannelSeed {
                name: "Geral".into(),
                kind: "text".into(),
                category: String::new(),
            },
            CommunityChannelSeed {
                name: "Sala de voz".into(),
                kind: "voice".into(),
                category: String::new(),
            },
            CommunityChannelSeed {
                name: "Cinema".into(),
                kind: "video".into(),
                category: String::new(),
            },
        ],
        roles: vec![
            CommunityRoleSeed {
                name: "Admin".into(),
                color: "#f23f42".into(),
                permissions: 0x3FF,
                hoist: true,
                mentionable: true,
            },
            CommunityRoleSeed {
                name: "Membro".into(),
                color: "#57f287".into(),
                permissions: 96,
                hoist: false,
                mentionable: true,
            },
        ],
        is_public: false,
    }
}

#[test]
fn wizard_cria_comunidade_com_canais_tipos_cargos_e_meta() {
    let (a, _ka, st, _da) = engine_for("Alice");
    let cid = a
        .create_community_with_options("Guilda", &[], &wizard_opts())
        .unwrap();

    let chans = a.channel_list(&cid).unwrap();
    assert_eq!(chans.len(), 3);
    let by_name: std::collections::HashMap<&str, &distorrent_core::storage::ChannelMetaRow> =
        chans.iter().map(|c| (c.name.as_str(), c)).collect();
    assert_eq!(by_name["geral"].kind, "text");
    assert_eq!(by_name["geral"].category, "CANAIS DE TEXTO");
    assert_eq!(by_name["sala-de-voz"].kind, "voice");
    assert_eq!(by_name["sala-de-voz"].category, "CANAIS DE VOZ");
    assert_eq!(by_name["cinema"].kind, "video");
    assert_eq!(by_name["cinema"].category, "CANAIS DE VÍDEO");

    let roles = a.roles_list(&cid).unwrap();
    assert_eq!(roles.len(), 2);
    let admin = roles.iter().find(|r| r.name == "Admin").unwrap();
    assert_eq!(admin.permissions, 0x3FF);
    assert!(admin.hoist);

    let (desc, cat, icon) = a.community_meta(&cid).unwrap();
    assert_eq!(desc, "servidor de testes do wizard");
    assert_eq!(cat, "games");
    assert_eq!(icon, "🎮");

    let rules = st.kv_get(&format!("rules:text:{cid}")).unwrap();
    assert!(rules.contains("sem spam"));
}

#[test]
fn wizard_rejeita_canal_com_tipo_invalido_e_legado_continua_funcionando() {
    let (a, _ka, _st, _da) = engine_for("Alice");

    let mut bad = wizard_opts();
    bad.channels_meta = vec![CommunityChannelSeed {
        name: "x".into(),
        kind: "holograma".into(),
        category: String::new(),
    }];
    assert!(a
        .create_community_with_options("Bugada", &[], &bad)
        .is_err());

    let cid = a
        .create_community("Legado", &["geral".to_string(), "bate-papo".to_string()])
        .unwrap();
    let chans = a.channel_list(&cid).unwrap();
    assert_eq!(chans.len(), 2);
    assert_eq!(chans[0].kind, "text");
}

#[test]
fn community_set_meta_atualiza_e_valida_tamanho() {
    let (a, _ka, _st, _da) = engine_for("Alice");
    let cid = a
        .create_community_with_options("Servidor", &[], &wizard_opts())
        .unwrap();

    a.community_set_meta(&cid, Some("nova descrição"), None, Some("🚀"))
        .unwrap();
    let (desc, cat, icon) = a.community_meta(&cid).unwrap();
    assert_eq!(desc, "nova descrição");
    assert_eq!(cat, "games");
    assert_eq!(icon, "🚀");

    assert!(a
        .community_set_meta(&cid, None, None, Some("emoji-com-muitos-chars"))
        .is_err());
}

#[test]
fn bot_post_message_assina_como_host_e_marca_bot_id() {
    let (a, ka, st, _da) = engine_for("Alice");
    let cid = a
        .create_community_with_options("ComBot", &[], &wizard_opts())
        .unwrap();
    let bot = a.bot_create(&cid, "ClimeBot", Some("🧠"), None).unwrap();

    let canal = a
        .channel_list(&cid)
        .unwrap()
        .iter()
        .find(|c| c.kind == "text")
        .unwrap()
        .id
        .clone();

    let m = a
        .bot_post_message(&cid, &canal, &bot.id, "25°C em São Paulo")
        .unwrap();
    assert_eq!(m.bot_id, bot.id);
    assert_eq!(m.author_fp, ka.identity("Alice").fingerprint);
    assert_eq!(m.body, "25°C em São Paulo");
    assert_eq!(m.status, "sent");

    let store_m = st.message_by_id(&m.id).ok().flatten();
    assert!(store_m.is_some());
    assert_eq!(store_m.unwrap().bot_id, bot.id);

    let hum = a.send_channel_message(&cid, &canal, "oi gente").unwrap();
    assert_eq!(hum.bot_id, "");

    assert!(a
        .bot_post_message(&cid, &canal, "bot-fantasma", "x")
        .is_err());
    assert!(a
        .bot_post_message(&cid, "canal-fantasma", &bot.id, "x")
        .is_err());
}

#[test]
fn bot_regen_token_invalida_o_antigo() {
    let (a, _ka, _st, _da) = engine_for("Alice");
    let cid = a.create_community("Serv", &[]).unwrap();
    let bot = a.bot_create(&cid, "Bot", None, None).unwrap();
    let old = bot.token.clone();
    let new = a.bot_regen_token(&cid, &bot.id).unwrap();
    assert_ne!(old, new);
    assert!(new.starts_with("bot_"));
    assert!(a.bots_list(&cid).unwrap().iter().any(|b| b.token == new));
}

#[test]
fn community_state_payload_mascara_token_para_nao_dono() {
    let (a, _ka, st, _da) = engine_for("Alice");
    let cid = a.create_community("Secreto", &[]).unwrap();
    let bot = a.bot_create(&cid, "Bot", None, None).unwrap();
    let me_fp = st.get_community(&cid).unwrap().unwrap().2;

    let for_owner = a.community_state_payload(&cid, Some(&me_fp)).unwrap();
    match &for_owner {
        SecureFrame::CommunityState { bots, .. } => {
            assert_eq!(bots[0].token, bot.token);
        }
        _ => panic!("esperava CommunityState"),
    }

    let for_member = a
        .community_state_payload(&cid, Some("aaaaaaaaaaaa"))
        .unwrap();
    match &for_member {
        SecureFrame::CommunityState {
            bots,
            description,
            icon,
            ..
        } => {
            assert_eq!(bots[0].token, "");
            assert_eq!(description, "");
            let _ = icon;
        }
        _ => panic!("esperava CommunityState"),
    }
}

#[test]
fn call_add_participant_valida_e_registra() {
    let (a, _ka, _st, _da) = engine_for("Alice");
    let call_id = a.call_invite("bbbbbbbbbbbb", "voice").unwrap();

    a.call_add_participant("bbbbbbbbbbbb", &call_id, "cccccccccccc", "")
        .unwrap();
    a.call_add_participant("cccccccccccc", &call_id, "dddddddddddd", "voice")
        .unwrap();

    assert!(a.call_add_participant("bbbbbbbbbbbb", "", "x", "").is_err());
    assert!(a
        .call_add_participant("bbbbbbbbbbbb", &call_id, "", "")
        .is_err());
}
