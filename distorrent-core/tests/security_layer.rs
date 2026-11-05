use distorrent_core::{antispam, identity::Keypair, moderation, names, protocol::MessageEnvelope};
use std::sync::Arc;

#[test]
fn mitm_nao_forja_mensagem() {
    let alice = Keypair::generate();
    let mallory = Keypair::generate();
    let env = MessageEnvelope::new(&alice, "convX", "segredo");
    let mut forged = env.clone();
    forged.sig = mallory.sign(&distorrent_core::protocol::message_sign_bytes(
        &env.id,
        &env.conv_id,
        &env.author_fp,
        &env.body,
        env.ts,
    ));
    assert!(!forged.verify_with_pubkey(&alice.public_hex()));
    assert!(!distorrent_core::identity::fingerprint_matches(
        &env.author_fp,
        &mallory.public_hex()
    ));
    assert!(env.verify_with_pubkey(&alice.public_hex()));
}

#[test]
fn handshake_transcript_amarrado_a_nonces_e_chaves() {
    let t1 = distorrent_core::protocol::handshake_transcript(
        "aa", &[1u8; 32], &[1u8; 16], "bb", &[2u8; 32], &[2u8; 16],
    );
    let t2 = distorrent_core::protocol::handshake_transcript(
        "aa", &[1u8; 32], &[9u8; 16], "bb", &[2u8; 32], &[2u8; 16],
    );
    assert_ne!(t1, t2);
    let a = Keypair::generate();
    let sig = a.sign(&t1);
    assert!(Keypair::verify(&a.public_hex(), &t1, &sig).unwrap());
    assert!(!Keypair::verify(&a.public_hex(), &t2, &sig).unwrap());
}

#[test]
fn replay_e_duplicada_barrados() {
    let mut dup = antispam::DuplicateDetector::with_window_secs(60);
    assert!(!dup.check("fpA", "oi", 1000));
    assert!(dup.check("fpA", "oi", 2000));
    assert!(!dup.check("fpB", "oi", 3000));
}

#[test]
fn spoof_de_nome_barrado() {
    let p = names::NamePolicy::for_kind(names::NameKind::User);
    assert!(!names::validate_name(names::NameKind::User, "аdmin", &[], &p).ok);
    assert!(!names::validate_name(names::NameKind::User, "Moderador Storm", &[], &p).ok);
    assert!(!names::validate_name(names::NameKind::User, "ana\u{200B}", &["ana".into()], &p).ok);
    let r = names::validate_name(names::NameKind::User, "marc0s", &["marcos".into()], &p);
    assert!(!r.ok);
    let ok = names::validate_name(names::NameKind::User, "  Ana Souza  ", &[], &p);
    assert!(ok.ok);
    assert_eq!(ok.normalized, "Ana Souza");
}

#[test]
fn flood_gate_via_engine_state() {
    let mut r = antispam::RateLimiter::with_params(10, 10);
    for _ in 0..10 {
        assert!(r.check("peer").is_none());
    }
    assert!(r.check("peer").is_some());
}

#[test]
fn links_gate() {
    assert!(matches!(
        antispam::check_links("clica https://iplogger.org/x", &[]),
        antispam::LinkVerdict::Malicious(_)
    ));
    let ctx_med = antispam::InboundCtx {
        level: antispam::SpamLevel::Medium,
        trust: antispam::Trust::New,
        shadow_banned: false,
        extra_blocked_domains: &[],
        pow_required: false,
        pow_ok: true,
    };
    assert!(matches!(
        antispam::decide_inbound("veja https://bit.ly/x", &ctx_med),
        antispam::Verdict::Warn(_)
    ));
    let ctx_high = antispam::InboundCtx {
        level: antispam::SpamLevel::High,
        ..ctx_med
    };
    assert!(matches!(
        antispam::decide_inbound("veja https://bit.ly/x", &ctx_high),
        antispam::Verdict::Drop(_)
    ));
}

#[test]
fn regras_do_servidor_e_auditoria() {
    let mut rules = moderation::ServerRules::fresh("srv1");
    rules.spam_level = "high".into();
    rules.banned_words = vec!["vazou".into()];
    rules.blocked_domains = vec!["evil.gg".into()];
    assert!(moderation::check_text_against_rules("isso vazou ontem", &rules).is_some());
    assert!(moderation::check_text_against_rules("https://evil.gg/a", &rules).is_some());
    assert!(moderation::check_text_against_rules("https://bit.ly/a", &rules).is_some());
    assert!(moderation::check_text_against_rules("bom dia", &rules).is_none());

    assert!(moderation::can_ban(true, false, 0));
    assert!(!moderation::can_ban(false, false, 0));
    assert!(moderation::can_ban(false, false, moderation::PERM_BAN));

    let a = moderation::AuditEntry::new("srv1", "mod", "ban", "alvo", "<img src=x> flood");
    let b = moderation::AuditEntry::new("srv1", "mod", "ban", "alvo", "flood");
    assert!(!a.reason.contains('<'));
    assert_ne!(a.id, b.id);
}

