use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const DEFAULT_WINDOW: Duration = Duration::from_secs(15 * 60);

pub const DEFAULT_MAX_FAILURES: u32 = 3;

pub const DEFAULT_LOCKOUT: Duration = Duration::from_secs(60);

pub const MAX_LOCKOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allowed,
    Blocked { retry_after: Duration },
}

#[derive(Debug)]
struct Bucket {
    failures: std::collections::VecDeque<Instant>,
    locked_until: Option<Instant>,
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

    fn lockout_for(&self, base: Duration) -> Duration {
        let prior = self.strikes.saturating_sub(1).min(10);
        let factor = 1u32.checked_shl(prior).unwrap_or(u32::MAX);
        base.saturating_mul(factor).min(MAX_LOCKOUT)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FailureOutcome {
    pub locked_now: bool,
    pub retry_after: Option<Duration>,
    pub remaining: u32,
}

impl FailureOutcome {
    pub const fn tolerated(remaining: u32) -> Self {
        Self {
            locked_now: false,
            retry_after: None,
            remaining,
        }
    }
}

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
                bucket.locked_until = None;
                Decision::Allowed
            }
            None => Decision::Allowed,
        }
    }

    pub fn record_failure(&self, key: &str) -> FailureOutcome {
        self.record_failure_at(key, Instant::now())
    }

    fn record_failure_at(&self, key: &str, now: Instant) -> FailureOutcome {
        let mut map = self.lock();
        let bucket = map.entry(key.to_string()).or_insert_with(Bucket::new);
        bucket.prune(now, self.window);

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

        if restam > 0 {
            return FailureOutcome::tolerated(restam);
        }

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

    pub fn record_success(&self, key: &str) {
        let mut map = self.lock();
        if let Some(bucket) = map.get_mut(key) {
            bucket.failures.clear();
            bucket.locked_until = None;
            bucket.strikes = 0;
        }
    }

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

    pub fn remaining_after(&self, key: &str) -> u32 {
        self.remaining(key)
    }

    pub fn strikes(&self, key: &str) -> u32 {
        self.lock().get(key).map(|b| b.strikes).unwrap_or(0)
    }

    pub fn key(account: &str, origin: &str) -> String {
        format!("{account}|{origin}")
    }

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
        let l = AuthLimiter::with_params(Duration::from_secs(1), 1, Duration::from_secs(10));
        let k = AuthLimiter::key("fp1", "desktop");
        let t0 = Instant::now();

        let o1 = l.record_failure_at(&k, t0);
        assert!(o1.locked_now, "1ª falha com max=1 já bloqueia");
        let w1 = o1.retry_after.unwrap();
        assert_eq!(w1, Duration::from_secs(10), "primeira pena é a base");

        let t1 = t0 + Duration::from_secs(11);
        assert!(matches!(l.check_at(&k, t1), Decision::Allowed));
        let o2 = l.record_failure_at(&k, t1);
        let w2 = o2.retry_after.unwrap();
        assert!(w2 > w1, "reincidência tem pena maior: {w1:?} -> {w2:?}");

        let mut t = t1 + w2 + Duration::from_secs(1);
        for _ in 0..12 {
            l.check_at(&k, t);
            let w = l.record_failure_at(&k, t).retry_after.unwrap();
            assert!(w <= MAX_LOCKOUT, "pena acima do teto: {w:?}");
            t += w + Duration::from_secs(1);
        }
    }

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
        assert_eq!(l.remaining(&k), 3);
    }

    #[test]
    fn janela_decresce_com_o_tempo() {
        let l = AuthLimiter::with_params(Duration::from_secs(1), 3, Duration::from_secs(5));
        let k = AuthLimiter::key("fp1", "d");
        l.record_failure_at(&k, Instant::now());
        l.record_failure_at(&k, Instant::now());
        l.record_failure_at(&k, Instant::now() + Duration::from_secs(2));
        assert_eq!(l.remaining(&k), 2);
    }
}
