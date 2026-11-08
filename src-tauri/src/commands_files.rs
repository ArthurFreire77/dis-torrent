// Comandos Tauri: files.
// Irmão de lib.rs; o generate_handler! continua lá.

use super::*;

#[tauri::command]
pub(crate) fn save_public_copy(
    app: AppHandle,
    path: String,
    name: String,
) -> Result<String, String> {
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

#[tauri::command]
pub(crate) fn vault_status(state: State<AppState>) -> Result<VaultStatus, String> {
    let store = open_store(&state)?;
    let stored = store.load_secret_hex().unwrap_or_default();
    let has_vault = store.kv_get("vault.on").as_deref() == Some("1") && stored.len() >= 88;
    let has_identity = store.load_identity().is_some();
    // Sem cofre e sem segredo legível = keyring sumiu (ou nunca houve). A UI
    // precisa saber disso para pedir a senha em vez de oferecer "criar conta".
    let secret_available = has_vault || plaintext_secret(&store).is_some();
    Ok(VaultStatus {
        has_identity,
        has_vault,
        locked: has_identity && !secret_available,
    })
}

#[tauri::command]
pub(crate) fn vault_unlock(
    app: AppHandle,
    password: String,
    state: State<AppState>,
) -> Result<Identity, String> {
    let store = open_store(&state)?;
    let key = auth_key(&store, "unlock");
    auth_guard(&state, &key)?;

    let mut identity = store.load_identity().ok_or("sem identidade")?;
    let Some(stored) = store.load_secret_hex().filter(|s| s.len() >= 88) else {
        return Err(
            "esta conta não tem senha de cofre e o keyring do sistema não respondeu — \
             importe um .stormvault com senha para recuperar"
                .into(),
        );
    };
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
            identity.fingerprint = kp.fingerprint();
            // Metadados apenas: o blob selado já está em `identity.secret`.
            let _ = store.save_identity_meta(&identity);
        }
    }
    *state.unlocked.lock().unwrap_or_else(|e| e.into_inner()) = true;
    boot_engine_with_secret(&app, &state, &store, secret)?;
    Ok(identity)
}

#[tauri::command]
pub(crate) fn vault_change(old: String, new: String, state: State<AppState>) -> Result<(), String> {
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
    // Depois que existe senha do cofre, o texto claro da chave no keyring não
    // pode continuar valendo: seria um segundo caminho sem senha para a conta.
    store.kv_set("vault.on", "1").map_err(err)?;
    #[cfg(not(target_os = "android"))]
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.delete_password();
    }
    auth_ok(&state, &key);
    Ok(())
}

