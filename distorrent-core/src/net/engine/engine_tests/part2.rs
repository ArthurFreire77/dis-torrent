// Testes do motor (declarados por #[path] em engine.rs): usam os internos
// privados do modulo, por isso moram no mesmo pai.

use super::engine_tests_support::*;
use super::*;
use crate::net::relay::MemRelay;
use crate::storage::Store;
#[tokio::test]
async fn foto_do_perfil_chega_inteira_no_outro_lado() {
    use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

    let (a, _da) = mk_engine("perfil-foto-a");
    let (b, _db) = mk_engine("perfil-foto-b");
    let fp_a = a.identity.fingerprint.clone();

    let bytes: Vec<u8> = (0..40_000u32).map(|i| (i % 251) as u8).collect();
    let avatar = B64.encode(&bytes);
    assert!(
        avatar.len() < PROFILE_IMG_B64_MAX,
        "o teste precisa caber no teto"
    );

    let p = a
        .social_profile_set("Eu Mesmo", "minha bio", &avatar, "", "#5865f2")
        .unwrap();
    assert_eq!(
        p.avatar_b64, avatar,
        "o store precisa devolver a foto inteira"
    );

    match profile_frame(&p) {
        SecureFrame::ProfileSet {
            avatar_b64,
            content_hash,
            rev,
            ..
        } => {
            assert_eq!(avatar_b64, avatar, "o frame perdeu a foto");
            assert_eq!(rev, 1);
            let esperado = crate::social::profile_content_hash(
                "Eu Mesmo",
                "minha bio",
                &avatar,
                "",
                "#5865f2",
            );
            assert_eq!(content_hash, esperado);
        }
        other => panic!("frame inesperado: {other:?}"),
    }

    frames::handle_frame(&b, &fp_a, "pubkey", "Eu Mesmo", profile_frame(&p))
        .await
        .unwrap();
    let recebido = b.store.profile_get(&fp_a).unwrap();
    assert_eq!(recebido.avatar_b64, avatar, "a foto não chegou íntegra");
    assert_eq!(recebido.display_name, "Eu Mesmo");
}

#[test]
fn repeticao_normal_nao_e_spam_mas_massa_e() {
    let (e, _d) = mk_engine("spam-dup");
    let peer = "peer-spam";
    for _ in 0..5 {
        assert!(
            e.spam_gate(peer, "sim").is_ok(),
            "repetir a mesma palavra numa conversa não pode virar erro"
        );
    }
    assert!(e.spam_gate(peer, "sim").is_err(), "massa de cópias é spam");
    assert!(e.spam_gate(peer, "outra coisa").is_ok());
}

#[test]
fn conversa_rapida_com_amigo_nao_dispara_flood() {
    let (e, _d) = mk_engine("spam-flood");
    let peer = "peer-amigo";
    e.store.set_friend(peer, "Amigo", "accepted").unwrap();
    for i in 0..12 {
        assert!(
            e.spam_gate(peer, &format!("msg {i}")).is_ok(),
            "mensagem {i} de uma conversa normal foi bloqueada como flood"
        );
    }
    let estranho = "peer-estranho";
    let mut bloqueou = false;
    for i in 0..20 {
        if e.spam_gate(estranho, &format!("m{i}")).is_err() {
            bloqueou = true;
            break;
        }
    }
    assert!(
        bloqueou,
        "o teto apertado precisa continuar valendo contra abuso"
    );
}

