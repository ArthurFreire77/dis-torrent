use std::path::PathBuf;
use std::sync::Arc;

#[path = "updater_apply.rs"]
pub mod updater_apply;
#[path = "updater_checks.rs"]
pub mod updater_checks;
#[path = "updater_download.rs"]
pub mod updater_download;
#[path = "updater_version.rs"]
pub mod updater_version;

use updater_apply::verify_before_apply;
use updater_download::pick_manifest_asset;

use serde::{Deserialize, Serialize};
use tauri::Emitter as _;

use distorrent_core::net::release_trust::StoreKv;
use distorrent_core::release::{
    self, ManifestAsset, ReleaseStatus, ReleaseTrust, SignedManifest, VerifiedManifest,
};
use distorrent_core::storage::Store;

const RELEASES_API: &str =
    "https://api.github.com/repos/ArthurFreire77/dis-torrent/releases?per_page=20";
/// Documental e usado pelos testes; o download real usa a URL do manifesto
/// verificado, nunca esta constante.
#[allow(dead_code)]
const DOWNLOAD_PREFIX: &str = "https://github.com/ArthurFreire77/dis-torrent/releases/download/";
const RELEASES_PAGE_CAP: usize = 20;
/// Quantas releases o cliente examina procurando um manifesto verificável.
/// Baixo de propósito: cada candidata é um download a mais no GitHub.
const MANIFEST_PROBES: usize = 3;
const MANIFEST_ASSET: &str = "distorrent-manifest.bin";
pub const KV_PENDING: &str = "release.update_pending";
pub const KV_ETAG: &str = "update.releases_etag";
pub const KV_LAST_CHECK: &str = "update.last_check_ms";
pub const KV_BACKOFF: &str = "update.backoff_ms";
const MIN_CHECK_INTERVAL_MS: i64 = 30 * 60 * 1000;
const MAX_MANIFEST_DOWNLOAD: u64 = 128 * 1024;
const MAX_INSTALLER_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub asset_name: String,
    pub asset_size: u64,
    pub download_url: String,
    pub digest: String,
    pub notes: String,
    pub html_url: String,
    pub platform: String,
    pub label_mismatch: bool,
    pub asset_version: String,
    /// Campos novos: procedência comprovada por 2-de-3.
    pub verified: bool,
    pub manifest_hash: String,
    pub security_epoch: u64,
    pub valid_signatures: u8,
    pub trust_epoch: u64,
    pub commit: String,
    pub channel: String,
    pub self_integrity: String,
    pub verification_available: bool,
    pub verification_note: String,
}

/// Registro do que foi baixado e verificado. É a ÚNICA fonte de verdade para
/// `update_apply`; a UI não consegue inventar hash nem caminho.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingUpdate {
    pub asset_name: String,
    pub sha256: String,
    pub size: u64,
    pub version: String,
    pub manifest_hash: String,
    pub security_epoch: u64,
    pub path: String,
}

fn version_in_asset_name(name: &str) -> String {
    let mut core = String::new();
    let mut digits = 0usize;
    let mut dots = 0usize;
    let mut started = false;
    for c in name.chars() {
        if c.is_ascii_digit() {
            started = true;
            core.push(c);
            digits += 1;
        } else if c == '.' && started {
            core.push(c);
            dots += 1;
        } else if started {
            break;
        }
    }
    let core = core.trim_end_matches('.').to_string();
    if dots >= 2 && digits >= 3 {
        core
    } else {
        String::new()
    }
}

fn platform_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(any(target_os = "linux", target_os = "freebsd")) {
        "linux"
    } else {
        "outro"
    }
}

fn arch_tag() -> &'static str {
    if cfg!(target_arch = "x86_64") {
        "x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else if cfg!(target_arch = "x86") {
        "x86"
    } else {
        "outro"
    }
}

