use std::path::PathBuf;

use serde::Serialize;

#[allow(dead_code)]
const REPO: &str = "ArthurFreire77/dis-torrent";
const RELEASES_API: &str =
    "https://api.github.com/repos/ArthurFreire77/dis-torrent/releases?per_page=20";
const DOWNLOAD_PREFIX: &str = "https://github.com/ArthurFreire77/dis-torrent/releases/download/";
const RELEASES_PAGE_CAP: usize = 20;

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

fn accepted_ext(platform: &str) -> &'static [&'static str] {
    match platform {
        "windows" => &[".exe"],
        "linux" => &[".appimage", ".deb"],
        "android" => &[".apk"],
        _ => &[],
    }
}

fn pick_asset<'a>(assets: &'a [GhAsset], platform: &str) -> Option<&'a GhAsset> {
    let exts = accepted_ext(platform);
    for want in exts {
        let da_ext: Vec<&GhAsset> = assets
            .iter()
            .filter(|a| a.name.to_ascii_lowercase().ends_with(want))
            .collect();
        if da_ext.is_empty() {
            continue;
        }
        let preferido = match *want {
            ".exe" => "_setup",
            ".apk" => "_arm64",
            _ => "",
        };
        if !preferido.is_empty() {
            if let Some(a) = da_ext
                .iter()
                .find(|a| a.name.to_ascii_lowercase().contains(preferido))
            {
                return Some(a);
            }
        }
        return Some(da_ext[0]);
    }
    None
}

