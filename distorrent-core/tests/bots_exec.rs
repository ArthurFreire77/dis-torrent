//! Bots executáveis: permissões administrativas, logs, variáveis e avisos.
//!
//! Roda contra o `Store` e o `NetworkEngine` reais (SQLite em memória), então
//! cobre o caminho do banco e da autorização â€” não um mock.

use std::sync::Arc;

use distorrent_core::net::engine::NetworkEngine;
use distorrent_core::storage::Store;
use tempfile::TempDir;

fn engine(nick: &str) -> (Arc<NetworkEngine>, TempDir) {
    let dir = tempfile::tempdir().expect("tmp");
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).expect("store"));
    let kp = distorrent_core::identity::Keypair::generate();
    let e = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (e, dir)
}

fn membro(engine: &NetworkEngine, cid: &str, fp: &str, nick: &str) {
    engine
        .store
        .upsert_member(cid, fp, nick, "member")
        .expect("membro");
}

#[test]
fn bot_nasce_sem_permissao_administrativa() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Ajuda", None, None).expect("bot");
    assert_eq!(bot.perms, 0, "bot não pode nascer com poderes");
    let listados = e.bots_list(&cid).unwrap();
    assert_eq!(listados[0].perms, 0);
}

#[test]
fn bot_sem_permissao_nao_bani() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    membro(&e, &cid, "aaaaaaaaaaaa", "Alvo");
    let bot = e.bot_create(&cid, "Ajuda", None, None).expect("bot");
    let erro = e
        .bot_admin(&cid, &bot.id, "ban", "aaaaaaaaaaaa", "spam", None)
        .expect_err("sem permissão o ban precisa falhar");
    assert!(
        erro.to_string().contains("não tem permissão"),
        "mensagem honesta esperada, veio: {erro}"
    );
}

#[test]
fn dono_concede_permissao_e_ban_funciona() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    membro(&e, &cid, "bbbbbbbbbbbb", "Alvo");
    let bot = e.bot_create(&cid, "Moderador", None, None).expect("bot");
    let perm = distorrent_core::moderation::PERM_BAN;
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(perm),
            ..Default::default()
        },
    )
    .expect("conceder");

    let texto = e
        .bot_admin(&cid, &bot.id, "ban", "Alvo", "flood", None)
        .expect("ban autorizado");
    assert!(texto.contains("banido"), "{texto}");
    assert!(
        e.store
            .list_members(&cid)
            .unwrap()
            .iter()
            .all(|(fp, _, _)| fp != "bbbbbbbbbbbb"),
        "o alvo precisa sair do servidor"
    );
    assert!(
        e.store.ban_get(&cid, "bbbbbbbbbbbb").unwrap().is_some(),
        "o ban precisa ficar registrado"
    );
    let audit = e.store.list_audit(&cid, 20).unwrap();
    assert!(
        audit
            .iter()
            .any(|a| a.action == "bot:ban" && a.actor_fp == bot.id),
        "a ação precisa ir para o audit com o bot como autor"
    );
}

#[test]
fn bot_nao_pode_moderar_o_dono_nem_estando_online() {
    let (e, _d) = engine("Dono");
    let me = e.identity().fingerprint.clone();
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Moderador", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(distorrent_core::moderation::PERM_ALL),
            ..Default::default()
        },
    )
    .unwrap();
    let erro = e
        .bot_admin(&cid, &bot.id, "ban", &me, "teste", None)
        .expect_err("o dono nunca é alvo");
    assert!(erro.to_string().contains("dono"), "{erro}");
}

#[test]
fn bot_offline_nao_executa_nada() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    membro(&e, &cid, "cccccccccccc", "Alvo");
    let bot = e.bot_create(&cid, "Moderador", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            online: Some(false),
            perms: Some(distorrent_core::moderation::PERM_ALL),
            ..Default::default()
        },
    )
    .unwrap();
    let erro = e
        .bot_admin(&cid, &bot.id, "kick", "cccccccccccc", "", None)
        .expect_err("offline não age");
    assert!(erro.to_string().contains("offline"), "{erro}");
}

