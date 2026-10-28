//! Métricas de runtime (dev mode / diagnóstico).
//!
//! Contadores atômicos globais + RTT EMA por peer. Sem custo perceptível no
//! caminho quente (AtomicU64 relaxed). NUNCA registra conteúdo: só contagens
//! e latências.
//!
//! Consumo: painel interno de dev via command `metrics_snapshot`. Em
//! produção os números continuam coletados (custo ~0) mas a UI não os expõe.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

/// Classe de tráfego QoS — espelha a classificação do engine (menor = prioridade maior).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameClass {
    /// Voz/vídeo/sinalização de chamada + liveness (Ping/Pong).
    Realtime = 0,
    /// Controle de conexão/social: amizade, comunidades, PEX, punch.
    Control = 1,
    /// Mensagens (Msg/ChannelMsg) + acks.
    Message = 2,
    /// Transferência de arquivos (chunks/announce) — fundo da fila.
    Bulk = 3,
}

impl FrameClass {
    pub fn index(self) -> usize {
        self as usize
    }

    /// Converte o índice da fila QoS (0-3) de volta para a classe.
    pub fn by_index(i: u8) -> FrameClass {
        match i & 3 {
            0 => FrameClass::Realtime,
            1 => FrameClass::Control,
            2 => FrameClass::Message,
            _ => FrameClass::Bulk,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            FrameClass::Realtime => "realtime",
            FrameClass::Control => "control",
            FrameClass::Message => "message",
            FrameClass::Bulk => "bulk",
        }
    }
}

pub struct Metrics {
    frames_tx: [AtomicU64; 4],
    frames_rx: [AtomicU64; 4],
    bytes_tx: AtomicU64,
    bytes_rx: AtomicU64,
    spam_rejected: AtomicU64,
    messages_in: AtomicU64,
    messages_out: AtomicU64,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    vault_ops: AtomicU64,
    rtt_by_peer: Mutex<HashMap<String, u64>>,
}

impl Metrics {
    fn new() -> Self {
        Self {
            frames_tx: std::array::from_fn(|_| AtomicU64::new(0)),
            frames_rx: std::array::from_fn(|_| AtomicU64::new(0)),
            bytes_tx: AtomicU64::new(0),
            bytes_rx: AtomicU64::new(0),
            spam_rejected: AtomicU64::new(0),
            messages_in: AtomicU64::new(0),
            messages_out: AtomicU64::new(0),
            cache_hits: AtomicU64::new(0),
            cache_misses: AtomicU64::new(0),
            vault_ops: AtomicU64::new(0),
            rtt_by_peer: Mutex::new(HashMap::new()),
        }
    }
}

/// Registro global (uma instância por processo — apps headless e Tauri).
static METRICS: OnceLock<Metrics> = OnceLock::new();

pub fn metrics() -> &'static Metrics {
    METRICS.get_or_init(Metrics::new)
}

impl Metrics {
    pub fn frame_tx(&self, class: FrameClass, wire_bytes: u64) {
        self.frames_tx[class.index()].fetch_add(1, Ordering::Relaxed);
        self.bytes_tx.fetch_add(wire_bytes, Ordering::Relaxed);
    }

    pub fn frame_rx(&self, class: FrameClass, wire_bytes: u64) {
        self.frames_rx[class.index()].fetch_add(1, Ordering::Relaxed);
        self.bytes_rx.fetch_add(wire_bytes, Ordering::Relaxed);
    }

    pub fn spam_rejected(&self) {
        self.spam_rejected.fetch_add(1, Ordering::Relaxed);
    }

    pub fn message_in(&self) {
        self.messages_in.fetch_add(1, Ordering::Relaxed);
    }

    pub fn message_out(&self) {
        self.messages_out.fetch_add(1, Ordering::Relaxed);
    }

    pub fn cache_hit(&self) {
        self.cache_hits.fetch_add(1, Ordering::Relaxed);
    }

    pub fn cache_miss(&self) {
        self.cache_misses.fetch_add(1, Ordering::Relaxed);
    }

    pub fn vault_op(&self) {
        self.vault_ops.fetch_add(1, Ordering::Relaxed);
    }

