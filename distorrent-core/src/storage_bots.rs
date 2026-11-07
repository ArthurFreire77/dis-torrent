// Metodos de Store: bots.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

impl Store {
    pub fn bots_list(&self, community_id: &str) -> Result<Vec<BotRow>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config,perms,webhook_secret
             FROM bots WHERE community_id=?1 ORDER BY created_at, id",
        )?;
        let rows = st
            .query_map(params![community_id], |r| {
                Ok(BotRow {
                    id: r.get(0)?,
                    community_id: r.get(1)?,
                    name: r.get(2)?,
                    discriminator: r.get(3)?,
                    avatar: r.get(4)?,
                    role_id: r.get(5)?,
                    token: r.get(6)?,
                    online: r.get::<_, i64>(7)? != 0,
                    owner_fp: r.get(8)?,
                    created_at: r.get(9)?,
                    config: r.get(10)?,
                    perms: r.get::<_, i64>(11).unwrap_or(0),
                    webhook_secret: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn bot_upsert(&self, b: &BotRow) -> Result<()> {
        let conn = self.locked();
        insert_bot_row(&conn, b)
    }

    pub fn bot_update_patch(
        &self,
        community_id: &str,
        bot_id: &str,
        patch: &BotPatch,
    ) -> Result<bool> {
        let all = self.bots_list(community_id)?;
        let Some(mut b) = all.into_iter().find(|x| x.id == bot_id) else {
            return Ok(false);
        };
        if let Some(n) = &patch.name {
            if !n.is_empty() {
                b.name = n.clone();
            }
        }
        if let Some(a) = &patch.avatar {
            if !a.is_empty() {
                b.avatar = a.clone();
            }
        }
        if let Some(rid) = &patch.role_id {
            b.role_id = match rid {
                Some(s) if !s.is_empty() => Some(s.clone()),
                _ => None,
            };
        }
        if let Some(o) = patch.online {
            b.online = o;
        }
        if let Some(c) = &patch.config {
            if c.len() > crate::bots::BOT_CONFIG_MAX {
                return Err(DistorrentError::Protocol(format!(
                    "config de bot muito grande (máx {} KB)",
                    crate::bots::BOT_CONFIG_MAX / 1024
                )));
            }
            b.config = c.clone();
        }
        if let Some(p) = patch.perms {
            b.perms = p & crate::moderation::PERM_ALL;
        }
        if let Some(s) = &patch.webhook_secret {
            b.webhook_secret = s.trim().chars().take(128).collect();
        }
        self.bot_upsert(&b)?;
        Ok(true)
    }

    pub fn bot_delete(&self, community_id: &str, bot_id: &str) -> Result<usize> {
        let conn = self.locked();
        conn.execute(
            "DELETE FROM bots WHERE community_id=?1 AND id=?2",
            params![community_id, bot_id],
        )
        .map_err(Into::into)
    }

    pub fn bots_replace(&self, community_id: &str, rows: &[BotRow]) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM bots WHERE community_id=?1",
            params![community_id],
        )?;
        for b in rows {
            insert_bot_row(&tx, b)?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Grava uma linha no console do bot. Corta a mensagem e mantém só as 500
    /// mais recentes por bot — log infinito viraria banco infinito.
    pub fn bot_log(
        &self,
        community_id: &str,
        bot_id: &str,
        level: &str,
        message: &str,
    ) -> Result<()> {
        let level = match level {
            "warn" | "error" => level,
            _ => "info",
        };
        let msg: String = message.chars().take(1000).collect();
        let conn = self.locked();
        conn.execute(
            "INSERT INTO bot_logs(community_id,bot_id,level,message,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![community_id, bot_id, level, msg, crate::identity::now_ms()],
        )?;
        conn.execute(
            "DELETE FROM bot_logs WHERE community_id=?1 AND bot_id=?2 AND id NOT IN
               (SELECT id FROM bot_logs WHERE community_id=?1 AND bot_id=?2 ORDER BY id DESC LIMIT 500)",
            params![community_id, bot_id],
        )?;
        Ok(())
    }

    pub fn bot_logs(&self, community_id: &str, bot_id: &str, limit: i64) -> Result<Vec<BotLogRow>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,community_id,bot_id,level,message,created_at FROM bot_logs
             WHERE community_id=?1 AND bot_id=?2 ORDER BY id DESC LIMIT ?3",
        )?;
        let rows = st
            .query_map(params![community_id, bot_id, limit.clamp(1, 500)], |r| {
                Ok(BotLogRow {
                    id: r.get(0)?,
                    community_id: r.get(1)?,
                    bot_id: r.get(2)?,
                    level: r.get(3)?,
                    message: r.get(4)?,
                    created_at: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn bot_logs_clear(&self, community_id: &str, bot_id: &str) -> Result<usize> {
        Ok(self.locked().execute(
            "DELETE FROM bot_logs WHERE community_id=?1 AND bot_id=?2",
            params![community_id, bot_id],
        )?)
    }

    pub fn bot_var_get(&self, community_id: &str, bot_id: &str, key: &str) -> Option<String> {
        self.locked()
            .query_row(
                "SELECT value FROM bot_vars WHERE community_id=?1 AND bot_id=?2 AND key=?3",
                params![community_id, bot_id, key],
                |r| r.get::<_, String>(0),
            )
            .ok()
    }

    pub fn bot_vars_list(&self, community_id: &str, bot_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT key,value FROM bot_vars WHERE community_id=?1 AND bot_id=?2 ORDER BY key",
        )?;
        let rows = st
            .query_map(params![community_id, bot_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn bot_var_set(
        &self,
        community_id: &str,
        bot_id: &str,
        key: &str,
        value: &str,
    ) -> Result<()> {
        let key: String = key.chars().take(64).collect();
        let value: String = value.chars().take(2048).collect();
        self.locked().execute(
            "INSERT INTO bot_vars(community_id,bot_id,key,value,updated_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(community_id,bot_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            params![community_id, bot_id, key, value, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub(super) fn bot_row_mapper() -> impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<BotRow> {
        |r| {
            Ok(BotRow {
                id: r.get(0)?,
                community_id: r.get(1)?,
                name: r.get(2)?,
                discriminator: r.get(3)?,
                avatar: r.get(4)?,
                role_id: r.get(5)?,
                token: r.get(6)?,
                online: r.get::<_, i64>(7)? != 0,
                owner_fp: r.get(8)?,
                created_at: r.get(9)?,
                config: r.get::<_, Option<String>>(10)?.unwrap_or_default(),
                perms: r.get::<_, i64>(11).unwrap_or(0),
                webhook_secret: r.get::<_, Option<String>>(12)?.unwrap_or_default(),
            })
        }
    }
}
