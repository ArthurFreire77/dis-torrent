pub mod dht;
pub mod discovery;
pub mod engine;
pub mod mdns;
/// AEC + supressao de ruido (speexdsp). Mesmo gate linux-only de `media_voice`.
#[cfg(target_os = "linux")]
pub mod media_dsp;
/// Video nativo (GStreamer + xcap). Mesmo gate linux-only de `media_voice`.
///
/// Ainda não é referenciado por `media_voice`: o encoder/decoder existem e
/// compilam, mas falta ligar a task de envio e a de recebimento (track,
/// `write_sample`, watchdog). Ver README do módulo.
#[cfg(target_os = "linux")]
pub mod media_video;
/// Camada de voz NATIVA (webrtc-rs + cpal + Opus).
///
/// Linux only, e por decisão: ver o bloco de dependências em Cargo.toml. Nos
/// outros sistemas o WebRTC do navegador é o dono das chamadas e este módulo
/// sequer existe — é o que garante que aquele caminho não muda em nada.
#[cfg(target_os = "linux")]
pub mod media_voice;
pub mod natpmp;
pub mod peer_relay;
pub mod relay;
pub mod socks5;
pub mod stun;
pub mod transport;
/// Retenção de sinalização de chamada (offer/ICE pré-aceite) + re-arm da
/// mídia nativa. O módulo compila em toda plataforma: fora do Linux tudo é
/// no-op (a offer flui para o JS como sempre) — mas o método
/// `resume_held_call` PRECISA existir em todas, o comando Tauri chama direto.
pub mod voice_gate;
pub mod vtunnel;