#[test]
fn store_v5_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sec.db");
    let mk = || distorrent_core::storage::Store::open(&path).unwrap();
    {
        let s = mk();
        let mut rules = moderation::ServerRules::fresh("srv9");
        rules.banned_words = vec!["x".into()];
        rules.moderators = vec!["modfp".into()];
        s.set_server_rules(&rules).unwrap();
        s.append_audit(&moderation::AuditEntry::new(
            "srv9", "owner", "ban", "t", "spam",
        ))
        .unwrap();
        let (trust, score, _) = s.bump_reputation("fpZ", -50, true).unwrap();
        assert_eq!(trust, "banned");
        assert!(score < 0);
        s.file_report("r1", "rep", "fpZ", "srv9", "enchendo <b>o saco</b>")
            .unwrap();
        assert_eq!(s.open_reports_for("fpZ").unwrap().len(), 1);
        s.resolve_report("r1", "actioned").unwrap();
        assert!(s.open_reports_for("fpZ").unwrap().is_empty());
    }
    {
        let s = mk();
        let rules = s.get_server_rules("srv9").unwrap();
        assert_eq!(rules.banned_words, vec!["x".to_string()]);
        assert_eq!(s.list_audit("srv9", 10).unwrap().len(), 1);
        let (trust, _, reports) = s.get_reputation("fpZ").unwrap();
        assert_eq!(trust, "banned");
        assert_eq!(reports, 1);
    }
}

use distorrent_core::net::engine::{EngineEvent, NetworkEngine};
use distorrent_core::storage::Store;
use tempfile::TempDir;

fn spawn(nick: &str) -> (Arc<NetworkEngine>, Arc<Store>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("distorrent.db")).unwrap());
    let kp = Keypair::generate();
    let engine = NetworkEngine::new(
        store.clone(),
        kp,
        nick.to_string(),
        dir.path().to_path_buf(),
    );
    engine.start_with_discovery(false).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(150));
    (engine, store, dir)
}

// Seção 1: wait_event
async fn wait_event(
    rx: &mut tokio::sync::broadcast::Receiver<EngineEvent>,
    matches: impl Fn(&EngineEvent) -> bool,
    timeout: std::time::Duration,
) -> EngineEvent {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        assert!(!remaining.is_zero(), "timeout esperando evento");
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Ok(ev)) if matches(&ev) => return ev,
            Ok(Ok(_)) => continue,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(e)) => panic!("erro no canal de eventos: {e}"),
            Err(_) => panic!("timeout esperando evento"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn e2e_mensagem_valida_entrega_e_flood_nao_mata_sessao() {
    let (a, _sa, _da) = spawn("alice");
    let (b, sb, _db) = spawn("bob");
    let mut ev_a = a.subscribe();
    let mut ev_b = b.subscribe();

    let fpa = a.identity().fingerprint.clone();
    let fpb = b.identity().fingerprint.clone();
    let addr_b: std::net::SocketAddr = format!("127.0.0.1:{}", b.listen_port()).parse().unwrap();
    a.add_manual_peer(addr_b, Some(fpb.clone()));
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        std::time::Duration::from_secs(10),
    )
    .await;
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::PeerOnline { .. }),
        std::time::Duration::from_secs(10),
    )
    .await;

    a.friend_request(&fpb).unwrap();
    wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::FriendRequestIn { fp, .. } if fp == &fpa),
        std::time::Duration::from_secs(10),
    )
    .await;
    b.friend_respond(&fpa, true).unwrap();
    wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::FriendAccepted { fp, .. } if fp == &fpb),
        std::time::Duration::from_secs(10),
    )
    .await;

    let conv = a.open_dm(&fpb, "bob").unwrap();
    let stored = a.send_dm(&conv.id, "olá, mensagem legítima").unwrap();
    assert_eq!(stored.status, "sent");
    let got = wait_event(
        &mut ev_b,
        |e| matches!(e, EngineEvent::MessageNew(m) if m.body == "olá, mensagem legítima"),
        std::time::Duration::from_secs(10),
    )
    .await;
    assert!(matches!(got, EngineEvent::MessageNew(_)));

    for i in 0..15 {
        let _ = a
            .send_dm(&conv.id, &format!("flood-msg-{i}-conteudo-unico-{i}"))
            .ok();
    }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let (_trust, score, _) = sb.get_reputation(&fpa).unwrap();
    assert!(score < 0, "flood deve derrubar reputação, score={score}");

    tokio::time::sleep(std::time::Duration::from_millis(9500)).await;
    let conv_b = b.open_dm(&fpa, "alice").unwrap();
    let _ = b.send_dm(&conv_b.id, "sessão viva após flood").unwrap();
    let got2 = wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::MessageNew(m) if m.body == "sessão viva após flood"),
        std::time::Duration::from_secs(10),
    )
    .await;
    assert!(matches!(got2, EngineEvent::MessageNew(_)));

    let _ = a.send_dm(&conv.id, "clica https://grabify.link/xyz").ok();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let inbox_b = b.messages(&conv_b.id);
    assert!(
        inbox_b.iter().all(|m| !m.body.contains("grabify")),
        "link malicioso não pode chegar ao receptor"
    );
    let _ = b.send_dm(&conv_b.id, "ping final").unwrap();
    let got3 = wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::MessageNew(m) if m.body == "ping final"),
        std::time::Duration::from_secs(10),
    )
    .await;
    assert!(matches!(got3, EngineEvent::MessageNew(_)));
}
