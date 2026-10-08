//! Video NATIVO (GStreamer) — encoder e decoder do caminho de video da chamada.
//!
//! Linux only, mesma política de `media_voice`: o WebRTC do navegador continua
//! sendo o dono nas outras plataformas.
//!
//! POR QUE GSTREAMER E NAO "so um encoder": a chamada nativa precisa de três
//! coisas que o `webrtc-rs` não dá pronto —
//!   1. codificar a câmera (v4l2src) ou a tela (appsrc alimentado pelo xcap) em
//!      VP8/H264 e entregar quadros codificados ao `TrackLocalStaticSample`;
//!   2. decodificar o RTP que chega e entregar frames para a UI;
//!   3. fazer isso SEM travar o worker tokio de áudio/RTP.
//! GStreamer cuida de captura/conversão/codec. O `TrackLocalStaticSample`
//! empacota os quadros codificados em RTP e SRTP; não se deve inserir um RTP
//! payloader do GStreamer antes dele (isso encapsularia RTP dentro de RTP).
//!
//! REGRA QUE NÃO SE QUEBRA: o payload type do decoder tem que ser o PT **real**
//! negociado no SDP. Ver [`rtp_caps`] e [`VideoDecoder::new_with_pt`].

use std::time::Duration;

use gstreamer as gst;
use gstreamer::prelude::*;
use gstreamer_app::AppSink;
use gstreamer_app::AppSrc;

// ---------------------------------------------------------------- parametros

/// Dimensoes de envio (tamanho de videochamada — 4K nao roda em CPU de
/// notebook e o encoder viralmente leria acima de 2x o frame rate).
const CAPTURE_W: u32 = 640;
const CAPTURE_H: u32 = 480;
/// Teto de frames em voo no encoder: acima disso, prefere perder quadro a
/// acumular latência.
const ENCODER_QUEUE: u32 = 2;
/// RTP precisa chegar inteiro ao depayloader: se qualquer fragmento de um
/// frame for descartado, todo o frame se perde. A fila é limitada para não
/// deixar a latência crescer sem limite se o decoder ficar preso.
const RTP_QUEUE: u32 = 512;
/// Teto de frames no sink de decode: a UI só quer o MAIS RECENTE.
const SINK_QUEUE: u32 = 2;

// ---------------------------------------------------------------- caps RTP

/// Caps do `appsrc`/`appsink` com o payload type REAL.
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

/// Extrai `sprop-parameter-sets` de um SDP.
///
/// Sem isso o decoder H264 fica PRETO até o peer mandar SPS/PPS in-band — e
/// muitos não mandam. Ver `media_voice::spawn_video_recv`.
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

// ---------------------------------------------------------------- codec

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
    pub fn mime(&self) -> &'static str {
        match self {
            VideoCodec::Vp8 => "video/VP8",
            VideoCodec::H264 => "video/H264",
        }
    }
}

// ---------------------------------------------------------------- gst init

/// `gst::init()` é idempotente mas pode falhar; memoizado para não repetir o
/// parse do registry a cada chamada.
fn gst_init() -> Result<(), String> {
    static ONCE: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    ONCE.get_or_init(|| gstreamer::init().map_err(|e| format!("GStreamer não inicializou: {e}")))
        .clone()
}

/// `Some(nome)` se o elemento existe no registry — usado para fallback
/// (avdec_h264 vs openh264dec, etc) sem falhar o pipeline inteiro.
fn has_element(name: &str) -> bool {
    if gst_init().is_err() {
        return false;
    }
    gstreamer::ElementFactory::find(name).is_some()
}

// ---------------------------------------------------------------- encoder

/// Pipeline de编码 camera -> RTP.
pub struct VideoEncoder {
    pipeline: gstreamer::Pipeline,
    /// appsink de saída: é daqui que saem os pacotes RTP crus.
    sink: AppSink,
    /// Só no modo tela (o `appsrc` que o xcap alimenta). `None` na câmera.
    appsrc: Option<AppSrc>,
    camera: bool,
}

/// Monta o encoder da CÂMERA. O RTP é produzido por `TrackLocalStaticSample`.
///
/// Não bloqueia por muito tempo: `v4l2src ! ... ! play` volta assim que o
/// primeiro frame entra, mas em máquina sem câmera o `play` pode demorar — daí
/// o caller(envolver em timeout) e o watchdog de envio.
pub fn new_camera(codec: VideoCodec, fps: u32) -> Result<VideoEncoder, String> {
    gst_init()?;
    let enc = video_encoder(codec, 800)?;
    let caps = encoded_caps(codec);
    let desc = format!(
        "v4l2src device=/dev/video0 ! videoconvert ! videoscale ! \
         video/x-raw,format=I420,width={CAPTURE_W},height={CAPTURE_H},framerate={fps}/1 ! \
         queue leaky=downstream max-size-buffers={ENCODER_QUEUE} ! {enc} ! {caps} ! \
         appsink name=vedsink emit-signals=false sync=false async=false \
         max-buffers=4 drop=true"
    );
    build_encoder(&desc, true)
}

