//! Moderação por servidor — Storm camada de segurança.
//!
//! Cada servidor define `ServerRules` (nível anti-spam, palavras próprias,
//! permissões, shadow-ban). Ações de moderação geram `AuditEntry`
//! persistida no SQLite (tabela `audit_log`, migration v5).
//!
//! REGRA DE OURO: toda decisão é validada no CORE. A UI apenas reflete.

use serde::{Deserialize, Serialize};

use crate::antispam::SpamLevel;
use crate::identity::now_ms;

pub const PERM_BAN: i64 = 1 << 0;
pub const PERM_MUTE: i64 = 1 << 1;
pub const PERM_DELETE: i64 = 1 << 2;
pub const PERM_MANAGE: i64 = 1 << 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerRules {
    pub community_id: String,
    pub spam_level: String, // "low" | "medium" | "high"
    pub banned_words: Vec<String>,
    pub blocked_domains: Vec<String>,
    /// fps com poder de moderação (além do dono)
    pub moderators: Vec<String>,
    /// shadow-ban: lista de fps que acham que postam, mas ninguém vê
    pub shadow_banned: Vec<String>,
    pub updated_at: i64,
}

impl ServerRules {
    pub fn fresh(community_id: &str) -> Self {
        Self {
            community_id: community_id.to_string(),
            spam_level: "medium".into(),
            banned_words: vec![],
            blocked_domains: vec![],
            moderators: vec![],
            shadow_banned: vec![],
            updated_at: now_ms(),
        }
    }
    pub fn level(&self) -> SpamLevel {
        SpamLevel::from_str(&self.spam_level)
    }
    pub fn is_shadow_banned(&self, fp: &str) -> bool {
        self.shadow_banned.iter().any(|x| x == fp)
    }
}

/// Uma ação de moderação auditável. `reason` é sanitizada (sem HTML).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditEntry {
    pub id: String,
    pub community_id: String,
    pub actor_fp: String,
    pub action: String, // "ban" | "unban" | "mute" | "unmute" | "delete" | "shadow_ban" | "rules"
    pub target_fp: String,
    pub reason: String,
    pub created_at: i64,
}

impl AuditEntry {
    pub fn new(
        community_id: &str,
        actor_fp: &str,
        action: &str,
        target_fp: &str,
        reason: &str,
    ) -> Self {
        let clean = crate::names::escape_html(&crate::names::sanitize_text(reason, 280));
        let mut h = blake3::Hasher::new();
        h.update(b"storm/audit|");
        h.update(community_id.as_bytes());
        h.update(actor_fp.as_bytes());
        h.update(action.as_bytes());
        h.update(target_fp.as_bytes());
        h.update(&now_ms().to_be_bytes());
        let mut rnd = [0u8; 8];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut rnd);
        h.update(&rnd);
        Self {
            id: hex::encode(&h.finalize().as_bytes()[..16]),
            community_id: community_id.to_string(),
            actor_fp: actor_fp.to_string(),
            action: action.to_string(),
            target_fp: target_fp.to_string(),
            reason: clean,
            created_at: now_ms(),
        }
    }
}

/// Quem pode moderar? Dono sempre; moderador listado; ou permissão por cargo.
///
/// `is_owner`: chamador é dono do servidor.
/// `is_moderator`: está em `rules.moderators`.
/// `role_perms`: bitmask somado dos cargos do chamador.
pub fn can_moderate(is_owner: bool, is_moderator: bool, role_perms: i64, needed: i64) -> bool {
    if is_owner {
        return true;
    }
    if is_moderator {
        return true;
    }
    (role_perms & needed) == needed
}

pub fn can_ban(is_owner: bool, is_moderator: bool, role_perms: i64) -> bool {
    can_moderate(is_owner, is_moderator, role_perms, PERM_BAN)
}

pub fn can_mute(is_owner: bool, is_moderator: bool, role_perms: i64) -> bool {
    can_moderate(is_owner, is_moderator, role_perms, PERM_MUTE)
}

pub fn can_delete(is_owner: bool, is_moderator: bool, role_perms: i64) -> bool {
    can_moderate(is_owner, is_moderator, role_perms, PERM_DELETE)
}

/// Valida texto de canal contra as regras do servidor.
/// Retorna `None` se OK, `Some(motivo)` se bloquear.
pub fn check_text_against_rules(body: &str, rules: &ServerRules) -> Option<String> {
    // palavra proibida do servidor (skeleton p/ pegar leet/homoglifo)
    let skel = crate::names::skeleton(body);
    for w in &rules.banned_words {
        let ws = crate::names::skeleton(w);
        if ws.len() >= 3 && skel.contains(&ws) {
            return Some(format!("palavra bloqueada neste servidor: {w}"));
        }
    }
    // domínios bloqueados
    match crate::antispam::check_links(body, &rules.blocked_domains) {
        crate::antispam::LinkVerdict::Malicious(d) => {
            return Some(format!("link bloqueado neste servidor: {d}"));
        }
        crate::antispam::LinkVerdict::Shortener(_)
            if rules.level() == crate::antispam::SpamLevel::High =>
        {
            return Some("encurtadores bloqueados neste servidor".to_string());
        }
        _ => {}
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dono_pode_tudo_membro_nao() {
        assert!(can_ban(true, false, 0));
        assert!(!can_ban(false, false, 0));
        assert!(can_ban(false, true, 0));
        assert!(can_ban(false, false, PERM_BAN));
        assert!(!can_mute(false, false, PERM_BAN));
    }

    #[test]
    fn regras_bloqueiam_palavra_e_dominio() {
        let mut r = ServerRules::fresh("c1");
        r.banned_words = vec!["spoiler".into()];
        r.blocked_domains = vec!["evil.gg".into()];
        assert!(check_text_against_rules("que spoiler feio", &r).is_some());
        // leet também pega
        assert!(check_text_against_rules("que sp0iler feio", &r).is_some());
        assert!(check_text_against_rules("veja https://evil.gg/a", &r).is_some());
        assert!(check_text_against_rules("bom dia a todos", &r).is_none());
    }

    #[test]
    fn auditoria_sanitiza_motivo() {
        let e = AuditEntry::new("c1", "actor", "ban", "alvo", "<script>x</script> flood");
        assert!(!e.reason.contains('<'));
        assert!(!e.id.is_empty());
    }

    #[test]
    fn shadow_ban_detectado() {
        let mut r = ServerRules::fresh("c1");
        r.shadow_banned = vec!["fpX".into()];
        assert!(r.is_shadow_banned("fpX"));
        assert!(!r.is_shadow_banned("fpY"));
    }
}
