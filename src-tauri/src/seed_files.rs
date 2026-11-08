// Semeadura por CAMINHO: reabrir o app e continuar semeando um arquivo de 100 GB
// sem copiá-lo para o spool. O caminho fica no SQLite; cada bloco é lido do
// disco na hora do pedido. Sem isso o app re-anunciava um arquivo que não
// conseguia servir (o outro lado pedia bloco e nunca recebia).
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;
use tauri::State;

use super::*;

const CHUNK: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub(crate) struct SeedEntry {
    file_id: String,
    name: String,
    size: u64,
    chunks: u32,
    hash: String,
    path: String,
}

fn meta_key(file_id: &str) -> String {
    format!("seed.meta.{file_id}")
}

fn check_id(file_id: &str) -> Result<(), String> {
    if file_id.is_empty() || file_id.len() > 256 || file_id.contains('\0') {
        return Err("seed: file_id inválido".into());
    }
    Ok(())
}

fn chunks_for(size: u64) -> u32 {
    size.div_ceil(CHUNK).max(1) as u32
}

/// Registra um arquivo já existente no disco como fonte de semeadura.
#[tauri::command]
pub(crate) fn seed_register(
    file_id: String,
    name: String,
    size: u64,
    hash: String,
    path: String,
    state: State<AppState>,
) -> Result<SeedEntry, String> {
    check_id(&file_id)?;
    let p = PathBuf::from(&path);
    if !p.is_absolute() || !p.is_file() {
        return Err(format!("seed: {} não é um arquivo válido", p.display()));
    }
    let md = std::fs::metadata(&p).map_err(|e| format!("seed: metadata: {e}"))?;
    if size > 0 && md.len() != size {
        return Err(format!(
            "seed: {} mudou de tamanho ({} bytes, esperado {size}) — selecione de novo",
            p.display(),
            md.len()
        ));
    }
    let safe = Path::new(&name)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            p.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("arquivo")
                .to_string()
        });
    let chunks = chunks_for(md.len());
    let entry = SeedEntry {
        file_id: file_id.clone(),
        name: safe,
        size: md.len(),
        chunks,
        hash,
        path: p.to_string_lossy().to_string(),
    };
    let store = open_store(&state)?;
    let json = serde_json::to_string(&entry).map_err(|e| format!("seed: json: {e}"))?;
    store.kv_set(&meta_key(&file_id), &json).map_err(err)?;
    Ok(entry)
}

#[tauri::command]
pub(crate) fn seed_unregister(file_id: String, state: State<AppState>) -> Result<(), String> {
    check_id(&file_id)?;
    let store = open_store(&state)?;
    let _ = store.kv_delete(&meta_key(&file_id));
    Ok(())
}

fn read_entries(state: &State<AppState>) -> Vec<SeedEntry> {
    let Ok(store) = open_store(state) else {
        return Vec::new();
    };
    let Ok(pairs) = store.kv_list_prefix("seed.meta.") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (k, json) in pairs {
        let Ok(e) = serde_json::from_str::<SeedEntry>(&json) else {
            continue;
        };
        // Arquivo apagado/movido: não pode continuar anunciando.
        let ok = std::fs::metadata(&e.path)
            .map(|m| m.is_file() && (e.size == 0 || m.len() == e.size))
            .unwrap_or(false);
        if !ok {
            let _ = store.kv_delete(&k);
            continue;
        }
        out.push(e);
    }
    out
}

#[tauri::command]
pub(crate) fn seed_list(state: State<AppState>) -> Result<Vec<SeedEntry>, String> {
    Ok(read_entries(&state))
}

#[tauri::command]
pub(crate) fn seed_read_chunk(
    file_id: String,
    index: u32,
    size: u64,
    state: State<AppState>,
) -> Result<Option<String>, String> {
    check_id(&file_id)?;
    let store = open_store(&state)?;
    let Some(json) = store.kv_get(&meta_key(&file_id)) else {
        return Ok(None);
    };
    let e: SeedEntry = serde_json::from_str(&json).map_err(|x| format!("seed: json: {x}"))?;
    let total = if size > 0 { size } else { e.size };
    if index >= chunks_for(total) {
        return Ok(None);
    }
    let ini = index as u64 * CHUNK;
    let len = (total - ini).min(CHUNK);
    let mut f = match std::fs::File::open(&e.path) {
        Ok(f) => f,
        Err(_) => return Ok(None),
    };
    f.seek(SeekFrom::Start(ini))
        .map_err(|x| format!("seed: seek: {x}"))?;
    let mut buf = vec![0u8; len as usize];
    if f.read_exact(&mut buf).is_err() {
        return Ok(None);
    }
    Ok(Some(general_purpose::STANDARD.encode(&buf)))
}
