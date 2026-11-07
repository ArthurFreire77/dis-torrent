// Metodos de crate::storage::Store: meta. Irmao de social.rs (mesma impl, mesmo tipo).

use super::*;

impl crate::storage::Store {
    fn meta_load(&self, msg_id: &str) -> Result<Option<MsgMetaView>, String> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT msg_id, conv_id, reply_to, forwarded_from, edited_body, edited_at,
                        deleted, pinned, pinned_by, mentioned
                 FROM msg_meta WHERE msg_id=?1",
                params![msg_id],
                |r| {
                    Ok(MsgMetaView {
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
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(r)
    }

    pub fn msg_meta(&self, msg_id: &str) -> Result<Option<MsgMetaView>, String> {
        self.meta_load(msg_id)
    }

    pub fn msg_meta_bulk(&self, msg_ids: &[String]) -> Result<Vec<MsgMetaView>, String> {
        let mut out = Vec::new();
        for id in msg_ids {
            if let Some(m) = self.meta_load(id)? {
                out.push(m);
            }
        }
        Ok(out)
    }

    pub fn msg_set_reply(&self, msg_id: &str, conv_id: &str, reply_to: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO msg_meta (msg_id, conv_id, reply_to) VALUES (?1,?2,?3)
             ON CONFLICT(msg_id) DO UPDATE SET reply_to=excluded.reply_to",
            params![msg_id, conv_id, reply_to],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn msg_set_forward(&self, msg_id: &str, conv_id: &str, from: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO msg_meta (msg_id, conv_id, forwarded_from) VALUES (?1,?2,?3)
             ON CONFLICT(msg_id) DO UPDATE SET forwarded_from=excluded.forwarded_from",
            params![msg_id, conv_id, from],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn msg_set_mentioned(&self, msg_id: &str, conv_id: &str, on: bool) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO msg_meta (msg_id, conv_id, mentioned) VALUES (?1,?2,?3)
             ON CONFLICT(msg_id) DO UPDATE SET mentioned=excluded.mentioned",
            params![msg_id, conv_id, on as i64],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn msg_edit(&self, msg_id: &str, conv_id: &str, body: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO msg_meta (msg_id, conv_id, edited_body, edited_at) VALUES (?1,?2,?3,?4)
             ON CONFLICT(msg_id) DO UPDATE SET edited_body=excluded.edited_body, edited_at=excluded.edited_at",
            params![msg_id, conv_id, body, crate::identity::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn msg_delete(&self, msg_id: &str, conv_id: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO msg_meta (msg_id, conv_id, deleted) VALUES (?1,?2,1)
             ON CONFLICT(msg_id) DO UPDATE SET deleted=1",
            params![msg_id, conv_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn effective_body(&self, msg_id: &str, original: &str) -> Result<String, String> {
        Ok(match self.meta_load(msg_id)? {
            Some(m) if !m.edited_body.is_empty() => m.edited_body,
            _ => original.to_string(),
        })
    }

    pub fn msg_pin(
        &self,
        msg_id: &str,
        conv_id: &str,
        pinned: bool,
        by_fp: &str,
    ) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO msg_meta (msg_id, conv_id, pinned, pinned_at, pinned_by) VALUES (?1,?2,?3,?4,?5)
             ON CONFLICT(msg_id) DO UPDATE SET pinned=excluded.pinned, pinned_at=excluded.pinned_at, pinned_by=excluded.pinned_by",
            params![msg_id, conv_id, pinned as i64, crate::identity::now_ms(), by_fp],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Consome uma das três mensagens iniciais. Devolve `true` quando a
    /// mensagem pode sair AGORA e `false` quando o limite daquela direção já
    /// estourou. `INSERT ... WHERE used < limite` é atômico no SQLite, então
    /// duas abas/dispositivos não conseguem passar de três ao mesmo tempo.
    pub fn dm_intro_take(
        &self,
        conv_id: &str,
        author_fp: &str,
        limit: i64,
    ) -> Result<bool, String> {
        let conn = self.locked();
        let changed = conn
            .execute(
                "INSERT INTO dm_intro (conv_id, author_fp, used, updated_at)
                 VALUES (?1,?2,1,?3)
                 ON CONFLICT(conv_id, author_fp) DO UPDATE SET
                   used = dm_intro.used + 1,
                   updated_at = excluded.updated_at
                 WHERE dm_intro.used < ?4",
                params![conv_id, author_fp, crate::identity::now_ms(), limit],
            )
            .map_err(|e| e.to_string())?;
        Ok(changed > 0)
    }

    pub fn dm_intro_used(&self, conv_id: &str, author_fp: &str) -> Result<i64, String> {
        let conn = self.locked();
        Ok(conn
            .query_row(
                "SELECT used FROM dm_intro WHERE conv_id=?1 AND author_fp=?2",
                params![conv_id, author_fp],
                |r| r.get::<_, i64>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0))
    }

    /// Estado que a UI precisa para não prometer o que o motor vai recusar.
    pub fn dm_intro_state(
        &self,
        conv_id: &str,
        peer_fp: &str,
        my_fp: &str,
    ) -> Result<IntroState, String> {
        let is_friend = matches!(
            self.get_friend(peer_fp).ok().flatten(),
            Some((_, s)) if s == "accepted"
        );
        let used = if is_friend {
            0
        } else {
            self.dm_intro_used(conv_id, my_fp)?
        };
        let limit = crate::social::DM_INTRO_LIMIT;
        Ok(IntroState {
            used,
            limit,
            is_friend,
            remaining: if is_friend {
                limit
            } else {
                (limit - used).max(0)
            },
        })
    }

    /// Devolve o crédito consumido por uma mensagem que NÃO chegou a existir
    /// (duplicata/rejeição). Sem isso, reconexão ou retry queimava o limite.
    pub fn dm_intro_refund(&self, conv_id: &str, author_fp: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "UPDATE dm_intro SET used = MAX(used - 1, 0), updated_at=?3
              WHERE conv_id=?1 AND author_fp=?2",
            params![conv_id, author_fp, crate::identity::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Zera o crédito quando a amizade é aceita: o histórico fica, mas a
    /// conversa deixa de ser "introdução".
    pub fn dm_intro_reset(&self, conv_id: &str) -> Result<(), String> {
        self.locked()
            .execute("DELETE FROM dm_intro WHERE conv_id=?1", params![conv_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
