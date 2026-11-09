// Metodos de NetworkEngine: friends.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn friends(&self, status: Option<&str>) -> Vec<PeerRecord> {
        self.store.list_friends(status).unwrap_or_default()
    }

    pub fn is_blocked(&self, peer_fp: &str) -> bool {
        matches!(self.store.get_friend(peer_fp).ok().flatten(), Some((_, s)) if s == "blocked")
    }

    /// Pedidos de amizade podem ser desligados sem bloquear ninguém: quem
    /// tenta recebe silêncio, e amizades já aceitas continuam se reconfirmando.
    pub fn friend_requests_enabled(&self) -> bool {
        self.store.kv_get("friends.requests_enabled").as_deref() != Some("0")
    }

    pub fn set_friend_requests_enabled(&self, enabled: bool) -> Result<()> {
        self.store
            .kv_set("friends.requests_enabled", if enabled { "1" } else { "0" })
    }

    /// Normaliza um identificador de peer digitado/colado.
    /// Aceita os dois formatos que a UI oferece para copiar: o fingerprint de 12
    /// hex e a chave pública de 64 hex. Recusar o formato longo fazia quem
    /// colava "certo" ver "fingerprint deve ter 12 hex chars".
    pub fn normalize_peer_id(input: &str) -> Result<String> {
        let v = input.trim().to_lowercase();
        let v = v.strip_prefix("distorrent:").unwrap_or(&v).to_string();
        if v.len() == 12 && v.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(v);
        }
        if v.len() == 64 && v.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(crate::identity::fingerprint_of_pubkey_hex(&v));
        }
        Err(DistorrentError::Protocol(
            "identificador inválido: use o fingerprint de 12 caracteres ou a chave pública de 64"
                .into(),
        ))
    }

    pub fn friend_request(&self, peer_fp: &str) -> Result<FriendOutcome> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        let peer_fp = peer_fp.as_str();
        if peer_fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "não é possível adicionar a si mesmo".into(),
            ));
        }
        match self.store.friend_state(peer_fp)? {
            // Amizade já vale dos dois lados: repetir o pedido é no-op, não reenvia frame nem mexe no carimbo.
            Some(s) if s.status == "accepted" => return Ok(FriendOutcome::Sent),
            Some(s) if s.status == "blocked" => {
                return Err(DistorrentError::Protocol("peer bloqueado".into()))
            }
            // Pedido dele chegou enquanto eu também pedia: aceitar os dois é o único desfecho que não deixa um lado "amigo" e o outro não.
            Some(s) if s.status == "pending_in" => {
                return self
                    .friend_respond(peer_fp, true)
                    .map(|_| FriendOutcome::Sent)
            }
            _ => {}
        }
        self.store
            .set_friend_request_out(peer_fp, &self.identity.nickname)?;
        let sent = self.deliver_friend_frame(
            peer_fp,
            SecureFrame::FriendRequest {
                nickname: self.identity.nickname.clone(),
            },
        );
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
            .ok();
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
            .ok();
        self.dht_probe(peer_fp);
        Ok(sent)
    }

    pub fn friend_respond(&self, peer_fp: &str, accept: bool) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        let peer_fp = peer_fp.as_str();
        let state = self.store.friend_state(peer_fp)?;
        match state.as_ref().map(|s| s.status.as_str()) {
            Some("pending_in") => {}
            Some("blocked") => {
                return Err(DistorrentError::Protocol("peer bloqueado".into()));
            }
            Some(status) => {
                return Err(DistorrentError::Protocol(format!(
                    "não há pedido pendente para responder (status: {status})"
                )))
            }
            None => return Err(DistorrentError::Protocol("não há pedido pendente".into())),
        }
        if accept {
            let nick = state
                .as_ref()
                .map(|s| s.nickname.clone())
                .unwrap_or_default();
            // Grava aceito ANTES de avisar: se o frame falhar, o outro lado reenvia o pedido no próximo tick e recebe FriendAccept.
            self.store.accept_friend(peer_fp, &nick)?;
            self.reset_dm_intro_for_peer(peer_fp);
            let _ = self.deliver_friend_frame(
                peer_fp,
                SecureFrame::FriendAccept {
                    nickname: self.identity.nickname.clone(),
                },
            );
            self.cmd_tx
                .send(EngineCmd::ConnectRelay(peer_fp.to_string()))
                .ok();
            self.cmd_tx
                .send(EngineCmd::LookupAnnounce(peer_fp.to_string()))
                .ok();
            let _ = self.events.send(EngineEvent::FriendAccepted {
                fp: peer_fp.into(),
                nickname: nick,
            });
        } else {
            self.store.reject_friend(peer_fp)?;
            self.deliver_friend_frame(peer_fp, SecureFrame::FriendReject);
            let _ = self
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }
        Ok(())
    }

    /// Zera o crédito de introdução da DM com o peer quando a amizade é aceita.
    pub(super) fn reset_dm_intro_for_peer(&self, peer_fp: &str) {
        let conv = crate::storage::Store::dm_conversation_id(&self.identity.fingerprint, peer_fp);
        let _ = self.store.dm_intro_reset(&conv);
    }

    pub fn friend_remove(&self, peer_fp: &str) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        self.store.clear_friendship(&peer_fp)?;
        self.deliver_friend_frame(&peer_fp, SecureFrame::FriendRemove);
        let _ = self.events.send(EngineEvent::FriendRemoved {
            fp: peer_fp.clone(),
        });
        Ok(())
    }

    pub fn friend_block(&self, peer_fp: &str) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        self.store.set_friend(&peer_fp, "", "blocked")?;
        self.deliver_friend_frame(&peer_fp, SecureFrame::FriendRemove);
        // Bloqueio é local e imediato: a UI precisa ver o peer sair da lista e da conversa sem esperar o próximo refresh.
        let _ = self.events.send(EngineEvent::FriendRemoved {
            fp: peer_fp.clone(),
        });
        Ok(())
    }

    pub fn friend_unblock(&self, peer_fp: &str) -> Result<()> {
        let peer_fp = Self::normalize_peer_id(peer_fp)?;
        // Desbloquear NÃO recria amizade: volta ao estado neutro e o próximo
        // pedido passa pelo fluxo normal. Antes um `DELETE` deixava o peer
        // sem memória nenhuma e o próximo ProfileSet o "amigava" de novo.
        self.store.unblock_friend(&peer_fp)?;
        let _ = self.events.send(EngineEvent::FriendRemoved {
            fp: peer_fp.clone(),
        });
        Ok(())
    }

    fn deliver_friend_frame(&self, peer_fp: &str, frame: SecureFrame) -> FriendOutcome {
        if self.link_tx(peer_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
                .ok();
            FriendOutcome::Sent
        } else {
            FriendOutcome::QueuedOffline
        }
    }

    pub(super) fn flush_friend_requests(&self, peer_fp: &str) {
        if let Some((_, status)) = self.store.get_friend(peer_fp).ok().flatten() {
            match status.as_str() {
                "pending_out" => {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendRequest {
                                nickname: self.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                }
                "accepted" => {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendAccept {
                                nickname: self.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                }
                _ => {}
            }
        }
    }

    pub(super) fn retry_pending_friend_request(&self, peer_fp: &str, incluir_aceite: bool) {
        let Some((_, status)) = self.store.get_friend(peer_fp).ok().flatten() else {
            return;
        };
        let frame = match status.as_str() {
            "pending_out" => SecureFrame::FriendRequest {
                nickname: self.identity.nickname.clone(),
            },
            "accepted" if incluir_aceite => SecureFrame::FriendAccept {
                nickname: self.identity.nickname.clone(),
            },
            _ => return,
        };
        self.cmd_tx
            .send(EngineCmd::SendToPeer(peer_fp.into(), frame))
            .ok();
    }
}