/// Monta o encoder de TELA. Não captura nada sozinho: quem alimenta é
/// [`VideoEncoder::push_screen_frame`] (via xcap).
pub fn new_screen(codec: VideoCodec, fps: u32) -> Result<VideoEncoder, String> {
    gst_init()?;
    let enc = video_encoder(codec, 1500)?;
    let caps = encoded_caps(codec);
    let desc = format!(
        "appsrc name=vesrc is-live=true format=time do-timestamp=true block=false \
         max-buffers={ENCODER_QUEUE} caps=video/x-raw,format=RGB,width={CAPTURE_W},height={CAPTURE_H},framerate={fps}/1 ! \
         queue leaky=downstream max-size-buffers={ENCODER_QUEUE} ! videoconvert ! videoscale ! \
         video/x-raw,format=I420,framerate={fps}/1 ! {enc} ! {caps} ! \
         appsink name=vedsink emit-signals=false sync=false async=false \
         max-buffers=4 drop=true"
    );
    build_encoder(&desc, false)
}

/// Escolhe um encoder que realmente produz o codec negociado. `avenc_mpeg4`
/// é MPEG-4 Part 2, não H.264.
fn video_encoder(codec: VideoCodec, bitrate_kbps: u32) -> Result<String, String> {
    match codec {
        VideoCodec::Vp8 => Ok("vp8enc deadline=1".to_string()),
        VideoCodec::H264 if has_element("x264enc") => Ok(format!(
            "x264enc tune=zerolatency speed-preset=veryfast bitrate={bitrate_kbps} key-int-max=60"
        )),
        VideoCodec::H264 if has_element("openh264enc") => Ok(format!(
            "openh264enc complexity=low bitrate={} gop-size=60",
            bitrate_kbps.saturating_mul(1000)
        )),
        VideoCodec::H264 if has_element("avenc_h264") => Ok("avenc_h264".to_string()),
        VideoCodec::H264 => {
            Err("nenhum encoder H.264 disponível (x264enc, openh264enc ou avenc_h264)".into())
        }
    }
}

/// Formato comprimido que o encoder entrega ao packetizer WebRTC.
fn encoded_caps(codec: VideoCodec) -> &'static str {
    match codec {
        VideoCodec::Vp8 => "video/x-vp8",
        VideoCodec::H264 => "video/x-h264,stream-format=byte-stream,alignment=au",
    }
}

fn build_encoder(desc: &str, camera: bool) -> Result<VideoEncoder, String> {
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
    // Câmera: o v4l2src alimenta sozinho. Tela: o appsrc é o ponto de entrada —
    // se não achou, o pipeline está errado e é melhor falhar aqui.
    if !camera && appsrc.is_none() {
        return Err("appsrc do encoder de tela ausente".into());
    }
    pipeline
        .set_state(gstreamer::State::Playing)
        .map_err(|e| format!("encoder não entrou em Playing: {e}"))?;
    Ok(VideoEncoder {
        pipeline,
        sink,
        appsrc,
        camera,
    })
}

impl VideoEncoder {
    /// Empurra um frame RGBA de tela (do xcap) no encoder. Só em encoder de tela.
    ///
    /// `block=false` + `max-buffers=2` no appsrc: quando o encoder atrasa, o frame
    /// é DESCARTADO em vez de acumular latência — o comportamento certo para
    /// videochamada (tela parada vale mais que tela com 2 s de atraso).
    pub fn push_screen_frame(&mut self, rgba: &[u8], w: u32, h: u32) -> Result<(), String> {
        if self.camera {
            return Err("push_screen_frame chamado em encoder de câmera".into());
        }
        let Some(src) = self.appsrc.as_ref() else {
            return Err("encoder sem appsrc".into());
        };
        let need = (w as usize) * (h as usize) * 3;
        if rgba.len() < need {
            return Err(format!(
                "frame de tela curto: {} bytes para {w}x{h} (esperado {need})",
                rgba.len()
            ));
        }
        let buf = gstreamer::Buffer::from_mut_slice(rgba.to_vec());
        // FlowSuccess::Ok = enfileirado; Flushing/Eos = o encoder esta' fechando.
        match src.push_buffer(buf) {
            Ok(gst::FlowSuccess::Ok) => Ok(()),
            Ok(other) => Err(format!("appsrc recusou o frame ({other:?})")),
            Err(e) => Err(format!("appsrc recusou o frame: {e}")),
        }
    }

    /// Puxa um quadro comprimido pronto para `TrackLocalStaticSample`.
    pub fn poll_encoded_frame(&mut self, timeout: Duration) -> Option<Vec<u8>> {
        let sample = self.sink.try_pull_sample(gst::ClockTime::from_nseconds(
            timeout.as_nanos().min(u64::MAX as u128) as u64,
        ))?;
        let map = sample.buffer()?.map_readable().ok()?;
        Some(map.as_slice().to_vec())
    }