fn accepted_ext(platform: &str) -> &'static [&'static str] {
    match platform {
        "windows" => &[".exe"],
        "linux" => &[".appimage", ".deb"],
        "android" => &[".apk"],
        _ => &[],
    }
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct GhAsset {
    name: String,
    size: u64,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
pub(crate) struct GhRelease {
    tag_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("DisTorrent/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("cliente HTTP: {e}"))
}

/// Hosts que podem servir artefato. Tudo HTTPS; nada de IP literal, nada de
/// host parecido (`github.com.evil`), nada de outro repositório.
const ALLOWED_HOSTS: &[&str] = &[
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

fn url_allowed(raw: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(raw) else {
        return false;
    };
    if parsed.scheme() != "https" {
        return false;
    }
    let Some(host) = parsed.host_str() else {
        return false;
    };
    if !ALLOWED_HOSTS.contains(&host) {
        return false;
    }
    if parsed.username() != "" || parsed.password().is_some() {
        return false;
    }
    let path = parsed.path();
    if host == "github.com" {
        return path.starts_with("/ArthurFreire77/dis-torrent/releases/download/");
    }
    if host == "api.github.com" {
        return path.starts_with("/repos/ArthurFreire77/dis-torrent/releases");
    }
    true
}

fn open_store(app: &tauri::AppHandle) -> Result<Arc<Store>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados: {e}"))?;
    Ok(Arc::new(
        Store::open(&dir.join("distorrent.db")).map_err(|e| format!("abrir banco: {e}"))?,
    ))
}

fn load_trust(store: &Arc<Store>) -> ReleaseTrust {
    distorrent_core::net::release_trust::load(store)
}

fn release_notes(release: &GhRelease) -> String {
    if release.body.trim().is_empty() {
        release.name.clone()
    } else {
        release.body.clone()
    }
}

/// Resultado interno da checagem, antes de virar `UpdateInfo`.
pub(crate) struct Escolha {
    release: GhRelease,
    verified: VerifiedManifest,
    asset: ManifestAsset,
}

fn cache_releases(store: &Arc<Store>, releases: &[GhRelease]) {
    if let Ok(raw) = serde_json::to_string(
        &releases
            .iter()
            .map(|r| {
                serde_json::json!({
                    "tag_name": r.tag_name,
                    "name": r.name,
                    "body": r.body,
                    "html_url": r.html_url,
                    "draft": r.draft,
                    "assets": r.assets.iter().map(|a| serde_json::json!({
                        "name": a.name, "size": a.size,
                        "browser_download_url": a.browser_download_url,
                        "digest": a.digest,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>(),
    ) {
        let _ = store.kv_set("update.releases_cache", &raw);
    }
}

fn proximo_backoff(atual: i64) -> i64 {
    let base = if atual <= 0 {
        60_000
    } else {
        (atual * 2).min(60 * 60 * 1000)
    };
    // Jitter de até 20% para não sincronizar todo mundo no mesmo segundo.
    let base_u: u64 = base as u64;
    let jitter = (now_rand() % (base_u / 5).max(1)) as i64;
    base + jitter
}

fn now_rand() -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
        .hash(&mut h);
    std::process::id().hash(&mut h);
    h.finish()
}

#[tauri::command]
pub fn update_verify_ready(app: tauri::AppHandle, path: String) -> Result<PendingUpdate, String> {
    verify_before_apply(&app, &path)
}

#[tauri::command]
pub fn update_trust_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let store = open_store(&app)?;
    let trust = load_trust(&store);
    let set = trust.trust();
    Ok(serde_json::json!({
        "verification_available": trust.verification_available(),
        "unavailable_reason": trust.unavailable_reason().unwrap_or(""),
        "epoch_floor": trust.epoch_floor(),
        "trust_epoch": set.map(|s| s.epoch).unwrap_or(0),
        "threshold": set.map(|s| s.threshold).unwrap_or(0),
        "keys": set.map(|s| s.keys.iter().map(|k| serde_json::json!({
            "key_id": k.key_id,
            "pubkey_hex": k.pubkey_hex,
        })).collect::<Vec<_>>()).unwrap_or_default(),
        "revoked_versions": trust.revoked_versions(),
        "latest_verified": trust.latest_verified().map(|v| serde_json::json!({
            "version": v.manifest.body.version,
            "manifest_hash": v.manifest_hash,
            "security_epoch": v.manifest.body.security_epoch,
            "valid_signatures": v.valid_signatures,
            "trust_epoch": v.trust_epoch,
        })),
    }))
}

#[tauri::command]
pub fn peer_trust_info(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let store = open_store(&app)?;
    let policy = distorrent_core::net::release_trust::peer_policy(&store);
    Ok(serde_json::json!({
        "policy": policy.as_str(),
        "policies": ["block_unverified", "block_revoked", "warn"],
    }))
}

#[tauri::command]
pub fn peer_trust_policy_set(app: tauri::AppHandle, policy: String) -> Result<(), String> {
    let store = open_store(&app)?;
    distorrent_core::net::release_trust::set_peer_policy(&store, &policy).map_err(|e| e.to_string())
}

/// Aplica uma atualização de confiança (rotação/revogação) recebida
/// offline. Exige 2-de-3 do conjunto atual; uma chave sozinha não muda nada.
#[tauri::command]
pub fn update_trust_apply(
    app: tauri::AppHandle,
    wire_hex: String,
) -> Result<serde_json::Value, String> {
    let store = open_store(&app)?;
    let bytes =
        hex::decode(wire_hex.trim()).map_err(|_| "payload de rotação não é hex".to_string())?;
    let up = distorrent_core::release::TrustUpdate::from_wire(&bytes)
        .map_err(|e| format!("rotação inválida: {e}"))?;
    let mut trust = load_trust(&store);
    let kv = StoreKv(Arc::clone(&store));
    let new_set = trust
        .apply_rotation(&kv, &up)
        .map_err(|e| format!("rotação recusada: {e}"))?;
    let _ = app.emit(
        "distorrent://trust",
        serde_json::json!({ "epoch": new_set.epoch }),
    );
    Ok(serde_json::json!({
        "epoch": new_set.epoch,
        "threshold": new_set.threshold,
        "keys": new_set.keys.iter().map(|k| k.key_id.clone()).collect::<Vec<_>>(),
    }))
}

#[tauri::command]
pub fn open_release_page(url: String) -> Result<(), String> {
    let ok = url.starts_with("https://github.com/ArthurFreire77/dis-torrent/");
    if !ok {
        return Err("URL fora do repositório oficial recusada".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("abrir navegador: {e}"))?;
    }
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("abrir navegador: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("abrir navegador: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        let _ = url;
        return Err("no Android a atualização é pelo APK (veja o cartão de atualização)".into());
    }
    Ok(())
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let alvo = url.trim();
    if alvo.is_empty() {
        return Err("endereço vazio".into());
    }
    let minusculo = alvo.to_ascii_lowercase();
    let permitido = minusculo.starts_with("https://")
        || minusculo.starts_with("http://")
        || minusculo.starts_with("distorrent://")
        || minusculo.starts_with("mailto:");
    if !permitido {
        return Err("esquema de endereço não permitido".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt as _;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        fn wide(s: &str) -> Vec<u16> {
            std::ffi::OsStr::new(s)
                .encode_wide()
                .chain(std::iter::once(0))
                .collect()
        }
        let op = wide("open");
        let file = wide(alvo);
        // SAFETY: as duas strings são NUL-terminadas e vivem até o fim da chamada;
        // os parâmetros restantes são nulos/documentados como opcionais.
        let rc = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
        // A API devolve um inteiro <= 32 em caso de erro (não é GetLastError).
        if (rc as isize) <= 32 {
            return Err(format!("abrir endereço: código {}", rc as isize));
        }
    }
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        std::process::Command::new("xdg-open")
            .arg(alvo)
            .spawn()
            .map_err(|e| format!("abrir endereço: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(alvo)
            .spawn()
            .map_err(|e| format!("abrir endereço: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        return Err("no Android o convite entra pelo próprio app (sem navegador externo)".into());
    }
    Ok(())
}

/// Sinal de "reinicie o app": só usado no Linux (substituição do AppImage).
#[allow(dead_code)]
pub const REINICIAR_SINAL: &str = "ATUALIZADO_E_REINICIADO";
/// Android: `update_apply` validou o APK (hash + manifesto) e o JS precisa
/// chamar `plugin:updater|installApk`. O sinal só é devolvido DEPOIS da
/// verificação; o Kotlin então compara o certificado de assinatura do APK com
/// o do app instalado antes de abrir o instalador do sistema.
#[allow(dead_code)]
pub const INSTALAR_APK_SINAL: &str = "INSTALAR_APK_VALIDADO";

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn appimage_alvo() -> Option<PathBuf> {
    let bruto = std::env::var("APPIMAGE").ok()?;
    let caminho = PathBuf::from(bruto);
    if !caminho.is_file() {
        return None;
    }
    Some(caminho)
}

#[cfg(any(target_os = "linux", target_os = "freebsd"))]
fn substituir_e_reiniciar(
    baixado: &std::path::Path,
    destino: &std::path::Path,
) -> Result<bool, String> {
    use std::os::unix::fs::PermissionsExt as _;

    let temp = destino.with_file_name(format!(
        ".{}.novo-{}",
        destino
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("distorrent"),
        std::process::id()
    ));
    std::fs::copy(baixado, &temp)
        .map_err(|e| format!("não consegui preparar a atualização: {e}"))?;
    std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("não consegui marcar o AppImage como executável: {e}"))?;
    std::fs::rename(&temp, destino).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("não consegui substituir o AppImage em uso: {e}")
    })?;

    std::process::Command::new(destino)
        .arg("--atualizado")
        .spawn()
        .map_err(|e| format!("AppImage substituído, mas não consegui reabrir: {e}"))?;
    Ok(true)
}

/// Windows: instalação por usuário vs. pasta do sistema.
fn instalação_por_usuario() -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| format!("executável atual: {e}"))?;
    let alvo = std::fs::canonicalize(&exe).unwrap_or(exe);
    let s = alvo.to_string_lossy().to_ascii_lowercase();
    let sistema = [
        "\\program files\\",
        "\\program files (x86)\\",
        "\\windows\\system32\\",
    ];
    Ok(!sistema.iter().any(|p| s.contains(p)))
}

fn updates_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    #[cfg(target_os = "android")]
    {
        let base = app
            .path()
            .app_data_dir()
            .or_else(|_| app.path().app_local_data_dir())
            .map_err(|e| format!("pasta de dados: {e}"))?;
        let files_dir = match app.path().app_local_data_dir() {
            Ok(p) => p,
            Err(_) => base.clone(),
        };
        let dentro = if base.starts_with(&files_dir) {
            base
        } else {
            files_dir
        };
        return Ok(dentro.join("updates"));
    }
    #[cfg(not(target_os = "android"))]
    {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("pasta de dados: {e}"))?;
        Ok(dir.join("updates"))
    }
}

#[tauri::command]
pub fn update_auto_get(app: tauri::AppHandle) -> Result<bool, String> {
    Ok(read_kv(&app, "update.auto")?
        .map(|v| v == "1")
        .unwrap_or(true))
}

#[tauri::command]
pub fn update_auto_set(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    write_kv(&app, "update.auto", if enabled { "1" } else { "0" })
}

#[tauri::command]
pub fn update_flag_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    read_kv(&app, &key)
}

#[tauri::command]
pub fn update_flag_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    write_kv(&app, &key, &value)
}

fn read_kv(app: &tauri::AppHandle, key: &str) -> Result<Option<String>, String> {
    use tauri::Manager;
    if !key.starts_with("update.") {
        return Err("chave de atualização inválida".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados: {e}"))?;
    let store = distorrent_core::storage::Store::open(&dir.join("distorrent.db"))
        .map_err(|e| format!("abrir banco: {e}"))?;
    Ok(store.kv_get(key))
}

fn write_kv(app: &tauri::AppHandle, key: &str, value: &str) -> Result<(), String> {
    use tauri::Manager;
    if !key.starts_with("update.") {
        return Err("chave de atualização inválida".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados: {e}"))?;
    let store = distorrent_core::storage::Store::open(&dir.join("distorrent.db"))
        .map_err(|e| format!("abrir banco: {e}"))?;
    store.kv_set(key, value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_cleanup(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = updates_dir(&app)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(0);
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        if entry.path().is_file() && std::fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::updater::updater_version::compare_version_strings;

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.to_string(),
            size: 1,
            browser_download_url: format!("{DOWNLOAD_PREFIX}v1.0.0/{name}"),
            digest: None,
        }
    }

    fn manifest_asset(name: &str, os: &str, arch: &str) -> ManifestAsset {
        ManifestAsset {
            name: name.to_string(),
            os: os.to_string(),
            arch: arch.to_string(),
            size: 1000,
            sha256: "a".repeat(64),
            url: format!("{DOWNLOAD_PREFIX}v1.2.3/{name}"),
        }
    }

    #[test]
    fn tag_limpa_casa_com_manifesto_com_sufixo() {
        // O bug que impediu TODO auto-update: manifesto `1.1.65-pre-alpha`
        // comparado por igualdade com a tag `v1.1.65` nunca batia, e a release
        // era recusada como "divergência de versão".
        use updater_version::mesma_versao;
        assert!(mesma_versao("1.1.65-pre-alpha", "v1.1.65"));
        assert!(mesma_versao("1.1.65-pre-alpha", "1.1.65"));
        assert!(mesma_versao("1.1.65", "v1.1.65"));
        assert!(mesma_versao("v1.1.65", "v1.1.65"));
        assert!(mesma_versao("1.1.65-alpha", "v1.1.65"));
        // Versões diferentes continuam sendo divergência.
        assert!(!mesma_versao("1.1.64-pre-alpha", "v1.1.65"));
        assert!(!mesma_versao("1.1.6", "v1.1.65"));
        assert!(!mesma_versao("", "v1.1.65"));
        assert!(!mesma_versao("1.1.65", ""));
    }

    #[test]
    fn versao_maior_ganha_da_ordem_da_api() {
        use std::cmp::Ordering;
        assert_eq!(compare_version_strings("v1.1.9", "1.1.10"), Ordering::Less);
        assert_eq!(
            compare_version_strings("1.1.10", "v1.1.9"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("v1.1.23", "1.1.22"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("1.1.23-pre-alpha", "1.1.22-pre-alpha"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("1.2.0", "1.2.0-pre-alpha"),
            Ordering::Equal
        );
        assert_eq!(compare_version_strings("2.0", "1.9.99"), Ordering::Greater);
        assert_eq!(
            compare_version_strings("1.1.10a", "1.1.10"),
            Ordering::Equal
        );
    }

    #[test]
    fn sufixos_tem_ordem_e_base_nova_sempre_ganha() {
        use std::cmp::Ordering;
        assert_eq!(
            compare_version_strings("1.2.1-alpha", "1.2.1-pre-alpha"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("1.2.1-beta", "1.2.1-alpha"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("1.2.1-rc", "1.2.1-beta"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("1.2.1-pre-alpha", "1.2.1-alpha"),
            Ordering::Less
        );
        assert_eq!(
            compare_version_strings("1.2.1-pre-alpha", "1.2.0"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("1.2.1-alpha.10", "1.2.1-alpha.2"),
            Ordering::Greater
        );
    }

    #[test]
    fn http_puro_http_e_host_parecido_sao_recusados() {
        assert!(url_allowed(
            "https://github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/x.exe"
        ));
        assert!(!url_allowed(
            "http://github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/x.exe"
        ));
        assert!(!url_allowed(
            "https://github.com.evil.example/ArthurFreire77/dis-torrent/releases/download/v1.2.3/x.exe"
        ));
        assert!(!url_allowed(
            "https://evil.example/ArthurFreire77/dis-torrent/releases/download/v1.2.3/x.exe"
        ));
        // outro repositório não é o oficial
        assert!(!url_allowed(
            "https://github.com/outro/repo/releases/download/v1.2.3/x.exe"
        ));
        // credenciais embutidas
        assert!(!url_allowed(
            "https://user:pass@github.com/ArthurFreire77/dis-torrent/releases/download/v1.2.3/x.exe"
        ));
        // esquema exótico
        assert!(!url_allowed("file:///C:/Windows/System32/calc.exe"));
        assert!(!url_allowed("javascript:alert(1)"));
        assert!(!url_allowed(""));
    }

    #[test]
    fn cdn_do_github_e_aceito_mas_api_restrita_ao_repo() {
        assert!(url_allowed(
            "https://objects.githubusercontent.com/github-production-release-asset/1/2"
        ));
        assert!(!url_allowed(
            "https://api.github.com/repos/outro/repo/releases"
        ));
        assert!(url_allowed(
            "https://api.github.com/repos/ArthurFreire77/dis-torrent/releases"
        ));
    }

    #[test]
    fn windows_escolhe_o_setup_do_manifesto_e_ignora_portable() {
        let lista = vec![
            manifest_asset("DisTorrent_1.2.3_x64_portable.exe", "windows", "x86_64"),
            manifest_asset("DisTorrent_1.2.3_x64_setup.exe", "windows", "x86_64"),
        ];
        let escolhido = pick_manifest_asset(&lista, "windows", "x86_64").unwrap();
        assert_eq!(escolhido.name, "DisTorrent_1.2.3_x64_setup.exe");
    }

    #[test]
    fn linux_prefere_appimage_e_aceita_deb_como_fallback() {
        let lista = vec![
            manifest_asset("DisTorrent_1.2.3_amd64.deb", "linux", "x86_64"),
            manifest_asset("DisTorrent_1.2.3_amd64.AppImage", "linux", "x86_64"),
        ];
        assert!(pick_manifest_asset(&lista, "linux", "x86_64")
            .unwrap()
            .name
            .ends_with(".AppImage"));
        let so_deb = vec![manifest_asset(
            "DisTorrent_1.2.3_amd64.deb",
            "linux",
            "x86_64",
        )];
        assert!(pick_manifest_asset(&so_deb, "linux", "x86_64")
            .unwrap()
            .name
            .ends_with(".deb"));
    }

    #[test]
    fn android_escolhe_apk_arm64_e_nao_o_universal() {
        let lista = vec![
            manifest_asset("DisTorrent_1.2.3_universal.apk", "android", "aarch64"),
            manifest_asset("DisTorrent_1.2.3_arm64.apk", "android", "aarch64"),
        ];
        assert_eq!(
            pick_manifest_asset(&lista, "android", "aarch64")
                .unwrap()
                .name,
            "DisTorrent_1.2.3_arm64.apk"
        );
    }

    #[test]
    fn asset_de_outra_plataforma_ou_arquitetura_nao_e_escolhido() {
        let lista = vec![manifest_asset(
            "DisTorrent_1.2.3_amd64.deb",
            "linux",
            "x86_64",
        )];
        assert!(pick_manifest_asset(&lista, "windows", "x86_64").is_none());
        assert!(pick_manifest_asset(&lista, "linux", "aarch64").is_none());
    }

    #[test]
    fn asset_com_extensao_trocada_no_manifesto_nao_passa() {
        let lista = vec![manifest_asset(
            "DisTorrent_1.2.3_amd64.AppImage",
            "windows",
            "x86_64",
        )];
        assert!(
            pick_manifest_asset(&lista, "windows", "x86_64").is_none(),
            "manifesto declarando AppImage como windows não pode casar"
        );
    }

    #[test]
    fn rotulo_do_asset_nao_decide_versao() {
        assert_eq!(
            version_in_asset_name("DisTorrent_1.1.23-pre-alpha_x64_setup.exe"),
            "1.1.23"
        );
        assert_eq!(version_in_asset_name("outro.exe"), "");
    }

    #[test]
    fn allowlist_nao_aceita_ip_literal() {
        assert!(!url_allowed("https://140.82.112.3/releases/download/x"));
        assert!(!url_allowed("https://127.0.0.1/x.exe"));
        assert!(!url_allowed("https://[::1]/x.exe"));
    }

    #[test]
    fn jitter_de_backoff_fica_dentro_do_teto() {
        for _ in 0..20 {
            let b = proximo_backoff(0);
            assert!((60_000..=72_000).contains(&b), "backoff inicial: {b}");
            let b = proximo_backoff(30 * 60 * 1000);
            assert!(b <= 60 * 60 * 1000 + 12 * 60 * 1000, "backoff alto: {b}");
        }
    }
}
