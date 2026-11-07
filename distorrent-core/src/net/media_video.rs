use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::AppSink;
use gstreamer_app::AppSrc;

const CAPTURE_W: u32 = 1280;
const CAPTURE_H: u32 = 720;
const FALLBACK_W: u32 = 640;
const FALLBACK_H: u32 = 480;
const CAMERA_KBPS: u32 = 2500;
const SCREEN_KBPS: u32 = 3500;
const ENCODER_QUEUE: u32 = 2;
const RTP_QUEUE: u32 = 512;
const SINK_QUEUE: u32 = 2;

pub fn rtp_caps(mime: &str, pt: u8, sprop: Option<&str>) -> String {
    let base = if mime.to_ascii_lowercase().contains("h264") {
        "application/x-rtp,media=video,clock-rate=90000,encoding-name=H264,payload={PT}"
    } else {
        "application/x-rtp,media=video,clock-rate=90000,encoding-name=VP8,payload={PT}"
    };
    let mut c = base.replace("{PT}", &pt.to_string());
    if let Some(s) = sprop {
        let t = s.trim();
        if !t.is_empty() {
            c.push_str(&format!(",sprop-parameter-sets=\"{t}\""));
        }
    }
    c
}

pub fn extract_h264_sprop(sdp: &str) -> Option<String> {
    for line in sdp.lines() {
        if line.contains("a=fmtp:") && line.to_ascii_lowercase().contains("h264") {
            let (_name, b) = line.split_once("sprop-parameter-sets=")?;
            let rest = b.trim();
            let end = rest.find(';').unwrap_or(rest.len());
            let val = rest[..end].trim();
            if !val.is_empty() {
                return Some(val.to_string());
            }
        }
    }
    None
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VideoCodec {
    Vp8,
    H264,
}

impl VideoCodec {
    pub fn from_mime(m: &str) -> Self {
        if m.to_ascii_lowercase().contains("h264") {
            VideoCodec::H264
        } else {
            VideoCodec::Vp8
        }
    }
    pub fn supported_from_mime(m: &str) -> Option<Self> {
        let l = m.to_ascii_lowercase();
        if l.contains("vp8") {
            Some(VideoCodec::Vp8)
        } else if l.contains("h264") {
            Some(VideoCodec::H264)
        } else {
            None
        }
    }
    pub fn mime(&self) -> &'static str {
        match self {
            VideoCodec::Vp8 => "video/VP8",
            VideoCodec::H264 => "video/H264",
        }
    }
}

fn gst_init() -> Result<(), String> {
    static ONCE: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| gstreamer::init().map_err(|e| format!("GStreamer não inicializou: {e}")))
        .clone()
}

fn has_element(name: &str) -> bool {
    if gst_init().is_err() {
        return false;
    }
    gstreamer::ElementFactory::find(name).is_some()
}

pub struct VideoEncoder {
    pipeline: gstreamer::Pipeline,
    sink: AppSink,
    appsrc: Option<AppSrc>,
    self_feeding: bool,
}

pub fn camera_devices() -> Vec<String> {
    let mut names: Vec<(u32, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/dev") {
        for e in entries.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if let Some(num) = n.strip_prefix("video").and_then(|s| s.parse::<u32>().ok()) {
                names.push((num, format!("/dev/{n}")));
            }
        }
    }
    names.sort_by_key(|(num, _)| *num);
    let list: Vec<String> = names.into_iter().map(|(_, p)| p).collect();
    if list.is_empty() {
        vec!["/dev/video0".to_string()]
    } else {
        list
    }
}

