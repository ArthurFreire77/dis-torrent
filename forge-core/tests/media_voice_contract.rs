//! Trava o contrato público da camada de voz nativa.
//!
//! Se uma assinatura mudar, este arquivo não compila — e' o aviso de que o
//! wiring do app (src-tauri + engine.rs) vai quebrar. O teste de ponta a ponta
//! (mic -> Opus -> webrtc -> jitter -> decode -> alto-falante, com medição de
//! latência) roda no binário de validação do módulo, não aqui: este arquivo só
//! precisa garantir a FORMA da API e que um ciclo offer/answer real acontece.

use std::sync::Arc;

use forge_core::net::media_voice::{OutboundSignal, VoiceMedia, VoiceStats};

#[test]
fn contrato_da_api() {
    // Construtores e metodos, com os tipos de retorno exatos.
    let new: fn() -> Result<Arc<VoiceMedia>, String> = VoiceMedia::new;
    let m: Arc<VoiceMedia> = new().expect("VoiceMedia::new");

    let has_capture: fn(&VoiceMedia) -> bool = VoiceMedia::has_capture;
    let _ = has_capture(&m);

    let create_offer: fn(&VoiceMedia, &str, &str) -> Result<String, String> =
        VoiceMedia::create_offer;
    let handle_offer: fn(&VoiceMedia, &str, &str, &str) -> Result<String, String> =
        VoiceMedia::handle_offer;
    let handle_answer: fn(&VoiceMedia, &str, &str, &str) -> Result<(), String> =
        VoiceMedia::handle_answer;
    let add_ice: fn(&VoiceMedia, &str, &str, &str, &str) -> Result<(), String> =
        VoiceMedia::add_ice_candidate;
    let drain: fn(&VoiceMedia, &str, &str) -> Vec<OutboundSignal> = VoiceMedia::drain_outbound;
    let set_muted: fn(&VoiceMedia, &str, bool) = VoiceMedia::set_muted;
    let hangup: fn(&VoiceMedia, &str) = VoiceMedia::hangup;
    let stats: fn(&VoiceMedia, &str) -> Option<VoiceStats> = VoiceMedia::stats;

    // VoiceStats: um campo por requisito, com o tipo pedido.
    let s = VoiceStats {
        state: String::from("idle"),
        route: String::from("n/d"),
        jitter_depth_ms: 50u32,
        packets_in: 0u64,
        packets_out: 0u64,
        plc_frames: 0u64,
        decode_errors: 0u64,
        rtt_ms: None,
        mic_error: None,
        video_state: None,
        video_codec: None,
        video_source: None,
        video_error: None,
        frames_in: None,
        frames_out: None,
    };
    assert_eq!(s.jitter_depth_ms, VoiceMedia::jitter_depth_ms());

    // As tres variantes do sinal de saida, com os campos exatos.
    let _ = OutboundSignal::Offer { sdp: String::new() };
    let _ = OutboundSignal::Answer { sdp: String::new() };
    let _ = OutboundSignal::Ice {
        candidate: String::new(),
        mid: String::new(),
    };

    // Uma sessao real ponta a ponta pela API publica.
    let offer = create_offer(&m, "call", "peer").expect("create_offer");
    assert!(offer.starts_with("v=0"), "offer nao parece SDP: {offer}");
    let answer = handle_offer(&m, "call", "peer2", &offer).expect("handle_offer");
    assert!(answer.starts_with("v=0"), "answer nao parece SDP: {answer}");
    handle_answer(&m, "call", "peer", &answer).expect("handle_answer");
    let _ = add_ice(
        &m,
        "call",
        "peer",
        "candidate:1 1 udp 1 127.0.0.1 1 typ host",
        "0",
    );
    let _ = drain(&m, "call", "peer");
    set_muted(&m, "call", true);
    set_muted(&m, "call", false);
    assert!(stats(&m, "call").is_some(), "stats da sessao existente");
    assert!(
        stats(&m, "outra-call").is_none(),
        "stats de call inexistente"
    );
    hangup(&m, "call");
    assert!(stats(&m, "call").is_none(), "estado limpo apos hangup");
}
