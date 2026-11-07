// Metodos de NetworkEngine: moderation.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub(super) fn spam_gate(&self, peer_fp: &str, body: &str) -> Result<()> {
        let now = crate::identity::now_ms();
        let eh_amigo = self
            .store
            .get_friend(peer_fp)
            .ok()
            .flatten()
            .map(|(_, s)| s == "accepted")
            .unwrap_or(false);
        let teto_flood = if eh_amigo { 40 } else { 10 };
        {
            let mut flood = self.spam_flood.lock().unwrap_or_else(|e| e.into_inner());
            let e = flood.entry(peer_fp.to_string()).or_insert((0, now));
            if now - e.1 > 10_000 {
                *e = (0, now);
            }
            e.0 += 1;
            if e.0 > teto_flood {
                drop(flood);
                let _ = self.store.bump_reputation(peer_fp, -5, false);
                crate::metrics::metrics().spam_rejected();
                return Err(DistorrentError::Protocol(format!(
                    "flood detectado: mensagem descartada (limite {teto_flood}/10s)"
                )));
            }
        }
        {
            let h = crate::antispam::DuplicateDetector::content_hash(peer_fp, body);
            let mut dup = self.spam_dup.lock().unwrap_or_else(|e| e.into_inner());
            let (mesma, n) = match dup.get(peer_fp) {
                Some((last_h, last_ts, reps)) => {
                    let igual = *last_h == h && now - *last_ts < 60_000;
                    (igual, if igual { reps + 1 } else { 1 })
                }
                None => (false, 1),
            };
            if mesma && n > 5 {
                drop(dup);
                let _ = self.store.bump_reputation(peer_fp, -2, false);
                crate::metrics::metrics().spam_rejected();
                return Err(DistorrentError::Protocol(
                    "mensagem repetida descartada (spam: 6+ cópias idênticas em 60s)".into(),
                ));
            }
            dup.insert(peer_fp.to_string(), (h, now, n));
        }
        if let crate::antispam::LinkVerdict::Malicious(d) = crate::antispam::check_links(body, &[])
        {
            let _ = d;
            let _ = self.store.bump_reputation(peer_fp, -8, false);
            return Err(DistorrentError::Protocol("link malicioso bloqueado".into()));
        }
        Ok(())
    }

    pub(super) fn server_rules_gate(
        &self,
        community_id: &str,
        author_fp: &str,
        body: &str,
    ) -> Result<()> {
        let rules = self.store.get_server_rules(community_id)?;
        if rules.is_shadow_banned(author_fp) {
            return Err(DistorrentError::Protocol(
                "mensagem removida pela moderação".into(),
            ));
        }
        if let Some(reason) = crate::moderation::check_text_against_rules(body, &rules) {
            let _ = self.store.bump_reputation(author_fp, -3, false);
            return Err(DistorrentError::Protocol(reason));
        }
        Ok(())
    }

    pub(super) fn validate_name_gate(
        kind: crate::names::NameKind,
        raw: &str,
        existing: &[String],
    ) -> Result<String> {
        let policy = crate::names::NamePolicy::for_kind(kind);
        let check = crate::names::validate_name(kind, raw, existing, &policy);
        if check.ok {
            return Ok(check.normalized);
        }
        Err(DistorrentError::Protocol(format!(
            "nome inválido: {}",
            check.errors.first().cloned().unwrap_or_default()
        )))
    }

    pub fn server_rules_get(&self, community_id: &str) -> Result<crate::moderation::ServerRules> {
        self.store.get_server_rules(community_id)
    }

    pub fn server_rules_set(&self, mut rules: crate::moderation::ServerRules) -> Result<()> {
        self.require_owner(&rules.community_id)?;
        rules.spam_level = match rules.spam_level.as_str() {
            "low" | "high" => rules.spam_level.clone(),
            _ => "medium".into(),
        };
        let clean_list = |xs: Vec<String>| -> Vec<String> {
            xs.into_iter()
                .map(|w| crate::names::sanitize_text(&w, 64).to_lowercase())
                .filter(|w| !w.is_empty())
                .take(200)
                .collect()
        };
        rules.banned_words = clean_list(rules.banned_words);
        rules.blocked_domains = clean_list(rules.blocked_domains);
        rules.moderators = rules.moderators.into_iter().take(50).collect();
        rules.shadow_banned = rules.shadow_banned.into_iter().take(500).collect();
        self.store.set_server_rules(&rules)?;
        let audit = crate::moderation::AuditEntry::new(
            &rules.community_id,
            &self.identity.fingerprint,
            "rules",
            "",
            "regras atualizadas",
        );
        self.store.append_audit(&audit)?;
        Ok(())
    }

    pub fn audit_list(
        &self,
        community_id: &str,
        limit: i64,
    ) -> Result<Vec<crate::moderation::AuditEntry>> {
        self.store.list_audit(community_id, limit)
    }

    pub fn reputation_get(&self, fp: &str) -> Result<(String, i32, u32)> {
        self.store.get_reputation(fp)
    }

    pub fn safety_number(&self, peer_fp: &str) -> Result<String> {
        let me = &self.identity;
        let peer = self
            .store
            .get_peer(peer_fp)?
            .ok_or_else(|| DistorrentError::Protocol("peer desconhecido".into()))?;
        Ok(crate::names::safety_number(
            &me.fingerprint,
            &me.pubkey_hex,
            peer_fp,
            &peer.pubkey_hex,
        ))
    }

    pub fn moderate(
        &self,
        community_id: &str,
        action: &str,
        target: &str,
        reason: &str,
    ) -> Result<()> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        let me = self.identity.fingerprint.clone();
        let is_owner = comm.2 == me;
        let rules = self.store.get_server_rules(community_id)?;
        let is_mod = rules.moderators.iter().any(|m| m == &me);
        let my_roles = self.store.member_roles_list(community_id, &me)?;
        let mut role_perms: i64 = 0;
        if !my_roles.is_empty() {
            if let Ok(all) = self.store.roles_list(community_id) {
                for r in all {
                    if my_roles.iter().any(|rid| rid == &r.id) {
                        role_perms |= r.permissions;
                    }
                }
            }
        }
        if target == comm.2 || target == me {
            return Err(DistorrentError::Protocol(
                "alvo inválido para moderação".into(),
            ));
        }
        let need = match action {
            "ban" | "unban" | "shadow_ban" | "unshadow" => crate::moderation::PERM_BAN,
            "mute" | "unmute" => crate::moderation::PERM_MUTE,
            "delete_msg" => crate::moderation::PERM_DELETE,
            _ => return Err(DistorrentError::Protocol("ação inválida".into())),
        };
        if !crate::moderation::can_moderate(is_owner, is_mod, role_perms, need) {
            return Err(DistorrentError::Protocol(
                "sem permissão de moderação".into(),
            ));
        }
        match action {
            "ban" => {
                self.store.set_reputation(
                    target,
                    "banned",
                    -100,
                    self.store.get_reputation(target)?.2,
                )?;
                self.store.remove_member(community_id, target).ok();
                if self.link_tx(target).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            target.to_string(),
                            SecureFrame::CommunityKicked {
                                community_id: community_id.to_string(),
                            },
                        ))
                        .ok();
                }
            }
            "unban" => {
                self.store.set_reputation(
                    target,
                    "new",
                    0,
                    self.store.get_reputation(target)?.2,
                )?;
            }
            "mute" => {
                let until = match reason.trim().parse::<i64>() {
                    Ok(ms) if ms > crate::identity::now_ms() => ms,
                    _ => crate::identity::now_ms() + MUTE_DEFAULT_MS,
                };
                self.store.mute_set(target, until)?;
                self.store.bump_reputation(target, -15, false)?;
            }
            "unmute" => {
                self.store.mute_set(target, 0)?;
                let (_, score, reports) = self.store.get_reputation(target)?;
                if score < 0 {
                    self.store.set_reputation(target, "new", 0, reports)?;
                }
            }
            "shadow_ban" => {
                let mut r = rules.clone();
                if !r.shadow_banned.iter().any(|x| x == target) {
                    r.shadow_banned.push(target.to_string());
                    self.store.set_server_rules(&r)?;
                }
            }
            "unshadow" => {
                let mut r = rules.clone();
                r.shadow_banned.retain(|x| x != target);
                self.store.set_server_rules(&r)?;
            }
            "delete_msg" => {
                let msg = self
                    .store
                    .message_by_id_raw(target)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                let owner_cid = self.store.channel_community(&msg.conv_id)?.ok_or_else(|| {
                    DistorrentError::Protocol("mensagem fora deste servidor".into())
                })?;
                if owner_cid != community_id {
                    return Err(DistorrentError::Protocol(
                        "mensagem fora deste servidor".into(),
                    ));
                }
                self.store.delete_message_by_id(target)?;
            }
            _ => unreachable!(),
        }
        let audit = crate::moderation::AuditEntry::new(community_id, &me, action, target, reason);
        self.store.append_audit(&audit)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn report_user(&self, target_fp: &str, community_id: &str, reason: &str) -> Result<()> {
        if target_fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "não é possível denunciar a si mesmo".into(),
            ));
        }
        let id = format!("rep-{}", Self::rand_hex(8));
        self.store.file_report(
            &id,
            &self.identity.fingerprint,
            target_fp,
            community_id,
            reason,
        )?;
        let open = self.store.open_reports_for(target_fp)?.len() as u32;
        let (_, score, _) = self.store.bump_reputation(target_fp, -10, true)?;
        let _ = (open, score);
        let audit = crate::moderation::AuditEntry::new(
            community_id,
            &self.identity.fingerprint,
            "report",
            target_fp,
            reason,
        );
        if self
            .store
            .get_community(community_id)
            .ok()
            .flatten()
            .is_some()
        {
            self.store.append_audit(&audit)?;
        }
        Ok(())
    }

    /// Resolve `fp`, `<@fp>` ou apelido para o fingerprint de um membro.
    pub fn resolve_member(&self, community_id: &str, raw: &str) -> Option<String> {
        let t = raw.trim();
        if t.is_empty() {
            return None;
        }
        let t = t
            .strip_prefix("<@")
            .and_then(|s| s.strip_suffix('>'))
            .unwrap_or(t);
        if let Ok(members) = self.store.list_members(community_id) {
            if let Some((fp, _, _)) = members.iter().find(|(fp, _, _)| fp == t) {
                return Some(fp.clone());
            }
            let lower = t.to_lowercase();
            if let Some((fp, _, _)) = members
                .iter()
                .find(|(_, nick, _)| nick.to_lowercase() == lower)
            {
                return Some(fp.clone());
            }
        }
        Some(t.to_string())
    }

    /// Resolve `#nome`, id de canal ou o primeiro canal de texto quando vazio.
    pub fn resolve_channel(&self, community_id: &str, raw: &str) -> Option<String> {
        let t = raw.trim().trim_start_matches('#');
        let channels = self.store.channel_rows(community_id).ok()?;
        if t.is_empty() {
            return channels
                .iter()
                .find(|c| c.kind == "text")
                .map(|c| c.id.clone());
        }
        channels
            .iter()
            .find(|c| c.id == t || c.name.eq_ignore_ascii_case(t))
            .map(|c| c.id.clone())
    }

    pub(super) fn emit_moderation(
        &self,
        community_id: &str,
        target: &str,
        kind: &str,
        until_ms: i64,
        reason: &str,
    ) {
        let _ = self.events.send(EngineEvent::ModerationApplied {
            community_id: community_id.into(),
            target_fp: target.into(),
            kind: kind.into(),
            until_ms,
            reason: reason.into(),
        });
    }
}
