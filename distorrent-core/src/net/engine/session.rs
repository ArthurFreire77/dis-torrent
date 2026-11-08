// Registro da sessão nova e o loop de leitura dela.

use super::*;

pub(super) async fn register_and_run(
    engine: Arc<NetworkEngine>,
    session: Session,
    peer_fp: &str,
    peer_pubkey: &str,
    peer_nick: &str,
    initiator: bool,
    via_relay: bool,
    peer_proto_v: u32,
    transcript_hash: String,
) -> bool {
    let my_fp = engine.identity.fingerprint.clone();
    let prefiro_outbound = my_fp.as_str() < peer_fp;

    {
        let links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        let online = links
            .values()
            .filter(|l| l.get_state() == PeerLinkState::Online)
            .count();
        if online >= engine.netlimiter.limits().sessions_max {
            debug!(
                peer_fp,
                online, "sessão recusada: teto global de sessões online"
            );
            return false;
        }
    }

    {
        let links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(existing) = links.get(peer_fp) {
            if existing.get_state() == PeerLinkState::Online
                && !nova_sessao_substitui(
                    existing.via_relay,
                    existing.initiator,
                    via_relay,
                    initiator,
                    prefiro_outbound,
                )
            {
                debug!(peer_fp, via_relay, "sessão descartada (a atual fica)");
                return false;
            }
            if existing.get_state() == PeerLinkState::Online {
                debug!(peer_fp, "eleição: sessão preferida substitui a atual");
            }
        }
    }

    // Autenticidade da identidade: se já conhecemos a pubkey deste fingerprint,
    // uma sessão nova TEM de apresentar a mesma chave. Sem isso, uma colisão do
    // esquema legado de fingerprint (pubkey como texto) sequestrava a identidade.
    if let Ok(Some(known)) = engine.store.get_peer(peer_fp) {
        if !known.pubkey_hex.is_empty() && !known.pubkey_hex.eq_ignore_ascii_case(peer_pubkey) {
            debug!(peer_fp, "sessão recusada: pubkey diferente da já conhecida");
            return false;
        }
    }

    let _ = engine.store.upsert_peer(&PeerRecord {
        fp: peer_fp.to_string(),
        pubkey_hex: peer_pubkey.to_string(),
        nickname: peer_nick.to_string(),
        addr: None,
        last_seen: crate::identity::now_ms(),
        origin: "handshake".into(),
    });

    let (frame_tx, mut frame_rx) = mpsc::unbounded_channel::<(u8, SecureFrame)>();
    let link = Arc::new(PeerLink {
        state: StdMutex::new(PeerLinkState::Online),
        tx: Some(frame_tx.clone()),
        drop_notify: Notify::new(),
        via_relay,
        initiator,
    });
    let replaced = {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        links
            .insert(peer_fp.to_string(), link.clone())
            .filter(|old| old.get_state() == PeerLinkState::Online)
    };
    if let Some(old) = replaced {
        old.drop_notify.notify_one();
    }
    info!(peer_fp, %peer_nick, via_relay, "peer ONLINE");
    engine.reset_dial_failures(peer_fp);
    {
        // ORDEM IMPORTA: `peer_proto` é populado abaixo. Desafiar antes disso
        // fazia `send_build_challenge` sair cedo e a primeira conexão de cada
        // peer nunca era verificada.
        let mut map = engine.peer_protos.lock().unwrap_or_else(|e| e.into_inner());
        map.entry(peer_fp.to_string())
            .and_modify(|v| {
                if peer_proto_v > *v {
                    *v = peer_proto_v;
                }
            })
            .or_insert(peer_proto_v);
    }
    {
        // Atestação de build: guarda o transcript desta sessão e desafia o
        // peer (só quem fala proto_v >= 5 entende). Sem isso o peer fica
        // NAO_VERIFICADO, que é o estado honesto.
        engine.set_attest_transcript(peer_fp, &transcript_hash);
        engine.send_build_challenge(peer_fp);
    }
    let _ = engine.events.send(EngineEvent::PeerOnline {
        fp: peer_fp.into(),
        nickname: peer_nick.into(),
        via_relay,
    });
    engine.emit_state();

    engine
        .cmd_tx
        .send(EngineCmd::SendToPeer(
            peer_fp.to_string(),
            SecureFrame::ProfileQuery {
                known_rev: engine
                    .store
                    .profile_get(peer_fp)
                    .map(|p| p.rev)
                    .unwrap_or(0),
            },
        ))
        .ok();

    engine.flush_files_to(peer_fp);

    if via_relay && peer_proto_v >= 1 && engine.punch_enabled() {
        spawn_punch_upgrade(engine.clone(), peer_fp.to_string());
    }

    {
        {
            let cutoff = crate::identity::now_ms() - 20_000;
            if let Ok(ids) = engine.store.revert_stale_sent_to_pending(peer_fp, cutoff) {
                for id in ids {
                    let _ = engine.events.send(EngineEvent::MessageStatus {
                        msg_id: id,
                        status: "pending".into(),
                    });
                }
            }
        }
        engine
            .cmd_tx
            .send(EngineCmd::FlushOutbox(peer_fp.to_string()))
            .ok();
        engine.flush_friend_requests(peer_fp);
        engine.flush_joins(peer_fp);
        engine.flush_pending_calls(peer_fp);
        engine.flush_pending_reacts(peer_fp);
        engine.flush_voice_state_to(peer_fp);
        engine.flush_community_state_to(peer_fp);
        engine.flush_rooms_to(peer_fp);
        engine.announce_presence();
    }

    let (mut reader, mut writer_session) = session.split();
    let writer: JoinHandle<()> = tokio::spawn(async move {
        let mut queues: [VecDeque<SecureFrame>; 4] = [
            VecDeque::new(),
            VecDeque::new(),
            VecDeque::new(),
            VecDeque::new(),
        ];
        const BATCH_CAP: usize = 16;
        const CLASS_CAP: [usize; 4] = [8, 4, 12, 4];
        loop {
            if queues.iter().all(|q| q.is_empty()) {
                match frame_rx.recv().await {
                    Some((p, f)) => queues[(p as usize).min(3)].push_back(f),
                    None => break,
                }
            }
            while let Ok((p, f)) = frame_rx.try_recv() {
                queues[(p as usize).min(3)].push_back(f);
            }
            let mut batch: Vec<(u8, SecureFrame)> = Vec::with_capacity(BATCH_CAP);

            for (class, q) in queues.iter_mut().enumerate() {
                let take = CLASS_CAP[class].min(q.len()).min(BATCH_CAP - batch.len());
                for _ in 0..take {
                    if let Some(f) = q.pop_front() {
                        batch.push((class as u8, f));
                    }
                }
            }
            if batch.is_empty() {
                continue;
            }
            let mut frames: Vec<SecureFrame> = Vec::with_capacity(batch.len());
            let mut classes: Vec<u8> = Vec::with_capacity(batch.len());
            for (c, f) in batch {
                classes.push(c);
                frames.push(f);
            }
            match writer_session.send_batch(&frames).await {
                Ok(sizes) => {
                    for (c, s) in classes.iter().zip(sizes.iter()) {
                        crate::metrics::metrics()
                            .frame_tx(crate::metrics::FrameClass::by_index(*c), *s as u64);
                    }
                }
                Err(_) => break,
            }
        }
    });

    let (base_interval, base_timeout, steps) = if via_relay {
        (
            RELAY_PING_INTERVAL,
            RELAY_PING_TIMEOUT,
            [
                RELAY_PING_INTERVAL,
                RELAY_PING_INTERVAL * 2,
                RELAY_PING_INTERVAL * 4,
                RELAY_PING_INTERVAL * 6,
            ],
        )
    } else {
        (
            PING_INTERVAL,
            PING_TIMEOUT,
            [
                PING_INTERVAL,
                PING_INTERVAL * 2,
                PING_INTERVAL * 3,
                PING_INTERVAL * 3,
            ],
        )
    };
    let mut idle_step = 0usize;
    let mut ping_at = tokio::time::Instant::now() + base_interval;
    // Teto para a escalada de timeout: sem ele, um par parado ficava até 75 s
    // (ou 120 s no relay) sem ser declarado morto — "Conectado" mentiroso.
    let max_idle = base_timeout * 2;

    let read_result = loop {
        let cur_interval = steps[idle_step.min(steps.len() - 1)];
        let cur_timeout = std::cmp::max(base_timeout, cur_interval.mul_f64(2.5)).min(max_idle);
        tokio::select! {
            res = timeout(cur_timeout, reader.recv_sized::<SecureFrame>()) => {
                match res {
                    Err(_) => break Err(DistorrentError::Protocol(format!("ping timeout ({:?} sem frames)", cur_timeout))),
                    Ok(Err(e)) => break Err(e),
                    Ok(Ok((frame, wire))) => {
                        idle_step = 0;
                        ping_at = tokio::time::Instant::now() + base_interval;
                        crate::metrics::metrics().frame_rx(
                            crate::metrics::FrameClass::by_index(frame_class(&frame)),
                            wire as u64,
                        );
                        match engine.netlimiter.allow_frame_in(peer_fp, wire as u64) {
                            FrameVerdict::Allow => {}
                            FrameVerdict::Drop(reason) => {
                                debug!("frame de {peer_fp} descartado: {reason}");
                                continue;
                            }
                            FrameVerdict::Kill(reason) => {
                                warn!(peer_fp, "sessão encerrada por limite: {reason}");
                                break Err(DistorrentError::Protocol(reason.to_string()));
                            }
                        }
                        if engine.peer_quarantined(peer_fp)
                            && !crate::release::frame_allowed_in_quarantine(&frame)
                        {
                            // Quarentena: o peer continua vivo (Ping/Bye e os frames de atualização), mas nada de mensagem, arquivo, chamada ou estado entra na rede.
                            debug!(peer_fp, "frame bloqueado pela quarentena de autenticidade");
                            continue;
                        }
                        if let Err(e) = frames::handle_frame(&engine, peer_fp, peer_pubkey, peer_nick, frame).await {
                            let motivo = e.to_string();
                            warn!(peer_fp, "frame rejeitado: {motivo}");
                            engine.diag_update(peer_fp, |d| {
                                d.last_reject = Some(motivo);
                                d.last_reject_ms = crate::identity::now_ms();
                            });
                        }
                    }
                }
            }
            _ = tokio::time::sleep_until(ping_at) => {
                if engine.store.peer_in_active_call(peer_fp) {
                    idle_step = 0;
                } else {
                    idle_step = (idle_step + 1).min(steps.len() - 1);
                }
                ping_at = tokio::time::Instant::now() + steps[idle_step];
                if frame_tx.send((0, SecureFrame::Ping { ts: crate::identity::now_ms() })).is_err() {
                    break Err(DistorrentError::PeerNotConnected(peer_fp.into()));
                }
            }
            _ = link.drop_notify.notified() => break Ok(()),
        }
    };

    writer.abort();
    let removed = {
        let mut links = engine.links.lock().unwrap_or_else(|e| e.into_inner());
        match links.get(peer_fp) {
            Some(current) if Arc::ptr_eq(current, &link) => links.remove(peer_fp).is_some(),
            _ => false,
        }
    };
    if removed {
        engine.netlimiter.forget_peer(peer_fp);
        {
            // Estado de confiança é POR SESSÃO: reconectar sem nova prova não herda o veredito antigo.
            let mut m = engine.peer_trust.lock().unwrap_or_else(|e| e.into_inner());
            m.remove(peer_fp);
            let mut n = engine
                .attest_nonce
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            n.remove(peer_fp);
            let mut sa = engine
                .attest_sent_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            sa.remove(peer_fp);
            let mut t = engine
                .attest_transcript
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            t.remove(peer_fp);
        }
        if engine.should_keep_dialing(peer_fp) {
            set_link_state(&engine, peer_fp, PeerLinkState::Reconnecting);
        }
        engine.tunnel_drop(peer_fp, "link caiu");
        if let Ok(ids) = engine.store.revert_unacked_to_pending(peer_fp) {
            for id in ids {
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: id,
                    status: "pending".into(),
                });
            }
        }
        if let Ok(ids) = engine.store.revert_unacked_groups_to_pending() {
            for id in ids {
                let _ = engine.events.send(EngineEvent::MessageStatus {
                    msg_id: id,
                    status: "pending".into(),
                });
            }
        }
        info!(
            peer_fp,
            "peer OFFLINE ({})",
            read_result
                .as_ref()
                .err()
                .map(|e| e.to_string())
                .unwrap_or_else(|| "desconectado".into())
        );
        let _ = engine.events.send(EngineEvent::PeerOffline {
            fp: peer_fp.to_string(),
        });
        // Presença persistida: sem isso o peer continuava "online" na UI por
        // até 90 s (TTL) depois de a conexão cair — o clássico verde mentiroso.
        let _ = engine.store.presence_offline(peer_fp);
        let _ = engine.events.send(EngineEvent::PresenceChanged {
            fp: peer_fp.to_string(),
            status: "offline".into(),
            custom: String::new(),
            custom_emoji: String::new(),
        });
        engine.drop_voice_presence_of(peer_fp);
        engine.emit_state();
    }
    true
}
