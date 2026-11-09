// Comandos Tauri: soundboard. Áudio fica em <app_data>/sounds, sempre revalidado
// por magic bytes e teto de tamanho; download só por https.

use super::*;
use base64::{engine::general_purpose, Engine as _};
use std::io::Write;

const MAX_SOUND_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SOUND_SECONDS: f64 = 10.0;
const MAX_NAME_CHARS: usize = 40;
const MAX_SOUNDS: usize = 120;

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct SoundView {
    pub id: String,
    pub name: String,
    pub ext: String,
    pub bytes: u64,
    pub seconds: f64,
    pub source: String,
    pub created_at: i64,
}

fn sounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_local_data_dir())
        .map_err(|e| format!("pasta do app indisponível: {e}"))?;
    let dir = base.join("sounds");
    std::fs::create_dir_all(&dir).map_err(|e| format!("não foi possível criar {dir:?}: {e}"))?;
    Ok(dir)
}

fn sounds_index_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(sounds_dir(app)?.join("index.json"))
}

fn read_index(app: &AppHandle) -> Vec<SoundView> {
    let Ok(path) = sounds_index_path(app) else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<SoundView>>(&raw).unwrap_or_default()
}

fn write_index(app: &AppHandle, list: &[SoundView]) -> Result<(), String> {
    let dir = sounds_dir(app)?;
    let path = dir.join("index.json");
    let tmp = dir.join("index.json.tmp");
    let body = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("índice: {e}"))?;
        f.write_all(&body).map_err(|e| format!("índice: {e}"))?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("índice: {e}"))?;
    Ok(())
}

/// Recusa qualquer coisa que não tenha magic bytes de áudio (exe renomeado cai aqui).
fn sniff_audio(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.len() < 12 {
        return None;
    }
    if &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        return Some(("wav", "audio/wav"));
    }
    if &bytes[0..4] == b"OggS" {
        return Some(("ogg", "audio/ogg"));
    }
    if &bytes[0..4] == b"fLaC" {
        return Some(("flac", "audio/flac"));
    }
    if bytes.len() > 8 && &bytes[4..8] == b"ftyp" {
        return Some(("m4a", "audio/mp4"));
    }
    // MP3: ID3 ou frame sync (0xFFEx/0xFFFx).
    if &bytes[0..3] == b"ID3" {
        return Some(("mp3", "audio/mpeg"));
    }
    if bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0 {
        return Some(("mp3", "audio/mpeg"));
    }
    None
}

/// Estimativa só do header (WAV); o frontend mede a duração real antes de salvar.
fn estimate_seconds(bytes: &[u8], ext: &str) -> f64 {
    match ext {
        "wav" => {
            if bytes.len() < 44 {
                return 0.0;
            }
            let byte_rate = u32::from_le_bytes([bytes[28], bytes[29], bytes[30], bytes[31]]) as f64;
            if byte_rate <= 0.0 {
                return 0.0;
            }
            let data = bytes.len() as f64 - 44.0;
            (data / byte_rate).max(0.0)
        }
        // OGG/MP3 sem parse completo: o frontend mede a duração real.
        _ => f64::MAX,
    }
}