pub fn new_camera(codec: VideoCodec, fps: u32) -> Result<VideoEncoder, String> {
    gst_init()?;
    let mut rates: Vec<u32> = vec![fps, 30, 15];
    rates.dedup();
    let devices = camera_devices();
    let mut errs: Vec<String> = Vec::new();
    let mut wedged: Vec<String> = Vec::new();
    let resolutions: [(u32, u32); 2] = [(CAPTURE_W, CAPTURE_H), (FALLBACK_W, FALLBACK_H)];
    for (ri, (w, h)) in resolutions.iter().enumerate() {
        let last_res = ri + 1 == resolutions.len();
        for (i, dev) in devices.iter().enumerate() {
            if wedged.iter().any(|d| d == dev) {
                continue;
            }
            let last_dev = i + 1 == devices.len();
            let mut failures = 0u32;
            let mut silences = 0u32;
            let mut first_combo = true;
            for rate in rates.iter() {
                for raw in [false, true] {
                    let proof_ms = if first_combo { 3000 } else { 1500 };
                    first_combo = false;
                    match try_camera_pipeline(codec, dev, *rate, raw, *w, *h, proof_ms) {
                        Ok(enc) => return Ok(enc),
                        Err((msg, silent)) => {
                            errs.push(format!(
                                "{dev}@{rate} {w}x{h}{}: {msg}",
                                if raw { " raw" } else { " mjpg" }
                            ));
                            failures += 1;
                            if silent {
                                silences += 1;
                            }
                            if failures >= 6 {
                                let hint = if silences >= 3 {
                                    "sem resposta — device travado? tente desplugar e plugar de novo"
                                } else {
                                    "6 falhas seguidas"
                                };
                                wedged.push(dev.clone());
                                errs.push(format!("{dev}: {hint}"));
                                break;
                            }
                        }
                    }
                    if last_res && last_dev && rate == rates.last().unwrap() && raw {
                        for livre in [false, true] {
                            match try_camera_pipeline(codec, dev, 0, livre, *w, *h, 1500) {
                                Ok(enc) => return Ok(enc),
                                Err((msg, _)) => errs.push(format!("{dev}@livre {w}x{h}: {msg}")),
                            }
                        }
                    }
                }
                if wedged.iter().any(|d| d == dev) {
                    break;
                }
            }
        }
    }
    let mut msg = format!(
        "nenhuma camera utilizavel ({} tentativas: {})",
        errs.len(),
        errs.join(" | ")
    );
    if !wedged.is_empty() {
        msg.push_str(&format!(
            " — {} sem resposta (tente desplugar e plugar de novo)",
            wedged.join(", ")
        ));
    }
    Err(msg)
}

fn try_camera_pipeline(
    codec: VideoCodec,
    device: &str,
    rate: u32,
    raw: bool,
    width: u32,
    height: u32,
    proof_ms: u64,
) -> Result<VideoEncoder, (String, bool)> {
    let enc = video_encoder(codec, CAMERA_KBPS).map_err(|e| (e, false))?;
    let caps = encoded_caps(codec);
    let src = if raw {
        format!("v4l2src device={device}")
    } else {
        let pre = if rate == 0 {
            format!("image/jpeg,width={width},height={height}")
        } else {
            format!("image/jpeg,width={width},height={height},framerate={rate}/1")
        };
        format!("v4l2src device={device} ! {pre} ! jpegdec")
    };
    let fps_caps = if rate == 0 {
        String::new()
    } else {
        format!(",framerate={rate}/1")
    };
    let desc = format!(
        "{src} ! videoconvert ! videoscale ! \
         video/x-raw,format=I420,width={width},height={height}{fps_caps} ! \
         queue leaky=downstream max-size-buffers={ENCODER_QUEUE} ! {enc} ! {caps} ! \
         appsink name=vedsink emit-signals=false sync=false async=false \
         max-buffers=4 drop=true"
    );
    let mut enc = build_encoder(&desc, true).map_err(|e| (e, false))?;
    let t0 = std::time::Instant::now();
    while t0.elapsed() < Duration::from_millis(proof_ms) {
        if enc.poll_encoded_frame(Duration::from_millis(100)).is_some() {
            return Ok(enc);
        }
    }
    let detail = enc
        .take_error()
        .map(|e| (e, false))
        .unwrap_or_else(|| (format!("nenhum quadro em {proof_ms}ms"), true));
    enc.stop();
    Err(detail)
}