    /// Último erro publicado no bus do encoder, se houver.
    ///
    /// Um pipeline quebrado não devolve sample — sem esta checagem, o chamador só
    /// via "parou de chegar pacote" e não sabe se foi device, codec ou pipeline.
    pub fn take_error(&mut self) -> Option<String> {
        let Some(bus) = self.pipeline.bus() else {
            return None;
        };
        let mut iter =
            bus.iter_timed_filtered(Some(gst::ClockTime::ZERO), &[gst::MessageType::Error]);
        let Some(msg) = iter.next() else {
            return None;
        };
        // `Message` em 0.22 não tem `parse`: o erro vem na estrutura, campo
        // "debug".
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

    /// Para o pipeline e FECHA o device.
    ///
    /// `set_state(Null)` é o que realmente libera o v4l2. Sem ele a próxima
    /// `new_camera` falha com "device busy" — e o sintoma é "liguei a câmera de novo
    /// e ela não abre mais".
    pub fn stop(&mut self) {
        let _ = self.pipeline.set_state(gstreamer::State::Null);
    }
}

impl Drop for VideoEncoder {
    fn drop(&mut self) {
        self.stop();
    }
}

// ---------------------------------------------------------------- decoder

/// Pipeline de decode: RTP -> frames RGB para a UI.
pub struct VideoDecoder {
    pipeline: gstreamer::Pipeline,
    appsrc: AppSrc,
    sink: AppSink,
}

impl VideoDecoder {
    /// PT padrão (96) — compatibilidade com quem chama sem SDP.
    pub fn new(codec: VideoCodec, sprop_h264: Option<&str>) -> Result<Self, String> {
        Self::new_with_pt(codec, 96, sprop_h264)
    }

    /// Com o PT REAL do SDP remoto.
    ///
    /// PT errado => `rtp*depay` rejeita todo pacote => tela preta SEM NENHUM
    /// erro. Foi o caso mais confuso que debugamos: funcionava contra o nosso
    /// próprio build (VP8 em 96) e falhava contra Android (H264 em 102).
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

    /// Enfia um pacote RTP cru (com header) no decode e preserva falhas do appsrc.
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

    /// Frame RGB mais recente, sem bloquear.
    pub fn poll_frame(&mut self, timeout: Duration) -> Option<(Vec<u8>, u32, u32)> {
        let sample = self.sink.try_pull_sample(gst::ClockTime::from_nseconds(
            timeout.as_nanos().min(u64::MAX as u128) as u64,
        ))?;
        // As dimensões vêm dos CAPS do sample. SemCaps não significa frame
        // ruim: às vezes o appsink entrega um sample sem caps quando o
        // pipeline só teve uma reneguração.
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
        // RGBA do GStreamer vs RGB esperado pela UI: normaliza pelo tamanho.
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

    /// Para o pipeline de decode (solta as threads do vp8dec/videoconvert).
    pub fn stop(&mut self) {
        let _ = self.pipeline.set_state(gstreamer::State::Null);
    }

    /// Erro de fluxo publicado pelo decoder, se houver.
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

// ---------------------------------------------------------------- captura de tela

/// Lista de monitores em cache, atualizada a cada dois segundos para perceber
/// hotplug sem enumerar outputs a cada quadro. Retorna uma cópia curta para o
/// chamador não manter o lock durante a captura.
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
            // Uma falha transitória não descarta a última lista conhecida.
            Err(e) => tracing::warn!("[video] xcap não enumerou monitores: {e}"),
        }
    }
    guard
        .as_ref()
        .map(|(_, monitors)| monitors.clone())
        .filter(|monitors| !monitors.is_empty())
}

/// Captura um frame RGB da tela. `None` = este tick falhou (Wayland sem portal,
/// monitor sumiu, etc).
pub fn grab_screen_frame(monitor: Option<u32>) -> Option<(Vec<u8>, u32, u32)> {
    let mons = monitors()?;
    if mons.is_empty() {
        return None;
    }
    // CLONE (Monitor e' Clone) e solta o Mutex ANTES de capturar: sob Wayland
    // sem portal, `capture_image()` pode bloquear por segundos — segurar o lock
    // nesse ponto congelaria o grab dos OUTROS peers da chamada.
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
            // Wayland sem xdg-desktop-portal cai aqui sempre. A captura pode
            // ser tentada por frame e por peer, então limita o log a 1 aviso/10s.
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
    let rgba = shot;
    let (w, h) = (rgba.width(), rgba.height());
    if w == 0 || h == 0 {
        return None;
    }
    // Reduz para o tamanho de envio: tela 4K em videochamada e' CPU que nao
    // volta (e enche o encoder de quadros que serao descartados).
    let small = image::imageops::resize(
        &rgba,
        CAPTURE_W,
        CAPTURE_H,
        image::imageops::FilterType::Triangle,
    );
    let mut rgb = Vec::with_capacity((CAPTURE_W * CAPTURE_H * 3) as usize);
    for px in small.as_raw().chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }
    let _ = (w, h);
    Some((rgb, CAPTURE_W, CAPTURE_H))
}

// ---------------------------------------------------------------- jpeg

/// RGB -> JPEG para o preview da UI. Chamado FORA do worker de áudio (o
/// `media_voice` faz isso num `spawn_blocking` dedicado).
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
}
