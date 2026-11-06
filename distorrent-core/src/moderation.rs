use serde::{Deserialize, Serialize};

use crate::antispam::SpamLevel;
use crate::identity::now_ms;

pub const PERM_BAN: i64 = 1 << 0;
pub const PERM_MUTE: i64 = 1 << 1;
pub const PERM_DELETE: i64 = 1 << 2;
pub const PERM_MANAGE: i64 = 1 << 3;
/// Montar o servidor: criar/renomear/excluir canais e cargos.
pub const PERM_STRUCTURE: i64 = 1 << 4;
/// Limpar/purgar: apagar mensagens e trancar canais.
pub const PERM_PURGE: i64 = 1 << 5;
/// Conteúdo: reagir, fixar, thread, enquete, emoji. Não apaga nada de outro.
pub const PERM_CONTENT: i64 = 1 << 6;

/// Conjunto COMPLETO de permissões administrativas que um bot pode receber.
/// Nunca inclui nada além disso: não existe "modo deus" para bot — cada bit
/// libera um conjunto fechado de ações do core, nunca código livre.
pub const PERM_ALL: i64 =
    PERM_BAN | PERM_MUTE | PERM_DELETE | PERM_MANAGE | PERM_STRUCTURE | PERM_PURGE | PERM_CONTENT;

/// Atalhos de exibição/atribuição no painel.
pub const PERM_BOT_LABELS: &[(i64, &str)] = &[
    (PERM_BAN, "banir"),
    (PERM_MUTE, "silenciar"),
    (PERM_DELETE, "apagar mensagens"),
    (PERM_MANAGE, "gerenciar membros"),
    (PERM_STRUCTURE, "montar o servidor"),
    (PERM_PURGE, "limpar canais"),
    (PERM_CONTENT, "conteúdo e organização"),
];

/// Uma ação que o bot pode pedir ao core. `args` é a ordem posicional que a
/// DSL, a ponte e o painel usam — não há argumento nomeado escondido.
pub struct BotActionDef {
    pub action: &'static str,
    pub perm: i64,
    pub args: &'static str,
    pub label: &'static str,
}

