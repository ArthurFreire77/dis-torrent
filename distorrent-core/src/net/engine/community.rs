// Metodos de NetworkEngine: community.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub(super) fn rand_hex(n: usize) -> String {
        use rand::RngCore;
        let mut buf = vec![0u8; n];
        rand::thread_rng().fill_bytes(&mut buf);
        hex::encode(buf)
    }

    pub(super) fn normalize_channel_name(name: &str) -> String {
        name.trim().to_lowercase().replace(' ', "-")
    }

    pub(super) fn require_owner(&self, community_id: &str) -> Result<()> {
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "apenas o dono pode alterar o servidor".into(),
            ));
        }
        Ok(())
    }

    pub fn community_state_payload(
        &self,
        community_id: &str,
        for_fp: Option<&str>,
    ) -> Result<SecureFrame> {
        let (id, name, owner_fp) = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        let channels = self.store.channel_rows(community_id)?;
        let roles = self.store.roles_list(community_id)?;
        let mut bots = self.store.bots_list(community_id)?;
        let members = self.store.list_members(community_id)?;
        let mut member_roles = Vec::with_capacity(members.len());
        for (fp, _, _) in &members {
            member_roles.push((fp.clone(), self.store.member_roles_list(community_id, fp)?));
        }
        let is_owner_target = for_fp.map(|f| f == owner_fp).unwrap_or(true);
        if !is_owner_target {
            for b in bots.iter_mut() {
                b.token = String::new();
                // Segredo de assinatura é credencial: quem não é dono não vê.
                b.webhook_secret = String::new();
            }
        }
        let (description, category, icon) = self.store.community_meta(&id).unwrap_or_default();
        let is_public = self.store.community_is_public(&id).unwrap_or(false);
        Ok(SecureFrame::CommunityState {
            community_id: id,
            name,
            owner_fp,
            channels,
            roles,
            bots,
            member_roles,
            members,
            description,
            category,
            icon,
            is_public,
        })
    }

    pub(super) fn broadcast_community_state(&self, community_id: &str) {
        let members = match self.store.list_members(community_id) {
            Ok(m) => m,
            Err(_) => return,
        };
        for (fp, _, _) in members {
            if fp == self.identity.fingerprint {
                continue;
            }
            let frame = match self.community_state_payload(community_id, Some(&fp)) {
                Ok(f) => f,
                Err(e) => {
                    debug!("broadcast do estado falhou para {community_id}/{fp}: {e}");
                    continue;
                }
            };
            if self.link_tx(&fp).is_some() {
                self.cmd_tx.send(EngineCmd::SendToPeer(fp, frame)).ok();
            }
        }
    }

    pub fn create_community(&self, name: &str, channels: &[String]) -> Result<String> {
        self.create_community_with_options(name, channels, &CommunityCreateOptions::default())
    }

    pub fn create_community_with_options(
        &self,
        name: &str,
        channels: &[String],
        opts: &CommunityCreateOptions,
    ) -> Result<String> {
        let existing: Vec<String> = self
            .store
            .list_communities()
            .unwrap_or_default()
            .into_iter()
            .map(|(_, n, _)| n)
            .collect();
        let name = Self::validate_name_gate(crate::names::NameKind::Server, name, &existing)?;
        let mut seen: Vec<String> = vec![];
        let cid = crate::protocol::new_message_id(
            &self.identity.fingerprint,
            &name,
            crate::identity::now_ms(),
            "community",
        )[..16]
            .to_string();

        let chan_rows: Vec<ChannelMetaRow> = if !opts.channels_meta.is_empty() {
            let mut rows = Vec::with_capacity(opts.channels_meta.len());
            for c in &opts.channels_meta {
                let kind = match c.kind.as_str() {
                    "" | "text" => "text",
                    "voice" => "voice",
                    "video" => "video",
                    other => {
                        return Err(DistorrentError::Protocol(format!(
                            "tipo de canal inválido ({other}) — use text|voice|video"
                        )))
                    }
                };
                let v = Self::validate_name_gate(
                    crate::names::NameKind::Channel,
                    &Self::normalize_channel_name(&c.name),
                    &seen,
                )?;
                seen.push(v.clone());
                let default_cat = match kind {
                    "voice" => "CANAIS DE VOZ",
                    "video" => "CANAIS DE VÍDEO",
                    _ => "CANAIS DE TEXTO",
                };
                let category = if c.category.trim().is_empty() {
                    default_cat.to_string()
                } else {
                    crate::names::sanitize_text(c.category.trim(), 64)
                };
                rows.push(ChannelMetaRow {
                    id: format!("{cid}-{}", v.to_lowercase().replace(' ', "-")),
                    name: v,
                    topic: String::new(),
                    category,
                    kind: kind.into(),
                    position: rows.len() as i64,
                });
            }
            rows
        } else {
            let mut clean: Vec<String> = Vec::with_capacity(channels.len());
            for c in channels {
                let v = Self::validate_name_gate(
                    crate::names::NameKind::Channel,
                    &Self::normalize_channel_name(c),
                    &seen,
                )?;
                seen.push(v.clone());
                clean.push(v);
            }
            if clean.is_empty() {
                clean.push("geral".into());
            }
            clean
                .into_iter()
                .enumerate()
                .map(|(i, c)| ChannelMetaRow {
                    id: format!("{cid}-{}", c.to_lowercase().replace(' ', "-")),
                    name: c,
                    topic: String::new(),
                    category: "CANAIS DE TEXTO".into(),
                    kind: "text".into(),
                    position: i as i64,
                })
                .collect()
        };

        let empty: Vec<(&str, &str)> = vec![];
        self.store
            .create_community(&cid, &name, &self.identity.fingerprint, &empty)?;
        for row in &chan_rows {
            self.store.upsert_channel(&cid, row)?;
        }
        self.store.upsert_member(
            &cid,
            &self.identity.fingerprint,
            &self.identity.nickname,
            "owner",
        )?;

        for (i, r) in opts.roles.iter().take(12).enumerate() {
            let clean_name = crate::names::sanitize_text(&r.name, 64);
            if clean_name.is_empty() {
                continue;
            }
            let color = crate::names::sanitize_text(&r.color, 16);
            let row = crate::storage::RoleRow {
                id: format!("{cid}-role-{}", Self::rand_hex(6)),
                community_id: cid.clone(),
                name: clean_name,
                color,
                permissions: r.permissions & 0x3FF,
                hoist: r.hoist,
                mentionable: r.mentionable,
                position: i as i64,
            };
            self.store.role_upsert(&row)?;
        }

        self.store.community_meta_set(
            &cid,
            Some(opts.description.trim()),
            Some(opts.category.trim()),
            Some(opts.icon.trim()),
        )?;
        if opts.is_public {
            self.store.community_set_public(&cid, true)?;
        }
        if !opts.rules_text.trim().is_empty() {
            self.store.kv_set(
                &format!("rules:text:{cid}"),
                &crate::names::sanitize_text(opts.rules_text.trim(), 4096),
            )?;
        }

        let _ = self.events.send(EngineEvent::CommunityJoined {
            community_id: cid.clone(),
            name: name.into(),
        });
        Ok(cid)
    }

    pub fn community_set_meta(
        &self,
        community_id: &str,
        description: Option<&str>,
        category: Option<&str>,
        icon: Option<&str>,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .community_meta_set(community_id, description, category, icon)?
            == 0
        {
            return Err(DistorrentError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn community_meta(&self, community_id: &str) -> Result<(String, String, String)> {
        self.store.community_meta(community_id)
    }

    /// Liga/desliga o servidor público. Só o dono muda; o estado vai para todos
    /// na mesma hora para ninguém ficar com a regra antiga na tela.
    pub fn community_set_public(&self, community_id: &str, is_public: bool) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.community_set_public(community_id, is_public)? == 0 {
            return Err(DistorrentError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn community_is_public(&self, community_id: &str) -> Result<bool> {
        self.store.community_is_public(community_id)
    }

    pub fn make_invite(&self, community_id: &str, member_fp: &str, ttl_ms: i64) -> Result<String> {
        const WILDCARD: &str = "000000000000";
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if comm.2 != self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "apenas o dono gera convites".into(),
            ));
        }
        let fp = member_fp.trim().to_lowercase();
        if fp != WILDCARD && (fp.len() != 12 || !fp.chars().all(|c| c.is_ascii_hexdigit())) {
            return Err(DistorrentError::Protocol("fingerprint inválido".into()));
        }
        let exp = crate::identity::now_ms() + ttl_ms;
        Ok(crate::protocol::make_invite_token(
            &self.keypair,
            community_id,
            &fp,
            exp,
        ))
    }

    pub fn join_community(&self, token: &str) -> Result<String> {
        let normalized = crate::protocol::extract_invite_token(token);
        let (host_fp, cid, member_fp, exp, sig) = crate::protocol::parse_invite_token(&normalized)?;
        if crate::identity::now_ms() > exp {
            return Err(DistorrentError::Protocol("convite expirado".into()));
        }
        const WILDCARD: &str = "000000000000";
        if member_fp != WILDCARD && member_fp != self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "convite é para outro fingerprint".into(),
            ));
        }
        if let Some(host) = self.store.get_peer(&host_fp)? {
            if !Keypair::verify(
                &host.pubkey_hex,
                &crate::protocol::invite_sign_bytes(&cid, &member_fp, exp),
                &sig,
            )
            .map_err(|e| DistorrentError::Crypto(e.to_string()))?
            {
                return Err(DistorrentError::Protocol(
                    "convite com assinatura inválida".into(),
                ));
            }
        }
        if self
            .store
            .member_role(&cid, &self.identity.fingerprint)
            .is_some()
        {
            self.persist_pending_join(&cid, &normalized);
            self.connect_to_community_peer(&host_fp);
            self.request_community_sync(&cid);
            return Ok(cid);
        }
        self.pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cid.clone(), normalized.clone());
        self.persist_pending_join(&cid, &normalized);
        self.send_join_to_host(&host_fp, &cid, &normalized);
        self.connect_to_community_peer(&host_fp);
        Ok(cid)
    }

    /// Entra num servidor PÚBLICO sem convite: o host aceita direto (com rate
    /// limit). Se o servidor for privado, o host recusa com erro honesto.
    pub fn join_public_community(&self, host_fp: &str, community_id: &str) -> Result<String> {
        let host = host_fp.trim().to_lowercase();
        let cid = community_id.trim().to_string();
        if host.is_empty() || cid.is_empty() {
            return Err(DistorrentError::Protocol(
                "servidor público precisa de host e id".into(),
            ));
        }
        if self
            .store
            .member_role(&cid, &self.identity.fingerprint)
            .is_some()
        {
            self.connect_to_community_peer(&host);
            self.request_community_sync(&cid);
            return Ok(cid);
        }
        self.pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(cid.clone(), String::new());
        self.send_join_to_host(&host, &cid, "");
        self.connect_to_community_peer(&host);
        Ok(cid)
    }

    fn persist_pending_join(&self, community_id: &str, token: &str) {
        let key = format!("join.pending.{community_id}");
        if let Err(e) = self.store.kv_set(&key, token) {
            tracing::warn!(%community_id, "não consegui persistir o convite pendente: {e}");
        }
    }

    pub(super) fn clear_pending_join(&self, community_id: &str) {
        self.pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(community_id);
        self.join_retry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(community_id);
        let _ = self
            .store
            .kv_delete(&format!("join.pending.{community_id}"));
    }

    fn send_join_to_host(&self, host_fp: &str, cid: &str, token: &str) {
        if self.link_tx(host_fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    host_fp.to_string(),
                    SecureFrame::JoinCommunity {
                        community_id: cid.to_string(),
                        token: token.to_string(),
                    },
                ))
                .ok();
        }
    }

    pub fn should_keep_dialing(&self, fp: &str) -> bool {
        if fp.is_empty() || fp == self.identity.fingerprint {
            return false;
        }
        if self
            .store
            .get_friend(fp)
            .ok()
            .flatten()
            .map(|(_, s)| s == "accepted" || s == "pending_out" || s == "pending_in")
            .unwrap_or(false)
        {
            return true;
        }
        for (cid, _, _) in self.store.list_communities().unwrap_or_default() {
            if self
                .store
                .list_members(&cid)
                .unwrap_or_default()
                .iter()
                .any(|(m, _, _)| m == fp)
            {
                return true;
            }
        }
        for conv in self.store.list_conversations().unwrap_or_default() {
            if conv.kind != "group" {
                continue;
            }
            if self
                .store
                .list_group_members(&conv.id)
                .unwrap_or_default()
                .iter()
                .any(|(m, _)| m == fp)
            {
                return true;
            }
        }
        false
    }

    pub(super) fn connect_to_community_peer(&self, fp: &str) {
        if fp == self.identity.fingerprint {
            return;
        }
        self.member_dial_at
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(fp.to_string(), crate::identity::now_ms());
        self.cmd_tx
            .send(EngineCmd::ConnectRelay(fp.to_string()))
            .ok();
        self.cmd_tx
            .send(EngineCmd::LookupAnnounce(fp.to_string()))
            .ok();
        self.dht_probe(fp);
    }

    pub fn request_community_sync(&self, community_id: &str) {
        if self
            .store
            .member_role(community_id, &self.identity.fingerprint)
            .is_none()
        {
            return;
        }
        let now = crate::identity::now_ms();
        {
            let mut seen = self
                .community_sync_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = seen.get(community_id) {
                if now.saturating_sub(*prev) < 45_000 {
                    return;
                }
            }
            seen.insert(community_id.to_string(), now);
        }
        let mut targets: Vec<String> = Vec::new();
        if let Ok(Some((_, _, owner))) = self.store.get_community(community_id) {
            if owner != self.identity.fingerprint {
                targets.push(owner);
            }
        }
        let mut seen: std::collections::HashSet<String> = targets.iter().cloned().collect();
        for fp in self.online_peer_fps() {
            if fp == self.identity.fingerprint || !seen.insert(fp.clone()) {
                continue;
            }
            if self.store.member_role(community_id, &fp).is_some() {
                targets.push(fp);
            }
        }
        for fp in targets {
            if self.link_tx(&fp).is_none() {
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp,
                    SecureFrame::CommunitySyncRequest {
                        community_id: community_id.to_string(),
                    },
                ))
                .ok();
        }
    }

    pub fn maintain_communities(&self) {
        let now = crate::identity::now_ms();
        let communities = self.store.list_communities().unwrap_or_default();
        for (cid, _name, owner) in communities {
            if self
                .store
                .member_role(&cid, &self.identity.fingerprint)
                .is_none()
            {
                continue;
            }
            if owner != self.identity.fingerprint && self.link_tx(&owner).is_none() {
                self.connect_to_community_peer_throttled(&owner, now, 30_000);
            }
            for (fp, _nick, _role) in self.store.list_members(&cid).unwrap_or_default() {
                if fp == self.identity.fingerprint || fp == owner {
                    continue;
                }
                if self.link_tx(&fp).is_some() {
                    continue;
                }
                self.connect_to_community_peer_throttled(&fp, now, 45_000);
            }
            self.request_community_sync(&cid);
        }
        self.retry_pending_joins();
    }

    pub(super) fn connect_to_community_peer_throttled(&self, fp: &str, now: i64, min_ms: i64) {
        {
            let mut seen = self
                .member_dial_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some(prev) = seen.get(fp) {
                if now.saturating_sub(*prev) < min_ms {
                    return;
                }
            }
            if seen.len() > 4096 {
                seen.clear();
            }
            seen.insert(fp.to_string(), now);
        }
        self.connect_to_community_peer(fp);
    }

    pub(super) fn flush_joins(&self, peer_fp: &str) {
        let joins: Vec<(String, String)> = self
            .pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        let now = crate::identity::now_ms();
        for (cid, token) in joins {
            let Some((host_fp, token_cid, member_fp, exp, sig)) =
                crate::protocol::parse_invite_token(&token).ok()
            else {
                self.clear_pending_join(&cid);
                continue;
            };
            const WILDCARD: &str = "000000000000";
            if token_cid != cid || (member_fp != WILDCARD && member_fp != self.identity.fingerprint)
            {
                self.clear_pending_join(&cid);
                continue;
            }
            if now > exp {
                self.clear_pending_join(&cid);
                let _ = self.events.send(EngineEvent::Error {
                    context: format!(
                        "o convite do servidor expirou antes de o dono responder — peça um novo token"
                    ),
                });
                continue;
            }
            if host_fp != peer_fp {
                continue;
            }
            let Some(host) = self.store.get_peer(peer_fp).ok().flatten() else {
                continue;
            };
            let valid_signature = Keypair::verify(
                &host.pubkey_hex,
                &crate::protocol::invite_sign_bytes(&cid, &member_fp, exp),
                &sig,
            )
            .unwrap_or(false);
            if !valid_signature {
                debug!(%peer_fp, %cid, "convite pendente descartado: assinatura inválida");
                self.clear_pending_join(&cid);
                let _ = self.events.send(EngineEvent::Error {
                    context: "o convite guardado não corresponde à chave do dono do servidor — peça um novo token".into(),
                });
                continue;
            }
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    peer_fp.into(),
                    SecureFrame::JoinCommunity {
                        community_id: cid,
                        token,
                    },
                ))
                .ok();
        }
    }

    fn retry_pending_joins(&self) {
        let now = crate::identity::now_ms();
        let pending: Vec<(String, String)> = self
            .pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        for (cid, token) in pending {
            let Ok((host_fp, _token_cid, _member_fp, exp, _sig)) =
                crate::protocol::parse_invite_token(&token)
            else {
                self.clear_pending_join(&cid);
                continue;
            };
            if now > exp {
                self.clear_pending_join(&cid);
                continue;
            }
            if self.link_tx(&host_fp).is_none() {
                self.connect_to_community_peer(&host_fp);
                continue;
            }
            let should_send = {
                let mut retry = self.join_retry.lock().unwrap_or_else(|e| e.into_inner());
                let (last, tries) = retry.get(&cid).copied().unwrap_or((0, 0));
                let wait = 15_000i64.saturating_mul(1 << tries.min(3));
                if now.saturating_sub(last) >= wait {
                    retry.insert(cid.clone(), (now, tries.saturating_add(1)));
                    true
                } else {
                    false
                }
            };
            if should_send {
                self.send_join_to_host(&host_fp, &cid, &token);
            }
        }
    }
}
