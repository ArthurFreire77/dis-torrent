// Metodos de Store: schema/kv/identity.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

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

    /// Grava só os metadados públicos. No desktop o segredo vive no keyring;
    /// chamar `save_identity` ali gravaria a chave privada em texto claro.
    pub fn save_identity_meta(&self, id: &Identity) -> Result<()> {
        self.kv_set(
            "identity",
            &serde_json::to_string(id)
                .map_err(|e| DistorrentError::Protocol(format!("serializar identidade: {e}")))?,
        )
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

    pub fn is_blocked_fp(&self, fp: &str) -> bool {
        matches!(
            self.get_friend(fp).ok().flatten(),
            Some((_, status)) if status == "blocked"
        )
    }
}
