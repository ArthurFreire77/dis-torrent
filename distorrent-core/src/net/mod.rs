pub mod call_room;
// Música do bot depende do `AudioHub`, que só existe na mídia nativa Linux.
// No Windows/Android o áudio da chamada é da WebView, não do core.
#[cfg(target_os = "linux")]
pub mod bot_audio;
pub mod dht;
pub mod discovery;
pub mod engine;
#[cfg(not(target_os = "android"))]
pub mod mdns;
#[cfg(target_os = "linux")]
pub mod media_dsp;
#[cfg(target_os = "linux")]
pub mod media_video;
#[cfg(target_os = "linux")]
pub mod media_voice;
pub mod natpmp;
pub mod netlimit;
pub mod peer_relay;
pub mod reaction_limit;
pub mod relay;
pub mod release_trust;
pub mod socks5;
pub mod stun;
pub mod transport;
pub mod voice_gate;
pub mod vtunnel;
