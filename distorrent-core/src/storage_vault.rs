// Metodos de Store: stormvault/core.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

impl Store {
    pub fn count_hidden(&self) -> Result<i64> {
        Ok(self
            .locked()
            .query_row("SELECT COUNT(*) FROM local_hidden", [], |r| r.get(0))?)
    }

    pub fn mark_read_outgoing(&self, conv_id: &str, up_to_ts: i64) -> Result<Vec<String>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id FROM messages
             WHERE conv_id=?1 AND direction='out'
               AND ts<=?2 AND status NOT IN ('read','failed')",
        )?;
        let ids = st
            .query_map(params![conv_id, up_to_ts], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(st);
        for id in &ids {
            conn.execute("UPDATE messages SET status='read' WHERE id=?1", params![id])?;
        }
        Ok(ids)
    }

    pub fn revert_stale_sent_to_pending(
        &self,
        peer_fp: &str,
        older_than_ts: i64,
    ) -> Result<Vec<String>> {
        let ids = {
            let conn = self.locked();
            let mut st = conn.prepare(
                "SELECT id FROM messages
                 WHERE direction='out' AND status IN ('sending','sent') AND ts < ?1
                   AND conv_id IN (SELECT id FROM conversations WHERE peer_fp=?2)
                   AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.msg_id = messages.id)",
            )?;
            let ids = st
                .query_map(params![older_than_ts, peer_fp], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(st);
            ids
        };
        for id in &ids {
            self.set_message_status(id, "pending")?;
            self.enqueue_outbox(id, peer_fp)?;
        }
        Ok(ids)
    }

    pub fn revert_all_sending_to_pending(&self) -> Result<usize> {
        let ids = {
            let conn = self.locked();
            let mut st =
                conn.prepare("SELECT id FROM messages WHERE direction='out' AND status='sending'")?;
            let ids = st
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(st);
            ids
        };
        let mut n = 0usize;
        for id in &ids {
            self.set_message_status(id, "pending")?;
            n += 1;
        }
        Ok(n)
    }

    pub fn revert_unacked_to_pending(&self, peer_fp: &str) -> Result<Vec<String>> {
        let ids = {
            let conn = self.locked();
            let mut st = conn.prepare(
                "SELECT id FROM messages
                 WHERE direction='out' AND status IN ('sending','sent')
                   AND conv_id IN (SELECT id FROM conversations WHERE peer_fp=?1)",
            )?;
            let ids = st
                .query_map(params![peer_fp], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(st);
            ids
        };
        for id in &ids {
            self.set_message_status(id, "pending")?;
            self.enqueue_outbox(id, peer_fp)?;
        }
        Ok(ids)
    }

    pub fn upsert_member(
        &self,
        community_id: &str,
        fp: &str,
        nickname: &str,
        role: &str,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT INTO community_members(community_id,fp,nickname,role,joined_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(community_id,fp) DO UPDATE SET nickname=excluded.nickname, role=excluded.role",
            params![community_id, fp, nickname, role, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn list_members(&self, community_id: &str) -> Result<Vec<(String, String, String)>> {
        let conn = self.locked();
        let mut st = conn.prepare("SELECT fp,nickname,role FROM community_members WHERE community_id=?1 ORDER BY joined_at")?;
        let rows = st
            .query_map(params![community_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub(super) fn parse_json_list(s: &str) -> Vec<String> {
        serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
    }

    pub fn upsert_channel(&self, community_id: &str, r: &ChannelMetaRow) -> Result<()> {
        let conn = self.locked();
        insert_channel_row(&conn, community_id, r)
    }

    pub fn delete_channel(&self, community_id: &str, channel_id: &str) -> Result<usize> {
        let conn = self.locked();
        conn.execute(
            "DELETE FROM channels WHERE community_id=?1 AND id=?2",
            params![community_id, channel_id],
        )
        .map_err(Into::into)
    }

    pub fn update_channel(
        &self,
        community_id: &str,
        channel_id: &str,
        name: Option<&str>,
        topic: Option<&str>,
        category: Option<&str>,
    ) -> Result<usize> {
        let rows = self.channel_rows(community_id)?;
        let Some(mut r) = rows.into_iter().find(|c| c.id == channel_id) else {
            return Ok(0);
        };
        if let Some(n) = name {
            if !n.is_empty() {
                r.name = n.to_string();
            }
        }
        if let Some(t) = topic {
            r.topic = t.to_string();
        }
        if let Some(c) = category {
            if !c.is_empty() {
                r.category = c.to_string();
            }
        }
        let conn = self.locked();
        insert_channel_row(&conn, community_id, &r)?;
        Ok(1)
    }

    pub fn set_channel_category(
        &self,
        community_id: &str,
        channel_id: &str,
        category: &str,
    ) -> Result<usize> {
        self.update_channel(community_id, channel_id, None, None, Some(category))
    }

    pub fn remove_member(&self, community_id: &str, fp: &str) -> Result<()> {
        self.locked().execute(
            "DELETE FROM community_members WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
        )?;
        Ok(())
    }

    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.locked();
        f(&conn)
    }

    pub(crate) fn stormvault_collect(
        &self,
        secret_hex: Option<String>,
        max_messages: Option<usize>,
        settings_whitelist: &[&str],
    ) -> Result<crate::stormvault::StormVaultData> {
        let identity = self.load_identity().ok_or_else(|| {
            crate::DistorrentError::Protocol("sem identidade para exportar".into())
        })?;
        let my_fp = identity.fingerprint.clone();

        let conversations = self.list_conversations()?;
        let total_msgs = self.count_messages().unwrap_or(0);
        let cap = max_messages.unwrap_or(crate::stormvault::DEFAULT_MAX_MESSAGES);
        let mut messages: Vec<StoredMessage> = self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id,thread_id FROM messages
                 ORDER BY ts DESC, id DESC LIMIT ?1",
            )?;
            let rows = st
                .query_map(params![cap as i64], |r| {
                    Ok(StoredMessage {
                        id: r.get(0)?,
                        conv_id: r.get(1)?,
                        author_fp: r.get(2)?,
                        body: r.get(3)?,
                        ts: r.get(4)?,
                        sig: r.get(5)?,
                        direction: r.get(6)?,
                        status: r.get(7)?,
                        bot_id: r.get(8)?,
                        thread_id: r.get(9)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        messages.reverse();
        let truncated = (messages.len() as i64) < total_msgs;

        let friends = self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT fp,nickname,status,added_at,requested_by,requested_at,blocked_at
                 FROM friends ORDER BY added_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::FriendRow {
                        fp: r.get(0)?,
                        nickname: r.get(1)?,
                        status: r.get(2)?,
                        added_at: r.get(3)?,
                        requested_by: r.get(4)?,
                        requested_at: r.get(5)?,
                        blocked_at: r.get(6)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;

        let peers = self.list_peers()?;

        let mut communities = Vec::new();
        let mut all_rules = Vec::new();
        for (id, name, owner) in self.list_communities()? {
            let channels = self.channel_rows(&id)?;
            let roles = self.roles_list(&id)?;
            let mut bots = self.with_conn(|conn| {
                let mut st = conn.prepare(
                    "SELECT id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config,perms,webhook_secret
                     FROM bots WHERE community_id=?1 ORDER BY created_at",
                )?;
                let rows = st
                    .query_map(params![id], Self::bot_row_mapper())?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })?;
            // Token e segredo de webhook são credenciais do dono, presas a ESTE
            // aparelho. Não viajam no cofre: quem restaura regenera o token.
            for b in bots.iter_mut() {
                b.token.clear();
                b.webhook_secret.clear();
            }
            let members = self.list_members(&id)?;
            let mut member_roles = Vec::new();
            for (fp, _, _) in &members {
                let role_ids = self.member_roles_list(&id, fp)?;
                if !role_ids.is_empty() {
                    member_roles.push((fp.clone(), role_ids));
                }
            }
            let created_at = self
                .with_conn(|conn| {
                    Ok(conn.query_row(
                        "SELECT created_at FROM communities WHERE id=?1",
                        params![id],
                        |r| r.get::<_, i64>(0),
                    )?)
                })
                .unwrap_or(0);
            let (description, category, icon) = self.community_meta(&id).unwrap_or_default();
            let rules = self.get_server_rules(&id).ok();
            communities.push(crate::stormvault::CommunityExport {
                id: id.clone(),
                name,
                owner_fp: owner,
                created_at,
                description,
                category,
                icon,
                channels,
                roles,
                bots,
                members,
                member_roles,
            });
            if let Some(r) = rules {
                all_rules.push(r);
            }
        }
        let reputations = self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT fp,trust,score,reports,updated_at FROM reputation ORDER BY updated_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::ReputationRow {
                        fp: r.get(0)?,
                        trust: r.get(1)?,
                        score: r.get(2)?,
                        reports: r.get::<_, i64>(3)? as u32,
                        updated_at: r.get(4)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        let audit = self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT id,community_id,actor_fp,action,target_fp,reason,created_at FROM audit_log
                 ORDER BY created_at DESC LIMIT 2000",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::moderation::AuditEntry {
                        id: r.get(0)?,
                        community_id: r.get(1)?,
                        actor_fp: r.get(2)?,
                        action: r.get(3)?,
                        target_fp: r.get(4)?,
                        reason: r.get(5)?,
                        created_at: r.get(6)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;
        let reports = self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT id,reporter_fp,target_fp,community_id,reason,status,created_at FROM reports
                 ORDER BY created_at DESC LIMIT 500",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::ReportRow {
                        id: r.get(0)?,
                        reporter_fp: r.get(1)?,
                        target_fp: r.get(2)?,
                        community_id: r.get(3)?,
                        reason: r.get(4)?,
                        status: r.get(5)?,
                        created_at: r.get(6)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })?;

        let mut groups = Vec::new();
        for conv in conversations.iter().filter(|c| c.kind == "group") {
            let members = self.list_group_members(&conv.id)?;
            groups.push(crate::stormvault::GroupExport {
                conv: conv.clone(),
                members,
            });
        }

        let settings = settings_whitelist
            .iter()
            .filter_map(|k| self.kv_get(k).map(|v| (k.to_string(), v)))
            .collect();

        Ok(crate::stormvault::StormVaultData {
            identity,
            secret_hex,
            conversations,
            messages,
            friends,
            peers,
            communities,
            rules: all_rules,
            reputations,
            audit,
            reports,
            groups,
            settings,
            meta: crate::stormvault::StormVaultMeta {
                app_version: option_env!("CARGO_PKG_VERSION").map(|s| s.to_string()),
                messages_truncated: truncated,
                data_version: crate::stormvault::DATA_VERSION,
            },
            profiles: self.collect_profiles()?,
            presence: self.collect_own_presence()?,
            reactions: self.collect_reactions()?,
            message_meta: self.collect_message_meta()?,
            read_states: self.collect_read_states()?,
            bookmarks: self.collect_bookmarks()?,
            threads: self.collect_threads()?,
            polls: self.collect_polls()?,
            poll_votes: self.collect_poll_votes()?,
            events: self.collect_events()?,
            emojis: self.collect_emojis()?,
            bans: self.collect_bans()?,
            timeouts: self.collect_timeouts()?,
            channel_cfg: self.collect_channel_cfg()?,
            server_nicknames: self.collect_server_nicknames()?,
            group_owners: self.collect_group_owners()?,
            mentions: self.collect_mentions(&my_fp)?,
            hidden: self.collect_hidden()?,
        })
    }

    fn collect_profiles(&self) -> Result<Vec<crate::social::ProfileView>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT fp,display_name,about,avatar_b64,banner_b64,accent,updated_at,rev,content_hash
                 FROM profiles ORDER BY updated_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::social::ProfileView {
                        fp: r.get(0)?,
                        display_name: r.get(1)?,
                        about: r.get(2)?,
                        avatar_b64: r.get(3)?,
                        banner_b64: r.get(4)?,
                        accent: r.get(5)?,
                        updated_at: r.get(6)?,
                        rev: r.get(7)?,
                        content_hash: r.get(8)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Presença de TERCEIROS é efêmera (TTL de 90 s): só o próprio status
    /// escolhido pelo usuário faz sentido migrar.
    fn collect_own_presence(&self) -> Result<Vec<crate::social::PresenceView>> {
        let me = self
            .load_identity()
            .map(|i| i.fingerprint)
            .ok_or_else(|| crate::DistorrentError::Protocol("sem identidade".into()))?;
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT fp,status,custom,custom_emoji,updated_at FROM presence WHERE fp=?1",
            )?;
            let rows = st
                .query_map(params![me], |r| {
                    Ok(crate::social::PresenceView {
                        fp: r.get(0)?,
                        status: r.get(1)?,
                        custom: r.get(2)?,
                        custom_emoji: r.get(3)?,
                        updated_at: r.get(4)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_reactions(&self) -> Result<Vec<crate::social::ReactionRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT msg_id,conv_id,emoji,reactor_fp,created_at FROM msg_reactions ORDER BY created_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::social::ReactionRow {
                        msg_id: r.get(0)?,
                        conv_id: r.get(1)?,
                        emoji: r.get(2)?,
                        reactor_fp: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_message_meta(&self) -> Result<Vec<crate::social::MsgMetaView>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT msg_id,conv_id,reply_to,forwarded_from,edited_body,edited_at,deleted,pinned,pinned_by,mentioned
                 FROM msg_meta ORDER BY conv_id",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::social::MsgMetaView {
                        msg_id: r.get(0)?,
                        conv_id: r.get(1)?,
                        reply_to: r.get(2)?,
                        forwarded_from: r.get(3)?,
                        edited_body: r.get(4)?,
                        edited_at: r.get(5)?,
                        deleted: r.get::<_, i64>(6)? != 0,
                        pinned: r.get::<_, i64>(7)? != 0,
                        pinned_by: r.get(8)?,
                        mentioned: r.get::<_, i64>(9)? != 0,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    /// Cursores de leitura: os DO usuário (por membro) e o legado global. Os de
    /// terceiros são cache — re-chegam pelos recibos de leitura.
    fn collect_read_states(&self) -> Result<Vec<crate::stormvault::ReadStateRow>> {
        let me = self
            .load_identity()
            .map(|i| i.fingerprint)
            .ok_or_else(|| crate::DistorrentError::Protocol("sem identidade".into()))?;
        self.with_conn(|conn| {
            let mut out = Vec::new();
            let mut st =
                conn.prepare("SELECT conv_id,last_read_ts,updated_at FROM conv_read WHERE fp=?1")?;
            let rows = st.query_map(params![me], |r| {
                Ok(crate::stormvault::ReadStateRow {
                    conv_id: r.get(0)?,
                    fp: me.clone(),
                    last_read_ts: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })?;
            for row in rows {
                out.push(row?);
            }
            let mut st2 =
                conn.prepare("SELECT conv_id,last_read_ts,updated_at FROM read_cursors")?;
            let rows2 = st2.query_map([], |r| {
                Ok(crate::stormvault::ReadStateRow {
                    conv_id: r.get(0)?,
                    fp: String::new(),
                    last_read_ts: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })?;
            for row in rows2 {
                out.push(row?);
            }
            Ok(out)
        })
    }

    fn collect_bookmarks(&self) -> Result<Vec<crate::stormvault::BookmarkRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare("SELECT conv_id,name,payload,created_at FROM bookmarks")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::BookmarkRow {
                        conv_id: r.get(0)?,
                        name: r.get(1)?,
                        payload: r.get(2)?,
                        created_at: r.get(3)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_threads(&self) -> Result<Vec<crate::social::ThreadRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT id,community_id,parent_channel,name,author_fp,created_at,archived,kind,tags
                 FROM threads ORDER BY created_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::social::ThreadRow {
                        id: r.get(0)?,
                        community_id: r.get(1)?,
                        parent_channel: r.get(2)?,
                        name: r.get(3)?,
                        author_fp: r.get(4)?,
                        created_at: r.get(5)?,
                        archived: r.get::<_, i64>(6)? != 0,
                        kind: r.get(7)?,
                        tags: r.get(8)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_polls(&self) -> Result<Vec<crate::social::PollRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT id,community_id,channel_id,question,options,multi,author_fp,created_at,ends_at,closed
                 FROM polls ORDER BY created_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    let options: String = r.get(4)?;
                    Ok(crate::social::PollRow {
                        id: r.get(0)?,
                        community_id: r.get(1)?,
                        channel_id: r.get(2)?,
                        question: r.get(3)?,
                        options: Self::parse_json_list(&options),
                        multi: r.get::<_, i64>(5)? != 0,
                        author_fp: r.get(6)?,
                        created_at: r.get(7)?,
                        ends_at: r.get(8)?,
                        closed: r.get::<_, i64>(9)? != 0,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_poll_votes(&self) -> Result<Vec<crate::stormvault::PollVoteRow>> {
        self.with_conn(|conn| {
            let mut st =
                conn.prepare("SELECT poll_id,voter_fp,option_idx,voted_at FROM poll_votes")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::PollVoteRow {
                        poll_id: r.get(0)?,
                        voter_fp: r.get(1)?,
                        option_idx: r.get(2)?,
                        voted_at: r.get(3)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_events(&self) -> Result<Vec<crate::social::EventRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT id,community_id,name,description,location,starts_at,ends_at,channel_id,entity_fp,status,interested
                 FROM scheduled_events ORDER BY starts_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    let interested: String = r.get(10)?;
                    Ok(crate::social::EventRow {
                        id: r.get(0)?,
                        community_id: r.get(1)?,
                        name: r.get(2)?,
                        description: r.get(3)?,
                        location: r.get(4)?,
                        starts_at: r.get(5)?,
                        ends_at: r.get(6)?,
                        channel_id: r.get(7)?,
                        entity_fp: r.get(8)?,
                        status: r.get(9)?,
                        interested: Self::parse_json_list(&interested),
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_emojis(&self) -> Result<Vec<crate::social::EmojiRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT id,community_id,name,char,created_at FROM custom_emojis ORDER BY created_at",
            )?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::social::EmojiRow {
                        id: r.get(0)?,
                        community_id: r.get(1)?,
                        name: r.get(2)?,
                        char: r.get(3)?,
                        created_at: r.get(4)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_bans(&self) -> Result<Vec<crate::stormvault::CommunitySanctionRow>> {
        self.with_conn(|conn| {
            let mut st = conn
                .prepare("SELECT community_id,fp,reason,actor_fp,created_at,until_ms FROM bans")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::CommunitySanctionRow {
                        community_id: r.get(0)?,
                        fp: r.get(1)?,
                        reason: r.get(2)?,
                        actor_fp: r.get(3)?,
                        created_at: r.get(4)?,
                        until_ms: r.get(5)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_timeouts(&self) -> Result<Vec<crate::stormvault::CommunitySanctionRow>> {
        self.with_conn(|conn| {
            let mut st =
                conn.prepare("SELECT community_id,fp,reason,until_ms,actor_fp,0 FROM timeouts")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::CommunitySanctionRow {
                        community_id: r.get(0)?,
                        fp: r.get(1)?,
                        reason: r.get(2)?,
                        until_ms: r.get(3)?,
                        actor_fp: r.get(4)?,
                        created_at: r.get(5)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_channel_cfg(&self) -> Result<Vec<crate::stormvault::ChannelCfgRow>> {
        self.with_conn(|conn| {
            let mut st =
                conn.prepare("SELECT channel_id,slowmode_secs,nsfw,topic_locked FROM channel_cfg")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::ChannelCfgRow {
                        channel_id: r.get(0)?,
                        slowmode_secs: r.get(1)?,
                        nsfw: r.get::<_, i64>(2)? != 0,
                        topic_locked: r.get::<_, i64>(3)? != 0,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_server_nicknames(&self) -> Result<Vec<crate::stormvault::ServerNicknameRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare("SELECT community_id,fp,nickname FROM server_nicknames")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::ServerNicknameRow {
                        community_id: r.get(0)?,
                        fp: r.get(1)?,
                        nickname: r.get(2)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_group_owners(&self) -> Result<Vec<crate::stormvault::GroupOwnerRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare("SELECT conv_id,owner_fp FROM group_owners")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::GroupOwnerRow {
                        conv_id: r.get(0)?,
                        owner_fp: r.get(1)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_mentions(&self, me: &str) -> Result<Vec<crate::stormvault::MentionRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare(
                "SELECT msg_id,conv_id,target_fp,created_at FROM mentions WHERE target_fp=?1",
            )?;
            let rows = st
                .query_map(params![me], |r| {
                    Ok(crate::stormvault::MentionRow {
                        msg_id: r.get(0)?,
                        conv_id: r.get(1)?,
                        target_fp: r.get(2)?,
                        created_at: r.get(3)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    fn collect_hidden(&self) -> Result<Vec<crate::stormvault::HiddenRow>> {
        self.with_conn(|conn| {
            let mut st = conn.prepare("SELECT msg_id,conv_id,hidden_at FROM local_hidden")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::HiddenRow {
                        msg_id: r.get(0)?,
                        conv_id: r.get(1)?,
                        hidden_at: r.get(2)?,
                    })
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            Ok(rows)
        })
    }

    pub(crate) fn stormvault_merge(
        &self,
        data: &crate::stormvault::StormVaultData,
        report: &mut crate::stormvault::ImportReport,
    ) -> Result<()> {
        const MSG_BATCH: usize = 2000;
        for chunk in data.messages.chunks(MSG_BATCH) {
            let mut conn = self.locked();
            let tx = conn.transaction()?;
            for m in chunk {
                let existing: Option<(String, i64)> = tx
                    .query_row(
                        "SELECT body,ts FROM messages WHERE id=?1",
                        params![m.id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()?;
                match existing {
                    None => {
                        if tx.execute(
                            "INSERT INTO messages(id,conv_id,author_fp,body,ts,sig,direction,status,bot_id)
                             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                            params![
                                m.id,
                                m.conv_id,
                                m.author_fp,
                                m.body,
                                m.ts,
                                m.sig,
                                m.direction,
                                m.status,
                                m.bot_id
                            ],
                        )? > 0
                        {
                            report.messages_merged += 1;
                        }
                    }
                    Some((body, ts)) => {
                        if body != m.body || ts != m.ts {
                            report.message_conflicts += 1;
                        }
                    }
                }
            }
            tx.commit()?;
        }

        let mut conn = self.locked();
        let tx = conn.transaction()?;

        for c in &data.conversations {
            if tx.execute(
                "INSERT OR IGNORE INTO conversations(id,kind,title,peer_fp,created_at)
                 VALUES(?1,?2,?3,?4,?5)",
                params![c.id, c.kind, c.title, c.peer_fp, c.created_at],
            )? > 0
            {
                report.conversations_added += 1;
            }
        }

        for f in &data.friends {
            let existing: Option<(String, i64, i64)> = tx
                .query_row(
                    "SELECT status,added_at,blocked_at FROM friends WHERE fp=?1",
                    params![f.fp],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?;
            match existing {
                None => {
                    if tx.execute(
                        "INSERT INTO friends(fp,nickname,status,added_at,requested_by,requested_at,blocked_at)
                         VALUES(?1,?2,?3,?4,?5,?6,?7)",
                        params![
                            f.fp,
                            f.nickname,
                            f.status,
                            f.added_at,
                            f.requested_by,
                            f.requested_at,
                            f.blocked_at
                        ],
                    )? > 0
                    {
                        report.friends_merged += 1;
                    }
                }
                Some((status, added_at, blocked_at)) => {
                    // Bloqueio é decisão do usuário: o cofre nunca o remove.
                    let take =
                        f.added_at >= added_at && !(f.status.is_empty() && !status.is_empty());
                    if take
                        && tx.execute(
                            "UPDATE friends SET nickname=?2, status=?3,
                               requested_by=?4, requested_at=?5,
                               blocked_at=MAX(blocked_at, ?6)
                             WHERE fp=?1",
                            params![
                                f.fp,
                                if f.nickname.is_empty() {
                                    tx.query_row(
                                        "SELECT nickname FROM friends WHERE fp=?1",
                                        params![f.fp],
                                        |r| r.get::<_, String>(0),
                                    )?
                                } else {
                                    f.nickname.clone()
                                },
                                if f.status.is_empty() {
                                    status
                                } else {
                                    f.status.clone()
                                },
                                f.requested_by,
                                f.requested_at,
                                f.blocked_at.max(blocked_at),
                            ],
                        )? > 0
                    {
                        report.friends_merged += 1;
                    }
                }
            }
        }

        for p in &data.peers {
            if tx.execute(
                "INSERT INTO peers(fp,pubkey_hex,nickname,addr,last_seen,origin)
                 VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(fp) DO UPDATE SET
                   pubkey_hex=CASE WHEN excluded.pubkey_hex='' THEN peers.pubkey_hex ELSE excluded.pubkey_hex END,
                   nickname=CASE WHEN excluded.nickname='' THEN peers.nickname ELSE excluded.nickname END,
                   addr=COALESCE(excluded.addr, peers.addr),
                   last_seen=MAX(peers.last_seen, excluded.last_seen)",
                params![p.fp, p.pubkey_hex, p.nickname, p.addr, p.last_seen, p.origin],
            )? > 0
            {
                report.peers_merged += 1;
            }
        }

        for cm in &data.communities {
            let community_new = tx.execute(
                "INSERT OR IGNORE INTO communities(id,name,owner_fp,created_at,description,category,icon) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![cm.id, cm.name, cm.owner_fp, cm.created_at, cm.description, cm.category, cm.icon],
            )? > 0;
            for ch in &cm.channels {
                tx.execute(
                    "INSERT OR IGNORE INTO channels(id,community_id,name,topic,category,kind,position)
                     VALUES(?1,?2,?3,?4,?5,?6,?7)",
                    params![ch.id, cm.id, ch.name, ch.topic, ch.category, ch.kind, ch.position],
                )?;
            }
            for r in &cm.roles {
                tx.execute(
                    "INSERT OR IGNORE INTO roles(id,community_id,name,color,permissions,hoist,mentionable,position)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                    params![r.id, cm.id, r.name, r.color, r.permissions, if r.hoist {1} else {0}, if r.mentionable {1} else {0}, r.position],
                )?;
            }
            for b in &cm.bots {
                tx.execute(
                    "INSERT OR IGNORE INTO bots(id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                    params![b.id, cm.id, b.name, b.discriminator, b.avatar, b.role_id, b.token, if b.online {1} else {0}, b.owner_fp, b.created_at, b.config],
                )?;
            }
            for (fp, nick, role) in &cm.members {
                tx.execute(
                    "INSERT OR IGNORE INTO community_members(community_id,fp,nickname,role,joined_at) VALUES(?1,?2,?3,?4,?5)",
                    params![cm.id, fp, nick, role, crate::identity::now_ms()],
                )?;
            }
            for (fp, role_ids) in &cm.member_roles {
                for rid in role_ids {
                    tx.execute(
                        "INSERT OR IGNORE INTO member_roles(community_id,fp,role_id) VALUES(?1,?2,?3)",
                        params![cm.id, fp, rid],
                    )?;
                }
            }
            if let Some(rules) = data.rules.iter().find(|r| r.community_id == cm.id) {
                let local_ts: i64 = tx
                    .query_row(
                        "SELECT updated_at FROM server_rules WHERE community_id=?1",
                        params![cm.id],
                        |r| r.get(0),
                    )
                    .optional()?
                    .unwrap_or(0);
                if rules.updated_at > local_ts {
                    tx.execute(
                        "INSERT INTO server_rules(community_id,spam_level,banned_words,blocked_domains,moderators,shadow_banned,updated_at)
                         VALUES(?1,?2,?3,?4,?5,?6,?7)
                         ON CONFLICT(community_id) DO UPDATE SET spam_level=excluded.spam_level, banned_words=excluded.banned_words,
                           blocked_domains=excluded.blocked_domains, moderators=excluded.moderators,
                           shadow_banned=excluded.shadow_banned, updated_at=excluded.updated_at",
                        params![
                            rules.community_id,
                            rules.spam_level,
                            serde_json::to_string(&rules.banned_words).unwrap_or_else(|_| "[]".into()),
                            serde_json::to_string(&rules.blocked_domains).unwrap_or_else(|_| "[]".into()),
                            serde_json::to_string(&rules.moderators).unwrap_or_else(|_| "[]".into()),
                            serde_json::to_string(&rules.shadow_banned).unwrap_or_else(|_| "[]".into()),
                            rules.updated_at,
                        ],
                    )?;
                    report.rules_merged += 1;
                }
            }
            if community_new {
                report.communities_merged += 1;
            }
        }

        for rep in &data.reputations {
            let local_ts: i64 = tx
                .query_row(
                    "SELECT updated_at FROM reputation WHERE fp=?1",
                    params![rep.fp],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            if rep.updated_at > local_ts {
                tx.execute(
                    "INSERT INTO reputation(fp,trust,score,reports,updated_at) VALUES(?1,?2,?3,?4,?5)
                     ON CONFLICT(fp) DO UPDATE SET trust=excluded.trust, score=excluded.score, reports=excluded.reports, updated_at=excluded.updated_at",
                    params![rep.fp, rep.trust, rep.score, rep.reports as i64, rep.updated_at],
                )?;
                report.reputations_merged += 1;
            }
        }

        for e in &data.audit {
            if tx.execute(
                "INSERT OR IGNORE INTO audit_log(id,community_id,actor_fp,action,target_fp,reason,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![e.id, e.community_id, e.actor_fp, e.action, e.target_fp, e.reason, e.created_at],
            )? > 0
            {
                report.audit_merged += 1;
            }
        }
        for r in &data.reports {
            if tx.execute(
                "INSERT OR IGNORE INTO reports(id,reporter_fp,target_fp,community_id,reason,status,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![r.id, r.reporter_fp, r.target_fp, r.community_id, r.reason, r.status, r.created_at],
            )? > 0
            {
                report.reports_merged += 1;
            }
        }

        for g in &data.groups {
            tx.execute(
                "INSERT OR IGNORE INTO conversations(id,kind,title,peer_fp,created_at)
                 VALUES(?1,?2,?3,'',?4)",
                params![g.conv.id, g.conv.kind, g.conv.title, g.conv.created_at],
            )?;
            for (fp, nick) in &g.members {
                tx.execute(
                    "INSERT OR IGNORE INTO group_members(conv_id,fp,nickname,added_at) VALUES(?1,?2,?3,?4)",
                    params![g.conv.id, fp, nick, crate::identity::now_ms()],
                )?;
            }
            report.groups_merged += 1;
        }

        for (k, v) in &data.settings {
            if tx.execute(
                "INSERT OR IGNORE INTO kv(key,value) VALUES(?1,?2)",
                params![k, v],
            )? > 0
            {
                report.settings_imported += 1;
            }
        }

        let (profiles_merged, social_merged) = merge_social_rows(&tx, data)?;
        report.profiles_merged += profiles_merged;
        report.social_merged += social_merged;
        report.data_version = data.meta.data_version;

        tx.commit()?;
        Ok(())
    }
}

/// Mescla o conteúdo v2 preservando o que é LOCAL por natureza (presença
/// efêmera, pins, silenciamentos e endereço). Devolve (perfis, demais linhas).
fn merge_social_rows(
    tx: &rusqlite::Transaction<'_>,
    data: &crate::stormvault::StormVaultData,
) -> Result<(usize, usize)> {
    let mut n = 0usize;
    let mut profiles = 0usize;

    // Perfil: vence a revisão maior; empate usa o hash canônico (determinístico
    // entre dispositivos, sem depender de relógio).
    for p in &data.profiles {
        if p.fp.trim().is_empty() {
            continue;
        }
        let cur: Option<(i64, String)> = tx
            .query_row(
                "SELECT rev,content_hash FROM profiles WHERE fp=?1",
                params![p.fp],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let take = match cur {
            None => true,
            Some((rev, hash)) => {
                p.rev > rev || (p.rev == rev && !hash.is_empty() && p.content_hash > hash)
            }
        };
        if !take {
            continue;
        }
        let hash = if p.content_hash.is_empty() {
            crate::social::profile_content_hash(
                &p.display_name,
                &p.about,
                &p.avatar_b64,
                &p.banner_b64,
                &p.accent,
            )
        } else {
            p.content_hash.clone()
        };
        tx.execute(
            "INSERT INTO profiles(fp,display_name,about,avatar_b64,banner_b64,accent,updated_at,rev,content_hash)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(fp) DO UPDATE SET display_name=excluded.display_name, about=excluded.about,
               avatar_b64=excluded.avatar_b64, banner_b64=excluded.banner_b64,
               accent=excluded.accent, updated_at=excluded.updated_at,
               rev=excluded.rev, content_hash=excluded.content_hash",
            params![
                p.fp,
                p.display_name,
                p.about,
                p.avatar_b64,
                p.banner_b64,
                p.accent,
                p.updated_at,
                p.rev,
                hash
            ],
        )?;
        profiles += 1;
    }
    // Presença de terceiro é dado vivo (TTL de 90 s); só a do próprio usuário
    // faz sentido migrar, senão o app mostraria "online" para quem está offline.
    for pr in &data.presence {
        if pr.fp != data.identity.fingerprint {
            continue;
        }
        // `since` não é exportado (é a hora de início da sessão local).
        tx.execute(
            "INSERT INTO presence(fp,status,custom,custom_emoji,updated_at)
             VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(fp) DO UPDATE SET status=excluded.status, custom=excluded.custom,
               custom_emoji=excluded.custom_emoji, updated_at=excluded.updated_at",
            params![pr.fp, pr.status, pr.custom, pr.custom_emoji, pr.updated_at],
        )?;
        n += 1;
    }

    for r in &data.reactions {
        if tx.execute(
            "INSERT OR IGNORE INTO msg_reactions(msg_id,conv_id,emoji,reactor_fp,created_at)
             VALUES(?1,?2,?3,?4,?5)",
            params![r.msg_id, r.conv_id, r.emoji, r.reactor_fp, r.created_at],
        )? > 0
        {
            n += 1;
        }
    }

    for m in &data.message_meta {
        // Metadados de edição/delete/reply vêm do autor e são imutáveis. O pin
        // entra só quando a linha não existe: pin é estado do servidor e um
        // cofre antigo não deve "despinar" o que o host fixou depois.
        if tx.execute(
            "INSERT OR IGNORE INTO msg_meta(msg_id,conv_id,reply_to,forwarded_from,edited_body,edited_at,deleted,pinned,pinned_at,pinned_by,mentioned)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,0,'',?9)",
            params![
                m.msg_id,
                m.conv_id,
                m.reply_to,
                m.forwarded_from,
                m.edited_body,
                m.edited_at,
                if m.deleted { 1 } else { 0 },
                if m.pinned { 1 } else { 0 },
                if m.mentioned { 1 } else { 0 }
            ],
        )? > 0
        {
            n += 1;
        }
    }

    for rs in &data.read_states {
        if rs.fp.is_empty() {
            // Cursor legado: não regride.
            tx.execute(
                "INSERT INTO read_cursors(conv_id,last_read_ts,updated_at) VALUES(?1,?2,?3)
                 ON CONFLICT(conv_id) DO UPDATE SET
                   last_read_ts=MAX(read_cursors.last_read_ts, excluded.last_read_ts)",
                params![rs.conv_id, rs.last_read_ts, rs.updated_at],
            )?;
        } else if rs.fp == data.identity.fingerprint {
            tx.execute(
                "INSERT INTO conv_read(conv_id,fp,last_read_ts,updated_at) VALUES(?1,?2,?3,?4)
                 ON CONFLICT(conv_id,fp) DO UPDATE SET
                   last_read_ts=MAX(conv_read.last_read_ts, excluded.last_read_ts)",
                params![rs.conv_id, rs.fp, rs.last_read_ts, rs.updated_at],
            )?;
        } else {
            continue;
        }
        n += 1;
    }

    for b in &data.bookmarks {
        if tx.execute(
            "INSERT OR IGNORE INTO bookmarks(conv_id,name,payload,created_at) VALUES(?1,?2,?3,?4)",
            params![b.conv_id, b.name, b.payload, b.created_at],
        )? > 0
        {
            n += 1;
        }
    }

    for t in &data.threads {
        if tx.execute(
            "INSERT OR IGNORE INTO threads(id,community_id,parent_channel,name,author_fp,created_at,archived,kind,tags)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                t.id,
                t.community_id,
                t.parent_channel,
                t.name,
                t.author_fp,
                t.created_at,
                if t.archived { 1 } else { 0 },
                t.kind,
                t.tags
            ],
        )? > 0
        {
            n += 1;
        }
    }

    for p in &data.polls {
        if tx.execute(
            "INSERT OR IGNORE INTO polls(id,community_id,channel_id,question,options,multi,author_fp,created_at,ends_at,closed)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                p.id,
                p.community_id,
                p.channel_id,
                p.question,
                serde_json::to_string(&p.options).unwrap_or_else(|_| "[]".into()),
                if p.multi { 1 } else { 0 },
                p.author_fp,
                p.created_at,
                p.ends_at,
                if p.closed { 1 } else { 0 }
            ],
        )? > 0
        {
            n += 1;
        }
    }
    for v in &data.poll_votes {
        if tx.execute(
            "INSERT OR IGNORE INTO poll_votes(poll_id,voter_fp,option_idx,voted_at) VALUES(?1,?2,?3,?4)",
            params![v.poll_id, v.voter_fp, v.option_idx, v.voted_at],
        )? > 0
        {
            n += 1;
        }
    }

    for e in &data.events {
        if tx.execute(
            "INSERT OR IGNORE INTO scheduled_events(id,community_id,name,description,location,starts_at,ends_at,channel_id,entity_fp,status,interested)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![
                e.id,
                e.community_id,
                e.name,
                e.description,
                e.location,
                e.starts_at,
                e.ends_at,
                e.channel_id,
                e.entity_fp,
                e.status,
                serde_json::to_string(&e.interested).unwrap_or_else(|_| "[]".into())
            ],
        )? > 0
        {
            n += 1;
        }
    }

    for e in &data.emojis {
        if tx.execute(
            "INSERT OR IGNORE INTO custom_emojis(id,community_id,name,char,created_at)
             VALUES(?1,?2,?3,?4,?5)",
            params![e.id, e.community_id, e.name, e.char, e.created_at],
        )? > 0
        {
            n += 1;
        }
    }

    // Sanções são fatos do servidor. O cofre só ADICIONA: um cofre velho não
    // pode desbanir ninguém.
    for b in &data.bans {
        if tx.execute(
            "INSERT OR IGNORE INTO bans(community_id,fp,reason,actor_fp,created_at,until_ms)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![
                b.community_id,
                b.fp,
                b.reason,
                b.actor_fp,
                b.created_at,
                b.until_ms
            ],
        )? > 0
        {
            n += 1;
        }
    }
    for t in &data.timeouts {
        if tx.execute(
            "INSERT OR IGNORE INTO timeouts(community_id,fp,reason,until_ms,actor_fp)
             VALUES(?1,?2,?3,?4,?5)",
            params![t.community_id, t.fp, t.reason, t.until_ms, t.actor_fp],
        )? > 0
        {
            n += 1;
        }
    }

    for c in &data.channel_cfg {
        if tx.execute(
            "INSERT OR IGNORE INTO channel_cfg(channel_id,slowmode_secs,nsfw,topic_locked)
             VALUES(?1,?2,?3,?4)",
            params![
                c.channel_id,
                c.slowmode_secs,
                if c.nsfw { 1 } else { 0 },
                if c.topic_locked { 1 } else { 0 }
            ],
        )? > 0
        {
            n += 1;
        }
    }

    for sn in &data.server_nicknames {
        if tx.execute(
            "INSERT OR IGNORE INTO server_nicknames(community_id,fp,nickname) VALUES(?1,?2,?3)",
            params![sn.community_id, sn.fp, sn.nickname],
        )? > 0
        {
            n += 1;
        }
    }

    for g in &data.group_owners {
        if tx.execute(
            "INSERT OR IGNORE INTO group_owners(conv_id,owner_fp) VALUES(?1,?2)",
            params![g.conv_id, g.owner_fp],
        )? > 0
        {
            n += 1;
        }
    }

    for m in &data.mentions {
        if tx.execute(
            "INSERT OR IGNORE INTO mentions(msg_id,conv_id,target_fp,created_at) VALUES(?1,?2,?3,?4)",
            params![m.msg_id, m.conv_id, m.target_fp, m.created_at],
        )? > 0
        {
            n += 1;
        }
    }

    for h in &data.hidden {
        if tx.execute(
            "INSERT OR IGNORE INTO local_hidden(msg_id,conv_id,hidden_at) VALUES(?1,?2,?3)",
            params![h.msg_id, h.conv_id, h.hidden_at],
        )? > 0
        {
            n += 1;
        }
    }

    Ok((profiles, n))
}
