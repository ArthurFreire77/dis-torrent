//! Storage local real: SQLite (rusqlite bundled — zero dependência externa).
//! A UI NUNCA acessa daqui; passa por services/repos.

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::identity::Identity;
use crate::protocol::MessageEnvelope;
use crate::ForgeError;
use crate::Result;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Conversation {
    pub id: String,
    pub kind: String,    // "dm" | "group"
    pub title: String,   // fallback: fingerprint do peer
    pub peer_fp: String, // para DM: fingerprint do outro lado
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
    pub direction: String, // "out" | "in"
    pub status: String,    // out: pending|sending|sent|delivered|failed; in: ok
    /// v6: id do bot quando a mensagem foi postada POR UM BOT ("" = humano).
    #[serde(default)]
    pub bot_id: String,
    /// v7: id da THREAD dona da mensagem ("" = mensagem de canal/DM comum).
    #[serde(default)]
    pub thread_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PeerRecord {
    pub fp: String,
    pub pubkey_hex: String,
    pub nickname: String,
    pub addr: Option<String>, // "ip:port" do listener TCP conhecido
    pub last_seen: i64,
    pub origin: String, // "discovery" | "manual" | "handshake"
}

/// Linha de canal (v4) — espelha ChannelMeta do frontend.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ChannelMetaRow {
    pub id: String,
    pub name: String,
    pub topic: String,
    pub category: String,
    pub kind: String,
    pub position: i64,
}

/// Cargo de comunidade (v4) — permissões em bitmask estilo Discord.
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

/// Bot da comunidade (v4) — token é o credential do bot local.
/// v6: `config` (JSON do runtime web) sincroniza no CommunityState; o token
/// é MASCARADO para não-donos na camada do engine (não viaja para membros).
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

/// Patch de atualização de bot. `role_id` é duplo-option:
/// None = não mexer; Some(None) = limpar cargo; Some(Some(x)) = definir cargo.
#[derive(Debug, Clone, Default)]
pub struct BotPatch {
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub role_id: Option<Option<String>>,
    pub online: Option<bool>,
    /// v6: JSON do runtime web (prefixo/comandos/escopos/webhook). Cap 16KB.
    pub config: Option<String>,
}

/// Verifica se uma coluna existe (PRAGMA table_info) — ALTER sem IF NOT EXISTS.
fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    // allowlist para prevenir injection
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