pub fn new_screen(codec: VideoCodec, fps: u32) -> Result<VideoEncoder, String> {
    gst_init()?;
    let enc = video_encoder(codec, SCREEN_KBPS)?;
    let caps = encoded_caps(codec);
    if has_element("ximagesrc") && std::env::var_os("DISPLAY").is_some() {
        let desc = format!(
            "ximagesrc use-damage=false ! videoconvert ! videoscale ! \
             video/x-raw,format=I420,width={CAPTURE_W},height={CAPTURE_H},framerate={fps}/1 ! \
             queue leaky=downstream max-size-buffers={ENCODER_QUEUE} ! {enc} ! {caps} ! \
             appsink name=vedsink emit-signals=false sync=false async=false \
             max-buffers=4 drop=true"
        );
        if let Ok(mut e) = build_encoder(&desc, true) {
            let t0 = std::time::Instant::now();
            let mut live = false;
            while t0.elapsed() < Duration::from_millis(1500) {
                if e.poll_encoded_frame(Duration::from_millis(100)).is_some() {
                    live = true;
                    break;
                }
            }
            if live {
                return Ok(e);
            }
            e.stop();
        }
    }
    let desc = format!(
        "appsrc name=vesrc is-live=true format=time do-timestamp=true block=false \
         max-buffers={ENCODER_QUEUE} caps=video/x-raw,format=RGBA,width=[1,2147483647],height=[1,2147483647],framerate=[1/1,2147483647/1] ! \
         queue leaky=downstream max-size-buffers={ENCODER_QUEUE} ! videoconvert ! videoscale ! \
         video/x-raw,format=I420,width={FALLBACK_W},height={FALLBACK_H},framerate={fps}/1 ! {enc} ! {caps} ! \
         appsink name=vedsink emit-signals=false sync=false async=false \
         max-buffers=4 drop=true"
    );
    build_encoder(&desc, false)
}

fn video_encoder(codec: VideoCodec, bitrate_kbps: u32) -> Result<String, String> {
    match codec {
        VideoCodec::Vp8 => Ok(
            "vp8enc deadline=1 cpu-used=-8 threads=4 lag-in-frames=0 \
             error-resilient=default+partitions keyframe-max-dist=60".to_string(),
        ),
        VideoCodec::H264 if has_element("x264enc") => Ok(format!(
            "x264enc tune=zerolatency speed-preset=superfast bitrate={bitrate_kbps} key-int-max=60 sliced-threads=true threads=4"
        )),
        VideoCodec::H264 if has_element("openh264enc") => Ok(format!(
            "openh264enc complexity=high bitrate={} gop-size=60 usage-type=screen",
            bitrate_kbps.saturating_mul(1000)
        )),
        VideoCodec::H264 if has_element("avenc_h264") => Ok("avenc_h264".to_string()),
        VideoCodec::H264 => {
            Err("nenhum encoder H.264 disponível (x264enc, openh264enc ou avenc_h264)".into())
        }
    }
}

fn encoded_caps(codec: VideoCodec) -> &'static str {
    match codec {
        VideoCodec::Vp8 => "video/x-vp8",
        VideoCodec::H264 => "video/x-h264,stream-format=byte-stream,alignment=au",
    }
}

fn build_encoder(desc: &str, self_feeding: bool) -> Result<VideoEncoder, String> {
    let pipeline = gstreamer::parse::launch(desc)
        .map_err(|e| format!("pipeline de encode não montou: {e}"))?
        .downcast::<gstreamer::Pipeline>()
        .map_err(|_| "pipeline de encode não é Pipeline".to_string())?;
    let sink = pipeline
        .by_name("vedsink")
        .and_then(|e| e.downcast::<AppSink>().ok())
        .ok_or_else(|| "appsink de encode ausente".to_string())?;
    let appsrc = pipeline
        .by_name("vesrc")
        .and_then(|e| e.downcast::<AppSrc>().ok());
    if !self_feeding && appsrc.is_none() {
        return Err("appsrc do encoder de tela ausente".into());
    }
    pipeline
        .set_state(gstreamer::State::Playing)
        .map_err(|e| format!("encoder não entrou em Playing: {e}"))?;
    Ok(VideoEncoder {
        pipeline,
        sink,
        appsrc,
        self_feeding,
    })
}