#[derive(Debug, serde::Deserialize)]
struct GhAsset {
    name: String,
    size: u64,
    #[serde(default)]
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GhRelease {
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

fn compare_version_strings(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;

    fn parse(raw: &str) -> (Vec<u64>, Vec<String>) {
        let s = raw.trim().trim_start_matches(['v', 'V']);
        let mut parts = s.splitn(2, '-');
        let core = parts.next().unwrap_or("");
        let pre = parts.next().unwrap_or("").to_ascii_lowercase();
        let mut nums: Vec<u64> = core
            .split('.')
            .map(|p| {
                let digits: String = p
                    .trim()
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect();
                digits.parse::<u64>().unwrap_or(0)
            })
            .collect();
        if nums.is_empty() {
            nums.push(0);
        }
        let tokens = pre
            .split(['-', '.'])
            .filter(|t| !t.is_empty())
            .map(|t| t.to_string())
            .collect();
        (nums, tokens)
    }

    fn rank(tokens: &[String]) -> u8 {
        for t in tokens {
            match t.as_str() {
                "pre" => return 0,
                "alpha" | "a" => return 1,
                "beta" | "b" => return 2,
                "rc" | "preview" => return 3,
                _ => {}
            }
        }
        2
    }

    // Seção 1: let
    let (pa, ta) = parse(a);
    let (pb, tb) = parse(b);
    let len = pa.len().max(pb.len());
    for i in 0..len {
        let na = pa.get(i).copied().unwrap_or(0);
        let nb = pb.get(i).copied().unwrap_or(0);
        match na.cmp(&nb) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    if ta.is_empty() || tb.is_empty() {
        return Ordering::Equal;
    }
    if ta == tb {
        return Ordering::Equal;
    }
    match rank(&ta).cmp(&rank(&tb)) {
        Ordering::Equal => {}
        other => return other,
    }
    let nums = |t: &[String]| -> Vec<u64> {
        t.iter()
            .filter(|x| x.chars().all(|c| c.is_ascii_digit()))
            .filter_map(|x| x.parse::<u64>().ok())
            .collect()
    };
    let na = nums(&ta);
    let nb = nums(&tb);
    let n = na.len().max(nb.len());
    for i in 0..n {
        let x = na.get(i).copied().unwrap_or(0);
        let y = nb.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            Ordering::Equal => continue,
            other => return other,
        }
    }
    Ordering::Equal
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("DisTorrent/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("cliente HTTP: {e}"))
}

fn select_update(
    current: String,
    mut releases: Vec<GhRelease>,
    platform: &str,
) -> Result<UpdateInfo, String> {
    releases.truncate(RELEASES_PAGE_CAP);

    releases.retain(|r| !r.draft);
    if releases.is_empty() {
        return Err("nenhuma release publicada no repositório".into());
    }

    releases.sort_by(|a, b| {
        compare_version_strings(&b.tag_name, &a.tag_name).then_with(|| b.tag_name.cmp(&a.tag_name))
    });
    let release = releases.remove(0);

    let platform = platform.to_string();
    let asset = pick_asset(&release.assets, &platform).ok_or_else(|| {
        format!(
            "a release {} não publicou um instalador para {platform}",
            release.tag_name
        )
    })?;

    if !asset.browser_download_url.starts_with(DOWNLOAD_PREFIX) {
        return Err("asset da release aponta para um host não permitido".into());
    }
    let lower = asset.name.to_ascii_lowercase();
    if !accepted_ext(&platform).iter().any(|e| lower.ends_with(e)) {
        return Err(format!("asset inesperado para {platform}: {}", asset.name));
    }

    let latest = release.tag_name.trim_start_matches('v').to_string();
    let asset_version = version_in_asset_name(&asset.name);
    let label_mismatch = !asset_version.is_empty() && {
        let tag_core = latest.split('-').next().unwrap_or("");
        let asset_core = asset_version.split('-').next().unwrap_or("");
        asset_core != tag_core
    };
    if label_mismatch {
        eprintln!(
            "update: a release {} publicou o asset {} (versão {asset_version}) — instalador rotulado com outra versão; não vou entrar em loop",
            release.tag_name, asset.name
        );
    }

    Ok(UpdateInfo {
        current,
        latest,
        asset_name: asset.name.clone(),
        asset_size: asset.size,
        download_url: asset.browser_download_url.clone(),
        digest: asset.digest.clone().unwrap_or_default(),
        notes: if release.body.trim().is_empty() {
            release.name
        } else {
            release.body
        },
        html_url: release.html_url,
        platform,
        label_mismatch,
        asset_version,
    })
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string());

    let client = http_client()?;
    let res = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("sem conexão com o GitHub: {e}"))?;
    if !res.status().is_success() {
        return Err(format!(
            "GitHub respondeu {} ao procurar a release mais nova",
            res.status().as_u16()
        ));
    }
    let bytes = res.bytes().await.map_err(|e| format!("resposta: {e}"))?;
    let releases: Vec<GhRelease> = serde_json::from_slice(&bytes)
        .map_err(|e| format!("resposta do GitHub em formato inesperado: {e}"))?;
    select_update(current, releases, platform_tag())
}

#[tauri::command]
pub async fn update_download(
    app: tauri::AppHandle,
    url: String,
    name: String,
    digest: String,
) -> Result<String, String> {
    use sha2::{Digest as _, Sha256};

    if !url.starts_with(DOWNLOAD_PREFIX) {
        return Err("download fora do repositório oficial recusado".into());
    }
    let platform = platform_tag();
    let lower_name = name.to_ascii_lowercase();
    if !accepted_ext(platform)
        .iter()
        .any(|e| lower_name.ends_with(e))
    {
        return Err(format!("extensão de instalador não aceita: {name}"));
    }
    // Seção 2: file_name
    let file_name = std::path::Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "nome de arquivo inválido".to_string())?
        .to_string();
    if file_name != name {
        return Err("nome de arquivo inválido".into());
    }

    let dir = updates_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar pasta de updates: {e}"))?;
    let final_path = dir.join(&file_name);
    let part_path = dir.join(format!("{file_name}.part"));

