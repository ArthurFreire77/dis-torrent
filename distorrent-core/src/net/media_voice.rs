//! Mídia de voz NATIVA (Rust/webrtc-rs + cpal + Opus) — motor de áudio Linux;
//! fala SDP/trickle ICE padrão, conversa com navegador sem tradutor. Decisões
//! fixas (não reverter sem medir): jitter 50 ms, buffer cpal EXPLÍCITO 960
//! frames, Opus 20 ms/48 kHz/mono/VOIP sem DTX, `Sample::new` = instante real
//! de captura, sem AGC na captura. REGRA: este módulo nunca decide chamada por
//! conta própria — só atua em (call_id, peer_fp) registrados no engine;
//! sem registro, o WebRTC do navegador é o dono (mantém Win/Android/macOS).

pub mod probe {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    /// (link, índice do frame de 20 ms) — distingue direções no mesmo processo.
    type Key = (u32, u64);

    /// Janela de retenção de capturas ainda não pareadas com um playout.
    const MAX_PENDING: usize = 8192;

    #[derive(Default)]
    pub struct LatencyProbe {
        captured: Mutex<HashMap<Key, Instant>>,
        played: Mutex<HashMap<Key, Instant>>,
        released: Mutex<HashMap<Key, Instant>>,
        deltas: Mutex<Vec<Duration>>,
        /// (captura -> liberacao do jitter buffer) e (liberacao -> playout).
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

        /// Instante em que o jitter buffer entregou o frame a aplicacao.
        pub fn stamp_release(&self, link: u32, idx: u64, at: Instant) {
            self.released.lock().unwrap().insert((link, idx), at);
        }

        /// Medianas (ms) dos segmentos captura→liberação e liberação→playout.
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

        /// Instante de captura do frame `idx` da direcao `link`.
        pub fn stamp_capture(&self, link: u32, idx: u64, at: Instant) {
            let mut m = self.captured.lock().unwrap();
            if m.len() >= MAX_PENDING {
                // Esquece os mais antigos: frame nunca pareado não cresce sem limite.
                let mut keys: Vec<Key> = m.keys().copied().collect();
                keys.sort_unstable_by_key(|k| k.1);
                for k in keys.into_iter().take(MAX_PENDING / 2) {
                    m.remove(&k);
                }
            }
            m.insert((link, idx), at);
        }

        /// Instante de playout do frame `idx`. Casa com a captura e guarda o delta.
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

        /// (mediana, p95) em ms. `None` enquanto nenhum frame foi pareado.
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

    /// Singleton: callback cpal (thread realtime) e tasks de áudio chegam nela.
    pub fn probe() -> &'static LatencyProbe {
        PROBE.get_or_init(LatencyProbe::new)
    }
}

pub mod audio {

    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

    use super::probe::probe;

