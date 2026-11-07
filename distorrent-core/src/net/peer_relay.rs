use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex as StdMutex, OnceLock};

use crate::net::relay::RELAY_TOPIC_PREFIX;

pub const MAX_BODY_BYTES: usize = 48 * 1024;
pub const MAX_MSGS_PER_TOPIC: usize = 256;
pub const MAX_TOPIC_BYTES: usize = 384 * 1024;
pub const MAX_TOPICS: usize = 1024;
pub const MAX_TOPIC_NAME: usize = 128;
pub const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_RELAY_DATA_BYTES: usize = 512 * 1024;

struct Topic {
    msgs: VecDeque<String>,
    bytes: usize,
    seq: u64,
}

struct Inner {
    topics: HashMap<String, Topic>,
    total_bytes: usize,
    next_seq: u64,
}

pub struct PeerRelayBroker {
    inner: StdMutex<Inner>,
}

impl Default for PeerRelayBroker {
    fn default() -> Self {
        Self::new()
    }
}

fn topic_owner(topic: &str) -> Option<&str> {
    topic
        .strip_prefix(RELAY_TOPIC_PREFIX)
        .filter(|s| !s.is_empty())
}

impl PeerRelayBroker {
    pub fn new() -> Self {
        Self {
            inner: StdMutex::new(Inner {
                topics: HashMap::new(),
                total_bytes: 0,
                next_seq: 0,
            }),
        }
    }

    pub fn put(&self, _sender_fp: &str, topic: &str, body: &str) -> bool {
        if topic.is_empty() || topic.len() > MAX_TOPIC_NAME || body.len() > MAX_BODY_BYTES {
            return false;
        }
        let body_len = body.len();
        let mut st = self.inner.lock().unwrap_or_else(|e| e.into_inner());

        if !st.topics.contains_key(topic) && st.topics.len() >= MAX_TOPICS {
            if let Some(old) = st
                .topics
                .iter()
                .min_by_key(|(_, t)| t.seq)
                .map(|(k, _)| k.clone())
            {
                if let Some(t) = st.topics.remove(&old) {
                    st.total_bytes = st.total_bytes.saturating_sub(t.bytes);
                }
            }
        }

        let seq = st.next_seq;
        st.next_seq = st.next_seq.wrapping_add(1);
        let mut removed = 0usize;
        {
            let entry = st.topics.entry(topic.to_string()).or_insert_with(|| Topic {
                msgs: VecDeque::new(),
                bytes: 0,
                seq,
            });
            entry.seq = seq;
            entry.msgs.push_back(body.to_string());
            entry.bytes += body_len;
            while entry.msgs.len() > MAX_MSGS_PER_TOPIC || entry.bytes > MAX_TOPIC_BYTES {
                let Some(old) = entry.msgs.pop_front() else {
                    break;
                };
                let n = old.len();
                entry.bytes = entry.bytes.saturating_sub(n);
                removed += n;
            }
        }
        st.total_bytes = st
            .total_bytes
            .saturating_add(body_len)
            .saturating_sub(removed);

        while st.total_bytes > MAX_TOTAL_BYTES {
            let Some(old) = st
                .topics
                .iter()
                .min_by_key(|(_, t)| t.seq)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(t) = st.topics.remove(&old) {
                st.total_bytes = st.total_bytes.saturating_sub(t.bytes);
            }
        }
        true
    }

    pub fn get(&self, requester_fp: &str, topic: &str, _req_id: u32) -> Vec<String> {
        let Some(owner) = topic_owner(topic) else {
            return Vec::new();
        };
        if requester_fp.is_empty() || owner != requester_fp {
            tracing::debug!(
                requester = %requester_fp,
                %topic,
                "peer-relay broker: get negado (tópico de outro par)"
            );
            return Vec::new();
        }
        self.take_unchecked(topic)
    }

    fn take_unchecked(&self, topic: &str) -> Vec<String> {
        let mut st = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(t) = st.topics.remove(topic) else {
            return Vec::new();
        };
        st.total_bytes = st.total_bytes.saturating_sub(t.bytes);
        t.msgs.into_iter().collect()
    }

    pub fn topic_count(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .topics
            .len()
    }

    pub fn total_bytes(&self) -> usize {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .total_bytes
    }
}

pub fn fit_relay_data(mut bodies: Vec<String>) -> Vec<String> {
    fn serialized_len(bodies: &[String]) -> usize {
        serde_json::to_vec(&crate::protocol::SecureFrame::PeerRelayData {
            req_id: 0,
            bodies: bodies.to_vec(),
        })
        .map(|v| v.len())
        .unwrap_or(usize::MAX)
    }
    while !bodies.is_empty() && serialized_len(&bodies) > MAX_RELAY_DATA_BYTES {
        bodies.pop();
    }
    bodies
}

static GLOBAL: OnceLock<PeerRelayBroker> = OnceLock::new();

pub fn broker() -> &'static PeerRelayBroker {
    GLOBAL.get_or_init(PeerRelayBroker::new)
}

pub fn put(sender_fp: &str, topic: &str, body: &str) -> bool {
    broker().put(sender_fp, topic, body)
}

