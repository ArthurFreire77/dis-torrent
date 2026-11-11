// Frames de groups: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_groups(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    _peer_pubkey: &str,
    _peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::GroupCreated {
            conv_id,
            title,
            members,
            owner_fp,
        } => {
            let eu = &engine.identity.fingerprint;
            if !members.iter().any(|(fp, _)| fp == peer_fp) {
                // Roster sem o próprio remetente é saída dele; recusar prendia
                // o fp no roster dos outros e o grupo voltava no próximo sync.
                let conhecido = engine.store.get_conversation(&conv_id)?.is_some()
                    && engine
                        .store
                        .list_group_members(&conv_id)?
                        .iter()
                        .any(|(fp, _)| fp == peer_fp);
                if !conhecido {
                    return Err(DistorrentError::Protocol(
                        "GroupCreated sem o criador na lista".into(),
                    ));
                }
                engine.store.remove_group_member(&conv_id, peer_fp)?;
                let sou_criador = engine
                    .store
                    .group_owner(&conv_id)?
                    .map(|d| d == *eu)
                    .unwrap_or(false);
                if sou_criador {
                    engine.broadcast_group_created(&conv_id);
                }
                let _ = engine.events.send(EngineEvent::GroupSynced {
                    conv_id,
                    title: String::new(),
                });
                return Ok(());
            }
            if members.len() > 10 {
                return Err(DistorrentError::Protocol(
                    "GroupCreated com roster acima do limite".into(),
                ));
            }
            let me_incluiu = members.iter().any(|(fp, _)| fp == eu);
            let dono_conhecido = engine
                .store
                .group_owner(&conv_id)?
                .or_else(|| {
                    if owner_fp.is_empty() {
                        None
                    } else {
                        Some(owner_fp.clone())
                    }
                })
                .or_else(|| crate::group_trash::owner_of(&engine.store, &conv_id))
                .or_else(|| members.first().map(|(fp, _)| fp.clone()));
            if let Some(dono) = dono_conhecido.filter(|d| !d.is_empty()) {
                if dono != peer_fp {
                    return Ok(());
                }
            }
            let dono = if owner_fp.is_empty() {
                peer_fp.to_string()
            } else {
                owner_fp.clone()
            };
            if dono != peer_fp {
                return Err(DistorrentError::Protocol(
                    "GroupCreated com owner_fp divergente do remetente".into(),
                ));
            }
            if !members.is_empty() {
                let _ = engine.store.group_owner_set(&conv_id, &dono);
            }
            if crate::group_trash::is_dismissed(&engine.store, &conv_id) {
                // Saí de propósito: roster reenviado não é reentrada.
                if me_incluiu && dono == peer_fp {
                    let restantes: Vec<(String, String)> =
                        members.iter().filter(|(fp, _)| fp != eu).cloned().collect();
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.to_string(),
                            SecureFrame::GroupCreated {
                                conv_id: conv_id.clone(),
                                title: title.clone(),
                                members: restantes,
                                owner_fp: dono.clone(),
                            },
                        ))
                        .ok();
                }
                return Ok(());
            }
            if !me_incluiu {
                engine.store.leave_group_local(&conv_id)?;
                let _ = crate::group_trash::dismiss_owned(&engine.store, &conv_id, &dono);
                let _ = engine.events.send(EngineEvent::GroupSynced {
                    conv_id,
                    title: String::new(),
                });
                return Ok(());
            }
            engine
                .store
                .upsert_group_state(&conv_id, &title, &members)?;
            let _ = engine
                .events
                .send(EngineEvent::GroupSynced { conv_id, title });
        }

        SecureFrame::GroupMemberAdded {
            conv_id,
            fp,
            nickname,
        } => {
            // O criador me readicionando depois de eu sair: o grupo já foi
            // apagado localmente, então recriar é o único caminho de volta.
            if fp == engine.identity.fingerprint
                && crate::group_trash::is_dismissed(&engine.store, &conv_id)
            {
                let dono = crate::group_trash::owner_of(&engine.store, &conv_id);
                if dono.as_deref() != Some(peer_fp) {
                    return Err(DistorrentError::Protocol(
                        "só quem criou o grupo readiciona".into(),
                    ));
                }
                let _ = crate::group_trash::restore(&engine.store, &conv_id);
                engine.store.upsert_group_state(
                    &conv_id,
                    "",
                    &[
                        (peer_fp.to_string(), String::new()),
                        (fp.clone(), nickname.clone()),
                    ],
                )?;
                let _ = engine.store.group_owner_set(&conv_id, peer_fp);
                let _ = engine.events.send(EngineEvent::GroupSynced {
                    conv_id,
                    title: String::new(),
                });
                return Ok(());
            }
            let membros = engine.store.list_group_members(&conv_id)?;
            if !membros.iter().any(|(f, _)| f == peer_fp) {
                return Err(DistorrentError::Protocol(
                    "GroupMemberAdded de fora do grupo".into(),
                ));
            }
            // Só o criador adiciona: "estar no grupo" não é permissão.
            let dono = engine
                .store
                .group_owner(&conv_id)?
                .unwrap_or_else(|| membros.first().map(|(f, _)| f.clone()).unwrap_or_default());
            if dono != peer_fp {
                return Err(DistorrentError::Protocol(
                    "só quem criou o grupo adiciona membros".into(),
                ));
            }
            if membros.len() >= 10 && !membros.iter().any(|(f, _)| f == &fp) {
                return Err(DistorrentError::Protocol(
                    "GroupMemberAdded acima do limite".into(),
                ));
            }
            // O criador ME readicionando limpa o bloqueio de quem saiu.
            if fp == engine.identity.fingerprint {
                let _ = crate::group_trash::restore(&engine.store, &conv_id);
            }
            engine.store.add_group_member(&conv_id, &fp, &nickname)?;
            let _ = engine.events.send(EngineEvent::GroupSynced {
                conv_id,
                title: String::new(),
            });
        }

        SecureFrame::GroupDeleted { conv_id } => {
            let membros = engine.store.list_group_members(&conv_id)?;
            let dono = engine
                .store
                .group_owner(&conv_id)?
                .unwrap_or_else(|| membros.first().map(|(f, _)| f.clone()).unwrap_or_default());
            if dono != peer_fp {
                return Err(DistorrentError::Protocol(
                    "GroupDeleted de quem não criou o grupo".into(),
                ));
            }
            engine.store.leave_group_local(&conv_id)?;
            let _ = engine.events.send(EngineEvent::GroupSynced {
                conv_id,
                title: String::new(),
            });
        }

        _ => {}
    }
    Ok(())
}
