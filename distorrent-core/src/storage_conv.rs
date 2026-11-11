// Metodos de Store: conversations/messages/outbox.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

impl Store {
    pub fn dm_conversation_id(my_fp: &str, peer_fp: &str) -> String {
        use blake3::Hasher;
        let (a, b) = if my_fp <= peer_fp {
            (my_fp, peer_fp)
        } else {
            (peer_fp, my_fp)
        };
        let mut h = Hasher::new();
        h.update(b"distorrent/v1|dm|");
        h.update(a.as_bytes());
        h.update(b"|");
        h.update(b.as_bytes());
        hex::encode(h.finalize().as_bytes())[..24].to_string()
    }

    pub fn ensure_dm_conversation(
        &self,
        my_fp: &str,
        peer_fp: &str,
        title: &str,
    ) -> Result<Conversation> {
        let id = Self::dm_conversation_id(my_fp, peer_fp);
        self.locked().execute(
            "INSERT OR IGNORE INTO conversations(id,kind,title,peer_fp,created_at) VALUES(?1,'dm',?2,?3,?4)",
            params![id, title, peer_fp, crate::identity::now_ms()],
        )?;
        Ok(Conversation {
            id,
            kind: "dm".into(),
            title: title.to_string(),
            peer_fp: peer_fp.to_string(),
            created_at: crate::identity::now_ms(),
        })
    }

