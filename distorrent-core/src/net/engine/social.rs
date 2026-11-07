// Metodos de NetworkEngine: social.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn send_channel_message(
        &self,
        community_id: &str,
        channel_id: &str,
        body: &str,
    ) -> Result<StoredMessage> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if self
            .store
            .member_role(community_id, &self.identity.fingerprint)
            .is_none()
        {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        if !self
            .store
            .list_channels(community_id)?
            .iter()
            .any(|(id, _)| id == channel_id)
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        self.gate_speech(community_id, channel_id)?;
        let env = MessageEnvelope::new(&self.keypair, channel_id, body);
        self.store.insert_message(&env, "out", "sending")?;
        let my = &self.identity.fingerprint;
        let targets = self.store.mention_targets(body);
        if targets.iter().any(|t| t == my) {
            self.store.msg_set_mentioned(&env.id, channel_id, true).ok();
        }
        for target in &targets {
            if target.len() == 12 {
                self.store.mention_add(&env.id, channel_id, target).ok();
            }
        }
        if targets.iter().any(|t| t == "everyone") {
            for (fp, _, _) in self.store.list_members(community_id)? {
                if &fp != my {
                    self.store.mention_add(&env.id, channel_id, &fp).ok();
                }
            }
        }
        crate::metrics::metrics().message_out();
        if comm.2 == self.identity.fingerprint {
            self.host_relay(community_id, channel_id, &env, "")?;
            self.store.set_message_status(&env.id, "sent")?;
        } else {
            let host_fp = comm.2;
            if self.link_tx(&host_fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        host_fp.clone(),
                        SecureFrame::ChannelMsg {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                            env: env.clone(),
                            bot_id: String::new(),
                        },
                    ))
                    .ok();
                self.store.set_message_status(&env.id, "sent")?;
            } else {
                self.store.enqueue_outbox(&env.id, &host_fp)?;
                self.store.set_message_status(&env.id, "pending")?;
            }
        }
        self.store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn gate_speech(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.gate_speech_for(community_id, channel_id, &self.identity.fingerprint)
    }

    pub fn gate_speech_for(
        &self,
        community_id: &str,
        channel_id: &str,
        author_fp: &str,
    ) -> Result<()> {
        let me = author_fp;
        let mute_until = self.store.mute_active(me).unwrap_or(0);
        if mute_until > crate::identity::now_ms() {
            let mins = ((mute_until - crate::identity::now_ms()) as f64 / 60_000.0).ceil() as i64;
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!("você está silenciado por mais {mins} min"),
                until_ms: mute_until,
            });
            return Err(DistorrentError::Protocol(format!(
                "você está silenciado por mais {mins} min"
            )));
        }
        if let Some(b) = self.store.ban_get(community_id, me).ok().flatten() {
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!(
                    "você está banido{}",
                    if b.reason.is_empty() {
                        String::new()
                    } else {
                        format!(": {}", b.reason)
                    }
                ),
                until_ms: b.until_ms,
            });
            return Err(DistorrentError::Protocol(
                "você está banido deste servidor".into(),
            ));
        }
        let until = self.store.timeout_active(community_id, me).unwrap_or(0);
        if until > 0 {
            let mins = ((until - crate::identity::now_ms()) as f64 / 60_000.0).ceil() as i64;
            let _ = self.events.send(EngineEvent::Muted {
                context: channel_id.into(),
                reason: format!("silenciado por mais {} min", mins),
                until_ms: until,
            });
            return Err(DistorrentError::Protocol(format!(
                "você está silenciado por mais {} min",
                mins
            )));
        }
        let slow = self.store.channel_cfg_slowmode(channel_id).unwrap_or(0);
        if slow > 0 && !self.is_moderator(community_id, me) {
            let wait = self.store.slowmode_gate(channel_id, me, slow).unwrap_or(0);
            if wait > 0 {
                let secs = (wait as f64 / 1000.0).ceil() as i64;
                let _ = self.events.send(EngineEvent::Muted {
                    context: channel_id.into(),
                    reason: format!("slowmode: aguarde {}s", secs),
                    until_ms: crate::identity::now_ms() + wait,
                });
                return Err(DistorrentError::Protocol(format!(
                    "slowmode: aguarde {}s",
                    secs
                )));
            }
        }
        Ok(())
    }

    fn to_social_peers(&self, conv_id: &str, frame: SecureFrame) {
        for fp in self.social_peers_of(conv_id) {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(fp, frame.clone()))
                .ok();
        }
    }

    pub fn social_react(&self, conv_id: &str, msg_id: &str, emoji: &str) -> Result<bool> {
        let me = self.identity.fingerprint.clone();
        let added = self
            .store
            .reaction_toggle(msg_id, conv_id, emoji, &me)
            .unwrap_or(false);
        self.events
            .send(EngineEvent::ReactionChanged {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
                emoji: emoji.into(),
                add: added,
                reactor_fp: me.clone(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::React {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                emoji: emoji.into(),
                add: added,
                reactor_fp: me.clone(),
            },
        );
        for fp in self.social_peers_of(conv_id) {
            if self.link_tx(&fp).is_none() {
                let _ = self
                    .store
                    .queue_pending_react(&fp, conv_id, msg_id, emoji, added);
            }
        }
        Ok(added)
    }

    pub fn social_reply(&self, conv_id: &str, msg_id: &str, reply_to: &str) -> Result<()> {
        let alvo = self
            .store
            .message_by_id(reply_to)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem citada não existe".into()))?;
        if alvo.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "a mensagem citada está em outra conversa".into(),
            ));
        }
        let portadora = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if portadora.conv_id != conv_id {
            return Err(DistorrentError::Protocol("conversa divergente".into()));
        }
        self.store.msg_set_reply(msg_id, conv_id, reply_to)?;
        self.events
            .send(EngineEvent::MessageReply {
                msg_id: msg_id.into(),
                reply_to: reply_to.into(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::Reply {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                reply_to: reply_to.into(),
            },
        );
        Ok(())
    }

    pub fn social_edit(&self, conv_id: &str, msg_id: &str, body: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let orig = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if orig.author_fp != me {
            return Err(DistorrentError::Protocol("só o autor edita".into()));
        }
        if orig.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "mensagem de outra conversa".into(),
            ));
        }
        let nb = cap_str(body, 4000);
        if nb.trim().is_empty() {
            return Err(DistorrentError::Protocol("corpo vazio".into()));
        }
        self.store.msg_edit(msg_id, conv_id, &nb)?;
        self.events
            .send(EngineEvent::MessageEdited {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
                body: nb.clone(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::MsgEdit {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                body: nb,
            },
        );
        Ok(())
    }

    pub fn social_delete(&self, conv_id: &str, msg_id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let orig = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if orig.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "mensagem de outra conversa".into(),
            ));
        }
        let is_author = orig.author_fp == me;
        // `is_moderator` espera community_id; em DM/grupo a permissão vem do
        // conv. Antes, passar o conv_id fazia `is_moderator` devolver false
        // sempre e o autor de grupo não conseguia apagar a própria mensagem
        // se o conv não fosse um canal.
        if !is_author && !self.can_moderate_conv(conv_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão para apagar".into(),
            ));
        }
        self.store.msg_delete(msg_id, conv_id)?;
        self.events
            .send(EngineEvent::MessageDeleted {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::MsgDelete {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
            },
        );
        Ok(())
    }

    pub fn social_pin(&self, conv_id: &str, msg_id: &str, pinned: bool) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.can_pin_conv(conv_id, &me) {
            return Err(DistorrentError::Protocol("sem permissão para fixar".into()));
        }
        let orig = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if orig.conv_id != conv_id {
            return Err(DistorrentError::Protocol(
                "mensagem de outra conversa".into(),
            ));
        }
        self.store.msg_pin(msg_id, conv_id, pinned, &me)?;
        self.events
            .send(EngineEvent::MessagePinned {
                msg_id: msg_id.into(),
                conv_id: conv_id.into(),
                pinned,
            })
            .ok();
        self.to_social_peers(
            conv_id,
            SecureFrame::MsgPin {
                conv_id: conv_id.into(),
                msg_id: msg_id.into(),
                pinned,
            },
        );
        Ok(())
    }

    pub fn social_forward(
        &self,
        src_msg_id: &str,
        target_conv: &str,
        target_channel: &str,
        from_label: &str,
    ) -> Result<StoredMessage> {
        let src = self
            .store
            .message_by_id(src_msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        let body = self.store.effective_body(src_msg_id, &src.body)?;
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol("mensagem longa demais".into()));
        }
        let env = MessageEnvelope::new(&self.keypair, target_conv, &body);
        self.store.insert_message(&env, "out", "sending")?;
        self.store
            .msg_set_forward(&env.id, target_conv, from_label)?;
        if let Some(sm) = self.store.message_by_id(&env.id)? {
            self.events.send(EngineEvent::MessageNew(sm)).ok();
        }
        let frame = SecureFrame::Forward {
            conv_id: target_conv.into(),
            channel_id: target_channel.into(),
            env: env.clone(),
            from_label: from_label.into(),
        };
        if let Some(comm) = self.store.channel_community(target_channel)? {
            self.broadcast_social(&comm, frame);
        } else {
            self.to_social_peers(target_conv, frame);
        }
        Ok(self
            .store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Protocol("falha ao gravar".into()))?)
    }

    pub fn social_presence_set(&self, status: &str, custom: &str, emoji: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let st = normalize_presence(status);
        self.store
            .presence_set(&me, st, &cap_str(custom, 128), &cap_str(emoji, 16))?;
        self.events
            .send(EngineEvent::PresenceChanged {
                fp: me,
                status: st.into(),
                custom: cap_str(custom, 128),
                custom_emoji: cap_str(emoji, 16),
            })
            .ok();
        self.announce_presence();
        Ok(())
    }

    pub fn social_profile_set(
        &self,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
    ) -> Result<crate::social::ProfileView> {
        self.social_profile_set_full(
            display_name,
            about,
            avatar_b64,
            banner_b64,
            accent,
            false,
            false,
        )
    }

    pub fn social_profile_set_full(
        &self,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
        clear_avatar: bool,
        clear_banner: bool,
    ) -> Result<crate::social::ProfileView> {
        let me = self.identity.fingerprint.clone();
        let dn = cap_str(display_name, 48);
        let ab = cap_str(about, 400);
        let ac = normalize_accent(accent);
        let av = cap_b64(avatar_b64, PROFILE_IMG_B64_MAX);
        let bn = cap_b64(banner_b64, PROFILE_BANNER_B64_MAX);

        let changed = self.store.profile_set_local(
            &me,
            &dn,
            &ab,
            &av,
            &bn,
            &ac,
            clear_avatar,
            clear_banner,
        )?;
        let profile = self.store.profile_get(&me)?;
        self.events
            .send(EngineEvent::ProfileChanged {
                fp: me.clone(),
                profile: profile.clone(),
            })
            .ok();

        if changed.is_some() {
            self.broadcast_profile(&profile);
        }
        Ok(profile)
    }

    pub fn broadcast_profile(&self, profile: &crate::social::ProfileView) {
        let me = self.identity.fingerprint.clone();
        let frame = profile_frame(profile);
        let mut alvos: std::collections::HashSet<String> = self
            .store
            .list_peers()
            .unwrap_or_default()
            .into_iter()
            .map(|p| p.fp)
            .collect();
        alvos.extend(self.online_peer_fps());
        alvos.remove(&me);
        for fp in alvos {
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(fp, frame.clone()))
                    .ok();
            }
        }
    }

    pub fn sync_profiles_with_peers(&self) {
        let me = self.identity.fingerprint.clone();
        for fp in self.online_peer_fps() {
            if fp == me {
                continue;
            }
            let known_rev = self.store.profile_get(&fp).map(|p| p.rev).unwrap_or(0);
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::ProfileQuery { known_rev },
                ))
                .ok();
        }
    }

    pub fn social_thread_create(
        &self,
        community_id: &str,
        parent_channel: &str,
        name: &str,
        kind: &str,
        tags: &str,
    ) -> Result<crate::social::ThreadRow> {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        let id = format!(
            "th_{}",
            &crate::protocol::new_message_id(&me, community_id, crate::identity::now_ms(), name)
                [..24]
        );
        let t = crate::social::ThreadRow {
            id,
            community_id: community_id.into(),
            parent_channel: parent_channel.into(),
            name: cap_str(name, 80),
            author_fp: me,
            created_at: crate::identity::now_ms(),
            archived: false,
            kind: if kind == "forum" {
                "forum".into()
            } else {
                "thread".into()
            },
            tags: cap_str(tags, 200),
        };
        self.store.thread_upsert(&t)?;
        self.events
            .send(EngineEvent::ThreadCreated {
                community_id: community_id.into(),
                thread: t.clone(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::ThreadCreate {
                community_id: community_id.into(),
                thread_id: t.id.clone(),
                parent_channel: parent_channel.into(),
                name: t.name.clone(),
                kind: t.kind.clone(),
                tags: t.tags.clone(),
            },
        );
        Ok(t)
    }

    pub fn social_thread_archive(&self, thread_id: &str, archived: bool) -> Result<()> {
        self.store.thread_archive(thread_id, archived)?;
        Ok(())
    }

    pub fn social_thread_send(
        &self,
        community_id: &str,
        thread_id: &str,
        body: &str,
    ) -> Result<StoredMessage> {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        let t = self
            .store
            .thread_get(thread_id)?
            .ok_or_else(|| DistorrentError::Protocol("thread inexistente".into()))?;
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        self.gate_speech(community_id, &t.parent_channel)?;
        let env = MessageEnvelope::new(&self.keypair, thread_id, body);
        self.store
            .insert_message_in_thread(&env, thread_id, "out", "sending")?;
        if body.contains(&me) {
            self.store.msg_set_mentioned(&env.id, thread_id, true).ok();
        }
        if let Some(sm) = self.store.message_by_id(&env.id)? {
            self.events.send(EngineEvent::MessageNew(sm)).ok();
        }
        self.broadcast_social(
            community_id,
            SecureFrame::ThreadMsg {
                community_id: community_id.into(),
                thread_id: thread_id.into(),
                parent_channel: t.parent_channel,
                env: env.clone(),
            },
        );
        Ok(self
            .store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Protocol("falha ao gravar".into()))?)
    }

    pub fn social_ban(
        &self,
        community_id: &str,
        target: &str,
        until_ms: i64,
        reason: &str,
    ) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me && !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        if target == comm.2 {
            return Err(DistorrentError::Protocol(
                "o dono não pode ser banido".into(),
            ));
        }
        self.store
            .ban_set(community_id, target, &cap_str(reason, 300), &me, until_ms)?;
        self.store.remove_member(community_id, target).ok();
        self.events
            .send(EngineEvent::ModerationApplied {
                community_id: community_id.into(),
                target_fp: target.into(),
                kind: "ban".into(),
                until_ms,
                reason: reason.into(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::MemberBan {
                community_id: community_id.into(),
                target_fp: target.into(),
                until_ms,
                reason: cap_str(reason, 300),
            },
        );
        Ok(())
    }

    pub fn social_unban(&self, community_id: &str, target: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        self.store.ban_remove(community_id, target)?;
        Ok(())
    }

    pub fn social_timeout(
        &self,
        community_id: &str,
        target: &str,
        until_ms: i64,
        reason: &str,
    ) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        self.store
            .timeout_set(community_id, target, until_ms, &cap_str(reason, 300), &me)?;
        self.events
            .send(EngineEvent::ModerationApplied {
                community_id: community_id.into(),
                target_fp: target.into(),
                kind: "timeout".into(),
                until_ms,
                reason: reason.into(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::MemberTimeout {
                community_id: community_id.into(),
                target_fp: target.into(),
                until_ms,
                reason: cap_str(reason, 300),
            },
        );
        Ok(())
    }

    pub fn social_channel_cfg(
        &self,
        community_id: &str,
        channel_id: &str,
        slowmode_secs: i64,
        nsfw: bool,
    ) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(DistorrentError::Protocol(
                "só o dono configura o canal".into(),
            ));
        }
        self.store
            .channel_cfg_set(channel_id, slowmode_secs.clamp(0, 21_600), nsfw, false)?;
        self.broadcast_social(
            community_id,
            SecureFrame::ChannelCfg {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                slowmode_secs,
                nsfw,
            },
        );
        Ok(())
    }

    pub fn social_poll_create(
        &self,
        community_id: &str,
        channel_id: &str,
        question: &str,
        options: Vec<String>,
        multi: bool,
        ends_at: i64,
    ) -> Result<crate::social::PollRow> {
        let me = self.identity.fingerprint.clone();
        if self.store.member_role(community_id, &me).is_none() {
            return Err(DistorrentError::Protocol("você não é membro".into()));
        }
        let opts: Vec<String> = options.iter().take(10).map(|o| cap_str(o, 80)).collect();
        if opts.len() < 2 {
            return Err(DistorrentError::Protocol(
                "enquete precisa de 2+ opções".into(),
            ));
        }
        let id = format!(
            "pl_{}",
            &crate::protocol::new_message_id(
                &me,
                community_id,
                crate::identity::now_ms(),
                question
            )[..24]
        );
        let p = crate::social::PollRow {
            id: id.clone(),
            community_id: community_id.into(),
            channel_id: channel_id.into(),
            question: cap_str(question, 200),
            options: opts.clone(),
            multi,
            author_fp: me,
            created_at: crate::identity::now_ms(),
            ends_at,
            closed: false,
        };
        self.store.poll_upsert(&p)?;
        self.events
            .send(EngineEvent::PollUpdated {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: id.clone(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::PollCreate {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: id,
                question: p.question.clone(),
                options: opts,
                multi,
                ends_at,
            },
        );
        Ok(p)
    }

    pub fn social_poll_vote(
        &self,
        community_id: &str,
        channel_id: &str,
        poll_id: &str,
        option_idx: i64,
    ) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let poll = self
            .store
            .poll_list(community_id, channel_id)?
            .into_iter()
            .find(|p| p.id == poll_id)
            .ok_or_else(|| DistorrentError::Protocol("enquete inexistente".into()))?;
        if poll.closed {
            return Err(DistorrentError::Protocol("enquete encerrada".into()));
        }
        if option_idx < 0 || option_idx as usize >= poll.options.len() {
            return Err(DistorrentError::Protocol("opção inválida".into()));
        }
        self.store.poll_vote(poll_id, &me, option_idx)?;
        self.events
            .send(EngineEvent::PollUpdated {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: poll_id.into(),
            })
            .ok();
        self.broadcast_social(
            community_id,
            SecureFrame::PollVote {
                community_id: community_id.into(),
                channel_id: channel_id.into(),
                poll_id: poll_id.into(),
                option_idx,
            },
        );
        Ok(())
    }

    pub fn social_event_upsert(&self, ev: crate::social::EventRow) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(&ev.community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(DistorrentError::Protocol("só o dono cria eventos".into()));
        }
        let mut e = ev.clone();
        e.entity_fp = me;
        e.name = cap_str(&e.name, 100);
        e.location = cap_str(&e.location, 120);
        e.description = cap_str(&e.description, 500);
        self.store.event_upsert(&e)?;
        self.events
            .send(EngineEvent::EventUpdated {
                community_id: e.community_id.clone(),
                event_id: e.id.clone(),
            })
            .ok();
        let comm_id = e.community_id.clone();
        let frame_comm = comm_id.clone();
        self.broadcast_social(
            &comm_id,
            SecureFrame::EventUpsert {
                community_id: frame_comm,
                event: e,
            },
        );
        Ok(())
    }

    pub fn social_event_interest(&self, community_id: &str, event_id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        self.store.event_interest(community_id, event_id, &me)?;
        self.broadcast_social(
            community_id,
            SecureFrame::EventInterest {
                community_id: community_id.into(),
                event_id: event_id.into(),
            },
        );
        Ok(())
    }

    pub fn social_event_delete(&self, community_id: &str, event_id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != me {
            return Err(DistorrentError::Protocol("só o dono exclui eventos".into()));
        }
        self.store.event_delete(community_id, event_id)?;
        self.events
            .send(EngineEvent::EventUpdated {
                community_id: community_id.into(),
                event_id: event_id.into(),
            })
            .ok();
        Ok(())
    }

    pub fn social_emoji_upsert(&self, e: crate::social::EmojiRow) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(&e.community_id, &me) {
            return Err(DistorrentError::Protocol("sem permissão".into()));
        }
        let mut row = e;
        row.name = cap_str(&row.name, 32);
        row.char = cap_str(&row.char, 8);
        if row.name.is_empty() || row.char.is_empty() {
            return Err(DistorrentError::Protocol("emoji incompleto".into()));
        }
        self.store.emoji_upsert(&row)?;
        self.events
            .send(EngineEvent::EmojiUpdated {
                community_id: row.community_id.clone(),
                emoji_id: row.id.clone(),
            })
            .ok();
        let comm_id = row.community_id.clone();
        let frame_comm = comm_id.clone();
        self.broadcast_social(
            &comm_id,
            SecureFrame::EmojiUpsert {
                community_id: frame_comm,
                emoji: row,
            },
        );
        Ok(())
    }

    pub fn social_emoji_delete(&self, community_id: &str, id: &str) -> Result<()> {
        let me = self.identity.fingerprint.clone();
        if !self.is_moderator(community_id, &me) {
            return Err(DistorrentError::Protocol("sem permissão".into()));
        }
        self.store.emoji_delete(community_id, id)?;
        Ok(())
    }

    pub fn social_typing(&self, conv_id: &str) -> Result<()> {
        let until = crate::identity::now_ms() + 6_000;
        let frame = SecureFrame::Typing {
            conv_id: conv_id.to_string(),
            until_ms: until,
        };
        self.to_social_peers(conv_id, frame);
        Ok(())
    }

    pub(super) fn flush_pending_reacts(&self, peer_fp: &str) {
        let pending = self.store.take_pending_reacts(peer_fp).unwrap_or_default();
        if pending.is_empty() {
            return;
        }
        let me = self.identity.fingerprint.clone();
        for (conv_id, msg_id, emoji, add) in pending {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::React {
                        conv_id,
                        msg_id,
                        emoji,
                        add,
                        reactor_fp: me.clone(),
                    },
                ))
                .ok();
        }
    }
}
