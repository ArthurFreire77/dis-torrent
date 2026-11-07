// Metodos de NetworkEngine: release_trust.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    /// Carrega o conjunto de confiança do banco local (uma vez no boot).
    pub fn init_release_trust(self: &Arc<Self>) {
        let loaded = crate::net::release_trust::load(&self.store);
        let mut guard = self.release_trust.lock().unwrap_or_else(|e| e.into_inner());
        *guard = loaded;
    }

    pub fn release_trust_snapshot(&self) -> crate::release::ReleaseTrust {
        self.release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn peer_trust_snapshot(&self, fp: &str) -> Option<crate::release::PeerTrust> {
        self.peer_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(fp)
            .cloned()
    }

    pub fn memory_floor(&self) -> u64 {
        self.release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .epoch_floor()
    }

    /// Registra o transcript da conexão para assinar a própria atestação.
    pub fn set_attest_transcript(&self, fp: &str, transcript_hash: &str) {
        let mut m = self
            .attest_transcript
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if m.len() > 4096 {
            m.clear();
        }
        m.insert(fp.to_string(), transcript_hash.to_string());
    }

    /// Envia o desafio de atestação para um peer que fala proto_v >= 5.
    pub fn send_build_challenge(self: &Arc<Self>, peer_fp: &str) {
        if self.peer_proto_v(peer_fp) < crate::release::ATTEST_PROTO_V {
            return;
        }
        let Some(transcript) = self
            .attest_transcript
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(peer_fp)
            .cloned()
        else {
            return;
        };
        let mut nonce = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut nonce);
        {
            let mut m = self.attest_nonce.lock().unwrap_or_else(|e| e.into_inner());
            if m.len() > 4096 {
                m.clear();
            }
            m.insert(peer_fp.to_string(), nonce);
        }
        {
            let mut m = self
                .attest_sent_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if m.len() > 4096 {
                m.clear();
            }
            m.insert(peer_fp.to_string(), crate::identity::now_ms());
        }
        let policy = crate::net::release_trust::peer_policy(&self.store);
        self.send_to_peer(
            peer_fp.to_string(),
            SecureFrame::BuildChallenge {
                nonce_hex: hex::encode(nonce),
                transcript_hash: transcript,
                policy: policy.as_str().to_string(),
            },
        );
    }

    /// Monta a própria atestação para responder a um desafio.
    pub(super) fn own_build_attestation(
        &self,
        nonce: [u8; 32],
        transcript_hash: &str,
    ) -> Option<crate::release::BuildAttestation> {
        let trust = self.release_trust_snapshot();
        let self_integrity = crate::net::release_trust::self_integrity(&self.store);
        let manifest = trust.latest_verified().map(|v| v.manifest.clone());
        let claim = crate::release::BuildClaim {
            version: env!("CARGO_PKG_VERSION").to_string(),
            manifest_hash: manifest
                .as_ref()
                .map(|m| m.body.hash_hex().unwrap_or_default())
                .unwrap_or_default(),
            build_id: crate::net::release_trust::build_id(
                &self.identity.pubkey_hex,
                env!("CARGO_PKG_VERSION"),
            ),
            commit: manifest
                .as_ref()
                .map(|m| m.body.commit.clone())
                .unwrap_or_default(),
            channel: manifest
                .as_ref()
                .map(|m| m.body.channel.clone())
                .unwrap_or_else(|| "unknown".into()),
            protocol_version: crate::net::transport::PROTO_V,
            security_epoch: trust.epoch_floor(),
            self_integrity,
        };
        crate::release::BuildAttestation::sign(
            &self.keypair,
            transcript_hash,
            &nonce,
            claim,
            manifest.as_ref(),
        )
        .ok()
    }

    /// Grava o veredito do peer e decide a quarentena.
    pub(super) fn record_peer_trust(
        self: &Arc<Self>,
        peer_fp: &str,
        trust: crate::release::PeerTrust,
    ) -> bool {
        let policy = crate::net::release_trust::peer_policy(&self.store);
        let verification_available = self
            .release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .verification_available();
        let blocked = policy
            .decision(&trust, verification_available)
            .map(str::to_string);
        let state = trust.state;
        let version = trust.version.clone();
        let manifest_hash = trust.manifest_hash.clone();
        let build_id = trust.build_id.clone();
        let commit = trust.commit.clone();
        let channel = trust.channel.clone();
        let valid_signatures = trust.valid_signatures;
        let reason = trust.reason.clone();
        let hardware = trust.hardware.clone();
        let self_integrity = trust.self_integrity;
        {
            let mut m = self.peer_trust.lock().unwrap_or_else(|e| e.into_inner());
            if m.len() > 4096 {
                m.clear();
            }
            m.insert(peer_fp.to_string(), trust);
        }
        let _ = self.events.send(EngineEvent::PeerTrustChanged {
            fp: peer_fp.into(),
            state: state.as_str().into(),
            version,
            manifest_hash,
            build_id,
            commit,
            channel,
            valid_signatures,
            self_integrity: match self_integrity {
                crate::release::SelfIntegrityState::Confere => "CONFERE",
                crate::release::SelfIntegrityState::Diverge => "DIVERGE",
                crate::release::SelfIntegrityState::Unavailable => "UNAVAILABLE",
            }
            .into(),
            hardware_proof: hardware.proof_available,
            hardware_reason: hardware.reason,
            reason: reason.clone(),
            verification_available,
            quarantined: blocked.is_some(),
            quarantine_reason: blocked.clone().unwrap_or_default(),
        });
        if let Some(r) = &blocked {
            debug!(peer_fp, reason = %r, "peer em quarentena (política de autenticidade)");
        }
        blocked.is_none()
    }

    /// `true` quando o peer está em quarentena e só pode falar o mínimo.
    ///
    /// Enquanto a atestação está PENDENTE dentro da janela de tolerância, o
    /// peer não é bloqueado (a resposta está a caminho). Passada a janela sem
    /// resposta, ele passa a contar como NAO_VERIFICADO — não fica "no limbo"
    /// para sempre, que era a brecha de um peer que simplesmente não responde.
    pub fn peer_quarantined(&self, peer_fp: &str) -> bool {
        let map = self.peer_trust.lock().unwrap_or_else(|e| e.into_inner());
        let policy = crate::net::release_trust::peer_policy(&self.store);
        let available = self
            .release_trust
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .verification_available();
        match map.get(peer_fp) {
            Some(t) => policy.decision(t, available).is_some(),
            None => {
                // Sem veredito AINDA: se há desafio pendente e ele é recente,
                // deixa passar (a prova está a caminho). Se venceu, trata como
                // não verificado e aplica a política.
                if !available {
                    return false;
                }
                let sent = self
                    .attest_sent_at
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(peer_fp)
                    .copied();
                let agora = crate::identity::now_ms();
                let vencido = match sent {
                    Some(t) => agora.saturating_sub(t) > crate::release::ATTEST_TIMEOUT_MS,
                    // Nenhum desafio foi enviado (peer proto_v < 5): não há prova possível, então é NAO_VERIFICADO de fato.
                    None => self.peer_proto_v(peer_fp) < crate::release::ATTEST_PROTO_V,
                };
                if !vencido {
                    return false;
                }
                policy
                    .decision(
                        &crate::release::PeerTrust::unavailable("sem prova"),
                        available,
                    )
                    .is_some()
            }
        }
    }

    /// Aceita um manifesto recebido de peer: RE-VERIFICA com as chaves locais
    /// e só então guarda. Manifesto de peer nunca é ordem de nada.
    pub fn accept_peer_manifest(&self, peer_fp: &str, hex_wire: &str) -> Result<bool> {
        if hex_wire.len() > crate::release::MAX_MANIFEST_BYTES * 2 {
            return Err(DistorrentError::Protocol(
                "manifesto de peer acima do limite".into(),
            ));
        }
        let wire = hex::decode(hex_wire)
            .map_err(|_| DistorrentError::Protocol("manifesto de peer não é hex".into()))?;
        let signed = crate::release::SignedManifest::from_wire(&wire)?;
        let kv = crate::net::release_trust::StoreKv(self.store.clone());
        let mut trust = self.release_trust.lock().unwrap_or_else(|e| e.into_inner());
        let verified = trust.accept(&kv, &signed)?;
        let ok = verified.is_verified();
        if ok {
            debug!(
                peer_fp,
                version = %verified.manifest.body.version,
                "manifesto de peer verificado e guardado"
            );
        } else {
            debug!(peer_fp, reason = %verified.reason, "manifesto de peer recusado");
        }
        Ok(ok)
    }
}