#[tauri::command]
pub(crate) fn vault_export(state: State<AppState>) -> Result<VaultExport, String> {
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
pub(crate) fn vault_import(
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
    // A identidade tem de ser coerente com o blob: sem isso um JSON arbitrário
    // vira "conta" na UI até a senha falhar.
    if !distorrent_core::identity::fingerprint_matches(&identity.fingerprint, &identity.pubkey_hex)
    {
        return Err("identity inválida: fingerprint não corresponde à pubkey".into());
    }

    store.save_identity(&identity, &vault_blob).map_err(err)?;
    store.kv_set("vault.on", "1").map_err(err)?;

    Ok(identity)
}

#[tauri::command]
pub(crate) fn accounts_list(state: State<AppState>) -> Result<Vec<SavedAccount>, String> {
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
pub(crate) fn account_save_imported(
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
    if !distorrent_core::identity::fingerprint_matches(&identity.fingerprint, &identity.pubkey_hex)
    {
        return Err("identity inválida: fingerprint não corresponde à pubkey".into());
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
pub(crate) fn account_switch(
    fingerprint: String,
    state: State<AppState>,
) -> Result<Identity, String> {
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
            if !imported_identity.pubkey_hex.is_empty()
                && !distorrent_core::identity::fingerprint_matches(
                    &imported_identity.fingerprint,
                    &imported_identity.pubkey_hex,
                )
            {
                return Err("conta importada corrompida: fingerprint não bate com a pubkey".into());
            }
            // Blob selado no slot ativo; o texto claro anterior (keyring) não
            // pode continuar valendo para OUTRA conta.
            store
                .save_identity(&imported_identity, &blob)
                .map_err(err)?;
            store.kv_set("vault.on", "1").map_err(err)?;
            #[cfg(not(target_os = "android"))]
            if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
                let _ = entry.delete_password();
            }

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
pub(crate) fn account_remove_imported(
    fingerprint: String,
    state: State<AppState>,
) -> Result<(), String> {
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
pub(crate) fn file_announce(
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
pub(crate) fn file_request_chunk(
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
pub(crate) fn file_send_chunk(
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
pub(crate) fn save_file_stream(
    app: AppHandle,
    job_id: String,
    name: String,
    data_b64: String,
    flush: bool,
    total_bytes: u64,
    expect_blake3: Option<String>,
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
            // Respeita a pasta escolhida pelo usuário (Configurações → Cofre &
            // Backup → Onde salvar). Antes ignorava e sempre salvava em Downloads.
            crate::download_target::target_dir(&app, &state)?
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
        if let Some(esperado) = expect_blake3
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let bytes = fs::read(&tmp).map_err(|e| {
                format!("save_file_stream: não consegui reler para conferir o hash: {e}")
            })?;
            let real = distorrent_core::blake3::hash(&bytes).to_hex().to_string();
            if !real.eq_ignore_ascii_case(esperado) {
                let _ = fs::remove_file(&tmp);
                return Err(format!(
                    "arquivo corrompido: o hash não bate (esperado {esperado}, recebido {real}). Baixe de novo."
                ));
            }
        }
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

#[tauri::command]
pub(crate) async fn stormvault_export(
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

#[tauri::command]
pub(crate) async fn stormvault_import(
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

#[tauri::command]
pub(crate) fn stormvault_backups_list(state: State<AppState>) -> Result<Vec<BackupView>, String> {
    list_backup_files(&state)
}

#[tauri::command]
pub(crate) async fn stormvault_backup_now(
    state: State<'_, AppState>,
) -> Result<BackupView, String> {
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
pub(crate) async fn stormvault_backup_restore(
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
pub(crate) fn stormvault_backup_set_retention(
    days: i64,
    state: State<AppState>,
) -> Result<(), String> {
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
pub(crate) fn stormvault_backup_get_retention(state: State<AppState>) -> Result<i64, String> {
    Ok(backup_retention_days(&open_store(&state)?))
}

#[tauri::command]
pub(crate) fn vault_wipe(
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

#[tauri::command]
pub(crate) fn metrics_snapshot() -> serde_json::Value {
    distorrent_core::metrics::metrics().snapshot()
}

#[tauri::command]
pub(crate) fn cache_get(key: String, state: State<AppState>) -> Result<Option<String>, String> {
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
pub(crate) fn cache_put(
    key: String,
    data_b64: String,
    state: State<AppState>,
) -> Result<(), String> {
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
pub(crate) fn cache_delete(key: String, state: State<AppState>) -> Result<(), String> {
    check_cache_key(&key)?;
    state.cache.delete(&key).map_err(err)
}

#[tauri::command]
pub(crate) fn cache_stats(state: State<AppState>) -> Result<CacheStatsView, String> {
    Ok(CacheStatsView {
        cap_mb: state.cache.cap() / (1024 * 1024),
        total_bytes: state.cache.total_bytes(),
        entries: state.cache.entries(),
    })
}

#[tauri::command]
pub(crate) fn cache_set_cap(cap_mb: u64, state: State<AppState>) -> Result<(), String> {
    let cap = cap_mb.clamp(16, 4096);
    let store = open_store(&state)?;
    store
        .kv_set("cache.cap_mb", &cap.to_string())
        .map_err(err)?;
    state.cache.set_cap(cap * 1024 * 1024).map_err(err)
}

#[tauri::command]
pub(crate) fn cache_get_ttl(state: State<AppState>) -> Result<u64, String> {
    Ok(state.cache.ttl_secs())
}

#[tauri::command]
pub(crate) fn cache_set_ttl(days: u64, state: State<AppState>) -> Result<(), String> {
    let days = days.clamp(1, 30);
    let store = open_store(&state)?;
    store
        .kv_set("cache.ttl_days", &days.to_string())
        .map_err(err)?;
    state.cache.set_ttl(days * 24 * 60 * 60).map_err(err)
}

#[tauri::command]
pub(crate) fn media_safety_get(state: State<AppState>) -> Result<MediaSafetyView, String> {
    Ok(media_safety_read(&open_store(&state)?))
}

#[tauri::command]
pub(crate) fn media_safety_set(
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

#[tauri::command]
pub(crate) fn retention_get(state: State<AppState>) -> Result<RetentionSettings, String> {
    Ok(retention_read(&open_store(&state)?))
}

#[tauri::command]
pub(crate) fn retention_set(
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
pub(crate) fn retention_run(state: State<AppState>) -> Result<usize, String> {
    retention_apply(&open_store(&state)?)
}
