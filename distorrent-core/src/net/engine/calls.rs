// Metodos de NetworkEngine: calls.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    fn remember_call_target(&self, call_id: &str, fp: &str) {
        if call_id.is_empty() || fp.is_empty() {
            return;
        }
        let mut map = self.call_targets.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 512 {
            map.clear();
        }
        let alvos = map.entry(call_id.to_string()).or_default();
        if !alvos.iter().any(|f| f == fp) {
            alvos.push(fp.to_string());
        }
    }

    pub(super) fn remembered_call_targets(&self, call_id: &str) -> Vec<String> {
        self.call_targets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(call_id)
            .cloned()
            .unwrap_or_default()
    }

    fn forget_call_targets(&self, call_id: &str) {
        self.call_targets
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(call_id);
    }

    pub fn call_invite(self: &Arc<Self>, target_fp: &str, kind: &str) -> Result<String> {
        self.call_invite_ctx(target_fp, kind, false)
    }

    /// `group = true` é chamada de grupo/canal (o alvo já está no grupo). Em
    /// 1:1 a regra é dura: sem amizade ACEITA não sai convite — a UI desabilita
    /// o botão, mas a barreira de verdade fica aqui.
    pub fn call_invite_ctx(
        self: &Arc<Self>,
        target_fp: &str,
        kind: &str,
        group: bool,
    ) -> Result<String> {
        if !group && !self.is_accepted_friend(target_fp) {
            return Err(DistorrentError::Protocol(
                "só amigos aceitos podem ligar — envie uma solicitação de amizade primeiro".into(),
            ));
        }
        let short = self
            .identity
            .fingerprint
            .get(..6)
            .unwrap_or(&self.identity.fingerprint)
            .to_string();
        let call_id = format!("call-{short}-{}", crate::identity::now_ms());
        self.store
            .create_call(&call_id, kind, target_fp, &self.identity.fingerprint)?;
        let _ = self.store.join_call(&call_id, &self.identity.fingerprint);
        self.remember_call_target(&call_id, target_fp);
        self.queue_or_send_call_frame(
            target_fp,
            SecureFrame::CallInvite {
                call_id: call_id.clone(),
                kind: kind.into(),
                target_fp: target_fp.into(),
                group,
            },
        );
        #[cfg(target_os = "linux")]
        {
            self.voice_rearm();
            self.voice_retry_mic();
        }
        #[cfg(target_os = "linux")]
        if let Some(sdp) = self.voice_begin_offer(&call_id, target_fp)? {
            self.call_signal(
                target_fp,
                SecureFrame::CallOffer {
                    call_id: call_id.clone(),
                    sdp,
                },
            )?;
        }
        Ok(call_id)
    }

    /// Amizade efetivamente aceita (não vale pendente, recusada nem bloqueada).
    pub fn is_accepted_friend(&self, peer_fp: &str) -> bool {
        matches!(
            self.store.get_friend(peer_fp).ok().flatten(),
            Some((_, s)) if s == "accepted"
        )
    }

    pub fn call_ring_retry(&self, call_id: &str, target_fp: &str, kind: &str) -> Result<()> {
        if call_id.trim().is_empty() || target_fp.trim().is_empty() {
            return Err(DistorrentError::Protocol("call_id/alvo vazios".into()));
        }
        // O retry também respeita a amizade: sem isto bastava o toque inicial
        // ser recusado para o app continuar insistindo por outro caminho.
        if !self.is_accepted_friend(target_fp) && !self.store.is_in_call(call_id, target_fp) {
            return Err(DistorrentError::Protocol(
                "só amigos aceitos podem ligar".into(),
            ));
        }
        self.remember_call_target(call_id, target_fp);
        self.queue_or_send_call_frame(
            target_fp,
            SecureFrame::CallInvite {
                call_id: call_id.into(),
                kind: kind.into(),
                target_fp: target_fp.into(),
                group: false,
            },
        );
        Ok(())
    }

    pub fn call_accept(self: &Arc<Self>, call_id: &str, from_fp: &str) -> Result<()> {
        self.store.join_call(call_id, &self.identity.fingerprint)?;
        self.store.join_call(call_id, from_fp)?;
        #[cfg(target_os = "linux")]
        self.voice_register(call_id, from_fp);
        self.queue_or_send_call_frame(
            from_fp,
            SecureFrame::CallAccept {
                call_id: call_id.into(),
            },
        );
        #[cfg(target_os = "linux")]
        {
            self.voice_rearm();
            self.voice_retry_mic();
        }
        #[cfg(target_os = "linux")]
        let _ = self.events.send(EngineEvent::CallAcceptedEv {
            call_id: call_id.into(),
            from_fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    pub fn call_reject(&self, call_id: &str, from_fp: &str, reason: &str) -> Result<()> {
        #[cfg(target_os = "linux")]
        self.forget_held_call(call_id);
        self.queue_or_send_call_frame(
            from_fp,
            SecureFrame::CallReject {
                call_id: call_id.into(),
                reason: reason.into(),
            },
        );
        Ok(())
    }

    pub fn call_end(&self, call_id: &str) -> Result<()> {
        #[cfg(target_os = "linux")]
        self.forget_held_call(call_id);
        let participantes = self.store.call_participants(call_id).unwrap_or_default();
        // O alvo do toque ainda NÃO é participante: sem avisar, ele segue tocando.
        let alvos = self.remembered_call_targets(call_id);
        for fp in participantes {
            if fp == self.identity.fingerprint {
                continue;
            }
            self.queue_or_send_call_frame(
                &fp,
                SecureFrame::CallEnd {
                    call_id: call_id.into(),
                },
            );
        }
        for fp in alvos {
            if fp == self.identity.fingerprint || self.store.is_in_call(call_id, &fp) {
                continue;
            }
            self.queue_or_send_call_frame(
                &fp,
                SecureFrame::CallReject {
                    call_id: call_id.into(),
                    reason: "cancele".into(),
                },
            );
            self.queue_or_send_call_frame(
                &fp,
                SecureFrame::CallEnd {
                    call_id: call_id.into(),
                },
            );
        }
        self.store.end_call(call_id)?;
        self.forget_call_targets(call_id);
        #[cfg(target_os = "linux")]
        self.voice_hangup(call_id);
        let _ = self.events.send(EngineEvent::CallEnded {
            call_id: call_id.into(),
            from_fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    pub fn call_signal(&self, target_fp: &str, frame: SecureFrame) -> Result<()> {
        self.queue_or_send_call_frame(target_fp, frame);
        Ok(())
    }

    pub fn call_add_participant(
        self: &Arc<Self>,
        target_fp: &str,
        call_id: &str,
        fp: &str,
        kind: &str,
    ) -> Result<()> {
        let call_id = call_id.trim();
        let fp = fp.trim();
        if call_id.is_empty() || fp.is_empty() {
            return Err(DistorrentError::Protocol("call_id/fp vazios".into()));
        }
        let kind = crate::names::sanitize_text(kind.trim(), 16);
        let _ = self.store.join_call(call_id, fp);
        let _ = self.store.join_call(call_id, target_fp);
        #[cfg(target_os = "linux")]
        if self.voice_register(call_id, target_fp) && self.voice_register(call_id, fp) {
            if let Some(sdp) = self.voice_begin_offer(call_id, target_fp)? {
                self.call_signal(
                    target_fp,
                    SecureFrame::CallOffer {
                        call_id: call_id.into(),
                        sdp,
                    },
                )?;
            }
        }
        self.queue_or_send_call_frame(
            target_fp,
            SecureFrame::CallAddParticipant {
                call_id: call_id.into(),
                fp: fp.into(),
                kind,
            },
        );
        self.remember_call_target(call_id, target_fp);
        Ok(())
    }
}
