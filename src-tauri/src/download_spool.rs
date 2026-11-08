// Spool de downloads grandes: grava DIRETO no arquivo final `.part` dentro da
// pasta de destino, num offset por bloco. Escolhas e porquês:
//
// - um arquivo só (pré-alocado com `set_len`) em vez de um `.blk` por bloco:
//   no fim o rename é instantâneo, sem copiar 500 GB de novo;
// - offset em vez de append: os blocos chegam fora de ordem;
// - `set_len` antes de escrever: sem isso, escrever no offset 400 GB de um
//   arquivo vazio faria o NTFS materializar centenas de GB de zeros;
// - o bitmap fica no appdata (`<stem>.bits`) e é o que retoma após reiniciar.
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

use super::download_target::target_dir;
use super::*;

/// Mesmo tamanho usado pelo JS (`CHUNK` em fileRules.ts).
const CHUNK: u64 = 256 * 1024;
const SPOOL_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_SPOOL_BYTES: u64 = 500 * 1024 * 1024 * 1024;
const EXIF_STRIP_MAX: u64 = 32 * 1024 * 1024;

fn spool_root(state: &State<AppState>) -> PathBuf {
    state.data_dir.join("spool")
}

fn stem(file_id: &str) -> String {
    let h = distorrent_core::blake3::hash(file_id.as_bytes());
    hex::encode(&h.as_bytes()[..16])
}

fn bits_path(root: &Path, file_id: &str) -> PathBuf {
    root.join(format!("{}.bits", stem(file_id)))
}

fn meta_path(root: &Path, file_id: &str) -> PathBuf {
    root.join(format!("{}.json", stem(file_id)))
}

fn check_id(file_id: &str) -> Result<(), String> {
    if file_id.is_empty() || file_id.len() > 256 || file_id.contains('\0') {
        return Err("spool: file_id inválido".into());
    }
    Ok(())
}

fn chunks_for(size: u64) -> u32 {
    size.div_ceil(CHUNK).max(1) as u32
}

fn expected_len(size: u64, index: u32) -> u64 {
    let inicio = index as u64 * CHUNK;
    (size - inicio).min(CHUNK)
}

fn read_bits(root: &Path, file_id: &str, chunks: u32) -> Vec<u8> {
    let len = (chunks as usize).div_ceil(8);
    let mut buf = vec![0u8; len];
    if let Ok(mut f) = std::fs::File::open(bits_path(root, file_id)) {
        let _ = f.read_exact(&mut buf);
    }
    buf
}

fn count_bits(buf: &[u8]) -> u32 {
    buf.iter().map(|b| b.count_ones()).sum()
}

fn set_bit(root: &Path, file_id: &str, index: u32) -> Result<(), String> {
    let byte = index as u64 / 8;
    let mask = 1u8 << (index % 8);
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(bits_path(root, file_id))
        .map_err(|e| format!("spool: bitmap: {e}"))?;
    f.seek(SeekFrom::Start(byte))
        .map_err(|e| format!("spool: bitmap seek: {e}"))?;
    let mut cur = [0u8; 1];
    let lido = f.read(&mut cur).unwrap_or(0);
    let novo = if lido == 1 { cur[0] | mask } else { mask };
    if novo != cur[0] || lido == 0 {
        f.seek(SeekFrom::Start(byte))
            .map_err(|e| format!("spool: bitmap seek2: {e}"))?;
        f.write_all(&[novo])
            .map_err(|e| format!("spool: bitmap write: {e}"))?;
    }
    Ok(())
}

/// Metadados do spool: onde está o `.part` e qual o nome final.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SpoolMeta {
    path: String,
    size: u64,
    name: String,
}

fn read_meta(root: &Path, file_id: &str) -> Option<SpoolMeta> {
    let raw = std::fs::read_to_string(meta_path(root, file_id)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta(root: &Path, file_id: &str, meta: &SpoolMeta) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("spool: mkdir: {e}"))?;
    let json = serde_json::to_string(meta).map_err(|e| format!("spool: json: {e}"))?;
    std::fs::write(meta_path(root, file_id), json).map_err(|e| format!("spool: meta: {e}"))
}

fn remove_spool(root: &Path, file_id: &str) -> u64 {
    let mut freed = 0u64;
    if let Some(meta) = read_meta(root, file_id) {
        if let Ok(md) = std::fs::metadata(&meta.path) {
            freed += md.len();
        }
        let _ = std::fs::remove_file(&meta.path);
    }
    for p in [bits_path(root, file_id), meta_path(root, file_id)] {
        if let Ok(md) = std::fs::metadata(&p) {
            freed += md.len();
        }
        let _ = std::fs::remove_file(&p);
    }
    freed
}

