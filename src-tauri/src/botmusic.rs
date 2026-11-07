//! Música do bot: liga a ponte `/v1/audio/*` ao misturador de áudio.
//!
//! Escopo declarado: o som toca no **alto-falante do PC do dono**, junto com a
//! voz. NÃO é enviado aos outros participantes da call — esse caminho é o track
//! de saída por peer (`spawn_send_loop`), alimentado pelo microfone, e injetar
//! música ali faria o bot soar como o próprio dono e o AEC trataria o som como
//! eco. A rota responde `delivered: "local"` em vez de fingir que transmitiu.
//!
//! Só existe no Linux: no Windows/Android o áudio da chamada é da WebView, que
//! o core não alcança. Nas outras plataformas o comando devolve erro honesto.

use std::collections::HashMap;
use std::sync::Mutex;

/// Teto de bytes por requisição de PCM (≈ 5 s a 48 kHz mono i16 = 480 KB).
/// Acima disso a ponte já recusa o corpo em 64 KB, então este teto é defesa
/// para o caminho que NÃO passa pela ponte HTTP (plugin local).
pub const MAX_PCM_BYTES: usize = 480_000;

pub struct MusicHandle {
    #[cfg(target_os = "linux")]
    sink: distorrent_core::net::bot_audio::MusicSink,
    /// Quantos frames entraram e quantos caíram, para o criador ver o
    /// backpressure em vez de "o som sumiu e não sei por quê".
    pub accepted: u64,
    pub dropped: u64,
}

impl MusicHandle {
    #[cfg(target_os = "linux")]
    pub fn new() -> Self {
        Self {
            sink: distorrent_core::net::bot_audio::open(),
            accepted: 0,
            dropped: 0,
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn new() -> Self {
        Self {
            accepted: 0,
            dropped: 0,
        }
    }

    /// PCM i16 mono 48 kHz, em little-endian.
    pub fn push_le(&mut self, bytes: &[u8], gain: f32) -> Result<(u64, u64), String> {
        if bytes.is_empty() {
            return Err("pcm vazio".into());
        }
        if bytes.len() > MAX_PCM_BYTES {
            return Err(format!(
                "pcm grande demais ({} bytes; máx {MAX_PCM_BYTES})",
                bytes.len()
            ));
        }
        if bytes.len() % 2 != 0 {
            return Err("pcm precisa ter número par de bytes (i16 little-endian)".into());
        }
        let pcm: Vec<i16> = bytes
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect();
        #[cfg(target_os = "linux")]
        {
            let com_ganho = distorrent_core::net::bot_audio::apply_gain(&pcm, gain);
            let (acc, drop) = self.sink.push_pcm(&com_ganho);
            self.accepted = self.accepted.saturating_add(acc as u64);
            self.dropped = self.dropped.saturating_add(drop as u64);
            Ok((acc as u64, drop as u64))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = (pcm, gain);
            Err(
                "tocar áudio de bot só existe no Linux: no Windows/Android o áudio da \
                 chamada é da WebView e o core não tem misturador"
                    .into(),
            )
        }
    }

    pub fn clear(&self) {
        #[cfg(target_os = "linux")]
        self.sink.clear();
    }
}

pub struct Music {
    map: Mutex<HashMap<String, MusicHandle>>,
}

impl Default for Music {
    fn default() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

impl Music {
    pub fn new() -> Self {
        Self::default()
    }

    /// Abre (ou reaproveita) o canal de música de um bot.
    pub fn open(&self, key: &str) -> (bool, usize) {
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        match m.get_mut(key) {
            Some(h) => (false, (h.accepted + h.dropped) as usize),
            None => {
                m.insert(key.to_string(), MusicHandle::new());
                (true, 0)
            }
        }
    }

    pub fn push(&self, key: &str, bytes: &[u8], gain: f32) -> Result<(u64, u64), String> {
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let Some(h) = m.get_mut(key) else {
            return Err("abra o canal de música antes de mandar pcm".into());
        };
        h.push_le(bytes, gain)
    }

    pub fn status(&self, key: &str) -> Option<(u64, u64)> {
        let m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        m.get(key).map(|h| (h.accepted, h.dropped))
    }

    /// Silencia e fecha. Fechar importa: um inbox morto continua sendo
    /// iterado pelo misturador a cada 20 ms.
    pub fn close(&self, key: &str) -> bool {
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(h) = m.remove(key) {
            h.clear();
            true
        } else {
            false
        }
    }
}
