// audio de media_voice.rs (extraido para o arquivo nao passar de 1.000 linhas).

use super::*;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};

use super::probe::probe;

pub const SAMPLE_RATE: u32 = 48_000;
pub const FRAME_MS: u32 = 20;
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize / 1000) * FRAME_MS as usize;
pub const FRAME: Duration = Duration::from_millis(FRAME_MS as u64);

pub const DEVICE_BUFFER: u32 = FRAME_SAMPLES as u32;

#[derive(Clone)]
pub struct MicFrame {
    pub pcm: Arc<Vec<i16>>,
    pub captured_at: Instant,
}

pub struct PcmFrame {
    pub pcm: Arc<Vec<i16>>,
    pub id: Option<(u32, u64)>,
}

type HStream = <cpal::Device as cpal::traits::DeviceTrait>::Stream;
type SpkStream = Box<HStream>;
type MicStream = Box<HStream>;
type Inbox = Arc<Mutex<VecDeque<PcmFrame>>>;

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

pub(super) struct MicGain {
    pub(super) gain: f32,
}

impl MicGain {
    pub(super) fn new() -> Self {
        Self { gain: 1.0 }
    }

    pub(super) const TARGET: f32 = 0.5;
    pub(super) const MAX_GAIN: f32 = 12.0;
    pub(super) const NOISE_FLOOR: f32 = 0.004;

    pub(super) fn process(&mut self, mono: &mut [i16]) {
        let peak = mono.iter().fold(0i16, |m, s| m.max(s.abs())) as f32 / i16::MAX as f32;
        if peak < Self::NOISE_FLOOR {
            self.gain += (1.0 - self.gain) * 0.05;
            if self.gain <= 1.001 {
                self.gain = 1.0;
            }
            return;
        }
        let want = (Self::TARGET / peak).min(Self::MAX_GAIN);
        let coef = if want > self.gain { 0.35 } else { 0.03 };
        self.gain += (want - self.gain) * coef;
        if self.gain <= 1.001 {
            self.gain = 1.0;
            return;
        }
        for s in mono.iter_mut() {
            let v = *s as f32 * self.gain / i16::MAX as f32;
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

#[derive(Default)]
struct HubShared {
    subs: Mutex<Vec<(u64, UnboundedSender<MicFrame>)>>,
    inboxes: Mutex<Vec<(u64, Inbox)>>,
    name: Mutex<String>,
    deafened: std::sync::Mutex<std::collections::HashSet<u64>>,
    play_ref: Arc<crate::net::media_dsp::RefRing>,
}

struct HubInner {
    shared: Arc<HubShared>,
    mic: Mutex<Option<MicStream>>,
    spk: Mutex<Option<SpkStream>>,
    mic_error: Mutex<Option<String>>,
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

    pub fn speaker_error(&self) -> Option<String> {
        self.inner.spk_error.lock().unwrap().clone()
    }

    pub fn ensure_mic(&self) -> Result<(), String> {
        if self.inner.has_capture.load(Ordering::SeqCst) {
            return Ok(());
        }
        if std::env::var("VOICE_NO_CAPTURE").as_deref() == Ok("1") {
            let e = "VOICE_NO_CAPTURE=1: microfone desabilitado de proposito".to_string();
            *self.inner.mic_error.lock().unwrap() = Some(e.clone());
            self.inner.mic_attempted.store(true, Ordering::SeqCst);
            return Err(e);
        }
        if self.inner.mic_attempted.swap(true, Ordering::SeqCst) {
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

    pub fn retry_mic(&self) {
        if self.inner.has_capture.load(Ordering::SeqCst) {
            return;
        }
        self.inner.mic_attempted.store(false, Ordering::SeqCst);
        if self.ensure_mic().is_ok() {
            *self.inner.mic_error.lock().unwrap() = None;
        }
    }

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

    pub fn subscriber_count(&self) -> usize {
        self.inner.shared.subs.lock().unwrap().len()
    }

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

    pub fn set_inbox_muted(&self, id: u64, muted: bool) {
        let mut set = self.inner.shared.deafened.lock().unwrap();
        if muted {
            set.insert(id);
        } else {
            set.remove(&id);
        }
    }

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

    pub fn ensure_speaker(&self) -> Result<(), String> {
        if self.inner.spk.lock().unwrap().is_some() {
            return Ok(());
        }
        let r = self.open_speaker();
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
        let (device, name) = chosen.ok_or_else(|| "nenhum alto-falante utilizavel".to_string())?;

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
        let mut buf: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 16);
        let mut phase: f64 = 0.0;
        let mut hw: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES * 16);

        let ref_ring = self.inner.shared.play_ref.clone();
        let stream = build_output_with_buffer_fallback(&device, cfg, move |out: &mut [f32]| {
            let need = (out.len() / ch).max(1);
            let target = if same_rate {
                need
            } else {
                (phase + (need as f64) * step).floor() as usize + 2
            };

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

            for (i, o) in out.iter_mut().enumerate() {
                *o = hw[i / ch].clamp(-1.0, 1.0);
            }
        })?;

        stream.play().map_err(|e| format!("output play(): {e}"))?;
        *self.inner.spk.lock().unwrap() = Some(stream);
        Ok(())
    }
}

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

fn config_with_buffer(cfg: cpal::SupportedStreamConfig, buffer: u32) -> cpal::StreamConfig {
    let mut sc = cfg.config();
    sc.buffer_size = cpal::BufferSize::Fixed(buffer);
    sc
}

const FALLBACK_BUFFERS: [u32; 4] = [DEVICE_BUFFER, 480, 240, 1920];

fn build_input_with_buffer_fallback<F>(
    device: &cpal::Device,
    cfg: cpal::SupportedStreamConfig,
    cb: F,
) -> Result<MicStream, String>
where
    F: FnMut(&[f32]) + Send + 'static,
{
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
