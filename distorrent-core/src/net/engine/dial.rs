// Loop de comandos: conecta, mantém e derruba pares.

use super::*;

pub(super) async fn command_loop(
    engine: Arc<NetworkEngine>,
    mut rx: mpsc::UnboundedReceiver<EngineCmd>,
) {
    while let Some(cmd) = rx.recv().await {
        match cmd {
            EngineCmd::ConnectTo(addr, expected_fp) => {
                let key = format!("{}@{addr}", expected_fp.as_deref().unwrap_or(""));
                let fresh = {
                    let mut set = engine
                        .direct_maintains
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if set.len() > 4096 {
                        set.clear();
                    }
                    set.insert(key)
                };
                if fresh {
                    let engine = engine.clone();
                    tokio::spawn(async move {
                        dial2::connect_and_maintain(engine, ConnTarget::Addr(addr), expected_fp)
                            .await
                    });
                }
            }
            EngineCmd::ConnectHost {
                host,
                port,
                expected_fp,
            } => {
                let key = format!("{}@{host}:{port}", expected_fp.as_deref().unwrap_or(""));
                let fresh = {
                    let mut set = engine
                        .direct_maintains
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if set.len() > 4096 {
                        set.clear();
                    }
                    set.insert(key)
                };
                if fresh {
                    let engine = engine.clone();
                    tokio::spawn(async move {
                        dial2::connect_and_maintain(
                            engine,
                            ConnTarget::Host(host, port),
                            expected_fp,
                        )
                        .await
                    });
                }
            }
            EngineCmd::ConnectRelay(fp) => {
                let fresh = engine
                    .relay_maintains
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(fp.clone());
                if fresh {
                    let engine = engine.clone();
                    tokio::spawn(async move { connect_relay_and_maintain(engine, fp).await });
                }
            }
            EngineCmd::LookupAnnounce(fp) => {
                announce_lookup_once(engine.clone(), fp);
            }
            EngineCmd::PunchDial {
                fp,
                endpoint,
                at_ms,
            } => {
                let engine = engine.clone();
                tokio::spawn(async move { punch_and_register(engine, fp, endpoint, at_ms).await });
            }
            EngineCmd::SendToPeer(fp, frame) => {
                if !matches!(
                    frame,
                    SecureFrame::TunnelOffer { .. }
                        | SecureFrame::TunnelAnswer { .. }
                        | SecureFrame::TunnelData { .. }
                ) && engine.tunnel_should_carry(&fp)
                {
                    if engine.tunnel_send_frame(&fp, &frame) {
                        continue;
                    }
                }
                let link = engine
                    .links
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&fp)
                    .cloned();
                let msg_falhou = match &frame {
                    SecureFrame::Msg(env) => engine
                        .store
                        .get_conversation(&env.conv_id)
                        .ok()
                        .flatten()
                        .map(|c| (env.id.clone(), c.peer_fp, c.kind)),
                    SecureFrame::ChannelMsg { env, .. } => {
                        Some((env.id.clone(), fp.clone(), "channel".to_string()))
                    }
                    _ => None,
                };
                let mut entregue = false;
                let reserva = if NetworkEngine::is_call_frame(&frame) {
                    Some(frame.clone())
                } else {
                    None
                };
                if let Some(l) = link {
                    if let Some(tx) = &l.tx {
                        entregue = tx.send((frame_class(&frame), frame)).is_ok();
                    }
                }
                if !entregue {
                    if let Some((msg_id, peer, kind)) = msg_falhou {
                        match kind.as_str() {
                            "dm" => {
                                let _ = engine.store.enqueue_outbox_kind(&msg_id, &peer, "dm");
                                let _ = engine.store.set_message_status(&msg_id, "pending");
                                let _ = engine.events.send(EngineEvent::MessageStatus {
                                    msg_id,
                                    status: "pending".into(),
                                });
                            }
                            "channel" if !peer.is_empty() => {
                                let _ = engine.store.enqueue_outbox_kind(&msg_id, &peer, "channel");
                                let _ = engine.store.set_message_status(&msg_id, "pending");
                                let _ = engine.events.send(EngineEvent::MessageStatus {
                                    msg_id,
                                    status: "pending".into(),
                                });
                            }
                            _ => {
                                let _ = engine.store.set_message_status(&msg_id, "pending");
                                let _ = engine.events.send(EngineEvent::MessageStatus {
                                    msg_id,
                                    status: "pending".into(),
                                });
                            }
                        }
                    }
                    drop_link_if_dead(&engine, &fp);
                    if let Some(f) = reserva {
                        engine.enqueue_call_frame(&fp, f);
                    }
                }
            }
            EngineCmd::FlushOutbox(fp) => {
                for id in engine.store.give_up_outbox(&fp).unwrap_or_default() {
                    engine.diag_update(&fp, |d| {
                        d.send_gave_up = d.send_gave_up.saturating_add(1);
                    });
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id: id,
                        status: "failed".into(),
                    });
                }
                let pending = engine.store.pending_outbox(&fp).unwrap_or_default();
                for msg_id in pending {
                    let Some(m) = engine.store.message_by_id(&msg_id).ok().flatten() else {
                        continue;
                    };
                    let env = MessageEnvelope {
                        id: m.id.clone(),
                        conv_id: m.conv_id.clone(),
                        author_fp: m.author_fp.clone(),
                        body: m.body.clone(),
                        ts: m.ts,
                        sig: m.sig.clone(),
                    };
                    let frame = if engine.store.outbox_kind(&m.id) == "channel" {
                        let community = engine
                            .store
                            .channel_community(&m.conv_id)
                            .ok()
                            .flatten()
                            .unwrap_or_default();
                        if community.is_empty() {
                            continue;
                        }
                        SecureFrame::ChannelMsg {
                            community_id: community,
                            channel_id: m.conv_id.clone(),
                            env,
                            bot_id: String::new(),
                        }
                    } else {
                        SecureFrame::Msg(env)
                    };
                    engine
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(fp.clone(), frame))
                        .ok();
                    engine.store.bump_outbox(&m.id).ok();
                    engine.store.set_message_status(&m.id, "sending").ok();
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id: m.id,
                        status: "sending".into(),
                    });
                }
                flush_group_to_peer(&engine, &fp);
                engine.flush_pending_reacts(&fp);
            }
        }
    }
}
