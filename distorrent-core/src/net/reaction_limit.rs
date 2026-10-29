//! Rate limit específico para reações recebidas de peers autenticados.
//!
//! O limitador de frames protege o transporte; este módulo protege o estado
//! social de rajadas de mudanças e do crescimento de mapas por IDs variados.

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

const PEER_RATE_PER_SEC: f64 = 1.0; // 10 ações/10s, com burst inicial de 5.
const PEER_BURST: f64 = 5.0;
const CONVERSATION_RATE_PER_SEC: f64 = 3.0; // teto adicional por peer+conversa.
const CONVERSATION_BURST: f64 = 10.0;
const MESSAGE_RATE_PER_SEC: f64 = 2.0; // no máximo 2 mudanças/s por peer+mensagem.
const MESSAGE_BURST: f64 = 2.0;
const GLOBAL_RATE_PER_SEC: f64 = 50.0; // 500 ações/10s somando todos os peers.
const GLOBAL_BURST: f64 = 100.0;

const PRUNE_INTERVAL: Duration = Duration::from_secs(10);
const ENTRY_TTL: Duration = Duration::from_secs(60);
const PEER_MAP_CAP: usize = 2_048;
const CONVERSATION_MAP_CAP: usize = 4_096;
const MESSAGE_MAP_CAP: usize = 8_192;

#[derive(Debug, Clone, Copy)]
struct Bucket {
    tokens: f64,
    last_refill: Instant,
    last_seen: Instant,
}

impl Bucket {
    fn full(burst: f64, now: Instant) -> Self {
        Self {
            tokens: burst,
            last_refill: now,
            last_seen: now,
        }
    }

    fn refill(&mut self, rate_per_sec: f64, burst: f64, now: Instant) {
        let elapsed = now
            .saturating_duration_since(self.last_refill)
            .as_secs_f64();
        self.tokens = (self.tokens + elapsed * rate_per_sec).min(burst);
        self.last_refill = now;
        self.last_seen = now;
    }
}

fn bucket_for<'a, K>(
    map: &'a mut HashMap<K, Bucket>,
    key: K,
    burst: f64,
    cap: usize,
    now: Instant,
) -> &'a mut Bucket
where
    K: Eq + Hash + Clone,
{
    if !map.contains_key(&key) && map.len() >= cap {
        // Evicta só a entrada mais antiga. Limpar o mapa inteiro faria um
        // peer renovar o burst de todos os demais ao variar IDs de conversa.
        if let Some(oldest) = map
            .iter()
            .min_by_key(|(_, bucket)| bucket.last_seen)
            .map(|(key, _)| key.clone())
        {
            map.remove(&oldest);
        }
    }
    map.entry(key).or_insert_with(|| Bucket::full(burst, now))
}

/// Buckets separados por peer, conversa e mensagem. A identidade passada é
/// sempre a do canal autenticado; o `reactor_fp` declarado pelo frame não é
/// usado como chave de segurança.
#[derive(Debug)]
pub(crate) struct ReactionLimiter {
    global: Bucket,
    peers: HashMap<String, Bucket>,
    conversations: HashMap<(String, String), Bucket>,
    messages: HashMap<(String, String, String), Bucket>,
    last_prune: Instant,
}

impl ReactionLimiter {
    pub(crate) fn new() -> Self {
        Self::at(Instant::now())
    }

    fn at(now: Instant) -> Self {
        Self {
            global: Bucket::full(GLOBAL_BURST, now),
            peers: HashMap::new(),
            conversations: HashMap::new(),
            messages: HashMap::new(),
            last_prune: now,
        }
    }

    /// `Err` significa descartar apenas esta reação. O chamador mantém a
    /// sessão viva e não persiste, emite nem retransmite o frame rejeitado.
    pub(crate) fn allow_at(
        &mut self,
        peer_fp: &str,
        conv_id: &str,
        msg_id: &str,
        now: Instant,
    ) -> Result<(), &'static str> {
        self.prune(now);

        let peer_key = peer_fp.to_string();
        let conversation_key = (peer_fp.to_string(), conv_id.to_string());
        let message_key = (peer_fp.to_string(), conv_id.to_string(), msg_id.to_string());

