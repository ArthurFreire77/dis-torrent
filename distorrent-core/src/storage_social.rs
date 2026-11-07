// Metodos de Store: friends/moderation.
// Irmão de storage.rs; o impl e o mesmo tipo (Store), entao o campo conn
// continua acessivel via self.locked().

use super::*;
use rusqlite::params;

impl Store {
    pub fn set_friend(&self, fp: &str, nickname: &str, status: &str) -> Result<()> {
        let now = crate::identity::now_ms();
        let blocked = if status == "blocked" { now } else { 0 };
        self.locked().execute(
            "INSERT INTO friends(fp,nickname,status,added_at,requested_by,requested_at,blocked_at)
             VALUES(?1,?2,?3,?4,'',0,?5)
             ON CONFLICT(fp) DO UPDATE SET
               nickname=CASE WHEN excluded.nickname='' THEN friends.nickname ELSE excluded.nickname END,
               status=excluded.status,
               blocked_at=CASE WHEN excluded.status='blocked' THEN excluded.blocked_at ELSE friends.blocked_at END",
            params![fp, nickname, status, now, blocked],
        )?;
        Ok(())
    }

    /// Registra um pedido enviado. Não rebaixa amizade aceita nem bloqueio.
    pub fn set_friend_request_out(&self, fp: &str, nickname: &str) -> Result<()> {
        let now = crate::identity::now_ms();
        self.locked().execute(
            "INSERT INTO friends(fp,nickname,status,added_at,requested_by,requested_at)
             VALUES(?1,?2,'pending_out',?3,?4,?3)
             ON CONFLICT(fp) DO UPDATE SET
               nickname=CASE WHEN excluded.nickname='' THEN friends.nickname ELSE excluded.nickname END,
               status=CASE WHEN friends.status IN ('blocked','accepted') THEN friends.status ELSE 'pending_out' END,
               requested_by=CASE WHEN friends.status IN ('blocked','accepted') THEN friends.requested_by ELSE excluded.requested_by END,
               requested_at=CASE WHEN friends.status IN ('blocked','accepted') THEN friends.requested_at ELSE excluded.requested_at END",
            params![fp, nickname, now, ""],
        )?;
        Ok(())
    }

    /// Registra um pedido recebido. Pedido repetido do mesmo peer mantém o
    /// carimbo original (a UI não deve "pular" a solicitação para o topo).
    pub fn set_friend_request_in(&self, fp: &str, nickname: &str) -> Result<()> {
        let now = crate::identity::now_ms();
        self.locked().execute(
            "INSERT INTO friends(fp,nickname,status,added_at,requested_by,requested_at)
             VALUES(?1,?2,'pending_in',?3,?4,?3)
             ON CONFLICT(fp) DO UPDATE SET
               nickname=CASE WHEN excluded.nickname='' THEN friends.nickname ELSE excluded.nickname END,
               status=CASE WHEN friends.status IN ('blocked','accepted') THEN friends.status ELSE 'pending_in' END,
               requested_by=CASE WHEN friends.status IN ('blocked','accepted') THEN friends.requested_by ELSE excluded.requested_by END,
               requested_at=CASE WHEN friends.status IN ('blocked','accepted') THEN friends.requested_at ELSE excluded.requested_at END",
            params![fp, nickname, now, fp],
        )?;
        Ok(())
    }

    /// Aceita nos dois sentidos: `accepted` é simétrico por definição.
    pub fn accept_friend(&self, fp: &str, nickname: &str) -> Result<()> {
        let now = crate::identity::now_ms();
        self.locked().execute(
            "INSERT INTO friends(fp,nickname,status,added_at,requested_by,requested_at)
             VALUES(?1,?2,'accepted',?3,'',0)
             ON CONFLICT(fp) DO UPDATE SET
               nickname=CASE WHEN excluded.nickname='' THEN friends.nickname ELSE excluded.nickname END,
               status=CASE WHEN friends.status='blocked' THEN friends.status ELSE 'accepted' END,
               added_at=CASE WHEN friends.status='accepted' THEN friends.added_at ELSE excluded.added_at END",
            params![fp, nickname, now],
        )?;
        Ok(())
    }