    pub const SAMPLE_RATE: u32 = 48_000;
    pub const FRAME_MS: u32 = 20;
    pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize / 1000) * FRAME_MS as usize; // 960
    pub const FRAME: Duration = Duration::from_millis(FRAME_MS as u64);

    /// Buffer cpal EXPLÍCITO (20 ms @ 48 kHz). `Default` nunca — em ALSA/PipeWire
    /// pode resolver para 1024..=u32::MAX frames e quebrar 1 callback = 1 frame.
    pub const DEVICE_BUFFER: u32 = FRAME_SAMPLES as u32; // 960

    /// Frame capturado, datado com o instante do PRIMEIRO sample (não da callback).
    #[derive(Clone)]
    pub struct MicFrame {
        pub pcm: Arc<Vec<i16>>,
        pub captured_at: Instant,
    }

    /// Quadro decodificado; `id` = (link, idx) para a sonda de latência.
    pub struct PcmFrame {
        pub pcm: Arc<Vec<i16>>,
        pub id: Option<(u32, u64)>,
    }

    // `cpal::Stream` 0.18 é struct por backend; tipo = `DeviceTrait::Stream`.
    type HStream = <cpal::Device as cpal::traits::DeviceTrait>::Stream;
    type SpkStream = Box<HStream>;
    type MicStream = Box<HStream>;
    type Inbox = Arc<Mutex<VecDeque<PcmFrame>>>;

    // ---------------------------------------------------------------- resampler

    /// Resampler linear com FASE PERSISTENTE: por-callback perdia fase e o
    /// frame de 960 nunca fechava em taxa não-inteira (44.1 kHz).
    struct Resampler {
        step: f64,
        pos: f64,
        carry: Vec<i16>,
    }

    impl Resampler {
        fn new(from: u32, to: u32) -> Self {
            Self {
                step: f64::from(from) / f64::from(to),
                pos: 0.0,
                carry: Vec::new(),
            }
        }

        /// Consome mono i16 @ `from` Hz e devolve mono i16 @ 48 kHz.
        fn process(&mut self, input: &[i16]) -> Vec<i16> {
            if (self.step - 1.0).abs() < 1e-9 {
                return input.to_vec();
            }
            self.carry.extend_from_slice(input);
            let n = self.carry.len();
            if n < 2 {
                return Vec::new();
            }
            let mut out = Vec::with_capacity((n as f64 / self.step) as usize + 2);
            while self.pos < (n - 1) as f64 {
                let i = self.pos as usize;
                let frac = (self.pos - i as f64) as f32;
                let a = self.carry[i] as f32;
                let b = self.carry[i + 1] as f32;
                out.push((a + (b - a) * frac) as i16);
                self.pos += self.step;
            }
            let consumed = (self.pos as usize).min(n);
            self.carry.drain(..consumed);
            self.pos -= consumed as f64;
            out
        }
    }

    /// Amplificador de pico do mic (alvo -6 dBFS): device a 31% chegava como
    /// sussurro ("não captura áudio"). Só amplifica, teto 12x, com noise gate
    /// (sem gate o AGC subia ganho entre palavras e o par ouvia chiado).
    pub(super) struct MicGain {
        pub(super) gain: f32,
    }

    impl MicGain {
        pub(super) fn new() -> Self {
            Self { gain: 1.0 }
        }

        /// Alvo de pico: -6 dBFS.
        pub(super) const TARGET: f32 = 0.5;
        /// Teto de amplificação.
        pub(super) const MAX_GAIN: f32 = 12.0;
        /// Piso de ruído (-48 dBFS): abaixo disso é silêncio, não voz baixa.
        pub(super) const NOISE_FLOOR: f32 = 0.004;

        pub(super) fn process(&mut self, mono: &mut [i16]) {
            let peak = mono.iter().fold(0i16, |m, s| m.max(s.abs())) as f32 / i16::MAX as f32;
            // Bloco de silêncio real: não mexe no ganho (e desce devagar para 1.0).
            if peak < Self::NOISE_FLOOR {
                self.gain += (1.0 - self.gain) * 0.05;
                if self.gain <= 1.001 {
                    self.gain = 1.0;
                }
                return;
            }
            let want = (Self::TARGET / peak).min(Self::MAX_GAIN);
            // Ataque rápido (não corta sílaba inicial), liberação lenta (não "bomba").
            let coef = if want > self.gain { 0.35 } else { 0.03 };
            self.gain += (want - self.gain) * coef;
            if self.gain <= 1.001 {
                self.gain = 1.0;
                return;
            }
            for s in mono.iter_mut() {
                let v = *s as f32 * self.gain / i16::MAX as f32;
                // Limitador suave: linear até 0.7, comprimido acima — sem clip reto.
                let limited = if v.abs() <= 0.7 {
                    v
                } else {
                    let over = v.signum() * (0.7 + (v.abs() - 0.7) / (1.0 + (v.abs() - 0.7) * 4.0));
                    over.min(1.0).max(-1.0)
                };
                *s = (limited * i16::MAX as f32) as i16;
            }
        }
    }

    // ---------------------------------------------------------------- hub

    /// Partes compartilhadas com os callbacks do cpal (threads de device).
    #[derive(Default)]
    struct HubShared {
        subs: Mutex<Vec<(u64, UnboundedSender<MicFrame>)>>,
        inboxes: Mutex<Vec<(u64, Inbox)>>,
        name: Mutex<String>,
        /// Inboxes ensurdecidas: o playout pula E drena (sem acumular backlog).
        deafened: std::sync::Mutex<std::collections::HashSet<u64>>,
        /// REFERÊNCIA do AEC: exatamente o áudio escrito no speaker — sem isso
        /// o filtro adaptativo não tem o que subtrair do mic.
        play_ref: Arc<crate::net::media_dsp::RefRing>,
    }

    struct HubInner {
        shared: Arc<HubShared>,
        mic: Mutex<Option<MicStream>>,
        spk: Mutex<Option<SpkStream>>,
        mic_error: Mutex<Option<String>>,
        /// Último erro de abertura do speaker — sem ele a recepção ficava muda
        /// com métricas saudáveis e sem diagnóstico.
        spk_error: Mutex<Option<String>>,
        has_capture: AtomicBool,
        mic_attempted: AtomicBool,
        next_sub_id: Mutex<u64>,
        next_inbox_id: Mutex<u64>,
    }

    pub struct AudioHub {
        inner: HubInner,
    }

    static HUB: OnceLock<AudioHub> = OnceLock::new();

    pub fn hub() -> &'static AudioHub {
        HUB.get_or_init(|| AudioHub {
            inner: HubInner {
                shared: Arc::new(HubShared::default()),
                mic: Mutex::new(None),
                spk: Mutex::new(None),
                mic_error: Mutex::new(None),
                spk_error: Mutex::new(None),
                has_capture: AtomicBool::new(false),
                mic_attempted: AtomicBool::new(false),
                next_sub_id: Mutex::new(1),
                next_inbox_id: Mutex::new(1),
            },
        })
    }

    impl AudioHub {
        pub fn has_capture(&self) -> bool {
            self.inner.has_capture.load(Ordering::SeqCst)
        }

        pub fn mic_name(&self) -> String {
            self.inner.shared.name.lock().unwrap().clone()
        }

        pub fn mic_error(&self) -> Option<String> {
            self.inner.mic_error.lock().unwrap().clone()
        }

        /// Último erro de abertura do ALTO-FALANTE (`None` = tocando).
        pub fn speaker_error(&self) -> Option<String> {
            self.inner.spk_error.lock().unwrap().clone()
        }

        /// Abre o mic se ainda não abriu; sem mic a sessão funciona só recebendo
        /// (erro guardado, não propagado).
        pub fn ensure_mic(&self) -> Result<(), String> {
            if self.inner.has_capture.load(Ordering::SeqCst) {
                return Ok(());
            }
            // Permite exercitar o caminho "sem microfone" sem desligar o device.
            if std::env::var("VOICE_NO_CAPTURE").as_deref() == Ok("1") {
                let e = "VOICE_NO_CAPTURE=1: microfone desabilitado de proposito".to_string();
                *self.inner.mic_error.lock().unwrap() = Some(e.clone());
                self.inner.mic_attempted.store(true, Ordering::SeqCst);
                return Err(e);
            }
            if self.inner.mic_attempted.swap(true, Ordering::SeqCst) {
                // Abertura em curso/falhada: devolver Ok() aqui fazia o sender
                // nascer com mic fechado (packets_out=0, "Linux não envia").
                // Espera a abertura terminar (abrir device leva ~1 s).
                let deadline = Instant::now() + Duration::from_secs(3);
                loop {
                    if self.inner.has_capture.load(Ordering::SeqCst) {
                        return Ok(());
                    }
                    if let Some(e) = &*self.inner.mic_error.lock().unwrap() {
                        return Err(e.clone());
                    }
                    if Instant::now() >= deadline {
                        tracing::warn!("[voice] microfone ainda nao abriu apos 3s de espera");
                        return Err("microfone demorando demais para abrir".to_string());
                    }
                    std::thread::sleep(Duration::from_millis(25));
                }
            }
            if let Err(e) = self.open_mic() {
                *self.inner.mic_error.lock().unwrap() = Some(e.clone());
                return Err(e);
            }
            Ok(())
        }

        /// Re-tenta abrir o microfone (ver `VoiceMedia::retry_mic`).
        pub fn retry_mic(&self) {
            if self.inner.has_capture.load(Ordering::SeqCst) {
                return;
            }
            self.inner.mic_attempted.store(false, Ordering::SeqCst);
            if self.ensure_mic().is_ok() {
                // Limpa erro velho: painel não mostra falha que já passou.
                *self.inner.mic_error.lock().unwrap() = None;
            }
        }

        /// Assina o fluxo do microfone. Devolve (id para `unsubscribe`, receptor).
        pub fn subscribe(&self) -> Result<(u64, UnboundedReceiver<MicFrame>), String> {
            self.ensure_mic()?;
            let (tx, rx) = unbounded_channel();
            let id = self.next_id(true);
            self.inner.shared.subs.lock().unwrap().push((id, tx));
            Ok((id, rx))
        }

        pub fn unsubscribe(&self, id: u64) {
            self.inner
                .shared
                .subs
                .lock()
                .unwrap()
                .retain(|(i, _)| *i != id);
        }

        /// Quantos peers assinam o microfone agora (deve cair a 0 apos hangup).
        pub fn subscriber_count(&self) -> usize {
            self.inner.shared.subs.lock().unwrap().len()
        }

        /// Registra uma caixa de playout; o callback de saida mistura todas.
        pub fn register_inbox(&self) -> u64 {
            let id = self.next_id(false);
            let inbox: Inbox = Arc::new(Mutex::new(VecDeque::new()));
            self.inner.shared.inboxes.lock().unwrap().push((id, inbox));
            id
        }

        pub fn unregister_inbox(&self, id: u64) {
            self.inner
                .shared
                .inboxes
                .lock()
                .unwrap()
                .retain(|(i, _)| *i != id);
        }

        pub fn inbox(&self, id: u64) -> Option<Inbox> {
            self.inner
                .shared
                .inboxes
                .lock()
                .unwrap()
                .iter()
                .find(|(i, _)| *i == id)
                .map(|(_, b)| b.clone())
        }

        pub fn has_speaker(&self) -> bool {
            self.inner.spk.lock().unwrap().is_some()
        }

        /// Inbox ensurdecida: playout pula e drena (antes o "deafen" só calava o mic).
        pub fn set_inbox_muted(&self, id: u64, muted: bool) {
            let mut set = self.inner.shared.deafened.lock().unwrap();
            if muted {
                set.insert(id);
            } else {
                set.remove(&id);
            }
        }

        /// Anel de referencia do alto-falante, para o AEC.
        pub fn play_ref(&self) -> Arc<crate::net::media_dsp::RefRing> {
            self.inner.shared.play_ref.clone()
        }

        fn next_id(&self, sub: bool) -> u64 {
            let mut n = if sub {
                self.inner.next_sub_id.lock().unwrap()
            } else {
                self.inner.next_inbox_id.lock().unwrap()
            };
            let id = *n;
            *n += 1;
            id
        }

        // ---------------------------------------------------------------- microfone

        fn open_mic(&self) -> Result<(), String> {
            let host = cpal::default_host();
            let devs: Vec<cpal::Device> = host
                .input_devices()
                .map_err(|e| format!("input_devices: {e}"))?
                .collect();

            let mut chosen: Option<(cpal::Device, String)> = host
                .default_input_device()
                .and_then(|d| d.description().ok().map(|x| (d, x.name().to_owned())));
            if chosen.is_none() {
                for d in devs.iter() {
                    if pick_input_config(d).is_ok() {
                        chosen = d
                            .description()
                            .ok()
                            .map(|x| (d.clone(), x.name().to_owned()));
                        break;
                    }
                }
            }
            let (device, name) = chosen.ok_or_else(|| {
            "nenhum microfone utilizavel: `default` ausente e nenhum device de entrada respondeu a supported_input_configs()".to_string()
        })?;

            let cfg = pick_input_config(&device)?;
            let hw_rate = cfg.sample_rate();
            let hw_channels = cfg.channels();
            *self.inner.shared.name.lock().unwrap() = name;
            eprintln!(
                "[voice] microfone: {hw_rate} Hz / {hw_channels}ch, buffer {DEVICE_BUFFER} frames"
            );

            let shared = self.inner.shared.clone();
            let downmix = hw_channels > 1;
            let ch = hw_channels as usize;
            let mut resampler = Resampler::new(hw_rate, SAMPLE_RATE);
            let mut agc = MicGain::new();
            let mut acc: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            // Ancora de tempo: frame datado pela callback que o entregou,
            // avançando +FRAME por frame emitido.
            let mut next_frame_wall: Option<Instant> = None;

            let stream = build_input_with_buffer_fallback(&device, cfg, move |data: &[f32]| {
                let mut mono: Vec<i16> = if downmix {
                    data.chunks_exact(ch)
                        .map(|c| {
                            let avg: f32 = c.iter().sum::<f32>() / ch as f32;
                            (avg.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                        })
                        .collect()
                } else {
                    data.iter()
                        .map(|s| ((*s).clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
                        .collect()
                };
                // Ganho antes do resampler: volume independente do volume do sistema.
                agc.process(&mut mono);
                if next_frame_wall.is_none() {
                    next_frame_wall = Some(Instant::now());
                }
                acc.extend_from_slice(&resampler.process(&mono));
                while acc.len() >= FRAME_SAMPLES {
                    let frame: Vec<i16> = acc.drain(..FRAME_SAMPLES).collect();
                    let at = next_frame_wall.unwrap_or_else(Instant::now);
                    next_frame_wall = Some(at + FRAME);
                    let list = shared.subs.lock().unwrap();
                    if list.is_empty() {
                        continue;
                    }
                    let shared_pcm = Arc::new(frame);
                    for (_, tx) in list.iter() {
                        // Canal ilimitado: `send` não bloqueia a thread realtime.
                        let _ = tx.send(MicFrame {
                            pcm: shared_pcm.clone(),
                            captured_at: at,
                        });
                    }
                }
            })?;

            stream.play().map_err(|e| format!("stream.play(): {e}"))?;
            *self.inner.mic.lock().unwrap() = Some(stream);
            self.inner.has_capture.store(true, Ordering::SeqCst);
            Ok(())
        }

        // ------------------------------------------------------------ alto-falante

        pub fn ensure_speaker(&self) -> Result<(), String> {
            if self.inner.spk.lock().unwrap().is_some() {
                return Ok(());
            }
            let r = self.open_speaker();
            // Guarda o motivo: `let _ = ensure_speaker()` engoliava "nenhum
            // alto-falante" e a recepção ficava muda sem diagnóstico.
            *self.inner.spk_error.lock().unwrap() = r.as_ref().err().cloned();
            r
        }

        fn open_speaker(&self) -> Result<(), String> {
            let host = cpal::default_host();
            let outs: Vec<cpal::Device> = host
                .output_devices()
                .map_err(|e| format!("output_devices: {e}"))?
                .collect();
            let mut chosen: Option<(cpal::Device, String)> = host
                .default_output_device()
                .and_then(|d| d.description().ok().map(|x| (d, x.name().to_owned())));
            if chosen.is_none() {
                for d in outs.iter() {
                    if d.supported_output_configs()
                        .is_ok_and(|mut i| i.next().is_some())
                    {
                        chosen = d
                            .description()
                            .ok()
                            .map(|x| (d.clone(), x.name().to_owned()));
                        break;
                    }
                }
            }
            let (device, name) =
                chosen.ok_or_else(|| "nenhum alto-falante utilizavel".to_string())?;

            let ranges: Vec<_> = device
                .supported_output_configs()
                .map_err(|e| format!("supported_output_configs: {e}"))?
                .collect();
            if ranges.is_empty() {
                return Err("alto-falante sem configs de saida".to_string());
            }
            let sr = SAMPLE_RATE;
            let cfg = ranges
                .iter()
                .find(|r| r.min_sample_rate() <= sr && r.max_sample_rate() >= sr)
                .map(|r| r.clone().with_sample_rate(sr))
                .unwrap_or_else(|| {
                    let r = &ranges[0];
                    r.clone()
                        .with_sample_rate(r.max_sample_rate().min(sr).max(r.min_sample_rate()))
                });
            let hw_rate = cfg.sample_rate();
            let hw_channels = cfg.channels().max(1);
            eprintln!(
            "[voice] alto-falante: {name}, {hw_rate} Hz / {hw_channels}ch, buffer {DEVICE_BUFFER} frames"
        );

            let shared = self.inner.shared.clone();
            let ch = hw_channels as usize;
            let step = f64::from(SAMPLE_RATE) / f64::from(hw_rate);
            let same_rate = (step - 1.0).abs() < 1e-9;
            // buffer 48k persistente: sobra do callback anterior + amostras novas
            let mut buf: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 16);
            let mut phase: f64 = 0.0;
            let mut hw: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 16);

            let ref_ring = self.inner.shared.play_ref.clone();
            let stream =
                build_output_with_buffer_fallback(&device, cfg, move |out: &mut [f32]| {
                    let need = (out.len() / ch).max(1);
                    // Alvo consumido por esta callback derivado da FASE acumulada (fração
                    // anterior conta; alvo constante vazava ~2 amostras/callback). +2 = âncoras.
                    let target = if same_rate {
                        need
                    } else {
                        (phase + (need as f64) * step).floor() as usize + 2
                    };

                    // 1) Completa o buffer até o alvo com as inboxes (mesh).
                    //    Ensurdecidas: pula e drena.
                    {
                        let fill_from = buf.len();
                        if target > fill_from {
                            buf.resize(target, 0.0);
                        }
                        let deaf = shared.deafened.lock().unwrap();
                        let list = shared.inboxes.lock().unwrap();
                        for (id, ib) in list.iter() {
                            let muted = deaf.contains(id);
                            let mut q = ib.lock().unwrap();
                            let mut pos = fill_from;
                            while pos < buf.len() {
                                let Some(frame) = q.pop_front() else { break };
                                if muted {
                                    continue;
                                }
                                if let Some((link, idx)) = frame.id {
                                    probe().stamp_play(link, idx, Instant::now());
                                }
                                let take = (buf.len() - pos).min(frame.pcm.len());
                                for (k, &s) in frame.pcm.iter().take(take).enumerate() {
                                    buf[pos + k] += f32::from(s) / f32::from(i16::MAX);
                                }
                                pos += take;
                                if take < frame.pcm.len() {
                                    let resto: Vec<i16> = frame.pcm[take..].to_vec();
                                    q.push_front(PcmFrame {
                                        pcm: Arc::new(resto),
                                        id: None,
                                    });
                                    break;
                                }
                            }
                        }
                    }

                    // 2) Resample 48k -> hw; `phase` no domínio da entrada.
                    hw.clear();
                    let consumed;
                    if same_rate {
                        hw.extend_from_slice(&buf[..need]);
                        consumed = need;
                    } else {
                        while hw.len() < need {
                            let i = phase as usize;
                            if i + 1 >= buf.len() {
                                break;
                            }
                            let frac = (phase - i as f64) as f32;
                            let a = buf[i];
                            let b = buf[i + 1];
                            hw.push(a + (b - a) * frac);
                            phase += step;
                        }
                        consumed = (phase as usize).min(buf.len().saturating_sub(1));
                        phase -= consumed as f64;
                        if hw.len() < need {
                            hw.resize(need, 0.0);
                        }
                    }

                    // 3) Referência do AEC a 48 kHz (pré-resample) — outra taxa
                    //    não converge (filtro roda na taxa do mic).
                    {
                        let mut ref_buf: Vec<i16> = Vec::with_capacity(consumed);
                        for &v in buf.iter().take(consumed) {
                            ref_buf.push((v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                        }
                        if !ref_buf.is_empty() {
                            ref_ring.push(&ref_buf);
                        }
                    }
                    buf.drain(..consumed);

                    // 4) mono -> canais intercalados
                    for (i, o) in out.iter_mut().enumerate() {
                        *o = hw[i / ch].clamp(-1.0, 1.0);
                    }
                })?;

            stream.play().map_err(|e| format!("output play(): {e}"))?;
            *self.inner.spk.lock().unwrap() = Some(stream);
            Ok(())
        }
    }

    // ---------------------------------------------------------------- device cfg

    fn pick_input_config(dev: &cpal::Device) -> Result<cpal::SupportedStreamConfig, String> {
        let ranges: Vec<_> = dev
            .supported_input_configs()
            .map_err(|e| format!("supported_input_configs: {e}"))?
            .collect();
        if ranges.is_empty() {
            return Err("device sem configs de entrada".to_string());
        }
        let sr = SAMPLE_RATE;
        for r in &ranges {
            if r.channels() == 1 && r.min_sample_rate() <= sr && r.max_sample_rate() >= sr {
                return Ok(r.clone().with_sample_rate(sr));
            }
        }
        for r in &ranges {
            if r.min_sample_rate() <= sr && r.max_sample_rate() >= sr {
                return Ok(r.clone().with_sample_rate(sr));
            }
        }
        let r = &ranges[0];
        let rate = r.max_sample_rate().min(sr).max(r.min_sample_rate());
        Ok(r.clone().with_sample_rate(rate))
    }

    /// StreamConfig com buffer EXPLÍCITO (`BufferSize::Default` nunca entra).
    fn config_with_buffer(cfg: cpal::SupportedStreamConfig, buffer: u32) -> cpal::StreamConfig {
        let mut sc = cfg.config();
        sc.buffer_size = cpal::BufferSize::Fixed(buffer);
        sc
    }

    /// Tenta 960 frames e, se o backend recusar, outros tamanhos EXPLÍCITOS.
    const FALLBACK_BUFFERS: [u32; 4] = [DEVICE_BUFFER, 480, 240, 1920];

    fn build_input_with_buffer_fallback<F>(
        device: &cpal::Device,
        cfg: cpal::SupportedStreamConfig,
        cb: F,
    ) -> Result<MicStream, String>
    where
        F: FnMut(&[f32]) + Send + 'static,
    {
        // Callback sobrevive a tentativa que falhou (fase do resampler etc.).
        let cb = Arc::new(Mutex::new(cb));
        let mut last = String::new();
        for buffer in FALLBACK_BUFFERS {
            let sc = config_with_buffer(cfg, buffer);
            let c = cb.clone();
            match device.build_input_stream::<f32, _, _>(
                sc,
                move |data: &[f32], _info| (c.lock().unwrap())(data),
                |_e| {},
                None,
            ) {
                Ok(s) => {
                    if buffer != DEVICE_BUFFER {
                        eprintln!(
                        "[voice] AVISO: microfone recusou {DEVICE_BUFFER} frames; usando {buffer}"
                    );
                    }
                    return Ok(Box::new(s));
                }
                Err(e) => last = format!("build_input_stream({buffer}): {e}"),
            }
        }
        Err(last)
    }

    fn build_output_with_buffer_fallback<F>(
        device: &cpal::Device,
        cfg: cpal::SupportedStreamConfig,
        cb: F,
    ) -> Result<SpkStream, String>
    where
        F: FnMut(&mut [f32]) + Send + 'static,
    {
        let cb = Arc::new(Mutex::new(cb));
        let mut last = String::new();
        for buffer in FALLBACK_BUFFERS {
            let sc = config_with_buffer(cfg, buffer);
            let c = cb.clone();
            match device.build_output_stream::<f32, _, _>(
                sc,
                move |out: &mut [f32], _info| (c.lock().unwrap())(out),
                |_e| {},
                None,
            ) {
                Ok(s) => {
                    if buffer != DEVICE_BUFFER {
                        eprintln!(
                        "[voice] AVISO: alto-falante recusou {DEVICE_BUFFER} frames; usando {buffer}"
                    );
                    }
                    return Ok(Box::new(s));
                }
                Err(e) => last = format!("build_output_stream({buffer}): {e}"),
            }
        }
        Err(last)
    }
}

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use self::audio::{MicFrame, PcmFrame, FRAME, FRAME_SAMPLES, SAMPLE_RATE};
use self::probe::{probe, LatencyProbe};
use bytes::Bytes;

thread_local! {
    static DBG: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static DBGSTATS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}
static DBG_BASE: Mutex<Option<Instant>> = Mutex::new(None);

fn dbg_on() -> bool {
    std::env::var("VOICE_DEBUG_LAT").is_ok_and(|v| v == "1")
}

/// Caminho "sem microfone" testável via env (lista de `peer_fp` separados por vírgula).
fn sem_mic(peer_fp: &str) -> bool {
    if std::env::var("VOICE_NO_CAPTURE").as_deref() == Ok("1") {
        return true;
    }
    match std::env::var("VOICE_NO_CAPTURE_PEERS") {
        Ok(v) => v.split(',').any(|p| p.trim() == peer_fp),
        Err(_) => false,
    }
}

fn dbg_stats_on() -> bool {
    std::env::var("VOICE_DEBUG_STATS").is_ok_and(|v| v == "1")
}
use rtc::ice::mdns::MulticastDnsMode;
use rtc::interceptor::{JitterBufferBuilder, Slot};
use rtc::media::Sample;
use rtc::media_stream::MediaStreamTrack;
use rtc::peer_connection::configuration::interceptor_registry::register_default_interceptors;
use rtc::peer_connection::configuration::media_engine::MediaEngine;
use rtc::peer_connection::configuration::setting_engine::SettingEngineBuilder;
use rtc::peer_connection::configuration::RTCConfigurationBuilder;
use rtc::peer_connection::configuration::RTCIceTransportPolicy;
use rtc::peer_connection::sdp::RTCSessionDescription;
use rtc::peer_connection::transport::{RTCIceCandidateInit, RTCIceCandidateType, RTCIceServer};
use rtc::rtp_transceiver::rtp_sender::{
    RTCRtpCodec, RTCRtpCodingParameters, RTCRtpEncodingParameters, RtpCodecKind,
};
use rtc::statistics::report::RTCStatsReportEntry;
use rtc::statistics::StatsSelector;
use tokio::sync::mpsc::UnboundedReceiver;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::media_stream::Track;
use webrtc::peer_connection::{
    PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler, RTCIceGatheringState,
    RTCPeerConnectionIceEvent, RTCPeerConnectionState,
};
use webrtc::rtp_transceiver::RtpSender;

// ---------------------------------------------------------------- parametros

/// Profundidade-alvo do jitter buffer: 50 ms = 2-3 pacotes de 20 ms.
const JITTER_DEPTH: Duration = Duration::from_millis(50);
/// Pacotes retidos por stream (independente da profundidade).
const JITTER_CAPACITY: usize = 64;
/// Bitrate Opus 48 kbps: 32 kbps chegava abafado em fone; fullband mono em P2P.
const BITRATE_BPS: i32 = 48_000;
const STUN_DEFAULT: &str = "stun:stun.l.google.com:19302";
/// TURN público padrão (mesmo do navegador); sem relay, CGNAT simétrico não fecha.
const TURN_DEFAULT_HOST: &str = "openrelay.metered.ca";
const TURN_DEFAULT_PORT: u16 = 80;
const TURN_DEFAULT_USER: &str = "openrelayproject";
const TURN_DEFAULT_SECRET: &str = "openrelayprojectsecret";
const SDP_WAIT: Duration = Duration::from_millis(1500);
/// fmtp Opus: 20 ms e FEC in-band (RFC 7587 5.1).
const OPUS_FMTP: &str = "minptime=10;useinbandfec=1";
/// Teto de frames PLC seguidos (mantido para testes de contrato).
#[allow(dead_code)]
const MAX_PLC_BURST: u32 = 50;

/// Buraco de `seq` acima disso = mute/troca de SSRC, não perda: re-sincroniza
/// sem sintetizar áudio (10 frames = 200 ms).
const PLC_RESYNC_GAP: u32 = 10;

// ---------------------------------------------------------------- API publica

/// Sinal de sinalizacao que a aplicacao deve encaminhar ao outro lado.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutboundSignal {
    Offer { sdp: String },
    Answer { sdp: String },
    Ice { candidate: String, mid: String },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct VoiceStats {
    pub state: String, // "idle"|"connecting"|"connected"|"failed"
    pub route: String, // "LAN"|"STUN"|"TURN"|"n/d"
    pub jitter_depth_ms: u32,
    pub packets_in: u64,
    pub packets_out: u64,
    /// Escritas na track que falharam; `packets_out` alto + `write_errors` alto
    /// = problema desta máquina.
    #[serde(default)]
    pub write_errors: u64,
    pub plc_frames: u64, // frames mascarados por perda
    pub decode_errors: u64,
    pub rtt_ms: Option<u64>,
    /// Último erro de abertura do mic; `Some` + `packets_out == 0` = este lado
    /// não envia (painel mostra o motivo em vez de "conectando" mudo).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_error: Option<String>,
    /// Último erro de abertura do speaker; `Some` + `packets_in` crescendo =
    /// áudio chega e não sai desta máquina.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_error: Option<String>,
    /// "off"|"starting"|"live"|"failed". "live" com `frames_out == 0` não é
    /// saúde: watchdog de 15 s converte em "failed" com motivo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_packets_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames_out: Option<u64>,
    /// Pares em `connected` AGORA: o `state` agregado é o PIOR caso — num mesh
    /// de 3, um par failed derrubava a chamada inteira sem estes campos.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peers_connected: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peers_total: Option<u32>,
}

/// Gerenciador de mídia de voz; estado por (call_id, peer_fp) — mesh de áudio.
pub struct VoiceMedia {
    inner: Arc<Inner>,
}

type Inbox = Arc<Mutex<VecDeque<PcmFrame>>>;
type Key = (String, String);

// ---------------------------------------------------------------- estado

struct Shared {
    packets_in: AtomicU64,
    packets_out: AtomicU64,
    /// Escritas na track que FALHARAM; sem o contador `packets_out` mentia.
    write_errors: AtomicU64,
    plc_frames: AtomicU64,
    decode_errors: AtomicU64,
    jitter_depth_ms: AtomicU32,

    connected_flag: AtomicBool,
    mid: Mutex<String>,
    state: Mutex<String>,
    route: Mutex<String>,
    rtt_ms: Mutex<Option<u64>>,

    /// Fila de trickle ICE drenada por `drain_outbound`.
    out: Mutex<VecDeque<OutboundSignal>>,
    connected: Arc<tokio::sync::Notify>,
    /// PC da sessão, para ICE restart automático no handler de estado.
    pc: Mutex<Option<std::sync::Arc<dyn PeerConnection>>>,
    /// ICE restarts já tentados nesta sessão (teto anti-loop).
    ice_restarts: AtomicU32,

    /// Caixa de playout deste peer (decode escreve, callback do cpal lê).
    inbox: Inbox,
    /// Id da direção instrumentada (ver `VoiceMedia::attach_probe`).
    in_link: Mutex<Option<u32>>,
    /// 1º timestamp RTP da direção: `idx = (ts - ts_0)/960` identifica o frame
    /// sem tocar no payload (Opus puro, navegador entende).
    base_ts: Mutex<Option<u32>>,
    /// SDP remoto: só para `sprop-parameter-sets` do H264 (senão ficava preto).
    remote_sdp: Mutex<Option<String>>,
    // ---- video nativo ----
    /// Pedido de video pendente/ativo: ("camera"|"screen", monitor).
    video_want: Mutex<Option<(String, Option<u32>)>>,
    /// "off" | "starting" | "live" | "failed".
    video_state: Mutex<String>,
    video_codec: Mutex<Option<String>>,
    video_error: Mutex<Option<String>>,
    video_source: Mutex<Option<String>>,
    video_packets_in: AtomicU64,
    frames_in: AtomicU64,
    frames_out: AtomicU64,
    video_seq: AtomicU64,
    /// Ultimo frame remoto decodificado (a UI faz polling).
    video_frame: Mutex<Option<VideoFrame>>,
    /// Tasks de RECEBIMENTO: sem abortá-las no close, o decode GStreamer
    /// sobrevivia ao hangup e cada renegociação abria outro decoder.
    recv_tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    /// Track local de video (criada na renegociacao; a task de envio escreve nela).
    video_track: Mutex<Option<Arc<TrackLocalStaticSample>>>,
}

impl Shared {
    fn new(inbox: Inbox) -> Self {
        Self {
            packets_in: AtomicU64::new(0),
            packets_out: AtomicU64::new(0),
            write_errors: AtomicU64::new(0),
            plc_frames: AtomicU64::new(0),
            decode_errors: AtomicU64::new(0),
            jitter_depth_ms: AtomicU32::new(JITTER_DEPTH.as_millis() as u32),
            connected_flag: AtomicBool::new(false),
            mid: Mutex::new(String::new()),
            state: Mutex::new("idle".to_string()),
            route: Mutex::new("n/d".to_string()),
            rtt_ms: Mutex::new(None),
            out: Mutex::new(VecDeque::new()),
            connected: Arc::new(tokio::sync::Notify::new()),
            pc: Mutex::new(None),
            ice_restarts: AtomicU32::new(0),
            inbox,
            in_link: Mutex::new(None),
            base_ts: Mutex::new(None),
            remote_sdp: Mutex::new(None),
            video_want: Mutex::new(None),
            video_state: Mutex::new("off".to_string()),
            video_codec: Mutex::new(None),
            video_error: Mutex::new(None),
            video_source: Mutex::new(None),
            video_packets_in: AtomicU64::new(0),
            frames_in: AtomicU64::new(0),
            frames_out: AtomicU64::new(0),
            video_seq: AtomicU64::new(0),
            video_frame: Mutex::new(None),
            recv_tasks: Mutex::new(Vec::new()),
            video_track: Mutex::new(None),
        }
    }

    fn set_state(&self, s: &str) {
        *self.state.lock().unwrap() = s.to_string();
    }

    fn stats(&self) -> VoiceStats {
        VoiceStats {
            state: self.state.lock().unwrap().clone(),
            route: self.route.lock().unwrap().clone(),
            jitter_depth_ms: self.jitter_depth_ms.load(Ordering::Relaxed),
            packets_in: self.packets_in.load(Ordering::Relaxed),
            packets_out: self.packets_out.load(Ordering::Relaxed),
            write_errors: self.write_errors.load(Ordering::Relaxed),
            plc_frames: self.plc_frames.load(Ordering::Relaxed),
            decode_errors: self.decode_errors.load(Ordering::Relaxed),
            rtt_ms: *self.rtt_ms.lock().unwrap(),
            mic_error: self::audio::hub().mic_error(),
            speaker_error: self::audio::hub().speaker_error(),
            video_state: Some(self.video_state.lock().unwrap().clone()),
            video_codec: self.video_codec.lock().unwrap().clone(),
            video_source: self.video_source.lock().unwrap().clone(),
            video_error: self.video_error.lock().unwrap().clone(),
            video_packets_in: Some(self.video_packets_in.load(Ordering::Relaxed)),
            frames_in: Some(self.frames_in.load(Ordering::Relaxed)),
            frames_out: Some(self.frames_out.load(Ordering::Relaxed)),
            // Contagem por estado: `stats()` é de UMA sessão (1/1 se conectada).
            peers_connected: Some(if self.state.lock().unwrap().as_str() == "connected" {
                1
            } else {
                0
            }),
            peers_total: Some(1),
        }
    }
}

struct TxState {
    track: Arc<TrackLocalStaticSample>,
    sender: Arc<dyn RtpSender>,
}

struct Session {
    call_id: String,
    peer_fp: String,
    sh: Arc<Shared>,
    pc: Arc<dyn PeerConnection>,
    inbox_id: u64,
    mic_id: u64, // 0 = sem assinatura do mic
    mic_sub: Mutex<Option<UnboundedReceiver<MicFrame>>>,
    out_link: Mutex<Option<u32>>,
    muted: AtomicBool,
    closed: AtomicBool,
    tx: TxState,
    /// Trilha de vídeo (sendrecv) desde o build: m=video já na oferta inicial,
    /// ligar a captura só escreve samples (nada de renegociação).
    vtx: TxState,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    probe: &'static LatencyProbe,
}

struct Inner {
    core: Arc<Core>,
    sessions: Mutex<HashMap<Key, Arc<Session>>>,
    probe_out: Mutex<Option<u32>>,
    probe_in: Mutex<Option<u32>>,
    /// Receptores do teste de microfone (mic_test_*), por id de subscribe.
    mic_tests: Mutex<HashMap<u64, UnboundedReceiver<MicFrame>>>,
}

impl Session {
    fn key(&self) -> Key {
        (self.call_id.clone(), self.peer_fp.clone())
    }
}

// ---------------------------------------------------------------- handler

struct H {
    sh: Arc<Shared>,
}

impl H {
    /// ICE restart nativo: nova offer com `ice_restart` na fila `out` (teto de 3);
    /// troca de rede deixa de matar a chamada.
    fn schedule_ice_restart(&self) {
        let sh = self.sh.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await; // flap curto se resolve sozinho
                                                              // `reconnecting` também conta (é o estado de `Disconnected`); flap
                                                              // que se resolveu sozinho já voltou a "connected" e sai aqui.
            {
                let atual = sh.state.lock().unwrap().clone();
                if atual != "failed" && atual != "reconnecting" {
                    return;
                }
            }
            if sh.remote_sdp.lock().unwrap().is_none() {
                return; // nunca negociou: não há o que reiniciar
            }
            if sh.ice_restarts.fetch_add(1, Ordering::SeqCst) >= 3 {
                return;
            }
            let pc = sh.pc.lock().unwrap().clone();
            let Some(pc) = pc else { return };
            let opts = rtc::peer_connection::configuration::RTCOfferOptions { ice_restart: true };
            match pc.create_offer(Some(opts)).await {
                Ok(offer) => {
                    if let Err(e) = pc.set_local_description(offer).await {
                        eprintln!("[voice] ICE restart: set_local falhou: {e}");
                        return;
                    }
                    let sdp = match wait_local_sdp(&pc).await {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("[voice] ICE restart: {e}");
                            return;
                        }
                    };
                    sh.out
                        .lock()
                        .unwrap()
                        .push_back(OutboundSignal::Offer { sdp });
                    sh.set_state("connecting");
                    eprintln!("[voice] ICE restart: nova offer na fila (rede trocou?)");
                }
                Err(e) => eprintln!("[voice] ICE restart: create_offer falhou: {e}"),
            }
        });
    }
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for H {
    async fn on_connection_state_change(&self, s: RTCPeerConnectionState) {
        match s {
            RTCPeerConnectionState::Connected => {
                self.sh.connected_flag.store(true, Ordering::SeqCst);
                self.sh.set_state("connected");
                self.sh.ice_restarts.store(0, Ordering::SeqCst);
                self.sh.connected.notify_waiters();
            }
            RTCPeerConnectionState::Connecting => self.sh.set_state("connecting"),
            RTCPeerConnectionState::Disconnected => {
                // ROTA CAIU: antes caía no `_ => {}` e a sessão seguia
                // "connected" com `packets_out` subindo sobre rota morta
                // ("aparece conectado mas não se ouve"). Tratado como
                // recuperável e agenda ICE restart (teto de 3 evita rajada).
                self.sh.connected_flag.store(false, Ordering::SeqCst);
                self.sh.set_state("reconnecting");
                self.sh.connected.notify_waiters();
                self.schedule_ice_restart();
            }
            RTCPeerConnectionState::Failed => {
                self.sh.connected_flag.store(false, Ordering::SeqCst);
                self.sh.set_state("failed");
                self.sh.connected.notify_waiters();
                self.schedule_ice_restart();
            }
            RTCPeerConnectionState::Closed => {
                // Fechamos de propósito (hangup): NÃO agendar restart — a task
                // detached criava offer em PC já fechada e sobrescrevia "idle"→"failed".
                self.sh.connected_flag.store(false, Ordering::SeqCst);
            }
            RTCPeerConnectionState::New => self.sh.set_state("idle"),
            // `#[non_exhaustive]`: sem este braço o crate não compila no Linux.
            _ => {}
        }
    }

    /// Trickle ICE: cada candidato vira um sinal na fila de `drain_outbound`.
    async fn on_ice_candidate(&self, ev: RTCPeerConnectionIceEvent) {
        match ev.candidate.to_json() {
            Ok(init) => {
                let mid = init.sdp_mid.clone().unwrap_or_default();
                if !mid.is_empty() {
                    *self.sh.mid.lock().unwrap() = mid.clone();
                }
                self.sh.out.lock().unwrap().push_back(OutboundSignal::Ice {
                    candidate: init.candidate,
                    mid,
                });
            }
            Err(e) => eprintln!("[voice] ICE candidate para JSON falhou: {e}"),
        }
    }

    async fn on_ice_gathering_state_change(&self, s: RTCIceGatheringState) {
        if s == RTCIceGatheringState::Complete {
            // Fim de candidatos, como o navegador sinaliza.
            let mid = self.sh.mid.lock().unwrap().clone();
            self.sh.out.lock().unwrap().push_back(OutboundSignal::Ice {
                candidate: String::new(),
                mid,
            });
        }
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let kind = track.kind().await;
        tracing::debug!("[voice] on_track kind={kind:?}");
        if kind == RtpCodecKind::Video {
            let h = spawn_video_recv(track, self.sh.clone());
            self.sh.recv_tasks.lock().unwrap().push(h);
        } else {
            let h = spawn_recv(track, self.sh.clone(), *self.sh.in_link.lock().unwrap());
            self.sh.recv_tasks.lock().unwrap().push(h);
        }
    }
}