        // Primeiro atualiza todas as janelas. Tokens só são consumidos depois
        // de todas passarem, para uma rejeição por conversa não gastar o bucket
        // independente do peer.
        let peer_ok = {
            let bucket = bucket_for(
                &mut self.peers,
                peer_key.clone(),
                PEER_BURST,
                PEER_MAP_CAP,
                now,
            );
            bucket.refill(PEER_RATE_PER_SEC, PEER_BURST, now);
            bucket.tokens >= 1.0
        };
        let conversation_ok = {
            let bucket = bucket_for(
                &mut self.conversations,
                conversation_key.clone(),
                CONVERSATION_BURST,
                CONVERSATION_MAP_CAP,
                now,
            );
            bucket.refill(CONVERSATION_RATE_PER_SEC, CONVERSATION_BURST, now);
            bucket.tokens >= 1.0
        };
        let message_ok = {
            let bucket = bucket_for(
                &mut self.messages,
                message_key.clone(),
                MESSAGE_BURST,
                MESSAGE_MAP_CAP,
                now,
            );
            bucket.refill(MESSAGE_RATE_PER_SEC, MESSAGE_BURST, now);
            bucket.tokens >= 1.0
        };
        self.global.refill(GLOBAL_RATE_PER_SEC, GLOBAL_BURST, now);

        if !peer_ok {
            return Err("limite de reações por participante atingido");
        }
        if !conversation_ok {
            return Err("limite de reações nesta conversa atingido");
        }
        if !message_ok {
            return Err("aguarde antes de alterar reações desta mensagem");
        }
        if self.global.tokens < 1.0 {
            return Err("limite global de reações atingido");
        }

        self.peers.get_mut(&peer_key).expect("bucket criado").tokens -= 1.0;
        self.conversations
            .get_mut(&conversation_key)
            .expect("bucket criado")
            .tokens -= 1.0;
        self.messages
            .get_mut(&message_key)
            .expect("bucket criado")
            .tokens -= 1.0;
        self.global.tokens -= 1.0;
        Ok(())
    }

    fn prune(&mut self, now: Instant) {
        if now.saturating_duration_since(self.last_prune) < PRUNE_INTERVAL {
            return;
        }
        self.peers
            .retain(|_, bucket| now.saturating_duration_since(bucket.last_seen) <= ENTRY_TTL);
        self.conversations
            .retain(|_, bucket| now.saturating_duration_since(bucket.last_seen) <= ENTRY_TTL);
        self.messages
            .retain(|_, bucket| now.saturating_duration_since(bucket.last_seen) <= ENTRY_TTL);
        self.last_prune = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permite_burst_de_cinco_e_refaz_um_token_por_segundo() {
        let t0 = Instant::now();
        let mut gate = ReactionLimiter::at(t0);

        for i in 0..5 {
            assert!(gate
                .allow_at("peer-a", "conv-a", &format!("msg-{i}"), t0)
                .is_ok());
        }
        assert!(gate.allow_at("peer-a", "conv-a", "msg-6", t0).is_err());
        assert!(gate
            .allow_at("peer-a", "conv-a", "msg-7", t0 + Duration::from_millis(999))
            .is_err());
        assert!(gate
            .allow_at("peer-a", "conv-a", "msg-8", t0 + Duration::from_secs(1))
            .is_ok());
    }

    #[test]
    fn limita_duas_alteracoes_por_segundo_na_mesma_mensagem() {
        let t0 = Instant::now();
        let mut gate = ReactionLimiter::at(t0);

        assert!(gate.allow_at("peer-a", "conv-a", "msg-a", t0).is_ok());
        assert!(gate.allow_at("peer-a", "conv-a", "msg-a", t0).is_ok());
        assert!(gate.allow_at("peer-a", "conv-a", "msg-a", t0).is_err());
        assert!(gate
            .allow_at("peer-a", "conv-a", "msg-a", t0 + Duration::from_millis(499))
            .is_err());
        assert!(gate
            .allow_at("peer-a", "conv-a", "msg-a", t0 + Duration::from_millis(500))
            .is_ok());
    }

    #[test]
    fn expira_chaves_inativas_e_mantem_tetos_de_memoria() {
        let t0 = Instant::now();
        let mut gate = ReactionLimiter::at(t0);
        gate.allow_at("peer-a", "conv-a", "msg-a", t0).unwrap();
        gate.prune(t0 + ENTRY_TTL + PRUNE_INTERVAL);
        assert!(gate.peers.is_empty());
        assert!(gate.conversations.is_empty());
        assert!(gate.messages.is_empty());

        for i in 0..(PEER_MAP_CAP + 1) {
            let peer = format!("peer-{i}");
            let _ = bucket_for(&mut gate.peers, peer, PEER_BURST, PEER_MAP_CAP, t0);
        }
        assert_eq!(gate.peers.len(), PEER_MAP_CAP);
    }
}
