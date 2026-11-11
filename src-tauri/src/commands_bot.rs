// Comandos Tauri: bot.
// Irmão de lib.rs; o generate_handler! continua lá.

use super::*;

#[tauri::command]
pub(crate) fn bot_create(
    community_id: String,
    name: String,
    avatar: Option<String>,
    role_id: Option<String>,
    state: State<AppState>,
) -> Result<distorrent_core::storage::BotRow, String> {
    if name.trim().is_empty() {
        return Err("nome do bot não pode ser vazio".into());
    }
    engine(&state)?
        .bot_create(
            &community_id,
            name.trim(),
            avatar.as_deref(),
            role_id.as_deref(),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_update(
    community_id: String,
    bot_id: String,
    patch: Option<BotPatch>,
    name: Option<String>,
    avatar: Option<String>,
    role_id: Option<String>,
    online: Option<bool>,
    config: Option<String>,
    perms: Option<i64>,
    webhook_secret: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let p = patch.unwrap_or_default();
    if let Some(c) = config.as_deref().or(p.config.as_deref()) {
        if c.len() > 64 * 1024 {
            return Err("config do bot muito grande (máx 64KB)".into());
        }
        distorrent_core::bots::parse_config(c).map_err(|e| format!("config inválida: {e}"))?;
    }
    let merged = distorrent_core::storage::BotPatch {
        name: name.or(p.name),
        avatar: avatar.or(p.avatar),
        role_id: role_id.map(|r| Some(r)).or(p.role_id),
        online: online.or(p.online),
        config: config.or(p.config),
        perms: perms.or(p.perms),
        webhook_secret: webhook_secret.or(p.webhook_secret),
    };
    if merged.name.is_none()
        && merged.avatar.is_none()
        && merged.role_id.is_none()
        && merged.online.is_none()
        && merged.config.is_none()
        && merged.perms.is_none()
        && merged.webhook_secret.is_none()
    {
        return Err("nada para atualizar no bot".into());
    }
    engine(&state)?
        .bot_update(&community_id, &bot_id, merged)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_delete(
    community_id: String,
    bot_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    if bot_id.trim().is_empty() {
        return Err("bot_id vazio".into());
    }
    engine(&state)?
        .bot_delete(&community_id, bot_id.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bots_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::BotRow>, String> {
    engine(&state)?.bots_list(&community_id).map_err(err)
}

#[tauri::command]
pub(crate) fn bot_webhook_secret_set(
    community_id: String,
    bot_id: String,
    state: State<AppState>,
) -> Result<bool, String> {
    Ok(engine(&state)?
        .store
        .bots_list(&community_id)
        .map_err(err)?
        .into_iter()
        .find(|b| b.id == bot_id)
        .map(|b| b.webhook_secret_set())
        .unwrap_or(false))
}

#[tauri::command]
pub(crate) fn bot_post_message(
    community_id: String,
    channel_id: String,
    bot_id: String,
    body: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::StoredMessage, String> {
    if body.trim().is_empty() {
        return Err("mensagem vazia".into());
    }
    engine(&state)?
        .bot_post_message(&community_id, &channel_id, &bot_id, body.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_regen_token(
    community_id: String,
    bot_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    engine(&state)?
        .bot_regen_token(&community_id, &bot_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_admin(
    community_id: String,
    bot_id: String,
    action: String,
    target: Option<String>,
    reason: Option<String>,
    number: Option<i64>,
    channel: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    engine(&state)?
        .bot_action_in(
            &community_id,
            &bot_id,
            action.trim(),
            target.as_deref().unwrap_or(""),
            reason.as_deref().unwrap_or(""),
            number,
            channel.as_deref(),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_logs(
    community_id: String,
    bot_id: String,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::BotLogRow>, String> {
    engine(&state)?
        .bot_logs(&community_id, &bot_id, limit.unwrap_or(120))
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_log_append(
    community_id: String,
    bot_id: String,
    level: String,
    message: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .bot_log_append(&community_id, &bot_id, level.trim(), message.trim())
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_logs_clear(
    community_id: String,
    bot_id: String,
    state: State<AppState>,
) -> Result<usize, String> {
    engine(&state)?
        .bot_logs_clear(&community_id, &bot_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_vars_list(
    community_id: String,
    bot_id: String,
    state: State<AppState>,
) -> Result<Vec<(String, String)>, String> {
    engine(&state)?
        .bot_vars_list(&community_id, &bot_id)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_var_get(
    community_id: String,
    bot_id: String,
    key: String,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    Ok(engine(&state)?
        .store
        .bot_var_get(&community_id, &bot_id, &key))
}

#[tauri::command]
pub(crate) fn bot_var_set(
    community_id: String,
    bot_id: String,
    key: String,
    value: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .bot_var_set(&community_id, &bot_id, &key, &value)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_config_validate(config: String) -> Result<serde_json::Value, String> {
    let cfg = distorrent_core::bots::parse_config(&config).map_err(|e| e.to_string())?;
    let commands: Vec<serde_json::Value> = cfg
        .commands
        .iter()
        .map(|c| {
            serde_json::json!({
                "name": c.name,
                "aliases": c.aliases,
                "description": c.description,
                "exec": c.exec.as_str(),
                "permission": c.need.as_str(),
                "cooldownMs": c.cooldown_ms,
                "ephemeral": c.ephemeral,
                "enabled": c.enabled,
            })
        })
        .collect();
    Ok(serde_json::json!({
        "prefix": cfg.prefix,
        "commands": commands,
        "channels": cfg.channels,
        "events": cfg.events,
        "blockPrivate": cfg.block_private,
        "maxRepliesPerMinute": cfg.max_replies_per_min,
        "webhook": cfg.webhook,
    }))
}

#[tauri::command]
pub(crate) fn bot_warnings_list(
    community_id: String,
    fp: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::WarnRow>, String> {
    engine(&state)?
        .store
        .warnings_for(&community_id, &fp)
        .map_err(err)
}

#[tauri::command]
pub(crate) fn bot_bridge_start(
    community_id: String,
    bot_id: String,
    port: Option<u16>,
    state: State<'_, AppState>,
) -> Result<botbridge::BridgeInfo, String> {
    let eng = engine(&state)?;
    if eng
        .bots_list(&community_id)
        .map_err(err)?
        .iter()
        .all(|b| b.id != bot_id)
    {
        return Err("bot inexistente".into());
    }
    let key = bridge_key(&community_id, &bot_id);
    let music = state.bot_music.clone();
    let mut map = state.bot_bridges.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = map.get(&key) {
        return Ok(existing.info());
    }
    let bridge = Arc::new(botbridge::start(
        eng,
        community_id.clone(),
        bot_id.clone(),
        port.unwrap_or(0),
        music,
    )?);
    let info = bridge.info();
    map.insert(key, bridge);
    Ok(info)
}

#[tauri::command]
pub(crate) fn bot_bridge_stop(
    community_id: String,
    bot_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let key = bridge_key(&community_id, &bot_id);
    let bridge = state
        .bot_bridges
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&key);
    match bridge {
        Some(b) => {
            b.stop();
            Ok(true)
        }
        None => Ok(false),
    }
}

#[tauri::command]
pub(crate) fn bot_bridge_status(
    community_id: String,
    bot_id: String,
    state: State<'_, AppState>,
) -> Result<Option<botbridge::BridgeStatus>, String> {
    let key = bridge_key(&community_id, &bot_id);
    Ok(state
        .bot_bridges
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&key)
        .map(|b| b.status()))
}

#[tauri::command]
pub(crate) fn bot_bridge_list(
    state: State<'_, AppState>,
) -> Result<Vec<botbridge::BridgeInfo>, String> {
    Ok(state
        .bot_bridges
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|b| b.info())
        .collect())
}

#[tauri::command]
pub(crate) fn bot_folder_read(dir: String) -> Result<botbridge::ImportedFolder, String> {
    botbridge::read_bot_folder(std::path::Path::new(dir.trim()))
}

/// Importa um bot empacotado em `.zip`. Extrai numa pasta privada do app (a
/// pasta fica lá: o plugin roda dela) e reusa `read_bot_folder`.
#[tauri::command]
pub(crate) fn bot_zip_save(
    app: AppHandle,
    file_name: String,
    bytes_b64: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_b64.as_bytes())
        .map_err(|_| "o arquivo não está em base64 válido".to_string())?;
    if bytes.is_empty() {
        return Err("arquivo vazio".into());
    }
    if bytes.len() as u64 > botzip::MAX_TOTAL_BYTES {
        return Err(format!(
            "pacote grande demais ({} MB, máximo {} MB)",
            bytes.len() / (1024 * 1024),
            botzip::MAX_TOTAL_BYTES / (1024 * 1024)
        ));
    }
    // Só a extensão do nome escolhido é usada; o nome em si é gerado aqui para
    // o caminho nunca vir do cliente (nada de `..` ou nome absoluto).
    let base_name = file_name
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("bot")
        .to_ascii_lowercase();
    if !base_name.ends_with(".zip") {
        return Err("o arquivo escolhido precisa ser um .zip".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|e| format!("pasta do app indisponível: {e}"))?
        .join("bot-uploads");
    std::fs::create_dir_all(&dir).map_err(|e| format!("não consegui criar {dir:?}: {e}"))?;
    let path = dir.join(format!("{}.zip", distorrent_core::bots::random_secret(12)));
    std::fs::write(&path, &bytes).map_err(|e| format!("gravar o .zip: {e}"))?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub(crate) fn bot_zip_read(
    app: AppHandle,
    zip_path: String,
) -> Result<botbridge::ImportedFolder, String> {
    let base = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|e| format!("pasta do app indisponível: {e}"))?;
    let dest = base
        .join("bot-imports")
        .join(distorrent_core::bots::random_secret(12));
    let root = match botzip::extract_bot_zip(std::path::Path::new(zip_path.trim()), &dest) {
        Ok(root) => root,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(e);
        }
    };
    match botbridge::read_bot_folder(&root) {
        Ok(info) => Ok(info),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dest);
            Err(e)
        }
    }
}

#[tauri::command]
pub(crate) fn bot_plugin_start(
    community_id: String,
    bot_id: String,
    dir: String,
    run: String,
    state: State<'_, AppState>,
) -> Result<botplugin::PluginStatus, String> {
    let key = bridge_key(&community_id, &bot_id);
    let info = {
        let map = state.bot_bridges.lock().unwrap_or_else(|e| e.into_inner());
        map.get(&key)
            .map(|b| b.info())
            .ok_or_else(|| "abra a ponte local do bot antes de iniciar o plugin".to_string())?
    };
    state
        .bot_plugins
        .start(&key, dir.trim(), run.trim(), &info.url)
}

#[tauri::command]
pub(crate) fn bot_plugin_stop(
    community_id: String,
    bot_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let key = bridge_key(&community_id, &bot_id);
    Ok(state.bot_plugins.stop(&key))
}

#[tauri::command]
pub(crate) fn bot_plugin_status(
    community_id: String,
    bot_id: String,
    state: State<'_, AppState>,
) -> Result<Option<botplugin::PluginStatus>, String> {
    let key = bridge_key(&community_id, &bot_id);
    Ok(state.bot_plugins.status(&key))
}

#[tauri::command]
pub(crate) fn bot_plugin_list(
    state: State<'_, AppState>,
) -> Result<Vec<botplugin::PluginStatus>, String> {
    Ok(state
        .bot_plugins
        .list()
        .into_iter()
        .map(|(_, s)| s)
        .collect())
}

#[tauri::command]
pub(crate) fn bot_call_take() -> Vec<(String, String)> {
    crate::botmusic::tomar_pedidos_de_call()
}

#[tauri::command]
pub(crate) fn bot_audio_open(
    community_id: String,
    bot_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    if engine(&state)?
        .bots_list(&community_id)
        .map_err(err)?
        .iter()
        .all(|b| b.id != bot_id)
    {
        return Err("bot inexistente".into());
    }
    let key = bridge_key(&community_id, &bot_id);
    let (abriu, _) = state.bot_music.open(&key);
    Ok(abriu)
}

#[tauri::command]
pub(crate) fn bot_audio_push(
    community_id: String,
    bot_id: String,
    pcm_b64: String,
    gain: Option<f32>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(pcm_b64.as_bytes())
        .map_err(|e| format!("base64 inválido: {e}"))?;
    let key = bridge_key(&community_id, &bot_id);
    let (acc, drop) = state.bot_music.push(&key, &bytes, gain.unwrap_or(1.0))?;
    Ok(serde_json::json!({
        "accepted": acc,
        "dropped": drop,
        // O áudio entra na track do participante; quem liga é o frontend.
        "delivered": "participant",
        "to_call": true,
    }))
}

#[tauri::command]
pub(crate) fn bot_audio_drain(
    community_id: String,
    bot_id: String,
    max: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    // Cada frame é PCM i16 mono 48 kHz em base64 — o frontend decodifica para
    // AudioBuffer e toca na track do participante.
    let key = bridge_key(&community_id, &bot_id);
    let frames = state.bot_music.drain(&key, max.unwrap_or(25).min(100));
    use base64::Engine as _;
    Ok(frames
        .into_iter()
        .map(|pcm| {
            let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
            base64::engine::general_purpose::STANDARD.encode(bytes)
        })
        .collect())
}

#[tauri::command]
pub(crate) fn bot_audio_status(
    community_id: String,
    bot_id: String,
    state: State<'_, AppState>,
) -> Result<Option<serde_json::Value>, String> {
    let key = bridge_key(&community_id, &bot_id);
    Ok(state.bot_music.status(&key).map(|(acc, drop)| {
        serde_json::json!({
            "accepted": acc,
            "dropped": drop,
            "delivered": "local",
        })
    }))
}

#[tauri::command]
pub(crate) fn bot_audio_close(
    community_id: String,
    bot_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let key = bridge_key(&community_id, &bot_id);
    Ok(state.bot_music.close(&key))
}
