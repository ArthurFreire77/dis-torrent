// Frames de community: braços extraídos de handle_frame.
// O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_community(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::JoinCommunity {
            community_id,
            token,
        } => {
            let comm = engine
                .store
                .get_community(&community_id)?
                .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
            // Servidor PÚBLICO: entrada livre, sem convite e sem aprovação. O rate limit é o que impede "qualquer um entra" virar flood.
            if token.trim().is_empty() {
                if !engine.store.community_is_public(&community_id)? {
                    return Err(DistorrentError::Protocol(
                        "este servidor é privado — peça um convite".into(),
                    ));
                }
                if engine.netlimiter.allow_public_join(peer_fp) == Decision::Blocked {
                    return Err(DistorrentError::Protocol(
                        "muitas tentativas de entrada — aguarde um pouco".into(),
                    ));
                }
                engine
                    .store
                    .upsert_member(&community_id, peer_fp, peer_nick, "member")?;
                let _ = engine.events.send(EngineEvent::MemberJoined {
                    community_id: community_id.clone(),
                    fp: peer_fp.into(),
                    nickname: peer_nick.into(),
                });
                let frame = engine.community_state_payload(&community_id, Some(peer_fp))?;
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
                    .ok();
                engine.broadcast_community_state(&community_id);
                return Ok(());
            }
            let (tok_host, _cid, member_fp, exp, sig) =
                crate::protocol::parse_invite_token(&token)?;
            const WILDCARD: &str = "000000000000";
            let bound = member_fp == WILDCARD || member_fp == peer_fp;
            if _cid != community_id || !bound || comm.2 != tok_host {
                return Err(DistorrentError::Protocol(
                    "token não corresponde ao servidor ou peer".into(),
                ));
            }
            let is_owner = comm.2 == engine.identity.fingerprint;
            if !is_owner
                && !engine
                    .store
                    .list_members(&community_id)?
                    .iter()
                    .any(|(fp, _, _)| fp == &engine.identity.fingerprint)
            {
                return Err(DistorrentError::Protocol(
                    "membro não autorizado como seed deste servidor".into(),
                ));
            }
            if crate::identity::now_ms() > exp {
                return Err(DistorrentError::Protocol("convite expirado".into()));
            }
            let owner_key = if is_owner {
                engine.keypair.public_hex()
            } else {
                engine
                    .store
                    .get_peer(&tok_host)?
                    .map(|p| p.pubkey_hex)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(
                            "chave pública do dono ainda não foi sincronizada".into(),
                        )
                    })?
            };
            if !Keypair::verify(
                &owner_key,
                &crate::protocol::invite_sign_bytes(&community_id, &member_fp, exp),
                &sig,
            )? {
                return Err(DistorrentError::Protocol(
                    "convite com assinatura inválida".into(),
                ));
            }
            engine
                .store
                .upsert_member(&community_id, peer_fp, peer_nick, "member")?;
            engine.clear_pending_join(&community_id);
            let _ = engine.events.send(EngineEvent::MemberJoined {
                community_id: community_id.clone(),
                fp: peer_fp.into(),
                nickname: peer_nick.into(),
            });
            let frame = engine.community_state_payload(&community_id, Some(peer_fp))?;
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
                .ok();
            engine.broadcast_community_state(&community_id);
        }

        SecureFrame::CommunityState {
            community_id,
            name,
            owner_fp,
            channels,
            roles,
            bots,
            member_roles,
            members,
            description,
            category,
            icon,
            is_public,
        } => {
            let allowed = match engine
                .store
                .get_community(&community_id)?
                .map(|(_, _, o)| o)
            {
                Some(stored_owner) => {
                    if stored_owner != owner_fp {
                        false
                    } else if peer_fp == owner_fp {
                        true
                    } else {
                        engine
                            .store
                            .list_members(&community_id)
                            .map(|members| {
                                members.iter().any(|(fp, _, _)| {
                                    fp == &peer_fp && fp != &engine.identity.fingerprint
                                })
                            })
                            .unwrap_or(false)
                    }
                }
                None => {
                    let pending = engine
                        .pending_joins
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .get(&community_id)
                        .cloned();
                    let Some(token) = pending else {
                        return Err(DistorrentError::Protocol(
                            "CommunityState sem convite pendente".into(),
                        ));
                    };
                    // Entrada em servidor PÚBLICO vai sem token: o host já aceitou e provou ser o dono assinando o próprio estado.
                    if token.trim().is_empty() {
                        peer_fp == owner_fp
                    } else {
                        let (host_fp, token_cid, member_fp, exp, sig) =
                            crate::protocol::parse_invite_token(&token)?;
                        const WILDCARD: &str = "000000000000";
                        let member_bound =
                            member_fp == WILDCARD || member_fp == engine.identity.fingerprint;
                        let host_key = engine.store.get_peer(&host_fp)?.map(|p| p.pubkey_hex);
                        if host_fp != owner_fp
                            || token_cid != community_id
                            || !member_bound
                            || crate::identity::now_ms() > exp
                        {
                            false
                        } else if let Some(host_key) = host_key {
                            Keypair::verify(
                                &host_key,
                                &crate::protocol::invite_sign_bytes(&community_id, &member_fp, exp),
                                &sig,
                            )
                            .unwrap_or(false)
                        } else {
                            false
                        }
                    }
                }
            };
            if !allowed {
                return Err(DistorrentError::Protocol(
                    "CommunityState fora do host".into(),
                ));
            }
            engine.store.community_full_sync(
                &community_id,
                &name,
                &owner_fp,
                &channels,
                &roles,
                &bots,
                &member_roles,
                &members,
                &(description, category, icon),
                is_public,
            )?;
            engine.clear_pending_join(&community_id);
            let _ = engine
                .events
                .send(EngineEvent::CommunityJoined { community_id, name });
        }

        SecureFrame::CommunityKicked { community_id } => {
            let (is_host, name) = engine
                .store
                .get_community(&community_id)?
                .map(|(_, n, owner)| (owner == peer_fp, n))
                .unwrap_or((false, community_id.clone()));
            if !is_host {
                return Err(DistorrentError::Protocol(
                    "CommunityKicked fora do host".into(),
                ));
            }
            engine.store.community_remove_local(&community_id)?;
            engine.clear_pending_join(&community_id);
            let _ = engine.events.send(EngineEvent::CommunityRemoved {
                community_id: community_id.clone(),
            });
            let _ = engine.events.send(EngineEvent::Error {
                context: format!("você foi removido do servidor {name}"),
            });
        }

        SecureFrame::ChannelReorder { community_id, ids } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner && !engine.is_moderator(&community_id, peer_fp) {
                return Err(DistorrentError::Protocol(
                    "sem permissão para reordenar".into(),
                ));
            }
            engine.reorder_channels(&community_id, &ids)?;
            engine.broadcast_community_state(&community_id);
        }

        SecureFrame::CommunitySyncRequest { community_id } => {
            let is_member = engine.store.member_role(&community_id, peer_fp).is_some();
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_member && !is_owner {
                return Err(DistorrentError::Protocol(
                    "CommunitySyncRequest de quem não é membro".into(),
                ));
            }
            if let Ok(frame) = engine.community_state_payload(&community_id, Some(peer_fp)) {
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(peer_fp.to_string(), frame))
                    .ok();
            }
        }

        _ => {}
    }
    Ok(())
}
