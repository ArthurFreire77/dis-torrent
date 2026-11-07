// Frames de peer: braços extraídos de handle_frame. O frame chega por valor, então os movimentos do match original continuam válidos.

use super::*;

pub(super) async fn handle_peer(
    engine: &Arc<NetworkEngine>,
    peer_fp: &str,
    _peer_pubkey: &str,
    _peer_nick: &str,
    frame: SecureFrame,
) -> Result<()> {
    match frame {
        SecureFrame::Ping { ts } => {
            engine
                .cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::Pong { ts },
                ))
                .ok();
        }

        SecureFrame::Pong { ts } => {
            let now = crate::identity::now_ms();
            if now >= ts {
                let rtt = (now - ts) as u64;
                if rtt <= RELAY_PING_TIMEOUT.as_millis() as u64 {
                    crate::metrics::metrics().rtt_sample(peer_fp, rtt);
                }
            }
        }

        SecureFrame::PeerExchange { peers } => {
            for p in peers {
                if p.fp == engine.identity.fingerprint {
                    continue;
                }
                if !crate::identity::fingerprint_matches(&p.fp, &p.pubkey_hex) {
                    continue;
                }
                if p.addr.is_none() {
                    continue;
                }
                let online = engine.online_peer_fps().contains(&p.fp);
                let via_relay = online && engine.is_peer_via_relay(&p.fp);
                if online && !via_relay {
                    continue;
                }
                if !online
                    && engine.peer_state(&p.fp) != crate::net::engine::NetworkState::Disconnected
                {
                    continue;
                }
                let _ = engine.store.upsert_peer(&p);
                if let Some(addr_str) = p.addr {
                    if let Ok(addr) = addr_str.parse::<std::net::SocketAddr>() {
                        engine
                            .cmd_tx
                            .send(EngineCmd::ConnectTo(addr, Some(p.fp)))
                            .ok();
                    }
                }
            }
        }

        SecureFrame::PeerRelayPut { topic, body } => {
            if engine.peer_relay_serving_enabled() {
                let _ = crate::net::peer_relay::put(peer_fp, &topic, &body);
            }
        }

        SecureFrame::PeerRelayGet { req_id, topic } => {
            if engine.peer_relay_serving_enabled() {
                let bodies = crate::net::peer_relay::get(peer_fp, &topic, req_id);
                let bodies = crate::net::peer_relay::fit_relay_data(bodies);
                engine
                    .cmd_tx
                    .send(EngineCmd::SendToPeer(
                        peer_fp.to_string(),
                        SecureFrame::PeerRelayData { req_id, bodies },
                    ))
                    .ok();
            }
        }

        SecureFrame::PeerRelayData { req_id, bodies } => {
            if engine.peer_relay_fp().as_deref() != Some(peer_fp) {
                debug!(%peer_fp, "peer-relay: PeerRelayData ignorado (não é o intermediário)");
                return Ok(());
            }
            let backend = engine.peer_relay_backend_for(peer_fp);
            if !backend.deliver(req_id, bodies) {
                debug!("peer-relay: PeerRelayData órfão (req_id={req_id})");
            }
        }

        SecureFrame::Bye => return Err(DistorrentError::Protocol("peer encerrou (Bye)".into())),
        // ------------------------------------------------------------------
        // Autenticidade de build
        // ------------------------------------------------------------------
        SecureFrame::Punch {
            endpoint,
            at_ms,
            nonce: _,
        } => {
            if !engine.punch_enabled() {
                return Ok(());
            }
            let Ok(remote) = endpoint.parse::<SocketAddr>() else {
                debug!("punch com endpoint inválido — ignora");
                return Ok(());
            };
            if remote.ip().is_unspecified() || remote.port() == 0 {
                debug!("punch para endereço inválido — ignora");
                return Ok(());
            }
            if engine.peer_state(peer_fp) == NetworkState::Connected
                && !engine.is_peer_via_relay(peer_fp)
            {
                return Ok(());
            }
            {
                let now = crate::identity::now_ms();
                let mut map = engine.punch_rate.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(last) = map.get(peer_fp) {
                    if now - *last < 1000 {
                        return Ok(());
                    }
                }
                if map.len() > 4096 {
                    map.clear();
                }
                map.insert(peer_fp.to_string(), now);
            }
            engine
                .cmd_tx
                .send(EngineCmd::PunchDial {
                    fp: peer_fp.to_string(),
                    endpoint,
                    at_ms,
                })
                .ok();
        }

        _ => {}
    }
    Ok(())
}
