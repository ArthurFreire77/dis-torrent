// Metodos de NetworkEngine: tunnel.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn send_to_peer(&self, peer_fp: String, frame: SecureFrame) {
        if !matches!(
            frame,
            SecureFrame::TunnelOffer { .. }
                | SecureFrame::TunnelAnswer { .. }
                | SecureFrame::TunnelData { .. }
        ) && self.tunnel_should_carry(&peer_fp)
        {
            if self.tunnel_send_frame(&peer_fp, &frame) {
                return;
            }
        }
        self.cmd_tx.send(EngineCmd::SendToPeer(peer_fp, frame)).ok();
    }

    pub(super) fn tunnel_should_carry(&self, peer_fp: &str) -> bool {
        if !self.tunnel_enabled() || !self.tunnel_established(peer_fp) {
            return false;
        }
        if self.peer_state(peer_fp) != NetworkState::Connected || !self.is_peer_via_relay(peer_fp) {
            return false;
        }
        let agora = crate::identity::now_ms();
        let map = self
            .tunnel_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        match map.get(peer_fp) {
            Some(s) => s.is_proven(
                agora,
                TUNNEL_PROVE_GRACE_MS,
                TUNNEL_PROVE_TTL_MS,
                TUNNEL_PROVE_WINDOW_MS,
            ),
            None => false,
        }
    }

    pub(super) fn tunnel_drop(&self, peer_fp: &str, motivo: &str) {
        let tinha = {
            let mut map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.remove(peer_fp).is_some()
        };
        if !tinha {
            return;
        }
        {
            let mut meta = self.tunnel_meta.lock().unwrap_or_else(|e| e.into_inner());
            meta.remove(peer_fp);
        }
        {
            let mut pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pend.remove(peer_fp);
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_up = false;
        });
        debug!(peer_fp, motivo, "tunel: sessão descartada");
    }

    pub fn tunnel_reap_stale(&self) {
        let agora = crate::identity::now_ms();
        let mortos: Vec<String> = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.iter()
                .filter(|(_, s)| s.is_dead(agora, TUNNEL_PROVE_GRACE_MS, TUNNEL_DEAD_MS))
                .map(|(fp, _)| fp.clone())
                .collect()
        };
        for fp in mortos {
            self.tunnel_drop(&fp, "sem prova de vida (varredura)");
            self.tunnel_request(&fp);
        }
    }

    pub fn reap_half_open_links(&self) {
        const SEM_ACK_MS: i64 = 120_000;
        let agora = crate::identity::now_ms();
        let candidatos: Vec<String> = {
            let links = self.links.lock().unwrap_or_else(|e| e.into_inner());
            links
                .iter()
                .filter(|(_, l)| l.get_state() == PeerLinkState::Online)
                .map(|(fp, _)| fp.clone())
                .collect()
        };
        for fp in candidatos {
            if self.store.peer_in_active_call(&fp) {
                continue;
            }
            let presas = self.store.outbox_len_for_peer(&fp);
            if presas == 0 {
                continue;
            }
            let (last_ack, last_rx) = {
                let diag = self.peer_diag.lock().unwrap_or_else(|e| e.into_inner());
                match diag.get(&fp) {
                    Some(d) => (d.last_ack_ms, d.last_rx_ms),
                    None => continue,
                }
            };
            let referencia = if last_ack > 0 { last_ack } else { last_rx };
            if referencia == 0 || agora.saturating_sub(referencia) < SEM_ACK_MS {
                continue;
            }
            warn!(
                peer_fp = %fp,
                presas,
                sem_ack_ms = agora.saturating_sub(last_ack),
                "link meio-vivo: online sem confirmação de dados — refazendo sessão"
            );
            self.diag_update(&fp, |d| {
                d.last_reject = Some(format!(
                    "link online porém sem confirmação há {}s — sessão refeita",
                    agora.saturating_sub(referencia) / 1000
                ));
                d.last_reject_ms = agora;
            });
            {
                let mut links = self.links.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(old) = links.remove(&fp) {
                    old.drop_notify.notify_one();
                }
                if self.should_keep_dialing(&fp) {
                    links.insert(
                        fp.clone(),
                        Arc::new(PeerLink {
                            state: StdMutex::new(PeerLinkState::Reconnecting),
                            tx: None,
                            drop_notify: Notify::new(),
                            via_relay: false,
                            initiator: false,
                        }),
                    );
                }
            }
            self.note_dial_failure(&fp);
            self.emit_state();
        }
    }

    pub(super) fn tunnel_send_frame(&self, peer_fp: &str, frame: &SecureFrame) -> bool {
        let json = match serde_json::to_vec(frame) {
            Ok(v) if v.len() <= TUN_FRAME_MAX => v,
            _ => return false,
        };
        static FRAG_ID: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);
        let (nonce_list, sealed) = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let sess = match map.get(peer_fp) {
                Some(s) => s,
                None => return false,
            };
            let my_fp = self.identity.fingerprint.clone();
            if json.len() <= TUN_FRAG_MAX {
                let pt = encode_full(&json);
                match sess.seal(&my_fp, peer_fp, &pt) {
                    Ok((n, ct)) => (vec![n], vec![ct]),
                    Err(_) => return false,
                }
            } else {
                let id = FRAG_ID.fetch_add(1, Ordering::SeqCst);
                let chunks: Vec<&[u8]> = json.chunks(TUN_FRAG_MAX).collect();
                let total = chunks.len() as u16;
                let mut out = Vec::with_capacity(chunks.len());
                for (i, ch) in chunks.iter().enumerate() {
                    let pt = encode_frag(id, i as u16, total, ch);
                    match sess.seal(&my_fp, peer_fp, &pt) {
                        Ok((n, ct)) => out.push((n, ct)),
                        Err(_) => return false,
                    }
                }
                let (ns, cts): (Vec<u64>, Vec<Vec<u8>>) = out.into_iter().unzip();
                (ns, cts)
            }
        };
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        for (n, ct) in nonce_list.into_iter().zip(sealed.into_iter()) {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.to_string(),
                    SecureFrame::TunnelData {
                        nonce: n,
                        ct_b64: B64.encode(&ct),
                    },
                ))
                .ok();
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_tx_frames = d.tunnel_tx_frames.saturating_add(1);
        });
        self.tunnel_housekeep(peer_fp);
        true
    }

    pub(super) fn tunnel_housekeep(&self, peer_fp: &str) {
        const REKEY_BYTES: u64 = 256 * 1024 * 1024;
        const REKEY_AGE_MS: i64 = 24 * 60 * 60 * 1000;
        let stale = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            match map.get(peer_fp) {
                Some(s) => {
                    s.tx_bytes.load(Ordering::SeqCst) >= REKEY_BYTES
                        || crate::identity::now_ms() - s.created_ms >= REKEY_AGE_MS
                }
                None => false,
            }
        };
        if stale {
            debug!(peer_fp, "tunel: rekey por volume/idade");
            self.tunnel_rotate(peer_fp);
        }
    }

    pub fn tunnel_rotate(&self, peer_fp: &str) {
        {
            let mut map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            map.remove(peer_fp);
        }
        {
            let mut pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            pend.remove(peer_fp);
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_up = false;
        });
        self.tunnel_request(peer_fp);
    }

    pub fn tunnel_enabled(&self) -> bool {
        !self.tunnel_disabled.load(Ordering::Relaxed)
    }

    pub fn peer_proto_v(&self, fp: &str) -> u32 {
        self.peer_protos
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .copied()
            .unwrap_or(0)
    }

    pub fn tunnel_established(&self, fp: &str) -> bool {
        self.tunnel_sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(fp)
    }

    pub fn tunnel_virtual_ip(fp: &str) -> String {
        virtual_ipv6(fp).to_string()
    }

    pub fn tunnel_request(&self, peer_fp: &str) {
        if !self.tunnel_enabled() || peer_fp.is_empty() {
            return;
        }
        if peer_fp == self.identity.fingerprint {
            return;
        }
        if self.tunnel_established(peer_fp) {
            return;
        }
        if self.peer_proto_v(peer_fp) < 2 {
            return;
        }
        {
            let pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(p) = pend.get(peer_fp) {
                if crate::identity::now_ms() - p.created_ms < 60_000 {
                    return;
                }
            }
        }
        let secret = x25519_dalek::StaticSecret::random_from_rng(rand::thread_rng());
        let eph_pub = x25519_dalek::PublicKey::from(&secret).to_bytes();
        let mut nonce = [0u8; 16];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        let my_fp = self.identity.fingerprint.clone();
        let transcript =
            tunnel_transcript(&my_fp, &eph_pub, &nonce, peer_fp, &[0u8; 32], &[0u8; 16]);
        let sig = self.keypair.sign(&transcript);
        {
            let mut pend = self
                .tunnel_pending
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if pend.len() > 256 {
                pend.clear();
            }
            pend.insert(
                peer_fp.to_string(),
                TunnelPending {
                    secret,
                    nonce,
                    created_ms: crate::identity::now_ms(),
                },
            );
        }
        debug!(peer_fp, "tunel: oferta enviada");
        self.send_to_peer(
            peer_fp.to_string(),
            SecureFrame::TunnelOffer {
                eph_pub_hex: hex::encode(eph_pub),
                nonce_hex: hex::encode(nonce),
                sig,
            },
        );
    }

    pub fn tunnel_ping(&self, peer_fp: &str) -> Result<u64> {
        static PING_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = PING_ID.fetch_add(1, Ordering::SeqCst);
        let msg = format!("ping:{id}");
        let sealed = {
            let map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let sess = map
                .get(peer_fp)
                .ok_or_else(|| DistorrentError::Protocol("tunel: sem sessão com o peer".into()))?;
            sess.seal(
                &self.identity.fingerprint,
                peer_fp,
                &encode_full(msg.as_bytes()),
            )?
        };
        let (nonce, ct) = sealed;
        {
            let mut p = self.tunnel_pings.lock().unwrap_or_else(|e| e.into_inner());
            if p.len() > 256 {
                p.clear();
            }
            p.insert((peer_fp.to_string(), id), crate::identity::now_ms());
        }
        use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
        self.send_to_peer(
            peer_fp.to_string(),
            SecureFrame::TunnelData {
                nonce,
                ct_b64: B64.encode(ct),
            },
        );
        Ok(id)
    }

    pub(super) fn tunnel_store_session(&self, peer_fp: &str, key: [u8; 32]) {
        {
            let mut map = self
                .tunnel_sessions
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if map.len() > 512 {
                map.clear();
            }
            map.insert(
                peer_fp.to_string(),
                TunnelSession::new(peer_fp.to_string(), key),
            );
        }
        self.diag_update(peer_fp, |d| {
            d.tunnel_up = true;
            d.virtual_ip = Some(Self::tunnel_virtual_ip(peer_fp));
        });
        let _ = self.events.send(EngineEvent::TunnelUp {
            fp: peer_fp.to_string(),
            virtual_ip: Self::tunnel_virtual_ip(peer_fp),
        });
        info!(
            peer_fp,
            "tunel: sessão ESTABELECIDA (via relay; UDP direto na Fase 2)"
        );
    }

    pub(super) fn tunnel_peer_nick(&self, peer_fp: &str) -> String {
        if let Some(p) = self
            .store
            .list_peers()
            .unwrap_or_default()
            .into_iter()
            .find(|p| p.fp == peer_fp)
        {
            if !p.nickname.is_empty() {
                return p.nickname;
            }
        }
        peer_fp.chars().take(8).collect()
    }

    pub(super) fn parse_tunnel_hs(eph_hex: &str, nonce_hex: &str) -> Option<([u8; 32], [u8; 16])> {
        let eph: [u8; 32] = hex::decode(eph_hex).ok()?.try_into().ok()?;
        let nonce: [u8; 16] = hex::decode(nonce_hex).ok()?.try_into().ok()?;
        if eph == [0u8; 32] {
            return None;
        }
        Some((eph, nonce))
    }

    pub fn pex_peers(&self, limit: usize) -> Vec<PeerRecord> {
        let mut v = self.peers();
        v.retain(|p| p.fp != self.identity.fingerprint && p.addr.is_some());
        v.truncate(limit);
        v
    }
}
