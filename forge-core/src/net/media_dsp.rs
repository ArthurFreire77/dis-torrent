//! Cancelamento de eco acustico (AEC) e supressao de ruido para a voz nativa.
//!
//! AEC = "o microfone hears the speaker". Sem isto, com caixa de som, o par do
//! outro lado ouve a sua propria voz com atraso. E' o que mais pesa para a voz
//! nativa "se comportar como o Discord".
//!
//! ## O que a API do speexdsp REALMENTE e' (lida na fonte, nao adivinhada)
//!
//! A especificacao original citava `echo_ctl(..., SetSize, 200)`,
//! `filter_length_ms` e `tail_length_ms`. **Nenhum desses existe.** A API real
//! do speexdsp e':
//!
//! ```c
//! SpeexEchoState *speex_echo_state_init(int frame_size, int filter_length);
//! void speex_echo_cancellation(SpeexEchoState*, const spx_int16_t *rec,
//!                              const spx_int16_t *play, spx_int16_t *out);
//! int  speex_echo_ctl(SpeexEchoState*, int request, void *ptr);
//! ```
//!
//! - `filter_length` e' em **AMOSTRAS**, nao ms. Nao existe `tail_length_ms`:
//!   o "tamanho do eco" e' unico e e' esse `filter_length`. O retardo que o
//!   filtro ainda alcanca e' derivado dele, e o unico ajuste fino disponivel.
//! - `rec` = microfone (o sinal com o eco), `play` = REFERENCIA (o que o
//!   alto-falante esta tocando). Sem `play` correto o filtro adaptativo aprende
//!   a prever a sua voz real e a apaga — por isso `EchoCanceller` abaixo so
//!   roda o AEC quando a referencia esta de fato chegando (ver `STALE_LIMIT`).
//!
//! `aec-rs` -> `aec-rs-sys`, que **traz o codigo C do speexdsp e compila com
//! cmake**. O crate `speexdsp` da crates.io so expoe o resampler, e o
//! `speexdsp-sys` original exige `libspeexdsp-dev` + pkg-config + bindgen
//! (indisponivel aqui sem root). Por isso `aec-rs`, e nao `speexdsp`.

use std::collections::VecDeque;
use std::sync::Mutex;

/// 48 kHz: mesma taxa do resto do pipeline de voz (Opus Voip).
pub const SAMPLE_RATE: u32 = 48_000;
/// 20 ms por quadro.
pub const FRAME_SAMPLES: usize = (SAMPLE_RATE as usize / 1000) * 20; // 960

/// Comprimento do filtro adaptativo, em ms.
///
/// O manual do speexdsp pede 100–500 ms. Abaixo de ~100 ms o filtro nao cobre
/// a cauda acustica (alto-falante + caixa + microfone). 200 ms fica no meio da
/// faixa: cabe o eco de uma caixa de som comum sem inflar a CPU.
pub const FILTER_LENGTH_MS: u32 = 200;
/// `filter_length` em amostras — a API real pede amostras.
pub const FILTER_LENGTH: i32 = ((SAMPLE_RATE / 1000) * FILTER_LENGTH_MS) as i32; // 9600

/// Capacidade do anel de referencia: ~1,3 s de audio. Ampla o bastante para
/// absorver jitter entre os dois streams (48 kHz em relogios independentes),
/// curta o bastante para que um ring buffer estourado nao vire latencia.
const REF_CAPACITY: usize = SAMPLE_RATE as usize * 13 / 10;

/// Quadros consecutivos sem referencia ANTES de jogar fora o filtro adaptativo.
///
/// Enquanto nao chega referencia, o filtro fica "olhando" um silencio que nao
/// existe no alto-falante. Depois de ~200 ms (10 quadros) de Reference, ele ja
/// teria adaptado para o silencio; quando o alto-falante volta, os primeiros
/// quadros podem suffering de sobre-subtracao — e sobre-subtracao e' exatamente
/// o modo de falha que "apaga a voz real". Descartar o estado e' mais honesto
/// que tentar adivinhar.
const STALE_LIMIT: u32 = 10;

/// Anel de referencia do alto-falante.
///
/// Alimentado pelo callback de playout com **exatamente** os samples que
/// foram escritos no device, e lido pelo envio a 48 kHz. Descarte-do-mais-
/// antigo: se os dois relogios derivarem, o anel nunca cresce (latencia) e
/// sempre contem o audio mais recente, que e' o que o filtro precisa.
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

    /// Empurra audio tocando. Chamado na thread realtime de playout: o lock e'
    /// tomado por poucos microssegundos e nunca se mantem em espera.
    pub fn push(&self, s: &[i16]) {
        let mut q = self.buf.lock().unwrap_or_else(|e| e.into_inner());
        q.extend(s.iter().copied());
        while q.len() > self.cap {
            q.pop_front();
        }
    }

    /// Retira ate `n` amostras. Devolve `false` se nao havia referencia
    /// suficiente — o chamador entao NAO roda o AEC.
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

