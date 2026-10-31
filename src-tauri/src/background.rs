//! Segundo plano do desktop: bandeja, autostart e notificações nativas,
//! sempre de forma visível ao usuário (plugins oficiais, sem evasão de AV).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::AppState;

/// Preferência: fechar a janela esconde para a bandeja (não encerra).
const KV_CLOSE_TO_TRAY: &str = "ui.close_to_tray";
/// Preferência: abrir já minimizado (bandeja) na inicialização automática.
const KV_START_MINIMIZED: &str = "ui.start_minimized";
/// Usuário já decidiu sobre autostart? Sem a marca, o boot religaria o que ele desligou.
const KV_AUTOSTART_DECIDED: &str = "ui.autostart_decided";

/// Estado do segundo plano do desktop. Um único `manage()` no setup.
pub struct Background {
    /// `true` = fechar a janela esconde para a bandeja em vez de sair.
    pub close_to_tray: AtomicBool,
    /// `true` = ao iniciar pelo autostart, abre só na bandeja.
    pub start_minimized: AtomicBool,
    /// `true` = estamos saindo de propósito (o close event não deve esconder).
    pub quitting: AtomicBool,
    /// `true` enquanto o toque de chamada recebida está ativo.
    ring_active: AtomicBool,
    /// Chamada cujo toque está ativo (só para diagnóstico/limpeza).
    ring_call: Mutex<Option<String>>,
    /// id da notificação → conversa (id estável: mensagem nova substitui a anterior).
    notif_targets: Mutex<HashMap<i32, String>>,
    /// Não-lidas agregadas mostradas no tooltip da bandeja.
    unread: AtomicUsize,
    /// Último estado de rede visto (só para o tooltip — nunca para presença).
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

/// Preferências de segundo plano, lidas pela UI no boot.
#[derive(Debug, Serialize)]
pub struct BackgroundPrefs {
    pub close_to_tray: bool,
    pub start_minimized: bool,
    pub autostart: bool,
    /// `true` quando existe ícone de bandeja de verdade nesta plataforma.
    pub tray: bool,
    /// `"granted"` / `"denied"` / `"prompt"` — permissão de notificação do SO.
    pub notification_permission: String,
}

// ------------------------------------------------------------------
// persistência (kv no mesmo SQLite do app)
// ------------------------------------------------------------------

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

// ------------------------------------------------------------------
// comandos
// ------------------------------------------------------------------

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
    // Decisão explícita: o boot deixa de mexer nisso.
    kv_set_bool(&state, KV_AUTOSTART_DECIDED, true);
    autostart_is_enabled(&app)
}

/// Reconcilia o autostart de forma idempotente e devolve o estado REAL do SO.
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
            // Honesto: não finge que ligou. O usuário ainda pode ligar na UI.
            tracing::warn!(error = %e, "não consegui ligar o autostart");
            Ok(false)
        }
    }
}

/// Marca a decisão do usuário sobre autostart (evita religar a cada boot).
#[tauri::command]
pub fn autostart_mark_decided(state: State<AppState>, enabled: bool) -> Result<(), String> {
    kv_set_bool(&state, KV_AUTOSTART_DECIDED, enabled);
    Ok(())
}

/// Id estável e positivo por chave (mesma fórmula do JS) para substituir avisos.
pub fn notification_id_for(key: &str) -> i32 {
    let mut h: i32 = 5381;
    for b in key.as_bytes() {
        h = ((h << 5).wrapping_add(h)).wrapping_add(*b as i32);
    }
    (h.unsigned_abs() % 2_000_000_000) as i32 + 1
}

/// Mostra a notificação do sistema com id estável (substitui, não empilha).
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

