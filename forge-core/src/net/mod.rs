pub mod dht;
pub mod discovery;
pub mod engine;
pub mod mdns;
/// AEC + supressao de ruido (speexdsp). Mesmo gate linux-only de `media_voice`.
#[cfg(target_os = "linux")]
pub mod media_dsp;
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
pub mod vtunnel;