#[test]
fn avisos_e_limpeza_ficam_no_banco() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    membro(&e, &cid, "dddddddddddd", "Alvo");
    let bot = e.bot_create(&cid, "Moderador", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(distorrent_core::moderation::PERM_MUTE),
            ..Default::default()
        },
    )
    .unwrap();
    e.bot_admin(&cid, &bot.id, "warn", "dddddddddddd", "spam", None)
        .expect("avisar");
    let lista = e.store.warnings_for(&cid, "dddddddddddd").unwrap();
    assert_eq!(lista.len(), 1);
    let resumo = e
        .bot_admin(&cid, &bot.id, "warnings", "dddddddddddd", "", None)
        .expect("listar avisos");
    assert!(resumo.contains("1 aviso"), "{resumo}");
    assert_eq!(e.store.warnings_clear(&cid, "dddddddddddd").unwrap(), 1);
    assert!(e
        .store
        .warnings_for(&cid, "dddddddddddd")
        .unwrap()
        .is_empty());
}

#[test]
fn console_do_bot_guarda_e_limpa() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Ajuda", None, None).expect("bot");
    e.bot_log_append(&cid, &bot.id, "info", "iniciou").unwrap();
    e.bot_log_append(&cid, &bot.id, "error", "falhou ao chamar api")
        .unwrap();
    let logs = e.bot_logs(&cid, &bot.id, 10).unwrap();
    assert_eq!(logs.len(), 2);
    assert_eq!(logs[0].level, "error", "mais recente primeiro");
    assert_eq!(e.bot_logs_clear(&cid, &bot.id).unwrap(), 2);
    assert!(e.bot_logs(&cid, &bot.id, 10).unwrap().is_empty());
}

#[test]
fn log_de_bot_inexistente_e_recusado() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    assert!(e.bot_log_append(&cid, "nao-existe", "info", "x").is_err());
}

#[test]
fn variaveis_do_script_persistem_por_bot() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Economia", None, None).expect("bot");
    e.bot_var_set(&cid, &bot.id, "pontos:ana", "7").unwrap();
    assert_eq!(
        e.store.bot_var_get(&cid, &bot.id, "pontos:ana").as_deref(),
        Some("7")
    );
    let todos = e.bot_vars_list(&cid, &bot.id).unwrap();
    assert_eq!(todos, vec![("pontos:ana".to_string(), "7".to_string())]);
}

#[test]
fn comando_de_admin_pede_a_permissao_certa() {
    use distorrent_core::moderation::{perm_for_action, PERM_ALL, PERM_BAN, PERM_MUTE};
    assert_eq!(perm_for_action("ban"), Some(PERM_BAN));
    assert_eq!(perm_for_action("mute"), Some(PERM_MUTE));
    assert_eq!(perm_for_action("userinfo"), Some(0));
    assert_eq!(perm_for_action("roubar_dados"), None);
    assert_eq!(PERM_ALL & PERM_BAN, PERM_BAN);
}

#[test]
fn resolve_canal_e_membro_por_nome() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    membro(&e, &cid, "eeeeeeeeeeee", "Maria");
    assert_eq!(
        e.resolve_member(&cid, "Maria").as_deref(),
        Some("eeeeeeeeeeee")
    );
    assert_eq!(
        e.resolve_member(&cid, "<@eeeeeeeeeeee>").as_deref(),
        Some("eeeeeeeeeeee")
    );
    let canal = e.resolve_channel(&cid, "#geral").expect("canal");
    assert!(e
        .store
        .list_channels(&cid)
        .unwrap()
        .iter()
        .any(|(id, _)| *id == canal));
}