/// Migrações. v2: mensagens de canal não são conversas — remove a FK de
/// messages sem perder dados (erro FOREIGN KEY constraint failed).
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
    if version.as_str() < "2" {
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
    if version.as_str() < "3" {
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
    if version.as_str() < "4" {
        // v4: canais completos (topic/category/kind) + cargos, bots e
        // assignments (estilo Discord) para sincronização P2P.
        // `kind` já existe no schema base — ALTER só quando a coluna faltar.
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
    if version.as_str() < "5" {
        // v5: moderação + anti-spam (Storm camada de segurança).        // server_rules: 1 linha por comunidade (regras definidas pelo dono).
        // audit_log: append-only de ações de moderação (quem/quando/porquê).
        // reputation: score de confiança por peer (novo/confiável/suspeito/banido).
        // reports: denúncias de usuários (reporter → alvo + motivo + estado).
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
    if version.as_str() < "6" {
        // v6: wizard de servidores + bots conectados à web.
        // communities.description/category/icon — metadados do fluxo guiado;
        // messages.bot_id — mensagens postadas POR BOT (display; assinatura
        //   continua sendo do host);
        // bots.config — JSON do runtime web (prefixo, comandos REST, escopos,
        //   webhook) — sincroniza no CommunityState para membros (token
        //   é mascarado na camada do engine).
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
    if version.as_str() < "7" {
        // v7: threads.
        //
        // `messages.thread_id` é obrigatório para as queries de thread
        // (índice + filtro). Precisa ser um bloco de versão PROPRIO, e não
        // uma coluna a mais dentro do bloco v6: quem já estava em v6 nunca
        // executa o `if version < "6"`, ficava sem a coluna, e aí TODA
        // leitura de mensagem quebrava em InvalidColumnIndex(9) — o app
        // abria com o histórico vazio e nenhuma mensagem carregava.
        //
        // O `column_exists` continua aqui de propósito: o bloco é
        // idempotente, então um banco que já tem a coluna (instalação
        // criada direto do SCHEMA_V1 novo) apenas pula o ALTER.
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
    // v8: silenciamento de CONTA (mute global).
    //
    // Antes, `mute` só decrementava a pontuação de reputação — e nenhum
    // caminho de leitura consumia essa pontuação, então silenciar um usuário
    // não impedia nada: ele escrevia, floodava e seguia normalmente. Isto dá
    // ao mute um prazo real, consultado pelo portão de fala do MOTOR (não da
    // UI), para que ban/time-out de servidor e mute de conta coexistam.
    if !column_exists(conn, "reputation", "muted_until") {
        conn.execute_batch(
            "ALTER TABLE reputation ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    conn.execute(
        "INSERT INTO kv(key,value) VALUES('schema_version','8') ON CONFLICT(key) DO UPDATE SET value='8'",
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

// ---------- helpers de escrita de linhas (reusados por upsert e sync) ----------

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
);
"#;

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

    /// rusqlite::Connection não é Sync — acesso serializado por Mutex.
    pub(crate) fn locked(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Nomes das tabelas existentes. Usado por testes de migração e por
    /// qualquer diagnóstico que precise relatar o schema real em vez do
    /// esperado — um schema divergente é exatamente o que costuma explicar
    /// "funciona no meu banco, quebra no do usuário".
    pub fn table_names(&self) -> Vec<String> {
        let conn = self.locked();
        let Ok(mut st) = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'") else {
            return Vec::new();
        };
        st.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    }

    // ---------- kv (identidade, config, estado de sync) ----------

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

    // ---------- identidade ----------

    pub fn save_identity(&self, id: &Identity, secret_hex: &str) -> Result<()> {
        self.kv_set(
            "identity",
            &serde_json::to_string(id)
                .map_err(|e| ForgeError::Protocol(format!("serializar identidade: {e}")))?,
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

    /// Sobrescreve apenas o campo de segredo (blob cifrado do cofre).
    pub fn save_secret_blob(&self, blob_hex: &str) -> Result<()> {
        self.kv_set("identity.secret", blob_hex)
    }

    // ---------- peers ----------

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

    // ---------- conversas ----------

    /// DM é determinística: id = blake3(fp_menor || fp_maior) — ambos os lados
    /// derivam o mesmo id sem coordenação.
    pub fn dm_conversation_id(my_fp: &str, peer_fp: &str) -> String {
        use blake3::Hasher;
        let (a, b) = if my_fp <= peer_fp {
            (my_fp, peer_fp)
        } else {
            (peer_fp, my_fp)
        };
        let mut h = Hasher::new();
        h.update(b"forge/v1|dm|");
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

    // ---------- mensagens ----------

    pub fn insert_message(&self, m: &MessageEnvelope, direction: &str, status: &str) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO messages(id,conv_id,author_fp,body,ts,sig,direction,status)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
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

    /// v7: insere mensagem dentro de uma THREAD (thread_id preenchido). A
    /// conversa continua sendo o canal pai — o thread_id é o filtro da UI.
    pub fn insert_message_in_thread(
        &self,
        m: &MessageEnvelope,
        thread_id: &str,
        direction: &str,
        status: &str,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO messages(id,conv_id,author_fp,body,ts,sig,direction,status,thread_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![m.id, m.conv_id, m.author_fp, m.body, m.ts, m.sig, direction, status, thread_id],
        )?;
        Ok(())
    }

    /// Mensagens de uma thread (mais recentes, ordem de leitura).
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

    /// v6: insere mensagem postada POR UM BOT (bot_id para display). A
    /// assinatura/autor real continua sendo quem postou (host) — o bot_id
    /// serve só para a UI renderizar com badge/avatar de bot.
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
             WHERE conv_id=?1 ORDER BY ts ASC, id ASC LIMIT ?2",
        )?;
        let rows = st
            .query_map(params![conv_id, limit], |r| {
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

    pub fn set_message_status(&self, msg_id: &str, status: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE messages SET status=?2 WHERE id=?1",
            params![msg_id, status],
        )?;
        Ok(())
    }

    /// Janela de mensagens (paginação por ts): as `limit` mais recentes
    /// ANTES de `before_ts` (None = as mais recentes no geral), em ordem
    /// crescente. É o caminho da UI — `messages_list` (tudo até 500) fica
    /// para compat.
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
        // consulta DESC (mais recente primeiro) → devolve em ordem de leitura
        let mut rows = rows;
        rows.reverse();
        Ok(rows)
    }

    /// Contagem total de mensagens (para o cofre reportar tamanho real).
    pub fn count_messages(&self) -> Result<i64> {
        let conn = self.locked();
        Ok(conn.query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))?)
    }

    // ---------- outbox (mensagens PENDING aguardando conexão) ----------

    pub fn enqueue_outbox(&self, msg_id: &str, peer_fp: &str) -> Result<()> {
        self.locked().execute(
            "INSERT OR IGNORE INTO outbox(msg_id,peer_fp,attempts,next_try) VALUES(?1,?2,0,0)",
            params![msg_id, peer_fp],
        )?;
        Ok(())
    }

    pub fn dequeue_outbox(&self, msg_id: &str) -> Result<()> {
        self.locked()
            .execute("DELETE FROM outbox WHERE msg_id=?1", params![msg_id])?;
        Ok(())
    }

    /// Teto de tentativas de reenvio por mensagem.
    ///
    /// BUG que isto corrige: o laço de retransmissão era ILIMITADO. O `outbox`
    /// tem `attempts` e `next_try` desde sempre, mas `pending_outbox` ignorava
    /// as duas colunas e `bump_outbox` nunca era chamada em lugar nenhum — ou
    /// seja, o backoff existia no schema e não existia no código. Pior: o
    /// `revert_stale_sent_to_pending` comparava `ts` (data de CRIAÇÃO da
    /// mensagem) com o corte, então passados 20s a mensagem satisfazia a
    /// condição para sempre e voltava a PENDING a cada flush de 5s. Como o
    /// receptor rejeitava o reenvio no anti-spam (e portanto não mandava Ack),
    /// o ciclo nunca terminava: era o "recebo a mesma mensagem infinitas
    /// vezes". Com teto, uma mensagem que não foi confirmada vira `failed`
    /// visível em vez de martelar o peer para sempre.
    pub const OUTBOX_MAX_ATTEMPTS: i64 = 12;

    /// Mensagens prontas para reenvio AGORA: respeita o backoff (`next_try`) e
    /// descarta as que estouraram o orçamento de tentativas.
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

    /// Marca uma tentativa: incrementa `attempts` e agenda o próximo reenvio
    /// com backoff. É o que CONVERTE o laço de 5s em reenvio com sono.
    pub fn bump_outbox(&self, msg_id: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE outbox SET attempts=attempts+1, next_try=?2 WHERE msg_id=?1",
            params![msg_id, crate::identity::now_ms() + 15_000],
        )?;
        Ok(())
    }

    /// Mensagens que estouraram o orçamento: marca `failed` e tira da fila,
    /// para o usuário ver que NÃO vai acontecer em vez de esperar para sempre.
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

    /// Varredor anti-buraco-negro (upgrade relay→direta, troca de sessão):
    /// mensagens out em sending/sent com ts mais velho que o corte e SEM ack
    /// voltam a PENDING + outbox. Receptor dedupa por id (INSERT OR IGNORE),
    /// então reenvio é seguro. Corte típico: 20s (relay RTT ~2s; além disso
    /// é perda certa, ex.: enviada pelo relay velho após o peer upgradear).
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
                   AND conv_id IN (SELECT id FROM conversations WHERE peer_fp=?2)",
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

    /// Ao cair a conexão: mensagens out não-confirmadas voltam a PENDING e
    /// voltam para o outbox. Retorna ids re-enfileirados.
    pub fn revert_unacked_to_pending(&self, peer_fp: &str) -> Result<Vec<String>> {
        // coleta os ids com o lock em escopo próprio — os métodos abaixo
        // re-adquirem o Mutex (não é reentrante).
        let ids = {
            let conn = self.locked();
            let mut st = conn.prepare(
                "SELECT id FROM messages
                 WHERE direction='out' AND status IN ('sending','sent')
                   AND conv_id IN (SELECT id FROM conversations WHERE peer_fp=?1)",
            )?;
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

    // ---------- amigos ----------

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

    // ---------- comunidades ----------

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

    /// v6: metadados do wizard — (descrição, categoria, ícone).
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

    /// v6: atualiza metadados — cada campo é opcional (None = não mexer).
    /// Caps anti-abuso; valida no engine quem pode chamar (dono).
    pub fn community_meta_set(
        &self,
        id: &str,
        description: Option<&str>,
        category: Option<&str>,
        icon: Option<&str>,
    ) -> Result<usize> {
        let conn = self.locked();
        // owned Strings: o borrow para ToSql vive até o execute (o `&str`
        // do if-let morreria no fim do bloco — E0597).
        let mut sets: Vec<(&str, String)> = Vec::new();
        if let Some(d) = description {
            if d.chars().count() > 512 {
                return Err(ForgeError::Protocol(
                    "descrição muito longa (máx 512)".into(),
                ));
            }
            sets.push(("description=?", d.to_string()));
        }
        if let Some(c) = category {
            if c.chars().count() > 32 {
                return Err(ForgeError::Protocol(
                    "categoria muito longa (máx 32)".into(),
                ));
            }
            sets.push(("category=?", c.to_string()));
        }
        if let Some(i) = icon {
            if i.chars().count() > 8 {
                return Err(ForgeError::Protocol(
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

    /// Comunidade dona de um canal. Mensagem de canal guarda `conv_id == channel_id`,
    /// então é isto que resolve "de qual servidor é esta conversa" — o que a
    /// autorização de moderador precisa antes de qualquer decisão.
    pub fn channel_community(&self, channel_id: &str) -> Result<Option<String>> {
        let conn = self.locked();
        let mut st = conn.prepare("SELECT community_id FROM channels WHERE id=?1")?;
        let mut rows = st.query(params![channel_id])?;
        Ok(match rows.next()? {
            Some(r) => Some(r.get(0)?),
            None => None,
        })
    }

    /// Posição de um canal dentro da comunidade (base do drag-to-reorder).
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

    /// Grava a ordem final de um conjunto de canais, em UMA transação.
    ///
    /// Rejeita ids que não pertencem à comunidade: um reordenamento é um frame
    /// de rede, e sem esta checagem um dono de servidor A conseguiria reordenar
    /// (ou tocar) canais do servidor B só por listar os ids. Também trava o
    /// tamanho para não transformar o frame num laço de escrita ilimitado.
    pub fn channels_reorder(&self, community_id: &str, ids: &[String]) -> Result<()> {
        if ids.len() > 256 {
            return Err(crate::ForgeError::Protocol(
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
                    return Err(crate::ForgeError::Protocol(
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

    /// Metadados completos de um canal (comunidade, nome, tipo, tópico).
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

    pub fn member_role(&self, community_id: &str, fp: &str) -> Option<String> {
        let conn = self.locked();
        conn.query_row(
            "SELECT role FROM community_members WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
            |r| r.get(0),
        )
        .ok()
    }

    // ---------- moderação + anti-spam (v5, Storm camada de segurança) ----------

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

    /// Ajusta reputação de forma atômica: `delta` no score, +1 report se `is_report`.
    /// Retorna `(trust, score, reports)` resultante. Transições: score<=-30 banido,
    /// <=-10 suspeito, >=20 (e era novo) confiável, suspeito que volta a >=0 vira novo.
    /// Silencia a conta inteira até `until_ms` (0 = levanta o silêncio).
    ///
    /// Escopo de CONTA, não de servidor: um moderador de um servidor não pode
    /// silenciar o comportamento da pessoa nos outros servidores, mas quem tem
    /// poder sobre a conta (ou o próprio dono, contra si mesmo) sim. Por isso
    /// isto vive ao lado da reputação, e não em `timeouts` (que é por
    /// comunidade).
    pub fn mute_set(&self, fp: &str, until_ms: i64) -> Result<()> {
        // Garante a linha: um usuário nunca moderado não tem registro ainda.
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

    /// Prazo do silenciamento ainda vigente (0 = pode falar).
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
            return Err(crate::ForgeError::Protocol("status inválido".into()));
        }
        self.locked().execute(
            "UPDATE reports SET status=?1 WHERE id=?2",
            params![status, id],
        )?;
        Ok(())
    }

    // ---------- grupos DM ----------
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
        h.update(b"forge/v1|group|");
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

    // ---------- calls ----------
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

    /// Host declarado de uma chamada — usado para validar CallAccept remoto.
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

    /// O peer está em alguma chamada ativa? Enquanto estiver, o heartbeat da
    /// sessão não desacelera (detecção de sessão morta tem de ficar rápida).
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

    // ---------- voice states ----------
    pub fn set_voice_state(
        &self,
        community_id: &str,
        channel_id: &str,
        fp: &str,
        muted: bool,
        deafened: bool,
    ) -> Result<()> {
        self.locked().execute(
            "INSERT INTO voice_states(community_id,channel_id,fp,muted,deafened,speaking,joined_at) VALUES(?1,?2,?3,?4,?5,0,?6)
             ON CONFLICT(community_id,channel_id,fp) DO UPDATE SET muted=excluded.muted, deafened=excluded.deafened",
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
        let conn = self.locked();
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

    // ---------- files swarm ----------
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

    // ---------- canais completos (v4) ----------

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

    /// Atualização parcial: None não mexe; "" em name/category não mexe.
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

    /// Substituição completa dos canais da comunidade (sync de membro):
    /// delete-then-insert em transação — canal removido no host some aqui.
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

    /// Apaga UMA mensagem (moderação). Retorna a comunidade dona via canal,
    /// se a mensagem for de um canal (`channel_community`), para checagem de permissão.
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

    // ---------- cargos (v4) ----------

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

    /// Patch de cargo: None não mexe; "" em name/color não mexe.
    /// Retorna false se o cargo não existir.
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

    /// Apaga o cargo e limpa dependências: assignments somem e bots ficam
    /// sem cargo (role_id NULL). Proteção de "-everyone" é papel do engine.
    pub fn role_delete(&self, community_id: &str, role_id: &str) -> Result<usize> {
        // transação: cargo, assignments e vínculos de bots somem JUNTOS
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

    // ---------- assignments de cargos (v4) ----------

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

    /// Substituição completa dos assignments (fp -> cargos) da comunidade.
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

    // ---------- bots (v4) ----------

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

    /// Patch de bot. `role_id`: None = não mexer; Some(None)/Some(Some(""))
    /// = limpar cargo; Some(Some(x)) = definir cargo. "" em name/avatar não mexe.
    /// Retorna false se o bot não existir.
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
            // cap anti-abuso de storage (a UI também valida; revalida no core)
            if c.len() > 16 * 1024 {
                return Err(ForgeError::Protocol(
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

    // ---------- mensagens de grupo (flush sem outbox por peer) ----------

    /// Cria/atualiza o estado COMPLETO de um grupo (sync do criador).
    /// INSERT OR IGNORE na conversa + replace da lista de membros.
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

    /// Conversas de grupo em que o peer participa: (id, título, membros).
    /// Usado no flush de conexão para re-sincronizar o estado do grupo.
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

    /// Mensagens 'out' pendentes (pending/sending) em conversas de grupo —
    /// reenviadas no flush de conexão a cada membro do grupo.
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

    /// Ao cair um link: mensagens 'out' de grupos em sending/sent voltam a
    /// PENDING (sem outbox por peer — o flush de grupo cuida do reenvio).
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

    // ---------- sync completo de comunidade (membro) ----------

    /// Aplica o estado oficial do host em UMA transação: upsert da comunidade,
    /// canais (delete-then-insert — removidos no host somem aqui), cargos,
    /// bots, assignments e membros (upsert).
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

    /// Remove uma comunidade inteiramente do storage local (kick recebido):
    /// canais, membros, comunidade, cargos, bots, assignments e voice states.
    pub fn community_remove_local(&self, community_id: &str) -> Result<()> {
        // transação: kick recebido não pode deixar metade da comunidade para trás
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

    // ---------- stormvault: coleta (export) e mesclagem (import) ----------

    /// Acesso cru à conexão para o módulo stormvault (mesmo crate, escopo
    /// fechado — a UI NUNCA vê isto; passa pelos commands do Tauri).
    pub(crate) fn with_conn<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.locked();
        f(&conn)
    }

    /// Coleta a conta inteira para o `.stormvault`. Whitelist de settings
    /// evita exportar segredos/estado de device por acidente.
    pub(crate) fn stormvault_collect(
        &self,
        secret_hex: Option<String>,
        max_messages: Option<usize>,
        settings_whitelist: &[&str],
    ) -> Result<crate::stormvault::StormVaultData> {
        let identity = self
            .load_identity()
            .ok_or_else(|| crate::ForgeError::Protocol("sem identidade para exportar".into()))?;

        let conversations = self.list_conversations()?;
        let total_msgs = self.count_messages().unwrap_or(0);
        let cap = max_messages.unwrap_or(crate::stormvault::DEFAULT_MAX_MESSAGES);
        // pega as mais recentes primeiro (DESC) e inverte para ordem de leitura
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
        // reputações, auditoria (cap: log pode crescer sem teto) e denúncias
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

    /// Mescla os dados do cofre importado. Política: NADA local mais recente
    /// é sobrescrito — mensagens por id (dedup + conflito mantém local),
    /// amigos/canais/cargos por upsert com não-vazio vencendo, settings só
    /// preenchem chaves ausentes (preferências do device têm precedência).
    pub(crate) fn stormvault_merge(
        &self,
        data: &crate::stormvault::StormVaultData,
        report: &mut crate::stormvault::ImportReport,
    ) -> Result<()> {
        // mensagens em LOTES (uma transação por lote): importar 200k msgs numa
        // transação única seguraria o Mutex do banco (rede/UI inteiras) por
        // minutos. Lote de 2000 = cada commit é rápido e o progresso é parcial
        // mesmo se o app cair no meio.
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
                    // dedup por id; mesma id com conteúdo diferente = conflito
                    // (id é hash de autor+conv+ts+corpo+rand — colisão real ~0;
                    // mantém local, defensivo contra cofre adulterado)
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
                            report.message_conflicts += 1; // local vence
                        }
                    }
                }
            }
            tx.commit()?;
        }

        let mut conn = self.locked();
        let tx = conn.transaction()?;

        // conversas: OR IGNORE (locais têm precedência; título local é
        // preferência do device — "não sobrescrever dados mais recentes")
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

        // amigos: novo valor não-vazio vence; added_at maior vence
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

        // peers (endereços para reconectar): preenche vazios, nunca apaga;
        // last_seen é MAX (dado mais recente vence, sem rollback)
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

        // comunidades: OR IGNORE em TUDO (base, canais, cargos, bots, membros,
        // assignments). O cofre NUNCA sobrescreve estado local — canal
        // renomeado aqui, cargo promovido aqui e token de bot revogado aqui
        // sobrevivem ao import; o host re-sync completa o que faltar.
        // Exceção: instalação limpa (tabelas vazias) absorve o cofre inteiro.
        for cm in &data.communities {
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
            // regras do servidor: updated_at maior vence (dado com recência real)
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

        // reputações: updated_at maior vence (nunca rebaixa por backup velho)
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

        // audit_log e reports: append-only por id (OR IGNORE — resolução local
        // de denúncia nunca é revertida por backup)
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

        // grupos DM: conversa + membros
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

        // settings: só preenchem chaves ausentes (preferências do device vencem)
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

    /// BUG do "recebo a mesma mensagem infinitas vezes": o retransmissor era
    /// ilimitado porque o `outbox` tem `attempts`/`next_try` no schema desde
    /// sempre, mas `pending_outbox` ignorava as duas colunas e `bump_outbox`
    /// nunca era chamada. O resultado era reenvio a CADA flush (5s) para
    /// sempre, enquanto o status não virasse `delivered`.
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

        // 1) sem bump: sai no primeiro flush.
        assert_eq!(
            store.pending_outbox("peerfp000001").unwrap(),
            vec![env.id.clone()]
        );

        // 2) depois do bump, a próxima janela é adiada -> NÃO reenvia de novo
        //    (era o que martelava o peer a cada 5s).
        store.bump_outbox(&env.id).unwrap();
        assert!(
            store.pending_outbox("peerfp000001").unwrap().is_empty(),
            "com backoff ativo o mesmo flush não pode reenviar"
        );

        // 3) esgota o orçamento de tentativas: some da fila e vira 'failed',
        //    para o usuário ver que não vai acontecer em vez de esperar para sempre.
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

    /// A retransmissão da MESMA mensagem precisa ser idempotente: quem já tem
    /// o id confirma (Ack) e não penaliza o remetente, nem gera evento novo.
    /// Sem isto, o anti-spam de duplicata (60s) rejeitava o reenvio ANTES do
    /// Ack, e o remetente nunca parava de reenviar.
    #[test]
    fn retransmissao_da_mesma_mensagem_nao_penaliza() {
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let me = kp.identity("me");
        let conv = store
            .ensure_dm_conversation(&me.fingerprint, "peerfp000001", "Peer")
            .unwrap();
        let env = MessageEnvelope::new(&kp, &conv.id, "mesma");
        // INSERT OR IGNORE: a segunda inserção do mesmo id é ignorada.
        store.insert_message(&env, "in", "ok").unwrap();
        store.insert_message(&env, "in", "ok").unwrap();
        let msgs = store.list_messages(&conv.id, 100).unwrap();
        assert_eq!(msgs.len(), 1, "o id é a chave: reentrega não duplica linha");
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

        // outbox
        store.enqueue_outbox(&env.id, "peerfp000001").unwrap();
        assert_eq!(
            store.pending_outbox("peerfp000001").unwrap(),
            vec![env.id.clone()]
        );
        store.dequeue_outbox(&env.id).unwrap();
        assert!(store.pending_outbox("peerfp000001").unwrap().is_empty());
    }

    #[test]
    fn channel_message_without_conversation_row() {
        // regressão do FOREIGN KEY constraint failed em canais de comunidade
        let store = Store::open_in_memory().unwrap();
        let kp = crate::identity::Keypair::generate();
        let env = MessageEnvelope::new(&kp, "canal-fake-1", "oi canal");
        store.insert_message(&env, "out", "sent").unwrap();
        assert_eq!(store.list_messages("canal-fake-1", 10).unwrap().len(), 1);
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
        store.upsert_peer(&p2).unwrap(); // não sobrescreve nickname/addr com vazio
        let got = store.get_peer("fp0000000001").unwrap().unwrap();
        assert_eq!(got.nickname, "Node A");
        assert_eq!(got.addr.as_deref(), Some("192.168.0.5:40000"));
        assert_eq!(got.last_seen, 2);
    }
}