#[tokio::test]
async fn grupo_dispensado_nao_volta_com_roster_reenviado() {
    let (e, _d) = mk_engine("grupo-nao-volta");
    let criador = "c0c0c0c00001";
    let outro_membro = "c0c0c0c00002";
    let conv = e
        .store
        .create_group_dm(
            &e.identity.fingerprint,
            &[criador.to_string(), outro_membro.to_string()],
            "Grupo que eu saí",
        )
        .unwrap();
    // O grupo foi criado por `criador` (não por mim): é o cenário real de quem recebe um convite e depois sai.
    e.store.group_owner_set(&conv.id, criador).unwrap();
    let membros = e.store.list_group_members(&conv.id).unwrap();
    e.store.leave_group_local(&conv.id).unwrap();
    crate::group_trash::dismiss_owned(&e.store, &conv.id, criador).unwrap();

    // Um membro comum reenvia o roster antigo — completo, comigo dentro.
    frames::handle_frame(
        &e,
        outro_membro,
        "",
        "Outro",
        SecureFrame::GroupCreated {
            conv_id: conv.id.clone(),
            title: "Grupo que eu saí".into(),
            members: membros.clone(),
            owner_fp: criador.into(),
        },
    )
    .await
    .unwrap();

    assert!(
        e.store.get_conversation(&conv.id).unwrap().is_none(),
        "roster reenviado por quem não é criador não pode ressuscitar o grupo"
    );
    assert!(
        crate::group_trash::is_dismissed(&e.store, &conv.id),
        "o bloqueio tem de continuar valendo depois do reenvio"
    );
}

#[tokio::test]
async fn grupo_dispensado_volta_quando_o_criador_me_adiciona() {
    let (e, _d) = mk_engine("grupo-volta");
    let criador = "c0c0c0c00003";
    let outro_membro = "c0c0c0c00004";
    let conv = e
        .store
        .create_group_dm(
            &e.identity.fingerprint,
            &[criador.to_string(), outro_membro.to_string()],
            "Grupo de volta",
        )
        .unwrap();
    e.store.group_owner_set(&conv.id, criador).unwrap();
    let membros = e.store.list_group_members(&conv.id).unwrap();
    e.store.leave_group_local(&conv.id).unwrap();
    crate::group_trash::dismiss_owned(&e.store, &conv.id, criador).unwrap();

    // O criador reenvia o roster me incluindo de novo: readição de propósito.
    frames::handle_frame(
        &e,
        criador,
        "",
        "Criador",
        SecureFrame::GroupCreated {
            conv_id: conv.id.clone(),
            title: "Grupo de volta".into(),
            members: membros.clone(),
            owner_fp: criador.into(),
        },
    )
    .await
    .unwrap();

    assert!(
        e.store.get_conversation(&conv.id).unwrap().is_some(),
        "o criador me adicionando de novo tem de recriar o grupo"
    );
    assert!(
        !crate::group_trash::is_dismissed(&e.store, &conv.id),
        "a readição do criador limpa o bloqueio"
    );
}

#[test]
fn sair_do_grupo_marca_como_dispensado() {
    let (e, _d) = mk_engine("sair-dispensa");
    let criador = "c0c0c0c00005";
    let eu = e.identity.fingerprint.clone();
    let conv = e
        .store
        .create_group_dm(&eu, &[criador.to_string()], "Grupo para sair")
        .unwrap();
    // O convite veio do criador: ele é o dono, não eu (que apenas recebi).
    e.store.group_owner_set(&conv.id, criador).unwrap();
    let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();

    e.group_leave(&conv.id).unwrap();

    assert!(
        e.store.get_conversation(&conv.id).unwrap().is_none(),
        "sair tem de remover a conversa local"
    );
    assert!(
        crate::group_trash::is_dismissed(&e.store, &conv.id),
        "sair sem marcar como dispensado deixava o grupo voltar no sync seguinte"
    );
    while commands.try_recv().is_ok() {}
}

#[test]
fn call_invite_registra_o_chamador_como_participante() {
    let (e, _d) = mk_engine("call-invite-parte");
    let me = e.identity.fingerprint.clone();
    let call_id = e.call_invite("peer-alvo", "voice").unwrap();
    assert!(
        e.store.is_in_call(&call_id, &me),
        "sem isto o gate de grupo não reconhece a própria chamada do chamador"
    );
    assert!(e.store.call_participants(&call_id).unwrap().contains(&me));
}

#[test]
fn is_in_call_so_vale_para_a_chamada_e_o_participante_certos() {
    let (e, _d) = mk_engine("is-in-call");
    let me = e.identity.fingerprint.clone();
    e.store.join_call("call-a", &me).unwrap();
    assert!(e.store.is_in_call("call-a", &me));
    assert!(
        !e.store.is_in_call("call-b", &me),
        "outra chamada não conta"
    );
    assert!(
        !e.store.is_in_call("call-a", "outro-fp"),
        "outro fp não é participante"
    );
}

