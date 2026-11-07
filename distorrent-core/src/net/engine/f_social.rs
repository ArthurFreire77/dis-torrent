// Frames de social: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_social(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::React {
            conv_id,
            msg_id,
            emoji,
            add: add_from_peer,
            reactor_fp: _,
        } => {
            receive_reaction(
                engine,
                peer_fp,
                &conv_id,
                &msg_id,
                &emoji,
                add_from_peer,
                std::time::Instant::now(),
            )?;
        }

        SecureFrame::Reply {
            conv_id,
            msg_id,
            reply_to,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let Some(mine) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(DistorrentError::Protocol(
                    "citação de mensagem inexistente".into(),
                ));
            };
            if mine.conv_id != *conv_id {
                return Err(DistorrentError::Protocol(
                    "citação de conversa divergente".into(),
                ));
            }
            if mine.author_fp != peer_fp {
                return Err(DistorrentError::Protocol("só o autor cita assim".into()));
            }
            let target = engine.store.message_by_id(&reply_to).ok().flatten();
            if target.as_ref().map(|t| &t.conv_id) != Some(&conv_id) {
                return Err(DistorrentError::Protocol(
                    "alvo de citação inexistente".into(),
                ));
            }
            engine.store.msg_set_reply(&msg_id, &conv_id, &reply_to)?;
            let _ = engine.events.send(EngineEvent::MessageReply {
                msg_id: msg_id.clone(),
                reply_to: reply_to.clone(),
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::Reply {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                                reply_to: reply_to.clone(),
                            },
                        ))
                        .ok();
                }
            }
        }

        SecureFrame::MsgEdit {
            conv_id,
            msg_id,
            body,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let Some(orig) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(DistorrentError::Protocol(
                    "edição de mensagem inexistente".into(),
                ));
            };
            if orig.conv_id != conv_id {
                return Err(DistorrentError::Protocol("conversa divergente".into()));
            }
            if orig.author_fp != peer_fp {
                return Err(DistorrentError::Protocol("só o autor edita".into()));
            }
            let nb = cap_str(&body, 4000);
            if nb.trim().is_empty() {
                return Err(DistorrentError::Protocol("corpo vazio".into()));
            }
            let _ = engine.store.msg_edit(&msg_id, &conv_id, &nb);
            let _ = engine.events.send(EngineEvent::MessageEdited {
                msg_id: msg_id.clone(),
                conv_id: conv_id.clone(),
                body: nb.clone(),
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::MsgEdit {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                                body: nb.clone(),
                            },
                        ))
                        .ok();
                }
            }
        }

        SecureFrame::MsgDelete { conv_id, msg_id } => {
            let Some(orig) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Ok(());
            };
            if orig.conv_id != conv_id {
                return Ok(());
            }
            let is_author = orig.author_fp == peer_fp;
            if !is_author && !engine.can_moderate_conv(&conv_id, peer_fp) {
                return Err(DistorrentError::Protocol(
                    "sem permissão para apagar".into(),
                ));
            }
            let _ = engine.store.msg_delete(&msg_id, &conv_id);
            let _ = engine.events.send(EngineEvent::MessageDeleted {
                msg_id: msg_id.clone(),
                conv_id: conv_id.clone(),
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::MsgDelete {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                            },
                        ))
                        .ok();
                }
            }
        }

        SecureFrame::MsgPin {
            conv_id,
            msg_id,
            pinned,
        } => {
            if !engine.can_moderate_conv(&conv_id, peer_fp) {
                return Err(DistorrentError::Protocol("sem permissão para fixar".into()));
            }
            let Some(orig) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                return Err(DistorrentError::Protocol(
                    "pin de mensagem inexistente".into(),
                ));
            };
            if orig.conv_id != conv_id {
                return Err(DistorrentError::Protocol(
                    "pin de conversa divergente".into(),
                ));
            }
            engine.store.msg_pin(&msg_id, &conv_id, pinned, peer_fp)?;
            let _ = engine.events.send(EngineEvent::MessagePinned {
                msg_id: msg_id.clone(),
                conv_id: conv_id.clone(),
                pinned,
            });
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::MsgPin {
                                conv_id: conv_id.clone(),
                                msg_id: msg_id.clone(),
                                pinned,
                            },
                        ))
                        .ok();
                }
            }
        }

        SecureFrame::Forward {
            conv_id,
            channel_id,
            env,
            from_label,
        } => {
            if env.author_fp != peer_fp || !env.verify_with_pubkey(peer_pubkey) {
                return Err(DistorrentError::Protocol("encaminhamento inválido".into()));
            }
            // Encaminhar para um CANAL passa pelo host, como qualquer
            // ChannelMsg. Antes um amigo injetava `Forward` direto no meu
            // banco com conv_id de canal alheio, sem o host validar.
            if !channel_id.is_empty() {
                if let Some(cid) = engine.store.channel_community(&channel_id)? {
                    let host = engine
                        .store
                        .get_community(&cid)?
                        .map(|(_, _, owner)| owner)
                        .unwrap_or_default();
                    if engine.identity.fingerprint != host {
                        return Err(DistorrentError::Protocol(
                            "Forward para canal fora do host".into(),
                        ));
                    }
                    if engine.store.member_role(&cid, peer_fp).is_none() {
                        return Err(DistorrentError::Protocol(
                            "Forward de quem não é membro".into(),
                        ));
                    }
                }
            } else if !engine.is_social_contact(peer_fp) {
                return Err(DistorrentError::Protocol(
                    "Forward de quem não é contato".into(),
                ));
            }
            let label = cap_str(&from_label, 120);
            if engine.store.message_by_id(&env.id)?.is_some() {
                return Ok(());
            }
            let _ = engine.store.msg_set_forward(&env.id, &conv_id, &label);
            let _ = engine.store.insert_message(&env, "in", "ok");
            let stored = engine.store.message_by_id(&env.id).ok().flatten();
            if let Some(sm) = stored {
                let _ = engine.events.send(EngineEvent::MessageNew(sm));
            }
        }

        SecureFrame::PresenceSet {
            status,
            custom,
            custom_emoji,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            if !engine.is_social_contact(peer_fp) {
                // Presença de quem não é contato é ruído (ou sonda): ignorar.
                return Ok(());
            }
            let st = normalize_presence(&status);
            let _ = engine.store.presence_set(
                peer_fp,
                st,
                &cap_str(&custom, 128),
                &cap_str(&custom_emoji, 16),
            );
            let _ = engine.events.send(EngineEvent::PresenceChanged {
                fp: peer_fp.to_string(),
                status: st.to_string(),
                custom: cap_str(&custom, 128),
                custom_emoji: cap_str(&custom_emoji, 16),
            });
        }

        SecureFrame::PresencePing => {
            let p = engine
                .store
                .presence_get_live(&engine.identity.fingerprint)
                .unwrap_or_default();
            let st = if p.status == "offline" {
                "online".to_string()
            } else {
                p.status.clone()
            };
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::PresenceSet {
                        status: st,
                        custom: p.custom,
                        custom_emoji: p.custom_emoji,
                    },
                ))
                .ok();
        }

        SecureFrame::Typing { conv_id, until_ms } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            if !engine
                .social_peers_of(&conv_id)
                .iter()
                .any(|p| p == peer_fp)
            {
                return Ok(());
            }
            let now = crate::identity::now_ms();
            let until = until_ms.clamp(now, now + 15_000);
            for fp in engine.social_peers_of(&conv_id) {
                if fp != peer_fp {
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp,
                            SecureFrame::Typing {
                                conv_id: conv_id.clone(),
                                until_ms: until,
                            },
                        ))
                        .ok();
                }
            }
            let _ = engine.events.send(EngineEvent::PeerTyping {
                fp: peer_fp.to_string(),
                conv_id,
                until_ms: until,
            });
        }

        SecureFrame::ProfileSet {
            display_name,
            about,
            avatar_b64,
            banner_b64,
            accent,
            rev,
            content_hash,
        } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let dn = cap_str(&display_name, 48);
            let ab = cap_str(&about, 400);
            let av = cap_b64(&avatar_b64, PROFILE_IMG_B64_MAX);
            let bn = cap_b64(&banner_b64, PROFILE_BANNER_B64_MAX);
            let ac = normalize_accent(&accent);

            let calculado = crate::social::profile_content_hash(&dn, &ab, &av, &bn, &ac);
            if !content_hash.is_empty() && content_hash != calculado {
                return Err(DistorrentError::Protocol(
                    "ProfileSet com content_hash divergente do conteúdo".into(),
                ));
            }

            if rev < 0 {
                return Err(DistorrentError::Protocol(
                    "ProfileSet com rev negativo".into(),
                ));
            }
            let applied = engine
                .store
                .profile_apply_remote(peer_fp, &dn, &ab, &av, &bn, &ac, rev)?;
            if !applied {
                return Ok(());
            }
            // Perfil NUNCA cria amizade. Antes, receber um `ProfileSet` com
            // nome preenchido marcava `accepted` dos dois lados — qualquer
            // peer que conseguisse abrir uma sessão virava "amigo" e ganhava
            // permissão de DM e chamada sem ninguém aceitar nada.
            let p = engine.store.profile_get(peer_fp).unwrap_or_default();
            let _ = engine.events.send(EngineEvent::ProfileChanged {
                fp: peer_fp.to_string(),
                profile: p,
            });
        }

        SecureFrame::ProfileQuery { known_rev } => {
            if engine.is_blocked(peer_fp) {
                return Ok(());
            }
            let me = engine.identity.fingerprint.clone();
            let Ok(p) = engine.store.profile_get(&me) else {
                return Ok(());
            };
            if p.rev > known_rev {
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.to_string(),
                        profile_frame(&p),
                    ))
                    .ok();
            }
        }

        SecureFrame::ThreadCreate {
            community_id,
            thread_id,
            parent_channel,
            name,
            kind,
            tags,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol("thread só para membro".into()));
            }
            let t = crate::social::ThreadRow {
                id: cap_str(&thread_id, 64),
                community_id: community_id.clone(),
                parent_channel: parent_channel.clone(),
                name: cap_str(&name, 80),
                author_fp: peer_fp.to_string(),
                created_at: crate::identity::now_ms(),
                archived: false,
                kind: if kind == "forum" {
                    "forum".into()
                } else {
                    "thread".into()
                },
                tags: cap_str(&tags, 200),
            };
            let _ = engine.store.thread_upsert(&t);
            let _ = engine.events.send(EngineEvent::ThreadCreated {
                community_id: community_id.clone(),
                thread: t,
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::ThreadCreate {
                    community_id: community_id.clone(),
                    thread_id: thread_id.clone(),
                    parent_channel: parent_channel.clone(),
                    name: name.clone(),
                    kind: kind.clone(),
                    tags: tags.clone(),
                },
            );
        }

        SecureFrame::ThreadMsg {
            community_id,
            thread_id,
            parent_channel,
            env,
        } => {
            if env.author_fp != peer_fp || !env.verify_with_pubkey(peer_pubkey) {
                return Err(DistorrentError::Protocol(
                    "mensagem de thread inválida".into(),
                ));
            }
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol("thread só para membro".into()));
            }
            if engine.store.message_by_id(&env.id)?.is_some() {
                return Ok(());
            }
            let _ = engine
                .store
                .insert_message_in_thread(&env, &thread_id, "in", "ok");
            let _ = engine
                .store
                .msg_set_forward(&env.id, &thread_id, &parent_channel);
            if let Some(sm) = engine.store.message_by_id(&env.id).ok().flatten() {
                let _ = engine.events.send(EngineEvent::MessageNew(sm));
            }
            engine.broadcast_social(
                &community_id,
                SecureFrame::ThreadMsg {
                    community_id: community_id.clone(),
                    thread_id: thread_id.clone(),
                    parent_channel: parent_channel.clone(),
                    env: env.clone(),
                },
            );
        }

        SecureFrame::MemberBan {
            community_id,
            target_fp,
            until_ms,
            reason,
        } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(DistorrentError::Protocol("só o dono baneia".into()));
            }
            // Banir a si mesmo ou alguém fora do servidor não faz sentido e era aceito: o frame chegava com qualquer target_fp.
            if target_fp == peer_fp || target_fp == engine.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "não é possível banir a si ou ao dono".into(),
                ));
            }
            if engine
                .store
                .member_role(&community_id, &target_fp)
                .is_none()
            {
                return Err(DistorrentError::Protocol("alvo não é membro".into()));
            }
            let _ = engine.store.ban_set(
                &community_id,
                &target_fp,
                &cap_str(&reason, 300),
                peer_fp,
                until_ms,
            );
            let _ = engine.store.remove_member(&community_id, &target_fp);
            let _ = engine.events.send(EngineEvent::ModerationApplied {
                community_id: community_id.clone(),
                target_fp: target_fp.clone(),
                kind: "ban".into(),
                until_ms,
                reason: reason.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::MemberBan {
                    community_id: community_id.clone(),
                    target_fp: target_fp.clone(),
                    until_ms,
                    reason: reason.clone(),
                },
            );
        }

        SecureFrame::MemberTimeout {
            community_id,
            target_fp,
            until_ms,
            reason,
        } => {
            if !engine.is_moderator(&community_id, peer_fp) {
                return Err(DistorrentError::Protocol(
                    "sem permissão de moderação".into(),
                ));
            }
            if target_fp == peer_fp || target_fp == engine.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "não é possível silenciar a si ou ao dono".into(),
                ));
            }
            if engine
                .store
                .member_role(&community_id, &target_fp)
                .is_none()
            {
                return Err(DistorrentError::Protocol("alvo não é membro".into()));
            }
            let _ = engine.store.timeout_set(
                &community_id,
                &target_fp,
                until_ms,
                &cap_str(&reason, 300),
                peer_fp,
            );
            let _ = engine.events.send(EngineEvent::ModerationApplied {
                community_id: community_id.clone(),
                target_fp: target_fp.clone(),
                kind: "timeout".into(),
                until_ms,
                reason: reason.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::MemberTimeout {
                    community_id: community_id.clone(),
                    target_fp: target_fp.clone(),
                    until_ms,
                    reason: reason.clone(),
                },
            );
        }

        SecureFrame::ChannelCfg {
            community_id,
            channel_id,
            slowmode_secs,
            nsfw,
        } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(DistorrentError::Protocol("só o dono configura".into()));
            }
            let _ = engine.store.channel_cfg_set(
                &channel_id,
                slowmode_secs.clamp(0, 21_600),
                nsfw,
                false,
            );
            engine.broadcast_social(
                &community_id,
                SecureFrame::ChannelCfg {
                    community_id: community_id.clone(),
                    channel_id: channel_id.clone(),
                    slowmode_secs,
                    nsfw,
                },
            );
        }

        SecureFrame::PollCreate {
            community_id,
            channel_id,
            poll_id,
            question,
            options,
            multi,
            ends_at,
        } => {
            if engine.store.member_role(&community_id, peer_fp).is_none() {
                return Err(DistorrentError::Protocol("só membro cria enquete".into()));
            }
            let opts: Vec<String> = options.iter().take(10).map(|o| cap_str(o, 80)).collect();
            if opts.len() < 2 {
                return Err(DistorrentError::Protocol(
                    "enquete precisa de 2+ opções".into(),
                ));
            }
            let p = crate::social::PollRow {
                id: cap_str(&poll_id, 64),
                community_id: community_id.clone(),
                channel_id: channel_id.clone(),
                question: cap_str(&question, 200),
                options: opts,
                multi,
                author_fp: peer_fp.to_string(),
                created_at: crate::identity::now_ms(),
                ends_at,
                closed: false,
            };
            let _ = engine.store.poll_upsert(&p);
            let _ = engine.events.send(EngineEvent::PollUpdated {
                community_id: community_id.clone(),
                channel_id: channel_id.clone(),
                poll_id: poll_id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::PollCreate {
                    community_id: community_id.clone(),
                    channel_id: channel_id.clone(),
                    poll_id: poll_id.clone(),
                    question: question.clone(),
                    options: p.options.clone(),
                    multi,
                    ends_at,
                },
            );
        }

        SecureFrame::PollVote {
            community_id,
            channel_id,
            poll_id,
            option_idx,
        } => {
            let Some(poll) = engine
                .store
                .poll_list(&community_id, &channel_id)
                .ok()
                .and_then(|v| v.into_iter().find(|p| p.id == poll_id))
            else {
                return Ok(());
            };
            if poll.closed {
                return Err(DistorrentError::Protocol("enquete encerrada".into()));
            }
            if option_idx < 0 || option_idx as usize >= poll.options.len() {
                return Err(DistorrentError::Protocol("opção inválida".into()));
            }
            let _ = engine.store.poll_vote(&poll_id, peer_fp, option_idx);
            let _ = engine.events.send(EngineEvent::PollUpdated {
                community_id: community_id.clone(),
                channel_id: channel_id.clone(),
                poll_id: poll_id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::PollVote {
                    community_id: community_id.clone(),
                    channel_id: channel_id.clone(),
                    poll_id: poll_id.clone(),
                    option_idx,
                },
            );
        }

        SecureFrame::EventUpsert {
            community_id,
            event,
        } => {
            let is_owner = engine
                .store
                .get_community(&community_id)
                .ok()
                .flatten()
                .map(|(_, _, owner)| owner == peer_fp)
                .unwrap_or(false);
            if !is_owner {
                return Err(DistorrentError::Protocol("só o dono cria evento".into()));
            }
            let mut ev = event.clone();
            ev.entity_fp = peer_fp.to_string();
            ev.name = cap_str(&ev.name, 100);
            ev.location = cap_str(&ev.location, 120);
            ev.description = cap_str(&ev.description, 500);
            let _ = engine.store.event_upsert(&ev);
            let _ = engine.events.send(EngineEvent::EventUpdated {
                community_id: community_id.clone(),
                event_id: ev.id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::EventUpsert {
                    community_id: community_id.clone(),
                    event: ev,
                },
            );
        }

        SecureFrame::EventInterest {
            community_id,
            event_id,
        } => {
            let _ = engine
                .store
                .event_interest(&community_id, &event_id, peer_fp);
            let _ = engine.events.send(EngineEvent::EventUpdated {
                community_id: community_id.clone(),
                event_id: event_id.clone(),
            });
        }

        SecureFrame::EmojiUpsert {
            community_id,
            emoji,
        } => {
            if !engine.is_moderator(&community_id, peer_fp) {
                return Err(DistorrentError::Protocol("sem permissão".into()));
            }
            let mut e = emoji.clone();
            e.id = cap_str(&e.id, 64);
            e.name = cap_str(&e.name, 32);
            e.char = cap_str(&e.char, 8);
            if e.name.is_empty() || e.char.is_empty() {
                return Ok(());
            }
            let _ = engine.store.emoji_upsert(&e);
            let _ = engine.events.send(EngineEvent::EmojiUpdated {
                community_id: community_id.clone(),
                emoji_id: e.id.clone(),
            });
            engine.broadcast_social(
                &community_id,
                SecureFrame::EmojiUpsert {
                    community_id: community_id.clone(),
                    emoji: e,
                },
            );
        }

        _ => {}
    }
    Ok(())
}
