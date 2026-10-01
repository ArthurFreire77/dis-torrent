//! Anti-spam P2P — Storm camada de segurança.
//!
//! Pipeline (barato primeiro, caro por último):
//! 1. `RateLimiter` (token bucket por peer/canal) — flood.
//! 2. `DuplicateDetector` (blake3 do corpo + janela) — mensagens repetidas.
//! 3. `LinkFilter` — domínios maliciosos + encurtadores.
//! 4. `ProofOfWork` — captcha leve p/ novatos em servidores públicos.
//! 5. `Reputation` — novo / confiável / suspeito / banido + shadow-ban.
//!
//! Tudo em memória no engine; decisões são `Allow | Warn | Drop | Ban`.
//! O receptor SEMPRE revalida assinatura antes (anti-spoof) — spam nunca
//! passa na frente de autenticidade.

use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

// ---------------------------------------------------------------------------
// Níveis
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpamLevel {
    Low,
    Medium,
    High,
}

impl SpamLevel {
    pub fn from_str(s: &str) -> Self {
        match s {
            "low" => Self::Low,
            "high" => Self::High,
            _ => Self::Medium,
        }
    }
    /// (msgs_por_10s, burst, dup_janela_s, pow_bits)
    pub fn params(self) -> (u32, u32, i64, u8) {
        match self {
            Self::Low => (20, 8, 30, 0),
            Self::Medium => (10, 5, 60, 8),
            Self::High => (5, 3, 120, 12),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    /// passa mas marca (dedup conta, reputação cai)
    Warn(&'static str),
    Drop(&'static str),
    Ban(&'static str),
}

// ---------------------------------------------------------------------------
// 1. Rate limiter (token bucket por chave)
// ---------------------------------------------------------------------------

#[derive(Debug)]
struct Bucket {
    tokens: f64,
    last: Instant,
}

#[derive(Debug)]
pub struct RateLimiter {
    per_10s: f64,
    burst: f64,
    buckets: HashMap<String, Bucket>,
    timeouts: HashMap<String, Instant>,
    violations: HashMap<String, u32>,
}

impl RateLimiter {
    pub fn new(level: SpamLevel) -> Self {
        let (per_10s, burst, _, _) = level.params();
        Self {
            per_10s: per_10s as f64,
            burst: burst as f64,
            buckets: HashMap::new(),
            timeouts: HashMap::new(),
            violations: HashMap::new(),
        }
    }

    pub fn with_params(msgs_per_10s: u32, burst: u32) -> Self {
        Self {
            per_10s: msgs_per_10s as f64,
            burst: burst as f64,
            buckets: HashMap::new(),
            timeouts: HashMap::new(),
            violations: HashMap::new(),
        }
    }

    /// Retorna `None` se permitido, `Some(espera)` se em timeout/flood.
    pub fn check(&mut self, key: &str) -> Option<Duration> {
        let now = Instant::now();
        if let Some(until) = self.timeouts.get(key) {
            if now < *until {
                return Some(*until - now);
            }
            self.timeouts.remove(key);
        }
        let refill_per_s = self.per_10s / 10.0;
        let b = self.buckets.entry(key.to_string()).or_insert(Bucket {
            tokens: self.burst,
            last: now,
        });
        let dt = now.duration_since(b.last).as_secs_f64();
        b.tokens = (b.tokens + dt * refill_per_s).min(self.burst);
        b.last = now;
        if b.tokens >= 1.0 {
            b.tokens -= 1.0;
            // decaimento de violações quando se comporta
            if let Some(v) = self.violations.get_mut(key) {
                if *v > 0 && b.tokens > self.burst / 2.0 {
                    *v = v.saturating_sub(1);
                }
            }
            None
        } else {
            let v = self.violations.entry(key.to_string()).or_insert(0);
            *v += 1;
            // timeout progressivo: 2^v segundos, teto 5 min
            let secs = (1u64 << (*v).min(8)) * 2;
            let secs = secs.min(300);
            self.timeouts
                .insert(key.to_string(), now + Duration::from_secs(secs));
            Some(Duration::from_secs(secs))
        }
    }

    pub fn violations(&self, key: &str) -> u32 {
        self.violations.get(key).copied().unwrap_or(0)
    }
}

// ---------------------------------------------------------------------------
// 2. Duplicadas (hash + janela)
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct DuplicateDetector {
    window_ms: i64,
    seen: VecDeque<(String, i64)>,
}

impl DuplicateDetector {
    pub fn new(level: SpamLevel) -> Self {
        let (_, _, win_s, _) = level.params();
        Self {
            window_ms: win_s * 1000,
            seen: VecDeque::new(),
        }
    }

    pub fn with_window_secs(secs: i64) -> Self {
        Self {
            window_ms: secs * 1000,
            seen: VecDeque::new(),
        }
    }

    pub fn content_hash(author_fp: &str, body: &str) -> String {
        let mut h = blake3::Hasher::new();
        h.update(b"storm/antispam/dup|");
        h.update(author_fp.as_bytes());
        h.update(b"|");
        h.update(body.trim().to_lowercase().as_bytes());
        hex::encode(&h.finalize().as_bytes()[..16])
    }

    /// `true` = duplicada dentro da janela (dropar).
    /// Passe `at_ms = 0` para usar o relógio atual.
    pub fn check(&mut self, author_fp: &str, body: &str, at_ms: i64) -> bool {
        let now = if at_ms == 0 {
            crate::identity::now_ms()
        } else {
            at_ms
        };
        while self
            .seen
            .front()
            .map(|(_, t)| now - *t > self.window_ms)
            .unwrap_or(false)
        {
            self.seen.pop_front();
        }
        let h = Self::content_hash(author_fp, body);
        if self.seen.iter().any(|(x, _)| x == &h) {
            return true;
        }
        self.seen.push_back((h, now));
        if self.seen.len() > 2000 {
            self.seen.pop_front();
        }
        false
    }
}

// ---------------------------------------------------------------------------
// 3. Links suspeitos
// ---------------------------------------------------------------------------

pub fn malicious_domains() -> Vec<&'static str> {
    vec![
        "grabify.link",
        "iplogger.org",
        "iplogger.ru",
        "blasze.tk",
        "shorte.st",
        "adf.ly",
        "bitly-stealer",
        "discord-nitro-free",
        "steamcommunlty",
        "steancommunuty",
        "metamask-seed",
        "wallet-drain",
    ]
}

pub fn shorteners() -> Vec<&'static str> {
    vec![
        "bit.ly",
        "t.co",
        "tinyurl.com",
        "goo.gl",
        "ow.ly",
        "is.gd",
        "buff.ly",
        "adf.ly",
        "shorte.st",
        "cutt.ly",
        "rebrand.ly",
        "shorturl.at",
    ]
}

/// Extrai domínios de um texto (http(s):// e bare `algo.tld/...` simples).
pub fn extract_domains(text: &str) -> Vec<String> {
    let mut out = vec![];
    let lower = text.to_lowercase();
    for tok in lower.split_whitespace() {
        let t = tok.trim_matches(|c: char| ".,;:!?()[]<>\"'".contains(c));
        let host = if let Some(rest) = t
            .strip_prefix("http://")
            .or_else(|| t.strip_prefix("https://"))
        {
            rest.split('/')
                .next()
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("")
                .to_string()
        } else if t.contains('.') && !t.contains(' ') && t.len() < 256 {
            let h = t
                .split('/')
                .next()
                .unwrap_or("")
                .split(':')
                .next()
                .unwrap_or("");
            // heurística: precisa ter ponto + tld de 2+ letras
            if h.contains('.')
                && h.split('.')
                    .last()
                    .map(|tld| tld.len() >= 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
                    .unwrap_or(false)
            {
                h.to_string()
            } else {
                continue;
            }
        } else {
            continue;
        };
        if !host.is_empty() {
            out.push(host);
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkVerdict {
    Clean,
    Shortener(String),
    Malicious(String),
}

pub fn check_links(body: &str, extra_blocked: &[String]) -> LinkVerdict {
    let mal: Vec<String> = malicious_domains()
        .into_iter()
        .map(|s| s.to_string())
        .chain(extra_blocked.iter().cloned())
        .collect();
    let short: Vec<String> = shorteners().into_iter().map(|s| s.to_string()).collect();
    for d in extract_domains(body) {
        if mal.iter().any(|m| d == *m || d.ends_with(&format!(".{m}"))) {
            return LinkVerdict::Malicious(d);
        }
    }
    for d in extract_domains(body) {
        if short
            .iter()
            .any(|m| d == *m || d.ends_with(&format!(".{m}")))
        {
            return LinkVerdict::Shortener(d);
        }
    }
    LinkVerdict::Clean
}

// ---------------------------------------------------------------------------
// 4. Proof-of-work (captcha leve p/ novatos)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct PowChallenge {
    pub challenge_hex: String,
    pub bits: u8,
}

impl PowChallenge {
    pub fn fresh(bits: u8) -> Self {
        let mut rnd = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut rnd);
        Self {
            challenge_hex: hex::encode(rnd),
            bits,
        }
    }

    /// Solução válida se `blake3(challenge || nonce_be)` tem `bits` zeros à esquerda.
    pub fn verify(&self, nonce: u64) -> bool {
        if self.bits == 0 {
            return true;
        }
        let chal = match hex::decode(&self.challenge_hex) {
            Ok(b) => b,
            Err(_) => return false,
        };
        let mut h = blake3::Hasher::new();
        h.update(b"storm/antispam/pow|");
        h.update(&chal);
        h.update(&nonce.to_be_bytes());
        let d = h.finalize();
        leading_zero_bits(d.as_bytes()) >= self.bits as u32
    }

    /// Solver do cliente (limitado; bits<=12 resolve em ms).
    pub fn solve(&self, max_iters: u64) -> Option<u64> {
        for n in 0..max_iters {
            if self.verify(n) {
                return Some(n);
            }
        }
        None
    }
}

fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut n = 0u32;
    for b in bytes {
        if *b == 0 {
            n += 8;
        } else {
            n += b.leading_zeros();
            break;
        }
    }
    n
}

// ---------------------------------------------------------------------------
// 5. Reputação
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trust {
    New,
    Trusted,
    Suspicious,
    Banned,
}

impl Trust {
    pub fn from_str(s: &str) -> Self {
        match s {
            "trusted" => Self::Trusted,
            "suspicious" => Self::Suspicious,
            "banned" => Self::Banned,
            _ => Self::New,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Trusted => "trusted",
            Self::Suspicious => "suspicious",
            Self::Banned => "banned",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Reputation {
    pub trust: Trust,
    pub score: i32, // -100..100
    pub reports: u32,
}

impl Reputation {
    pub fn fresh() -> Self {
        Self {
            trust: Trust::New,
            score: 0,
            reports: 0,
        }
    }
    pub fn good(&mut self) {
        self.score = (self.score + 1).min(100);
        if self.score >= 20 && self.trust == Trust::New {
            self.trust = Trust::Trusted;
        }
        if self.score >= 0 && self.trust == Trust::Suspicious {
            self.trust = Trust::New;
        }
    }
    pub fn bad(&mut self, w: i32) {
        self.score = (self.score - w).max(-100);
        if self.score <= -30 {
            self.trust = Trust::Banned;
        } else if self.score <= -10 {
            self.trust = Trust::Suspicious;
        }
    }
    pub fn report(&mut self) {
        self.reports += 1;
        self.bad(10);
    }
}

// ---------------------------------------------------------------------------
// Pipeline combinado (o engine chama por mensagem recebida)
// ---------------------------------------------------------------------------

pub struct InboundCtx<'a> {
    pub level: SpamLevel,
    pub trust: Trust,
    pub shadow_banned: bool,
    pub extra_blocked_domains: &'a [String],
    /// novato sem PoW resolvido?
    pub pow_required: bool,
    pub pow_ok: bool,
}

pub fn decide_inbound(body: &str, ctx: &InboundCtx) -> Verdict {
    if ctx.trust == Trust::Banned || ctx.shadow_banned {
        return Verdict::Ban("usuário banido");
    }
    if ctx.pow_required && !ctx.pow_ok {
        return Verdict::Drop("proof-of-work pendente");
    }
    match check_links(body, ctx.extra_blocked_domains) {
        LinkVerdict::Malicious(d) => {
            let _ = d;
            return Verdict::Drop("link malicioso bloqueado");
        }
        LinkVerdict::Shortener(_) if ctx.level == SpamLevel::High => {
            return Verdict::Drop("encurtador bloqueado neste servidor");
        }
        LinkVerdict::Shortener(_) => return Verdict::Warn("encurtador: verifique antes de abrir"),
        LinkVerdict::Clean => {}
    }
    if ctx.trust == Trust::Suspicious && body.len() > 2000 {
        return Verdict::Warn("mensagem longa de usuário suspeito");
    }
    Verdict::Allow
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bucket_permite_burst_e_bloqueia_flood() {
        let mut r = RateLimiter::with_params(10, 3);
        assert!(r.check("a").is_none());
        assert!(r.check("a").is_none());
        assert!(r.check("a").is_none());
        let wait = r.check("a");
        assert!(wait.is_some()); // 4ª estoura o burst de 3
        assert!(r.violations("a") >= 1);
    }

    #[test]
    fn timeout_progressivo_cresce() {
        let mut r = RateLimiter::with_params(1, 1);
        assert!(r.check("k").is_none());
        let w1 = r.check("k").unwrap();
        // limpa timeout manualmente p/ simular reincidência após cumprir pena
        r.timeouts.remove("k");
        // esgota de novo
        r.buckets.get_mut("k").unwrap().tokens = 0.0;
        r.buckets.get_mut("k").unwrap().last = Instant::now();
        let w2 = r.check("k").unwrap();
        assert!(w2 >= w1);
    }

    #[test]
    fn duplicada_na_janela() {
        let mut d = DuplicateDetector::with_window_secs(60);
        assert!(!d.check("fp1", "Olá mundo", 1000));
        assert!(d.check("fp1", "  olá MUNDO ", 2000)); // case/space-insensitive
        assert!(!d.check("fp1", "outra msg", 3000));
        assert!(!d.check("fp1", "Olá mundo", 1000 + 61_000)); // fora da janela
    }

    #[test]
    fn links_maliciosos_e_encurtadores() {
        assert!(matches!(
            check_links("veja https://grabify.link/abc", &[]),
            LinkVerdict::Malicious(_)
        ));
        assert!(matches!(
            check_links("link https://bit.ly/xyz", &[]),
            LinkVerdict::Shortener(_)
        ));
        assert!(matches!(
            check_links("oi, tudo bem?", &[]),
            LinkVerdict::Clean
        ));
        assert!(matches!(
            check_links(
                "https://evil.example.com/x",
                &["evil.example.com".to_string()]
            ),
            LinkVerdict::Malicious(_)
        ));
    }

    #[test]
    fn pow_resolve_e_verifica() {
        let c = PowChallenge {
            challenge_hex: hex::encode([7u8; 16]),
            bits: 8,
        };
        let n = c.solve(100_000).expect("8 bits resolve rápido");
        assert!(c.verify(n));
        assert!(
            !c.verify(n.wrapping_add(1).wrapping_mul(7919).wrapping_add(13) % 100_000 + 100_000)
        );
        assert!(PowChallenge {
            challenge_hex: c.challenge_hex.clone(),
            bits: 0
        }
        .verify(0));
    }

    #[test]
    fn reputacao_transicoes() {
        let mut r = Reputation::fresh();
        assert_eq!(r.trust, Trust::New);
        for _ in 0..25 {
            r.good();
        }
        assert_eq!(r.trust, Trust::Trusted);
        r.bad(35);
        assert!(matches!(r.trust, Trust::Suspicious | Trust::Banned));
        r.report();
        assert_eq!(r.reports, 1);
    }

    #[test]
    fn pipeline_banido_e_pow() {
        let ctx = InboundCtx {
            level: SpamLevel::Medium,
            trust: Trust::Banned,
            shadow_banned: false,
            extra_blocked_domains: &[],
            pow_required: false,
            pow_ok: true,
        };
        assert!(matches!(decide_inbound("oi", &ctx), Verdict::Ban(_)));
        let ctx2 = InboundCtx {
            trust: Trust::New,
            pow_required: true,
            pow_ok: false,
            ..ctx
        };
        assert!(matches!(decide_inbound("oi", &ctx2), Verdict::Drop(_)));
    }
}
