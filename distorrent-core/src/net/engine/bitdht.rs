// Metodos de NetworkEngine: bitdht.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn ensure_bit_dht(&self) -> Result<()> {
        let mut guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Ok(());
        }
        match mainline::Dht::client() {
            Ok(dht) => {
                *guard = Some(Arc::new(dht));
                debug!("DHT BitTorrent: nó mainline iniciado (descoberta descentralizada)");
                Ok(())
            }
            Err(e) => {
                debug!("DHT BitTorrent: falhou ao subir nó ({e}) — tenta de novo");
                Err(DistorrentError::Protocol(format!("dht node: {e}")))
            }
        }
    }

    pub fn shutdown_bit_dht(&self) {
        let mut guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dht) = guard.take() {
            let _ = Arc::try_unwrap(dht).map(|mut d| d.shutdown());
        }
    }

    pub fn bit_dht_announce(&self, infohash: mainline::Id, port: u16) -> Result<()> {
        let guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        let dht = guard
            .as_ref()
            .ok_or_else(|| DistorrentError::Protocol("dht não iniciada".into()))?;
        dht.announce_peer(infohash, Some(port))
            .map(|_| ())
            .map_err(|e| DistorrentError::Protocol(format!("announce_peer: {e}")))
    }

    pub fn bit_dht_lookup_and_dial(&self, peer_fp: String) -> usize {
        self.dht_lookups
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(peer_fp.clone(), crate::identity::now_ms());
        let guard = self.bit_dht.lock().unwrap_or_else(|e| e.into_inner());
        let Some(dht) = guard.as_ref().cloned() else {
            return 0;
        };
        drop(guard);
        let ih = crate::net::dht::identity_infohash(&peer_fp);
        let mut found: Vec<std::net::SocketAddr> = Vec::new();
        if let Ok(iter) = dht.get_peers(ih) {
            for batch in iter {
                for a in batch {
                    if found.len() >= 8 {
                        break;
                    }
                    found.push(a);
                }
                if found.len() >= 8 {
                    break;
                }
            }
        }
        if found.is_empty() {
            self.diag_update(&peer_fp, |d| {
                d.last_direct_err = Some("DHT: sem peers no infohash (amigo offline?)".into());
                d.direct_attempts = d.direct_attempts.saturating_add(1);
            });
            return 0;
        }
        info!(fp=%peer_fp, addrs=?found, "DHT BitTorrent: endpoints descobertos — dial direto");
        self.diag_update(&peer_fp, |d| {
            d.announce_seen_ms = crate::identity::now_ms();
        });
        let n = found.len();
        for a in found {
            self.cmd_tx
                .send(EngineCmd::ConnectTo(a, Some(peer_fp.clone())))
                .ok();
        }
        n
    }

    pub fn dht_probe(&self, peer_fp: &str) {
        if !crate::net::dht::bit_dht_enabled() {
            return;
        }
        let mut q = self.dht_queue.lock().unwrap_or_else(|e| e.into_inner());
        if q.len() < 64 {
            q.push(peer_fp.to_string());
        }
    }

    pub fn dht_queue_pop(&self, max: usize) -> Vec<String> {
        let mut q = self.dht_queue.lock().unwrap_or_else(|e| e.into_inner());
        let mut out = Vec::new();
        while out.len() < max && !q.is_empty() {
            let fp = q.remove(0);
            if !out.contains(&fp) {
                out.push(fp);
            }
        }
        out
    }

    pub fn dht_lookup_due(&self, peer_fp: &str, min_ms: i64) -> bool {
        let map = self.dht_lookups.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(peer_fp) {
            Some(t) => crate::identity::now_ms().saturating_sub(*t) >= min_ms,
            None => true,
        }
    }

    pub fn friends_without_session(&self, max: usize) -> Vec<String> {
        let accepted = self
            .store
            .list_friends(Some("accepted"))
            .unwrap_or_default();
        let pending = self
            .store
            .list_friends(Some("pending_out"))
            .unwrap_or_default();
        let friends: Vec<String> = accepted.into_iter().chain(pending).map(|p| p.fp).collect();
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        friends
            .into_iter()
            .filter(|fp| {
                links
                    .get(fp)
                    .map(|l| l.get_state() != PeerLinkState::Online)
                    .unwrap_or(true)
            })
            .take(max)
            .collect()
    }

    pub fn maybe_auto_fallback_proxy(&self, peer_fp: &str) {
        if self.peer_relay_fp().is_some() {
            return;
        }
        let now = crate::identity::now_ms();
        let (count, first_ms) = {
            let map = self.dial_failures.lock().unwrap_or_else(|e| e.into_inner());
            map.get(peer_fp).copied().unwrap_or((0, 0))
        };
        let stalled = first_ms > 0 && now.saturating_sub(first_ms) >= AUTO_PROXY_STALL_MS;
        let failures = if stalled {
            count.max(AUTO_PROXY_FAILURE_THRESHOLD)
        } else {
            count
        };
        let already_switched = {
            let map = self
                .auto_proxy_switched
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.get(peer_fp)
                .map(|ts| now.saturating_sub(*ts) < AUTO_PROXY_COOLDOWN_MS)
                .unwrap_or(false)
        };
        let mode = self.privacy_mode();
        if !auto_proxy_should_switch(
            &mode,
            self.proxy_configured(),
            auto_proxy_enabled(),
            already_switched,
            failures,
        ) {
            return;
        }
        self.auto_proxy_switched
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(peer_fp.to_string(), now);
        let reason = format!(
            "sem conexão direta nem intermediário após {failures} falhas — roteando por SOCKS5"
        );
        match self.privacy_set_mode("proxy") {
            Ok(()) => {
                let _ = self.store.kv_set("privacy.auto_switched", "1");
                let _ = self.store.kv_set("privacy.auto_switched.peer", peer_fp);
                let _ = self.store.kv_set("privacy.auto_switched.reason", &reason);
                info!(peer_fp, %reason, "fallback automático: modo de privacidade → proxy (SOCKS5)");
                let _ = self.events.send(EngineEvent::ModeAutoSwitched {
                    to: "proxy".to_string(),
                    reason,
                });
            }
            Err(e) => warn!(peer_fp, "fallback automático para proxy falhou: {e}"),
        }
    }
}
