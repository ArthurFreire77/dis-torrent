//! Mídia de voz NATIVA (Rust/webrtc-rs + cpal + Opus) — o motor de áudio do app.
//!
//! O WebRTC do navegador não existe (ou não é confiável) no WebKitGTK do Linux,
//! então a voz do lado desktop é feita aqui em Rust: cpal -> Opus(VOIP 20 ms) ->
//! webrtc-rs -> jitter buffer -> decode Opus -> cpal. O mesmo código fala SDP e
//! trickle ICE **padrão**, então conversa com um navegador (Windows/Android/
//! macOS) sem tradutor.
//!
//! Latência: o gargalo é a profundidade do jitter buffer. Mediu-se 144 ms com
//! 120 ms de profundidade; aqui o alvo é 50 ms (ITU-T G.114 trata como
//! interativo tudo abaixo de 100 ms).
//!
//! Decisões que NÃO podem ser revertidas sem medir de novo:
//! - jitter buffer com 50 ms de profundidade (2-3 pacotes de 20 ms);
//! - cpal com buffer EXPLÍCITO de 960 frames (20 ms @ 48 kHz), nunca `Default`
//!   (em ALSA/PipeWire `Default` pode resolver para 1024..=u32::MAX frames);
//! - Opus 20 ms / 48 kHz / mono / VOIP com DTX DESLIGADO — DTX manda um frame a
//!   cada 400 ms no silêncio, ou seja, 20x a duração do frame;
//! - `Sample::duration` = duração REAL de wall clock; `Sample::new(instante)` = o
//!   instante em que o frame nasceu no microfone;
//! - nada de supressão de eco no caminho de captura (áudio soberano, sem AGC).
//!
//! REGRA DE COEXISTÊNCIA (não reverta sem medir de novo nos 3 sistemas):
//! este módulo NUNCA assume uma chamada por conta própria. Quem decide é o
//! `NetworkEngine`, e apenas para pares (call_id, peer_fp) registrados em
//! `NetworkEngine::voice_calls`. Sem sessão registrada, o frame de sinalização
//! segue intacto para o JS e o WebRTC do navegador continua sendo o dono da
//! chamada. É essa assimetria — e nada mais — que mantém Windows/Android/macOS
//! exatamente como estavam.

pub mod probe {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    /// (link, indice do frame de 20 ms). O `link` distingue um par (sender, receiver)
    /// dentro do mesmo processo: num loopback in-process as duas pontas compartilham
    /// este registro, e cada direcao tem o seu proprio id.
    type Key = (u32, u64);

    /// Janela de retencao de capturas ainda nao pareadas com um playout.
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

        /// Medianas, em ms, dos dois segmentos: (captura -> liberacao) e
        /// (liberacao -> playout). Serve para localizar onde a latencia esta.
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
                // Esquece os mais antigos: um frame nunca pareado e audio perdido ou
                // uma direcao que encerrou; nao vale a pena Crescer sem limite.
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

    /// Sonda do processo. Um singleton de proposito: o callback de saida do cpal
    /// (thread realtime) e as tasks de audio precisam chegar nela sem depender da
    /// ordem em que os `VoiceMedia` foram criados.
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

    /// Tamanho de buffer EXPLICITO pedido ao cpal: 20 ms a 48 kHz.
    /// `BufferSize::Default` NUNCA e' usado — em ALSA/PipeWire ele pode resolver para
    /// 1024..=u32::MAX frames, o que joga 20 ms (ou muito mais) na latencia e quebra
    /// a hipotese de "uma callback = um frame".
    pub const DEVICE_BUFFER: u32 = FRAME_SAMPLES as u32; // 960

    /// Frame capturado, com o instante em que o PRIMEIRO sample dele foi capturado
    /// (nao em que a callback de device rodou).
    #[derive(Clone)]
    pub struct MicFrame {
        pub pcm: Arc<Vec<i16>>,
        pub captured_at: Instant,
    }

    /// Quadro decodificado pronto para o alto-falante. `id` identifica o frame para a
    /// sonda de latencia: `Some((link, idx))`.
    pub struct PcmFrame {
        pub pcm: Arc<Vec<i16>>,
        pub id: Option<(u32, u64)>,
    }

    // `cpal::Stream` em 0.18 e' um STRUCT por backend; o tipo do stream de um device
    // concreto e' o tipo associado `DeviceTrait::Stream`.
    type HStream = <cpal::Device as cpal::traits::DeviceTrait>::Stream;
    type SpkStream = Box<HStream>;
    type MicStream = Box<HStream>;
    type Inbox = Arc<Mutex<VecDeque<PcmFrame>>>;

    // ---------------------------------------------------------------- resampler

    /// Resampler linear com FASE PERSISTENTE entre callbacks.
    ///
    /// Um resampler por callback perde a fase a cada callback; com taxa nao-inteira
    /// (44.1 kHz, por exemplo) a contagem de amostras por callback varia e o frame de
    /// 960 nunca fecha. A fase vive aqui, junto com o resto da entrada.
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

    // ---------------------------------------------------------------- hub

    /// Partes compartilhadas com os callbacks do cpal (threads de device).
    #[derive(Default)]
    struct HubShared {
        subs: Mutex<Vec<(u64, UnboundedSender<MicFrame>)>>,
        inboxes: Mutex<Vec<(u64, Inbox)>>,
        name: Mutex<String>,
        /// REFERENCIA do AEC: o audio que o alto-falante esta tocando agora.
        ///
        /// Alimentado pelo callback de playout com exatamente os samples escritos
        /// no device. Sem isto nao existe AEC que preste — o filtro adaptativo
        /// precisa saber o que sairia pelo alto-falante para subtrair do mic.
        play_ref: Arc<crate::net::media_dsp::RefRing>,
    }

