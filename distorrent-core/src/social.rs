use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[path = "social_reads.rs"]
mod social_reads;

#[path = "social_meta.rs"]
mod social_meta;

#[path = "social_profiles.rs"]
mod social_profiles;

#[path = "social_threads.rs"]
mod social_threads;

#[path = "social_misc.rs"]
mod social_misc;

pub const PRESENCE_TTL_MS: i64 = 90_000;

/// Mensagens iniciais permitidas por direção antes de existir amizade aceita.
/// O contador é persistido e conferido nos dois lados: um cliente alterado
/// não consegue passar de três porque o receptor também conta.
pub const DM_INTRO_LIMIT: i64 = 3;

/// Solicitação sem resposta não pode viver para sempre: depois disso ela deixa
/// de aparecer nas listas e o contador de introdução volta a valer.
pub const FRIEND_REQUEST_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

fn column_exists(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return false;
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) else {
        return false;
    };
    let found = rows.filter_map(|r| r.ok()).any(|c| c == column);
    found
}

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

          -- Reações que não puderam sair porque o peer estava offline.
          -- (Mensagens têm outbox com retry; reação ia em SendToPeer direto e
          -- se perdia em silêncio.)
          CREATE TABLE IF NOT EXISTS pending_reacts (
             peer_fp TEXT NOT NULL,
             msg_id TEXT NOT NULL,
             conv_id TEXT NOT NULL DEFAULT '',
             emoji TEXT NOT NULL,
             is_add INTEGER NOT NULL,
             created_at INTEGER NOT NULL,
             PRIMARY KEY (peer_fp, msg_id, emoji)
          );
          CREATE INDEX IF NOT EXISTS idx_preact_peer ON pending_reacts(peer_fp);

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
         );

         -- Gate das três mensagens iniciais. A chave é a DIREÇÃO
         -- (conversa + autor), não a conversa: apagar/reabrir a conversa não
         -- zera o contador, e o receptor conta o mesmo que o emissor.
         CREATE TABLE IF NOT EXISTS dm_intro (
            conv_id TEXT NOT NULL,
            author_fp TEXT NOT NULL,
            used INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (conv_id, author_fp)
         );

         -- Um lida por conversa e por membro. O read_cursors antigo é
         -- global por conversa; num grupo isso marcava como lido para todos.
         CREATE TABLE IF NOT EXISTS conv_read (
            conv_id TEXT NOT NULL,
            fp TEXT NOT NULL,
            last_read_ts INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (conv_id, fp)
         );

         -- Dono do grupo. A convenção antiga era o primeiro membro da lista,
         -- mas create_group_dm ORDENA os fingerprints: o criador quase nunca
         -- é o primeiro, e qualquer membro virava dono para remover/apagar.
         CREATE TABLE IF NOT EXISTS group_owners (
            conv_id TEXT PRIMARY KEY,
            owner_fp TEXT NOT NULL
         );

         -- Menção é fato registrado, não substring: sem esta tabela o
         -- contador casava qualquer mensagem que citasse o fingerprint.
         CREATE TABLE IF NOT EXISTS mentions (
            msg_id TEXT NOT NULL,
            conv_id TEXT NOT NULL,
            target_fp TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (msg_id, target_fp)
         );
         CREATE INDEX IF NOT EXISTS idx_mentions_target ON mentions(target_fp, conv_id);",
    )?;

    for column in [
        "rev",
        "content_hash",
        "profile_theme",
        "avatar_effect",
        "decoration",
    ] {
        if !column_exists(conn, "profiles", column) {
            let ddl = match column {
                "rev" => "ALTER TABLE profiles ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;",
                "content_hash" => {
                    "ALTER TABLE profiles ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';"
                }
                "profile_theme" => {
                    "ALTER TABLE profiles ADD COLUMN profile_theme TEXT NOT NULL DEFAULT '';"
                }
                "avatar_effect" => {
                    "ALTER TABLE profiles ADD COLUMN avatar_effect TEXT NOT NULL DEFAULT '';"
                }
                _ => "ALTER TABLE profiles ADD COLUMN decoration TEXT NOT NULL DEFAULT '';",
            };
            conn.execute_batch(ddl)?;
        }
    }

    if !column_exists(conn, "msg_reactions", "is_super") {
        conn.execute_batch(
            "ALTER TABLE msg_reactions ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if !column_exists(conn, "pending_reacts", "is_super") {
        conn.execute_batch(
            "ALTER TABLE pending_reacts ADD COLUMN is_super INTEGER NOT NULL DEFAULT 0;",
        )?;
    }

    for column in ["requested_by", "requested_at", "blocked_at"] {
        if !column_exists(conn, "friends", column) {
            let ddl = match column {
                "requested_by" => {
                    "ALTER TABLE friends ADD COLUMN requested_by TEXT NOT NULL DEFAULT '';"
                }
                "requested_at" => {
                    "ALTER TABLE friends ADD COLUMN requested_at INTEGER NOT NULL DEFAULT 0;"
                }
                _ => "ALTER TABLE friends ADD COLUMN blocked_at INTEGER NOT NULL DEFAULT 0;",
            };
            conn.execute_batch(ddl)?;
        }
    }
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status, added_at);
         CREATE INDEX IF NOT EXISTS idx_conv_read_fp ON conv_read(fp);",
    )?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReactionRow {
    pub msg_id: String,
    pub conv_id: String,
    pub emoji: String,
    pub reactor_fp: String,
    pub created_at: i64,
    /// Reação "super": a UI desenha com brilho/ondas. Mesmo custo de rede.
    #[serde(default)]
    pub is_super: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReactionSummary {
    pub msg_id: String,
    pub emoji: String,
    pub count: i64,
    pub reactors: Vec<String>,
    pub mine: bool,
    #[serde(default)]
    pub super_count: i64,
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
    #[serde(default)]
    pub rev: i64,
    #[serde(default)]
    pub content_hash: String,
    /// Gradiente do perfil (`none`, `aurora`, `sunset`, `ocean`, `neon`).
    /// Fora do hash v1 de propósito: frames antigos continuam válidos.
    #[serde(default)]
    pub profile_theme: String,
    /// Aura ao redor do avatar (`none`, `glow`, `pulse`, `rainbow`).
    #[serde(default)]
    pub avatar_effect: String,
    /// Emoji/ícone de decoração do perfil, exibido ao lado do nome.
    #[serde(default)]
    pub decoration: String,
}

/// Chave de desempate das customizações que não entram no hash v1.
/// Mantém a convergência determinística entre dispositivos com a mesma `rev`.
pub fn profile_style_key(theme: &str, avatar_effect: &str, decoration: &str) -> String {
    format!("{theme}\u{1f}{avatar_effect}\u{1f}{decoration}")
}

pub fn profile_content_hash(
    display_name: &str,
    about: &str,
    avatar_b64: &str,
    banner_b64: &str,
    accent: &str,
) -> String {
    let mut h = blake3::Hasher::new();
    for part in [display_name, about, avatar_b64, banner_b64, accent] {
        h.update(&(part.len() as u64).to_le_bytes());
        h.update(part.as_bytes());
    }
    h.finalize().to_hex().to_string()[..32].to_string()
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
    pub kind: String,
    pub tags: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BanRow {
    pub fp: String,
    pub reason: String,
    pub actor_fp: String,
    pub created_at: i64,
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

/// Resumo de conversa para a lista: prévia, horário e não lidas do membro.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConversationSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub peer_fp: String,
    pub created_at: i64,
    pub last_ts: i64,
    pub last_body: String,
    pub unread_count: i64,
}

/// Quanto do limite de introdução já foi usado nesta conversa/direção.
/// A UI mostra isso; o Rust é quem recusa a mensagem excedente.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IntroState {
    pub used: i64,
    pub limit: i64,
    pub is_friend: bool,
    pub remaining: i64,
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
    pub from: String,
    pub conv: String,
    pub has: String,
    pub before: i64,
    pub limit: i64,
    /// Quem está buscando. Necessário para "unread" saber o cursor certo.
    #[serde(default)]
    pub me: String,
}

impl crate::storage::Store {
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
}
