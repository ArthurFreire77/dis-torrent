//! Testes de penetração básicos da camada de segurança Storm:
//! MITM, replay, spoof de nome/autoria, flood, links, regras por servidor.
//!
//! Estratégia: MITM/replay/spoof exercem o handshake+envelope reais;
//! flood/dup/links/regras exercem o gate (spam_gate/server_rules_gate) via
//! dois engines reais em localhost quando há rede, e via Store+helpers
//! quando o foco é a decisão pura.

use forge_core::{antispam, identity::Keypair, moderation, names, protocol::MessageEnvelope};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// MITM: atacante no meio não consegue forjar mensagem do autor
// ---------------------------------------------------------------------------

#[test]
fn mitm_nao_forja_mensagem() {
    let alice = Keypair::generate();
    let mallory = Keypair::generate();
    let env = MessageEnvelope::new(&alice, "convX", "segredo");
    // Mallory tenta re-assinar com a própria chave mas mantendo author_fp de Alice
    let mut forged = env.clone();
    forged.sig = mallory.sign(&forge_core::protocol::message_sign_bytes(
        &env.id,
        &env.conv_id,
        &env.author_fp,
        &env.body,
        env.ts,
    ));
    // verificação com a pubkey REAL de Alice falha (sig é de Mallory)
    assert!(!forged.verify_with_pubkey(&alice.public_hex()));
    // e o vínculo fp↔pubkey impede Mallory de se passar por Alice
    assert!(!forge_core::identity::fingerprint_matches(
        &env.author_fp,
        &mallory.public_hex()
    ));
    // original passa
    assert!(env.verify_with_pubkey(&alice.public_hex()));
}

#[test]
fn handshake_transcript_amarrado_a_nonces_e_chaves() {
    // nonces/chaves diferentes → transcript diferente → assinatura não reutilizável
    let t1 = forge_core::protocol::handshake_transcript(
        "aa", &[1u8; 32], &[1u8; 16], "bb", &[2u8; 32], &[2u8; 16],
    );
    let t2 = forge_core::protocol::handshake_transcript(
        "aa", &[1u8; 32], &[9u8; 16], "bb", &[2u8; 32], &[2u8; 16],
    );
    assert_ne!(t1, t2);
    let a = Keypair::generate();
    let sig = a.sign(&t1);
    assert!(Keypair::verify(&a.public_hex(), &t1, &sig).unwrap());
    assert!(!Keypair::verify(&a.public_hex(), &t2, &sig).unwrap());
}

// ---------------------------------------------------------------------------
// Replay: envelope reenviado é detectado como duplicado pelo gate
// ---------------------------------------------------------------------------

#[test]
fn replay_e_duplicada_barrados() {
    let mut dup = antispam::DuplicateDetector::with_window_secs(60);
    assert!(!dup.check("fpA", "oi", 1000));
    // replay exato do mesmo corpo/autor dentro da janela
    assert!(dup.check("fpA", "oi", 2000));
    // autor diferente com mesmo texto NÃO é dup (grupos legítimos repetem)
    assert!(!dup.check("fpB", "oi", 3000));
}

// ---------------------------------------------------------------------------
// Spoof de nome: homoglifos, cargos, parecidos
// ---------------------------------------------------------------------------

#[test]
fn spoof_de_nome_barrado() {
    let p = names::NamePolicy::for_kind(names::NameKind::User);
    // cirílico 'а' no lugar do 'a'
    assert!(!names::validate_name(names::NameKind::User, "аdmin", &[], &p).ok);
    // imita cargo
    assert!(!names::validate_name(names::NameKind::User, "Moderador Storm", &[], &p).ok);
    // zero-width ghost
    assert!(!names::validate_name(names::NameKind::User, "ana\u{200B}", &["ana".into()], &p).ok);
    // parecido a 1 edição de existente
    let r = names::validate_name(names::NameKind::User, "marc0s", &["marcos".into()], &p);
    assert!(!r.ok);
    // legítimo passa e normaliza NFC
    let ok = names::validate_name(names::NameKind::User, "  Ana Souza  ", &[], &p);
    assert!(ok.ok);
    assert_eq!(ok.normalized, "Ana Souza");
}

// ---------------------------------------------------------------------------
// Flood: 11ª mensagem em 10s cai; janela nova libera
// ---------------------------------------------------------------------------

#[test]
fn flood_gate_via_engine_state() {
    // exercita a mesma política do spam_gate (10/10s) de forma determinística
    let mut r = antispam::RateLimiter::with_params(10, 10);
    for _ in 0..10 {
        assert!(r.check("peer").is_none());
    }
    assert!(r.check("peer").is_some());
}

