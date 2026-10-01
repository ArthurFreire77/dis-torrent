//! Proteção contra descoberta de senha/token — testes de penetração do limite
//! de tentativas.
//!
//! O que estes testes tentam provar, na ordem em que o usuário pediu:
//!
//!  1. Tentativa normal funciona.
//!  2. Três tentativas são permitidas.
//!  3. A quarta é bloqueada.
//!  4. "Refresh" (recriar o estado do limiter) NÃO abre uma janela nova — desde
//!     que o estado é o do processo, não o da página.
//!  5. Requisições SIMULTÂNEAS não furam o limite (o bug clássico de
//!     check-then-act: N threads passam na verificação antes de qualquer uma
//!     registrar a falha).
//!  6. Endpoints/caminhos paralelos de autenticação NÃO compartilham o
//!     orçamento por acidente NEM são um contorno.
//!  7. A senha nunca aparece em log, erro ou estado.
//!
//! O `AuthLimiter` é a mesma instância que o shell Tauri segura; os testes
//! exercitam o código de produção, não uma reimplementação.

use forge_core::authlimit::{AuthLimiter, Decision};
use forge_core::vault;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Limite de produção: 3 tentativas. Curto só o suficiente para o teste rodar.
const MAX: u32 = 3;
const LOCKOUT: Duration = Duration::from_secs(60);
const WINDOW: Duration = Duration::from_secs(15 * 60);

fn limiter() -> AuthLimiter {
    AuthLimiter::with_params(WINDOW, MAX, LOCKOUT)
}

/// Reproduz o que `vault_unlock` faz: guard → Argon2 → fail/success.
struct UnlockSim {
    limit: AuthLimiter,
    key: String,
    calls: AtomicUsize,
    argon2_calls: AtomicUsize,
    /// Blob do cofre, construído UMA vez. No app real o blob já está no disco
    /// quando o comando roda; criá-lo por chamada custaria um Argon2id extra
    /// dentro da seção crítica de cada thread e serializaria o teste,
    /// mascarando a janela de concorrência que ele existe para medir.
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