fn sanitize_sound_name(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        "som".to_string()
    } else {
        trimmed
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub(crate) fn sound_list(app: AppHandle) -> Result<Vec<SoundView>, String> {
    let mut list = read_index(&app);
    let dir = sounds_dir(&app)?;
    // Arquivo apagado por fora some do índice em vez de virar erro ao tocar.
    list.retain(|s| dir.join(format!("{}.{}", s.id, s.ext)).is_file());
    Ok(list)
}

#[tauri::command]
pub(crate) fn sound_save(
    app: AppHandle,
    name: String,
    bytes_b64: String,
    seconds: f64,
    source: Option<String>,
) -> Result<SoundView, String> {
    let bytes = general_purpose::STANDARD
        .decode(bytes_b64.as_bytes())
        .map_err(|_| "bytes do som não estão em base64 válido".to_string())?;
    if bytes.is_empty() {
        return Err("arquivo vazio".into());
    }
    if bytes.len() as u64 > MAX_SOUND_BYTES {
        return Err(format!(
            "som grande demais ({} KB, máximo {} KB)",
            bytes.len() / 1024,
            MAX_SOUND_BYTES / 1024
        ));
    }
    let Some((ext, _mime)) = sniff_audio(&bytes) else {
        return Err("formato não reconhecido — use WAV, OGG, FLAC, M4A ou MP3".into());
    };
    let dur = if seconds.is_finite() && seconds > 0.0 {
        seconds
    } else {
        estimate_seconds(&bytes, ext)
    };
    if dur > MAX_SOUND_SECONDS + 0.25 {
        return Err(format!(
            "som com {:.1}s — o limite é {:.0}s",
            dur, MAX_SOUND_SECONDS
        ));
    }

    let dir = sounds_dir(&app)?;
    let mut list = read_index(&app);
    if list.len() >= MAX_SOUNDS {
        return Err(format!("limite de {MAX_SOUNDS} sons — apague algum antes"));
    }
    let id = format!("snd-{}-{}", now_ms(), bytes.len() % 100000);
    let path = dir.join(format!("{id}.{ext}"));
    {
        let mut f = std::fs::File::create(&path).map_err(|e| format!("gravar som: {e}"))?;
        f.write_all(&bytes)
            .map_err(|e| format!("gravar som: {e}"))?;
    }
    let view = SoundView {
        id,
        name: sanitize_sound_name(&name),
        ext: ext.to_string(),
        bytes: bytes.len() as u64,
        seconds: dur.min(MAX_SOUND_SECONDS),
        source: source.unwrap_or_default().chars().take(200).collect(),
        created_at: now_ms(),
    };
    list.push(view.clone());
    if let Err(e) = write_index(&app, &list) {
        let _ = std::fs::remove_file(&path);
        return Err(e);
    }
    Ok(view)
}

#[tauri::command]
pub(crate) fn sound_delete(app: AppHandle, id: String) -> Result<(), String> {
    if id.trim().is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("id de som inválido".into());
    }
    let dir = sounds_dir(&app)?;
    let mut list = read_index(&app);
    if let Some(pos) = list.iter().position(|s| s.id == id) {
        let ext = list[pos].ext.clone();
        list.remove(pos);
        let _ = std::fs::remove_file(dir.join(format!("{id}.{ext}")));
        write_index(&app, &list)?;
    }
    Ok(())
}

/// Bytes em base64 para o frontend montar o AudioBuffer (sem `asset:` no CSP).
#[tauri::command]
pub(crate) fn sound_read(app: AppHandle, id: String) -> Result<SoundData, String> {
    if id.trim().is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("id de som inválido".into());
    }
    let list = read_index(&app);
    let meta = list
        .iter()
        .find(|s| s.id == id)
        .ok_or_else(|| "som não existe mais".to_string())?;
    let path = sounds_dir(&app)?.join(format!("{}.{}", meta.id, meta.ext));
    let bytes = std::fs::read(&path).map_err(|e| format!("ler som: {e}"))?;
    if bytes.len() as u64 > MAX_SOUND_BYTES {
        return Err("som no disco acima do limite".into());
    }
    Ok(SoundData {
        name: meta.name.clone(),
        ext: meta.ext.clone(),
        bytes_b64: general_purpose::STANDARD.encode(&bytes),
        seconds: meta.seconds,
    })
}

#[derive(serde::Serialize)]
pub(crate) struct SoundData {
    pub name: String,
    pub ext: String,
    pub bytes_b64: String,
    pub seconds: f64,
}

