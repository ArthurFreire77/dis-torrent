// Metodos de NetworkEngine: privacy.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn privacy_set_mode(&self, mode: &str) -> Result<()> {
        match mode {
            "normal" | "encrypted" | "proxy" | "full" => {
                self.store.kv_set("privacy.mode", mode)?;
                self.refresh_relay_for_privacy();
                self.refresh_peer_relay();
                if matches!(mode, "proxy" | "full") {
                    let direct: Vec<String> = {
                        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
                        links
                            .iter()
                            .filter(|(_, l)| l.get_state() == PeerLinkState::Online && !l.via_relay)
                            .map(|(fp, _)| fp.clone())
                            .collect()
                    };
                    for fp in direct {
                        info!(%fp, "sessão direta encerrada: política anônima em vigor");
                        self.disconnect_peer(&fp);
                    }
                    *self.public_addr.lock().unwrap_or_else(|e| e.into_inner()) = None;
                }
                Ok(())
            }
            _ => Err(DistorrentError::Protocol(format!(
                "modo de privacidade inválido: {mode}"
            ))),
        }
    }

    pub fn privacy_mode(&self) -> String {
        self.store
            .kv_get("privacy.mode")
            .unwrap_or_else(|| "encrypted".to_string())
    }

    fn anonymity_addr_key(mode: &str) -> &'static str {
        if mode == "full" {
            "privacy.tor_addr"
        } else {
            "privacy.proxy_addr"
        }
    }

    pub fn anonymity_proxy(&self) -> Option<String> {
        let mode = self.privacy_mode();
        match mode.as_str() {
            "full" => {
                if let Some(addr) = self.store.kv_get(Self::anonymity_addr_key(&mode)) {
                    if !addr.trim().is_empty() {
                        return Some(addr);
                    }
                }
                Some(
                    std::env::var("DISTORRENT_TOR_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:9050".to_string()),
                )
            }
            "proxy" => {
                if let Some(addr) = self.store.kv_get(Self::anonymity_addr_key(&mode)) {
                    if !addr.trim().is_empty() {
                        return Some(addr);
                    }
                }
                Some(
                    std::env::var("DISTORRENT_PROXY_ADDR")
                        .unwrap_or_else(|_| "127.0.0.1:1080".to_string()),
                )
            }
            _ => None,
        }
    }

    pub fn set_anonymity_addr(&self, mode: &str, addr: &str) -> Result<()> {
        let key = Self::anonymity_addr_key(mode);
        let addr = addr.trim();
        if addr.is_empty() {
            self.store.kv_delete(key)?;
        } else {
            let _ = crate::net::socks5::split_host_port(addr)?;
            self.store.kv_set(key, addr)?;
        }
        self.refresh_relay_for_privacy();
        Ok(())
    }

    pub(super) fn proxy_configured(&self) -> bool {
        if let Ok(v) = std::env::var("DISTORRENT_PROXY_ADDR") {
            if !v.trim().is_empty() {
                return true;
            }
        }
        self.store
            .kv_get("privacy.proxy_addr")
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
    }

    fn record_dial_failure(&self, peer_fp: &str) {
        if peer_fp.is_empty() {
            return;
        }
        let now = crate::identity::now_ms();
        let mut map = self.dial_failures.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() > 4096 {
            map.clear();
        }
        let e = map.entry(peer_fp.to_string()).or_insert((0, now));
        e.0 = e.0.saturating_add(1);
        if e.0 == 1 {
            e.1 = now;
        }
    }

    pub(super) fn reset_dial_failures(&self, peer_fp: &str) {
        self.dial_failures
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(peer_fp);
    }

    pub fn note_dial_failure(&self, peer_fp: &str) {
        self.record_dial_failure(peer_fp);
        if self.direct_unreachable(peer_fp) {
            self.request_peer_path(peer_fp);
        }
        self.maybe_auto_fallback_proxy(peer_fp);
    }

    pub fn direct_unreachable(&self, peer_fp: &str) -> bool {
        let (count, first_ms) = {
            let map = self.dial_failures.lock().unwrap_or_else(|e| e.into_inner());
            map.get(peer_fp).copied().unwrap_or((0, 0))
        };
        if count < DIRECT_UNREACHABLE_THRESHOLD {
            return false;
        }
        let now = crate::identity::now_ms();
        first_ms > 0 && now.saturating_sub(first_ms) >= DIRECT_UNREACHABLE_STALL_MS
    }

    fn request_peer_path(&self, peer_fp: &str) {
        if peer_fp.is_empty() || peer_fp == self.identity.fingerprint {
            return;
        }
        self.diag_update(peer_fp, |d| {
            d.last_direct_err = Some(format!(
                "sem porta TCP aberta dos dois lados ({} falhas) — usando relay/tunel",
                d.direct_attempts
            ));
        });
        self.tunnel_request(peer_fp);
    }
}