impl VideoEncoder {
    pub fn self_feeding(&self) -> bool {
        self.self_feeding
    }
}

impl VideoEncoder {
    pub fn push_screen_frame(&mut self, rgba: &[u8], w: u32, h: u32) -> Result<(), String> {
        if self.self_feeding {
            return Err("push_screen_frame chamado em encoder auto-alimentado".into());
        }
        let Some(src) = self.appsrc.as_ref() else {
            return Err("encoder sem appsrc".into());
        };
        let need = (w as usize) * (h as usize) * 4;
        if rgba.len() < need {
            return Err(format!(
                "frame de tela curto: {} bytes para {w}x{h} RGBA (esperado {need})",
                rgba.len()
            ));
        }
        let buf = gstreamer::Buffer::from_mut_slice(rgba.to_vec());
        match src.push_buffer(buf) {
            Ok(gst::FlowSuccess::Ok) => Ok(()),
            Ok(other) => Err(format!("appsrc recusou o frame ({other:?})")),
            Err(e) => Err(format!("appsrc recusou o frame: {e}")),
        }
    }

    pub fn poll_encoded_frame(&mut self, timeout: Duration) -> Option<Vec<u8>> {
        let sample = self.sink.try_pull_sample(gst::ClockTime::from_nseconds(
            timeout.as_nanos().min(u64::MAX as u128) as u64,
        ))?;
        let map = sample.buffer()?.map_readable().ok()?;
        Some(map.as_slice().to_vec())
    }

    pub fn take_error(&mut self) -> Option<String> {
        let Some(bus) = self.pipeline.bus() else {
            return None;
        };
        let mut iter =
            bus.iter_timed_filtered(Some(gst::ClockTime::ZERO), &[gst::MessageType::Error]);
        let Some(msg) = iter.next() else {
            return None;
        };
        let detail = msg
            .structure()
            .and_then(|st| st.get::<String>("debug").ok())
            .unwrap_or_else(|| "(sem detalhe)".to_string());
        let domain = msg
            .structure()
            .and_then(|st| st.get::<&str>("domain").ok())
            .unwrap_or("gstreamer");
        Some(format!("encoder de vídeo [{domain}]: {detail}"))
    }

    pub fn stop(&mut self) {
        let _ = self.pipeline.set_state(gstreamer::State::Null);
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        self.stop();
    }
}

pub struct VideoDecoder {
    pipeline: gstreamer::Pipeline,
    appsrc: AppSrc,
    sink: AppSink,
}

impl VideoDecoder {
    pub fn new(codec: VideoCodec, sprop_h264: Option<&str>) -> Result<Self, String> {
        Self::new_with_pt(codec, 96, sprop_h264)
    }

