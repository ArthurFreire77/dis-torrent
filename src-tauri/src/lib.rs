#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use distorrent_core::net::engine::{NetworkEngine, NetworkState};
use distorrent_core::storage::{PeerRecord, Store, StoredMessage};
use distorrent_core::{Identity, Keypair};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

mod background;
pub mod commands_bot;
pub mod commands_files;
pub mod commands_misc;
pub mod commands_net;
pub mod commands_server;
pub mod commands_social;
pub mod commands_sound;
pub mod commands_voice;
mod download_spool;
mod download_target;
mod seed_files;

mod botbridge;
mod botmusic;
mod botplugin;
mod firewall;
mod sharebar;
mod updater;

use background::{
    app_hide_to_tray, app_quit, app_show_window, app_ui_ready, autostart_ensure, autostart_get,
    autostart_mark_decided, autostart_set, background_prefs_get, background_prefs_set,
    background_set_connection, call_ring_start, call_ring_stop, notification_cancel,
    notification_cancel_all, notification_permission_state, notification_request_permission,
    notification_show, notify_prefs_set, window_toggle_fullscreen,
};
use firewall::{network_firewall_allow, network_firewall_status, network_firmware_open_firewall};

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

struct AppState {
    engine: Mutex<Option<Arc<NetworkEngine>>>,
    data_dir: PathBuf,
    unlocked: Mutex<bool>,
    cache: distorrent_core::cache::DiskLru,
    auth_limit: distorrent_core::authlimit::AuthLimiter,
    /// Pontes locais abertas, por `community_id|bot_id`. Uma por bot.
    bot_bridges: Mutex<std::collections::HashMap<String, Arc<botbridge::Bridge>>>,
    /// Plugins de bot rodando como processo filho (código do usuário).
    bot_plugins: botplugin::Plugins,
    /// Canais de música abertos, por `community_id|bot_id`. Só no desktop
    /// Linux, onde existe o misturador nativo; nas outras plataformas o áudio
    /// da chamada é da WebView e esta lista fica vazia.
    bot_music: Arc<botmusic::Music>,
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

const DEV_PORT: u16 = 5173;

#[derive(Debug, Serialize)]
struct VaultStatus {
    has_identity: bool,
    has_vault: bool,
    /// Tem identidade, mas o segredo não está no keyring nem há cofre: a conta
    /// só volta importando um `.stormvault` com senha.
    locked: bool,
}

/// Guarda o segredo da identidade. No desktop ele vive SÓ no keyring do SO:
/// gravar em `distorrent.db` transformava "copiar a pasta" em "virar o dono".
/// Sem keyring, a única alternativa segura é o cofre por senha (`vault.on`) —
/// por isso esta função devolve erro pedindo a senha em vez de cair para SQLite.
fn persist_secret(store: &Store, kp: &Keypair, identity: &Identity) -> Result<(), String> {
    let secret = kp.secret_hex();
    #[cfg(target_os = "android")]
    {
        // Android não tem keyring neste build. O sandbox + allowBackup=false
        // limitam o dano; a limitação está documentada em THREAT_MODEL.md.
        tracing::info!("Android: secret no SQLite (sandbox do app, allowBackup=false)");
        store.save_identity(identity, &secret).map_err(err)?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| format!("keyring indisponível ({e}) — defina uma senha do cofre"))?;
        match entry.set_password(&secret) {
            Ok(()) => {
                // Metadados apenas: o segredo NÃO entra no SQLite.
                store.save_identity_meta(identity).map_err(err)?;
                purge_plaintext_secret(store);
                Ok(())
            }
            Err(e) => {
                tracing::warn!("keyring set_password falhou ({e})");
                Err(format!(
                    "o keyring do sistema não está disponível ({e}). \
                     Crie a conta com uma senha do cofre para guardar a chave com segurança."
                ))
            }
        }
    }
}

/// Remove segredo em claro do banco (migração de instalações antigas).
fn purge_plaintext_secret(store: &Store) {
    let _ = store.kv_delete("identity.secret");
    let _ = store.kv_delete("identity.secret.backup");
}