    /// RTT medido sobre Ping/Pong (EMA α≈0.3, ms).
    pub fn rtt_sample(&self, peer_fp: &str, rtt_ms: u64) {
        let mut map = self.rtt_by_peer.lock().unwrap_or_else(|e| e.into_inner());
        let next = match map.get(peer_fp) {
            Some(prev) => {
                let prev = *prev as f64;
                ((0.3 * rtt_ms as f64) + (0.7 * prev)).round() as u64
            }
            None => rtt_ms,
        };
        map.insert(peer_fp.to_string(), next);
        if map.len() > 1024 {
            // anti-crescimento: descarta amostras excedentes (ordem arbitrária)
            let excess = map.len() - 1024;
            let drop: Vec<String> = map.keys().take(excess).cloned().collect();
            for k in drop {
                map.remove(&k);
            }
        }
    }

    /// RTT estimado do peer (ms) — None = sem amostra ainda.
    pub fn rtt_of(&self, peer_fp: &str) -> Option<u64> {
        let map = self.rtt_by_peer.lock().unwrap_or_else(|e| e.into_inner());
        map.get(peer_fp).copied()
    }

    /// Snapshot para o painel dev (JSON). Só contagens — nada sensível.
    pub fn snapshot(&self) -> serde_json::Value {
        let frames_tx: Vec<u64> = self
            .frames_tx
            .iter()
            .map(|c| c.load(Ordering::Relaxed))
            .collect();
        let frames_rx: Vec<u64> = self
            .frames_rx
            .iter()
            .map(|c| c.load(Ordering::Relaxed))
            .collect();
        let peers: serde_json::Map<String, serde_json::Value> = {
            let map = self.rtt_by_peer.lock().unwrap_or_else(|e| e.into_inner());
            let mut m = serde_json::Map::new();
            for (fp, rtt) in map.iter().take(64) {
                m.insert(fp.clone(), serde_json::json!(rtt));
            }
            m
        };
        serde_json::json!({
            "frames_tx": frames_tx,
            "frames_rx": frames_rx,
            "classes": ["realtime", "control", "message", "bulk"],
            "bytes_tx": self.bytes_tx.load(Ordering::Relaxed),
            "bytes_rx": self.bytes_rx.load(Ordering::Relaxed),
            "spam_rejected": self.spam_rejected.load(Ordering::Relaxed),
            "messages_in": self.messages_in.load(Ordering::Relaxed),
            "messages_out": self.messages_out.load(Ordering::Relaxed),
            "cache_hits": self.cache_hits.load(Ordering::Relaxed),
            "cache_misses": self.cache_misses.load(Ordering::Relaxed),
            "vault_ops": self.vault_ops.load(Ordering::Relaxed),
            "rtt_by_peer_ms": peers,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counters_cumulativos() {
        // usa a global mesmo (processo de teste isolado por binário de teste)
        let m = metrics();
        let tx_before = m.frames_tx[FrameClass::Bulk.index()].load(Ordering::Relaxed);
        m.frame_tx(FrameClass::Bulk, 1000);
        assert_eq!(
            m.frames_tx[FrameClass::Bulk.index()].load(Ordering::Relaxed),
            tx_before + 1
        );
        let bytes_before = m.bytes_tx.load(Ordering::Relaxed);
        m.frame_tx(FrameClass::Realtime, 50);
        assert_eq!(m.bytes_tx.load(Ordering::Relaxed), bytes_before + 50);
    }

    #[test]
    fn rtt_ema_converge() {
        let m = metrics();
        m.rtt_sample("fp-ema-test", 100);
        m.rtt_sample("fp-ema-test", 200);
        let v = m.rtt_of("fp-ema-test").unwrap();
        // 100 → EMA(200): 0.3*200 + 0.7*100 = 130
        assert!((120..=140).contains(&v), "EMA deveria ficar ~130, veio {v}");
    }

    #[test]
    fn snapshot_nao_expoe_dados_sensiveis() {
        let m = metrics();
        let s = serde_json::to_string(&m.snapshot()).unwrap();
        assert!(s.contains("frames_tx"));
        assert!(!s.contains("identity.secret"));
    }
}
