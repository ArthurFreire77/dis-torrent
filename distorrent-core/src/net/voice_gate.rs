//! voice_gate — sinalização retida até o aceite + re-arm da mídia nativa.
//!
//! A offer nativa do chamador sai ~2s após o invite e quase sempre chega antes
//! de o usuário atender. Sem registro ela caía num evento para uma WebView sem
//! `RTCPeerConnection` (WebKitGTK) e morria — a chamada "só conectava por
//! sorte". Aqui ela é retida e absorvida no `call_accept`.

#[cfg(target_os = "linux")]
use std::sync::Arc;

use super::engine::NetworkEngine;
#[cfg(target_os = "linux")]
use crate::identity::now_ms;

/// Sinalização de chamada retida até o aceite.
#[cfg(target_os = "linux")]
pub struct HeldCall {
    pub(super) peer_fp: String,
    pub(super) sdp: String,
    pub(super) ice: Vec<(String, String)>,
    pub(super) held_at: i64,
}

impl NetworkEngine {
    /// Re-tenta construir a mídia nativa quando ela não subiu no boot
    /// (PipeWave/ALSA aparecendo depois). Barato: a construção é lazy.
    #[cfg(target_os = "linux")]
    pub(super) fn voice_rearm(&self) {
        {
            let guard = self.voice.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() || !super::engine::native_voice_capable() {
                return;
            }
        }
        if let Some(v) = super::engine::build_voice_media() {
            tracing::info!("voz nativa: re-armada (áudio apareceu depois do boot)");
            *self.voice.lock().unwrap_or_else(|e| e.into_inner()) = Some(v);
        }
    }

    /// Retém a offer que chegou antes do aceite (só chamadas 1:1 `call-*`;
    /// canais de voz `voice-*` pertencem ao JS).
    #[cfg(target_os = "linux")]
    pub(super) fn hold_call_offer(&self, call_id: &str, peer_fp: &str, sdp: &str) {
        if call_id.starts_with("voice-") {
            return;
        }
        let mut map = self.held_calls.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= 16 {
            if let Some(oldest) = map
                .iter()
                .min_by_key(|(_, h)| h.held_at)
                .map(|(k, _)| k.clone())
            {
                map.remove(&oldest);
            }
        }
        let h = map.entry(call_id.to_string()).or_insert_with(|| HeldCall {
            peer_fp: peer_fp.to_string(),
            sdp: String::new(),
            ice: Vec::new(),
            held_at: now_ms(),
        });
        h.peer_fp = peer_fp.to_string();
        h.sdp = sdp.to_string();
        h.held_at = now_ms();
    }

    /// Retém ICE que chegou antes do aceite. `true` se ficou retido.
    #[cfg(target_os = "linux")]
    pub(super) fn hold_call_ice(
        &self,
        call_id: &str,
        peer_fp: &str,
        candidate: &str,
        mid: &str,
    ) -> bool {
        if call_id.starts_with("voice-") {
            return false;
        }
        let mut map = self.held_calls.lock().unwrap_or_else(|e| e.into_inner());
        match map.get_mut(call_id) {
            Some(h) if h.peer_fp == peer_fp && h.ice.len() < 64 => {
                h.ice.push((candidate.to_string(), mid.to_string()));
                true
            }
            _ => false,
        }
    }

    /// Consome a entrada retida deste par (ou `None`).
    #[cfg(target_os = "linux")]
    fn take_held_call(&self, call_id: &str, peer_fp: &str) -> Option<HeldCall> {
        let mut map = self.held_calls.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(call_id) {
            Some(h) if h.peer_fp == peer_fp => map.remove(call_id),
            _ => None,
        }
    }

    /// Descarta a sinalização retida da chamada (fim/rejeição).
    #[cfg(target_os = "linux")]
    pub fn forget_held_call(&self, call_id: &str) {
        self.held_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(call_id);
    }

    /// Encerra a sessão nativa com UM par (CallEnd dele) — as demais ficam.
    #[cfg(target_os = "linux")]
    pub(super) fn voice_hangup_peer(&self, call_id: &str, peer_fp: &str) {
        if let Some(v) = self.voice_media() {
            v.hangup_peer(call_id, peer_fp);
        }
    }

    /// Ensurdecer a chamada nativa (cala o playout das sessões dela).
    #[cfg(target_os = "linux")]
    pub fn voice_set_deafened(&self, call_id: &str, deafened: bool) {
        if let Some(v) = self.voice_media() {
            v.set_deafened(call_id, deafened);
        }
    }

    /// Remove o par do registro nativo da chamada, sem tocar nos outros.
    #[cfg(target_os = "linux")]
    pub(super) fn voice_forget_peer(&self, call_id: &str, peer_fp: &str) {
        let mut map = self.voice_calls.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(peers) = map.get_mut(call_id) {
            peers.remove(peer_fp);
            if peers.is_empty() {
                map.remove(call_id);
            }
        }
    }

    /// Absorve a offer/ICE retidos no aceite. Chamado pelo comando async do
    /// Tauri (dentro do runtime tokio — os absorbs são async).
    #[cfg(target_os = "linux")]
    pub async fn resume_held_call(&self, call_id: &str, from_fp: &str) {
        if !self.voice_is_native(call_id, from_fp) {
            self.forget_held_call(call_id);
            return;
        }
        let Some(held) = self.take_held_call(call_id, from_fp) else {
            return;
        };
        if held.sdp.is_empty() {
            return;
        }
        if self
            .voice_absorb_offer(call_id, from_fp, &held.sdp)
            .await
            .unwrap_or(false)
        {
            for (cand, mid) in held.ice {
                let _ = self.voice_absorb_ice(call_id, from_fp, &cand, &mid).await;
            }
        } else {
            tracing::debug!(call_id, "offer retida falhou no absorb — descartada");
        }
    }

    /// Drenador periódico do trickle ICE nativo (400ms por par registrado).
    /// Sem ele, candidatos tardios ficavam presos na fila `out` até o peer
    /// mandar algo. Morre sozinho quando o registro é esquecido.
    #[cfg(target_os = "linux")]
    pub(super) fn spawn_voice_signal_drainer(self: &Arc<Self>, call_id: &str, peer_fp: &str) {
        // Sem runtime tokio (testes síncronos): sem drainer — os pontos de
        // flush nos absorbs continuam cobrindo o caso.
        if tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        let engine = self.clone();
        let (call_id, peer_fp) = (call_id.to_string(), peer_fp.to_string());
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(400));
            loop {
                tick.tick().await;
                if !engine.voice_is_native(&call_id, &peer_fp) {
                    return;
                }
                engine.voice_flush_signals(&call_id, &peer_fp);
            }
        });
    }
}

#[cfg(not(target_os = "linux"))]
impl NetworkEngine {
    pub async fn resume_held_call(&self, _call_id: &str, _from_fp: &str) {}
}
