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

/// Dimensao de envio do video. 720p MEDIDO a 29 fps com `ximagesrc` (tela) e
/// a camera aguenta o mesmo. 640x480 era o que fazia a imagem do peer chegar
/// do tamanho de um selo — e o `scaleResolutionDownBy` do adaptive acabava
/// piorando quem ja estava pequeno.
const CAPTURE_W: u32 = 1280;
const CAPTURE_H: u32 = 720;
/// Fallback para dispositivo que nao negoceia 720p (webcam antiga, encoder
/// lento, driver sem superficie): a chamada fica em 480p em vez de preta.
const FALLBACK_W: u32 = 640;
const FALLBACK_H: u32 = 480;
/// Bitrate alvo do VP8/H264 em kbps. 720p com 800 kbps (o valor antigo de
/// camera) gerava blocos visiveis em qualquer movimento; 2.5 Mbps e o que
/// uma chamada 720p precisa para nao derreter.
const CAMERA_KBPS: u32 = 2500;
/// Tela tem mais conteudo estatico: um pouco mais de bitrate, mesmo perfil.
const SCREEN_KBPS: u32 = 3500;
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
    /// Só no modo tela por appsrc (xcap). `None` na câmera e no ximagesrc.
    appsrc: Option<AppSrc>,
    /// `true` = o pipeline CAPTA SOZINHO (`v4l2src` ou `ximagesrc`) e o laço
    /// de envio só precisa puxar. `false` = appsrc alimentado pelo xcap.
    self_feeding: bool,
}

/// Devices V4L2 em ordem numérica (`/dev/video0`, `/dev/video1`, ...).
///
/// Hardcodar `/dev/video0` quebrou em duas frentes medidas: (1) webcam que
/// aparece como `video1` porque `video0` é um nó de metadados da mesma câmera
/// (UVC sempre cria o par) ou de outra câmera IR; (2) notebook com câmera em
/// `video2` depois de uma placa de captura. Enumerar custa um `read_dir`.
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
        // Sem /dev/video*: devolve o caminho histórico para o erro do GStreamer
        // ser o mesmo que o usuário já sabe ler.
        vec!["/dev/video0".to_string()]
    } else {
        list
    }
}

