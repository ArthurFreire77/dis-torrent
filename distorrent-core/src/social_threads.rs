// Metodos de crate::storage::Store: threads. Irmao de social.rs (mesma impl, mesmo tipo).

use super::*;

impl crate::storage::Store {
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

    pub(super) fn thread_map(r: &rusqlite::Row) -> rusqlite::Result<ThreadRow> {
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
}
