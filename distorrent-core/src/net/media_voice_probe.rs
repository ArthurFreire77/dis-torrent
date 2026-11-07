// probe de media_voice.rs (extraido para o arquivo nao passar de 1.000 linhas).

use super::*;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

type Key = (u32, u64);

const MAX_PENDING: usize = 8192;

#[derive(Default)]
pub struct LatencyProbe {
    captured: Mutex<HashMap<Key, Instant>>,
    played: Mutex<HashMap<Key, Instant>>,
    released: Mutex<HashMap<Key, Instant>>,
    deltas: Mutex<Vec<Duration>>,
    seg_a: Mutex<Vec<Duration>>,
    seg_b: Mutex<Vec<Duration>>,
}

impl LatencyProbe {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&self) {
        self.captured.lock().unwrap().clear();
        self.played.lock().unwrap().clear();
        self.released.lock().unwrap().clear();
        self.deltas.lock().unwrap().clear();
        self.seg_a.lock().unwrap().clear();
        self.seg_b.lock().unwrap().clear();
    }

    pub fn stamp_release(&self, link: u32, idx: u64, at: Instant) {
        self.released.lock().unwrap().insert((link, idx), at);
    }

    pub fn segments_ms(&self) -> Option<((f64, f64), (f64, f64))> {
        let pct = |v: &[Duration], p: f64| -> f64 {
            if v.is_empty() {
                return f64::NAN;
            }
            let mut x: Vec<u64> = v.iter().map(|d| d.as_micros() as u64).collect();
            x.sort_unstable();
            let i = (((x.len() - 1) as f64) * p).round() as usize;
            x[i] as f64 / 1000.0
        };
        let a = { self.seg_a.lock().unwrap().clone() };
        let b = { self.seg_b.lock().unwrap().clone() };
        if a.is_empty() && b.is_empty() {
            return None;
        }
        Some(((pct(&a, 0.5), pct(&a, 0.95)), (pct(&b, 0.5), pct(&b, 0.95))))
    }

    pub fn stamp_capture(&self, link: u32, idx: u64, at: Instant) {
        let mut m = self.captured.lock().unwrap();
        if m.len() >= MAX_PENDING {
            let mut keys: Vec<Key> = m.keys().copied().collect();
            keys.sort_unstable_by_key(|k| k.1);
            for k in keys.into_iter().take(MAX_PENDING / 2) {
                m.remove(&k);
            }
        }
        m.insert((link, idx), at);
    }

    pub fn stamp_play(&self, link: u32, idx: u64, at: Instant) {
        let captured = self.captured.lock().unwrap().remove(&(link, idx));
        let released = self.released.lock().unwrap().remove(&(link, idx));
        if let Some(c) = captured {
            if let Some(d) = at.checked_duration_since(c) {
                self.deltas.lock().unwrap().push(d);
            }
            if let Some(r) = released {
                if let Some(d) = r.checked_duration_since(c) {
                    self.seg_a.lock().unwrap().push(d);
                }
                if let Some(d) = at.checked_duration_since(r) {
                    self.seg_b.lock().unwrap().push(d);
                }
            }
        } else {
            let mut p = self.played.lock().unwrap();
            if p.len() >= MAX_PENDING {
                p.clear();
            }
            p.insert((link, idx), at);
        }
    }

    pub fn count(&self) -> usize {
        self.deltas.lock().unwrap().len()
    }

    pub fn samples(&self) -> Vec<Duration> {
        self.deltas.lock().unwrap().clone()
    }

    pub fn median_p95_ms(&self) -> Option<(f64, f64)> {
        let mut v: Vec<u64> = self
            .deltas
            .lock()
            .unwrap()
            .iter()
            .map(|d| d.as_micros() as u64)
            .collect();
        if v.is_empty() {
            return None;
        }
        v.sort_unstable();
        let pct = |p: f64| -> f64 {
            let i = (((v.len() - 1) as f64) * p).round() as usize;
            v[i] as f64 / 1000.0
        };
        Some((pct(0.50), pct(0.95)))
    }
}

static PROBE: OnceLock<LatencyProbe> = OnceLock::new();

pub fn probe() -> &'static LatencyProbe {
    PROBE.get_or_init(LatencyProbe::new)
}
