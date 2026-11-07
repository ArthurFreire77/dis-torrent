// Metodos de NetworkEngine: voice.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    #[cfg(target_os = "linux")]
    pub fn voice(&self) -> Option<Arc<VoiceMedia>> {
        self.voice_media()
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn voice_media(&self) -> Option<Arc<VoiceMedia>> {
        self.voice.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    #[cfg(target_os = "linux")]
    pub fn native_voice_available(&self) -> bool {
        self.voice_media().is_some()
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_test_start(&self) -> Result<u64> {
        self.voice_media()
            .ok_or_else(|| DistorrentError::Protocol("voz nativa indisponível".into()))?
            .mic_test_start()
            .map_err(DistorrentError::Protocol)
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_test_level(&self, id: u64) -> f32 {
        self.voice_media()
            .map(|v| v.mic_test_level(id))
            .unwrap_or(0.0)
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_test_stop(&self, id: u64) {
        if let Some(v) = self.voice_media() {
            v.mic_test_stop(id);
        }
    }

    #[cfg(target_os = "linux")]
    pub fn voice_mic_name(&self) -> String {
        self.voice_media().map(|v| v.mic_name()).unwrap_or_default()
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn voice_is_native(&self, call_id: &str, peer_fp: &str) -> bool {
        self.voice_media().is_some()
            && self
                .voice_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(call_id)
                .is_some_and(|peers| peers.contains(peer_fp))
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn voice_register(self: &Arc<Self>, call_id: &str, peer_fp: &str) -> bool {
        if self.voice_media().is_none() {
            return false;
        }
        let first = self
            .voice_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(call_id.to_string())
            .or_default()
            .insert(peer_fp.to_string());
        if first {
            self.spawn_voice_signal_drainer(call_id, peer_fp);
        }
        true
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn voice_forget_call(&self, call_id: &str) {
        self.voice_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(call_id);
    }

    #[cfg(target_os = "linux")]
    pub(super) fn auto_register_voice_channel(
        self: &Arc<Self>,
        call_id: &str,
        peer_fp: &str,
    ) -> bool {
        let Some((community_id, _channel_id)) = self
            .voice_channel_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(call_id)
            .cloned()
        else {
            return false;
        };
        if self.store.member_role(&community_id, peer_fp).is_none() {
            return false;
        }
        self.voice_register(call_id, peer_fp)
    }

    #[cfg(target_os = "linux")]
    pub(super) fn native_pair_begin(self: &Arc<Self>, call_id: &str, peer_fp: &str) {
        if !self.voice_register(call_id, peer_fp) {
            return;
        }
        if self.identity.fingerprint.as_str() <= peer_fp {
            return;
        }
        if tokio::runtime::Handle::try_current().is_err() {
            if let Ok(Some(sdp)) = self.voice_begin_offer(call_id, peer_fp) {
                let _ = self.call_signal(
                    peer_fp,
                    SecureFrame::CallOffer {
                        call_id: call_id.into(),
                        sdp,
                    },
                );
            }
            return;
        }
        let engine = self.clone();
        let cid = call_id.to_string();
        let peer = peer_fp.to_string();
        tokio::spawn(async move {
            let e2 = engine.clone();
            let (c, p) = (cid.clone(), peer.clone());
            let r = tokio::task::spawn_blocking(move || e2.voice_begin_offer(&c, &p)).await;
            if let Ok(Ok(Some(sdp))) = r {
                let _ = engine.call_signal(&peer, SecureFrame::CallOffer { call_id: cid, sdp });
            }
        });
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn voice_flush_signals(&self, call_id: &str, peer_fp: &str) {
        let Some(v) = self.voice_media() else { return };
        let signals = v.drain_outbound(call_id, peer_fp);
        if signals.is_empty() {
            return;
        }
        for s in signals {
            let frame = match s {
                OutboundSignal::Offer { sdp } => SecureFrame::CallOffer {
                    call_id: call_id.into(),
                    sdp,
                },
                OutboundSignal::Answer { sdp } => SecureFrame::CallAnswer {
                    call_id: call_id.into(),
                    sdp,
                },
                OutboundSignal::Ice { candidate, mid } => SecureFrame::CallIce {
                    call_id: call_id.into(),
                    candidate,
                    mid,
                },
            };
            let _ = self.call_signal(peer_fp, frame);
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn voice_begin_offer(
        self: &Arc<Self>,
        call_id: &str,
        peer_fp: &str,
    ) -> Result<Option<String>> {
        if !self.voice_register(call_id, peer_fp) {
            return Ok(None);
        }
        let Some(v) = self.voice_media() else {
            return Ok(None);
        };
        let offer = match in_multi_thread_runtime() {
            true => tokio::task::block_in_place(move || v.create_offer(call_id, peer_fp)),
            false => v.create_offer(call_id, peer_fp),
        };
        match offer {
            Ok(sdp) => {
                self.voice_flush_signals(call_id, peer_fp);
                Ok(Some(sdp))
            }
            Err(e) => {
                warn!("voz nativa: offer falhou para {peer_fp} ({e}) — sinalização segue no navegador");
                let sessao_viva = self
                    .voice_media()
                    .map(|v| v.stats_peer(call_id, peer_fp).is_some())
                    .unwrap_or(false);
                if sessao_viva {
                    warn!("voz nativa: {call_id}/{peer_fp} mantém a sessão apesar da offer falhar");
                } else if let Some(peers) = self
                    .voice_calls
                    .lock()
                    .unwrap_or_else(|x| x.into_inner())
                    .get_mut(call_id)
                {
                    peers.remove(peer_fp);
                }
                Ok(None)
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn voice_absorb_offer(
        &self,
        call_id: &str,
        peer_fp: &str,
        sdp: &str,
    ) -> Result<bool> {
        if !self.voice_is_native(call_id, peer_fp) {
            return Ok(false);
        }
        let Some(v) = self.voice_media() else {
            return Ok(false);
        };
        let (cid, pfp, s) = (
            call_id.to_string(),
            peer_fp.to_string(),
            unwrap_wire_sdp(sdp),
        );
        let res = tokio::task::spawn_blocking(move || v.handle_offer(&cid, &pfp, &s)).await;
        match res {
            Ok(Ok(answer)) => {
                let _ = self.call_signal(
                    peer_fp,
                    SecureFrame::CallAnswer {
                        call_id: call_id.into(),
                        sdp: answer,
                    },
                );
                self.voice_flush_signals(call_id, peer_fp);
                Ok(true)
            }
            _ => {
                warn!("voz nativa: offer rejeitado de {peer_fp} — devolvendo ao navegador");
                Ok(false)
            }
        }
    }

    #[cfg(target_os = "linux")]
    pub(super) async fn voice_absorb_answer(
        &self,
        call_id: &str,
        peer_fp: &str,
        sdp: &str,
    ) -> bool {
        if !self.voice_is_native(call_id, peer_fp) {
            return false;
        }
        let Some(v) = self.voice_media() else {
            return false;
        };
        let (cid, pfp, s) = (
            call_id.to_string(),
            peer_fp.to_string(),
            unwrap_wire_sdp(sdp),
        );
        let res = tokio::task::spawn_blocking(move || v.handle_answer(&cid, &pfp, &s)).await;
        let ok = matches!(res, Ok(Ok(())));
        self.voice_flush_signals(call_id, peer_fp);
        ok
    }

    #[cfg(target_os = "linux")]
    pub(crate) async fn voice_absorb_ice(
        &self,
        call_id: &str,
        peer_fp: &str,
        cand: &str,
        mid: &str,
    ) -> bool {
        if !self.voice_is_native(call_id, peer_fp) {
            return false;
        }
        let Some(v) = self.voice_media() else {
            return false;
        };
        let (cand, mid) = unwrap_wire_candidate(cand, mid);
        let mid_log = mid.clone();
        let (cid, pfp) = (call_id.to_string(), peer_fp.to_string());
        let res =
            tokio::task::spawn_blocking(move || v.add_ice_candidate(&cid, &pfp, &cand, &mid)).await;
        let ok = matches!(res, Ok(Ok(())));
        if !ok {
            tracing::debug!(
                call_id = %call_id,
                peer = %peer_fp,
                mid = %mid_log,
                "candidato ICE nativo recusado (formato do fio inválido)"
            );
        }
        self.voice_flush_signals(call_id, peer_fp);
        ok
    }

    #[cfg(target_os = "linux")]
    pub fn voice_media_available(&self) -> bool {
        self.native_voice_available()
    }

    #[cfg(target_os = "linux")]
    pub fn voice_media_stats(&self, call_id: &str) -> Option<VoiceStats> {
        self.voice_media().and_then(|v| v.stats_agg(call_id))
    }

    #[cfg(target_os = "linux")]
    pub fn voice_set_muted(&self, call_id: &str, muted: bool) {
        if let Some(v) = self.voice_media() {
            v.set_muted(call_id, muted);
        }
    }

    #[cfg(target_os = "linux")]
    pub fn voice_hangup(&self, call_id: &str) {
        if let Some(v) = self.voice_media() {
            v.hangup(call_id);
        }
        self.voice_forget_call(call_id);
    }

    #[cfg(target_os = "linux")]
    pub fn native_video_start(
        &self,
        call_id: &str,
        peer_fp: &str,
        source: &str,
        monitor_id: Option<u32>,
    ) -> std::result::Result<String, String> {
        let v = self
            .voice_media()
            .ok_or_else(|| "voz nativa indisponivel".to_string())?;
        v.video_start(call_id, peer_fp, source, monitor_id)
    }

    #[cfg(target_os = "linux")]
    pub fn native_video_stop(&self, call_id: &str, peer_fp: &str) {
        if let Some(v) = self.voice_media() {
            v.video_stop(call_id, peer_fp);
        }
    }

    #[cfg(target_os = "linux")]
    pub fn native_video_frame(
        &self,
        call_id: &str,
        peer_fp: &str,
    ) -> Option<crate::net::media_voice::VideoFrame> {
        self.voice_media()
            .and_then(|v| v.video_frame(call_id, peer_fp))
    }

    #[cfg(target_os = "linux")]
    pub fn voice_retry_mic(&self) {
        if let Some(v) = self.voice_media() {
            v.retry_mic();
        }
    }
}
