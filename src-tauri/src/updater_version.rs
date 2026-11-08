// Updater version: parte de updater.rs.
// Irmao do updater.rs; usa os tipos la declarados via super::*.

use super::*;

#[allow(dead_code)]
pub const REPO: &str = "ArthurFreire77/dis-torrent";

pub fn compare_version_strings(a: &str, b: &str) -> std::cmp::Ordering {
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

pub async fn fetch_manifest(client: &reqwest::Client, asset: &GhAsset) -> Result<Vec<u8>, String> {
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

/// Percorre as releases mais novas até achar uma cujo manifesto assine 2-de-3
/// e publique um artefato para esta plataforma/arquitetura.
pub async fn escolher(
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
        // O manifesto declara `1.1.65-pre-alpha`; a tag é `v1.1.65`. Comparar
        // por IGUALDADE recusava TODA release ("divergência de versão") e o
        // auto-update nunca funcionou. A tag é só onde o arquivo está
        // hospedado: o que vale é o núcleo N.N.N bater.
        if !mesma_versao(&signed.body.version, &release.tag_name) {
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

/// Compara versão do manifesto com a tag do GitHub pelo NÚCLEO (`N.N.N`).
///
/// A tag é limpa (`v1.1.65`) e o manifesto carrega o sufixo
/// (`1.1.65-pre-alpha`); exigir igualdade exata recusava todas as releases.
/// Também aceita `1.1.65-pre-alpha` × `1.1.65-pre-alpha` e diferenças de `v`.
pub fn mesma_versao(manifesto: &str, tag: &str) -> bool {
    fn nucleo(v: &str) -> String {
        v.trim()
            .trim_start_matches(['v', 'V'])
            .split('-')
            .next()
            .unwrap_or("")
            .trim()
            .to_string()
    }
    let a = nucleo(manifesto);
    !a.is_empty() && a == nucleo(tag)
}

pub fn releases_all(store: &Arc<Store>) -> Vec<GhRelease> {
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
