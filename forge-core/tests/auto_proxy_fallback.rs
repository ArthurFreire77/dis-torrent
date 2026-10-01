//! Corrente de fallback automática de conexão (degrau 3): quando o direto
//! (TCP/STUN/hole punch) e o intermediário por peer (peer-relay) não
//! estabelecem, e existe um SOCKS5 configurado, o engine liga sozinho o modo
//! de privacidade `proxy` e avisa a UI.
//!
//! Aqui não há proxy real: o modo `proxy` apenas RECONFIGURA o relay para
//! rotear por SOCKS5 (fail-closed). Os testes exercitam a regra pura e o
//! caminho de decisão do engine (kv `privacy.mode` + evento) sem depender de
//! rede. O env é serializado por um Mutex (testes deste binário apenas).

use std::sync::{Arc, Mutex};

use forge_core::net::engine::{
    auto_proxy_should_switch, EngineEvent, NetworkEngine, AUTO_PROXY_FAILURE_THRESHOLD,
};
use forge_core::storage::Store;

// ---------------------------------------------------------------------------
// Regra PURA: auto_proxy_should_switch(mode, has_proxy, enabled,
// already_switched, failures)
// ---------------------------------------------------------------------------

#[test]
fn regra_pura_casos_obrigatorios() {
    let n = AUTO_PROXY_FAILURE_THRESHOLD;

    // normal + proxy + habilitado + 1ª vez + limiar → TROCA
    assert!(
        auto_proxy_should_switch("normal", true, true, false, n),
        "normal+proxy+{n} falhas deve trocar"
    );
    // encrypted (padrão) idem
    assert!(
        auto_proxy_should_switch("encrypted", true, true, false, n),
        "encrypted+proxy+{n} falhas deve trocar"
    );
    // sem proxy → NUNCA (fail-closed)
    assert!(
        !auto_proxy_should_switch("encrypted", false, true, false, n),
        "sem proxy configurado não troca"
    );
    // full (Tor) → NUNCA
    assert!(
        !auto_proxy_should_switch("full", true, true, false, n),
        "nunca sai de full (Tor)"
    );
    // já é proxy → não troca de novo
    assert!(
        !auto_proxy_should_switch("proxy", true, true, false, n),
        "já em proxy não troca"
    );
    // desabilitado por env → NUNCA
    assert!(
        !auto_proxy_should_switch("encrypted", true, false, false, n),
        "FORGE_AUTO_PROXY=0 desliga"
    );
    // já trocou (anti-flapping) → NUNCA
    assert!(
        !auto_proxy_should_switch("encrypted", true, true, true, n),
        "anti-flapping: não troca duas vezes"
    );
    // poucas falhas → ainda não
    assert!(
        !auto_proxy_should_switch("encrypted", true, true, false, n - 1),
        "abaixo do limiar não troca"
    );
    // modo desconhecido → fail-closed
    assert!(
        !auto_proxy_should_switch("desconhecido", true, true, false, n),
        "modo desconhecido = fail-closed"
    );
    // acima do limiar continua trocando
    assert!(auto_proxy_should_switch(
        "normal",
        true,
        true,
        false,
        n + 10
    ));
}

// ---------------------------------------------------------------------------
// Integração leve: caminho de decisão do engine (sem proxy real, sem runtime)
// ---------------------------------------------------------------------------

/// Serializa o acesso ao env do processo entre os testes deste binário.
static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Sobe um engine real só com store (não inicia runtime: os caminhos testados
/// — `privacy_set_mode` e `note_dial_failure` — são síncronos).
fn mk_engine(nick: &str) -> (Arc<NetworkEngine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("forge.db")).unwrap());
    let kp = forge_core::identity::Keypair::generate();
    let engine = NetworkEngine::new(store, kp, nick.to_string(), dir.path().to_path_buf());
    (engine, dir)
}

/// Roda `f` com `FORGE_PROXY_ADDR`/`FORGE_AUTO_PROXY` fixados e restaura depois.
fn with_env<F: FnOnce()>(proxy: Option<&str>, auto: Option<&str>, f: F) {
    let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    match proxy {
        Some(v) => std::env::set_var("FORGE_PROXY_ADDR", v),
        None => std::env::remove_var("FORGE_PROXY_ADDR"),
    }
    match auto {
        Some(v) => std::env::set_var("FORGE_AUTO_PROXY", v),
        None => std::env::remove_var("FORGE_AUTO_PROXY"),
    }
    f();
    std::env::remove_var("FORGE_PROXY_ADDR");
    std::env::remove_var("FORGE_AUTO_PROXY");
}

