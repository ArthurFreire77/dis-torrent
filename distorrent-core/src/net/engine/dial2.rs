// Manutenção de uma conexão de par (retry/backoff).

use super::*;

pub(super) async fn connect_and_maintain(
    engine: Arc<NetworkEngine>,
    target: ConnTarget,
    expected_fp: Option<String>,
) {
    let mut backoff = Duration::from_secs(1);
    let cancel = engine.cancel_tx.subscribe();
    loop {
        if cancelled(&cancel) {
            return;
        }
        let dial_slot = match engine.netlimiter.try_dial_slot() {
            Some(g) => g,
            None => {
                sleep(Duration::from_millis(400)).await;
                continue;
            }
        };
        if let Some(fp) = &expected_fp {
            set_link_state(&engine, fp, PeerLinkState::Connecting);
        }

        let attempt = async {
            let privacy_mode = engine
                .store
                .kv_get("privacy.mode")
                .unwrap_or_else(|| "encrypted".to_string());
            let use_tor = privacy_mode == "full";
            let use_proxy = privacy_mode == "proxy" || use_tor;
            let socks_target = match &target {
                ConnTarget::Addr(sa) => SocksTarget::Addr(*sa),
                ConnTarget::Host(h, p) => SocksTarget::Host(h.clone(), *p),
            };
            let stream: TcpStream = if use_proxy {
                let proxy_addr = if use_tor {
                    std::env::var("DISTORRENT_TOR_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:9050".to_string())
                } else {
                    std::env::var("DISTORRENT_PROXY_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:1080".to_string())
                };
                match timeout(CONNECT_TIMEOUT, socks5_connect(&proxy_addr, &socks_target)).await {
                    Ok(Ok(s)) => s,
                    Ok(Err(e)) => {
                        debug!(
                            proxy = %proxy_addr,
                            "proxy falhou ({e}) — SEM fallback direto (modo anônimo fail-closed)"
                        );
                        return Err(e);
                    }
                    Err(_) => {
                        return Err(DistorrentError::Protocol("proxy connect timeout".into()))
                    }
                }
            } else {
                match &target {
                    ConnTarget::Addr(sa) => timeout(CONNECT_TIMEOUT, TcpStream::connect(*sa))
                        .await
                        .map_err(|_| DistorrentError::Protocol("connect timeout".into()))??,
                    ConnTarget::Host(h, p) => resolve_and_connect(h, *p).await?,
                }
            };
            let hs = crate::net::transport::handshake_with_fp(
                stream,
                engine.keypair.clone(),
                &engine.nickname,
                engine.listen_port(),
                true,
                Some(engine.identity.fingerprint.clone()),
            )
            .await?;
            if let Some(want) = &expected_fp {
                if &hs.peer_fp != want {
                    return Err(DistorrentError::Protocol(format!(
                        "peer apresentou {} mas esperávamos {want}",
                        hs.peer_fp
                    )));
                }
            }
            Ok::<_, DistorrentError>(hs)
        };

        match attempt.await {
            Ok(hs) => {
                backoff = Duration::from_secs(1);
                let fp = hs.peer_fp.clone();
                engine.diag_record_direct_ok(&fp);
                {
                    let mut m = engine
                        .tor_timeouts
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    m.remove(&fp);
                }
                let registered = session::register_and_run(
                    engine.clone(),
                    hs.session,
                    &fp,
                    &hs.peer_pubkey_hex,
                    &hs.peer_nickname,
                    true,
                    false,
                    hs.peer_proto_v,
                    hs.transcript_hash.clone(),
                )
                .await;
                if !registered {
                    sleep(Duration::from_secs(3)).await;
                    continue;
                }
                set_link_state(&engine, &fp, PeerLinkState::Reconnecting);
            }
            Err(e) => {
                debug!(target = ?target, "conexão falhou: {e}");
                if let Some(fp) = &expected_fp {
                    engine.diag_record_direct_err(
                        fp,
                        &match &e {
                            DistorrentError::Protocol(p) => p.clone(),
                            other => other.to_string(),
                        },
                    );
                }
                if let Some(fp) = &expected_fp {
                    engine.note_dial_failure(fp);
                    // Sem isto o peer ficava "CONECTANDO" para sempre no painel:
                    // o link era criado em Connecting e nenhum caminho de erro
                    // mudava o estado. Reconnecting diz a verdade e o backoff
                    // abaixo continua tentando.
                    set_link_state(&engine, fp, PeerLinkState::Reconnecting);
                }
                if let Some(fp) = &expected_fp {
                    let mode = engine
                        .store
                        .kv_get("privacy.mode")
                        .unwrap_or_else(|| "encrypted".to_string());
                    let err_s = match &e {
                        DistorrentError::Protocol(p) => p.clone(),
                        other => other.to_string(),
                    };
                    if mode == "full" && err_s.contains("timeout") {
                        let n = {
                            let mut m = engine
                                .tor_timeouts
                                .lock()
                                .unwrap_or_else(|e| e.into_inner());
                            if m.len() > 4096 {
                                m.clear();
                            }
                            let c = m.get(fp).copied().unwrap_or(0) + 1;
                            m.insert(fp.clone(), c);
                            c
                        };
                        if n >= 3 {
                            {
                                let mut m = engine
                                    .tor_timeouts
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner());
                                m.remove(fp);
                            }
                            debug!(fp, "tor: 3 timeouts seguidos — caindo para o túnel virtual");
                            engine.diag_record_direct_err(
                                fp,
                                "tor: 3 timeouts — tentando túnel virtual",
                            );
                            engine.tunnel_request(fp);
                        }
                    }
                }
            }
        }
        drop(dial_slot);
        sleep(backoff).await;
        backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX);
    }
}
