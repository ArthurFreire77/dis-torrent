use std::path::Path;
use std::sync::Mutex;

#[path = "storage_vault.rs"]
mod storage_vault;

#[path = "storage_schema.rs"]
mod storage_schema;

#[path = "storage_peers.rs"]
mod storage_peers;

#[path = "storage_conv.rs"]
mod storage_conv;

#[path = "storage_social.rs"]
mod storage_social;

#[path = "storage_community.rs"]
mod storage_community;

#[path = "storage_groups.rs"]
mod storage_groups;

#[path = "storage_bots.rs"]
mod storage_bots;

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

/// Estado persistido de um relacionamento. `requested_by` guarda quem enviou
/// o pedido pendente (`""` nos demais estados) e `blocked_at` sobrevive à
/// remoção da amizade — é o que impede o desbloqueio acidental.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FriendState {
    pub fp: String,
    pub nickname: String,
    pub status: String,
    pub added_at: i64,
    pub requested_by: String,
    pub requested_at: i64,
    pub blocked_at: i64,
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
    /// Permissões administrativas concedidas explicitamente pelo dono.
    /// Sem isso o bot não executa `/ban`, `/kick`, etc.
    #[serde(default)]
    pub perms: i64,
    /// Segredo do HMAC do webhook. **Local do dono**: fica fora do `config`
    /// (que é sincronizado para todos os membros) e é zerado no estado enviado
    /// a quem não é dono, exatamente como o `token`. O runtime do dono lê
    /// daqui para assinar; o export do painel não o inclui.
    #[serde(default)]
    pub webhook_secret: String,
}

impl BotRow {
    /// O dono precisa saber se há assinatura configurada, sem ver o valor.
    pub fn webhook_secret_set(&self) -> bool {
        !self.webhook_secret.is_empty()
    }
}

#[derive(Debug, Clone, Default)]
pub struct BotPatch {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub role_id: Option<Option<String>>,
    pub online: Option<bool>,
    pub config: Option<String>,
    pub perms: Option<i64>,
    /// `Some("")` apaga o segredo; `None` mantém o atual.
    pub webhook_secret: Option<String>,
}

/// Uma denúncia/aviso registrado pela moderação (comando `/warn`).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct WarnRow {
    pub id: String,
    pub community_id: String,
    pub fp: String,
    pub reason: String,
    pub actor_fp: String,
    pub created_at: i64,
    pub active: bool,
}

/// Uma linha do console de um bot. `level` é `info|warn|error`.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BotLogRow {
    pub id: i64,
    pub community_id: String,
    pub bot_id: String,
    pub level: String,
    pub message: String,
    pub created_at: i64,
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
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS read_receipts (
           msg_id TEXT NOT NULL,
           fp TEXT NOT NULL,
           read_at INTEGER NOT NULL,
           PRIMARY KEY(msg_id, fp)
         );
         CREATE INDEX IF NOT EXISTS idx_receipts_msg ON read_receipts(msg_id);",
    )?;
    // Servidor público: qualquer um entra (com rate limit); privado exige convite.
    if !column_exists(conn, "communities", "is_public") {
        conn.execute_batch(
            "ALTER TABLE communities ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    conn.execute(
        "INSERT INTO kv(key,value) VALUES('schema_version','13') ON CONFLICT(key) DO UPDATE SET value='13'",
        [],
    )?;
    if !column_exists(conn, "bots", "perms") {
        conn.execute_batch("ALTER TABLE bots ADD COLUMN perms INTEGER NOT NULL DEFAULT 0;")?;
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS bot_logs (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           community_id TEXT NOT NULL,
           bot_id TEXT NOT NULL,
           level TEXT NOT NULL DEFAULT 'info',
           message TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_bot_logs_bot ON bot_logs(community_id, bot_id, id);
         CREATE TABLE IF NOT EXISTS bot_vars (
           community_id TEXT NOT NULL,
           bot_id TEXT NOT NULL,
           key TEXT NOT NULL,
           value TEXT NOT NULL,
           updated_at INTEGER NOT NULL,
           PRIMARY KEY(community_id, bot_id, key)
         );
         CREATE TABLE IF NOT EXISTS warnings (
           id TEXT PRIMARY KEY,
           community_id TEXT NOT NULL,
           fp TEXT NOT NULL,
           reason TEXT NOT NULL DEFAULT '',
           actor_fp TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           active INTEGER NOT NULL DEFAULT 1
         );
         CREATE INDEX IF NOT EXISTS idx_warnings_target ON warnings(community_id, fp, active);",
    )?;
    conn.execute(
        "INSERT INTO kv(key,value) VALUES('schema_version','14') ON CONFLICT(key) DO UPDATE SET value='14'",
        [],
    )?;
    if !column_exists(conn, "bots", "webhook_secret") {
        conn.execute_batch("ALTER TABLE bots ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT '';")?;
    }
    conn.execute(
        "INSERT INTO kv(key,value) VALUES('schema_version','15') ON CONFLICT(key) DO UPDATE SET value='15'",
        [],
    )?;
    conn.execute_batch("PRAGMA foreign_keys=ON;")?;
    Ok(())
}

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
        "INSERT OR REPLACE INTO bots(id,community_id,name,discriminator,avatar,role_id,token,online,owner_fp,created_at,config,perms,webhook_secret)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
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
            b.config,
            b.perms,
            b.webhook_secret
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

impl Store {
    pub const OUTBOX_MAX_ATTEMPTS: i64 = 12;
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
