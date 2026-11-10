// Importação de bot por .zip.
// O nome de cada entrada NUNCA escolhe o destino: só componentes normais e
// sempre dentro da pasta de destino (guardas contra zip-slip).

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// Tetos: entradas, total descompactado e por arquivo.
pub const MAX_ENTRIES: usize = 1000;
pub const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
pub const MAX_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_NAME_CHARS: usize = 300;
const ZIP_MAGIC: [u8; 4] = [b'P', b'K', 3, 4];

/// Extrai `zip_path` dentro de `dest_root` e devolve a pasta que contém o bot.
/// A pasta é privada do app e é mantida para o plugin rodar dela depois.
pub fn extract_bot_zip(zip_path: &Path, dest_root: &Path) -> Result<PathBuf, String> {
    let file_name = zip_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !file_name.ends_with(".zip") {
        return Err("o arquivo do bot precisa terminar em .zip".into());
    }
    let mut head =
        std::fs::File::open(zip_path).map_err(|e| format!("não consegui abrir o .zip: {e}"))?;
    let mut magic = [0u8; 4];
    head.read_exact(&mut magic)
        .map_err(|_| "arquivo vazio ou ilegível (não é um .zip)".to_string())?;
    if magic != ZIP_MAGIC {
        return Err("arquivo não é um ZIP (assinatura inválida)".into());
    }
    drop(head);

    std::fs::create_dir_all(dest_root)
        .map_err(|e| format!("não consegui criar a pasta de importação: {e}"))?;
    let root = dest_root
        .canonicalize()
        .map_err(|e| format!("pasta de importação inválida: {e}"))?;

    let file =
        std::fs::File::open(zip_path).map_err(|e| format!("não consegui abrir o .zip: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("ZIP inválido ou corrompido: {e}"))?;
    if archive.len() > MAX_ENTRIES {
        return Err(format!("ZIP com arquivos demais (máx {MAX_ENTRIES})"));
    }

    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("entrada {index} ilegível: {e}"))?;
        let raw_name = entry.name().to_string();
        if entry.is_symlink() {
            return Err(format!("ZIP contém link simbólico, recusado: {raw_name}"));
        }
        let rel = safe_relative(&raw_name)?;
        let target = root.join(&rel);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)
                .map_err(|e| format!("não consegui criar a pasta {raw_name}: {e}"))?;
            continue;
        }
        if entry.size() > MAX_ENTRY_BYTES {
            return Err(format!("arquivo grande demais no ZIP: {raw_name}"));
        }
        let parent = target
            .parent()
            .ok_or_else(|| format!("caminho inválido no ZIP: {raw_name}"))?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("não consegui criar a pasta de {raw_name}: {e}"))?;
        // Um link no meio do caminho não pode fazer o destino escapar da raiz.
        let real_parent = parent
            .canonicalize()
            .map_err(|e| format!("pasta de {raw_name} ilegível: {e}"))?;
        if !real_parent.starts_with(&root) {
            return Err(format!("caminho fora da pasta de importação: {raw_name}"));
        }
        if target.exists() {
            return Err(format!("ZIP com entradas duplicadas: {raw_name}"));
        }
        let mut out = std::fs::File::create(&target)
            .map_err(|e| format!("não consegui escrever {raw_name}: {e}"))?;
        // O tamanho declarado no cabeçalho não é confiável: copia com teto.
        let copied = std::io::copy(&mut entry.by_ref().take(MAX_ENTRY_BYTES + 1), &mut out)
            .map_err(|e| format!("falha ao extrair {raw_name}: {e}"))?;
        if copied > MAX_ENTRY_BYTES {
            let _ = std::fs::remove_file(&target);
            return Err(format!("arquivo grande demais no ZIP: {raw_name}"));
        }
        total = total.saturating_add(copied);
        if total > MAX_TOTAL_BYTES {
            return Err(format!(
                "ZIP grande demais depois de extrair (máx {} MB)",
                MAX_TOTAL_BYTES / (1024 * 1024)
            ));
        }
    }
    Ok(find_bot_root(&root))
}

/// Um ZIP do GitHub traz tudo dentro de uma pasta; o `bot.json` pode estar na
/// raiz ou num único nível abaixo.
pub fn find_bot_root(root: &Path) -> PathBuf {
    if has_manifest(root) {
        return root.to_path_buf();
    }
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && !path.is_symlink() && has_manifest(&path) {
                return path;
            }
        }
    }
    root.to_path_buf()
}