fn peer_hex(n: u8) -> String {
    format!("{n:02x}").repeat(6)
}

#[test]
fn profile_set_nao_cria_amizade() {
    let (e, _d) = mk_engine("perfil-nao-amiga");
    let peer = peer_hex(0x11);
    perfil_block_on(frames::handle_frame(
        &e,
        &peer,
        "pk",
        "Estranho",
        SecureFrame::ProfileSet {
            display_name: "Estranho".into(),
            about: String::new(),
            avatar_b64: String::new(),
            banner_b64: String::new(),
            accent: String::new(),
            rev: 1,
            content_hash: String::new(),
            profile_theme: String::new(),
            avatar_effect: String::new(),
            decoration: String::new(),
        },
    ))
    .unwrap();
    assert_eq!(
        e.store.profile_get(&peer).unwrap().display_name,
        "Estranho",
        "perfil é aceito"
    );
    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        None,
        "receber perfil NÃO pode virar amizade"
    );
}

#[test]
fn pedido_cruzado_vira_amizade_dos_dois_lados() {
    let a = mk_engine("a").0;
    let b = mk_engine("b").0;
    let fp_a = a.identity.fingerprint.clone();
    let fp_b = b.identity.fingerprint.clone();

    // Os dois pedem ao mesmo tempo; cada um recebe o pedido do outro.
    a.store.set_friend_request_out(&fp_b, "b").unwrap();
    b.store.set_friend_request_out(&fp_a, "a").unwrap();

    perfil_block_on(frames::handle_frame(
        &b,
        &fp_a,
        "pk",
        "a",
        SecureFrame::FriendRequest {
            nickname: "a".into(),
        },
    ))
    .unwrap();

    assert_eq!(
        b.store.get_friend(&fp_a).unwrap().map(|(_, s)| s),
        Some("accepted".into()),
        "quem recebeu o pedido cruzado aceita"
    );
    assert_eq!(
        a.store.get_friend(&fp_b).unwrap().map(|(_, s)| s),
        Some("pending_out".into()),
        "o outro lado só muda quando o FriendAccept chegar"
    );

    perfil_block_on(frames::handle_frame(
        &a,
        &fp_b,
        "pk",
        "b",
        SecureFrame::FriendAccept {
            nickname: "b".into(),
        },
    ))
    .unwrap();
    assert_eq!(
        a.store.get_friend(&fp_b).unwrap().map(|(_, s)| s),
        Some("accepted".into())
    );
}

#[test]
fn aceite_atrasado_nao_recria_amizade_bloqueada() {
    let (e, _d) = mk_engine("aceite-atrasado");
    let peer = peer_hex(0x22);
    e.friend_block(&peer).unwrap();
    perfil_block_on(frames::handle_frame(
        &e,
        &peer,
        "pk",
        "peer",
        SecureFrame::FriendAccept {
            nickname: "peer".into(),
        },
    ))
    .unwrap();
    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        Some("blocked".into()),
        "FriendAccept não desfaz bloqueio"
    );
}

/// Recusa de um pedido vindo de quem já me bloqueou não rebaixa o
/// bloqueio — senão um "reject" atrasado me liberava para o abuso.
#[test]
fn recusa_preserva_bloqueio_e_nao_apaga_historico() {
    let (e, _d) = mk_engine("recusa");
    let peer = peer_hex(0x33);
    e.store.set_friend_request_in(&peer, "peer").unwrap();
    perfil_block_on(frames::handle_frame(
        &e,
        &peer,
        "pk",
        "peer",
        SecureFrame::FriendReject,
    ))
    .unwrap();
    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        Some("rejected".into())
    );
    e.friend_block(&peer).unwrap();
    perfil_block_on(frames::handle_frame(
        &e,
        &peer,
        "pk",
        "peer",
        SecureFrame::FriendReject,
    ))
    .unwrap();
    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        Some("blocked".into())
    );
}