// ---------------------------------------------------------------- nucleo

/// Thread dedicada com runtime tokio: API síncrona sem conflitar com runtime
/// externo; `create_offer` usável de qualquer lugar.
struct Core {
    tx: mpsc::Sender<Box<dyn FnOnce() + Send>>,
    handle: tokio::runtime::Handle,
}

impl Core {
    fn new() -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<Box<dyn FnOnce() + Send>>();
        let (htx, hrx) = mpsc::channel::<tokio::runtime::Handle>();
        std::thread::Builder::new()
            .name("voice-core".to_string())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("[voice] FALHA: nao foi possivel criar o runtime tokio: {e}");
                        return;
                    }
                };
                // Handle permite `block_on` de FORA de qualquer runtime.
                if htx.send(rt.handle().clone()).is_err() {
                    return;
                }
                while let Ok(job) = rx.recv() {
                    job();
                }
                drop(rt);
            })
            .expect("voice-core thread");
        let handle = match hrx.recv() {
            Ok(h) => h,
            Err(_) => {
                eprintln!("[voice] FALHA: voice-core nao subiu");
                std::process::exit(1);
            }
        };
        Arc::new(Core { tx, handle })
    }

    /// Envia um futuro para a thread do core e bloqueia ate o resultado.
    fn run<T: Send + 'static>(
        &self,
        fut: impl std::future::Future<Output = T> + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = mpsc::channel::<Result<T, Box<dyn std::any::Any + Send>>>();
        let wrapped = std::panic::AssertUnwindSafe(fut);
        let h = self.handle.clone();
        let job: Box<dyn FnOnce() + Send> = Box::new(move || {
            let out =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || h.block_on(wrapped)));
            let _ = tx.send(out);
        });
        self.tx
            .send(job)
            .map_err(|_| "voice-core encerrado".to_string())?;
        match rx.recv() {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(p)) => Err(panic_msg(&p)),
            Err(_) => Err("voice-core encerrado".to_string()),
        }
    }
}

