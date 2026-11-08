// Updater apply: parte de updater.rs.
// Irmao do updater.rs; usa os tipos la declarados via super::*.

use super::*;

/// Revalida o instalador imediatamente antes de executar.
///
/// Cobre: arquivo trocado depois do download, symlink apontando para fora da
/// pasta, hash que não bate, manifesto que expirou (época) e caminho fora da
/// pasta de updates.
pub fn verify_before_apply(app: &tauri::AppHandle, path: &str) -> Result<PendingUpdate, String> {
    use sha2::{Digest as _, Sha256};

    let store = open_store(app)?;
    let raw = store
        .kv_get(KV_PENDING)
        .ok_or("nenhuma atualização verificada pendente")?;
    let pending: PendingUpdate =
        serde_json::from_str(&raw).map_err(|_| "registro de atualização corrompido".to_string())?;
    if pending.path.is_empty() || pending.path != path {
        return Err("o caminho não é o do download verificado".into());
    }
    let trust = load_trust(&store);
    if !trust.verification_available() {
        return Err("sem chaves de confiança: instalação recusada".into());
    }
    match trust.latest_verified() {
        Some(v) if v.manifest_hash == pending.manifest_hash => {}
        Some(_) => return Err("o manifesto verificado mudou — refaça a atualização".into()),
        None => return Err("manifesto verificado indisponível — instalação recusada".into()),
    }

    let dir = updates_dir(app)?;
    let dir_canon = std::fs::canonicalize(&dir).map_err(|e| format!("pasta de updates: {e}"))?;
    let p = PathBuf::from(path);
    // `symlink_metadata` antes do canonicalize: symlink é recusado por si só.
    let meta = std::fs::symlink_metadata(&p).map_err(|e| format!("instalador ausente: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err("o instalador é um symlink — recusado".into());
    }
    if !meta.is_file() {
        return Err("o instalador não é um arquivo comum".into());
    }
    let canon = std::fs::canonicalize(&p).map_err(|e| format!("resolver caminho: {e}"))?;
    if !canon.starts_with(&dir_canon) {
        return Err("o instalador está fora da pasta de updates do app".into());
    }
    if meta.len() != pending.size {
        return Err(format!(
            "o instalador tem {} bytes, o manifesto diz {} — recusado",
            meta.len(),
            pending.size
        ));
    }
    let bytes = std::fs::read(&canon).map_err(|e| format!("ler instalador: {e}"))?;
    let got = hex::encode(Sha256::digest(&bytes));
    if !got.eq_ignore_ascii_case(&pending.sha256) {
        return Err(
            "o instalador mudou depois do download (hash não confere) — instalação recusada".into(),
        );
    }
    Ok(pending)
}

#[tauri::command]
pub fn update_apply(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let pending = verify_before_apply(&app, &path)?;
    let _ = &pending;
    let p = PathBuf::from(&path);
    let lower = path.to_ascii_lowercase();
    #[allow(unused_variables)]
    let store = open_store(&app)?;

    #[cfg(target_os = "windows")]
    {
        if !lower.ends_with(".exe") {
            return Err("só instalador .exe é executado no Windows".into());
        }
        match pre_update_snapshot(&app) {
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
        // Instalação em Program Files precisa de elevação. Antes o app RECUSAVA
        // e mandava baixar o instalador do GitHub na mão — era isso que prendia
        // quem tinha instalado "para todos os usuários" na versão antiga.
        // `runas` mostra o UAC e, negado, devolve erro claro (não trava).
        if instalação_por_usuario()? {
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
        } else {
            run_elevated(&p)?;
        }
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
        let _ = pending;
        return Err(INSTALAR_APK_SINAL.into());
    }
    #[cfg(not(any(
        target_os = "windows",
        target_os = "linux",
        target_os = "freebsd",
        target_os = "android"
    )))]
    {
        let _ = (&p, &lower, &pending);
        return Err("atualização automática não disponível nesta plataforma".into());
    }
    #[cfg(any(target_os = "linux", target_os = "freebsd"))]
    {
        let _ = pending;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn run_elevated(installer: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(std::iter::once(0)).collect()
    }
    let op = wide(std::ffi::OsStr::new("runas"));
    let file = wide(installer.as_os_str());
    let params = wide(std::ffi::OsStr::new(
        "/SILENT /SUPPRESSMSGBOXES /CLOSEAPPLICATIONS /RESTARTAPPLICATIONS",
    ));
    let dir = installer.parent().unwrap_or(std::path::Path::new("."));
    let cwd = wide(dir.as_os_str());
    // SAFETY: as quatro strings são NUL-terminadas e vivem até o fim da chamada;
    // hwnd e show são valores documentados para uso interativo.
    let rc = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            op.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            cwd.as_ptr(),
            SW_SHOWNORMAL,
        )
    };
    // <= 32 é erro (a API não usa GetLastError). 5 = acesso negado = UAC negado.
    if (rc as isize) <= 32 {
        let code = rc as isize;
        return Err(if code == 5 {
            "a atualização precisa de administrador e o pedido do Windows foi negado — \
             abra o instalador e permita a elevação"
                .into()
        } else {
            format!("não consegui abrir o instalador com elevação (código {code})")
        });
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn pre_update_snapshot(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
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
    // Só dá para selar o snapshot com a chave de backup quando o segredo está
    // recuperável SEM senha (keyring). Conta protegida por senha não gera
    // snapshot aqui — não há como derivar a chave do blob selado.
    let secret = match crate::recover_plaintext_secret(&store) {
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
