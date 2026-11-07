// Metodos de NetworkEngine: diagnostics.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub(super) fn diag_update(&self, fp: &str, f: impl FnOnce(&mut PeerDiagInfo)) {
        let mut map = self.peer_diag.lock().unwrap_or_else(|e| e.into_inner());
        let now = crate::identity::now_ms();
        let entry = map.entry(fp.to_string()).or_default();
        f(entry);
        entry.last_seen_ms = now;
        if map.len() > 512 {
            let mut recent: Vec<(String, i64)> = map
                .iter()
                .map(|(k, v)| (k.clone(), v.last_seen_ms))
                .collect();
            recent.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
            let keep: std::collections::HashSet<String> =
                recent.into_iter().take(512).map(|(k, _)| k).collect();
            map.retain(|k, _| keep.contains(k));
        }
    }

    pub fn peer_diag(&self, fp: &str) -> PeerDiagInfo {
        self.peer_diag
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .cloned()
            .unwrap_or_default()
    }

    pub fn net_diag(&self) -> NetDiagInfo {
        self.net_diag
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub(super) fn diag_record_direct_err(&self, fp: &str, err: &str) {
        self.diag_update(fp, |d| {
            d.last_direct_err = Some(short_diag_err(err));
            d.direct_attempts = d.direct_attempts.saturating_add(1);
        });
    }

    pub(super) fn diag_record_direct_ok(&self, fp: &str) {
        self.diag_update(fp, |d| {
            d.last_direct_err = None;
            d.last_direct_ok_ms = crate::identity::now_ms();
        });
    }

    pub(super) fn diag_record_relay_err(&self, fp: &str, err: &str) {
        self.diag_update(fp, |d| {
            d.last_relay_err = Some(short_diag_err(err));
            d.relay_attempts = d.relay_attempts.saturating_add(1);
        });
    }

    pub(super) fn diag_record_relay_ok(&self, fp: &str) {
        self.diag_update(fp, |d| {
            d.last_relay_err = None;
            d.last_relay_ok_ms = crate::identity::now_ms();
        });
    }

    pub(super) fn diag_record_announce_seen(&self, fp: &str) {
        self.diag_update(fp, |d| {
            d.announce_seen_ms = crate::identity::now_ms();
        });
    }

    pub fn diag_record_net(&self, f: impl FnOnce(&mut NetDiagInfo)) {
        let mut d = self.net_diag.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut d);
    }

    pub fn net_limits_snapshot(&self) -> crate::net::netlimit::LimitsSnapshot {
        self.netlimiter.snapshot()
    }

    pub fn net_limits_reconfigure(&self, l: crate::net::netlimit::Limits) {
        self.netlimiter.reconfigure(l);
    }

    pub fn peers(&self) -> Vec<PeerRecord> {
        self.store.list_peers().unwrap_or_default()
    }

    pub fn online_peer_fps(&self) -> Vec<String> {
        self.links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter(|(_, l)| l.get_state() == PeerLinkState::Online)
            .map(|(fp, _)| fp.clone())
            .collect()
    }

    pub fn online_friend_fps(&self) -> Vec<String> {
        let accepted: std::collections::HashSet<String> = self
            .store
            .list_friends(Some("accepted"))
            .unwrap_or_default()
            .into_iter()
            .map(|f| f.fp)
            .collect();
        self.online_peer_fps()
            .into_iter()
            .filter(|fp| accepted.contains(fp))
            .collect()
    }

    pub fn peer_state(&self, fp: &str) -> NetworkState {
        let st = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| match l.get_state() {
                PeerLinkState::Online => NetworkState::Connected,
                PeerLinkState::Connecting => NetworkState::Connecting,
                PeerLinkState::Reconnecting => NetworkState::Reconnecting,
            })
            .unwrap_or(NetworkState::Disconnected);
        if st == NetworkState::Connected && !self.peer_alive(fp) {
            return NetworkState::Reconnecting;
        }
        st
    }

    pub fn peer_alive(&self, fp: &str) -> bool {
        let now = crate::identity::now_ms();
        let diag = self.peer_diag.lock().unwrap_or_else(|e| e.into_inner());
        let info = match diag.get(fp) {
            Some(d) => d,
            None => return false,
        };
        let last_rx = info.last_rx_ms;
        let online_desde = info.last_direct_ok_ms.max(info.last_relay_ok_ms);
        drop(diag);
        // Um link recém-conectado ainda não recebeu nada: isso NÃO é "vivo",
        // é "não provado". Antes `last_rx == 0` devolvia `true` para sempre e a
        // UI mostrava Conectado num par que nunca entregou um único frame.
        if last_rx == 0 {
            let graca_ms = FIRST_FRAME_GRACE.as_millis() as i64;
            return online_desde > 0 && now.saturating_sub(online_desde) <= graca_ms;
        }
        let via_relay = self
            .links
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .map(|l| l.via_relay)
            .unwrap_or(false);
        let janela_ms = if via_relay {
            RELAY_PING_TIMEOUT.as_millis() as i64
        } else {
            PING_TIMEOUT.as_millis() as i64
        };
        now.saturating_sub(last_rx) <= janela_ms
    }

    pub fn aggregated_state(&self) -> NetworkState {
        self.network_snapshot().0
    }

    /// Estado agregado e contagem de online na MESMA leitura.
    ///
    /// Antes a UI chamava `aggregated_state()` e `online_peer_fps().len()` em
    /// dois locks diferentes: entre um e outro o conjunto de links mudava e a
    /// pílula mostrava o par impossível "DISCONNECTED com 1 pessoa online".
    pub fn network_snapshot(&self) -> (NetworkState, usize) {
        let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
        let mut online = 0usize;
        let mut reconnecting = false;
        let mut connecting = false;
        for l in links.values() {
            match l.get_state() {
                PeerLinkState::Online => online += 1,
                PeerLinkState::Reconnecting => reconnecting = true,
                PeerLinkState::Connecting => connecting = true,
            }
        }
        let state = if online > 0 {
            NetworkState::Connected
        } else if reconnecting {
            NetworkState::Reconnecting
        } else if connecting {
            NetworkState::Connecting
        } else {
            NetworkState::Disconnected
        };
        (state, online)
    }

    pub fn peer_rtt_ms(&self, fp: &str) -> Option<u64> {
        crate::metrics::metrics().rtt_of(fp)
    }
}
