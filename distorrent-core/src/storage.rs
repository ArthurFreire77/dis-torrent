use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::identity::Identity;
use crate::protocol::MessageEnvelope;
use crate::DistorrentError;
use crate::Result;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Conversation {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub peer_fp: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct StoredMessage {
    pub id: String,
    pub conv_id: String,
    pub author_fp: String,
    pub body: String,
    pub ts: i64,
    pub sig: String,
    pub direction: String,
    pub status: String,
    #[serde(default)]
    pub bot_id: String,
    #[serde(default)]
    pub thread_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PeerRecord {
    pub fp: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub addr: Option<String>,
    pub last_seen: i64,
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChannelMetaRow {
    pub id: String,
    pub name: String,
    pub topic: String,
    pub category: String,
    pub kind: String,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct RoleRow {
    pub id: String,
    pub community_id: String,
    pub name: String,
    pub color: String,
    pub permissions: i64,
    pub hoist: bool,
    pub mentionable: bool,
    pub position: i64,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BotRow {
    pub id: String,
    #[serde(rename = "community_id")]
    pub community_id: String,
    pub name: String,
    pub discriminator: String,
    pub avatar: String,
    #[serde(rename = "roleId")]
    pub role_id: Option<String>,
    pub token: String,
    pub online: bool,
    #[serde(rename = "ownerFp")]
    pub owner_fp: String,
    #[serde(rename = "createdAt")]
    pub created_at: i64,
    #[serde(default)]
    pub config: String,
}

#[derive(Debug, Clone, Default)]
pub struct BotPatch {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub role_id: Option<Option<String>>,
    pub online: Option<bool>,
    pub config: Option<String>,
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    if ![
        "channels",
        "roles",
        "bots",
        "channels",
        "communities",
        "members",
        "kv",
        "peers",
        "conversations",
        "messages",
        "friends",
        "group_members",
        "calls",
        "files",
        "server_rules",
        "audit_log",
        "reputation",
        "reports",
        "voice_states",
        "outbox",
        "local_hidden",
    ]
    .contains(&table)
    {
        return false;
    }
    let Ok(mut st) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    let cols: Vec<String> = st
        .query_map([], |r| r.get::<_, String>(1))
        .map(|rows| rows.filter_map(|c| c.ok()).collect())
        .unwrap_or_default();
    cols.iter().any(|c| c == column)
}

fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("PRAGMA foreign_keys=OFF;")?;
    conn.execute_batch(SCHEMA_V1)?;
    let version: String = conn
        .query_row(
            "SELECT COALESCE((SELECT value FROM kv WHERE key='schema_version'), '0')",
            [],
            |r| r.get(0),
        )
        .unwrap_or_else(|_| "0".into());
    let version: u32 = version.trim().parse().unwrap_or(0);
    if version < 2 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS messages_v2 (
               id TEXT PRIMARY KEY,
               conv_id TEXT NOT NULL,
               author_fp TEXT NOT NULL,
               body TEXT NOT NULL,
               ts INTEGER NOT NULL,
               sig TEXT NOT NULL,
               direction TEXT NOT NULL,
               status TEXT NOT NULL
             );
             INSERT OR IGNORE INTO messages_v2 SELECT id,conv_id,author_fp,body,ts,sig,direction,status FROM messages;
             DROP TABLE messages;
             ALTER TABLE messages_v2 RENAME TO messages;
             CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, ts);",
        )?;
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','2') ON CONFLICT(key) DO UPDATE SET value='2'",
            [],
        )?;
    }
    if version < 3 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS group_members (
               conv_id TEXT NOT NULL,
               fp TEXT NOT NULL,
               nickname TEXT NOT NULL DEFAULT '',
               added_at INTEGER NOT NULL,
               PRIMARY KEY(conv_id, fp)
             );
             CREATE TABLE IF NOT EXISTS calls (
               call_id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               conv_id TEXT NOT NULL,
               host_fp TEXT NOT NULL,
               created_at INTEGER NOT NULL,
               ended_at INTEGER
             );
             CREATE TABLE IF NOT EXISTS call_participants (
               call_id TEXT NOT NULL,
               fp TEXT NOT NULL,
               joined_at INTEGER NOT NULL,
               PRIMARY KEY(call_id, fp)
             );
             CREATE TABLE IF NOT EXISTS files (
               file_id TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               size INTEGER NOT NULL,
               chunks INTEGER NOT NULL,
               hash TEXT NOT NULL,
               owner_fp TEXT NOT NULL,
               created_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS voice_states (
               community_id TEXT NOT NULL,
               channel_id TEXT NOT NULL,
               fp TEXT NOT NULL,
               muted INTEGER NOT NULL DEFAULT 0,
               deafened INTEGER NOT NULL DEFAULT 0,
               speaking INTEGER NOT NULL DEFAULT 0,
               joined_at INTEGER NOT NULL,
               PRIMARY KEY(community_id, channel_id, fp)
             );",
        )?;
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','3') ON CONFLICT(key) DO UPDATE SET value='3'",
            [],
        )?;
    }
    if version < 4 {
        if !column_exists(conn, "channels", "topic") {
            conn.execute_batch("ALTER TABLE channels ADD COLUMN topic TEXT NOT NULL DEFAULT '';")?;
        }
        if !column_exists(conn, "channels", "category") {
            conn.execute_batch(
                "ALTER TABLE channels ADD COLUMN category TEXT NOT NULL DEFAULT 'CANAIS DE TEXTO';",
            )?;
        }
        if !column_exists(conn, "channels", "kind") {
            conn.execute_batch(
                "ALTER TABLE channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';",
            )?;
        }
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, community_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#949ba4', permissions INTEGER NOT NULL DEFAULT 96, hoist INTEGER NOT NULL DEFAULT 0, mentionable INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS member_roles (community_id TEXT NOT NULL, fp TEXT NOT NULL, role_id TEXT NOT NULL, PRIMARY KEY(community_id, fp, role_id));
             CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, community_id TEXT NOT NULL, name TEXT NOT NULL, discriminator TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '🤖', role_id TEXT, token TEXT NOT NULL, online INTEGER NOT NULL DEFAULT 1, owner_fp TEXT NOT NULL, created_at INTEGER NOT NULL);",
        )?;
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','4') ON CONFLICT(key) DO UPDATE SET value='4'",
            [],
        )?;
    }
    if version < 5 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS server_rules (
               community_id TEXT PRIMARY KEY,
               spam_level TEXT NOT NULL DEFAULT 'medium',
               banned_words TEXT NOT NULL DEFAULT '[]',
               blocked_domains TEXT NOT NULL DEFAULT '[]',
               moderators TEXT NOT NULL DEFAULT '[]',
               shadow_banned TEXT NOT NULL DEFAULT '[]',
               updated_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS audit_log (
               id TEXT PRIMARY KEY,
               community_id TEXT NOT NULL,
               actor_fp TEXT NOT NULL,
               action TEXT NOT NULL,
               target_fp TEXT NOT NULL DEFAULT '',
               reason TEXT NOT NULL DEFAULT '',
               created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_audit_community ON audit_log(community_id, created_at);
             CREATE TABLE IF NOT EXISTS reputation (
               fp TEXT PRIMARY KEY,
               trust TEXT NOT NULL DEFAULT 'new',
               score INTEGER NOT NULL DEFAULT 0,
               reports INTEGER NOT NULL DEFAULT 0,
               updated_at INTEGER NOT NULL DEFAULT 0,
               muted_until INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS reports (
               id TEXT PRIMARY KEY,
               reporter_fp TEXT NOT NULL,
               target_fp TEXT NOT NULL,
               community_id TEXT NOT NULL DEFAULT '',
               reason TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'open',
               created_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_reports_target ON reports(target_fp, status);",
        )?;
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','5') ON CONFLICT(key) DO UPDATE SET value='5'",
            [],
        )?;
    }
    if version < 6 {
        if !column_exists(conn, "communities", "description") {
            conn.execute_batch(
                "ALTER TABLE communities ADD COLUMN description TEXT NOT NULL DEFAULT '';",
            )?;
        }
        if !column_exists(conn, "communities", "category") {
            conn.execute_batch(
                "ALTER TABLE communities ADD COLUMN category TEXT NOT NULL DEFAULT '';",
            )?;
        }
        if !column_exists(conn, "communities", "icon") {
            conn.execute_batch(
                "ALTER TABLE communities ADD COLUMN icon TEXT NOT NULL DEFAULT '';",
            )?;
        }
        if !column_exists(conn, "messages", "bot_id") {
            conn.execute_batch("ALTER TABLE messages ADD COLUMN bot_id TEXT NOT NULL DEFAULT '';")?;
        }
        if !column_exists(conn, "bots", "config") {
            conn.execute_batch("ALTER TABLE bots ADD COLUMN config TEXT NOT NULL DEFAULT '';")?;
        }
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','7') ON CONFLICT(key) DO UPDATE SET value='7'",
            [],
        )?;
    }
    if version < 7 {
        if !column_exists(conn, "messages", "thread_id") {
            conn.execute_batch(
                "ALTER TABLE messages ADD COLUMN thread_id TEXT NOT NULL DEFAULT '';",
            )?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, ts);",
        )?;
        conn.execute(
            "INSERT INTO kv(key,value) VALUES('schema_version','7') ON CONFLICT(key) DO UPDATE SET value='7'",
            [],
        )?;
    }
    if version < 11 {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS local_hidden (
               msg_id TEXT PRIMARY KEY,
               conv_id TEXT NOT NULL,
               hidden_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_local_hidden_conv ON local_hidden(conv_id);",
        )?;
    }
    if version < 12 {
        if !column_exists(conn, "outbox", "kind") {
            conn.execute_batch("ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT '';")?;
        }
    }
    if !column_exists(conn, "reputation", "muted_until") {
        conn.execute_batch(
            "ALTER TABLE reputation ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !column_exists(conn, "files", "seeded_at") {
        conn.execute_batch("ALTER TABLE files ADD COLUMN seeded_at INTEGER NOT NULL DEFAULT 0;")?;
    }
    if !column_exists(conn, "voice_states", "announced_at") {
        conn.execute_batch(
            "ALTER TABLE voice_states ADD COLUMN announced_at INTEGER NOT NULL DEFAULT 0;",
        )?;
        conn.execute_batch(
            "UPDATE voice_states SET announced_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE announced_at = 0;",
        )?;
    }
    // Recibo POR MEMBRO. O `status` da mensagem é agregado e, num grupo,
    // `read` de um só já virava "lida por todos" na tela.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS read_receipts (
           msg_id TEXT NOT NULL,
           fp TEXT NOT NULL,
           read_at INTEGER NOT NULL,
           PRIMARY KEY(msg_id, fp)
         );
         CREATE INDEX IF NOT EXISTS idx_receipts_msg ON read_receipts(msg_id);",
    )?;
    conn.execute(
        "INSERT INTO kv(key,value) VALUES('schema_version','13') ON CONFLICT(key) DO UPDATE SET value='13'",
        [],
    )?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;
    Ok(())
}