#[test]
fn config_de_bot_existente_nao_e_perdida_na_migracao() {
    let cfg = r#"{"prefix":"!","commands":[{"name":"clima","url":"https://api.x/y","template":"{{json}}"}]}"#;
    let parsed = distorrent_core::bots::parse_config(cfg).expect("config antiga válida");
    assert_eq!(parsed.commands.len(), 1);
    assert!(parsed.block_private);
    assert_eq!(parsed.max_replies_per_min, 20);
}

#[test]
fn bot_monta_o_servidor_com_permissao_de_gerenciar() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Arquiteto", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(distorrent_core::moderation::PERM_MANAGE),
            ..Default::default()
        },
    )
    .unwrap();

    // Cria canal, cargo, edita o canal, dá o cargo e renomeia o servidor.
    let a = e
        .bot_admin(&cid, &bot.id, "channel_create", "avisos", "text", None)
        .expect("canal");
    assert!(a.contains("criado"), "{a}");
    assert!(e.resolve_channel(&cid, "#avisos").is_some());

    let b = e
        .bot_admin(&cid, &bot.id, "role_create", "Membro", "#57f287", None)
        .expect("cargo");
    assert!(b.contains("criado"), "{b}");

    let c = e
        .bot_admin(&cid, &bot.id, "channel_edit", "#avisos", "novidades", None)
        .expect("renomear canal");
    assert!(c.contains("novidades"), "{c}");

    membro(&e, &cid, "abcdabcdabcd", "Ana");
    let d = e
        .bot_admin(&cid, &bot.id, "role_assign", "Membro", "Ana", None)
        .expect("dar cargo");
    assert!(d.contains("dado"), "{d}");
    let roles = e.store.member_roles_list(&cid, "abcdabcdabcd").unwrap();
    assert!(!roles.is_empty(), "cargo precisa estar atribuído");

    let f = e
        .bot_admin(&cid, &bot.id, "server_edit", "Servidor Renomeado", "", None)
        .expect("renomear servidor");
    assert!(f.contains("Renomeado"), "{f}");
    assert_eq!(
        e.store.get_community(&cid).unwrap().unwrap().1,
        "Servidor Renomeado"
    );
}

#[test]
fn sem_permissao_de_gerenciar_o_bot_nao_cria_canal() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "SemPoder", None, None).expect("bot");
    let erro = e
        .bot_admin(&cid, &bot.id, "channel_create", "invasao", "", None)
        .expect_err("sem permissão");
    assert!(erro.to_string().contains("não tem permissão"), "{erro}");
    assert!(e.resolve_channel(&cid, "#invasao").is_none());
}

#[test]
fn o_bot_troca_a_propria_config_mas_nao_se_da_permissao() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Plugin", None, None).expect("bot");
    let nova =
        r#"{"prefix":"/","commands":[{"name":"ping","reply":"pong"}],"events":["member_joined"]}"#;
    let n = e
        .bot_replace_config(&cid, &bot.id, nova)
        .expect("config válida");
    assert_eq!(n, 1);
    let salvo = e
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .unwrap();
    assert!(salvo.config.contains("pong"));
    assert_eq!(salvo.perms, 0, "o bot NUNCA se concede permissão");

    // Config inválida é recusada e não sobrescreve a boa.
    assert!(e.bot_replace_config(&cid, &bot.id, "{lixo").is_err());
    let salvo = e
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .unwrap();
    assert!(salvo.config.contains("pong"), "config boa preservada");
}

#[test]
fn bot_offline_nao_troca_a_config() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Plugin", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            online: Some(false),
            ..Default::default()
        },
    )
    .unwrap();
    let erro = e
        .bot_replace_config(&cid, &bot.id, r#"{"commands":[{"name":"x","reply":"y"}]}"#)
        .expect_err("offline");
    assert!(erro.to_string().contains("offline"), "{erro}");
}

