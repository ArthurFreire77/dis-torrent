// Metodos de Store: communities/channels/roles.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

impl Store {
    pub fn create_community(
        &self,
        id: &str,
        name: &str,
        owner_fp: &str,
        channels: &[(&str, &str)],
    ) -> Result<()> {
        let now = crate::identity::now_ms();
        self.locked().execute(
            "INSERT INTO communities(id,name,owner_fp,created_at) VALUES(?1,?2,?3,?4)",
            params![id, name, owner_fp, now],
        )?;
        self.locked().execute(
            "INSERT INTO community_members(community_id,fp,nickname,role,joined_at) VALUES(?1,?2,?3,'owner',?4)",
            params![id, owner_fp, "", now],
        )?;
        for (i, (cid, cname)) in channels.iter().enumerate() {
            self.locked().execute(
                "INSERT INTO channels(id,community_id,name,kind,position) VALUES(?1,?2,?3,'text',?4)",
                params![cid, id, cname, i as i64],
            )?;
        }
        Ok(())
    }

    pub fn join_community(
        &self,
        id: &str,
        name: &str,
        owner_fp: &str,
        member_fp: &str,
        member_nick: &str,
        channels: &[(String, String)],
    ) -> Result<()> {
        let now = crate::identity::now_ms();
        self.locked().execute(
            "INSERT OR IGNORE INTO communities(id,name,owner_fp,created_at) VALUES(?1,?2,?3,?4)",
            params![id, name, owner_fp, now],
        )?;
        self.locked().execute(
            "INSERT OR IGNORE INTO community_members(community_id,fp,nickname,role,joined_at) VALUES(?1,?2,?3,'member',?4)",
            params![id, member_fp, member_nick, now],
        )?;
        for (i, (cid, cname)) in channels.iter().enumerate() {
            self.locked().execute(
                "INSERT OR IGNORE INTO channels(id,community_id,name,kind,position) VALUES(?1,?2,?3,'text',?4)",
                params![cid, id, cname, i as i64],
            )?;
        }
        Ok(())
    }

