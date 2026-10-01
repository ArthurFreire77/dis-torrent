//! Mede o AEC: ANTES e DEPOIS, e prova que a voz NAUTIL (near-end) sobrevive.
//!
//! Usa o arquivo de PRODUCAO via `#[path]`, nao uma copia.

#[path = "../../forge-core/src/net/media_dsp.rs"]
mod media_dsp;

use media_dsp::*;
use std::sync::Arc;

const PULAR: usize = 150; // 3 s de convergencia do filtro adaptativo

/// Fonte-filtro de voz: ruido -> 3 formantes ressonantes, envelope silabico
/// com PAUSAS, normalizado no RMS pedido.
///
/// Duas versoes ruins aconteceram aqui e ambasinflaram o numero:
///  1) harmonicos puros (mesmo gerador da referencia): patologico, o filtro
///     adaptativo trava e "voz apagada" era artefato do TESTE;
///  2) voz broadband sem normalizar, batendo em -16 dBFS com clipping:
///     o AEC DIVERGE (972 resets) e a saida vira silencio.
/// Voz real e' broadband, NAO-estacionaria, com pauses e RMS de -25 dBFS.
fn voz_real(n: usize, semente: u32, rms_alvo: f32) -> Vec<f32> {
    let mut x: u32 = semente | 1;
    let mut bruto = Vec::with_capacity(n);
    for _ in 0..n {
        x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        bruto.push(((x >> 8) as f32 / 8_388_608.0) - 1.0);
    }
    // envelope silabico (~4 Hz) com pausas; a fala real nao e' continua
    let env: Vec<f32> = (0..n)
        .map(|i| {
            let t = i as f64 / SAMPLE_RATE as f64;
            let syl = (2.0 * std::f64::consts::PI * 4.0 * t).sin() * 0.5 + 0.5;
            let pausas = if (t * 1.7).fract() < 0.22 { 0.06 } else { 1.0 };
            (syl * pausas) as f32
        })
        .collect();
    // 3 ressonadores em serie, formantesmoveis
    let mut saida = Vec::with_capacity(n);
    let (mut y1a, mut y2a) = (0.0f32, 0.0f32);
    let (mut y1b, mut y2b) = (0.0f32, 0.0f32);
    let (mut y1c, mut y2c) = (0.0f32, 0.0f32);
    for i in 0..n {
        let t = i as f64 / SAMPLE_RATE as f64;
        let vib = 1.0 + 0.06 * (2.0 * std::f64::consts::PI * 5.0 * t).sin();
        let src = bruto[i] * env[i];
        let mut y = 0.0f32;
        for (fc, r) in [(700.0f64, 0.982f32), (1220.0, 0.975), (2600.0, 0.968)] {
            let th = 2.0 * std::f64::consts::PI * fc * vib / SAMPLE_RATE as f64;
            let a1 = 2.0 * r * th.cos() as f32;
            let a2 = -(r * r);
            let _ = (fc, r);
            y = match fc as u32 {
                700 => { let v = src + a1 * y1a + a2 * y2a; y2a = y1a; y1a = v; v }
                1220 => { let v = src + a1 * y1b + a2 * y2b; y2b = y1b; y1b = v; v }
                _ => { let v = src + a1 * y1c + a2 * y2c; y2c = y1c; y1c = v; v }
            };
        }
        saida.push(y);
    }
    // normaliza no RMS alvo (sem clipping duro)
    let rms = (saida.iter().map(|v| v * v).sum::<f32>() / n as f32).sqrt().max(1e-9);
    let g = rms_alvo / rms;
    saida.iter().map(|v| (v * g).clamp(-1.0, 1.0)).collect()
}

/// Correlacao normalizada no lag ZERO (pega quanto do eco sobrou).
fn correlacao0(a: &[i16], b: &[i16], lag: i64) -> f64 {
    let n = a.len().min(b.len());
    let (mut sa, mut sb, mut sab) = (0.0f64, 0.0f64, 0.0f64);
    for i in 0..n {
        let j = i as i64 + lag;
        if j < 0 || j as usize >= n { continue; }
        let (x, y) = (f64::from(a[i]), f64::from(b[j as usize]));
        sa += x * x; sb += y * y; sab += x * y;
    }
    if sa <= 0.0 || sb <= 0.0 { return 0.0; }
    sab / (sa.sqrt() * sb.sqrt())
}

fn correlacao(a: &[i16], b: &[i16]) -> f64 {
    correlacao0(a, b, 0)
}

#[derive(Default)]
struct Metricas {
    mic_db: f64, out_db: f64,
    c_mic_eco: f64, c_out_eco: f64,
    c_mic_falante: f64, c_out_falante: f64,
}

