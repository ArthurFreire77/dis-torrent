use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::Emitter as _;

use distorrent_core::net::release_trust::StoreKv;
use distorrent_core::release::{
    self, ManifestAsset, ReleaseStatus, ReleaseTrust, SignedManifest, VerifiedManifest,
};
use distorrent_core::storage::Store;

#[allow(dead_code)]
const REPO: &str = "ArthurFreire77/dis-torrent";
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
const MIN_CHECK_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
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

/// Um asset só é aceito se estiver descrito no manifesto assinado. Esta função
/// não "descobre" nada por conta própria — ela filtra a lista assinada.
fn pick_manifest_asset<'a>(
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
    // Preferências que existem hoje na publicação: setup do Windows, arm64 do
    // Android, AppImage antes de .deb no Linux. Todas dentro do manifesto.
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
    // Release asset tem de ser do repositório oficial OU do CDN que o GitHub
    // usa para servir os assets desse repositório.
    let path = parsed.path();
    if host == "github.com" {
        return path.starts_with("/ArthurFreire77/dis-torrent/releases/download/");
    }
    if host == "api.github.com" {
        return path.starts_with("/repos/ArthurFreire77/dis-torrent/releases");
    }
    true
}

/// Cliente estrito para download: cada redirect é revalidado contra a
/// allowlist (o cliente padrão seguiria qualquer Location).
fn download_client() -> Result<reqwest::Client, String> {
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

fn current_version(app: &tauri::AppHandle) -> String {
    app.config()
        .version
        .clone()
        .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string())
}

async fn fetch_manifest(client: &reqwest::Client, asset: &GhAsset) -> Result<Vec<u8>, String> {
    if asset.size == 0 || asset.size > MAX_MANIFEST_DOWNLOAD {
        return Err("manifesto de release com tamanho fora do limite".into());
    }
    if !url_allowed(&asset.browser_download_url) {
        return Err("manifesto aponta para host não permitido".into());
    }
    let mut resp = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|e| format!("download do manifesto: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub recusou o manifesto ({})",
            resp.status().as_u16()
        ));
    }
    let mut out: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(c)) => {
                out.extend_from_slice(&c);
                if out.len() as u64 > MAX_MANIFEST_DOWNLOAD {
                    return Err("manifesto passou do limite durante o download".into());
                }
            }
            Ok(None) => break,
            Err(e) => return Err(format!("download do manifesto interrompido: {e}")),
        }
    }
    Ok(out)
}

fn release_notes(release: &GhRelease) -> String {
    if release.body.trim().is_empty() {
        release.name.clone()
    } else {
        release.body.clone()
    }
}

/// Resultado interno da checagem, antes de virar `UpdateInfo`.
struct Escolha {
    release: GhRelease,
    verified: VerifiedManifest,
    asset: ManifestAsset,
}

