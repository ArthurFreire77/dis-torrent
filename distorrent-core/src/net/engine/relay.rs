// Metodos de NetworkEngine: relay.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub async fn relay_diagnostics(&self) -> Vec<crate::net::relay::RelayLegStatus> {
        let proxy = self.anonymity_proxy();
        crate::net::relay::check_relay_legs_via(proxy.as_deref()).await
    }

    pub fn connect_host(&self, host_port: &str, expected_fp: Option<String>) -> Result<()> {
        let (host, port) = split_host_port(host_port)?;
        self.cmd_tx
            .send(EngineCmd::ConnectHost {
                host,
                port,
                expected_fp,
            })
            .ok();
        Ok(())
    }

    pub fn add_manual_peer(&self, addr: SocketAddr, expected_fp: Option<String>) {
        self.cmd_tx
            .send(EngineCmd::ConnectTo(addr, expected_fp))
            .ok();
    }

    pub fn set_relay_backend(&self, backend: Arc<dyn RelayBackend>) {
        *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) = backend;
        self.relay_backend_custom.store(true, Ordering::Relaxed);
        self.relay_proxied.store(false, Ordering::Relaxed);
        self.relay_disabled.store(false, Ordering::Relaxed);
    }

    pub fn set_relay_disabled(&self, disabled: bool) {
        self.relay_disabled.store(disabled, Ordering::Relaxed);
        self.peer_relay_disabled.store(disabled, Ordering::Relaxed);
        self.refresh_peer_relay();
        debug!(disabled, "relay: kill-switch atualizado");
    }

    pub fn relay_is_disabled(&self) -> bool {
        self.relay_disabled.load(Ordering::Relaxed)
    }

    pub fn relay_is_proxied(&self) -> bool {
        self.relay_proxied.load(Ordering::Relaxed)
    }

    pub fn punch_enabled(&self) -> bool {
        self.punch_enabled.load(Ordering::Relaxed)
    }

    pub fn set_punch_enabled(&self, on: bool) {
        self.punch_enabled.store(on, Ordering::Relaxed);
        debug!(on, "hole punch: kill-flag atualizado");
    }

    pub(super) fn refresh_relay_for_privacy(&self) {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return;
        }
        let mode = self.privacy_mode();
        let proxy_mode = matches!(mode.as_str(), "proxy" | "full");
        let currently_proxied = self.relay_proxied.load(Ordering::Relaxed);
        if proxy_mode {
            let proxy = self
                .anonymity_proxy()
                .unwrap_or_else(|| "127.0.0.1:1080".to_string());
            match MultiRelay::proxied_routes_with_fp(&proxy, &self.identity.fingerprint) {
                Ok(b) => {
                    *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(b);
                    self.relay_proxied.store(true, Ordering::Relaxed);
                    debug!(%proxy, "relay: modo anônimo — MQTT via túneis SOCKS5 (sem abrir porta, sem vazar IP)");
                }
                Err(e) => {
                    self.relay_proxied.store(false, Ordering::Relaxed);
                    debug!("relay: proxy SOCKS5 inválido ({e}) — relay desligado no modo anônimo (fail-closed)");
                }
            }
        } else if currently_proxied {
            *self.relay_backend.lock().unwrap_or_else(|e| e.into_inner()) = Arc::new(
                MultiRelay::routes_from_env_or_default(&self.identity.fingerprint),
            );
            self.relay_proxied.store(false, Ordering::Relaxed);
            debug!("relay: modo normal/encrypted — rotas públicas diretas restauradas");
        }
    }

    pub fn set_public_addr(&self, addr: String) {
        *self.public_addr.lock().unwrap_or_else(|e| e.into_inner()) = Some(addr);
    }

    pub fn is_peer_via_relay(&self, fp: &str) -> bool {
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| l.via_relay && l.get_state() == PeerLinkState::Online)
            .unwrap_or(false)
    }

    pub fn relay_stats(&self) -> (u64, u64) {
        let backend = self
            .relay_backend
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let s = backend.stats();
        (s.posts, s.poll_hits)
    }

    pub fn peer_relay_fp(&self) -> Option<String> {
        self.peer_relay
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn peer_relay_serving_enabled(&self) -> bool {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return false;
        }
        if !self.peer_relay_optin.load(Ordering::Relaxed) {
            return false;
        }
        if self.peer_relay_disabled.load(Ordering::Relaxed) {
            return false;
        }
        peer_relay_policy(&self.privacy_mode()).1
    }

    pub fn peer_relay_enabled(&self) -> bool {
        if self.relay_backend_custom.load(Ordering::Relaxed) {
            return false;
        }
        if !self.peer_relay_optin.load(Ordering::Relaxed) {
            return false;
        }
        if self.peer_relay_disabled.load(Ordering::Relaxed) {
            return false;
        }
        peer_relay_policy(&self.privacy_mode()).0
    }

    pub fn peer_relay_optin_enabled(&self) -> bool {
        self.peer_relay_optin.load(Ordering::Relaxed)
    }

    pub fn set_peer_relay_enabled(&self, on: bool) {
        self.peer_relay_optin.store(on, Ordering::Relaxed);
        if on {
            self.peer_relay_disabled.store(false, Ordering::Relaxed);
        }
        self.refresh_peer_relay();
        debug!(on, "peer-relay: opt-in atualizado");
    }

    pub(super) fn refresh_peer_relay(&self) {
        let new = if self.peer_relay_enabled() {
            let me = self.identity.fingerprint.clone();
            let mut cands: Vec<String> = self
                .links
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .filter(|(fp, l)| {
                    fp.as_str() != me.as_str()
                        && l.get_state() == PeerLinkState::Online
                        && !l.via_relay
                })
                .map(|(fp, _)| fp.clone())
                .collect();
            cands.retain(|fp| !self.is_blocked(fp));
            cands.sort();
            cands.into_iter().next()
        } else {
            None
        };
        let mut cur = self.peer_relay.lock().unwrap_or_else(|e| e.into_inner());
        if *cur != new {
            match &new {
                Some(fp) => debug!(%fp, "peer-relay: intermediário direto selecionado"),
                None => debug!("peer-relay: sem intermediário — usa relay configurado"),
            }
            *cur = new;
        }
    }

    pub(super) fn peer_relay_backend_for(
        self: &Arc<Self>,
        relay_fp: &str,
    ) -> Arc<PeerRelayBackend> {
        let mut cache = self
            .peer_relay_backend
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some((fp, b)) = cache.as_ref() {
            if fp == relay_fp {
                return b.clone();
            }
        }
        let b = Arc::new(PeerRelayBackend::new(
            Arc::downgrade(self),
            relay_fp.to_string(),
        ));
        *cache = Some((relay_fp.to_string(), b.clone()));
        b
    }

    pub(super) fn host_relay(
        &self,
        community_id: &str,
        channel_id: &str,
        env: &MessageEnvelope,
        bot_id: &str,
    ) -> Result<()> {
        for (fp, _nick, _role) in self.store.list_members(community_id)? {
            if fp == env.author_fp || fp == self.identity.fingerprint {
                continue;
            }
            if self.link_tx(&fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp,
                        SecureFrame::ChannelMsg {
                            community_id: community_id.into(),
                            channel_id: channel_id.into(),
                            env: env.clone(),
                            bot_id: bot_id.into(),
                        },
                    ))
                    .ok();
            }
        }
        if env.author_fp != self.identity.fingerprint && self.link_tx(&env.author_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    env.author_fp.clone(),
                    SecureFrame::ChannelAck {
                        env_id: env.id.clone(),
                    },
                ))
                .ok();
        }
        Ok(())
    }
}