fn safe_name(name: &str) -> Result<String, String> {
    let safe = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "spool: nome de arquivo inválido".to_string())?
        .to_string();
    if safe.is_empty()
        || safe.starts_with('.')
        || safe.contains('\\')
        || safe.contains('/')
        || safe.contains('\0')
        || safe.len() > 255
    {
        return Err("spool: nome de arquivo inválido (traversal bloqueado)".into());
    }
    Ok(safe)
}

#[derive(Debug, Serialize)]
pub(crate) struct SpoolBeginView {
    have: u32,
    bitmap_b64: String,
    /** Pasta onde o `.part` está sendo gravado (a UI mostra isso). */
    dir: String,
}

#[tauri::command]
pub(crate) fn spool_begin(
    app: AppHandle,
    file_id: String,
    size: u64,
    name: String,
    state: State<AppState>,
) -> Result<SpoolBeginView, String> {
    check_id(&file_id)?;
    if size == 0 || size > MAX_SPOOL_BYTES {
        return Err(format!(
            "spool: tamanho inválido ({} MB)",
            size / (1024 * 1024)
        ));
    }
    let safe = safe_name(&name)?;
    let root = spool_root(&state);
    std::fs::create_dir_all(&root).map_err(|e| format!("spool: criar pasta: {e}"))?;

    let chunks = chunks_for(size);
    let existente = read_meta(&root, &file_id);
    let meta = match existente {
        Some(m) if m.size == size && Path::new(&m.path).exists() => m,
        _ => {
            // Limpa resto de um anúncio diferente para o mesmo id.
            remove_spool(&root, &file_id);
            let dir = target_dir(&app, &state)?;
            std::fs::create_dir_all(&dir).map_err(|e| format!("spool: pasta de destino: {e}"))?;
            let part = dir.join(format!(".{safe}.{}.distorrent-part", stem(&file_id)));
            let f = std::fs::OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(true)
                .open(&part)
                .map_err(|e| format!("spool: criar .part em {}: {e}", dir.display()))?;
            // Pré-aloca sem zerar: evita materializar centenas de GB de zeros.
            f.set_len(size)
                .map_err(|e| format!("spool: reservar {size} bytes em {}: {e}", dir.display()))?;
            let meta = SpoolMeta {
                path: part.to_string_lossy().to_string(),
                size,
                name: safe.clone(),
            };
            write_meta(&root, &file_id, &meta)?;
            meta
        }
    };

    let bits = read_bits(&root, &file_id, chunks);
    Ok(SpoolBeginView {
        have: count_bits(&bits),
        bitmap_b64: general_purpose::STANDARD.encode(&bits),
        dir: Path::new(&meta.path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    })
}

#[tauri::command]
pub(crate) fn spool_put(
    file_id: String,
    index: u32,
    data_b64: String,
    size: u64,
    state: State<AppState>,
) -> Result<u32, String> {
    check_id(&file_id)?;
    let bytes = general_purpose::STANDARD
        .decode(data_b64.trim())
        .map_err(|e| format!("spool: base64 inválido: {e}"))?;
    put_one(&state, &file_id, index, bytes, size)?;
    Ok(index)
}

/// Lote de blocos numa chamada só: cada `spool_put` individual custa uma ida e
/// volta de IPC com base64; 8 blocos por chamada é ~8× menos overhead.
#[tauri::command]
pub(crate) fn spool_put_batch(
    file_id: String,
    size: u64,
    entries: Vec<(u32, String)>,
    state: State<AppState>,
) -> Result<u32, String> {
    check_id(&file_id)?;
    if entries.is_empty() {
        return Ok(0);
    }
    let mut escritos = 0u32;
    for (index, data_b64) in entries {
        let bytes = general_purpose::STANDARD
            .decode(data_b64.trim())
            .map_err(|e| format!("spool: base64 inválido (bloco {index}): {e}"))?;
        put_one(&state, &file_id, index, bytes, size)?;
        escritos += 1;
    }
    Ok(escritos)
}

fn put_one(
    state: &State<AppState>,
    file_id: &str,
    index: u32,
    bytes: Vec<u8>,
    size: u64,
) -> Result<(), String> {
    if size == 0 || size > MAX_SPOOL_BYTES {
        return Err("spool: tamanho inválido".into());
    }
    if index >= chunks_for(size) {
        return Err("spool: índice fora da faixa".into());
    }
    let esperado = expected_len(size, index) as usize;
    if bytes.len() != esperado {
        return Err(format!(
            "spool: bloco {index} com {} bytes (esperado {esperado})",
            bytes.len()
        ));
    }
    let root = spool_root(state);
    let meta = read_meta(&root, file_id)
        .ok_or_else(|| "spool: download não iniciado neste aparelho".to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .open(&meta.path)
        .map_err(|e| format!("spool: abrir .part: {e}"))?;
    f.seek(SeekFrom::Start(index as u64 * CHUNK))
        .map_err(|e| format!("spool: seek: {e}"))?;
    f.write_all(&bytes)
        .map_err(|e| format!("spool: write: {e}"))?;
    drop(f);
    set_bit(&root, file_id, index)
}

#[tauri::command]
pub(crate) fn spool_get(
    file_id: String,
    index: u32,
    size: u64,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    check_id(&file_id)?;
    if size == 0 || index >= chunks_for(size) {
        return Ok(None);
    }
    let root = spool_root(&state);
    let Some(meta) = read_meta(&root, &file_id) else {
        return Ok(None);
    };
    let mut f = match std::fs::File::open(&meta.path) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };
    let mut buf = vec![0u8; expected_len(size, index) as usize];
    f.seek(SeekFrom::Start(index as u64 * CHUNK))
        .map_err(|e| format!("spool: get seek: {e}"))?;
    if f.read_exact(&mut buf).is_err() {
        return Ok(None);
    }
    Ok(Some(general_purpose::STANDARD.encode(&buf)))
}

#[tauri::command]
pub(crate) fn spool_bitmap(
    file_id: String,
    size: u64,
    state: State<AppState>,
) -> Result<SpoolBeginView, String> {
    check_id(&file_id)?;
    let root = spool_root(&state);
    let chunks = chunks_for(size);
    let bits = read_bits(&root, &file_id, chunks);
    let dir = read_meta(&root, &file_id)
        .and_then(|m| {
            Path::new(&m.path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
        })
        .unwrap_or_default();
    Ok(SpoolBeginView {
        have: count_bits(&bits),
        bitmap_b64: general_purpose::STANDARD.encode(&bits),
        dir,
    })
}

fn hash_file(path: &Path) -> Result<String, String> {
    let f = std::fs::File::open(path).map_err(|e| format!("spool: abrir para hash: {e}"))?;
    let mut reader = std::io::BufReader::with_capacity(256 * 1024, f);
    let mut h = distorrent_core::blake3::Hasher::new();
    h.update_reader(&mut reader)
        .map_err(|e| format!("spool: hash: {e}"))?;
    Ok(h.finalize().to_hex().to_string())
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], Some(&name[i..])),
        _ => (name, None),
    };
    for n in 1..1000 {
        let cand = match ext {
            Some(e) => dir.join(format!("{stem} ({n}){e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !cand.exists() {
            return cand;
        }
    }
    first
}

#[tauri::command]
pub(crate) fn spool_finish(
    app: AppHandle,
    file_id: String,
    name: String,
    size: u64,
    expect_blake3: Option<String>,
    state: State<AppState>,
) -> Result<String, String> {
    check_id(&file_id)?;
    let safe = safe_name(&name)?;
    let root = spool_root(&state);
    let meta = read_meta(&root, &file_id)
        .ok_or_else(|| "spool: download não iniciado neste aparelho".to_string())?;
    let path = PathBuf::from(&meta.path);
    let chunks = chunks_for(size);
    let bits = read_bits(&root, &file_id, chunks);
    if count_bits(&bits) != chunks {
        return Err(format!(
            "spool: faltam blocos ({}/{} recebidos)",
            count_bits(&bits),
            chunks
        ));
    }
    let md = std::fs::metadata(&path).map_err(|e| format!("spool: arquivo .part: {e}"))?;
    if md.len() != size {
        return Err(format!(
            "spool: arquivo com {} bytes (anunciado {size})",
            md.len()
        ));
    }

    let store = open_store(&state)?;
    let safety = media_safety_read(&store);
    if safety.block_executables && distorrent_core::media::extension_is_blocked(&safe) {
        remove_spool(&root, &file_id);
        return Err("spool bloqueou: extensão de executável/script recebida por P2P — risco de malware. Desligue o bloqueio em Configurações → Cofre & Backup → Mídia se tiver certeza.".into());
    }

    if let Some(esperado) = expect_blake3
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let real = hash_file(&path)?;
        // O hash anunciado pode vir truncado (32 hex): compara só o prefixo.
        let n = esperado.len().min(real.len());
        if !real[..n].eq_ignore_ascii_case(&esperado[..n]) {
            if let Ok(mut f) = std::fs::OpenOptions::new().write(true).open(&path) {
                let _ = f.set_len(0);
            }
            let _ = std::fs::remove_file(&path);
            remove_spool(&root, &file_id);
            return Err(format!(
                "arquivo corrompido: o hash não bate (esperado {esperado}, recebido {real}). Baixe de novo."
            ));
        }
    }

    if safety.block_executables && size > 0 {
        let mut head = vec![0u8; 4096];
        if let Ok(mut f) = std::fs::File::open(&path) {
            let n = f.read(&mut head).unwrap_or(0);
            head.truncate(n);
        }
        let sniffed = distorrent_core::media::sniff_mime(&head);
        if sniffed.is_executable() {
            let _ = std::fs::remove_file(&path);
            remove_spool(&root, &file_id);
            return Err(format!(
                "spool bloqueou: executável recebido por P2P (tipo real: {}) — risco de malware.",
                sniffed.as_str()
            ));
        }
    }

    // EXIF só em imagem pequena: privacidade sem reler 500 GB.
    if safety.strip_exif && size <= EXIF_STRIP_MAX {
        if let Ok(mut f) = std::fs::File::open(&path) {
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
                if let Ok(all) = std::fs::read(&path) {
                    if let Ok(clean) = distorrent_core::media::strip_metadata(&all) {
                        let _ = std::fs::write(&path, &clean);
                    }
                }
            }
        }
    }

    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    // O `.part` já está na pasta de destino: este rename não copia bytes.
    let dest = unique_path(&dir, &safe);
    std::fs::rename(&path, &dest).map_err(|e| format!("spool: renomear: {e}"))?;
    let _ = std::fs::remove_file(bits_path(&root, &file_id));
    let _ = std::fs::remove_file(meta_path(&root, &file_id));

    #[cfg(target_os = "android")]
    {
        let name = dest
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&safe)
            .to_string();
        return super::commands_files::save_public_copy(
            app,
            dest.to_string_lossy().to_string(),
            name,
        );
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = &app;
        Ok(dest.to_string_lossy().to_string())
    }
}