/// Percorre as releases mais novas até achar uma cujo manifesto assine 2-de-3
/// e publique um artefato para esta plataforma/arquitetura.
async fn escolher(
    _app: &tauri::AppHandle,
    store: &Arc<Store>,
    trust: &mut ReleaseTrust,
    releases: Vec<GhRelease>,
    current: &str,
    platform: &str,
    arch: &str,
) -> Result<Escolha, String> {
    let mut releases: Vec<GhRelease> = releases.into_iter().filter(|r| !r.draft).collect();
    if releases.is_empty() {
        return Err("nenhuma release publicada no repositório".into());
    }
    releases.sort_by(|a, b| {
        compare_version_strings(&b.tag_name, &a.tag_name).then_with(|| b.tag_name.cmp(&a.tag_name))
    });
    releases.truncate(RELEASES_PAGE_CAP);

    // Se o conjunto de confiança não está disponível, não existe "verificado":
    // a mensagem precisa ser honesta em vez de oferecer instalador sem prova.
    if !trust.verification_available() {
        return Err(trust
            .unavailable_reason()
            .unwrap_or("este build não tem chaves de confiança de release")
            .to_string());
    }

    let client = http_client()?;
    let kv = StoreKv(Arc::clone(store));
    let mut candidatas = releases
        .into_iter()
        .filter(|r| {
            let v = r.tag_name.trim_start_matches('v');
            compare_version_strings(v, current) == std::cmp::Ordering::Greater
        })
        .take(MANIFEST_PROBES)
        .collect::<Vec<_>>();

    // Se não há nada mais novo, ainda assim vale verificar a release ATUAL para
    // saber se ela foi revogada. (O usuário precisa saber disso.)
    if candidatas.is_empty() {
        candidatas = releases_all(store)
            .into_iter()
            .take(MANIFEST_PROBES)
            .collect();
        if candidatas.is_empty() {
            return Err("nenhuma release publicada no repositório".into());
        }
    }

    let mut ultimo_erro = String::from("nenhuma release com manifesto verificável");
    for release in candidatas {
        let Some(asset) = release.assets.iter().find(|a| a.name == MANIFEST_ASSET) else {
            ultimo_erro = format!(
                "a release {} não publicou {MANIFEST_ASSET} — não há como verificar a procedência",
                release.tag_name
            );
            continue;
        };
        let bytes = match fetch_manifest(&client, asset).await {
            Ok(b) => b,
            Err(e) => {
                ultimo_erro = e;
                continue;
            }
        };
        let signed = match SignedManifest::from_wire(&bytes) {
            Ok(s) => s,
            Err(e) => {
                ultimo_erro = format!("manifesto da release {} inválido: {e}", release.tag_name);
                continue;
            }
        };
        let verified = match trust.accept(&kv, &signed) {
            Ok(v) => v,
            Err(e) => {
                ultimo_erro = e.to_string();
                continue;
            }
        };
        match verified.status {
            ReleaseStatus::ReleaseVerificada => {}
            ReleaseStatus::Revogado => {
                ultimo_erro = format!(
                    "a release {} está REVOGADA pela autoridade — não será instalada",
                    release.tag_name
                );
                continue;
            }
            ReleaseStatus::Obsoleto => {
                ultimo_erro = format!(
                    "a release {} está abaixo da época mínima de segurança — downgrade recusado",
                    release.tag_name
                );
                continue;
            }
            ReleaseStatus::NaoVerificado => {
                ultimo_erro = format!(
                    "a release {} não tem assinaturas válidas suficientes ({})",
                    release.tag_name, verified.reason
                );
                continue;
            }
        }
        // O manifesto verificado manda na versão: a tag do GitHub não é fonte
        // de verdade, só onde o arquivo estava hospedado.
        if signed.body.version != release.tag_name.trim_start_matches('v') {
            ultimo_erro = format!(
                "manifesto da release {} declara versão {} — divergência recusada",
                release.tag_name, signed.body.version
            );
            continue;
        }
        let Some(chosen) = pick_manifest_asset(&signed.body.assets, platform, arch) else {
            ultimo_erro = format!(
                "o manifesto {} não publica instalador para {platform}/{arch}",
                signed.body.version
            );
            continue;
        };
        if !url_allowed(&chosen.url) {
            ultimo_erro = format!(
                "o manifesto {} aponta o instalador para um host não permitido",
                signed.body.version
            );
            continue;
        }
        return Ok(Escolha {
            release,
            verified,
            asset: chosen.clone(),
        });
    }
    Err(ultimo_erro)
}

// Cache em memória da última lista de releases (uma consulta por processo;
// `update_check` é chamado no boot e a cada 6 h).
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

