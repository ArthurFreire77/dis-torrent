// Frames de friends: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_friends(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::FriendRequest { nickname } => {
            if engine.netlimiter.allow_friend_request(peer_fp) == Decision::Blocked {
                return Err(DistorrentError::Protocol(
                    "friend request descartado (rate limit)".into(),
                ));
            }
            if engine.is_blocked(peer_fp) {
                // Não confirma nem nega: um bloqueado não pode descobrir que está bloqueado pela resposta.
                return Ok(());
            }
            let nick = cap_str(&nickname, 64);
            let state = engine.store.friend_state(peer_fp)?;
            match state.as_ref().map(|s| s.status.as_str()) {
                Some("accepted") => {
                    // Já somos amigos (o outro lado perdeu o estado): basta reconfirmar. Não recria linha nem "re-aceita".
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendAccept {
                                nickname: engine.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                }
                // Pedido cruzado: os dois pediram. Aceitar aqui é o único
                // desfecho simétrico; sem isto um lado ficava pendente para
                // sempre enquanto o outro recebia FriendAccept.
                Some("pending_out") | Some("pending_in") => {
                    engine.store.accept_friend(peer_fp, &nick)?;
                    engine.reset_dm_intro_for_peer(peer_fp);
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            peer_fp.into(),
                            SecureFrame::FriendAccept {
                                nickname: engine.identity.nickname.clone(),
                            },
                        ))
                        .ok();
                    let _ = engine.events.send(EngineEvent::FriendAccepted {
                        fp: peer_fp.into(),
                        nickname: nick,
                    });
                }
                _ => {
                    // `rejected`/`removed` voltam a ser pendentes, mas o carimbo de quando o pedido chegou é renovado.
                    engine.store.set_friend_request_in(peer_fp, &nick)?;
                    let _ = engine.events.send(EngineEvent::FriendRequestIn {
                        fp: peer_fp.into(),
                        nickname: nick,
                    });
                }
            }
        }

        SecureFrame::FriendAccept { nickname } => {
            let state = engine.store.friend_state(peer_fp)?;
            let status = state.as_ref().map(|s| s.status.as_str());
            // Bloqueado: aceite atrasado é ignorado sem derrubar a sessão.
            if status == Some("blocked") {
                return Ok(());
            }
            if !matches!(status, Some("pending_out") | Some("accepted")) {
                // Frame antigo/replay: não é motivo para romper a conexão.
                return Ok(());
            }
            if status == Some("accepted") {
                return Ok(());
            }
            let nick = cap_str(&nickname, 64);
            engine.store.accept_friend(peer_fp, &nick)?;
            engine.reset_dm_intro_for_peer(peer_fp);
            let _ = engine.events.send(EngineEvent::FriendAccepted {
                fp: peer_fp.into(),
                nickname: nick,
            });
        }

        SecureFrame::FriendReject => {
            // Recusa é do PEDIDO, não da amizade: preserva histórico e o
            // carimbo de bloqueio. Antes um `DELETE` apagava tudo e o
            // próximo ProfileSet recriava a amizade sozinho.
            engine.store.reject_friend(peer_fp)?;
            let _ = engine
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }

        SecureFrame::FriendRemove => {
            // Quem bloqueou não pode ser "desamigado" pelo outro lado: o bloqueio é local e soberano.
            if !engine.store.is_blocked_fp(peer_fp) {
                engine.store.clear_friendship(peer_fp)?;
            }
            let _ = engine
                .events
                .send(EngineEvent::FriendRemoved { fp: peer_fp.into() });
        }

        _ => {}
    }
    Ok(())
}
