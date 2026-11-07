// Metodos de Store: peers/files.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

impl Store {
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
}