fn panic_msg(p: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "panico no voice-core".to_string()
    }
}

// ---------------------------------------------------------------- impl

impl VoiceMedia {
    /// Cria o gerenciador. NÃO abre devices aqui (abertura é lazy — abrir
    /// device de áudio pode levar segundos/travar o engine no nascimento).
    pub fn new() -> Result<Arc<Self>, String> {
        let core = Core::new();
        Ok(Arc::new(VoiceMedia {
            inner: Arc::new(Inner {
                core,
                sessions: Mutex::new(HashMap::new()),
                probe_out: Mutex::new(None),
                probe_in: Mutex::new(None),
                mic_tests: Mutex::new(HashMap::new()),
            }),
        }))
    }

    /// Teste de microfone SEM chamada (config no Linux, sem getUserMedia):
    /// abre o mic e devolve id; UI lê `mic_test_level(id)` e fecha com stop.
    pub fn mic_test_start(&self) -> Result<u64, String> {
        let hub = self::audio::hub();
        hub.ensure_mic()?;
        let (id, rx) = hub.subscribe()?;
        self.inner
            .mic_tests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, rx);
        Ok(id)
    }

    /// Pico 0..1 desde a última leitura; drena a fila (canal ilimitado cresce).
    pub fn mic_test_level(&self, id: u64) -> f32 {
        let mut peak = 0f32;
        if let Some(rx) = self
            .inner
            .mic_tests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get_mut(&id)
        {
            while let Ok(frame) = rx.try_recv() {
                for s in frame.pcm.iter() {
                    let v = (*s as f32 / 32768.0).abs();
                    if v > peak {
                        peak = v;
                    }
                }
            }
        }
        peak.clamp(0.0, 1.0)
    }

    /// Fecha o teste e libera o mic (idempotente).
    pub fn mic_test_stop(&self, id: u64) {
        let dropped = self
            .inner
            .mic_tests
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id)
            .is_some();
        if dropped {
            self::audio::hub().unsubscribe(id);
        }
    }

    /// Nome do device de entrada atual (best-effort: tenta abrir antes).
    pub fn mic_name(&self) -> String {
        let hub = self::audio::hub();
        let _ = hub.ensure_mic();
        hub.mic_name()
    }

    pub fn has_capture(&self) -> bool {
        self::audio::hub().has_capture()
    }

    /// Cria offer para (call_id, peer_fp) e devolve o SDP.
    pub fn create_offer(&self, call_id: &str, peer_fp: &str) -> Result<String, String> {
        let (i, c, p) = (self.inner.clone(), call_id.to_owned(), peer_fp.to_owned());
        let key: Key = (c.clone(), p.clone());
        let fresh = Arc::new(AtomicBool::new(false));
        let fresh_flag = fresh.clone();
        let out: Result<String, String> = self.inner.core.run(async move {
            // Sessão viva? REUSA (renegociação/ICE restart na mesma PC; criar
            // outra vazava mic, tasks e PC antiga).
            let sess = match i.get(&(c.clone(), p.clone())) {
                Some(s) if !s.closed.load(Ordering::SeqCst) => s.clone(),
                _ => match build_session(&i, &c, &p).await {
                    Ok(s) => {
                        fresh_flag.store(true, Ordering::SeqCst);
                        i.insert((c.clone(), p.clone()), s.clone());
                        s
                    }
                    Err(e) => return Err(e),
                },
            };
            match sess.pc.create_offer(None).await {
                Ok(offer) => match sess.pc.set_local_description(offer).await {
                    Ok(()) => wait_local_sdp(&sess.pc).await,
                    Err(e) => Err(err(e)),
                },
                Err(e) => Err(err(e)),
            }
        })?;
        match out {
            Ok(sdp) => Ok(sdp),
            Err(e) => {
                // Só desfaz o que FOI construído agora (fechar sessão viva por
                // renegociação falha matava a chamada em curso).
                if fresh.load(Ordering::SeqCst) {
                    self.close_key(key);
                }
                Err(e)
            }
        }
    }

    /// Atende um offer e devolve o answer.
    pub fn handle_offer(&self, call_id: &str, peer_fp: &str, sdp: &str) -> Result<String, String> {
        let (i, c, p, s) = (
            self.inner.clone(),
            call_id.to_owned(),
            peer_fp.to_owned(),
            sdp.to_owned(),
        );
        let key: Key = (c.clone(), p.clone());
        let fresh = Arc::new(AtomicBool::new(false));
        let fresh_flag = fresh.clone();
        let out: Result<String, String> = self.inner.core.run(async move {
            // Idem `create_offer`: reusa a sessão (offer de ICE restart do par
            // cai na MESMA PC, senão estado ICE/DTLS se perdia).
            let sess = match i.get(&(c.clone(), p.clone())) {
                Some(s) if !s.closed.load(Ordering::SeqCst) => s.clone(),
                _ => match build_session(&i, &c, &p).await {
                    Ok(s) => {
                        fresh_flag.store(true, Ordering::SeqCst);
                        i.insert((c.clone(), p.clone()), s.clone());
                        s
                    }
                    Err(e) => return Err(e),
                },
            };
            let desc = match RTCSessionDescription::offer(s.clone()) {
                Ok(d) => d,
                Err(e) => return Err(err(e)),
            };
            if let Err(e) = sess.pc.set_remote_description(desc).await {
                return Err(err(e));
            }
            *sess.sh.remote_sdp.lock().unwrap() = Some(s);
            match sess.pc.create_answer(None).await {
                Ok(answer) => match sess.pc.set_local_description(answer).await {
                    Ok(()) => wait_local_sdp(&sess.pc).await,
                    Err(e) => Err(err(e)),
                },
                Err(e) => Err(err(e)),
            }
        })?;
        match out {
            Ok(sdp) => Ok(sdp),
            Err(e) => {
                // Idem create_offer: só desfaz sessão construída AGORA.
                if fresh.load(Ordering::SeqCst) {
                    self.close_key(key);
                }
                Err(e)
            }
        }
    }

    pub fn handle_answer(&self, call_id: &str, peer_fp: &str, sdp: &str) -> Result<(), String> {
        let (i, c, p, s) = (
            self.inner.clone(),
            call_id.to_owned(),
            peer_fp.to_owned(),
            sdp.to_owned(),
        );
        self.inner.core.run(async move {
            let sess = i
                .get(&(c.clone(), p.clone()))
                .ok_or_else(|| "sessao inexistente".to_string())?;
            let desc = RTCSessionDescription::answer(s).map_err(err)?;
            sess.pc.set_remote_description(desc).await.map_err(err)?;
            Ok(())
        })?
    }

    /// trickle ICE. `cand` vazio = fim de candidatos.
    pub fn add_ice_candidate(
        &self,
        call_id: &str,
        peer_fp: &str,
        cand: &str,
        mid: &str,
    ) -> Result<(), String> {
        let (i, c, p, cand, mid) = (
            self.inner.clone(),
            call_id.to_owned(),
            peer_fp.to_owned(),
            cand.to_owned(),
            mid.to_owned(),
        );
        self.inner.core.run(async move {
            let sess = i
                .get(&(c.clone(), p.clone()))
                .ok_or_else(|| "sessao inexistente".to_string())?;
            let init = RTCIceCandidateInit {
                candidate: cand,
                sdp_mid: if mid.is_empty() { None } else { Some(mid) },
                sdp_mline_index: Some(0),
                username_fragment: None,
                url: None,
            };
            sess.pc.add_ice_candidate(init).await.map_err(err)
        })?
    }

    /// Esvazia a fila de trickle ICE (SDPs não passam aqui: já saem por valor).
    pub fn drain_outbound(&self, call_id: &str, peer_fp: &str) -> Vec<OutboundSignal> {
        match self.inner.get(&(call_id.to_owned(), peer_fp.to_owned())) {
            Some(s) => s.sh.out.lock().unwrap().drain(..).collect(),
            None => Vec::new(),
        }
    }

    pub fn set_muted(&self, call_id: &str, muted: bool) {
        for s in self.inner.of_call(call_id) {
            s.muted.store(muted, Ordering::SeqCst);
        }
    }

    /// Ensurdecer: cala o playout das sessões (mute normal cuida do mic).
    pub fn set_deafened(&self, call_id: &str, deafened: bool) {
        for s in self.inner.of_call(call_id) {
            self::audio::hub().set_inbox_muted(s.inbox_id, deafened);
        }
    }

    /// Fecha as PeerConnections, aborta as tasks de audio e limpa o estado.
    pub fn hangup(&self, call_id: &str) {
        let keys: Vec<Key> = self
            .inner
            .of_call(call_id)
            .into_iter()
            .map(|s| s.key())
            .collect();
        for k in keys {
            self.close_key(k);
        }
    }

    /// Fecha a sessão com UM par da chamada (o `CallEnd` dele) — as demais
    /// sessões do mesh continuam de pé.
    pub fn hangup_peer(&self, call_id: &str, peer_fp: &str) {
        self.close_key((call_id.to_owned(), peer_fp.to_owned()));
    }

    /// Fecha UMA sessão e a tira do mapa (hangup ou falha de negociação) —
    /// sem isto a sessão falha deixava mic assinado para sempre (vazamento).
    fn close_key(&self, k: Key) {
        if let Some(sess) = self.inner.remove(&k) {
            sess.closed.store(true, Ordering::SeqCst);
            for h in sess.tasks.lock().unwrap().drain(..) {
                h.abort();
            }
            // Tasks de receive/decode de vídeo também morrem aqui (vazava GStreamer).
            for h in sess.sh.recv_tasks.lock().unwrap().drain(..) {
                h.abort();
            }
            *sess.sh.video_state.lock().unwrap() = "off".to_string();
            *sess.sh.video_frame.lock().unwrap() = None;
            sess.mic_sub.lock().unwrap().take();
            if sess.mic_id != 0 {
                self::audio::hub().unsubscribe(sess.mic_id);
            }
            self::audio::hub().unregister_inbox(sess.inbox_id);
            sess.sh.set_state("idle");
            // `pc.close()` é async; sessão fora do mapa e tasks abortadas,
            // então falha aqui só resta ao driver no último Arc.
            let _ = self.inner.core.run(async move {
                sess.pc.close().await.ok();
            });
        }
    }

    /// Estado do primeiro peer da call (só existe um; `stats_agg` soma todos).
    pub fn stats(&self, call_id: &str) -> Option<VoiceStats> {
        self.inner
            .of_call(call_id)
            .into_iter()
            .next()
            .map(|s| s.sh.stats())
    }

    /// Estado agregado: contadores somados; vídeo do peer com mídia fluindo
    /// tem precedência (não depende da ordem do HashMap).
    pub fn stats_agg(&self, call_id: &str) -> Option<VoiceStats> {
        aggregate_stats(
            self.inner
                .of_call(call_id)
                .into_iter()
                .map(|session| session.sh.stats()),
        )
    }

    pub fn stats_peer(&self, call_id: &str, peer_fp: &str) -> Option<VoiceStats> {
        self.inner
            .get(&(call_id.to_owned(), peer_fp.to_owned()))
            .map(|s| s.sh.stats())
    }

    /// Liga a sonda: `out` = direção enviada, `in` = recebida; `None` = sem medição.
    pub fn attach_probe(&self, out: Option<u32>, inbound: Option<u32>) {
        *self.inner.probe_out.lock().unwrap() = out;
        *self.inner.probe_in.lock().unwrap() = inbound;
        for s in self.inner.all() {
            *s.out_link.lock().unwrap() = out;
            *s.sh.in_link.lock().unwrap() = inbound;
        }
    }

    /// Profundidade do jitter buffer em uso, em ms.
    pub fn jitter_depth_ms() -> u32 {
        JITTER_DEPTH.as_millis() as u32
    }

    /// Re-tenta abrir o mic (falha no boot marcava `mic_attempted` para sempre
    /// e todas as chamadas nasciam só-recebendo). Passa pela fila do core:
    /// chamar direto abriria device na main thread e travava a UI.
    pub fn retry_mic(&self) {
        let _ = self
            .inner
            .core
            .run(async { self::audio::hub().retry_mic() });
    }

    // ---------------- video nativo ----------------
    //
    // O encoder e o decoder vivem em `media_video` (GStreamer). Aqui so' mora
    // o ESTADO por sessao e o laco que liga o encoder a PeerConnection.

    /// Liga o envio de vídeo ("camera"|"screen", `monitor_id` só p/ tela).
    /// Idempotente (2 encoders no mesmo stream congelavam o vídeo); troca de
    /// fonte com vídeo no ar reinicia a task (senão o botão ficava morto).
    pub fn video_start(
        &self,
        call_id: &str,
        peer_fp: &str,
        source: &str,
        monitor_id: Option<u32>,
    ) -> Result<String, String> {
        let source = if source == "screen" {
            "screen"
        } else {
            "camera"
        };
        let sess = self
            .inner
            .get(&(call_id.to_owned(), peer_fp.to_owned()))
            .ok_or_else(|| "sessao inexistente".to_string())?;
        {
            // Check-then-act ATÔMICO (mesmo Mutex de `video_state`); "starting"
            // gravado antes de qualquer `await`.
            let mut st = sess.sh.video_state.lock().unwrap();
            if st.as_str() == "live" || st.as_str() == "starting" {
                // TROCA DE FONTE: recomeçar é a única forma — devolver o codec
                // sem fazer nada deixava o botão morto sem erro.
                let atual = sess.sh.video_want.lock().unwrap().clone();
                let mesma_fonte = atual.as_ref().map(|(f, _)| f == source).unwrap_or(false);
                if mesma_fonte {
                    let codec = sess
                        .sh
                        .video_codec
                        .lock()
                        .unwrap()
                        .clone()
                        .unwrap_or_else(|| "video/VP8".to_string());
                    return Ok(codec);
                }
                // Solta o lock: `video_purge_source` também usa `video_state`.
                drop(st);
                self.video_purge_source(&sess);
                let mut st = sess.sh.video_state.lock().unwrap();
                *sess.sh.video_want.lock().unwrap() = Some((source.to_string(), monitor_id));
                *st = "starting".to_string();
                *sess.sh.video_error.lock().unwrap() = None;
                drop(st);
                let for_task = sess.clone();
                let for_abort = sess.clone();
                let want = source.to_string();
                self.inner.core.run(async move {
                    let h = tokio::spawn(async move { video_send_task(for_task, want).await });
                    for_abort.tasks.lock().unwrap().push(h.abort_handle());
                    Ok::<(), String>(())
                })??;
                return Ok("starting".to_string());
            }
            *sess.sh.video_want.lock().unwrap() = Some((source.to_string(), monitor_id));
            *st = "starting".to_string();
            *sess.sh.video_error.lock().unwrap() = None;
        }
        // `Session` é Arc: clona para a task e para o handle de aborto (sem o
        // registro em `sess.tasks`, a task sobrevivia ao hangup).
        let for_task = sess.clone();
        let for_abort = sess.clone();
        let want = source.to_string();
        self.inner.core.run(async move {
            let h = tokio::spawn(async move { video_send_task(for_task, want).await });
            for_abort.tasks.lock().unwrap().push(h.abort_handle());
            Ok::<(), String>(())
        })??;
        Ok("starting".to_string())
    }

    /// Purga a task/encoder da fonte atual para troca de fonte reabrir o device
    /// (sem isto a task antiga rodava e a nova nunca assumia).
    fn video_purge_source(&self, sess: &Session) {
        // Estado "off" quebra o laço de `video_send_task`; tasks abortadas no
        // close. Folga de 120 ms antes de reabrir: 2 capturas simultâneas brigam.
        std::thread::sleep(Duration::from_millis(120));
    }

    /// Desliga o envio de video (o recebimento continua; o tile some na UI).
    pub fn video_stop(&self, call_id: &str, peer_fp: &str) {
        if let Some(sess) = self.inner.get(&(call_id.to_owned(), peer_fp.to_owned())) {
            *sess.sh.video_state.lock().unwrap() = "off".to_string();
            *sess.sh.video_want.lock().unwrap() = None;
        }
    }

    /// Último frame remoto decodificado (JPEG + dims + seq); polling ~10 fps.
    pub fn video_frame(&self, call_id: &str, peer_fp: &str) -> Option<VideoFrame> {
        self.inner
            .get(&(call_id.to_owned(), peer_fp.to_owned()))?
            .sh
            .video_frame
            .lock()
            .unwrap()
            .clone()
    }
}

