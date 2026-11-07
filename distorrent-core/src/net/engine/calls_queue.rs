// Metodos de NetworkEngine: calls_queue.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub(super) fn is_call_frame(frame: &SecureFrame) -> bool {
        matches!(
            frame,
            SecureFrame::CallInvite { .. }
                | SecureFrame::CallAccept { .. }
                | SecureFrame::CallReject { .. }
                | SecureFrame::CallEnd { .. }
                | SecureFrame::CallOffer { .. }
                | SecureFrame::CallAnswer { .. }
                | SecureFrame::CallIce { .. }
                | SecureFrame::CallAddParticipant { .. }
                | SecureFrame::CallRoom { .. }
                | SecureFrame::ScreenShareOffer { .. }
                | SecureFrame::ScreenShareAnswer { .. }
        )
    }

    pub(super) fn evict_call_frame(q: &mut Vec<SecureFrame>) {
        if Self::evict_one(q, |f| matches!(f, SecureFrame::CallIce { .. })) {
            return;
        }
        if Self::evict_one(q, |f| {
            matches!(
                f,
                SecureFrame::CallEnd { .. } | SecureFrame::CallInvite { .. }
            )
        }) {
            return;
        }
        let newest_offer = q.iter().rposition(Self::is_offer_frame);
        let newest_answer = q.iter().rposition(Self::is_answer_frame);
        let victim = (0..q.len()).find(|i| {
            if Self::is_offer_frame(&q[*i]) {
                Some(*i) != newest_offer
            } else if Self::is_answer_frame(&q[*i]) {
                Some(*i) != newest_answer
            } else {
                true
            }
        });
        if let Some(pos) = victim {
            q.remove(pos);
        }
    }

    fn evict_one(q: &mut Vec<SecureFrame>, pred: fn(&SecureFrame) -> bool) -> bool {
        match q.iter().position(pred) {
            Some(pos) => {
                q.remove(pos);
                true
            }
            None => false,
        }
    }

    pub(super) fn is_offer_frame(f: &SecureFrame) -> bool {
        matches!(f, SecureFrame::CallOffer { .. })
    }

    pub(super) fn is_answer_frame(f: &SecureFrame) -> bool {
        matches!(f, SecureFrame::CallAnswer { .. })
    }

    pub(super) fn queue_or_send_call_frame(&self, peer_fp: &str, frame: SecureFrame) {
        if self.link_tx(peer_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.to_string(), frame))
                .ok();
            return;
        }
        self.enqueue_call_frame(peer_fp, frame);
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
            .ok();
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
            .ok();
    }

    pub(super) fn ring_is_new(&self, call_id: &str, peer_fp: &str) -> bool {
        let mut vistos = self.ring_seen.lock().unwrap_or_else(|e| e.into_inner());
        if vistos.len() > 512 {
            vistos.clear();
        }
        vistos.insert(format!("{call_id}|{peer_fp}"))
    }

    pub(super) fn enqueue_call_frame(&self, peer_fp: &str, frame: SecureFrame) {
        let mut map = self.pending_calls.lock().unwrap_or_else(|e| e.into_inner());
        let q = map.entry(peer_fp.to_string()).or_default();
        if q.len() >= Self::PENDING_CALL_MAX {
            Self::evict_call_frame(q);
            if q.len() >= Self::PENDING_CALL_MAX {
                q.remove(0);
            }
        }
        q.push(frame);
    }

    pub(super) fn flush_pending_calls(&self, peer_fp: &str) {
        let frames: Vec<SecureFrame> = self
            .pending_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_fp)
            .unwrap_or_default();
        for f in frames {
            let _ = Self::is_call_frame(&f);
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.to_string(), f))
                .ok();
        }
    }
}
