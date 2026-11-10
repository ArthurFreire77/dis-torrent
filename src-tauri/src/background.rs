use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::AppState;

const KV_CLOSE_TO_TRAY: &str = "ui.close_to_tray";
const KV_START_MINIMIZED: &str = "ui.start_minimized";
const KV_AUTOSTART_DECIDED: &str = "ui.autostart_decided";

pub struct Background {
    pub close_to_tray: AtomicBool,
    pub start_minimized: AtomicBool,
    pub quitting: AtomicBool,
    ring_active: AtomicBool,
    ring_call: Mutex<Option<String>>,
    notif_targets: Mutex<HashMap<i32, String>>,
    unread: AtomicUsize,
    connection: Mutex<String>,
    #[cfg(desktop)]
    tray: Mutex<Option<tauri::tray::TrayIcon<tauri::Wry>>>,
    #[cfg(desktop)]
    status_item: Mutex<Option<tauri::menu::MenuItem<tauri::Wry>>>,
}

impl Background {
    pub fn new() -> Self {
        Self {
            close_to_tray: AtomicBool::new(true),
            start_minimized: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
            ring_active: AtomicBool::new(false),
            ring_call: Mutex::new(None),
            notif_targets: Mutex::new(HashMap::new()),
            unread: AtomicUsize::new(0),
            connection: Mutex::new("SEM_CONEXAO".to_string()),
            #[cfg(desktop)]
            tray: Mutex::new(None),
            #[cfg(desktop)]
            status_item: Mutex::new(None),
        }
    }

    fn remember_target(&self, id: i32, conversation: Option<&str>) {
        if let Ok(mut m) = self.notif_targets.lock() {
            match conversation {
                Some(c) if !c.is_empty() => {
                    m.insert(id, c.to_string());
                }
                _ => {
                    m.remove(&id);
                }
            }
        }
    }

    fn conversation_of(&self, id: i32) -> Option<String> {
        self.notif_targets
            .lock()
            .ok()
            .and_then(|m| m.get(&id).cloned())
    }

    fn forget_target(&self, id: i32) {
        if let Ok(mut m) = self.notif_targets.lock() {
            m.remove(&id);
        }
    }
}

impl Default for Background {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Serialize)]
pub struct BackgroundPrefs {
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub autostart: bool,
    pub tray: bool,
    pub notification_permission: String,
}

fn kv_bool(state: &AppState, key: &str, fallback: bool) -> bool {
    distorrent_core::storage::Store::open(&state.data_dir.join("distorrent.db"))
        .ok()
        .and_then(|s| s.kv_get(key))
        .map(|v| v == "1")
        .unwrap_or(fallback)
}

fn kv_set_bool(state: &AppState, key: &str, value: bool) {
    if let Ok(s) = distorrent_core::storage::Store::open(&state.data_dir.join("distorrent.db")) {
        let _ = s.kv_set(key, if value { "1" } else { "0" });
    }
}

#[tauri::command]
pub fn background_prefs_get(app: AppHandle, bg: State<Background>) -> BackgroundPrefs {
    BackgroundPrefs {
        close_to_tray: bg.close_to_tray.load(Ordering::Relaxed),
        start_minimized: bg.start_minimized.load(Ordering::Relaxed),
        autostart: autostart_is_enabled(&app).unwrap_or(false),
        tray: tray_available(&bg),
        notification_permission: permission_state(&app),
    }
}

/// Chamado pelo frontend quando a interface já desenhou a primeira tela.
///
/// POR QUE: no boot do autostart a janela é criada escondida (senão abre e
/// recolhe — o "pisca" que o usuário vê). Aqui ela aparece só ao abrir pelo
/// atalho, e NUNCA fica invisível: se algo falhar no caminho, este comando
/// também é a rede de segurança que mostra a janela.
#[tauri::command]
pub fn app_ui_ready(app: AppHandle) {
    let Some(w) = app.get_webview_window("main") else {
        return;
    };
    let visivel = w.is_visible().unwrap_or(true);
    if visivel {
        return;
    }
    let pediu_bandeja = app
        .try_state::<Background>()
        .map(|b| b.start_minimized.load(Ordering::Relaxed))
        .unwrap_or(false);
    if pediu_bandeja && tray_available(app.state::<Background>().inner()) {
        return; // a preferência é abrir escondido: não força a janela na tela
    }
    let _ = w.show();
    #[cfg(desktop)]
    {
        let _ = w.unminimize();
    }
    let _ = w.set_focus();
}

