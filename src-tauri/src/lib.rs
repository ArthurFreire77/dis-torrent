#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use distorrent_core::net::engine::{NetworkEngine, NetworkState};
use distorrent_core::protocol::MessageEnvelope;
use distorrent_core::storage::{PeerRecord, Store, StoredMessage};
use distorrent_core::{Identity, Keypair};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

mod background;
mod sharebar;
mod updater;

use background::{
    app_hide_to_tray, app_quit, app_show_window, autostart_ensure, autostart_get,
    autostart_mark_decided, autostart_set, background_prefs_get, background_prefs_set,
    background_set_connection, call_ring_start, call_ring_stop, notification_cancel,
    notification_cancel_all, notification_permission_state, notification_request_permission,
    notification_show, notify_prefs_set, window_toggle_fullscreen,
};

fn downloads_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("downloads")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                match api.register_android_plugin("com.distorrent.app", "DownloadsPlugin") {
                    Ok(handle) => {
                        app.manage(handle);
                    }
                    Err(e) => {
                        eprintln!(
                            "plugin downloads NÃO registrado no Android ({e}); \
                             download fica na área privada do app e a UI avisa"
                        );
                    }
                }
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = (&app, &api);
            }
            Ok(())
        })
        .build()
}

#[tauri::command]
fn save_public_copy(app: AppHandle, path: String, name: String) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        let handle = app
            .try_state::<tauri::plugin::PluginHandle<tauri::Wry>>()
            .ok_or_else(|| {
                "o plugin de downloads não está registrado neste aparelho — \
             o arquivo continua na área do app"
                    .to_string()
            })?;
        #[derive(serde::Deserialize)]
        struct Res {
            path: String,
        }
        let r: Res = handle
            .run_mobile_plugin("save", serde_json::json!({ "path": path, "name": name }))
            .map_err(|e| format!("não foi possível gravar em Downloads do celular: {e}"))?;
        if r.path.trim().is_empty() {
            return Err("o Android devolveu caminho vazio ao salvar em Downloads".into());
        }
        Ok(r.path)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (&app, &name);
        Ok(path)
    }
}

struct AppState {
    engine: Mutex<Option<Arc<NetworkEngine>>>,
    data_dir: PathBuf,
    unlocked: Mutex<bool>,
    cache: distorrent_core::cache::DiskLru,
    auth_limit: distorrent_core::authlimit::AuthLimiter,
}

const AUTH_ORIGIN: &str = "desktop";

fn auth_key(store: &Store, suffix: &str) -> String {
    let account = store
        .load_identity()
        .map(|i| i.fingerprint)
        .unwrap_or_else(|| "no-identity".to_string());
    distorrent_core::authlimit::AuthLimiter::key(&format!("{account}:{suffix}"), AUTH_ORIGIN)
}

fn auth_guard(state: &State<AppState>, key: &str) -> Result<(), String> {
    match state.auth_limit.check(key) {
        distorrent_core::authlimit::Decision::Allowed => Ok(()),
        distorrent_core::authlimit::Decision::Blocked { retry_after } => {
            let secs = retry_after.as_secs().max(1);
            tracing::warn!(
                fingerprint = %key,
                bloqueado_ate_s = secs,
                "tentativa de desbloqueio recusada: limite de tentativas"
            );
            Err(format!(
                "muitas tentativas incorretas. Tente de novo em {secs}s."
            ))
        }
    }
}

fn auth_fail(state: &State<AppState>, key: &str, motivo: &str) -> String {
    let out = state.auth_limit.record_failure(key);
    if out.locked_now {
        let secs = out.retry_after.map(|d| d.as_secs()).unwrap_or(0).max(1);
        tracing::warn!(
            fingerprint = %key,
            motivo = %motivo,
            bloqueado_s = secs,
            "desbloqueio falhou — limite de tentativas atingido"
        );
        return format!("senha incorreta. Mais {secs}s de espera antes de tentar de novo.");
    }
    tracing::warn!(
        fingerprint = %key,
        motivo = %motivo,
        tentativas_restantes = out.remaining,
        "desbloqueio falhou"
    );
    "senha incorreta".into()
}

fn auth_ok(state: &State<AppState>, key: &str) {
    state.auth_limit.record_success(key);
    tracing::info!(fingerprint = %key, "cofre desbloqueado");
}

#[derive(Debug, Serialize)]
struct PeerView {
    #[serde(flatten)]
    record: PeerRecord,
    state: NetworkState,
    via_relay: bool,
    last_direct_error: Option<String>,
    last_relay_error: Option<String>,
    direct_attempts: u64,
    relay_attempts: u64,
    announce_seen_ms: i64,
    last_reject: Option<String>,
    last_reject_ms: i64,
    send_gave_up: u64,
}

#[derive(Debug, Serialize)]
struct NetDiagView {
    stun_ok: Option<bool>,
    stun_addr: Option<String>,
    stun_ms: i64,
    announce_addr: Option<String>,
    announce_ms: i64,
    nat_source: Option<String>,
    dht_ok: Option<bool>,
    dht_ms: i64,
}

// Seção 1: derive
#[derive(Debug, Serialize)]
struct NetworkStatusView {
    state: NetworkState,
    online_peers: usize,
    listen_port: u16,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn db_path(state: &State<AppState>) -> PathBuf {
    state.data_dir.join("distorrent.db")
}

fn open_store(state: &State<AppState>) -> Result<Store, String> {
    Store::open(&db_path(state)).map_err(err)
}

#[derive(Debug, Serialize)]
struct LocalAddresses {
    localhost: String,
    lan: Option<String>,
    lan_all: Vec<String>,
    port: u16,
}

fn local_ipv4_addresses() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if s.connect("192.0.2.1:9").is_ok() {
            if let Ok(a) = s.local_addr() {
                let ip = a.ip();
                let v4 = !ip.is_loopback() && !ip.is_unspecified() && ip.is_ipv4();
                if v4 {
                    out.push(ip.to_string());
                }
            }
        }
    }
    out
}

#[tauri::command]
fn hide_share_bar() -> bool {
    crate::sharebar::hide_share_bar()
}

#[tauri::command]
fn share_bar_watch(ativo: bool) {
    if ativo {
        crate::sharebar::watch_share_bar();
    } else {
        crate::sharebar::unwatch_share_bar();
    }
}

#[tauri::command]
fn local_addresses(port: Option<u16>, state: State<AppState>) -> Result<LocalAddresses, String> {
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

const DEV_PORT: u16 = 5173;

#[tauri::command]
fn identity_get(app: AppHandle, state: State<AppState>) -> Result<Option<Identity>, String> {
    let store = open_store(&state)?;
    let Some(id) = store.load_identity() else {
        return Ok(None);
    };
    let vault_on = store.kv_get("vault.on").as_deref() == Some("1");
    let stored = store.load_secret_hex().unwrap_or_default();
    let has_valid_blob = stored.len() >= 88;

    if vault_on && has_valid_blob {
        return Ok(None);
    }
    if !stored.is_empty() && stored.len() >= 32 {
        let _ = store.kv_set("identity.secret.backup", &stored);
        let _ = store.kv_delete("vault.on");
        boot_engine_with_store(&app, &state, store)?;
        return Ok(Some(id));
    }
    if let Ok(entry) = keyring::Entry::new("distorrent-app", "identity.secret") {
        if let Ok(secret) = entry.get_password() {
            if !secret.is_empty() && secret.len() >= 32 {
                let _ = store.save_identity(&id, &secret);
                let _ = store.kv_set("identity.secret.backup", &secret);
                let _ = store.kv_delete("vault.on");
                boot_engine_with_store(&app, &state, store)?;
                return Ok(Some(id));
            }
        }
    }
    if let Some(bk) = store.kv_get("identity.secret.backup") {
        if !bk.is_empty() && bk.len() >= 32 {
            let _ = store.save_identity(&id, &bk);
            let _ = store.kv_delete("vault.on");
            boot_engine_with_store(&app, &state, store)?;
            return Ok(Some(id));
        }
    }
    tracing::warn!("identidade sem segredo recuperável — requer intervenção do usuário");
    return Err(
        "segredo da identidade não encontrado — tente reiniciar o app ou restaurar backup".into(),
    );
}

#[tauri::command]
fn identity_create(
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

#[derive(Debug, Serialize)]
struct VaultStatus {
    has_identity: bool,
    has_vault: bool,
}

#[tauri::command]
fn vault_status(state: State<AppState>) -> Result<VaultStatus, String> {
    let store = open_store(&state)?;
    let stored = store.load_secret_hex().unwrap_or_default();
    let has_vault = store.kv_get("vault.on").as_deref() == Some("1") && stored.len() >= 88;
    Ok(VaultStatus {
        has_identity: store.load_identity().is_some(),
        has_vault,
    })
}

// Seção 2: tauri
#[tauri::command]
fn vault_unlock(
    app: AppHandle,
    password: String,
    state: State<AppState>,
) -> Result<Identity, String> {
    let store = open_store(&state)?;
    let key = auth_key(&store, "unlock");
    auth_guard(&state, &key)?;

    let mut identity = store.load_identity().ok_or("sem identidade")?;
    let stored = store.load_secret_hex().ok_or("sem cofre")?;
    let blob = hex::decode(&stored).map_err(|_| "cofre corrompido".to_string())?;

    let secret = match distorrent_core::vault::open_sealed(&blob, &password) {
        Ok(s) => s,
        Err(e) => {
            return Err(auth_fail(&state, &key, &e.to_string()));
        }
    };

    auth_ok(&state, &key);

    if identity.pubkey_hex.is_empty() {
        if let Ok(kp) = Keypair::from_secret_hex(&secret) {
            identity.pubkey_hex = kp.public_hex();
            let _ = store.save_identity(&identity, &stored);
        }
    }
    *state.unlocked.lock().unwrap_or_else(|e| e.into_inner()) = true;
    boot_engine_with_secret(&app, &state, &store, secret)?;
    Ok(identity)
}

#[tauri::command]
fn vault_change(old: String, new: String, state: State<AppState>) -> Result<(), String> {
    let store = open_store(&state)?;
    let key = auth_key(&store, "change");
    auth_guard(&state, &key)?;

    let stored = store.load_secret_hex().ok_or("sem cofre")?;
    let blob = hex::decode(&stored).map_err(|_| "cofre corrompido".to_string())?;
    let secret = match distorrent_core::vault::open_sealed(&blob, &old) {
        Ok(s) => s,
        Err(e) => return Err(auth_fail(&state, &key, &e.to_string())),
    };
    let newblob = match distorrent_core::vault::seal_secret(&secret, &new) {
        Ok(b) => b,
        Err(e) => return Err(e.to_string()),
    };
    store
        .save_secret_blob(&hex::encode(&newblob))
        .map_err(err)?;
    auth_ok(&state, &key);
    Ok(())
}

#[tauri::command]
fn identity_rename(
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
    let current_secret = store.load_secret_hex().unwrap_or_default();
    store
        .save_identity(&identity, &current_secret)
        .map_err(err)?;
    restart_engine(&app, &state)?;
    Ok(identity)
}

fn persist_secret(store: &Store, kp: &Keypair, identity: &Identity) -> Result<(), String> {
    let secret = kp.secret_hex();
    #[cfg(target_os = "android")]
    {
        tracing::info!("Android: salvando secret no SQLite");
        store.save_identity(identity, &secret).map_err(err)?;
        let _ = store.kv_set("identity.secret.backup", &secret);
        return Ok(());
    }
    match keyring::Entry::new("distorrent-app", "identity.secret") {
        Ok(entry) => match entry.set_password(&secret) {
            Ok(_) => {
                store.save_identity(identity, &secret).map_err(err)?;
                let _ = store.kv_set("identity.secret.backup", &secret);
            }
            Err(e) => {
                tracing::warn!("keyring set_password falhou ({e}); fallback SQLite");
                store.save_identity(identity, &secret).map_err(err)?;
                let _ = store.kv_set("identity.secret.backup", &secret);
            }
        },
        Err(e) => {
            tracing::warn!("keyring indisponível ({e}); secret no SQLite local");
            store.save_identity(identity, &secret).map_err(err)?;
            let _ = store.kv_set("identity.secret.backup", &secret);
        }
    }
    Ok(())
}

fn load_secret(store: &Store, unlocked: bool) -> Result<String, String> {
    let stored = store.load_secret_hex().unwrap_or_default();
    if store.kv_get("vault.on").as_deref() == Some("1") {
        if unlocked {
            return Err("usar cache".into());
        }
        return Err("bloqueado — informe a senha".into());
    }
    if !stored.is_empty() {
        return Ok(stored);
    }
    if let Ok(entry) = keyring::Entry::new("distorrent-app", "identity.secret") {
        if let Ok(s) = entry.get_password() {
            if !s.is_empty() {
                return Ok(s);
            }
        }
    }
    if let Some(bk) = store.kv_get("identity.secret.backup") {
        if !bk.is_empty() {
            return Ok(bk);
        }
    }
    Err("segredo da identidade não encontrado".into())
}

fn boot_engine_with_secret(
    app: &AppHandle,
    state: &State<AppState>,
    store: &Store,
    secret: String,
) -> Result<(), String> {
    tauri::async_runtime::block_on(async {
        let identity = store.load_identity().ok_or("sem identidade")?;
        let kp = Keypair::from_secret_hex(&secret).map_err(err)?;
        let engine = NetworkEngine::new_with_identity(
            Arc::new(Store::open(&db_path(state)).map_err(err)?),
            kp,
            identity.clone(),
            state.data_dir.clone(),
        );
        engine.start().map_err(err)?;
        *state.engine.lock().unwrap_or_else(|e| e.into_inner()) = Some(engine.clone());
        forward_events(app, engine);
        Ok(())
    })
}

fn boot_engine_if_needed(app: &AppHandle, state: &State<AppState>) -> Result<(), String> {
    let store = open_store(state)?;
    boot_engine_with_store(app, state, store)
}

// Seção 3: boot_engine_with_store
fn boot_engine_with_store(
    app: &AppHandle,
    state: &State<AppState>,
    store: Store,
) -> Result<(), String> {
    if state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
    {
        return Ok(());
    }
    tauri::async_runtime::block_on(async {
        if store.kv_get("vault.on").as_deref() == Some("1")
            && !*state.unlocked.lock().unwrap_or_else(|e| e.into_inner())
        {
            return Ok(());
        }
        if let Err(e) = store.revert_all_sending_to_pending() {
            tracing::warn!("recuperação de envios pendentes falhou: {e}");
        }
        match retention_apply(&store) {
            Ok(n) if n > 0 => tracing::info!("limpeza automática escondeu {n} mensagens"),
            Ok(_) => {}
            Err(e) => tracing::warn!("limpeza automática falhou: {e}"),
        }
        let identity = store.load_identity().ok_or("sem identidade")?;
        let secret = load_secret(&store, true)?;
        let kp = Keypair::from_secret_hex(&secret).map_err(err)?;
        let engine = NetworkEngine::new_with_identity(
            Arc::new(store),
            kp,
            identity.clone(),
            state.data_dir.clone(),
        );
        engine.start().map_err(err)?;
        *state.engine.lock().unwrap_or_else(|e| e.into_inner()) = Some(engine.clone());
        forward_events(app, engine);
        Ok(())
    })
}

fn restart_engine(app: &AppHandle, state: &State<AppState>) -> Result<(), String> {
    {
        let guard = state.engine.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = guard.as_ref() {
            e.shutdown();
        }
    }
    *state.engine.lock().unwrap_or_else(|e| e.into_inner()) = None;
    boot_engine_if_needed(app, state)
}

fn forward_events(app: &AppHandle, engine: Arc<NetworkEngine>) {
    let mut rx = engine.subscribe();
    let handle = app.clone();
    let notify_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    native_notice(&notify_handle, &ev);
                    if let Err(e) = handle.emit("distorrent://event", &ev) {
                        tracing::warn!("emit falhou: {e}");
                    }
                }
                Err(distorrent_core::BroadcastRecvError::Lagged(n)) => {
                    tracing::warn!("eventos descartados na UI ({n}) — pump segue vivo");
                }
                Err(distorrent_core::BroadcastRecvError::Closed) => break,
            }
        }
    });
}

