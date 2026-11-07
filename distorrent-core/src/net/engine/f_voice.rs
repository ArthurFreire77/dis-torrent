// Frames de voice: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_voice(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    _peer_pubkey: &str,
    _peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::VoiceJoin {
            community_id,
            channel_id,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol(
                    "não é membro da comunidade".into(),
                ));
            }
            engine
                .store
                .set_voice_state(&community_id, &channel_id, peer_fp, false, false)?;
            #[cfg(target_os = "linux")]
            {
                engine.voice_mesh_maybe_offer(&community_id, &channel_id, peer_fp);
            }
            if engine.identity.fingerprint.as_str() < peer_fp {
                let estou_no_canal = engine
                    .store
                    .my_voice_states(&engine.identity.fingerprint)
                    .map(|v| {
                        v.iter()
                            .any(|(c, ch, _, _)| c == &community_id && ch == &channel_id)
                    })
                    .unwrap_or(false);
                if estou_no_canal {
                    let (muted, deafened) = engine
                        .store
                        .my_voice_states(&engine.identity.fingerprint)
                        .ok()
                        .and_then(|v| {
                            v.into_iter()
                                .find(|(c, ch, _, _)| c == &community_id && ch == &channel_id)
                                .map(|(_, _, m, d)| (m, d))
                        })
                        .unwrap_or((false, false));
                    let _ = engine.cmd_tx.send(EngineCmd::SendToPeer(
                        peer_fp.to_string(),
                        SecureFrame::VoiceState {
                            community_id: community_id.clone(),
                            channel_id: channel_id.clone(),
                            muted,
                            deafened,
                            speaking: false,
                        },
                    ));
                }
            }
            let _ = engine.events.send(EngineEvent::VoiceJoined {
                community_id,
                channel_id,
                fp: peer_fp.into(),
            });
        }

        SecureFrame::VoiceLeave {
            community_id,
            channel_id,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol(
                    "não é membro da comunidade".into(),
                ));
            }
            engine
                .store
                .leave_voice(&community_id, &channel_id, peer_fp)?;
            #[cfg(target_os = "linux")]
            {
                let call_id = format!("voice-{}-{}", community_id, channel_id);
                if engine.voice_is_native(&call_id, peer_fp) {
                    engine.voice_hangup_peer(&call_id, peer_fp);
                    engine.voice_forget_peer(&call_id, peer_fp);
                }
            }
            let _ = engine.events.send(EngineEvent::VoiceLeft {
                community_id,
                channel_id,
                fp: peer_fp.into(),
            });
        }

        SecureFrame::VoiceState {
            community_id,
            channel_id,
            muted,
            deafened,
            speaking: _,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol(
                    "não é membro da comunidade".into(),
                ));
            }
            engine
                .store
                .set_voice_state(&community_id, &channel_id, peer_fp, muted, deafened)?;
            #[cfg(target_os = "linux")]
            engine.voice_mesh_maybe_offer(&community_id, &channel_id, peer_fp);
            let _ = engine.events.send(EngineEvent::VoiceStateChanged {
                community_id,
                channel_id,
                fp: peer_fp.into(),
                muted,
                deafened,
            });
        }

        _ => {}
    }
    Ok(())
}
