//! Camada social (paridade Discord) — schema + operações.
//!
//! Tudo aqui é estado LOCAL persistido em SQLite e sincronizado por frames
//! assinados dentro da sessão AEAD (ver `protocol::SecureFrame`). Nenhuma
//! operação depende da UI: o motor valida autor/permissão antes de aplicar.
//!
//! Grupos de features:
//!  - mensagem: reações, respostas, edição, exclusão, encaminhamento, pins
//!  - leitura: cursor de leitura, menções, não-lidas
//!  - pessoas: presença estendida, status/display name/bio/avatar/banner
//!  - servidor: threads, fóruns, bans, timeouts, slowmode, emojis, enquetes,
//!    eventos agendados

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

// ================================ SCHEMA ================================

/// Cria as tabelas da camada social. Idempotente — pode rodar em todo boot.
pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS msg_reactions (
            msg_id TEXT NOT NULL,
            conv_id TEXT NOT NULL,
            emoji TEXT NOT NULL,
            reactor_fp TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (msg_id, emoji, reactor_fp)
         );
         CREATE INDEX IF NOT EXISTS idx_react_conv ON msg_reactions(conv_id);

         CREATE TABLE IF NOT EXISTS msg_meta (
            msg_id TEXT PRIMARY KEY,
            conv_id TEXT NOT NULL,
            reply_to TEXT NOT NULL DEFAULT '',
            forwarded_from TEXT NOT NULL DEFAULT '',
            edited_body TEXT NOT NULL DEFAULT '',
            edited_at INTEGER NOT NULL DEFAULT 0,
            deleted INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            pinned_at INTEGER NOT NULL DEFAULT 0,
            pinned_by TEXT NOT NULL DEFAULT '',
            mentioned INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_msgmeta_conv ON msg_meta(conv_id);
         CREATE INDEX IF NOT EXISTS idx_msgmeta_pinned ON msg_meta(conv_id, pinned);

         CREATE TABLE IF NOT EXISTS read_cursors (
            conv_id TEXT PRIMARY KEY,
            last_read_ts INTEGER NOT NULL DEFAULT 0,
            last_read_id TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0
         );

         CREATE TABLE IF NOT EXISTS presence (
            fp TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'offline',
            custom TEXT NOT NULL DEFAULT '',
            custom_emoji TEXT NOT NULL DEFAULT '',
            since INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
         );

         CREATE TABLE IF NOT EXISTS profiles (
            fp TEXT PRIMARY KEY,
            display_name TEXT NOT NULL DEFAULT '',
            about TEXT NOT NULL DEFAULT '',
            avatar_b64 TEXT NOT NULL DEFAULT '',
            banner_b64 TEXT NOT NULL DEFAULT '',
            accent TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0
         );

         CREATE TABLE IF NOT EXISTS server_nicknames (
            community_id TEXT NOT NULL,
            fp TEXT NOT NULL,
            nickname TEXT NOT NULL,
            PRIMARY KEY (community_id, fp)
         );

         CREATE TABLE IF NOT EXISTS threads (
            id TEXT PRIMARY KEY,
            community_id TEXT NOT NULL,
            parent_channel TEXT NOT NULL,
            name TEXT NOT NULL,
            author_fp TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'thread',
            tags TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(community_id, parent_channel);

         CREATE TABLE IF NOT EXISTS bans (
            community_id TEXT NOT NULL,
            fp TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            actor_fp TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL DEFAULT 0,
            until_ms INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (community_id, fp)
         );

         CREATE TABLE IF NOT EXISTS timeouts (
            community_id TEXT NOT NULL,
            fp TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '',
            until_ms INTEGER NOT NULL DEFAULT 0,
            actor_fp TEXT NOT NULL DEFAULT '',
            PRIMARY KEY (community_id, fp)
         );

         CREATE TABLE IF NOT EXISTS channel_cfg (
            channel_id TEXT PRIMARY KEY,
            slowmode_secs INTEGER NOT NULL DEFAULT 0,
            last_msg_at INTEGER NOT NULL DEFAULT 0,
            last_msg_fp TEXT NOT NULL DEFAULT '',
            nsfw INTEGER NOT NULL DEFAULT 0,
            topic_locked INTEGER NOT NULL DEFAULT 0
         );

         CREATE TABLE IF NOT EXISTS polls (
            id TEXT PRIMARY KEY,
            community_id TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            question TEXT NOT NULL,
            options TEXT NOT NULL,
            multi INTEGER NOT NULL DEFAULT 0,
            author_fp TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            ends_at INTEGER NOT NULL DEFAULT 0,
            closed INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_polls_channel ON polls(community_id, channel_id);

         CREATE TABLE IF NOT EXISTS poll_votes (
            poll_id TEXT NOT NULL,
            voter_fp TEXT NOT NULL,
            option_idx INTEGER NOT NULL,
            voted_at INTEGER NOT NULL,
            PRIMARY KEY (poll_id, voter_fp, option_idx)
         );

         CREATE TABLE IF NOT EXISTS scheduled_events (
            id TEXT PRIMARY KEY,
            community_id TEXT NOT NULL,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            location TEXT NOT NULL DEFAULT '',
            starts_at INTEGER NOT NULL,
            ends_at INTEGER NOT NULL DEFAULT 0,
            channel_id TEXT NOT NULL DEFAULT '',
            entity_fp TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'scheduled',
            interested TEXT NOT NULL DEFAULT '[]'
         );
         CREATE INDEX IF NOT EXISTS idx_events_comm ON scheduled_events(community_id);

         CREATE TABLE IF NOT EXISTS custom_emojis (
            id TEXT PRIMARY KEY,
            community_id TEXT NOT NULL,
            name TEXT NOT NULL,
            char TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_emoji_comm ON custom_emojis(community_id);

         CREATE TABLE IF NOT EXISTS bookmarks (
            conv_id TEXT NOT NULL,
            name TEXT NOT NULL,
            payload TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (conv_id, name)
         );",
    )
}

// ================================ TIPOS ================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReactionRow {
    pub msg_id: String,
    pub conv_id: String,
    pub emoji: String,
    pub reactor_fp: String,
    pub created_at: i64,
}

/// Reactions agregadas por mensagem+emoji (contagem + lista de quem reagiu).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReactionSummary {
    pub msg_id: String,
    pub emoji: String,
    pub count: i64,
    pub reactors: Vec<String>,
    pub mine: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct MsgMetaView {
    pub msg_id: String,
    pub conv_id: String,
    pub reply_to: String,
    pub forwarded_from: String,
    pub edited_body: String,
    pub edited_at: i64,
    pub deleted: bool,
    pub pinned: bool,
    pub pinned_by: String,
    pub mentioned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct PresenceView {
    pub fp: String,
    /// "online" | "idle" | "dnd" | "invisible" | "offline"
    pub status: String,
    pub custom: String,
    pub custom_emoji: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ProfileView {
    pub fp: String,
    pub display_name: String,
    pub about: String,
    pub avatar_b64: String,
    pub banner_b64: String,
    pub accent: String,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ThreadRow {
    pub id: String,
    pub community_id: String,
    pub parent_channel: String,
    pub name: String,
    pub author_fp: String,
    pub created_at: i64,
    pub archived: bool,
    /// "thread" (a partir de mensagem) | "forum" (post de fórum)
    pub kind: String,
    pub tags: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BanRow {
    pub fp: String,
    pub reason: String,
    pub actor_fp: String,
    pub created_at: i64,
    /// 0 = permanente
    pub until_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PollRow {
    pub id: String,
    pub community_id: String,
    pub channel_id: String,
    pub question: String,
    pub options: Vec<String>,
    pub multi: bool,
    pub author_fp: String,
    pub created_at: i64,
    pub ends_at: i64,
    pub closed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventRow {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub description: String,
    pub location: String,
    pub starts_at: i64,
    pub ends_at: i64,
    pub channel_id: String,
    pub entity_fp: String,
    /// "scheduled" | "active" | "completed" | "canceled"
    pub status: String,
    pub interested: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EmojiRow {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub char: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReadCursor {
    pub conv_id: String,
    pub last_read_ts: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub conv_id: String,
    pub author_fp: String,
    pub body: String,
    pub ts: i64,
    pub direction: String,
    pub community_id: String,
    pub channel_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SearchQuery {
    pub text: String,
    /// fingerprint do autor (filtro `from:`)
    pub from: String,
    /// conversa específica (filtro `in:`)
    pub conv: String,
    /// "link" | "file" | "mention" | "poll" — filtro `has:`
    pub has: String,
    /// ts máximo (filtro `before:`)
    pub before: i64,
    pub limit: i64,
}

impl crate::storage::Store {
    // ======================= MENSAGEM: REAÇÕES =======================

    pub fn reaction_toggle(
        &self,
        msg_id: &str,
        conv_id: &str,
        emoji: &str,
        reactor_fp: &str,
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
                "INSERT OR REPLACE INTO msg_reactions (msg_id, conv_id, emoji, reactor_fp, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![msg_id, conv_id, emoji, reactor_fp, crate::identity::now_ms()],
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
                "SELECT emoji, reactor_fp FROM msg_reactions WHERE msg_id=?1 ORDER BY emoji ASC, created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![msg_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut out: Vec<ReactionSummary> = Vec::new();
        for r in rows {
            let (emoji, reactor) = r.map_err(|e| e.to_string())?;
            if let Some(last) = out.last_mut() {
                if last.emoji == emoji {
                    last.count += 1;
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
            });
        }
        Ok(out)
    }

    /// Reações de várias mensagens de uma vez.
    ///
    /// Uma consulta só, com `IN`: a tela lista ~100 mensagens de uma vez e a
    /// versão em laço fazia 100 travessias do banco por renderização de tela.
    /// Os reatores vêm desagregados do emoji porque o agrupamento é feito aqui.
    pub fn reactions_for_msgs(&self, msg_ids: &[String]) -> Result<Vec<ReactionSummary>, String> {
        if msg_ids.is_empty() {
            return Ok(Vec::new());
        }
        if msg_ids.len() > 1000 {
            return Err("lote de reações grande demais".into());
        }
        let conn = self.locked();
        // 9 parâmetros por linha: rusqlite não tem placeholder de tamanho
        // variável, então o `IN` é montado com o total conhecido. Os ids são
        // VINCULADOS (nunca concatenados no SQL), então isso não é injeção.
        let placeholders = vec!["?"; msg_ids.len()].join(",");
        let sql = format!(
            "SELECT msg_id, emoji, reactor_fp FROM msg_reactions
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
                ))
            })
            .map_err(|e| e.to_string())?;

        let mut out: Vec<ReactionSummary> = Vec::new();
        for r in rows {
            let (msg_id, emoji, reactor) = r.map_err(|e| e.to_string())?;
            match out.last_mut() {
                Some(last) if last.msg_id == msg_id && last.emoji == emoji => {
                    last.count += 1;
                    last.reactors.push(reactor);
                }
                _ => out.push(ReactionSummary {
                    msg_id,
                    emoji,
                    count: 1,
                    reactors: vec![reactor],
                    mine: false,
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

    // ======================= MENSAGEM: META =======================

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

    /// Grava referência de resposta (idempotente: repetir não sobrescreve).
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

    /// Edição: guarda o novo corpo + timestamp. Chamado só pelo motor depois de
    /// validar `author_fp == peer`.
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

    /// Exclusão lógica: o corpo some mas a malha do histórico sobrevive
    /// (mesma UX do Discord: "Esta mensagem foi apagada").
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

    /// Corpo efetivo de uma mensagem: editado > original.
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

    pub fn pins_list(&self, conv_id: &str) -> Result<Vec<MsgMetaView>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT msg_id, conv_id, reply_to, forwarded_from, edited_body, edited_at,
                        deleted, pinned, pinned_by, mentioned
                 FROM msg_meta WHERE conv_id=?1 AND pinned=1 ORDER BY pinned_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![conv_id], |r| {
                Ok(MsgMetaView {
                    msg_id: r.get(0)?,
                    conv_id: r.get(1)?,
                    reply_to: r.get(2)?,
                    forwarded_from: r.get(3)?,
                    edited_body: r.get(4)?,
                    edited_at: r.get(5)?,
                    deleted: r.get::<_, i64>(6)? != 0,
                    pinned: true,
                    pinned_by: r.get(8)?,
                    mentioned: r.get::<_, i64>(9)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    // ======================= LEITURA / NÃO-LIDAS =======================

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
        let conn = self.locked();
        conn.execute(
            "INSERT INTO read_cursors (conv_id, last_read_ts, updated_at) VALUES (?1,?2,?3)
             ON CONFLICT(conv_id) DO UPDATE SET
               last_read_ts = MAX(read_cursors.last_read_ts, excluded.last_read_ts),
               updated_at = excluded.updated_at",
            params![conv_id, ts, crate::identity::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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

    /// Quantas mensagens não lidas me mencionam — o badge da barra de menções.
    ///
    /// Só conta o que o AUTOR NÃO escreveu (mencionar a si mesmo não notifica)
    /// e o que chegou depois do cursor de leitura. A conversa é resolvida pelo
    /// `conv_id` da própria mensagem, que é o mesmo campo do cursor.
    pub fn unread_mentions(&self, fp: &str) -> Result<i64, String> {
        if fp.is_empty() {
            return Ok(0);
        }
        let conn = self.locked();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM msg_meta m
                   JOIN messages g ON g.id = m.msg_id
              LEFT JOIN read_cursors rc ON rc.conv_id = m.conv_id
                  WHERE m.mentioned = 1
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

    // ======================= PRESENÇA =======================

    pub fn presence_set(
        &self,
        fp: &str,
        status: &str,
        custom: &str,
        custom_emoji: &str,
    ) -> Result<(), String> {
        let now = crate::identity::now_ms();
        let conn = self.locked();
        conn.execute(
            "INSERT INTO presence (fp, status, custom, custom_emoji, since, updated_at)
             VALUES (?1,?2,?3,?4,?5,?5)
             ON CONFLICT(fp) DO UPDATE SET status=excluded.status, custom=excluded.custom,
               custom_emoji=excluded.custom_emoji, since=excluded.since, updated_at=excluded.updated_at",
            params![fp, status, custom, custom_emoji, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn presence_offline(&self, fp: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO presence (fp, status, updated_at) VALUES (?1,'offline',?2)
             ON CONFLICT(fp) DO UPDATE SET status='offline', updated_at=excluded.updated_at",
            params![fp, crate::identity::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn presence_get(&self, fp: &str) -> Result<PresenceView, String> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT fp, status, custom, custom_emoji, updated_at FROM presence WHERE fp=?1",
                params![fp],
                |r| {
                    Ok(PresenceView {
                        fp: r.get(0)?,
                        status: r.get(1)?,
                        custom: r.get(2)?,
                        custom_emoji: r.get(3)?,
                        updated_at: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(r.unwrap_or(PresenceView {
            fp: fp.to_string(),
            status: "offline".into(),
            custom: String::new(),
            custom_emoji: String::new(),
            updated_at: 0,
        }))
    }

    pub fn presence_list(&self) -> Result<Vec<PresenceView>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT fp, status, custom, custom_emoji, updated_at FROM presence ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PresenceView {
                    fp: r.get(0)?,
                    status: r.get(1)?,
                    custom: r.get(2)?,
                    custom_emoji: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    // ======================= PERFIL =======================

    pub fn profile_set(
        &self,
        fp: &str,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
    ) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO profiles (fp, display_name, about, avatar_b64, banner_b64, accent, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(fp) DO UPDATE SET display_name=excluded.display_name, about=excluded.about,
               avatar_b64=CASE WHEN excluded.avatar_b64='' THEN profiles.avatar_b64 ELSE excluded.avatar_b64 END,
               banner_b64=CASE WHEN excluded.banner_b64='' THEN profiles.banner_b64 ELSE excluded.banner_b64 END,
               accent=excluded.accent, updated_at=excluded.updated_at",
            params![
                fp,
                display_name,
                about,
                avatar_b64,
                banner_b64,
                accent,
                crate::identity::now_ms()
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn profile_get(&self, fp: &str) -> Result<ProfileView, String> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT fp, display_name, about, avatar_b64, banner_b64, accent, updated_at
                   FROM profiles WHERE fp=?1",
                params![fp],
                |r| {
                    Ok(ProfileView {
                        fp: r.get(0)?,
                        display_name: r.get(1)?,
                        about: r.get(2)?,
                        avatar_b64: r.get(3)?,
                        banner_b64: r.get(4)?,
                        accent: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(r.unwrap_or(ProfileView {
            fp: fp.to_string(),
            ..Default::default()
        }))
    }

    pub fn profile_list(&self) -> Result<Vec<ProfileView>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT fp, display_name, about, avatar_b64, banner_b64, accent, updated_at
                   FROM profiles ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProfileView {
                    fp: r.get(0)?,
                    display_name: r.get(1)?,
                    about: r.get(2)?,
                    avatar_b64: r.get(3)?,
                    banner_b64: r.get(4)?,
                    accent: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn nickname_set(&self, community_id: &str, fp: &str, nick: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO server_nicknames (community_id, fp, nickname) VALUES (?1,?2,?3)
             ON CONFLICT(community_id, fp) DO UPDATE SET nickname=excluded.nickname",
            params![community_id, fp, nick],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn nickname_get(&self, community_id: &str, fp: &str) -> Result<String, String> {
        let conn = self.locked();
        Ok(conn
            .query_row(
                "SELECT nickname FROM server_nicknames WHERE community_id=?1 AND fp=?2",
                params![community_id, fp],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default())
    }

    // ======================= THREADS =======================

    pub fn thread_upsert(&self, t: &ThreadRow) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO threads (id, community_id, parent_channel, name, author_fp, created_at, archived, kind, tags)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, archived=excluded.archived",
            params![
                t.id,
                t.community_id,
                t.parent_channel,
                t.name,
                t.author_fp,
                t.created_at,
                t.archived as i64,
                t.kind,
                t.tags
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn thread_map(r: &rusqlite::Row) -> rusqlite::Result<ThreadRow> {
        Ok(ThreadRow {
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
    }

    pub fn threads_list(&self, community_id: &str, parent: &str) -> Result<Vec<ThreadRow>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT id, community_id, parent_channel, name, author_fp, created_at, archived, kind, tags
                   FROM threads WHERE community_id=?1 AND parent_channel=?2 ORDER BY created_at ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![community_id, parent], |r| Self::thread_map(r))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn thread_get(&self, id: &str) -> Result<Option<ThreadRow>, String> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT id, community_id, parent_channel, name, author_fp, created_at, archived, kind, tags
                   FROM threads WHERE id=?1",
                params![id],
                |r| Self::thread_map(r),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(r)
    }

    pub fn thread_archive(&self, id: &str, archived: bool) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "UPDATE threads SET archived=?2 WHERE id=?1",
            params![id, archived as i64],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // ======================= MODERAÇÃO =======================

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

    /// Timeout ativo? (0 = sem timeout; expirado é removido na consulta)
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

    // ======================= SLOWMODE / CFG DE CANAL =======================

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

    /// Registro de "última mensagem por fingerprint" — base do slowmode.
    /// Retorna quanto falta (ms) para o autor poder falar de novo; 0 = liberto.
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

    // ======================= ENQUETES =======================

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

    /// Registra um voto.
    ///
    /// O `multi` vem da própria enquete (nada de confiar no chamante): em
    /// enquete simples o voto SUBSTITUI o anterior, em múltipla acumula. A
    /// versão anterior apagava o voto anterior sempre, o que tornava a opção
    /// "múltipla escolha" impossível de usar — a segunda escolha apagava a
    /// primeira e o total nunca passava de 1 por pessoa.
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

        // a opção precisa existir: um índice fora da faixa viraria um voto em
        // uma opção invisível na contagem, inflating o total sem aparecer na UI.
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
            // múltipla: clicar de novo na MESMA opção desmarca (toggle)
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

    /// Contagem por opção + total de votos (não de voters distintos).
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

    // ======================= EVENTOS AGENDADOS =======================

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

    // ======================= EMOJIS =======================

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

    // ======================= BUSCA =======================

    /// Busca textual com filtros no estilo Discord: `from:`, `has:`, `before:`.
    /// O texto puro é escaneado no Rust (nunca montado como SQL).
    pub fn message_search(&self, q: &SearchQuery) -> Result<Vec<SearchHit>, String> {
        let needle = q.text.trim().to_lowercase();
        let limit = if q.limit <= 0 { 50 } else { q.limit.min(500) };
        let conn = self.locked();
        // `conversations` não tem coluna de dono: a comunidade de uma mensagem
        // de canal vem do próprio canal (`channels.community_id`). `msg_meta` é
        // LEFT e opcional, então "não deletada" precisa aceitar NULL.
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

    /// Janela de mensagens ao redor de um timestamp (pular para data).
    pub fn messages_around(
        &self,
        conv_id: &str,
        ts: i64,
        limit: i64,
    ) -> Result<Vec<crate::storage::StoredMessage>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT id,conv_id,author_fp,body,ts,sig,direction,status,bot_id FROM messages WHERE conv_id=?1 ORDER BY ts ASC")
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
            .take(limit as usize / 2)
            .cloned()
            .collect();
        let mut before: Vec<_> = before.into_iter().rev().collect();
        let after: Vec<_> = all
            .into_iter()
            .filter(|m| m.ts >= ts)
            .take(limit as usize / 2)
            .collect();
        before.extend(after);
        Ok(before)
    }

    // ======================= BOOKMARKS =======================

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

    /// Apaga TODO o estado social de uma conversa (usado ao deletar conversa).
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