fn janela_em_primeiro_plano(app: &AppHandle) -> bool {
    match app.get_webview_window("main") {
        Some(w) => {
            let visivel = w.is_visible().unwrap_or(false);
            let focado = w.is_focused().unwrap_or(false);
            visivel && focado
        }
        None => false,
    }
}

fn native_notice(app: &AppHandle, ev: &distorrent_core::EngineEvent) {
    use distorrent_core::EngineEvent as E;

    let store_for_prefs = app.try_state::<AppState>().and_then(|s| {
        distorrent_core::storage::Store::open(&s.data_dir.join("distorrent.db")).ok()
    });
    let prefs = store_for_prefs
        .as_ref()
        .map(|st| {
            (
                st.kv_get("notify.system").as_deref() != Some("0"),
                st.kv_get("notify.preview").as_deref() != Some("0"),
            )
        })
        .unwrap_or((true, true));
    if !prefs.0 {
        return;
    }

    match ev {
        E::MessageNew(m) => {
            if let Some(eu) = store_for_prefs
                .as_ref()
                .and_then(|st| st.load_identity().map(|i| i.fingerprint))
            {
                if eu == m.author_fp {
                    return;
                }
            }
            if janela_em_primeiro_plano(app) {
                return;
            }
            {
                let level = store_for_prefs
                    .as_ref()
                    .and_then(|st| st.kv_get("notify.policy"))
                    .map(|raw| nivel_do_canal(&raw, &m.conv_id, &store_for_prefs));
                if let Some(lv) = level {
                    if lv == "none" {
                        return;
                    }
                    if lv == "mentions" {
                        let eu = store_for_prefs
                            .as_ref()
                            .and_then(|st| st.load_identity().map(|i| i.fingerprint))
                            .unwrap_or_default();
                        if eu.is_empty() || !m.body.contains(&eu) {
                            return;
                        }
                    }
                }
            }
            let store = store_for_prefs;
            let autor = m.author_fp.clone();
            let conv = store
                .as_ref()
                .and_then(|st| st.get_conversation(&m.conv_id).ok().flatten());
            let titulo = conv
                .as_ref()
                .and_then(|c| {
                    if c.kind == "dm" {
                        store
                            .as_ref()
                            .and_then(|st| st.get_peer(&autor).ok().flatten())
                            .map(|p| p.nickname)
                    } else {
                        Some(c.title.clone())
                    }
                })
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| autor.chars().take(8).collect());
            // Seção 4: corpo
            let corpo = if prefs.1 {
                resumo_mensagem(&m.body)
            } else {
                "Nova mensagem".to_string()
            };
            let id = background::notification_id_for(&format!("conv:{}", m.conv_id));
            let _ = background::notification_show_inner(
                app,
                id,
                titulo,
                corpo,
                Some(m.conv_id.clone()),
                false,
                false,
            );
        }
        E::CallIncoming {
            call_id, from_fp, ..
        } => {
            if janela_em_primeiro_plano(app) {
                return;
            }
            let store = app.try_state::<AppState>().and_then(|s| {
                distorrent_core::storage::Store::open(&s.data_dir.join("distorrent.db")).ok()
            });
            let quem = store
                .as_ref()
                .and_then(|st| st.get_peer(from_fp).ok().flatten())
                .map(|p| p.nickname)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| from_fp.chars().take(8).collect());
            let id = background::notification_id_for(&format!("call:{call_id}"));
            let _ = background::notification_show_inner(
                app,
                id,
                format!("{quem} está ligando"),
                "Toque para abrir e atender".to_string(),
                None,
                true,
                false,
            );
        }
        E::CallEnded { call_id, .. } => {
            let id = background::notification_id_for(&format!("call:{call_id}"));
            background::notification_cancel_inner(app, id);
        }
        _ => {}
    }
}

fn resumo_mensagem(body: &str) -> String {
    if body.starts_with('\u{1F4CE}') {
        return "Enviou um arquivo".to_string();
    }
    if body.starts_with("__DISTORRENT_FILE__") {
        return "Enviou um arquivo".to_string();
    }
    let limpo = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if limpo.is_empty() {
        return "Nova mensagem".to_string();
    }
    let mut out: String = limpo.chars().take(140).collect();
    if limpo.chars().count() > 140 {
        out.push('…');
    }
    out
}

fn nivel_do_canal(
    raw: &str,
    conv_id: &str,
    store: &Option<distorrent_core::storage::Store>,
) -> String {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return "all".to_string();
    };
    if let Some(lvl) = v
        .get("channels")
        .and_then(|c| c.get(conv_id))
        .and_then(|x| x.as_str())
    {
        return lvl.to_string();
    }
    if let Some(srv) = store
        .as_ref()
        .and_then(|st| st.channel_community(conv_id).ok().flatten())
    {
        let muted = v
            .get("servers")
            .and_then(|s| s.as_array())
            .map(|arr| arr.iter().any(|x| x.as_str() == Some(srv.as_str())))
            .unwrap_or(false);
        if muted {
            return "none".to_string();
        }
    }
    v.get("default")
        .and_then(|x| x.as_str())
        .unwrap_or("all")
        .to_string()
}

#[tauri::command]
fn network_status(state: State<AppState>) -> Result<NetworkStatusView, String> {
    let engine = engine(&state)?;
    Ok(NetworkStatusView {
        state: engine.aggregated_state(),
        online_peers: engine.online_peer_fps().len(),
        listen_port: engine.listen_port(),
    })
}