const KEYRING_SERVICE: &str = "distorrent-app";
const KEYRING_USER: &str = "identity.secret";

/// Segredo em claro, quando existe em local recuperável SEM senha (keyring ou
/// legado no SQLite). `None` = cofre por senha (precisa desbloquear).
fn plaintext_secret(store: &Store) -> Option<String> {
    let identity = store.load_identity()?;
    let matches_identity = |s: &str| {
        is_plaintext_secret(s)
            && Keypair::from_secret_hex(s)
                .map(|kp| kp.fingerprint() == identity.fingerprint)
                .unwrap_or(false)
    };
    #[cfg(target_os = "android")]
    {
        let _ = &matches_identity;
        return store.load_secret_hex().filter(|s| is_plaintext_secret(s));
    }
    #[cfg(not(target_os = "android"))]
    {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
            if let Ok(s) = entry.get_password() {
                if matches_identity(&s) {
                    return Some(s);
                }
                // Keyring de OUTRA conta: não entrega para a identidade errada.
                tracing::warn!("keyring tem segredo de outra identidade — ignorado");
            }
        }
        let stored = store.load_secret_hex().unwrap_or_default();
        if matches_identity(&stored) {
            return Some(stored);
        }
        let bk = store.kv_get("identity.secret.backup").unwrap_or_default();
        if matches_identity(&bk) {
            return Some(bk);
        }
        None
    }
}

/// 32 bytes em hex = 64 caracteres. Um blob selado tem salt+nonce+tag, sempre
/// bem maior, então o tamanho separa os dois sem tentar decifrar.
fn is_plaintext_secret(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Migra o legado em claro para o keyring e apaga do SQLite. Chamado no boot.
fn migrate_plaintext_to_keyring(store: &Store, secret: &str) -> bool {
    #[cfg(target_os = "android")]
    {
        let _ = (store, secret);
        false
    }
    #[cfg(not(target_os = "android"))]
    {
        let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) else {
            return false;
        };
        if entry.set_password(secret).is_err() {
            return false;
        }
        purge_plaintext_secret(store);
        true
    }
}

/// Segredo em claro recuperável SEM senha (keyring ou legado no SQLite), já
/// conferido contra a identidade. Usado pelo snapshot pré-update (Windows).
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn recover_plaintext_secret(store: &Store) -> Option<String> {
    plaintext_secret(store)
}

fn load_secret(store: &Store, unlocked: bool) -> Result<String, String> {
    if store.kv_get("vault.on").as_deref() == Some("1") {
        if unlocked {
            return Err("usar cache".into());
        }
        return Err("bloqueado — informe a senha".into());
    }
    if let Some(secret) = plaintext_secret(store) {
        // Instalação antiga: sobe para o keyring e limpa o texto claro.
        if migrate_plaintext_to_keyring(store, &secret) {
            tracing::info!("segredo legado movido para o keyring; SQLite limpo");
        }
        return Ok(secret);
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
        if kp.public_hex() != identity.pubkey_hex || kp.fingerprint() != identity.fingerprint {
            return Err(
                "o segredo não corresponde à identidade deste perfil — importe o cofre certo"
                    .into(),
            );
        }
        let engine = NetworkEngine::new_with_identity(
            Arc::new(Store::open(&db_path(state)).map_err(err)?),
            kp,
            identity.clone(),
            state.data_dir.clone(),
        );
        engine.start().map_err(err)?;
        // Carrega raiz de confiança + cache de manifestos do banco local.
        engine.init_release_trust();
        *state.engine.lock().unwrap_or_else(|e| e.into_inner()) = Some(engine.clone());
        forward_events(app, engine);
        Ok(())
    })
}

fn boot_engine_if_needed(app: &AppHandle, state: &State<AppState>) -> Result<(), String> {
    let store = open_store(state)?;
    boot_engine_with_store(app, state, store)
}

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
        // O keyring pode ter segredo de OUTRA conta (pasta copiada/trocada).
        // Nunca inicia o motor com uma identidade que o segredo não prova.
        if kp.fingerprint() != identity.fingerprint || kp.public_hex() != identity.pubkey_hex {
            return Err(
                "o segredo guardado não corresponde à identidade deste perfil — \
                 importe o .stormvault correto"
                    .into(),
            );
        }
        let engine = NetworkEngine::new_with_identity(
            Arc::new(store),
            kp,
            identity.clone(),
            state.data_dir.clone(),
        );
        engine.start().map_err(err)?;
        // Carrega raiz de confiança + cache de manifestos do banco local.
        engine.init_release_trust();
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