fn aggregate_stats(stats: impl IntoIterator<Item = VoiceStats>) -> Option<VoiceStats> {
    let all = stats.into_iter().collect::<Vec<_>>();
    // Estado agregado: o PIOR peer decide (HashMap não tem ordem estável —
    // um par failed derrubava a chamada dos outros; conecting escondia connected).
    let gravidade = |peer: &VoiceStats| match peer.state.as_str() {
        "failed" => 4,
        "connecting" => 3,
        "reconnecting" => 3,
        "connected" => 2,
        "idle" => 1,
        _ => 0,
    };
    let worst = all.iter().max_by_key(|peer| gravidade(peer))?;
    let mut out = worst.clone();

    // Contagem por estado ANTES de somar: o que evita matar a chamada por UM par.
    out.peers_total = Some(all.len() as u32);
    out.peers_connected = Some(all.iter().filter(|peer| peer.state == "connected").count() as u32);

    // Soma contadores UMA vez, pulando o pior por `ptr::eq` (o antigo `skip(1)`
    // contava o pior duas vezes quando ele não era o primeiro).
    for peer in all.iter() {
        if std::ptr::eq(peer, worst) {
            continue;
        }
        out.packets_in = out.packets_in.saturating_add(peer.packets_in);
        out.packets_out = out.packets_out.saturating_add(peer.packets_out);
        out.write_errors = out.write_errors.saturating_add(peer.write_errors);
        out.plc_frames = out.plc_frames.saturating_add(peer.plc_frames);
        out.decode_errors = out.decode_errors.saturating_add(peer.decode_errors);
    }

    // `route` vem do peer escolhido (a rota que decide o estado).
    let best_video = all
        .iter()
        .max_by_key(|peer| match peer.video_state.as_deref() {
            Some("live") => 4,
            Some("starting") => 3,
            Some("failed") => 2,
            Some("off") => 1,
            _ => 0,
        });
    if let Some(peer) = best_video {
        out.video_state = peer.video_state.clone();
        out.video_source = peer.video_source.clone();
        out.video_codec = peer.video_codec.clone();
    }
    out.video_error = all
        .iter()
        .find(|peer| peer.video_state.as_deref() == Some("failed"))
        .and_then(|peer| peer.video_error.clone());
    out.video_packets_in = sum_optional_stat(&all, |peer| peer.video_packets_in);
    out.frames_in = sum_optional_stat(&all, |peer| peer.frames_in);
    out.frames_out = sum_optional_stat(&all, |peer| peer.frames_out);
    Some(out)
}

fn sum_optional_stat(
    all: &[VoiceStats],
    field: impl Fn(&VoiceStats) -> Option<u64>,
) -> Option<u64> {
    let mut found = false;
    let mut sum = 0u64;
    for peer in all {
        if let Some(value) = field(peer) {
            found = true;
            sum = sum.saturating_add(value);
        }
    }
    found.then_some(sum)
}

#[cfg(test)]
mod stats_aggregation_tests {
    use super::{aggregate_stats, VoiceStats};

    fn peer(state: &str, source: Option<&str>, frames_out: u64) -> VoiceStats {
        VoiceStats {
            state: "connected".into(),
            route: "LAN".into(),
            jitter_depth_ms: 50,
            packets_in: 2,
            packets_out: 3,
            write_errors: 0,
            plc_frames: 0,
            decode_errors: 0,
            rtt_ms: Some(10),
            mic_error: None,
            speaker_error: None,
            video_state: Some(state.into()),
            video_codec: source.map(|_| "video/VP8".into()),
            video_source: source.map(str::to_owned),
            video_error: None,
            video_packets_in: Some(4),
            frames_in: Some(5),
            frames_out: Some(frames_out),
            peers_connected: None,
            peers_total: None,
        }
    }

    #[test]
    fn aggregate_prefers_live_video_and_sums_peer_counters() {
        let stats = aggregate_stats([peer("off", None, 0), peer("live", Some("screen"), 7)])
            .expect("duas sessões devem produzir stats");

        assert_eq!(stats.video_state.as_deref(), Some("live"));
        assert_eq!(stats.video_source.as_deref(), Some("screen"));
        assert_eq!(stats.frames_out, Some(7));
        assert_eq!(stats.video_packets_in, Some(8));
        assert_eq!(stats.frames_in, Some(10));
        assert_eq!(stats.packets_in, 4);
        assert_eq!(stats.packets_out, 6);
    }

    #[test]
    fn aggregate_reports_failed_video_when_no_peer_is_live_or_starting() {
        let stats = aggregate_stats([peer("off", None, 0), peer("failed", Some("camera"), 0)])
            .expect("duas sessões devem produzir stats");

        assert_eq!(stats.video_state.as_deref(), Some("failed"));
        assert_eq!(stats.video_source.as_deref(), Some("camera"));
    }

    #[test]
    fn aggregate_does_not_double_count_the_worst_peer() {
        // Pior peer failed não é o primeiro: era o caso em que `skip(1)` somava
        // o pior duas vezes.
        let mut primeiro = peer("off", None, 1);
        primeiro.state = "connected".into();
        primeiro.packets_in = 10;
        primeiro.packets_out = 20;
        let mut pior = peer("failed", Some("screen"), 3);
        pior.state = "failed".into();
        pior.packets_in = 1;
        pior.packets_out = 2;

        let stats = aggregate_stats([primeiro, pior]).expect("stats");
        assert_eq!(stats.state, "failed");
        assert_eq!(stats.packets_in, 11, "cada peer conta uma vez só");
        assert_eq!(stats.packets_out, 22);
    }

    #[test]
    fn aggregate_counts_connected_peers_so_one_bad_peer_does_not_kill_the_call() {
        // `state` agregado é o pior par; `peers_connected` distingue
        // "um par caiu" de "a chamada acabou".
        let mut a = peer("off", None, 0);
        a.state = "connected".into();
        let mut b = peer("off", None, 0);
        b.state = "failed".into();
        let mut c = peer("off", None, 0);
        c.state = "connected".into();

        let stats = aggregate_stats([a, b, c]).expect("três sessões produzem stats");
        assert_eq!(
            stats.state, "failed",
            "o pior par continua mandando no estado"
        );
        assert_eq!(stats.peers_connected, Some(2));
        assert_eq!(stats.peers_total, Some(3));
    }

    #[test]
    fn aggregate_reports_zero_connected_only_when_nobody_is_up() {
        let mut a = peer("off", None, 0);
        a.state = "failed".into();
        let mut b = peer("off", None, 0);
        b.state = "connecting".into();

        let stats = aggregate_stats([a, b]).expect("duas sessões produzem stats");
        assert_eq!(stats.peers_connected, Some(0));
        assert_eq!(stats.peers_total, Some(2));
    }

    #[test]
    fn aggregate_of_nothing_is_none_and_does_not_invent_zero_of_zero() {
        assert!(aggregate_stats(Vec::<VoiceStats>::new()).is_none());
    }
}

/// Último frame remoto decodificado (UI faz polling; sem eventos).
#[derive(Clone, Debug, serde::Serialize)]
pub struct VideoFrame {
    pub jpeg: Vec<u8>,
    pub w: u32,
    pub h: u32,
    pub seq: u64,
}

impl Inner {
    fn get(&self, k: &Key) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().get(k).cloned()
    }
    fn insert(&self, k: Key, s: Arc<Session>) {
        self.sessions.lock().unwrap().insert(k, s);
    }
    fn remove(&self, k: &Key) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().remove(k)
    }
    fn all(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().unwrap().values().cloned().collect()
    }
    fn of_call(&self, call_id: &str) -> Vec<Arc<Session>> {
        self.sessions
            .lock()
            .unwrap()
            .iter()
            .filter(|((c, _), _)| c == call_id)
            .map(|(_, s)| s.clone())
            .collect()
    }
}

// ---------------------------------------------------------------- construcao

fn ice_servers() -> Vec<RTCIceServer> {
    let mut v: Vec<RTCIceServer> = Vec::new();
    let stun = std::env::var("VOICE_STUN_URLS").unwrap_or_else(|_| STUN_DEFAULT.to_string());
    for url in stun.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        v.push(RTCIceServer {
            urls: vec![url.to_string()],
            ..Default::default()
        });
    }
    // TURN é OBRIGATÓRIO atrás de CGNAT (STUN só revela IP mapeado; CGNAT
    // simétrico nunca fecha). BUG corrigido: TURN vinha só de env var que
    // ninguém definia — agora usa o mesmo padrão do caminho JS.
    let turn_urls = std::env::var("VOICE_TURN_URLS").unwrap_or_else(|_| {
        // openrelay: TURN público com credencial estática documentada.
        format!("{TURN_DEFAULT_HOST}:{TURN_DEFAULT_PORT}")
    });
    let turn_user =
        std::env::var("VOICE_TURN_USER").unwrap_or_else(|_| TURN_DEFAULT_USER.to_string());
    let turn_pass =
        std::env::var("VOICE_TURN_PASS").unwrap_or_else(|_| TURN_DEFAULT_SECRET.to_string());
    for url in turn_urls
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let urls = if url.starts_with("turn:") || url.starts_with("turns:") {
            vec![url.to_string()]
        } else {
            vec![format!("turn:{url}")]
        };
        v.push(RTCIceServer {
            urls,
            username: turn_user.clone(),
            credential: turn_pass.clone(),
            ..Default::default()
        });
    }
    v
}

fn mdns_mode() -> MulticastDnsMode {
    match std::env::var("VOICE_MDNS").unwrap_or_default().as_str() {
        "disabled" | "off" => MulticastDnsMode::Disabled,
        "query-and-gather" | "queryandgather" => MulticastDnsMode::QueryAndGather,
        // Default de navegador: publica hostnames .local e resolve os do par.
        _ => MulticastDnsMode::QueryOnly,
    }
}

fn udp_addrs() -> Vec<String> {
    match std::env::var("VOICE_BIND") {
        Ok(v) if !v.trim().is_empty() => v.split(',').map(|s| s.trim().to_string()).collect(),
        // Sem VOICE_BIND: todas as interfaces (o que um app de chat quer).
        _ => vec!["0.0.0.0:0".to_string(), "[::]:0".to_string()],
    }
}

