// Metodos de NetworkEngine: channels_roles.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn channel_create(
        &self,
        community_id: &str,
        name: &str,
        topic: &str,
        category: &str,
        kind: &str,
    ) -> Result<ChannelMetaRow> {
        self.require_owner(community_id)?;
        let existing: Vec<String> = self
            .store
            .list_channels(community_id)?
            .into_iter()
            .map(|(_, n)| n)
            .collect();
        let valid = Self::validate_name_gate(
            crate::names::NameKind::Channel,
            &Self::normalize_channel_name(name),
            &existing,
        )?;
        if valid.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do canal não pode ser vazio".into(),
            ));
        }
        let kind = if kind.is_empty() { "text" } else { kind };
        if kind != "text" && kind != "voice" && kind != "video" {
            return Err(DistorrentError::Protocol(
                "tipo de canal inválido (text|voice|video)".into(),
            ));
        }
        let id = format!("{community_id}-ch-{}", Self::rand_hex(4));
        let position = self.store.channel_rows(community_id)?.len() as i64;
        let default_cat = match kind {
            "voice" => "CANAIS DE VOZ",
            "video" => "CANAIS DE VÍDEO",
            _ => "CANAIS DE TEXTO",
        };
        let row = ChannelMetaRow {
            id,
            name: valid,
            topic: topic.trim().to_string(),
            category: if category.trim().is_empty() {
                default_cat.into()
            } else {
                category.trim().to_string()
            },
            kind: kind.into(),
            position,
        };
        self.store.upsert_channel(community_id, &row)?;
        let _ = self.events.send(EngineEvent::ChannelCreated {
            community_id: community_id.into(),
            channel_id: row.id.clone(),
            name: row.name.clone(),
        });
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    pub fn channel_delete(&self, community_id: &str, channel_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.delete_channel(community_id, channel_id)? == 0 {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.store.delete_messages_by_conv(channel_id)?;
        let _ = self.events.send(EngineEvent::ChannelDeleted {
            community_id: community_id.into(),
            channel_id: channel_id.into(),
        });
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn channel_rename(
        &self,
        community_id: &str,
        channel_id: &str,
        new_name: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        let others: Vec<String> = self
            .store
            .list_channels(community_id)?
            .into_iter()
            .filter(|(id, _)| id != channel_id)
            .map(|(_, n)| n)
            .collect();
        let valid = Self::validate_name_gate(
            crate::names::NameKind::Channel,
            &Self::normalize_channel_name(new_name),
            &others,
        )?;
        if valid.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do canal não pode ser vazio".into(),
            ));
        }
        if self
            .store
            .update_channel(community_id, channel_id, Some(&valid), None, None)?
            == 0
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn channel_set_topic(
        &self,
        community_id: &str,
        channel_id: &str,
        topic: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .update_channel(community_id, channel_id, None, Some(topic), None)?
            == 0
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn channel_set_category(
        &self,
        community_id: &str,
        channel_id: &str,
        category: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        let category = category.trim();
        if category.is_empty() {
            return Err(DistorrentError::Protocol(
                "categoria não pode ser vazia".into(),
            ));
        }
        if self
            .store
            .set_channel_category(community_id, channel_id, category)?
            == 0
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn channel_list(&self, community_id: &str) -> Result<Vec<ChannelMetaRow>> {
        self.store.channel_rows(community_id)
    }

    pub fn community_rename(&self, community_id: &str, name: &str) -> Result<()> {
        self.require_owner(community_id)?;
        let others: Vec<String> = self
            .store
            .list_communities()
            .unwrap_or_default()
            .into_iter()
            .filter(|(id, _, _)| id != community_id)
            .map(|(_, n, _)| n)
            .collect();
        let name = Self::validate_name_gate(crate::names::NameKind::Server, name, &others)?;
        if self.store.community_set_name(community_id, &name)? == 0 {
            return Err(DistorrentError::Protocol("comunidade inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn role_create(
        &self,
        community_id: &str,
        name: &str,
        color: &str,
        permissions: i64,
        hoist: bool,
        mentionable: bool,
    ) -> Result<RoleRow> {
        self.require_owner(community_id)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do cargo não pode ser vazio".into(),
            ));
        }
        let row = RoleRow {
            id: format!("{community_id}-role-{}", Self::rand_hex(3)),
            community_id: community_id.to_string(),
            name: name.to_string(),
            color: if color.trim().is_empty() {
                "#949ba4".into()
            } else {
                color.trim().to_string()
            },
            permissions,
            hoist,
            mentionable,
            position: self.store.next_role_position(community_id)?,
        };
        self.store.role_upsert(&row)?;
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn role_update(
        &self,
        community_id: &str,
        role_id: &str,
        name: Option<&str>,
        color: Option<&str>,
        permissions: Option<i64>,
        hoist: Option<bool>,
        mentionable: Option<bool>,
        position: Option<i64>,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if !self.store.role_update_patch(
            community_id,
            role_id,
            name,
            color,
            permissions,
            hoist,
            mentionable,
            position,
        )? {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn role_delete(&self, community_id: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if role_id.ends_with("-everyone") {
            return Err(DistorrentError::Protocol(
                "@everyone não pode ser apagado".into(),
            ));
        }
        if self.store.role_delete(community_id, role_id)? == 0 {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn roles_list(&self, community_id: &str) -> Result<Vec<RoleRow>> {
        self.store.roles_list(community_id)
    }

    pub fn member_roles(&self, community_id: &str, fp: &str) -> Result<Vec<String>> {
        self.store.member_roles_list(community_id, fp)
    }

    pub fn member_assign_role(&self, community_id: &str, fp: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if !self
            .store
            .roles_list(community_id)?
            .iter()
            .any(|r| r.id == role_id)
        {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        if self
            .store
            .list_members(community_id)?
            .iter()
            .all(|(m, _, _)| m != fp)
        {
            return Err(DistorrentError::Protocol("membro inexistente".into()));
        }
        self.store.member_role_assign(community_id, fp, role_id)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn member_unassign_role(&self, community_id: &str, fp: &str, role_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if !self
            .store
            .roles_list(community_id)?
            .iter()
            .any(|r| r.id == role_id)
        {
            return Err(DistorrentError::Protocol("cargo inexistente".into()));
        }
        self.store.member_role_unassign(community_id, fp, role_id)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn member_kick(&self, community_id: &str, fp: &str) -> Result<()> {
        self.require_owner(community_id)?;
        let comm = self
            .store
            .get_community(community_id)?
            .ok_or_else(|| DistorrentError::Protocol("comunidade inexistente".into()))?;
        if fp == comm.2 {
            return Err(DistorrentError::Protocol(
                "o dono não pode ser expulso".into(),
            ));
        }
        if self
            .store
            .list_members(community_id)?
            .iter()
            .all(|(m, _, _)| m != fp)
        {
            return Err(DistorrentError::Protocol("membro inexistente".into()));
        }
        self.store.remove_member(community_id, fp)?;
        self.store.member_roles_remove_all(community_id, fp)?;
        let _ = self.events.send(EngineEvent::MemberLeft {
            community_id: community_id.into(),
            fp: fp.into(),
            nickname: String::new(),
        });
        if self.link_tx(fp).is_some() {
            self.cmd_tx
                .send(EngineCmd::SendToPeer(
                    fp.to_string(),
                    SecureFrame::CommunityKicked {
                        community_id: community_id.to_string(),
                    },
                ))
                .ok();
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn reorder_channels(&self, community_id: &str, ids: &[String]) -> Result<()> {
        let me = &self.identity.fingerprint;
        let is_owner = self
            .store
            .get_community(community_id)
            .ok()
            .flatten()
            .map(|(_, _, owner)| owner == *me)
            .unwrap_or(false);
        if !is_owner && !self.is_moderator(community_id, me) {
            return Err(DistorrentError::Protocol(
                "sem permissão para reordenar".into(),
            ));
        }
        self.store.channels_reorder(community_id, ids)?;
        self.broadcast_community_state(community_id);
        Ok(())
    }
}