/// Baixa um som por https; o conteúdo é revalidado (magic bytes + teto) e nada é executado.
#[tauri::command]
pub(crate) async fn sound_download(url: String) -> Result<SoundDownload, String> {
    let url = url.trim().to_string();
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("https://") {
        return Err("só é possível baixar sons por https".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|e| format!("cliente http: {e}"))?;
    let resp = client
        .get(&url)
        .header("accept", "audio/*")
        .send()
        .await
        .map_err(|e| format!("download falhou: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("o servidor respondeu {}", resp.status()));
    }
    if let Some(len) = resp.content_length() {
        if len > MAX_SOUND_BYTES {
            return Err(format!(
                "arquivo grande demais ({} KB, máximo {} KB)",
                len / 1024,
                MAX_SOUND_BYTES / 1024
            ));
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("download interrompido: {e}"))?;
    if bytes.len() as u64 > MAX_SOUND_BYTES {
        return Err("arquivo acima do limite de 2 MB".into());
    }
    let Some((ext, mime)) = sniff_audio(&bytes) else {
        return Err("o link não aponta para um áudio (WAV/OGG/FLAC/M4A/MP3)".into());
    };
    let name = {
        let last = url
            .split('/')
            .next_back()
            .unwrap_or("som")
            .split('?')
            .next()
            .unwrap_or("som");
        let stem = last.split('.').next().unwrap_or("som");
        sanitize_sound_name(&sanitize_sound_name(stem).replace(['%', '+'], " "))
    };
    Ok(SoundDownload {
        name,
        ext: ext.to_string(),
        mime: mime.to_string(),
        bytes_b64: general_purpose::STANDARD.encode(&bytes),
        bytes: bytes.len() as u64,
    })
}

#[derive(serde::Serialize)]
pub(crate) struct SoundDownload {
    pub name: String,
    pub ext: String,
    pub mime: String,
    pub bytes_b64: String,
    pub bytes: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav_bytes(seconds: u32) -> Vec<u8> {
        let rate = 8000u32;
        let data = rate * seconds;
        let mut v = Vec::with_capacity(44 + data as usize);
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes()); // PCM
        v.extend_from_slice(&1u16.to_le_bytes()); // mono
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes()); // byte rate
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&8u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data.to_le_bytes());
        v.resize(44 + data as usize, 128);
        v
    }

    #[test]
    fn magic_bytes_reconhecem_os_formatos_aceitos() {
        assert_eq!(sniff_audio(&wav_bytes(1)).map(|x| x.0), Some("wav"));
        let mut ogg = b"OggS".to_vec();
        ogg.extend_from_slice(&[0; 16]);
        assert_eq!(sniff_audio(&ogg).map(|x| x.0), Some("ogg"));
        let mut mp3 = b"ID3".to_vec();
        mp3.extend_from_slice(&[0; 16]);
        assert_eq!(sniff_audio(&mp3).map(|x| x.0), Some("mp3"));
        let mut flac = b"fLaC".to_vec();
        flac.extend_from_slice(&[0; 16]);
        assert_eq!(sniff_audio(&flac).map(|x| x.0), Some("flac"));
    }

    #[test]
    fn executavel_renomeado_nao_passa_por_audio() {
        let mut exe = b"MZ".to_vec();
        exe.extend_from_slice(&[0; 64]);
        assert!(sniff_audio(&exe).is_none(), "MZ não pode virar som");
        assert!(sniff_audio(b"#!/bin/sh\necho oi\n").is_none());
        assert!(sniff_audio(b"").is_none());
    }

    #[test]
    fn wav_tem_duracao_estimada_pelo_byte_rate() {
        let b = wav_bytes(3);
        let s = estimate_seconds(&b, "wav");
        assert!((s - 3.0).abs() < 0.05, "duração estimada {s}");
    }

    #[test]
    fn nome_do_som_e_limpo_e_limitado() {
        assert_eq!(sanitize_sound_name("  buzininha  "), "buzininha");
        assert_eq!(sanitize_sound_name("\u{7}\u{1}"), "som");
        assert!(sanitize_sound_name(&"x".repeat(200)).chars().count() <= MAX_NAME_CHARS);
    }

    #[test]
    fn ids_so_aceitam_ascii_seguro() {
        let ok = |id: &str| id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        assert!(ok("snd-1700000000000-123"));
        assert!(!ok("../../etc/passwd"));
        assert!(!ok("snd 1"));
    }
}
