// Comandos Tauri: net.
// Irmão de lib.rs; o generate_handler! continua lá.

use super::*;

#[tauri::command]
pub(crate) fn identity_get(
    app: AppHandle,
    state: State<AppState>,
) -> Result<Option<Identity>, String> {
    let store = open_store(&state)?;
    let Some(id) = store.load_identity() else {
        return Ok(None);
    };
    let vault_on = store.kv_get("vault.on").as_deref() == Some("1");
    let stored = store.load_secret_hex().unwrap_or_default();
    let has_valid_blob = stored.len() >= 88;

    if vault_on && has_valid_blob {
        // Cofre por senha: só `vault_unlock` destrava. Nunca apagar o cofre
        // aqui — era o caminho que devolvia a identidade sem senha.
        return Ok(None);
    }
    if plaintext_secret(&store).is_some() {
        let _ = store.kv_delete("vault.on");
        boot_engine_with_store(&app, &state, store)?;
        return Ok(Some(id));
    }
    if vault_on {
        return Ok(None);
    }
    // `stored` != blob válido e sem segredo recuperável: não invente. A UI
    // mostra a tela de bloqueio/criação, que é o estado honesto.
    tracing::warn!("identidade sem segredo recuperável — requer intervenção do usuário");
    Err("segredo da identidade não encontrado — tente reiniciar o app ou restaurar backup".into())
}

#[tauri::command]
pub(crate) fn identity_create(
    app: AppHandle,
    nickname: String,
    password: Option<String>,
    state: State<AppState>,
) -> Result<Identity, String> {
    let store = open_store(&state)?;
    if store.load_identity().is_some() {
        return Err("identidade já existe neste dispositivo".into());
    }
    let nick = nickname.trim();
    if nick.is_empty() {
        return Err("nome não pode ser vazio".into());
    }
    if nick.chars().count() > 64 {
        return Err("nome muito longo (máximo 64 caracteres)".into());
    }
    let kp = Keypair::generate();
    let identity = kp.identity(nick);
    match password.as_deref() {
        Some(pass) if !pass.is_empty() => {
            let secret_hex = kp.secret_hex();
            let blob = distorrent_core::vault::seal_secret(&secret_hex, pass).map_err(err)?;
            store
                .save_identity(&identity, &hex::encode(&blob))
                .map_err(err)?;
            store.kv_set("vault.on", "1").map_err(err)?;
            *state.unlocked.lock().unwrap_or_else(|e| e.into_inner()) = true;
            boot_engine_with_secret(&app, &state, &store, secret_hex)?;
            return Ok(identity);
        }
        _ => persist_secret(&store, &kp, &identity)?,
    }
    boot_engine_if_needed(&app, &state)?;
    Ok(identity)
}

#[tauri::command]
pub(crate) fn identity_rename(
    app: AppHandle,
    nickname: String,
    state: State<AppState>,
) -> Result<Identity, String> {
    let store = open_store(&state)?;
    let mut identity = store.load_identity().ok_or("sem identidade")?;
    let nick = nickname.trim();
    if nick.is_empty() {
        return Err("nickname não pode ser vazio".into());
    }
    if nick.chars().count() > 64 {
        return Err("nickname muito longo (máximo 64 caracteres)".into());
    }
    identity.nickname = nick.to_string();
    // Só metadados mudaram: reescrever o segredo aqui é o que re-criava o
    // texto claro no SQLite (ou apagava o blob selado).
    store.save_identity_meta(&identity).map_err(err)?;
    restart_engine(&app, &state)?;
    Ok(identity)
}

#[tauri::command]
pub(crate) fn network_status(state: State<AppState>) -> Result<NetworkStatusView, String> {
    let engine = engine(&state)?;
    // Uma leitura só: estado e contagem coerentes (ver network_snapshot).
    let (state, online_peers) = engine.network_snapshot();
    Ok(NetworkStatusView {
        state,
        online_peers,
        listen_port: engine.listen_port(),
    })
}

#[tauri::command]
pub(crate) fn webrtc_report(info: String) {
    eprintln!("[distorrent-probe] {info}");
}

