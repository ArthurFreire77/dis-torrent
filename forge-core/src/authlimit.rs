//! Limite de tentativas de autenticação — proteção contra descoberta de senha/token.
//!
//! Onde roda: no `forge-core`, dentro do processo nativo. O JavaScript da UI
//! NUNCA participa da decisão — recarregar a página, recarregar o app ou
//! manipular headers não cria uma janela nova.
//!
//! O que é medido: tentativas FALSAS por janela deslizante, não requisições.
//! Um desbloqueio legítimo no meio da janela não consome orçamento, então um
//! usuário que digita a senha certa na 5ª tentativa entra normalmente — o
//! contador de falhas zera no acerto.
//!
//! A chave combina a identidade da conta (fingerprint, quando há vault) com a
//! origem da chamada. Um app de desktop é uma origem só, então a proteção real
//! contra força bruta é a combinação `conta + origem + processo`: trocar de
//! cabeçalho HTTP, forjar `Origin` ou recarregar a página não muda a chave, e
//! encerrar o processo zera o contador — o que é o comportamento honesto de
//! um aplicativo local: não existe servidor onde persistir o contador.
//!
//! O que NUNCA é registrado: a senha, o token, o blob do cofre ou qualquer
//! prefixo deles. O log de auditoria carrega só fingerprint da conta, origem,
//! contagem e o tempo de espera restante.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Janela padrão de observação (15 min).
pub const DEFAULT_WINDOW: Duration = Duration::from_secs(15 * 60);

/// Máximo de tentativas FALSAS dentro da janela. A 4ª falha bloqueia.
pub const DEFAULT_MAX_FAILURES: u32 = 3;

/// Quanto tempo o bloqueio dura depois de estourar o limite. Cresce por
/// reincidência: quem insiste espera cada vez mais.
pub const DEFAULT_LOCKOUT: Duration = Duration::from_secs(60);

/// Teto do crescimento progressivo (15 min).
pub const MAX_LOCKOUT: Duration = Duration::from_secs(15 * 60);

/// Resultado da verificação de orçamento.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Pode tentar.
    Allowed,
    /// Bloqueado. `retry_after` é o que falta para liberar.
    Blocked { retry_after: Duration },
}

#[derive(Debug)]
struct Bucket {
    /// Instantes (há quanto tempo) das falhas dentro da janela, em ordem.
    failures: std::collections::VecDeque<Instant>,
    /// Instante até quando o bloqueio está ativo.
    locked_until: Option<Instant>,
    /// Quantas vezes o limite foi estourado — dirige o lockout progressivo.
    strikes: u32,
}

impl Bucket {
    fn new() -> Self {
        Self {
            failures: std::collections::VecDeque::new(),
            locked_until: None,
            strikes: 0,
        }
    }

    fn prune(&mut self, now: Instant, window: Duration) {
        while self
            .failures
            .front()
            .map(|t| now.duration_since(*t) >= window)
            .unwrap_or(false)
        {
            self.failures.pop_front();
        }
    }

    /// Pena para o próximo bloqueio. O PRIMEIRO estouro usa a pena base; a
    /// partir do segundo, dobra por reincidência, até o teto.
    ///
    /// `strikes` é o número de bloqueios JÁ installer, então a primeira
    /// penalidade usa `strikes - 1` como expoente. Sem esse `-1` a primeira
    /// pena saía dobrada e o primeiro erro do usuário custava o dobro.
    fn lockout_for(&self, base: Duration) -> Duration {
        let prior = self.strikes.saturating_sub(1).min(10);
        let factor = 1u32.checked_shl(prior).unwrap_or(u32::MAX);
        base.saturating_mul(factor).min(MAX_LOCKOUT)
    }
}

/// Registra uma tentativa FALHA.
///
/// Semântica de "3 tentativas": as tentativas 1, 2 e 3 acontecem normalmente.
/// A 3ª falha é a que **instala** o bloqueio, de modo que a 4ª chamada é a
/// primeira barrada. A 3ª ainda responde "senha incorreta" — a senha estava
/// errada de fato, e mentir para o usuário sobre isso só confunde.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FailureOutcome {
    /// O bloqueio foi instalado NESTA chamada.
    pub locked_now: bool,
    /// Quanto falta do bloqueio, se houver.
    pub retry_after: Option<Duration>,
    /// Falhas restantes na janela depois desta.
    pub remaining: u32,
}

