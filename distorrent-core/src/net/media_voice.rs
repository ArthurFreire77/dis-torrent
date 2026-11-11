use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

#[path = "media_voice_audio.rs"]
pub mod audio;

#[path = "media_voice_probe.rs"]
mod probe;

#[path = "media_voice_stats_tests.rs"]
mod stats_aggregation_tests;

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

const JITTER_DEPTH: Duration = Duration::from_millis(50);
const JITTER_CAPACITY: usize = 64;
const BITRATE_BPS: i32 = 48_000;
const STUN_DEFAULT: &str = "stun:stun.l.google.com:19302";
const SDP_WAIT: Duration = Duration::from_millis(1500);
const OPUS_FMTP: &str = "minptime=10;useinbandfec=1";
#[allow(dead_code)]
const MAX_PLC_BURST: u32 = 50;
/// Máximo de peers com vídeo simultâneo por chamada (evita device busy).
const MAX_VIDEO_PEERS: usize = 4;

const PLC_RESYNC_GAP: u32 = 10;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OutboundSignal {
    Offer { sdp: String },
    Answer { sdp: String },
    Ice { candidate: String, mid: String },
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct VoiceStats {
    pub state: String,
    pub route: String,
    pub jitter_depth_ms: u32,
    pub packets_in: u64,
    pub packets_out: u64,
    #[serde(default)]
    pub write_errors: u64,
    pub plc_frames: u64,
    pub decode_errors: u64,
    pub rtt_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mic_error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker_error: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peers_connected: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub peers_total: Option<u32>,
}

pub struct VoiceMedia {
    inner: Arc<Inner>,
}

type Inbox = Arc<Mutex<VecDeque<PcmFrame>>>;
type Key = (String, String);

struct Shared {
    packets_in: AtomicU64,
    packets_out: AtomicU64,
    write_errors: AtomicU64,
    plc_frames: AtomicU64,
    decode_errors: AtomicU64,
    jitter_depth_ms: AtomicU32,

    connected_flag: AtomicBool,
    mid: Mutex<String>,
    state: Mutex<String>,
    route: Mutex<String>,
    rtt_ms: Mutex<Option<u64>>,

    out: Mutex<VecDeque<OutboundSignal>>,
    connected: Arc<tokio::sync::Notify>,
    pc: Mutex<Option<std::sync::Arc<dyn PeerConnection>>>,
    ice_restarts: AtomicU32,

    inbox: Inbox,
    in_link: Mutex<Option<u32>>,
    base_ts: Mutex<Option<u32>>,
    remote_sdp: Mutex<Option<String>>,
    video_want: Mutex<Option<(String, Option<u32>)>>,
    video_state: Mutex<String>,
    video_codec: Mutex<Option<String>>,
    video_error: Mutex<Option<String>>,
    video_source: Mutex<Option<String>>,
    video_packets_in: AtomicU64,
    frames_in: AtomicU64,
    frames_out: AtomicU64,
    video_seq: AtomicU64,
    video_frame: Mutex<Option<VideoFrame>>,
    recv_tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    video_track: Mutex<Option<Arc<TrackLocalStaticSample>>>,
    /// Geração de vídeo: cada troca de fonte incrementa. Tasks antigas verificam
    /// se sua geração ainda é atual antes de enviar frames.
    video_generation: AtomicU64,
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
            video_generation: AtomicU64::new(0),
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
    mic_id: u64,
    mic_sub: Mutex<Option<UnboundedReceiver<MicFrame>>>,
    out_link: Mutex<Option<u32>>,
    muted: AtomicBool,
    closed: AtomicBool,
    tx: TxState,
    vtx: TxState,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
    probe: &'static LatencyProbe,
}

struct Inner {
    core: Arc<Core>,
    sessions: Mutex<HashMap<Key, Arc<Session>>>,
    probe_out: Mutex<Option<u32>>,
    probe_in: Mutex<Option<u32>>,
    mic_tests: Mutex<HashMap<u64, UnboundedReceiver<MicFrame>>>,
}

impl Session {
    fn key(&self) -> Key {
        (self.call_id.clone(), self.peer_fp.clone())
    }
}

struct H {
    sh: Arc<Shared>,
}

impl H {
    fn schedule_ice_restart(&self) {
        let sh = self.sh.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            {
                let atual = sh.state.lock().unwrap().clone();
                if atual != "failed" && atual != "reconnecting" {
                    return;
                }
            }
            if sh.remote_sdp.lock().unwrap().is_none() {
                return;
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
                self.sh.connected_flag.store(false, Ordering::SeqCst);
            }
            RTCPeerConnectionState::New => self.sh.set_state("idle"),
            _ => {}
        }
    }

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

impl VoiceMedia {
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

    pub fn mic_name(&self) -> String {
        let hub = self::audio::hub();
        let _ = hub.ensure_mic();
        hub.mic_name()
    }

    pub fn has_capture(&self) -> bool {
        self::audio::hub().has_capture()
    }

    pub fn create_offer(&self, call_id: &str, peer_fp: &str) -> Result<String, String> {
        let (i, c, p) = (self.inner.clone(), call_id.to_owned(), peer_fp.to_owned());
        let key: Key = (c.clone(), p.clone());
        let fresh = Arc::new(AtomicBool::new(false));
        let fresh_flag = fresh.clone();
        let out: Result<String, String> = self.inner.core.run(async move {
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
                if fresh.load(Ordering::SeqCst) {
                    self.close_key(key);
                }
                Err(e)
            }
        }
    }

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

    pub fn set_deafened(&self, call_id: &str, deafened: bool) {
        for s in self.inner.of_call(call_id) {
            self::audio::hub().set_inbox_muted(s.inbox_id, deafened);
        }
    }

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

    pub fn hangup_peer(&self, call_id: &str, peer_fp: &str) {
        self.close_key((call_id.to_owned(), peer_fp.to_owned()));
    }

    fn close_key(&self, k: Key) {
        if let Some(sess) = self.inner.remove(&k) {
            sess.closed.store(true, Ordering::SeqCst);
            for h in sess.tasks.lock().unwrap().drain(..) {
                h.abort();
            }
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
            let _ = self.inner.core.run(async move {
                sess.pc.close().await.ok();
            });
        }
    }

    pub fn stats(&self, call_id: &str) -> Option<VoiceStats> {
        self.inner
            .of_call(call_id)
            .into_iter()
            .next()
            .map(|s| s.sh.stats())
    }

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

    pub fn attach_probe(&self, out: Option<u32>, inbound: Option<u32>) {
        *self.inner.probe_out.lock().unwrap() = out;
        *self.inner.probe_in.lock().unwrap() = inbound;
        for s in self.inner.all() {
            *s.out_link.lock().unwrap() = out;
            *s.sh.in_link.lock().unwrap() = inbound;
        }
    }

    pub fn jitter_depth_ms() -> u32 {
        JITTER_DEPTH.as_millis() as u32
    }

    pub fn retry_mic(&self) {
        let _ = self
            .inner
            .core
            .run(async { self::audio::hub().retry_mic() });
    }

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
        // Limita peers com vídeo ativo para evitar device busy.
        let ativos = self
            .inner
            .of_call(call_id)
            .iter()
            .filter(|s| {
                matches!(
                    s.sh.video_state.lock().unwrap().as_str(),
                    "starting" | "live"
                )
            })
            .count();
        if ativos >= MAX_VIDEO_PEERS {
            return Err(format!(
                "limite de {MAX_VIDEO_PEERS} peers com vídeo atingido — pare o vídeo de outro participante antes"
            ));
        }
        {
            let mut st = sess.sh.video_state.lock().unwrap();
            if st.as_str() == "live" || st.as_str() == "starting" {
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
                drop(st);
                let gen = self.video_purge_source(&sess);
                let mut st = sess.sh.video_state.lock().unwrap();
                *sess.sh.video_want.lock().unwrap() = Some((source.to_string(), monitor_id));
                *st = "starting".to_string();
                *sess.sh.video_error.lock().unwrap() = None;
                drop(st);
                let for_task = sess.clone();
                let for_abort = sess.clone();
                let want = source.to_string();
                self.inner.core.run(async move {
                    let h = tokio::spawn(async move { video_send_task(for_task, want, gen).await });
                    for_abort.tasks.lock().unwrap().push(h.abort_handle());
                    Ok::<(), String>(())
                })??;
                return Ok("starting".to_string());
            }
            *sess.sh.video_want.lock().unwrap() = Some((source.to_string(), monitor_id));
            *st = "starting".to_string();
            *sess.sh.video_error.lock().unwrap() = None;
        }
        let gen = sess.sh.video_generation.load(Ordering::SeqCst);
        let for_task = sess.clone();
        let for_abort = sess.clone();
        let want = source.to_string();
        self.inner.core.run(async move {
            let h = tokio::spawn(async move { video_send_task(for_task, want, gen).await });
            for_abort.tasks.lock().unwrap().push(h.abort_handle());
            Ok::<(), String>(())
        })??;
        Ok("starting".to_string())
    }

    /// Incrementa a geração de vídeo, invalidando tasks de envio antigas.
    /// Retorna o novo token de geração.
    fn video_purge_source(&self, sess: &Session) -> u64 {
        let gen = sess.sh.video_generation.fetch_add(1, Ordering::SeqCst) + 1;
        // Aborta tasks de vídeo anteriores para esta sessão
        for h in sess.tasks.lock().unwrap().drain(..) {
            h.abort();
        }
        gen
    }

    pub fn video_stop(&self, call_id: &str, peer_fp: &str) {
        if let Some(sess) = self.inner.get(&(call_id.to_owned(), peer_fp.to_owned())) {
            *sess.sh.video_state.lock().unwrap() = "off".to_string();
            *sess.sh.video_want.lock().unwrap() = None;
        }
    }

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

    out.peers_total = Some(all.len() as u32);
    out.peers_connected = Some(all.iter().filter(|peer| peer.state == "connected").count() as u32);

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

fn ice_servers() -> Vec<RTCIceServer> {
    let mut v: Vec<RTCIceServer> = Vec::new();
    let stun = std::env::var("VOICE_STUN_URLS").unwrap_or_else(|_| STUN_DEFAULT.to_string());
    for url in stun.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        v.push(RTCIceServer {
            urls: vec![url.to_string()],
            ..Default::default()
        });
    }
    let turn_urls = std::env::var("VOICE_TURN_URLS").unwrap_or_default();
    let turn_user = std::env::var("VOICE_TURN_USER").unwrap_or_default();
    let turn_pass = std::env::var("VOICE_TURN_PASS").unwrap_or_default();
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
        _ => MulticastDnsMode::QueryOnly,
    }
}

