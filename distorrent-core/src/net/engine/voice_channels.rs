// Metodos de NetworkEngine: voice_channels.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn voice_join(self: &Arc<Self>, community_id: &str, channel_id: &str) -> Result<()> {
        self.store.set_voice_state(
            community_id,
            channel_id,
            &self.identity.fingerprint,
            false,
            false,
        )?;
        let call_id = format!("voice-{}-{}", community_id, channel_id);
        self.voice_leave_other_channels(&call_id);
        #[cfg(target_os = "linux")]
        self.voice_channel_calls
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(
                call_id.clone(),
                (community_id.to_string(), channel_id.to_string()),
            );
        for (fp, _, _) in self.store.list_members(community_id)? {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceJoin {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                        },
                    ))
                    .ok();
            }
        }
        let _ = self.events.send(EngineEvent::VoiceJoined {
            community_id: community_id.into(),
            channel_id: channel_id.into(),
            fp: self.identity.fingerprint.clone(),
        });
        #[cfg(target_os = "linux")]
        if self.native_voice_available() {
            for (fp, _, _) in self.store.list_voice_states(community_id, channel_id)? {
                if fp == self.identity.fingerprint {
                    continue;
                }
                self.voice_mesh_maybe_offer(community_id, channel_id, &fp);
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub(super) fn voice_mesh_maybe_offer(
        self: &Arc<Self>,
        community_id: &str,
        channel_id: &str,
        peer_fp: &str,
    ) {
        if !self.native_voice_available() {
            return;
        }
        if self.identity.fingerprint.as_str() <= peer_fp {
            return;
        }
        let call_id = format!("voice-{community_id}-{channel_id}");
        if self.voice_is_native(&call_id, peer_fp) {
            return;
        }
        if !self.auto_register_voice_channel(&call_id, peer_fp) {
            return;
        }
        let engine = self.clone();
        let peer = peer_fp.to_string();
        tokio::spawn(async move {
            let e2 = engine.clone();
            let cid = call_id.clone();
            let p = peer.clone();
            let r = tokio::task::spawn_blocking(move || e2.voice_begin_offer(&cid, &p)).await;
            if let Ok(Ok(Some(sdp))) = r {
                let _ = engine.call_signal(&peer, SecureFrame::CallOffer { call_id, sdp });
            }
        });
    }

    pub fn voice_leave(self: &Arc<Self>, community_id: &str, channel_id: &str) -> Result<()> {
        self.store
            .leave_voice(community_id, channel_id, &self.identity.fingerprint)?;
        let call_id = format!("voice-{}-{}", community_id, channel_id);
        #[cfg(not(target_os = "linux"))]
        let _ = &call_id;
        #[cfg(target_os = "linux")]
        {
            self.voice_channel_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&call_id);
            if self
                .voice_calls
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains_key(&call_id)
            {
                self.voice_hangup(&call_id);
                self.voice_forget_call(&call_id);
            }
        }
        for (fp, _, _) in self.store.list_members(community_id)? {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceLeave {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                        },
                    ))
                    .ok();
            }
        }
        let _ = self.events.send(EngineEvent::VoiceLeft {
            community_id: community_id.into(),
            channel_id: channel_id.into(),
            fp: self.identity.fingerprint.clone(),
        });
        Ok(())
    }

    fn voice_leave_other_channels(&self, keep_call_id: &str) {
        let me = self.identity.fingerprint.clone();
        let mine = match self.store.my_voice_states(&me) {
            Ok(v) => v,
            Err(_) => return,
        };
        for (community_id, channel_id, _, _) in mine {
            let call_id = format!("voice-{community_id}-{channel_id}");
            if call_id == keep_call_id {
                continue;
            }
            #[cfg(target_os = "linux")]
            {
                self.voice_hangup(&call_id);
                self.voice_forget_call(&call_id);
                self.voice_channel_calls
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&call_id);
            }
            let _ = self.store.leave_voice(&community_id, &channel_id, &me);
            for (fp, _, _) in self.store.list_members(&community_id).unwrap_or_default() {
                if fp == me {
                    continue;
                }
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceLeave {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                        },
                    ))
                    .ok();
            }
            let _ = self.events.send(EngineEvent::VoiceLeft {
                community_id,
                channel_id,
                fp: me.clone(),
            });
        }
    }

    pub(super) fn flush_voice_state_to(&self, peer_fp: &str) {
        let me = self.identity.fingerprint.clone();
        let Ok(mine) = self.store.my_voice_states(&me) else {
            return;
        };
        for (community_id, channel_id, muted, deafened) in mine {
            if self.store.member_role(&community_id, peer_fp).is_none() {
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::VoiceJoin {
                        community_id: community_id.clone(),
                        channel_id: channel_id.clone(),
                    },
                ))
                .ok();
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::VoiceState {
                        community_id: community_id.clone(),
                        channel_id: channel_id.clone(),
                        muted,
                        deafened,
                        speaking: false,
                    },
                ))
                .ok();
        }
    }

    pub(super) fn reannounce_voice_channels(self: &Arc<Self>) {
        let me = self.identity.fingerprint.clone();
        let mine = match self.store.my_voice_states(&me) {
            Ok(v) => v,
            Err(_) => return,
        };
        for (community_id, channel_id, muted, deafened) in mine {
            // Renova o próprio carimbo: sem isto a linha local expirava em 90 s
            // e o roster de todos perdia quem continuava na call.
            let _ = self
                .store
                .touch_voice_state(&community_id, &channel_id, &me);
            // Limpa só quem REALMENTE parou de se anunciar, no tick de
            // manutenção. Ler o roster nunca deve apagar linha.
            let limite =
                crate::identity::now_ms() - (crate::storage::Store::VOICE_PRESENCE_TTL_MS as i64);
            if let Ok(saidos) =
                self.store
                    .purge_stale_voice_states(&community_id, &channel_id, limite)
            {
                for fp in saidos {
                    if fp == me {
                        continue;
                    }
                    let _ = self.events.send(EngineEvent::VoiceLeft {
                        community_id: community_id.clone(),
                        channel_id: channel_id.clone(),
                        fp,
                    });
                }
            }
            for (fp, _, _) in self.store.list_members(&community_id).unwrap_or_default() {
                if fp == me {
                    continue;
                }
                if self.link_tx(&fp).is_none() {
                    continue;
                }
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp.clone(),
                        SecureFrame::VoiceJoin {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                        },
                    ))
                    .ok();
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceState {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                            muted,
                            deafened,
                            speaking: false,
                        },
                    ))
                    .ok();
            }
            #[cfg(target_os = "linux")]
            if self.native_voice_available() {
                for (fp, _, _) in self
                    .store
                    .list_voice_states(&community_id, &channel_id)
                    .unwrap_or_default()
                {
                    if fp == me {
                        continue;
                    }
                    self.voice_mesh_maybe_offer(&community_id, &channel_id, &fp);
                }
            }
        }
    }

    pub(super) fn drop_voice_presence_of(&self, peer_fp: &str) {
        let Ok(canais) = self.store.peer_voice_states(peer_fp) else {
            return;
        };
        for (community_id, channel_id) in canais {
            #[cfg(target_os = "linux")]
            let rota_viva = {
                let call_id = format!("voice-{community_id}-{channel_id}");
                let viva = self
                    .voice_media()
                    .and_then(|v| v.stats_peer(&call_id, peer_fp))
                    .map(|s| s.state == "connected")
                    .unwrap_or(false);
                if !viva {
                    self.voice_hangup_peer(&call_id, peer_fp);
                    self.voice_forget_peer(&call_id, peer_fp);
                }
                viva
            };
            #[cfg(not(target_os = "linux"))]
            let rota_viva = false;
            if rota_viva {
                continue;
            }
            let _ = self
                .store
                .drop_peer_voice_state(&community_id, &channel_id, peer_fp);
            let _ = self.events.send(EngineEvent::VoiceLeft {
                community_id,
                channel_id,
                fp: peer_fp.to_string(),
            });
        }
    }

    pub fn voice_state_update(
        &self,
        community_id: &str,
        channel_id: &str,
        muted: bool,
        deafened: bool,
    ) -> Result<()> {
        self.store.set_voice_state(
            community_id,
            channel_id,
            &self.identity.fingerprint,
            muted,
            deafened,
        )?;
        for (fp, _, _) in self.store.list_members(community_id)? {
            if fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::VoiceState {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                            muted,
                            deafened,
                            speaking: false,
                        },
                    ))
                    .ok();
            }
        }
        Ok(())
    }

    pub fn list_voice_states(
        &self,
        community_id: &str,
        channel_id: &str,
    ) -> Vec<(String, bool, bool)> {
        self.store
            .list_voice_states(community_id, channel_id)
            .unwrap_or_default()
    }
}