    pub fn list_communities(&self) -> Result<Vec<(String, String, String)>> {
        let conn = self.locked();
        let mut st =
            conn.prepare("SELECT id,name,owner_fp FROM communities ORDER BY created_at")?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_community(&self, id: &str) -> Result<Option<(String, String, String)>> {
        let conn = self.locked();
        conn.query_row(
            "SELECT id,name,owner_fp FROM communities WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn community_meta(&self, id: &str) -> Result<(String, String, String)> {
        let conn = self.locked();
        conn.query_row(
            "SELECT description,category,icon FROM communities WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map(|o| o.unwrap_or_default())
        .map_err(Into::into)
    }

    pub fn community_meta_set(
        &self,
        id: &str,
        description: Option<&str>,
        category: Option<&str>,
        icon: Option<&str>,
    ) -> Result<usize> {
        let conn = self.locked();
        let mut sets: Vec<(&str, String)> = Vec::new();
        if let Some(d) = description {
            if d.chars().count() > 512 {
                return Err(DistorrentError::Protocol(
                    "descrição muito longa (máx 512)".into(),
                ));
            }
            sets.push(("description=?", d.to_string()));
        }
        if let Some(c) = category {
            if c.chars().count() > 32 {
                return Err(DistorrentError::Protocol(
                    "categoria muito longa (máx 32)".into(),
                ));
            }
            sets.push(("category=?", c.to_string()));
        }
        if let Some(i) = icon {
            if i.chars().count() > 8 {
                return Err(DistorrentError::Protocol(
                    "ícone muito longo (máx 8 chars)".into(),
                ));
            }
            sets.push(("icon=?", i.to_string()));
        }
        if sets.is_empty() {
            return Ok(0);
        }
        let assignments: Vec<String> = sets.iter().map(|(k, _)| k.to_string()).collect();
        let sql = format!(
            "UPDATE communities SET {} WHERE id=?{}",
            assignments.join(","),
            sets.len() + 1
        );
        let mut values: Vec<&dyn rusqlite::ToSql> = Vec::new();
        for (_, v) in &sets {
            values.push(v);
        }
        values.push(&id);
        conn.execute(&sql, values.as_slice()).map_err(Into::into)
    }

    /// Marca o servidor como público (entrada livre com rate limit) ou privado
    /// (só por convite). Devolve quantas linhas mudaram.
    pub fn community_set_public(&self, id: &str, is_public: bool) -> Result<usize> {
        self.locked()
            .execute(
                "UPDATE communities SET is_public=?2 WHERE id=?1",
                params![id, i64::from(is_public)],
            )
            .map_err(Into::into)
    }

    pub fn community_is_public(&self, id: &str) -> Result<bool> {
        let conn = self.locked();
        conn.query_row(
            "SELECT is_public FROM communities WHERE id=?1",
            params![id],
            |r| r.get::<_, i64>(0),
        )
        .optional()
        .map(|o| o.unwrap_or(0) != 0)
        .map_err(Into::into)
    }

    /// Servidores públicos desta máquina, para o diretório/descoberta.
    pub fn list_public_communities(&self) -> Result<Vec<(String, String, String)>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,name,owner_fp FROM communities WHERE is_public=1 ORDER BY created_at",
        )?;
        let rows = st
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn list_channels(&self, community_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.locked();
        let mut st =
            conn.prepare("SELECT id,name FROM channels WHERE community_id=?1 ORDER BY position")?;
        let rows = st
            .query_map(params![community_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn channel_community(&self, channel_id: &str) -> Result<Option<String>> {
        let conn = self.locked();
        let mut st = conn.prepare("SELECT community_id FROM channels WHERE id=?1")?;
        let mut rows = st.query(params![channel_id])?;
        Ok(match rows.next()? {
            Some(r) => Some(r.get(0)?),
            None => None,
        })
    }

    pub fn channel_position(&self, channel_id: &str) -> Result<Option<i64>> {
        let conn = self.locked();
        conn.query_row(
            "SELECT position FROM channels WHERE id=?1",
            params![channel_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn channels_reorder(&self, community_id: &str, ids: &[String]) -> Result<()> {
        if ids.len() > 256 {
            return Err(crate::DistorrentError::Protocol(
                "reordenação grande demais".into(),
            ));
        }
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        {
            let mut st =
                tx.prepare("SELECT COUNT(*) FROM channels WHERE id=?1 AND community_id=?2")?;
            for id in ids {
                let n: i64 = st.query_row(params![id, community_id], |r| r.get(0))?;
                if n != 1 {
                    return Err(crate::DistorrentError::Protocol(
                        "canal não pertence a esta comunidade".into(),
                    ));
                }
            }
            let mut up = tx.prepare("UPDATE channels SET position=?2 WHERE id=?1")?;
            for (i, id) in ids.iter().enumerate() {
                up.execute(params![id, i as i64])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn channel_meta(
        &self,
        channel_id: &str,
    ) -> Result<Option<(String, String, String, String)>> {
        let conn = self.locked();
        let mut st = conn
            .prepare("SELECT community_id,name,kind,IFNULL(topic,'') FROM channels WHERE id=?1")?;
        let mut rows = st.query(params![channel_id])?;
        Ok(match rows.next()? {
            Some(r) => Some((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            None => None,
        })
    }

    pub fn member_role(&self, community_id: &str, fp: &str) -> Option<String> {
        let conn = self.locked();
        conn.query_row(
            "SELECT role FROM community_members WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
            |r| r.get(0),
        )
        .ok()
    }

    pub fn channel_rows(&self, community_id: &str) -> Result<Vec<ChannelMetaRow>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,name,topic,category,kind,position
             FROM channels WHERE community_id=?1 ORDER BY position, id",
        )?;
        let rows = st
            .query_map(params![community_id], |r| {
                Ok(ChannelMetaRow {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    topic: r.get(2)?,
                    category: r.get(3)?,
                    kind: r.get(4)?,
                    position: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn community_channels_replace(
        &self,
        community_id: &str,
        rows: &[ChannelMetaRow],
    ) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM channels WHERE community_id=?1",
            params![community_id],
        )?;
        for r in rows {
            insert_channel_row(&tx, community_id, r)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn community_set_name(&self, id: &str, name: &str) -> Result<usize> {
        let conn = self.locked();
        conn.execute(
            "UPDATE communities SET name=?2 WHERE id=?1",
            params![id, name],
        )
        .map_err(Into::into)
    }

    pub fn roles_list(&self, community_id: &str) -> Result<Vec<RoleRow>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,community_id,name,color,permissions,hoist,mentionable,position
             FROM roles WHERE community_id=?1 ORDER BY position, id",
        )?;
        let rows = st
            .query_map(params![community_id], |r| {
                Ok(RoleRow {
                    id: r.get(0)?,
                    community_id: r.get(1)?,
                    name: r.get(2)?,
                    color: r.get(3)?,
                    permissions: r.get(4)?,
                    hoist: r.get::<_, i64>(5)? != 0,
                    mentionable: r.get::<_, i64>(6)? != 0,
                    position: r.get(7)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn next_role_position(&self, community_id: &str) -> Result<i64> {
        let conn = self.locked();
        conn.query_row(
            "SELECT COALESCE(MAX(position)+1, 0) FROM roles WHERE community_id=?1",
            params![community_id],
            |r| r.get(0),
        )
        .map_err(Into::into)
    }

    pub fn role_upsert(&self, r: &RoleRow) -> Result<()> {
        let conn = self.locked();
        insert_role_row(&conn, r)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn role_update_patch(
        &self,
        community_id: &str,
        role_id: &str,
        name: Option<&str>,
        color: Option<&str>,
        permissions: Option<i64>,
        hoist: Option<bool>,
        mentionable: Option<bool>,
        position: Option<i64>,
    ) -> Result<bool> {
        let all = self.roles_list(community_id)?;
        let Some(mut r) = all.into_iter().find(|x| x.id == role_id) else {
            return Ok(false);
        };
        if let Some(n) = name {
            if !n.is_empty() {
                r.name = n.to_string();
            }
        }
        if let Some(c) = color {
            if !c.is_empty() {
                r.color = c.to_string();
            }
        }
        if let Some(p) = permissions {
            r.permissions = p;
        }
        if let Some(h) = hoist {
            r.hoist = h;
        }
        if let Some(m) = mentionable {
            r.mentionable = m;
        }
        if let Some(p) = position {
            r.position = p;
        }
        self.role_upsert(&r)?;
        Ok(true)
    }

    pub fn role_delete(&self, community_id: &str, role_id: &str) -> Result<usize> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        let n = tx.execute(
            "DELETE FROM roles WHERE community_id=?1 AND id=?2",
            params![community_id, role_id],
        )?;
        tx.execute(
            "DELETE FROM member_roles WHERE community_id=?1 AND role_id=?2",
            params![community_id, role_id],
        )?;
        tx.execute(
            "UPDATE bots SET role_id=NULL WHERE community_id=?1 AND role_id=?2",
            params![community_id, role_id],
        )?;
        tx.commit()?;
        Ok(n)
    }

    pub fn roles_replace(&self, community_id: &str, rows: &[RoleRow]) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM roles WHERE community_id=?1",
            params![community_id],
        )?;
        for r in rows {
            insert_role_row(&tx, r)?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn member_roles_list(&self, community_id: &str, fp: &str) -> Result<Vec<String>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT role_id FROM member_roles WHERE community_id=?1 AND fp=?2 ORDER BY rowid",
        )?;
        let rows = st
            .query_map(params![community_id, fp], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn member_role_assign(&self, community_id: &str, fp: &str, role_id: &str) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO member_roles(community_id,fp,role_id) VALUES(?1,?2,?3)",
            params![community_id, fp, role_id],
        )?;
        Ok(())
    }

    pub fn member_role_unassign(&self, community_id: &str, fp: &str, role_id: &str) -> Result<()> {
        self.locked().execute(
            "DELETE FROM member_roles WHERE community_id=?1 AND fp=?2 AND role_id=?3",
            params![community_id, fp, role_id],
        )?;
        Ok(())
    }

    pub fn member_roles_remove_all(&self, community_id: &str, fp: &str) -> Result<()> {
        self.locked().execute(
            "DELETE FROM member_roles WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
        )?;
        Ok(())
    }

    pub fn member_roles_replace(
        &self,
        community_id: &str,
        assignments: &[(String, Vec<String>)],
    ) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM member_roles WHERE community_id=?1",
            params![community_id],
        )?;
        for (fp, role_ids) in assignments {
            for rid in role_ids {
                tx.execute(
                    "INSERT OR IGNORE INTO member_roles(community_id,fp,role_id) VALUES(?1,?2,?3)",
                    params![community_id, fp, rid],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn community_full_sync(
        &self,
        community_id: &str,
        name: &str,
        owner_fp: &str,
        channels: &[ChannelMetaRow],
        roles: &[RoleRow],
        bots: &[BotRow],
        member_roles: &[(String, Vec<String>)],
        members: &[(String, String, String)],
        meta: &(String, String, String),
        is_public: bool,
    ) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO communities(id,name,owner_fp,created_at,description,category,icon,is_public)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, owner_fp=excluded.owner_fp,
               description=excluded.description, category=excluded.category, icon=excluded.icon,
               is_public=excluded.is_public",
            params![
                community_id,
                name,
                owner_fp,
                crate::identity::now_ms(),
                meta.0,
                meta.1,
                meta.2,
                i64::from(is_public)
            ],
        )?;
        tx.execute(
            "DELETE FROM channels WHERE community_id=?1",
            params![community_id],
        )?;
        for r in channels {
            insert_channel_row(&tx, community_id, r)?;
        }
        tx.execute(
            "DELETE FROM roles WHERE community_id=?1",
            params![community_id],
        )?;
        for r in roles {
            insert_role_row(&tx, r)?;
        }
        tx.execute(
            "DELETE FROM bots WHERE community_id=?1",
            params![community_id],
        )?;
        for b in bots {
            insert_bot_row(&tx, b)?;
        }
        tx.execute(
            "DELETE FROM member_roles WHERE community_id=?1",
            params![community_id],
        )?;
        for (fp, role_ids) in member_roles {
            for rid in role_ids {
                tx.execute(
                    "INSERT OR IGNORE INTO member_roles(community_id,fp,role_id) VALUES(?1,?2,?3)",
                    params![community_id, fp, rid],
                )?;
            }
        }
        for (fp, nick, role) in members {
            tx.execute(
                "INSERT INTO community_members(community_id,fp,nickname,role,joined_at) VALUES(?1,?2,?3,?4,?5)
                 ON CONFLICT(community_id,fp) DO UPDATE SET nickname=excluded.nickname, role=excluded.role",
                params![community_id, fp, nick, role, crate::identity::now_ms()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn community_remove_local(&self, community_id: &str) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM channels WHERE community_id=?1",
            params![community_id],
        )?;
        tx.execute(
            "DELETE FROM community_members WHERE community_id=?1",
            params![community_id],
        )?;
        tx.execute("DELETE FROM communities WHERE id=?1", params![community_id])?;
        tx.execute(
            "DELETE FROM roles WHERE community_id=?1",
            params![community_id],
        )?;
        tx.execute(
            "DELETE FROM bots WHERE community_id=?1",
            params![community_id],
        )?;
        tx.execute(
            "DELETE FROM member_roles WHERE community_id=?1",
            params![community_id],
        )?;
        tx.execute(
            "DELETE FROM voice_states WHERE community_id=?1",
            params![community_id],
        )?;
        tx.commit()?;
        Ok(())
    }
}