    pub fn new_with_pt(
        codec: VideoCodec,
        pt: u8,
        sprop_h264: Option<&str>,
    ) -> Result<Self, String> {
        gst_init()?;
        let caps = rtp_caps(codec.mime(), pt, sprop_h264);
        let (depay, dec) = match codec {
            VideoCodec::Vp8 => ("rtpvp8depay", "vp8dec".to_string()),
            VideoCodec::H264 => {
                let d = if has_element("avdec_h264") {
                    "avdec_h264"
                } else {
                    "openh264dec"
                };
                ("rtph264depay", d.to_string())
            }
        };
        let desc = format!(
            "appsrc name=vdsrc is-live=true format=time do-timestamp=true block=false \
             max-buffers={RTP_QUEUE} caps={caps} ! \
             queue leaky=no max-size-buffers={RTP_QUEUE} max-size-bytes=0 max-size-time=0 ! \
             {depay} ! {dec} ! videoconvert ! videoscale ! \
             video/x-raw,format=RGB ! appsink name=vdsink emit-signals=false sync=false \
             async=false max-buffers={SINK_QUEUE} drop=true"
        );
        let pipeline = gstreamer::parse::launch(&desc)
            .map_err(|e| format!("pipeline de decode não montou: {e}"))?
            .downcast::<gstreamer::Pipeline>()
            .map_err(|_| "pipeline de decode não é Pipeline".to_string())?;
        let appsrc = pipeline
            .by_name("vdsrc")
            .and_then(|e| e.downcast::<AppSrc>().ok())
            .ok_or_else(|| "appsrc de decode ausente".to_string())?;
        let sink = pipeline
            .by_name("vdsink")
            .and_then(|e| e.downcast::<AppSink>().ok())
            .ok_or_else(|| "appsink de decode ausente".to_string())?;
        pipeline
            .set_state(gstreamer::State::Playing)
            .map_err(|e| format!("decoder não entrou em Playing: {e}"))?;
        Ok(VideoDecoder {
            pipeline,
            appsrc,
            sink,
        })
    }

    pub fn push_rtp(&mut self, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        let buf = gstreamer::Buffer::from_mut_slice(bytes.to_vec());
        match self.appsrc.push_buffer(buf) {
            Ok(gst::FlowSuccess::Ok) => Ok(()),
            Ok(other) => Err(format!("appsrc do decoder recusou RTP ({other:?})")),
            Err(e) => Err(format!("appsrc do decoder recusou RTP: {e}")),
        }
    }

    pub fn poll_frame(&mut self, timeout: Duration) -> Option<(Vec<u8>, u32, u32)> {
        let sample = self.sink.try_pull_sample(gst::ClockTime::from_nseconds(
            timeout.as_nanos().min(u64::MAX as u128) as u64,
        ))?;
        let Some(caps) = sample.caps() else {
            return None;
        };
        let Some(st) = caps.structure(0) else {
            return None;
        };
        let w = st.get::<i32>("width").unwrap_or(0).max(1) as u32;
        let h = st.get::<i32>("height").unwrap_or(0).max(1) as u32;
        let map = sample.buffer()?.map_readable().ok()?;
        let bytes = map.as_slice().to_vec();
        let want_rgb = (w as usize) * (h as usize) * 3;
        let rgba = bytes.len() >= want_rgb * 2 && bytes.len() >= (w as usize) * (h as usize) * 4;
        let out = if rgba && bytes.len() == (w as usize) * (h as usize) * 4 {
            let mut rgb = Vec::with_capacity(want_rgb);
            for px in bytes.chunks_exact(4) {
                rgb.extend_from_slice(&px[..3]);
            }
            rgb
        } else {
            bytes
        };
        if out.len() < want_rgb {
            return None;
        }
        Some((out, w, h))
    }

    pub fn stop(&mut self) {
        let _ = self.pipeline.set_state(gstreamer::State::Null);
    }

    pub fn take_error(&mut self) -> Option<String> {
        let bus = self.pipeline.bus()?;
        let mut iter =
            bus.iter_timed_filtered(Some(gst::ClockTime::ZERO), &[gst::MessageType::Error]);
        let msg = iter.next()?;
        let detail = msg
            .structure()
            .and_then(|st| st.get::<String>("debug").ok())
            .unwrap_or_else(|| "(sem detalhe)".to_string());
        let domain = msg
            .structure()
            .and_then(|st| st.get::<&str>("domain").ok())
            .unwrap_or("gstreamer");
        Some(format!("decoder de vídeo [{domain}]: {detail}"))
    }
}

impl Drop for VideoDecoder {
    fn drop(&mut self) {
        self.stop();
    }
}

