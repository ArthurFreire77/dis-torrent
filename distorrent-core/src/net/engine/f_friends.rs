// Frames de friends: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_friends(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    _peer_pubkey: &str,
    _peer_nick: &str,
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
            let status = state.as_ref().map(|s| s.status.as_str());
            if !engine.friend_requests_enabled() && status != Some("accepted") {
                // Silêncio deliberado: desligar pedidos não pode virar um
                // sinal de "estou bloqueando" para quem tentou.
                return Ok(());
            }
            match status {
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
                // Só `pending_out` é pedido cruzado de verdade (este lado
                // também pediu). `pending_in` é o MESMO pedido reenviado
                // pelo retry automático; aceitar ali criava amizade sem
                // ninguém tocar em "Aceitar".
                Some("pending_out") => {
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
                Some("pending_in") => {
                    let mudou = state.as_ref().map(|s| s.nickname != nick).unwrap_or(true);
                    engine.store.set_friend_request_in(peer_fp, &nick)?;
                    if mudou {
                        let _ = engine.events.send(EngineEvent::FriendRequestIn {
                            fp: peer_fp.into(),
                            nickname: nick,
                        });
                    }
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
                // Remover amizade revoga a chamada 1:1 que estava de pé.
                let me = engine.identity.fingerprint.clone();
                let mut ids = engine
                    .store
                    .open_calls_targeting(&me, peer_fp)
                    .unwrap_or_default();
                ids.extend(
                    engine
                        .store
                        .open_calls_targeting(peer_fp, &me)
                        .unwrap_or_default(),
                );
                for call_id in ids {
                    let _ = engine.call_end(&call_id);
                }
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
