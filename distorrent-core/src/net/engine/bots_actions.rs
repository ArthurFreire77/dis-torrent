// Interpretador de comandos de bot (bot_action_in): maior trecho do modulo
// de bots. Fica em arquivo proprio para nenhum arquivo passar de 1.000 linhas.

use super::*;

impl NetworkEngine {
    /// Igual a [`Self::bot_admin`], mas com o canal de contexto. Ações que
    /// dependem de canal (`poll_create`, `thread_create`, `typing`) usam este
    /// valor; sem ele, caem no primeiro canal de texto do servidor.
    #[allow(clippy::too_many_arguments)]
    pub fn bot_action_in(
        &self,
        community_id: &str,
        bot_id: &str,
        action: &str,
        target: &str,
        reason: &str,
        number: Option<i64>,
        channel: Option<&str>,
    ) -> Result<String> {
        self.require_owner(community_id)?;
        let Some(bot) = self
            .store
            .bots_list(community_id)?
            .into_iter()
            .find(|b| b.id == bot_id)
        else {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        };
        if !bot.online {
            return Err(DistorrentError::Protocol(
                "bot está offline — ative-o no painel".into(),
            ));
        }
        let need = crate::moderation::perm_for_action(action)
            .ok_or_else(|| DistorrentError::Protocol(format!("ação inválida: {action}")))?;
        if !crate::moderation::perm_satisfied(bot.perms, need) {
            return Err(DistorrentError::Protocol(format!(
                "o bot não tem permissão para `{action}` — conceda no painel de Bots"
            )));
        }
        let (_, name, owner) = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        let target = target.trim();
        let reason = crate::names::sanitize_text(reason.trim(), 280);
        let needs_target = matches!(
            action,
            "ban"
                | "unban"
                | "kick"
                | "mute"
                | "unmute"
                | "warn"
                | "warnings"
                | "warnings_clear"
                | "userinfo"
        );
        if needs_target && target.is_empty() {
            return Err(DistorrentError::Protocol("informe o membro alvo".into()));
        }
        let resolved = if target.is_empty() {
            None
        } else {
            self.resolve_member(community_id, target)
        };
        if needs_target {
            let Some(fp) = resolved.clone() else {
                return Err(DistorrentError::Protocol(format!(
                    "membro `{target}` não encontrado neste servidor"
                )));
            };
            if fp == owner {
                return Err(DistorrentError::Protocol(
                    "o dono do servidor não pode ser alvo de moderação".into(),
                ));
            }
        }
        let fp = resolved.unwrap_or_else(|| target.to_string());
        // Leitura não suja a auditoria: só o que muda estado vira registro.
        if !matches!(
            action,
            "userinfo"
                | "serverinfo"
                | "ping"
                | "audit"
                | "bans"
                | "timeouts"
                | "channels"
                | "roles"
        ) {
            self.store
                .append_audit(&crate::moderation::AuditEntry::new(
                    community_id,
                    &bot.id,
                    &format!("bot:{action}"),
                    &fp,
                    &reason,
                ))?;
        }
        match action {
            "ban" => {
                let until = number.unwrap_or(0).max(0);
                self.store
                    .ban_set(community_id, &fp, &reason, &bot.id, until)?;
                self.store.remove_member(community_id, &fp).ok();
                self.store.member_roles_remove_all(community_id, &fp)?;
                if self.link_tx(&fp).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp.clone(),
                            SecureFrame::CommunityKicked {
                                community_id: community_id.to_string(),
                            },
                        ))
                        .ok();
                }
                self.emit_moderation(community_id, &fp, "ban", until, &reason);
                self.broadcast_community_state(community_id);
                Ok(format!("{fp} foi banido do servidor"))
            }
            "unban" => {
                self.store.ban_remove(community_id, &fp)?;
                Ok(format!("{fp} não está mais banido"))
            }
            "kick" => {
                if self
                    .store
                    .list_members(community_id)?
                    .iter()
                    .all(|(m, _, _)| m != &fp)
                {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                }
                self.store.remove_member(community_id, &fp)?;
                self.store.member_roles_remove_all(community_id, &fp)?;
                if self.link_tx(&fp).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            fp.clone(),
                            SecureFrame::CommunityKicked {
                                community_id: community_id.to_string(),
                            },
                        ))
                        .ok();
                }
                self.emit_moderation(community_id, &fp, "kick", 0, &reason);
                self.broadcast_community_state(community_id);
                Ok(format!("{fp} foi expulso do servidor"))
            }
            "mute" => {
                let mins = number.unwrap_or(10).clamp(1, 10_080);
                let until = crate::identity::now_ms() + mins * 60_000;
                self.store
                    .timeout_set(community_id, &fp, until, &reason, &bot.id)?;
                self.emit_moderation(community_id, &fp, "mute", until, &reason);
                Ok(format!("{fp} silenciado por {mins} min"))
            }
            "unmute" => {
                self.store.timeout_clear(community_id, &fp)?;
                self.emit_moderation(community_id, &fp, "unmute", 0, &reason);
                Ok(format!("{fp} pode falar de novo"))
            }
            "warn" => {
                self.store.warn_add(community_id, &fp, &reason, &bot.id)?;
                let total = self.store.warnings_for(community_id, &fp)?.len();
                Ok(format!("{fp} recebeu um aviso — total: {total}"))
            }
            "warnings" => {
                let list = self.store.warnings_for(community_id, &fp)?;
                if list.is_empty() {
                    return Ok(format!("{fp} não tem avisos ativos"));
                }
                let mut out = format!("{fp}: {} aviso(s)", list.len());
                for w in list.iter().take(5) {
                    out.push_str(&format!(
                        "\n• {}",
                        if w.reason.is_empty() {
                            "(sem motivo)"
                        } else {
                            &w.reason
                        }
                    ));
                }
                Ok(out)
            }
            "clear" => {
                let n = number.unwrap_or(10).clamp(1, 100);
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let ids = self.store.recent_message_ids(&conv, n)?;
                let mut removed = 0usize;
                for id in ids {
                    if self.social_delete(&conv, &id).is_ok() {
                        removed += 1;
                    }
                }
                Ok(format!("{removed} mensagem(ns) apagada(s) em {conv}"))
            }
            "lock" | "unlock" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let slow = self.store.channel_cfg_slowmode(&conv).unwrap_or(0);
                self.store
                    .channel_cfg_set(&conv, slow, false, action == "lock")?;
                Ok(if action == "lock" {
                    format!("canal {conv} trancado")
                } else {
                    format!("canal {conv} destrancado")
                })
            }
            "slowmode" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let secs = number.unwrap_or(0).clamp(0, 21_600);
                self.store.channel_cfg_set(&conv, secs, false, false)?;
                Ok(if secs == 0 {
                    format!("slowmode desligado em {conv}")
                } else {
                    format!("slowmode de {secs}s em {conv}")
                })
            }
            "channel_create" => {
                let name = target;
                if name.trim().is_empty() {
                    return Err(DistorrentError::Protocol(
                        "informe o nome do canal (ex.: `avisos`)".into(),
                    ));
                }
                let kind = if reason.trim().is_empty() {
                    "text"
                } else {
                    reason.trim()
                };
                let row = self.channel_create(community_id, name, "", "", kind)?;
                Ok(format!("canal #{} criado", row.name))
            }
            "channel_delete" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                self.channel_delete(community_id, &conv)?;
                Ok(format!("canal {conv} excluído"))
            }
            "role_create" => {
                let name = target;
                if name.trim().is_empty() {
                    return Err(DistorrentError::Protocol("informe o nome do cargo".into()));
                }
                // Cor vem em `reason` (opcional, formato #RRGGBB).
                let color = if reason.trim().starts_with('#') {
                    reason.trim()
                } else {
                    ""
                };
                let row = self.role_create(community_id, name, color, 0, false, true)?;
                Ok(format!("cargo {} criado", row.name))
            }
            "role_delete" => {
                let raw = target.trim();
                if raw.is_empty() {
                    return Err(DistorrentError::Protocol("informe o cargo".into()));
                }
                let role_id = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == raw || r.name.eq_ignore_ascii_case(raw))
                    .map(|r| r.id)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{raw}` não existe"))
                    })?;
                self.role_delete(community_id, &role_id)?;
                Ok(format!("cargo {raw} excluído"))
            }
            "role_assign" => {
                // `target` = cargo, `reason` = membro. Assim o mesmo comando serve para dar e tirar e o alvo é explícito.
                let role_raw = target.trim();
                let member_raw = reason.trim();
                if role_raw.is_empty() || member_raw.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /role_assign <cargo> <membro>".into(),
                    ));
                }
                let role_id = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == role_raw || r.name.eq_ignore_ascii_case(role_raw))
                    .map(|r| r.id)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{role_raw}` não existe"))
                    })?;
                // O bot só distribui o poder que ele próprio tem: um cargo com
                // `ban`/`mute` criado pelo dono não pode ser dado por um bot que
                // só recebeu `manage`, senão ele escala moderação de lado.
                let role_perms = self
                    .store
                    .roles_list(community_id)?
                    .iter()
                    .find(|r| r.id == role_id)
                    .map(|r| r.permissions)
                    .unwrap_or(0);
                if !crate::moderation::perm_can_grant(bot.perms, role_perms) {
                    return Err(DistorrentError::Protocol(
                        "o bot não pode dar um cargo com permissões que ele não tem".into(),
                    ));
                }
                let Some(member) = self.resolve_member(community_id, member_raw) else {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                };
                if self
                    .store
                    .list_members(community_id)?
                    .iter()
                    .all(|(m, _, _)| m != &member)
                {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                }
                self.member_assign_role(community_id, &member, &role_id)?;
                Ok(format!("cargo {role_raw} dado a {member}"))
            }
            "role_unassign" => {
                let role_raw = target.trim();
                let member_raw = reason.trim();
                if role_raw.is_empty() || member_raw.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /role_unassign <cargo> <membro>".into(),
                    ));
                }
                let role_id = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == role_raw || r.name.eq_ignore_ascii_case(role_raw))
                    .map(|r| r.id)
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{role_raw}` não existe"))
                    })?;
                let Some(member) = self.resolve_member(community_id, member_raw) else {
                    return Err(DistorrentError::Protocol("membro inexistente".into()));
                };
                self.member_unassign_role(community_id, &member, &role_id)?;
                Ok(format!("cargo {role_raw} removido de {member}"))
            }
            "channel_edit" => {
                // `target` = canal, `reason` = novo nome.
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                let new_name = reason.trim();
                if new_name.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /channel_edit <canal> <novo-nome>".into(),
                    ));
                }
                self.channel_rename(community_id, &conv, new_name)?;
                Ok(format!("canal {conv} renomeado para {new_name}"))
            }
            "server_edit" => {
                if target.trim().is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /server_edit <novo-nome>".into(),
                    ));
                }
                self.community_rename(community_id, target)?;
                Ok(format!("servidor renomeado para {}", target.trim()))
            }
            "userinfo" => {
                let (mfp, nick, role) = self
                    .store
                    .list_members(community_id)?
                    .into_iter()
                    .find(|(m, _, _)| m == &fp)
                    .ok_or_else(|| DistorrentError::Protocol("membro inexistente".into()))?;
                let role_ids = self.store.member_roles_list(community_id, &mfp)?;
                let names: Vec<String> = self
                    .store
                    .roles_list(community_id)
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|r| role_ids.iter().any(|id| id == &r.id))
                    .map(|r| r.name)
                    .collect();
                let warns = self.store.warnings_for(community_id, &mfp)?.len();
                Ok(format!(
                    "**{nick}** (`{mfp}`)\nfunção: {role}\ncargos: {}\navisos: {warns}",
                    if names.is_empty() {
                        "nenhum".to_string()
                    } else {
                        names.join(", ")
                    }
                ))
            }
            "serverinfo" => {
                let channels = self.store.channel_rows(community_id)?.len();
                let members = self.store.list_members(community_id)?.len();
                let roles = self.store.roles_list(community_id)?.len();
                let bots = self.store.bots_list(community_id)?.len();
                let public = self.store.community_is_public(community_id)?;
                Ok(format!(
                "**{name}**\ndono: {owner}\ncanais: {channels}\nmembros: {members}\ncargos: {roles}\nbots: {bots}\nentrada: {}",
                if public { "pública" } else { "por convite" }
            ))
            }
            "ping" => Ok("pong".to_string()),
            "audit" => {
                let n = number.unwrap_or(10).clamp(1, 50);
                let rows = self.store.list_audit(community_id, n)?;
                if rows.is_empty() {
                    return Ok("auditoria vazia".into());
                }
                let mut out = format!("{} ação(ões) recentes:", rows.len());
                for a in rows.iter().take(n as usize) {
                    out.push_str(&format!(
                        "\n• {} → {} ({})",
                        a.action,
                        if a.target_fp.is_empty() {
                            "—"
                        } else {
                            &a.target_fp
                        },
                        if a.reason.is_empty() {
                            "sem motivo"
                        } else {
                            &a.reason
                        }
                    ));
                }
                Ok(out)
            }
            "bans" => {
                let rows = self.store.ban_list(community_id)?;
                if rows.is_empty() {
                    return Ok("ninguém está banido".into());
                }
                let mut out = format!("{} banido(s):", rows.len());
                for b in rows.iter().take(20) {
                    out.push_str(&format!("\n• {}", b.fp));
                }
                Ok(out)
            }
            "timeouts" => {
                let rows = self.store.timeout_list(community_id)?;
                if rows.is_empty() {
                    return Ok("ninguém está silenciado".into());
                }
                let mut out = format!("{} silenciado(s):", rows.len());
                for b in rows.iter().take(20) {
                    out.push_str(&format!("\n• {}", b.fp));
                }
                Ok(out)
            }
            "channels" => {
                let rows = self.store.channel_rows(community_id)?;
                let mut out = format!("{} canal(is):", rows.len());
                for c in rows.iter().take(60) {
                    out.push_str(&format!("\n• #{} ({})", c.name, c.kind));
                }
                Ok(out)
            }
            "roles" => {
                let rows = self.store.roles_list(community_id)?;
                let mut out = format!("{} cargo(s):", rows.len());
                for r in rows.iter().take(60) {
                    out.push_str(&format!("\n• {} {}", r.name, r.color));
                }
                Ok(out)
            }
            "warnings_clear" => {
                let n = self.store.warnings_clear(community_id, &fp)?;
                Ok(format!("{n} aviso(s) removido(s) de {fp}"))
            }
            "delete_msg" => {
                let msg_id = target.trim();
                if msg_id.is_empty() {
                    return Err(DistorrentError::Protocol("informe o id da mensagem".into()));
                }
                let alvo = self
                    .store
                    .message_by_id(msg_id)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                self.social_delete(&alvo.conv_id, msg_id)?;
                Ok(format!("mensagem {msg_id} apagada"))
            }
            "react" => {
                let msg_id = target.trim();
                let emoji = reason.trim();
                if msg_id.is_empty() || emoji.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /react <id-da-mensagem> <emoji>".into(),
                    ));
                }
                let alvo = self
                    .store
                    .message_by_id(msg_id)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                let added = self.social_react(&alvo.conv_id, msg_id, emoji)?;
                Ok(format!(
                    "reação {emoji} {} em {msg_id}",
                    if added { "adicionada" } else { "removida" }
                ))
            }
            "pin" | "unpin" => {
                let msg_id = target.trim();
                if msg_id.is_empty() {
                    return Err(DistorrentError::Protocol("informe o id da mensagem".into()));
                }
                let alvo = self
                    .store
                    .message_by_id(msg_id)?
                    .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
                let pinned = action == "pin";
                self.social_pin(&alvo.conv_id, msg_id, pinned)?;
                Ok(format!(
                    "mensagem {msg_id} {}",
                    if pinned { "fixada" } else { "desafixada" }
                ))
            }
            "channel_topic" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                self.channel_set_topic(community_id, &conv, reason.trim())?;
                Ok(format!("tópico de {conv} atualizado"))
            }
            "channel_category" => {
                let Some(conv) = self.resolve_channel(community_id, target) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal (#nome ou id)".into(),
                    ));
                };
                if reason.trim().is_empty() {
                    return Err(DistorrentError::Protocol("informe a categoria".into()));
                }
                self.channel_set_category(community_id, &conv, reason.trim())?;
                Ok(format!("categoria de {conv} agora é {}", reason.trim()))
            }
            "role_edit" => {
                let raw = target.trim();
                if raw.is_empty() {
                    return Err(DistorrentError::Protocol("informe o cargo".into()));
                }
                let role = self
                    .store
                    .roles_list(community_id)?
                    .into_iter()
                    .find(|r| r.id == raw || r.name.eq_ignore_ascii_case(raw))
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("cargo `{raw}` não existe"))
                    })?;
                // Cor é o token `#RRGGBB`; o resto (se houver) é o novo nome.
                let mut new_name = String::new();
                let mut new_color = String::new();
                for tok in reason.split_whitespace() {
                    if tok.starts_with('#') && tok.len() == 7 {
                        new_color = tok.to_string();
                    } else {
                        if !new_name.is_empty() {
                            new_name.push(' ');
                        }
                        new_name.push_str(tok);
                    }
                }
                self.role_update(
                    community_id,
                    &role.id,
                    if new_name.is_empty() {
                        None
                    } else {
                        Some(new_name.as_str())
                    },
                    if new_color.is_empty() {
                        None
                    } else {
                        Some(new_color.as_str())
                    },
                    None,
                    None,
                    None,
                    None,
                )?;
                Ok(format!("cargo {} atualizado", role.name))
            }
            "server_meta" => {
                let desc = target.trim();
                self.community_set_meta(community_id, Some(desc), None, None)?;
                Ok("descrição do servidor atualizada".to_string())
            }
            "server_public" => {
                let on = matches!(
                    target.trim().to_ascii_lowercase().as_str(),
                    "on" | "1" | "true" | "sim" | "publico" | "público"
                );
                self.community_set_public(community_id, on)?;
                Ok(if on {
                    "entrada pública ligada".to_string()
                } else {
                    "entrada pública desligada".to_string()
                })
            }
            "make_invite" => {
                let horas = number.unwrap_or(24).clamp(1, 24 * 30);
                let alvo = if target.trim().is_empty() {
                    "000000000000".to_string()
                } else {
                    self.resolve_member(community_id, target).ok_or_else(|| {
                        DistorrentError::Protocol(format!(
                            "membro `{target}` não encontrado neste servidor"
                        ))
                    })?
                };
                let token = self.make_invite(community_id, &alvo, horas * 3_600_000)?;
                Ok(format!("convite válido por {horas}h: {token}"))
            }
            "thread_create" => {
                let Some(parent) = self.resolve_channel(community_id, channel.unwrap_or("")) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal onde a thread nasce".into(),
                    ));
                };
                let nome = target.trim();
                if nome.is_empty() {
                    return Err(DistorrentError::Protocol("informe o nome da thread".into()));
                }
                let t = self.social_thread_create(
                    community_id,
                    &parent,
                    nome,
                    "thread",
                    reason.trim(),
                )?;
                Ok(format!("thread {} criada em {parent}", t.name))
            }
            "thread_archive" => {
                let id = target.trim();
                if id.is_empty() {
                    return Err(DistorrentError::Protocol("informe o id da thread".into()));
                }
                let archived = !matches!(
                    reason.trim().to_ascii_lowercase().as_str(),
                    "off" | "0" | "false" | "nao" | "não" | "abrir"
                );
                self.social_thread_archive(id, archived)?;
                Ok(format!(
                    "thread {id} {}",
                    if archived { "arquivada" } else { "reaberta" }
                ))
            }
            "poll_create" => {
                let Some(conv) = self.resolve_channel(community_id, channel.unwrap_or("")) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal da enquete".into(),
                    ));
                };
                let question = target.trim();
                let options: Vec<String> = reason
                    .split('|')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if question.is_empty() || options.len() < 2 {
                    return Err(DistorrentError::Protocol(
                        "uso: /poll <pergunta> | <opção> | <opção>".into(),
                    ));
                }
                let p = self.social_poll_create(
                    community_id,
                    &conv,
                    question,
                    options,
                    false,
                    crate::identity::now_ms() + 24 * 3_600_000,
                )?;
                Ok(format!("enquete criada: {}", p.question))
            }
            "emoji_add" => {
                let nome = target.trim();
                let ch = reason.trim();
                if nome.is_empty() || ch.is_empty() {
                    return Err(DistorrentError::Protocol(
                        "uso: /emoji_add <nome> <emoji>".into(),
                    ));
                }
                let id = format!("em_{}", crate::bots::random_secret(6));
                self.social_emoji_upsert(crate::social::EmojiRow {
                    id,
                    community_id: community_id.into(),
                    name: nome.into(),
                    char: ch.into(),
                    created_at: crate::identity::now_ms(),
                })?;
                Ok(format!("emoji :{nome}: adicionado"))
            }
            "emoji_del" => {
                let nome = target.trim();
                if nome.is_empty() {
                    return Err(DistorrentError::Protocol("informe o nome do emoji".into()));
                }
                let row = self
                    .store
                    .emoji_list(community_id)?
                    .into_iter()
                    .find(|e| e.id == nome || e.name.eq_ignore_ascii_case(nome))
                    .ok_or_else(|| {
                        DistorrentError::Protocol(format!("emoji `{nome}` não existe"))
                    })?;
                self.social_emoji_delete(community_id, &row.id)?;
                Ok(format!("emoji :{}: removido", row.name))
            }
            "typing" => {
                let Some(conv) = self.resolve_channel(community_id, channel.unwrap_or("")) else {
                    return Err(DistorrentError::Protocol(
                        "informe o canal para o \"digitando\"".into(),
                    ));
                };
                self.social_typing(&conv)?;
                Ok("digitando…".to_string())
            }
            other => Err(DistorrentError::Protocol(format!("ação inválida: {other}"))),
        }
    }
}