/// Registro ÚNICO das ações de bot. O painel, a ponte e a DSL leem daqui; ação
/// nova entra nesta lista, nunca numa cadeia de `match` paralela que diverge.
pub const BOT_ACTIONS: &[BotActionDef] = &[
    // --- moderação ---
    BotActionDef {
        action: "ban",
        perm: PERM_BAN,
        args: "<membro> [motivo]",
        label: "Banir membro",
    },
    BotActionDef {
        action: "unban",
        perm: PERM_BAN,
        args: "<membro>",
        label: "Desbanir membro",
    },
    BotActionDef {
        action: "kick",
        perm: PERM_MANAGE,
        args: "<membro> [motivo]",
        label: "Expulsar membro",
    },
    BotActionDef {
        action: "mute",
        perm: PERM_MUTE,
        args: "<membro> [minutos] [motivo]",
        label: "Silenciar por N minutos",
    },
    BotActionDef {
        action: "unmute",
        perm: PERM_MUTE,
        args: "<membro> [motivo]",
        label: "Remover silêncio",
    },
    BotActionDef {
        action: "warn",
        perm: PERM_MUTE,
        args: "<membro> [motivo]",
        label: "Registrar aviso",
    },
    BotActionDef {
        action: "warnings",
        perm: PERM_MUTE,
        args: "<membro>",
        label: "Listar avisos",
    },
    BotActionDef {
        action: "warnings_clear",
        perm: PERM_MUTE,
        args: "<membro>",
        label: "Limpar avisos",
    },
    BotActionDef {
        action: "delete_msg",
        perm: PERM_DELETE,
        args: "<id-da-mensagem>",
        label: "Apagar uma mensagem",
    },
    BotActionDef {
        action: "clear",
        perm: PERM_PURGE,
        args: "[#canal] [N]",
        label: "Apagar N mensagens",
    },
    BotActionDef {
        action: "lock",
        perm: PERM_PURGE,
        args: "[#canal]",
        label: "Trancar canal",
    },
    BotActionDef {
        action: "unlock",
        perm: PERM_PURGE,
        args: "[#canal]",
        label: "Destrancar canal",
    },
    BotActionDef {
        action: "slowmode",
        perm: PERM_PURGE,
        args: "[#canal] [segundos]",
        label: "Definir slowmode (s)",
    },
    // --- estrutura ---
    BotActionDef {
        action: "channel_create",
        perm: PERM_STRUCTURE,
        args: "<nome> [text|voice|video|forum]",
        label: "Criar canal",
    },
    BotActionDef {
        action: "channel_delete",
        perm: PERM_STRUCTURE,
        args: "[#canal]",
        label: "Excluir canal",
    },
    BotActionDef {
        action: "channel_edit",
        perm: PERM_STRUCTURE,
        args: "<canal> <novo-nome>",
        label: "Renomear canal",
    },
    BotActionDef {
        action: "channel_topic",
        perm: PERM_STRUCTURE,
        args: "<canal> <tópico>",
        label: "Mudar tópico do canal",
    },
    BotActionDef {
        action: "channel_category",
        perm: PERM_STRUCTURE,
        args: "<canal> <categoria>",
        label: "Mudar categoria do canal",
    },
    BotActionDef {
        action: "role_create",
        perm: PERM_STRUCTURE,
        args: "<nome> [#RRGGBB]",
        label: "Criar cargo",
    },
    BotActionDef {
        action: "role_delete",
        perm: PERM_STRUCTURE,
        args: "<cargo>",
        label: "Excluir cargo",
    },
    BotActionDef {
        action: "role_edit",
        perm: PERM_STRUCTURE,
        args: "<cargo> [novo-nome] [#RRGGBB]",
        label: "Renomear/recolorir cargo",
    },
    BotActionDef {
        action: "role_assign",
        perm: PERM_MANAGE,
        args: "<cargo> <membro>",
        label: "Dar cargo a membro",
    },
    BotActionDef {
        action: "role_unassign",
        perm: PERM_MANAGE,
        args: "<cargo> <membro>",
        label: "Tirar cargo de membro",
    },
    BotActionDef {
        action: "server_edit",
        perm: PERM_STRUCTURE,
        args: "<novo-nome>",
        label: "Renomear servidor",
    },
    BotActionDef {
        action: "server_meta",
        perm: PERM_STRUCTURE,
        args: "[descrição]",
        label: "Mudar descrição do servidor",
    },
    BotActionDef {
        action: "server_public",
        perm: PERM_STRUCTURE,
        args: "<on|off>",
        label: "Abrir/fechar entrada pública",
    },
    BotActionDef {
        action: "make_invite",
        perm: PERM_STRUCTURE,
        args: "[horas] [fp-alvo]",
        label: "Gerar convite",
    },
    // --- conteúdo ---
    BotActionDef {
        action: "react",
        perm: PERM_CONTENT,
        args: "<id-da-mensagem> <emoji>",
        label: "Reagir a mensagem",
    },
    BotActionDef {
        action: "pin",
        perm: PERM_CONTENT,
        args: "<id-da-mensagem>",
        label: "Fixar mensagem",
    },
    BotActionDef {
        action: "unpin",
        perm: PERM_CONTENT,
        args: "<id-da-mensagem>",
        label: "Desafixar mensagem",
    },
    BotActionDef {
        action: "thread_create",
        perm: PERM_CONTENT,
        args: "<nome> [tag1,tag2]",
        label: "Criar thread",
    },
    BotActionDef {
        action: "thread_archive",
        perm: PERM_CONTENT,
        args: "<id-da-thread> [on|off]",
        label: "Arquivar/desarquivar thread",
    },
    BotActionDef {
        action: "poll_create",
        perm: PERM_CONTENT,
        args: "<pergunta> | <opção> | <opção>",
        label: "Criar enquete",
    },
    BotActionDef {
        action: "emoji_add",
        perm: PERM_CONTENT,
        args: "<nome> <emoji>",
        label: "Adicionar emoji do servidor",
    },
    BotActionDef {
        action: "emoji_del",
        perm: PERM_CONTENT,
        args: "<nome>",
        label: "Remover emoji do servidor",
    },
    BotActionDef {
        action: "typing",
        perm: PERM_CONTENT,
        args: "",
        label: "Mostrar \"digitando\"",
    },
    // --- leitura (sem permissão) ---
    BotActionDef {
        action: "userinfo",
        perm: 0,
        args: "<membro>",
        label: "Informações do membro",
    },
    BotActionDef {
        action: "serverinfo",
        perm: 0,
        args: "",
        label: "Informações do servidor",
    },
    BotActionDef {
        action: "ping",
        perm: 0,
        args: "",
        label: "Latência do bot",
    },
    BotActionDef {
        action: "audit",
        perm: 0,
        args: "[N]",
        label: "Últimas ações da auditoria",
    },
    BotActionDef {
        action: "bans",
        perm: 0,
        args: "",
        label: "Membros banidos",
    },
    BotActionDef {
        action: "timeouts",
        perm: 0,
        args: "",
        label: "Membros silenciados",
    },
    BotActionDef {
        action: "channels",
        perm: 0,
        args: "",
        label: "Listar canais",
    },
    BotActionDef {
        action: "roles",
        perm: 0,
        args: "",
        label: "Listar cargos",
    },
];