/// Monta o encoder da CÂMERA, tentando os devices e taxas que existem de fato.
///
/// Dois modos de falha cobertos aqui, ambos medidos:
///  - `not-negotiated`: o caps pedia `framerate=15/1` e a webcam só oferece
///    30/1 (UVC comum). Antes o pipeline morria e a câmera nunca ligava.
///  - MJPG puro: webcam barata que só entrega `image/jpeg` — `videoconvert`
///    não decodifica JPEG, então sem `jpegdec` o pipeline não negociada.
///
/// A primeira combinação que ENTREGA UM QUADRO ganha: `set_state(Playing)`
/// por si só não prova nada (o v4l2src entra em Playing e quebra no preroll).
pub fn new_camera(codec: VideoCodec, fps: u32) -> Result<VideoEncoder, String> {
    gst_init()?;
    // Taxas a tentar, na ordem: a pedida, depois as que as UVC realmente têm.
    // 20/10 caíram: webcam que faz 20/10 quase sempre faz 30/15, e cada taxa
    // a mais custa 1.5s × formatos na falha — a varredura passava de 1 min.
    let mut rates: Vec<u32> = vec![fps, 30, 15];
    rates.dedup();
    let devices = camera_devices();
    let mut errs: Vec<String> = Vec::new();
    let mut wedged: Vec<String> = Vec::new();
    // 720p primeiro; 480p só entra se NENHUMA combinação de 720p funcionar
    // (webcam antiga/driver sem superfície) — chamada em 480p é melhor que
    // chamada sem imagem.
    let resolutions: [(u32, u32); 2] = [(CAPTURE_W, CAPTURE_H), (FALLBACK_W, FALLBACK_H)];
    for (ri, (w, h)) in resolutions.iter().enumerate() {
        let last_res = ri + 1 == resolutions.len();
        for (i, dev) in devices.iter().enumerate() {
            if wedged.iter().any(|d| d == dev) {
                continue; // device mudo nas anteriores: não insiste
            }
            let last_dev = i + 1 == devices.len();
            // Teto de falhas por device: hardware saudável conecta na 1ª ou
            // 2ª combinação (MJPG primeiro); 6 falhas seguidas = device morto
            // ou travado (firmware wedged entrega zero quadros mas às vezes
            // cospe erro de negociação entre um silêncio e outro). Sem teto,
            // a varredura queimava 1 min+ num device morto.
            let mut failures = 0u32;
            let mut silences = 0u32;
            let mut first_combo = true;
            for rate in rates.iter() {
                // MJPG primeiro: YUYV 720p@30 (55 MB/s) não cabe no USB2, e o
                // raw era tentado antes e queimava 1.5s+ por combinação à toa.
                // MJPG cabe e é universal em UVC; raw fica de fallback.
                for raw in [false, true] {
                    // Primeira combinação do device ganha janela maior (3s):
                    // firmware frio demora para entregar o 1º quadro.
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
                    // Última carta do último device/resolução: taxa livre.
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

/// Uma tentativa de pipeline de câmera. `rate == 0` = sem filtro de framerate.
/// `proof_ms` = quanto esperar pelo 1º quadro codificado. Devolve
/// `(mensagem, silencioso)` no erro: silencioso = pipeline montou e rodou,
/// mas zero quadros (device travado), diferente de erro de negociação.
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
        // MJPG: o filtro de entrada força image/jpeg e o jpegdec converte.
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
    // Prova real: um quadro codificado chega? Sem isto, um pipeline que monta
    // e morre no preroll (device ocupado, caps impossível) passaria por válido.
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

/// Monta o encoder de TELA.
///
/// X11 com `ximagesrc`: o pipeline captura sozinho, dentro do GStreamer.
/// MEDIDO nesta máquina: 29 fps a 1280x720 — contra 0.5 fps do caminho
/// xcap+appsrc. O xcap usa `XGetImage` sem MIT-SHM e converte 2M pixels em
/// Rust (`get_pixel24_32_rgba`); o `image::resize(Triangle)` sozinho custava
/// 1 fps e a conversão RGBA→RGB mais outro. `ximagesrc` resolve os três.
///
/// Sem `ximagesrc` (Wayland sem portal, ou elemento ausente): cai no
/// `appsrc` alimentado pelo `grab_screen_frame` (xcap) — o pipeline antigo.
pub fn new_screen(codec: VideoCodec, fps: u32) -> Result<VideoEncoder, String> {
    gst_init()?;
    let enc = video_encoder(codec, SCREEN_KBPS)?;
    let caps = encoded_caps(codec);
    if has_element("ximagesrc") && std::env::var_os("DISPLAY").is_some() {
        // use-damage=false: o padrão (true) faz o ximagesrc mandar atualização
        // parcial da tela, e o RTP/webrtc-rs não entende delta — a imagem do
        // peer rachava. false manda o quadro inteiro sempre.
        let desc = format!(
            "ximagesrc use-damage=false ! videoconvert ! videoscale ! \
             video/x-raw,format=I420,width={CAPTURE_W},height={CAPTURE_H},framerate={fps}/1 ! \
             queue leaky=downstream max-size-buffers={ENCODER_QUEUE} ! {enc} ! {caps} ! \
             appsink name=vedsink emit-signals=false sync=false async=false \
             max-buffers=4 drop=true"
        );
        if let Ok(mut e) = build_encoder(&desc, true) {
            // Prova real igual à da câmera: ximagesrc que monta mas não
            // entrega (Wayland sem portal, DISPLAY errado, permissão) virava
            // tela preta anunciada como ativa. Sem quadro em 1.5s, cai no
            // appsrc (xcap) em vez de mentir.
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

/// Escolhe um encoder que realmente produz o codec negociado. `avenc_mpeg4`
/// é MPEG-4 Part 2, não H.264.
fn video_encoder(codec: VideoCodec, bitrate_kbps: u32) -> Result<String, String> {
    match codec {
        VideoCodec::Vp8 => Ok(
            // cpu-used negativo = MAIS qualidade (gasta mais CPU). Medido: -8 a
            // 1280x720 segura 29 fps. threads=4 paraleliza o encode.
            // lag-in-frames=0 corta a latência do look-ahead.
            // error-resilient: `partitions` deixa cada partição do quadro ser
            // decodificada sozinha — em P2P pacote RTP se perde e sem isso a
            // imagem inteira racha até o próximo keyframe.
            // keyframe-max-dist: um keyframe a cada ~2 s em 30 fps (60), o
            // suficiente para recuperar de perda sem gastar bitrate à toa.
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

/// Formato comprimido que o encoder entrega ao packetizer WebRTC.
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
    // ximagesrc/v4l2src alimentam sozinhos. Só o caminho appsrc (xcap) precisa
    // do ponto de entrada externo — se não achou, o pipeline está errado.
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
    /// O pipeline captura sozinho (v4l2src/ximagesrc)? Quando `true`, o laço
    /// de envio NÃO deve alimentar o encoder — só puxar os quadros.
    pub fn self_feeding(&self) -> bool {
        self.self_feeding
    }
}

impl VideoEncoder {
    /// Empurra um frame RGBA de tela (do xcap) no encoder. Só em encoder de tela.
    ///
    /// `block=false` + `max-buffers=2` no appsrc: quando o encoder atrasa, o frame
    /// é DESCARTADO em vez de acumular latência — o comportamento certo para
    /// videochamada (tela parada vale mais que tela com 2 s de atraso).
    pub fn push_screen_frame(&mut self, rgba: &[u8], w: u32, h: u32) -> Result<(), String> {
        if self.self_feeding {
            return Err("push_screen_frame chamado em encoder auto-alimentado".into());
        }
        let Some(src) = self.appsrc.as_ref() else {
            return Err("encoder sem appsrc".into());
        };
        // O appsrc recebe RGBA CRU, na resolução do monitor: é o `videoscale`
        // do pipeline que reduz. Redimensionar em Rust (image::resize Triangle)
        // custava 1 fps MEDIDO — mais caro que todo o resto do vídeo somado.
        let need = (w as usize) * (h as usize) * 4;
        if rgba.len() < need {
            return Err(format!(
                "frame de tela curto: {} bytes para {w}x{h} RGBA (esperado {need})",
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

/// Captura um frame da tela em **RGBA, na resolução real do monitor**.
///
/// Sem resize e sem conversão de formato: o `videoscale`/`videoconvert` do
/// pipeline de encode fazem isso em C, ordens de magnitude mais rápido. A
/// versão anterior reduzia com `image::resize(Triangle)` e convertia RGBA→RGB
/// num laço Rust — os dois juntos derrubavam o compartilhamento de tela para
/// ~0.5 fps em 1080p.
///
/// `None` = este tick falhou (Wayland sem portal, monitor sumiu, etc).
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
    let (w, h) = (shot.width(), shot.height());
    if w == 0 || h == 0 {
        return None;
    }
    Some((shot.into_raw(), w, h))
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