    let client = http_client()?;
    let mut stream = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("falha ao baixar o instalador: {e}"))?;
    if !stream.status().is_success() {
        return Err(format!(
            "download recusado pelo GitHub ({})",
            stream.status().as_u16()
        ));
    }

    let mut hasher = Sha256::new();
    let mut file =
        std::fs::File::create(&part_path).map_err(|e| format!("criar arquivo de download: {e}"))?;
    loop {
        match stream.chunk().await {
            Ok(Some(chunk)) => {
                use std::io::Write as _;
                hasher.update(&chunk);
                file.write_all(&chunk)
                    .map_err(|e| format!("gravar download: {e}"))?;
            }
            Ok(None) => break,
            Err(e) => {
                drop(file);
                let _ = std::fs::remove_file(&part_path);
                return Err(format!("download interrompido: {e}"));
            }
        }
    }
    drop(file);

    let got = format!("sha256:{}", hex::encode(hasher.finalize()));
    if !digest.is_empty() && !digest.eq_ignore_ascii_case(&got) {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "o instalador baixado não confere com o hash publicado (esperado {digest}, obtido {got}) — arquivo descartado"
        ));
    }
    std::fs::rename(&part_path, &final_path).map_err(|e| format!("finalizar download: {e}"))?;
    Ok(final_path.to_string_lossy().to_string())
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
        std::process::Command::new("cmd")
            .args(["/C", "start", "", alvo])
            .spawn()
            .map_err(|e| format!("abrir endereço: {e}"))?;
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

pub const REINICIAR_SINAL: &str = "ATUALIZADO_E_REINICIADO";

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
        // Seção 3: _
        let _ = std::fs::remove_file(&temp);
        format!("não consegui substituir o AppImage em uso: {e}")
    })?;

    std::process::Command::new(destino)
        .arg("--atualizado")
        .spawn()
        .map_err(|e| format!("AppImage substituído, mas não consegui reabrir: {e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn update_apply(_app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err("instalador não encontrado (o download falhou?)".into());
    }
    let lower = path.to_ascii_lowercase();

    #[cfg(target_os = "windows")]
    {
        if !lower.ends_with(".exe") {
            return Err("só instalador .exe é executado no Windows".into());
        }
        match pre_update_snapshot(&_app) {
            Ok(Some(arquivo)) => {
                tracing::info!(?arquivo, "backup pré-atualização criado")
            }
            Ok(None) => {}
            Err(e) => {
                eprintln!(
                    "update: backup pré-atualização falhou ({e}) — seguindo com a atualização"
                );
            }
        }
        std::process::Command::new(&p)
            .args([
                "/SILENT",
                "/SUPPRESSMSGBOXES",
                "/CLOSEAPPLICATIONS",
                "/RESTARTAPPLICATIONS",
            ])
            .current_dir(p.parent().unwrap_or(std::path::Path::new(".")))
            .spawn()
            .map_err(|e| format!("não consegui iniciar o instalador: {e}"))?;
    }
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        if !(lower.ends_with(".deb") || lower.ends_with(".appimage")) {
            return Err("instalador inesperado para Linux".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            if lower.ends_with(".appimage") {
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755));
            }
        }
        if lower.ends_with(".appimage") {
            if let Some(destino) = appimage_alvo() {
                if substituir_e_reiniciar(&p, &destino)? {
                    return Err(REINICIAR_SINAL.into());
                }
            }
        }
        std::process::Command::new("xdg-open")
            .arg(&p)
            .spawn()
            .map_err(|e| format!("não consegui abrir o instalador: {e}"))?;
    }
    #[cfg(target_os = "android")]
    {
        if !lower.ends_with(".apk") {
            return Err("esperava um APK para atualizar no Android".into());
        }
        return Err(
            "no Android a instalação é feita pelo plugin nativo (updater|installApk)".into(),
        );
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "android"
    )))]
    {
        let _ = (&p, &lower);
        return Err("atualização automática não disponível nesta plataforma".into());
    }
    Ok(())
}