/// Supressao de ruido ligada por padrao?
///
/// `false`: o AEC faz o trabalho dele e o ruido de sala segue para o par, que
/// e' o preco de nunca apagar a voz local. Ver `new_opts`.
pub const DEFAULT_NS: bool = false;

/// Estado do AEC de UMA sessao.
///
/// `aec_rs::Aec` guarda ponteiro cru (`*mut SpeexEchoState`) e portanto nao e'
/// `Send`. O `Send` e' declarado aqui porque o objeto e' movido para dentro de
/// UM unico task de envio e nunca e' compartilhado entre tasks: nao ha como dois
/// threads chamem `cancel_echo` ao mesmo tempo.
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
    /// `play_ref` e' o anel alimentado pelo playout. `enabled=false` deixa o
    /// microfone passar intacto (fones de ouvido: nao ha eco acustico para
    /// cancelar, e o filtro so custaria CPU e risco).
    pub fn new(play_ref: std::sync::Arc<RefRing>, enabled: bool) -> Self {
        Self::new_opts(play_ref, enabled, DEFAULT_NS)
    }

    /// `ns` = preprocessor do speexdsp (supressao de ruido).
    ///
    /// MEDICAO IMPORTANTE: ligado, ele treats um sinal de voz *estacionario*
    /// como ruido e apaga ~43 dB da fala local (ver aec-probe, cenario 5).
    /// Voz real e' nao-estacionaria e sofre menos, mas o caso e' grave demais
    /// para deixar ligado sem prova. `DEFAULT_NS` decide o que entra no
    /// binario; ver o relatorio.
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

    /// Processa um quadro do microfone.
    ///
    /// Retorna o audio a enviar. Sem AEC, ou sem referencia, devolve `mic`
    /// intacto — nunca silencio, nunca metade do sinal.
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
                // Referencia morreu (alto-falante fechado, call encerrada):
                // joga o filtro fora em vez de manter um estado divergido.
                self.inner = None;
                self.starved = 0;
                self.rebuilt = 1;
                self.play_ref.clear();
            }
            return mic;
        }
        self.starved = 0;

        let inner = self.inner.as_mut().expect("inneracima do early-return");
        inner
            .aec
            .cancel_echo(mic, &self.playbuf, &mut self.out);
        &self.out
    }

    /// Tenta religar o AEC depois de uma referencia morta. Chamado pelo loop de
    /// envio; so' o rebuilda se ja houver referencia de novo.
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
    let acc: f64 = x.iter().map(|&v| {
        let n = f64::from(v) / f64::from(i16::MAX);
        n * n
    }).sum();
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

    /// Voz sintética: ruido -> 3 formantes, com pausas, normalizada.
    ///
    /// Sinal harmônico puro e' PATOLOGICO para um filtro adaptativo: ele trava
    /// e o resultado da medicao mente. Isso custou duas rodadas de medicao
    /// errada antes de o gerador ficar realista.
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
            for (fc, r, which) in [(700.0f64, 0.982f32, 0u8), (1220.0, 0.975, 1), (2600.0, 0.968, 2)] {
                let th = 2.0 * std::f64::consts::PI * fc * vib / SAMPLE_RATE as f64;
                let a1 = 2.0 * r * th.cos() as f32;
                let a2 = -(r * r);
                let _ = (fc, r);
                let v = match which {
                    0 => { let v = src + a1 * a1p + a2 * a1q; a1q = a1p; a1p = v; v }
                    1 => { let v = src + a1 * b1p + a2 * b1q; b1q = b1p; b1p = v; v }
                    _ => { let v = src + a1 * c1p + a2 * c1q; c1q = c1p; c1p = v; v }
                };
                if which == 2 { out.push(v); }
            }
        }
        let rms_real = (out.iter().map(|v| v * v).sum::<f32>() / n as f32).sqrt().max(1e-9);
        let g = rms / rms_real;
        out.iter().map(|v| (v * g).clamp(-1.0, 1.0)).collect()
    }

    /// Roda o pipeline inteiro. Devolve (energia media ANTES, energia media
    /// DEPOIS) em dBFS, medidos so depois da convergencia do filtro.
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

    /// O teste pedido: toca uma referencia, devolve o microfone com esse eco
    /// atrasado, e compara a energia ANTES e DEPOIS do AEC.
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

    /// Sem alto-falante nao ha eco acustico: o microfone passa INTACTO.
    /// E' o requisito "pular com seguranca quando nao ha alto-falante".
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
        assert!(ec.last_starved, "deveria ter registrado frames sem referencia");
    }

    /// AEC desligado (fone de ouvido) = pass-through exato, sem custo de CPU.
    #[test]
    fn desligado_e_pass_through() {
        let ring = Arc::new(RefRing::new());
        ring.push(&vec![1000i16; FRAME_SAMPLES * 20]);
        let mut ec = EchoCanceller::new(ring.clone(), false);
        assert!(!ec.is_enabled());
        let mic: Vec<i16> = (0..FRAME_SAMPLES).map(|i| (i as i16).wrapping_mul(3)).collect();
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

    /// Referencia morta por muito tempo descarta o filtro adaptativo, para um
    /// estado divergido nunca overdeletar a voz quando o alto-falante volta.
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