impl FailureOutcome {
    /// Falha comum, ainda dentro do orçamento.
    pub const fn tolerated(remaining: u32) -> Self {
        Self {
            locked_now: false,
            retry_after: None,
            remaining,
        }
    }
}

/// Limite de tentativas por chave (`conta|origem`).
///
/// `std::sync::Mutex` porque o shell Tauri é multi-thread e o comando de
/// desbloqueio roda fora do event loop.
#[derive(Debug)]
pub struct AuthLimiter {
    inner: Mutex<HashMap<String, Bucket>>,
    window: Duration,
    max_failures: u32,
    lockout: Duration,
}

impl Default for AuthLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthLimiter {
    pub fn new() -> Self {
        Self::with_params(DEFAULT_WINDOW, DEFAULT_MAX_FAILURES, DEFAULT_LOCKOUT)
    }

    /// Parâmetros explícitos — os testes usam janela/limite curtos para não
    /// esperar minutos.
    pub fn with_params(window: Duration, max_failures: u32, lockout: Duration) -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            window,
            max_failures: max_failures.max(1),
            lockout,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Bucket>> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Verifica se a chave pode tentar agora. **Chame ANTES** de gastar o
    /// Argon2id, para que um atacante bloqueado nem alcance o KDF.
    pub fn check(&self, key: &str) -> Decision {
        self.check_at(key, Instant::now())
    }

    fn check_at(&self, key: &str, now: Instant) -> Decision {
        let mut map = self.lock();
        let bucket = map.entry(key.to_string()).or_insert_with(Bucket::new);
        bucket.prune(now, self.window);
        match bucket.locked_until {
            Some(until) if now < until => Decision::Blocked {
                retry_after: until.duration_since(now),
            },
            Some(_) => {
                // bloqueio cumprido — libera, mas o histórico de falhas da
                // janela ainda conta.
                bucket.locked_until = None;
                Decision::Allowed
            }
            None => Decision::Allowed,
        }
    }

    /// Registra uma tentativa FALHA e devolve o desfecho: se o bloqueio acabou
    /// de ser instalado, por quanto tempo, e quantas tentativas restam.
    pub fn record_failure(&self, key: &str) -> FailureOutcome {
        self.record_failure_at(key, Instant::now())
    }

    fn record_failure_at(&self, key: &str, now: Instant) -> FailureOutcome {
        let mut map = self.lock();
        let bucket = map.entry(key.to_string()).or_insert_with(Bucket::new);
        bucket.prune(now, self.window);

        // já bloqueado? a falha não conta duas vezes, só renova o strike.
        if let Some(until) = bucket.locked_until {
            if now < until {
                return FailureOutcome {
                    locked_now: false,
                    retry_after: Some(until.duration_since(now)),
                    remaining: 0,
                };
            }
            bucket.locked_until = None;
        }

        bucket.failures.push_back(now);
        let restam = self
            .max_failures
            .saturating_sub(bucket.failures.len() as u32);

        // A N-ésima falha é a que instala o bloqueio. As N-1 anteriores
        // vieram antes, com `restam > 0`.
        if restam > 0 {
            return FailureOutcome::tolerated(restam);
        }

        // Estourou. As falhas da janela saem — o bloqueio assume o controle de
        // agora em diante, e `remaining` volta a valer só depois de cumprir a
        // pena (via `check`).
        bucket.failures.clear();
        bucket.strikes = bucket.strikes.saturating_add(1);
        let dur = bucket.lockout_for(self.lockout);
        bucket.locked_until = Some(now + dur);
        FailureOutcome {
            locked_now: true,
            retry_after: Some(dur),
            remaining: 0,
        }
    }

    /// Registra um SUCESSO: zera o histórico. Um usuário que erra duas vezes e
    /// acerta na terceira entra e não fica com bloqueio pendente.
    pub fn record_success(&self, key: &str) {
        let mut map = self.lock();
        if let Some(bucket) = map.get_mut(key) {
            bucket.failures.clear();
            bucket.locked_until = None;
            bucket.strikes = 0;
        }
    }