#[test]
fn remover_amigo_bloqueado_nao_desbloqueia() {
    let (e, _d) = mk_engine("remover-bloqueado");
    let peer = peer_hex(0x44);
    e.friend_block(&peer).unwrap();
    e.friend_remove(&peer).unwrap();
    assert!(
        e.store.is_blocked_fp(&peer),
        "remover não pode apagar a memória do bloqueio"
    );
}

#[test]
fn desbloquear_nao_recria_amizade() {
    let (e, _d) = mk_engine("desbloquear");
    let peer = peer_hex(0x55);
    e.friend_block(&peer).unwrap();
    e.friend_unblock(&peer).unwrap();
    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        Some("removed".into()),
        "desbloqueado volta ao neutro, não a amigo"
    );
}

/// O retry automático reenvia o MESMO perfil de pedido. Tratar todo
/// `pending_in` como "pedido cruzado" fazia a amizade nascer sem ninguém
/// clicar em Aceitar — era o bug relatado ("aceitou sozinho").
#[test]
fn pedido_repetido_nao_vira_amizade_sem_aceite() {
    let (e, _d) = mk_engine("pedido-repetido");
    let peer = peer_hex(0xab);

    for _ in 0..5 {
        perfil_block_on(frames::handle_frame(
            &e,
            &peer,
            "pk",
            "peer",
            SecureFrame::FriendRequest {
                nickname: "peer".into(),
            },
        ))
        .unwrap();
    }

    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        Some("pending_in".into()),
        "pedido repetido continua PENDENTE: quem aceita é o usuário"
    );
    assert!(
        e.friends(Some("pending_in")).iter().any(|f| f.fp == peer),
        "o pedido continua visível na lista de pendentes"
    );
}

/// Desligar solicitações não pode criar amizade nem revelar bloqueio.
#[test]
fn pedido_ignorado_com_solicitacoes_desligadas() {
    let (e, _d) = mk_engine("pedidos-desligados");
    let peer = peer_hex(0xcd);
    e.set_friend_requests_enabled(false).unwrap();
    assert!(!e.friend_requests_enabled());

    perfil_block_on(frames::handle_frame(
        &e,
        &peer,
        "pk",
        "peer",
        SecureFrame::FriendRequest {
            nickname: "peer".into(),
        },
    ))
    .unwrap();

    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        None,
        "com pedidos desligados não nasce nem solicitação pendente"
    );

    e.set_friend_requests_enabled(true).unwrap();
    assert!(e.friend_requests_enabled(), "a opção volta a ligar");
}

#[test]
fn pedido_vencido_some_das_listas() {
    let (e, d) = mk_engine("pedido-vencido");
    let peer = peer_hex(0x66);
    e.store.set_friend_request_in(&peer, "velho").unwrap();
    {
        let conn = e.store.locked();
        conn.execute(
            "UPDATE friends SET requested_at=?2 WHERE fp=?1",
            rusqlite::params![
                peer,
                crate::identity::now_ms() - crate::social::FRIEND_REQUEST_TTL_MS - 1000
            ],
        )
        .unwrap();
    }
    assert!(e.friends(Some("pending_in")).is_empty());
    drop(d);
}

#[test]
fn gate_de_tres_mensagens_e_por_direcao_e_persistente() {
    let (e, d) = mk_engine("intro");
    let peer = peer_hex(0x77);
    let conv = e.open_dm(&peer, "peer").unwrap();
    e.social_profile_set("Eu", "", "", "", "").unwrap();

    for i in 0..crate::social::DM_INTRO_LIMIT {
        let m = e.send_dm(&conv.id, &format!("oi {i}")).unwrap();
        assert!(m.id.len() > 8);
    }
    let err = e.send_dm(&conv.id, "quarta").unwrap_err().to_string();
    assert!(
        err.contains("limite"),
        "quarta mensagem tem de falhar: {err}"
    );

    // Reabrir o app/banco não devolve crédito.
    let store2 = crate::storage::Store::open(&d.path().join("distorrent.db")).unwrap();
    assert_eq!(
        store2
            .dm_intro_used(&conv.id, &e.identity.fingerprint)
            .unwrap(),
        crate::social::DM_INTRO_LIMIT
    );

    // Aceitar a amizade libera a conversa e zera o contador.
    e.store.accept_friend(&peer, "peer").unwrap();
    e.reset_dm_intro_for_peer(&peer);
    assert!(e.send_dm(&conv.id, "agora pode").is_ok());
}