/// Versão sem `State` para o pump do motor notificar com a janela escondida.
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
    // Android: canais separados (mensagem × chamada) para silenciar um sem o outro.
    #[cfg(target_os = "android")]
    {
        // O toque no aviso remove a notificação na hora.
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

/// Cancela um aviso pelo id (usado quando a chamada termina).
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

/// Espelha as preferências de aviso do localStorage para o Rust (o motor não
/// vê a WebView). `policy`: `{"default":..., "channels":{id:level},"servers":[id]}`.
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
        // Teto defensivo: é um mapa de ids curtos; acima disso é lixo/ataque.
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

/// Abre (e foca) a janela principal — bandeja e clique na notificação.
#[tauri::command]
pub fn app_show_window(app: AppHandle) {
    show_window(&app);
}

/// Esconde a janela mantendo o processo (e a conexão P2P) vivo.
#[tauri::command]
pub fn app_hide_to_tray(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    emit_hidden(&app);
}

/// Sair DE VERDADE: derruba a rede, remove a bandeja e encerra o processo.
#[tauri::command]
pub fn app_quit(app: AppHandle, state: State<AppState>, bg: State<Background>) {
    bg.quitting.store(true, Ordering::Relaxed);
    if let Ok(guard) = state.engine.lock() {
        if let Some(engine) = guard.as_ref() {
            engine.shutdown();
        }
    }
    // Remover a bandeja antes evita ícone órfão no Windows por alguns segundos.
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

/// Intervalo de um toque de chamada.
const RING_INTERVAL: Duration = Duration::from_millis(1800);
/// Teto de segurança: se a UI não parar o toque, o Rust para sozinho.
const RING_MAX: Duration = Duration::from_secs(90);

/// Toque de chamada dirigido pelo RUST: timers de página oculta sofrem
/// throttling do Chromium; a thread nativa não sofre throttling.
#[tauri::command]
pub fn call_ring_start(app: AppHandle, bg: State<Background>, call_id: String) {
    if let Ok(mut c) = bg.ring_call.lock() {
        *c = Some(call_id);
    }
    // Já tocando: mantém o loop (evita dois toques sobrepostos).
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

/// Para o toque (atendeu, recusou, chamada encerrou, overlay fechou).
#[tauri::command]
pub fn call_ring_stop(bg: State<Background>) {
    bg.ring_active.store(false, Ordering::SeqCst);
    if let Ok(mut c) = bg.ring_call.lock() {
        *c = None;
    }
}

/// Estado REAL da rede para o tooltip da bandeja (não é presença).
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

// ------------------------------------------------------------------
// plataforma
// ------------------------------------------------------------------

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

/// No Android não existe autostart: erro honesto em vez de botão que finge.
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
        // `unminimize` só existe no desktop (Android: E0599); lá basta mostrar/focar.
        #[cfg(desktop)]
        {
            let _ = w.unminimize();
        }
        let _ = w.set_focus();
    }
    // Janela voltou: a camada de presença sobe de "ausente" para o estado escolhido.
    let _ = app.emit(
        "distorrent://activity",
        serde_json::json!({ "active": true }),
    );
}

/// Avisa a UI que a janela saiu da tela (bandeja).
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
    // Tooltip mostra só o estado da REDE; presença fica na UI.
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

    // Ícone: o do bundle (já embutido). Sem ele, a bandeja ficaria invisível.
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

/// Chamado no `setup()`, depois de `AppState`/`Background` gerenciados.
pub fn init(app: &AppHandle) {
    // Preferências persistidas (fonte de verdade entre reinícios).
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

    // Autostart (padrão LIGADO): mensageiro que só recebe com o app aberto não
    // serve. Liga só no primeiro boot e respeita `KV_AUTOSTART_DECIDED`;
    // falha aqui não pode impedir o app de abrir.
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

    // Bandeja: sem suporte na plataforma, o app segue sem fechar-para-bandeja.
    #[cfg(desktop)]
    if let Some(bg) = app.try_state::<Background>() {
        if let Err(e) = install_tray(app, bg.inner()) {
            tracing::warn!("bandeja indisponível nesta plataforma: {e}");
        }
    }

    // Android: criar canais é idempotente (escolhas do usuário são preservadas).
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
        // Canal separado de chamada: sem ele a chamada caía como mensagem comum.
        let calls = Channel::builder("distorrent_calls", "Chamadas")
            .description("Chamadas de voz e vídeo recebidas")
            .importance(Importance::High)
            .build();
        if let Err(e) = app.notification().create_channel(calls) {
            tracing::warn!("canal de chamadas não criado: {e}");
        }
    }

    // Clique na notificação → abre a janela; o Rust só informa, a UI roteia.
    let handle = app.clone();
    let _ = app.notification().on_action(move |p| {
        let action = p.action_id().to_string();
        let id = p.notification().map(|n| n.id());
        let conv = match (id, handle.try_state::<Background>()) {
            (Some(i), Some(bg)) => bg.conversation_of(i),
            _ => None,
        };
        // `dismiss` (iOS) não abre nada — o usuário fechou de propósito.
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

    // BUG REAL corrigido: `--minimized` do autostart sozinho escondia a janela;
    // agora só minimiza se o usuário DECIDIU isso na preferência.
    let pediu_minimizado = std::env::args().any(|a| a == "--minimized");
    let deve_minimizar = pediu_minimizado
        && app
            .try_state::<Background>()
            .map(|b| b.start_minimized.load(Ordering::Relaxed))
            .unwrap_or(false);
    if let Some(w) = app.get_webview_window("main") {
        if deve_minimizar {
            let _ = w.hide();
        } else {
            // Boot deve MOSTRAR o app; `unminimize` só existe no desktop (E0599).
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
