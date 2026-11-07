// Loop de ticks do motor: intervalos de ping, NAT, anúncio e manutenção. Separado de engine.rs para o arquivo nao passar de 1.000 linhas.

use super::*;

pub(super) async fn run_engine(engine: Arc<NetworkEngine>, discovery_enabled: bool) -> Result<()> {
    engine.refresh_relay_for_privacy();

    if let Err(e) = engine
        .store
        .clear_my_voice_states(&engine.identity.fingerprint)
    {
        tracing::debug!(error = %e, "não consegui limpar presença de voz antiga");
    }

    {
        for p in engine.store.list_peers().unwrap_or_default() {
            if let Some(addr) = p.addr.as_deref().and_then(|a| a.parse::<SocketAddr>().ok()) {
                if addr.port() != 0 {
                    engine
                        .cmd_tx
                        .send(EngineCmd::ConnectTo(addr, Some(p.fp.clone())))
                        .ok();
                }
            }
        }
        for status in ["accepted", "pending_out", "pending_in"] {
            for f in engine.store.list_friends(Some(status)).unwrap_or_default() {
                engine
                    .cmd_tx
                    .send(EngineCmd::ConnectRelay(f.fp.clone()))
                    .ok();
                engine
                    .cmd_tx
                    .send(EngineCmd::LookupAnnounce(f.fp.clone()))
                    .ok();
            }
        }
        engine.pair_all_groups_now();
        for (key, token) in engine
            .store
            .kv_list_prefix("join.pending.")
            .unwrap_or_default()
        {
            let Some(cid) = key.strip_prefix("join.pending.") else {
                continue;
            };
            let Ok((host_fp, token_cid, member_fp, exp, _sig)) =
                crate::protocol::parse_invite_token(&token)
            else {
                let _ = engine.store.kv_delete(&key);
                continue;
            };
            const WILDCARD: &str = "000000000000";
            if token_cid != cid
                || (member_fp != WILDCARD && member_fp != engine.identity.fingerprint)
                || crate::identity::now_ms() > exp
            {
                let _ = engine.store.kv_delete(&key);
                continue;
            }
            engine
                .pending_joins
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(cid.to_string(), token);
            engine.connect_to_community_peer(&host_fp);
        }
    }

    let listener = {
        let preferred: u16 = std::env::var("DISTORRENT_PORT")
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .filter(|p: &u16| *p != 0)
            .unwrap_or(51413);
        let mut candidates: Vec<u16> = (0..10).map(|i| preferred.wrapping_add(i)).collect();
        candidates.push(0);
        let mut bound = None;
        for p in candidates {
            if p != 0
                && process_ports()
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .contains(&p)
            {
                continue;
            }
            let attempt = (|| -> Result<tokio::net::TcpListener> {
                let sock = tokio::net::TcpSocket::new_v4()?;
                #[cfg(unix)]
                sock.set_reuseport(true)?;
                #[cfg(windows)]
                sock.set_reuseaddr(true)?;
                sock.bind(
                    format!("0.0.0.0:{p}")
                        .parse::<SocketAddr>()
                        .map_err(|e| DistorrentError::Protocol(format!("bind inválido: {e}")))?,
                )?;
                Ok(sock.listen(128)?)
            })();
            match attempt {
                Ok(l) => {
                    if p != 0 {
                        process_ports()
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .insert(p);
                    }
                    bound = Some(l);
                    break;
                }
                Err(_) => continue,
            }
        }
        bound.ok_or_else(|| DistorrentError::Protocol("sem porta TCP livre".into()))?
    };
    let port = listener.local_addr()?.port();
    engine.listen_port.store(port, Ordering::Relaxed);
    info!(port, "listener TCP ativo");

    {
        let port_upnp = port;
        let ext_port = engine.nat_external_port.clone();
        let engine_nat = engine.clone();
        tokio::spawn(async move {
            let mut cancel = engine_nat.cancel_tx.subscribe();
            loop {
                if cancelled(&cancel) {
                    break;
                }
                if matches!(engine_nat.privacy_mode().as_str(), "proxy" | "full") {
                    debug!("upnp/nat-pmp suspenso: modo anônimo (proxy/full)");
                } else {
                    nat_map_port(port_upnp, ext_port.clone()).await;
                }
                tokio::select! {
                    _ = cancel.changed() => break,
                    _ = sleep(NAT_RENEW_INTERVAL) => {}
                }
            }
        });
    }

    {
        let engine_clone = engine.clone();
        let port_clone = port;
        tokio::spawn(async move {
            let trackers: Vec<String> = std::env::var("DISTORRENT_BOOTSTRAP_URL")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().trim_end_matches('/').to_string())
                .filter(|s| s.starts_with("http"))
                .collect();
            if trackers.is_empty() {
                debug!(
                    "bootstrap: sem trackers HTTP — descoberta 100% P2P (LAN/mDNS/MQTT/hole-punch)"
                );
            } else {
                info!(
                    ?trackers,
                    "bootstrap: anunciando em {} tracker(s)",
                    trackers.len()
                );
            }
            let mut cancel = engine_clone.cancel_tx.subscribe();
            let mut tick = interval(Duration::from_secs(30));
            let last_announce = StdMutex::new(0i64);
            loop {
                if cancelled(&cancel) {
                    break;
                }
                tokio::select! {
                    _ = cancel.changed() => break,
                    _ = tick.tick() => {}
                }
                let privacy_mode = engine_clone
                    .store
                    .kv_get("privacy.mode")
                    .unwrap_or_else(|| "encrypted".to_string());
                if matches!(privacy_mode.as_str(), "proxy" | "full") {
                    continue;
                }
                let fp = engine_clone.identity.fingerprint.clone();
                let nickname = engine_clone.identity.nickname.clone();
                let public_ip: Option<String> = {
                    static UPNP_CACHE: std::sync::OnceLock<StdMutex<(Option<String>, i64)>> =
                        std::sync::OnceLock::new();
                    let cached = UPNP_CACHE
                        .get_or_init(|| StdMutex::new((None, 0)))
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone();
                    if crate::identity::now_ms() - cached.1 < 5 * 60 * 1000 {
                        cached.0
                    } else {
                        let upnp_ip = tokio::time::timeout(
                            Duration::from_secs(4),
                            tokio::task::spawn_blocking(|| {
                                igd::search_gateway(Default::default())
                                    .ok()
                                    .and_then(|g| g.get_external_ip().ok())
                            }),
                        )
                        .await
                        .ok()
                        .and_then(|r| r.ok())
                        .flatten()
                        .map(|ip| ip.to_string());
                        *UPNP_CACHE
                            .get_or_init(|| StdMutex::new((None, 0)))
                            .lock()
                            .unwrap_or_else(|e| e.into_inner()) =
                            (upnp_ip.clone(), crate::identity::now_ms());
                        upnp_ip
                    }
                };
                let announce_on = announce_discovery_enabled();
                let ext_port = engine_clone.nat_external_port.load(Ordering::Relaxed);
                let stun_addr = if !announce_on {
                    None
                } else if ext_port == 0 {
                    let sa = crate::net::stun::stun_external_addr().await;
                    engine_clone.diag_record_net(|d| {
                        d.stun_ok = Some(sa.is_some());
                        d.stun_addr = sa.map(|s| s.to_string());
                        d.stun_ms = crate::identity::now_ms();
                    });
                    sa
                } else {
                    None
                };
                let announced: Option<(String, u16)> = if ext_port != 0 {
                    let ip = public_ip.or_else(|| stun_addr.map(|s| s.ip().to_string()));
                    ip.map(|ip| (format!("{ip}:{ext_port}"), ext_port))
                } else if let Some(ip) = public_ip {
                    Some((format!("{ip}:{port_clone}"), port_clone))
                } else {
                    None
                };
                engine_clone.diag_record_net(|d| {
                    d.announce_addr = announced.as_ref().map(|(a, _)| a.clone());
                    d.announce_ms = crate::identity::now_ms();
                    d.nat_source = announced.as_ref().map(|_| {
                        if ext_port != 0 {
                            "upnp".to_string()
                        } else {
                            "public-ip".to_string()
                        }
                    });
                });
                if relay_allowed(&engine_clone) {
                    let agora = crate::identity::now_ms();
                    if agora - *last_announce.lock().unwrap_or_else(|e| e.into_inner())
                        >= ANNOUNCE_REPUBLISH_MS
                    {
                        *last_announce.lock().unwrap_or_else(|e| e.into_inner()) = agora;
                        let lan = local_lan_ip().map(|ip| format!("{ip}:{port_clone}"));
                        let (pub_addr, pub_port) = announced
                            .as_ref()
                            .map(|(a, p)| (Some(a.clone()), Some(*p)))
                            .unwrap_or((None, None));
                        let ann = serde_json::json!({
                            "fp": fp, "addr": pub_addr, "lan": lan,
                            "nickname": nickname, "port": pub_port,
                        })
                        .to_string();
                        let ann_topic = crate::net::relay::announce_topic(&fp);
                        let abackend = active_relay_backend(&engine_clone);
                        tokio::spawn(async move {
                            abackend.post(&ann_topic, &ann).await.ok();
                        });
                    }
                }
                if let Some((addr, announced_port)) = announced {
                    if !trackers.is_empty() {
                        let payload = serde_json::json!({ "fp": fp, "addr": addr, "nickname": nickname, "port": announced_port });
                        let trackers_c = trackers.clone();
                        tokio::spawn(async move {
                            let client = reqwest::Client::new();
                            for tr in &trackers_c {
                                let url = format!("{tr}/announce");
                                match client
                                    .post(&url)
                                    .json(&payload)
                                    .timeout(Duration::from_secs(5))
                                    .send()
                                    .await
                                {
                                    Ok(_) => {
                                        tracing::debug!(tracker=%tr, "tracker: anúncio aceito")
                                    }
                                    Err(e) => {
                                        tracing::debug!(tracker=%tr, "tracker falhou ({e}) — descoberta segue por MQTT/LAN/hole-punch")
                                    }
                                }
                            }
                        });
                    }
                    debug!(%fp, %addr, stun = stun_addr.is_some(), "bootstrap announce");
                    *engine_clone
                        .public_addr
                        .lock()
                        .unwrap_or_else(|e| e.into_inner()) = Some(addr.clone());
                    let nat_source = if stun_addr.is_some() { "stun" } else { "upnp" };
                    let _ = engine_clone.events.send(EngineEvent::NatEndpoint {
                        addr: addr.clone(),
                        source: nat_source.into(),
                    });
                }
                if let Ok(pending) = engine_clone.store.list_friends(Some("pending_out")) {
                    for peer in pending {
                        if announce_on && relay_allowed(&engine_clone) {
                            let ann_topic = crate::net::relay::announce_topic(&peer.fp);
                            let abackend = active_relay_backend(&engine_clone);
                            if let Ok(msgs) = abackend.poll(&ann_topic).await {
                                for raw in msgs.iter().rev().take(3) {
                                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
                                        let f = v.get("fp").and_then(|x| x.as_str()).unwrap_or("");
                                        if f == peer.fp {
                                            let lan = v.get("lan").and_then(|x| x.as_str());
                                            let pubip = v.get("addr").and_then(|x| x.as_str());
                                            for cand in [lan, pubip].into_iter().flatten() {
                                                if cand.is_empty() || cand == "null" {
                                                    continue;
                                                }
                                                if let Ok(sock) = cand.parse::<SocketAddr>() {
                                                    info!(fp=%peer.fp, %sock, "direta: endpoint via anúncio — sem relay");
                                                    engine_clone
                                                        .cmd_tx
                                                        .send(EngineCmd::ConnectTo(
                                                            sock,
                                                            Some(peer.fp.clone()),
                                                        ))
                                                        .ok();
                                                    break;
                                                }
                                            }
                                            break;
                                        }
                                    }
                                }
                            }
                        }
                        let has_link = engine_clone
                            .links
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .contains_key(&peer.fp);
                        if !has_link {
                            engine_clone
                                .cmd_tx
                                .send(EngineCmd::ConnectRelay(peer.fp.clone()))
                                .ok();
                        }
                        tracker_lookup_and_dial(&engine_clone, &peer.fp, &trackers).await;
                    }
                }
                if let Ok(friends) = engine_clone.store.list_friends(Some("accepted")) {
                    for peer in friends {
                        if peer.fp == engine_clone.identity.fingerprint {
                            continue;
                        }
                        let (has_link, is_direct_online) = {
                            let links =
                                engine_clone.links.lock().unwrap_or_else(|e| e.into_inner());
                            match links.get(&peer.fp) {
                                None => (false, false),
                                Some(l) => {
                                    let online = l.get_state() == PeerLinkState::Online;
                                    (true, online && !l.via_relay)
                                }
                            }
                        };
                        if !is_direct_online {
                            tracker_lookup_and_dial(&engine_clone, &peer.fp, &trackers).await;
                            engine_clone
                                .cmd_tx
                                .send(EngineCmd::LookupAnnounce(peer.fp.clone()))
                                .ok();
                            engine_clone.dht_probe(&peer.fp);
                        }
                        if !has_link {
                            engine_clone
                                .cmd_tx
                                .send(EngineCmd::ConnectRelay(peer.fp.clone()))
                                .ok();
                        }
                    }
                }
            }
        });
    }

    {
        let engine = engine.clone();
        tokio::spawn(async move {
            let mut cancel = engine.cancel_tx.subscribe();
            loop {
                if cancelled(&cancel) {
                    break;
                }
                let conn = tokio::select! {
                    _ = cancel.changed() => break,
                    c = listener.accept() => c,
                };
                match conn {
                    Ok((stream, peer)) => {
                        if !privacy_allows_lan(&engine) {
                            debug!("inbound direto recusado: modo anônimo (proxy/full)");
                            continue;
                        }
                        if engine.netlimiter.allow_tcp_accept(peer.ip()) == Decision::Blocked {
                            debug!(%peer, "accept descartado: rate limit de TCP inbound");
                            continue;
                        }
                        let Some(hs_slot) = engine.netlimiter.try_handshake_slot() else {
                            debug!(%peer, "accept descartado: teto de handshakes concorrentes");
                            continue;
                        };
                        let engine = engine.clone();
                        tokio::spawn(async move {
                            let _hs_slot = hs_slot;
                            match crate::net::transport::handshake_with_fp(
                                stream,
                                engine.keypair.clone(),
                                &engine.nickname,
                                engine.listen_port(),
                                false,
                                Some(engine.identity.fingerprint.clone()),
                            )
                            .await
                            {
                                Ok(hs) => {
                                    session::register_and_run(
                                        engine,
                                        hs.session,
                                        &hs.peer_fp,
                                        &hs.peer_pubkey_hex,
                                        &hs.peer_nickname,
                                        false,
                                        false,
                                        hs.peer_proto_v,
                                        hs.transcript_hash.clone(),
                                    )
                                    .await;
                                }
                                Err(e) => debug!("handshake inbound falhou: {e}"),
                            }
                        });
                    }
                    Err(e) => {
                        warn!("accept erro: {e}");
                        sleep(Duration::from_millis(300)).await;
                    }
                }
            }
        });
    }

    let (disc_tx, mut disc_rx) = mpsc::unbounded_channel::<DiscoveredPeer>();
    let disc_allowed: Arc<dyn Fn() -> bool + Send + Sync> = {
        let engine = engine.clone();
        Arc::new(move || !matches!(engine.privacy_mode().as_str(), "proxy" | "full"))
    };
    let _discovery = if discovery_enabled {
        Some(
            Discovery::spawn(
                engine.keypair.clone(),
                engine.nickname.clone(),
                port,
                disc_tx.clone(),
                disc_allowed.clone(),
                engine.netlimiter.clone(),
            )
            .await?,
        )
    } else {
        None
    };

    #[cfg(not(target_os = "android"))]
    let _mdns = if discovery_enabled {
        match crate::net::mdns::MdnsDiscovery::spawn(
            engine.keypair.clone(),
            engine.nickname.clone(),
            port,
            disc_tx,
            disc_allowed,
        ) {
            Ok(m) => Some(m),
            Err(e) => {
                warn!("mDNS indisponível ({e}) — seguindo só com discovery UDP");
                None
            }
        }
    } else {
        None
    };

    {
        let engine_pex = engine.clone();
        tokio::spawn(crate::net::dht::spawn_pex(engine_pex));
    }

    {
        let engine_dht = engine.clone();
        tokio::spawn(crate::net::dht::spawn_bit_dht(engine_dht));
    }

    {
        let engine_relay = engine.clone();
        tokio::spawn(relay_loop::relay_manager_loop(engine_relay));
    }

    {
        let engine_prewarm = engine.clone();
        tokio::spawn(async move {
            if !relay_allowed(&engine_prewarm) {
                return;
            }
            let backend = active_relay_backend(&engine_prewarm);
            let my_fp = engine_prewarm.identity.fingerprint.clone();
            let _ = backend.poll(&relay_topic(&my_fp)).await;
            debug!("relay prewarm ok");
        });
    }

    let mut flush_tick = interval(Duration::from_secs(5));
    let mut friend_tick = interval(Duration::from_secs(5));
    let mut friend_retry_tick: u32 = 0;
    let mut community_tick = interval(Duration::from_secs(15));
    let mut presence_tick = interval(Duration::from_secs(30));
    let mut profile_tick = interval(Duration::from_secs(PROFILE_SYNC_INTERVAL_SECS));
    loop {
        tokio::select! {
            Some(peer) = disc_rx.recv() => {
                if peer.fp == engine.identity.fingerprint { continue; }
                if matches!(engine.privacy_mode().as_str(), "proxy" | "full") {
                    continue;
                }
                let addr_str = peer.addr.to_string();
                let record = PeerRecord {
                    fp: peer.fp.clone(),
                    pubkey_hex: peer.pubkey_hex.clone(),
                    nickname: peer.nickname.clone(),
                    addr: Some(addr_str.clone()),
                    last_seen: crate::identity::now_ms(),
                    origin: "discovery".into(),
                };
                let _ = engine.store.upsert_peer(&record);
                let should_dial_direct = {
                    match engine.links.lock().unwrap_or_else(|e| e.into_inner()).get(&peer.fp) {
                        None => true,
                        Some(l) => l.via_relay && l.get_state() == PeerLinkState::Online,
                    }
                };
                let _ = engine.events.send(EngineEvent::PeerDiscovered {
                    fp: peer.fp.clone(),
                    nickname: peer.nickname.clone(),
                    addr: addr_str,
                });
                if should_dial_direct {
                    engine.cmd_tx.send(EngineCmd::ConnectTo(peer.addr, Some(peer.fp))).ok();
                }
            }
            _ = flush_tick.tick() => {
                engine.tunnel_reap_stale();
                engine.reap_half_open_links();
                let cutoff = crate::identity::now_ms() - 20_000;
                for fp in engine.online_peer_fps() {
                    if let Ok(ids) = engine.store.revert_stale_sent_to_pending(&fp, cutoff) {
                        for id in ids {
                            let _ = engine.events.send(EngineEvent::MessageStatus { msg_id: id, status: "pending".into() });
                        }
                    }
                    engine.cmd_tx.send(EngineCmd::FlushOutbox(fp)).ok();
                }
            }
            _ = friend_tick.tick() => {
                friend_retry_tick = friend_retry_tick.wrapping_add(1);
                let reaceita = friend_retry_tick % 3 == 0;
                for fp in engine.online_peer_fps() {
                    engine.retry_pending_friend_request(&fp, reaceita);
                }
            }
            _ = community_tick.tick() => {
                engine.maintain_communities();
                engine.maintain_groups();
                engine.reannounce_voice_channels();
                engine.reannounce_files();
                engine.room_tick_arc();
            }
            _ = presence_tick.tick() => {
                let me = engine.identity.fingerprint.clone();
                if let Ok(mut presence) = engine.store.presence_get_live(&me) {
                    let status = if presence.status.is_empty() || presence.status == "offline" {
                        "online".to_string()
                    } else {
                        presence.status.clone()
                    };
                    presence.status = status.clone();
                    if engine.store.presence_set(
                        &me,
                        &status,
                        &presence.custom,
                        &presence.custom_emoji,
                    ).is_ok() {
                        engine.announce_presence();
                    }
                }
            }
            _ = profile_tick.tick() => {
                engine.sync_profiles_with_peers();
            }
        }
    }
}
