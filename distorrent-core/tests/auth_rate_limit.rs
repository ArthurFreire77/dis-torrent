use distorrent_core::authlimit::{AuthLimiter, Decision};
use distorrent_core::vault;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const MAX: u32 = 3;
const LOCKOUT: Duration = Duration::from_secs(60);
const WINDOW: Duration = Duration::from_secs(15 * 60);

fn limiter() -> AuthLimiter {
    AuthLimiter::with_params(WINDOW, MAX, LOCKOUT)
}

struct UnlockSim {
    limit: AuthLimiter,
    key: String,
    calls: AtomicUsize,
    argon2_calls: AtomicUsize,
    blob: Vec<u8>,
}

impl UnlockSim {
    fn new(fingerprint: &str) -> Self {
        Self::with_password(fingerprint, "certa-123")
    }

    fn with_password(fingerprint: &str, correct: &str) -> Self {
        Self {
            limit: limiter(),
            key: AuthLimiter::key(fingerprint, "desktop"),
            calls: AtomicUsize::new(0),
            argon2_calls: AtomicUsize::new(0),
            blob: vault::seal_secret(&"ab".repeat(32), correct).unwrap(),
        }
    }

    fn unlock(&self, password: &str) -> Result<String, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if let Decision::Blocked { retry_after } = self.limit.check(&self.key) {
            return Err(format!(
                "muitas tentativas incorretas. Tente de novo em {}s.",
                retry_after.as_secs().max(1)
            ));
        }
        self.argon2_calls.fetch_add(1, Ordering::SeqCst);
        match vault::open_sealed(&self.blob, password) {
            Ok(secret) => {
                self.limit.record_success(&self.key);
                Ok(secret)
            }
            Err(_) => {
                let out = self.limit.record_failure(&self.key);
                if out.locked_now {
                    let secs = out.retry_after.map(|d| d.as_secs()).unwrap_or(0).max(1);
                    return Err(format!(
                        "senha incorreta. Mais {secs}s de espera antes de tentar de novo."
                    ));
                }
                Err("senha incorreta".into())
            }
        }
    }
}

