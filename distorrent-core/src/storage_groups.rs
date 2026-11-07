// Metodos de Store: groups/calls/voice.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

impl Store {
    pub fn create_group_dm(
        &self,
        my_fp: &str,
        members: &[String],
        title: &str,
    ) -> Result<Conversation> {
        use blake3::Hasher;
        let mut sorted = members.to_vec();
        sorted.push(my_fp.to_string());
        sorted.sort();
        sorted.dedup();
        let mut h = Hasher::new();
        h.update(b"distorrent/v1|group|");
        for fp in &sorted {
            h.update(fp.as_bytes());
            h.update(b"|");
        }
        h.update(&crate::identity::now_ms().to_be_bytes());
        let id = hex::encode(h.finalize().as_bytes())[..24].to_string();
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO conversations(id,kind,title,peer_fp,created_at) VALUES(?1,'group',?2,'',?3)",
            params![id, title, crate::identity::now_ms()],
        )?;
        for fp in sorted {
            tx.execute(
                "INSERT OR IGNORE INTO group_members(conv_id,fp,nickname,added_at) VALUES(?1,?2,'',?3)",
                params![id, fp, crate::identity::now_ms()],
            )?;
        }
        // O dono é quem CRIOU, não quem ordenou primeiro na lista.
        tx.execute(
            "INSERT INTO group_owners(conv_id,owner_fp) VALUES(?1,?2)
             ON CONFLICT(conv_id) DO UPDATE SET owner_fp=excluded.owner_fp",
            params![id, my_fp],
        )?;
        tx.commit()?;
        Ok(Conversation {
            id,
            kind: "group".into(),
            title: title.to_string(),
            peer_fp: "".into(),
            created_at: crate::identity::now_ms(),
        })
    }

    pub fn group_owner(&self, conv_id: &str) -> Result<Option<String>> {
        let conn = self.locked();
        let dono = conn
            .query_row(
                "SELECT owner_fp FROM group_owners WHERE conv_id=?1",
                params![conv_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if dono.is_some() {
            return Ok(dono);
        }
        Ok(Self::list_group_members_conn(&conn, conv_id)?
            .first()
            .map(|(fp, _)| fp.clone()))
    }

    pub fn group_owner_set(&self, conv_id: &str, owner_fp: &str) -> Result<()> {
        self.locked().execute(
            "INSERT INTO group_owners(conv_id,owner_fp) VALUES(?1,?2)
             ON CONFLICT(conv_id) DO UPDATE SET owner_fp=excluded.owner_fp",
            params![conv_id, owner_fp],
        )?;
        Ok(())
    }

    pub fn list_group_members(&self, conv_id: &str) -> Result<Vec<(String, String)>> {
        let conn = self.locked();
        Self::list_group_members_conn(&conn, conv_id)
    }

    fn list_group_members_conn(conn: &Connection, conv_id: &str) -> Result<Vec<(String, String)>> {
        let mut st = conn
            .prepare("SELECT fp,nickname FROM group_members WHERE conv_id=?1 ORDER BY added_at")?;
        let rows = st
            .query_map(params![conv_id], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn add_group_member(&self, conv_id: &str, fp: &str, nickname: &str) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO group_members(conv_id,fp,nickname,added_at) VALUES(?1,?2,?3,?4)",
            params![conv_id, fp, nickname, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn remove_group_member(&self, conv_id: &str, fp: &str) -> Result<()> {
        self.locked().execute(
            "DELETE FROM group_members WHERE conv_id=?1 AND fp=?2",
            params![conv_id, fp],
        )?;
        Ok(())
    }

    pub fn leave_group_local(&self, conv_id: &str) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM group_members WHERE conv_id=?1",
            params![conv_id],
        )?;
        tx.execute("DELETE FROM messages WHERE conv_id=?1", params![conv_id])?;
        tx.execute("DELETE FROM conversations WHERE id=?1", params![conv_id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn create_call(
        &self,
        call_id: &str,
        kind: &str,
        conv_id: &str,
        host_fp: &str,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO calls(call_id,kind,conv_id,host_fp,created_at) VALUES(?1,?2,?3,?4,?5)",
            params![call_id, kind, conv_id, host_fp, crate::identity::now_ms()],
        )?;
        self.locked().execute(
            "INSERT OR IGNORE INTO call_participants(call_id,fp,joined_at) VALUES(?1,?2,?3)",
            params![call_id, host_fp, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn join_call(&self, call_id: &str, fp: &str) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO call_participants(call_id,fp,joined_at) VALUES(?1,?2,?3)",
            params![call_id, fp, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn leave_call(&self, call_id: &str, fp: &str) -> Result<()> {
        self.locked().execute(
            "DELETE FROM call_participants WHERE call_id=?1 AND fp=?2",
            params![call_id, fp],
        )?;
        Ok(())
    }

    pub fn end_call(&self, call_id: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE calls SET ended_at=?2 WHERE call_id=?1",
            params![call_id, crate::identity::now_ms()],
        )?;
        self.locked().execute(
            "DELETE FROM call_participants WHERE call_id=?1",
            params![call_id],
        )?;
        Ok(())
    }

    pub fn get_call_host(&self, call_id: &str) -> Result<Option<String>> {
        let conn = self.locked();
        conn.query_row(
            "SELECT host_fp FROM calls WHERE call_id=?1",
            params![call_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn call_participants(&self, call_id: &str) -> Result<Vec<String>> {
        let conn = self.locked();
        let mut st = conn.prepare("SELECT fp FROM call_participants WHERE call_id=?1")?;
        let rows = st
            .query_map(params![call_id], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn is_in_call(&self, call_id: &str, fp: &str) -> bool {
        self.locked()
            .query_row(
                "SELECT 1 FROM call_participants WHERE call_id=?1 AND fp=?2",
                params![call_id, fp],
                |_| Ok(()),
            )
            .is_ok()
    }

    pub fn peer_in_active_call(&self, fp: &str) -> bool {
        self.locked()
            .query_row(
                "SELECT 1 FROM call_participants cp \
                 JOIN calls c ON c.call_id = cp.call_id \
                 WHERE cp.fp = ?1 AND c.ended_at IS NULL LIMIT 1",
                params![fp],
                |_| Ok(()),
            )
            .is_ok()
    }

    pub fn set_voice_state(
        &self,
        community_id: &str,
        channel_id: &str,
        fp: &str,
        muted: bool,
        deafened: bool,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT INTO voice_states(community_id,channel_id,fp,muted,deafened,speaking,joined_at,announced_at) VALUES(?1,?2,?3,?4,?5,0,?6,?6)
             ON CONFLICT(community_id,channel_id,fp) DO UPDATE SET muted=excluded.muted, deafened=excluded.deafened, announced_at=excluded.announced_at",
            params![community_id, channel_id, fp, if muted {1} else {0}, if deafened {1} else {0}, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn leave_voice(&self, community_id: &str, channel_id: &str, fp: &str) -> Result<()> {
        self.locked().execute(
            "DELETE FROM voice_states WHERE community_id=?1 AND channel_id=?2 AND fp=?3",
            params![community_id, channel_id, fp],
        )?;
        Ok(())
    }

    pub fn list_voice_states(
        &self,
        community_id: &str,
        channel_id: &str,
    ) -> Result<Vec<(String, bool, bool)>> {
        let agora = crate::identity::now_ms();
        let limite = agora - (Self::VOICE_PRESENCE_TTL_MS as i64);
        let conn = self.locked();
        let _ = conn.execute(
            "DELETE FROM voice_states WHERE community_id=?1 AND channel_id=?2 AND announced_at > 0 AND announced_at < ?3",
            params![community_id, channel_id, limite],
        );
        let mut st = conn.prepare(
            "SELECT fp,muted,deafened FROM voice_states WHERE community_id=?1 AND channel_id=?2",
        )?;
        let rows = st
            .query_map(params![community_id, channel_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)? != 0,
                    r.get::<_, i64>(2)? != 0,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn my_voice_states(&self, fp: &str) -> Result<Vec<(String, String, bool, bool)>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT community_id,channel_id,muted,deafened FROM voice_states WHERE fp=?1",
        )?;
        let rows = st
            .query_map(params![fp], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? != 0,
                    r.get::<_, i64>(3)? != 0,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn clear_my_voice_states(&self, fp: &str) -> Result<()> {
        self.locked()
            .execute("DELETE FROM voice_states WHERE fp=?1", params![fp])?;
        Ok(())
    }

    pub fn peer_voice_states(&self, fp: &str) -> Result<Vec<(String, String)>> {
        let conn = self.locked();
        let mut st =
            conn.prepare("SELECT community_id,channel_id FROM voice_states WHERE fp=?1")?;
        let rows = st
            .query_map(params![fp], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn drop_peer_voice_state(
        &self,
        community_id: &str,
        channel_id: &str,
        fp: &str,
    ) -> Result<()> {
        self.locked().execute(
            "DELETE FROM voice_states WHERE community_id=?1 AND channel_id=?2 AND fp=?3",
            params![community_id, channel_id, fp],
        )?;
        Ok(())
    }

    pub fn drop_peer_voice_states(&self, fp: &str) -> Result<Vec<(String, String)>> {
        let conn = self.locked();
        let mut st =
            conn.prepare("SELECT community_id,channel_id FROM voice_states WHERE fp=?1")?;
        let rows = st
            .query_map(params![fp], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(st);
        conn.execute("DELETE FROM voice_states WHERE fp=?1", params![fp])?;
        Ok(rows)
    }

    pub fn upsert_group_state(
        &self,
        conv_id: &str,
        title: &str,
        members: &[(String, String)],
    ) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO conversations(id,kind,title,peer_fp,created_at) VALUES(?1,'group',?2,'',?3)",
            params![conv_id, title, crate::identity::now_ms()],
        )?;
        if !title.is_empty() {
            tx.execute(
                "UPDATE conversations SET title=?2 WHERE id=?1",
                params![conv_id, title],
            )?;
        }
        tx.execute(
            "DELETE FROM group_members WHERE conv_id=?1",
            params![conv_id],
        )?;
        for (fp, nick) in members {
            tx.execute(
                "INSERT OR IGNORE INTO group_members(conv_id,fp,nickname,added_at) VALUES(?1,?2,?3,?4)",
                params![conv_id, fp, nick, crate::identity::now_ms()],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    #[allow(clippy::type_complexity)]
    pub fn group_convs_with_peer(
        &self,
        peer_fp: &str,
    ) -> Result<Vec<(String, String, Vec<(String, String)>)>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT c.id, c.title FROM conversations c
             WHERE c.kind='group' AND EXISTS(
               SELECT 1 FROM group_members gm WHERE gm.conv_id=c.id AND gm.fp=?1)
             ORDER BY c.created_at ASC",
        )?;
        let convs = st
            .query_map(params![peer_fp], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(convs.len());
        for (id, title) in convs {
            let members = Self::list_group_members_conn(&conn, &id)?;
            out.push((id, title, members));
        }
        Ok(out)
    }

    pub fn pending_group_messages(&self) -> Result<Vec<StoredMessage>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT m.id,m.conv_id,m.author_fp,m.body,m.ts,m.sig,m.direction,m.status,m.bot_id,m.thread_id
             FROM messages m JOIN conversations c ON c.id = m.conv_id
             WHERE c.kind='group' AND m.direction='out' AND m.status IN ('pending','sending')
             ORDER BY m.ts ASC, m.id ASC",
        )?;
        let rows = st
            .query_map([], |r| {
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
    }

    pub fn revert_unacked_groups_to_pending(&self) -> Result<Vec<String>> {
        let ids = {
            let conn = self.locked();
            let mut st = conn.prepare(
                "SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conv_id
                 WHERE c.kind='group' AND m.direction='out' AND m.status IN ('sending','sent')",
            )?;
            let ids = st
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(st);
            ids
        };
        for id in &ids {
            self.set_message_status(id, "pending")?;
        }
        Ok(ids)
    }
}