/// `eco_gain`: quanto do playout volta no microfone.
/// `falante`: amplitude da fala local (near-end), que o AEC nao pode apagar.
fn rodar(usar_aec: bool, delay_ms: usize, eco_gain: f32, falante: f32, ns: bool, quadros: usize) -> Metricas {
    let delay = (SAMPLE_RATE as usize / 1000) * delay_ms;
    let total = delay + 2 * FRAME_SAMPLES;
    let mut line = vec![0i16; total];
    let mut w = 0usize;
    let ring = Arc::new(RefRing::new());
    let mut ec = EchoCanceller::new_opts(ring.clone(), usar_aec, ns);
    let mut m = Metricas::default();
    let mut conta = 0usize;

    // playout = voz do PAR remoto; near-end = voz do usuario local (independente)
    let total_n = quadros * FRAME_SAMPLES;
    let v_ref = voz_real(total_n, 0xA5A5_1234, 0.09); // -21 dBFS
    let v_near = voz_real(total_n, 0x1357_9BDF, 0.05); // -26 dBFS

    for q in 0..quadros {
        let mut ref_f = vec![0i16; FRAME_SAMPLES];
        let mut mic_f = vec![0i16; FRAME_SAMPLES];
        let mut eco_f = vec![0i16; FRAME_SAMPLES];
        let mut voz_f = vec![0i16; FRAME_SAMPLES];

        for i in 0..FRAME_SAMPLES {
            let idx = q * FRAME_SAMPLES + i;
            ref_f[i] = (v_ref[idx] * i16::MAX as f32) as i16;

            let src = line[(w + i + total - delay) % total];
            line[(w + i) % total] = ref_f[i];

            let e = src as f32 / i16::MAX as f32 * eco_gain;
            let f = v_near[idx] * falante;
            let ruido = (((i as f32 * 12.9898).sin() * 43758.5453).fract()) * 0.0005;

            eco_f[i] = (e.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            voz_f[i] = (f.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            mic_f[i] = ((e + f + ruido).clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        }
        w = (w + FRAME_SAMPLES) % total;

        ring.push(&ref_f);
        let out = ec.process(&mic_f);
        if q >= PULAR {
            m.mic_db += dbfs(&mic_f);
            m.out_db += dbfs(out);
            m.c_mic_eco += correlacao(&mic_f, &eco_f);
            m.c_out_eco += correlacao(out, &eco_f);
            m.c_mic_falante += correlacao(&mic_f, &voz_f);
            m.c_out_falante += correlacao(out, &voz_f);
            conta += 1;
        }
    }
    let n = conta.max(1) as f64;
    m.mic_db /= n; m.out_db /= n;
    m.c_mic_eco /= n; m.c_out_eco /= n;
    m.c_mic_falante /= n; m.c_out_falante /= n;
    m
}

fn cenario(delay_ms: usize, eco_gain: f32, falante: f32, ns: bool, label: &str) {
    let m = rodar(true, delay_ms, eco_gain, falante, ns, 500);
    println!("--- {} | eco {:.2} | fala local {:.2} | NS {} ---",
        label, eco_gain, falante, if ns { "ON " } else { "OFF" });
    println!("  ENERGIA ANTES (sem AEC) : {:>9.2} dBFS", m.mic_db);
    println!("  ENERGIA DEPOIS(com AEC) : {:>9.2} dBFS", m.out_db);
    println!("  >> ERLE (reducao de eco) : {:>9.2} dB", m.mic_db - m.out_db);
    println!("  >> corr c/ ECO  : {:>6.3} -> {:>6.3}   (0 = eco eliminado)", m.c_mic_eco, m.c_out_eco);
    println!("  >> corr c/ FALA : {:>6.3} -> {:>6.3}   (alto = fala preservada)", m.c_mic_falante, m.c_out_falante);
    println!();
}

fn main() {
    println!("=================================================================");
    println!(" AEC — cancelamento de eco + supressao de ruido");
    println!(" codigo medido: forge-core/src/net/media_dsp.rs (via #[path])");
    println!(" frame={} | taxa={} Hz | filtro={} ms = {} amostras",
        FRAME_SAMPLES, SAMPLE_RATE, FILTER_LENGTH_MS, FILTER_LENGTH);
    println!(" janela: 3 s..10 s (filtro adaptativo ja convergiu)");
    println!("=================================================================\n");

    println!("### 1. CAIXA DE SOM — so eco (caso classico)\n");
    cenario(12, 0.35, 0.0, false, "caixa de som");

    println!("### 2. CAIXA + SALA — eco maior e mais atrasado\n");
    cenario(25, 0.50, 0.0, false, "caixa + sala");

    println!("### 3. FONE / MESA — eco fraco\n");
    cenario(6, 0.20, 0.0, false, "fone/mesa");

    println!("### 4. DUPLEX — eco + fala local: a fala tem de SOBREVIVER\n");
    cenario(12, 0.35, 1.0, false, "fala + eco");
    cenario(25, 0.50, 1.0, false, "fala + eco forte");
    cenario(12, 0.35, 1.0, true, "fala + eco");

    println!("### 5. SEM ECO — so a voz local (pior caso)\n");
    cenario(12, 0.00, 1.0, false, "so fala, sem eco");
    cenario(12, 0.00, 1.0, true,  "so fala, sem eco");

    // --------------------------------------------------------------- CPU
    println!("### 6. CUSTO DE CPU POR QUADRO (20 ms de audio a 48 kHz)\n");
    let casos: [(bool, &str); 2] = [(false, "sem AEC (pass-through)"), (true, "com AEC (filtro 200 ms)")];
    for (rot, rotulo) in casos.into_iter().collect::<Vec<_>>() {
        let ring = Arc::new(RefRing::new());
        let mut ec = EchoCanceller::new_opts(ring.clone(), rot, rot);
        let mut mic = vec![3000i16; FRAME_SAMPLES];
        for i in 0..FRAME_SAMPLES { mic[i] = ((i as f32 * 0.05).sin() * 8000.0) as i16; }
        let mut ref_f = vec![0i16; FRAME_SAMPLES];
        for i in 0..FRAME_SAMPLES { ref_f[i] = ((i as f32 * 0.03).cos() * 6000.0) as i16; }
        // aquece
        for _ in 0..50 { ring.push(&ref_f); let _ = ec.process(&mic); }
        let n = 1000;
        let t0 = std::time::Instant::now();
        for _ in 0..n { ring.push(&ref_f); let _ = ec.process(&mic); }
        let d = t0.elapsed();
        let por_quadro = d.as_secs_f64() * 1000.0 / n as f64;
        println!("  {:<30} {:>7.3} ms/quadro  => {:>5.1}% de um deadline de 20 ms",
            rotulo, por_quadro, por_quadro / 20.0 * 100.0);
    }
    println!("\nFIM");
}