#[test]
fn aceitar_amizade_zera_o_gate_da_dm() {
    let (e, _d) = mk_engine("intro-aceite");
    let peer = peer_hex(0x88);
    let conv = e.open_dm(&peer, "peer").unwrap();
    e.store.set_friend_request_in(&peer, "peer").unwrap();
    assert!(e
        .store
        .dm_intro_take(
            &conv.id,
            &e.identity.fingerprint,
            crate::social::DM_INTRO_LIMIT
        )
        .unwrap());
    e.friend_respond(&peer, true).unwrap();
    assert_eq!(
        e.store
            .dm_intro_used(&conv.id, &e.identity.fingerprint)
            .unwrap(),
        0
    );
    assert_eq!(
        e.store.get_friend(&peer).unwrap().map(|(_, s)| s),
        Some("accepted".into())
    );
}

#[test]
fn mensagem_bloqueada_nao_sai() {
    let (e, _d) = mk_engine("dm-bloqueada");
    let peer = peer_hex(0x99);
    let conv = e.open_dm(&peer, "peer").unwrap();
    e.friend_block(&peer).unwrap();
    let err = e.send_dm(&conv.id, "oi").unwrap_err().to_string();
    assert!(err.contains("bloqueado"), "{err}");
}

#[test]
fn contadores_por_membro_nao_vazam_entre_grupo() {
    let (e, _d) = mk_engine("contadores");
    let peer_a = peer_hex(0xaa);
    let peer_b = peer_hex(0xbb);
    let conv = e
        .store
        .create_group_dm(
            &e.identity.fingerprint,
            &[peer_a.clone(), peer_b.clone()],
            "g",
        )
        .unwrap();
    // Autoria do OUTRO membro: a própria mensagem nunca conta como não lida para quem a escreveu.
    let msg = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, "oi");
    let mut recebida = msg.clone();
    recebida.author_fp = peer_a.clone();
    e.store.insert_message(&recebida, "in", "ok").unwrap();

    let me = &e.identity.fingerprint;
    assert_eq!(e.store.unread_count_for(&conv.id, me).unwrap(), 1);
    e.store.conv_read_set(&conv.id, me, recebida.ts).unwrap();
    assert_eq!(e.store.unread_count_for(&conv.id, me).unwrap(), 0);
    assert_eq!(
        e.store.unread_count_for(&conv.id, &peer_b).unwrap(),
        1,
        "a leitura de um membro não marca para o outro"
    );
}

#[test]
fn mencao_e_registrada_por_destinatario() {
    let (e, _d) = mk_engine("mencoes");
    let alvo = peer_hex(0xcc);
    let autor = peer_hex(0xcc + 1);
    let meu = e.identity.fingerprint.clone();
    let conv = e
        .store
        .create_group_dm(&meu, &[alvo.clone(), autor.clone()], "g")
        .unwrap();
    let body = format!("oi @{alvo} e @{meu}");
    let mut msg = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, &body);
    msg.author_fp = autor;
    e.store.insert_message(&msg, "in", "ok").unwrap();
    for t in e.store.mention_targets(&body) {
        e.store.mention_add(&msg.id, &conv.id, &t).unwrap();
    }
    assert_eq!(e.store.unread_mentions_for(&meu).unwrap(), 1);
    assert_eq!(e.store.unread_mentions_for(&alvo).unwrap(), 1);
    e.store.conv_read_set(&conv.id, &meu, msg.ts).unwrap();
    assert_eq!(e.store.unread_mentions_for(&meu).unwrap(), 0);
}

