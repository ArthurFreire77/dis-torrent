// Metodos de crate::storage::Store: reads. Irmao de social.rs (mesma impl, mesmo tipo).

use super::*;

impl crate::storage::Store {
    pub fn reaction_toggle(
        &self,
        msg_id: &str,
        conv_id: &str,
        emoji: &str,
        reactor_fp: &str,
    ) -> Result<bool, String> {
        self.reaction_toggle_full(msg_id, conv_id, emoji, reactor_fp, false)
    }

    pub fn reaction_toggle_full(
        &self,
        msg_id: &str,
        conv_id: &str,
        emoji: &str,
        reactor_fp: &str,
        is_super: bool,
    ) -> Result<bool, String> {
        let conn = self.locked();
        let existing: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM msg_reactions WHERE msg_id=?1 AND emoji=?2 AND reactor_fp=?3",
                params![msg_id, emoji, reactor_fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let added = existing.is_none();
        if added {
            conn.execute(
                "INSERT OR REPLACE INTO msg_reactions (msg_id, conv_id, emoji, reactor_fp, created_at, is_super)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    msg_id,
                    conv_id,
                    emoji,
                    reactor_fp,
                    crate::identity::now_ms(),
                    is_super as i32
                ],
            )
            .map_err(|e| e.to_string())?;
        } else {
            conn.execute(
                "DELETE FROM msg_reactions WHERE msg_id=?1 AND emoji=?2 AND reactor_fp=?3",
                params![msg_id, emoji, reactor_fp],
            )
            .map_err(|e| e.to_string())?;
        }
        Ok(added)
    }

    pub fn reactions_for_msg(&self, msg_id: &str) -> Result<Vec<ReactionSummary>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT emoji, reactor_fp, is_super FROM msg_reactions WHERE msg_id=?1 ORDER BY emoji ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![msg_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i32>(2)? != 0,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out: Vec<ReactionSummary> = Vec::new();
        for r in rows {
            let (emoji, reactor, is_super) = r.map_err(|e| e.to_string())?;
            if let Some(last) = out.last_mut() {
                if last.emoji == emoji {
                    last.count += 1;
                    if is_super {
                        last.super_count += 1;
                    }
                    last.reactors.push(reactor);
                    continue;
                }
            }
            out.push(ReactionSummary {
                msg_id: msg_id.to_string(),
                emoji,
                count: 1,
                reactors: vec![reactor],
                mine: false,
                super_count: if is_super { 1 } else { 0 },
            });
        }
        Ok(out)
    }