#[tauri::command]
pub fn background_prefs_set(
    state: State<AppState>,
    bg: State<Background>,
    close_to_tray: Option<bool>,
    start_minimized: Option<bool>,
) -> Result<(), String> {
    if let Some(v) = close_to_tray {
        bg.close_to_tray.store(v, Ordering::Relaxed);
        kv_set_bool(&state, KV_CLOSE_TO_TRAY, v);
    }
    if let Some(v) = start_minimized {
        bg.start_minimized.store(v, Ordering::Relaxed);
        kv_set_bool(&state, KV_START_MINIMIZED, v);
    }
    Ok(())
}

#[tauri::command]
pub fn autostart_get(app: AppHandle) -> Result<bool, String> {
    autostart_is_enabled(&app)
}

#[tauri::command]
pub fn autostart_set(
    app: AppHandle,
    state: State<AppState>,
    enabled: bool,
) -> Result<bool, String> {
    autostart_apply(&app, enabled)?;
    kv_set_bool(&state, KV_AUTOSTART_DECIDED, true);
    autostart_is_enabled(&app)
}

#[tauri::command]
pub fn autostart_ensure(app: AppHandle, state: State<AppState>) -> Result<bool, String> {
    if kv_bool(&state, KV_AUTOSTART_DECIDED, false) {
        return autostart_is_enabled(&app);
    }
    if autostart_is_enabled(&app).unwrap_or(false) {
        return Ok(true);
    }
    match autostart_apply(&app, true) {
        Ok(()) => {
            tracing::info!("autostart ligado (DisTorrent abre junto com o Windows)");
            Ok(autostart_is_enabled(&app).unwrap_or(false))
        }
        Err(e) => {
            tracing::warn!(error = %e, "não consegui ligar o autostart");
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn autostart_mark_decided(state: State<AppState>, enabled: bool) -> Result<(), String> {
    kv_set_bool(&state, KV_AUTOSTART_DECIDED, enabled);
    Ok(())
}

pub fn notification_id_for(key: &str) -> i32 {
    let mut h: i32 = 5381;
    for b in key.as_bytes() {
        h = ((h << 5).wrapping_add(h)).wrapping_add(*b as i32);
    }
    (h.unsigned_abs() % 2_000_000_000) as i32 + 1
}

#[tauri::command]
pub fn notification_show(
    app: AppHandle,
    _bg: State<Background>,
    id: i32,
    title: String,
    body: String,
    conversation: Option<String>,
    silent: bool,
) -> Result<(), String> {
    notification_show_inner(&app, id, title, body, conversation, silent, false)
}

pub fn notification_show_inner(
    app: &AppHandle,
    id: i32,
    title: String,
    body: String,
    conversation: Option<String>,
    silent: bool,
    is_call: bool,
) -> Result<(), String> {
    if let Some(bg) = app.try_state::<Background>() {
        bg.remember_target(id, conversation.as_deref());
    }
    let mut builder = app.notification().builder().id(id).title(title).body(body);
    #[cfg(target_os = "android")]
    {
        builder = builder
            .channel_id(if is_call {
                "distorrent_calls"
            } else {
                "distorrent_messages"
            })
            .auto_cancel();
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = is_call;
    }
    if silent {
        builder = builder.silent();
    }
    builder.show().map_err(|e| e.to_string())
}

pub fn notification_cancel_inner(app: &AppHandle, id: i32) {
    if let Some(bg) = app.try_state::<Background>() {
        bg.forget_target(id);
    }
    let _ = app.notification().remove_active(vec![id]);
}

#[tauri::command]
pub fn notification_cancel(app: AppHandle, bg: State<Background>, id: i32) {
    bg.forget_target(id);
    let _ = app.notification().remove_active(vec![id]);
}

#[tauri::command]
pub fn notify_prefs_set(
    state: State<AppState>,
    system: bool,
    preview: bool,
    policy: Option<String>,
) -> Result<(), String> {
    let store = distorrent_core::storage::Store::open(&state.data_dir.join("distorrent.db"))
        .map_err(|e| e.to_string())?;
    store
        .kv_set("notify.system", if system { "1" } else { "0" })
        .map_err(|e| e.to_string())?;
    store
        .kv_set("notify.preview", if preview { "1" } else { "0" })
        .map_err(|e| e.to_string())?;
    if let Some(p) = policy {
        if p.len() <= 256 * 1024 {
            store
                .kv_set("notify.policy", &p)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn notification_cancel_all(app: AppHandle, bg: State<Background>) {
    if let Ok(mut m) = bg.notif_targets.lock() {
        m.clear();
    }
    let _ = app.notification().remove_all_active();
}

#[tauri::command]
pub fn notification_permission_state(app: AppHandle) -> String {
    permission_state(&app)
}

#[tauri::command]
pub fn notification_request_permission(app: AppHandle) -> String {
    match app.notification().request_permission() {
        Ok(p) => permission_string(p),
        Err(e) => {
            tracing::warn!("permissão de notificação falhou: {e}");
            "denied".to_string()
        }
    }
}

#[tauri::command]
pub fn app_show_window(app: AppHandle) {
    show_window(&app);
}

#[tauri::command]
pub fn app_hide_to_tray(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    emit_hidden(&app);
}

#[tauri::command]
pub fn window_toggle_fullscreen(app: AppHandle) -> bool {
    #[cfg(desktop)]
    {
        let Some(w) = app.get_webview_window("main") else {
            return false;
        };
        let atual = w.is_fullscreen().unwrap_or(false);
        let alvo = !atual;
        if w.set_fullscreen(alvo).is_err() {
            return atual;
        }
        alvo
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        false
    }
}

#[tauri::command]
pub fn app_quit(app: AppHandle, state: State<AppState>, bg: State<Background>) {
    bg.quitting.store(true, Ordering::Relaxed);
    if let Ok(guard) = state.engine.lock() {
        if let Some(engine) = guard.as_ref() {
            engine.shutdown();
        }
    }
    #[cfg(desktop)]
    {
        if let Ok(mut t) = bg.tray.lock() {
            if let Some(tray) = t.take() {
                let _ = tray.set_visible(false);
            }
        }
    }
    app.exit(0);
}

const RING_INTERVAL: Duration = Duration::from_millis(1800);
const RING_MAX: Duration = Duration::from_secs(90);

#[tauri::command]
pub fn call_ring_start(app: AppHandle, bg: State<Background>, call_id: String) {
    if let Ok(mut c) = bg.ring_call.lock() {
        *c = Some(call_id);
    }
    if bg.ring_active.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        loop {
            let Some(state) = handle.try_state::<Background>() else {
                break;
            };
            if !state.ring_active.load(Ordering::SeqCst) || started.elapsed() > RING_MAX {
                state.ring_active.store(false, Ordering::SeqCst);
                break;
            }
            let _ = handle.emit("distorrent://ring", serde_json::json!({}));
            std::thread::sleep(RING_INTERVAL);
        }
    });
}

#[tauri::command]
pub fn call_ring_stop(bg: State<Background>) {
    bg.ring_active.store(false, Ordering::SeqCst);
    if let Ok(mut c) = bg.ring_call.lock() {
        *c = None;
    }
}

#[tauri::command]
pub fn background_set_connection(
    bg: State<Background>,
    state_label: String,
    online_peers: usize,
    unread: Option<usize>,
) {
    let _ = online_peers;
    if let Ok(mut c) = bg.connection.lock() {
        *c = state_label;
    }
    if let Some(u) = unread {
        bg.unread.store(u, Ordering::Relaxed);
    }
    refresh_tray(bg.inner());
}

fn permission_string(p: tauri_plugin_notification::PermissionState) -> String {
    use tauri_plugin_notification::PermissionState as P;
    match p {
        P::Granted => "granted",
        P::Denied => "denied",
        _ => "prompt",
    }
    .to_string()
}

fn permission_state<R: tauri::Runtime>(app: &AppHandle<R>) -> String {
    match app.notification().permission_state() {
        Ok(p) => permission_string(p),
        Err(_) => "prompt".to_string(),
    }
}

#[cfg(desktop)]
fn autostart_is_enabled<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

#[cfg(desktop)]
fn autostart_apply<R: tauri::Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled {
        m.enable().map_err(|e| e.to_string())
    } else {
        m.disable().map_err(|e| e.to_string())
    }
}

#[cfg(mobile)]
fn autostart_is_enabled<R: tauri::Runtime>(_app: &AppHandle<R>) -> Result<bool, String> {
    Ok(false)
}
#[cfg(mobile)]
fn autostart_apply<R: tauri::Runtime>(_app: &AppHandle<R>, _enabled: bool) -> Result<(), String> {
    Err("inicialização automática não é permitida no Android".into())
}

fn tray_available(bg: &Background) -> bool {
    #[cfg(desktop)]
    {
        bg.tray.lock().map(|t| t.is_some()).unwrap_or(false)
    }
    #[cfg(mobile)]
    {
        let _ = bg;
        false
    }
}

fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        #[cfg(desktop)]
        {
            let _ = w.unminimize();
        }
        let _ = w.set_focus();
    }
    let _ = app.emit(
        "distorrent://activity",
        serde_json::json!({ "active": true }),
    );
}

pub fn emit_hidden(app: &AppHandle) {
    let _ = app.emit(
        "distorrent://activity",
        serde_json::json!({ "active": false }),
    );
}

#[cfg(desktop)]
fn refresh_tray(bg: &Background) {
    let label = bg
        .connection
        .lock()
        .map(|c| c.clone())
        .unwrap_or_else(|_| "SEM_CONEXAO".to_string());
    let unread = bg.unread.load(Ordering::Relaxed);
    let (net, icon) = match label.as_str() {
        "CONNECTED" => ("conectado", "🟢"),
        "DEGRADED" => ("conexão instável", "🟡"),
        _ => ("sem conexão", "⚪"),
    };
    let tip = if unread > 0 {
        format!("DisTorrent — {net} · {unread} não lida(s)")
    } else {
        format!("DisTorrent — {net}")
    };
    if let Ok(t) = bg.tray.lock() {
        if let Some(tray) = t.as_ref() {
            let _ = tray.set_tooltip(Some(tip));
        }
    }
    if let Ok(s) = bg.status_item.lock() {
        if let Some(item) = s.as_ref() {
            let _ = item.set_text(format!("{icon} {net}"));
        }
    }
}

#[cfg(mobile)]
fn refresh_tray(_bg: &Background) {}

#[cfg(desktop)]
fn install_tray(app: &AppHandle, bg: &Background) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Abrir DisTorrent", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "⚪ sem conexão", false, None::<&str>)?;
    let autostart = MenuItem::with_id(
        app,
        "autostart",
        "Iniciar com o Windows",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Sair do DisTorrent", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &status, &sep, &autostart, &sep, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("DisTorrent — sem conexão")
        .on_menu_event(|app, ev| match ev.id.as_ref() {
            "open" => show_window(app),
            "autostart" => {
                let enabled = autostart_is_enabled(app).unwrap_or(false);
                match autostart_apply(app, !enabled) {
                    Ok(()) => {
                        if let Err(e) = app.emit(
                            "distorrent://background-changed",
                            serde_json::json!({ "autostart": !enabled }),
                        ) {
                            tracing::warn!("emit background-changed falhou: {e}");
                        }
                    }
                    Err(e) => tracing::warn!("autostart pela bandeja falhou: {e}"),
                }
            }
            "quit" => {
                if let Some(state) = app.try_state::<AppState>() {
                    if let Ok(g) = state.engine.lock() {
                        if let Some(engine) = g.as_ref() {
                            engine.shutdown();
                        }
                    }
                }
                if let Some(bg) = app.try_state::<Background>() {
                    bg.quitting.store(true, Ordering::Relaxed);
                }
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_window(tray.app_handle()),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    let tray = builder.build(app)?;
    if let Ok(mut t) = bg.tray.lock() {
        *t = Some(tray);
    }
    if let Ok(mut s) = bg.status_item.lock() {
        *s = Some(status);
    }
    Ok(())
}

pub fn init(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Some(bg) = app.try_state::<Background>() {
            bg.close_to_tray
                .store(kv_bool(&state, KV_CLOSE_TO_TRAY, true), Ordering::Relaxed);
            bg.start_minimized.store(
                kv_bool(&state, KV_START_MINIMIZED, false),
                Ordering::Relaxed,
            );
        }
    }

    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let ja_ligado = app.autolaunch().is_enabled().unwrap_or(false);
        let decidido = app
            .try_state::<AppState>()
            .map(|s| kv_bool(&s, KV_AUTOSTART_DECIDED, false))
            .unwrap_or(false);
        if !decidido && !ja_ligado {
            match app.autolaunch().enable() {
                Ok(()) => {
                    tracing::info!("autostart ligado (DisTorrent abre junto com o Windows)")
                }
                Err(e) => tracing::warn!(error = %e, "não consegui ligar o autostart"),
            }
        }
    }

    #[cfg(desktop)]
    if let Some(bg) = app.try_state::<Background>() {
        if let Err(e) = install_tray(app, bg.inner()) {
            tracing::warn!("bandeja indisponível nesta plataforma: {e}");
        }
    }

    #[cfg(mobile)]
    {
        use tauri_plugin_notification::{Channel, Importance};
        let messages = Channel::builder("distorrent_messages", "Mensagens")
            .description("Novas mensagens recebidas")
            .importance(Importance::High)
            .build();
        if let Err(e) = app.notification().create_channel(messages) {
            tracing::warn!("canal de mensagens não criado: {e}");
        }
        let calls = Channel::builder("distorrent_calls", "Chamadas")
            .description("Chamadas de voz e vídeo recebidas")
            .importance(Importance::High)
            .build();
        if let Err(e) = app.notification().create_channel(calls) {
            tracing::warn!("canal de chamadas não criado: {e}");
        }
    }

    let handle = app.clone();
    let _ = app.notification().on_action(move |p| {
        let action = p.action_id().to_string();
        let id = p.notification().map(|n| n.id());
        let conv = match (id, handle.try_state::<Background>()) {
            (Some(i), Some(bg)) => bg.conversation_of(i),
            _ => None,
        };
        if action != "dismiss" {
            show_window(&handle);
        }
        if let Err(e) = handle.emit(
            "distorrent://notification-action",
            serde_json::json!({
                "action": action,
                "id": id,
                "conversation": conv,
            }),
        ) {
            tracing::warn!("emit notification-action falhou: {e}");
        }
    });

    // A preferência "iniciar minimizado" vale em QUALQUER abertura, não só no
    // login: antes só `--minimized` escondia, e abrir pelo atalho com a opção
    // ligada jogava a janela na cara do usuário.
    let quer_minimizado = app
        .try_state::<Background>()
        .map(|b| b.start_minimized.load(Ordering::Relaxed))
        .unwrap_or(false);
    let tem_bandeja = app
        .try_state::<Background>()
        .map(|b| tray_available(b.inner()))
        .unwrap_or(false);
    let deve_minimizar = quer_minimizado && tem_bandeja;
    if let Some(w) = app.get_webview_window("main") {
        if deve_minimizar {
            let _ = w.hide();
        } else {
            let _ = w.show();
            #[cfg(desktop)]
            {
                let _ = w.unminimize();
            }
            let _ = w.set_focus();
        }
    }

    if let Some(bg) = app.try_state::<Background>() {
        refresh_tray(bg.inner());
    }
}
