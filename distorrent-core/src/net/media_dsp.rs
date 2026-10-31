//! AEC/supressão de ruído (speexdsp via `aec-rs`) para a voz nativa.
//! Cuidado: `filter_length` é em AMOSTRAS (não existe `tail_length_ms`), e
//! sem a referência correta do speaker o filtro apaga a voz real.

use std::collections::VecDeque;
use std::sync::Mutex;

/// 48 kHz: mesma taxa do resto do pipeline de voz (Opus Voip).
pub const SAMPLE_RATE: u32 = 48_000;
/// 20 ms por quadro.
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize / 1000) * 20; // 960

/// Comprimento do filtro adaptativo: 200 ms cobre a cauda acústica sem inflar CPU.
pub const FILTER_LENGTH_MS: u32 = 200;
/// `filter_length` em amostras — a API real pede amostras.
pub const FILTER_LENGTH: i32 = ((SAMPLE_RATE / 1000) * FILTER_LENGTH_MS) as i32; // 9600

/// Anel de ~1,3 s: absorve jitter entre relógios sem virar latência.
const REF_CAPACITY: usize = SAMPLE_RATE as usize * 13 / 10;

/// Quadros sem referência antes de descartar o filtro (evita apagar voz real
/// por sobre-subtração quando o speaker volta).
const STALE_LIMIT: u32 = 10;

/// Anel de referência do speaker: recebe exatamente os samples do playout,
/// descarta-o-mais-antigo para nunca crescer nem atrasar.
#[derive(Debug)]
pub struct RefRing {
    buf: Mutex<VecDeque<i16>>,
    cap: usize,
}

impl Default for RefRing {
    fn default() -> Self {
        Self::new()
    }
}

impl RefRing {
    pub fn new() -> Self {
        Self {
            buf: Mutex::new(VecDeque::with_capacity(REF_CAPACITY + FRAME_SAMPLES)),
            cap: REF_CAPACITY,
        }
    }

    /// Empurra áudio tocando; lock curtíssimo na thread realtime de playout.
    pub fn push(&self, s: &[i16]) {
        let mut q = self.buf.lock().unwrap_or_else(|e| e.into_inner());
        q.extend(s.iter().copied());
        while q.len() > self.cap {
            q.pop_front();
        }
    }

    /// Retira até `n` amostras; `false` = sem referência, chamador NÃO roda AEC.
    pub fn take(&self, n: usize, out: &mut [i16]) -> bool {
        let mut q = self.buf.lock().unwrap_or_else(|e| e.into_inner());
        if q.len() < n {
            out[..n].fill(0);
            return false;
        }
        for slot in out.iter_mut().take(n) {
            *slot = q.pop_front().unwrap_or(0);
        }
        true
    }