// Seção 1: friend_row
fn friend_row() -> impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<PeerRecord> {
    |r| {
        Ok(PeerRecord {
            fp: r.get(0)?,
            pubkey_hex: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            nickname: r.get(2)?,
            addr: r.get(3)?,
            last_seen: r.get(4)?,
            origin: r.get(5)?,
        })
    }
}

fn insert_channel_row(conn: &Connection, community_id: &str, r: &ChannelMetaRow) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO channels(id,community_id,name,topic,category,kind,position)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![
            r.id,
            community_id,
            r.name,
            r.topic,
            r.category,
            r.kind,
            r.position
        ],
    )?;
    Ok(())
}

fn insert_role_row(conn: &Connection, r: &RoleRow) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO roles(id,community_id,name,color,permissions,hoist,mentionable,position)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
        params![
            r.id,
            r.community_id,
            r.name,
            r.color,
            r.permissions,
            if r.hoist { 1 } else { 0 },
            if r.mentionable { 1 } else { 0 },
            r.position
        ],
    )?;
    Ok(())
}

fn insert_bot_row(conn: &Connection, b: &BotRow) -> Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO bots(id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
        params![
            b.id,
            b.community_id,
            b.name,
            b.discriminator,
            b.avatar,
            b.role_id,
            b.token,
            if b.online { 1 } else { 0 },
            b.owner_fp,
            b.created_at,
            b.config
        ],
    )?;
    Ok(())
}

