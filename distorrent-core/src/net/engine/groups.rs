// Metodos de NetworkEngine: groups.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn group_pair_now(&self, conv_id: &str) {
        let me = self.identity.fingerprint.clone();
        let membros = self.store.list_group_members(conv_id).unwrap_or_default();
        if membros.iter().all(|(fp, _)| fp != &me) {
            return;
        }
        for (fp, _nick) in membros {
            if fp == me || self.link_tx(&fp).is_some() {
                continue;
            }
            self.connect_to_community_peer(&fp);
        }
    }

    pub fn pair_all_groups_now(&self) {
        let me = self.identity.fingerprint.clone();
        for conv in self.store.list_conversations().unwrap_or_default() {
            if conv.kind != "group" {
                continue;
            }
            let membros = self.store.list_group_members(&conv.id).unwrap_or_default();
            if membros.iter().all(|(fp, _)| fp != &me) {
                continue;
            }
            for (fp, _nick) in membros {
                if fp == me || self.link_tx(&fp).is_some() {
                    continue;
                }
                self.connect_to_community_peer(&fp);
            }
        }
    }

    pub fn maintain_groups(&self) {
        let now = crate::identity::now_ms();
        let me = self.identity.fingerprint.clone();
        let convs = self.store.list_conversations().unwrap_or_default();
        for conv in convs {
            if conv.kind != "group" {
                continue;
            }
            let membros = self.store.list_group_members(&conv.id).unwrap_or_default();
            if membros.iter().all(|(fp, _)| fp != &me) {
                continue;
            }
            for (fp, _nick) in membros {
                if fp == me {
                    continue;
                }
                if self.link_tx(&fp).is_some() {
                    continue;
                }
                self.connect_to_community_peer_throttled(&fp, now, 45_000);
            }
        }
    }

    pub fn create_group(&self, title: &str, members: Vec<String>) -> Result<Conversation> {
        if members.is_empty() {
            return Err(DistorrentError::Protocol(
                "selecione ao menos 1 pessoa".into(),
            ));
        }
        if members.len() > 9 {
            return Err(DistorrentError::Protocol(
                "máximo 9 membros + você (10 total)".into(),
            ));
        }
        for fp in &members {
            let f = fp.trim();
            if f.is_empty() || f == self.identity.fingerprint {
                return Err(DistorrentError::Protocol(
                    "fingerprint inválido para o grupo".into(),
                ));
            }
        }
        let conv = self
            .store
            .create_group_dm(&self.identity.fingerprint, &members, title)?;
        self.broadcast_group_created(&conv.id);
        Ok(conv)
    }

    fn broadcast_group_created(&self, conv_id: &str) {
        let members = self.store.list_group_members(conv_id).unwrap_or_default();
        let title = self
            .store
            .get_conversation(conv_id)
            .ok()
            .flatten()
            .map(|c| c.title)
            .unwrap_or_default();
        let me = self.identity.fingerprint.clone();
        let dono = self
            .store
            .group_owner(conv_id)
            .ok()
            .flatten()
            .unwrap_or_default();
        for (fp, _) in &members {
            if *fp == me {
                continue;
            }
            if self.link_tx(fp).is_some() {
                self.cmd_tx
                    .send(EngineCmd::SendToPeer(
                        fp.clone(),
                        SecureFrame::GroupCreated {
                            conv_id: conv_id.to_string(),
                            title: title.clone(),
                            members: members.clone(),
                            owner_fp: dono.clone(),
                        },
                    ))
                    .ok();
            }
        }
    }

    /// Só quem criou o grupo gerencia roster e nome. Antes, qualquer membro
    /// (ou o próprio peer removido, reenviando o frame) mudava o grupo de
    /// todos — a autorização ficava só na UI.
    fn require_group_owner(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let me = &self.identity.fingerprint;
        let dono = self.store.group_owner(conv_id)?.unwrap_or_default();
        if &dono != me {
            return Err(DistorrentError::Protocol(
                "só quem criou o grupo pode alterar membros".into(),
            ));
        }
        Ok(())
    }

    pub fn group_members(&self, conv_id: &str) -> Vec<(String, String)> {
        self.store.list_group_members(conv_id).unwrap_or_default()
    }

    /// Dono real do grupo, como o core decide (tabela `group_owners`, caindo no
    /// primeiro membro só quando não há registro). A UI não pode adivinhar:
    /// adivinhar pelo primeiro membro mostrava "Sair" para quem é dono.
    pub fn group_dono(&self, conv_id: &str) -> Result<Option<String>> {
        self.store.group_owner(conv_id)
    }

    pub fn group_add(&self, conv_id: &str, fp: &str) -> Result<()> {
        self.require_group_owner(conv_id)?;
        let fp = Self::normalize_peer_id(fp)?;
        if fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol("você já está no grupo".into()));
        }
        if self.store.is_blocked_fp(&fp) {
            return Err(DistorrentError::Protocol(
                "não é possível adicionar um peer bloqueado".into(),
            ));
        }
        let atuais = self.store.list_group_members(conv_id)?;
        if atuais.len() >= 10 {
            return Err(DistorrentError::Protocol(
                "máximo 9 membros + você (10 total)".into(),
            ));
        }
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        self.store.add_group_member(conv_id, &fp, "")?;
        let _ = crate::group_trash::restore(&self.store, conv_id);
        let members = self.store.list_group_members(conv_id)?;
        let title = conv.title.clone();
        let me = self.identity.fingerprint.clone();
        for (mfp, _) in &members {
            if *mfp == me {
                continue;
            }
            if self.link_tx(mfp).is_some() {
                if *mfp == fp {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            mfp.clone(),
                            SecureFrame::GroupCreated {
                                conv_id: conv_id.to_string(),
                                title: title.clone(),
                                members: members.clone(),
                                owner_fp: self.store.group_owner(conv_id)?.unwrap_or_default(),
                            },
                        ))
                        .ok();
                } else {
                    self.cmd_tx
                        .send(EngineCmd::SendToPeer(
                            mfp.clone(),
                            SecureFrame::GroupMemberAdded {
                                conv_id: conv_id.to_string(),
                                fp: fp.to_string(),
                                nickname: String::new(),
                            },
                        ))
                        .ok();
                }
            }
        }
        Ok(())
    }

    pub fn group_remove(&self, conv_id: &str, fp: &str) -> Result<()> {
        self.require_group_owner(conv_id)?;
        if fp == self.identity.fingerprint {
            return Err(DistorrentError::Protocol(
                "o criador não pode sair do próprio grupo".into(),
            ));
        }
        self.store.remove_group_member(conv_id, fp)?;
        self.broadcast_group_created(conv_id);
        Ok(())
    }

    pub fn group_leave(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let me = self.identity.fingerprint.clone();
        let membros = self.store.list_group_members(conv_id)?;
        let sou_criador = self
            .store
            .group_owner(conv_id)?
            .map(|d| d == me)
            .unwrap_or(false);
        if sou_criador {
            return Err(DistorrentError::Protocol(
                "você criou este grupo — escolha apagar para todos ou só para você".into(),
            ));
        }
        let restantes: Vec<(String, String)> = membros
            .iter()
            .filter(|(fp, _)| fp != &me)
            .cloned()
            .collect();
        let titulo = conv.title.clone();
        for (fp, _) in &restantes {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp.clone(),
                    SecureFrame::GroupCreated {
                        conv_id: conv_id.to_string(),
                        title: titulo.clone(),
                        members: restantes.clone(),
                        owner_fp: self.store.group_owner(conv_id)?.unwrap_or_default(),
                    },
                ))
                .ok();
        }
        self.store.leave_group_local(conv_id)?;
        // Sair do grupo precisa marcar como dispensado como apagar "só para mim".
        // Sem isto, o próximo GroupCreated/sync de qualquer membro recriava o
        // grupo minutos depois — era o "saio e ele volta". O criador vai junto
        // porque a conversa some e só ele pode me readicionar de propósito.
        let dono = self.store.group_owner(conv_id)?.unwrap_or_default();
        let _ = crate::group_trash::dismiss_owned(&self.store, conv_id, &dono);
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: String::new(),
        });
        Ok(())
    }

    pub fn group_delete(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let me = self.identity.fingerprint.clone();
        let membros = self.store.list_group_members(conv_id)?;
        let sou_criador = self
            .store
            .group_owner(conv_id)?
            .map(|d| d == me)
            .unwrap_or(false);
        if !sou_criador {
            return Err(DistorrentError::Protocol(
                "só quem criou o grupo pode apagar para todos".into(),
            ));
        }
        for (fp, _) in membros.iter().filter(|(fp, _)| fp != &me) {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp.clone(),
                    SecureFrame::GroupDeleted {
                        conv_id: conv_id.to_string(),
                    },
                ))
                .ok();
        }
        self.store.leave_group_local(conv_id)?;
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: String::new(),
        });
        Ok(())
    }

    pub fn group_delete_local(&self, conv_id: &str) -> Result<()> {
        let conv = self
            .store
            .get_conversation(conv_id)?
            .ok_or_else(|| DistorrentError::Protocol("grupo inexistente".into()))?;
        if conv.kind != "group" {
            return Err(DistorrentError::Protocol("não é grupo".into()));
        }
        let membros = self.store.list_group_members(conv_id).unwrap_or_default();
        let dono = self.store.group_owner(conv_id)?.unwrap_or_default();
        self.store.leave_group_local(conv_id)?;
        let _ = crate::group_trash::dismiss_owned(&self.store, conv_id, &dono);
        let _ = membros;
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: String::new(),
        });
        Ok(())
    }

    pub fn group_rename(&self, conv_id: &str, title: &str) -> Result<()> {
        self.require_group_owner(conv_id)?;
        let nome = crate::names::sanitize_text(title, 64).trim().to_string();
        if nome.is_empty() {
            return Err(DistorrentError::Protocol("título vazio".into()));
        }
        self.store.update_conversation_title(conv_id, &nome)?;
        self.broadcast_group_created(conv_id);
        let _ = self.events.send(EngineEvent::GroupSynced {
            conv_id: conv_id.to_string(),
            title: nome,
        });
        Ok(())
    }
}