    pub fn available(&self) -> usize {
        self.buf.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn clear(&self) {
        self.buf.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

/// NS desligado por padrão: o risco de apagar a voz local supera o ganho.
pub const DEFAULT_NS: bool = false;

/// Estado do AEC de uma sessão; `Send` seguro pois vive em UM task só.
struct Inner {
    aec: aec_rs::Aec,
}
unsafe impl Send for Inner {}

/// Cancelador de eco + supressao de ruido, por sessao.
pub struct EchoCanceller {
    inner: Option<Inner>,
    ns: bool,
    play_ref: std::sync::Arc<RefRing>,
    playbuf: Vec<i16>,
    out: Vec<i16>,
    starved: u32,
    /// ultimos numeros, so' para diagnostico.
    pub last_starved: bool,
    pub rebuilt: u32,
}

impl EchoCanceller {
    /// `play_ref` = anel do playout; sem AEC (fone) o mic passa intacto.
    pub fn new(play_ref: std::sync::Arc<RefRing>, enabled: bool) -> Self {
        Self::new_opts(play_ref, enabled, DEFAULT_NS)
    }

    /// NS do speexdsp apaga ~43 dB de fala estacionária (medido) — default é off.
    pub fn new_opts(play_ref: std::sync::Arc<RefRing>, enabled: bool, ns: bool) -> Self {
        Self {
            inner: enabled.then(|| Self::make(ns)),
            ns,
            play_ref,
            playbuf: vec![0i16; FRAME_SAMPLES],
            out: vec![0i16; FRAME_SAMPLES],
            starved: 0,
            last_starved: false,
            rebuilt: 0,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.inner.is_some()
    }

    fn make(ns: bool) -> Inner {
        Inner {
            aec: aec_rs::Aec::new(&aec_rs::AecConfig {
                frame_size: FRAME_SAMPLES,
                filter_length: FILTER_LENGTH,
                sample_rate: SAMPLE_RATE,
                enable_preprocess: ns,
            }),
        }
    }

    /// Processa um quadro do mic; sem AEC/referência devolve `mic` intacto.
    pub fn process<'a>(&'a mut self, mic: &'a [i16]) -> &'a [i16] {
        debug_assert_eq!(mic.len(), FRAME_SAMPLES);
        if self.inner.is_none() {
            return mic;
        }

        // Sem referencia suficiente => nao roda o AEC (ver doc de `play_ref`).
        let have = self.play_ref.take(FRAME_SAMPLES, &mut self.playbuf);
        self.last_starved = !have;

        if !have {
            self.starved += 1;
            if self.starved >= STALE_LIMIT {
                // Referência morta: descarta o filtro (estado divergido apagaria a voz).
                self.inner = None;
                self.starved = 0;
                self.rebuilt = 1;
                self.play_ref.clear();
            }
            return mic;
        }
        self.starved = 0;

        let inner = self.inner.as_mut().expect("inneracima do early-return");
        inner.aec.cancel_echo(mic, &self.playbuf, &mut self.out);
        &self.out
    }

    /// Rearma o AEC após referência morta, só quando ela voltar.
    pub fn maybe_rearm(&mut self, enable: bool) {
        if enable && self.inner.is_none() && self.play_ref.available() >= FRAME_SAMPLES {
            self.rebuilt += 1;
            self.starved = 0;
            self.inner = Some(Self::make(self.ns));
        }
    }
}

/// Energia em dBFS. dbfs(&[x]) = 0 para sinal full-scale, negativo para abaixo.
pub fn dbfs(x: &[i16]) -> f64 {
    if x.is_empty() {
        return f64::NEG_INFINITY;
    }
    let acc: f64 = x
        .iter()
        .map(|&v| {
            let n = f64::from(v) / f64::from(i16::MAX);
            n * n
        })
        .sum();
    let rms = (acc / x.len() as f64).sqrt();
    if rms <= 0.0 {
        f64::NEG_INFINITY
    } else {
        20.0 * rms.log10()
    }
}

// ---------------------------------------------------------------- testes

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// Voz sintética realista: sinal harmônico puro trava o filtro e mente
    /// na medição (custou duas rodadas erradas).
    fn voz(n: usize, semente: u32, rms: f32) -> Vec<f32> {
        let mut x = semente | 1;
        let bruto: Vec<f32> = (0..n)
            .map(|_| {
                x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((x >> 8) as f32 / 8_388_608.0) - 1.0
            })
            .collect();
        let env: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 / SAMPLE_RATE as f64;
                let syl = (2.0 * std::f64::consts::PI * 4.0 * t).sin() * 0.5 + 0.5;
                let pausas = if (t * 1.7).fract() < 0.22 { 0.06 } else { 1.0 };
                (syl * pausas) as f32
            })
            .collect();
        let mut out = Vec::with_capacity(n);
        let (mut a1p, mut a1q) = (0.0f32, 0.0f32);
        let (mut b1p, mut b1q) = (0.0f32, 0.0f32);
        let (mut c1p, mut c1q) = (0.0f32, 0.0f32);
        for i in 0..n {
            let t = i as f64 / SAMPLE_RATE as f64;
            let vib = 1.0 + 0.06 * (2.0 * std::f64::consts::PI * 5.0 * t).sin();
            let src = bruto[i] * env[i];
            for (fc, r, which) in [
                (700.0f64, 0.982f32, 0u8),
                (1220.0, 0.975, 1),
                (2600.0, 0.968, 2),
            ] {
                let th = 2.0 * std::f64::consts::PI * fc * vib / SAMPLE_RATE as f64;
                let a1 = 2.0 * r * th.cos() as f32;
                let a2 = -(r * r);
                let _ = (fc, r);
                let v = match which {
                    0 => {
                        let v = src + a1 * a1p + a2 * a1q;
                        a1q = a1p;
                        a1p = v;
                        v
                    }
                    1 => {
                        let v = src + a1 * b1p + a2 * b1q;
                        b1q = b1p;
                        b1p = v;
                        v
                    }
                    _ => {
                        let v = src + a1 * c1p + a2 * c1q;
                        c1q = c1p;
                        c1p = v;
                        v
                    }
                };
                if which == 2 {
                    out.push(v);
                }
            }
        }
        let rms_real = (out.iter().map(|v| v * v).sum::<f32>() / n as f32)
            .sqrt()
            .max(1e-9);
        let g = rms / rms_real;
        out.iter().map(|v| (v * g).clamp(-1.0, 1.0)).collect()
    }

    /// Roda o pipeline AEC; devolve (dBFS antes, dBFS depois) pós-convergência.
    fn medir(usar_aec: bool, delay_ms: usize, eco_gain: f32, quadros: usize) -> (f64, f64) {
        const PULAR: usize = 100; // 2 s para o filtro adaptativo convergir
        let delay = (SAMPLE_RATE as usize / 1000) * delay_ms;
        let total = delay + 2 * FRAME_SAMPLES;
        let mut line = vec![0i16; total];
        let mut w = 0usize;
        let ring = Arc::new(RefRing::new());
        let mut ec = EchoCanceller::new(ring.clone(), usar_aec);

        let n_total = quadros * FRAME_SAMPLES;
        let v_ref = voz(n_total, 0xA5A5_1234, 0.09);

        let (mut antes, mut depois) = (0.0f64, 0.0f64);
        let mut conta = 0usize;
        for q in 0..quadros {
            let mut ref_f = vec![0i16; FRAME_SAMPLES];
            let mut mic_f = vec![0i16; FRAME_SAMPLES];
            for i in 0..FRAME_SAMPLES {
                let idx = q * FRAME_SAMPLES + i;
                ref_f[i] = (v_ref[idx] * i16::MAX as f32) as i16;
                let src = line[(w + i + total - delay) % total];
                line[(w + i) % total] = ref_f[i];
                let e = src as f32 / i16::MAX as f32 * eco_gain;
                mic_f[i] = (e.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            }
            w = (w + FRAME_SAMPLES) % total;
            ring.push(&ref_f);
            let out = ec.process(&mic_f);
            if q >= PULAR {
                antes += dbfs(&mic_f);
                depois += dbfs(out);
                conta += 1;
            }
        }
        let n = conta.max(1) as f64;
        (antes / n, depois / n)
    }

    /// Compara energia antes/depois do AEC com eco atrasado injetado.
    #[test]
    fn aec_reduz_eco_antes_e_depois() {
        const Q: usize = 200; // 4 s
        let (antes, depois) = medir(true, 12, 0.35, Q);
        let reducao = antes - depois;
        println!(
            "\n  === AEC: ANTES {:.2} dBFS | DEPOIS {:.2} dBFS | reducao {:.2} dB ===\n",
            antes, depois, reducao
        );
        // O eco tem de sumir: sem isto o AEC nao esta ligado a nada.
        assert!(
            reducao > 6.0,
            "AEC nao reduziu o eco: ANTES {antes:.2} dBFS, DEPOIS {depois:.2} dBFS"
        );
    }

    /// Sem alto-falante não há eco: mic passa INTACTO (requisito de segurança).
    #[test]
    fn sem_referencia_o_microfone_passa_intacto() {
        let ring = Arc::new(RefRing::new());
        let mut ec = EchoCanceller::new(ring.clone(), true);
        let mic: Vec<i16> = (0..FRAME_SAMPLES)
            .map(|i| ((i as f32 * 0.01).sin() * 12000.0) as i16)
            .collect();
        // sem nenhum push no ring: referencia morta
        let out = ec.process(&mic).to_vec();
        assert_eq!(out, mic, "sem referencia o microfone nao pode ser alterado");
        assert!(
            ec.last_starved,
            "deveria ter registrado frames sem referencia"
        );
    }

    /// AEC desligado (fone de ouvido) = pass-through exato, sem custo de CPU.
    #[test]
    fn desligado_e_pass_through() {
        let ring = Arc::new(RefRing::new());
        ring.push(&vec![1000i16; FRAME_SAMPLES * 20]);
        let mut ec = EchoCanceller::new(ring.clone(), false);
        assert!(!ec.is_enabled());
        let mic: Vec<i16> = (0..FRAME_SAMPLES)
            .map(|i| (i as i16).wrapping_mul(3))
            .collect();
        assert_eq!(ec.process(&mic), &mic[..]);
    }

    /// Ring: push/take, descarte-do-mais-antigo e ausencia de referencia.
    #[test]
    fn ring_de_referencia() {
        let r = RefRing::new();
        let mut buf = vec![0i16; FRAME_SAMPLES];

        // ring vazio => take falha e devolve silencio (nada de lixo antigo)
        assert!(!r.take(FRAME_SAMPLES, &mut buf));
        assert!(buf.iter().all(|&v| v == 0));

        r.push(&vec![7i16; FRAME_SAMPLES]);
        assert!(r.take(FRAME_SAMPLES, &mut buf));
        assert!(buf.iter().all(|&v| v == 7));
        assert_eq!(r.available(), 0);

        // encher alem da capacidade nao cresce (latencia nao explode)
        for _ in 0..40 {
            r.push(&vec![1i16; FRAME_SAMPLES]);
        }
        assert!(r.available() <= REF_CAPACITY, "ring estourou a capacidade");
    }

    /// Referência morta longa descarta o filtro (evita overdelete na volta).
    #[test]
    fn referencia_morta_descarta_o_filtro() {
        let ring = Arc::new(RefRing::new());
        let mut ec = EchoCanceller::new(ring.clone(), true);
        let mic = vec![100i16; FRAME_SAMPLES];
        // so referencia no primeiro quadro, depois nada
        ring.push(&vec![0i16; FRAME_SAMPLES]);
        for _ in 0..(STALE_LIMIT + 2) {
            ec.process(&mic);
        }
        assert!(
            ec.rebuilt > 0,
            "o filtro deveria ter sido descartado apos referencia morta"
        );
        // e volta a passar o microfone intacto ate a referencia voltar
        let out = ec.process(&mic).to_vec();
        assert_eq!(out, mic);
    }

    /// dbfs: full-scale ~ 0 dB, silencio = -infinito.
    #[test]
    fn dbfs_basico() {
        assert!((dbfs(&[i16::MAX; 100]) - 0.0).abs() < 0.01);
        assert!(dbfs(&[0i16; 100]).is_infinite() && dbfs(&[0i16; 100]) < 0.0);
    }
}