fn udp_addrs() -> Vec<String> {
    match std::env::var("VOICE_BIND") {
        Ok(v) if !v.trim().is_empty() => v.split(',').map(|s| s.trim().to_string()).collect(),
        _ => vec!["0.0.0.0:0".to_string(), "[::]:0".to_string()],
    }
}

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
        .with_ice_transport_policy(RTCIceTransportPolicy::All)
        .build();

    let inbox_id = hub.register_inbox();
    struct LimpezaNoErro {
        inbox_id: Option<u64>,
        mic_id: u64,
    }
    impl Drop for LimpezaNoErro {
        fn drop(&mut self) {
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

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e}")
}

fn new_encoder() -> Result<opus::Encoder, String> {
    let mut enc = opus::Encoder::new(SAMPLE_RATE, opus::Channels::Mono, opus::Application::Voip)
        .map_err(err)?;
    enc.set_bitrate(opus::Bitrate::Bits(BITRATE_BPS))
        .map_err(err)?;
    enc.set_dtx(false).map_err(err)?;
    let _ = enc.set_inband_fec(true);
    let _ = enc.set_packet_loss_perc(5);
    Ok(enc)
}

fn spawn_send_loop(sess: Arc<Session>) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
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
                eprintln!("[voice] envio aguardando ICE conectar (>30s; TURN/CGNAT demoram)");
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }

        let mut attempt: u32 = 0;
        let (pt, ssrc) = loop {
            if sess.closed.load(Ordering::SeqCst) {
                return;
            }
            let pt = match sess.tx.sender.get_parameters().await {
                Ok(p) => p
                    .rtp_parameters
                    .codecs
                    .iter()
                    .find(|c| c.rtp_codec.mime_type.eq_ignore_ascii_case("audio/opus"))
                    .or_else(|| p.rtp_parameters.codecs.first())
                    .map(|c| c.payload_type),
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
                eprintln!(
                    "[voice] {}/{}: segue só recebendo (sem microfone)",
                    sess.call_id, sess.peer_fp
                );
                return;
            }
        }
        let mut idx: u64 = 0;

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

        let mut pkt = vec![0u8; 4000];
        DBG.with(|d| d.set(dbg_on()));

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
            let Ok(Some(frame)) = tokio::time::timeout(FRAME + FRAME / 2, rx.recv()).await else {
                continue;
            };
            let at = frame.captured_at;
            let pcm = frame.pcm;
            let t_pick = Instant::now();
            if pcm.len() != FRAME_SAMPLES {
                continue;
            }

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
                    duration: FRAME,
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
            match write_res {
                Ok(()) => {
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

            let wait = (at + FRAME).saturating_duration_since(Instant::now());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
    })
    .abort_handle()
}

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
                    let gap = ext - e;
                    if gap > PLC_RESYNC_GAP {
                        sh.plc_frames.fetch_add(u64::from(gap), Ordering::Relaxed);
                    } else {
                        for _ in 0..gap {
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
    while q.len() > 200 {
        q.pop_front();
    }
    q.push_back(PcmFrame {
        pcm: Arc::new(pcm[..n].to_vec()),
        id,
    });
}

fn video_fail(sh: &Arc<Shared>, msg: String) {
    tracing::warn!("[video] {msg}");
    *sh.video_state.lock().unwrap() = "failed".to_string();
    *sh.video_error.lock().unwrap() = Some(msg);
}

const VIDEO_FPS: u32 = 30;
const VIDEO_FRAME_INTERVAL: Duration = Duration::from_millis(33);
const VIDEO_STALL: Duration = Duration::from_secs(15);

async fn video_send_task(sess: Arc<Session>, want_source: String, generation: u64) {
    let sh = sess.sh.clone();
    let want = sh.video_want.lock().unwrap().clone();
    let Some((_, want_monitor)) = want else {
        *sh.video_state.lock().unwrap() = "off".to_string();
        return;
    };
    let is_screen = want_source == "screen";
    let mut vticks: u32 = 0;
    loop {
        if sess.closed.load(Ordering::SeqCst)
            || sh.video_state.lock().unwrap().as_str() != "starting"
            || sh.video_generation.load(Ordering::SeqCst) != generation
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
    if sh.video_state.lock().unwrap().as_str() != "starting" {
        return;
    }

    let params = match sess.vtx.sender.get_parameters().await {
        Ok(p) => p,
        Err(e) => {
            video_fail(&sh, format!("vídeo: sender sem parâmetros: {e}"));
            return;
        }
    };
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
        if sh.video_generation.load(Ordering::SeqCst) != generation {
            break;
        }
        let t_iter = Instant::now();
        let Some(mut enc2) = enc.take() else { break };
        let pumped = tokio::task::spawn_blocking(
            move || -> (Option<Vec<u8>>, Option<String>, bool, crate::net::media_video::VideoEncoder) {
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
        let gasto = t_iter.elapsed();
        if gasto < VIDEO_FRAME_INTERVAL {
            tokio::time::sleep(VIDEO_FRAME_INTERVAL - gasto).await;
        } else {
            tokio::task::yield_now().await;
        }
    }

    if let Some(mut e) = enc {
        e.stop();
    }

    let mut state = sh.video_state.lock().unwrap();
    if matches!(state.as_str(), "starting" | "live") {
        *state = "off".to_string();
    }
    tracing::debug!("[video] envio encerrado");
}

fn rtp_ts_video() -> u32 {
    static ANCHOR: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let a = ANCHOR.get_or_init(std::time::Instant::now);
    (a.elapsed().as_micros() as u64 / 11_111) as u32
}

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

    fn peak(samples: &[i16]) -> i32 {
        samples.iter().map(|s| (*s as i32).abs()).max().unwrap_or(0)
    }

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
        let mut agc = MicGain::new();
        let bloco = vec![4000i16; 960];
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
        let bloco: Vec<i16> = (0..960)
            .map(|i| if i % 2 == 0 { i16::MAX } else { 30000 })
            .collect();
        let saida = rodar(&mut agc, 60, &bloco);
        assert!(saida <= i16::MAX as i32, "estouro digital");
        assert_eq!(agc.gain, 1.0);
    }

    #[test]
    fn limitador_nao_estoura_com_pico_minimo() {
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
        for v in [
            vec![peer("connected"), peer("connecting")],
            vec![peer("connecting"), peer("connected")],
        ] {
            let s = aggregate_stats(v).expect("agregado");
            assert_eq!(s.state, "connecting");
        }
    }
}