    struct HubInner {
        shared: Arc<HubShared>,
        mic: Mutex<Option<MicStream>>,
        spk: Mutex<Option<SpkStream>>,
        mic_error: Mutex<Option<String>>,
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

        /// Abre o microfone se ainda nao abriu. Sem microfone a sessao AINDA funciona,
        /// so que so recebendo: e' por isso que o erro e' guardado, nao propagado.
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
                // Ja' ha uma abertura EM CURSO (ou ja' falhou). Antes esta porta
                // devolvia `Ok(())` sempre que `mic_error` ainda era `None` — ou
                // seja, SUCESSO com o mic ainda fechando. O `subscribe`
                // acreditava, o sender nascia, e `packets_out` ficava em 0 para
                // sempre ("Linux nao envia nada", sem erro nenhum).
                // Aqui: espera a abertura terminar (estamos numa task
                // bloqueante do voice-core; abrir o device leva ~1 s).
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
                // Sucesso agora: limpa o erro velho para o painel nao mostrar
                // motivo de uma falha que ja' passou.
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

        // -------------------------------------------------------------- microfone

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
            let mut acc: Vec<i16> = Vec::with_capacity(FRAME_SAMPLES * 4);
            // Ancora de tempo do frame em formacao. Encadeada por +FRAME a cada frame
            // emitido: o primeiro sample de cada frame e' datado pela callback que o
            // entregou, nao pelo instante em que a callback rodou.
            let mut next_frame_wall: Option<Instant> = None;