    pub fn list_conversations(&self) -> Result<Vec<Conversation>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,kind,title,peer_fp,created_at FROM conversations ORDER BY created_at DESC",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok(Conversation {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    title: r.get(2)?,
                    peer_fp: r.get(3)?,
                    created_at: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_conversation(&self, id: &str) -> Result<Option<Conversation>> {
        let conn = self.locked();
        let mut st =
            conn.prepare("SELECT id,kind,title,peer_fp,created_at FROM conversations WHERE id=?1")?;
        st.query_row(params![id], |r| {
            Ok(Conversation {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get(2)?,
                peer_fp: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .optional()
        .map_err(Into::into)
    }

    pub fn update_conversation_title(&self, id: &str, title: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE conversations SET title=?2 WHERE id=?1",
            params![id, title],
        )?;
        Ok(())
    }

    pub fn delete_conversation(&self, id: &str) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM outbox WHERE msg_id IN (SELECT id FROM messages WHERE conv_id=?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM msg_reactions WHERE conv_id=?1", params![id])?;
        tx.execute("DELETE FROM msg_meta WHERE conv_id=?1", params![id])?;
        tx.execute(
            "DELETE FROM read_receipts WHERE msg_id IN
                    (SELECT id FROM messages WHERE conv_id=?1)",
            params![id],
        )?;
        tx.execute("DELETE FROM messages WHERE conv_id=?1", params![id])?;
        tx.execute("DELETE FROM conversations WHERE id=?1", params![id])?;
        tx.execute("DELETE FROM read_cursors WHERE conv_id=?1", params![id])?;
        tx.execute("DELETE FROM conv_read WHERE conv_id=?1", params![id])?;
        tx.execute("DELETE FROM mentions WHERE conv_id=?1", params![id])?;
        tx.execute("DELETE FROM pending_reacts WHERE conv_id=?1", params![id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn insert_message(&self, m: &MessageEnvelope, direction: &str, status: &str) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO messages(id,conv_id,author_fp,body,ts,sig,direction,status)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8
             WHERE NOT EXISTS (SELECT 1 FROM local_hidden WHERE msg_id=?1)",
            params![
                m.id,
                m.conv_id,
                m.author_fp,
                m.body,
                m.ts,
                m.sig,
                direction,
                status
            ],
        )?;
        Ok(())
    }

    pub fn insert_message_in_thread(
        &self,
        m: &MessageEnvelope,
        thread_id: &str,
        direction: &str,
        status: &str,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO messages(id,conv_id,author_fp,body,ts,sig,direction,status,thread_id)
             SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
             WHERE NOT EXISTS (SELECT 1 FROM local_hidden WHERE msg_id=?1)",
            params![m.id, m.conv_id, m.author_fp, m.body, m.ts, m.sig, direction, status, thread_id],
        )?;
        Ok(())
    }

    pub fn list_messages_thread(&self, thread_id: &str, limit: i64) -> Result<Vec<StoredMessage>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id,thread_id FROM messages
             WHERE thread_id=?1 ORDER BY ts DESC, id DESC LIMIT ?2",
        )?;
        let mut rows = st
            .query_map(params![thread_id, limit.clamp(1, 1000)], |r| {
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
        rows.reverse();
        Ok(rows)
    }

    pub fn insert_message_as_bot(
        &self,
        m: &MessageEnvelope,
        direction: &str,
        status: &str,
        bot_id: &str,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO messages(id,conv_id,author_fp,body,ts,sig,direction,status,bot_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                m.id,
                m.conv_id,
                m.author_fp,
                m.body,
                m.ts,
                m.sig,
                direction,
                status,
                bot_id
            ],
        )?;
        Ok(())
    }

    pub fn list_messages(&self, conv_id: &str, limit: i64) -> Result<Vec<StoredMessage>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id,thread_id FROM messages
             WHERE conv_id=?1 ORDER BY ts DESC, id DESC LIMIT ?2",
        )?;
        let mut rows = st
            .query_map(params![conv_id, limit.clamp(1, 5000)], |r| {
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
        rows.reverse();
        Ok(rows)
    }

    pub fn hide_messages_local(&self, ids: &[String]) -> Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        let now = crate::identity::now_ms();
        let mut n = 0usize;
        for id in ids {
            let conv: Option<String> = tx
                .query_row(
                    "SELECT conv_id FROM messages WHERE id=?1",
                    params![id],
                    |r| r.get(0),
                )
                .ok();
            let Some(conv_id) = conv else { continue };
            tx.execute(
                "INSERT OR IGNORE INTO local_hidden(msg_id,conv_id,hidden_at) VALUES(?1,?2,?3)",
                params![id, conv_id, now],
            )?;
            tx.execute("DELETE FROM messages WHERE id=?1", params![id])?;
            n += 1;
        }
        tx.commit()?;
        Ok(n)
    }

    pub fn is_message_hidden(&self, msg_id: &str) -> bool {
        self.locked()
            .query_row(
                "SELECT 1 FROM local_hidden WHERE msg_id=?1",
                params![msg_id],
                |_| Ok(()),
            )
            .is_ok()
    }

    pub fn expired_message_ids(
        &self,
        cutoff_ms: i64,
        servers: bool,
        groups: bool,
        dms: bool,
        limit: i64,
    ) -> Result<Vec<String>> {
        if !(servers || groups || dms) {
            return Ok(Vec::new());
        }
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT m.id FROM messages m
             LEFT JOIN conversations c ON c.id = m.conv_id
             LEFT JOIN local_hidden h ON h.msg_id = m.id
             WHERE m.ts < ?1 AND h.msg_id IS NULL
               AND ((?2 = 1 AND c.kind = 'dm')
                 OR (?3 = 1 AND c.kind = 'group')
                 OR (?4 = 1 AND (c.id IS NULL OR c.kind NOT IN ('dm','group'))))
             ORDER BY m.ts ASC LIMIT ?5",
        )?;
        let rows = st
            .query_map(
                params![
                    cutoff_ms,
                    dms as i64,
                    groups as i64,
                    servers as i64,
                    limit.clamp(1, 100_000)
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn set_message_status(&self, msg_id: &str, status: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE messages SET status=?2 WHERE id=?1",
            params![msg_id, status],
        )?;
        Ok(())
    }

    /// Grava o recibo de UM membro e devolve as mensagens que ficaram lidas por
    /// TODOS os outros. Sem isso um `read` de um participante já pintava o
    /// duplo check azul para o grupo inteiro.
    pub fn record_read_receipt(
        &self,
        conv_id: &str,
        reader_fp: &str,
        up_to_ts: i64,
    ) -> Result<Vec<String>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id FROM messages
             WHERE conv_id=?1 AND direction='out'
               AND ts<=?2 AND status<>'failed'",
        )?;
        let ids = st
            .query_map(params![conv_id, up_to_ts], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(st);
        let now = crate::identity::now_ms();
        for id in &ids {
            conn.execute(
                "INSERT INTO read_receipts(msg_id,fp,read_at) VALUES(?1,?2,?3)
                 ON CONFLICT(msg_id,fp) DO UPDATE SET read_at=?3",
                params![id, reader_fp, now],
            )?;
        }
        Ok(ids)
    }

    /// Mensagens da conversa que já foram lidas por todos os membros esperados.
    pub fn messages_read_by_all(
        &self,
        conv_id: &str,
        up_to_ts: i64,
        expected: &[String],
    ) -> Result<Vec<String>> {
        if expected.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT m.id,
                    (SELECT COUNT(DISTINCT r.fp) FROM read_receipts r
                      WHERE r.msg_id = m.id) AS n
             FROM messages m
             WHERE m.conv_id=?1 AND m.direction='out'
               AND m.ts<=?2 AND m.status<>'failed'",
        )?;
        let pares = st
            .query_map(params![conv_id, up_to_ts], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(st);
        let faltando = expected.len() as i64;
        Ok(pares
            .into_iter()
            .filter(|(_, n)| *n >= faltando)
            .map(|(id, _)| id)
            .collect())
    }

    /// Quem visualizou cada mensagem pedida (fp → instante mais recente).
    pub fn receipts_for(&self, msg_ids: &[String]) -> Result<Vec<(String, String, i64)>> {
        if msg_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.locked();
        let mut out = Vec::new();
        // Em lotes: o SQLite tem teto de parâmetros por consulta.
        for bloco in msg_ids.chunks(400) {
            let marca = std::iter::repeat("?")
                .take(bloco.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql =
                format!("SELECT msg_id, fp, read_at FROM read_receipts WHERE msg_id IN ({marca})");
            let mut st = conn.prepare(&sql)?;
            let rows = st.query_map(rusqlite::params_from_iter(bloco.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                out.push(row?);
            }
        }
        Ok(out)
    }

    pub fn list_messages_window(
        &self,
        conv_id: &str,
        before_ts: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredMessage>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id,thread_id FROM messages
             WHERE conv_id=?1 AND (?2 IS NULL OR ts < ?2)
             ORDER BY ts DESC, id DESC LIMIT ?3",
        )?;
        let rows = st
            .query_map(params![conv_id, before_ts, limit.clamp(1, 1000)], |r| {
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
        let mut rows = rows;
        rows.reverse();
        Ok(rows)
    }

    pub fn count_messages(&self) -> Result<i64> {
        let conn = self.locked();
        Ok(conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?)
    }

    pub fn enqueue_outbox(&self, msg_id: &str, peer_fp: &str) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO outbox(msg_id,peer_fp,attempts,next_try,kind) VALUES(?1,?2,0,0,'')",
            params![msg_id, peer_fp],
        )?;
        Ok(())
    }

    pub fn enqueue_outbox_kind(&self, msg_id: &str, peer_fp: &str, kind: &str) -> Result<()> {
        self.locked().execute(
            "INSERT INTO outbox(msg_id,peer_fp,attempts,next_try,kind) VALUES(?1,?2,0,0,?3)
             ON CONFLICT(msg_id) DO UPDATE SET peer_fp=excluded.peer_fp, kind=excluded.kind",
            params![msg_id, peer_fp, kind],
        )?;
        Ok(())
    }

    pub fn outbox_kind(&self, msg_id: &str) -> String {
        self.locked()
            .query_row(
                "SELECT kind FROM outbox WHERE msg_id=?1",
                params![msg_id],
                |r| r.get::<_, String>(0),
            )
            .unwrap_or_default()
    }

    pub fn dequeue_outbox(&self, msg_id: &str) -> Result<()> {
        self.locked()
            .execute("DELETE FROM outbox WHERE msg_id=?1", params![msg_id])?;
        Ok(())
    }

    pub fn requeue_outbox(&self, msg_id: &str, peer_fp: &str) -> Result<()> {
        self.locked().execute(
            "INSERT INTO outbox(msg_id,peer_fp,attempts,next_try,kind) VALUES(?1,?2,0,0,'')
             ON CONFLICT(msg_id) DO UPDATE SET peer_fp=excluded.peer_fp, attempts=0, next_try=0",
            params![msg_id, peer_fp],
        )?;
        Ok(())
    }

    pub fn pending_outbox(&self, peer_fp: &str) -> Result<Vec<String>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT msg_id FROM outbox
             WHERE peer_fp=?1 AND next_try <= ?2 AND attempts < ?3
             ORDER BY rowid",
        )?;
        let rows = st
            .query_map(
                params![
                    peer_fp,
                    crate::identity::now_ms(),
                    Self::OUTBOX_MAX_ATTEMPTS
                ],
                |r| r.get::<_, String>(0),
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn bump_outbox(&self, msg_id: &str) -> Result<()> {
        let attempts: i64 = self
            .locked()
            .query_row(
                "SELECT attempts FROM outbox WHERE msg_id=?1",
                params![msg_id],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let passo = (15_000i64).saturating_mul(1i64 << attempts.min(6));
        let espera = passo.min(8 * 60 * 1000);
        self.locked().execute(
            "UPDATE outbox SET attempts=attempts+1, next_try=?2 WHERE msg_id=?1",
            params![msg_id, crate::identity::now_ms() + espera],
        )?;
        Ok(())
    }

    pub fn give_up_outbox(&self, peer_fp: &str) -> Result<Vec<String>> {
        let ids = {
            let conn = self.locked();
            let mut st = conn.prepare(
                "SELECT msg_id FROM outbox
                 WHERE peer_fp=?1 AND attempts >= ?2 ORDER BY rowid",
            )?;
            let ids = st
                .query_map(params![peer_fp, Self::OUTBOX_MAX_ATTEMPTS], |r| {
                    r.get::<_, String>(0)
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            drop(st);
            ids
        };
        for id in &ids {
            self.set_message_status(id, "failed")?;
            self.dequeue_outbox(id)?;
        }
        Ok(ids)
    }

    pub fn outbox_len_for_peer(&self, peer_fp: &str) -> usize {
        self.locked()
            .query_row(
                "SELECT COUNT(*) FROM outbox WHERE peer_fp=?1",
                params![peer_fp],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n as usize)
            .unwrap_or(0)
    }

    /// Reenfileira mensagens que desistiram ("failed") quando o peer volta.
    ///
    /// POR QUE: `give_up_outbox` marcava `failed` e removia do outbox; sem isto
    /// a mensagem ficava failed para sempre e só saía por "reenviar" manual.
    /// O retry automático ao reconectar é o que o usuário espera de mensageiro.
    pub fn requeue_failed_for_peer(&self, peer_fp: &str) -> Result<usize> {
        let ids = {
            let conn = self.locked();
            let mut st = conn.prepare(
                "SELECT m.id FROM messages m
                   JOIN conversations c ON c.id = m.conv_id
                  WHERE m.direction='out' AND m.status='failed' AND c.kind='dm' AND c.peer_fp=?1
                  ORDER BY m.ts ASC LIMIT 200",
            )?;
            let ids = st
                .query_map(params![peer_fp], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids
        };
        for id in &ids {
            self.requeue_outbox(id, peer_fp)?;
            self.set_message_status(id, "pending")?;
        }
        Ok(ids.len())
    }

    /// Mensagens presas em `sending` cujo outbox parou de tentar (peer offline).
    /// A UI precisa dizer a verdade: "pendente, entrega ao reconectar".
    pub fn revert_stuck_outbox_sending(&self, older_than_ts: i64) -> Result<Vec<String>> {
        let ids = {
            let conn = self.locked();
            let mut st = conn.prepare(
                "SELECT m.id FROM messages m
                   JOIN outbox o ON o.msg_id = m.id
                  WHERE m.direction='out' AND m.status='sending' AND m.ts < ?1
                  LIMIT 500",
            )?;
            let ids = st
                .query_map(params![older_than_ts], |r| r.get::<_, String>(0))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            ids
        };
        for id in &ids {
            self.set_message_status(id, "pending")?;
        }
        Ok(ids)
    }

    /// Peers com mensagem no outbox, inclusive offline. O tick de flush usava
    /// só `online_peer_fps()`, então o outbox de um amigo sem rota nunca era
    /// inspecionado nem avisado.
    pub fn outbox_peers(&self) -> Result<Vec<String>> {
        let conn = self.locked();
        let mut st = conn.prepare("SELECT DISTINCT peer_fp FROM outbox")?;
        let rows = st
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(DistorrentError::from)?;
        Ok(rows)
    }

    pub fn message_by_id(&self, msg_id: &str) -> Result<Option<StoredMessage>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id,thread_id FROM messages WHERE id=?1",
        )?;
        st.query_row(params![msg_id], |r| {
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
        })
        .optional()
        .map_err(Into::into)
    }

    pub fn delete_messages_by_conv(&self, conv_id: &str) -> Result<()> {
        self.locked()
            .execute("DELETE FROM messages WHERE conv_id=?1", params![conv_id])?;
        Ok(())
    }

    pub fn delete_message_by_id(&self, msg_id: &str) -> Result<usize> {
        Ok(self
            .locked()
            .execute("DELETE FROM messages WHERE id=?1", params![msg_id])?)
    }

    pub fn message_by_id_raw(&self, msg_id: &str) -> Result<Option<StoredMessage>> {
        Ok(self.message_by_id(msg_id)?)
    }

    /// Ids das N mensagens mais recentes de um canal (para `/clear`).
    pub fn recent_message_ids(&self, conv_id: &str, limit: i64) -> Result<Vec<String>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id FROM messages WHERE conv_id=?1 ORDER BY ts DESC, id DESC LIMIT ?2",
        )?;
        let rows = st
            .query_map(params![conv_id, limit.clamp(1, 100)], |r| r.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}
