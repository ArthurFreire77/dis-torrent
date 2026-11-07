// Frames de message: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_message(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::Msg(env) => {
            if engine.is_blocked(peer_fp) {
                return Err(DistorrentError::Protocol("peer bloqueado".into()));
            }
            if env.author_fp != peer_fp {
                return Err(DistorrentError::Protocol(
                    "author != peer da conexão".into(),
                ));
            }
            if !env.verify_with_pubkey(peer_pubkey) {
                return Err(DistorrentError::Protocol(
                    "assinatura da mensagem inválida".into(),
                ));
            }
            if engine.store.message_by_id(&env.id)?.is_some() {
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
                return Ok(());
            }
            engine.spam_gate(peer_fp, &env.body)?;
            let conv_kind = engine.store.get_conversation(&env.conv_id)?.map(|c| c.kind);
            if conv_kind.as_deref() == Some("group") {
                let is_member = engine
                    .store
                    .list_group_members(&env.conv_id)?
                    .iter()
                    .any(|(fp, _)| fp == &env.author_fp);
                if !is_member {
                    return Err(DistorrentError::Protocol(
                        "autor não é membro do grupo".into(),
                    ));
                }
                engine.store.insert_message(&env, "in", "ok")?;
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: String::new(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
            } else if conv_kind.is_none()
                && engine
                    .store
                    .get_friend(peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false)
                && env.conv_id
                    != crate::storage::Store::dm_conversation_id(
                        &engine.identity.fingerprint,
                        peer_fp,
                    )
                && !crate::group_trash::is_dismissed(&engine.store, &env.conv_id)
            {
                // Só vira grupo se o conv_id NÃO é a DM determinística deste
                // peer. Antes, apagar a conversa local e receber uma mensagem
                // de amigo recriava um "grupo" chamado "Grupo" com uma pessoa
                // — e a DM de verdade nunca voltava.
                engine.store.upsert_group_state(
                    &env.conv_id,
                    "Grupo",
                    &[(peer_fp.to_string(), peer_nick.to_string())],
                )?;
                engine.store.insert_message(&env, "in", "ok")?;
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: String::new(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
            } else {
                let is_friend = engine
                    .store
                    .get_friend(peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false);
                let conv = engine.open_dm(peer_fp, peer_nick)?;
                if env.conv_id != conv.id {
                    return Err(DistorrentError::Protocol(
                        "conv_id não corresponde à DM deste peer".into(),
                    ));
                }
                // Introdução: o RECEPTOR também conta. Se o cliente do outro
                // lado foi alterado (ou a mensagem é replay), o limite vale
                // aqui — sem isso o gate do emissor seria a única barreira.
                let intro = !is_friend;
                if intro
                    && !engine.store.dm_intro_take(
                        &env.conv_id,
                        peer_fp,
                        crate::social::DM_INTRO_LIMIT,
                    )?
                {
                    return Err(DistorrentError::Protocol(format!(
                        "limite de {} mensagens iniciais deste peer atingido",
                        crate::social::DM_INTRO_LIMIT
                    )));
                }
                if let Err(e) = engine.store.insert_message(&env, "in", "ok") {
                    if intro {
                        let _ = engine.store.dm_intro_refund(&env.conv_id, peer_fp);
                    }
                    return Err(e);
                }
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: String::new(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.into(),
                        SecureFrame::Ack { msg_id: env.id },
                    ))
                    .ok();
            }
        }

        SecureFrame::Ack { msg_id } => {
            engine.diag_update(peer_fp, |d| {
                d.last_ack_ms = crate::identity::now_ms();
            });
            if let Some(m) = engine.store.message_by_id(&msg_id)? {
                if m.direction == "out" {
                    let ack_ok = match engine
                        .store
                        .get_conversation(&m.conv_id)?
                        .map(|c| (c.kind, c.peer_fp))
                    {
                        Some((kind, peer)) if kind == "dm" => peer == peer_fp,
                        Some((kind, _)) if kind == "group" => engine
                            .store
                            .list_group_members(&m.conv_id)?
                            .iter()
                            .any(|(fp, _)| fp == peer_fp),
                        _ => false,
                    };
                    if !ack_ok {
                        return Err(DistorrentError::Protocol(
                            "Ack de peer não autorizado".into(),
                        ));
                    }
                    engine.store.set_message_status(&msg_id, "delivered")?;
                    let is_group = engine
                        .store
                        .get_conversation(&m.conv_id)?
                        .map(|c| c.kind == "group")
                        .unwrap_or(false);
                    if !is_group {
                        engine.store.dequeue_outbox(&msg_id)?;
                    }
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id,
                        status: "delivered".into(),
                    });
                }
            }
        }

        SecureFrame::Read { conv_id, up_to_ts } => {
            engine.diag_update(peer_fp, |d| {
                d.last_ack_ms = crate::identity::now_ms();
            });
            let ack_ok = match engine
                .store
                .get_conversation(&conv_id)?
                .map(|c| (c.kind, c.peer_fp))
            {
                Some((kind, peer)) if kind == "dm" => peer == peer_fp,
                Some((kind, _)) if kind == "group" => engine
                    .store
                    .list_group_members(&conv_id)?
                    .iter()
                    .any(|(fp, _)| fp == peer_fp),
                _ => false,
            };
            if !ack_ok {
                return Err(DistorrentError::Protocol(
                    "Read de peer não autorizado".into(),
                ));
            }
            // Recibo POR MEMBRO: num grupo/canal, o `read` de um participante não pode marcar a mensagem como lida para todos.
            let _ = engine
                .store
                .record_read_receipt(&conv_id, peer_fp, up_to_ts)?;
            let esperados = engine.social_peers_of(&conv_id);
            let ids = engine
                .store
                .messages_read_by_all(&conv_id, up_to_ts, &esperados)?;
            for msg_id in ids {
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id,
                    status: "read".into(),
                });
            }
        }

        SecureFrame::ChannelMsg {
            community_id,
            channel_id,
            env,
            bot_id,
        } => {
            let comm = engine
                .store
                .get_community(&community_id)?
                .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
            let is_host = comm.2 == engine.identity.fingerprint;
            let bot_id = if bot_id.trim().is_empty() {
                String::new()
            } else {
                if !is_host {
                    return Err(DistorrentError::Protocol(
                        "mensagem de bot fora do host".into(),
                    ));
                }
                if !engine
                    .store
                    .bots_list(&community_id)?
                    .iter()
                    .any(|b| b.id == bot_id)
                {
                    return Err(DistorrentError::Protocol("bot inexistente".into()));
                }
                bot_id.trim().to_string()
            };
            if is_host {
                if engine
                    .store
                    .member_role(&community_id, &env.author_fp)
                    .is_none()
                {
                    return Err(DistorrentError::Protocol("autor não é membro".into()));
                }
                if !engine
                    .store
                    .list_channels(&community_id)?
                    .iter()
                    .any(|(id, _)| *id == channel_id)
                {
                    return Err(DistorrentError::Protocol("canal inexistente".into()));
                }
                if env.conv_id != channel_id {
                    return Err(DistorrentError::Protocol("env.conv_id != canal".into()));
                }
                if !env.verify_with_pubkey(peer_pubkey) {
                    return Err(DistorrentError::Protocol("assinatura inválida".into()));
                }
                if env.author_fp != peer_fp {
                    return Err(DistorrentError::Protocol(
                        "author != peer da conexão".into(),
                    ));
                }
                engine.spam_gate(peer_fp, &env.body)?;
                engine.server_rules_gate(&community_id, &env.author_fp, &env.body)?;
                engine.gate_speech_for(&community_id, &channel_id, &env.author_fp)?;
                if engine.store.message_by_id(&env.id)?.is_some() {
                    engine.host_relay(&community_id, &channel_id, &env, &bot_id)?;
                    return Ok(());
                }
                if bot_id.is_empty() {
                    engine.store.insert_message(&env, "in", "ok")?;
                } else {
                    engine
                        .store
                        .insert_message_as_bot(&env, "in", "ok", &bot_id)?;
                }
                // Menções são registradas no host para TODOS os membros: é dele que sai o contador de "menções não lidas" de cada um.
                for target in engine.store.mention_targets(&env.body) {
                    if target == "everyone" {
                        for (fp, _, _) in engine.store.list_members(&community_id)? {
                            if fp != env.author_fp {
                                engine.store.mention_add(&env.id, &channel_id, &fp).ok();
                            }
                        }
                    } else {
                        engine.store.mention_add(&env.id, &channel_id, &target).ok();
                    }
                }
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: bot_id.clone(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
                engine.host_relay(&community_id, &channel_id, &env, &bot_id)?;
            } else {
                if peer_fp != comm.2 {
                    return Err(DistorrentError::Protocol("ChannelMsg fora do host".into()));
                }
                if env.conv_id != channel_id {
                    return Err(DistorrentError::Protocol("env.conv_id != canal".into()));
                }
                if engine
                    .store
                    .member_role(&community_id, &env.author_fp)
                    .is_none()
                {
                    return Err(DistorrentError::Protocol("autor não é membro".into()));
                }
                let sig_ok = if env.author_fp == peer_fp {
                    env.verify_with_pubkey(peer_pubkey)
                } else {
                    match engine.store.get_peer(&env.author_fp)?.map(|p| p.pubkey_hex) {
                        Some(author_pub) => env.verify_with_pubkey(&author_pub),
                        // Sem a chave do autor não há como provar que foi ele.
                        // Antes isso era aceito com um `warn` — uma mensagem
                        // forjada em nome de um membro passava pelo host.
                        None => false,
                    }
                };
                if !sig_ok {
                    return Err(DistorrentError::Protocol("assinatura inválida".into()));
                }
                if engine.store.message_by_id(&env.id)?.is_some() {
                    return Ok(());
                }
                if bot_id.is_empty() {
                    engine.store.insert_message(&env, "in", "ok")?;
                } else {
                    engine
                        .store
                        .insert_message_as_bot(&env, "in", "ok", &bot_id)?;
                }
                crate::metrics::metrics().message_in();
                let stored = engine.store.message_by_id(&env.id)?.unwrap_or_else(|| {
                    super::super::super::storage::StoredMessage {
                        id: env.id.clone(),
                        conv_id: env.conv_id.clone(),
                        author_fp: env.author_fp.clone(),
                        body: String::new(),
                        ts: env.ts,
                        sig: String::new(),
                        direction: "in".into(),
                        status: "ok".into(),
                        bot_id: bot_id.clone(),
                        thread_id: String::new(),
                    }
                });
                let _ = engine.events.send(EngineEvent::MessageNew(stored));
            }
        }

        SecureFrame::ChannelAck { env_id } => {
            if engine.store.message_by_id(&env_id)?.map(|m| m.direction) == Some("out".into()) {
                let ack_ok = engine
                    .store
                    .message_by_id(&env_id)?
                    .map(|m| m.conv_id)
                    .and_then(|conv| engine.store.channel_community(&conv).ok().flatten())
                    .and_then(|cid| engine.store.get_community(&cid).ok().flatten())
                    .map(|(_, _, owner)| owner == peer_fp)
                    .unwrap_or(false);
                if !ack_ok {
                    return Err(DistorrentError::Protocol("ChannelAck fora do host".into()));
                }
                engine.store.set_message_status(&env_id, "delivered")?;
                engine.store.dequeue_outbox(&env_id)?;
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: env_id,
                    status: "delivered".into(),
                });
            }
        }

        _ => {}
    }
    Ok(())
}
