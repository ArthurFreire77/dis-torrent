// Testes do motor (declarados por #[path] em engine.rs): usam os internos
// privados do modulo, por isso moram no mesmo pai.

use super::engine_tests_support::*;
use super::*;
use crate::net::relay::MemRelay;
use crate::storage::Store;
#[tokio::test]
async fn reacoes_rejeitadas_nao_persistem_nem_sao_ecoada() {
    let (e, _dir) = mk_engine("ReactionLimit");
    let peer = "peer-autenticado";
    let outro_membro = "peer-destino";
    e.store.set_friend(peer, "", "accepted").unwrap();
    let conv = e
        .store
        .create_group_dm(
            &e.identity.fingerprint,
            &[peer.to_string(), outro_membro.to_string()],
            "teste de rate limit",
        )
        .unwrap();
    let mut events = e.subscribe();
    let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();

    let msg_ids: Vec<String> = (0..6)
        .map(|i| {
            let message = crate::protocol::MessageEnvelope::new(
                &e.keypair,
                &conv.id,
                &format!("mensagem {i}"),
            );
            e.store.insert_message(&message, "in", "ok").unwrap();
            message.id
        })
        .collect();

    for msg_id in msg_ids.iter().take(5) {
        frames::handle_frame(
            &e,
            peer,
            "",
            "peer",
            SecureFrame::React {
                conv_id: conv.id.clone(),
                msg_id: msg_id.clone(),
                emoji: "🔥".into(),
                add: true,
                reactor_fp: "vitima-falsificada".into(),
            },
        )
        .await
        .unwrap();
    }

    frames::handle_frame(
        &e,
        peer,
        "",
        "peer",
        SecureFrame::React {
            conv_id: conv.id.clone(),
            msg_id: msg_ids[0].clone(),
            emoji: "🔥".into(),
            add: true,
            reactor_fp: "vitima-falsificada".into(),
        },
    )
    .await
    .unwrap();

    frames::handle_frame(
        &e,
        peer,
        "",
        "peer",
        SecureFrame::React {
            conv_id: conv.id.clone(),
            msg_id: "msg-inexistente".into(),
            emoji: "🔥".into(),
            add: true,
            reactor_fp: "vitima-falsificada".into(),
        },
    )
    .await
    .unwrap();

    frames::handle_frame(
        &e,
        peer,
        "",
        "peer",
        SecureFrame::React {
            conv_id: conv.id.clone(),
            msg_id: msg_ids[5].clone(),
            emoji: "🔥".into(),
            add: true,
            reactor_fp: "vitima-falsificada".into(),
        },
    )
    .await
    .unwrap();

    let stored = e.store.reactions_for_msg(&msg_ids[0]).unwrap();
    assert_eq!(stored[0].reactors, vec![peer.to_string()]);
    assert!(e
        .store
        .reactions_for_msg("msg-inexistente")
        .unwrap()
        .is_empty());
    assert!(e.store.reactions_for_msg(&msg_ids[5]).unwrap().is_empty());

    let mut emitted = 0;
    while let Ok(event) = events.try_recv() {
        if matches!(event, EngineEvent::ReactionChanged { .. }) {
            emitted += 1;
        }
    }
    assert_eq!(emitted, 5, "duplicata e rejeição não emitem eventos");

    let mut relayed = 0;
    while let Ok(command) = commands.try_recv() {
        if matches!(command, EngineCmd::SendToPeer(_, SecureFrame::React { .. })) {
            relayed += 1;
        }
    }
    assert_eq!(relayed, 5, "duplicata e rejeição não são retransmitidas");
}

#[test]
fn relay_kill_switch_desliga_e_religa() {
    let (e, _d) = mk_engine("KillSwitch");
    assert!(
        !e.relay_is_disabled(),
        "relay deve vir LIGADO por padrao (fallback CGNAT)"
    );
    assert!(relay_allowed(&e), "default: relay ligado");
    e.set_relay_disabled(true);
    assert!(!relay_allowed(&e), "flag deve desligar o relay");
    e.set_relay_disabled(false);
    assert!(relay_allowed(&e), "flag desligada religa o relay");
}