#[test]
fn busca_unread_respeita_cursor_por_conversa() {
    let (e, _d) = mk_engine("busca-unread");
    let peer = peer_hex(0xd0);
    let conv = e.open_dm(&peer, "peer").unwrap();
    let mut antes = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, "antiga");
    antes.ts = 1_000;
    antes.author_fp = peer.clone();
    let mut depois = crate::protocol::MessageEnvelope::new(&e.keypair, &conv.id, "nova");
    depois.ts = 2_000;
    depois.author_fp = peer.clone();
    e.store.insert_message(&antes, "in", "ok").unwrap();
    e.store.insert_message(&depois, "in", "ok").unwrap();

    let mut q = crate::social::SearchQuery {
        has: "unread".into(),
        me: e.identity.fingerprint.clone(),
        ..Default::default()
    };
    assert_eq!(e.store.message_search(&q).unwrap().len(), 2);

    e.store
        .conv_read_set(&conv.id, &e.identity.fingerprint, antes.ts)
        .unwrap();
    let hits = e.store.message_search(&q).unwrap();
    assert_eq!(hits.len(), 1, "só a mensagem posterior ao cursor");
    assert_eq!(hits[0].id, depois.id);

    q.has.clear();
    q.text = "antiga".into();
    assert_eq!(
        e.store.message_search(&q).unwrap().len(),
        1,
        "busca textual continua enxergando o histórico lido"
    );
}

#[test]
fn mensagem_de_amigo_com_conversa_apagada_recria_a_dm_nao_um_grupo() {
    let (e, _d) = mk_engine("dm-apagada");
    // Peer real: a assinatura é verificada contra a pubkey da sessão.
    let kp_amigo = Keypair::generate();
    let amigo = kp_amigo.fingerprint();
    e.store.accept_friend(&amigo, "amigo").unwrap();
    let conv = e.open_dm(&amigo, "amigo").unwrap();
    // Usuário apaga a conversa local; a amizade continua.
    e.store.delete_conversation(&conv.id).unwrap();
    assert!(e.store.get_conversation(&conv.id).unwrap().is_none());

    let env = crate::protocol::MessageEnvelope::new(&kp_amigo, &conv.id, "oi");
    perfil_block_on(frames::handle_frame(
        &e,
        &amigo,
        &kp_amigo.public_hex(),
        "amigo",
        SecureFrame::Msg(env),
    ))
    .unwrap();

    let recriada = e
        .store
        .get_conversation(&conv.id)
        .unwrap()
        .expect("DM volta");
    assert_eq!(recriada.kind, "dm", "não pode virar grupo de 1 pessoa");
}

#[test]
fn grupo_so_e_gerenciado_pelo_criador() {
    let (e, _d) = mk_engine("dono-grupo");
    let outro = peer_hex(0xdd);
    let conv = e
        .store
        .create_group_dm(&e.identity.fingerprint, &[outro.clone()], "g")
        .unwrap();
    // O dono é quem criou (eu), não o primeiro do roster ordenado. Um membro comum tentando reescrever o grupo tem de ser ignorado.
    let r = frames::handle_frame(
        &e,
        &outro,
        "pk",
        "outro",
        SecureFrame::GroupCreated {
            conv_id: conv.id.clone(),
            title: "sequestrado".into(),
            members: vec![(outro.clone(), "outro".into())],
            owner_fp: outro.clone(),
        },
    );
    assert!(perfil_block_on(r).is_ok());
    assert_ne!(
        e.store.get_conversation(&conv.id).unwrap().unwrap().title,
        "sequestrado"
    );
}

#[test]
fn forward_de_canal_exige_host_e_membro() {
    let (e, _d) = mk_engine("forward-guard");
    let estranho = peer_hex(0xee);
    let env = crate::protocol::MessageEnvelope::new(&e.keypair, "canal-alheio", "x");
    // Sem canal no banco, o frame cai no ramo de "contato": um desconhecido não pode injetar mensagem.
    let r = frames::handle_frame(
        &e,
        &estranho,
        "pk",
        "estranho",
        SecureFrame::Forward {
            conv_id: "conv".into(),
            channel_id: String::new(),
            env,
            from_label: "label".into(),
        },
    );
    assert!(perfil_block_on(r).is_err());
}

#[test]
fn adicionar_participante_exige_estar_na_chamada() {
    let (e, _d) = mk_engine("call-add-guard");
    let amigo = peer_hex(0xef);
    e.store.accept_friend(&amigo, "amigo").unwrap();
    let r = frames::handle_frame(
        &e,
        &amigo,
        "pk",
        "amigo",
        SecureFrame::CallAddParticipant {
            call_id: "call-inexistente".into(),
            fp: peer_hex(0xf0),
            kind: String::new(),
        },
    );
    assert!(
        perfil_block_on(r).is_err(),
        "sem estar na chamada, ninguém adiciona participante"
    );
}

