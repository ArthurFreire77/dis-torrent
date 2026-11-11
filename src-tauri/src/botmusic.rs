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
    /// Fila de PCM para o frontend consumir (Windows/Android/macOS).
    ///
    /// POR QUE uma fila: nas plataformas em que a chamada é da WebView, o core
    /// não alcança o track de áudio. O bot manda o PCM pela ponte, o app
    /// enfileira aqui e o frontend puxa em `bot_audio_drain` para tocar na
    /// track do participante.
    #[cfg(not(target_os = "linux"))]
    fila: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<Vec<i16>>>>,
    /// Quantos frames entraram e quantos caíram, para o criador ver o
    /// backpressure em vez de "o som sumiu e não sei por quê".
    pub accepted: u64,
    pub dropped: u64,
}

/// Teto da fila no frontend: 250 frames de 20 ms = 5 s. Sem teto, um bot que
/// empurra mais rápido do que o WebView consome cresce a memória sem limite.
pub const MAX_QUEUE_FRAMES_WEBVIEW: usize = 250;

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
            fila: std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new())),
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
            let mut q = self.fila.lock().unwrap_or_else(|e| e.into_inner());
            let mut aceitos = 0u64;
            let mut descartados = 0u64;
            // 48 kHz mono: 960 amostras = 20 ms por frame.
            const FRAME: usize = 960;
            for chunk in pcm.chunks(FRAME) {
                while q.len() >= MAX_QUEUE_FRAMES_WEBVIEW {
                    q.pop_front();
                    descartados += 1;
                }
                let mut frame = chunk.to_vec();
                frame.resize(FRAME, 0);
                q.push_back(frame);
                aceitos += 1;
            }
            self.accepted = self.accepted.saturating_add(aceitos);
            self.dropped = self.dropped.saturating_add(descartados);
            let _ = gain;
            Ok((aceitos, descartados))
        }
    }

    /// Tira até `max` frames da fila (PCM i16 mono 48 kHz).
    #[cfg(not(target_os = "linux"))]
    pub fn drain(&mut self, max: usize) -> Vec<Vec<i16>> {
        let mut q = self.fila.lock().unwrap_or_else(|e| e.into_inner());
        let n = max.min(q.len());
        q.drain(..n).collect()
    }

    #[cfg(target_os = "linux")]
    pub fn drain(&mut self, _max: usize) -> Vec<Vec<i16>> {
        // No Linux o misturador consome direto; não há fila para puxar.
        Vec::new()
    }

    pub fn clear(&self) {
        #[cfg(target_os = "linux")]
        self.sink.clear();
    }
}

pub struct Music {
    map: Mutex<HashMap<String, MusicHandle>>,
}

/// Pedidos de entrada na call: `(community_id, bot_id)`. O frontend consome
/// via `bot_call_take`, que zera a entrada. Um bot que abre `/v1/audio/open`
/// quer entrar como participante com áudio próprio.
static PEDIDOS_CALL: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

pub fn marcar_pedido_de_call(community_id: &str, bot_id: &str) {
    let mut p = PEDIDOS_CALL.lock().unwrap_or_else(|e| e.into_inner());
    let entrada = (community_id.to_string(), bot_id.to_string());
    if !p.contains(&entrada) {
        // Teto: a fila não pode crescer sem limite se o frontend não consumir.
        if p.len() >= 32 {
            p.remove(0);
        }
        p.push(entrada);
    }
}

/// Tira (e devolve) os pedidos pendentes. Consumir zera: o frontend decide uma
/// vez por pedido.
pub fn tomar_pedidos_de_call() -> Vec<(String, String)> {
    let mut p = PEDIDOS_CALL.lock().unwrap_or_else(|e| e.into_inner());
    std::mem::take(&mut *p)
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

    /// Puxa até `max` frames de PCM do bot (20 ms cada, 48 kHz mono).
    pub fn drain(&self, key: &str, max: usize) -> Vec<Vec<i16>> {
        let mut m = self.map.lock().unwrap_or_else(|e| e.into_inner());
        m.get_mut(key).map(|h| h.drain(max)).unwrap_or_default()
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