#[tauri::command]
pub(crate) fn spool_discard(file_id: String, state: State<AppState>) -> Result<(), String> {
    check_id(&file_id)?;
    remove_spool(&spool_root(&state), &file_id);
    Ok(())
}

#[derive(Debug, Serialize)]
pub(crate) struct SpoolStatsView {
    bytes: u64,
    entries: usize,
}

#[tauri::command]
pub(crate) fn spool_stats(state: State<AppState>) -> Result<SpoolStatsView, String> {
    let root = spool_root(&state);
    let mut bytes = 0u64;
    let mut entries = 0usize;
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Ok(SpoolStatsView { bytes, entries });
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<SpoolMeta>(&raw) else {
            continue;
        };
        entries += 1;
        if let Ok(md) = std::fs::metadata(&meta.path) {
            bytes += md.len();
        }
    }
    Ok(SpoolStatsView { bytes, entries })
}

/// Apaga spools parados há mais de 7 dias (o app fechou no meio do download).
#[tauri::command]
pub(crate) fn spool_gc(state: State<AppState>) -> Result<u64, String> {
    let root = spool_root(&state);
    let agora = std::time::SystemTime::now();
    let mut apagados = 0u64;
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Ok(0);
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        let velho = md
            .modified()
            .ok()
            .and_then(|m| agora.duration_since(m).ok())
            .map(|d| d.as_millis() as u64 > SPOOL_TTL_MS)
            .unwrap_or(false);
        if !velho {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<SpoolMeta>(&raw) else {
            continue;
        };
        if let Ok(m) = std::fs::metadata(&meta.path) {
            apagados += m.len();
        }
        let _ = std::fs::remove_file(&meta.path);
        let base = name.trim_end_matches(".json");
        let _ = std::fs::remove_file(root.join(format!("{base}.bits")));
        let _ = std::fs::remove_file(e.path());
    }
    Ok(apagados)
}
