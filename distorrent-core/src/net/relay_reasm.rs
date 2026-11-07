// Relay reasm: parte de net/relay.rs.
// Irmao do relay.rs; usa os tipos la declarados via super::*.

use super::*;

pub fn chunk_frame(from: &str, to: &str, msg_id: &str, frame: &[u8]) -> Vec<String> {
    if frame.is_empty() {
        return Vec::new();
    }
    let b64 = B64.encode(frame);
    if b64.len() <= RELAY_CHUNK_B64 {
        let s = serde_json::to_string(&RelayEnvelope {
            v: 1,
            from: from.to_string(),
            to: to.to_string(),
            msg_id: msg_id.to_string(),
            idx: 0,
            total: 1,
            data: b64,
        })
        .unwrap_or_default();
        if s.is_empty() {
            return Vec::new();
        }
        return vec![s];
    }
    let parts: Vec<&str> = b64
        .as_bytes()
        .chunks(RELAY_CHUNK_B64)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();
    let total = parts.len().max(1) as u32;
    if parts.is_empty() {
        return Vec::new();
    }
    parts
        .into_iter()
        .enumerate()
        .map(|(i, data)| {
            serde_json::to_string(&RelayEnvelope {
                v: 1,
                from: from.to_string(),
                to: to.to_string(),
                msg_id: msg_id.to_string(),
                idx: i as u32,
                total,
                data: data.to_string(),
            })
            .unwrap_or_default()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn chunk_frame_opaque(frame: &[u8]) -> Vec<String> {
    if frame.is_empty() {
        return Vec::new();
    }
    let b64 = B64.encode(frame);
    let rid = hex::encode(rand::random::<[u8; 16]>());
    if b64.len() <= RELAY_CHUNK_B64 {
        let s = serde_json::to_string(&OpaqueRelayEnvelope {
            v: 1,
            rid,
            idx: 0,
            total: 1,
            data: b64,
        })
        .unwrap_or_default();
        if s.is_empty() {
            return Vec::new();
        }
        return vec![s];
    }
    let parts: Vec<&str> = b64
        .as_bytes()
        .chunks(RELAY_CHUNK_B64)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();
    let total = parts.len().max(1) as u32;
    if parts.is_empty() {
        return Vec::new();
    }
    parts
        .into_iter()
        .enumerate()
        .map(|(i, data)| {
            serde_json::to_string(&OpaqueRelayEnvelope {
                v: 1,
                rid: rid.clone(),
                idx: i as u32,
                total,
                data: data.to_string(),
            })
            .unwrap_or_default()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

impl Reassembler {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
        }
    }

    pub fn feed(&mut self, my_fp: &str, raw: &str) -> Option<(String, Vec<u8>)> {
        if let Ok(env) = serde_json::from_str::<RelayEnvelope>(raw) {
            return self.feed_classic(my_fp, env);
        }
        let env: OpaqueRelayEnvelope = serde_json::from_str(raw).ok()?;
        self.feed_opaque(env)
    }

    fn feed_classic(&mut self, my_fp: &str, env: RelayEnvelope) -> Option<(String, Vec<u8>)> {
        if env.v != 1 || env.to != my_fp {
            return None;
        }
        if env.from.len() > 64 || env.msg_id.len() > 64 || env.total == 0 || env.total > 512 {
            return None;
        }
        if env.idx >= env.total || env.data.len() > RELAY_CHUNK_B64 + 64 {
            return None;
        }
        if env.total == 1 {
            if env.idx != 0 {
                return None;
            }
            let bytes = B64.decode(env.data.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((env.from, bytes));
        }
        if self.pending.len() > 256 {
            self.pending.clear();
        }
        let key = format!("{}:{}", env.from, env.msg_id);
        let slot = self
            .pending
            .entry(key)
            .or_insert_with(|| vec![None; env.total as usize]);
        if slot.len() != env.total as usize {
            return None;
        }
        slot[env.idx as usize] = Some(env.data.clone());
        if slot.iter().all(|p| p.is_some()) {
            let b64: String = slot.iter().flatten().cloned().collect();
            self.pending.remove(&format!("{}:{}", env.from, env.msg_id));
            let bytes = B64.decode(b64.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((env.from, bytes));
        }
        None
    }

    fn feed_opaque(&mut self, env: OpaqueRelayEnvelope) -> Option<(String, Vec<u8>)> {
        if env.v != 1 || env.rid.len() > 64 || env.total == 0 || env.total > 512 {
            return None;
        }
        if env.idx >= env.total || env.data.len() > RELAY_CHUNK_B64 + 64 {
            return None;
        }
        if env.total == 1 {
            if env.idx != 0 {
                return None;
            }
            let bytes = B64.decode(env.data.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((String::new(), bytes));
        }
        if self.pending.len() > 256 {
            self.pending.clear();
        }
        let key = format!("o:{}", env.rid);
        let slot = self
            .pending
            .entry(key)
            .or_insert_with(|| vec![None; env.total as usize]);
        if slot.len() != env.total as usize {
            return None;
        }
        slot[env.idx as usize] = Some(env.data.clone());
        if slot.iter().all(|p| p.is_some()) {
            let b64: String = slot.iter().flatten().cloned().collect();
            self.pending.remove(&format!("o:{}", env.rid));
            let bytes = B64.decode(b64.as_bytes()).ok()?;
            if bytes.len() > RELAY_MAX_FRAME || bytes.len() < 4 {
                return None;
            }
            return Some((String::new(), bytes));
        }
        None
    }
}

impl Default for Reassembler {
    fn default() -> Self {
        Self::new()
    }
}

impl RelayStream {
    pub fn new(
        inbound: mpsc::UnboundedReceiver<Vec<u8>>,
        outbound: mpsc::UnboundedSender<Vec<u8>>,
    ) -> Self {
        Self {
            inbound,
            outbound,
            read_buf: Vec::new(),
            read_pos: 0,
            write_buf: Vec::new(),
        }
    }

    pub(super) fn flush_frames(&mut self) -> std::io::Result<()> {
        loop {
            if self.write_buf.len() < 4 {
                break;
            }
            let len = u32::from_be_bytes([
                self.write_buf[0],
                self.write_buf[1],
                self.write_buf[2],
                self.write_buf[3],
            ]) as usize;
            if len > (1 << 20) {
                return Err(std::io::Error::other("frame gigante no relay"));
            }
            if self.write_buf.len() < 4 + len {
                break;
            }
            let frame: Vec<u8> = self.write_buf.drain(..4 + len).collect();
            self.outbound
                .send(frame)
                .map_err(|_| std::io::Error::other("relay fechado"))?;
        }
        Ok(())
    }
}
