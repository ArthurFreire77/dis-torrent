// Comandos Tauri: misc.
// Irmão de lib.rs; o generate_handler! continua lá.

use super::*;

#[tauri::command]
pub(crate) fn hide_share_bar() -> bool {
    crate::sharebar::hide_share_bar()
}

#[tauri::command]
pub(crate) fn share_bar_watch(ativo: bool) {
    if ativo {
        crate::sharebar::watch_share_bar();
    } else {
        crate::sharebar::unwatch_share_bar();
    }
}

#[tauri::command]
pub(crate) fn local_addresses(
    port: Option<u16>,
    state: State<AppState>,
) -> Result<LocalAddresses, String> {
    let lan_all = local_ipv4_addresses();
    let port = port.unwrap_or(DEV_PORT);
    let _ = &state;
    Ok(LocalAddresses {
        localhost: format!("http://localhost:{port}"),
        lan: lan_all.first().cloned(),
        lan_all,
        port,
    })
}

#[tauri::command]
pub(crate) fn notify_ui_alive(state: State<AppState>) -> Result<(), String> {
    open_store(&state)?
        .kv_set(
            "notify.ui_alive",
            &distorrent_core::identity::now_ms().to_string(),
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn peers_list(state: State<AppState>) -> Result<Vec<PeerView>, String> {
    let engine = engine(&state)?;
    Ok(engine
        .peers()
        .into_iter()
        .map(|record| {
            let fp = record.fp.clone();
            let d = engine.peer_diag(&fp);
            PeerView {
                via_relay: engine.is_peer_via_relay(&fp),
                state: engine.peer_state(&fp),
                last_direct_error: d.last_direct_err,
                last_relay_error: d.last_relay_err,
                direct_attempts: d.direct_attempts,
                relay_attempts: d.relay_attempts,
                announce_seen_ms: d.announce_seen_ms,
                last_reject: d.last_reject,
                last_reject_ms: d.last_reject_ms,
                send_gave_up: d.send_gave_up,
                record,
            }
        })
        .collect())
}

#[tauri::command]
pub(crate) fn communities_list(state: State<AppState>) -> Result<Vec<CommunityView>, String> {
    let engine = engine(&state)?;
    let me = engine.identity().fingerprint.clone();
    let mut out = Vec::new();
    for (id, name, owner) in engine.store_list_communities() {
        let (description, category, icon) = engine.community_meta(&id).unwrap_or_default();
        out.push(CommunityView {
            channels: engine.store_list_channels(&id),
            members: engine.store_list_members(&id),
            is_owner: owner == me,
            is_public: engine.community_is_public(&id).unwrap_or(false),
            id,
            name,
            owner_fp: owner,
            description,
            category,
            icon,
        });
    }
    Ok(out)
}

#[tauri::command]
pub(crate) fn roles_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::RoleRow>, String> {
    engine(&state)?.roles_list(&community_id).map_err(err)
}

#[tauri::command]
pub(crate) fn validate_name(
    kind: String,
    raw: String,
    existing: Option<Vec<String>>,
    state: State<AppState>,
) -> Result<NameCheckView, String> {
    let _ = &state;
    let k = distorrent_core::names::NameKind::from_str(kind.trim())
        .ok_or_else(|| "tipo inválido (user|server|channel)".to_string())?;
    let scope = existing.unwrap_or_default();
    let policy = distorrent_core::names::NamePolicy::for_kind(k);
    let c = distorrent_core::names::validate_name(k, &raw, &scope, &policy);
    Ok(NameCheckView {
        ok: c.ok,
        normalized: c.normalized,
        errors: c.errors,
        suggestions: c.suggestions,
    })
}

#[tauri::command]
pub(crate) fn random_name() -> String {
    distorrent_core::names::random_name()
}

#[cfg(desktop)]
#[tauri::command]
pub(crate) fn open_bots_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("bots") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "bots")
        .cloned()
        .ok_or_else(|| "a janela de bots não está declarada em tauri.conf.json".to_string())?;
    let janela = tauri::WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let _ = janela.show();
    let _ = janela.set_focus();
    Ok(())
}