/// SSRC estável por par: único dentro da PC é suficiente (hash FNV).
fn ssrc_for(call_id: &str, peer_fp: &str) -> u32 {
    let mut h: u32 = 0x811C_9DC5;
    for b in call_id
        .bytes()
        .chain(b"|".iter().copied())
        .chain(peer_fp.bytes())
    {
        h ^= u32::from(b);
        h = h.wrapping_mul(0x0100_0193);
    }
    h | 0x8000_0000
}

/// SSRC do VÍDEO, distinto do de áudio: SSRCs iguais confundem o demux RTP
/// (o áudio do par "sumia" ao ligar a câmera).
fn ssrc_for_video(call_id: &str, peer_fp: &str) -> u32 {
    ssrc_for(&format!("{call_id}|video"), peer_fp)
}

async fn build_session(
    inner: &Arc<Inner>,
    call_id: &str,
    peer_fp: &str,
) -> Result<Arc<Session>, String> {
    let hub = self::audio::hub();

    let mut me = MediaEngine::default();
    me.register_default_codecs().map_err(err)?;

    let se = SettingEngineBuilder::new()
        .with_multicast_dns_mode(mdns_mode())
        .build();

    // Jitter buffer na cadeia REAL (Slot::JitterBuffer): o driver do PC já roda
    // os timeouts, então o playout por tempo não precisa de tick manual.
    let ir = register_default_interceptors(Default::default(), &mut me).map_err(err)?;
    let ir = ir.with(
        Slot::JitterBuffer,
        JitterBufferBuilder::new()
            .with_depth(JITTER_DEPTH)
            .with_capacity(JITTER_CAPACITY)
            .build(),
    );

    let cfg = RTCConfigurationBuilder::new()
        .with_ice_servers(ice_servers())
        // `iceTransportPolicy: all` — relay so' entra se TURN estiver configurado.
        .with_ice_transport_policy(RTCIceTransportPolicy::All)
        .build();

    // Caixa de playout; falha no speaker não impede a sessão (só não sai áudio).
    let inbox_id = hub.register_inbox();
    // GUARDA DE LIMPEZA: inbox/mic eram registrados antes dos awaits de rede;
    // se o build falhava, ficavam para sempre (mic "ocupado",
    // subscriber_count nunca a zero).
    struct LimpezaNoErro {
        inbox_id: Option<u64>,
        mic_id: u64,
    }
    impl Drop for LimpezaNoErro {
        fn drop(&mut self) {
            // Desarma quando o build dá certo (campos viram None/0).
            let hub = audio::hub();
            if self.mic_id != 0 {
                hub.unsubscribe(self.mic_id);
            }
            if let Some(id) = self.inbox_id {
                hub.unregister_inbox(id);
            }
        }
    }
    let mut limpeza = LimpezaNoErro {
        inbox_id: Some(inbox_id),
        mic_id: 0,
    };
    let inbox = hub
        .inbox(inbox_id)
        .ok_or_else(|| "inbox nao registrado".to_string())?;
    let _ = hub.ensure_speaker();

    let sh = Arc::new(Shared::new(inbox));
    *sh.in_link.lock().unwrap() = *inner.probe_in.lock().unwrap();
    sh.set_state("connecting");

    let pc = PeerConnectionBuilder::new()
        .with_configuration(cfg)
        .with_setting_engine(se)
        .with_media_engine(me)
        .with_interceptor_registry(ir)
        .with_handler(Arc::new(H { sh: sh.clone() }))
        .with_udp_addrs(udp_addrs())
        .build()
        .await
        .map_err(err)?;
    let pc: Arc<dyn PeerConnection> = Arc::new(pc);
    *sh.pc.lock().unwrap() = Some(pc.clone());

    // Faixa de saída: criada mesmo sem mic (sessão só recebe).
    let (mic_id, mic_rx) = if sem_mic(peer_fp) {
        eprintln!("[voice] {peer_fp}: sem microfone; sessao so vai receber");
        (0, None)
    } else {
        match hub.subscribe() {
            Ok((id, rx)) => (id, Some(rx)),
            Err(e) => {
                eprintln!("[voice] sem microfone ({e}); sessao so vai receber");
                (0, None)
            }
        }
    };
    limpeza.mic_id = mic_id;

    let codec = RTCRtpCodec {
        mime_type: "audio/opus".to_owned(),
        clock_rate: SAMPLE_RATE,
        channels: 1,
        sdp_fmtp_line: OPUS_FMTP.to_owned(),
        rtcp_feedback: vec![],
    };
    let tl = TrackLocalStaticSample::new(
        Instant::now(),
        MediaStreamTrack::new(
            format!("{peer_fp}-audio"),
            "audio".to_string(),
            "audio0".to_string(),
            RtpCodecKind::Audio,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc_for(call_id, peer_fp)),
                    ..Default::default()
                },
                codec,
                ..Default::default()
            }],
        ),
    )
    .map_err(err)?;
    let tl: Arc<TrackLocalStaticSample> = Arc::new(tl);
    let sender = pc
        .add_track(Arc::clone(&tl) as Arc<dyn TrackLocal>)
        .await
        .map_err(err)?;

    // Trilha de VÍDEO criada desde o início (sendrecv): antes era adicionada
    // no meio da chamada sem renegociação — o par nunca via a m-line e o RTP
    // ia a lugar nenhum. Navegador também anuncia audio+video (ensureMlines).
    let vcodec = RTCRtpCodec {
        mime_type: "video/VP8".to_owned(),
        clock_rate: 90_000,
        channels: 0,
        sdp_fmtp_line: String::new(),
        rtcp_feedback: vec![],
    };
    let vtl = TrackLocalStaticSample::new(
        Instant::now(),
        MediaStreamTrack::new(
            format!("{peer_fp}-video"),
            "video".to_string(),
            "video0".to_string(),
            RtpCodecKind::Video,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc_for_video(call_id, peer_fp)),
                    ..Default::default()
                },
                codec: vcodec,
                ..Default::default()
            }],
        ),
    )
    .map_err(err)?;
    let vtl: Arc<TrackLocalStaticSample> = Arc::new(vtl);
    let vsender = pc
        .add_track(Arc::clone(&vtl) as Arc<dyn TrackLocal>)
        .await
        .map_err(err)?;

    let sess = Arc::new(Session {
        call_id: call_id.to_owned(),
        peer_fp: peer_fp.to_owned(),
        sh,
        pc: pc.clone(),
        inbox_id,
        mic_id,
        mic_sub: Mutex::new(mic_rx),
        out_link: Mutex::new(*inner.probe_out.lock().unwrap()),
        muted: AtomicBool::new(false),
        closed: AtomicBool::new(false),
        tx: TxState { track: tl, sender },
        vtx: TxState {
            track: vtl,
            sender: vsender,
        },
        tasks: Mutex::new(Vec::new()),
        probe: probe(),
    });

    {
        let mut tasks = sess.tasks.lock().unwrap();
        tasks.push(spawn_send_loop(sess.clone()));
        tasks.push(spawn_stats_loop(sess.clone()));
    }
    // Sessão entregue com sucesso: o guard NÃO desfaz os registros.
    limpeza.inbox_id = None;
    limpeza.mic_id = 0;
    Ok(sess)
}

async fn wait_local_sdp(pc: &Arc<dyn PeerConnection>) -> Result<String, String> {
    let deadline = Instant::now() + SDP_WAIT;
    loop {
        if let Some(d) = pc.local_description().await {
            return Ok(d.sdp);
        }
        if Instant::now() >= deadline {
            return Err("local_description nao apareceu".to_string());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_connected(sh: &Arc<Shared>, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if sh.connected_flag.load(Ordering::SeqCst) {
            return true;
        }
        // `notified()` criado ANTES de checar a flag: sinal pré-listener se perde.
        let n = sh.connected.notified();
        if sh.connected_flag.load(Ordering::SeqCst) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        let _ = tokio::time::timeout(Duration::from_millis(100), n).await;
    }
}

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e}")
}

// ---------------------------------------------------------------- envio

fn new_encoder() -> Result<opus::Encoder, String> {
    let mut enc = opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip)
        .map_err(err)?;
    enc.set_bitrate(opus::Bitrate::Bits(BITRATE_BPS))
        .map_err(err)?;
    // DTX DESLIGADO: com DTX o Opus manda 1 frame/~400 ms no silêncio (20x o
    // frame) e mata a interatividade.
    enc.set_dtx(false).map_err(err)?;
    let _ = enc.set_inband_fec(true);
    let _ = enc.set_packet_loss_perc(5);
    Ok(enc)
}

