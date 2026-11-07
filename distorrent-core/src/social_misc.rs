// Metodos de crate::storage::Store: misc. Irmao de social.rs (mesma impl, mesmo tipo).

use super::*;

impl crate::storage::Store {
    /// Lista de conversas com o resumo que a interface móvel já tentava ler
    /// (`unread_count`, `last_ts`, `last_body`) mas que o core nunca enviava —
    /// os badges e a prévia ficavam sempre vazios.
    pub fn conversations_with_counts(&self, fp: &str) -> Result<Vec<ConversationSummary>, String> {
        if fp.is_empty() {
            return Err("sem identidade".into());
        }
        let convs = self.list_conversations().map_err(|e| e.to_string())?;
        let conn = self.locked();
        let mut out = Vec::with_capacity(convs.len());
        for c in convs {
            let cursor: i64 = conn
                .query_row(
                    "SELECT MAX(
                        COALESCE((SELECT last_read_ts FROM conv_read WHERE conv_id=?1 AND fp=?2), 0),
                        COALESCE((SELECT last_read_ts FROM read_cursors WHERE conv_id=?1), 0)
                     )",
                    params![c.id, fp],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let (last_ts, last_body): (i64, String) = conn
                .query_row(
                    "SELECT ts, body FROM messages WHERE conv_id=?1 ORDER BY ts DESC, id DESC LIMIT 1",
                    params![c.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .unwrap_or((0, String::new()));
            let unread: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM messages
                      WHERE conv_id=?1 AND ts > ?2 AND author_fp <> ?3",
                    params![c.id, cursor, fp],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            out.push(ConversationSummary {
                id: c.id,
                kind: c.kind,
                title: c.title,
                peer_fp: c.peer_fp,
                created_at: c.created_at,
                last_ts,
                last_body,
                unread_count: unread,
            });
        }
        out.sort_by(|a, b| {
            b.last_ts
                .cmp(&a.last_ts)
                .then_with(|| b.created_at.cmp(&a.created_at))
        });
        Ok(out)
    }

    pub fn ban_set(
        &self,
        community_id: &str,
        fp: &str,
        reason: &str,
        actor_fp: &str,
        until_ms: i64,
    ) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO bans (community_id, fp, reason, actor_fp, created_at, until_ms)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(community_id, fp) DO UPDATE SET reason=excluded.reason,
               actor_fp=excluded.actor_fp, created_at=excluded.created_at, until_ms=excluded.until_ms",
            params![
                community_id,
                fp,
                reason,
                actor_fp,
                crate::identity::now_ms(),
                until_ms
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn ban_remove(&self, community_id: &str, fp: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "DELETE FROM bans WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn ban_get(&self, community_id: &str, fp: &str) -> Result<Option<BanRow>, String> {
        let r = self.locked()
            .query_row(
                "SELECT fp, reason, actor_fp, created_at, until_ms FROM bans WHERE community_id=?1 AND fp=?2",
                params![community_id, fp],
                |r| {
                    Ok(BanRow {
                        fp: r.get(0)?,
                        reason: r.get(1)?,
                        actor_fp: r.get(2)?,
                        created_at: r.get(3)?,
                        until_ms: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(b) = &r {
            if b.until_ms > 0 && b.until_ms < crate::identity::now_ms() {
                self.ban_remove(community_id, fp)?;
                return Ok(None);
            }
        }
        Ok(r)
    }

    pub fn ban_list(&self, community_id: &str) -> Result<Vec<BanRow>, String> {
        let conn = self.locked();
        let now = crate::identity::now_ms();
        let mut stmt = conn
            .prepare(
                "SELECT fp, reason, actor_fp, created_at, until_ms FROM bans
                  WHERE community_id=?1 ORDER BY created_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![community_id], |r| {
                Ok(BanRow {
                    fp: r.get(0)?,
                    reason: r.get(1)?,
                    actor_fp: r.get(2)?,
                    created_at: r.get(3)?,
                    until_ms: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let all: Vec<BanRow> = rows.flatten().collect();
        let expired: Vec<String> = all
            .iter()
            .filter(|b| b.until_ms > 0 && b.until_ms < now)
            .map(|b| b.fp.clone())
            .collect();
        let out: Vec<BanRow> = all
            .into_iter()
            .filter(|b| !(b.until_ms > 0 && b.until_ms < now))
            .collect();
        drop(stmt);
        drop(conn);
        for fp in expired {
            self.ban_remove(community_id, &fp)?;
        }
        Ok(out)
    }

    pub fn timeout_set(
        &self,
        community_id: &str,
        fp: &str,
        until_ms: i64,
        reason: &str,
        actor_fp: &str,
    ) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO timeouts (community_id, fp, reason, until_ms, actor_fp) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(community_id, fp) DO UPDATE SET until_ms=excluded.until_ms,
               reason=excluded.reason, actor_fp=excluded.actor_fp",
            params![community_id, fp, reason, until_ms, actor_fp],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn timeout_clear(&self, community_id: &str, fp: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "DELETE FROM timeouts WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn timeout_active(&self, community_id: &str, fp: &str) -> Result<i64, String> {
        let now = crate::identity::now_ms();
        let until: Option<i64> = self
            .locked()
            .query_row(
                "SELECT until_ms FROM timeouts WHERE community_id=?1 AND fp=?2",
                params![community_id, fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        match until {
            Some(u) if u > now => Ok(u),
            Some(_) => {
                self.timeout_clear(community_id, fp)?;
                Ok(0)
            }
            None => Ok(0),
        }
    }

    pub fn timeout_list(&self, community_id: &str) -> Result<Vec<BanRow>, String> {
        let conn = self.locked();
        let now = crate::identity::now_ms();
        let mut stmt = conn
            .prepare("SELECT fp, reason, actor_fp, until_ms FROM timeouts WHERE community_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![community_id], |r| {
                Ok(BanRow {
                    fp: r.get(0)?,
                    reason: r.get(1)?,
                    actor_fp: r.get(2)?,
                    created_at: 0,
                    until_ms: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().filter(|b| b.until_ms > now).collect())
    }

    pub fn channel_cfg_slowmode(&self, channel_id: &str) -> Result<i64, String> {
        let conn = self.locked();
        let v: Option<i64> = conn
            .query_row(
                "SELECT slowmode_secs FROM channel_cfg WHERE channel_id=?1",
                params![channel_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(v.unwrap_or(0))
    }

    pub fn channel_cfg_set(
        &self,
        channel_id: &str,
        slowmode_secs: i64,
        nsfw: bool,
        topic_locked: bool,
    ) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO channel_cfg (channel_id, slowmode_secs, nsfw, topic_locked) VALUES (?1,?2,?3,?4)
             ON CONFLICT(channel_id) DO UPDATE SET slowmode_secs=excluded.slowmode_secs,
               nsfw=excluded.nsfw, topic_locked=excluded.topic_locked",
            params![channel_id, slowmode_secs, nsfw as i64, topic_locked as i64],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn slowmode_gate(
        &self,
        channel_id: &str,
        fp: &str,
        slowmode_secs: i64,
    ) -> Result<i64, String> {
        if slowmode_secs <= 0 {
            return Ok(0);
        }
        let conn = self.locked();
        let now = crate::identity::now_ms();
        let last: Option<i64> = conn
            .query_row(
                "SELECT last_msg_at FROM channel_cfg WHERE channel_id=?1 AND last_msg_fp=?2",
                params![channel_id, fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(l) = last {
            let next = l + slowmode_secs * 1000;
            if next > now {
                conn.execute(
                    "INSERT INTO channel_cfg (channel_id, last_msg_at, last_msg_fp) VALUES (?1,?2,?3)
                     ON CONFLICT(channel_id) DO UPDATE SET last_msg_at=excluded.last_msg_at,
                       last_msg_fp=excluded.last_msg_fp",
                    params![channel_id, now, fp],
                )
                .map_err(|e| e.to_string())?;
                return Ok(next - now);
            }
        }
        conn.execute(
            "INSERT INTO channel_cfg (channel_id, last_msg_at, last_msg_fp) VALUES (?1,?2,?3)
             ON CONFLICT(channel_id) DO UPDATE SET last_msg_at=excluded.last_msg_at,
               last_msg_fp=excluded.last_msg_fp",
            params![channel_id, now, fp],
        )
        .map_err(|e| e.to_string())?;
        Ok(0)
    }

    pub fn poll_upsert(&self, p: &PollRow) -> Result<(), String> {
        let conn = self.locked();
        let opts = serde_json::to_string(&p.options).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO polls (id, community_id, channel_id, question, options, multi, author_fp, created_at, ends_at, closed)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
             ON CONFLICT(id) DO UPDATE SET question=excluded.question, options=excluded.options,
               multi=excluded.multi, ends_at=excluded.ends_at, closed=excluded.closed",
            params![
                p.id,
                p.community_id,
                p.channel_id,
                p.question,
                opts,
                p.multi as i64,
                p.author_fp,
                p.created_at,
                p.ends_at,
                p.closed as i64
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn poll_list(&self, community_id: &str, channel_id: &str) -> Result<Vec<PollRow>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT id, community_id, channel_id, question, options, multi, author_fp, created_at, ends_at, closed
                   FROM polls WHERE community_id=?1 AND channel_id=?2 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![community_id, channel_id], |r| {
                let opts: String = r.get(4)?;
                Ok(PollRow {
                    id: r.get(0)?,
                    community_id: r.get(1)?,
                    channel_id: r.get(2)?,
                    question: r.get(3)?,
                    options: serde_json::from_str(&opts).unwrap_or_default(),
                    multi: r.get::<_, i64>(5)? != 0,
                    author_fp: r.get(6)?,
                    created_at: r.get(7)?,
                    ends_at: r.get(8)?,
                    closed: r.get::<_, i64>(9)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn poll_vote(&self, poll_id: &str, voter_fp: &str, option_idx: i64) -> Result<(), String> {
        let conn = self.locked();
        let multi: Option<i64> = conn
            .query_row(
                "SELECT multi FROM polls WHERE id=?1",
                params![poll_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let multi = multi.ok_or_else(|| "enquete inexistente".to_string())?;

        let options: String = conn
            .query_row(
                "SELECT options FROM polls WHERE id=?1",
                params![poll_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        let parsed: Vec<String> = serde_json::from_str(&options).unwrap_or_default();
        if option_idx < 0 || option_idx as usize >= parsed.len() {
            return Err("opção inexistente".into());
        }

        if multi == 0 {
            conn.execute(
                "DELETE FROM poll_votes WHERE poll_id=?1 AND voter_fp=?2",
                params![poll_id, voter_fp],
            )
            .map_err(|e| e.to_string())?;
        } else {
            let ja_votou: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM poll_votes WHERE poll_id=?1 AND voter_fp=?2 AND option_idx=?3",
                    params![poll_id, voter_fp, option_idx],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            if ja_votou.is_some() {
                conn.execute(
                    "DELETE FROM poll_votes WHERE poll_id=?1 AND voter_fp=?2 AND option_idx=?3",
                    params![poll_id, voter_fp, option_idx],
                )
                .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
        conn.execute(
            "INSERT OR REPLACE INTO poll_votes (poll_id, voter_fp, option_idx, voted_at) VALUES (?1,?2,?3,?4)",
            params![poll_id, voter_fp, option_idx, crate::identity::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn poll_tally(&self, poll_id: &str) -> Result<(Vec<i64>, i64), String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT option_idx, COUNT(*) FROM poll_votes WHERE poll_id=?1 GROUP BY option_idx",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![poll_id], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut counts: Vec<i64> = Vec::new();
        let mut voters: i64 = 0;
        for (idx, n) in rows.flatten() {
            let i = idx as usize;
            if counts.len() <= i {
                counts.resize(i + 1, 0);
            }
            counts[i] = n;
            voters += n;
        }
        Ok((counts, voters))
    }

    pub fn poll_my_votes(&self, poll_id: &str, voter_fp: &str) -> Result<Vec<i64>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT option_idx FROM poll_votes WHERE poll_id=?1 AND voter_fp=?2")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![poll_id, voter_fp], |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        Ok(rows.flatten().collect())
    }

    pub fn event_upsert(&self, e: &EventRow) -> Result<(), String> {
        let conn = self.locked();
        let interested = serde_json::to_string(&e.interested).unwrap_or_else(|_| "[]".into());
        conn.execute(
            "INSERT INTO scheduled_events (id, community_id, name, description, location, starts_at, ends_at, channel_id, entity_fp, status, interested)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
               location=excluded.location, starts_at=excluded.starts_at, ends_at=excluded.ends_at,
               status=excluded.status, interested=excluded.interested",
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
                interested
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn event_list(&self, community_id: &str) -> Result<Vec<EventRow>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT id, community_id, name, description, location, starts_at, ends_at, channel_id, entity_fp, status, interested
                   FROM scheduled_events WHERE community_id=?1 ORDER BY starts_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![community_id], |r| {
                let int: String = r.get(10)?;
                Ok(EventRow {
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
                    interested: serde_json::from_str(&int).unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn event_delete(&self, community_id: &str, id: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "DELETE FROM scheduled_events WHERE community_id=?1 AND id=?2",
            params![community_id, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn event_interest(&self, community_id: &str, id: &str, fp: &str) -> Result<(), String> {
        let mut ev = self
            .event_list(community_id)?
            .into_iter()
            .find(|e| e.id == id)
            .ok_or_else(|| "evento não encontrado".to_string())?;
        if let Some(p) = ev.interested.iter().position(|x| x == fp) {
            ev.interested.remove(p);
        } else {
            ev.interested.push(fp.to_string());
        }
        self.event_upsert(&ev)
    }

    pub fn emoji_upsert(&self, e: &EmojiRow) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO custom_emojis (id, community_id, name, char, created_at) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, char=excluded.char",
            params![e.id, e.community_id, e.name, e.char, e.created_at],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn emoji_list(&self, community_id: &str) -> Result<Vec<EmojiRow>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT id, community_id, name, char, created_at FROM custom_emojis WHERE community_id=?1 ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![community_id], |r| {
                Ok(EmojiRow {
                    id: r.get(0)?,
                    community_id: r.get(1)?,
                    name: r.get(2)?,
                    char: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn emoji_delete(&self, community_id: &str, id: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "DELETE FROM custom_emojis WHERE community_id=?1 AND id=?2",
            params![community_id, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn message_search(&self, q: &SearchQuery) -> Result<Vec<SearchHit>, String> {
        let needle = q.text.trim().to_lowercase();
        let limit = if q.limit <= 0 { 50 } else { q.limit.min(500) };
        let conn = self.locked();
        let mut sql = String::from(
            "SELECT g.id, g.conv_id, g.author_fp, g.body, g.ts, g.direction,
                    IFNULL(ch.community_id, ''), IFNULL(ch.id, '')
               FROM messages g
               LEFT JOIN msg_meta mm ON mm.msg_id = g.id
               LEFT JOIN channels ch ON ch.id = g.conv_id
              WHERE (mm.deleted IS NULL OR mm.deleted = 0)
                AND g.body <> ''",
        );
        let mut args: Vec<String> = Vec::new();
        if !q.from.is_empty() {
            sql.push_str(" AND g.author_fp = ?");
            args.push(q.from.clone());
        }
        if !q.conv.is_empty() {
            sql.push_str(" AND g.conv_id = ?");
            args.push(q.conv.clone());
        }
        if q.before > 0 {
            sql.push_str(" AND g.ts < ?");
            args.push(q.before.to_string());
        }
        sql.push_str(" ORDER BY g.ts DESC LIMIT 2000");

        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs: Vec<&dyn rusqlite::ToSql> =
            args.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt
            .query_map(refs.as_slice(), |r| {
                Ok(SearchHit {
                    id: r.get(0)?,
                    conv_id: r.get(1)?,
                    author_fp: r.get(2)?,
                    body: r.get(3)?,
                    ts: r.get(4)?,
                    direction: r.get(5)?,
                    community_id: r.get(6)?,
                    channel_id: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        // Cursor por conversa, uma vez só: o filtro "unread" precisa comparar cada mensagem com o que AQUELE usuário já leu naquela conversa.
        let me = q.me.clone();
        let mut cursors: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        if !me.is_empty() {
            if let Ok(mut cs) = conn.prepare("SELECT conv_id, last_read_ts FROM read_cursors") {
                if let Ok(rows) =
                    cs.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                {
                    for row in rows.flatten() {
                        cursors.insert(row.0, row.1);
                    }
                }
            }
            if let Ok(mut cs) =
                conn.prepare("SELECT conv_id, last_read_ts FROM conv_read WHERE fp=?1")
            {
                if let Ok(rows) = cs.query_map(params![me], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                }) {
                    for row in rows.flatten() {
                        let cur = cursors.entry(row.0).or_insert(0);
                        *cur = (*cur).max(row.1);
                    }
                }
            }
        }
        for hit in rows.flatten() {
            if !needle.is_empty() && !hit.body.to_lowercase().contains(&needle) {
                continue;
            }
            let ok = match q.has.as_str() {
                "" => true,
                "link" => hit.body.contains("http://") || hit.body.contains("https://"),
                "file" => {
                    hit.body.starts_with("{\"file\"") || hit.body.contains("\"kind\":\"file\"")
                }
                "mention" => hit.body.contains('@'),
                "poll" => hit.body.starts_with("{\"poll\""),
                "image" => hit.body.contains("\"mime\":\"image/"),
                "code" => hit.body.contains("```"),
                // Não lidas DE VERDADE: recebidas depois do cursor da conversa.
                "unread" => {
                    if hit.direction != "in" || hit.author_fp == q.me {
                        false
                    } else {
                        hit.ts > cursors.get(&hit.conv_id).copied().unwrap_or(0)
                    }
                }
                _ => true,
            };
            if !ok {
                continue;
            }
            out.push(hit);
            if out.len() as i64 >= limit {
                break;
            }
        }
        Ok(out)
    }

    pub fn messages_around(
        &self,
        conv_id: &str,
        ts: i64,
        limit: i64,
    ) -> Result<Vec<crate::storage::StoredMessage>, String> {
        let limit = limit.clamp(1, 500) as usize;
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id,thread_id FROM messages WHERE conv_id=?1 ORDER BY ts ASC")
            .map_err(|e| e.to_string())?;
        let all: Vec<crate::storage::StoredMessage> = stmt
            .query_map(params![conv_id], |r| {
                Ok(crate::storage::StoredMessage {
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
            })
            .map_err(|e| e.to_string())?
            .flatten()
            .collect();
        let before: Vec<_> = all
            .iter()
            .filter(|m| m.ts < ts)
            .rev()
            .take(limit / 2)
            .cloned()
            .collect();
        let mut before: Vec<_> = before.into_iter().rev().collect();
        let depois = limit - before.len();
        let after: Vec<_> = all
            .into_iter()
            .filter(|m| m.ts >= ts)
            .take(depois)
            .collect();
        before.extend(after);
        Ok(before)
    }

    pub fn bookmark_set(&self, conv_id: &str, name: &str, payload: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT OR REPLACE INTO bookmarks (conv_id, name, payload, created_at) VALUES (?1,?2,?3,?4)",
            params![conv_id, name, payload, crate::identity::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn bookmark_list(&self, conv_id: &str) -> Result<Vec<(String, String)>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT name, payload FROM bookmarks WHERE conv_id=?1")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conv_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn purge_conv(&self, conv_id: &str) -> Result<(), String> {
        let conn = self.locked();
        for t in [
            "DELETE FROM msg_reactions WHERE conv_id=?1",
            "DELETE FROM msg_meta WHERE conv_id=?1",
            "DELETE FROM read_cursors WHERE conv_id=?1",
            "DELETE FROM bookmarks WHERE conv_id=?1",
        ] {
            conn.execute(t, params![conv_id])
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}
