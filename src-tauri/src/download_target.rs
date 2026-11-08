// Pasta de destino dos downloads: o usuário escolhe onde salvar (arquivo de
// 1 GB no disco do sistema não pode ir para o perfil do app) e a escolha fica
// gravada. O navegador de pastas é só leitura de diretórios — sem shell.
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use super::*;

const KV_DIR: &str = "downloads.dir";

#[derive(Debug, Serialize)]
pub(crate) struct DownloadDirView {
    dir: String,
    is_default: bool,
}

#[derive(Debug, Serialize)]
pub(crate) struct BrowseEntry {
    name: String,
    path: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct BrowseView {
    path: String,
    parent: Option<String>,
    dirs: Vec<BrowseEntry>,
    drives: Vec<String>,
}

fn default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(target_os = "android")]
    {
        super::android_private_download_dir(app)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        super::resolve_downloads_dir()
    }
}

fn valid_dir(path: &Path) -> bool {
    path.is_dir()
}

/// Pasta efetiva: a escolhida pelo usuário, se ainda existir; senão Downloads.
pub(crate) fn target_dir(app: &AppHandle, state: &State<AppState>) -> Result<PathBuf, String> {
    if let Ok(store) = open_store(state) {
        if let Some(p) = store.kv_get(KV_DIR) {
            let path = PathBuf::from(p);
            if valid_dir(&path) {
                return Ok(path);
            }
        }
    }
    default_dir(app)
}

#[tauri::command]
pub(crate) fn download_dir_get(
    app: AppHandle,
    state: State<AppState>,
) -> Result<DownloadDirView, String> {
    let dir = target_dir(&app, &state)?;
    let is_default = default_dir(&app).map(|d| d == dir).unwrap_or(false);
    Ok(DownloadDirView {
        dir: dir.to_string_lossy().to_string(),
        is_default,
    })
}

#[tauri::command]
pub(crate) fn download_dir_set(
    app: AppHandle,
    path: String,
    state: State<AppState>,
) -> Result<DownloadDirView, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() {
        return Err(
            "escolha uma pasta com caminho completo (ex.: C:\\Users\\você\\Downloads)".into(),
        );
    }
    if !valid_dir(&p) {
        return Err(format!("a pasta {} não existe", p.display()));
    }
    // Teste real de escrita: pasta somente-leitura falharia só no fim do download.
    let probe = p.join(format!(".distorrent-write-{}", std::process::id()));
    std::fs::write(&probe, b"ok")
        .map_err(|e| format!("sem permissão para gravar em {}: {e}", p.display()))?;
    let _ = std::fs::remove_file(&probe);
    let store = open_store(&state)?;
    store.kv_set(KV_DIR, &p.to_string_lossy()).map_err(err)?;
    let is_default = default_dir(&app).map(|d| d == p).unwrap_or(false);
    Ok(DownloadDirView {
        dir: p.to_string_lossy().to_string(),
        is_default,
    })
}

#[tauri::command]
pub(crate) fn download_dir_reset(
    app: AppHandle,
    state: State<AppState>,
) -> Result<DownloadDirView, String> {
    let store = open_store(&state)?;
    let _ = store.kv_delete(KV_DIR);
    let dir = default_dir(&app)?;
    Ok(DownloadDirView {
        dir: dir.to_string_lossy().to_string(),
        is_default: true,
    })
}

#[cfg(target_os = "windows")]
fn drives() -> Vec<String> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).is_dir() {
            out.push(root);
        }
    }
    out
}

#[cfg(not(target_os = "windows"))]
fn drives() -> Vec<String> {
    vec![
        "/".to_string(),
        dirs::home_dir()
            .map(|h| h.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string()),
    ]
}

#[tauri::command]
pub(crate) fn download_dir_browse(path: Option<String>) -> Result<BrowseView, String> {
    let atual = match path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(p) => {
            let pb = PathBuf::from(&p);
            if !pb.is_dir() {
                return Err(format!("a pasta {p} não existe"));
            }
            pb
        }
        None => dirs::home_dir().ok_or("não achei a pasta do usuário")?,
    };
    let mut dirs_v: Vec<BrowseEntry> = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&atual) {
        for e in rd.flatten() {
            let Ok(md) = e.metadata() else { continue };
            if !md.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with('$') {
                continue;
            }
            dirs_v.push(BrowseEntry {
                name,
                path: e.path().to_string_lossy().to_string(),
            });
        }
    }
    dirs_v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(BrowseView {
        path: atual.to_string_lossy().to_string(),
        parent: atual.parent().map(|p| p.to_string_lossy().to_string()),
        dirs: dirs_v,
        drives: drives(),
    })
}

/// Abre a pasta no gerenciador de arquivos do sistema.
#[tauri::command]
pub(crate) fn download_dir_open(
    path: Option<String>,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    let dir = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => target_dir(&app, &state)?,
    };
    if !dir.is_dir() {
        return Err(format!("a pasta {} não existe", dir.display()));
    }
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
    let _ = std::process::Command::new("xdg-open").arg(&dir).spawn();
    #[cfg(target_os = "android")]
    {
        let _ = &dir;
        return Err("no Android o arquivo vai para a pasta Downloads do sistema".into());
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub(crate) struct DiskSpaceView {
    free_bytes: u64,
    total_bytes: u64,
}

/// Espaço livre na pasta escolhida: avisar ANTES de baixar 500 GB.
#[tauri::command]
pub(crate) fn download_dir_space(
    app: AppHandle,
    path: Option<String>,
    state: State<AppState>,
) -> Result<DiskSpaceView, String> {
    let dir = match path.filter(|p| !p.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => target_dir(&app, &state)?,
    };
    let (free, total) = free_space(&dir)?;
    Ok(DiskSpaceView {
        free_bytes: free,
        total_bytes: total,
    })
}

#[cfg(target_os = "windows")]
fn free_space(dir: &Path) -> Result<(u64, u64), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut wide: Vec<u16> = dir.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut free = 0u64;
    let mut total = 0u64;
    let ok =
        unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, &mut total, std::ptr::null_mut()) };
    if ok == 0 {
        return Err(format!(
            "não consegui medir o espaço livre em {}",
            dir.display()
        ));
    }
    Ok((free, total))
}

#[cfg(not(target_os = "windows"))]
fn free_space(_dir: &Path) -> Result<(u64, u64), String> {
    // Sem statvfs nesta árvore de dependências: devolver 0/0 é honesto e a UI
    // simplesmente não mostra o aviso de espaço.
    Ok((0, 0))
}
