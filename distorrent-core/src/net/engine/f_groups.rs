// Frames de groups: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_groups(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::GroupCreated {
            conv_id,
            title,
            members,
            owner_fp,
        } => {
            if !members.iter().any(|(fp, _)| fp == peer_fp) {
                return Err(DistorrentError::Protocol(
                    "GroupCreated sem o criador na lista".into(),
                ));
            }
            if members.len() > 10 {
                return Err(DistorrentError::Protocol(
                    "GroupCreated com roster acima do limite".into(),
                ));
            }
            let eu = &engine.identity.fingerprint;
            let me_incluiu = members.iter().any(|(fp, _)| fp == eu);
            // Só o CRIADOR do grupo pode reescrever o roster. Antes qualquer
            // membro mandava GroupCreated e mudava (ou esvaziava) o grupo de
            // todos, e um peer removido reentrava sozinho reenviando o frame.
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
                    // Roster reenviado por quem não criou é ignorado em
                    // silêncio: derrubar a sessão puniria o mensageiro e não
                    // impede nada (o próximo tick reenviaria).
                    return Ok(());
                }
            }
            // Grava o dono. `owner_fp` do frame é a fonte nova; frames antigos
            // vêm com vazio e a convenção do primeiro membro vale como antes.
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
                if !me_incluiu {
                    return Ok(());
                }
                // Só o criador me readiciona de propósito. Sem esta checagem
                // qualquer membro que reenviasse o roster antigo (rename,
                // add-membro, flush de reconexão) ressuscitava o grupo que eu
                // deixei — era o "saio e ele volta minutos depois".
                let criador = crate::group_trash::owner_of(&engine.store, &conv_id);
                let primeiro_do_roster = members
                    .first()
                    .map(|(fp, _)| fp.clone())
                    .unwrap_or_default();
                // Criador gravado que sumiu do roster é dado velho: cai para a
                // convenção do resto do grupo (criador = primeiro da lista),
                // senão eu nunca mais conseguiria voltar.
                let dono_conhecido = criador
                    .filter(|fp| members.iter().any(|(m, _)| m == fp))
                    .unwrap_or_else(|| primeiro_do_roster.clone());
                if dono_conhecido != peer_fp {
                    return Ok(());
                }
                let _ = crate::group_trash::restore(&engine.store, &conv_id);
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
            let membros = engine.store.list_group_members(&conv_id)?;
            if !membros.iter().any(|(f, _)| f == peer_fp) {
                return Err(DistorrentError::Protocol(
                    "GroupMemberAdded de fora do grupo".into(),
                ));
            }
            // Só o criador adiciona. "Estar no grupo" não é permissão.
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