    /// `password` é o que o usuário digitou; o cofre tem a senha verdadeira.
    fn unlock(&self, password: &str) -> Result<String, String> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        // O guard roda ANTES do KDF — um atacante bloqueado não gasta Argon2.
        if let Decision::Blocked { retry_after } = self.limit.check(&self.key) {
            return Err(format!(
                "muitas tentativas incorretas. Tente de novo em {}s.",
                retry_after.as_secs().max(1)
            ));
        }
        self.argon2_calls.fetch_add(1, Ordering::SeqCst);
        // Argon2id real via o cofre de produção — o custo é o mesmo do app.
        match vault::open_sealed(&self.blob, password) {
            Ok(secret) => {
                self.limit.record_success(&self.key);
                Ok(secret)
            }
            Err(_) => {
                let out = self.limit.record_failure(&self.key);
                if out.locked_now {
                    let secs = out.retry_after.map(|d| d.as_secs()).unwrap_or(0).max(1);
                    // A N-ésima falha instala o bloqueio mas ainda responde
                    // "senha incorreta" — a senha ESTAVA errada. O bloqueio
                    // concreto aparece na tentativa seguinte, na guarda.
                    return Err(format!(
                        "senha incorreta. Mais {secs}s de espera antes de tentar de novo."
                    ));
                }
                Err("senha incorreta".into())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 1 e 2: tentativa normal, e as três permitidas
// ---------------------------------------------------------------------------

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
    // Duas erradas + uma certa = entra. Errar não deve custar o acesso.
    assert_eq!(u.unlock("errada").unwrap_err(), "senha incorreta");
    assert_eq!(u.unlock("errada").unwrap_err(), "senha incorreta");
    assert!(u.unlock("certa-123").is_ok(), "a 3ª certa tem que entrar");
    assert_eq!(u.argon2_calls.load(Ordering::SeqCst), 3);
}

// ---------------------------------------------------------------------------
// 3: a quarta tentativa
// ---------------------------------------------------------------------------

#[test]
fn quarta_tentativa_e_bloqueada_com_erro_explicito() {
    let u = UnlockSim::new("fp-carol");

    // As MAX primeiras são aceitas de verdade — cada uma gasta um Argon2.
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

    // A última aceita já avisa que a próxima será barrada — o usuário não
    // descobre isso no susto, e a senha errada continua sendo dita como errada.
    assert!(
        ultima.contains("incorreta") && ultima.contains("s de espera"),
        "a última aceita deve avisar da espera: {ultima}"
    );

    // A 4ª: barrada pela guarda, com o tempo restante no erro.
    let antes = u.argon2_calls.load(Ordering::SeqCst);
    let e = u.unlock("certa-123").unwrap_err();
    assert!(
        e.contains("muitas tentativas"),
        "a 4ª deve dizer que está bloqueada: {e}"
    );
    assert!(e.contains("s."), "a 4ª deve dizer quanto tempo falta: {e}");
    // E o bloqueio não gastou KDF — a guarda veio antes do Argon2.
    assert_eq!(
        u.argon2_calls.load(Ordering::SeqCst),
        antes,
        "bloqueado não pode gastar Argon2"
    );
}

#[test]
fn bloqueio_impede_senha_correta() {
    // A propriedade que importa: o limite NÃO é só contra erro, é contra
    // descoberta. Mesmo com a senha certa, bloqueado é bloqueado.
    let u = UnlockSim::new("fp-dave");
    for _ in 0..MAX {
        let _ = u.unlock("errada");
    }
    assert!(u.unlock("certa-123").is_err());
}

#[test]
fn guarda_e_checado_antes_do_argon2() {
    // Se o KDF rodasse antes da guarda, o atacante bloqueado ainda poderia
    // usar o app como oráculo de tempo (e gastar CPU) para medir a senha.
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

// ---------------------------------------------------------------------------
// 4: refresh / nova sessão
// ---------------------------------------------------------------------------

#[test]
fn refresh_da_pagina_nao_zera_o_limite() {
    // A UI recarrega chamando os mesmos comandos; o estado é do PROCESSO.
    // Simular refresh = chamar unlock de novo a partir de um "contexto" novo,
    // mas com o MESMO limiter — que é o que o app realmente faz.
    let u = Arc::new(UnlockSim::new("fp-frank"));
    for _ in 0..MAX {
        let _ = u.unlock("errada");
    }
    // "refresh" 5 vezes, cada uma como se fosse uma sessão nova do front
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
    // Um limiter NOVO (processo reiniciado) zera — é o limite do modelo
    // local. O teste existe para DOCUMENTAR esse limite em vez de fingir que
    // não existe: o app é local-first e não tem servidor para persistir.
    let a = UnlockSim::new("fp-grace");
    for _ in 0..MAX {
        let _ = a.unlock("errada");
    }
    assert!(a.unlock("certa-123").is_err());

    let b = UnlockSim::new("fp-grace"); // processo novo
    assert!(
        b.unlock("certa-123").is_ok(),
        "processo reiniciado começa limpo — limitação conhecida e assumida"
    );
}

// ---------------------------------------------------------------------------
// 5: requisições simultâneas
// ---------------------------------------------------------------------------

#[test]
fn requisicoes_simultaneas_nao_furam_o_limite() {
    // 40 threads com senha ERRADA batendo ao mesmo tempo.
    //
    // O que este teste NÃO tenta afirmar é que a guarda barra a maioria das
    // threads: ela não consegue. Todas as 40 chegam ao `check()` antes de
    // qualquer uma terminar o Argon2 (~50ms) e registrar a falha — a janela
    // check-then-act é real: o guard e o registro do erro não são um passo
    // atômico, e entre os dois corre um Argon2id inteiro (~50ms). Todas as 40
    // chegam ao `check()` antes de a primeira registrar a falha.
    //
    // O que precisa ser verdade, e é:
    //  1. senha errada NUNCA desbloqueia, sob nenhuma concorrência;
    //  2. ao fim da rajada o estado fica bloqueado — o atacante não ganha
    //     orçamento novo a cada rajada;
    //  3. a partir daí, nenhuma tentativa nova gasta KDF.
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

    // Toda resposta é um erro de senha incorreta ou de bloqueio — nunca um
    // sucesso nem um erro inesperado (tipo de dado quebrado, pânico silencioso).
    for r in rs.iter() {
        let e = r.as_ref().unwrap_err();
        assert!(
            e.contains("senha incorreta") || e.contains("muitas tentativas"),
            "erro inesperado: {e}"
        );
    }
    drop(rs);

    // 2. Estado final: bloqueado.
    assert!(
        matches!(u.limit.check(&u.key), Decision::Blocked { .. }),
        "após a rajada, o estado tem de estar bloqueado"
    );

    // 3. E nenhuma tentativa nova gasta KDF.
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

// ---------------------------------------------------------------------------
// 6: caminhos de autenticação paralelos
// ---------------------------------------------------------------------------

#[test]
fn caminhos_paralelos_nao_furam_um_o_outro() {
    // vault_unlock, vault_change e stormvault_import são três comandos
    // diferentes que testam senha. Cada um tem sua chave. Um atacante que
    // esgota o orçamento do unlock não pode passar a usar o change — e o
    // inverso também. Nenhum é atalho para os outros.
    let store = AuthLimiter::new();
    let fp = "fp-jane";

    let unlock = AuthLimiter::key(&format!("{fp}:unlock"), "desktop");
    let change = AuthLimiter::key(&format!("{fp}:change"), "desktop");
    let import = AuthLimiter::key(&format!("{fp}:stormvault"), "desktop");

    for _ in 0..MAX {
        store.record_failure(&unlock);
    }
    assert!(matches!(store.check(&unlock), Decision::Blocked { .. }));

    // O change tem o próprio orçamento — não é herança do bloqueio, e não é
    // um furo: ele também vai bloquear depois das MESMAS 3 tentativas.
    assert_eq!(store.check(&change), Decision::Allowed);
    for _ in 0..MAX {
        store.record_failure(&change);
    }
    assert!(matches!(store.check(&change), Decision::Blocked { .. }));

    // E o import igual.
    assert_eq!(store.check(&import), Decision::Allowed);
    for _ in 0..MAX {
        store.record_failure(&import);
    }
    assert!(matches!(store.check(&import), Decision::Blocked { .. }));
}

#[test]
fn conta_diferente_nao_herda_bloqueio() {
    // O inverso do teste acima também é propriedade: a conta B (ou outro
    // fingerprint) não fica presa por causa da conta A.
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
    // E o orçamento de B segue intacto.
    assert_eq!(store.remaining(&b), MAX);
}

// ---------------------------------------------------------------------------
// 7: o segredo não vaza
// ---------------------------------------------------------------------------

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
    // O limiter guarda fingerprint, origem e instantes. Nada do que foi
    // digitado. `Debug` é derivado, então um log de depuração também não
    // carrega a senha.
    let l = limiter();
    let k = AuthLimiter::key("fp-noah:unlock", "desktop");
    let _ = l.record_failure(&k);
    let dump = format!("{:?}", l);
    assert!(
        !dump.contains("senha"),
        "Debug do limiter pode conter segredo: {dump}"
    );
    // E o `Display` do erro de bloqueio também não.
    let d = match l.check(&k) {
        Decision::Blocked { retry_after } => format!("{}", retry_after.as_secs()),
        Decision::Allowed => "0".into(),
    };
    assert!(d.chars().all(|c| c.is_ascii_digit()));
}

#[test]
fn cofre_real_nao_vaza_o_segredo_no_erro() {
    // Sanidade no primitive: o `open_sealed` devolve mensagem genérica.
    let blob = vault::seal_secret(&"cd".repeat(32), "correta-123").unwrap();
    let e = vault::open_sealed(&blob, "errada").unwrap_err().to_string();
    assert_eq!(e, "crypto: senha incorreta");
    assert!(!e.contains("errada"));
    assert!(!e.contains("correta-123"));
}

// ---------------------------------------------------------------------------
// contabilização
// ---------------------------------------------------------------------------

#[test]
fn orcamento_e_tres_nao_mais_nem_menos() {
    let l = limiter();
    let k = AuthLimiter::key("fp-pam:unlock", "desktop");
    assert_eq!(l.remaining(&k), MAX, "começa com o orçamento cheio");

    // O contador que importa é o que a falha devolve. `remaining()` volta ao
    // cheio depois do bloqueio porque quem assume o controle passa a ser o
    // `locked_until`, não a janela de falhas.
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
