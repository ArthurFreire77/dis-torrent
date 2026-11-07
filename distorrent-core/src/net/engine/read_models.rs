// Metodos de NetworkEngine: read_models.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn store_list_communities(&self) -> Vec<(String, String, String)> {
        self.store.list_communities().unwrap_or_default()
    }

    pub fn store_list_channels(&self, cid: &str) -> Vec<(String, String)> {
        self.store.list_channels(cid).unwrap_or_default()
    }

    pub fn store_list_members(&self, cid: &str) -> Vec<(String, String, String)> {
        self.store.list_members(cid).unwrap_or_default()
    }

    pub fn community_member_states(&self, community_id: &str) -> Vec<MemberPairing> {
        let owner = self
            .store
            .get_community(community_id)
            .ok()
            .flatten()
            .map(|(_, _, o)| o)
            .unwrap_or_default();
        let pending_join = self
            .pending_joins
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains_key(community_id);
        let me = &self.identity.fingerprint;
        let mut out = Vec::new();
        for (fp, nick, role) in self.store.list_members(community_id).unwrap_or_default() {
            let (state, via_relay) = if fp == *me {
                ("connected".to_string(), false)
            } else {
                let link = self
                    .links
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(&fp)
                    .map(|l| (l.get_state(), l.via_relay));
                match link {
                    Some((PeerLinkState::Online, relay)) => {
                        (if relay { "relay" } else { "connected" }.to_string(), relay)
                    }
                    Some((PeerLinkState::Reconnecting, relay)) => {
                        ("reconnecting".to_string(), relay)
                    }
                    Some((PeerLinkState::Connecting, relay)) => ("connecting".to_string(), relay),
                    None => {
                        if fp == owner && pending_join {
                            ("pending_join".to_string(), false)
                        } else {
                            ("offline".to_string(), false)
                        }
                    }
                }
            };
            out.push(MemberPairing {
                is_owner: fp == owner,
                is_self: fp == *me,
                fp,
                nickname: nick,
                role,
                state,
                via_relay,
            });
        }
        out
    }

    pub fn conversations(&self) -> Vec<Conversation> {
        self.store.list_conversations().unwrap_or_default()
    }

    pub fn messages(&self, conv_id: &str) -> Vec<StoredMessage> {
        self.store.list_messages(conv_id, 500).unwrap_or_default()
    }

    pub fn messages_window(
        &self,
        conv_id: &str,
        before_ts: Option<i64>,
        limit: i64,
    ) -> Result<Vec<StoredMessage>> {
        self.store.list_messages_window(conv_id, before_ts, limit)
    }

    pub fn open_dm(&self, peer_fp: &str, peer_nick: &str) -> Result<Conversation> {
        if peer_fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "não é possível abrir DM consigo".into(),
            ));
        }
        let title = if peer_nick.is_empty() {
            peer_fp.to_string()
        } else {
            peer_nick.to_string()
        };
        let conv =
            self.store
                .ensure_dm_conversation(&self.identity.fingerprint, peer_fp, &title)?;
        let current = self.store.get_conversation(&conv.id)?.unwrap_or(conv);
        if !title.is_empty() && current.title != title {
            self.store.update_conversation_title(&current.id, &title)?;
            let mut c = current;
            c.title = title;
            Ok(c)
        } else {
            Ok(current)
        }
    }

    pub fn notify_read(&self, conv_id: &str, up_to_ts: i64) {
        use std::time::{SystemTime, UNIX_EPOCH};
        static LAST_SENT: std::sync::OnceLock<StdMutex<HashMap<String, u64>>> =
            std::sync::OnceLock::new();
        let map = LAST_SENT.get_or_init(|| StdMutex::new(HashMap::new()));
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        {
            let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
            if m.get(conv_id).copied().unwrap_or(0) + 1000 > now {
                return;
            }
            m.insert(conv_id.to_string(), now);
        }
        let peers = self.social_peers_of(conv_id);
        for fp in peers {
            if self.peer_proto_v(&fp) < 4 {
                continue;
            }
            self.send_to_peer(
                fp,
                SecureFrame::Read {
                    conv_id: conv_id.to_string(),
                    up_to_ts,
                },
            );
        }
    }

    pub fn send_dm(&self, conv_id: &str, body: &str) -> Result<StoredMessage> {
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("conversa inexistente".into()))?;
        let env = MessageEnvelope::new(&self.keypair, conv_id, body);
        match conv.kind.as_str() {
            "dm" => {
                let is_friend = self
                    .store
                    .get_friend(&conv.peer_fp)
                    .ok()
                    .flatten()
                    .map(|(_, s)| s == "accepted")
                    .unwrap_or(false);
                if self.store.is_blocked_fp(&conv.peer_fp) {
                    return Err(DistorrentError::Protocol(
                        "peer bloqueado — desbloqueie para conversar".into(),
                    ));
                }
                // Sem amizade, a conversa é uma INTRODUÇÃO: no máximo três
                // mensagens por direção. O contador é consumido só depois de
                // a mensagem existir, para retry não queimar crédito.
                let intro = !is_friend;
                if intro
                    && !self.store.dm_intro_take(
                        conv_id,
                        &self.identity.fingerprint,
                        crate::social::DM_INTRO_LIMIT,
                    )?
                {
                    return Err(DistorrentError::Protocol(format!(
                        "limite de {} mensagens antes da amizade — envie uma solicitação para continuar",
                        crate::social::DM_INTRO_LIMIT
                    )));
                }
                if let Err(e) = self.store.insert_message(&env, "out", "sending") {
                    if intro {
                        let _ = self
                            .store
                            .dm_intro_refund(conv_id, &self.identity.fingerprint);
                    }
                    return Err(e);
                }
                crate::metrics::metrics().message_out();
                let online = self.link_tx(&conv.peer_fp).is_some();
                // Amigo ou introdução: os dois caminham pelo mesmo transporte. A diferença é que a introdução só tem crédito finito.
                if online {
                    self.store.enqueue_outbox(&env.id, &conv.peer_fp)?;
                    if self
                        .cmd_tx
                        .send(EngineCmd::SendToPeer(
                            conv.peer_fp.clone(),
                            SecureFrame::Msg(env.clone()),
                        ))
                        .is_err()
                    {
                        self.store.set_message_status(&env.id, "pending")?;
                        let _ = self.events.send(EngineEvent::MessageStatus {
                            msg_id: env.id.clone(),
                            status: "pending".into(),
                        });
                        self.cmd_tx
                            .send(EngineCmd::ConnectRelay(conv.peer_fp.clone()))
                            .ok();
                        return self.store.message_by_id(&env.id)?.ok_or_else(|| {
                            DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows)
                        });
                    }
                    self.store.set_message_status(&env.id, "sent")?;
                    let _ = self.events.send(EngineEvent::MessageStatus {
                        msg_id: env.id.clone(),
                        status: "sent".into(),
                    });
                } else {
                    self.store.enqueue_outbox(&env.id, &conv.peer_fp)?;
                    self.store.set_message_status(&env.id, "pending")?;
                    let _ = self.events.send(EngineEvent::MessageStatus {
                        msg_id: env.id.clone(),
                        status: "pending".into(),
                    });
                    self.cmd_tx
                        .send(EngineCmd::ConnectRelay(conv.peer_fp.clone()))
                        .ok();
                }
            }
            "group" => {
                self.store.insert_message(&env, "out", "sending")?;
                crate::metrics::metrics().message_out();
                let me = self.identity.fingerprint.clone();
                let mut sent_any = false;
                for (fp, _) in self.store.list_group_members(conv_id)? {
                    if fp == me {
                        continue;
                    }
                    if self.link_tx(&fp).is_some() {
                        self.cmd_tx
                            .send(EngineCmd::SendToPeer(
                                fp.clone(),
                                SecureFrame::Msg(env.clone()),
                            ))
                            .ok();
                        sent_any = true;
                    } else {
                        self.cmd_tx.send(EngineCmd::ConnectRelay(fp)).ok();
                    }
                }
                let status = if sent_any { "sent" } else { "pending" };
                self.store.set_message_status(&env.id, status)?;
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: env.id.clone(),
                    status: status.into(),
                });
            }
            other => {
                return Err(DistorrentError::Protocol(format!(
                    "tipo de conversa desconhecido: {other}"
                )))
            }
        }
        self.store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    pub fn resend_message(self: &Arc<Self>, msg_id: &str) -> Result<StoredMessage> {
        let m = self
            .store
            .message_by_id(msg_id)?
            .ok_or_else(|| DistorrentError::Protocol("mensagem inexistente".into()))?;
        if m.direction != "out" {
            return Err(DistorrentError::Protocol(
                "só dá para reenviar mensagem enviada por você".into(),
            ));
        }
        let conv = self
            .store
            .get_conversation(&m.conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("conversa inexistente".into()))?;
        let env = MessageEnvelope {
            id: m.id.clone(),
            conv_id: m.conv_id.clone(),
            author_fp: m.author_fp.clone(),
            body: m.body.clone(),
            ts: m.ts,
            sig: m.sig.clone(),
        };
        match conv.kind.as_str() {
            "dm" => {
                self.store.requeue_outbox(&m.id, &conv.peer_fp)?;
                self.store.set_message_status(&m.id, "pending")?;
                if self.link_tx(&conv.peer_fp).is_some() {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            conv.peer_fp.clone(),
                            SecureFrame::Msg(env),
                        ))
                        .ok();
                    self.store.set_message_status(&m.id, "sent").ok();
                }
                self.cmd_tx
                    .send(EngineCmd::ConnectRelay(conv.peer_fp.clone()))
                    .ok();
                let status = self
                    .store
                    .message_by_id(&m.id)?
                    .map(|x| x.status)
                    .unwrap_or_else(|| "pending".into());
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: m.id.clone(),
                    status,
                });
            }
            "group" => {
                self.store.set_message_status(&m.id, "pending")?;
                let me = self.identity.fingerprint.clone();
                let mut sent_any = false;
                for (fp, _) in self.store.list_group_members(&m.conv_id)? {
                    if fp == me {
                        continue;
                    }
                    if self.link_tx(&fp).is_some() {
                        self.cmd_tx
                            .send(EngineCmd::SendToPeer(fp, SecureFrame::Msg(env.clone())))
                            .ok();
                        sent_any = true;
                    }
                }
                let status = if sent_any { "sent" } else { "pending" };
                self.store.set_message_status(&m.id, status)?;
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: m.id.clone(),
                    status: status.into(),
                });
            }
            other => {
                let mut achou = false;
                for (cid, _, owner) in self.store.list_communities().unwrap_or_default() {
                    if !self
                        .store
                        .list_channels(&cid)
                        .unwrap_or_default()
                        .iter()
                        .any(|(ch, _)| ch == &m.conv_id)
                    {
                        continue;
                    }
                    achou = true;
                    if owner == self.identity.fingerprint {
                        self.host_relay(&cid, &m.conv_id, &env, "")?;
                        self.store.set_message_status(&m.id, "sent")?;
                    } else if self.link_tx(&owner).is_some() {
                        self.cmd_tx
                            .send(EngineCmd::SendToPeer(
                                owner.clone(),
                                SecureFrame::ChannelMsg {
                                    community_id: cid.clone(),
                                    channel_id: m.conv_id.clone(),
                                    env: env.clone(),
                                    bot_id: String::new(),
                                },
                            ))
                            .ok();
                        self.store.set_message_status(&m.id, "sent")?;
                    } else {
                        self.store.requeue_outbox(&m.id, &owner)?;
                        self.store.set_message_status(&m.id, "pending")?;
                    }
                    break;
                }
                if !achou {
                    return Err(DistorrentError::Protocol(format!(
                        "reenvio não suportado para conversa do tipo {other}"
                    )));
                }
                let status = self
                    .store
                    .message_by_id(&m.id)?
                    .map(|x| x.status)
                    .unwrap_or_else(|| "sent".into());
                let _ = self.events.send(EngineEvent::MessageStatus {
                    msg_id: m.id.clone(),
                    status,
                });
            }
        }
        self.store
            .message_by_id(&m.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }
}