#[test]
fn relay_default_fail_open() {
    assert!(env_relay_enabled(), "sem DISTORRENT_RELAY: relay LIGADO");
    for v in ["0", "false", "no", "off"] {
        std::env::set_var("DISTORRENT_RELAY", v);
        assert!(!env_relay_enabled(), "DISTORRENT_RELAY={v} desliga");
    }
    std::env::set_var("DISTORRENT_RELAY", "1");
    assert!(env_relay_enabled(), "DISTORRENT_RELAY=1 liga");
    std::env::remove_var("DISTORRENT_RELAY");
    std::env::set_var("DISTORRENT_NO_RELAY", "1");
    assert!(!env_relay_enabled(), "DISTORRENT_NO_RELAY=1 kill-switch");
    std::env::remove_var("DISTORRENT_NO_RELAY");
}

#[test]
fn backend_injetado_nao_desliga_sozinho() {
    let (e, _d) = mk_engine("Injected");
    e.set_relay_backend(Arc::new(MemRelay::new()));
    assert!(relay_allowed(&e));
    e.set_relay_disabled(true);
    assert!(!relay_allowed(&e));
}

#[test]
fn punch_kill_switch_liga_e_desliga() {
    let (e, _d) = mk_engine("PunchSwitch");
    assert!(e.punch_enabled());
    e.set_punch_enabled(false);
    assert!(
        !e.punch_enabled(),
        "DISTORRENT_PUNCH=0 deve desligar o furo"
    );
    e.set_punch_enabled(true);
    assert!(e.punch_enabled(), "deve religar");
}

#[test]
fn punch_flag_value_parsing() {
    assert!(punch_flag_value(None), "default = ligado");
    assert!(punch_flag_value(Some("1")));
    assert!(punch_flag_value(Some("yes")));
    assert!(punch_flag_value(Some("TRUE")));
    assert!(!punch_flag_value(Some("0")));
    assert!(!punch_flag_value(Some("false")));
    assert!(!punch_flag_value(Some("no")));
    assert!(!punch_flag_value(Some("off")));
    assert!(!punch_flag_value(Some(" OFF ")));
}

#[test]
fn keepalive_direto_dentro_de_30s() {
    assert!(PING_INTERVAL <= Duration::from_secs(30));
    assert!(NAT_RENEW_INTERVAL < Duration::from_secs(3600));
}

