// Frames de calls: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_calls(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    _peer_pubkey: &str,
    _peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::CallInvite {
            call_id,
            kind,
            target_fp,
            group: _,
        } => {
            // `target_fp` vazio em versões antigas. Quando vem preenchido,
            // precisa ser eu: um convite endereçado a outra pessoa não pode
            // tocar a minha campainha.
            if !target_fp.is_empty() && target_fp != engine.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "CallInvite endereçado a outro peer".into(),
                ));
            }
            if engine.ring_is_new(&call_id, peer_fp) {
                let _ = engine.events.send(EngineEvent::CallIncoming {
                    call_id: call_id.clone(),
                    from_fp: peer_fp.into(),
                    kind,
                });
            }
            // Já aceitei este invite antes: o CallAccept é one-shot e pode ter se
            // perdido. Reenviar aqui é idempotente e usa o retry de 6 s do
            // chamador como canal de recuperação.
            let sou_host = engine.store.get_call_host(&call_id)?.as_deref() == Some(peer_fp);
            if !sou_host
                && engine
                    .store
                    .is_in_call(&call_id, &engine.identity.fingerprint)
            {
                engine.queue_or_send_call_frame(
                    peer_fp,
                    SecureFrame::CallAccept {
                        call_id: call_id.clone(),
                    },
                );
            }
            engine.queue_or_send_call_frame(
                peer_fp,
                SecureFrame::CallRinging {
                    call_id: call_id.clone(),
                },
            );
        }

        SecureFrame::CallRinging { call_id } => {
            if engine.store.get_call_host(&call_id)?.as_deref()
                != Some(engine.identity.fingerprint.as_str())
            {
                return Err(DistorrentError::Protocol(
                    "CallRinging para chamada não iniciada por mim".into(),
                ));
            }
            engine.store.join_call(&call_id, peer_fp)?;
            let _ = engine.events.send(EngineEvent::CallRingingEv {
                call_id,
                from_fp: peer_fp.into(),
            });
        }

        SecureFrame::CallAccept { call_id } => {
            if engine.store.get_call_host(&call_id)?.as_deref()
                != Some(engine.identity.fingerprint.as_str())
            {
                return Err(DistorrentError::Protocol(
                    "CallAccept para chamada não iniciada por mim".into(),
                ));
            }
            engine.store.join_call(&call_id, peer_fp)?;
            let _ = engine.events.send(EngineEvent::CallAcceptedEv {
                call_id,
                from_fp: peer_fp.into(),
            });
        }

        SecureFrame::CallReject { call_id, reason } => {
            // Revogação imediata: se a amizade caiu entre o toque e o aceite,
            // o convite não pode mais virar chamada. A CEIFA aqui também cobre
            // o caso de a UI ainda mostrar o painel de toque.
            if engine
                .store
                .is_in_call(&call_id, &engine.identity.fingerprint)
                && !engine.is_accepted_friend(peer_fp)
                && engine.store.get_call_host(&call_id)?.as_deref() != Some(peer_fp)
            {
                engine
                    .store
                    .leave_call(&call_id, &engine.identity.fingerprint)?;
            }
            let _ = engine.events.send(EngineEvent::CallRejected {
                call_id,
                from_fp: peer_fp.into(),
                reason,
            });
        }

        SecureFrame::CallEnd { call_id } => {
            engine.store.leave_call(&call_id, peer_fp)?;
            let sozinho = engine
                .store
                .call_participants(&call_id)
                .unwrap_or_default()
                .iter()
                .filter(|f| **f != engine.identity.fingerprint)
                .count()
                == 0;
            if sozinho {
                engine.store.end_call(&call_id)?;
            }
            #[cfg(target_os = "linux")]
            if engine.voice_is_native(&call_id, peer_fp) {
                engine.voice_hangup_peer(&call_id, peer_fp);
                engine.voice_forget_peer(&call_id, peer_fp);
            }
            #[cfg(target_os = "linux")]
            engine.forget_held_call(&call_id);
            let _ = engine.events.send(EngineEvent::CallEnded {
                call_id,
                from_fp: peer_fp.into(),
            });
        }

        SecureFrame::CallOffer { call_id, sdp } => {
            #[cfg(target_os = "linux")]
            {
                if !engine.voice_is_native(&call_id, peer_fp) && engine.native_voice_available() {
                    engine.auto_register_voice_channel(&call_id, peer_fp);
                }
                if !engine.voice_is_native(&call_id, peer_fp) && engine.native_voice_available() {
                    if engine.hold_call_offer(&call_id, peer_fp, &sdp) {
                        return Ok(());
                    }
                }
                if engine.voice_absorb_offer(&call_id, peer_fp, &sdp).await? {
                    return Ok(());
                }
            }
            let _ = engine.events.send(EngineEvent::CallOfferEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }

        SecureFrame::CallAnswer { call_id, sdp } => {
            #[cfg(target_os = "linux")]
            if engine.voice_absorb_answer(&call_id, peer_fp, &sdp).await {
                return Ok(());
            }
            let _ = engine.events.send(EngineEvent::CallAnswerEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }

        SecureFrame::CallIce {
            call_id,
            candidate,
            mid,
        } => {
            #[cfg(target_os = "linux")]
            {
                if !engine.voice_is_native(&call_id, peer_fp)
                    && engine.native_voice_available()
                    && engine.hold_call_ice(&call_id, peer_fp, &candidate, &mid)
                {
                    return Ok(());
                }
                if engine
                    .voice_absorb_ice(&call_id, peer_fp, &candidate, &mid)
                    .await
                {
                    return Ok(());
                }
            }
            let _ = engine.events.send(EngineEvent::CallIceEv {
                call_id,
                from_fp: peer_fp.into(),
                candidate,
                mid,
            });
        }

        SecureFrame::CallAddParticipant { call_id, fp, kind } => {
            // Quem adiciona precisa ter relação comigo (amigo/grupo/servidor),
            // e a sala precisa ser de uma conversa em que eu esteja. Antes
            // qualquer peer "adicionava" um terceiro à minha chamada.
            if !engine
                .store
                .is_in_call(&call_id, &engine.identity.fingerprint)
            {
                return Err(DistorrentError::Protocol(
                    "CallAddParticipant numa chamada em que não estou".into(),
                ));
            }
            if fp != peer_fp && !engine.is_social_contact(&fp) && !engine.is_social_contact(peer_fp)
            {
                return Err(DistorrentError::Protocol(
                    "CallAddParticipant de quem não é contato".into(),
                ));
            }
            #[cfg(target_os = "linux")]
            {
                let ja_na_chamada = engine.voice_is_native(&call_id, peer_fp);
                if !ja_na_chamada {
                    engine.native_pair_begin(&call_id, peer_fp);
                }
            }
            let _ = engine.events.send(EngineEvent::CallParticipantAdded {
                call_id: call_id.clone(),
                fp,
                kind: kind.clone(),
            });
            if !kind.is_empty() {
                let _ = engine.events.send(EngineEvent::CallIncoming {
                    call_id,
                    from_fp: peer_fp.into(),
                    kind,
                });
            }
        }

        SecureFrame::CallRoom { .. } => {}

        SecureFrame::ScreenShareOffer { call_id, sdp } => {
            let _ = engine.events.send(EngineEvent::ScreenShareOfferEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }

        SecureFrame::ScreenShareAnswer { call_id, sdp } => {
            let _ = engine.events.send(EngineEvent::CallAnswerEv {
                call_id,
                from_fp: peer_fp.into(),
                sdp,
            });
        }

        _ => {}
    }
    Ok(())
}