#[cfg(not(desktop))]
#[tauri::command]
pub(crate) fn open_bots_window(_app: AppHandle) -> Result<(), String> {
    Err("a tela de bots no celular usa a interface do app, não uma janela separada".into())
}

#[tauri::command]
pub(crate) async fn http_fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    allow_private: Option<bool>,
    _state: State<'_, AppState>,
) -> Result<HttpResponse, String> {
    use base64::Engine as _;
    let block_private = !allow_private.unwrap_or(false);
    distorrent_core::bots::url_allowed(&url, block_private)?;
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("URL inválida: {e}"))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("só http/https são permitidos".into());
    }
    if parsed.host_str().map(str::is_empty).unwrap_or(true) {
        return Err("URL sem host".into());
    }
    let method = method.trim().to_uppercase();
    let method = match method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        other => return Err(format!("método {other} não suportado (use GET|POST)")),
    };
    let headers: Vec<(String, String)> = headers
        .into_iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .take(16)
        .collect();
    if headers.iter().any(|(k, v)| k.len() > 128 || v.len() > 1024) {
        return Err("header grande demais".into());
    }
    let body_bytes = match body.as_deref() {
        Some(b) if !b.is_empty() => base64::engine::general_purpose::STANDARD
            .decode(b)
            .ok()
            .map(reqwest::Body::from)
            .unwrap_or_else(|| reqwest::Body::from(b.to_string())),
        _ => reqwest::Body::from(Vec::new()),
    };
    // LLM responde devagar; o teto acompanha o do runtime declarativo (90s).
    let mut timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(10_000).min(90_000));
    if timeout.as_millis() < 1_000 {
        timeout = std::time::Duration::from_millis(1_000);
    }
    let guarded = block_private;
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 3 {
                return attempt.error("redirect demais (máx 3)");
            }
            match distorrent_core::bots::url_allowed(attempt.url().as_str(), guarded) {
                Ok(()) => attempt.follow(),
                Err(e) => attempt.error(format!("redirect bloqueado: {e}")),
            }
        }))
        .build()
        .map_err(err)?;
    let mut req = client.request(method, parsed);
    for (k, v) in headers {
        req = req.header(&k, &v);
    }
    let res = req.body(body_bytes).send().await.map_err(err)?;
    let status = res.status().as_u16();
    let bytes = res.bytes().await.map_err(err)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let truncated = bytes.len() > 256 * 1024;
    Ok(HttpResponse {
        status,
        body_b64: b64,
        body_text: String::from_utf8(bytes[..bytes.len().min(256 * 1024)].to_vec()).ok(),
        truncated,
    })
}

#[tauri::command]
pub(crate) fn create_group(
    title: String,
    members: Vec<String>,
    state: State<AppState>,
) -> Result<distorrent_core::storage::Conversation, String> {
    engine(&state)?.create_group(&title, members).map_err(err)
}

#[tauri::command]
pub(crate) fn send_typing(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_typing(&conv_id).map_err(err)
}

#[tauri::command]
pub(crate) fn screen_share_offer(
    target_fp: String,
    call_id: String,
    sdp: String,
    state: State<AppState>,
) -> Result<(), String> {
    if sdp.len() > 4 * 1024 {
        return Err("sinal de tela grande demais (máx 4KB)".into());
    }
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::ScreenShareOffer { call_id, sdp },
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn screen_share_answer(
    target_fp: String,
    call_id: String,
    sdp: String,
    state: State<AppState>,
) -> Result<(), String> {
    if sdp.len() > 256 * 1024 {
        return Err("sinal de tela grande demais".into());
    }
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::ScreenShareAnswer { call_id, sdp },
        )
        .map_err(err)
}

#[tauri::command]
pub(crate) fn get_app_version(app: tauri::AppHandle) -> String {
    app.config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}