// ---------------------------------------------------------------------------
// Links: malicioso cai, encurtador avisa (medium) / cai (high)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Regras por servidor: palavra própria, domínio, shadow-ban, permissão, audit
// ---------------------------------------------------------------------------

#[test]
fn regras_do_servidor_e_auditoria() {
    let mut rules = moderation::ServerRules::fresh("srv1");
    rules.spam_level = "high".into();
    rules.banned_words = vec!["vazou".into()];
    rules.blocked_domains = vec!["evil.gg".into()];
    assert!(moderation::check_text_against_rules("isso vazou ontem", &rules).is_some());
    assert!(moderation::check_text_against_rules("https://evil.gg/a", &rules).is_some());
    assert!(moderation::check_text_against_rules("https://bit.ly/a", &rules).is_some()); // high bloqueia shortener
    assert!(moderation::check_text_against_rules("bom dia", &rules).is_none());

    // permissão: dono sim, membro não, cargo com bit sim
    assert!(moderation::can_ban(true, false, 0));
    assert!(!moderation::can_ban(false, false, 0));
    assert!(moderation::can_ban(false, false, moderation::PERM_BAN));

    // auditoria: motivo sem HTML, id único
    let a = moderation::AuditEntry::new("srv1", "mod", "ban", "alvo", "<img src=x> flood");
    let b = moderation::AuditEntry::new("srv1", "mod", "ban", "alvo", "flood");
    assert!(!a.reason.contains('<'));
    assert_ne!(a.id, b.id);
}

// ---------------------------------------------------------------------------
// Persistência v5: rules + audit + reputação + reports sobrevivem ao reopen
// ---------------------------------------------------------------------------

#[test]
fn store_v5_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("sec.db");
    let mk = || forge_core::storage::Store::open(&path).unwrap();
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

// ---------------------------------------------------------------------------
// Fim-a-fim real: dois engines, mensagem válida passa, flood cai sem matar sessão
// ---------------------------------------------------------------------------

use forge_core::net::engine::{EngineEvent, NetworkEngine};
use forge_core::storage::Store;
use tempfile::TempDir;

fn spawn(nick: &str) -> (Arc<NetworkEngine>, Arc<Store>, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
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

    // amizade pelo fluxo real (regra v4.3: DM só entre amigos)
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

    // DM legítima entrega (cifrada + assinada)
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

    // flood: 15 msgs distintas — o gate do receptor derruba o excedente (10/10s)
    for i in 0..15 {
        let _ = a
            .send_dm(&conv.id, &format!("flood-msg-{i}-conteudo-unico-{i}"))
            .ok();
    }
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    // reputação do flooder caiu no receptor (flood -5 por msg excedente)
    let (_trust, score, _) = sb.get_reputation(&fpa).unwrap();
    assert!(score < 0, "flood deve derrubar reputação, score={score}");

    // sessão SOBREVIVEU ao flood: DM normal após a janela entrega de novo
    tokio::time::sleep(std::time::Duration::from_millis(9500)).await; // janela 10s limpa
    let conv_b = b.open_dm(&fpa, "alice").unwrap();
    let _ = b.send_dm(&conv_b.id, "sessão viva após flood").unwrap();
    let got2 = wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::MessageNew(m) if m.body == "sessão viva após flood"),
        std::time::Duration::from_secs(10),
    )
    .await;
    assert!(matches!(got2, EngineEvent::MessageNew(_)));

    // link malicioso vindo de peer autenticado é descartado (sem matar sessão).
    // checagem negativa por ausência no store (esperar evento que nunca vem
    // entraria em pânico por timeout — ausência é o resultado correto).
    let _ = a.send_dm(&conv.id, "clica https://grabify.link/xyz").ok();
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    let inbox_b = b.messages(&conv_b.id);
    assert!(
        inbox_b.iter().all(|m| !m.body.contains("grabify")),
        "link malicioso não pode chegar ao receptor"
    );
    // e a sessão segue viva depois de tudo: A recebe de volta
    let _ = b.send_dm(&conv_b.id, "ping final").unwrap();
    let got3 = wait_event(
        &mut ev_a,
        |e| matches!(e, EngineEvent::MessageNew(m) if m.body == "ping final"),
        std::time::Duration::from_secs(10),
    )
    .await;
    assert!(matches!(got3, EngineEvent::MessageNew(_)));
}