fn updates_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    #[cfg(target_os = "android")]
    {
        // No Android `app_data_dir()` JÁ aponta para `filesDir`. Juntar "files"
        // de novo jogava o APK em `filesDir/files/updates`, fora do
        // `<files-path path=".">` do FileProvider — o `getUriForFile` então
        // lançava IllegalArgumentException e o "Atualizar" falhava na hora.
        let base = app
            .path()
            .app_data_dir()
            .or_else(|_| app.path().app_local_data_dir())
            .map_err(|e| format!("pasta de dados: {e}"))?;
        // Garante que o APK fique DENTRO de filesDir mesmo se o provider
        // apontar para o pai (Tauri devolve dataDir em algumas versões).
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

// Seção 4: tauri
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

#[cfg(target_os = "windows")]
fn pre_update_snapshot(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    use tauri::Manager;

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("pasta de dados: {e}"))?;
    let store = distorrent_core::storage::Store::open(&dir.join("distorrent.db"))
        .map_err(|e| e.to_string())?;
    let Some(_identity) = store.load_identity() else {
        return Ok(None);
    };
    let secret = match store.load_secret_hex() {
        Some(s) => s,
        None => return Ok(None),
    };

    let data = distorrent_core::stormvault::collect(&store, None, Some(20_000))
        .map_err(|e| e.to_string())?;
    let backup_key = distorrent_core::stormvault::backup_key_for(&secret);
    let blob = distorrent_core::stormvault::seal_with_key(&data, &backup_key)
        .map_err(|e| e.to_string())?;

    let backups = dir.join("backups");
    std::fs::create_dir_all(&backups).map_err(|e| format!("criar pasta de backups: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let version = app
        .config()
        .version
        .clone()
        .unwrap_or_else(|| "0.0.0".to_string());
    let nome = format!("pre-update-{version}-{stamp}.stormvault");
    let destino = backups.join(&nome);
    let part = backups.join(format!("{nome}.part"));
    std::fs::write(&part, &blob).map_err(|e| format!("gravar snapshot: {e}"))?;
    std::fs::rename(&part, &destino).map_err(|e| format!("finalizar snapshot: {e}"))?;

    if let Ok(entries) = std::fs::read_dir(&backups) {
        let mut pre: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n.starts_with("pre-update-") && n.ends_with(".stormvault"))
                    .unwrap_or(false)
            })
            .collect();
        pre.sort();
        while pre.len() > 5 {
            let velho = pre.remove(0);
            let _ = std::fs::remove_file(velho);
        }
    }
    Ok(Some(destino))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str) -> GhAsset {
        GhAsset {
            name: name.to_string(),
            size: 1,
            browser_download_url: format!("{DOWNLOAD_PREFIX}v1.0.0/{name}"),
            digest: None,
        }
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
            compare_version_strings("1.10.0-pre-alpha", "1.2.0-pre-alpha"),
            Ordering::Greater
        );
        assert_eq!(
            compare_version_strings("1.2.1-alpha.10", "1.2.1-alpha.2"),
            Ordering::Greater
        );
    }

    #[test]
    fn windows_escolhe_o_setup_e_nao_outro_exe() {
        let lista = vec![
            asset("DisTorrent_1.1.23-pre-alpha_x64_portable.exe"),
            asset("DisTorrent_1.1.23-pre-alpha_x64_setup.exe"),
        ];
        let escolhido = pick_asset(&lista, "windows").expect("tem .exe");
        assert_eq!(escolhido.name, "DisTorrent_1.1.23-pre-alpha_x64_setup.exe");
    }

    #[test]
    fn linux_prefere_appimage_e_aceita_deb_como_fallback() {
        // Seção 5: lista
        let lista = vec![
            asset("DisTorrent_1.1.23-pre-alpha_amd64.deb"),
            asset("DisTorrent_1.1.23-pre-alpha_amd64.AppImage"),
        ];
        assert!(pick_asset(&lista, "linux")
            .unwrap()
            .name
            .ends_with(".AppImage"));
        let so_deb = vec![asset("DisTorrent_1.1.23-pre-alpha_amd64.deb")];
        assert!(pick_asset(&so_deb, "linux").unwrap().name.ends_with(".deb"));
    }

    #[test]
    fn android_escolhe_o_apk_arm64() {
        let lista = vec![asset("DisTorrent_1.1.23-pre-alpha_arm64.apk")];
        assert!(pick_asset(&lista, "android")
            .unwrap()
            .name
            .ends_with(".apk"));
    }

    #[test]
    fn plataforma_sem_asset_devolve_none() {
        let lista = vec![asset("DisTorrent_1.1.23-pre-alpha_amd64.deb")];
        assert!(pick_asset(&lista, "windows").is_none());
    }

    fn release_v123() -> GhRelease {
        let nomes = [
            "DisTorrent_1.1.23-pre-alpha_amd64.AppImage",
            "DisTorrent_1.1.23-pre-alpha_amd64.deb",
            "DisTorrent_1.1.23-pre-alpha_arm64.apk",
            "DisTorrent_1.1.23-pre-alpha_x64_setup.exe",
        ];
        GhRelease {
            tag_name: "v1.1.23".into(),
            name: "DisTorrent 1.1.23-pre-alpha".into(),
            body: "correcoes".into(),
            html_url: "https://github.com/x/y/releases/tag/v1.1.23".into(),
            draft: false,
            assets: nomes
                .iter()
                .map(|n| GhAsset {
                    name: (*n).into(),
                    size: 1000,
                    browser_download_url: format!("{DOWNLOAD_PREFIX}v1.1.23/{n}"),
                    digest: Some("sha256:abc".into()),
                })
                .collect(),
        }
    }

    #[test]
    fn v123_windows_escolhe_o_setup_e_nao_marca_rotulo_trocado() {
        let info =
            select_update("1.1.22-pre-alpha".into(), vec![release_v123()], "windows").unwrap();
        assert_eq!(info.asset_name, "DisTorrent_1.1.23-pre-alpha_x64_setup.exe");
        assert_eq!(info.asset_version, "1.1.23");
        assert!(!info.label_mismatch, "asset e tag tem a mesma versao");
        assert_eq!(info.latest, "1.1.23");
        assert_eq!(info.digest, "sha256:abc");
    }

    #[test]
    fn v123_linux_escolhe_appimage() {
        let info = select_update("1.1.22-pre-alpha".into(), vec![release_v123()], "linux").unwrap();
        assert_eq!(
            info.asset_name,
            "DisTorrent_1.1.23-pre-alpha_amd64.AppImage"
        );
        assert!(!info.label_mismatch);
    }

    #[test]
    fn v123_android_escolhe_o_apk_arm64_publicado() {
        let info =
            select_update("1.1.22-pre-alpha".into(), vec![release_v123()], "android").unwrap();
        assert_eq!(info.asset_name, "DisTorrent_1.1.23-pre-alpha_arm64.apk");
        assert_eq!(info.asset_version, "1.1.23");
        assert!(!info.label_mismatch);
    }

    #[test]
    fn release_antiga_nao_ganha_e_rotulo_velho_avisa() {
        let mut antiga = release_v123();
        antiga.tag_name = "v1.1.22".into();
        let info = select_update(
            "1.1.21-pre-alpha".into(),
            vec![antiga, release_v123()],
            "windows",
        )
        .unwrap();
        assert_eq!(
            info.latest, "1.1.23",
            "maior versao ganha da ordem da lista"
        );

        let mut trocada = release_v123();
        trocada.assets[3].name = "DisTorrent_1.1.22-pre-alpha_x64_setup.exe".into();
        let info = select_update("1.1.22-pre-alpha".into(), vec![trocada], "windows").unwrap();
        assert!(
            info.label_mismatch,
            "instalador rotulado errado precisa avisar"
        );
        assert_eq!(info.asset_version, "1.1.22");
    }

    #[test]
    fn rascunho_nao_e_oferecido() {
        let mut draft = release_v123();
        draft.draft = true;
        draft.tag_name = "v9.9.9".into();
        let info = select_update(
            "1.1.22-pre-alpha".into(),
            vec![draft, release_v123()],
            "windows",
        )
        .unwrap();
        assert_eq!(info.latest, "1.1.23", "draft 9.9.9 nao pode ser oferecido");
    }
}
