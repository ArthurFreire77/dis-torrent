//! Probe de MEDICAO REAL da captura de midia nativa (Linux).
//!
//! Nao e teste de unidade: liga o dispositivo de verdade e imprime o que
//! aconteceu. Existe para responder, com numero, "por que a chamada nativa
//! nao captura audio/camera/tela nesta maquina?".
//!
//!   cargo run --example media_probe

use forge_core::net::media_video::{self, VideoCodec};
use forge_core::net::media_voice::VoiceMedia;
use std::time::{Duration, Instant};

fn main() {
    extra();
    println!("=== 1. VOZ NATIVA (cpal / PipeWire) ===");
    match VoiceMedia::new() {
        Ok(v) => {
            let h = forge_core::net::media_voice::audio::hub();
            // 1a: abertura preguicosa, como o app faz no invite/accept.
            v.retry_mic();
            println!(
                "  retry_mic()            = has_capture={} err={:?}",
                v.has_capture(),
                h.mic_error()
            );
            println!("  mic_name()             = {}", h.mic_name());
            println!("  has_speaker()          = {}", h.has_speaker());
            // 2a: o microfone ENTREGA samples? (sem subs o callback descarta.)
            match h.subscribe() {
                Ok((id, mut rx)) => {
                    let t0 = Instant::now();
                    let mut frames = 0usize;
                    let mut loud = 0usize;
                    while t0.elapsed() < Duration::from_secs(3) {
                        match rx.try_recv() {
                            Ok(f) => {
                                frames += 1;
                                let peak = f.pcm.iter().fold(0i16, |m, s| m.max(s.abs()));
                                if peak > 300 {
                                    loud += 1;
                                }
                            }
                            Err(_) => std::thread::sleep(Duration::from_millis(20)),
                        }
                    }
                    h.unsubscribe(id);
                    println!(
                        "  MIC 3s                 = {frames} frames, {loud} com sinal -> {}",
                        if loud > 0 {
                            "CAPTURANDO"
                        } else {
                            "SILENCIO TOTAL"
                        }
                    );
                }
                Err(e) => println!("  subscribe()            = ERRO: {e}"),
            }
            // 3a: garante a abertura (ensure_mic direto) e repete a medicao.
            let _ = h.ensure_mic();
            println!("  ensure_mic()           = has_capture={}", v.has_capture());
            // Alto-falante: o build_session chama ensure_speaker (falha nao impede).
            match h.ensure_speaker() {
                Ok(()) => println!("  ensure_speaker()       = OK (has_speaker=true)"),
                Err(e) => println!("  ensure_speaker()       = ERRO: {e}"),
            }
        }
        Err(e) => println!("  VoiceMedia::new()      = ERRO: {e}"),
    }

    println!("\n=== 2. CAMERA (v4l2) ===");
    for fps in [30u32, 15] {
        println!("  --- fps={fps}");
        match media_video::new_camera(VideoCodec::Vp8, fps) {
            Ok(mut enc) => {
                let t0 = Instant::now();
                let mut got = 0usize;
                while t0.elapsed() < Duration::from_secs(3) {
                    if enc.poll_encoded_frame(Duration::from_millis(100)).is_some() {
                        got += 1;
                    }
                }
                let fps = got as f64 / t0.elapsed().as_secs_f64();
                println!("      {got} frames em 3s = {fps:.1} fps");
                if got == 0 {
                    println!("      take_error()      = {:?}", enc.take_error());
                }
                enc.stop();
            }
            Err(e) => println!("      new_camera()      = ERRO: {e}"),
        }
    }

    println!("\n=== 3. TELA (xcap) ===");
    match xcap::Monitor::all() {
        Ok(mons) => {
            println!("  monitores = {}", mons.len());
            for m in &mons {
                println!(
                    "    id={:?} name={:?} primary={:?} {}x{}",
                    m.id(),
                    m.name(),
                    m.is_primary(),
                    m.width().unwrap_or(0),
                    m.height().unwrap_or(0)
                );
            }
        }
        Err(e) => println!("  Monitor::all() = ERRO: {e}"),
    }
    match media_video::grab_screen_frame(None) {
        Some((rgb, w, h)) => {
            let nonzero = rgb.iter().filter(|b| **b != 0).count();
            println!(
                "  grab_screen_frame()   = OK {w}x{h} ({} bytes RGB, {} nao-zero)",
                rgb.len(),
                nonzero
            );
        }
        None => println!("  grab_screen_frame()   = None (falhou)"),
    }
    // O caminho de PRODUCAO da tela: encoder alimentado pelo xcap.
    match media_video::new_screen(VideoCodec::Vp8, 30) {
        Ok(mut enc) => {
            let t0 = Instant::now();
            let mut pushed = 0usize;
            let mut got = 0usize;
            while t0.elapsed() < Duration::from_secs(4) {
                if !enc.self_feeding() {
                    if let Some((rgb, w, hh)) = media_video::grab_screen_frame(None) {
                        if enc.push_screen_frame(&rgb, w, hh).is_ok() {
                            pushed += 1;
                        }
                    }
                }
                while enc.poll_encoded_frame(Duration::from_millis(1)).is_some() {
                    got += 1;
                }
                // sem sleep: mede o teto real do encoder (o laco de envio real
                // tem 33 ms de passo = 30 fps).
            }
            println!(
                "  encoder de tela       = {pushed} empurrados, {got} VP8 saida = {:.1} fps",
                got as f64 / t0.elapsed().as_secs_f64()
            );
            enc.stop();
        }
        Err(e) => println!("  new_screen()          = ERRO: {e}"),
    }
}

#[allow(dead_code)]
fn extra() {
    // Custo isolado de cada etapa da captura de tela.
    let mons = xcap::Monitor::all().expect("sem monitores");
    let m = mons
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .unwrap_or(&mons[0]);
    println!(
        "monitor: {:?} {}x{}",
        m.name(),
        m.width().unwrap_or(0),
        m.height().unwrap_or(0)
    );

    let t0 = Instant::now();
    let mut ok = 0usize;
    let mut bytes = 0usize;
    while t0.elapsed() < Duration::from_secs(3) {
        if let Ok(img) = m.capture_image() {
            ok += 1;
            bytes += img.as_raw().len();
        }
    }
    let el = t0.elapsed().as_secs_f64();
    println!(
        "XCAP capture_image puro: {ok} em {el:.1}s = {:.2} fps ({} bytes/frame)",
        ok as f64 / el,
        bytes / ok.max(1)
    );

    // Custo do resize (1920x1080 -> 640x480) sobre um frame REAL.
    let img = m.capture_image().expect("sem frame");
    let t0 = Instant::now();
    let mut n = 0usize;
    while t0.elapsed() < Duration::from_secs(1) {
        let small = image::imageops::resize(&img, 640, 480, image::imageops::FilterType::Triangle);
        std::hint::black_box(&small);
        n += 1;
    }
    println!("RESIZE 1920x1080->640x480: {n} em 1s = {n} fps");

    // E com o filtro Nearest (mais barato)?
    let t0 = Instant::now();
    let mut n = 0usize;
    while t0.elapsed() < Duration::from_secs(1) {
        let small = image::imageops::resize(&img, 640, 480, image::imageops::FilterType::Nearest);
        std::hint::black_box(&small);
        n += 1;
    }
    println!("RESIZE Nearest: {n} em 1s = {n} fps");
}
