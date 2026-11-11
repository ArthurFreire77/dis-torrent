// Updater checks: parte de updater.rs.
// Irmao do updater.rs; usa os tipos la declarados via super::*.

use super::updater_version::{compare_version_strings, escolher, mesma_versao, releases_all};
use super::*;

pub fn current_version(app: &tauri::AppHandle) -> String {
    app.config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

#[tauri::command]
pub async fn update_check(
    app: tauri::AppHandle,
    force: Option<bool>,
    boot: Option<bool>,
) -> Result<UpdateInfo, String> {
    let current = current_version(&app);
    let store = open_store(&app)?;
    let mut trust = load_trust(&store);
    let platform = platform_tag();
    let arch = arch_tag();

    let now = distorrent_core::identity::now_ms();
    let last = store
        .kv_get(KV_LAST_CHECK)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let backoff = store
        .kv_get(KV_BACKOFF)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    // Regra do dono: "sempre que o app abrir, atualiza". O boot e o botão
    // "Verificar agora" IGNORAM o intervalo e o backoff; só a checagem de
    // rotina (a cada 30 min com o app aberto) respeita a janela para não
    // martelar o GitHub.
    let forcar = force.unwrap_or(false) || boot.unwrap_or(false);
    let espera = MIN_CHECK_INTERVAL_MS.max(backoff);
    let dentro_da_janela = !forcar && last > 0 && now.saturating_sub(last) < espera;
    if dentro_da_janela {
        // Dentro da janela: se o cache já aponta uma versão MAIOR que a
        // instalada, responde na hora (não gasta rede). Se o cache diz "nada
        // novo" ou não existe, cai na checagem real abaixo — era esse o bug do
        // "reabri e não atualizou": o cache congelava a resposta por 6 h.
        let cached = releases_all(&store);
        let cache_tem_nova = cached
            .iter()
            .filter(|r| !r.draft)
            .filter_map(|r| {
                let v = r.tag_name.trim_start_matches('v');
                (compare_version_strings(v, &current) == std::cmp::Ordering::Greater).then_some(v)
            })
            .max_by(|a, b| compare_version_strings(a, b));
        if cache_tem_nova.is_some() {
            return completar(
                &app, &store, &mut trust, cached, &current, platform, arch, true,
            )
            .await;
        }
    }

    let client = http_client()?;
    let mut req = client
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json");
    if let Some(etag) = store.kv_get(KV_ETAG) {
        if !etag.is_empty() && !forcar {
            req = req.header("If-None-Match", etag);
        }
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = store.kv_set(KV_BACKOFF, &proximo_backoff(backoff).to_string());
            let cached = releases_all(&store);
            if !cached.is_empty() {
                return completar(
                    &app, &store, &mut trust, cached, &current, platform, arch, true,
                )
                .await;
            }
            return Err(format!("sem conexão com o GitHub: {e}"));
        }
    };
    if res.status().as_u16() == 304 {
        let cached = releases_all(&store);
        let _ = store.kv_set(KV_LAST_CHECK, &now.to_string());
        let _ = store.kv_set(KV_BACKOFF, "0");
        return completar(
            &app, &store, &mut trust, cached, &current, platform, arch, true,
        )
        .await;
    }
    if !res.status().is_success() {
        let _ = store.kv_set(KV_BACKOFF, &proximo_backoff(backoff).to_string());
        return Err(format!(
            "GitHub respondeu {} ao procurar a release mais nova",
            res.status().as_u16()
        ));
    }
    if let Some(etag) = res.headers().get("etag").and_then(|v| v.to_str().ok()) {
        let _ = store.kv_set(KV_ETAG, etag);
    }
    let bytes = res.bytes().await.map_err(|e| format!("resposta: {e}"))?;
    let releases: Vec<GhRelease> = serde_json::from_slice(&bytes)
        .map_err(|e| format!("resposta do GitHub em formato inesperado: {e}"))?;
    cache_releases(&store, &releases);
    let _ = store.kv_set(KV_LAST_CHECK, &now.to_string());
    let _ = store.kv_set(KV_BACKOFF, "0");
    completar(
        &app, &store, &mut trust, releases, &current, platform, arch, false,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn completar(
    app: &tauri::AppHandle,
    store: &Arc<Store>,
    trust: &mut ReleaseTrust,
    releases: Vec<GhRelease>,
    current: &str,
    platform: &str,
    arch: &str,
    from_cache: bool,
) -> Result<UpdateInfo, String> {
    let escolha = escolher(app, store, trust, releases, current, platform, arch).await?;
    let verified = &escolha.verified;
    let body = &verified.manifest.body;
    let asset = &escolha.asset;

    let rotulo = version_in_asset_name(&asset.name);
    // O rótulo do arquivo tem só o núcleo ("1.1.70"); o manifesto diz
    // "1.1.70-pre-alpha". Comparar por igualdade acusava TODA release.
    let label_mismatch = !rotulo.is_empty() && !mesma_versao(&rotulo, &body.version);

    let self_integrity = distorrent_core::net::release_trust::self_integrity(store);
    let digests = format!("sha256:{}", asset.sha256);
    if let Some(gh) = escolha.release.assets.iter().find(|a| a.name == asset.name) {
        if let Some(d) = &gh.digest {
            if !d.is_empty() && !d.eq_ignore_ascii_case(&digests) {
                return Err(format!(
                    "o digest do GitHub para {} não bate com o manifesto assinado — download adulterado ou asset trocado",
                    asset.name
                ));
            }
        }
        if gh.size != asset.size {
            return Err(format!(
                "o tamanho do asset {} no GitHub ({}) não bate com o manifesto ({})",
                asset.name, gh.size, asset.size
            ));
        }
    } else {
        return Err(format!(
            "o manifesto cita {} mas a release não publicou esse arquivo",
            asset.name
        ));
    }

    let info = UpdateInfo {
        current: current.to_string(),
        latest: body.version.clone(),
        asset_name: asset.name.clone(),
        asset_size: asset.size,
        download_url: asset.url.clone(),
        digest: digests,
        notes: release_notes(&escolha.release),
        html_url: escolha.release.html_url.clone(),
        platform: platform.to_string(),
        label_mismatch,
        asset_version: rotulo,
        verified: true,
        manifest_hash: verified.manifest_hash.clone(),
        security_epoch: body.security_epoch,
        valid_signatures: verified.valid_signatures,
        trust_epoch: verified.trust_epoch,
        commit: body.commit.clone(),
        channel: body.channel.clone(),
        self_integrity: match self_integrity {
            release::SelfIntegrityState::Confere => "CONFERE",
            release::SelfIntegrityState::Diverge => "DIVERGE",
            release::SelfIntegrityState::Unavailable => "UNAVAILABLE",
        }
        .into(),
        verification_available: trust.verification_available(),
        verification_note: if from_cache {
            "manifesto verificado em cache".into()
        } else {
            verified.reason.clone()
        },
    };

    // Preserva o `path` de um download já verificado: zerar aqui fazia o apply
    // recusar o instalador sempre que uma checagem rodasse no meio do fluxo.
    let mut caminho_existente = store
        .kv_get(KV_PENDING)
        .and_then(|raw| serde_json::from_str::<PendingUpdate>(&raw).ok())
        .filter(|p| {
            p.version == body.version
                && p.manifest_hash == verified.manifest_hash
                && p.asset_name == asset.name
                && p.sha256 == asset.sha256
        })
        .map(|p| p.path)
        .unwrap_or_default();
    if !caminho_existente.is_empty() && !std::path::Path::new(&caminho_existente).is_file() {
        caminho_existente.clear();
    }

    if let Ok(raw) = serde_json::to_string(&PendingUpdate {
        asset_name: asset.name.clone(),
        sha256: asset.sha256.clone(),
        size: asset.size,
        version: body.version.clone(),
        manifest_hash: verified.manifest_hash.clone(),
        security_epoch: body.security_epoch,
        path: caminho_existente,
    }) {
        if let Err(e) = store.kv_set(KV_PENDING, &raw) {
            return Err(format!(
                "não consegui registrar a atualização pendente: {e}"
            ));
        }
    }
    let _ = app.emit("distorrent://update", &info);
    Ok(info)
}