#[tauri::command]
fn peers_list(state: State<AppState>) -> Result<Vec<PeerView>, String> {
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
fn webrtc_report(info: String) {
    eprintln!("[distorrent-probe] {info}");
}

#[tauri::command]
fn net_diag(state: State<AppState>) -> Result<NetDiagView, String> {
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

// Seção 5: tauri
#[tauri::command]
async fn relay_status(
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
fn connect_addr(
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
fn disconnect_peer(fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.disconnect_peer(&fp);
    Ok(())
}

#[derive(Debug, Serialize)]
struct CommunityView {
    id: String,
    name: String,
    owner_fp: String,
    channels: Vec<(String, String)>,
    members: Vec<(String, String, String)>,
    description: String,
    category: String,
    icon: String,
    is_owner: bool,
    /// `true` = qualquer um entra (com rate limit); `false` = só por convite.
    is_public: bool,
}

#[derive(Debug, Serialize)]
struct MemberPairingView {
    fp: String,
    nickname: String,
    role: String,
    state: String,
    via_relay: bool,
    is_owner: bool,
    is_self: bool,
}

#[derive(Debug, Serialize)]
struct InviteView {
    token: String,
    link: String,
    expires_at_ms: i64,
    scope: String,
}

#[tauri::command]
fn communities_list(state: State<AppState>) -> Result<Vec<CommunityView>, String> {
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
fn community_members(
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
fn create_community(
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
fn community_set_meta(
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
fn community_set_public(
    community_id: String,
    is_public: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .community_set_public(&community_id, is_public)
        .map_err(err)
}

#[tauri::command]
fn join_public_community(
    host_fp: String,
    community_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    engine(&state)?
        .join_public_community(&host_fp, &community_id)
        .map_err(err)
}

#[tauri::command]
fn make_invite(
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

// Seção 6: presentation_error
fn presentation_error(e: impl std::fmt::Display) -> String {
    let raw = e.to_string();
    raw.strip_prefix("protocol: ")
        .or_else(|| raw.strip_prefix("crypto: "))
        .or_else(|| raw.strip_prefix("storage: "))
        .unwrap_or(&raw)
        .to_string()
}

#[tauri::command]
fn join_community(token: String, state: State<AppState>) -> Result<String, String> {
    engine(&state)?
        .join_community(token.trim())
        .map_err(presentation_error)
}

#[tauri::command]
fn make_invite_link(
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
fn send_channel_message(
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

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct RolePatch {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    color: Option<String>,
    #[serde(default)]
    permissions: Option<i64>,
    #[serde(default)]
    hoist: Option<bool>,
    #[serde(default)]
    mentionable: Option<bool>,
    #[serde(default)]
    position: Option<i64>,
}

fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}

#[derive(Debug, Clone, Default, serde::Deserialize)]
struct BotPatch {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(
        default,
        rename = "roleId",
        alias = "role_id",
        deserialize_with = "double_option"
    )]
    role_id: Option<Option<String>>,
    #[serde(default)]
    online: Option<bool>,
    #[serde(default)]
    config: Option<String>,
}

#[tauri::command]
fn channel_create(
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
fn channel_delete(
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
fn channel_rename(
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

// Seção 7: tauri
#[tauri::command]
fn channel_set_topic(
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
fn channel_set_category(
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
fn channel_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::ChannelMetaRow>, String> {
    engine(&state)?.channel_list(&community_id).map_err(err)
}

#[tauri::command]
fn community_rename(
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
fn role_create(
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
fn role_update(
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
fn role_delete(
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
fn roles_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::RoleRow>, String> {
    engine(&state)?.roles_list(&community_id).map_err(err)
}

#[tauri::command]
fn member_roles(
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
fn member_assign_role(
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

// Seção 8: tauri
#[tauri::command]
fn member_unassign_role(
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
fn member_kick(community_id: String, fp: String, state: State<AppState>) -> Result<(), String> {
    if fp.trim().is_empty() {
        return Err("fp vazio".into());
    }
    engine(&state)?
        .member_kick(&community_id, fp.trim())
        .map_err(err)
}

#[tauri::command]
fn server_rules_get(
    community_id: String,
    state: State<AppState>,
) -> Result<distorrent_core::moderation::ServerRules, String> {
    engine(&state)?
        .server_rules_get(community_id.trim())
        .map_err(err)
}

#[tauri::command]
fn server_rules_set(
    rules: distorrent_core::moderation::ServerRules,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.server_rules_set(rules).map_err(err)
}

#[tauri::command]
fn audit_list(
    community_id: String,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::moderation::AuditEntry>, String> {
    engine(&state)?
        .audit_list(community_id.trim(), limit.unwrap_or(100))
        .map_err(err)
}

#[tauri::command]
fn reputation_get(fp: String, state: State<AppState>) -> Result<(String, i32, u32), String> {
    engine(&state)?.reputation_get(fp.trim()).map_err(err)
}

#[tauri::command]
fn safety_number(peer_fp: String, state: State<AppState>) -> Result<String, String> {
    engine(&state)?.safety_number(peer_fp.trim()).map_err(err)
}

#[tauri::command]
fn moderate(
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
fn report_user(
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
fn validate_name(
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
fn random_name() -> String {
    distorrent_core::names::random_name()
}

#[derive(serde::Serialize)]
struct NameCheckView {
    ok: bool,
    normalized: String,
    errors: Vec<String>,
    suggestions: Vec<String>,
}

#[tauri::command]
fn bot_create(
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
fn bot_update(
    community_id: String,
    bot_id: String,
    patch: Option<BotPatch>,
    name: Option<String>,
    avatar: Option<String>,
    role_id: Option<String>,
    online: Option<bool>,
    config: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    // Seção 9: p
    let p = patch.unwrap_or_default();
    if let Some(c) = config.as_deref().or(p.config.as_deref()) {
        if c.len() > 16 * 1024 {
            return Err("config do bot muito grande (máx 16KB)".into());
        }
    }
    let merged = distorrent_core::storage::BotPatch {
        name: name.or(p.name),
        avatar: avatar.or(p.avatar),
        role_id: role_id.map(|r| Some(r)).or(p.role_id),
        online: online.or(p.online),
        config: config.or(p.config),
    };
    if merged.name.is_none()
        && merged.avatar.is_none()
        && merged.role_id.is_none()
        && merged.online.is_none()
        && merged.config.is_none()
    {
        return Err("nada para atualizar no bot".into());
    }
    engine(&state)?
        .bot_update(&community_id, &bot_id, merged)
        .map_err(err)
}

#[tauri::command]
fn bot_delete(community_id: String, bot_id: String, state: State<AppState>) -> Result<(), String> {
    if bot_id.trim().is_empty() {
        return Err("bot_id vazio".into());
    }
    engine(&state)?
        .bot_delete(&community_id, bot_id.trim())
        .map_err(err)
}

#[tauri::command]
fn bots_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::BotRow>, String> {
    engine(&state)?.bots_list(&community_id).map_err(err)
}

#[tauri::command]
fn bot_post_message(
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
fn bot_regen_token(
    community_id: String,
    bot_id: String,
    state: State<AppState>,
) -> Result<String, String> {
    engine(&state)?
        .bot_regen_token(&community_id, &bot_id)
        .map_err(err)
}

#[tauri::command]
async fn http_fetch(
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    _state: State<'_, AppState>,
) -> Result<HttpResponse, String> {
    use base64::Engine as _;
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
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(10_000).min(15_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(3))
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

#[derive(Debug, Serialize)]
struct HttpResponse {
    status: u16,
    body_b64: String,
    body_text: Option<String>,
    truncated: bool,
}

#[tauri::command]
fn friends_list(status: Option<String>, state: State<AppState>) -> Result<Vec<PeerRecord>, String> {
    Ok(engine(&state)?.friends(status.as_deref()))
}

#[tauri::command]
fn friend_request(
    peer_fp: String,
    state: State<AppState>,
) -> Result<distorrent_core::net::engine::FriendOutcome, String> {
    let fp = peer_fp.trim().to_lowercase();
    if !fp.chars().all(|c| c.is_ascii_hexdigit()) || fp.len() != 12 {
        return Err("fingerprint deve ter 12 hex chars".into());
    }
    let outcome = engine(&state)?.friend_request(&fp).map_err(err)?;
    Ok(outcome)
}

// Seção 10: tauri
#[tauri::command]
fn friend_respond(peer_fp: String, accept: bool, state: State<AppState>) -> Result<(), String> {
    engine(&state)?
        .friend_respond(peer_fp.trim(), accept)
        .map_err(err)
}

#[tauri::command]
fn friend_remove(peer_fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.friend_remove(peer_fp.trim()).map_err(err)
}

#[tauri::command]
fn friend_block(peer_fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.friend_block(peer_fp.trim()).map_err(err)
}

#[tauri::command]
fn friend_unblock(peer_fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.friend_unblock(peer_fp.trim()).map_err(err)
}

#[tauri::command]
fn conversations_list(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::Conversation>, String> {
    Ok(engine(&state)?.conversations())
}

#[tauri::command]
fn dm_open(
    peer_fp: String,
    peer_nick: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::Conversation, String> {
    engine(&state)?.open_dm(&peer_fp, &peer_nick).map_err(err)
}

#[tauri::command]
fn messages_list(
    conv_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::storage::StoredMessage>, String> {
    Ok(engine(&state)?.messages(&conv_id))
}

#[tauri::command]
fn message_send(
    conv_id: String,
    body: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::StoredMessage, String> {
    if body.trim().is_empty() {
        return Err("mensagem vazia".into());
    }
    engine(&state)?.send_dm(&conv_id, body.trim()).map_err(err)
}

#[tauri::command]
fn message_resend(
    msg_id: String,
    state: State<AppState>,
) -> Result<distorrent_core::storage::StoredMessage, String> {
    engine(&state)?.resend_message(&msg_id).map_err(err)
}

#[tauri::command]
fn delete_conversation(conv_id: String, state: State<AppState>) -> Result<(), String> {
    let st = open_store(&state)?;
    st.delete_conversation(&conv_id).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn message_verify(env: MessageEnvelope, pubkey_hex: String) -> Result<bool, String> {
    Ok(env.verify_with_pubkey(&pubkey_hex))
}

#[derive(Debug, Clone, Serialize)]
struct PrivacySettings {
    mode: String,
    encryption_enabled: bool,
    tor_proxy: bool,
    udp_discovery: bool,
    metadata_padding: bool,
    traffic_obfuscation: bool,
    proxy_effective: bool,
}

impl PrivacySettings {
    fn from_mode(mode: &str) -> Self {
        match mode {
            "normal" => PrivacySettings {
                mode: "normal".into(),
                encryption_enabled: false,
                tor_proxy: false,
                udp_discovery: true,
                metadata_padding: false,
                traffic_obfuscation: false,
                proxy_effective: false,
            },
            "encrypted" => PrivacySettings {
                mode: "encrypted".into(),
                encryption_enabled: true,
                tor_proxy: false,
                udp_discovery: true,
                metadata_padding: false,
                traffic_obfuscation: false,
                proxy_effective: false,
            },
            "proxy" => PrivacySettings {
                mode: "proxy".into(),
                encryption_enabled: true,
                tor_proxy: false,
                udp_discovery: false,
                metadata_padding: false,
                traffic_obfuscation: true,
                proxy_effective: false,
            },
            "full" => PrivacySettings {
                mode: "full".into(),
                encryption_enabled: true,
                tor_proxy: true,
                udp_discovery: false,
                metadata_padding: true,
                traffic_obfuscation: true,
                proxy_effective: false,
            },
            _ => PrivacySettings {
                mode: "encrypted".into(),
                encryption_enabled: true,
                tor_proxy: false,
                udp_discovery: true,
                metadata_padding: false,
                traffic_obfuscation: false,
                proxy_effective: false,
            },
        }
    }
}

#[tauri::command]
fn privacy_get(state: State<AppState>) -> Result<PrivacySettings, String> {
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
fn privacy_set(mode: String, state: State<AppState>) -> Result<PrivacySettings, String> {
    let valid = matches!(mode.as_str(), "normal" | "encrypted" | "proxy" | "full");
    if !valid {
        return Err("modo inválido — use: normal, encrypted, proxy ou full".into());
    }

    // Seção 11: engine_opt
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
fn net_limits(
    state: State<AppState>,
) -> Result<distorrent_core::net::netlimit::LimitsSnapshot, String> {
    let engine = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    match engine {
        Some(eng) => Ok(eng.net_limits_snapshot()),
        None => Err("motor de rede não está ativo (cofre trancado?)".into()),
    }
}

#[derive(Debug, Serialize)]
struct ProxyConfig {
    addr: String,
    is_default: bool,
}

fn proxy_addr_key(mode: &str) -> &'static str {
    if mode == "full" {
        "privacy.tor_addr"
    } else {
        "privacy.proxy_addr"
    }
}

fn valid_privacy_mode(mode: &str) -> bool {
    matches!(mode, "normal" | "encrypted" | "proxy" | "full")
}

#[tauri::command]
fn proxy_addr_get(mode: Option<String>, state: State<AppState>) -> Result<ProxyConfig, String> {
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
fn proxy_addr_set(
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
            // Seção 12: trimmed
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
async fn proxy_test(addr: String) -> Result<u64, String> {
    let trimmed = addr.trim().to_string();
    if trimmed.is_empty() {
        return Err("informe o endereço do proxy (ex.: 127.0.0.1:9050 para Tor)".into());
    }
    distorrent_core::net::relay::proxy_online_test(&trimmed).await
}

#[derive(Debug, Serialize)]
struct VaultExport {
    identity: Identity,
    vault_blob: String,
}

#[tauri::command]
fn vault_export(state: State<AppState>) -> Result<VaultExport, String> {
    let store = open_store(&state)?;
    let identity = store.load_identity().ok_or("sem identidade")?;
    if store.kv_get("vault.on").as_deref() != Some("1") {
        return Err("sem cofre cifrado — defina uma senha (vault) antes de exportar".into());
    }
    let vault_blob = store.load_secret_hex().ok_or("sem cofre para exportar")?;
    if vault_blob.is_empty() {
        return Err("vault vazio — não há identidade para exportar".into());
    }
    Ok(VaultExport {
        identity,
        vault_blob,
    })
}

#[tauri::command]
fn vault_import(
    identity_json: String,
    vault_blob: String,
    state: State<AppState>,
) -> Result<Identity, String> {
    let store = open_store(&state)?;

    if store.load_identity().is_some() {
        return Err(
            "já existe uma identidade neste device — exporte ou apague antes de importar".into(),
        );
    }

    let identity: Identity =
        serde_json::from_str(&identity_json).map_err(|e| format!("identity inválida: {e}"))?;

    if identity.fingerprint.is_empty() {
        return Err("fingerprint vazio na identidade importada".into());
    }

    if vault_blob.len() < 88 {
        return Err("vault blob inválido (muito curto)".into());
    }

    store.save_identity(&identity, &vault_blob).map_err(err)?;
    store.kv_set("vault.on", "1").map_err(err)?;

    Ok(identity)
}

#[derive(Debug, Serialize)]
struct SavedAccount {
    nickname: String,
    fingerprint: String,
}

#[tauri::command]
fn accounts_list(state: State<AppState>) -> Result<Vec<SavedAccount>, String> {
    let store = open_store(&state)?;
    let mut out = Vec::new();
    if let Some(id) = store.load_identity() {
        out.push(SavedAccount {
            nickname: id.nickname,
            fingerprint: id.fingerprint,
        });
    }
    if store.kv_get(&format!("imported.0.blob")).is_some() {
        for i in 0..20 {
            if let Some(fp) = store.kv_get(&format!("imported.{i}.fp")) {
                if let Some(nick) = store.kv_get(&format!("imported.{i}.nick")) {
                    if !out.iter().any(|a| a.fingerprint == fp) {
                        out.push(SavedAccount {
                            nickname: nick,
                            fingerprint: fp,
                        });
                    }
                }
            }
        }
    }
    Ok(out)
}

#[tauri::command]
fn account_save_imported(
    identity_json: String,
    vault_blob: String,
    state: State<AppState>,
) -> Result<(), String> {
    let identity: Identity =
        serde_json::from_str(&identity_json).map_err(|e| format!("identity inválida: {e}"))?;
    if identity.fingerprint.is_empty() {
        return Err("fingerprint vazio na identidade importada".into());
    }
    if vault_blob.len() < 88 {
        return Err("vault blob inválido (muito curto)".into());
    }

    let store = open_store(&state)?;
    for i in 0..20 {
        if store.kv_get(&format!("imported.{i}.fp")).is_none() {
            store
                .kv_set(&format!("imported.{i}.nick"), &identity.nickname)
                .map_err(err)?;
            store
                .kv_set(&format!("imported.{i}.fp"), &identity.fingerprint)
                .map_err(err)?;
            store
                .kv_set(&format!("imported.{i}.pubkey"), &identity.pubkey_hex)
                .map_err(err)?;
            store
                .kv_set(&format!("imported.{i}.blob"), &vault_blob)
                .map_err(err)?;
            return Ok(());
        }
    }
    Err("máximo de contas importadas atingido (20)".into())
}

#[tauri::command]
fn account_switch(fingerprint: String, state: State<AppState>) -> Result<Identity, String> {
    let store = open_store(&state)?;

    if let Some(id) = store.load_identity() {
        if id.fingerprint == fingerprint {
            return Ok(id);
        }
    }

    for i in 0..20 {
        if store.kv_get(&format!("imported.{i}.fp")).as_deref() == Some(&fingerprint) {
            let blob = store
                .kv_get(&format!("imported.{i}.blob"))
                .ok_or("vault da conta não encontrado")?;
            let nick = store
                .kv_get(&format!("imported.{i}.nick"))
                .unwrap_or_default();
            // Seção 13: pubkey_hex
            let pubkey_hex = store
                .kv_get(&format!("imported.{i}.pubkey"))
                .unwrap_or_default();

            if let Some(current_id) = store.load_identity() {
                if let Some(current_blob) = store.load_secret_hex() {
                    if !current_blob.is_empty() {
                        for j in 0..20 {
                            if store.kv_get(&format!("imported.{j}.fp")).as_deref()
                                != Some(&current_id.fingerprint)
                            {
                                if store.kv_get(&format!("imported.{j}.fp")).is_none() {
                                    store
                                        .kv_set(&format!("imported.{j}.nick"), &current_id.nickname)
                                        .map_err(err)?;
                                    store
                                        .kv_set(
                                            &format!("imported.{j}.fp"),
                                            &current_id.fingerprint,
                                        )
                                        .map_err(err)?;
                                    store
                                        .kv_set(
                                            &format!("imported.{j}.pubkey"),
                                            &current_id.pubkey_hex,
                                        )
                                        .map_err(err)?;
                                    store
                                        .kv_set(&format!("imported.{j}.blob"), &current_blob)
                                        .map_err(err)?;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            let imported_identity = Identity {
                fingerprint: fingerprint.clone(),
                pubkey_hex: if pubkey_hex.is_empty() {
                    String::new()
                } else {
                    pubkey_hex
                },
                nickname: nick,
                created_at: distorrent_core::identity::now_ms(),
            };
            store
                .save_identity(&imported_identity, &blob)
                .map_err(err)?;
            store.kv_set("vault.on", "1").map_err(err)?;

            {
                let guard = state.engine.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(e) = guard.as_ref() {
                    e.shutdown();
                }
            }
            *state.engine.lock().unwrap_or_else(|e| e.into_inner()) = None;
            *state.unlocked.lock().unwrap_or_else(|e| e.into_inner()) = false;

            return Ok(imported_identity);
        }
    }

    Err("conta não encontrada".into())
}

#[tauri::command]
fn account_remove_imported(fingerprint: String, state: State<AppState>) -> Result<(), String> {
    let store = open_store(&state)?;
    for i in 0..20 {
        if store.kv_get(&format!("imported.{i}.fp")).as_deref() == Some(&fingerprint) {
            store
                .kv_delete(&format!("imported.{i}.nick"))
                .map_err(err)?;
            store.kv_delete(&format!("imported.{i}.fp")).map_err(err)?;
            store
                .kv_delete(&format!("imported.{i}.blob"))
                .map_err(err)?;
            return Ok(());
        }
    }
    Err("conta não encontrada".into())
}

#[tauri::command]
fn social_react(
    conv_id: String,
    msg_id: String,
    emoji: String,
    state: State<AppState>,
) -> Result<bool, String> {
    engine(&state)?
        .social_react(&conv_id, &msg_id, &emoji)
        .map_err(err)
}

#[tauri::command]
fn social_reactions(
    msg_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ReactionSummary>, String> {
    let store = open_store(&state)?;
    let rows = store.reactions_for_msg(&msg_id).map_err(err)?;
    Ok(store.mark_reactions_mine(rows, &identity_fp(&state)))
}

#[tauri::command]
fn social_reactions_bulk(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ReactionSummary>, String> {
    let store = open_store(&state)?;
    let rows = store.reactions_for_msgs(&msg_ids).map_err(err)?;
    Ok(store.mark_reactions_mine(rows, &identity_fp(&state)))
}

#[tauri::command]
fn social_reply(
    conv_id: String,
    msg_id: String,
    reply_to: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_reply(&conv_id, &msg_id, &reply_to)
        .map_err(err)
}

#[tauri::command]
fn social_edit(
    conv_id: String,
    msg_id: String,
    body: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_edit(&conv_id, &msg_id, &body)
        .map_err(err)
}

#[tauri::command]
fn social_delete(conv_id: String, msg_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?
        .social_delete(&conv_id, &msg_id)
        .map_err(err)
}

#[tauri::command]
fn social_pin(
    conv_id: String,
    msg_id: String,
    pinned: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_pin(&conv_id, &msg_id, pinned)
        .map_err(err)
}

#[tauri::command]
fn social_pins(
    conv_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::MsgMetaView>, String> {
    open_store(&state)?.pins_list(&conv_id).map_err(err)
}

// Seção 14: tauri
#[tauri::command]
fn social_meta_bulk(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::MsgMetaView>, String> {
    open_store(&state)?.msg_meta_bulk(&msg_ids).map_err(err)
}

#[tauri::command]
fn social_bodies(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<(String, String)>, String> {
    let store = open_store(&state)?;
    let mut out = Vec::new();
    for id in msg_ids {
        if let Some(m) = store.message_by_id(&id).map_err(err)? {
            let body = store.effective_body(&id, &m.body).map_err(err)?;
            out.push((id, body));
        }
    }
    Ok(out)
}

#[tauri::command]
fn social_forward(
    src_msg_id: String,
    target_conv: String,
    target_channel: String,
    from_label: String,
    state: State<AppState>,
) -> Result<StoredMessage, String> {
    engine(&state)?
        .social_forward(&src_msg_id, &target_conv, &target_channel, &from_label)
        .map_err(err)
}

#[tauri::command]
fn read_set(conv_id: String, ts: i64, state: State<AppState>) -> Result<(), String> {
    open_store(&state)?.read_set(&conv_id, ts).map_err(err)?;
    if let Ok(e) = engine(&state) {
        e.notify_read(&conv_id, ts);
    }
    Ok(())
}

#[tauri::command]
fn read_all(state: State<AppState>) -> Result<Vec<distorrent_core::social::ReadCursor>, String> {
    open_store(&state)?.read_all().map_err(err)
}

#[tauri::command]
fn unread_count(conv_id: String, state: State<AppState>) -> Result<i64, String> {
    open_store(&state)?.unread_count(&conv_id).map_err(err)
}

#[tauri::command]
fn unread_mentions(state: State<AppState>) -> Result<i64, String> {
    let fp = identity_fp(&state);
    open_store(&state)?.unread_mentions(&fp).map_err(err)
}

#[tauri::command]
fn presence_set(
    status: String,
    custom: String,
    custom_emoji: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_presence_set(&status, &custom, &custom_emoji)
        .map_err(err)
}

#[tauri::command]
fn presence_list(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::PresenceView>, String> {
    open_store(&state)?.presence_list().map_err(err)
}

#[tauri::command]
fn presence_get(
    fp: String,
    state: State<AppState>,
) -> Result<distorrent_core::social::PresenceView, String> {
    open_store(&state)?.presence_get(&fp).map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
fn profile_set(
    display_name: String,
    about: String,
    avatar_b64: String,
    banner_b64: String,
    accent: String,
    remove_avatar: Option<bool>,
    remove_banner: Option<bool>,
    state: State<AppState>,
) -> Result<distorrent_core::social::ProfileView, String> {
    engine(&state)?
        .social_profile_set_full(
            &display_name,
            &about,
            &avatar_b64,
            &banner_b64,
            &accent,
            remove_avatar.unwrap_or(false),
            remove_banner.unwrap_or(false),
        )
        .map_err(err)
}

#[tauri::command]
fn profile_sync_now(state: State<AppState>) -> Result<(), String> {
    engine(&state)?.sync_profiles_with_peers();
    Ok(())
}

#[tauri::command]
fn profile_get(
    fp: String,
    state: State<AppState>,
) -> Result<distorrent_core::social::ProfileView, String> {
    open_store(&state)?.profile_get(&fp).map_err(err)
}

#[tauri::command]
fn profile_list(
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ProfileView>, String> {
    open_store(&state)?.profile_list().map_err(err)
}

#[tauri::command]
fn nickname_set(
    community_id: String,
    fp: String,
    nickname: String,
    state: State<AppState>,
) -> Result<(), String> {
    open_store(&state)?
        .nickname_set(&community_id, &fp, &nickname)
        .map_err(err)
}

#[tauri::command]
fn nickname_get(
    community_id: String,
    fp: String,
    state: State<AppState>,
) -> Result<String, String> {
    open_store(&state)?
        .nickname_get(&community_id, &fp)
        .map_err(err)
}

#[tauri::command]
fn message_search(
    q: distorrent_core::social::SearchQuery,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::SearchHit>, String> {
    open_store(&state)?.message_search(&q).map_err(err)
}

#[tauri::command]
fn messages_around(
    conv_id: String,
    ts: i64,
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<StoredMessage>, String> {
    open_store(&state)?
        .messages_around(&conv_id, ts, limit)
        .map_err(err)
}

#[tauri::command]
fn message_receipts(
    msg_ids: Vec<String>,
    state: State<AppState>,
) -> Result<Vec<(String, String, i64)>, String> {
    open_store(&state)?.receipts_for(&msg_ids).map_err(err)
}

// Seção 15: tauri
#[tauri::command]
fn thread_create(
    community_id: String,
    parent_channel: String,
    name: String,
    kind: String,
    tags: String,
    state: State<AppState>,
) -> Result<distorrent_core::social::ThreadRow, String> {
    engine(&state)?
        .social_thread_create(&community_id, &parent_channel, &name, &kind, &tags)
        .map_err(err)
}

#[tauri::command]
fn thread_list(
    community_id: String,
    parent: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::ThreadRow>, String> {
    open_store(&state)?
        .threads_list(&community_id, &parent)
        .map_err(err)
}

#[tauri::command]
fn thread_messages(
    thread_id: String,
    limit: i64,
    state: State<AppState>,
) -> Result<Vec<StoredMessage>, String> {
    open_store(&state)?
        .list_messages_thread(&thread_id, limit)
        .map_err(err)
}

#[tauri::command]
fn thread_send(
    community_id: String,
    thread_id: String,
    body: String,
    state: State<AppState>,
) -> Result<StoredMessage, String> {
    engine(&state)?
        .social_thread_send(&community_id, &thread_id, &body)
        .map_err(err)
}

#[tauri::command]
fn thread_archive(thread_id: String, archived: bool, state: State<AppState>) -> Result<(), String> {
    engine(&state)?
        .social_thread_archive(&thread_id, archived)
        .map_err(err)
}

#[tauri::command]
fn member_ban(
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
fn member_unban(community_id: String, fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?
        .social_unban(&community_id, &fp)
        .map_err(err)
}

#[tauri::command]
fn member_timeout(
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
fn ban_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::BanRow>, String> {
    open_store(&state)?.ban_list(&community_id).map_err(err)
}

#[tauri::command]
fn timeout_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::BanRow>, String> {
    open_store(&state)?.timeout_list(&community_id).map_err(err)
}

#[tauri::command]
fn channel_cfg_set(
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
fn channel_cfg_get(channel_id: String, state: State<AppState>) -> Result<i64, String> {
    open_store(&state)?
        .channel_cfg_slowmode(&channel_id)
        .map_err(err)
}

#[tauri::command]
fn poll_create(
    community_id: String,
    channel_id: String,
    question: String,
    options: Vec<String>,
    multi: bool,
    ends_at: i64,
    state: State<AppState>,
) -> Result<distorrent_core::social::PollRow, String> {
    engine(&state)?
        .social_poll_create(
            &community_id,
            &channel_id,
            &question,
            options,
            multi,
            ends_at,
        )
        .map_err(err)
}

#[tauri::command]
fn poll_list(
    community_id: String,
    channel_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::PollRow>, String> {
    open_store(&state)?
        .poll_list(&community_id, &channel_id)
        .map_err(err)
}

#[tauri::command]
fn poll_vote(
    community_id: String,
    channel_id: String,
    poll_id: String,
    option_idx: i64,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_poll_vote(&community_id, &channel_id, &poll_id, option_idx)
        .map_err(err)
}

// Seção 16: tauri
#[tauri::command]
fn poll_tally(
    poll_id: String,
    state: State<AppState>,
) -> Result<(Vec<i64>, i64, Vec<i64>), String> {
    let store = open_store(&state)?;
    let (counts, total) = store.poll_tally(&poll_id).map_err(err)?;
    let mine = store
        .poll_my_votes(&poll_id, &identity_fp(&state))
        .map_err(err)?;
    Ok((counts, total, mine))
}

#[tauri::command]
fn event_upsert(
    ev: distorrent_core::social::EventRow,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.social_event_upsert(ev).map_err(err)
}

#[tauri::command]
fn event_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::EventRow>, String> {
    open_store(&state)?.event_list(&community_id).map_err(err)
}

#[tauri::command]
fn event_interest(
    community_id: String,
    event_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_event_interest(&community_id, &event_id)
        .map_err(err)
}

#[tauri::command]
fn event_delete(
    community_id: String,
    event_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .social_event_delete(&community_id, &event_id)
        .map_err(err)
}

#[tauri::command]
fn emoji_upsert(
    e: distorrent_core::social::EmojiRow,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.social_emoji_upsert(e).map_err(err)
}

#[tauri::command]
fn emoji_list(
    community_id: String,
    state: State<AppState>,
) -> Result<Vec<distorrent_core::social::EmojiRow>, String> {
    open_store(&state)?.emoji_list(&community_id).map_err(err)
}

#[tauri::command]
fn emoji_delete(community_id: String, id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?
        .social_emoji_delete(&community_id, &id)
        .map_err(err)
}

#[tauri::command]
fn bookmark_set(
    conv_id: String,
    name: String,
    payload: String,
    state: State<AppState>,
) -> Result<(), String> {
    open_store(&state)?
        .bookmark_set(&conv_id, &name, &payload)
        .map_err(err)
}

#[tauri::command]
fn bookmark_list(conv_id: String, state: State<AppState>) -> Result<Vec<(String, String)>, String> {
    open_store(&state)?.bookmark_list(&conv_id).map_err(err)
}

fn identity_fp(state: &State<AppState>) -> String {
    open_store(state)
        .ok()
        .and_then(|s| s.load_identity().map(|i| i.fingerprint))
        .unwrap_or_default()
}

fn engine(state: &State<AppState>) -> Result<Arc<NetworkEngine>, String> {
    state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or_else(|| "motor não iniciado (sem identidade)".to_string())
}

fn is_reserved_key(key: &str) -> bool {
    key == "identity.secret" || key == "identity.secret.backup" || key.is_empty() || key.len() > 128
}

#[tauri::command]
fn secure_store(key: String, value: String) -> Result<(), String> {
    if is_reserved_key(&key) {
        return Err("chave reservada do sistema".into());
    }
    let entry = keyring::Entry::new("distorrent-app", &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_load(key: String) -> Result<Option<String>, String> {
    if is_reserved_key(&key) {
        return Err("chave reservada do sistema".into());
    }
    let entry = keyring::Entry::new("distorrent-app", &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn create_group(
    title: String,
    members: Vec<String>,
    state: State<AppState>,
) -> Result<distorrent_core::storage::Conversation, String> {
    engine(&state)?.create_group(&title, members).map_err(err)
}

#[tauri::command]
fn group_members(conv_id: String, state: State<AppState>) -> Result<Vec<(String, String)>, String> {
    Ok(engine(&state)?.group_members(&conv_id))
}

#[tauri::command]
fn group_pair_now(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_pair_now(&conv_id);
    Ok(())
}

#[tauri::command]
fn community_pair_now(community_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.community_pair_now(&community_id);
    Ok(())
}

#[tauri::command]
fn community_sync_now(community_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.community_sync_now(&community_id);
    Ok(())
}

#[tauri::command]
fn group_add(conv_id: String, fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_add(&conv_id, &fp).map_err(err)
}

#[tauri::command]
// Seção 17: group_remove
fn group_remove(conv_id: String, fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_remove(&conv_id, &fp).map_err(err)
}

#[tauri::command]
fn group_rename(conv_id: String, title: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_rename(&conv_id, &title).map_err(err)
}

#[tauri::command]
fn group_leave(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_leave(&conv_id).map_err(err)
}

#[tauri::command]
fn group_delete(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_delete(&conv_id).map_err(err)
}

#[tauri::command]
fn group_delete_local(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_delete_local(&conv_id).map_err(err)
}

#[tauri::command]
fn call_room_publish(
    call_id: String,
    conv_id: String,
    kind: String,
    participants: Vec<String>,
    state: State<AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    e.publish_room(&call_id, &conv_id, &kind, participants);
    Ok(())
}

#[tauri::command]
fn call_room_close(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.unpublish_room(&conv_id);
    Ok(())
}

#[tauri::command]
fn call_room_leave(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.leave_room(&conv_id);
    Ok(())
}

#[tauri::command]
fn call_room_join(
    conv_id: String,
    kind: String,
    state: State<AppState>,
) -> Result<(String, Vec<String>), String> {
    engine(&state)?.room_join(&conv_id, &kind).map_err(err)
}

#[tauri::command]
fn call_rooms_list(state: State<AppState>) -> Result<Vec<serde_json::Value>, String> {
    let e = engine(&state)?;
    let mut out = Vec::new();
    for ev in e.rooms_snapshot() {
        if let distorrent_core::EngineEvent::CallRoom {
            call_id,
            conv_id,
            kind,
            state,
            participants,
            host_fp,
        } = ev
        {
            out.push(serde_json::json!({
                "call_id": call_id,
                "conv_id": conv_id,
                "kind": kind,
                "state": state,
                "participants": participants,
                "host_fp": host_fp,
            }));
        }
    }
    Ok(out)
}

#[tauri::command]
async fn call_invite(
    target_fp: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.call_invite(&target_fp, &kind))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
async fn call_accept(
    call_id: String,
    from_fp: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    let e2 = e.clone();
    let (cid, fp) = (call_id.clone(), from_fp.clone());
    tauri::async_runtime::spawn_blocking(move || e.call_accept(&cid, &fp))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)?;
    e2.resume_held_call(&call_id, &from_fp).await;
    Ok(())
}

#[tauri::command]
fn call_ring_retry(
    call_id: String,
    target_fp: String,
    kind: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_ring_retry(&call_id, &target_fp, &kind)
        .map_err(err)
}

#[tauri::command]
fn call_reject(
    call_id: String,
    from_fp: String,
    reason: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_reject(&call_id, &from_fp, &reason)
        .map_err(err)
}

#[tauri::command]
async fn call_end(call_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.call_end(&call_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
fn call_offer(
    target_fp: String,
    call_id: String,
    sdp: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::CallOffer { call_id, sdp },
        )
        .map_err(err)
}

#[tauri::command]
fn call_answer(
    target_fp: String,
    call_id: String,
    sdp: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::CallAnswer { call_id, sdp },
        )
        .map_err(err)
}

// Seção 18: tauri
#[tauri::command]
fn call_ice(
    target_fp: String,
    call_id: String,
    candidate: String,
    mid: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_signal(
            &target_fp,
            distorrent_core::protocol::SecureFrame::CallIce {
                call_id,
                candidate,
                mid,
            },
        )
        .map_err(err)
}

#[tauri::command]
fn call_add_participant(
    target_fp: String,
    call_id: String,
    fp: String,
    kind: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .call_add_participant(&target_fp, &call_id, &fp, kind.as_deref().unwrap_or(""))
        .map_err(err)
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_media_available(state: State<AppState>) -> Result<bool, String> {
    match state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        Some(e) => Ok(e.voice_media_available()),
        None => Ok(distorrent_core::net::engine::native_voice_capable()),
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_media_stats(call_id: String, state: State<AppState>) -> Result<serde_json::Value, String> {
    match engine(&state)?.voice_media_stats(&call_id) {
        Some(s) => serde_json::to_value(s).map_err(|e| e.to_string()),
        None => Ok(serde_json::Value::Null),
    }
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_set_muted(call_id: String, muted: bool, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.voice_set_muted(&call_id, muted);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_hangup(call_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.voice_hangup(&call_id);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_set_deafened(
    call_id: String,
    deafened: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.voice_set_deafened(&call_id, deafened);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_video_start(
    call_id: String,
    peer_fp: String,
    source: String,
    monitor_id: Option<u32>,
    state: State<AppState>,
) -> Result<String, String> {
    let e = engine(&state)?;
    let Some(v) = e.voice() else {
        return Err("mídia nativa indisponível (voz nativa desligada?)".into());
    };
    v.video_start(&call_id, &peer_fp, &source, monitor_id)
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_video_stop(
    call_id: String,
    peer_fp: String,
    state: State<AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    if let Some(v) = e.voice() {
        v.video_stop(&call_id, &peer_fp);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_video_frame(
    call_id: String,
    peer_fp: String,
    since_seq: Option<u64>,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    let e = engine(&state)?;
    let Some(v) = e.voice() else {
        return Ok(serde_json::Value::Null);
    };
    match v.video_frame(&call_id, &peer_fp) {
        Some(f) => {
            if let Some(since) = since_seq {
                if f.seq <= since {
                    return Ok(serde_json::json!({ "seq": f.seq, "w": f.w, "h": f.h }));
                }
            }
            let b64 = {
                use base64::Engine as _;
                base64::engine::general_purpose::STANDARD.encode(&f.jpeg)
            };
            Ok(serde_json::json!({ "jpeg": b64, "w": f.w, "h": f.h, "seq": f.seq }))
        }
        None => Ok(serde_json::Value::Null),
    }
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_media_available(_state: State<AppState>) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_media_stats(
    _call_id: String,
    _state: State<AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::Value::Null)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_set_muted(_call_id: String, _muted: bool, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
// Seção 19: voice_hangup
fn voice_hangup(_call_id: String, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_set_deafened(
    _call_id: String,
    _deafened: bool,
    _state: State<AppState>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_video_start(
    _call_id: String,
    _peer_fp: String,
    _source: String,
    _monitor_id: Option<u32>,
    _state: State<AppState>,
) -> Result<String, String> {
    Err("vídeo nativo indisponível nesta plataforma".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_video_stop(
    _call_id: String,
    _peer_fp: String,
    _state: State<AppState>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_video_frame(
    _call_id: String,
    _peer_fp: String,
    _since_seq: Option<u64>,
    _state: State<AppState>,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::Value::Null)
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_mic_test_start(state: State<AppState>) -> Result<u64, String> {
    engine(&state)?
        .voice_mic_test_start()
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_mic_test_level(test_id: u64, state: State<AppState>) -> Result<f32, String> {
    Ok(engine(&state)?.voice_mic_test_level(test_id))
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_mic_test_stop(test_id: u64, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.voice_mic_test_stop(test_id);
    Ok(())
}

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_mic_name(state: State<AppState>) -> Result<String, String> {
    Ok(engine(&state)?.voice_mic_name())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_mic_test_start(_state: State<AppState>) -> Result<u64, String> {
    Err("teste de mic nativo indisponível nesta plataforma".into())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_mic_test_level(_test_id: u64, _state: State<AppState>) -> Result<f32, String> {
    Ok(0.0)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_mic_test_stop(_test_id: u64, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_mic_name(_state: State<AppState>) -> Result<String, String> {
    Ok(String::new())
}

#[tauri::command]
fn send_typing(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_typing(&conv_id).map_err(err)
}

#[tauri::command]
fn screen_share_offer(
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
fn screen_share_answer(
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
async fn voice_join(
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.voice_join(&community_id, &channel_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
async fn voice_leave(
    community_id: String,
    channel_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let e = engine(&state)?;
    tauri::async_runtime::spawn_blocking(move || e.voice_leave(&community_id, &channel_id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(err)
}

#[tauri::command]
fn voice_state(
    community_id: String,
    channel_id: String,
    muted: bool,
    deafened: bool,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .voice_state_update(&community_id, &channel_id, muted, deafened)
        .map_err(err)
}

// Seção 20: tauri
#[tauri::command]
fn voice_states(
    community_id: String,
    channel_id: String,
    state: State<AppState>,
) -> Result<Vec<(String, bool, bool)>, String> {
    Ok(engine(&state)?.list_voice_states(&community_id, &channel_id))
}

#[tauri::command]
fn file_announce(
    file_id: String,
    name: String,
    size: u64,
    chunks: u32,
    hash: String,
    state: State<AppState>,
    chunk_hashes: Option<Vec<String>>,
) -> Result<(), String> {
    if let Some(hs) = chunk_hashes {
        engine(&state)?
            .file_announce_with_chunks(&file_id, &name, size, chunks, &hash, hs)
            .map_err(err)
    } else {
        engine(&state)?
            .file_announce(&file_id, &name, size, chunks, &hash)
            .map_err(err)
    }
}

#[tauri::command]
fn file_request_chunk(
    file_id: String,
    index: u32,
    holder_fp: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .file_request_chunk(&file_id, index, &holder_fp)
        .map_err(err)
}

#[tauri::command]
fn file_send_chunk(
    target_fp: String,
    file_id: String,
    index: u32,
    data_b64: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .file_send_chunk(&target_fp, &file_id, index, &data_b64)
        .map_err(err)
}

#[tauri::command]
fn save_file(
    app: AppHandle,
    name: String,
    data_b64: String,
    state: State<AppState>,
) -> Result<String, String> {
    use std::fs;
    if data_b64.len() > 280_000_000 {
        return Err("arquivo grande demais para salvar (máx ~200MB)".into());
    }
    let bytes = {
        use base64::{engine::general_purpose, Engine as _};
        general_purpose::STANDARD
            .decode(&data_b64)
            .or_else(|_| {
                general_purpose::STANDARD_NO_PAD
                    .decode(&data_b64)
                    .map_err(|e| e.to_string())
            })
            .or_else(|_| hex::decode(&data_b64))
            .map_err(|e| format!("save_file travou em decode base64: {e}"))?
    };
    let safety = open_store(&state)
        .map(|s| media_safety_read(&s))
        .unwrap_or(MediaSafetyView {
            strip_exif: true,
            block_executables: true,
        });
    let sniffed = distorrent_core::media::sniff_mime(&bytes);
    if sniffed.is_executable() && safety.block_executables {
        return Err(format!(
            "save_file bloqueou: executável recebido por P2P (tipo real: {}) — risco de malware. Se você confia na origem, desligue o bloqueio em Configurações → Cofre & Backup → Mídia e baixe de novo.",
            sniffed.as_str()
        ));
    }
    if distorrent_core::media::extension_is_blocked(&name) && safety.block_executables {
        return Err("save_file bloqueou: extensão de executável/script recebida por P2P — risco de malware. Desligue o bloqueio em Configurações → Cofre & Backup → Mídia se tiver certeza.".into());
    }
    let bytes = if safety.strip_exif {
        match distorrent_core::media::strip_metadata(&bytes) {
            Ok(clean) => clean,
            Err(e) => {
                tracing::warn!("save_file: imagem com metadados intactos (strip falhou: {e}) — salvando original");
                bytes
            }
        }
    } else {
        bytes
    };
    let safe = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "save_file travou em sanitize: nome de arquivo inválido".to_string())?;
    if safe != name.as_str()
        || safe.trim().is_empty()
        || safe.starts_with('.')
        || safe.contains('\\')
        || safe.contains('/')
        || safe.contains('\0')
        || safe.len() > 255
    {
        return Err(
            "save_file travou em sanitize: nome de arquivo inválido (traversal bloqueado)".into(),
        );
    }
    let _ = &app;
    let downloads = {
        #[cfg(target_os = "android")]
        {
            android_private_download_dir(&app)?
        }
        #[cfg(not(target_os = "android"))]
        {
            resolve_downloads_dir()?
        }
    };
    if let Err(e) = fs::create_dir_all(&downloads) {
        return Err(format!(
            "save_file travou em mkdir {}: {e}",
            downloads.display()
        ));
    }
    let path = unique_download_path(&downloads, safe);
    let tmp = path.with_extension("distorrent-part");
    if let Err(e) = fs::write(&tmp, &bytes) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "save_file travou em write {}: {e} (Android 10+ com scoped storage pode negar escrita direta; verifique permissão de armazenamento)",
            tmp.display()
        ));
    }
    if let Err(e) = fs::rename(&tmp, &path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!(
            "save_file travou em rename {}: {e}",
            path.display()
        ));
    }
    Ok(path.to_string_lossy().to_string())
}

// Seção 21: tauri
#[tauri::command]
fn save_file_stream(
    app: AppHandle,
    job_id: String,
    name: String,
    data_b64: String,
    flush: bool,
    total_bytes: u64,
    state: State<AppState>,
) -> Result<String, String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;

    if job_id.is_empty()
        || job_id.len() > 64
        || !job_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("save_file_stream: job_id inválido".into());
    }

    let safe = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "save_file_stream: nome de arquivo inválido".to_string())?
        .to_string();
    if safe.is_empty()
        || safe.starts_with('.')
        || safe.contains('\\')
        || safe.contains('/')
        || safe.contains('\0')
        || safe.len() > 255
    {
        return Err("save_file_stream: nome de arquivo inválido (traversal bloqueado)".into());
    }

    let bytes = decode_b64_batches(&data_b64)
        .map_err(|e| format!("save_file_stream travou em decode base64: {e}"))?;

    if bytes.len() > 32 * 1024 * 1024 {
        return Err("save_file_stream: lote acima de 32 MB".into());
    }
    if total_bytes > MAX_STREAM_FILE_BYTES {
        return Err(format!(
            "arquivo grande demais para salvar (máx {})",
            crate::fmt_mb(MAX_STREAM_FILE_BYTES)
        ));
    }

    let safety = open_store(&state)
        .map(|s| media_safety_read(&s))
        .unwrap_or(MediaSafetyView {
            strip_exif: true,
            block_executables: true,
        });
    if safety.block_executables && distorrent_core::media::extension_is_blocked(&safe) {
        return Err("save_file_stream bloqueou: extensão de executável/script recebida por P2P — risco de malware. Desligue o bloqueio em Configurações → Cofre & Backup → Mídia se tiver certeza.".into());
    }

    let _ = &app;
    let downloads = {
        #[cfg(target_os = "android")]
        {
            android_private_download_dir(&app)?
        }
        #[cfg(not(target_os = "android"))]
        {
            resolve_downloads_dir()?
        }
    };
    fs::create_dir_all(&downloads).map_err(|e| format!("save_file_stream travou em mkdir: {e}"))?;

    let tmp = downloads.join(format!(".{safe}.{job_id}.distorrent-part"));

    let primeiro_lote = fs::metadata(&tmp).map(|m| m.len() == 0).unwrap_or(true);
    if primeiro_lote && safety.block_executables && !bytes.is_empty() {
        let sniffed = distorrent_core::media::sniff_mime(&bytes);
        if sniffed.is_executable() {
            let _ = fs::remove_file(&tmp);
            return Err(format!(
                "save_file_stream bloqueou: executável recebido por P2P (tipo real: {}) — risco de malware. Desligue o bloqueio em Configurações → Cofre & Backup → Mídia se você confia na origem.",
                sniffed.as_str()
            ));
        }
    }

    if !bytes.is_empty() {
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&tmp)
            .map_err(|e| format!("save_file_stream travou em open {}: {e}", tmp.display()))?;
        f.write_all(&bytes)
            .map_err(|e| format!("save_file_stream travou em write: {e}"))?;
        f.sync_all().ok();
    }

    if total_bytes > 0 {
        if let Ok(m) = fs::metadata(&tmp) {
            if m.len() > total_bytes {
                let _ = fs::remove_file(&tmp);
                return Err(
                    "save_file_stream: o peer enviou mais bytes que o tamanho anunciado".into(),
                );
            }
        }
    }

    if flush {
        if safety.strip_exif {
            if let Ok(mut f) = fs::File::open(&tmp) {
                use std::io::Read;
                let mut head = vec![0u8; 512];
                let n = f.read(&mut head).unwrap_or(0);
                head.truncate(n);
                let sniffed = distorrent_core::media::sniff_mime(&head);
                let is_image = matches!(
                    sniffed,
                    distorrent_core::media::SniffedMime::Jpeg
                        | distorrent_core::media::SniffedMime::Png
                        | distorrent_core::media::SniffedMime::Gif
                        | distorrent_core::media::SniffedMime::Webp
                );
                if is_image {
                    if let Ok(all) = fs::read(&tmp) {
                        if let Ok(clean) = distorrent_core::media::strip_metadata(&all) {
                            let _ = fs::write(&tmp, &clean);
                        }
                    }
                }
            }
        }
        let dest = unique_download_path(&downloads, &safe);
        if let Err(e) = fs::rename(&tmp, &dest) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("save_file_stream travou em rename: {e}"));
        }
        return Ok(dest.to_string_lossy().to_string());
    }

    Ok(tmp.to_string_lossy().to_string())
}

fn decode_b64_batches(data: &str) -> Result<Vec<u8>, String> {
    use base64::{engine::general_purpose, Engine as _};
    let s: &[u8] = data.as_bytes();
    if s.is_empty() {
        return Ok(Vec::new());
    }
    if s.len() % 4 != 0 {
        return Err(format!(
            "comprimento base64 inválido ({} bytes, não múltiplo de 4)",
            s.len()
        ));
    }
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut start = 0usize;
    let mut i = 0usize;
    while i < s.len() {
        let end = i + 4;
        let pad = if end >= 4 && s[end - 1] == b'=' {
            if end >= 2 && s[end - 2] == b'=' {
                2
            } else {
                1
            }
        } else {
            0
        };
        if pad > 0 {
            // Seção 22: piece
            let piece = &s[start..end];
            let decoded = general_purpose::STANDARD
                .decode(piece)
                .map_err(|e| format!("lote inválido em offset {start}: {e}"))?;
            out.extend_from_slice(&decoded);
            start = end;
        }
        i = end;
    }
    if start < s.len() {
        let piece = &s[start..];
        let decoded = general_purpose::STANDARD
            .decode(piece)
            .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(piece))
            .map_err(|e| format!("último lote inválido em offset {start}: {e}"))?;
        out.extend_from_slice(&decoded);
    }
    Ok(out)
}

const MAX_STREAM_FILE_BYTES: u64 = 50 * 1024 * 1024 * 1024;

pub(crate) fn fmt_mb(b: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if b >= 1024 * MB {
        format!("{} GB", b / (1024 * MB))
    } else {
        format!("{} MB", b / MB)
    }
}

#[cfg(not(target_os = "android"))]
fn resolve_downloads_dir() -> Result<PathBuf, String> {
    if let Some(d) = dirs::download_dir() {
        return Ok(d);
    }
    if let Some(h) = dirs::home_dir() {
        let dl = h.join("Download");
        let dls = h.join("Downloads");
        if dl.exists() {
            return Ok(dl);
        }
        if dls.exists() {
            return Ok(dls);
        }
        if h.exists() {
            return Ok(dl);
        }
    }
    Err(
        "save_file travou em resolve_dir: diretório de Downloads não encontrado (download_dir=None e sem ~/Download)".to_string(),
    )
}

fn unique_download_path(dir: &std::path::Path, file_name: &str) -> PathBuf {
    let first = dir.join(file_name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match file_name.rfind('.') {
        Some(i) if i > 0 => (&file_name[..i], Some(&file_name[i..])),
        _ => (file_name, None),
    };
    for n in 1..1000 {
        let cand = match ext {
            Some(e) => dir.join(format!("{stem} ({n}){e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !cand.exists() {
            return cand;
        }
    }
    first
}

#[tauri::command]
fn get_app_version(app: tauri::AppHandle) -> String {
    app.config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

#[derive(Debug, Serialize)]
struct StormVaultExportView {
    path: String,
    bytes: u64,
    header: distorrent_core::stormvault::StormVaultHeader,
}

#[derive(Debug, Serialize)]
struct BackupView {
    file: String,
    created_ms: i64,
    bytes: u64,
}

fn backups_dir(state: &State<AppState>) -> PathBuf {
    state.data_dir.join("backups")
}

fn backup_retention_days(store: &Store) -> i64 {
    store
        .kv_get("stormvault.backup_retention_days")
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|d| (1..=3650).contains(d))
        .unwrap_or(30)
}

fn export_secret(state: &State<AppState>, store: &Store) -> Result<String, String> {
    if let Some(eng) = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        return Ok(eng.secret_hex());
    }
    if store.kv_get("vault.on").as_deref() == Some("1") {
        return Err("app bloqueado — desbloqueie com sua senha antes de exportar".into());
    }
    load_secret(store, true)
}

#[tauri::command]
async fn stormvault_export(
    app: AppHandle,
    password: String,
    include_secret: Option<bool>,
    max_messages: Option<u64>,
    state: State<'_, AppState>,
) -> Result<StormVaultExportView, String> {
    let store = open_store(&state)?;
    let identity = store
        .load_identity()
        .ok_or("sem identidade para exportar")?;
    let include_secret = include_secret.unwrap_or(true);
    let secret = if include_secret {
        Some(export_secret(&state, &store)?)
    } else {
        None
    };
    let max = max_messages.map(|m| m.min(5_000_000) as usize);
    let data = distorrent_core::stormvault::collect(&store, secret, max).map_err(err)?;
    let sealed = distorrent_core::stormvault::seal_with_password(&data, &password).map_err(err)?;
    let header = distorrent_core::stormvault::read_header(&sealed).map_err(err)?;

    let base = export_base_dir(&app)?;
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("não consegui criar a pasta de export: {e}"))?;
    let fname = format!(
        "distorrent-cofre-{}-{}.stormvault",
        identity.fingerprint,
        distorrent_core::identity::now_ms()
    );
    let path = unique_download_path(&base, &fname);
    let tmp = path.with_extension("stormvault-part");
    if let Err(e) = std::fs::write(&tmp, &sealed) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("falha ao gravar o cofre: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        // Seção 23: _
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("falha ao gravar o cofre: {e}"));
    }
    distorrent_core::metrics::metrics().vault_op();
    drop(password);
    Ok(StormVaultExportView {
        path: path.to_string_lossy().to_string(),
        bytes: sealed.len() as u64,
        header,
    })
}

fn export_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let _ = app;
        android_private_download_dir(app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        resolve_downloads_dir()
    }
}

#[cfg(target_os = "android")]
fn android_files_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|e| format!("pasta do app indisponível: {e}"))?;
    Ok(base.join("files"))
}

#[cfg(target_os = "android")]
fn android_private_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(android_files_dir(app)?.join("Download"))
}

#[tauri::command]
async fn stormvault_import(
    content_b64: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<distorrent_core::stormvault::ImportReport, String> {
    use base64::{engine::general_purpose, Engine as _};
    let bytes = general_purpose::STANDARD
        .decode(content_b64.trim())
        .map_err(|e| format!("arquivo inválido (base64): {e}"))?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("arquivo grande demais (máx 512MB)".into());
    }
    let store = open_store(&state)?;

    let key = auth_key(&store, "stormvault");
    auth_guard(&state, &key)?;

    if store.load_identity().is_some() {
        engine(&state)?;
    }
    let report = match distorrent_core::stormvault::import_with_password(&store, &bytes, &password)
    {
        Ok(r) => r,
        Err(e) => return Err(auth_fail(&state, &key, &e.to_string())),
    };
    auth_ok(&state, &key);
    distorrent_core::metrics::metrics().vault_op();
    drop(password);
    Ok(report)
}

fn list_backup_files(state: &State<AppState>) -> Result<Vec<BackupView>, String> {
    Ok(
        distorrent_core::stormvault::list_backup_files(&backups_dir(state))
            .into_iter()
            .map(|(file, created_ms, bytes)| BackupView {
                file,
                created_ms,
                bytes,
            })
            .collect(),
    )
}

#[tauri::command]
fn stormvault_backups_list(state: State<AppState>) -> Result<Vec<BackupView>, String> {
    list_backup_files(&state)
}

#[tauri::command]
async fn stormvault_backup_now(state: State<'_, AppState>) -> Result<BackupView, String> {
    let eng = engine(&state)?;
    let secret = eng.secret_hex();
    let store = open_store(&state)?;
    let data =
        distorrent_core::stormvault::collect(&store, Some(secret.clone()), None).map_err(err)?;
    let key = distorrent_core::stormvault::backup_key_for(&secret);
    let sealed = distorrent_core::stormvault::seal_with_key(&data, &key).map_err(err)?;
    let dir = backups_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("pasta de backups: {e}"))?;
    let now = distorrent_core::identity::now_ms();
    let file = distorrent_core::stormvault::backup_file_name(now);
    std::fs::write(dir.join(&file), &sealed).map_err(|e| format!("gravar backup: {e}"))?;
    distorrent_core::metrics::metrics().vault_op();
    prune_backups(&state).map_err(err)?;
    Ok(BackupView {
        file,
        created_ms: now,
        bytes: sealed.len() as u64,
    })
}

#[tauri::command]
async fn stormvault_backup_restore(
    file: String,
    state: State<'_, AppState>,
) -> Result<distorrent_core::stormvault::ImportReport, String> {
    let safe = std::path::Path::new(&file)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "nome de backup inválido".to_string())?;
    if safe != file.as_str()
        || !safe.starts_with("stormvault-")
        || !safe.ends_with(".stormvault")
        || safe.contains("..")
    {
        return Err("nome de backup inválido".into());
    }
    let bytes = std::fs::read(backups_dir(&state).join(safe))
        .map_err(|_| "backup não encontrado".to_string())?;
    let eng = engine(&state)?;
    let key = distorrent_core::stormvault::backup_key_for(&eng.secret_hex());
    let data = distorrent_core::stormvault::open_with_key(&bytes, &key)
        .map_err(|e| format!("não abriu como backup automático ({e}) — use Importar com senha"))?;
    if data.identity.fingerprint != eng.identity().fingerprint {
        return Err("backup de outra conta — restaure na conta certa".into());
    }
    let store = open_store(&state)?;
    let report = distorrent_core::stormvault::import_merge_only(&store, &data).map_err(err)?;
    distorrent_core::metrics::metrics().vault_op();
    Ok(report)
}

#[tauri::command]
fn stormvault_backup_set_retention(days: i64, state: State<AppState>) -> Result<(), String> {
    if !(1..=3650).contains(&days) {
        return Err("retenção inválida (1 a 3650 dias)".into());
    }
    let store = open_store(&state)?;
    store
        .kv_set("stormvault.backup_retention_days", &days.to_string())
        .map_err(err)?;
    prune_backups(&state).map_err(err)?;
    Ok(())
}

#[tauri::command]
fn stormvault_backup_get_retention(state: State<AppState>) -> Result<i64, String> {
    Ok(backup_retention_days(&open_store(&state)?))
}

fn prune_backups(state: &State<AppState>) -> Result<usize, String> {
    // Seção 24: store
    let store = open_store(state)?;
    distorrent_core::stormvault::prune_backup_files(
        &backups_dir(state),
        backup_retention_days(&store),
        distorrent_core::identity::now_ms(),
    )
    .map_err(err)
}

#[tauri::command]
fn vault_wipe(
    app: AppHandle,
    confirm: String,
    state: State<AppState>,
) -> Result<WipeReport, String> {
    if confirm != "APAGAR" {
        return Err("confirmação inválida — digite APAGAR".into());
    }
    {
        let mut guard = state.engine.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(e) = guard.as_ref() {
            e.shutdown();
        }
        *guard = None;
    }
    *state.unlocked.lock().unwrap_or_else(|e| e.into_inner()) = false;
    if let Ok(entry) = keyring::Entry::new("distorrent-app", "identity.secret") {
        let _ = entry.delete_password();
    }
    for f in ["distorrent.db", "distorrent.db-wal", "distorrent.db-shm"] {
        let _ = std::fs::remove_file(state.data_dir.join(f));
    }
    let _ = std::fs::remove_dir_all(backups_dir(&state));
    let _ = std::fs::remove_dir_all(state.data_dir.join("cache"));
    let _ = state.cache.clear();
    let mut leftovers = Vec::new();
    if let Ok(base) = export_base_dir(&app) {
        if let Ok(rd) = std::fs::read_dir(&base) {
            for entry in rd.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("distorrent-cofre-") && name.ends_with(".stormvault") {
                    leftovers.push(entry.path().to_string_lossy().to_string());
                }
            }
        }
    }
    leftovers.sort();
    let _ = &app;
    tracing::warn!("modo pânico executado: dados locais apagados");
    Ok(WipeReport { leftovers })
}

#[derive(Debug, Serialize)]
struct WipeReport {
    leftovers: Vec<String>,
}

#[tauri::command]
fn metrics_snapshot() -> serde_json::Value {
    distorrent_core::metrics::metrics().snapshot()
}

#[tauri::command]
fn peer_rtt(fp: String, state: State<AppState>) -> Result<Option<u64>, String> {
    Ok(engine(&state)?.peer_rtt_ms(fp.trim()))
}

#[tauri::command]
fn messages_window(
    conv_id: String,
    before_ts: Option<i64>,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<StoredMessage>, String> {
    engine(&state)?
        .messages_window(
            conv_id.trim(),
            before_ts,
            limit.unwrap_or(100).clamp(1, 1000),
        )
        .map_err(err)
}

#[derive(Debug, Serialize)]
struct CacheStatsView {
    cap_mb: u64,
    total_bytes: u64,
    entries: usize,
}

fn check_cache_key(key: &str) -> Result<(), String> {
    if key.is_empty() || key.len() > 256 {
        return Err("chave de cache inválida".into());
    }
    Ok(())
}

#[tauri::command]
fn cache_get(key: String, state: State<AppState>) -> Result<Option<String>, String> {
    use base64::{engine::general_purpose, Engine as _};
    check_cache_key(&key)?;
    match state.cache.get(&key).map_err(err)? {
        Some(bytes) => {
            distorrent_core::metrics::metrics().cache_hit();
            Ok(Some(general_purpose::STANDARD.encode(&bytes)))
        }
        None => {
            distorrent_core::metrics::metrics().cache_miss();
            Ok(None)
        }
    }
}

#[tauri::command]
fn cache_put(key: String, data_b64: String, state: State<AppState>) -> Result<(), String> {
    use base64::{engine::general_purpose, Engine as _};
    check_cache_key(&key)?;
    let bytes = general_purpose::STANDARD
        .decode(&data_b64)
        .map_err(|e| format!("cache_put: base64 inválido: {e}"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("entrada de cache muito grande (máx 32MB)".into());
    }
    state.cache.put(&key, &bytes).map_err(err)
}

#[tauri::command]
fn cache_delete(key: String, state: State<AppState>) -> Result<(), String> {
    check_cache_key(&key)?;
    state.cache.delete(&key).map_err(err)
}

#[tauri::command]
fn cache_stats(state: State<AppState>) -> Result<CacheStatsView, String> {
    Ok(CacheStatsView {
        cap_mb: state.cache.cap() / (1024 * 1024),
        total_bytes: state.cache.total_bytes(),
        entries: state.cache.entries(),
    })
}

#[tauri::command]
fn cache_set_cap(cap_mb: u64, state: State<AppState>) -> Result<(), String> {
    let cap = cap_mb.clamp(16, 4096);
    let store = open_store(&state)?;
    store
        .kv_set("cache.cap_mb", &cap.to_string())
        .map_err(err)?;
    state.cache.set_cap(cap * 1024 * 1024).map_err(err)
}

#[derive(Debug, Serialize)]
struct MediaSafetyView {
    strip_exif: bool,
    block_executables: bool,
}

fn media_safety_read(store: &Store) -> MediaSafetyView {
    MediaSafetyView {
        strip_exif: store.kv_get("media.strip_exif").as_deref() != Some("0"),
        block_executables: store.kv_get("media.block_executables").as_deref() != Some("0"),
    }
}

#[tauri::command]
// Seção 25: media_safety_get
fn media_safety_get(state: State<AppState>) -> Result<MediaSafetyView, String> {
    Ok(media_safety_read(&open_store(&state)?))
}

#[tauri::command]
fn media_safety_set(
    strip_exif: bool,
    block_executables: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let store = open_store(&state)?;
    store
        .kv_set("media.strip_exif", if strip_exif { "1" } else { "0" })
        .map_err(err)?;
    store
        .kv_set(
            "media.block_executables",
            if block_executables { "1" } else { "0" },
        )
        .map_err(err)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
struct RetentionSettings {
    days: u32,
    servers: bool,
    groups: bool,
    dms: bool,
}

impl Default for RetentionSettings {
    fn default() -> Self {
        Self {
            days: 30,
            servers: true,
            groups: true,
            dms: false,
        }
    }
}

fn retention_read(store: &Store) -> RetentionSettings {
    let mut s = RetentionSettings::default();
    if let Some(v) = store.kv_get("privacy.retention_days") {
        s.days = v.trim().parse().unwrap_or(s.days);
    }
    let flag = |key: &str, default: bool| -> bool {
        match store.kv_get(key).as_deref() {
            Some("1") => true,
            Some("0") => false,
            _ => default,
        }
    };
    s.servers = flag("privacy.retention_servers", s.servers);
    s.groups = flag("privacy.retention_groups", s.groups);
    s.dms = flag("privacy.retention_dms", s.dms);
    s
}

fn retention_apply(store: &Store) -> Result<usize, String> {
    let s = retention_read(store);
    if s.days == 0 || !(s.servers || s.groups || s.dms) {
        return Ok(0);
    }
    let cutoff = distorrent_core::identity::now_ms() - (s.days as i64) * 86_400_000;
    let mut total = 0usize;
    loop {
        let ids = store
            .expired_message_ids(cutoff, s.servers, s.groups, s.dms, 500)
            .map_err(err)?;
        if ids.is_empty() {
            break;
        }
        let n = store.hide_messages_local(&ids).map_err(err)?;
        total += n;
        if n == 0 {
            break;
        }
    }
    Ok(total)
}

#[tauri::command]
fn retention_get(state: State<AppState>) -> Result<RetentionSettings, String> {
    Ok(retention_read(&open_store(&state)?))
}

#[tauri::command]
fn retention_set(
    days: u32,
    servers: bool,
    groups: bool,
    dms: bool,
    state: State<AppState>,
) -> Result<RetentionSettings, String> {
    let store = open_store(&state)?;
    let days = if days == 0 { 0 } else { days.clamp(1, 3650) };
    store
        .kv_set("privacy.retention_days", &days.to_string())
        .map_err(err)?;
    store
        .kv_set("privacy.retention_servers", if servers { "1" } else { "0" })
        .map_err(err)?;
    store
        .kv_set("privacy.retention_groups", if groups { "1" } else { "0" })
        .map_err(err)?;
    store
        .kv_set("privacy.retention_dms", if dms { "1" } else { "0" })
        .map_err(err)?;
    retention_apply(&store)?;
    Ok(retention_read(&store))
}

#[tauri::command]
fn retention_run(state: State<AppState>) -> Result<usize, String> {
    retention_apply(&open_store(&state)?)
}

fn log_filter() -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,distorrent_core=info"))
}

fn log_file_writer() -> Option<std::fs::File> {
    let dir = dirs::data_dir()?.join("com.distorrent.app");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("distorrent.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > 2 * 1024 * 1024 {
            let _ = std::fs::rename(&path, path.with_extension("log.1"));
        }
    }
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()
}

fn main() {
    use tracing_subscriber::layer::SubscriberExt as _;
    use tracing_subscriber::util::SubscriberInitExt as _;
    let json = std::env::var("DISTORRENT_LOG_JSON").as_deref() == Ok("1");
    let registry = tracing_subscriber::registry().with(log_filter());
    let file = log_file_writer();
    let boot = match (file, json) {
        (Some(f), true) => registry
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::stderr)
                    .json(),
            )
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(std::sync::Mutex::new(f))
                    .json(),
            )
            .try_init(),
        (Some(f), false) => registry
            .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
            .with(
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(std::sync::Mutex::new(f)),
            )
            .try_init(),
        (None, true) => registry
            .with(
                tracing_subscriber::fmt::layer()
                    .with_writer(std::io::stderr)
                    .json(),
            )
            .try_init(),
        (None, false) => registry
            .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
            .try_init(),
    };
    // Seção 26: _
    let _ = boot;

    #[cfg_attr(mobile, allow(unused_mut))]
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    builder = builder
        .plugin(downloads_plugin())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init());
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ));
    }
    builder
        .on_permission_request(|_webview, kind| {
            use tauri::webview::{PermissionKind, PermissionResponse};
            match kind {
                PermissionKind::Microphone
                | PermissionKind::Camera
                | PermissionKind::DisplayCapture
                | PermissionKind::Autoplay
                | PermissionKind::Other => PermissionResponse::Allow,
                _ => PermissionResponse::Deny,
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            hide_share_bar,
            share_bar_watch,
            updater::update_check,
            updater::update_download,
            updater::update_apply,
            updater::update_auto_get,
            updater::update_auto_set,
            updater::update_flag_get,
            updater::update_flag_set,
            updater::update_cleanup,
            updater::open_release_page,
            updater::open_external,
            identity_get,
            identity_create,
            identity_rename,
            vault_status,
            vault_unlock,
            vault_change,
            local_addresses,
            communities_list,
            community_members,
            create_community,
            make_invite,
            make_invite_link,
            join_community,
            send_channel_message,
            network_status,
            peers_list,
            net_diag,
            webrtc_report,
            relay_status,
            connect_addr,
            disconnect_peer,
            save_file_stream,
            save_public_copy,
            friends_list,
            friend_request,
            friend_respond,
            friend_remove,
            friend_block,
            friend_unblock,
            conversations_list,
            dm_open,
            delete_conversation,
            messages_list,
            messages_window,
            message_send,
            message_resend,
            message_verify,
            metrics_snapshot,
            peer_rtt,
            stormvault_export,
            stormvault_import,
            stormvault_backups_list,
            stormvault_backup_now,
            stormvault_backup_restore,
            stormvault_backup_set_retention,
            stormvault_backup_get_retention,
            vault_wipe,
            cache_get,
            cache_put,
            cache_delete,
            cache_stats,
            cache_set_cap,
            media_safety_get,
            media_safety_set,
            retention_get,
            retention_set,
            retention_run,
            secure_store,
            secure_load,
            privacy_get,
            privacy_set,
            net_limits,
            proxy_addr_get,
            proxy_addr_set,
            proxy_test,
            vault_export,
            vault_import,
            accounts_list,
            account_save_imported,
            account_switch,
            account_remove_imported,
            create_group,
            group_members,
            group_pair_now,
            community_pair_now,
            community_sync_now,
            group_add,
            group_remove,
            group_rename,
            group_leave,
            group_delete,
            group_delete_local,
            call_room_publish,
            call_room_close,
            call_room_leave,
            call_room_join,
            call_rooms_list,
            call_invite,
            call_ring_retry,
            call_accept,
            call_reject,
            call_end,
            call_offer,
            call_answer,
            call_ice,
            call_add_participant,
            voice_media_available,
            voice_media_stats,
            voice_set_muted,
            voice_hangup,
            voice_set_deafened,
            voice_video_start,
            voice_video_stop,
            voice_video_frame,
            voice_mic_test_start,
            voice_mic_test_level,
            voice_mic_test_stop,
            voice_mic_name,
            send_typing,
            screen_share_offer,
            screen_share_answer,
            channel_create,
            channel_delete,
            channel_rename,
            channel_set_topic,
            channel_set_category,
            channel_list,
            community_rename,
            community_set_meta,
            community_set_public,
            join_public_community,
            role_create,
            role_update,
            role_delete,
            roles_list,
            member_roles,
            member_assign_role,
            member_unassign_role,
            member_kick,
            server_rules_get,
            server_rules_set,
            audit_list,
            reputation_get,
            safety_number,
            // Seção 27: moderate
            moderate,
            report_user,
            validate_name,
            random_name,
            bot_create,
            bot_update,
            bot_delete,
            bots_list,
            bot_post_message,
            bot_regen_token,
            http_fetch,
            voice_join,
            voice_leave,
            voice_state,
            voice_states,
            file_announce,
            file_request_chunk,
            file_send_chunk,
            save_file,
            social_react,
            social_reactions,
            social_reactions_bulk,
            social_reply,
            social_edit,
            social_delete,
            social_pin,
            social_pins,
            social_meta_bulk,
            social_bodies,
            social_forward,
            read_set,
            read_all,
            unread_count,
            unread_mentions,
            presence_set,
            presence_list,
            presence_get,
            profile_set,
            profile_get,
            profile_list,
            profile_sync_now,
            nickname_set,
            nickname_get,
            message_search,
            messages_around,
            message_receipts,
            thread_create,
            thread_list,
            thread_messages,
            thread_send,
            thread_archive,
            member_ban,
            member_unban,
            ban_list,
            member_timeout,
            timeout_list,
            channel_cfg_set,
            channel_cfg_get,
            poll_create,
            poll_list,
            poll_vote,
            poll_tally,
            event_upsert,
            event_list,
            event_interest,
            event_delete,
            emoji_upsert,
            emoji_list,
            emoji_delete,
            bookmark_set,
            bookmark_list,
            background_prefs_get,
            background_prefs_set,
            autostart_get,
            autostart_set,
            autostart_ensure,
            autostart_mark_decided,
            notification_show,
            notification_cancel,
            notification_cancel_all,
            notification_permission_state,
            notification_request_permission,
            notify_prefs_set,
            app_show_window,
            app_hide_to_tray,
            app_quit,
            window_toggle_fullscreen,
            background_set_connection,
            call_ring_start,
            call_ring_stop,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(desktop)]
                {
                    let app = window.app_handle();
                    if let Some(bg) = app.try_state::<background::Background>() {
                        let hide = bg.close_to_tray.load(std::sync::atomic::Ordering::Relaxed)
                            && !bg.quitting.load(std::sync::atomic::Ordering::Relaxed);
                        if hide {
                            api.prevent_close();
                            let _ = window.hide();
                            background::emit_hidden(app);
                        }
                    }
                }
                #[cfg(mobile)]
                {
                    let _ = (&api, &window);
                }
            }
        })
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            std::fs::create_dir_all(&dir).ok();
            tracing::info!(?dir, "DisTorrent iniciando");
            #[cfg(target_os = "linux")]
            isolate_fontconfig_cache_managed(&dir);
            let cap_mb: u64 = Store::open(&dir.join("distorrent.db"))
                .ok()
                .and_then(|s| s.kv_get("cache.cap_mb"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(256)
                .clamp(16, 4096);
            let cache = distorrent_core::cache::DiskLru::open(
                dir.join("cache"),
                Some(cap_mb * 1024 * 1024),
            )
            .map_err(|e| format!("cache: {e}"))?;
            app.manage(AppState {
                engine: Mutex::new(None),
                data_dir: dir.clone(),
                unlocked: Mutex::new(false),
                cache,
                auth_limit: distorrent_core::authlimit::AuthLimiter::new(),
            });
            app.manage(background::Background::new());
            background::init(app.handle());
            {
                let warm = dir.join("distorrent.db");
                std::thread::spawn(move || {
                    let _ = Store::open(&warm);
                });
            }
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(e) = app.deep_link().register_all() {
                    eprintln!("deep-link: não consegui registrar o esquema distorrent:// ({e}) — o convite por token continua funcionando");
                }
            }
            enable_webrtc(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao rodar distorrent");
}

// Seção 28: cfg
#[cfg(any(
    target_os = "linux",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
fn enable_webrtc(app: &tauri::AppHandle) {
    use tauri::Manager;
    use webkit2gtk::{SettingsExt, WebViewExt};
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let _ = win.with_webview(move |wv| {
        let inner = wv.inner();
        match inner.settings() {
            Some(settings) => {
                settings.set_enable_webrtc(true);
                settings.set_enable_write_console_messages_to_stdout(true);
                eprintln!("[distorrent] WebKitGTK: enable_webrtc = LIGADO");
            }
            None => eprintln!("[distorrent] WebKitGTK: settings() = None — WebRTC NÃO ligado"),
        }
    });
}

#[cfg(not(any(
    target_os = "linux",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
)))]
fn enable_webrtc(_app: &tauri::AppHandle) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_mobile() {
    std::env::set_var("DISTORRENT_DHT", "1");
    main();
}

pub fn run() {
    std::env::set_var("DISTORRENT_DHT", "1");
    #[cfg(target_os = "linux")]
    isolate_fontconfig_cache_best_effort();
    main();
}

#[cfg(target_os = "linux")]
fn isolate_fontconfig_cache_best_effort() {
    if std::env::var_os("FONTCONFIG_FILE").is_some() {
        return;
    }
    let Some(data_dir) = dirs::data_dir().map(|d| d.join("com.distorrent.app")) else {
        return;
    };
    isolate_fontconfig_cache(&data_dir);
}

#[cfg(target_os = "linux")]
fn isolate_fontconfig_cache_managed(data_dir: &std::path::Path) {
    if std::env::var_os("FONTCONFIG_FILE").is_some() {
        return;
    }
    isolate_fontconfig_cache(data_dir);
}

#[cfg(target_os = "linux")]
fn isolate_fontconfig_cache(data_dir: &std::path::Path) {
    const CONF: &str = include_str!("../fontconfig/distorrent-fonts.conf");
    let target = data_dir.join("distorrent-fonts.conf");
    let fresh = std::fs::read_to_string(&target)
        .map(|c| c == CONF)
        .unwrap_or(false);
    if !fresh {
        if let Err(e) =
            std::fs::create_dir_all(data_dir).and_then(|_| std::fs::write(&target, CONF))
        {
            tracing::warn!("fontconfig privado indisponível ({e}) — seguindo com o compartilhado");
            return;
        }
    }
    std::env::set_var("FONTCONFIG_FILE", &target);
    eprintln!(
        "[distorrent] fontconfig: cache privado em {}",
        target.display()
    );
}

#[cfg(test)]
mod tests {
    use super::decode_b64_batches;
    use base64::{engine::general_purpose, Engine as _};

    #[test]
    fn decodifica_lotes_concatenados_com_padding_no_meio() {
        let bloco = vec![0xA5u8; 262_144];
        let um = general_purpose::STANDARD.encode(&bloco);
        assert!(
            um.ends_with("=="),
            "premissa do bug: bloco termina em padding"
        );
        let concatenado = format!("{um}{um}{um}");
        assert!(general_purpose::STANDARD.decode(&concatenado).is_err());

        let out = decode_b64_batches(&concatenado).expect("lote concatenado deve decodificar");
        assert_eq!(out.len(), 3 * 262_144);
        assert!(out.iter().all(|b| *b == 0xA5));
    }

    #[test]
    fn decodifica_base64_simples_e_vazio() {
        assert!(decode_b64_batches("").unwrap().is_empty());
        let out = decode_b64_batches("aGVsbG8=").unwrap();
        assert_eq!(out, b"hello");
    }

    #[test]
    fn rejeita_lote_corrompido() {
        assert!(decode_b64_batches("aGVsbG8=".to_string().as_str()).is_ok());
        assert!(
            decode_b64_batches("aGVsbG8").is_err(),
            "comprimento não múltiplo de 4"
        );
        assert!(decode_b64_batches("!!!!!!!!").is_err(), "alfabeto inválido");
    }
}
