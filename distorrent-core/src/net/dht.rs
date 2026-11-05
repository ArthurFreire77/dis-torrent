use std::sync::Arc;
use std::time::Duration;
use tokio::time::interval;
use tracing::debug;

use crate::net::engine::NetworkEngine;

pub async fn spawn_pex(engine: Arc<NetworkEngine>) {
    let mut tick = interval(Duration::from_secs(20));
    let cancel = engine.cancel_subscribe();
    loop {
        if engine.is_cancelled(&cancel) {
            return;
        }
        tick.tick().await;
        let mode = engine.privacy_mode();
        if matches!(mode.as_str(), "proxy" | "full") {
            continue;
        }
        let known = engine.pex_peers(10);
        if known.is_empty() {
            continue;
        }
        let online = engine.online_friend_fps();
        if online.is_empty() {
            continue;
        }
        debug!(peers=%known.len(), online=%online.len(), "PEX: compartilhando {} peers com {} online", known.len(), online.len());
        for fp in online {
            let peers_clone = known.clone();
            let frame = crate::protocol::SecureFrame::PeerExchange { peers: peers_clone };
            engine.send_to_peer(fp, frame);
        }
    }
}

pub fn identity_infohash(fp: &str) -> mainline::Id {
    let h = blake3::hash(format!("distorrent-dht-v1:{fp}").as_bytes());
    let bytes: [u8; 20] = h.as_bytes()[..20].try_into().expect("blake3 gera 32B");
    mainline::Id::from_bytes(bytes).expect("Id aceita 20B")
}

pub fn bit_dht_enabled() -> bool {
    if matches!(
        std::env::var("DISTORRENT_NO_DHT")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    ) {
        return false;
    }
    matches!(
        std::env::var("DISTORRENT_DHT")
            .ok()
            .as_deref()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("1" | "true" | "yes" | "on")
    )
}

pub async fn spawn_bit_dht(engine: Arc<NetworkEngine>) {
    if !bit_dht_enabled() {
        debug!("DHT BitTorrent: desligada via DISTORRENT_NO_DHT");
        return;
    }
    let mut next_announce = 0i64;
    let cancel = engine.cancel_subscribe();
    loop {
        tokio::time::sleep(Duration::from_secs(5)).await;
        if engine.is_cancelled(&cancel) {
            return;
        }
        let mode = engine.privacy_mode();
        if matches!(mode.as_str(), "proxy" | "full") {
            engine.shutdown_bit_dht();
            engine.diag_record_net(|d| {
                d.dht_ok = Some(false);
                d.dht_ms = crate::identity::now_ms();
            });
            continue;
        }
        if engine.ensure_bit_dht().is_err() {
            engine.diag_record_net(|d| {
                d.dht_ok = Some(false);
                d.dht_ms = crate::identity::now_ms();
            });
            continue;
        }
        engine.diag_record_net(|d| {
            if d.dht_ok.is_none() {
                d.dht_ok = Some(true);
                d.dht_ms = crate::identity::now_ms();
            }
        });

        let now = crate::identity::now_ms();
        if now >= next_announce {
            next_announce = now + 60_000;
            if let Some(port) = engine.dht_announce_port() {
                let eng = engine.clone();
                let own = identity_infohash(&engine.identity().fingerprint);
                let r = tokio::task::spawn_blocking(move || eng.bit_dht_announce(own, port)).await;
                if let Ok(Ok(())) = r {
                    engine.diag_record_net(|d| {
                        d.dht_ok = Some(true);
                        d.dht_ms = crate::identity::now_ms();
                    });
                }
            } else {
                debug!("DHT: sem endpoint externo confirmado — pulo o announce (lookup segue)");
            }
        }

        let mut targets = engine.dht_queue_pop(16);
        if targets.is_empty() {
            targets = engine.friends_without_session(8);
        }
        for fp in targets {
            if !engine.dht_lookup_due(&fp, 20_000) {
                continue;
            }
            let eng = engine.clone();
            let fp = fp.clone();
            tokio::task::spawn_blocking(move || eng.bit_dht_lookup_and_dial(fp));
        }
    }
}