pub fn get(requester_fp: &str, topic: &str, req_id: u32) -> Vec<String> {
    broker().get(requester_fp, topic, req_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::relay::RELAY_CHUNK_B64;

    #[test]
    fn put_get_drena_dono() {
        let b = PeerRelayBroker::new();
        assert!(b.put("A", "distorrent_r_B", "a"));
        assert!(b.put("A", "distorrent_r_B", "b"));
        assert_eq!(
            b.get("B", "distorrent_r_B", 1),
            vec!["a".to_string(), "b".to_string()]
        );
        assert!(
            b.get("B", "distorrent_r_B", 2).is_empty(),
            "segundo get drena vazio"
        );
    }

    #[test]
    fn get_negado_para_nao_dono() {
        let b = PeerRelayBroker::new();
        assert!(b.put("A", "distorrent_r_B", "segredo"));
        assert!(
            b.get("C", "distorrent_r_B", 7).is_empty(),
            "não-dono não drena"
        );
        assert_eq!(b.topic_count(), 1, "tópico intacto após tentativa negada");
        assert!(b.get("B", "sem-prefixo", 8).is_empty());
        assert!(b.get("", "distorrent_r_B", 9).is_empty());
        assert_eq!(
            b.get("B", "distorrent_r_B", 10),
            vec!["segredo".to_string()]
        );
    }

    #[test]
    fn topico_vazio_retorna_vazio() {
        let b = PeerRelayBroker::new();
        assert!(b.get("B", "nao-existe", 7).is_empty());
        assert!(b.get("B", "distorrent_r_outro", 7).is_empty());
        assert_eq!(b.topic_count(), 0);
        assert_eq!(b.total_bytes(), 0);
    }

    #[test]
    fn cap_por_topico_descarta_mais_antigos() {
        let b = PeerRelayBroker::new();
        let t = "distorrent_r_dono";
        for i in 0..(MAX_MSGS_PER_TOPIC + 50) {
            assert!(b.put("A", t, &format!("m{i}")));
        }
        let got = b.get("dono", t, 1);
        assert_eq!(got.len(), MAX_MSGS_PER_TOPIC, "cap de mensagens por tópico");
        assert_eq!(got.first().unwrap(), &format!("m{}", 50));
        assert_eq!(
            got.last().unwrap(),
            &format!("m{}", MAX_MSGS_PER_TOPIC + 49)
        );
    }

    #[test]
    fn corpo_gigante_e_topico_gigante_rejeitados() {
        let b = PeerRelayBroker::new();
        let grande = "x".repeat(MAX_BODY_BYTES + 1);
        assert!(
            !b.put("A", "distorrent_r_dono", &grande),
            "corpo acima do cap é rejeitado"
        );
        let nome = format!("{}{}", RELAY_TOPIC_PREFIX, "t".repeat(MAX_TOPIC_NAME + 1));
        assert!(!b.put("A", &nome, "ok"), "tópico acima do cap é rejeitado");
        assert!(!b.put("A", "", "ok"), "tópico vazio é rejeitado");
        assert_eq!(b.topic_count(), 0);
    }

    #[test]
    fn cap_de_topicos_limitado() {
        let b = PeerRelayBroker::new();
        for i in 0..(MAX_TOPICS + 100) {
            assert!(b.put("A", &format!("distorrent_r_t{i}"), "x"));
        }
        assert_eq!(
            b.topic_count(),
            MAX_TOPICS,
            "nº de tópicos deve ficar no cap"
        );
        let last = MAX_TOPICS + 99;
        assert_eq!(
            b.get(&format!("t{last}"), &format!("distorrent_r_t{last}"), 1)
                .len(),
            1,
            "tópico recente presente"
        );
        assert!(
            b.get("t0", "distorrent_r_t0", 1).is_empty(),
            "tópico mais antigo evictado"
        );
    }

    #[test]
    fn cap_total_bytes_limitado() {
        let b = PeerRelayBroker::new();
        let body = "y".repeat(MAX_BODY_BYTES);
        for i in 0..2000 {
            assert!(b.put("A", &format!("distorrent_r_t{i}"), &body));
        }
        assert!(b.total_bytes() <= MAX_TOTAL_BYTES, "cap global de bytes");
        assert!(b.topic_count() <= MAX_TOPICS);
    }

    #[test]
    fn relay_data_cabe_no_max_frame() {
        let b = PeerRelayBroker::new();
        let t = "distorrent_r_dono";
        let chunk = "\n".repeat(RELAY_CHUNK_B64);
        let mut guard = 0;
        while b.put("A", t, &chunk) {
            guard += 1;
            if guard > 4096 {
                break;
            }
        }
        let bodies = b.get("dono", t, 1);
        let raw = serde_json::to_vec(&crate::protocol::SecureFrame::PeerRelayData {
            req_id: 0,
            bodies: bodies.clone(),
        })
        .unwrap();
        assert!(
            raw.len() < (1 << 20),
            "PeerRelayData serializado ({}) deve caber em MAX_FRAME",
            raw.len()
        );
        let fitted = fit_relay_data(bodies);
        let raw2 = serde_json::to_vec(&crate::protocol::SecureFrame::PeerRelayData {
            req_id: 0,
            bodies: fitted,
        })
        .unwrap();
        assert!(
            raw2.len() <= MAX_RELAY_DATA_BYTES,
            "fit_relay_data respeita o teto ({})",
            raw2.len()
        );
    }

    #[test]
    fn fit_relay_data_descarta_excedente() {
        let b = PeerRelayBroker::new();
        let t = "distorrent_r_dono";
        for _ in 0..80 {
            let _ = b.put("A", t, &"\u{0007}".repeat(MAX_BODY_BYTES));
        }
        let bodies = b.get("dono", t, 1);
        if bodies.is_empty() {
            return;
        }
        let fitted = fit_relay_data(bodies);
        let raw = serde_json::to_vec(&crate::protocol::SecureFrame::PeerRelayData {
            req_id: 0,
            bodies: fitted,
        })
        .unwrap();
        assert!(raw.len() <= MAX_RELAY_DATA_BYTES);
    }
}