/// O frontend renova este carimbo a cada 30 s. Janela minimizada/oculta
/// continua viva (renova); webview morto/suspenso (Android em background)
/// para de renovar e o Rust assume os avisos.
fn ui_alive(store: &Option<distorrent_core::storage::Store>) -> bool {
    const WINDOW_MS: i64 = 90_000;
    let Some(st) = store.as_ref() else {
        return false;
    };
    let Some(raw) = st.kv_get("notify.ui_alive") else {
        return false;
    };
    let Ok(ts) = raw.parse::<i64>() else {
        return false;
    };
    distorrent_core::identity::now_ms().saturating_sub(ts) < WINDOW_MS
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

    if matches!(ev, E::MessageNew(_)) && ui_alive(&store_for_prefs) {
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

fn presentation_error(e: impl std::fmt::Display) -> String {
    let raw = e.to_string();
    raw.strip_prefix("protocol: ")
        .or_else(|| raw.strip_prefix("crypto: "))
        .or_else(|| raw.strip_prefix("storage: "))
        .unwrap_or(&raw)
        .to_string()
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
    #[serde(default)]
    perms: Option<i64>,
    #[serde(default, rename = "webhookSecret", alias = "webhook_secret")]
    webhook_secret: Option<String>,
}

#[derive(serde::Serialize)]
struct NameCheckView {
    ok: bool,
    normalized: String,
    errors: Vec<String>,
    suggestions: Vec<String>,
}

/// O painel precisa saber se o webhook está assinado sem receber o segredo.

/// Valida/e normaliza uma config de bot sem gravar. Usado pelo editor visual e
/// pelo importador para dar o erro exato do campo antes de salvar.

// --- Ponte local do bot (`127.0.0.1`) -------------------------------------

fn bridge_key(community_id: &str, bot_id: &str) -> String {
    format!("{community_id}|{bot_id}")
}

/// Abre `http://127.0.0.1:<porta>` para UM bot falar com o servidor. Só o dono
/// do servidor pode; a ponte herda o token do bot (não cria segredo novo) e
/// escuta exclusivamente em loopback.

/// Lê uma pasta de bot (`bot.json` + código) sem gravar. O painel mostra o que
/// encontrou e o dono confirma a importação.

/// Inicia o CÓDIGO do bot (plugin) apontando para a ponte local já aberta.

/// Abre a janela própria de bots — ou só traz para a frente se já existir.
///
/// A janela nasce em `tauri.conf.json` com `create:false` e `visible:false`:
/// criada sob demanda (não gasta um webview inteiro no boot) e mostrada só
/// depois de construir, para não piscar branco.

/// No celular não existe segunda janela: a tela de bots é a rota `/bots`.

#[derive(Debug, Serialize)]
struct HttpResponse {
    status: u16,
    body_b64: String,
    body_text: Option<String>,
    truncated: bool,
}

/// Lista com prévia, horário e não lidas do membro. A UI móvel já lia
/// `unread_count`/`last_ts`/`last_body` destes objetos e recebia `undefined`.

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

#[derive(Debug, Serialize)]
struct VaultExport {
    identity: Identity,
    vault_blob: String,
}

#[derive(Debug, Serialize)]
struct SavedAccount {
    nickname: String,
    fingerprint: String,
}

/// Estado do limite de introdução para a conversa aberta. A UI não recria a
/// regra: pergunta ao core quanto já foi usado.

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

/// Abre o canal de música de um bot. Idempotente.

/// Enfileira PCM i16 mono 48 kHz em base64. Devolve `(aceitos, descartados)`.

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

const MAX_STREAM_FILE_BYTES: u64 = 500 * 1024 * 1024 * 1024;

pub(crate) fn fmt_mb(b: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if b >= 1024 * MB {
        format!("{} GB", b / (1024 * MB))
    } else {
        format!("{} MB", b / MB)
    }
}

#[cfg(not(target_os = "android"))]
pub(crate) fn resolve_downloads_dir() -> Result<PathBuf, String> {
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
pub(crate) fn android_private_download_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(android_files_dir(app)?.join("Download"))
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

fn prune_backups(state: &State<AppState>) -> Result<usize, String> {
    let store = open_store(state)?;
    distorrent_core::stormvault::prune_backup_files(
        &backups_dir(state),
        backup_retention_days(&store),
        distorrent_core::identity::now_ms(),
    )
    .map_err(err)
}

#[derive(Debug, Serialize)]
struct WipeReport {
    leftovers: Vec<String>,
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
            commands_misc::get_app_version,
            commands_misc::hide_share_bar,
            commands_misc::share_bar_watch,
            updater::updater_checks::update_check,
            updater::updater_download::update_download,
            updater::updater_apply::update_apply,
            updater::update_verify_ready,
            updater::update_trust_info,
            updater::update_trust_apply,
            updater::peer_trust_info,
            updater::peer_trust_policy_set,
            updater::update_auto_get,
            updater::update_auto_set,
            updater::update_flag_get,
            updater::update_flag_set,
            updater::update_cleanup,
            updater::open_release_page,
            updater::open_external,
            commands_net::identity_get,
            commands_net::identity_create,
            commands_net::identity_rename,
            commands_files::vault_status,
            commands_files::vault_unlock,
            commands_files::vault_change,
            commands_misc::local_addresses,
            commands_misc::communities_list,
            commands_server::community_members,
            commands_server::create_community,
            commands_server::make_invite,
            commands_server::make_invite_link,
            commands_server::join_community,
            commands_server::send_channel_message,
            commands_net::network_status,
            commands_misc::notify_ui_alive,
            commands_misc::peers_list,
            commands_net::net_diag,
            commands_net::webrtc_report,
            commands_net::relay_status,
            commands_net::connect_addr,
            commands_net::disconnect_peer,
            commands_files::save_file_stream,
            commands_files::save_public_copy,
            commands_sound::sound_list,
            commands_sound::sound_save,
            commands_sound::sound_delete,
            commands_sound::sound_read,
            commands_sound::sound_download,
            commands_net::friends_list,
            commands_social::friend_request,
            commands_social::friend_respond,
            commands_social::friend_remove,
            commands_social::friend_block,
            commands_social::friend_unblock,
            commands_social::friend_requests_enabled,
            commands_social::friend_requests_set,
            commands_net::conversations_list,
            commands_net::conversations_overview,
            commands_net::dm_open,
            commands_net::delete_conversation,
            commands_social::messages_list,
            commands_social::messages_window,
            commands_social::message_send,
            commands_social::message_resend,
            commands_files::metrics_snapshot,
            commands_net::peer_rtt,
            commands_files::stormvault_export,
            commands_files::stormvault_import,
            commands_files::stormvault_backups_list,
            commands_files::stormvault_backup_now,
            commands_files::stormvault_backup_restore,
            commands_files::stormvault_backup_set_retention,
            commands_files::stormvault_backup_get_retention,
            commands_files::vault_wipe,
            commands_files::cache_get,
            commands_files::cache_put,
            commands_files::cache_delete,
            commands_files::cache_stats,
            commands_files::cache_set_cap,
            commands_files::cache_get_ttl,
            commands_files::cache_set_ttl,
            download_spool::spool_begin,
            download_spool::spool_put,
            download_spool::spool_put_batch,
            download_spool::spool_get,
            download_spool::spool_bitmap,
            download_spool::spool_finish,
            download_spool::spool_discard,
            download_spool::spool_stats,
            download_spool::spool_gc,
            download_target::download_dir_get,
            download_target::download_dir_set,
            download_target::download_dir_reset,
            download_target::download_dir_browse,
            download_target::download_dir_open,
            download_target::download_dir_space,
            seed_files::seed_register,
            seed_files::seed_unregister,
            seed_files::seed_list,
            seed_files::seed_read_chunk,
            commands_files::media_safety_get,
            commands_files::media_safety_set,
            commands_files::retention_get,
            commands_files::retention_set,
            commands_files::retention_run,
            commands_net::privacy_get,
            commands_net::privacy_set,
            commands_net::proxy_addr_get,
            commands_net::proxy_addr_set,
            commands_net::proxy_test,
            commands_files::vault_export,
            commands_files::vault_import,
            commands_files::accounts_list,
            commands_files::account_save_imported,
            commands_files::account_switch,
            commands_files::account_remove_imported,
            commands_misc::create_group,
            commands_server::group_members,
            commands_server::group_pair_now,
            commands_server::community_pair_now,
            commands_server::community_sync_now,
            commands_server::group_add,
            commands_server::group_remove,
            commands_server::group_rename,
            commands_server::group_leave,
            commands_server::group_delete,
            commands_server::group_delete_local,
            commands_voice::call_room_publish,
            commands_voice::call_room_close,
            commands_voice::call_room_leave,
            commands_voice::call_room_join,
            commands_voice::call_rooms_list,
            commands_voice::call_invite,
            commands_voice::call_ring_retry,
            commands_voice::call_accept,
            commands_voice::call_reject,
            commands_voice::call_end,
            commands_voice::call_offer,
            commands_voice::call_answer,
            commands_voice::call_ice,
            commands_voice::call_add_participant,
            commands_voice::voice_media_available,
            commands_voice::voice_media_stats,
            commands_voice::voice_set_muted,
            commands_voice::voice_hangup,
            commands_voice::voice_set_deafened,
            commands_voice::voice_video_start,
            commands_voice::voice_video_stop,
            commands_voice::voice_video_frame,
            commands_voice::voice_mic_test_start,
            commands_voice::voice_mic_test_level,
            commands_voice::voice_mic_test_stop,
            commands_voice::voice_mic_name,
            commands_misc::send_typing,
            commands_misc::screen_share_offer,
            commands_misc::screen_share_answer,
            commands_server::channel_create,
            commands_server::channel_delete,
            commands_server::channel_rename,
            commands_server::channel_set_topic,
            commands_server::channel_set_category,
            commands_server::channel_list,
            commands_server::community_rename,
            commands_server::community_set_meta,
            commands_server::community_set_public,
            commands_server::join_public_community,
            commands_server::role_create,
            commands_server::role_update,
            commands_server::role_delete,
            commands_misc::roles_list,
            commands_server::member_roles,
            commands_server::member_assign_role,
            commands_server::member_unassign_role,
            commands_server::member_kick,
            commands_server::server_rules_get,
            commands_server::server_rules_set,
            commands_server::audit_list,
            commands_server::reputation_get,
            commands_server::safety_number,
            commands_server::moderate,
            commands_server::report_user,
            commands_misc::validate_name,
            commands_misc::random_name,
            commands_bot::bot_create,
            commands_bot::bot_update,
            commands_bot::bot_delete,
            commands_bot::bots_list,
    commands_bot::bot_webhook_secret_set,
            commands_bot::bot_post_message,
            commands_bot::bot_regen_token,
            commands_bot::bot_admin,
            commands_bot::bot_logs,
            commands_bot::bot_log_append,
            commands_bot::bot_logs_clear,
            commands_bot::bot_vars_list,
            commands_bot::bot_var_get,
            commands_bot::bot_var_set,
            commands_bot::bot_config_validate,
            commands_bot::bot_warnings_list,
            commands_bot::bot_bridge_start,
            commands_bot::bot_bridge_stop,
            commands_bot::bot_bridge_status,
            commands_bot::bot_bridge_list,
            commands_bot::bot_folder_read,
            commands_bot::bot_plugin_start,
            commands_bot::bot_plugin_stop,
            commands_bot::bot_plugin_status,
            commands_bot::bot_plugin_list,
            commands_misc::open_bots_window,
            commands_misc::http_fetch,
            commands_voice::voice_join,
            commands_bot::bot_audio_open,
            commands_bot::bot_audio_push,
            commands_bot::bot_audio_status,
            commands_bot::bot_audio_close,
            commands_voice::voice_leave,
            commands_voice::voice_state,
            commands_voice::voice_states,
            commands_files::file_announce,
            commands_files::file_request_chunk,
            commands_files::file_send_chunk,
            commands_social::social_react,
            commands_social::social_reactions,
            commands_social::social_reactions_bulk,
            commands_social::social_reply,
            commands_social::social_edit,
            commands_social::social_delete,
            commands_social::social_pin,
            commands_social::social_pins,
            commands_social::social_meta_bulk,
            commands_social::social_bodies,
            commands_social::social_forward,
            commands_social::read_set,
            commands_social::read_all,
            commands_net::unread_count,
            commands_net::unread_mentions,
            commands_net::dm_intro_state,
            commands_social::presence_set,
            commands_social::presence_list,
            commands_social::presence_get,
            commands_social::profile_set,
            commands_social::profile_get,
            commands_social::profile_list,
            commands_social::profile_sync_now,
            commands_social::nickname_set,
            commands_social::nickname_get,
            commands_social::message_search,
            commands_social::messages_around,
            commands_social::message_receipts,
            commands_social::thread_create,
            commands_social::thread_list,
            commands_social::thread_messages,
            commands_social::thread_send,
            commands_social::thread_archive,
            commands_server::member_ban,
            commands_server::member_unban,
            commands_server::ban_list,
            commands_server::member_timeout,
            commands_server::timeout_list,
            commands_server::channel_cfg_set,
            commands_server::channel_cfg_get,
            commands_social::poll_create,
            commands_social::poll_list,
            commands_social::poll_vote,
            commands_social::poll_tally,
            commands_social::event_upsert,
            commands_social::event_list,
            commands_social::event_interest,
            commands_social::event_delete,
            commands_social::emoji_upsert,
            commands_social::emoji_list,
            commands_social::emoji_delete,
            commands_social::bookmark_set,
            commands_social::bookmark_list,
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
            app_ui_ready,
            app_quit,
            window_toggle_fullscreen,
            background_set_connection,
            network_firewall_status,
            network_firewall_allow,
            network_firmware_open_firewall,
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
            // O teto do cache de prévias cresce com o uso (512 MB → 8 GB), como
            // o dono pediu. `cache.cap_mb` não é mais lido no boot; um teto
            // explícito via `cache_set_cap` continua desligando o crescimento.
            let ttl_days: u64 = Store::open(&dir.join("distorrent.db"))
                .ok()
                .and_then(|s| s.kv_get("cache.ttl_days"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(7)
                .clamp(1, 30);
            let cache = distorrent_core::cache::DiskLru::open_growing(
                dir.join("cache"),
                ttl_days * 24 * 60 * 60,
            )
            .map_err(|e| format!("cache: {e}"))?;
            app.manage(AppState {
                engine: Mutex::new(None),
                data_dir: dir.clone(),
                unlocked: Mutex::new(false),
                cache,
                auth_limit: distorrent_core::authlimit::AuthLimiter::new(),
                bot_bridges: Mutex::new(std::collections::HashMap::new()),
                bot_plugins: botplugin::Plugins::new(),
                bot_music: Arc::new(botmusic::Music::new()),
            });
            app.manage(background::Background::new());
            background::init(app.handle());
            #[cfg(target_os = "windows")]
            std::thread::spawn(|| {
                let s = firewall::network_firewall_allow();
                if !s.allowed {
                    tracing::warn!(
                        reason = ?s.reason,
                        profile = %s.profile,
                        "firewall do Windows não liberado: o app vai receber conexões de entrada só se a regra existir"
                    );
                }
            });
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
        .build(tauri::generate_context!())
        .expect("erro ao montar distorrent")
        .run(|app, event| {
            // Fechar o app fecha as pontes: socket de bot não pode ficar órfão.
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app.try_state::<AppState>() {
                    state.bot_plugins.stop_all();
                    let bridges: Vec<Arc<botbridge::Bridge>> = state
                        .bot_bridges
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .drain()
                        .map(|(_, b)| b)
                        .collect();
                    for b in bridges {
                        b.stop();
                    }
                }
            }
        });
}

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