fn releases_all(store: &Arc<Store>) -> Vec<GhRelease> {
    let Some(raw) = store.kv_get("update.releases_cache") else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Vec<serde_json::Value>>(&raw) else {
        return Vec::new();
    };
    v.into_iter()
        .filter_map(|r| {
            Some(GhRelease {
                tag_name: r.get("tag_name")?.as_str()?.to_string(),
                name: r
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                body: r
                    .get("body")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                html_url: r
                    .get("html_url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                draft: r.get("draft").and_then(|x| x.as_bool()).unwrap_or(false),
                assets: r
                    .get("assets")
                    .and_then(|x| x.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|a| {
                                Some(GhAsset {
                                    name: a.get("name")?.as_str()?.to_string(),
                                    size: a.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
                                    browser_download_url: a
                                        .get("browser_download_url")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("")
                                        .to_string(),
                                    digest: a
                                        .get("digest")
                                        .and_then(|x| x.as_str())
                                        .map(|s| s.to_string()),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    let current = current_version(&app);
    let store = open_store(&app)?;
    let mut trust = load_trust(&store);
    let platform = platform_tag();
    let arch = arch_tag();

    // Controle de frequência: só consulta o GitHub se passou o intervalo, a
    // menos que seja o boot (last_check ausente). Backoff em falha.
    let now = distorrent_core::identity::now_ms();
    let last = store
        .kv_get(KV_LAST_CHECK)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let backoff = store
        .kv_get(KV_BACKOFF)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let espera = MIN_CHECK_INTERVAL_MS.max(backoff);
    if last > 0 && now.saturating_sub(last) < espera {
        // Dentro da janela: usa o cache de releases e o manifesto já
        // verificado, sem tocar na rede.
        let cached = releases_all(&store);
        if !cached.is_empty() {
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
        if !etag.is_empty() {
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

#[allow(clippy::too_many_arguments)]
async fn completar(
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

    // Arquivo rotulado com versão diferente da assinada: o manifesto manda,
    // mas o usuário merece saber. Nunca é usado para "corrigir" a versão.
    let rotulo = version_in_asset_name(&asset.name);
    let label_mismatch = !rotulo.is_empty() && rotulo != body.version;

    let self_integrity = distorrent_core::net::release_trust::self_integrity(store);
    let digests = format!("sha256:{}", asset.sha256);
    // O digest do GitHub é auxiliar: se existir e divergir do manifesto
    // assinado, isso é sinal de adulteração no caminho, e o update é recusado.
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

    // Se ainda não é mais nova, devolve o estado atual verificado (a UI mostra
    // "você está na mais nova" com procedência comprovada).
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

    // Persiste o que `update_download` vai precisar. Sem este registro, baixar
    // é impossível — é o que impede a UI de pedir um arquivo qualquer.
    if let Ok(raw) = serde_json::to_string(&PendingUpdate {
        asset_name: asset.name.clone(),
        sha256: asset.sha256.clone(),
        size: asset.size,
        version: body.version.clone(),
        manifest_hash: verified.manifest_hash.clone(),
        security_epoch: body.security_epoch,
        path: String::new(),
    }) {
        let _ = store.kv_set(KV_PENDING, &raw);
    }
    let _ = app.emit("distorrent://update", &info);
    Ok(info)
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
    // O nome vem da UI, mas só é aceito se for EXATAMENTE o que está no
    // manifesto já verificado. Trocar nome/URL/hash é impossível daqui.
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
    // Regrava o registro com o caminho absoluto e o hash conferido. `apply`
    // revalida o arquivo contra este registro.
    let registrado = PendingUpdate {
        path: final_path.to_string_lossy().to_string(),
        ..pending
    };
    let _ = store.kv_set(
        KV_PENDING,
        &serde_json::to_string(&registrado).map_err(|e| e.to_string())?,
    );
    Ok(final_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn update_verify_ready(app: tauri::AppHandle, path: String) -> Result<PendingUpdate, String> {
    verify_before_apply(&app, &path)
}

/// Revalida o instalador imediatamente antes de executar.
///
/// Cobre: arquivo trocado depois do download, symlink apontando para fora da
/// pasta, hash que não bate, manifesto que expirou (época) e caminho fora da
/// pasta de updates.
fn verify_before_apply(app: &tauri::AppHandle, path: &str) -> Result<PendingUpdate, String> {
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
        // `cmd /C start "" <url>` passa pela linha de comando do cmd, que trata
        // `&` como separador: qualquer link com query (`?a=1&b=2`) abria o
        // navegador pela metade ou não abria. ShellExecuteW recebe a URL crua,
        // sem shell no meio.
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
pub fn update_apply(app: tauri::AppHandle, path: String) -> Result<(), String> {
    // A validação FINAL é aqui: caminho, symlink, tamanho, hash e manifesto.
    // Sem ela o instalador não roda, mesmo que a UI insista.
    let pending = verify_before_apply(&app, &path)?;
    // `pending` prova que ESTE caminho/hash veio do manifesto verificado.
    // Plataformas que delegam a instalação não leem os campos, mas a
    // verificação acima já aconteceu — não é um valor "ignorado por engano".
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
        // Instalação por usuário: se o app está em Program Files, o Inno
        // silencioso precisaria de UAC. Recusar é melhor que pedir admin.
        match instalação_por_usuario() {
            Ok(true) => {}
            Ok(false) => {
                return Err(
                    "esta instalação está em uma pasta do sistema (Program Files). \
                     A atualização automática sem administrador não é possível — \
                     baixe o instalador e execute manualmente."
                        .into(),
                )
            }
            Err(e) => return Err(e),
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
        // Sem referência de self-integrity nova: `pending.sha256` é o hash do
        // INSTALADOR, não do `distorrent.exe` que sai da instalação. Gravarlo
        // faria o próximo boot acusar DIVERGE sempre — mentira pior que
        // "UNAVAILABLE". A medição só vale quando existe o hash do executável
        // publicado como asset próprio no manifesto (ver docs/RELEASE_TRUST.md).
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
        // O APK já passou por hash + manifesto em `verify_before_apply`.
        // A comparação de certificado é feita no Kotlin antes de abrir o
        // instalador do sistema.
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

/// Windows: instalação por usuário vs. pasta do sistema.
#[cfg(target_os = "windows")]
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

    // ---------------------------------------------------------------------
    // Controles de URL (o caminho que um atacante tentaria)
    // ---------------------------------------------------------------------

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

    // ---------------------------------------------------------------------
    // Seleção de asset: só o que está no manifesto
    // ---------------------------------------------------------------------

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