            let stream = build_input_with_buffer_fallback(&device, cfg, move |data: &[f32]| {
                let mono: Vec<i16> = if downmix {
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
                        // Canal ilimitado: `send` nao bloqueia a thread realtime.
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
            self.open_speaker()
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
            let mut phase: f64 = 0.0; // fase persistente da saida
            let mut mono: Vec<f32> = vec![0.0; FRAME_SAMPLES * 16];
            let mut hw: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 16);

            let ref_ring = self.inner.shared.play_ref.clone();
            let stream =
                build_output_with_buffer_fallback(&device, cfg, move |out: &mut [f32]| {
                    let need = (out.len() / ch).max(1).min(mono.len());
                    // Lote de amostras para o ring: UM lock por callback, nunca por amostra.
                    let mut ref_buf: Vec<i16> = Vec::with_capacity(need);
                    let mut filled = 0usize;

                    {
                        let list = shared.inboxes.lock().unwrap();
                        for (_, ib) in list.iter() {
                            if filled >= need {
                                break;
                            }
                            let mut q = ib.lock().unwrap();
                            while filled < need {
                                let Some(frame) = q.pop_front() else { break };
                                let at = Instant::now();
                                if let Some((link, idx)) = frame.id {
                                    probe().stamp_play(link, idx, at);
                                }
                                let take = (need - filled).min(frame.pcm.len());
                                for &s in frame.pcm.iter().take(take) {
                                    mono[filled] = f32::from(s) / f32::from(i16::MAX);
                                    filled += 1;
                                }
                                if take < frame.pcm.len() {
                                    // Sobrou parte do frame: devolve para a proxima
                                    // callback em vez de perder audio.
                                    let resto: Vec<i16> = frame.pcm[take..].to_vec();
                                    q.push_front(PcmFrame {
                                        pcm: Arc::new(resto),
                                        id: None,
                                    });
                                }
                            }
                        }
                    }

                    // underrun: silencia, nunca bloqueia a thread realtime
                    for v in mono.iter_mut().take(need).skip(filled) {
                        *v = 0.0;
                    }

                    // 48 kHz -> taxa do hardware (fase preservada entre callbacks)
                    if (step - 1.0).abs() < 1e-9 {
                        hw.clear();
                        hw.extend_from_slice(&mono[..need]);
                    } else {
                        hw.clear();
                        while hw.len() < need {
                            let i = phase as usize;
                            if i + 1 >= need {
                                break;
                            }
                            let frac = (phase - i as f64) as f32;
                            let a = mono[i];
                            let b = mono[i + 1];
                            hw.push(a + (b - a) * frac);
                            phase += step;
                        }
                        phase -= hw.len() as f64;
                        hw.resize(need, 0.0);
                    }

                    // REFERENCIA DO AEC: captura o MESMO sinal que vai para o device.
                    //
                    // Push acontece AQUI, depois do downmix e DEPOIS do resample para a
                    // taxa do hardware: e' esse o sinal que a sala ouve e que volta no
                    // microfone. Se fosse capturado antes, o filtro adaptativo aprenderia
                    // o caminho errado e a referencia nao bateria com o eco real.
                    for &v in hw.iter().take(need) {
                        ref_buf.push((v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
                    }
                    // UM lock por callback (nao por amostra): a thread de audio nunca
                    // espera, e o ring e' o unico ponto de compartilhamento com o AEC.
                    if !ref_buf.is_empty() {
                        ref_ring.push(&ref_buf);
                    }

                    // mono -> canais intercalados (o device repete o mesmo sinal)
                    for (i, o) in out.iter_mut().enumerate() {
                        *o = hw[i / ch];
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

    /// StreamConfig com tamanho de buffer EXPLICITO. `BufferSize::Default` nunca entra.
    fn config_with_buffer(cfg: cpal::SupportedStreamConfig, buffer: u32) -> cpal::StreamConfig {
        let mut sc = cfg.config();
        sc.buffer_size = cpal::BufferSize::Fixed(buffer);
        sc
    }

    /// Tenta 960 frames (20 ms @ 48 kHz) e, se o backend recusar, outros tamanhos
    /// EXPLICITOS. `Default` continua fora de questao.
    const FALLBACK_BUFFERS: [u32; 4] = [DEVICE_BUFFER, 480, 240, 1920];

    fn build_input_with_buffer_fallback<F>(
        device: &cpal::Device,
        cfg: cpal::SupportedStreamConfig,
        cb: F,
    ) -> Result<MicStream, String>
    where
        F: FnMut(&[f32]) + Send + 'static,
    {
        // O callback precisa sobreviver a uma tentativa que falhou: um backend que
        // recusa 960 frames ainda pode aceitar 480, e o estado do callback (fase do
        // resampler etc.) nao pode ser perdido entre as tentativas.
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

/// Deixa o caminho "sem microfone" testavel sem desligar o device: lista os
/// `peer_fp` que nao assinam o microfone (separados por virgula).
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
const BITRATE_BPS: i32 = 32_000;
const STUN_DEFAULT: &str = "stun:stun.l.google.com:19302";
/// TURN público padrão (mesmo do caminho do navegador). Sem relay, CGNAT
/// simétrico não fecha — daí a obrigatoriedade.
const TURN_DEFAULT_HOST: &str = "openrelay.metered.ca";
const TURN_DEFAULT_PORT: u16 = 80;
const TURN_DEFAULT_USER: &str = "openrelayproject";
const TURN_DEFAULT_SECRET: &str = "openrelayprojectsecret";
const SDP_WAIT: Duration = Duration::from_millis(1500);
/// fmtp Opus: 20 ms e FEC in-band (RFC 7587 5.1).
const OPUS_FMTP: &str = "minptime=10;useinbandfec=1";
/// Teto de frames PLC seguidos: depois de um buraco longo, mascarar tudo consome
/// CPU sem recuperar audio.
const MAX_PLC_BURST: u32 = 50;

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
    pub plc_frames: u64, // frames mascarados por perda
    pub decode_errors: u64,
    pub rtt_ms: Option<u64>,
    /// Ultimo erro de ABERTURA do microfone (cpal). `Some` com
    /// `packets_out == 0` = este lado nao envia audio — o painel mostra o motivo
    /// em vez de "conectando" mudo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_error: Option<String>,
    /// "off" | "starting" | "live" | "failed". "live" com `frames_out == 0`
    /// NAO e' sinal de saude: e' encoder que subiu sem produzir. O watchdog de
    /// 15s converte isso em "failed" com o motivo.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames_out: Option<u64>,
}

/// Gerenciador de midia de voz. Estado interno por (call_id, peer_fp): varios
/// peers por call (mesh de audio).
pub struct VoiceMedia {
    inner: Arc<Inner>,
}

type Inbox = Arc<Mutex<VecDeque<PcmFrame>>>;
type Key = (String, String);

// ---------------------------------------------------------------- estado

struct Shared {
    packets_in: AtomicU64,
    packets_out: AtomicU64,
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

    /// Caixa de playout deste peer, escrita pela task de decode e lida pelo
    /// callback de saida do cpal.
    inbox: Inbox,
    /// Id da direcao instrumentada (ver `VoiceMedia::attach_probe`).
    in_link: Mutex<Option<u32>>,
    /// Primeiro timestamp RTP visto nesta direcao. O packetizer gera
    /// `ts_n = ts_0 + n * 960`, entao `idx = (ts - ts_0) / 960` identifica o frame
    /// do outro lado SEM alterar o payload (continua Opus puro, e um navegador
    /// continua entendendo o RTP).
    base_ts: Mutex<Option<u32>>,
    /// SDP REMOTO: so' para o `sprop-parameter-sets` do H264. Sem ele o decoder
    /// so' funciona quando o peer manda SPS in-band, e H264 ficava preto mesmo
    /// com o RTP chegando.
    remote_sdp: Mutex<Option<String>>,
    // ---- video nativo ----
    /// Pedido de video pendente/ativo: ("camera"|"screen", monitor).
    video_want: Mutex<Option<(String, Option<u32>)>>,
    /// "off" | "starting" | "live" | "failed".
    video_state: Mutex<String>,
    video_codec: Mutex<Option<String>>,
    video_error: Mutex<Option<String>>,
    video_source: Mutex<Option<String>>,
    frames_in: AtomicU64,
    frames_out: AtomicU64,
    video_seq: AtomicU64,
    /// Ultimo frame remoto decodificado (a UI faz polling).
    video_frame: Mutex<Option<VideoFrame>>,
    /// Tasks de RECEBIMENTO (audio + decode de video). Antes os handles eram
    /// descartados no `on_track` e o pipeline GStreamer de decode sobrevivia ao
    /// hangup — e cada renegociacao abria OUTRO decoder no mesmo `Shared`.
    recv_tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    /// Track local de video (criada na renegociacao; a task de envio escreve nela).
    video_track: Mutex<Option<Arc<TrackLocalStaticSample>>>,
}

impl Shared {
    fn new(inbox: Inbox) -> Self {
        Self {
            packets_in: AtomicU64::new(0),
            packets_out: AtomicU64::new(0),
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
            inbox,
            in_link: Mutex::new(None),
            base_ts: Mutex::new(None),
            remote_sdp: Mutex::new(None),
            video_want: Mutex::new(None),
            video_state: Mutex::new("off".to_string()),
            video_codec: Mutex::new(None),
            video_error: Mutex::new(None),
            video_source: Mutex::new(None),
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
            plc_frames: self.plc_frames.load(Ordering::Relaxed),
            decode_errors: self.decode_errors.load(Ordering::Relaxed),
            rtt_ms: *self.rtt_ms.lock().unwrap(),
            mic_error: self::audio::hub().mic_error(),
            video_state: Some(self.video_state.lock().unwrap().clone()),
            video_codec: self.video_codec.lock().unwrap().clone(),
            video_source: self.video_source.lock().unwrap().clone(),
            video_error: self.video_error.lock().unwrap().clone(),
            frames_in: Some(self.frames_in.load(Ordering::Relaxed)),
            frames_out: Some(self.frames_out.load(Ordering::Relaxed)),
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
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    probe: &'static LatencyProbe,
}

struct Inner {
    core: Arc<Core>,
    sessions: Mutex<HashMap<Key, Arc<Session>>>,
    probe_out: Mutex<Option<u32>>,
    probe_in: Mutex<Option<u32>>,
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

#[async_trait::async_trait]
impl PeerConnectionEventHandler for H {
    async fn on_connection_state_change(&self, s: RTCPeerConnectionState) {
        match s {
            RTCPeerConnectionState::Connected => {
                self.sh.connected_flag.store(true, Ordering::SeqCst);
                self.sh.set_state("connected");
                self.sh.connected.notify_waiters();
            }
            RTCPeerConnectionState::Connecting => self.sh.set_state("connecting"),
            RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed => {
                self.sh.set_state("failed");
                self.sh.connected.notify_waiters();
            }
            RTCPeerConnectionState::New => self.sh.set_state("idle"),
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

/// Thread dedicada que hospeda o runtime tokio e executa os jobs da API sincrona.
///
/// A API publica e' sincrona mas o webrtc-rs e' async. Fazer `block_on` na thread
/// da aplicacao conflitaria com um runtime ja ativo; uma thread dedicada isola
/// isso e mantem `create_offer` usavel de qualquer lugar.
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
                // O handle e' o que permite `block_on` de FORA do contexto do
                // runtime — o loop abaixo nao esta dentro de nenhum.
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
    /// Cria o gerenciador. NAO abre microfone nem alto-falante aqui — a abertura
    /// e preguicosa (ver abaixo). Sem microfone a sessao funciona so' recebendo,
    /// e `retry_mic` existe para o device que so' fica pronto depois.
    pub fn new() -> Result<Arc<Self>, String> {
        let core = Core::new();
        // NAO abre microfone/speaker aqui. `NetworkEngine::new()` chama isto, e
        // abrir device de audio leva segundos (ou trava) quando nao ha servidor
        // de audio — Deixando todo engine nascer lento,  e no pior caso travar a
        // main thread antes de o app aparecer. A abertura e preguicosa: acontece
        // em `subscribe()`/`build_session`, no primeiro `create_offer`, e
        // `retry_mic` cobre o caso de device que so' fica pronto depois.
        // Em troca, o status inicial e' honesto: "iniciando", nao "ativa".
        Ok(Arc::new(VoiceMedia {
            inner: Arc::new(Inner {
                core,
                sessions: Mutex::new(HashMap::new()),
                probe_out: Mutex::new(None),
                probe_in: Mutex::new(None),
            }),
        }))
    }

    pub fn has_capture(&self) -> bool {
        self::audio::hub().has_capture()
    }

    /// Cria offer para (call_id, peer_fp) e devolve o SDP.
    pub fn create_offer(&self, call_id: &str, peer_fp: &str) -> Result<String, String> {
        let (i, c, p) = (self.inner.clone(), call_id.to_owned(), peer_fp.to_owned());
        let key: Key = (c.clone(), p.clone());
        let out: Result<String, String> = self.inner.core.run(async move {
            let sess = match build_session(&i, &c, &p).await {
                Ok(s) => s,
                Err(e) => return Err(e),
            };
            // Insere ANTES dos passos que podem falhar: se o SDP não fechar,
            // `close_key` encontra a sessão e desfaz o que `build_session`
            // abriu (microfone, inbox, sockets).
            i.insert((c.clone(), p.clone()), sess.clone());
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
                self.close_key(key);
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
        let out: Result<String, String> = self.inner.core.run(async move {
            let sess = match build_session(&i, &c, &p).await {
                Ok(s) => s,
                Err(e) => return Err(e),
            };
            // Mesmo de `create_offer`: insere antes dos passos que podem falhar
            // para que `close_key` possa desfazer microfone/inbox/sockets.
            i.insert((c.clone(), p.clone()), sess.clone());
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
                self.close_key(key);
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

    /// Esvazia a fila de trickle ICE. Os SDPs nao entram aqui: `create_offer` e
    /// `handle_offer` ja os devolvem por valor, e duplica-los faria a aplicacao
    /// reenviar o mesmo offer.
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

    /// Fecha UMA sessão e a tira do mapa.
    ///
    /// Usado tanto pelo hangup quanto pela FALHA DE NEGOCIAÇÃO: se
    /// `create_offer`/`handle_offer` morre depois de `build_session` (SDP
    /// inválido do par, por exemplo), a
    /// sessão já assinou o microfone e registrou uma caixa de playout. Sem
    /// isto, o par continuaria no microfone para sempre e
    /// `subscriber_count()` nunca voltaria a zero — vazamento silencioso que só
    /// aparece como "o microfone fica ligado depois de uma chamada falhada".
    fn close_key(&self, k: Key) {
        if let Some(sess) = self.inner.remove(&k) {
            sess.closed.store(true, Ordering::SeqCst);
            for h in sess.tasks.lock().unwrap().drain(..) {
                h.abort();
            }
            // Receiving + decode de video tambem morrem aqui (ver
            // `Shared::recv_tasks`): sem isso o pipeline GStreamer vazava a cada
            // hangup/renegociacao.
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
            // `pc.close()` é async. A sessão já saiu do mapa e as tasks de
            // áudio foram abortadas, então se isto falhar só resta o driver
            // fechando junto com o último Arc.
            let _ = self.inner.core.run(async move {
                sess.pc.close().await.ok();
            });
        }
    }

    /// Estado do primeiro peer da call (so existe um por call no app; `stats_agg`
    /// soma todos).
    pub fn stats(&self, call_id: &str) -> Option<VoiceStats> {
        self.inner
            .of_call(call_id)
            .into_iter()
            .next()
            .map(|s| s.sh.stats())
    }

    /// Estado agregado da call (soma de todos os peers).
    pub fn stats_agg(&self, call_id: &str) -> Option<VoiceStats> {
        let all = self.inner.of_call(call_id);
        let first = all.first()?;
        let mut out = first.sh.stats();
        for s in all.iter().skip(1) {
            let s = s.sh.stats();
            out.packets_in += s.packets_in;
            out.packets_out += s.packets_out;
            out.plc_frames += s.plc_frames;
            out.decode_errors += s.decode_errors;
        }
        Some(out)
    }

    pub fn stats_peer(&self, call_id: &str, peer_fp: &str) -> Option<VoiceStats> {
        self.inner
            .get(&(call_id.to_owned(), peer_fp.to_owned()))
            .map(|s| s.sh.stats())
    }

    /// Liga a sonda de latencia: `out` e' o id da direcao que ESTA ponta envia,
    /// `in` o da que ela recebe. Num loopback in-process as duas pontas usam o
    /// mesmo id em lados opostos. `None` = sem medicao.
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

    /// Re-tenta abrir o microfone.
    ///
    /// Sem isto, uma falha no boot (PipeWire ainda subindo, device ocupado por
    /// outro app) marcava `mic_attempted` para sempre e TODAS as chamadas
    /// seguintes nasciam so-recebendo ate reiniciar o app. Barato quando o mic
    /// ja' esta' aberto (sai no primeiro `if` do `ensure_mic`).
    pub fn retry_mic(&self) {
        // Precisa passar pela fila do voice-core como TODO o resto. Chamar direto
        // abria device de audio na thread que chamou: `call_invite` e um comando
        // Tauri SINCRONO (roda na main thread), e `open_mic` enumera os devices
        // de entrada chamando `supported_input_configs()` em cada um. Sem
        // servidor de audio (JACK, device ocupado,Wayland sem pipewire) isso
        // leva segundos ou bloqueia — e enquanto bloqueia, a UI inteira fica
        // presa em "Chamando...", porque o `invoke` nao resolve.
        let _ = self
            .inner
            .core
            .run(async { self::audio::hub().retry_mic() });
    }

    // ---------------- video nativo ----------------
    //
    // O encoder e o decoder vivem em `media_video` (GStreamer). Aqui so' mora
    // o ESTADO por sessao e o laco que liga o encoder a PeerConnection.

    /// Liga o envio de video ("camera"|"screen", `monitor_id` so' p/ tela).
    /// Idempotente: se ja' esta' no ar, devolve o codec sem subir um segundo
    /// encoder (dois encoders no mesmo stream RTP congelavam o video pelo resto
    /// da chamada — o jitter buffer do receptor via seq intercalado).
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
            // Check-then-act ATOMICO: mesmo Mutex do `video_state`, e
            // "starting" e' gravado ANTES de qualquer `await`.
            let mut st = sess.sh.video_state.lock().unwrap();
            if st.as_str() == "live" || st.as_str() == "starting" {
                let codec = sess
                    .sh
                    .video_codec
                    .lock()
                    .unwrap()
                    .clone()
                    .unwrap_or_else(|| "video/VP8".to_string());
                return Ok(codec);
            }
            *sess.sh.video_want.lock().unwrap() = Some((source.to_string(), monitor_id));
            *st = "starting".to_string();
            *sess.sh.video_error.lock().unwrap() = None;
        }
        // `Session` e' `Arc`: clona para dar a um lado a sessao (a task) e ao
        // outro o handle para abortar. Sem o registro em `sess.tasks`, a task de
        // video sobrevivia ao hangup (so' o `close_key` a encerra).
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

    /// Desliga o envio de video (o recebimento continua; o tile some na UI).
    pub fn video_stop(&self, call_id: &str, peer_fp: &str) {
        if let Some(sess) = self.inner.get(&(call_id.to_owned(), peer_fp.to_owned())) {
            *sess.sh.video_state.lock().unwrap() = "off".to_string();
            *sess.sh.video_want.lock().unwrap() = None;
        }
    }

    /// Ultimo frame remoto decodificado (JPEG + dimensoes + seq). O frontend
    /// faz polling (~10 fps) — sem inundar o IPC com eventos.
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

/// Ultimo frame remoto decodificado (a UI faz polling; nao emitimos evento).
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
    // TURN é OBRIGATÓRIO atrás de CGNAT: o STUN só revela o IP mapeado, e
    // CGNAT simétrico não deixa esse IP ser alcançado de volta. Sem relay, dois
    // peers atrás de CGNAT nunca fecham — a chamada fica em "Conectando…"
    // para sempre.
    //
    // BUG que isto corrige: o TURN vinha SÓ de `VOICE_TURN_URLS`, que ninguém
    // define. O caminho do navegador (`getIceServers` no JS) tinha TURN padrão;
    // a voz nativa não tinha NENHUM. Então no 4G/CGNAT a chamada nativa nunca
    // conectava. Agora usa os mesmos servidores padrão do caminho JS.
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
        // Sem VOICE_BIND: todas as interfaces, que e' o que um app de chat quer.
        _ => vec!["0.0.0.0:0".to_string(), "[::]:0".to_string()],
    }
}

/// SSRC estavel por par. Nao precisa ser aleatorio: so precisa ser unico dentro
/// da PeerConnection, e o par (call, peer) ja e' unico la.
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

    // O jitter buffer entra na cadeia REAL, em Slot::JitterBuffer (13_000,
    // application-ward de tudo). O driver do PeerConnection ja roda
    // poll_timeout()/handle_timeout(), entao o playout por TEMPO nao precisa de
    // tick manual. `depth` e' o atraso que ele adiciona, pacote a pacote.
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

    // Caixa de playout. Falha no alto-falante nao impede a sessao: so nao ha audio
    // saindo no host.
    let inbox_id = hub.register_inbox();
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

    // Faixa de saida. Sem microfone ela e' criada assim mesmo e o loop de envio
    // simplesmente nao recebe frames: a sessao so recebe.
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
        tasks: Mutex::new(Vec::new()),
        probe: probe(),
    });

    {
        let mut tasks = sess.tasks.lock().unwrap();
        tasks.push(spawn_send_loop(sess.clone()));
        tasks.push(spawn_stats_loop(sess.clone()));
    }
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
        // `notified()` e' criado ANTES de checar a flag: um sinal publicado antes
        // do listener existir se perderia.
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
    // DTX DESLIGADO: com DTX ligado o Opus manda um frame a cada ~400 ms no
    // silencio, o que e' 20x a duracao do frame e some com a interatividade.
    enc.set_dtx(false).map_err(err)?;
    let _ = enc.set_inband_fec(true);
    let _ = enc.set_packet_loss_perc(5);
    Ok(enc)
}

fn spawn_send_loop(sess: Arc<Session>) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
        if !wait_connected(&sess.sh, Duration::from_secs(30)).await {
            eprintln!("[voice] envio nao iniciou: nunca conectou");
            return;
        }

        // pt/ssrc so' sao negociados depois do answer.
        let params = match sess.tx.sender.get_parameters().await {
            Ok(p) => p,
            Err(e) => {
                eprintln!("[voice] get_parameters falhou: {e}");
                return;
            }
        };
        let Some(pt) = params.rtp_parameters.codecs.first().map(|c| c.payload_type) else {
            eprintln!("[voice] sender sem codec negociado");
            return;
        };
        let Some(ssrc) = sess.tx.track.ssrcs().await.first().copied() else {
            eprintln!("[voice] track sem ssrc");
            return;
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
            // Sessao so-recebe: sem microfone nao ha o que enviar, e enviar
            // pacote nenhum seria melhor que enviar silencio.
            return;
        }
        // `idx` conta PACOTES ESCRITOS (nao frames gerados): o packetizer so
        // avanca o timestamp RTP quando um sample entra.
        let mut idx: u64 = 0;

        // O mic ficou aberto durante o ICE inteiro, entao o canal tem ~1.5 s de
        // audiovelho. Sem descartar isso o envio despeja o backlog de uma vez:
        // estoura a capacidade do jitter buffer (64 pacotes), perde RTP e a
        // latencia medida vira a idade do backlog, nao a do pipeline.
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

        // O envio e' DISPARADO pelo frame, nao por um relogio de slots. Um relogio
        // de slots comecaria em `Instant::now()`, que nao tem relacao com o
        // instante de captura: sempre que um slot caisse antes do proximo frame
        // do mic, o loop repetiria o frame antigo e ficaria permanentemente
        // alguns frames atras do audio de verdade — um offset que nao sai, porque
        // o clock RTP ja foi ancorado no primeiro pacote.
        let mut pkt = vec![0u8; 4000];
        DBG.with(|d| d.set(dbg_on()));

        // ---------------------------------------------------------------- AEC
        //
        // Só liga se existe ALTO-FALANTE. Em fone de ouvido não há eco acústico
        // para cancelar: o custo seria CPU e o risco de o filtro adaptativo
        // aprender a voz local. `RefRing` compartilhado entre as sessões porque
        // a referência é o MESMO áudio tocando para todos os peers.
        let hub = crate::net::media_voice::audio::hub();
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
            // Mudo nao escreve nada: o clock RTP para de andar e o receptor
            // preenche com PLC. E' o que se quer de um mute (zero banda).
            if sess.muted.load(Ordering::SeqCst) {
                tokio::time::sleep(FRAME).await;
                continue;
            }

            let rx = match mic_rx.as_mut() {
                Some(r) => r,
                None => return,
            };
            // Espera o proximo frame; 20 ms e' a janela normal, e estourar ela
            // significa que o mic nao entregou nada nesse periodo.
            let Ok(Some(frame)) = tokio::time::timeout(FRAME, rx.recv()).await else {
                continue;
            };
            let at = frame.captured_at;
            let pcm = frame.pcm;
            let t_pick = Instant::now();
            if pcm.len() != FRAME_SAMPLES {
                continue;
            }

            // AEC antes de codificar: o eco subtraído nunca vira pacote RTP.
            // `process` devolve `pcm` intacto se não houver referência, então o
            // caminho "sem alto-falante" não muda o áudio nem trava.
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
            let _ = sess
                .tx
                .track
                .sample_writer(ssrc, pt)
                .write_sample(&Sample {
                    data: Bytes::from(pkt.clone()),
                    // DURACAO DE WALL CLOCK: e' dela que o packetizer deriva as
                    // 960 ticks por frame no clock RTP de 48 kHz.
                    duration: FRAME,
                    // timestamp = instante em que o frame foi gerado no mic
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
            sess.sh.packets_out.fetch_add(1, Ordering::Relaxed);

            // Alinha o proximo envio no RELOGIO DE CAPTURA: o frame seguinte
            // nasce em `at + FRAME`. E' o que mantem o ritmo em 50 pacotes/s sem
            // nunca acumular atraso de fila.
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
                    let lost = (ext - e).min(MAX_PLC_BURST);
                    for _ in 0..lost {
                        // PLC de verdade: payload vazio faz o Opus gerar
                        // concealment a partir do estado interno do decoder.
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
                } else if ext < e {
                    // Duplicata ou replay: o jitter buffer ja entregou em ordem,
                    // entao isso aqui e' lixo. Nao pode virar audio fora de ordem.
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
    // Teto de ~4 s de fila: um playout parado nao pode virar latencia infinita.
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
/// Janela do watchdog de envio: encoder "live" que nao cospe pacote nenhum
/// durante isto e' envio morto. Camera escura AINDA gera frames, entao 15 s
/// sem pacote = captura travada de verdade.
const VIDEO_STALL: Duration = Duration::from_secs(15);

/// Cria a track de video, registra o sender e devolve o codec/PT que a
/// PeerConnection REALMENTE escolheu.
///
/// Separate do laco porque o PT so' existe depois do answer: `add_track` roda
/// aqui e so' com a renegociacao feita que o sender diz qual codec e qual PT.
/// Montar o encoder antes seria chute — e chute de PT e' exatamente o que fazia
/// o video "funcionar contra o nosso build e sumir contra o Android".
async fn add_video_transceiver(sess: &Arc<Session>) -> Result<(String, u8), String> {
    let sh = sess.sh.clone();
    let vtl = TrackLocalStaticSample::new(
        Instant::now(),
        MediaStreamTrack::new(
            format!("{}-video", sess.peer_fp),
            "video".to_string(),
            "video0".to_string(),
            RtpCodecKind::Video,
            vec![RTCRtpEncodingParameters {
                rtp_coding_parameters: RTCRtpCodingParameters {
                    ssrc: Some(ssrc_for(&sess.call_id, &sess.peer_fp)),
                    ..Default::default()
                },
                // VP8 primeiro: e' o codec que TODOS os navegadores aceitam e o
                // unico que o pipeline do GStreamer garante aqui. O PT real e'
                // reescrito pela renegociacao; este e' so' a proposta.
                codec: RTCRtpCodec {
                    mime_type: "video/VP8".to_owned(),
                    clock_rate: 90_000,
                    channels: 0,
                    sdp_fmtp_line: String::new(),
                    rtcp_feedback: vec![],
                },
                ..Default::default()
            }],
        ),
    )
    .map_err(|e| format!("track de video recusada: {e}"))?;
    let vtl: Arc<TrackLocalStaticSample> = Arc::new(vtl);
    let sender = sess
        .pc
        .add_track(Arc::clone(&vtl) as Arc<dyn TrackLocal>)
        .await
        .map_err(|e| format!("peer recusou a track de video: {e}"))?;

    let params = sender
        .get_parameters()
        .await
        .map_err(|e| format!("vídeo: sender sem parâmetros: {e}"))?;
    let c = params
        .rtp_parameters
        .codecs
        .iter()
        .find(|c| c.rtp_codec.mime_type.starts_with("video"))
        .ok_or_else(|| {
            format!(
                "vídeo não foi negociado no SDP (o sender ficou só com: {})",
                params
                    .rtp_parameters
                    .codecs
                    .iter()
                    .map(|c| c.rtp_codec.mime_type.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        })?;
    let mime = c.rtp_codec.mime_type.clone();
    let pt = c.payload_type;
    *sh.video_track.lock().unwrap() = Some(vtl);
    Ok((mime, pt))
}

/// Envia video pela MESMA PeerConnection da voz.
///
/// Espera conectar -> cria track e descobre codec/PT -> monta encoder ->
/// laco que puxa pacotes RTP e escreve na track, com watchdog de 15 s.
async fn video_send_task(sess: Arc<Session>, want_source: String) {
    let sh = sess.sh.clone();
    let Some((_, want_monitor)) = sh.video_want.lock().unwrap().clone() else {
        *sh.video_state.lock().unwrap() = "off".to_string();
        return;
    };
    let is_screen = want_source == "screen";
    if !wait_connected(&sh, Duration::from_secs(30)).await {
        video_fail(&sh, "vídeo não iniciou: a chamada não conectou".into());
        return;
    }
    // Re-avalia: o usuario pode ter desligado a camera enquanto o ICE subia.
    if sh.video_state.lock().unwrap().as_str() != "starting" {
        return;
    }

    let (mime, pt) = match add_video_transceiver(&sess).await {
        Ok(v) => v,
        Err(e) => {
            video_fail(&sh, e);
            return;
        }
    };
    let codec = crate::net::media_video::VideoCodec::from_mime(&mime);
    let want = codec.mime();
    *sh.video_codec.lock().unwrap() = Some(want.to_string());
    *sh.video_source.lock().unwrap() = Some(want_source.clone());
    sh.frames_out.store(0, Ordering::Relaxed);
    tracing::debug!("[video] enviando ({want}, {want_source}) pt={pt}");

    let Some(vtl) = sh.video_track.lock().unwrap().clone() else {
        video_fail(&sh, "vídeo: track local não foi criada".into());
        return;
    };

    // Encoder: construcao bloqueante (v4l2src/xscreen abrem device), fora do
    // laco quente e fora do worker de audio.
    let built = tokio::task::spawn_blocking(move || {
        if is_screen {
            crate::net::media_video::new_screen(codec, pt, VIDEO_FPS)
        } else {
            crate::net::media_video::new_camera(codec, pt, VIDEO_FPS)
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

    *sh.video_state.lock().unwrap() = "live".to_string();
    let mut last_progress = Instant::now();
    let mut grab_miss: u32 = 0;

    loop {
        if sess.closed.load(Ordering::SeqCst) {
            break;
        }
        if sh.video_state.lock().unwrap().as_str() != "live" {
            break;
        }
        // `take()`: o encoder e' MOVIDO para dentro da `spawn_blocking` (ele
        // precisa estar la para o poll_rtp). O `Option` existe para o `break`
        // do meio do laco nao deixar um valor ja movido.
        let Some(mut enc2) = enc.take() else { break };
        // Iteracao bloqueante: tick de tela + pacotes RTP prontos. A cadencia
        // do loop (~poll 60 ms + captura) dita ~10 fps de tela sozinha.
        let pumped = tokio::task::spawn_blocking(
            move || -> (Vec<Vec<u8>>, Option<String>, bool, crate::net::media_video::VideoEncoder) {
            let mut grab_ok = !is_screen;
            if is_screen {
                match crate::net::media_video::grab_screen_frame(want_monitor) {
                    Some((rgb, w, h)) => {
                        let _ = enc2.push_screen_frame(&rgb, w, h);
                        grab_ok = true;
                    }
                    None => grab_ok = false,
                }
            }
            let mut pkts = Vec::new();
            // Primeiro com espera curta (cadencia), resto sem esperar.
            if let Some(p) = enc2.poll_rtp(Duration::from_millis(60)) {
                pkts.push(p);
                while pkts.len() < 64 {
                    match enc2.poll_rtp(Duration::ZERO) {
                        Some(p) => pkts.push(p),
                        None => break,
                    }
                }
            }
            let err = enc2.take_error();
            (pkts, err, grab_ok, enc2)
            },
        )
        .await;
        let (pkts, enc_err, grab_ok, encoder) = match pumped {
            Ok(v) => v,
            Err(_) => break,
        };
        // Devolve o encoder ao laco ANTES de qualquer `break`: ele foi movido
        // para dentro da `spawn_blocking`, e sem este passo o `enc.stop()` do
        // fim nao acha o encoder e o device de video fica aberto.
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
        // `write_sample` pede ssrc + payload type: sao os do transceiver que
        // acabamos de negociar, e NAO um chute.
        let Some(ssrc) = vtl.ssrcs().await.first().copied() else {
            video_fail(&sh, "vídeo: a track local ficou sem ssrc".into());
            break;
        };
        let now_ts = rtp_ts_video();
        let sent = pkts.len();
        for p in pkts {
            let sample = Sample {
                data: Bytes::from(p),
                // `Sample::duration` = duracao REAL de wall clock; e' dela que
                // o packetizer deriva o timestamp RTP de video (90 kHz).
                duration: VIDEO_FRAME_INTERVAL,
                timestamp: Instant::now(),
                packet_timestamp: now_ts,
                prev_dropped_packets: 0,
                prev_padding_packets: 0,
            };
            if vtl.write_sample(ssrc, pt, &sample, &[]).await.is_err() {
                break;
            }
            sh.frames_out.fetch_add(1, Ordering::Relaxed);
        }
        if sent > 0 {
            last_progress = Instant::now();
        } else if last_progress.elapsed() > VIDEO_STALL {
            // 15 s sem nenhum pacote: captura morta. Mensagem por fonte para o
            // painel dizer o motivo em vez de "live" com frames_out zerado.
            // (Wayland sem portal: o grab falha sempre; camera desplugada no
            // meio da chamada: o encoder seca do mesmo jeito.)
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
        tokio::time::sleep(VIDEO_FRAME_INTERVAL).await;
    }

    // FECHA o device: sem `set_state(Null)` a proxima `new_camera` falha com
    // "device busy" e a camera nao abre mais ate reiniciar o app.
    if let Some(mut e) = enc {
        e.stop();
    }
    let _ = vtl.stop();
    if sh.video_state.lock().unwrap().as_str() == "live" {
        *sh.video_state.lock().unwrap() = "off".to_string();
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
                let codec = crate::net::media_video::VideoCodec::from_mime(&mime);
                // PT NEGOCIADO + sprop do SDP remoto: sem os dois, o
                // `rtp*depay` rejeita tudo (PT != 96) ou o H264 fica preto ate'
                // chegar SPS in-band. Era o "video so funciona quando o outro
                // lado e' o nosso proprio build".
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
                    _ => {
                        *sh.video_error.lock().unwrap() =
                            Some(format!("decode {mime} indisponivel"));
                        break;
                    }
                }
            }
            if let Some(d) = dec.as_mut() {
                use rtc::shared::marshal::Marshal;
                if let Ok(bytes) = pkt.marshal() {
                    d.push_rtp(&bytes);
                }
                // Drena frames sem bloquear: fica so o mais recente. O JPEG de
                // CADA frame decoded sai por um `spawn_blocking` DEDICADO —
                // encode de 640x480 custa ~2-4 ms de CPU e, rodando aqui,
                // competia com a pilha de audio/RTP (o audio engasgava
                // exatamente quando o video ligava).
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

            // Melhor par: oparingionado, ou o que mais transportou media.
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
                    // O par referencia o candidato pelo id cru
                    // ("candidate:foundation/ufrag"), enquanto a entrada do
                    // report traz o mesmo id prefixado com o tipo do objeto.
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
