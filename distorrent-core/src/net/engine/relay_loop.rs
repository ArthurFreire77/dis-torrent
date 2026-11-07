// Gerenciador do relay MQTT.

use super::*;

pub(super) async fn relay_manager_loop(engine: Arc<NetworkEngine>) {
    let mut reasm = Reassembler::new();
    let mut seen: std::collections::HashSet<u64> = std::collections::HashSet::new();
    let mut last_hello: std::collections::HashMap<String, ([u8; 32], [u8; 16])> =
        std::collections::HashMap::new();
    let mut first = true;
    let (wake_tx, mut wake_rx) = mpsc::unbounded_channel::<()>();
    {
        let backend = active_relay_backend(&engine);
        for note in backend.wakes() {
            let wake_tx = wake_tx.clone();
            tokio::spawn(async move {
                loop {
                    note.notified().await;
                    if wake_tx.send(()).is_err() {
                        break;
                    }
                }
            });
        }
    }
    let cancel = engine.cancel_tx.subscribe();
    loop {
        if cancelled(&cancel) {
            break;
        }
        if !first {
            let has_push = {
                let backend = active_relay_backend(&engine);
                !backend.wakes().is_empty()
            };
            let (base_ms, jitter_max) = if has_push {
                (1000u64, 500u64)
            } else {
                (800, 400)
            };
            let jitter_ms = {
                use rand::Rng;
                rand::thread_rng().gen_range(0..jitter_max)
            };
            tokio::select! {
                _ = sleep(Duration::from_millis(base_ms + jitter_ms)) => {}
                _ = wake_rx.recv() => {
                    while wake_rx.try_recv().is_ok() {}
                }
            }
        }
        first = false;
        engine.refresh_peer_relay();
        if !relay_allowed(&engine) && engine.peer_relay_fp().is_none() {
            continue;
        }
        let backend = active_relay_backend(&engine);
        let my_fp = engine.identity.fingerprint.clone();
        let msgs = match backend.poll(&relay_topic(&my_fp)).await {
            Ok(m) => m,
            Err(e) => {
                debug!("relay poll falhou: {e}");
                continue;
            }
        };
        for raw in msgs {
            let h = {
                use std::hash::{Hash, Hasher};
                let mut s = std::collections::hash_map::DefaultHasher::new();
                raw.hash(&mut s);
                s.finish()
            };
            if !seen.insert(h) {
                continue;
            }
            if seen.len() > 1024 {
                seen.clear();
            }
            let Some((from_raw, frame)) = reasm.feed(&my_fp, &raw) else {
                continue;
            };
            let hello = parse_relay_hello_full(&frame);
            let from = if !from_raw.is_empty() {
                from_raw
            } else if let Some(h) = &hello {
                h.fp.clone()
            } else {
                String::new()
            };
            if from == my_fp {
                continue;
            }
            if let Some(hello) = &hello {
                if !from.is_empty() && hello.fp != from {
                    continue;
                }
                let key = (hello.eph_pub, hello.nonce);
                let dup = last_hello.get(&from) == Some(&key);
                if dup {
                    if is_online(&engine, &from) {
                        continue;
                    }
                } else {
                    last_hello.insert(from.clone(), key);
                    if last_hello.len() > 512 {
                        last_hello.clear();
                    }
                    if engine.netlimiter.allow_relay_hello(&from) == Decision::Blocked {
                        debug!(%from, "relay: Hello descartado — rate limit por peer");
                        continue;
                    }
                    if is_online(&engine, &from) {
                        debug!(%from, "relay: redial novo com sessão viva — novo respondente");
                        spawn_relay_responder_force(engine.clone(), from.clone(), frame.clone());
                        continue;
                    }
                }
            } else if !from.is_empty()
                && is_online(&engine, &from)
                && is_relay_handshake_frame(&frame)
            {
                continue;
            }
            if from.is_empty() {
                let map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
                for tx in map.values() {
                    let _ = tx.send(frame.clone());
                }
                continue;
            }
            let routed = {
                let mut map = engine.relay_in.lock().unwrap_or_else(|e| e.into_inner());
                match map.get(&from) {
                    Some(tx) => match tx.send(frame.clone()) {
                        Ok(()) => true,
                        Err(_) => {
                            map.remove(&from);
                            false
                        }
                    },
                    None => false,
                }
            };
            if routed {
                continue;
            }
            if let Some(hello_fp) = parse_relay_hello_full(&frame).map(|h| h.fp) {
                if hello_fp == from {
                    if engine.netlimiter.allow_relay_hello(&from) == Decision::Blocked {
                        debug!(%from, "relay: Hello (sem sessão) descartado — rate limit");
                        continue;
                    }
                    debug!(%from, "relay: Hello recebido — atendendo");
                    spawn_relay_responder(engine.clone(), from, frame);
                }
            }
        }
    }
}