#[test]
fn com_proxy_troca_para_proxy_e_emite_evento() {
    // auto-proxy é OPT-IN: só com FORGE_AUTO_PROXY=1 o fallback automático age.
    with_env(Some("127.0.0.1:1080"), Some("1"), || {
        let (e, _d) = mk_engine("AutoProxyOn");
        assert_eq!(e.privacy_mode(), "encrypted", "default encrypted");
        let mut rx = e.subscribe();

        for _ in 0..AUTO_PROXY_FAILURE_THRESHOLD {
            e.note_dial_failure("peerX");
        }

        assert_eq!(e.privacy_mode(), "proxy", "após o limiar cai em proxy");
        // O evento informativo chega à UI (fake store/relay, sem rede).
        match rx.try_recv() {
            Ok(EngineEvent::ModeAutoSwitched { to, reason }) => {
                assert_eq!(to, "proxy");
                assert!(!reason.is_empty(), "reason deve ser informativo");
            }
            other => panic!("esperava ModeAutoSwitched, veio {other:?}"),
        }
    });
}

#[test]
fn sem_proxy_permanece_encrypted() {
    with_env(None, None, || {
        let (e, _d) = mk_engine("AutoProxyNoProxy");
        for _ in 0..(AUTO_PROXY_FAILURE_THRESHOLD + 4) {
            e.note_dial_failure("peerX");
        }
        assert_eq!(e.privacy_mode(), "encrypted", "sem proxy não troca");
    });
}

#[test]
fn modo_full_nunca_cai_para_proxy() {
    with_env(Some("127.0.0.1:1080"), Some("1"), || {
        let (e, _d) = mk_engine("AutoProxyFull");
        e.privacy_set_mode("full").unwrap();
        for _ in 0..(AUTO_PROXY_FAILURE_THRESHOLD + 4) {
            e.note_dial_failure("peerX");
        }
        assert_eq!(e.privacy_mode(), "full", "full (Tor) é terminal");
    });
}

#[test]
fn auto_proxy_desligado_nao_troca() {
    with_env(Some("127.0.0.1:1080"), Some("0"), || {
        let (e, _d) = mk_engine("AutoProxyDisabled");
        for _ in 0..(AUTO_PROXY_FAILURE_THRESHOLD + 4) {
            e.note_dial_failure("peerX");
        }
        assert_eq!(e.privacy_mode(), "encrypted", "FORGE_AUTO_PROXY=0 desliga");
    });
}

/// REGRA DE PRODUTO central: com proxy configurado mas SEM opt-in explícito
/// (env ausente), o fallback automático NUNCA dispara — proxy desativado por
/// padrão, nenhuma conexão passa por ele silenciosamente.
#[test]
fn default_desligado_sem_env_nao_troca() {
    with_env(Some("127.0.0.1:1080"), None, || {
        let (e, _d) = mk_engine("AutoProxyDefaultOff");
        for _ in 0..(AUTO_PROXY_FAILURE_THRESHOLD * 3) {
            e.note_dial_failure("peerX");
        }
        assert_eq!(
            e.privacy_mode(),
            "encrypted",
            "default: proxy NUNCA liga sozinho"
        );
    });
}

#[test]
fn anti_flapping_nao_troca_duas_vezes_no_cooldown() {
    with_env(Some("127.0.0.1:1080"), Some("1"), || {
        let (e, _d) = mk_engine("AutoProxyFlap");
        for _ in 0..AUTO_PROXY_FAILURE_THRESHOLD {
            e.note_dial_failure("peerX");
        }
        assert_eq!(e.privacy_mode(), "proxy");

        // Usuário reverte manualmente; novas falhas NÃO trocam de novo já
        // (cooldown por peer) — evita loop de troca.
        e.privacy_set_mode("encrypted").unwrap();
        for _ in 0..(AUTO_PROXY_FAILURE_THRESHOLD * 2) {
            e.note_dial_failure("peerX");
        }
        assert_eq!(e.privacy_mode(), "encrypted", "cooldown anti-flapping");
    });
}