/// Toda ação listada no registro precisa ser despachada pelo motor; senão o
/// painel oferece um botão que responde "ação inválida".
#[test]
fn registro_de_acoes_e_o_mesmo_que_o_motor_executa() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Tudo", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(distorrent_core::moderation::PERM_ALL),
            ..Default::default()
        },
    )
    .unwrap();
    // Argumentos vazios: o esperado é erro de ARGUMENTO, nunca "ação inválida".
    for def in distorrent_core::moderation::BOT_ACTIONS {
        let out = e.bot_admin(&cid, &bot.id, def.action, "", "", None);
        if let Err(err) = &out {
            let txt = err.to_string();
            assert!(
                !txt.contains("ação inválida"),
                "`{}` está no registro mas o motor não a executa: {txt}",
                def.action
            );
        }
    }
}

#[test]
fn acoes_de_conteudo_reagem_fixam_e_apagam() {
    use distorrent_core::moderation::{PERM_ALL, PERM_CONTENT};
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let canal = e.resolve_channel(&cid, "").expect("canal");
    let bot = e.bot_create(&cid, "Conteudo", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(PERM_ALL),
            ..Default::default()
        },
    )
    .unwrap();
    let msg = e.send_channel_message(&cid, &canal, "oi").expect("msg");

    // Reagir alterna (1ª adiciona, 2ª remove).
    e.bot_admin(&cid, &bot.id, "react", &msg.id, "🔥", None)
        .expect("reagir");
    assert_eq!(e.store.reactions_for_msg(&msg.id).unwrap().len(), 1);
    e.bot_admin(&cid, &bot.id, "react", &msg.id, "🔥", None)
        .expect("desreagir");
    assert!(e.store.reactions_for_msg(&msg.id).unwrap().is_empty());

    e.bot_admin(&cid, &bot.id, "pin", &msg.id, "", None)
        .expect("fixar");
    assert_eq!(e.store.pins_list(&canal).unwrap().len(), 1);
    e.bot_admin(&cid, &bot.id, "unpin", &msg.id, "", None)
        .expect("desafixar");
    assert!(e.store.pins_list(&canal).unwrap().is_empty());

    e.bot_admin(&cid, &bot.id, "delete_msg", &msg.id, "", None)
        .expect("apagar");
    assert!(
        e.store
            .msg_meta(&msg.id)
            .unwrap()
            .map(|m| m.deleted)
            .unwrap_or(false),
        "a mensagem precisa ficar marcada como apagada"
    );

    // O bit de conteúdo não dá poder de moderação.
    let bot2 = e.bot_create(&cid, "SoConteudo", None, None).expect("bot2");
    e.bot_update(
        &cid,
        &bot2.id,
        distorrent_core::storage::BotPatch {
            perms: Some(PERM_CONTENT),
            ..Default::default()
        },
    )
    .unwrap();
    let erro = e
        .bot_admin(&cid, &bot2.id, "ban", "Alvo", "x", None)
        .expect_err("conteúdo não bane");
    assert!(erro.to_string().contains("permissão"), "{erro}");
}

#[test]
fn acoes_de_leitura_nao_sujam_a_auditoria() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Leitor", None, None).expect("bot");
    for acao in [
        "serverinfo",
        "ping",
        "channels",
        "roles",
        "bans",
        "timeouts",
        "audit",
    ] {
        e.bot_admin(&cid, &bot.id, acao, "", "", None)
            .unwrap_or_else(|err| panic!("{acao}: {err}"));
    }
    assert!(
        e.store.list_audit(&cid, 50).unwrap().is_empty(),
        "consulta não é ação: nada de audit log"
    );
}

#[test]
fn acao_de_canal_usa_o_canal_de_contexto() {
    use distorrent_core::moderation::PERM_ALL;
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let segundo = e
        .channel_create(&cid, "avisos", "", "", "text")
        .expect("canal");
    let bot = e.bot_create(&cid, "Enquete", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(PERM_ALL),
            ..Default::default()
        },
    )
    .unwrap();
    let out = e
        .bot_action_in(
            &cid,
            &bot.id,
            "poll_create",
            "Qual jogo?",
            "A | B",
            None,
            Some(&segundo.id),
        )
        .expect("enquete");
    assert!(out.contains("enquete"), "{out}");
    assert_eq!(
        e.store.poll_list(&cid, &segundo.id).unwrap().len(),
        1,
        "a enquete precisa nascer no canal do contexto"
    );
}

