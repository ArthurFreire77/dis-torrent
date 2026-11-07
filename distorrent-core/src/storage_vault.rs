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
            let mut st =
                conn.prepare("SELECT fp,nickname,status,added_at FROM friends ORDER BY added_at")?;
            let rows = st
                .query_map([], |r| {
                    Ok(crate::stormvault::FriendRow {
                        fp: r.get(0)?,
                        nickname: r.get(1)?,
                        status: r.get(2)?,
                        added_at: r.get(3)?,
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
            let bots = self.with_conn(|conn| {
                let mut st = conn.prepare(
                    "SELECT id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config,perms,webhook_secret
                     FROM bots WHERE community_id=?1 ORDER BY created_at",
                )?;
                let rows = st
                    .query_map(params![id], Self::bot_row_mapper())?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                Ok(rows)
            })?;
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
            },
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
            let existing: Option<(String, i64)> = tx
                .query_row(
                    "SELECT status,added_at FROM friends WHERE fp=?1",
                    params![f.fp],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            match existing {
                None => {
                    if tx.execute(
                        "INSERT INTO friends(fp,nickname,status,added_at) VALUES(?1,?2,?3,?4)",
                        params![f.fp, f.nickname, f.status, f.added_at],
                    )? > 0
                    {
                        report.friends_merged += 1;
                    }
                }
                Some((status, added_at)) => {
                    let take =
                        f.added_at >= added_at && !(f.status.is_empty() && !status.is_empty());
                    if take
                        && tx.execute(
                            "UPDATE friends SET nickname=?2, status=?3 WHERE fp=?1",
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
                                }
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

        tx.commit()?;
        Ok(())
    }
}