    pub fn reactions_for_msgs(&self, msg_ids: &[String]) -> Result<Vec<ReactionSummary>, String> {
        if msg_ids.is_empty() {
            return Ok(Vec::new());
        }
        if msg_ids.len() > 1000 {
            return Err("lote de reações grande demais".into());
        }
        let conn = self.locked();
        let placeholders = vec!["?"; msg_ids.len()].join(",");
        let sql = format!(
            "SELECT msg_id, emoji, reactor_fp, is_super FROM msg_reactions
              WHERE msg_id IN ({placeholders})
              ORDER BY msg_id, emoji, created_at ASC"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let refs: Vec<&dyn rusqlite::ToSql> =
            msg_ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let rows = stmt
            .query_map(refs.as_slice(), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i32>(3)? != 0,
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut out: Vec<ReactionSummary> = Vec::new();
        for r in rows {
            let (msg_id, emoji, reactor, is_super) = r.map_err(|e| e.to_string())?;
            match out.last_mut() {
                Some(last) if last.msg_id == msg_id && last.emoji == emoji => {
                    last.count += 1;
                    if is_super {
                        last.super_count += 1;
                    }
                    last.reactors.push(reactor);
                }
                _ => out.push(ReactionSummary {
                    msg_id,
                    emoji,
                    count: 1,
                    reactors: vec![reactor],
                    mine: false,
                    super_count: if is_super { 1 } else { 0 },
                }),
            }
        }
        Ok(out)
    }

    pub fn mark_reactions_mine(
        &self,
        mut rows: Vec<ReactionSummary>,
        my_fp: &str,
    ) -> Vec<ReactionSummary> {
        for r in rows.iter_mut() {
            r.mine = r.reactors.iter().any(|x| x == my_fp);
        }
        rows
    }

    pub fn reaction_apply(
        &self,
        msg_id: &str,
        conv_id: &str,
        emoji: &str,
        reactor_fp: &str,
        add: bool,
    ) -> Result<bool, String> {
        self.reaction_apply_full(msg_id, conv_id, emoji, reactor_fp, add, false)
    }

    pub fn reaction_apply_full(
        &self,
        msg_id: &str,
        conv_id: &str,
        emoji: &str,
        reactor_fp: &str,
        add: bool,
        is_super: bool,
    ) -> Result<bool, String> {
        let conn = self.locked();
        if add {
            conn.execute(
                "INSERT OR IGNORE INTO msg_reactions (msg_id, conv_id, emoji, reactor_fp, created_at, is_super)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    msg_id,
                    conv_id,
                    emoji,
                    reactor_fp,
                    crate::identity::now_ms(),
                    is_super as i32
                ],
            )
            .map_err(|e| e.to_string())?;
            Ok(true)
        } else {
            conn.execute(
                "DELETE FROM msg_reactions WHERE msg_id=?1 AND emoji=?2 AND reactor_fp=?3",
                params![msg_id, emoji, reactor_fp],
            )
            .map_err(|e| e.to_string())?;
            Ok(false)
        }
    }

    pub fn queue_pending_react(
        &self,
        peer_fp: &str,
        conv_id: &str,
        msg_id: &str,
        emoji: &str,
        add: bool,
    ) -> Result<(), String> {
        self.queue_pending_react_full(peer_fp, conv_id, msg_id, emoji, add, false)
    }

    pub fn queue_pending_react_full(
        &self,
        peer_fp: &str,
        conv_id: &str,
        msg_id: &str,
        emoji: &str,
        add: bool,
        is_super: bool,
    ) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT OR REPLACE INTO pending_reacts (peer_fp, msg_id, conv_id, emoji, is_add, created_at, is_super)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                peer_fp,
                msg_id,
                conv_id,
                emoji,
                add as i32,
                crate::identity::now_ms(),
                is_super as i32
            ],
        )
        .map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM pending_reacts WHERE peer_fp=?1 AND rowid NOT IN
             (SELECT rowid FROM pending_reacts WHERE peer_fp=?1 ORDER BY created_at DESC LIMIT 200)",
            params![peer_fp],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn take_pending_reacts(
        &self,
        peer_fp: &str,
    ) -> Result<Vec<(String, String, String, bool, bool)>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT conv_id, msg_id, emoji, is_add, is_super FROM pending_reacts
                 WHERE peer_fp=?1 ORDER BY created_at ASC LIMIT 200",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![peer_fp], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i32>(3)? != 0,
                    r.get::<_, i32>(4)? != 0,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        conn.execute(
            "DELETE FROM pending_reacts WHERE peer_fp=?1",
            params![peer_fp],
        )
        .map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn read_cursor(&self, conv_id: &str) -> Result<i64, String> {
        let conn = self.locked();
        let ts: i64 = conn
            .query_row(
                "SELECT last_read_ts FROM read_cursors WHERE conv_id=?1",
                params![conv_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        Ok(ts)
    }

    pub fn read_set(&self, conv_id: &str, ts: i64) -> Result<(), String> {
        let me = crate::identity::now_ms();
        let conn = self.locked();
        conn.execute(
            "INSERT INTO read_cursors (conv_id, last_read_ts, updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(conv_id) DO UPDATE SET
               last_read_ts = MAX(read_cursors.last_read_ts, excluded.last_read_ts),
               updated_at = excluded.updated_at",
            params![conv_id, ts, me],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Leitura do ponto de vista de UM membro. `read_cursors` continua sendo
    /// o "meu cursor" (chamadas antigas), mas grupo/canal precisam separar
    /// quem leu o quê — senão o recibo de um virava "lido" para todos.
    pub fn conv_read_set(&self, conv_id: &str, fp: &str, ts: i64) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO conv_read (conv_id, fp, last_read_ts, updated_at) VALUES (?1,?2,?3,?3)
             ON CONFLICT(conv_id, fp) DO UPDATE SET
               last_read_ts = MAX(conv_read.last_read_ts, excluded.last_read_ts),
               updated_at = excluded.updated_at",
            params![conv_id, fp, ts],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn conv_read_cursor(&self, conv_id: &str, fp: &str) -> Result<i64, String> {
        let conn = self.locked();
        // Compatibilidade: instalações antigas só têm o cursor global. O efetivo é o maior dos dois, então atualizar não "desmarca" leitura.
        let ts: i64 = conn
            .query_row(
                "SELECT MAX(
                    COALESCE((SELECT last_read_ts FROM conv_read WHERE conv_id=?1 AND fp=?2), 0),
                    COALESCE((SELECT last_read_ts FROM read_cursors WHERE conv_id=?1), 0)
                 )",
                params![conv_id, fp],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(ts)
    }

    pub fn mention_add(&self, msg_id: &str, conv_id: &str, target_fp: &str) -> Result<(), String> {
        if target_fp.is_empty() {
            return Ok(());
        }
        self.locked()
            .execute(
                "INSERT OR IGNORE INTO mentions (msg_id, conv_id, target_fp, created_at)
                 VALUES (?1,?2,?3,?4)",
                params![msg_id, conv_id, target_fp, crate::identity::now_ms()],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn mention_targets(&self, body: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = body;
        while let Some(pos) = rest.find('@') {
            rest = &rest[pos + 1..];
            let token: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
            if token.len() == 12 && !out.contains(&token) {
                out.push(token);
            }
        }
        if out.is_empty() && body.contains("@everyone") {
            out.push("everyone".into());
        }
        out
    }

    pub fn unread_mentions_for(&self, fp: &str) -> Result<i64, String> {
        if fp.is_empty() {
            return Ok(0);
        }
        let conn = self.locked();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM mentions m
                   JOIN messages g ON g.id = m.msg_id
              LEFT JOIN conv_read rc ON rc.conv_id = m.conv_id AND rc.fp = ?1
                  WHERE m.target_fp = ?1
                    AND g.author_fp <> ?1
                    AND (rc.last_read_ts IS NULL OR g.ts > rc.last_read_ts)",
                params![fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        Ok(n)
    }

    pub fn read_all(&self) -> Result<Vec<ReadCursor>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT conv_id, last_read_ts, updated_at FROM read_cursors")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ReadCursor {
                    conv_id: r.get(0)?,
                    last_read_ts: r.get(1)?,
                    updated_at: r.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn unread_count(&self, conv_id: &str) -> Result<i64, String> {
        let cursor = self.read_cursor(conv_id)?;
        let conn = self.locked();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages WHERE conv_id=?1 AND ts > ?2",
                params![conv_id, cursor],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    /// Não lidas de UM membro (grupo/canal), descontando as próprias.
    pub fn unread_count_for(&self, conv_id: &str, fp: &str) -> Result<i64, String> {
        let cursor = self.conv_read_cursor(conv_id, fp)?;
        let conn = self.locked();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM messages
                  WHERE conv_id=?1 AND ts > ?2 AND author_fp <> ?3",
                params![conv_id, cursor, fp],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(n)
    }

    pub fn unread_mentions(&self, fp: &str) -> Result<i64, String> {
        if fp.is_empty() {
            return Ok(0);
        }
        // Tabela `mentions` é a fonte de verdade. O `msg_meta.mentioned` é
        // apenas um booleano "alguém foi mencionado" e não dizer QUEM — não
        // serve para contar menções de um membro específico.
        self.unread_mentions_for(fp)
    }
}