#[test]
fn banir_exige_alvo_membro_e_nao_o_proprio() {
    let (e, _d) = mk_engine("ban-guard");
    let meu = e.identity.fingerprint.clone();
    let outsider = peer_hex(0xf1);
    // Eu sou o dono do servidor; recebo um ban de mim mesmo (frame forjado
    // por um peer que se diz dono não passa, mas o alvo tem de ser válido).
    e.store
        .create_community("cid1", "Servidor", &meu, &[])
        .unwrap();
    let r = frames::handle_frame(
        &e,
        &meu,
        "pk",
        "eu",
        SecureFrame::MemberBan {
            community_id: "cid1".into(),
            target_fp: outsider,
            until_ms: 0,
            reason: String::new(),
        },
    );
    assert!(
        perfil_block_on(r).is_err(),
        "banir quem não é membro tem de falhar"
    );
}

/// Fluxo completo com dois motores reais: pedido de A, aviso em B,
/// aceite em B e confirmação em A. Cada passo usa o MESMO frame que o
/// transporte usaria, então uma quebra de simetria aparece aqui.
#[tokio::test]
async fn ciclo_de_amizade_entre_dois_motores_termina_igual_nos_dois() {
    let (a, _da) = mk_engine("amizade-a");
    let (b, _db) = mk_engine("amizade-b");
    let fp_a = a.identity.fingerprint.clone();
    let fp_b = b.identity.fingerprint.clone();

    let outcome = a.friend_request(&fp_b).unwrap();
    assert_eq!(outcome, FriendOutcome::QueuedOffline, "sem link: enfileira");
    assert_eq!(
        a.store.get_friend(&fp_b).unwrap().map(|(_, s)| s),
        Some("pending_out".into())
    );

    // O pedido chega em B (o transporte entregaria este frame).
    frames::handle_frame(
        &b,
        &fp_a,
        "pk-a",
        "a",
        SecureFrame::FriendRequest {
            nickname: "a".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        b.store.get_friend(&fp_a).unwrap().map(|(_, s)| s),
        Some("pending_in".into())
    );

    // B aceita pelo comando local (que também emite o FriendAccept).
    b.friend_respond(&fp_a, true).unwrap();
    assert_eq!(
        b.store.get_friend(&fp_a).unwrap().map(|(_, s)| s),
        Some("accepted".into())
    );

    // O aceite chega em A.
    frames::handle_frame(
        &a,
        &fp_b,
        "pk-b",
        "b",
        SecureFrame::FriendAccept {
            nickname: "b".into(),
        },
    )
    .await
    .unwrap();

    for (quem, e, peer) in [("a", &a, &fp_b), ("b", &b, &fp_a)] {
        assert_eq!(
            e.store.get_friend(peer).unwrap().map(|(_, s)| s),
            Some("accepted".into()),
            "{quem} precisa terminar como amigo"
        );
    }
}

/// Remover de um lado chega ao outro e os dois terminam sem amizade.
#[tokio::test]
async fn remocao_propaga_e_nao_deixa_amizade_unilateral() {
    let (a, _da) = mk_engine("rm-a");
    let (b, _db) = mk_engine("rm-b");
    let fp_a = a.identity.fingerprint.clone();
    let fp_b = b.identity.fingerprint.clone();
    a.store.accept_friend(&fp_b, "b").unwrap();
    b.store.accept_friend(&fp_a, "a").unwrap();

    a.friend_remove(&fp_b).unwrap();
    frames::handle_frame(&b, &fp_a, "pk-a", "a", SecureFrame::FriendRemove)
        .await
        .unwrap();

    for (quem, e, peer) in [("a", &a, &fp_b), ("b", &b, &fp_a)] {
        assert!(
            !matches!(
                e.store.get_friend(peer).unwrap().map(|(_, s)| s),
                Some(s) if s == "accepted"
            ),
            "{quem} não pode continuar amigo depois da remoção"
        );
    }
}
