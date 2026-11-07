// Frames de files: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_files(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    _peer_pubkey: &str,
    _peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::FileAnnounce {
            file_id,
            name,
            size,
            chunks,
            hash,
            chunk_hashes,
        } => {
            if file_id.len() > 128 || name.len() > 255 || hash.len() > 128 {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com campos gigantes".into(),
                ));
            }
            if chunks > 1_000_000 {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com chunks excessivos".into(),
                ));
            }
            const CHUNK_BYTES: u64 = 256 * 1024;
            let expected_chunks = std::cmp::max(1, size.div_ceil(CHUNK_BYTES));
            if chunks as u64 != expected_chunks && size > 0 {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com chunks incompatíveis com o tamanho".into(),
                ));
            }
            if size > MAX_ANNOUNCED_FILE_BYTES {
                return Err(DistorrentError::Protocol(
                    "FileAnnounce com tamanho acima do teto".into(),
                ));
            }
            if let Some(hs) = &chunk_hashes {
                if hs.len() != chunks as usize {
                    return Err(DistorrentError::Protocol(
                        "FileAnnounce com chunk_hashes fora de cardinalidade".into(),
                    ));
                }
                if hs.iter().any(|h| h.is_empty() || h.len() > 128) {
                    return Err(DistorrentError::Protocol(
                        "FileAnnounce com chunk_hash inválido".into(),
                    ));
                }
            }
            let name = cap_str(&name, 255);
            let _ = engine.store.announce_file(
                &file_id,
                &name,
                size as i64,
                chunks as i64,
                &hash,
                peer_fp,
            );
            if let Some(hs) = &chunk_hashes {
                let hs_json = serde_json::to_string(hs).unwrap_or_else(|_| "[]".into());
                let _ = engine
                    .store
                    .kv_set(&format!("file:chunk_hashes:{file_id}"), &hs_json);
            }
            let _ = engine.events.send(EngineEvent::FileAnnounceEv {
                file_id: file_id.clone(),
                name: name.clone(),
                size,
                chunks,
                hash: hash.clone(),
                from_fp: peer_fp.into(),
                chunk_hashes: chunk_hashes.clone().unwrap_or_default(),
            });
        }

        SecureFrame::FileChunkRequest { file_id, index } => {
            if engine.netlimiter.allow_chunk_request(peer_fp) == Decision::Blocked {
                return Err(DistorrentError::Protocol(
                    "chunk request descartado (rate limit)".into(),
                ));
            }
            let _ = engine.events.send(EngineEvent::FileChunkRequestEv {
                file_id,
                index,
                from_fp: peer_fp.into(),
            });
        }

        SecureFrame::FileChunkData {
            file_id,
            index,
            data_b64,
        } => {
            if data_b64.len() > MAX_CHUNK_BYTES * 4 / 3 + 8 {
                return Err(DistorrentError::Protocol(
                    "FileChunkData acima do tamanho de bloco".into(),
                ));
            }
            if index > 16_777_216 {
                return Err(DistorrentError::Protocol(
                    "FileChunkData com índice absurdo".into(),
                ));
            }
            let _ = engine.events.send(EngineEvent::FileChunkDataEv {
                file_id,
                index,
                data_b64,
                from_fp: peer_fp.into(),
            });
        }

        SecureFrame::FileHave {
            file_id: _,
            indices: _,
        } => {}

        _ => {}
    }
    Ok(())
}