fn monitors() -> Option<Vec<xcap::Monitor>> {
    type Cache = Option<(std::time::Instant, Vec<xcap::Monitor>)>;
    static MONS: std::sync::OnceLock<std::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    let cache = MONS.get_or_init(|| std::sync::Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    let stale = guard.as_ref().map_or(true, |(updated, _)| {
        updated.elapsed() >= Duration::from_secs(2)
    });
    if stale {
        match xcap::Monitor::all() {
            Ok(list) => *guard = Some((std::time::Instant::now(), list)),
            Err(e) => tracing::warn!("[video] xcap não enumerou monitores: {e}"),
        }
    }
    guard
        .as_ref()
        .map(|(_, monitors)| monitors.clone())
        .filter(|monitors| !monitors.is_empty())
}

pub fn grab_screen_frame(monitor: Option<u32>) -> Option<(Vec<u8>, u32, u32)> {
    let mons = monitors()?;
    if mons.is_empty() {
        return None;
    }
    let want = match monitor {
        Some(id) => mons
            .iter()
            .find(|m| m.id().map(|x| x == id).unwrap_or(false))
            .unwrap_or(&mons[0])
            .clone(),
        None => mons
            .iter()
            .find(|m| m.is_primary().unwrap_or(false))
            .unwrap_or(&mons[0])
            .clone(),
    };
    let shot = match want.capture_image() {
        Ok(s) => s,
        Err(e) => {
            static LAST_CAPTURE_WARNING: std::sync::OnceLock<
                std::sync::Mutex<Option<std::time::Instant>>,
            > = std::sync::OnceLock::new();
            let last = LAST_CAPTURE_WARNING.get_or_init(|| std::sync::Mutex::new(None));
            let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
            if last.map_or(true, |t| t.elapsed() >= Duration::from_secs(10)) {
                tracing::warn!("[video] captura de tela falhou: {e}");
                *last = Some(std::time::Instant::now());
            }
            return None;
        }
    };
    let (w, h) = (shot.width(), shot.height());
    if w == 0 || h == 0 {
        return None;
    }
    Some((shot.into_raw(), w, h))
}

pub fn jpeg_encode(rgb: &[u8], w: u32, h: u32) -> Result<Vec<u8>, String> {
    if rgb.len() < (w as usize) * (h as usize) * 3 {
        return Err(format!(
            "frame RGB curto: {} bytes para {w}x{h} (esperado {})",
            rgb.len(),
            (w as usize) * (h as usize) * 3
        ));
    }
    let img = image::RgbImage::from_raw(w, h, rgb.to_vec())
        .ok_or_else(|| "RgbImage::from_raw recusou as dimensões".to_string())?;
    let mut out = Vec::new();
    let enc = jpeg_encoder::Encoder::new(&mut out, 70);
    enc.encode(
        img.as_raw(),
        w as u16,
        h as u16,
        jpeg_encoder::ColorType::Rgb,
    )
    .map_err(|e| format!("JPEG falhou: {e}"))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{encoded_caps, VideoCodec};

    #[test]
    fn encoder_exposes_compressed_frames_for_the_webrtc_packetizer() {
        assert_eq!(encoded_caps(VideoCodec::Vp8), "video/x-vp8");
        assert_eq!(
            encoded_caps(VideoCodec::H264),
            "video/x-h264,stream-format=byte-stream,alignment=au"
        );
    }

    #[test]
    fn only_implemented_codecs_are_selected_for_sending() {
        assert_eq!(
            VideoCodec::supported_from_mime("video/VP8"),
            Some(VideoCodec::Vp8)
        );
        assert_eq!(
            VideoCodec::supported_from_mime("video/H264"),
            Some(VideoCodec::H264)
        );
        assert_eq!(VideoCodec::supported_from_mime("video/VP9"), None);
        assert_eq!(VideoCodec::supported_from_mime("video/AV1"), None);
        assert_eq!(VideoCodec::supported_from_mime("video/rtx"), None);
    }
}
