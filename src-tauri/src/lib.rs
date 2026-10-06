#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

//! FORGE shell — Tauri é apenas a casca: todo o motor (identidade, storage,
//! rede P2P) vive em forge-core. Commands abaixo expõem a API ao WebView.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use forge_core::net::engine::{NetworkEngine, NetworkState};
use forge_core::protocol::MessageEnvelope;
use forge_core::storage::{PeerRecord, Store, StoredMessage};
use forge_core::{Identity, Keypair};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Plugin `downloads` — só existe no Android.
///
/// No desktop o `save_file` (Rust) escreve direto na pasta Downloads do
/// usuário via `resolve_downloads_dir()`, e nada mais é preciso. No Android o
/// scoped storage (API 29+) **nega** escrita direta em
/// `/storage/emulated/0/Download`; o caminho oficial é o `MediaStore`, que
/// precisa de código nativo (Kotlin — `DownloadsPlugin.kt`). Este plugin liga
/// o `com.forge.app.DownloadsPlugin` e expõe `plugin:downloads|save` pro
/// frontend — que chama DEPOIS do `save_file`, copiando o rascunho privado
/// para o Downloads público de verdade.
///
/// Fora do Android devolvemos um builder vazio: o código do app é o mesmo
/// nos dois alvos e o frontend só invoca `plugin:downloads|save` quando
/// detecta Tauri+Android.
fn downloads_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("downloads")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                // Sem `let _ =`: o handle fica vivo no PluginManager do
                // WebView; se o registro falhar (classe não encontrada, R8
                // renomeou) o startup do app inteiro quebra — erro cedo é
                // melhor que um "não dá pra baixar" só no meio do caminho.
                let _handle = api.register_android_plugin("com.forge.app", "DownloadsPlugin")?;
            }
            #[cfg(not(target_os = "android"))]
            {
                let _ = &api;
            }
            Ok(())
        })
        .build()
}

/// Estado global do app. Engine existe só depois que a identidade existe.
struct AppState {
    engine: Mutex<Option<Arc<NetworkEngine>>>,
    data_dir: PathBuf,
    unlocked: Mutex<bool>,
    cache: forge_core::cache::DiskLru,
    /// Limite de tentativas de senha/token. Vive no processo nativo, então
    /// recarregar a página ou o WebView NÃO cria uma janela nova.
    auth_limit: forge_core::authlimit::AuthLimiter,
}

/// Origem da chamada de desbloqueio. Num app desktop há uma origem só, então
/// ela é constante — e é justamente por isso que o limite não pode depender
/// de algo que o chamador controle (header, Origin, IP de loopback): aqui não
/// há nada que o front-end possa trocar.
const AUTH_ORIGIN: &str = "desktop";

/// Monta a chave do orçamento de tentativas.
///
/// `account` é o fingerprint da conta cujo cofre está sendo aberto. Antes de
/// existir identidade — primeira configuração, ou um vault sem identidade
/// carregada — usamos um marcador fixo, para que as tentativas nesse estado
/// também somem no mesmo balde.
fn auth_key(store: &Store, suffix: &str) -> String {
    let account = store
        .load_identity()
        .map(|i| i.fingerprint)
        .unwrap_or_else(|| "no-identity".to_string());
    forge_core::authlimit::AuthLimiter::key(&format!("{account}:{suffix}"), AUTH_ORIGIN)
}