#[test]
fn tentativa_normal_desbloqueia() {
    let u = UnlockSim::with_password("fp-alice", "senha-correta-123");
    let id = u.unlock("senha-correta-123").unwrap();
    assert_eq!(id, "ab".repeat(32));
    assert_eq!(u.calls.load(Ordering::SeqCst), 1);
    assert_eq!(u.argon2_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn tres_tentativas_iguais_ainda_desbloqueiam() {
    let u = UnlockSim::new("fp-bob");
    assert_eq!(u.unlock("errada").unwrap_err(), "senha incorreta");
    assert_eq!(u.unlock("errada").unwrap_err(), "senha incorreta");
    assert!(u.unlock("certa-123").is_ok(), "a 3ª certa tem que entrar");
    assert_eq!(u.argon2_calls.load(Ordering::SeqCst), 3);
}

#[test]
fn quarta_tentativa_e_bloqueada_com_erro_explicito() {
    let u = UnlockSim::new("fp-carol");

    let mut ultima = String::new();
    for i in 1..=MAX {
        let e = u.unlock("errada").unwrap_err();
        assert!(
            e.starts_with("senha incorreta"),
            "tentativa {i} deveria responder 'senha incorreta', veio: {e}"
        );
        ultima = e;
    }
    assert_eq!(
        u.argon2_calls.load(Ordering::SeqCst),
        MAX as usize,
        "as {MAX} tentativas realmente chegaram ao verificador"
    );

    assert!(
        ultima.contains("incorreta") && ultima.contains("s de espera"),
        "a última aceita deve avisar da espera: {ultima}"
    );

    let antes = u.argon2_calls.load(Ordering::SeqCst);
    let e = u.unlock("certa-123").unwrap_err();
    assert!(
        e.contains("muitas tentativas"),
        "a 4ª deve dizer que está bloqueada: {e}"
    );
    assert!(e.contains("s."), "a 4ª deve dizer quanto tempo falta: {e}");
    assert_eq!(
        u.argon2_calls.load(Ordering::SeqCst),
        antes,
        "bloqueado não pode gastar Argon2"
    );
}

#[test]
fn bloqueio_impede_senha_correta() {
    let u = UnlockSim::new("fp-dave");
    for _ in 0..MAX {
        let _ = u.unlock("errada");
    }
    assert!(u.unlock("certa-123").is_err());
}

#[test]
fn guarda_e_checado_antes_do_argon2() {
    let u = UnlockSim::new("fp-erin");
    for _ in 0..MAX {
        let _ = u.unlock("errada");
    }
    let antes = u.argon2_calls.load(Ordering::SeqCst);
    for _ in 0..20 {
        let _ = u.unlock("certa-123");
    }
    assert_eq!(
        u.argon2_calls.load(Ordering::SeqCst),
        antes,
        "nenhum Argon2 pode rodar enquanto bloqueado"
    );
}

#[test]
fn refresh_da_pagina_nao_zera_o_limite() {
    let u = Arc::new(UnlockSim::new("fp-frank"));
    for _ in 0..MAX {
        let _ = u.unlock("errada");
    }
    for _ in 0..5 {
        let e = u.unlock("certa-123").unwrap_err();
        assert!(
            e.contains("muitas tentativas"),
            "refresh furou o limite: {e}"
        );
    }
}

#[test]
fn limiter_novo_e_o_unico_contorno() {
    let a = UnlockSim::new("fp-grace");
    for _ in 0..MAX {
        let _ = a.unlock("errada");
    }
    assert!(a.unlock("certa-123").is_err());

    let b = UnlockSim::new("fp-grace");
    assert!(
        b.unlock("certa-123").is_ok(),
        "processo reiniciado começa limpo — limitação conhecida e assumida"
    );
}

// Seção 1: test
#[test]
fn requisicoes_simultaneas_nao_furam_o_limite() {
    let u = Arc::new(UnlockSim::new("fp-heidi"));
    let respostas = Arc::new(Mutex::new(Vec::new()));

    let mut handles = Vec::new();
    for _ in 0..40 {
        let u = u.clone();
        let respostas = respostas.clone();
        handles.push(std::thread::spawn(move || {
            let r = u.unlock("errada");
            respostas.lock().unwrap().push(r);
        }));
    }
    for h in handles {
        h.join().unwrap();
    }

    let rs = respostas.lock().unwrap();
    assert_eq!(rs.len(), 40, "todas as threads responderam");
    assert!(
        rs.iter().all(|r| r.is_err()),
        "senha errada NUNCA desbloqueia, sob nenhuma concorrência"
    );

    for r in rs.iter() {
        let e = r.as_ref().unwrap_err();
        assert!(
            e.contains("senha incorreta") || e.contains("muitas tentativas"),
            "erro inesperado: {e}"
        );
    }
    drop(rs);

    assert!(
        matches!(u.limit.check(&u.key), Decision::Blocked { .. }),
        "após a rajada, o estado tem de estar bloqueado"
    );

    let argon_antes = u.argon2_calls.load(Ordering::SeqCst);
    let mut handles = Vec::new();
    for _ in 0..20 {
        let u = u.clone();
        handles.push(std::thread::spawn(move || {
            let _ = u.unlock("certa-123");
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    assert_eq!(
        u.argon2_calls.load(Ordering::SeqCst),
        argon_antes,
        "com o bloqueio ativo, nem a senha certa gasta Argon2"
    );
}

#[test]
fn caminhos_paralelos_nao_furam_um_o_outro() {
    let store = AuthLimiter::new();
    let fp = "fp-jane";

    let unlock = AuthLimiter::key(&format!("{fp}:unlock"), "desktop");
    let change = AuthLimiter::key(&format!("{fp}:change"), "desktop");
    let import = AuthLimiter::key(&format!("{fp}:stormvault"), "desktop");

    for _ in 0..MAX {
        store.record_failure(&unlock);
    }
    assert!(matches!(store.check(&unlock), Decision::Blocked { .. }));

    assert_eq!(store.check(&change), Decision::Allowed);
    for _ in 0..MAX {
        store.record_failure(&change);
    }
    assert!(matches!(store.check(&change), Decision::Blocked { .. }));

    assert_eq!(store.check(&import), Decision::Allowed);
    for _ in 0..MAX {
        store.record_failure(&import);
    }
    assert!(matches!(store.check(&import), Decision::Blocked { .. }));
}

#[test]
fn conta_diferente_nao_herda_bloqueio() {
    let store = AuthLimiter::new();
    let a = AuthLimiter::key("fp-kate:unlock", "desktop");
    let b = AuthLimiter::key("fp-leo:unlock", "desktop");
    for _ in 0..MAX {
        store.record_failure(&a);
    }
    assert!(matches!(store.check(&a), Decision::Blocked { .. }));
    assert_eq!(
        store.check(&b),
        Decision::Allowed,
        "conta B tem que entrar sem herdar o bloqueio da conta A"
    );
    assert_eq!(store.remaining(&b), MAX);
}

#[test]
fn erro_nao_contem_a_senha() {
    let senha_certa = "senha-ultra-secreta-9999";
    let u = UnlockSim::with_password("fp-mia", senha_certa);
    for _ in 0..MAX + 2 {
        if let Err(e) = u.unlock("senha-errada-7777") {
            assert!(
                !e.contains("senha-ultra-secreta-9999"),
                "erro vazou a senha: {e}"
            );
            assert!(
                !e.contains("senha-errada-7777"),
                "erro vazou a tentativa: {e}"
            );
        }
    }
}

#[test]
fn estado_do_limiter_nao_guarda_o_segredo() {
    let l = limiter();
    let k = AuthLimiter::key("fp-noah:unlock", "desktop");
    let _ = l.record_failure(&k);
    let dump = format!("{:?}", l);
    assert!(
        !dump.contains("senha"),
        "Debug do limiter pode conter segredo: {dump}"
    );
    let d = match l.check(&k) {
        Decision::Blocked { retry_after } => format!("{}", retry_after.as_secs()),
        Decision::Allowed => "0".into(),
    };
    assert!(d.chars().all(|c| c.is_ascii_digit()));
}

#[test]
fn cofre_real_nao_vaza_o_segredo_no_erro() {
    let blob = vault::seal_secret(&"cd".repeat(32), "correta-123").unwrap();
    let e = vault::open_sealed(&blob, "errada").unwrap_err().to_string();
    assert_eq!(e, "crypto: senha incorreta");
    assert!(!e.contains("errada"));
    assert!(!e.contains("correta-123"));
}

#[test]
fn orcamento_e_tres_nao_mais_nem_menos() {
    let l = limiter();
    let k = AuthLimiter::key("fp-pam:unlock", "desktop");
    assert_eq!(l.remaining(&k), MAX, "começa com o orçamento cheio");

    for (i, esperada) in [MAX - 1, MAX - 2, MAX - 3].into_iter().enumerate() {
        let out = l.record_failure(&k);
        let tentativa = i + 1;
        assert_eq!(
            out.remaining, esperada,
            "após {tentativa}ª falha restam {esperada}"
        );
        assert_eq!(
            out.locked_now,
            tentativa == MAX as usize,
            "só a última falha instala o bloqueio"
        );
    }
    assert!(
        matches!(l.check(&k), Decision::Blocked { .. }),
        "a 4ª está bloqueada"
    );
}
// Seção 2: fim