fn spawn_send_loop(sess: Arc<Session>) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
        // Espera conectar SEM TETO: desistir em silêncio virava "só recebe"
        // até o fim com TURN lento/ICE restart tardio. Quem decide "nunca
        // conectou" é a UI (watchdogs); aqui a missão é viver com a sessão.
        let mut silent_ticks: u32 = 0;
        loop {
            if sess.closed.load(Ordering::SeqCst) {
                return;
            }
            if sess.sh.connected_flag.load(Ordering::SeqCst) {
                break;
            }
            silent_ticks = silent_ticks.saturating_add(1);
            if silent_ticks == 150 {
                // ~30s sem rota: um log honesto (NAO desiste).
                eprintln!("[voice] envio aguardando ICE conectar (>30s; TURN/CGNAT demoram)");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        // PT/SSRC só existem depois do answer: tenta ~10 s e, se nada, marca
        // `failed` com motivo (antes morria em silêncio com "connected").
        let mut attempt: u32 = 0;
        let (pt, ssrc) = loop {
            if sess.closed.load(Ordering::SeqCst) {
                return;
            }
            let pt = match sess.tx.sender.get_parameters().await {
                Ok(p) => {
                    // PRIORIZA o Opus negociado: com fmtp divergente ele cai no
                    // balde parcial e `.first()` escolhia PT=0 (PCMU) — ruído
                    // alto no receptor com packets_out normal.
                    p.rtp_parameters
                        .codecs
                        .iter()
                        .find(|c| c.rtp_codec.mime_type.eq_ignore_ascii_case("audio/opus"))
                        .or_else(|| p.rtp_parameters.codecs.first())
                        .map(|c| c.payload_type)
                }
                Err(e) => {
                    tracing::debug!("[voice] get_parameters ainda nao pronto: {e}");
                    None
                }
            };
            let ssrc = sess.tx.track.ssrcs().await.first().copied();
            if let (Some(pt), Some(ssrc)) = (pt, ssrc) {
                break (pt, ssrc);
            }
            attempt = attempt.saturating_add(1);
            if attempt >= 20 {
                let msg =
                    "nao foi possivel enviar audio: o SDP nao negociou codec/SSRC desta sessao"
                        .to_string();
                eprintln!("[voice] {msg}");
                sess.sh.set_state("failed");
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        };

        let mut enc = match new_encoder() {
            Ok(e) => e,
            Err(e) => {
                eprintln!("[voice] encoder Opus falhou: {e}");
                return;
            }
        };

        let mut mic_rx = sess.mic_sub.lock().unwrap().take();
        if mic_rx.is_none() {
            // Sessão só-recebe (mic ainda não abriu): antes `return` imediato —
            // `retry_mic` reabria o device mas não re-assinava, e quem entrava
            // antes do mic ficar pronto ficava MUDO. Tenta assinar por 60 s.
            let hub_mic = self::audio::hub();
            for _ in 0..30 {
                tokio::time::sleep(Duration::from_secs(2)).await;
                if let Some((_, rx)) = hub_mic.subscribe().ok() {
                    mic_rx = Some(rx);
                    eprintln!(
                        "[voice] {}/{}: microfone passou a existir — envio liberado",
                        sess.call_id, sess.peer_fp
                    );
                    break;
                }
            }
            if mic_rx.is_none() {
                // Honesto: segue recebendo, mas ninguém nos ouve (mic_error já
                // publicado em VoiceStats).
                eprintln!(
                    "[voice] {}/{}: segue só recebendo (sem microfone)",
                    sess.call_id, sess.peer_fp
                );
                return;
            }
        }
        // `idx` conta PACOTES ESCRITOS (o packetizer só avança o RTP por sample).
        let mut idx: u64 = 0;

        // Descarta o backlog de ~1.5 s acumulado durante o ICE (despejar de uma
        // vez estoura o jitter buffer e a latência medida vira a idade do backlog).
        let mut descartados = 0usize;
        if let Some(rx) = mic_rx.as_mut() {
            while rx.try_recv().is_ok() {
                descartados += 1;
            }
        }
        if descartados > 0 {
            eprintln!(
                "[voice] {}/{}: {descartados} frames do mic acumulados no ICE foram descartados",
                sess.call_id, sess.peer_fp
            );
        }

        // Envio DISPARADO pelo frame, não por relógio de slots (slots repetiam
        // frame antigo e ficavam permanentemente atrasados).
        let mut pkt = vec![0u8; 4000];
        DBG.with(|d| d.set(dbg_on()));

        // AEC só com ALTO-FALANTE (fone não tem eco; filtro aprendia a voz
        // local). RefRing compartilhado: referência é o mesmo áudio p/ todos.
        let hub = self::audio::hub();
        let aec_ref = hub.play_ref();
        let mut aec = crate::net::media_dsp::EchoCanceller::new(aec_ref.clone(), hub.has_speaker());
        if aec.is_enabled() {
            eprintln!(
                "[voice] AEC ligado: filtro {} ms ({} amostras) a {} Hz",
                crate::net::media_dsp::FILTER_LENGTH_MS,
                crate::net::media_dsp::FILTER_LENGTH,
                crate::net::media_dsp::SAMPLE_RATE
            );
        }

        loop {
            if sess.closed.load(Ordering::SeqCst) {
                return;
            }
            // Mudo: não escreve (clock RTP para, receptor usa PLC) e DRENA o
            // canal — sem drenar: ~360 MB/h mutado + rajada ao desmutar.
            if sess.muted.load(Ordering::SeqCst) {
                if let Some(rx) = mic_rx.as_mut() {
                    while rx.try_recv().is_ok() {}
                }
                tokio::time::sleep(FRAME).await;
                continue;
            }

            let rx = match mic_rx.as_mut() {
                Some(r) => r,
                None => return,
            };
            // Espera o frame com janela 1.5x o período: janela exata descartava
            // frame atrasado e o clock RTP andava mais devagar que o real
            // (áudio picado sob carga, sem erro nos contadores).
            let Ok(Some(frame)) = tokio::time::timeout(FRAME + FRAME / 2, rx.recv()).await else {
                continue;
            };
            let at = frame.captured_at;
            let pcm = frame.pcm;
            let t_pick = Instant::now();
            if pcm.len() != FRAME_SAMPLES {
                continue;
            }

            // AEC antes de codificar (eco nunca vira RTP; sem referência o
            // áudio passa intacto).
            aec.maybe_rearm(hub.has_speaker());
            let limpo = aec.process(&pcm);

            let t_enc = Instant::now();
            let n = match enc.encode(limpo, &mut pkt) {
                Ok(n) => n,
                Err(e) => {
                    eprintln!("[voice] encode Opus falhou: {e:?}");
                    continue;
                }
            };
            pkt.truncate(n);

            if DBG.with(|d| d.get()) {
                let base = {
                    let mut g = DBG_BASE.lock().unwrap();
                    match *g {
                        None => {
                            *g = Some(at);
                            at
                        }
                        Some(b) => b,
                    }
                };
                if idx < 6 {
                    eprintln!(
                        "[dbg] escrita idx={idx}: captura +{} ms, PEGA +{} ms, escrita +{} ms",
                        at.saturating_duration_since(base).as_millis(),
                        t_pick.saturating_duration_since(base).as_millis(),
                        Instant::now().saturating_duration_since(base).as_millis()
                    );
                }
            }
            if let Some(link) = *sess.out_link.lock().unwrap() {
                sess.probe.stamp_capture(link, idx, at);
            }
            let write_res = sess
                .tx
                .track
                .sample_writer(ssrc, pt)
                .write_sample(&Sample {
                    data: Bytes::from(pkt.clone()),
                    // Duração de wall clock: dela derivam as 960 ticks/frame.
                    duration: FRAME,
                    // timestamp = instante de geração no mic
                    ..Sample::new(at)
                })
                .await;
            let t_end = Instant::now();
            if DBG.with(|d| d.get()) && idx < 6 {
                eprintln!(
                    "[dbg]   encode {} us, write_sample {} us",
                    t_enc.saturating_duration_since(t_pick).as_micros(),
                    t_end.saturating_duration_since(t_enc).as_micros()
                );
            }
            idx += 1;
            // `packets_out` só conta o que REALMENTE entrou na track.
            //
            // Antes o `Result` era descartado e o contador subia sempre: o
            // painel mostrava "enviando" com a escrita falhando (track fechada
            // por hangup, PT inválido) — e o diagnóstico concluía que o
            // problema era sempre do outro lado.
            match write_res {
                Ok(()) => {
                    // Só conta com ROTA VIVA. Durante `reconnecting`/`failed` a
                    // track aceita a escrita e o ICE descarta depois; somar ali
                    // fazia o painel mostrar "pacotes saindo" numa sessão que
                    // não entrega nada — a mentira que o `Disconnected` acima
                    // existe para evitar.
                    if sess.sh.connected_flag.load(Ordering::Relaxed) {
                        sess.sh.packets_out.fetch_add(1, Ordering::Relaxed);
                    }
                }
                Err(e) => {
                    sess.sh.write_errors.fetch_add(1, Ordering::Relaxed);
                    if idx <= 3 {
                        tracing::warn!(
                            call_id = %sess.call_id,
                            peer = %sess.peer_fp,
                            "[voice] write_sample falhou: {e}"
                        );
                    }
                }
            }

            // Alinha o próximo envio no RELOGIO DE CAPTURA (at + FRAME):
            // ritmo de 50 pacotes/s sem acumular atraso.
            let wait = (at + FRAME).saturating_duration_since(Instant::now());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
    })
    .abort_handle()
}

// ---------------------------------------------------------------- recepcao

/// Estende o sequence number de 16 bits para 32, tolerando o wrap.
fn extend_seq(expected: Option<u32>, seq: u32) -> u32 {
    match expected {
        None => seq,
        Some(e) => {
            let mut cand = (e & !0xFFFF) | seq;
            if cand.wrapping_add(0x8000) < e {
                cand = cand.wrapping_add(0x1_0000);
            } else if cand > e.wrapping_add(0x8000) {
                cand = cand.wrapping_sub(0x1_0000);
            }
            cand
        }
    }
}

fn spawn_recv(
    track: Arc<dyn TrackRemote>,
    sh: Arc<Shared>,
    in_link: Option<u32>,
) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
        // Decoder DENTRO da task: opus::Decoder nao e' Sync e nao ha motivo para
        // compartilhar.
        let mut dec = match opus::Decoder::new(SAMPLE_RATE, opus::Channels::Mono) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[voice] decoder Opus falhou: {e:?}");
                return;
            }
        };
        let mut pcm = vec![0i16; FRAME_SAMPLES];
        DBG.with(|d| d.set(dbg_on()));
        let mut expected: Option<u32> = None;

        while let Some(ev) = track.poll().await {
            let TrackRemoteEvent::OnRtpPacket(pkt) = ev else {
                continue;
            };
            sh.packets_in.fetch_add(1, Ordering::Relaxed);

            let ts = pkt.header.timestamp;
            let base = {
                let mut b = sh.base_ts.lock().unwrap();
                if b.is_none() {
                    *b = Some(ts);
                }
                b.unwrap()
            };

            let seq = u32::from(pkt.header.sequence_number);
            if DBG.with(|d| d.get()) && seq < 6 {
                let base = *DBG_BASE.lock().unwrap();
                if let Some(b) = base {
                    eprintln!(
                        "[dbg] chegada  seq={seq}: chegada +{} ms",
                        Instant::now().saturating_duration_since(b).as_millis()
                    );
                }
            }
            let ext = extend_seq(expected, seq);
            if let Some(e) = expected {
                if ext > e {
                    // BURACO LONGO = MUTE/SSRC NOVO, NÃO PERDA.
                    //
                    // O mute do remetente PARA de escrever RTP, então o `seq`
                    // salta N. Sintetizar `min(N, 50)` frames de concealment
                    // (1 s) empurrava 1 s de áudio inventado na inbox de uma
                    // vez e deixava o receptor 1 s atrasado até drenar — o
                    // "embaralha/some quando alguém desmuta".
                    // Acima de ~200 ms é silêncio honesto: re-sincroniza sem
                    // fabricar áudio.
                    let gap = ext - e;
                    if gap > PLC_RESYNC_GAP {
                        sh.plc_frames.fetch_add(u64::from(gap), Ordering::Relaxed);
                    } else {
                        for _ in 0..gap {
                            // PLC de verdade: payload vazio = concealment do decoder.
                            match dec.decode(&[], &mut pcm, false) {
                                Ok(n) => {
                                    sh.plc_frames.fetch_add(1, Ordering::Relaxed);
                                    push_pcm(&sh, &pcm, n, None);
                                }
                                Err(e) => {
                                    sh.decode_errors.fetch_add(1, Ordering::Relaxed);
                                    eprintln!("[voice] PLC falhou: {e:?}");
                                }
                            }
                        }
                    }
                } else if ext < e {
                    // Duplicata/replay: o jitter buffer já entregou em ordem.
                    continue;
                }
            }
            expected = Some(ext.wrapping_add(1));

            match dec.decode(&pkt.payload, &mut pcm, false) {
                Ok(n) => {
                    let idx = u64::from(ts.wrapping_sub(base) / FRAME_SAMPLES as u32);
                    let id = in_link.map(|l| (l, idx));
                    if let Some((l, i)) = id {
                        probe().stamp_release(l, i, Instant::now());
                    }
                    push_pcm(&sh, &pcm, n, id);
                }
                Err(e) => {
                    sh.decode_errors.fetch_add(1, Ordering::Relaxed);
                    eprintln!("[voice] decode falhou: {e:?}");
                }
            }
        }
    })
    .abort_handle()
}

fn push_pcm(sh: &Arc<Shared>, pcm: &[i16], n: usize, id: Option<(u32, u64)>) {
    if n == 0 || n > pcm.len() {
        return;
    }
    let mut q = sh.inbox.lock().unwrap();
    // Teto de ~4 s de fila: playout parado não vira latência infinita.
    while q.len() > 200 {
        q.pop_front();
    }
    q.push_back(PcmFrame {
        pcm: Arc::new(pcm[..n].to_vec()),
        id,
    });
}

// ---------------------------------------------------------------- stats

// ---------------------------------------------------------------- video

/// Marca falha de video com motivo (o painel mostra em vez de tile preto).
fn video_fail(sh: &Arc<Shared>, msg: String) {
    tracing::warn!("[video] {msg}");
    *sh.video_state.lock().unwrap() = "failed".to_string();
    *sh.video_error.lock().unwrap() = Some(msg);
}

/// Teto de FPS do envio de video.
const VIDEO_FPS: u32 = 30;
/// Intervalo entre quadros: 30 fps => ~33 ms.
const VIDEO_FRAME_INTERVAL: Duration = Duration::from_millis(33);
/// Janela do watchdog: encoder "live" sem pacote por 15 s = envio morto
/// (câmera escura ainda gera frames).
const VIDEO_STALL: Duration = Duration::from_secs(15);