fn has_manifest(dir: &Path) -> bool {
    if dir.join("bot.json").is_file() {
        return true;
    }
    std::fs::read_dir(dir)
        .map(|mut it| {
            it.any(|e| {
                e.ok()
                    .and_then(|e| e.file_name().to_str().map(|n| n.ends_with(".bot.json")))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

/// Só aceita componentes normais: nada de `..`, absoluto, prefixo de unidade
/// ou nome vazio — é isto que impede a extração de escrever fora da pasta.
fn safe_relative(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() || raw.chars().count() > MAX_NAME_CHARS {
        return Err("ZIP com nome de arquivo vazio ou longo demais".into());
    }
    if raw.contains('\0') {
        return Err("ZIP com nome de arquivo inválido".into());
    }
    let mut out = PathBuf::new();
    for comp in Path::new(raw).components() {
        match comp {
            Component::Normal(part) => {
                let text = part.to_string_lossy();
                if text.contains(':') {
                    return Err(format!("caminho inválido no ZIP: {raw}"));
                }
                out.push(part);
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("caminho fora da pasta de importação: {raw}"));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("ZIP com nome de arquivo vazio".into());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TempDir(PathBuf);

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tempdir(tag: &str) -> TempDir {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "distorrent-botzip-{tag}-{}-{n}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("tmp");
        TempDir(dir)
    }

    fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
        let file = std::fs::File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn zip_normal_e_extraido_dentro_da_pasta() {
        let tmp = tempdir("ok");
        let zip_path = tmp.0.join("bot.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "bot.json",
                    br#"{"name":"ZipBot","config":{"commands":[{"name":"ping","reply":"pong"}]}}"#,
                ),
                ("bot.js", b"// codigo"),
            ],
        );
        let dest = tmp.0.join("out");
        let root = extract_bot_zip(&zip_path, &dest).unwrap();
        assert!(root.join("bot.json").is_file());
        assert!(root.join("bot.js").is_file());
    }

    #[test]
    fn zip_com_parent_dir_e_recusado_e_nao_escreve_fora() {
        let tmp = tempdir("slip");
        let zip_path = tmp.0.join("evil.zip");
        write_zip(&zip_path, &[("../evil.txt", b"pwned")]);
        let dest = tmp.0.join("out");
        let erro = extract_bot_zip(&zip_path, &dest).unwrap_err();
        assert!(erro.contains("fora da pasta"), "{erro}");
        assert!(!tmp.0.join("evil.txt").exists(), "arquivo escapou da pasta");
    }

    #[test]
    fn zip_com_caminho_absoluto_e_recusado() {
        let tmp = tempdir("abs");
        let zip_path = tmp.0.join("abs.zip");
        write_zip(&zip_path, &[("/abs/tmp/evil.txt", b"x")]);
        let dest = tmp.0.join("out");
        let erro = extract_bot_zip(&zip_path, &dest).unwrap_err();
        assert!(erro.contains("fora da pasta"), "{erro}");
    }

    #[test]
    fn arquivo_que_nao_e_zip_e_recusado_pela_assinatura() {
        let tmp = tempdir("magic");
        let zip_path = tmp.0.join("fake.zip");
        std::fs::write(&zip_path, b"isto nao e um zip").unwrap();
        let erro = extract_bot_zip(&zip_path, &tmp.0.join("out")).unwrap_err();
        assert!(erro.contains("ZIP"), "{erro}");
    }

    #[test]
    fn extensao_diferente_de_zip_e_recusada() {
        let tmp = tempdir("ext");
        let zip_path = tmp.0.join("bot.tar");
        write_zip(&zip_path, &[("bot.json", b"{}")]);
        let erro = extract_bot_zip(&zip_path, &tmp.0.join("out")).unwrap_err();
        assert!(erro.contains(".zip"), "{erro}");
    }

    #[test]
    fn pasta_com_bot_json_dentro_de_uma_subpasta_e_encontrada() {
        let tmp = tempdir("nested");
        let zip_path = tmp.0.join("bot.zip");
        write_zip(
            &zip_path,
            &[
                (
                    "meu-bot/bot.json",
                    br#"{"name":"Aninhado","config":{"commands":[{"name":"oi","reply":"ola"}]}}"#,
                ),
                ("meu-bot/bot.js", b"// codigo"),
            ],
        );
        let dest = tmp.0.join("out");
        let root = extract_bot_zip(&zip_path, &dest).unwrap();
        assert_eq!(root.file_name().unwrap(), "meu-bot");
        assert!(root.join("bot.json").is_file());
    }

    #[test]
    fn caminho_com_dois_pontos_e_recusado() {
        assert!(safe_relative("a:b.txt").is_err());
        assert!(safe_relative("ok/arquivo.txt").is_ok());
    }
}