    /// Falhas ainda dentro da janela (para a UI mostrar "2 de 3").
    pub fn remaining(&self, key: &str) -> u32 {
        let now = Instant::now();
        let mut map = self.lock();
        let Some(bucket) = map.get_mut(key) else {
            return self.max_failures;
        };
        bucket.prune(now, self.window);
        self.max_failures
            .saturating_sub(bucket.failures.len() as u32)
    }

    /// Tentativas restantes depois de um `record_failure`.
    pub fn remaining_after(&self, key: &str) -> u32 {
        self.remaining(key)
    }

    /// Bloqueios acumulados da chave (diagnóstico).
    pub fn strikes(&self, key: &str) -> u32 {
        self.lock().get(key).map(|b| b.strikes).unwrap_or(0)
    }

    /// Chave composta. `account` é o fingerprint da conta (ou `"no-identity"`
    /// antes de existir uma); `origin` identifica quem está chamando.
    pub fn key(account: &str, origin: &str) -> String {
        format!("{account}|{origin}")
    }

    /// Remove chaves ociosas. Chamado pelo shell periodicamente — o mapa é
    /// limitado pelo número de identidades no device, mas ejetar o que está
    /// fora da janela evita crescimento em SessionLong.
    pub fn sweep(&self, keep_under: Duration) {
        let now = Instant::now();
        let mut map = self.lock();
        map.retain(|_, b| {
            let locked = b.locked_until.map(|u| now < u).unwrap_or(false);
            let recent = b
                .failures
                .back()
                .map(|t| now.duration_since(*t) < keep_under)
                .unwrap_or(false);
            locked || recent
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lim() -> AuthLimiter {
        AuthLimiter::with_params(Duration::from_secs(60), 3, Duration::from_secs(30))
    }

    #[test]
    fn tres_tentativas_passam_e_a_quarta_e_bloqueada() {
        let l = lim();
        let k = AuthLimiter::key("fp1", "desktop");

        // As TRÊS primeiras são permitidas de verdade: o `check` libera e o
        // palpite chega ao verificador.
        for i in 1..=3 {
            assert_eq!(
                l.check(&k),
                Decision::Allowed,
                "tentativa {i} tem que passar"
            );
            let out = l.record_failure(&k);
            if i < 3 {
                assert!(!out.locked_now, "tentativa {i} não pode instalar bloqueio");
                assert!(out.retry_after.is_none());
                assert_eq!(out.remaining, 3 - i);
            } else {
                assert!(out.locked_now, "a 3ª falha instala o bloqueio");
                assert_eq!(out.remaining, 0);
            }
        }

        // A 4ª é barrada ANTES de qualquer verificação de senha.
        match l.check(&k) {
            Decision::Blocked { retry_after } => {
                assert!(
                    retry_after <= Duration::from_secs(30),
                    "esperava ~30s, veio {retry_after:?}"
                )
            }
            Decision::Allowed => panic!("4ª tentativa deveria estar bloqueada"),
        }
    }

    #[test]
    fn falha_durante_bloqueio_nao_reinicia_a_pena() {
        let l = lim();
        let k = AuthLimiter::key("fp1", "desktop");
        for _ in 0..3 {
            l.record_failure(&k);
        }
        let first = l.check(&k);
        let again = l.record_failure(&k);
        match (first, again) {
            (Decision::Blocked { retry_after: a }, out) => {
                let b = out
                    .retry_after
                    .expect("bloqueio vigente precisa de retry_after");
                assert!(!out.locked_now, "não reinstala, só renova");
                assert!(b <= a, "a pena não pode crescer durante o bloqueio");
            }
            _ => panic!("esperava bloqueio dos dois lados"),
        }
    }

    #[test]
    fn sucesso_zera_o_historico() {
        let l = lim();
        let k = AuthLimiter::key("fp1", "desktop");
        l.record_failure(&k);
        l.record_failure(&k);
        assert_eq!(l.remaining(&k), 1);
        l.record_success(&k);
        assert_eq!(l.remaining(&k), 3, "sucesso devolve o orçamento cheio");
        // e 3 falhas de novo bloqueiam (não sobrou estado fantasma)
        for _ in 0..3 {
            l.record_failure(&k);
        }
        assert!(matches!(l.check(&k), Decision::Blocked { .. }));
    }

    #[test]
    fn contas_diferentes_nao_compartilham_orcamento() {
        let l = lim();
        let a = AuthLimiter::key("fp1", "desktop");
        let b = AuthLimiter::key("fp2", "desktop");
        for _ in 0..3 {
            l.record_failure(&a);
        }
        assert!(matches!(l.check(&a), Decision::Blocked { .. }));
        // a conta B continua intacta
        assert_eq!(l.check(&b), Decision::Allowed);
        assert_eq!(l.remaining(&b), 3);
    }

    #[test]
    fn origens_diferentes_nao_compartilham_orcamento() {
        let l = lim();
        let a = AuthLimiter::key("fp1", "desktop");
        let b = AuthLimiter::key("fp1", "mobile");
        for _ in 0..3 {
            l.record_failure(&a);
        }
        assert!(matches!(l.check(&a), Decision::Blocked { .. }));
        assert_eq!(l.check(&b), Decision::Allowed);
    }

    #[test]
    fn recidencia_cresce_a_pena() {
        // max_failures=1: cada falha estoura e instala um bloqueio.
        let l = AuthLimiter::with_params(Duration::from_secs(1), 1, Duration::from_secs(10));
        let k = AuthLimiter::key("fp1", "desktop");
        let t0 = Instant::now();

        let o1 = l.record_failure_at(&k, t0);
        assert!(o1.locked_now, "1ª falha com max=1 já bloqueia");
        let w1 = o1.retry_after.unwrap();
        assert_eq!(w1, Duration::from_secs(10), "primeira pena é a base");

        // cumpre a pena e reincide — a segunda tem que ser maior.
        let t1 = t0 + Duration::from_secs(11);
        assert!(matches!(l.check_at(&k, t1), Decision::Allowed));
        let o2 = l.record_failure_at(&k, t1);
        let w2 = o2.retry_after.unwrap();
        assert!(w2 > w1, "reincidência tem pena maior: {w1:?} -> {w2:?}");

        // e a pena não cresce sem limite
        let mut t = t1 + w2 + Duration::from_secs(1);
        for _ in 0..12 {
            l.check_at(&k, t);
            let w = l.record_failure_at(&k, t).retry_after.unwrap();
            assert!(w <= MAX_LOCKOUT, "pena acima do teto: {w:?}");
            t += w + Duration::from_secs(1);
        }
    }

    /// Sucesso legítimo zera os strikes: quem acerta a senha uma vez não fica
    /// com pena acrescida nas tentativas seguintes.
    #[test]
    fn sucesso_nao_carrega_pena_anterior() {
        let l = AuthLimiter::with_params(Duration::from_secs(1), 1, Duration::from_secs(10));
        let k = AuthLimiter::key("fp1", "desktop");
        let t0 = Instant::now();
        l.record_failure_at(&k, t0);
        assert_eq!(l.strikes(&k), 1);
        l.record_success(&k);
        assert_eq!(l.strikes(&k), 0);
        let w = l
            .record_failure_at(&k, t0 + Duration::from_secs(11))
            .retry_after
            .unwrap();
        assert_eq!(w, Duration::from_secs(10), "voltou à pena base");
    }

    #[test]
    fn sweep_remove_chaves_ociosas() {
        let l = lim();
        let k = AuthLimiter::key("fp1", "desktop");
        l.record_failure(&k);
        assert_eq!(l.remaining(&k), 2);
        l.sweep(Duration::from_secs(0));
        assert_eq!(l.remaining(&k), 3); // ejetada
    }

    #[test]
    fn janela_decresce_com_o_tempo() {
        let l = AuthLimiter::with_params(Duration::from_secs(1), 3, Duration::from_secs(5));
        let k = AuthLimiter::key("fp1", "d");
        l.record_failure_at(&k, Instant::now());
        l.record_failure_at(&k, Instant::now());
        // simula 2s depois: as duas falhas velhas saíram da janela
        l.record_failure_at(&k, Instant::now() + Duration::from_secs(2));
        assert_eq!(l.remaining(&k), 2);
    }
}
