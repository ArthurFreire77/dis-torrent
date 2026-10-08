//! Exercita câmera/tela Linux reais, GStreamer, SDP e RTP entre dois peers locais.
//!
//! É ignorado no CI porque requer webcam V4L2 e plugins GStreamer. Para rodar
//! numa máquina com câmera: `cargo test --test media_voice_video_hardware -- --ignored --nocapture`.

#![cfg(target_os = "linux")]

use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use forge_core::net::media_voice::{OutboundSignal, VoiceMedia};

const A: &str = "hardware-test-peer-a";
const B: &str = "hardware-test-peer-b";
static HARDWARE_TEST_LOCK: Mutex<()> = Mutex::new(());

fn exchange_ice(call_id: &str, from: &VoiceMedia, from_peer: &str, to: &VoiceMedia, to_peer: &str) {
    for signal in from.drain_outbound(call_id, from_peer) {
        if let OutboundSignal::Ice { candidate, mid } = signal {
            if !candidate.is_empty() {
                to.add_ice_candidate(call_id, to_peer, &candidate, &mid)
                    .expect("aplicar candidato ICE local");
            }
        }
    }
}

fn run_video_round(sender: &VoiceMedia, receiver: &VoiceMedia, call_id: &str, source: &str) {
    let offer = sender
        .create_offer(call_id, B)
        .expect("criar offer com áudio e vídeo");
    assert!(offer.contains("m=audio"), "offer sem m-line de áudio");
    assert!(offer.contains("m=video"), "offer sem m-line de vídeo");
    let answer = receiver
        .handle_offer(call_id, A, &offer)
        .expect("responder offer");
    sender
        .handle_answer(call_id, B, &answer)
        .expect("aplicar answer remoto");

    let connect_deadline = Instant::now() + Duration::from_secs(20);
    loop {
        exchange_ice(call_id, sender, B, receiver, A);
        exchange_ice(call_id, receiver, A, sender, B);
        let a_connected = sender
            .stats_peer(call_id, B)
            .is_some_and(|stats| stats.state == "connected");
        let b_connected = receiver
            .stats_peer(call_id, A)
            .is_some_and(|stats| stats.state == "connected");
        if a_connected && b_connected {
            break;
        }
        assert!(Instant::now() < connect_deadline, "ICE local não conectou");
        thread::sleep(Duration::from_millis(50));
    }

    sender
        .video_start(call_id, B, source, None)
        .unwrap_or_else(|e| panic!("iniciar captura real ({source}): {e}"));
    let frame_deadline = Instant::now() + Duration::from_secs(20);
    loop {
        exchange_ice(call_id, sender, B, receiver, A);
        exchange_ice(call_id, receiver, A, sender, B);
        if let Some(frame) = receiver.video_frame(call_id, A) {
            assert!(
                frame.w > 0 && frame.h > 0,
                "frame decodificado sem dimensões"
            );
            assert!(!frame.jpeg.is_empty(), "frame decodificado sem JPEG");
            break;
        }
        let stats = sender.stats_peer(call_id, B).expect("stats do emissor");
        assert_ne!(
            stats.video_state.as_deref(),
            Some("failed"),
            "{source} falhou: {stats:?}"
        );
        assert!(
            Instant::now() < frame_deadline,
            "o peer remoto não recebeu frames; emissor={stats:?}; receptor={:?}",
            receiver.stats_peer(call_id, A)
        );
        thread::sleep(Duration::from_millis(50));
    }

    sender.hangup(call_id);
    receiver.hangup(call_id);
    assert!(
        sender.stats_peer(call_id, B).is_none(),
        "emissor não liberou a sessão"
    );
    assert!(
        receiver.stats_peer(call_id, A).is_none(),
        "receptor não liberou a sessão"
    );
}

#[test]
#[ignore = "requires an accessible V4L2 camera and GStreamer video plugins"]
fn native_camera_reaches_the_remote_peer_as_decoded_frames() {
    let _serial = HARDWARE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let sender = VoiceMedia::new().expect("criar motor de mídia do emissor");
    let receiver = VoiceMedia::new().expect("criar motor de mídia do receptor");
    for round in 0..3 {
        run_video_round(
            &sender,
            &receiver,
            &format!("native-camera-hardware-test-{round}"),
            "camera",
        );
    }
}

#[test]
#[ignore = "requires an active X11 desktop and GStreamer video plugins"]
fn native_x11_screen_capture_reaches_the_remote_peer_as_decoded_frames() {
    let _serial = HARDWARE_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let sender = VoiceMedia::new().expect("criar motor de mídia do emissor");
    let receiver = VoiceMedia::new().expect("criar motor de mídia do receptor");
    run_video_round(
        &sender,
        &receiver,
        "native-x11-screen-hardware-test",
        "screen",
    );
}