pub fn bot_action(action: &str) -> Option<&'static BotActionDef> {
    BOT_ACTIONS.iter().find(|d| d.action == action.trim())
}

/// Cada ação administrativa exige uma permissão explícita do bot.
pub fn perm_for_action(action: &str) -> Option<i64> {
    bot_action(action).map(|d| d.perm)
}

/// `PERM_MANAGE` era o bit único que liberava tudo antes da separação. Quem já
/// tinha esse bit continua podendo tudo, senão a atualização tiraria poder de
/// bots que já estavam configurados.
///
/// Isto é uma exceção HERDADA, não a regra: a UI precisa espelhar exatamente
/// aqui (`permAllows` em `botCommands.ts`) ou o painel diz "sem permissão"
/// enquanto a ponte executa. O rótulo do bit avisa o alcance na aba
/// Permissões — conceder `manage` num bot novo dá estrutura e purga junto.
pub fn perm_satisfied(granted: i64, need: i64) -> bool {
    if need == 0 {
        return true;
    }
    if (granted & need) != 0 {
        return true;
    }
    let legado = PERM_STRUCTURE | PERM_PURGE | PERM_MANAGE;
    (need & legado) != 0 && (granted & PERM_MANAGE) != 0
}

/// Bit que o bot pode repassar a um membro ao dar cargo.
///
/// Sem isto, `role_assign` (que só exige `PERM_MANAGE`) distribuía um cargo com
/// `PERM_BAN`/`PERM_MUTE` criado pelo dono e o bot transferia poder de
/// moderação para qualquer um — escalada lateral, não auto-concessão.
pub fn perm_can_grant(granted: i64, role_perms: i64) -> bool {
    let extra = role_perms & PERM_ALL & !granted;
    // `manage` herdado continua podendo os bits que ele já implica.
    if extra == 0 {
        return true;
    }
    let legado = PERM_STRUCTURE | PERM_PURGE | PERM_MANAGE;
    (granted & PERM_MANAGE) != 0 && (extra & !legado) == 0
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerRules {
    pub community_id: String,
    pub spam_level: String,
    pub banned_words: Vec<String>,
    pub blocked_domains: Vec<String>,
    pub moderators: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AuditEntry {
    pub id: String,
    pub community_id: String,
    pub actor_fp: String,
    pub action: String,
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

pub fn check_text_against_rules(body: &str, rules: &ServerRules) -> Option<String> {
    let skel = crate::names::skeleton(body);
    for w in &rules.banned_words {
        let ws = crate::names::skeleton(w);
        if ws.len() >= 3 && skel.contains(&ws) {
            return Some(format!("palavra bloqueada neste servidor: {w}"));
        }
    }
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
// Seção 1: fim