    /// Remove a amizade mas PRESERVA o bloqueio. Antes, remover um amigo
    /// bloqueado apagava a linha e com ela o próprio bloqueio.
    pub fn clear_friendship(&self, fp: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE friends
                SET status = CASE WHEN blocked_at > 0 THEN 'blocked' ELSE 'removed' END,
                    requested_by = '', requested_at = 0
              WHERE fp = ?1",
            params![fp],
        )?;
        Ok(())
    }

    /// Desbloqueio explícito: zera `blocked_at` e deixa a linha neutra.
    /// Diferente de `clear_friendship`, aqui o usuário PEDIU para desbloquear.
    pub fn unblock_friend(&self, fp: &str) -> Result<()> {
        self.locked().execute(
            "UPDATE friends
                SET status='removed', blocked_at=0, requested_by='', requested_at=0
              WHERE fp=?1 AND status='blocked'",
            params![fp],
        )?;
        Ok(())
    }

    /// Só para teste: envelhece o carimbo do pedido para exercitar o TTL sem
    /// dormir um mês. Não é usada em produção.
    #[doc(hidden)]
    pub fn age_friend_request_for_test(&self, fp: &str, age_ms: i64) -> Result<()> {
        self.locked().execute(
            "UPDATE friends SET requested_at=?2 WHERE fp=?1",
            params![fp, crate::identity::now_ms() - age_ms],
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

    /// Estado completo com carimbos. `None` = nunca existiu relacionamento.
    pub fn friend_state(&self, fp: &str) -> Result<Option<FriendState>> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT fp, nickname, status, added_at, requested_by, requested_at, blocked_at
                   FROM friends WHERE fp=?1",
                params![fp],
                |r| {
                    Ok(FriendState {
                        fp: r.get(0)?,
                        nickname: r.get(1)?,
                        status: r.get(2)?,
                        added_at: r.get(3)?,
                        requested_by: r.get(4)?,
                        requested_at: r.get(5)?,
                        blocked_at: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(r)
    }

    /// Devolve um pedido recebido ao estado pendente depois de uma recusa.
    /// Sem isto, recusar apagava o histórico e o próximo pedido parecia novo.
    pub fn reject_friend(&self, fp: &str) -> Result<()> {
        let conn = self.locked();
        conn.execute(
            "UPDATE friends SET
                status = CASE WHEN status='blocked' THEN 'blocked' ELSE 'rejected' END,
                requested_by = CASE WHEN status='blocked' THEN requested_by ELSE '' END,
                requested_at = CASE WHEN status='blocked' THEN requested_at ELSE 0 END
              WHERE fp=?1",
            params![fp],
        )?;
        Ok(())
    }

    pub fn list_friends(&self, status: Option<&str>) -> Result<Vec<PeerRecord>> {
        let conn = self.locked();
        let sql = "SELECT f.fp, p.pubkey_hex, f.nickname, p.addr, f.added_at, 'friend'
                   FROM friends f LEFT JOIN peers p ON p.fp = f.fp";
        let now = crate::identity::now_ms();
        let validade = "f.status <> 'removed' AND NOT (f.status IN ('pending_in','pending_out')
                        AND f.requested_at > 0 AND f.requested_at < ?2)";
        let corte = now - crate::social::FRIEND_REQUEST_TTL_MS;
        let mut st;
        let rows = match status {
            Some(s) => {
                st = conn.prepare(&format!(
                    "{sql} WHERE f.status=?1 AND {validade} ORDER BY f.added_at DESC"
                ))?;
                st.query_map(params![s, corte], friend_row())?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            }
            None => {
                st = conn.prepare(&format!(
                    "{sql} WHERE f.status <> 'removed' AND NOT (f.status IN ('pending_in','pending_out')
                        AND f.requested_at > 0 AND f.requested_at < ?1) ORDER BY f.added_at DESC"
                ))?;
                st.query_map(params![corte], friend_row())?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            }
        };
        Ok(rows)
    }

    /// Remove a amizade sem apagar a memória do bloqueio. É o que
    /// `friend_remove`/cancelar solicitação deve chamar.
    pub fn remove_friend(&self, fp: &str) -> Result<()> {
        self.clear_friendship(fp)
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

    pub fn warn_add(
        &self,
        community_id: &str,
        fp: &str,
        reason: &str,
        actor_fp: &str,
    ) -> Result<WarnRow> {
        let row = WarnRow {
            id: format!(
                "warn-{}",
                hex::encode(
                    &blake3::hash(
                        format!(
                            "{community_id}|{fp}|{}|{}",
                            crate::identity::now_ms(),
                            actor_fp
                        )
                        .as_bytes()
                    )
                    .as_bytes()[..8]
                )
            ),
            community_id: community_id.to_string(),
            fp: fp.to_string(),
            reason: crate::names::sanitize_text(reason, 280),
            actor_fp: actor_fp.to_string(),
            created_at: crate::identity::now_ms(),
            active: true,
        };
        self.locked().execute(
            "INSERT INTO warnings(id,community_id,fp,reason,actor_fp,created_at,active)
             VALUES(?1,?2,?3,?4,?5,?6,1)",
            params![
                row.id,
                row.community_id,
                row.fp,
                row.reason,
                row.actor_fp,
                row.created_at
            ],
        )?;
        Ok(row)
    }

    pub fn warnings_for(&self, community_id: &str, fp: &str) -> Result<Vec<WarnRow>> {
        let conn = self.locked();
        let mut st = conn.prepare(
            "SELECT id,community_id,fp,reason,actor_fp,created_at,active FROM warnings
             WHERE community_id=?1 AND fp=?2 AND active=1 ORDER BY created_at DESC LIMIT 100",
        )?;
        let rows = st
            .query_map(params![community_id, fp], |r| {
                Ok(WarnRow {
                    id: r.get(0)?,
                    community_id: r.get(1)?,
                    fp: r.get(2)?,
                    reason: r.get(3)?,
                    actor_fp: r.get(4)?,
                    created_at: r.get(5)?,
                    active: r.get::<_, i64>(6)? != 0,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn warnings_clear(&self, community_id: &str, fp: &str) -> Result<usize> {
        Ok(self.locked().execute(
            "UPDATE warnings SET active=0 WHERE community_id=?1 AND fp=?2",
            params![community_id, fp],
        )?)
    }
}