#[tokio::test]
async fn peer_relay_intermediario_put_get_data() {
    let (relay, _d) = mk_engine("PeerRelayC");
    relay.set_peer_relay_enabled(true);
    relay.start_with_discovery(false).unwrap();
    let topic = "distorrent_r_peerB";

    let (tx_b, mut rx_b) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    relay.links.lock().unwrap().insert(
        "peerB".into(),
        Arc::new(PeerLink {
            state: StdMutex::new(PeerLinkState::Online),
            tx: Some(tx_b),
            drop_notify: Notify::new(),
            via_relay: false,
            initiator: false,
        }),
    );

    frames::handle_frame(
        &relay,
        "peerA",
        "pkA",
        "A",
        SecureFrame::PeerRelayPut {
            topic: topic.into(),
            body: "CIFRADO".into(),
        },
    )
    .await
    .unwrap();

    frames::handle_frame(
        &relay,
        "peerB",
        "pkB",
        "B",
        SecureFrame::PeerRelayGet {
            req_id: 42,
            topic: topic.into(),
        },
    )
    .await
    .unwrap();
    let mut resp = None;
    for _ in 0..200 {
        match rx_b.try_recv() {
            Ok((_, SecureFrame::PeerRelayData { req_id: 42, bodies })) => {
                resp = Some(bodies);
                break;
            }
            Ok(_) => continue,
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert_eq!(
        resp.expect("C deveria responder"),
        vec!["CIFRADO".to_string()]
    );

    frames::handle_frame(
        &relay,
        "peerB",
        "pkB",
        "B",
        SecureFrame::PeerRelayGet {
            req_id: 43,
            topic: topic.into(),
        },
    )
    .await
    .unwrap();
    let mut resp2 = None;
    for _ in 0..200 {
        match rx_b.try_recv() {
            Ok((_, SecureFrame::PeerRelayData { req_id: 43, bodies })) => {
                resp2 = Some(bodies);
                break;
            }
            Ok(_) => continue,
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
    assert!(resp2.expect("C deveria responder vazio").is_empty());
    relay.shutdown();
}

#[tokio::test]
async fn peer_relay_backend_post_e_deliver() {
    let (a, _d) = mk_engine("PeerRelayClient");
    a.set_relay_backend(Arc::new(MemRelay::new()));
    a.start_with_discovery(false).unwrap();

    let (tx_c, mut rx_c) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    a.links.lock().unwrap().insert(
        "relayC".into(),
        Arc::new(PeerLink {
            state: StdMutex::new(PeerLinkState::Online),
            tx: Some(tx_c),
            drop_notify: Notify::new(),
            via_relay: false,
            initiator: false,
        }),
    );

    let backend = Arc::new(PeerRelayBackend::new(Arc::downgrade(&a), "relayC".into()));
    backend.post("distorrent_r_dest", "opaco").await.unwrap();
    let mut put = None;
    for _ in 0..100 {
        if let Ok((_, f)) = rx_c.try_recv() {
            put = Some(f);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    match put.expect("intermediário deveria receber PeerRelayPut") {
        SecureFrame::PeerRelayPut { topic, body } => {
            assert_eq!(topic, "distorrent_r_dest");
            assert_eq!(body, "opaco");
        }
        other => panic!("frame inesperado: {other:?}"),
    }

    let b2 = backend.clone();
    let handle = tokio::spawn(async move { b2.poll("distorrent_r_meu").await });
    let mut req_id = None;
    for _ in 0..100 {
        if let Ok((_, SecureFrame::PeerRelayGet { req_id: r, topic })) = rx_c.try_recv() {
            assert_eq!(topic, "distorrent_r_meu");
            req_id = Some(r);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let req_id = req_id.expect("deveria haver PeerRelayGet");
    assert!(
        backend.pending_len() >= 1,
        "poll deveria ter oneshot pendente"
    );
    assert!(backend.deliver(req_id, vec!["resposta".into()]));
    let out = handle.await.unwrap().unwrap();
    assert_eq!(out, vec!["resposta".to_string()]);
    a.shutdown();
}

#[test]
fn peer_relay_selecao_respeita_privacidade_e_kill_switch() {
    let (e, _d) = mk_engine("PeerRelaySelect");
    let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    e.links.lock().unwrap().insert(
        "peerC".into(),
        Arc::new(PeerLink {
            state: StdMutex::new(PeerLinkState::Online),
            tx: Some(tx),
            drop_notify: Notify::new(),
            via_relay: false,
            initiator: false,
        }),
    );

    e.set_peer_relay_enabled(true);
    e.refresh_peer_relay();
    assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));

    e.privacy_set_mode("proxy").unwrap();
    e.refresh_peer_relay();
    assert_eq!(e.peer_relay_fp(), None, "proxy nao usa peer-relay");

    e.privacy_set_mode("encrypted").unwrap();
    e.refresh_peer_relay();
    assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));

    e.set_relay_disabled(true);
    e.refresh_peer_relay();
    assert_eq!(e.peer_relay_fp(), None, "kill-switch desliga peer-relay");
    e.set_relay_disabled(false);
    e.refresh_peer_relay();
    assert_eq!(e.peer_relay_fp().as_deref(), Some("peerC"));
}

#[tokio::test]
async fn peer_relay_data_so_do_intermediario() {
    let (e, _d) = mk_engine("DataGuard");
    e.set_peer_relay_enabled(true);
    let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    e.links.lock().unwrap().insert(
        "mid".into(),
        Arc::new(PeerLink {
            state: StdMutex::new(PeerLinkState::Online),
            tx: Some(tx),
            drop_notify: Notify::new(),
            via_relay: false,
            initiator: false,
        }),
    );
    e.refresh_peer_relay();
    assert_eq!(e.peer_relay_fp().as_deref(), Some("mid"));
    e.start_with_discovery(false).unwrap();

    let backend = e.peer_relay_backend_for("mid");
    let fut = backend.poll("distorrent_r_mid");
    let ids = backend.pending_req_ids();
    assert_eq!(ids.len(), 1, "deveria haver 1 pedido pendente");
    let req_id = ids[0];

    frames::handle_frame(
        &e,
        "atacante",
        "pkX",
        "X",
        SecureFrame::PeerRelayData {
            req_id,
            bodies: vec!["roubado".into()],
        },
    )
    .await
    .unwrap();
    assert_eq!(backend.pending_len(), 1, "não-intermediário não entrega");

    frames::handle_frame(
        &e,
        "mid",
        "pkM",
        "M",
        SecureFrame::PeerRelayData {
            req_id,
            bodies: vec!["ok".into()],
        },
    )
    .await
    .unwrap();
    assert_eq!(backend.pending_len(), 0, "intermediário entrega");
    assert_eq!(fut.await.unwrap(), vec!["ok".to_string()]);
}

#[test]
fn peer_relay_nao_elege_bloqueado() {
    let (e, _d) = mk_engine("BlockElect");
    e.set_peer_relay_enabled(true);
    let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    e.links.lock().unwrap().insert(
        "blockedPeer".into(),
        Arc::new(PeerLink {
            state: StdMutex::new(PeerLinkState::Online),
            tx: Some(tx),
            drop_notify: Notify::new(),
            via_relay: false,
            initiator: false,
        }),
    );
    e.store.set_friend("blockedPeer", "", "blocked").unwrap();
    e.refresh_peer_relay();
    assert_eq!(
        e.peer_relay_fp(),
        None,
        "bloqueado não pode ser intermediário"
    );
}

#[test]
fn nat_endpoint_serializa_sem_sufixo_ev() {
    let ev = EngineEvent::NatEndpoint {
        addr: "203.0.113.7:51234".into(),
        source: "upnp".into(),
    };
    let v = serde_json::to_value(&ev).unwrap();
    assert_eq!(v.get("type").and_then(|t| t.as_str()), Some("nat_endpoint"));
    assert_eq!(
        v.get("addr").and_then(|a| a.as_str()),
        Some("203.0.113.7:51234")
    );
    assert_eq!(v.get("source").and_then(|s| s.as_str()), Some("upnp"));
}

#[test]
fn dht_announce_port_so_externa_confirmada() {
    let (e, _d) = mk_engine("DhtPort");
    assert_eq!(e.dht_announce_port(), None);
    e.nat_external_port.store(45678, Ordering::Relaxed);
    assert_eq!(e.dht_announce_port(), Some(45678));
    assert_ne!(e.dht_announce_port(), Some(e.listen_port()));
    e.set_public_addr("203.0.113.7:51234".to_string());
    assert_eq!(e.dht_announce_port(), Some(51234));
    e.set_public_addr("lixo".to_string());
    assert_eq!(e.dht_announce_port(), Some(45678));
}

#[test]
fn peer_diag_bound_512_mantem_recentes() {
    let (e, _d) = mk_engine("DiagBound");
    for i in 0..600 {
        e.diag_update(&format!("fp{i:04}"), |d| {
            d.direct_attempts = i as u64;
        });
    }
    let len = e.peer_diag.lock().unwrap().len();
    assert_eq!(len, 512, "mapa deve ficar em 512, achou {len}");
    let map = e.peer_diag.lock().unwrap();
    assert!(map.contains_key("fp0599"), "mais recente fica");
    assert!(!map.contains_key("fp0000"), "mais antigo sai");
}

#[cfg(target_os = "linux")]
#[test]
fn identificador_de_amigo_aceita_fingerprint_e_chave_publica() {
    // 12 hex = já é o fingerprint: passa como está.
    assert_eq!(
        NetworkEngine::normalize_peer_id("  A1B2C3D4E5F6 ").unwrap(),
        "a1b2c3d4e5f6"
    );
    // 64 hex = chave pública: o fingerprint é derivado dela (é o que a tela de perfil oferece em "copiar identidade").
    let kp = Keypair::generate();
    let pk = kp.public_hex();
    assert_eq!(
        NetworkEngine::normalize_peer_id(&pk).unwrap(),
        kp.fingerprint(),
        "colar a chave pública tem de achar o mesmo peer"
    );
    // Prefixo do esquema de convite também é aceito.
    assert_eq!(
        NetworkEngine::normalize_peer_id(&format!("distorrent:{pk}")).unwrap(),
        kp.fingerprint()
    );
    // Lixo continua recusado com mensagem que diz o que fazer.
    let erro = NetworkEngine::normalize_peer_id("abc")
        .unwrap_err()
        .to_string();
    assert!(
        erro.contains("12"),
        "a recusa precisa explicar o formato: {erro}"
    );
}

#[test]
#[cfg(target_os = "linux")]
fn call_offer_sem_sessao_nativa_vai_para_o_js() {
    let (e, _d) = engine_com_amigo("CoexistBrowser");
    let mut rx = e.subscribe();
    let call_id = "call-browser";
    let r = block_on(frames::handle_frame(
        &e,
        PEER,
        "pubkey",
        "Peer",
        offer_frame(call_id, "v=0\r\n".into()),
    ));
    assert!(r.is_ok(), "frame rejeitado: {r:?}");
    assert!(
        !e.voice_is_native(call_id, PEER),
        "par não registrado não pode virar sessão nativa"
    );
    if e.native_voice_available() {
        assert!(
            proximo_evento(&mut rx).is_none(),
            "offer pré-aceite retida não pode vazar para o JS"
        );
        assert!(e.voice_register(call_id, PEER));
        block_on(e.resume_held_call(call_id, PEER));
        assert!(
            proximo_evento(&mut rx).is_none(),
            "offer absorvida pela nativa não gera evento"
        );
        e.voice_hangup(call_id);
    } else {
        let ev = proximo_evento(&mut rx).expect("deve haver evento para o JS");
        assert!(
            ev.contains("CallOfferEv"),
            "sem sessão nativa o evento tem que ser CallOfferEv, veio: {ev}"
        );
    }
}

#[test]
#[cfg(target_os = "linux")]
fn call_offer_com_sessao_nativa_nao_vai_para_o_js() {
    let (e, _d) = engine_com_amigo("CoexistNative");
    let Some(v) = e.voice_media() else {
        return;
    };
    let mut rx = e.subscribe();
    let call_id = "call-native";
    e.voice_register(call_id, PEER);
    assert!(e.voice_is_native(call_id, PEER), "registro falhou");

    let oferta = v.create_offer("outra-call", "peer-fantasma").unwrap();
    let r = block_on(frames::handle_frame(
        &e,
        PEER,
        "pubkey",
        "Peer",
        offer_frame(call_id, oferta),
    ));
    assert!(r.is_ok(), "frame rejeitado: {r:?}");
    assert!(
        proximo_evento(&mut rx).is_none(),
        "sessão nativa absorveu o offer — o JS NÃO pode criar RTCPeerConnection"
    );
    v.hangup("outra-call");
    e.voice_hangup(call_id);
}

#[test]
#[cfg(target_os = "linux")]
fn offer_invalido_na_regressa_para_o_navegador() {
    let (e, _d) = engine_com_amigo("CoexistFallback");
    if e.voice_media().is_none() {
        return;
    }
    let mut rx = e.subscribe();
    let call_id = "call-lixo";
    e.voice_register(call_id, PEER);
    let r = block_on(frames::handle_frame(
        &e,
        PEER,
        "pubkey",
        "Peer",
        offer_frame(call_id, "isto-nao-e-um-sdp".into()),
    ));
    assert!(r.is_ok(), "frame rejeitado: {r:?}");
    let ev = proximo_evento(&mut rx).expect("SDP recusado tem de voltar ao JS");
    assert!(ev.contains("CallOfferEv"), "veio: {ev}");
    e.voice_hangup(call_id);
}

#[test]
#[cfg(target_os = "linux")]
fn registro_por_call_nao_vaza_para_outra() {
    let (e, _d) = engine_com_amigo("CoexistScope");
    if !e.voice_register("call-a", PEER) {
        return;
    }
    assert!(e.voice_is_native("call-a", PEER));
    assert!(
        !e.voice_is_native("call-b", PEER),
        "call_id diferente = sessão diferente"
    );
    assert!(
        !e.voice_is_native("call-a", "outro-peer"),
        "peer diferente = sessão diferente"
    );
    e.voice_hangup("call-a");
    assert!(
        !e.voice_is_native("call-a", PEER),
        "hangup limpa o registro"
    );
}

#[test]
#[cfg(target_os = "linux")]
fn sem_midia_nativa_nada_e_registrado() {
    let (e, _d) = mk_engine("SemMidia");
    if e.voice_media().is_some() {
        assert!(e.voice_register("c", "p"));
    } else {
        assert!(
            !e.voice_register("c", "p"),
            "sem mídia nativa nada pode ser registrado — o navegador assume"
        );
        assert!(!e.voice_is_native("c", "p"));
    }
}

#[test]
fn peer_relay_optin_value_parsing() {
    assert!(
        peer_relay_optin_value(None, None, false),
        "AUTO: ligado por padrão"
    );
    assert!(peer_relay_optin_value(Some("1"), None, false));
    assert!(peer_relay_optin_value(None, Some("true"), false));
    assert!(peer_relay_optin_value(Some("on"), None, false));
    assert!(
        !peer_relay_optin_value(Some("0"), None, false),
        "relay=0 desliga"
    );
    assert!(
        !peer_relay_optin_value(None, Some("off"), false),
        "peer=off desliga"
    );
    assert!(
        !peer_relay_optin_value(Some("1"), Some("1"), true),
        "no_relay desliga"
    );
}

#[test]
fn profile_set_remoto_emite_evento_quando_muda() {
    let (e, _d) = mk_engine("perfil-remoto");
    let autor = "fp-autor";
    let mut rx = e.subscribe();
    let r = perfil_block_on(frames::handle_frame(
        &e,
        autor,
        "pubkey",
        "Autor",
        SecureFrame::ProfileSet {
            display_name: "Autor Novo".into(),
            about: "bio".into(),
            avatar_b64: "QUJD".into(),
            banner_b64: String::new(),
            accent: "#ff0000".into(),
            rev: 1,
            content_hash: crate::social::profile_content_hash(
                "Autor Novo",
                "bio",
                "QUJD",
                "",
                "#ff0000",
            ),
        },
    ));
    assert!(r.is_ok(), "frame rejeitado: {r:?}");
    let p = e.store.profile_get(autor).unwrap();
    assert_eq!(p.display_name, "Autor Novo");
    assert_eq!(p.rev, 1);
    assert_eq!(p.accent, "#ff0000");
    let ev = rx
        .try_recv()
        .ok()
        .map(|e| format!("{e:?}"))
        .unwrap_or_default();
    assert!(ev.contains("ProfileChanged"), "evento esperado, veio: {ev}");
}

#[test]
fn profile_set_remoto_revisao_antiga_nao_emite_nem_sobrescreve() {
    let (e, _d) = mk_engine("perfil-antigo");
    let autor = "fp-autor2";
    for (rev, nome) in [(2i64, "Versão 2"), (1i64, "Versão 1 atrasada")] {
        let _ = perfil_block_on(frames::handle_frame(
            &e,
            autor,
            "pubkey",
            "Autor",
            SecureFrame::ProfileSet {
                display_name: nome.into(),
                about: String::new(),
                avatar_b64: String::new(),
                banner_b64: String::new(),
                accent: String::new(),
                rev,
                content_hash: String::new(),
            },
        ));
    }
    let p = e.store.profile_get(autor).unwrap();
    assert_eq!(p.display_name, "Versão 2", "rev antiga não pode vencer");
    assert_eq!(p.rev, 2);
}

#[test]
fn profile_set_com_hash_divergente_e_rejeitado() {
    let (e, _d) = mk_engine("perfil-hash");
    let autor = "fp-autor3";
    let r = perfil_block_on(frames::handle_frame(
        &e,
        autor,
        "pubkey",
        "Autor",
        SecureFrame::ProfileSet {
            display_name: "Nome".into(),
            about: String::new(),
            avatar_b64: String::new(),
            banner_b64: String::new(),
            accent: String::new(),
            rev: 1,
            content_hash: "0".repeat(32),
        },
    ));
    assert!(r.is_err(), "hash divergente tem que ser rejeitado");
    assert_eq!(
        e.store.profile_get(autor).unwrap().display_name,
        "",
        "perfil armazenado não pode ser corrompido"
    );
}

#[test]
fn profile_set_de_peer_bloqueado_e_ignorado() {
    let (e, _d) = mk_engine("perfil-bloqueio");
    // Fingerprint precisa ser hex de 12: o frame agora rejeita id
    // inválido antes de qualquer escrita, e o teste precisa exercitar o
    // caminho de BLOQUEIO, não o de validação.
    let autor = "b10c0ad00001";
    e.friend_block(autor).unwrap();
    let r = perfil_block_on(frames::handle_frame(
        &e,
        autor,
        "pubkey",
        "Bloqueado",
        SecureFrame::ProfileSet {
            display_name: "Invasor".into(),
            about: String::new(),
            avatar_b64: String::new(),
            banner_b64: String::new(),
            accent: String::new(),
            rev: 99,
            content_hash: String::new(),
        },
    ));
    assert!(r.is_ok(), "frame de bloqueado não derruba a sessão");
    assert_eq!(
        e.store.profile_get(autor).unwrap().display_name,
        "",
        "peer bloqueado não pode gravar perfil"
    );
}

#[test]
fn profile_set_no_teto_cabe_no_frame_e_no_relay() {
    let (e, _d) = mk_engine("perfil-frame");
    let avatar = "A".repeat(PROFILE_IMG_B64_MAX);
    let banner = "B".repeat(PROFILE_BANNER_B64_MAX);
    e.social_profile_set(
        "Nome de exibição",
        &"bio".repeat(100),
        &avatar,
        &banner,
        "#5865f2",
    )
    .unwrap();
    let p = e.store.profile_get(&e.identity.fingerprint).unwrap();
    let frame = profile_frame(&p);
    let json = serde_json::to_string(&frame).unwrap();

    assert!(
        json.len() < crate::net::transport::MAX_FRAME as usize,
        "ProfileSet de {} bytes estoura MAX_FRAME ({}): a sessão cai",
        json.len(),
        crate::net::transport::MAX_FRAME,
    );
    assert!(
        json.len() < crate::net::peer_relay::MAX_TOPIC_BYTES,
        "ProfileSet de {} bytes passa do orçamento por tópico do relay ({})",
        json.len(),
        crate::net::peer_relay::MAX_TOPIC_BYTES,
    );
    assert_eq!(p.avatar_b64.len(), PROFILE_IMG_B64_MAX);
    assert_eq!(p.banner_b64.len(), PROFILE_BANNER_B64_MAX);
}

#[test]
fn profile_query_responde_so_quando_temos_revisao_maior() {
    let (e, _d) = mk_engine("perfil-query");
    let me = e.identity.fingerprint.clone();
    e.social_profile_set("Meu Nome", "bio", "", "", "").unwrap();
    let minha_rev = e.store.profile_get(&me).unwrap().rev;
    assert!(minha_rev >= 1);

    let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();
    let _ = perfil_block_on(frames::handle_frame(
        &e,
        "peer-query",
        "pubkey",
        "Peer",
        SecureFrame::ProfileQuery {
            known_rev: minha_rev,
        },
    ));
    assert!(
        commands.try_recv().is_err(),
        "sem mudança não pode haver ProfileSet na fila"
    );

    let _ = perfil_block_on(frames::handle_frame(
        &e,
        "peer-query",
        "pubkey",
        "Peer",
        SecureFrame::ProfileQuery { known_rev: 0 },
    ));
    let mut enviou = false;
    while let Ok(cmd) = commands.try_recv() {
        if let EngineCmd::SendToPeer(_, SecureFrame::ProfileSet { .. }) = cmd {
            enviou = true;
        }
    }
    assert!(enviou, "peer desatualizado precisa receber o ProfileSet");
}

#[test]
fn profile_query_leva_a_revisao_do_peer_e_nao_a_minha() {
    let (e, _d) = mk_engine("perfil-known-rev");
    let me = e.identity.fingerprint.clone();
    let peer = "peer-alvo".to_string();

    for i in 0..3 {
        let _ = e
            .store
            .profile_set_local(&me, "eu", &format!("bio {i}"), "", "", "", false, false);
    }
    let _ = e
        .store
        .profile_set_local(&peer, "amigo", "bio do amigo", "", "", "", false, false);
    assert_eq!(e.store.profile_get(&me).unwrap().rev, 3);
    assert_eq!(e.store.profile_get(&peer).unwrap().rev, 1);

    let (tx, _rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    e.links.lock().unwrap().insert(
        peer.clone(),
        Arc::new(PeerLink {
            state: StdMutex::new(PeerLinkState::Online),
            tx: Some(tx),
            drop_notify: Notify::new(),
            via_relay: false,
            initiator: false,
        }),
    );

    let mut commands = e.cmd_rx.lock().unwrap().take().unwrap();
    e.sync_profiles_with_peers();
    let mut known = None;
    while let Ok(cmd) = commands.try_recv() {
        if let EngineCmd::SendToPeer(dest, SecureFrame::ProfileQuery { known_rev }) = cmd {
            if dest == peer {
                known = Some(known_rev);
            }
        }
    }
    assert_eq!(
        known,
        Some(1),
        "a pergunta deve citar a revisão DO PEER (1), nunca a minha (3) — \
             com a minha o peer não responde e o perfil/foto nunca chega"
    );
}

#[test]
fn social_profile_set_local_emite_evento_e_incrementa_revisao() {
    let (e, _d) = mk_engine("perfil-local");
    let mut rx = e.subscribe();
    let p = e.social_profile_set("Eu Mesmo", "bio", "", "", "").unwrap();
    assert_eq!(p.rev, 1);
    let ev = rx
        .try_recv()
        .ok()
        .map(|e| format!("{e:?}"))
        .unwrap_or_default();
    assert!(
        ev.contains("ProfileChanged"),
        "o próprio usuário precisa ser notificado (causa do avatar velho): {ev}"
    );
    let p2 = e.social_profile_set("Eu Mesmo", "bio", "", "", "").unwrap();
    assert_eq!(p2.rev, 1);
}