pub struct Store {
    conn: Mutex<Connection>,
}

impl Store {
    pub const VOICE_PRESENCE_TTL_MS: u64 = 90_000;
}

const SCHEMA_V1: &str = r#"
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS peers (
  fp TEXT PRIMARY KEY,
  pubkey_hex TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  addr TEXT,
  last_seen INTEGER NOT NULL,
  origin TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  peer_fp TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conv_id TEXT NOT NULL,
  author_fp TEXT NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL,
  sig TEXT NOT NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, ts);
CREATE TABLE IF NOT EXISTS outbox (
  msg_id TEXT PRIMARY KEY,
  peer_fp TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_try INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_fp TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  community_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL,
  fp TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(community_id, fp)
);
CREATE TABLE IF NOT EXISTS friends (
  fp TEXT PRIMARY KEY,
  nickname TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  added_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  conv_id TEXT NOT NULL,
  fp TEXT NOT NULL,
  nickname TEXT NOT NULL DEFAULT '',
  added_at INTEGER NOT NULL,
  PRIMARY KEY(conv_id, fp)
);
CREATE TABLE IF NOT EXISTS calls (
  call_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  conv_id TEXT NOT NULL,
  host_fp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS call_participants (
  call_id TEXT NOT NULL,
  fp TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(call_id, fp)
);
CREATE TABLE IF NOT EXISTS files (
  file_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunks INTEGER NOT NULL,
  hash TEXT NOT NULL,
  owner_fp TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seeded_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS voice_states (
  community_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  fp TEXT NOT NULL,
  muted INTEGER NOT NULL DEFAULT 0,
  deafened INTEGER NOT NULL DEFAULT 0,
  speaking INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(community_id, channel_id, fp)
);
"#;

// Seção 2: Store
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA_V1)?;
        migrate(&conn)?;
        crate::social::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA_V1)?;
        migrate(&conn)?;
        crate::social::migrate(&conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub(crate) fn locked(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn table_names(&self) -> Vec<String> {
        let conn = self.locked();
        let Ok(mut st) = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'") else {
            return Vec::new();
        };
        st.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    pub fn kv_get(&self, key: &str) -> Option<String> {
        self.locked()
            .query_row("SELECT value FROM kv WHERE key=?1", params![key], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .ok()
            .flatten()
    }

    pub fn kv_set(&self, key: &str, value: &str) -> Result<()> {
        self.locked().execute(
            "INSERT INTO kv(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn kv_delete(&self, key: &str) -> Result<()> {
        self.locked()
            .execute("DELETE FROM kv WHERE key=?1", params![key])?;
        Ok(())
    }

    pub fn kv_list_prefix(&self, prefix: &str) -> Result<Vec<(String, String)>> {
        let conn = self.locked();
        let escaped = prefix
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut st =
            conn.prepare("SELECT key,value FROM kv WHERE key LIKE ?1 ESCAPE '\\' ORDER BY key")?;
        let rows = st
            .query_map(params![format!("{escaped}%")], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn save_identity(&self, id: &Identity, secret_hex: &str) -> Result<()> {
        self.kv_set(
            "identity",
            &serde_json::to_string(id)
                .map_err(|e| DistorrentError::Protocol(format!("serializar identidade: {e}")))?,
        )?;
        self.kv_set("identity.secret", secret_hex)
    }

    pub fn load_identity(&self) -> Option<Identity> {
        let raw = self.kv_get("identity")?;
        serde_json::from_str(&raw).ok()
    }

    pub fn load_secret_hex(&self) -> Option<String> {
        self.kv_get("identity.secret")
    }

    pub fn save_secret_blob(&self, blob_hex: &str) -> Result<()> {
        self.kv_set("identity.secret", blob_hex)
    }

    pub fn upsert_peer(&self, p: &PeerRecord) -> Result<()> {
        self.locked().execute(
            "INSERT INTO peers(fp,pubkey_hex,nickname,addr,last_seen,origin)
             VALUES(?1,?2,?3,?4,?5,?6)
             ON CONFLICT(fp) DO UPDATE SET
               pubkey_hex=excluded.pubkey_hex,
               nickname=CASE WHEN excluded.nickname='' THEN peers.nickname ELSE excluded.nickname END,
               addr=COALESCE(excluded.addr, peers.addr),
               last_seen=excluded.last_seen,
               origin=excluded.origin",
            params![p.fp, p.pubkey_hex, p.nickname, p.addr, p.last_seen, p.origin],
        )?;
        Ok(())
    }

    pub fn list_peers(&self) -> Result<Vec<PeerRecord>> {
        let conn = self.locked();
        let mut st = conn
            .prepare("SELECT fp,pubkey_hex,nickname,addr,last_seen,origin FROM peers ORDER BY last_seen DESC")?;
        let rows = st
            .query_map([], |r| {
                Ok(PeerRecord {
                    fp: r.get(0)?,
                    pubkey_hex: r.get(1)?,
                    nickname: r.get(2)?,
                    addr: r.get(3)?,
                    last_seen: r.get(4)?,
                    origin: r.get(5)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn get_peer(&self, fp: &str) -> Result<Option<PeerRecord>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT fp,pubkey_hex,nickname,addr,last_seen,origin FROM peers WHERE fp=?1",
        )?;
        st.query_row(params![fp], |r| {
            Ok(PeerRecord {
                fp: r.get(0)?,
                pubkey_hex: r.get(1)?,
                nickname: r.get(2)?,
                addr: r.get(3)?,
                last_seen: r.get(4)?,
                origin: r.get(5)?,
            })
        })
        .optional()
        .map_err(Into::into)
    }

    pub fn set_peer_addr(&self, fp: &str, addr: &str) -> Result<()> {
        self.locked()
            .execute("UPDATE peers SET addr=?2 WHERE fp=?1", params![fp, addr])?;
        Ok(())
    }

    pub fn dm_conversation_id(my_fp: &str, peer_fp: &str) -> String {
        use blake3::Hasher;
        let (a, b) = if my_fp <= peer_fp {
            (my_fp, peer_fp)
        } else {
            (peer_fp, my_fp)
        };
        // Seção 3: mut
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
        let conn = self.locked();
        conn.execute("DELETE FROM messages WHERE conv_id=?1", params![id])?;
        conn.execute("DELETE FROM conversations WHERE id=?1", params![id])?;
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

    // Seção 4: list_messages
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

    pub fn count_hidden(&self) -> Result<i64> {
        Ok(self
            .locked()
            .query_row("SELECT COUNT(*) FROM local_hidden", [], |r| r.get(0))?)
    }

    pub fn set_message_status(&self, msg_id: &str, status: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE messages SET status=?2 WHERE id=?1",
            params![msg_id, status],
        )?;
        Ok(())
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
        // Seção 5: mut
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

    pub const OUTBOX_MAX_ATTEMPTS: i64 = 12;

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
            // Seção 6: ids
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

    pub fn set_friend(&self, fp: &str, nickname: &str, status: &str) -> Result<()> {
        self.locked().execute(
            "INSERT INTO friends(fp,nickname,status,added_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(fp) DO UPDATE SET nickname=CASE WHEN excluded.nickname='' THEN friends.nickname ELSE excluded.nickname END, status=excluded.status",
            params![fp, nickname, status, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn get_friend(&self, fp: &str) -> Result<Option<(String, String)>> {
        let conn = self.locked();
        conn.query_row(
            "SELECT nickname,status FROM friends WHERE fp=?1",
            params![fp],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn list_friends(&self, status: Option<&str>) -> Result<Vec<PeerRecord>> {
        let conn = self.locked();
        let sql = "SELECT f.fp, p.pubkey_hex, f.nickname, p.addr, f.added_at, 'friend'
                   FROM friends f LEFT JOIN peers p ON p.fp = f.fp";
        let mut st;
        let rows = match status {
            Some(s) => {
                st = conn.prepare(&format!("{sql} WHERE f.status=?1 ORDER BY f.added_at DESC"))?;
                st.query_map(params![s], friend_row())?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            }
            None => {
                st = conn.prepare(&format!("{sql} ORDER BY f.added_at DESC"))?;
                st.query_map([], friend_row())?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            }
        };
        Ok(rows)
    }

    pub fn remove_friend(&self, fp: &str) -> Result<()> {
        self.locked()
            .execute("DELETE FROM friends WHERE fp=?1", params![fp])?;
        Ok(())
    }

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

    // Seção 7: community_meta
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

    // Seção 8: member_role
    pub fn member_role(&self, community_id: &str, fp: &str) -> Option<String> {
        let conn = self.locked();
        conn.query_row(
            "SELECT role FROM community_members WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
            |r| r.get(0),
        )
        .ok()
    }

    fn parse_json_list(s: &str) -> Vec<String> {
        serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
    }

    pub fn get_server_rules(&self, community_id: &str) -> Result<crate::moderation::ServerRules> {
        let conn = self.locked();
        let row: Option<(String, String, String, String, String, i64)> = conn
            .query_row(
                "SELECT spam_level,banned_words,blocked_domains,moderators,shadow_banned,updated_at FROM server_rules WHERE community_id=?1",
                params![community_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?;
        Ok(match row {
            Some((level, bw, bd, mods, shadow, updated)) => crate::moderation::ServerRules {
                community_id: community_id.to_string(),
                spam_level: level,
                banned_words: Self::parse_json_list(&bw),
                blocked_domains: Self::parse_json_list(&bd),
                moderators: Self::parse_json_list(&mods),
                shadow_banned: Self::parse_json_list(&shadow),
                updated_at: updated,
            },
            None => crate::moderation::ServerRules::fresh(community_id),
        })
    }

    pub fn set_server_rules(&self, rules: &crate::moderation::ServerRules) -> Result<()> {
        self.locked().execute(
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
                crate::identity::now_ms(),
            ],
        )?;
        Ok(())
    }

    pub fn append_audit(&self, e: &crate::moderation::AuditEntry) -> Result<()> {
        self.locked().execute(
            "INSERT INTO audit_log(id,community_id,actor_fp,action,target_fp,reason,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![e.id, e.community_id, e.actor_fp, e.action, e.target_fp, e.reason, e.created_at],
        )?;
        Ok(())
    }

    pub fn list_audit(
        &self,
        community_id: &str,
        limit: i64,
    ) -> Result<Vec<crate::moderation::AuditEntry>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,community_id,actor_fp,action,target_fp,reason,created_at FROM audit_log WHERE community_id=?1 ORDER BY created_at DESC LIMIT ?2",
        )?;
        let rows = st
            .query_map(params![community_id, limit.max(1).min(500)], |r| {
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
    }

    pub fn get_reputation(&self, fp: &str) -> Result<(String, i32, u32)> {
        let conn = self.locked();
        let row: Option<(String, i32, i64)> = conn
            .query_row(
                "SELECT trust,score,reports FROM reputation WHERE fp=?1",
                params![fp],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        Ok(row
            .map(|(t, s, r)| (t, s, r as u32))
            .unwrap_or_else(|| ("new".into(), 0, 0)))
    }

    pub fn set_reputation(&self, fp: &str, trust: &str, score: i32, reports: u32) -> Result<()> {
        self.locked().execute(
            "INSERT INTO reputation(fp,trust,score,reports,updated_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(fp) DO UPDATE SET trust=excluded.trust, score=excluded.score, reports=excluded.reports, updated_at=excluded.updated_at",
            params![fp, trust, score, reports as i64, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn mute_set(&self, fp: &str, until_ms: i64) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO reputation(fp,trust,score,reports,updated_at,muted_until)
                 VALUES(?1,'new',0,0,?2,0)",
            params![fp, crate::identity::now_ms()],
        )?;
        self.locked().execute(
            "UPDATE reputation SET muted_until=?2, updated_at=?3 WHERE fp=?1",
            params![fp, until_ms, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn mute_active(&self, fp: &str) -> Result<i64> {
        let until: Option<i64> = self
            .locked()
            .query_row(
                "SELECT muted_until FROM reputation WHERE fp=?1",
                params![fp],
                |r| r.get(0),
            )
            .optional()?;
        Ok(until.unwrap_or(0).max(0))
    }

    pub fn bump_reputation(
        &self,
        fp: &str,
        delta: i32,
        is_report: bool,
    ) -> Result<(String, i32, u32)> {
        let (mut trust, mut score, mut reports) = self.get_reputation(fp)?;
        score = (score + delta).clamp(-100, 100);
        if is_report {
            reports += 1;
        }
        if score <= -30 {
            trust = "banned".into();
        } else if score <= -10 {
            trust = "suspicious".into();
        } else if score >= 20 && trust == "new" {
            trust = "trusted".into();
        } else if score >= 0 && trust == "suspicious" {
            trust = "new".into();
        }
        self.set_reputation(fp, &trust, score, reports)?;
        Ok((trust, score, reports))
    }

    // Seção 9: file_report
    pub fn file_report(
        &self,
        id: &str,
        reporter_fp: &str,
        target_fp: &str,
        community_id: &str,
        reason: &str,
    ) -> Result<()> {
        let clean = crate::names::sanitize_text(reason, 280);
        self.locked().execute(
            "INSERT INTO reports(id,reporter_fp,target_fp,community_id,reason,status,created_at) VALUES(?1,?2,?3,?4,?5,'open',?6)",
            params![id, reporter_fp, target_fp, community_id, clean, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    pub fn open_reports_for(&self, target_fp: &str) -> Result<Vec<(String, String, String, i64)>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,reporter_fp,reason,created_at FROM reports WHERE target_fp=?1 AND status='open' ORDER BY created_at DESC LIMIT 100",
        )?;
        let rows = st
            .query_map(params![target_fp], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn resolve_report(&self, id: &str, status: &str) -> Result<()> {
        let ok = matches!(status, "dismissed" | "actioned");
        if !ok {
            return Err(crate::DistorrentError::Protocol("status inválido".into()));
        }
        self.locked().execute(
            "UPDATE reports SET status=?1 WHERE id=?2",
            params![status, id],
        )?;
        Ok(())
    }

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
        self.locked().execute(
            "INSERT INTO conversations(id,kind,title,peer_fp,created_at) VALUES(?1,'group',?2,'',?3)",
            params![id, title, crate::identity::now_ms()],
        )?;
        for fp in sorted {
            self.locked().execute(
                "INSERT OR IGNORE INTO group_members(conv_id,fp,nickname,added_at) VALUES(?1,?2,'',?3)",
                params![id, fp, crate::identity::now_ms()],
            )?;
        }
        Ok(Conversation {
            id,
            kind: "group".into(),
            title: title.to_string(),
            peer_fp: "".into(),
            created_at: crate::identity::now_ms(),
        })
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

    // Seção 10: get_call_host
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

    pub fn announce_file(
        &self,
        file_id: &str,
        name: &str,
        size: i64,
        chunks: i64,
        hash: &str,
        owner_fp: &str,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO files(file_id,name,size,chunks,hash,owner_fp,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
            params![file_id, name, size, chunks, hash, owner_fp, crate::identity::now_ms()],
        )?;
        Ok(())
    }

    // Seção 11: allow
    #[allow(clippy::type_complexity)]
    pub fn get_file(&self, file_id: &str) -> Result<Option<(String, i64, i64, String, String)>> {
        let conn = self.locked();
        conn.query_row(
            "SELECT name,size,chunks,hash,owner_fp FROM files WHERE file_id=?1",
            params![file_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(Into::into)
    }

    #[allow(clippy::type_complexity)]
    pub fn my_seed_files(
        &self,
        owner_fp: &str,
    ) -> Result<Vec<(String, String, i64, i64, String, i64)>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT file_id,name,size,chunks,hash,seeded_at FROM files
             WHERE owner_fp=?1 ORDER BY seeded_at",
        )?;
        let rows = st
            .query_map(params![owner_fp], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn touch_file_seeded(&self, file_id: &str, at_ms: i64) -> Result<()> {
        self.locked().execute(
            "UPDATE files SET seeded_at=?2 WHERE file_id=?1",
            params![file_id, at_ms],
        )?;
        Ok(())
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

    pub fn community_set_name(&self, id: &str, name: &str) -> Result<usize> {
        let conn = self.locked();
        conn.execute(
            "UPDATE communities SET name=?2 WHERE id=?1",
            params![id, name],
        )
        .map_err(Into::into)
    }

    pub fn roles_list(&self, community_id: &str) -> Result<Vec<RoleRow>> {
        // Seção 12: conn
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

    // Seção 13: bots_list
    pub fn bots_list(&self, community_id: &str) -> Result<Vec<BotRow>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config
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
            if c.len() > 16 * 1024 {
                return Err(DistorrentError::Protocol(
                    "config de bot muito grande (máx 16KB)".into(),
                ));
            }
            b.config = c.clone();
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
        // Seção 14: rows
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
    ) -> Result<()> {
        let mut conn = self.locked();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO communities(id,name,owner_fp,created_at,description,category,icon)
             VALUES(?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(id) DO UPDATE SET name=excluded.name, owner_fp=excluded.owner_fp,
               description=excluded.description, category=excluded.category, icon=excluded.icon",
            params![
                community_id,
                name,
                owner_fp,
                crate::identity::now_ms(),
                meta.0,
                meta.1,
                meta.2
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

    // Seção 15: stormvault_collect
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
                    "SELECT id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config
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

        // Seção 16: mut
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

    fn bot_row_mapper() -> impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<BotRow> {
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
            })
        }
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
            // Seção 17: community_new
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_persist() {
        let store = Store::open_in_memory().unwrap();
        assert!(store.load_identity().is_none());
        let kp = crate::identity::Keypair::generate();
        let id = kp.identity("Arthur");
        store.save_identity(&id, &kp.secret_hex()).unwrap();
        let loaded = store.load_identity().unwrap();
        assert_eq!(loaded.nickname, "Arthur");
        assert_eq!(loaded.fingerprint, kp.fingerprint());
        let secret = store.load_secret_hex().unwrap();
        let kp2 = crate::identity::Keypair::from_secret_hex(&secret).unwrap();
        assert_eq!(kp2.public_hex(), kp.public_hex());
    }

    // Seção 18: test
    #[test]
    fn dm_conversation_id_symmetric() {
        let a = "aaaaaaaaaaaa";
        let b = "bbbbbbbbbbbb";
        assert_eq!(
            Store::dm_conversation_id(a, b),
            Store::dm_conversation_id(b, a)
        );
        let c = "cccccccccccc";
        assert_ne!(
            Store::dm_conversation_id(a, b),
            Store::dm_conversation_id(a, c)
        );
    }

    #[test]
    fn outbox_respeita_backoff_e_teto_de_tentativas() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let me = kp.identity("me");
        let conv = store
            .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
            .unwrap();
        let env = MessageEnvelope::new(&kp, &conv.id, "oi");
        store.insert_message(&env, "out", "pending").unwrap();
        store.enqueue_outbox(&env.id, "peerfp000001").unwrap();

        assert_eq!(
            store.pending_outbox("peerfp000001").unwrap(),
            vec![env.id.clone()]
        );

        store.bump_outbox(&env.id).unwrap();
        assert!(
            store.pending_outbox("peerfp000001").unwrap().is_empty(),
            "com backoff ativo o mesmo flush não pode reenviar"
        );

        for _ in 0..Store::OUTBOX_MAX_ATTEMPTS {
            store.bump_outbox(&env.id).unwrap();
        }
        let gave_up = store.give_up_outbox("peerfp000001").unwrap();
        assert_eq!(gave_up, vec![env.id.clone()]);
        assert!(store.pending_outbox("peerfp000001").unwrap().is_empty());
        let m = store.message_by_id(&env.id).unwrap().unwrap();
        assert_eq!(
            m.status, "failed",
            "mensagem sem confirmação precisa ficar visível como falha"
        );
    }

    #[test]
    fn backoff_do_outbox_cresce_e_da_janela_util() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let me = kp.identity("me");
        let conv = store
            .ensure_dm_conversation(&me.fingerprint, "peerfp000002", "Peer")
            .unwrap();
        let env = MessageEnvelope::new(&kp, &conv.id, "oi");
        store.insert_message(&env, "out", "pending").unwrap();
        store.enqueue_outbox(&env.id, "peerfp000002").unwrap();

        let mut esperas: Vec<i64> = Vec::new();
        for _ in 0..Store::OUTBOX_MAX_ATTEMPTS {
            let antes = crate::identity::now_ms();
            store.bump_outbox(&env.id).unwrap();
            let (next, _): (i64, i64) = store
                .locked()
                .query_row(
                    "SELECT next_try, attempts FROM outbox WHERE msg_id=?1",
                    params![env.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            esperas.push(next - antes);
        }

        let crescimento: Vec<i64> = esperas.iter().copied().filter(|e| *e < 480_000).collect();
        assert!(
            crescimento.windows(2).all(|w| w[0] <= w[1]),
            "backoff precisa crescer até o teto, veio {esperas:?}"
        );
        assert!(
            esperas[0] < 20_000 && esperas.iter().any(|e| *e >= 60_000),
            "começa curto e cresce de verdade, veio {esperas:?}"
        );
        let total: i64 = esperas.iter().sum();
        assert!(
            total >= 30 * 60 * 1000,
            "a janela total precisa passar de 30 min para sobreviver a uma \
             reconexão por relay (era ~3 min com +15s fixo), veio {total} ms"
        );
    }

    #[test]
    fn retransmissao_da_mesma_mensagem_nao_penaliza() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let me = kp.identity("me");
        let conv = store
            .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
            .unwrap();
        let env = MessageEnvelope::new(&kp, &conv.id, "mesma");
        store.insert_message(&env, "in", "ok").unwrap();
        store.insert_message(&env, "in", "ok").unwrap();
        let msgs = store.list_messages(&conv.id, 100).unwrap();
        assert_eq!(msgs.len(), 1, "o id é a chave: reentrega não duplica linha");
    }

    #[test]
    fn reenvio_preserva_o_id_e_zera_o_orcamento() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let me = kp.identity("me");
        let conv = store
            .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
            .unwrap();
        let env = MessageEnvelope::new(&kp, &conv.id, "reenviar");
        store.insert_message(&env, "out", "failed").unwrap();

        store.enqueue_outbox(&env.id, "peerfp000001").unwrap();
        for _ in 0..Store::OUTBOX_MAX_ATTEMPTS {
            store.bump_outbox(&env.id).unwrap();
        }
        assert!(
            store.pending_outbox("peerfp000001").unwrap().is_empty(),
            "estourada não sai no flush normal"
        );

        store.requeue_outbox(&env.id, "peerfp000001").unwrap();
        let prontas = store.pending_outbox("peerfp000001").unwrap();
        assert_eq!(prontas, vec![env.id.clone()], "o MESMO id volta a sair");

        let msgs = store.list_messages(&conv.id, 100).unwrap();
        assert_eq!(msgs.len(), 1, "reenviar não cria outra linha");
    }

    #[test]
    fn conversations_and_messages_flow() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let me = kp.identity("me");
        let conv = store
            .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
            .unwrap();
        let env = MessageEnvelope::new(&kp, &conv.id, "oi");
        store.insert_message(&env, "out", "pending").unwrap();
        store.set_message_status(&env.id, "sent").unwrap();

        let msgs = store.list_messages(&conv.id, 100).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].status, "sent");
        assert_eq!(msgs[0].direction, "out");

        let convs = store.list_conversations().unwrap();
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].peer_fp, "peerfp000001");

        store.enqueue_outbox(&env.id, "peerfp000001").unwrap();
        assert_eq!(
            store.pending_outbox("peerfp000001").unwrap(),
            vec![env.id.clone()]
        );
        store.dequeue_outbox(&env.id).unwrap();
        assert!(store.pending_outbox("peerfp000001").unwrap().is_empty());
    }

    // Seção 19: test
    #[test]
    fn channel_message_without_conversation_row() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let env = MessageEnvelope::new(&kp, "canal-fake-1", "oi canal");
        store.insert_message(&env, "out", "sent").unwrap();
        assert_eq!(store.list_messages("canal-fake-1", 10).unwrap().len(), 1);
    }

    #[test]
    fn recibo_de_um_membro_nao_marca_lida_para_o_grupo_todo() {
        // O `status` é agregado: com 3 pessoas, o "lida" de uma só já virava
        // duplo check azul para todo mundo.
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let env = MessageEnvelope::new(&kp, "grupo-1", "oi grupo");
        store.insert_message(&env, "out", "sent").unwrap();
        let ts = env.ts;
        let esperados = vec!["peer-a".to_string(), "peer-b".to_string()];

        store.record_read_receipt("grupo-1", "peer-a", ts).unwrap();
        let todos = store
            .messages_read_by_all("grupo-1", ts, &esperados)
            .unwrap();
        assert!(
            todos.is_empty(),
            "com um membro faltando a mensagem NÃO está lida por todos: {todos:?}"
        );

        store.record_read_receipt("grupo-1", "peer-b", ts).unwrap();
        let todos = store
            .messages_read_by_all("grupo-1", ts, &esperados)
            .unwrap();
        assert_eq!(todos, vec![env.id.clone()], "agora todos visualizaram");
    }

    #[test]
    fn recibos_listam_quem_visualizou_com_horario() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let env = MessageEnvelope::new(&kp, "grupo-2", "oi");
        store.insert_message(&env, "out", "sent").unwrap();
        store
            .record_read_receipt("grupo-2", "peer-z", env.ts)
            .unwrap();

        let linhas = store.receipts_for(&[env.id.clone()]).unwrap();
        assert_eq!(linhas.len(), 1);
        assert_eq!(linhas[0].0, env.id);
        assert_eq!(linhas[0].1, "peer-z");
        assert!(linhas[0].2 > 0, "o instante precisa ser real, não zero");
    }

    #[test]
    fn recibo_nao_duplica_por_membro() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let env = MessageEnvelope::new(&kp, "grupo-3", "oi");
        store.insert_message(&env, "out", "sent").unwrap();
        store
            .record_read_receipt("grupo-3", "peer-a", env.ts)
            .unwrap();
        store
            .record_read_receipt("grupo-3", "peer-a", env.ts)
            .unwrap();
        assert_eq!(store.receipts_for(&[env.id.clone()]).unwrap().len(), 1);
    }

    #[test]
    fn sem_membros_esperados_ninguem_esta_lido() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let env = MessageEnvelope::new(&kp, "grupo-4", "oi");
        store.insert_message(&env, "out", "sent").unwrap();
        store
            .record_read_receipt("grupo-4", "peer-a", env.ts)
            .unwrap();
        assert!(store
            .messages_read_by_all("grupo-4", env.ts, &[])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn peers_upsert() {
        let store = Store::open_in_memory().unwrap();
        let p = PeerRecord {
            fp: "fp0000000001".into(),
            pubkey_hex: "ab".repeat(32),
            nickname: "Node A".into(),
            addr: Some("192.168.0.5:40000".into()),
            last_seen: 1,
            origin: "discovery".into(),
        };
        store.upsert_peer(&p).unwrap();
        let mut p2 = p.clone();
        p2.nickname = "".into();
        p2.last_seen = 2;
        p2.addr = None;
        store.upsert_peer(&p2).unwrap();
        let got = store.get_peer("fp0000000001").unwrap().unwrap();
        assert_eq!(got.nickname, "Node A");
        assert_eq!(got.addr.as_deref(), Some("192.168.0.5:40000"));
        assert_eq!(got.last_seen, 2);
    }
}