/// Verifica o orçamento antes de gastar o Argon2id.
///
/// Devolve `Err` com o tempo restante quando bloqueado. A mensagem diz
/// quantos segundos faltam — a UI mostra isso e impede novo envio, mas quem
/// manda é esta função, não a UI.
fn auth_guard(state: &State<AppState>, key: &str) -> Result<(), String> {
    match state.auth_limit.check(key) {
        forge_core::authlimit::Decision::Allowed => Ok(()),
        forge_core::authlimit::Decision::Blocked { retry_after } => {
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

/// Registra uma tentativa FALHA e devolve o erro de bloqueio se estourou o
/// limite. Log sem nenhum fragmento do segredo.
///
/// Semântica: a 3ª falha é a que instala o bloqueio, e ela ainda responde
/// "senha incorreta" — a senha estava errada de fato. A mensagem de bloqueio
/// aparece na 4ª tentativa, quando a guarda a barra de verdade.
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
        // A 3ª tentativa foi a última aceita. Dizemos isso agora, para o
        // usuário não ficar descobrindo na 4ª.
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

/// Zera o histórico depois de um desbloqueio bem-sucedido.
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
    /// Diagnóstico por peer: último erro direto/relay, tentativas, announce.
    /// Valores REAIS do motor — nada inventado; null = ainda sem tentativa.
    last_direct_error: Option<String>,
    last_relay_error: Option<String>,
    direct_attempts: u64,
    relay_attempts: u64,
    announce_seen_ms: i64,
}

/// Diagnóstico global da rede (STUN/announce/DHT) — por que 0 peers.
#[derive(Debug, Serialize)]
struct NetDiagView {
    /// STUN: null = não testado ainda; true = binding NAT ok.
    stun_ok: Option<bool>,
    stun_addr: Option<String>,
    stun_ms: i64,
    /// Endpoint próprio anunciado (null = não anunciou).
    announce_addr: Option<String>,
    announce_ms: i64,
    /// Origem do endpoint: "upnp" (local, sem servidor) ou "stun".
    nat_source: Option<String>,
    /// DHT mainline BitTorrent: null = desligada (testes/proxy); true = nó
    /// anunciando na rede BitTorrent.
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
    state.data_dir.join("forge.db")
}

fn open_store(state: &State<AppState>) -> Result<Store, String> {
    Store::open(&db_path(state)).map_err(err)
}

// ---------------- endereços locais ----------------

#[derive(Debug, Serialize)]
struct LocalAddresses {
    /// `localhost` — válido SÓ nesta máquina.
    localhost: String,
    /// IP de LAN (en0/wlan0/etc). Válido no celular, na mesma rede Wi-Fi.
    /// `None` quando não há rede cabeada/sem fio (ou não foi possível ler).
    lan: Option<String>,
    /// Todos os IPs de LAN encontrados, para o usuário escolher.
    lan_all: Vec<String>,
    /// A porta em que o servidor de desenvolvimento/UI escuta.
    port: u16,
}

/// IPs de todas as interfaces locais, em ordem de preferência.
///
/// Por que isso importa: `localhost` no celular é o PRÓPRIO celular. Um link
/// de convite `http://localhost:5173/...` que o usuário copia e manda para o
/// celular não abre o app do computador — abre o celular e falha. O endereço
/// que funciona é o IP de LAN. Este comando existe para a interface poder
/// MOSTRAR os dois, com essa explicação, em vez de fingir que localhost
/// resolve para o computador.
fn local_ipv4_addresses() -> Vec<String> {
    // `UdpSocket::bind` numa porta descartável + `connect` para um endereço
    // público não envia nada: só faz o SO escolher a interface de saída. É a
    // forma padrão de descobrir o IP de LAN sem trazer dependência de rede.
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

/// Porta do servidor de desenvolvimento (Vite). O `vite.config.ts` fixa
/// `port: 5173, strictPort: true`, então divergir daqui quebraria o link.
const DEV_PORT: u16 = 5173;

// ---------------- identidade ----------------

#[tauri::command]
fn identity_get(app: AppHandle, state: State<AppState>) -> Result<Option<Identity>, String> {
    let store = open_store(&state)?;
    let Some(id) = store.load_identity() else {
        return Ok(None);
    };
    let vault_on = store.kv_get("vault.on").as_deref() == Some("1");
    let stored = store.load_secret_hex().unwrap_or_default();
    let has_valid_blob = stored.len() >= 88; // salt16+nonce12+ct(32secret+16tag), hex

    if vault_on && has_valid_blob {
        // cofre com senha: engine ainda sem segredo — devolve None para a UI
        // cair no LockScreen e chamar vault_unlock (export/backup exigem engine).
        return Ok(None);
    }
    // sem cofre válido: tenta keyring do SO, SQLite direto e backup
    // 1) keyring
    if let Ok(entry) = keyring::Entry::new("forge-app", "identity.secret") {
        if let Ok(secret) = entry.get_password() {
            if !secret.is_empty() && secret.len() >= 32 {
                // restaura no SQLite para robustez futura
                let _ = store.save_identity(&id, &secret);
                let _ = store.kv_set("identity.secret.backup", &secret);
                let _ = store.kv_delete("vault.on");
                boot_engine_if_needed(&app, &state)?;
                return Ok(Some(id));
            }
        }
    }
    // 2) SQLite direto (fallback quando keyring salvou vazio mas secret estava em backup, ou sistema sem keyring)
    if !stored.is_empty() && stored.len() >= 32 {
        // secret já está no SQLite (caso fallback persist_secret)
        let _ = store.kv_set("identity.secret.backup", &stored);
        let _ = store.kv_delete("vault.on");
        boot_engine_if_needed(&app, &state)?;
        return Ok(Some(id));
    }
    // 3) backup kv
    if let Some(bk) = store.kv_get("identity.secret.backup") {
        if !bk.is_empty() && bk.len() >= 32 {
            let _ = store.save_identity(&id, &bk);
            let _ = store.kv_delete("vault.on");
            boot_engine_if_needed(&app, &state)?;
            return Ok(Some(id));
        }
    }
    // sem blob válido e sem keyring/SQLite: a chave privada está irrecuperável.
    // NÃO apagar automaticamente — retornar erro para UI decidir (evita perda irreversível)
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
            // cofre: secret cifrada com a senha no SQLite local
            let secret_hex = kp.secret_hex();
            let blob = forge_core::vault::seal_secret(&secret_hex, pass).map_err(err)?;
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

/// Desbloqueia o cofre com a senha do usuário.
///
/// ORDEM DELIBERADA: o orçamento é verificado ANTES do Argon2id. Um atacante
/// bloqueado nem chega a gastar o KDF — o que também impede que ele use o
/// próprio app como oráculo de tempo de resposta para medir a senha.
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

    let secret = match forge_core::vault::open_sealed(&blob, &password) {
        Ok(s) => s,
        Err(e) => {
            // A senha NÃO aparece no log nem no erro devolvido.
            return Err(auth_fail(&state, &key, &e.to_string()));
        }
    };

    auth_ok(&state, &key);

    // corrigir pubkey vazio (após account_switch) derivando da secret
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

/// Troca de senha (exige a atual). Re-cifra a secret local.
///
/// Caminho de autenticação paralelo e COM o MESMO orçamento: sem isto, um
/// atacante bloquearia `vault_unlock` e depois usaria `vault_change` para
/// testar senhas sem limite nenhum.
#[tauri::command]
fn vault_change(old: String, new: String, state: State<AppState>) -> Result<(), String> {
    let store = open_store(&state)?;
    let key = auth_key(&store, "change");
    auth_guard(&state, &key)?;

    let stored = store.load_secret_hex().ok_or("sem cofre")?;
    let blob = hex::decode(&stored).map_err(|_| "cofre corrompido".to_string())?;
    let secret = match forge_core::vault::open_sealed(&blob, &old) {
        Ok(s) => s,
        Err(e) => return Err(auth_fail(&state, &key, &e.to_string())),
    };
    let newblob = match forge_core::vault::seal_secret(&secret, &new) {
        Ok(b) => b,
        Err(e) => return Err(e.to_string()),
    };
    store
        .save_secret_blob(&hex::encode(&newblob))
        .map_err(err)?;
    auth_ok(&state, &key);
    Ok(())
}

/// Troca de nickname — muda só o nome EXIBIDO (fingerprint é imutável).
/// Engine é reiniciado para anunciar o novo nick no discovery/handshake.
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

/// Chave privada vai para o keyring do SO. Se indisponível (headless, Linux
/// sem secret service), cai para o SQLite local — documentado em SECURITY.md.
/// No keyring: kv guarda secret vazia ("" = "está no keyring").
fn persist_secret(store: &Store, kp: &Keypair, identity: &Identity) -> Result<(), String> {
    let secret = kp.secret_hex();
    #[cfg(target_os = "android")]
    {
        tracing::info!("Android: salvando secret no SQLite");
        store.save_identity(identity, &secret).map_err(err)?;
        let _ = store.kv_set("identity.secret.backup", &secret);
        return Ok(());
    }
    match keyring::Entry::new("forge-app", "identity.secret") {
        Ok(entry) => match entry.set_password(&secret) {
            Ok(_) => {
                // salva também backup no SQLite para caso keyring fique indisponível após reboot
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
    if let Ok(entry) = keyring::Entry::new("forge-app", "identity.secret") {
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

/// Boot direto a partir de um segredo já aberto (pós-desbloqueio do cofre).
/// O spawn do engine EXIGE runtime tokio — sempre via block_on.
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

// ---------------- engine boot/restart ----------------

fn boot_engine_if_needed(app: &AppHandle, state: &State<AppState>) -> Result<(), String> {
    if state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .is_some()
    {
        return Ok(());
    }
    // engine spawn precisa de runtime tokio — commands sync rodam fora dele
    tauri::async_runtime::block_on(async {
        let store = open_store(state)?;
        if store.kv_get("vault.on").as_deref() == Some("1")
            && !*state.unlocked.lock().unwrap_or_else(|e| e.into_inner())
        {
            return Ok(()); // aguardando senha na UI — sem boot
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
    // sem sleep: peers recebem RST do OS, limpeza imediata
    *state.engine.lock().unwrap_or_else(|e| e.into_inner()) = None;
    boot_engine_if_needed(app, state)
}

fn forward_events(app: &AppHandle, engine: Arc<NetworkEngine>) {
    let mut rx = engine.subscribe();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ev) => {
                    if let Err(e) = handle.emit("forge://event", &ev) {
                        tracing::warn!("emit falhou: {e}");
                    }
                }
                // Lagged = a UI ficou >256 eventos atrás (ex.: transferência de
                // arquivo). O canal segue VIVO: seguir é obrigatório. Antes o
                // `break` matava o pump para sempre — nenhum evento chegava
                // mais à WebView (sem ring, sem sinalização) até REINICIAR o
                // app, que é exatamente o sintoma reportado.
                Err(forge_core::BroadcastRecvError::Lagged(n)) => {
                    tracing::warn!("eventos descartados na UI ({n}) — pump segue vivo");
                }
                Err(forge_core::BroadcastRecvError::Closed) => break,
            }
        }
    });
}

// ---------------- rede ----------------

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
                record,
            }
        })
        .collect())
}

/// Diagnóstico global: STUN (binding NAT) e anúncio do próprio endpoint.
/// A página reporta o que ela enxerga de WebRTC. É a ÚNICA prova real: o
/// `WebKitSettings` ter sido aplicado não garante que o `RTCPeerConnection`
/// exista de fato no contexto da página (depende do build do WebKitGTK).
#[tauri::command]
fn webrtc_report(info: String) {
    eprintln!("[forge-probe] {info}");
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

#[tauri::command]
async fn relay_status(
    state: State<'_, AppState>,
) -> Result<Vec<forge_core::net::relay::RelayLegStatus>, String> {
    // Diagnóstico honesto das pernas do relay. Se o motor existe, respeita o
    // modo de privacidade: em proxy/Tor o probe passa pelo SOCKS5 (nítido —
    // NÃO revela o IP real aos hosts públicos). Sem motor (sem identidade),
    // cai no probe direto (não há modo anônimo configurado ainda).
    let engine = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    match engine {
        Some(engine) => Ok(engine.relay_diagnostics().await),
        None => Ok(forge_core::net::relay::check_relay_legs().await),
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
    // IP:porta → direto; domínio:porta e .onion:porta → connect_host
    // (em modo proxy/Tor o hostname vai ao SOCKS5 SEM resolver localmente)
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

// ---------------- comunidades ----------------

#[derive(Debug, Serialize)]
struct CommunityView {
    id: String,
    name: String,
    owner_fp: String,
    channels: Vec<(String, String)>,
    members: Vec<(String, String, String)>,
    /// v6 (wizard): descrição/categoria/ícone.
    description: String,
    category: String,
    icon: String,
}

#[tauri::command]
fn communities_list(state: State<AppState>) -> Result<Vec<CommunityView>, String> {
    let engine = engine(&state)?;
    let mut out = Vec::new();
    for (id, name, owner) in engine.store_list_communities() {
        let (description, category, icon) = engine.community_meta(&id).unwrap_or_default();
        out.push(CommunityView {
            channels: engine.store_list_channels(&id),
            members: engine.store_list_members(&id),
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
fn create_community(
    name: String,
    channels: Option<Vec<String>>,
    options: Option<forge_core::net::engine::CommunityCreateOptions>,
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

/// v6 — atualiza descrição/categoria/ícone da comunidade (dono).
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
fn make_invite(
    community_id: String,
    member_fp: String,
    state: State<AppState>,
) -> Result<String, String> {
    let member_fp = member_fp.trim().to_lowercase();
    if member_fp != "000000000000"
        && (member_fp.len() != 12 || !member_fp.chars().all(|c| c.is_ascii_hexdigit()))
    {
        return Err(
            "fingerprint do convidado deve ter 12 hex (ou use 000000000000 p/ link aberto)".into(),
        );
    }
    engine(&state)?
        .make_invite(&community_id, &member_fp, 7 * 24 * 3600 * 1000)
        .map_err(err)
}

#[tauri::command]
fn join_community(token: String, state: State<AppState>) -> Result<String, String> {
    engine(&state)?.join_community(token.trim()).map_err(err)
}

#[tauri::command]
fn send_channel_message(
    community_id: String,
    channel_id: String,
    body: String,
    state: State<AppState>,
) -> Result<forge_core::storage::StoredMessage, String> {
    if body.trim().is_empty() {
        return Err("mensagem vazia".into());
    }
    engine(&state)?
        .send_channel_message(&community_id, &channel_id, body.trim())
        .map_err(err)
}

// ---------------- servidor: canais / cargos / bots ----------------

/// Patch de cargo aceito como objeto `patch` (formato do frontend) OU args
/// planos; os planos têm precedência quando presentes.
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

/// Distingue ausente (não mexer) de null (limpar cargo).
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
    /// v6: JSON do runtime web do bot (a UI valida tamanho; o core persiste).
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
) -> Result<forge_core::storage::ChannelMetaRow, String> {
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
) -> Result<Vec<forge_core::storage::ChannelMetaRow>, String> {
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
) -> Result<forge_core::storage::RoleRow, String> {
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
    // args planos vencem o objeto patch quando presentes
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
) -> Result<Vec<forge_core::storage::RoleRow>, String> {
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

// ---------------- moderação + segurança (Storm) ----------------

#[tauri::command]
fn server_rules_get(
    community_id: String,
    state: State<AppState>,
) -> Result<forge_core::moderation::ServerRules, String> {
    engine(&state)?
        .server_rules_get(community_id.trim())
        .map_err(err)
}

#[tauri::command]
fn server_rules_set(
    rules: forge_core::moderation::ServerRules,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?.server_rules_set(rules).map_err(err)
}

#[tauri::command]
fn audit_list(
    community_id: String,
    limit: Option<i64>,
    state: State<AppState>,
) -> Result<Vec<forge_core::moderation::AuditEntry>, String> {
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
    let k = forge_core::names::NameKind::from_str(kind.trim())
        .ok_or_else(|| "tipo inválido (user|server|channel)".to_string())?;
    let scope = existing.unwrap_or_default();
    let policy = forge_core::names::NamePolicy::for_kind(k);
    let c = forge_core::names::validate_name(k, &raw, &scope, &policy);
    Ok(NameCheckView {
        ok: c.ok,
        normalized: c.normalized,
        errors: c.errors,
        suggestions: c.suggestions,
    })
}

#[tauri::command]
fn random_name() -> String {
    forge_core::names::random_name()
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
) -> Result<forge_core::storage::BotRow, String> {
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
    let p = patch.unwrap_or_default();
    if let Some(c) = config.as_deref().or(p.config.as_deref()) {
        if c.len() > 16 * 1024 {
            return Err("config do bot muito grande (máx 16KB)".into());
        }
    }
    let merged = forge_core::storage::BotPatch {
        name: name.or(p.name),
        avatar: avatar.or(p.avatar),
        // flat Some(x) → Some(Some(x)); "" ou null limpam o cargo
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
) -> Result<Vec<forge_core::storage::BotRow>, String> {
    engine(&state)?.bots_list(&community_id).map_err(err)
}

/// v6 — posta mensagem COMO O BOT (dono; runtime web roda no host).
#[tauri::command]
fn bot_post_message(
    community_id: String,
    channel_id: String,
    bot_id: String,
    body: String,
    state: State<AppState>,
) -> Result<forge_core::storage::StoredMessage, String> {
    if body.trim().is_empty() {
        return Err("mensagem vazia".into());
    }
    engine(&state)?
        .bot_post_message(&community_id, &channel_id, &bot_id, body.trim())
        .map_err(err)
}

/// v6 — novo token (dono); o antigo é invalidado na hora.
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

/// v6 — HTTP REST para o runtime de BOTS. reqwest no shell = SEM CORS do
/// WebView (a API de bots precisa de internet aberta: weather, APIs públicas,
/// webhooks). Limites: scheme http/https, timeout 15s, resposta 256KB,
/// sem secrets no log. O alvo é definido pelo DONO no painel do bot.
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
    // valida scheme/host antes de gastar socket
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
    // cap defensivo: 16 headers, chaves/valores pequenos (o painel também valida)
    let headers: Vec<(String, String)> = headers
        .into_iter()
        .filter(|(k, _)| !k.trim().is_empty())
        .take(16)
        .collect();
    if headers.iter().any(|(k, v)| k.len() > 128 || v.len() > 1024) {
        return Err("header grande demais".into());
    }
    let body_bytes = match body.as_deref() {
        Some(b) if !b.is_empty() => {
            // aceita texto puro OU base64 (dados binários de webhook)
            base64::engine::general_purpose::STANDARD
                .decode(b)
                .ok()
                .map(reqwest::Body::from)
                .unwrap_or_else(|| reqwest::Body::from(b.to_string()))
        }
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
    // corpo volta como base64 para trafegar binário com segurança de IPC
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let truncated = bytes.len() > 256 * 1024;
    Ok(HttpResponse {
        status,
        body_b64: b64,
        // já decodifica em texto quando é UTF-8 válido (caso comum: JSON de API)
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

// ---------------- amigos ----------------

#[tauri::command]
fn friends_list(status: Option<String>, state: State<AppState>) -> Result<Vec<PeerRecord>, String> {
    Ok(engine(&state)?.friends(status.as_deref()))
}

#[tauri::command]
fn friend_request(
    peer_fp: String,
    state: State<AppState>,
) -> Result<forge_core::net::engine::FriendOutcome, String> {
    let fp = peer_fp.trim().to_lowercase();
    if !fp.chars().all(|c| c.is_ascii_hexdigit()) || fp.len() != 12 {
        return Err("fingerprint deve ter 12 hex chars".into());
    }
    let outcome = engine(&state)?.friend_request(&fp).map_err(err)?;
    // REMOVIDO: fallback de friend request via ntfy.sh (POST externo lento).
    // O pedido vai pelo motor P2P (relay MQTT push / direta), sem HTTP externo.
    Ok(outcome)
}

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

// ---------------- conversas / mensagens ----------------

#[tauri::command]
fn conversations_list(
    state: State<AppState>,
) -> Result<Vec<forge_core::storage::Conversation>, String> {
    Ok(engine(&state)?.conversations())
}

#[tauri::command]
fn dm_open(
    peer_fp: String,
    peer_nick: String,
    state: State<AppState>,
) -> Result<forge_core::storage::Conversation, String> {
    engine(&state)?.open_dm(&peer_fp, &peer_nick).map_err(err)
}

#[tauri::command]
fn messages_list(
    conv_id: String,
    state: State<AppState>,
) -> Result<Vec<forge_core::storage::StoredMessage>, String> {
    Ok(engine(&state)?.messages(&conv_id))
}

#[tauri::command]
fn message_send(
    conv_id: String,
    body: String,
    state: State<AppState>,
) -> Result<forge_core::storage::StoredMessage, String> {
    if body.trim().is_empty() {
        return Err("mensagem vazia".into());
    }
    engine(&state)?.send_dm(&conv_id, body.trim()).map_err(err)
}

#[tauri::command]
fn delete_conversation(conv_id: String, state: State<AppState>) -> Result<(), String> {
    let st = open_store(&state)?;
    st.delete_conversation(&conv_id).map_err(err)?;
    Ok(())
}

/// Verificação de assinatura disponível para qualquer camada da UI.
#[tauri::command]
fn message_verify(env: MessageEnvelope, pubkey_hex: String) -> Result<bool, String> {
    Ok(env.verify_with_pubkey(&pubkey_hex))
}

// ---------------- privacidade ----------------

/// Configuração de privacidade persistida no SQLite (kv store).
/// Cada flag controla uma camada real de rede/criptografia no engine.
#[derive(Debug, Clone, Serialize)]
struct PrivacySettings {
    mode: String,
    encryption_enabled: bool,
    tor_proxy: bool,
    udp_discovery: bool,
    metadata_padding: bool,
    traffic_obfuscation: bool,
}

impl PrivacySettings {
    /// Resolve o modo para as flags reais que o engine Rust aplica.
    /// 'encrypted' é o padrão seguro (fallback se modo inválido).
    fn from_mode(mode: &str) -> Self {
        match mode {
            "normal" => PrivacySettings {
                mode: "normal".into(),
                encryption_enabled: false, // sem criptografia
                tor_proxy: false,
                udp_discovery: true,
                metadata_padding: false,
                traffic_obfuscation: false,
            },
            "encrypted" => PrivacySettings {
                mode: "encrypted".into(),
                encryption_enabled: true, // X25519 + ChaCha20
                tor_proxy: false,
                udp_discovery: true,
                metadata_padding: false,
                traffic_obfuscation: false,
            },
            "proxy" => PrivacySettings {
                mode: "proxy".into(),
                encryption_enabled: true, // com criptografia + 1 proxy (esconde IP)
                tor_proxy: false,         // proxy único, não Tor 7 nós
                udp_discovery: false,     // sem broadcast para esconder IP
                metadata_padding: false,
                traffic_obfuscation: true, // tráfego via proxy
            },
            "full" => PrivacySettings {
                mode: "full".into(),
                encryption_enabled: true, // Tor 7 nós + criptografia
                tor_proxy: true,          // SOCKS5 na porta 9050 (TOR)
                udp_discovery: false,
                metadata_padding: true,
                traffic_obfuscation: true,
            },
            _ => PrivacySettings {
                mode: "encrypted".into(),
                encryption_enabled: true,
                tor_proxy: false,
                udp_discovery: true,
                metadata_padding: false,
                traffic_obfuscation: false,
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
    Ok(PrivacySettings::from_mode(&mode))
}

#[tauri::command]
fn privacy_set(mode: String, state: State<AppState>) -> Result<PrivacySettings, String> {
    let valid = matches!(mode.as_str(), "normal" | "encrypted" | "proxy" | "full");
    if !valid {
        return Err("modo inválido — use: normal, encrypted, proxy ou full".into());
    }

    // APLICA NO MOTOR EM TEMPO REAL (era só persistência: o relay só trocava
    // de rota após reiniciar o app — modos proxy/full nunca valiam de fato).
    // `privacy_set_mode` persiste `privacy.mode` no kv E re-rota o relay
    // (túneis SOCKS5 em proxy/Tor; rotas diretas em normal/encrypted).
    let engine_opt = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if let Some(eng) = engine_opt {
        eng.privacy_set_mode(&mode).map_err(err)?;
    } else {
        // sem motor (vault trancado): só persiste — o boot lê do kv.
        let store = open_store(&state)?;
        store.kv_set("privacy.mode", &mode).map_err(err)?;
    }

    // Persiste cada flag individualmente para debug e auditoria
    let store = open_store(&state)?;
    let settings = PrivacySettings::from_mode(&mode);
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
    Ok(settings)
}

/// Endereço SOCKS5 salvo (ou default por modo: proxy=1080, full/Tor=9050).
#[derive(Debug, Serialize)]
struct ProxyConfig {
    addr: String,
    is_default: bool,
}

#[tauri::command]
fn proxy_addr_get(state: State<AppState>) -> Result<ProxyConfig, String> {
    let store = open_store(&state)?;
    let saved = store
        .kv_get("privacy.proxy_addr")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let mode = store
        .kv_get("privacy.mode")
        .unwrap_or_else(|| "encrypted".into());
    match saved {
        Some(addr) => Ok(ProxyConfig {
            addr,
            is_default: false,
        }),
        None => {
            // default alinhado ao motor: Tor=9050, proxy=1080
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

/// Salva o proxy digitado na UI ("host:porta"); aplica na hora se o motor
/// estiver em modo proxy/full (o relay re-rotas os túneis sem reiniciar).
#[tauri::command]
fn proxy_addr_set(addr: String, state: State<AppState>) -> Result<(), String> {
    let engine_opt = state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    match engine_opt {
        Some(eng) => eng.set_proxy_addr(&addr).map_err(err),
        None => {
            // sem motor: valida mínimo e persiste para o próximo boot
            let trimmed = addr.trim();
            let store = open_store(&state)?;
            if trimmed.is_empty() {
                store.kv_delete("privacy.proxy_addr").map_err(err)?;
            } else {
                // valida formato host:porta antes de persistir
                let (_, port) = trimmed
                    .rsplit_once(':')
                    .ok_or("formato inválido — use host:porta")?;
                port.parse::<u16>()
                    .map_err(|_| "porta inválida".to_string())?;
                store.kv_set("privacy.proxy_addr", trimmed).map_err(err)?;
            }
            Ok(())
        }
    }
}

/// Teste ONLINE do proxy SOCKS5: abre um circuito real pelo proxy até os
/// brokers MQTT públicos (mesmas pernas que o relay vai usar — sem ntfy,
/// sem HTTP extra). Devolve a latência do 1º circuito que abrir ou o erro.
#[tauri::command]
async fn proxy_test(addr: String) -> Result<u64, String> {
    let trimmed = addr.trim().to_string();
    if trimmed.is_empty() {
        return Err("informe o endereço do proxy (ex.: 127.0.0.1:9050 para Tor)".into());
    }
    forge_core::net::relay::proxy_online_test(&trimmed).await
}

// ---------------- vault export/import ----------------

#[derive(Debug, Serialize)]
struct VaultExport {
    identity: Identity,
    vault_blob: String, // hex do blob criptografado
}

/// Exporta a identidade completa (identity + vault criptografado).
/// O vault já está cifrado com a senha — seguro pra transferir.
#[tauri::command]
fn vault_export(state: State<AppState>) -> Result<VaultExport, String> {
    let store = open_store(&state)?;
    let identity = store.load_identity().ok_or("sem identidade")?;
    // GATE: só exporta BLOB CIFRADO. Sem vault (keyring/fallback SQLite), o kv
    // guarda a secret RAW — exportá-la como "vault_blob" vazaría a chave
    // privada em claro para a UI/arquivo de backup.
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

/// Importa uma identidade de outro device.
/// Salva o vault criptografado — o unlock normal pede a senha.
/// NÃO permite importar se já existe uma identidade ativa.
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

/// Lista contas salvas neste device (para tela de bloqueio).
#[derive(Debug, Serialize)]
struct SavedAccount {
    nickname: String,
    fingerprint: String,
}

#[tauri::command]
fn accounts_list(state: State<AppState>) -> Result<Vec<SavedAccount>, String> {
    let store = open_store(&state)?;
    let mut out = Vec::new();
    // conta atual
    if let Some(id) = store.load_identity() {
        out.push(SavedAccount {
            nickname: id.nickname,
            fingerprint: id.fingerprint,
        });
    }
    // contas importadas (salvas no kv) — early exit: se slot 0 não existe, nenhum existe
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

/// Salva uma identidade importada como conta alternativa.
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
    // encontra slot vazio
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

/// Troca pra outra conta salva (ativa a identidade selecionada).
#[tauri::command]
fn account_switch(fingerprint: String, state: State<AppState>) -> Result<Identity, String> {
    let store = open_store(&state)?;

    // verifica se é a conta atual
    if let Some(id) = store.load_identity() {
        if id.fingerprint == fingerprint {
            return Ok(id); // já é esta
        }
    }

    // procura nas importadas
    for i in 0..20 {
        if store.kv_get(&format!("imported.{i}.fp")).as_deref() == Some(&fingerprint) {
            let blob = store
                .kv_get(&format!("imported.{i}.blob"))
                .ok_or("vault da conta não encontrado")?;
            let nick = store
                .kv_get(&format!("imported.{i}.nick"))
                .unwrap_or_default();
            let pubkey_hex = store
                .kv_get(&format!("imported.{i}.pubkey"))
                .unwrap_or_default();

            // salva a conta atual como importada antes de trocar
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
                created_at: forge_core::identity::now_ms(),
            };
            store
                .save_identity(&imported_identity, &blob)
                .map_err(err)?;
            store.kv_set("vault.on", "1").map_err(err)?;

            // O motor ainda anuncia/responde com a identidade ANTIGA. Sem isto,
            // peers conectavam com quem a UI nem mostrava mais.
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

/// Remove uma conta importada.
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


// =====================================================================
// CAMADA SOCIAL v3 — paridade Discord (relações, pins, busca, perfis,
// presença, threads, moderação, enquetes, eventos, emojis)
// Todas passam pelo MOTOR (validação de autor/permissão no core).
// =====================================================================

#[tauri::command]
fn social_react(conv_id: String, msg_id: String, emoji: String, state: State<AppState>) -> Result<bool, String> {
    engine(&state)?.social_react(&conv_id, &msg_id, &emoji).map_err(err)
}

#[tauri::command]
fn social_reactions(msg_id: String, state: State<AppState>) -> Result<Vec<forge_core::social::ReactionSummary>, String> {
    let store = open_store(&state)?;
    let rows = store.reactions_for_msg(&msg_id).map_err(err)?;
    Ok(store.mark_reactions_mine(rows, &identity_fp(&state)))
}

#[tauri::command]
fn social_reactions_bulk(msg_ids: Vec<String>, state: State<AppState>) -> Result<Vec<forge_core::social::ReactionSummary>, String> {
    let store = open_store(&state)?;
    let rows = store.reactions_for_msgs(&msg_ids).map_err(err)?;
    Ok(store.mark_reactions_mine(rows, &identity_fp(&state)))
}

#[tauri::command]
fn social_reply(conv_id: String, msg_id: String, reply_to: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_reply(&conv_id, &msg_id, &reply_to).map_err(err)
}

#[tauri::command]
fn social_edit(conv_id: String, msg_id: String, body: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_edit(&conv_id, &msg_id, &body).map_err(err)
}

#[tauri::command]
fn social_delete(conv_id: String, msg_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_delete(&conv_id, &msg_id).map_err(err)
}

#[tauri::command]
fn social_pin(conv_id: String, msg_id: String, pinned: bool, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_pin(&conv_id, &msg_id, pinned).map_err(err)
}

#[tauri::command]
fn social_pins(conv_id: String, state: State<AppState>) -> Result<Vec<forge_core::social::MsgMetaView>, String> {
    open_store(&state)?.pins_list(&conv_id).map_err(err)
}

#[tauri::command]
fn social_meta_bulk(msg_ids: Vec<String>, state: State<AppState>) -> Result<Vec<forge_core::social::MsgMetaView>, String> {
    open_store(&state)?.msg_meta_bulk(&msg_ids).map_err(err)
}

/// Corpo efetivo de um lote de mensagens (edição aplicada / apagada).
#[tauri::command]
fn social_bodies(msg_ids: Vec<String>, state: State<AppState>) -> Result<Vec<(String, String)>, String> {
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

// ---------- leitura / não-lidas ----------

#[tauri::command]
fn read_set(conv_id: String, ts: i64, state: State<AppState>) -> Result<(), String> {
    open_store(&state)?.read_set(&conv_id, ts).map_err(err)
}

#[tauri::command]
fn read_all(state: State<AppState>) -> Result<Vec<forge_core::social::ReadCursor>, String> {
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

// ---------- presença / perfil ----------

#[tauri::command]
fn presence_set(status: String, custom: String, custom_emoji: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_presence_set(&status, &custom, &custom_emoji).map_err(err)
}

#[tauri::command]
fn presence_list(state: State<AppState>) -> Result<Vec<forge_core::social::PresenceView>, String> {
    open_store(&state)?.presence_list().map_err(err)
}

#[tauri::command]
fn presence_get(fp: String, state: State<AppState>) -> Result<forge_core::social::PresenceView, String> {
    open_store(&state)?.presence_get(&fp).map_err(err)
}

#[tauri::command]
fn profile_set(
    display_name: String,
    about: String,
    avatar_b64: String,
    banner_b64: String,
    accent: String,
    state: State<AppState>,
) -> Result<forge_core::social::ProfileView, String> {
    engine(&state)?
        .social_profile_set(&display_name, &about, &avatar_b64, &banner_b64, &accent)
        .map_err(err)
}

#[tauri::command]
fn profile_get(fp: String, state: State<AppState>) -> Result<forge_core::social::ProfileView, String> {
    open_store(&state)?.profile_get(&fp).map_err(err)
}

#[tauri::command]
fn profile_list(state: State<AppState>) -> Result<Vec<forge_core::social::ProfileView>, String> {
    open_store(&state)?.profile_list().map_err(err)
}

#[tauri::command]
fn nickname_set(community_id: String, fp: String, nickname: String, state: State<AppState>) -> Result<(), String> {
    open_store(&state)?.nickname_set(&community_id, &fp, &nickname).map_err(err)
}

#[tauri::command]
fn nickname_get(community_id: String, fp: String, state: State<AppState>) -> Result<String, String> {
    open_store(&state)?.nickname_get(&community_id, &fp).map_err(err)
}

// ---------- busca / histórico ----------

#[tauri::command]
fn message_search(q: forge_core::social::SearchQuery, state: State<AppState>) -> Result<Vec<forge_core::social::SearchHit>, String> {
    open_store(&state)?.message_search(&q).map_err(err)
}

#[tauri::command]
fn messages_around(conv_id: String, ts: i64, limit: i64, state: State<AppState>) -> Result<Vec<StoredMessage>, String> {
    open_store(&state)?.messages_around(&conv_id, ts, limit).map_err(err)
}

// ---------- threads ----------

#[tauri::command]
fn thread_create(
    community_id: String,
    parent_channel: String,
    name: String,
    kind: String,
    tags: String,
    state: State<AppState>,
) -> Result<forge_core::social::ThreadRow, String> {
    engine(&state)?
        .social_thread_create(&community_id, &parent_channel, &name, &kind, &tags)
        .map_err(err)
}

#[tauri::command]
fn thread_list(community_id: String, parent: String, state: State<AppState>) -> Result<Vec<forge_core::social::ThreadRow>, String> {
    open_store(&state)?.threads_list(&community_id, &parent).map_err(err)
}

#[tauri::command]
fn thread_messages(thread_id: String, limit: i64, state: State<AppState>) -> Result<Vec<StoredMessage>, String> {
    open_store(&state)?.list_messages_thread(&thread_id, limit).map_err(err)
}

#[tauri::command]
fn thread_send(community_id: String, thread_id: String, body: String, state: State<AppState>) -> Result<StoredMessage, String> {
    engine(&state)?.social_thread_send(&community_id, &thread_id, &body).map_err(err)
}

#[tauri::command]
fn thread_archive(thread_id: String, archived: bool, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_thread_archive(&thread_id, archived).map_err(err)
}

// ---------- moderação ----------

#[tauri::command]
fn member_ban(community_id: String, fp: String, until_ms: i64, reason: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_ban(&community_id, &fp, until_ms, &reason).map_err(err)
}

#[tauri::command]
fn member_unban(community_id: String, fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_unban(&community_id, &fp).map_err(err)
}

#[tauri::command]
fn member_timeout(community_id: String, fp: String, until_ms: i64, reason: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_timeout(&community_id, &fp, until_ms, &reason).map_err(err)
}

#[tauri::command]
fn ban_list(community_id: String, state: State<AppState>) -> Result<Vec<forge_core::social::BanRow>, String> {
    open_store(&state)?.ban_list(&community_id).map_err(err)
}

#[tauri::command]
fn timeout_list(community_id: String, state: State<AppState>) -> Result<Vec<forge_core::social::BanRow>, String> {
    open_store(&state)?.timeout_list(&community_id).map_err(err)
}

#[tauri::command]
fn channel_cfg_set(community_id: String, channel_id: String, slowmode_secs: i64, nsfw: bool, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_channel_cfg(&community_id, &channel_id, slowmode_secs, nsfw).map_err(err)
}

#[tauri::command]
fn channel_cfg_get(channel_id: String, state: State<AppState>) -> Result<i64, String> {
    open_store(&state)?.channel_cfg_slowmode(&channel_id).map_err(err)
}

// ---------- enquetes / eventos / emojis ----------

#[tauri::command]
fn poll_create(
    community_id: String,
    channel_id: String,
    question: String,
    options: Vec<String>,
    multi: bool,
    ends_at: i64,
    state: State<AppState>,
) -> Result<forge_core::social::PollRow, String> {
    engine(&state)?
        .social_poll_create(&community_id, &channel_id, &question, options, multi, ends_at)
        .map_err(err)
}

#[tauri::command]
fn poll_list(community_id: String, channel_id: String, state: State<AppState>) -> Result<Vec<forge_core::social::PollRow>, String> {
    open_store(&state)?.poll_list(&community_id, &channel_id).map_err(err)
}

#[tauri::command]
fn poll_vote(community_id: String, channel_id: String, poll_id: String, option_idx: i64, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_poll_vote(&community_id, &channel_id, &poll_id, option_idx).map_err(err)
}

/// (contagens, total de votos, meus votos)
#[tauri::command]
fn poll_tally(poll_id: String, state: State<AppState>) -> Result<(Vec<i64>, i64, Vec<i64>), String> {
    let store = open_store(&state)?;
    let (counts, total) = store.poll_tally(&poll_id).map_err(err)?;
    let mine = store.poll_my_votes(&poll_id, &identity_fp(&state)).map_err(err)?;
    Ok((counts, total, mine))
}

#[tauri::command]
fn event_upsert(ev: forge_core::social::EventRow, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_event_upsert(ev).map_err(err)
}

#[tauri::command]
fn event_list(community_id: String, state: State<AppState>) -> Result<Vec<forge_core::social::EventRow>, String> {
    open_store(&state)?.event_list(&community_id).map_err(err)
}

#[tauri::command]
fn event_interest(community_id: String, event_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_event_interest(&community_id, &event_id).map_err(err)
}

#[tauri::command]
fn event_delete(community_id: String, event_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_event_delete(&community_id, &event_id).map_err(err)
}

#[tauri::command]
fn emoji_upsert(e: forge_core::social::EmojiRow, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_emoji_upsert(e).map_err(err)
}

#[tauri::command]
fn emoji_list(community_id: String, state: State<AppState>) -> Result<Vec<forge_core::social::EmojiRow>, String> {
    open_store(&state)?.emoji_list(&community_id).map_err(err)
}

#[tauri::command]
fn emoji_delete(community_id: String, id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_emoji_delete(&community_id, &id).map_err(err)
}

// ---------- bookmarks ----------

#[tauri::command]
fn bookmark_set(conv_id: String, name: String, payload: String, state: State<AppState>) -> Result<(), String> {
    open_store(&state)?.bookmark_set(&conv_id, &name, &payload).map_err(err)
}

#[tauri::command]
fn bookmark_list(conv_id: String, state: State<AppState>) -> Result<Vec<(String, String)>, String> {
    open_store(&state)?.bookmark_list(&conv_id).map_err(err)
}

/// Fingerprint da identidade carregada (usado para "minhas" reações/votos).
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


// ---------------- keyring genérico (reservado para backups futuros) ----------------

/// Chaves reservadas do sistema — a generic API NUNCA as toca
/// (secure_load("identity.secret") devolveria a chave privada à WebView).
fn is_reserved_key(key: &str) -> bool {
    key == "identity.secret" || key == "identity.secret.backup" || key.is_empty() || key.len() > 128
}

#[tauri::command]
fn secure_store(key: String, value: String) -> Result<(), String> {
    if is_reserved_key(&key) {
        return Err("chave reservada do sistema".into());
    }
    let entry = keyring::Entry::new("forge-app", &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secure_load(key: String) -> Result<Option<String>, String> {
    if is_reserved_key(&key) {
        return Err("chave reservada do sistema".into());
    }
    let entry = keyring::Entry::new("forge-app", &key).map_err(|e| e.to_string())?;
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
) -> Result<forge_core::storage::Conversation, String> {
    engine(&state)?.create_group(&title, members).map_err(err)
}

#[tauri::command]
fn group_members(conv_id: String, state: State<AppState>) -> Result<Vec<(String, String)>, String> {
    Ok(engine(&state)?.group_members(&conv_id))
}

#[tauri::command]
fn group_add(conv_id: String, fp: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.group_add(&conv_id, &fp).map_err(err)
}

#[tauri::command]
async fn call_invite(
    target_fp: String,
    kind: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // `call_invite` negocia mídia nativa (offer/ICE) e pode levar segundos:
    // fora da main thread, senão a UI congela em "Chamando...".
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
    // Absorve a offer/ICE retidos no pré-aceite (ver net/voice_gate.rs).
    e2.resume_held_call(&call_id, &from_fp).await;
    Ok(())
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
            forge_core::protocol::SecureFrame::CallOffer { call_id, sdp },
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
            forge_core::protocol::SecureFrame::CallAnswer { call_id, sdp },
        )
        .map_err(err)
}

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
            forge_core::protocol::SecureFrame::CallIce {
                call_id,
                candidate,
                mid,
            },
        )
        .map_err(err)
}

/// v6 — grupo (mesh): notifica peer sobre novo participante; kind não-vazio toca no receptor.
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

// ---------------- voz nativa (webrtc-rs + cpal + Opus) ----------------
//
// São LEITURA/controle. A negociação (offer/answer/ICE) acontece dentro do
// motor, em Rust — a WebView não vê nada disso e não cria
// `RTCPeerConnection` para chamadas que o core conduz. Estas funções só
// perguntam se a camada existe e exponem mute/hangup/estatísticas.
//
// `voice_media_available` devolve `false` quando não há mídia nativa (build
// sem ela, plataforma diferente de Linux, ou `FORGE_NO_NATIVE_VOICE=1`). Nesse
// caso a UI deve seguir 100% pelo WebRTC do navegador, como sempre.

#[cfg(target_os = "linux")]
#[tauri::command]
fn voice_media_available(state: State<AppState>) -> Result<bool, String> {
    // Sem motor (cofre trancado): capacidade do build — o JS re-checa a cada
    // chamada, então o botão não mente depois do desbloqueio. Com motor: só
    // a verdade VIVA. Antes respondia `true` com a mídia morta (falhou no
    // boot), a UI confiava e toda chamada nascia sem offer nenhum.
    match state
        .engine
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        Some(e) => Ok(e.voice_media_available()),
        None => Ok(forge_core::net::engine::native_voice_capable()),
    }
}

/// `null` quando a chamada não é nativa (ou não há mídia nativa): nesse caso a
/// UI usa o relatório de `RTCPeerConnection` do navegador, como sempre.
/// `Value` em vez de `Option<..>` porque o Tauri IPC não serializa `Option`
/// no topo da resposta.
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
fn voice_set_deafened(call_id: String, deafened: bool, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.voice_set_deafened(&call_id, deafened);
    Ok(())
}

// Fora do Linux a camada nativa NÃO EXISTE (webrtc-rs/cpal/libopus nem entram
// no build — ver forge-core/Cargo.toml). Estes stubs respondem exatamente o que
// o Linux responderia com a camada desligada, então a UI não tem nenhum caminho
// novo para aprender e o WebRTC do navegador permanece intocado.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_media_available(_state: State<AppState>) -> Result<bool, String> {
    Ok(false)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_media_stats(_call_id: String, _state: State<AppState>) -> Result<serde_json::Value, String> {
    Ok(serde_json::Value::Null)
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_set_muted(_call_id: String, _muted: bool, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_hangup(_call_id: String, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "linux"))]
#[tauri::command]
fn voice_set_deafened(_call_id: String, _deafened: bool, _state: State<AppState>) -> Result<(), String> {
    Ok(())
}

/// Indicador "digitando…" — o frame Typing existia no protocolo e o engine
/// já o emitia, mas NÃO havia comando: o frontend invocava `send_typing` e o
/// catch engolia o erro para sempre (indicador morto no app nativo).
#[tauri::command]
fn send_typing(conv_id: String, state: State<AppState>) -> Result<(), String> {
    engine(&state)?.social_typing(&conv_id).map_err(err)
}

/// v6 — sinal dedicado de TELA (estado on/off via campo sdp em JSON).
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
            forge_core::protocol::SecureFrame::ScreenShareOffer { call_id, sdp },
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
            forge_core::protocol::SecureFrame::ScreenShareAnswer { call_id, sdp },
        )
        .map_err(err)
}

#[tauri::command]
fn voice_join(
    community_id: String,
    channel_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .voice_join(&community_id, &channel_id)
        .map_err(err)
}

#[tauri::command]
fn voice_leave(
    community_id: String,
    channel_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    engine(&state)?
        .voice_leave(&community_id, &channel_id)
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
    // O frontend sempre envia base64 (ver fileSwarm.download) — decodifica base64
    // PRIMEIRO. Antes era hex primeiro: um base64 que por acaso só contivesse
    // [0-9a-f] decodificava como hex e corrompia o arquivo salvo.
    // teto anti-OOM: o swarm capa arquivos em 200MB (~272MB em base64);
    // sem teto, um peer malicioso manda 1GB e o decode derruba o app
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
    // SEGURANÇA DE MÍDIA: o nome/extensão vem de PEER remoto — valida o tipo
    // REAL por magic bytes e limpa metadados de imagens (GPS/câmera/EXIF).
    let safety = open_store(&state)
        .map(|s| media_safety_read(&s))
        .unwrap_or(MediaSafetyView {
            strip_exif: true,
            block_executables: true,
        });
    let sniffed = forge_core::media::sniff_mime(&bytes);
    if sniffed.is_executable() && safety.block_executables {
        return Err(format!(
            "save_file bloqueou: executável recebido por P2P (tipo real: {}) — risco de malware. Se você confia na origem, desligue o bloqueio em Configurações → Cofre & Backup → Mídia e baixe de novo.",
            sniffed.as_str()
        ));
    }
    if forge_core::media::extension_is_blocked(&name) && safety.block_executables {
        return Err("save_file bloqueou: extensão de executável/script recebida por P2P — risco de malware. Desligue o bloqueio em Configurações → Cofre & Backup → Mídia se tiver certeza.".into());
    }
    let bytes = if safety.strip_exif {
        match forge_core::media::strip_metadata(&bytes) {
            Ok(clean) => clean,
            Err(e) => {
                tracing::warn!("save_file: imagem com metadados intactos (strip falhou: {e}) — salvando original");
                bytes
            }
        }
    } else {
        bytes
    };
    // SANITIZAÇÃO ANTI-TRAVERSAL: o nome pode vir de PEER remoto (FileAnnounce)
    // e o download é automático ao completar o swarm — sem isso,
    // name="../../.ssh/authorized_keys" escreveria fora de Downloads.
    // Aceita apenas o basename literal, sem separadores, "..", ou nome oculto.
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
    // CAUSA Android (antes: `dirs::download_dir().or(home)` direto):
    // o crate `dirs` não mapeia Downloads no Android — `download_dir()` retorna
    // None (sem XDG/user-dirs) e `home_dir()` aponta para área interna
    // (/data/data/…) sem acesso ao Downloads compartilhado; somado ao fallback
    // anchor-blob do frontend (que o WebView Android não dispara), o resultado
    // era "não dá pra baixar" sem dizer onde travou.
    let _ = &app; // evita "unused" em desktop (usado só no ramo Android)
    let downloads = {
        #[cfg(target_os = "android")]
        {
            // Scoped storage (Android 10+): gravar direto em
            // /storage/emulated/0/Download é NEGADO. Grava na área do app
            // (sempre gravável) e o frontend chama `navigator.share` (intent)
            // pra salvar onde o usuário quiser. Antes o write falhava aqui.
            let base = app
                .path()
                .app_data_dir()
                .or_else(|_| app.path().app_local_data_dir())
                .map_err(|e| format!("save_file: pasta do app indisponível: {e}"))?;
            base.join("Download")
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
    // ESCRITA ATÔMICA (v6): grava em .tmp e renomeia no fim — um crash/app
    // morto no meio do write NÃO deixa um arquivo corrompido com nome final
    // (o usuário veria "foto.png" quebrada). O tmp morre junto em falha.
    let tmp = path.with_extension("forge-part");
    if let Err(e) = fs::write(&tmp, &bytes) {
        // limpa possível tmp de tentativa anterior antes de reportar
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

// ---------------------------------------------------------------------------
// Escrita em LOTES (streaming) — o gargalo de arquivo grande.
//
// `save_file` recebe o arquivo INTEIRO em base64 numa unica chamada. O pico de
// memoria era ~8.7x o tamanho do arquivo: Uint8Array montado (1x) + arrayBuffer
// (1x) + string base64 (1.33x) + JSON do IPC (1.33x) + Vec decodificado no Rust
// (1x), com as copias anteriores ainda vivas. Em 200 MB sao ~1.7 GB; o renderer
// do WebView morre e o item fica preso em "verifying".
//
// `save_file_stream` recebe o mesmo arquivo em N pedacos: o frontend mantem no
// maximo um lote em memoria (16 chunks = 4 MB) e o Rust、追加 no .tmp que ja
// existia. O pico cai para ~1.15x e o teto deixa de ser o gargalo.
// ---------------------------------------------------------------------------

/// Acumula lotes de um arquivo ate fechar o download.
///
/// Chame com `data_b64` por pedaco e `flush: false`; o ultimo lote traz
/// `flush: true`. A primeira chamada cria o .tmp, o `job_id` devolve o caminho
/// temporario e as seguintes reabrem esse mesmo arquivo em append. `flush: true`
/// faz rename atomico e devolve o caminho final.
///
/// Se o app morrer no meio, sobra um `.forge-part` (mesmo comportamento de antes,
/// que ja gravava em .tmp) — nunca um arquivo corrompido com nome final.
#[tauri::command]
fn save_file_stream(
    app: AppHandle,
    job_id: String,
    name: String,
    data_b64: String,
    flush: bool,
    total_bytes: u64,
) -> Result<String, String> {
    use std::fs::{self, OpenOptions};
    use std::io::Write;
    use base64::{engine::general_purpose, Engine as _};

    // Sanitização anti-traversal ANTES de qualquer escrita (mesma regra do
    // save_file: o nome vem de peer remoto).
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

    let bytes = general_purpose::STANDARD
        .decode(&data_b64)
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(&data_b64))
        .map_err(|e| format!("save_file_stream travou em decode base64: {e}"))?;

    // Teto anti-OOM por LOTE e por TOTAL. Sem teto, um peer malicioso manda
    // um lote de 4 GB e o decode derruba o processo.
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("save_file_stream: lote acima de 32 MB".into());
    }
    if total_bytes > MAX_STREAM_FILE_BYTES {
        return Err(format!(
            "arquivo grande demais para salvar (máx {})",
            crate::fmt_mb(MAX_STREAM_FILE_BYTES)
        ));
    }

    let _ = &app;
    let downloads = {
        #[cfg(target_os = "android")]
        {
            let base = app
                .path()
                .app_data_dir()
                .or_else(|_| app.path().app_local_data_dir())
                .map_err(|e| format!("save_file_stream: pasta do app indisponível: {e}"))?;
            base.join("Download")
        }
        #[cfg(not(target_os = "android"))]
        {
            resolve_downloads_dir()?
        }
    };
    fs::create_dir_all(&downloads)
        .map_err(|e| format!("save_file_stream travou em mkdir: {e}"))?;

    let tmp = downloads.join(format!(".{safe}.{job_id}.forge-part"));

    if flush {
        if let Err(e) = fs::rename(&tmp, &unique_download_path(&downloads, &safe)) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("save_file_stream travou em rename: {e}"));
        }
        return Ok(safe);
    }

    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&tmp)
        .map_err(|e| format!("save_file_stream travou em open {}: {e}", tmp.display()))?;
    f.write_all(&bytes)
        .map_err(|e| format!("save_file_stream travou em write: {e}"))?;
    f.sync_all().ok();
    Ok(tmp.to_string_lossy().to_string())
}

/// Teto do fluxo em lotes. Espelha a validacao do frontend (VITE_FORGE_MAX_FILE_MB,
/// default 2 GB) — este e' o que impede um peer de nos fazer preencher o disco.
const MAX_STREAM_FILE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// Formata bytes como "X MB"/"X GB" para as mensagens de erro.
pub(crate) fn fmt_mb(b: u64) -> String {
    const MB: u64 = 1024 * 1024;
    if b >= 1024 * MB {
        format!("{} GB", b / (1024 * MB))
    } else {
        format!("{} MB", b / MB)
    }
}

/// Resolve a pasta Downloads do DESKTOP com estágios honestos.
/// Ordem: dirs::download_dir() → ~/Download(s) via home_dir() → erro dizendo
/// exatamente o que faltou.
///
/// Não é compilado no Android: lá o `save_file` escreve na área privada e o
/// `DownloadsPlugin` (Kotlin/MediaStore) faz a cópia para o Downloads público —
/// os candidatos `/storage/emulated/0/Download` abaixo do scoped storage
/// (API 29+) seriam negados na escrita de qualquer jeito.
#[cfg(not(target_os = "android"))]
fn resolve_downloads_dir() -> Result<PathBuf, String> {
    if let Some(d) = dirs::download_dir() {
        return Ok(d);
    }
    if let Some(h) = dirs::home_dir() {
        // Desktop sem XDG: tenta ~/Download antes de desistir.
        let dl = h.join("Download");
        let dls = h.join("Downloads");
        if dl.exists() {
            return Ok(dl);
        }
        if dls.exists() {
            return Ok(dls);
        }
        // Último recurso honesto: home existe mas sem pasta Downloads —
        // usa ~/Download (será criada) em vez de espalhar na home.
        if h.exists() {
            return Ok(dl);
        }
    }
    Err(
        "save_file travou em resolve_dir: diretório de Downloads não encontrado (download_dir=None e sem ~/Download)".to_string(),
    )
}

/// Nome único em Downloads: `foto.png` → `foto (1).png`… evita sobrescrever
/// o arquivo anterior quando o mesmo nome chega duas vezes do swarm.
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
fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// ---------------- cofre portátil .stormvault (conta inteira, sem servidor) ----------------

#[derive(Debug, Serialize)]
struct StormVaultExportView {
    path: String,
    bytes: u64,
    header: forge_core::stormvault::StormVaultHeader,
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

/// Segredo para export/backup: engine desbloqueado (RAM) > fallback
/// keyring/plain (contas sem senha). Cofre trancado sem engine = recusa honesta.
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

/// Exporta a conta INTEIRA (identidade + histórico + contatos + comunidades)
/// para um arquivo `.stormvault` cifrado em Downloads. A senha protege tudo
/// com Argon2id — o provedor de nuvem/pen drive nunca lê o conteúdo.
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
    let data = forge_core::stormvault::collect(&store, secret, max).map_err(err)?;
    let sealed = forge_core::stormvault::seal_with_password(&data, &password).map_err(err)?;
    let header = forge_core::stormvault::read_header(&sealed).map_err(err)?;

    let base = export_base_dir(&app)?;
    std::fs::create_dir_all(&base)
        .map_err(|e| format!("não consegui criar a pasta de export: {e}"))?;
    let fname = format!(
        "distorrent-cofre-{}-{}.stormvault",
        identity.fingerprint,
        forge_core::identity::now_ms()
    );
    let path = unique_download_path(&base, &fname);
    // Escrita atômica: tmp + rename — crash no meio não deixa cofre
    // corrompido com o nome final (igual save_file).
    let tmp = path.with_extension("stormvault-part");
    if let Err(e) = std::fs::write(&tmp, &sealed) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("falha ao gravar o cofre: {e}"));
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("falha ao gravar o cofre: {e}"));
    }
    forge_core::metrics::metrics().vault_op();
    // zera a senha da memória asim que possível (best-effort; String não é zeroizável)
    drop(password);
    Ok(StormVaultExportView {
        path: path.to_string_lossy().to_string(),
        bytes: sealed.len() as u64,
        header,
    })
}

/// Pasta de export: Android usa a área do app (scoped storage), desktop usa Downloads.
fn export_base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        let base = app
            .path()
            .app_data_dir()
            .or_else(|_| app.path().app_local_data_dir())
            .map_err(|e| format!("pasta do app indisponível: {e}"))?;
        Ok(base.join("Download"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        resolve_downloads_dir()
    }
}

/// Importa um `.stormvault`: instala a identidade em device limpo (a senha do
/// arquivo vira a senha do cofre local) ou mescla dados na mesma conta.
/// Conta diferente = recusa (use multi-conta).
///
/// Terceiro caminho de autenticação por senha, e o mais perigoso dos três:
/// o usuário digita a senha de um ARQUIVO, e o arquivo pode vir de qualquer
/// lugar. Sem o mesmo orçamento, este comando seria um caminho completo para
/// testar senhas sem limite.
#[tauri::command]
async fn stormvault_import(
    content_b64: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<forge_core::stormvault::ImportReport, String> {
    use base64::{engine::general_purpose, Engine as _};
    let bytes = general_purpose::STANDARD
        .decode(content_b64.trim())
        .map_err(|e| format!("arquivo inválido (base64): {e}"))?;
    if bytes.len() > 512 * 1024 * 1024 {
        return Err("arquivo grande demais (máx 512MB)".into());
    }
    let store = open_store(&state)?;

    // A chave inclui o fingerprint do ARQUIVO (via `import_with_password`), e
    // não o da conta local: assim, tentar o mesmo arquivo 3 vezes bloqueia, e
    // trocar de arquivo dá um balde novo — sem virar uma brecha trivial, porque
    // o orçamento por conta continua valendo nos outros dois caminhos.
    let key = auth_key(&store, "stormvault");
    auth_guard(&state, &key)?;

    if store.load_identity().is_some() {
        // merge numa conta existente: exige desbloqueio (a senha do cofre
        // local continua valendo — o arquivo sozinho não injeta nada)
        engine(&state)?;
    }
    let report =
        match forge_core::stormvault::import_with_password(&store, &bytes, &password) {
            Ok(r) => r,
            Err(e) => return Err(auth_fail(&state, &key, &e.to_string())),
        };
    auth_ok(&state, &key);
    forge_core::metrics::metrics().vault_op();
    drop(password);
    Ok(report)
}

fn list_backup_files(state: &State<AppState>) -> Result<Vec<BackupView>, String> {
    Ok(
        forge_core::stormvault::list_backup_files(&backups_dir(state))
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

/// Cria um snapshot cifrado AGORA (exige app desbloqueado — a chave do backup
/// deriva da identidade em RAM, sem senha digitada).
#[tauri::command]
async fn stormvault_backup_now(state: State<'_, AppState>) -> Result<BackupView, String> {
    let eng = engine(&state)?;
    let secret = eng.secret_hex();
    let store = open_store(&state)?;
    let data = forge_core::stormvault::collect(&store, Some(secret.clone()), None).map_err(err)?;
    let key = forge_core::stormvault::backup_key_for(&secret);
    let sealed = forge_core::stormvault::seal_with_key(&data, &key).map_err(err)?;
    let dir = backups_dir(&state);
    std::fs::create_dir_all(&dir).map_err(|e| format!("pasta de backups: {e}"))?;
    let now = forge_core::identity::now_ms();
    let file = forge_core::stormvault::backup_file_name(now);
    std::fs::write(dir.join(&file), &sealed).map_err(|e| format!("gravar backup: {e}"))?;
    forge_core::metrics::metrics().vault_op();
    prune_backups(&state).map_err(err)?;
    Ok(BackupView {
        file,
        created_ms: now,
        bytes: sealed.len() as u64,
    })
}

/// Restaura um snapshot (mescla — nada atual é perdido). Exige desbloqueado.
#[tauri::command]
async fn stormvault_backup_restore(
    file: String,
    state: State<'_, AppState>,
) -> Result<forge_core::stormvault::ImportReport, String> {
    // sanitiza: basename exato, sem traversal, só o padrão de backup
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
    let key = forge_core::stormvault::backup_key_for(&eng.secret_hex());
    let data = forge_core::stormvault::open_with_key(&bytes, &key)
        .map_err(|e| format!("não abriu como backup automático ({e}) — use Importar com senha"))?;
    if data.identity.fingerprint != eng.identity().fingerprint {
        return Err("backup de outra conta — restaure na conta certa".into());
    }
    let store = open_store(&state)?;
    let report = forge_core::stormvault::import_merge_only(&store, &data).map_err(err)?;
    forge_core::metrics::metrics().vault_op();
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

/// Apaga backups além da retenção (lógica no core — testável).
fn prune_backups(state: &State<AppState>) -> Result<usize, String> {
    let store = open_store(state)?;
    forge_core::stormvault::prune_backup_files(
        &backups_dir(state),
        backup_retention_days(&store),
        forge_core::identity::now_ms(),
    )
    .map_err(err)
}

/// MODO PÂNICO: apaga identidade, mensagens, contatos, backups e cache DESTE
/// dispositivo imediatamente. Exige digitar APAGAR. Sem desfazer — um
/// .stormvault guardado fora continua válido para restaurar depois.
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
    if let Ok(entry) = keyring::Entry::new("forge-app", "identity.secret") {
        let _ = entry.delete_password();
    }
    for f in ["forge.db", "forge.db-wal", "forge.db-shm"] {
        let _ = std::fs::remove_file(state.data_dir.join(f));
    }
    let _ = std::fs::remove_dir_all(backups_dir(&state));
    let _ = std::fs::remove_dir_all(state.data_dir.join("cache"));
    let _ = state.cache.clear();
    // .stormvault exportados ficam em Downloads (fora do app_data) — o wipe
    // não apaga arquivo do usuário sem aviso: devolve a lista p/ a UI
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
    /// .stormvault exportados que SOBREVIVEM em Downloads (o wipe não apaga
    /// arquivo do usuário sozinho — a UI orienta a apagar manualmente).
    leftovers: Vec<String>,
}

// ---------------- observabilidade (painel dev) ----------------

/// Snapshot de métricas do motor (só contagens/latências — nada sensível).
#[tauri::command]
fn metrics_snapshot() -> serde_json::Value {
    forge_core::metrics::metrics().snapshot()
}

/// RTT estimado (EMA, ms) de um peer — None se ainda sem amostra Ping/Pong.
#[tauri::command]
fn peer_rtt(fp: String, state: State<AppState>) -> Result<Option<u64>, String> {
    Ok(engine(&state)?.peer_rtt_ms(fp.trim()))
}

// ---------------- mensagens: janela (paginação) ----------------

/// Janela de mensagens por timestamp (o caminho da UI — `messages_list`
/// continua existindo para compat). `before_ts=None` = as mais recentes.
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

// ---------------- cache LRU de disco ----------------

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
            forge_core::metrics::metrics().cache_hit();
            Ok(Some(general_purpose::STANDARD.encode(&bytes)))
        }
        None => {
            forge_core::metrics::metrics().cache_miss();
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

// ---------------- segurança de mídia ----------------

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

fn log_filter() -> tracing_subscriber::EnvFilter {
    tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,forge_core=info"))
}

fn main() {
    // Logs estruturados (JSON, 1 evento por linha) com FORGE_LOG_JSON=1 —
    // para coleta em arquivo/SIEM. Nunca logar chaves, senhas ou conteúdo
    // de mensagens (revisar qualquer novo `tracing::` antes de mergear).
    if std::env::var("FORGE_LOG_JSON").as_deref() == Ok("1") {
        tracing_subscriber::fmt()
            .json()
            .with_env_filter(log_filter())
            .init();
    } else {
        tracing_subscriber::fmt()
            .with_env_filter(log_filter())
            .init();
    }

    tauri::Builder::default()
        .plugin(downloads_plugin())
        .invoke_handler(tauri::generate_handler![
            get_app_version,
            identity_get,
            identity_create,
            identity_rename,
            vault_status,
            vault_unlock,
            vault_change,
            local_addresses,
            communities_list,
            create_community,
            make_invite,
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
            secure_store,
            secure_load,
            privacy_get,
            privacy_set,
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
            group_add,
            call_invite,
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
            // ---- camada social (paridade Discord) ----
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
            nickname_set,
            nickname_get,
            message_search,
            messages_around,
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
        ])
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            std::fs::create_dir_all(&dir).ok();
            tracing::info!(?dir, "FORGE iniciando");
            // cache LRU de disco (avatares/thumbnails/spool de chunks) — teto
            // persistido em kv, padrão 256MB
            let cap_mb: u64 = Store::open(&dir.join("forge.db"))
                .ok()
                .and_then(|s| s.kv_get("cache.cap_mb"))
                .and_then(|v| v.parse().ok())
                .unwrap_or(256)
                .clamp(16, 4096);
            let cache =
                forge_core::cache::DiskLru::open(dir.join("cache"), Some(cap_mb * 1024 * 1024))
                    .map_err(|e| format!("cache: {e}"))?;
            app.manage(AppState {
                engine: Mutex::new(None),
                data_dir: dir,
                unlocked: Mutex::new(false),
                cache,
                // 3 tentativas em 15 min, bloqueio de 60s dobrando a cada
                // reincidência. Ver `forge-core/src/authlimit.rs`.
                auth_limit: forge_core::authlimit::AuthLimiter::new(),
            });
            // Liga o WebRTC no WebKitGTK (Linux). TEM que estar NESTE closure:
            // um segundo `.setup()` SOBRESCREVE o anterior no Tauri, e aí o
            // `AppState` nunca é registrado — o app abre mas TODO comando que
            // pega `State<AppState>` morre com "state not managed for field
            // `state`" (foi o que aconteceu na primeira tentativa).
            enable_webrtc(app.handle());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao rodar forge");
}

/// LIGA O WEBRTC NO WEBCOMPATÍVEL DO LINUX.
///
/// BUG que isto corrige: dentro do app desktop, `typeof RTCPeerConnection`
/// era `undefined` — a chamada morria com "falta WebRTC (RTCPeerConnection
/// ausente)" e o app culpava o WebView do sistema, que estava atualizado o
/// tempo todo.
///
/// Causa: no WebKitGTK o WebRTC EXISTE (o símbolo `webkit_settings_set_enable_webrtc`
/// está na lib, e o `RTCPeerConnection` está no binário) mas vem **desligado por
/// padrão**. O wry liga `enable_webgl`, `enable_webaudio` e `enable_canvas`
/// sozinho, e simplesmente esqueceu o `enable_webrtc` — não há nenhuma opção de
/// configuração na CLI nem no `tauri.conf.json` para isso.
///
/// Aqui ligamos direto no `WebKitSettings` da webview, pela trait pública
/// `WebViewExt` do `webkit2gtk` (mesma versão 2.0.2 que o wry usa, senão o
/// trait não se aplica ao tipo dele).
#[cfg(any(target_os = "linux", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd"))]
fn enable_webrtc(app: &tauri::AppHandle) {
    use tauri::Manager;
    use webkit2gtk::{SettingsExt, WebViewExt};
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let _ = win.with_webview(move |wv| {
        // `PlatformWebview` é wrapper; no Linux o `inner()` devolve o
        // `webkit2gtk::WebView` (type alias direto, sem cast).
        let inner = wv.inner();
        match inner.settings() {
            Some(settings) => {
                settings.set_enable_webrtc(true);
                eprintln!("[forge] WebKitGTK: enable_webrtc = LIGADO");
            }
            None => eprintln!("[forge] WebKitGTK: settings() = None — WebRTC NÃO ligado"),
        }
    });

}

/// No Android o WebRTC já vem ligado no WebView (é o Chromium de fábrica) e no
/// macOS/Windows o WebView do sistema já expõe WebRTC. Nada a fazer.
#[cfg(not(any(target_os = "linux", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd")))]
fn enable_webrtc(_app: &tauri::AppHandle) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run_mobile() {
    // Android: DHT mainline BitTorrent LIGADA (paridade com desktop).
    // Sem isto o celular nunca anuncia/faz lookup na rede BitTorrent.
    std::env::set_var("FORGE_DHT", "1");
    main();
}

/// Entrada desktop — main.rs chama isto. Mesma app do mobile, sem duplicação.
pub fn run() {
    // PRODUÇÃO: liga a DHT mainline BitTorrent (descoberta descentralizada).
    // Testes não setam → engines de teste ficam isolados da rede BitTorrent.
    std::env::set_var("FORGE_DHT", "1");
    main();
}