#[test]
fn bot_nao_distribui_cargo_com_permissao_que_ele_nao_tem() {
    use distorrent_core::moderation::{PERM_BAN, PERM_MANAGE};
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Delegador", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            perms: Some(PERM_MANAGE),
            ..Default::default()
        },
    )
    .unwrap();
    let perigoso = e
        .role_create(&cid, "Moderador", "#ed4245", PERM_BAN, false, false)
        .expect("cargo");
    membro(&e, &cid, "abcdabcdabcd", "Ana");
    let erro = e
        .bot_admin(&cid, &bot.id, "role_assign", "Moderador", "Ana", None)
        .expect_err("nao pode dar cargo com ban sem ter ban");
    let msg = format!("{erro}");
    assert!(msg.contains("permiss"), "{msg}");
    assert!(
        e.store
            .member_roles_list(&cid, "abcdabcdabcd")
            .unwrap()
            .is_empty(),
        "o cargo perigoso nao pode ter sido atribuido"
    );
    // Cargo sem poder extra continua permitido.
    let inofensivo = e
        .role_create(&cid, "Visitante", "#949ba4", 0, false, false)
        .expect("cargo");
    e.bot_admin(&cid, &bot.id, "role_assign", "Visitante", "Ana", None)
        .expect("cargo sem permissao pode ser dado");
    assert!(e
        .store
        .member_roles_list(&cid, "abcdabcdabcd")
        .unwrap()
        .iter()
        .any(|r| *r == inofensivo.id));
    let _ = perigoso;
}

#[test]
fn segredo_do_webhook_fica_fora_do_json_de_config() {
    use distorrent_core::storage::BotPatch;
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Assinado", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        BotPatch {
            webhook_secret: Some("segredo-de-assinatura-123".into()),
            config: Some(r#"{"prefix":"!","commands":[{"name":"ping","reply":"pong"}]}"#.into()),
            ..Default::default()
        },
    )
    .unwrap();

    let salvo = e
        .store
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .expect("bot");
    // O valor mora na coluna local, NAO no JSON de config.
    assert_eq!(salvo.webhook_secret, "segredo-de-assinatura-123");
    assert!(
        !salvo.config.contains("segredo-de-assinatura-123"),
        "config: {}",
        salvo.config
    );
    // E o bot NAO apaga o segredo ao trocar a propria config pela ponte.
    e.bot_replace_config(
        &cid,
        &bot.id,
        r#"{"prefix":"!","commands":[{"name":"eco","reply":"eco"}]}"#,
    )
    .expect("bot troca a propria config");
    let depois = e
        .store
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .expect("bot");
    assert_eq!(
        depois.webhook_secret, "segredo-de-assinatura-123",
        "regravar a config nao pode apagar a assinatura"
    );
    assert!(depois.config.contains("eco"), "{}", depois.config);
}

#[test]
fn bot_nao_religa_rede_privada_pela_ponte() {
    // O dono decidiu bloquear a LAN; o bot nao desfaz essa decisao sozinho.
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Rebelde", None, None).expect("bot");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            config: Some(r#"{"prefix":"!","blockPrivate":true}"#.into()),
            ..Default::default()
        },
    )
    .unwrap();
    e.bot_replace_config(
        &cid,
        &bot.id,
        r#"{"prefix":"!","blockPrivate":false,"commands":[{"name":"x","reply":"x"}]}"#,
    )
    .expect("config valida");
    let depois = e
        .store
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .find(|b| b.id == bot.id)
        .expect("bot");
    let cfg = distorrent_core::bots::parse_config(&depois.config).expect("config");
    assert!(
        cfg.block_private,
        "a politica do dono (bloquear rede privada) precisa sobreviver: {}",
        depois.config
    );
}

