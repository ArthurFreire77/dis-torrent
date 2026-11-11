// Updater download: parte de updater.rs.
// Irmao do updater.rs; usa os tipos la declarados via super::*.

use super::*;

/// Um asset só é aceito se estiver descrito no manifesto assinado. Esta função
/// não "descobre" nada por conta própria — ela filtra a lista assinada.
pub fn pick_manifest_asset<'a>(
    assets: &'a [ManifestAsset],
    platform: &str,
    arch: &str,
) -> Option<&'a ManifestAsset> {
    let exts = accepted_ext(platform);
    let mut candidatos: Vec<&ManifestAsset> = assets
        .iter()
        .filter(|a| a.os == platform)
        .filter(|a| a.arch == arch || a.arch == "universal")
        .filter(|a| {
            let lower = a.name.to_ascii_lowercase();
            exts.iter().any(|e| lower.ends_with(e))
        })
        .collect();
    let preferido = match platform {
        "windows" => Some("_setup"),
        "android" => Some("_arm64"),
        "linux" => Some(".appimage"),
        _ => None,
    };
    if let Some(p) = preferido {
        if let Some(a) = candidatos
            .iter()
            .find(|a| a.name.to_ascii_lowercase().contains(p))
        {
            return Some(a);
        }
    }
    candidatos.sort_by(|a, b| a.name.cmp(&b.name));
    candidatos.first().copied()
}

/// Cliente estrito para download: cada redirect é revalidado contra a
/// allowlist (o cliente padrão seguiria qualquer Location).
pub fn download_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(format!("DisTorrent/{}", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(120))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("redirects demais");
            }
            let url = attempt.url().as_str().to_string();
            if url_allowed(&url) {
                attempt.follow()
            } else {
                attempt.error(format!("redirect para host não permitido: {url}"))
            }
        }))
        .build()
        .map_err(|e| format!("cliente HTTP: {e}"))
}

#[tauri::command]
pub async fn update_download(app: tauri::AppHandle, name: String) -> Result<String, String> {
    use sha2::{Digest as _, Sha256};

    let store = open_store(&app)?;
    let raw = store
        .kv_get(KV_PENDING)
        .ok_or("nenhuma atualização verificada — rode a checagem de novo")?;
    let pending: PendingUpdate =
        serde_json::from_str(&raw).map_err(|_| "registro de atualização corrompido".to_string())?;
    if name != pending.asset_name {
        return Err("asset pedido não corresponde ao manifesto verificado".into());
    }
    let platform = platform_tag();
    let lower_name = pending.asset_name.to_ascii_lowercase();
    if !accepted_ext(platform)
        .iter()
        .any(|e| lower_name.ends_with(e))
    {
        return Err(format!("extensão de instalador não aceita: {name}"));
    }
    let file_name = std::path::Path::new(&pending.asset_name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "nome de arquivo inválido".to_string())?
        .to_string();
    if file_name != pending.asset_name {
        return Err("nome de arquivo inválido".into());
    }

    let trust = load_trust(&store);
    if !trust.verification_available() {
        return Err("sem chaves de confiança: download recusado".into());
    }
    if pending.security_epoch < trust.epoch_floor() {
        return Err(
            "o manifesto em cache ficou atrás da época de segurança — checagem nova necessária"
                .into(),
        );
    }

    // A URL vem do manifesto verificado, não da UI.
    let manifest = trust
        .latest_verified()
        .filter(|v| v.manifest_hash == pending.manifest_hash)
        .map(|v| v.manifest.clone())
        .ok_or("o manifesto verificado não está mais em cache — rode a checagem de novo")?;
    let asset = manifest
        .body
        .assets
        .iter()
        .find(|a| a.name == pending.asset_name)
        .cloned()
        .ok_or("asset não consta no manifesto verificado")?;
    if asset.sha256 != pending.sha256 || asset.size != pending.size {
        return Err("o manifesto mudou entre a checagem e o download — refaça a checagem".into());
    }
    if !url_allowed(&asset.url) {
        return Err("URL do instalador fora dos hosts permitidos".into());
    }
    if asset.size == 0 || asset.size > MAX_INSTALLER_BYTES {
        return Err("tamanho de instalador fora do limite".into());
    }

    let dir = updates_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("criar pasta de updates: {e}"))?;
    let final_path = dir.join(&file_name);
    let part_path = dir.join(format!("{file_name}.part"));
    let _ = std::fs::remove_file(&part_path);

    let client = download_client()?;
    let mut stream = client
        .get(&asset.url)
        .send()
        .await
        .map_err(|e| format!("falha ao baixar o instalador: {e}"))?;
    if !stream.status().is_success() {
        return Err(format!(
            "download recusado pelo GitHub ({})",
            stream.status().as_u16()
        ));
    }
    if let Some(len) = stream.content_length() {
        if len != asset.size {
            return Err(format!(
                "o GitHub anunciou {len} bytes, o manifesto assinado diz {} — recusado",
                asset.size
            ));
        }
    }

    let mut hasher = Sha256::new();
    let mut total: u64 = 0;
    let mut file =
        std::fs::File::create(&part_path).map_err(|e| format!("criar arquivo de download: {e}"))?;
    loop {
        match stream.chunk().await {
            Ok(Some(chunk)) => {
                use std::io::Write as _;
                total = total.saturating_add(chunk.len() as u64);
                if total > asset.size {
                    drop(file);
                    let _ = std::fs::remove_file(&part_path);
                    return Err("download maior que o manifesto — descartado".into());
                }
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

    if total != asset.size {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "download incompleto ({total} de {} bytes) — arquivo descartado",
            asset.size
        ));
    }
    let got = hex::encode(hasher.finalize());
    if !got.eq_ignore_ascii_case(&asset.sha256) {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "o instalador baixado não confere com o hash do manifesto (esperado {}, obtido {got}) — arquivo descartado",
            asset.sha256
        ));
    }
    // Renomeação atômica só depois da validação.
    std::fs::rename(&part_path, &final_path).map_err(|e| format!("finalizar download: {e}"))?;
    let registrado = PendingUpdate {
        path: final_path.to_string_lossy().to_string(),
        ..pending
    };
    store
        .kv_set(
            KV_PENDING,
            &serde_json::to_string(&registrado).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("não consegui registrar o instalador baixado: {e}"))?;
    Ok(final_path.to_string_lossy().to_string())
}
