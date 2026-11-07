// Comandos Tauri: server.
// Irmão de lib.rs; o generate_handler! continua lá.

use super::*;

#[tauri::command]
pub(crate) fn community_members(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<MemberPairingView>, String> {
    Ok(engine(&state)?
        .community_member_states(&community_id)
        .into_iter()
        .map(|m| MemberPairingView {
            fp: m.fp,
            nickname: m.nickname,
            role: m.role,
            state: m.state,
            via_relay: m.via_relay,
            is_owner: m.is_owner,
            is_self: m.is_self,
        })
        .collect())
}

#[tauri::command]
pub(crate) fn create_community(
    name: String,
    channels: Option<Vec<String>>,
    options: Option<distorrent_core::net::engine::CommunityCreateOptions>,
    state: State<AppState>,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("nome não pode ser vazio".into());
    }
    let opts = options.unwrap_or_default();
    engine(&state)?
        .create_community_with_options(&name, channels.as_deref().unwrap_or(&[]), &opts)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn community_set_meta(
    community_id: String,
    description: Option<String>,
    category: Option<String>,
    icon: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .community_set_meta(
            &community_id,
            description.as_deref(),
            category.as_deref(),
            icon.as_deref(),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn community_set_public(
    community_id: String,
    is_public: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .community_set_public(&community_id, is_public)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn join_public_community(
    host_fp: String,
    community_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    engine(&state)?
        .join_public_community(&host_fp, &community_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn make_invite(
    community_id: String,
    member_fp: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    const WILDCARD: &str = "000000000000";
    let raw = member_fp.unwrap_or_default();
    let member_fp = if raw.trim().is_empty() {
        WILDCARD.to_string()
    } else {
        raw.trim().to_lowercase()
    };
    if member_fp != WILDCARD
        && (member_fp.len() != 12 || !member_fp.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(
            "fingerprint do convidado deve ter 12 hex (ou vazio para convite aberto)".into(),
        );
    }
    engine(&state)?
        .make_invite(&community_id, &member_fp, 7 * 24 * 3600 * 1000)
        .map_err(presentation_error)
}

#[tauri::command]
pub(crate) fn join_community(token: String, state: State<AppState>) -> Result<String, String> {
    engine(&state)?
        .join_community(token.trim())
        .map_err(presentation_error)
}

#[tauri::command]
pub(crate) fn make_invite_link(
    community_id: String,
    member_fp: Option<String>,
    state: State<AppState>,
) -> Result<InviteView, String> {
    const WILDCARD: &str = "000000000000";
    const TTL_MS: i64 = 7 * 24 * 3600 * 1000;
    let raw = member_fp.unwrap_or_default();
    let fp = if raw.trim().is_empty() {
        WILDCARD.to_string()
    } else {
        raw.trim().to_lowercase()
    };
    if fp != WILDCARD && (fp.len() != 12 || !fp.chars().all(|c| c.is_ascii_hexdigit())) {
        return Err("fingerprint do convidado deve ter 12 hex".into());
    }
    let token = engine(&state)?
        .make_invite(&community_id, &fp, TTL_MS)
        .map_err(presentation_error)?;
    let link = format!("distorrent://invite?invite={token}");
    Ok(InviteView {
        token,
        link,
        expires_at_ms: distorrent_core::identity::now_ms() + TTL_MS,
        scope: if fp == WILDCARD {
            "open".into()
        } else {
            "fp".into()
        },
    })
}

#[tauri::command]
pub(crate) fn send_channel_message(
    community_id: String,
    channel_id: String,
    body: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::StoredMessage, String> {
    if body.trim().is_empty() {
        return Err("mensagem vazia".into());
    }
    engine(&state)?
        .send_channel_message(&community_id, &channel_id, body.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn channel_create(
    community_id: String,
    name: String,
    topic: Option<String>,
    category: Option<String>,
    kind: Option<String>,
    state: State<AppState>,
) -> Result<distorrent_core::storage::ChannelMetaRow, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("nome do canal não pode ser vazio".into());
    }
    engine(&state)?
        .channel_create(
            &community_id,
            name,
            topic.as_deref().unwrap_or(""),
            category.as_deref().unwrap_or(""),
            kind.as_deref().unwrap_or("text"),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn channel_delete(
    community_id: String,
    channel_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    if channel_id.trim().is_empty() {
        return Err("channel_id vazio".into());
    }
    engine(&state)?
        .channel_delete(&community_id, channel_id.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn channel_rename(
    community_id: String,
    channel_id: String,
    new_name: String,
    state: State<AppState>,
) -> Result<(), String> {
    if new_name.trim().is_empty() {
        return Err("nome do canal não pode ser vazio".into());
    }
    engine(&state)?
        .channel_rename(&community_id, &channel_id, new_name.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn channel_set_topic(
    community_id: String,
    channel_id: String,
    topic: String,
    state: State<AppState>,
) -> Result<(), String> {
    if channel_id.trim().is_empty() {
        return Err("channel_id vazio".into());
    }
    engine(&state)?
        .channel_set_topic(&community_id, &channel_id, &topic)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn channel_set_category(
    community_id: String,
    channel_id: String,
    category: String,
    state: State<AppState>,
) -> Result<(), String> {
    if category.trim().is_empty() {
        return Err("categoria não pode ser vazia".into());
    }
    engine(&state)?
        .channel_set_category(&community_id, &channel_id, category.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn channel_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::ChannelMetaRow>, String> {
    engine(&state)?.channel_list(&community_id).map_err(err)
}

#[tauri::command]
pub(crate) fn community_rename(
    community_id: String,
    name: String,
    state: State<AppState>,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("nome não pode ser vazio".into());
    }
    engine(&state)?
        .community_rename(&community_id, name.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn role_create(
    community_id: String,
    name: String,
    color: String,
    permissions: i64,
    hoist: bool,
    mentionable: bool,
    state: State<AppState>,
) -> Result<distorrent_core::storage::RoleRow, String> {
    if name.trim().is_empty() {
        return Err("nome do cargo não pode ser vazio".into());
    }
    engine(&state)?
        .role_create(
            &community_id,
            name.trim(),
            &color,
            permissions,
            hoist,
            mentionable,
        )
        .map_err(err)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn role_update(
    community_id: String,
    role_id: String,
    patch: Option<RolePatch>,
    name: Option<String>,
    color: Option<String>,
    permissions: Option<i64>,
    hoist: Option<bool>,
    mentionable: Option<bool>,
    position: Option<i64>,
    state: State<AppState>,
) -> Result<(), String> {
    let p = patch.unwrap_or_default();
    let name = name.or(p.name);
    let color = color.or(p.color);
    let permissions = permissions.or(p.permissions);
    let hoist = hoist.or(p.hoist);
    let mentionable = mentionable.or(p.mentionable);
    let position = position.or(p.position);
    if name.is_none()
        && color.is_none()
        && permissions.is_none()
        && hoist.is_none()
        && mentionable.is_none()
        && position.is_none()
    {
        return Err("nada para atualizar no cargo".into());
    }
    engine(&state)?
        .role_update(
            &community_id,
            &role_id,
            name.as_deref(),
            color.as_deref(),
            permissions,
            hoist,
            mentionable,
            position,
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn role_delete(
    community_id: String,
    role_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    if role_id.trim().is_empty() {
        return Err("role_id vazio".into());
    }
    engine(&state)?
        .role_delete(&community_id, role_id.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn member_roles(
    community_id: String,
    fp: String,
    state: State<AppState>,
) -> Result<Vec<String>, String> {
    if fp.trim().is_empty() {
        return Err("fp vazio".into());
    }
    engine(&state)?
        .member_roles(&community_id, fp.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn member_assign_role(
    community_id: String,
    fp: String,
    role_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    if fp.trim().is_empty() || role_id.trim().is_empty() {
        return Err("fp/role_id vazios".into());
    }
    engine(&state)?
        .member_assign_role(&community_id, fp.trim(), role_id.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn member_unassign_role(
    community_id: String,
    fp: String,
    role_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    if fp.trim().is_empty() || role_id.trim().is_empty() {
        return Err("fp/role_id vazios".into());
    }
    engine(&state)?
        .member_unassign_role(&community_id, fp.trim(), role_id.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn member_kick(
    community_id: String,
    fp: String,
    state: State<AppState>,
) -> Result<(), String> {
    if fp.trim().is_empty() {
        return Err("fp vazio".into());
    }
    engine(&state)?
        .member_kick(&community_id, fp.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn server_rules_get(
    community_id: String,
    state: State<AppState>,
) -> Result<distorrent_core::moderation::ServerRules, String> {
    engine(&state)?
        .server_rules_get(community_id.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn server_rules_set(
    rules: distorrent_core::moderation::ServerRules,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.server_rules_set(rules).map_err(err)
}

#[tauri::command]
pub(crate) fn audit_list(
    community_id: String,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::moderation::AuditEntry>, String> {
    engine(&state)?
        .audit_list(community_id.trim(), limit.unwrap_or(100))
        .map_err(err)
}

#[tauri::command]
pub(crate) fn reputation_get(
    fp: String,
    state: State<AppState>,
) -> Result<(String, i32, u32), String> {
    engine(&state)?.reputation_get(fp.trim()).map_err(err)
}

#[tauri::command]
pub(crate) fn safety_number(peer_fp: String, state: State<AppState>) -> Result<String, String> {
    engine(&state)?.safety_number(peer_fp.trim()).map_err(err)
}

#[tauri::command]
pub(crate) fn moderate(
    community_id: String,
    action: String,
    target: String,
    reason: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    if target.trim().is_empty() {
        return Err("alvo vazio".into());
    }
    engine(&state)?
        .moderate(
            community_id.trim(),
            action.trim(),
            target.trim(),
            reason.as_deref().unwrap_or(""),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn report_user(
    target_fp: String,
    community_id: Option<String>,
    reason: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    if target_fp.trim().is_empty() {
        return Err("alvo vazio".into());
    }
    engine(&state)?
        .report_user(
            target_fp.trim(),
            community_id.as_deref().unwrap_or(""),
            reason.as_deref().unwrap_or(""),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn member_ban(
    community_id: String,
    fp: String,
    until_ms: i64,
    reason: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_ban(&community_id, &fp, until_ms, &reason)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn member_unban(
    community_id: String,
    fp: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_unban(&community_id, &fp)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn member_timeout(
    community_id: String,
    fp: String,
    until_ms: i64,
    reason: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_timeout(&community_id, &fp, until_ms, &reason)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn ban_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::BanRow>, String> {
    open_store(&state)?.ban_list(&community_id).map_err(err)
}

#[tauri::command]
pub(crate) fn timeout_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::BanRow>, String> {
    open_store(&state)?.timeout_list(&community_id).map_err(err)
}

#[tauri::command]
pub(crate) fn channel_cfg_set(
    community_id: String,
    channel_id: String,
    slowmode_secs: i64,
    nsfw: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_channel_cfg(&community_id, &channel_id, slowmode_secs, nsfw)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn channel_cfg_get(channel_id: String, state: State<AppState>) -> Result<i64, String> {
    open_store(&state)?
        .channel_cfg_slowmode(&channel_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn group_members(
    conv_id: String,
    state: State<AppState>,
) -> Result<Vec<(String, String)>, String> {
    Ok(engine(&state)?.group_members(&conv_id))
}

#[tauri::command]
pub(crate) fn group_pair_now(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_pair_now(&conv_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn community_pair_now(
    community_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.community_pair_now(&community_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn community_sync_now(
    community_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.community_sync_now(&community_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn group_add(conv_id: String, fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_add(&conv_id, &fp).map_err(err)
}

#[tauri::command]
pub(crate) fn group_remove(
    conv_id: String,
    fp: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.group_remove(&conv_id, &fp).map_err(err)
}

#[tauri::command]
pub(crate) fn group_rename(
    conv_id: String,
    title: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.group_rename(&conv_id, &title).map_err(err)
}

#[tauri::command]
pub(crate) fn group_leave(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_leave(&conv_id).map_err(err)
}

#[tauri::command]
pub(crate) fn group_delete(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_delete(&conv_id).map_err(err)
}

#[tauri::command]
pub(crate) fn group_delete_local(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_delete_local(&conv_id).map_err(err)
}