#[test]
fn migracao_cria_a_coluna_do_segredo_e_bots_antigos_continuam() {
    let (e, dir) = engine("Dono");
    drop(e);
    let store = Store::open(&dir.path().join("distorrent.db")).expect("reabrir");
    let cid = "c-antigo".to_string();
    store
        .create_community(&cid, "Antigo", "ffffffffffff", &[])
        .expect("comunidade");
    let antigo = distorrent_core::storage::BotRow {
        id: "b-antigo".into(),
        community_id: cid.clone(),
        name: "Antigo".into(),
        discriminator: "0001".into(),
        avatar: "x".into(),
        role_id: None,
        token: "bot_x".into(),
        online: true,
        owner_fp: "ffffffffffff".into(),
        created_at: 1,
        config: r#"{"prefix":"!","commands":[{"name":"ping","reply":"pong"}]}"#.into(),
        perms: 0,
        webhook_secret: String::new(),
    };
    store.bot_upsert(&antigo).expect("upsert");
    let lido = store
        .bots_list(&cid)
        .unwrap()
        .into_iter()
        .next()
        .expect("bot antigo");
    assert_eq!(lido.name, "Antigo");
    assert!(lido.webhook_secret.is_empty(), "sem segredo por padrao");
    assert!(!lido.webhook_secret_set());
}

#[test]
fn limite_de_config_e_o_mesmo_no_parser_e_no_banco() {
    use distorrent_core::bots::BOT_CONFIG_MAX;
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "Grande", None, None).expect("bot");

    // Config valida de ~32 KB: passa no parser e TEM de gravar.
    let script = "reply \"x\"\n".repeat(2000); // 200 linhas * 9 chars, cortado pelo parser
    let meio = serde_json::json!({
        "prefix": "!",
        "commands": [{ "name": "eco", "exec": "script", "script": script }],
        "channels": [],
    })
    .to_string();
    assert!(meio.len() > 16 * 1024, "o caso precisa passar de 16 KB");
    assert!(meio.len() < BOT_CONFIG_MAX, "e ficar abaixo do teto real");
    e.bot_update(
        &cid,
        &bot.id,
        distorrent_core::storage::BotPatch {
            config: Some(meio.clone()),
            ..Default::default()
        },
    )
    .expect("config abaixo de 64 KB precisa gravar");

    // Acima do teto: recusa nos DOIS lados, com o mesmo numero.
    let grande = "a".repeat(BOT_CONFIG_MAX + 1);
    let err = e
        .bot_update(
            &cid,
            &bot.id,
            distorrent_core::storage::BotPatch {
                config: Some(grande),
                ..Default::default()
            },
        )
        .expect_err("acima do teto tem de recusar");
    let msg = format!("{err}");
    assert!(
        msg.contains("64"),
        "a mensagem precisa citar o teto real (64 KB), nao 16: {msg}"
    );
}

#[test]
fn audio_do_bot_toca_local_e_nao_finge_transmitir() {
    let (e, _d) = engine("Dono");
    let cid = e
        .create_community("Servidor", &["geral".to_string()])
        .expect("criar");
    let bot = e.bot_create(&cid, "DJ", None, None).expect("bot");
    assert!(e.bots_list(&cid).unwrap().iter().any(|b| b.id == bot.id));
    // O gate de plataforma: no Windows compila sem o misturador; no Linux usa.
    #[cfg(target_os = "linux")]
    {
        let mut sink = distorrent_core::net::bot_audio::open();
        let (acc, drop) = sink.push_pcm(&vec![0i16; 4800]);
        assert_eq!(acc, 5, "4800 amostras = 5 frames de 20 ms");
        assert_eq!(drop, 0);
        assert_eq!(sink.dropped(), 0);
    }
}
