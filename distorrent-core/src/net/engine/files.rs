// Metodos de NetworkEngine: files.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn file_announce(
        &self,
        file_id: &str,
        name: &str,
        size: u64,
        chunks: u32,
        hash: &str,
    ) -> Result<()> {
        self.store.announce_file(
            file_id,
            name,
            size as i64,
            chunks as i64,
            hash,
            &self.identity.fingerprint,
        )?;
        for fp in self.online_peer_fps() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::FileAnnounce {
                        file_id: file_id.into(),
                        name: name.into(),
                        size,
                        chunks,
                        hash: hash.into(),
                        chunk_hashes: None,
                    },
                ))
                .ok();
        }
        let _ = self
            .store
            .touch_file_seeded(file_id, crate::identity::now_ms());
        Ok(())
    }

    pub fn file_announce_with_chunks(
        &self,
        file_id: &str,
        name: &str,
        size: u64,
        chunks: u32,
        hash: &str,
        chunk_hashes: Vec<String>,
    ) -> Result<()> {
        self.store.announce_file(
            file_id,
            name,
            size as i64,
            chunks as i64,
            hash,
            &self.identity.fingerprint,
        )?;
        for fp in self.online_peer_fps() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::FileAnnounce {
                        file_id: file_id.into(),
                        name: name.into(),
                        size,
                        chunks,
                        hash: hash.into(),
                        chunk_hashes: Some(chunk_hashes.clone()),
                    },
                ))
                .ok();
        }
        let _ = self
            .store
            .touch_file_seeded(file_id, crate::identity::now_ms());
        Ok(())
    }

    pub fn reannounce_files(&self) {
        let me = self.identity.fingerprint.clone();
        let Ok(arquivos) = self.store.my_seed_files(&me) else {
            return;
        };
        if arquivos.is_empty() {
            return;
        }
        let online = self.online_peer_fps();
        if online.is_empty() {
            return;
        }
        let now = crate::identity::now_ms();
        for (file_id, name, size, chunks, hash, seeded_at) in arquivos {
            if now.saturating_sub(seeded_at) < 30_000 && seeded_at != 0 {
                continue;
            }
            for fp in &online {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp.clone(),
                        SecureFrame::FileAnnounce {
                            file_id: file_id.clone(),
                            name: name.clone(),
                            size: size.max(0) as u64,
                            chunks: chunks.max(0) as u32,
                            hash: hash.clone(),
                            chunk_hashes: None,
                        },
                    ))
                    .ok();
            }
            let _ = self.store.touch_file_seeded(&file_id, now);
        }
    }

    pub fn flush_files_to(&self, peer_fp: &str) {
        let me = self.identity.fingerprint.clone();
        let Ok(arquivos) = self.store.my_seed_files(&me) else {
            return;
        };
        for (file_id, name, size, chunks, hash, _) in arquivos {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::FileAnnounce {
                        file_id,
                        name,
                        size: size.max(0) as u64,
                        chunks: chunks.max(0) as u32,
                        hash,
                        chunk_hashes: None,
                    },
                ))
                .ok();
        }
    }

    pub fn file_request_chunk(&self, file_id: &str, index: u32, holder_fp: &str) -> Result<()> {
        if self.link_tx(holder_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    holder_fp.into(),
                    SecureFrame::FileChunkRequest {
                        file_id: file_id.into(),
                        index,
                    },
                ))
                .ok();
            Ok(())
        } else {
            Err(DistorrentError::PeerNotConnected(holder_fp.into()))
        }
    }

    pub fn file_send_chunk(
        &self,
        target_fp: &str,
        file_id: &str,
        index: u32,
        data_b64: &str,
    ) -> Result<()> {
        if data_b64.len() > MAX_CHUNK_BYTES * 4 / 3 + 8 {
            return Err(DistorrentError::Protocol(
                "file_send_chunk: bloco acima do tamanho máximo".into(),
            ));
        }
        if self.link_tx(target_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    target_fp.into(),
                    SecureFrame::FileChunkData {
                        file_id: file_id.into(),
                        index,
                        data_b64: data_b64.into(),
                    },
                ))
                .ok();
            Ok(())
        } else {
            Err(DistorrentError::PeerNotConnected(target_fp.into()))
        }
    }
}