#[tauri::command]
pub(crate) fn net_diag(state: State<AppState>) -> Result<NetDiagView, String> {
    let engine = engine(&state)?;
    let d = engine.net_diag();
    Ok(NetDiagView {
        stun_ok: d.stun_ok,
        stun_addr: d.stun_addr,
        stun_ms: d.stun_ms,
        announce_addr: d.announce_addr,
        announce_ms: d.announce_ms,
        nat_source: d.nat_source,
        dht_ok: d.dht_ok,
        dht_ms: d.dht_ms,
    })
}

#[tauri::command]
pub(crate) async fn relay_status(
    state: State<'_, AppState>,
) -> Result<Vec<distorrent_core::net::relay::RelayLegStatus>, String> {
    let engine = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    match engine {
        Some(engine) => Ok(engine.relay_diagnostics().await),
        None => Ok(distorrent_core::net::relay::check_relay_legs().await),
    }
}

#[tauri::command]
pub(crate) fn connect_addr(
    addr: String,
    expected_fp: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let engine = engine(&state)?;
    let trimmed = addr.trim().to_string();
    if trimmed.is_empty() {
        return Err("endereço vazio".into());
    }
    if let Ok(s) = trimmed.parse::<std::net::SocketAddr>() {
        engine.add_manual_peer(s, expected_fp);
    } else {
        engine
            .connect_host(&trimmed, expected_fp)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn disconnect_peer(fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.disconnect_peer(&fp);
    Ok(())
}

#[tauri::command]
pub(crate) fn friends_list(
    status: Option<String>,
    state: State<AppState>,
) -> Result<Vec<PeerRecord>, String> {
    Ok(engine(&state)?.friends(status.as_deref()))
}

#[tauri::command]
pub(crate) fn conversations_list(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::Conversation>, String> {
    Ok(engine(&state)?.conversations())
}

#[tauri::command]
pub(crate) fn conversations_overview(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ConversationSummary>, String> {
    let store = open_store(&state)?;
    let fp = identity_fp(&state);
    store.conversations_with_counts(&fp).map_err(err)
}

#[tauri::command]
pub(crate) fn dm_open(
    peer_fp: String,
    peer_nick: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::Conversation, String> {
    engine(&state)?.open_dm(&peer_fp, &peer_nick).map_err(err)
}

#[tauri::command]
pub(crate) fn delete_conversation(conv_id: String, state: State<AppState>) -> Result<(), String> {
    let st = open_store(&state)?;
    st.delete_conversation(&conv_id).map_err(err)?;
    Ok(())
}

#[tauri::command]
pub(crate) fn privacy_get(state: State<AppState>) -> Result<PrivacySettings, String> {
    let store = open_store(&state)?;
    let mode = store
        .kv_get("privacy.mode")
        .unwrap_or_else(|| "encrypted".into());
    let mut settings = PrivacySettings::from_mode(&mode);
    if let Some(eng) = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        settings.proxy_effective = eng.relay_is_proxied();
    }
    Ok(settings)
}

#[tauri::command]
pub(crate) fn privacy_set(mode: String, state: State<AppState>) -> Result<PrivacySettings, String> {
    let valid = matches!(mode.as_str(), "normal" | "encrypted" | "proxy" | "full");
    if !valid {
        return Err("modo inválido — use: normal, encrypted, proxy ou full".into());
    }

    let engine_opt = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(eng) = engine_opt {
        eng.privacy_set_mode(&mode).map_err(err)?;
    } else {
        let store = open_store(&state)?;
        store.kv_set("privacy.mode", &mode).map_err(err)?;
    }

    let store = open_store(&state)?;
    let mut settings = PrivacySettings::from_mode(&mode);
    store
        .kv_set(
            "privacy.encryption",
            if settings.encryption_enabled {
                "1"
            } else {
                "0"
            },
        )
        .map_err(err)?;
    store
        .kv_set("privacy.tor", if settings.tor_proxy { "1" } else { "0" })
        .map_err(err)?;
    store
        .kv_set(
            "privacy.udp_discovery",
            if settings.udp_discovery { "1" } else { "0" },
        )
        .map_err(err)?;
    store
        .kv_set(
            "privacy.padding",
            if settings.metadata_padding { "1" } else { "0" },
        )
        .map_err(err)?;
    store
        .kv_set(
            "privacy.obfuscation",
            if settings.traffic_obfuscation {
                "1"
            } else {
                "0"
            },
        )
        .map_err(err)?;

    tracing::info!(
        mode = %mode,
        encryption = settings.encryption_enabled,
        tor = settings.tor_proxy,
        udp = settings.udp_discovery,
        padding = settings.metadata_padding,
        obfuscation = settings.traffic_obfuscation,
        "modo de privacidade alterado"
    );
    if let Some(eng) = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        settings.proxy_effective = eng.relay_is_proxied();
    }
    Ok(settings)
}

#[tauri::command]
pub(crate) fn proxy_addr_get(
    mode: Option<String>,
    state: State<AppState>,
) -> Result<ProxyConfig, String> {
    let store = open_store(&state)?;
    let mode = mode.filter(|m| valid_privacy_mode(m)).unwrap_or_else(|| {
        store
            .kv_get("privacy.mode")
            .unwrap_or_else(|| "encrypted".into())
    });
    let saved = store
        .kv_get(proxy_addr_key(&mode))
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    match saved {
        Some(addr) => Ok(ProxyConfig {
            addr,
            is_default: false,
        }),
        None => {
            let addr = if mode == "full" {
                "127.0.0.1:9050"
            } else {
                "127.0.0.1:1080"
            }
            .to_string();
            Ok(ProxyConfig {
                addr,
                is_default: true,
            })
        }
    }
}

#[tauri::command]
pub(crate) fn proxy_addr_set(
    addr: String,
    mode: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let engine_opt = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let mode =
        mode.filter(|m| valid_privacy_mode(m))
            .unwrap_or_else(|| match engine_opt.as_ref() {
                Some(eng) => eng.privacy_mode(),
                None => open_store(&state)
                    .ok()
                    .and_then(|s| s.kv_get("privacy.mode"))
                    .unwrap_or_else(|| "encrypted".into()),
            });
    match engine_opt {
        Some(eng) => eng.set_anonymity_addr(&mode, &addr).map_err(err),
        None => {
            let trimmed = addr.trim();
            let store = open_store(&state)?;
            if trimmed.is_empty() {
                store.kv_delete(proxy_addr_key(&mode)).map_err(err)?;
            } else {
                let (_, port) = trimmed
                    .rsplit_once(':')
                    .ok_or("formato inválido — use host:porta")?;
                port.parse::<u16>()
                    .map_err(|_| "porta inválida".to_string())?;
                store.kv_set(proxy_addr_key(&mode), trimmed).map_err(err)?;
            }
            Ok(())
        }
    }
}

#[tauri::command]
pub(crate) async fn proxy_test(addr: String) -> Result<u64, String> {
    let trimmed = addr.trim().to_string();
    if trimmed.is_empty() {
        return Err("informe o endereço do proxy (ex.: 127.0.0.1:9050 para Tor)".into());
    }
    distorrent_core::net::relay::proxy_online_test(&trimmed).await
}

#[tauri::command]
pub(crate) fn unread_count(conv_id: String, state: State<AppState>) -> Result<i64, String> {
    let st = open_store(&state)?;
    let fp = identity_fp(&state);
    st.unread_count_for(&conv_id, &fp).map_err(err)
}

#[tauri::command]
pub(crate) fn dm_intro_state(
    conv_id: String,
    state: State<AppState>,
) -> Result<distorrent_core::social::IntroState, String> {
    let st = open_store(&state)?;
    let fp = identity_fp(&state);
    let conv = st
        .get_conversation(&conv_id)
        .map_err(err)?
        .ok_or_else(|| "conversa inexistente".to_string())?;
    if conv.kind != "dm" {
        return Err("não é uma conversa direta".into());
    }
    st.dm_intro_state(&conv_id, &conv.peer_fp, &fp).map_err(err)
}

#[tauri::command]
pub(crate) fn unread_mentions(state: State<AppState>) -> Result<i64, String> {
    let fp = identity_fp(&state);
    open_store(&state)?.unread_mentions(&fp).map_err(err)
}

#[tauri::command]
pub(crate) fn peer_rtt(fp: String, state: State<AppState>) -> Result<Option<u64>, String> {
    Ok(engine(&state)?.peer_rtt_ms(fp.trim()))
}
