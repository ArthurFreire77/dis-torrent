use std::sync::Arc;

use super::media_voice::audio::{hub, PcmFrame, FRAME_SAMPLES};

/// Quantos frames de 20 ms cabem na fila antes de descartar os mais velhos.
///
/// 250 frames = 5 s. Sem teto, um bot que empurra mais rápido do que o alto-
/// falante consome cresce a memória sem limite (e o som atrasa cada vez mais).
pub const MAX_QUEUE_FRAMES: usize = 250;

/// Id do inbox de música deste bot. `None` = nenhum áudio tocando.
pub struct MusicSink {
    inbox_id: u64,
    dropped: u64,
}

/// Abre um canal de música. O chamador é dono do id e precisa de `close`.
pub fn open() -> MusicSink {
    MusicSink {
        inbox_id: hub().register_inbox(),
        dropped: 0,
    }
}

impl MusicSink {
    pub fn inbox_id(&self) -> u64 {
        self.inbox_id
    }

    /// Quantos frames foram descartados por fila cheia (backpressure visível).
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Enfileira PCM i16 mono 48 kHz. `pcm` é cortado em frames de 20 ms.
    ///
    /// Devolve quantos frames entraram e quantos caíram.
    pub fn push_pcm(&mut self, pcm: &[i16]) -> (usize, usize) {
        let Some(inbox) = hub().inbox(self.inbox_id) else {
            return (0, 1);
        };
        let mut q = inbox.lock().unwrap_or_else(|e| e.into_inner());
        let mut accepted = 0usize;
        let mut dropped = 0usize;
        for chunk in pcm.chunks(FRAME_SAMPLES) {
            while q.len() >= MAX_QUEUE_FRAMES {
                q.pop_front();
                dropped += 1;
            }
            let mut frame = chunk.to_vec();
            frame.resize(FRAME_SAMPLES, 0);
            q.push_back(PcmFrame {
                pcm: Arc::new(frame),
                id: None,
            });
            accepted += 1;
        }
        self.dropped = self.dropped.saturating_add(dropped as u64);
        (accepted, dropped)
    }

    /// Silencia sem fechar o canal (pausa).
    pub fn clear(&self) {
        if let Some(inbox) = hub().inbox(self.inbox_id) {
            inbox.lock().unwrap_or_else(|e| e.into_inner()).clear();
        }
    }
}

impl Drop for MusicSink {
    fn drop(&mut self) {
        hub().unregister_inbox(self.inbox_id);
    }
}

/// Converte i16 mono para o formato do hub, com ganho linear.
///
/// Volume em `0.0..=2.0`. Acima de 2.0 satura de propósito: som alto demais
/// vira clipping, e clipping num canal de voz é ruído para todo mundo.
pub fn apply_gain(pcm: &[i16], gain: f32) -> Vec<i16> {
    if !gain.is_finite() || gain <= 0.0 {
        return vec![0; pcm.len()];
    }
    let g = gain.min(2.0);
    pcm.iter()
        .map(|&s| {
            let v = f32::from(s) * g;
            v.clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ganho_satura_em_vez_de_estourar() {
        let alto = vec![i16::MAX, i16::MIN, 0];
        let out = apply_gain(&alto, 4.0);
        assert_eq!(out[0], i16::MAX, "clipping positivo");
        assert_eq!(out[1], i16::MIN, "clipping negativo");
        assert_eq!(out[2], 0);
    }

    #[test]
    fn ganho_zero_silencia_e_negativo_e_tratado_como_zero() {
        let pcm = vec![1000, -1000];
        assert_eq!(apply_gain(&pcm, 0.0), vec![0, 0]);
        assert_eq!(apply_gain(&pcm, -1.0), vec![0, 0]);
        assert_eq!(apply_gain(&pcm, f32::NAN), vec![0, 0]);
    }

    #[test]
    fn ganho_meio_divide_a_amplitude() {
        let out = apply_gain(&[1000, -1000], 0.5);
        assert_eq!(out, vec![500, -500]);
    }

    #[test]
    fn fila_tem_teto_e_descarta_o_mais_velho() {
        let mut sink = open();
        let total = FRAME_SAMPLES * (MAX_QUEUE_FRAMES + 50);
        let (accepted, dropped) = sink.push_pcm(&vec![100i16; total]);
        assert_eq!(accepted, MAX_QUEUE_FRAMES + 50);
        assert_eq!(dropped, 50, "tem de descartar exatamente o excedente");
        assert_eq!(sink.dropped(), 50);
        sink.clear();
    }

    #[test]
    fn fechar_o_canal_remove_o_inbox_do_misturador() {
        let id = {
            let sink = open();
            sink.inbox_id()
        };
        assert!(
            hub().inbox(id).is_none(),
            "inbox morto continuaria sendo iterado a cada 20 ms"
        );
    }

    #[test]
    fn pcm_curto_e_completado_com_silencio() {
        let mut sink = open();
        let (accepted, dropped) = sink.push_pcm(&[1, 2, 3]);
        assert_eq!(accepted, 1, "3 amostras viram 1 frame");
        assert_eq!(dropped, 0);
        sink.clear();
    }
}