/// Envia vídeo pela MESMA PC da voz: espera conectar → lê PT negociado →
/// encoder → laço com watchdog de 15 s.
async fn video_send_task(sess: Arc<Session>, want_source: String) {
    let sh = sess.sh.clone();
    // ORDEM DE LOCK ÚNICA (state → want): o antigo let-else invertia a ordem de
    // `video_start`/`stop`/`purge` e travava a UI em entrelaçamento.
    let want = sh.video_want.lock().unwrap().clone();
    let Some((_, want_monitor)) = want else {
        *sh.video_state.lock().unwrap() = "off".to_string();
        return;
    };
    let is_screen = want_source == "screen";
    // Sem teto: vídeo só começa após a rota; watchdog cuida de "conectou e morreu".
    let mut vticks: u32 = 0;
    loop {
        if sess.closed.load(Ordering::SeqCst)
            || sh.video_state.lock().unwrap().as_str() != "starting"
        {
            return;
        }
        if sh.connected_flag.load(Ordering::SeqCst) {
            break;
        }
        vticks = vticks.saturating_add(1);
        if vticks == 150 {
            tracing::debug!("[video] aguardando ICE conectar (>30s)");
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    // Re-avalia: o usuario pode ter desligado a camera enquanto o ICE subia.
    if sh.video_state.lock().unwrap().as_str() != "starting" {
        return;
    }

    // Transceiver já veio do `build_session`: só lemos codec/PT aceito pelo par.
    let params = match sess.vtx.sender.get_parameters().await {
        Ok(p) => p,
        Err(e) => {
            video_fail(&sh, format!("vídeo: sender sem parâmetros: {e}"));
            return;
        }
    };
    // Escolhe o PT de codec que o ENCODER realmente produz (VP8, depois H264):
    // pegar o primeiro do SDP dava PT de VP9/AV1 recebendo bitstream VP8
    // (o par decodificava lixo); nenhum dos dois = erro explícito.
    let neg = &params.rtp_parameters.codecs;
    let pick = neg
        .iter()
        .find(|c| c.rtp_codec.mime_type.eq_ignore_ascii_case("video/VP8"))
        .or_else(|| {
            neg.iter()
                .find(|c| c.rtp_codec.mime_type.eq_ignore_ascii_case("video/H264"))
        });
    let Some(c) = pick else {
        let oferecidos: Vec<&str> = neg
            .iter()
            .filter(|c| {
                c.rtp_codec
                    .mime_type
                    .to_ascii_lowercase()
                    .starts_with("video")
            })
            .map(|c| c.rtp_codec.mime_type.as_str())
            .collect();
        video_fail(
            &sh,
            format!(
                "o outro lado não aceitou VP8 nem H264 (ofereceu: {})",
                if oferecidos.is_empty() {
                    "nenhum codec de vídeo".to_string()
                } else {
                    oferecidos.join(", ")
                }
            ),
        );
        return;
    };
    let mime = c.rtp_codec.mime_type.clone();
    let pt = c.payload_type;
    let vtl = sess.vtx.track.clone();
    *sh.video_track.lock().unwrap() = Some(vtl.clone());
    let codec = match crate::net::media_video::VideoCodec::supported_from_mime(&mime) {
        Some(c) => c,
        None => {
            video_fail(&sh, format!("codec de vídeo não implementado: {mime}"));
            return;
        }
    };
    let want = codec.mime();
    *sh.video_codec.lock().unwrap() = Some(want.to_string());
    *sh.video_source.lock().unwrap() = Some(want_source.clone());
    sh.frames_out.store(0, Ordering::Relaxed);
    tracing::debug!("[video] enviando ({want}, {want_source}) pt={pt}");

    // Encoder: construção bloqueante (abre device), fora do laço quente.
    let built = tokio::task::spawn_blocking(move || {
        if is_screen {
            crate::net::media_video::new_screen(codec, VIDEO_FPS)
        } else {
            crate::net::media_video::new_camera(codec, VIDEO_FPS)
        }
    })
    .await;
    let mut enc: Option<crate::net::media_video::VideoEncoder> = match built {
        Ok(Ok(e)) => Some(e),
        Ok(Err(e)) => {
            video_fail(&sh, e);
            return;
        }
        Err(_) => {
            video_fail(&sh, "encoder de vídeo: tarefa de construção caiu".into());
            return;
        }
    };

    let mut last_progress = Instant::now();
    let mut grab_miss: u32 = 0;
    // SSRC buscado UMA vez: por quadro custava ~20 ms e travava em ~15 fps.
    let ssrc = vtl.ssrcs().await.first().copied();
    if ssrc.is_none() {
        video_fail(&sh, "vídeo: a track local ficou sem ssrc".into());
        return;
    }

    loop {
        if sess.closed.load(Ordering::SeqCst) {
            break;
        }
        if !matches!(sh.video_state.lock().unwrap().as_str(), "starting" | "live") {
            break;
        }
        // `take()`: encoder movido para a `spawn_blocking`; Option evita usar
        // valor já movido num `break` do meio do laço.
        let t_iter = Instant::now();
        let Some(mut enc2) = enc.take() else { break };
        // Captura/encode fora do worker tokio; mantém só o quadro mais recente.
        let pumped = tokio::task::spawn_blocking(
            move || -> (Option<Vec<u8>>, Option<String>, bool, crate::net::media_video::VideoEncoder) {
            // `ximagesrc` captura sozinho: só puxar, sem alimentar por cima.
            let needs_feed = is_screen && !enc2.self_feeding();
            let mut grab_ok = !needs_feed;
            let mut capture_error = None;
            if needs_feed {
                match crate::net::media_video::grab_screen_frame(want_monitor) {
                    Some((rgb, w, h)) => {
                        if let Err(e) = enc2.push_screen_frame(&rgb, w, h) {
                            capture_error = Some(e);
                            grab_ok = false;
                        } else {
                            grab_ok = true;
                        }
                    }
                    None => grab_ok = false,
                }
            }
            let mut latest = enc2.poll_encoded_frame(Duration::ZERO);
            for _ in 0..16 {
                match enc2.poll_encoded_frame(Duration::ZERO) {
                    Some(frame) => latest = Some(frame),
                    None => break,
                }
            }
            let err = capture_error.or_else(|| enc2.take_error());
            (latest, err, grab_ok, enc2)
            },
        )
        .await;
        let (frame, enc_err, grab_ok, encoder) = match pumped {
            Ok(v) => v,
            Err(_) => break,
        };
        // Devolve o encoder ao laço ANTES de qualquer break (senão o `enc.stop()`
        // final não acha o encoder e o device fica aberto).
        enc = Some(encoder);
        if let Some(e) = enc_err {
            video_fail(&sh, e);
            break;
        }
        if grab_ok {
            grab_miss = 0;
        } else {
            grab_miss = grab_miss.saturating_add(1);
        }
        let sent = usize::from(frame.is_some());
        if let Some(frame) = frame {
            let sample = Sample {
                // TrackLocalStaticSample packetiza em RTP; aqui não entram pacotes.
                data: Bytes::from(frame),
                duration: VIDEO_FRAME_INTERVAL,
                timestamp: Instant::now(),
                packet_timestamp: rtp_ts_video(),
                prev_dropped_packets: 0,
                prev_padding_packets: 0,
            };
            let Some(ssrc) = ssrc else { break };
            if let Err(e) = vtl.write_sample(ssrc, pt, &sample, &[]).await {
                video_fail(&sh, format!("vídeo: falha ao escrever amostra RTP: {e}"));
                break;
            }
            sh.frames_out.fetch_add(1, Ordering::Relaxed);
            let mut state = sh.video_state.lock().unwrap();
            if state.as_str() == "starting" {
                *state = "live".to_string();
            }
        }
        if sent > 0 {
            last_progress = Instant::now();
        } else if last_progress.elapsed() > VIDEO_STALL {
            // 15 s sem pacote: captura morta (Wayland sem portal, device removido).
            let msg = if is_screen {
                format!(
                    "tela sem frames há {} s (captura vazia em {grab_miss} ticks — Wayland sem portal/permissão, ou o monitor sumiu)",
                    VIDEO_STALL.as_secs()
                )
            } else {
                format!(
                    "câmera sem frames há {} s (device travou ou foi removido no meio da chamada)",
                    VIDEO_STALL.as_secs()
                )
            };
            video_fail(&sh, msg);
            break;
        }
        // Passo adaptativo: dormir só o que falta do intervalo (33 ms cheios
        // + custo do frame travavam em ~15 fps).
        let gasto = t_iter.elapsed();
        if gasto < VIDEO_FRAME_INTERVAL {
            tokio::time::sleep(VIDEO_FRAME_INTERVAL - gasto).await;
        } else {
            tokio::task::yield_now().await;
        }
    }

    // FECHA o device: sem `set_state(Null)` a próxima câmera falha "device busy".
    if let Some(mut e) = enc {
        e.stop();
    }

    // NÃO chamar `vtl.stop()` aqui: a track pertence à sessão e já foi
    // negociada; `stop()` a deixava sem SSRC — era o bug "câmera só liga
    // uma vez" (só hangup + nova chamada recuperava). Quem encerra é o
    // `close_key`/drop junto com a PC.
    let mut state = sh.video_state.lock().unwrap();
    if matches!(state.as_str(), "starting" | "live") {
        *state = "off".to_string();
    }
    tracing::debug!("[video] envio encerrado");
}

/// Timestamp RTP de video (relogio de 90 kHz, ancorado no processo).
fn rtp_ts_video() -> u32 {
    static ANCHOR: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let a = ANCHOR.get_or_init(std::time::Instant::now);
    (a.elapsed().as_micros() as u64 / 11_111) as u32
}

/// Recebimento: pacotes RTP -> decode GStreamer -> JPEG mais recente p/ a UI.
fn spawn_video_recv(track: Arc<dyn TrackRemote>, sh: Arc<Shared>) -> tokio::task::AbortHandle {
    let h = tokio::spawn(async move {
        let mut dec: Option<crate::net::media_video::VideoDecoder> = None;
        let mut n = 0u64;
        while let Some(ev) = track.poll().await {
            let TrackRemoteEvent::OnRtpPacket(pkt) = ev else {
                continue;
            };
            n += 1;
            sh.video_packets_in.fetch_add(1, Ordering::Relaxed);
            if n <= 3 || n % 200 == 0 {
                tracing::debug!(
                    "[video] recv pacote #{n} ssrc={} seq={} pt={} payload={}",
                    pkt.header.ssrc,
                    pkt.header.sequence_number,
                    pkt.header.payload_type,
                    pkt.payload.len()
                );
            }
            if dec.is_none() {
                let mime = track
                    .codec(pkt.header.ssrc)
                    .await
                    .map(|c| c.mime_type.clone())
                    .unwrap_or_else(|| "video/VP8".to_string());
                let codec = match crate::net::media_video::VideoCodec::supported_from_mime(&mime) {
                    Some(c) => c,
                    None => {
                        video_fail(
                            &sh,
                            format!(
                                "codec de vídeo não suportado: {mime} (o decodificador só abre VP8/H264)"
                            ),
                        );
                        break;
                    }
                };
                // PT NEGOCIADO + sprop do SDP remoto: sem os dois, o depay
                // rejeita tudo (PT != 96) ou H264 fica preto até SPS in-band.
                let pt = pkt.header.payload_type;
                let sprop = sh
                    .remote_sdp
                    .lock()
                    .unwrap()
                    .as_deref()
                    .and_then(crate::net::media_video::extract_h264_sprop);
                *sh.video_codec.lock().unwrap() = Some(mime.clone());
                tracing::debug!(
                    "[video] decoder abrindo mime={mime} pt={pt} sprop={}",
                    sprop.is_some()
                );
                let built = tokio::task::spawn_blocking(move || {
                    crate::net::media_video::VideoDecoder::new_with_pt(codec, pt, sprop.as_deref())
                })
                .await;
                match built {
                    Ok(Ok(d)) => {
                        tracing::debug!("[video] recebendo ({mime})");
                        dec = Some(d);
                    }
                    Ok(Err(e)) => {
                        video_fail(&sh, format!("decodificador {mime} não abriu: {e}"));
                        break;
                    }
                    Err(e) => {
                        video_fail(&sh, format!("tarefa do decodificador {mime} falhou: {e}"));
                        break;
                    }
                }
            }
            if let Some(d) = dec.as_mut() {
                use rtc::shared::marshal::Marshal;
                if let Ok(bytes) = pkt.marshal() {
                    if let Err(e) = d.push_rtp(&bytes) {
                        video_fail(&sh, format!("entrada RTP de vídeo falhou: {e}"));
                        return;
                    }
                }
                if let Some(e) = d.take_error() {
                    video_fail(&sh, e);
                    return;
                }
                // Drena frames sem bloquear (só o mais recente). JPEG de cada
                // frame sai por `spawn_blocking` DEDICADO (2-4 ms de CPU cada;
                // aqui embaixo engasgava o áudio quando o vídeo ligava).
                while let Some((rgb, w, h)) = d.poll_frame(Duration::ZERO) {
                    let rgb = std::sync::Arc::new(rgb);
                    let sh_task = sh.clone();
                    tokio::spawn(async move {
                        if let Ok(Ok(jpg)) = tokio::task::spawn_blocking(move || {
                            crate::net::media_video::jpeg_encode(&rgb, w, h)
                        })
                        .await
                        {
                            let seq = sh_task.video_seq.fetch_add(1, Ordering::Relaxed);
                            *sh_task.video_frame.lock().unwrap() = Some(VideoFrame {
                                jpeg: jpg,
                                w,
                                h,
                                seq,
                            });
                            sh_task.frames_in.fetch_add(1, Ordering::Relaxed);
                        }
                    });
                }
            }
        }
        tracing::debug!("[video] recebimento encerrado");
    });
    h.abort_handle()
}

fn spawn_stats_loop(sess: Arc<Session>) -> tokio::task::AbortHandle {
    let pc = sess.pc.clone();
    let sh = sess.sh.clone();
    tokio::spawn(async move {
        DBGSTATS.with(|d| d.set(dbg_stats_on()));
        loop {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            if sess.closed.load(Ordering::SeqCst) {
                return;
            }
            if sh.state.lock().unwrap().as_str() != "connected" {
                continue;
            }
            let report = pc.get_stats(Instant::now(), StatsSelector::None).await;

            // Melhor par: nominado, ou o que mais transportou mídia.
            let mut best: Option<(u64, String, f64)> = None;
            for e in report.iter() {
                if let RTCStatsReportEntry::IceCandidatePair(p) = e {
                    if p.nominated || p.packets_sent > 0 || p.packets_received > 0 {
                        let better = match &best {
                            None => true,
                            Some((n, _, _)) => p.packets_sent > *n,
                        };
                        if better {
                            best = Some((
                                p.packets_sent,
                                p.local_candidate_id.clone(),
                                p.current_round_trip_time,
                            ));
                        }
                    }
                }
            }
            let Some((_, local_id, rtt)) = best else {
                if DBGSTATS.with(|d| d.get()) {
                    eprintln!("[dbg] stats: nenhum candidate pair utilizavel");
                    for e in report.iter() {
                        eprintln!("[dbg]   entrada {:?} id={:?}", e.stats_type(), e.id());
                    }
                }
                continue;
            };
            if DBGSTATS.with(|d| d.get()) {
                eprintln!("[dbg] stats: par local_candidate_id={local_id} rtt={rtt}");
                for e in report.iter() {
                    if let RTCStatsReportEntry::LocalCandidate(c) = e {
                        eprintln!(
                            "[dbg]   local candidate id={:?} tipo={:?} addr={:?}:{}",
                            e.id(),
                            c.candidate_type,
                            c.address,
                            c.port
                        );
                    }
                }
            }
            if rtt > 0.0 {
                *sh.rtt_ms.lock().unwrap() = Some((rtt * 1000.0).round() as u64);
            }
            for e in report.iter() {
                if let RTCStatsReportEntry::LocalCandidate(c) = e {
                    // Par referencia o candidato por id cru; report traz id
                    // prefixado com o tipo do objeto.
                    if e.id() == local_id || e.id().ends_with(&local_id) {
                        let route = match c.candidate_type {
                            RTCIceCandidateType::Relay => "TURN",
                            RTCIceCandidateType::Srflx | RTCIceCandidateType::Prflx => "STUN",
                            RTCIceCandidateType::Host => "LAN",
                            _ => "n/d",
                        };
                        *sh.route.lock().unwrap() = route.to_string();
                        break;
                    }
                }
            }
        }
    })
    .abort_handle()
}

#[cfg(test)]
mod mic_gain_tests {
    use super::audio::MicGain;

    /// Pico em i32: `i16::MIN.abs()` estoura em i16 e panica em debug.
    fn peak(samples: &[i16]) -> i32 {
        samples.iter().map(|s| (*s as i32).abs()).max().unwrap_or(0)
    }

    /// Aplica o ganho a `n` callbacks novos (cada bloco = áudio novo, mesmo pico).
    fn rodar(agc: &mut MicGain, n: usize, bloco: &[i16]) -> i32 {
        let mut ultimo = 0;
        for _ in 0..n {
            let mut b = bloco.to_vec();
            agc.process(&mut b);
            ultimo = peak(&b);
        }
        ultimo
    }

    #[test]
    fn amplifica_voz_baixa_ate_o_alvo() {
        // Caso medido: device a 31% de volume, pico -33 dBFS.
        let mut agc = MicGain::new();
        let bloco = vec![4000i16; 960]; // pico 0.122
        let saida = rodar(&mut agc, 40, &bloco);
        let alvo = saida as f32 / i16::MAX as f32;
        assert!(
            (alvo - MicGain::TARGET).abs() < 0.06,
            "pico nao foi para o alvo: {alvo}"
        );
    }

    #[test]
    fn nao_amplifica_silencio() {
        let mut agc = MicGain::new();
        for v in [0i16, 3, 0, 2, 1] {
            let mut b = vec![v; 960];
            agc.process(&mut b);
            assert_eq!(peak(&b), v.abs() as i32, "silencio foi amplificado");
        }
        assert_eq!(agc.gain, 1.0);
    }

    #[test]
    fn nunca_estoura_acima_de_full_scale() {
        let mut agc = MicGain::new();
        // Sinal já alto: ganho volta a 1.0, limitador segura full scale.
        let bloco: Vec<i16> = (0..960)
            .map(|i| if i % 2 == 0 { i16::MAX } else { 30000 })
            .collect();
        let saida = rodar(&mut agc, 60, &bloco);
        assert!(saida <= i16::MAX as i32, "estouro digital");
        assert_eq!(agc.gain, 1.0);
    }

    #[test]
    fn limitador_nao_estoura_com_pico_minimo() {
        // Pico baixo: o limitador suave tem de segurar sem clip reto.
        let mut agc = MicGain::new();
        let bloco: Vec<i16> = (0..960).map(|i| 300 + (i % 7) as i16 * 10).collect();
        let saida = rodar(&mut agc, 100, &bloco);
        assert!(saida <= i16::MAX as i32, "estouro digital");
    }
}

#[cfg(test)]
mod aggregate_priority_tests {
    use super::{aggregate_stats, VoiceStats};

    fn peer(state: &str) -> VoiceStats {
        VoiceStats {
            state: state.into(),
            route: "LAN".into(),
            jitter_depth_ms: 20,
            packets_in: 1,
            packets_out: 1,
            write_errors: 0,
            plc_frames: 0,
            decode_errors: 0,
            rtt_ms: Some(5),
            mic_error: None,
            speaker_error: None,
            video_state: None,
            video_codec: None,
            video_source: None,
            video_error: None,
            video_packets_in: None,
            frames_in: None,
            frames_out: None,
            peers_connected: None,
            peers_total: None,
        }
    }

    #[test]
    fn aggregate_state_is_the_worst_case_not_an_arbitrary_peer() {
        // Regressão: `all.first()` sorteado pela ordem do HashMap reportava
        // `connected` com um par `failed`.
        let s = aggregate_stats(vec![peer("connected"), peer("failed"), peer("connected")])
            .expect("agregado");
        assert_eq!(s.state, "failed", "um par failed decide o estado do mesh");
    }

    #[test]
    fn aggregate_state_connected_only_when_every_peer_is() {
        let s = aggregate_stats(vec![peer("connected"), peer("connected")]).expect("agregado");
        assert_eq!(s.state, "connected");
    }

    #[test]
    fn aggregate_state_connecting_pinned_even_after_a_connected_peer() {
        // A ordem do Vec não pode mudar o resultado (connecting > connected).
        for v in [
            vec![peer("connected"), peer("connecting")],
            vec![peer("connecting"), peer("connected")],
        ] {
            let s = aggregate_stats(v).expect("agregado");
            assert_eq!(s.state, "connecting");
        }
    }
}
