// Metodos de NetworkEngine: bots.
// Arquivo irmao de engine.rs; o impl e o mesmo tipo, entao campos privados
// continuam acessiveis. Declarado por #[path] para herdar o mesmo modulo.

use super::*;

impl NetworkEngine {
    pub fn bot_create(
        &self,
        community_id: &str,
        name: &str,
        avatar: Option<&str>,
        role_id: Option<&str>,
    ) -> Result<BotRow> {
        self.require_owner(community_id)?;
        let name = name.trim();
        if name.is_empty() {
            return Err(DistorrentError::Protocol(
                "nome do bot não pode ser vazio".into(),
            ));
        }
        let role_id = match role_id.map(str::trim) {
            Some("") | None => None,
            Some(r) => {
                let exists = self
                    .store
                    .roles_list(community_id)
                    .map(|rs| rs.iter().any(|x| x.id == r))
                    .unwrap_or(false);
                if !exists {
                    return Err(DistorrentError::Protocol(format!(
                        "cargo {r} não existe nesta comunidade"
                    )));
                }
                Some(r.to_string())
            }
        };
        let discriminator: String = {
            use rand::Rng;
            format!("{:04}", rand::thread_rng().gen_range(0..10000))
        };
        let row = BotRow {
            id: format!("{community_id}-bot-{}", Self::rand_hex(6)),
            community_id: community_id.to_string(),
            name: name.to_string(),
            discriminator,
            avatar: avatar
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .unwrap_or("🤖")
                .to_string(),
            role_id,
            token: format!("bot_{}_{}", Self::rand_hex(12), Self::rand_hex(4)),
            online: true,
            owner_fp: self.identity.fingerprint.clone(),
            created_at: crate::identity::now_ms(),
            config: String::new(),
            perms: 0,
            webhook_secret: String::new(),
        };
        self.store.bot_upsert(&row)?;
        let _ = self.events.send(EngineEvent::BotCreated {
            community_id: community_id.into(),
            bot_id: row.id.clone(),
        });
        self.broadcast_community_state(community_id);
        Ok(row)
    }

    pub fn bot_update(&self, community_id: &str, bot_id: &str, patch: BotPatch) -> Result<()> {
        self.require_owner(community_id)?;
        if !self.store.bot_update_patch(community_id, bot_id, &patch)? {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn bot_delete(&self, community_id: &str, bot_id: &str) -> Result<()> {
        self.require_owner(community_id)?;
        if self.store.bot_delete(community_id, bot_id)? == 0 {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.broadcast_community_state(community_id);
        Ok(())
    }

    pub fn bots_list(&self, community_id: &str) -> Result<Vec<BotRow>> {
        self.store.bots_list(community_id)
    }

    pub fn bot_regen_token(&self, community_id: &str, bot_id: &str) -> Result<String> {
        self.require_owner(community_id)?;
        let all = self.store.bots_list(community_id)?;
        let Some(mut b) = all.into_iter().find(|x| x.id == bot_id) else {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        };
        b.token = format!("bot_{}_{}", Self::rand_hex(12), Self::rand_hex(4));
        self.store.bot_upsert(&b)?;
        self.broadcast_community_state(community_id);
        Ok(b.token)
    }

    pub fn bot_post_message(
        &self,
        community_id: &str,
        channel_id: &str,
        bot_id: &str,
        body: &str,
    ) -> Result<crate::storage::StoredMessage> {
        self.require_owner(community_id)?;
        let bot_id = bot_id.trim();
        if bot_id.is_empty() {
            return Err(DistorrentError::Protocol("bot_id vazio".into()));
        }
        if !self
            .store
            .bots_list(community_id)?
            .iter()
            .any(|b| b.id == bot_id)
        {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        if !self
            .store
            .list_channels(community_id)?
            .iter()
            .any(|(id, _)| id == channel_id)
        {
            return Err(DistorrentError::Protocol("canal inexistente".into()));
        }
        let body = body.trim();
        if body.is_empty() {
            return Err(DistorrentError::Protocol("mensagem vazia".into()));
        }
        if body.len() > 64 * 1024 {
            return Err(DistorrentError::Protocol(
                "mensagem muito longa (máx 64KB)".into(),
            ));
        }
        if let Some(b) = self
            .store
            .bots_list(community_id)?
            .into_iter()
            .find(|x| x.id == bot_id)
        {
            if !b.online {
                return Err(DistorrentError::Protocol(
                    "bot está offline — ative-o no painel".into(),
                ));
            }
        }
        let env = MessageEnvelope::new(&self.keypair, channel_id, body);
        self.store
            .insert_message_as_bot(&env, "out", "sending", bot_id)?;
        crate::metrics::metrics().message_out();
        self.host_relay(community_id, channel_id, &env, bot_id)?;
        self.store.set_message_status(&env.id, "sent")?;
        self.store
            .message_by_id(&env.id)?
            .ok_or_else(|| DistorrentError::Storage(rusqlite::Error::QueryReturnedNoRows))
    }

    /// Executa uma ação administrativa em nome de um bot.
    ///
    /// A autorização é conferida AQUI, não na UI: o bot precisa existir, estar
    /// online e ter a permissão específica que o dono concedeu. Um bot nunca
    /// alcança o dono do servidor nem age além do que lhe foi dado, e toda
    /// ação vira audit log com o `bot_id` como autor.
    pub fn bot_admin(
        &self,
        community_id: &str,
        bot_id: &str,
        action: &str,
        target: &str,
        reason: &str,
        number: Option<i64>,
    ) -> Result<String> {
        self.bot_action_in(community_id, bot_id, action, target, reason, number, None)
    }

    pub fn bot_logs(
        &self,
        community_id: &str,
        bot_id: &str,
        limit: i64,
    ) -> Result<Vec<crate::storage::BotLogRow>> {
        self.require_owner(community_id)?;
        self.store.bot_logs(community_id, bot_id, limit)
    }

    pub fn bot_logs_clear(&self, community_id: &str, bot_id: &str) -> Result<usize> {
        self.require_owner(community_id)?;
        self.store.bot_logs_clear(community_id, bot_id)
    }

    /// O runtime roda na máquina do dono; log/variável exigem que o bot exista.
    pub fn bot_log_append(
        &self,
        community_id: &str,
        bot_id: &str,
        level: &str,
        message: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .bots_list(community_id)?
            .iter()
            .all(|b| b.id != bot_id)
        {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.store.bot_log(community_id, bot_id, level, message)
    }

    pub fn bot_vars_list(&self, community_id: &str, bot_id: &str) -> Result<Vec<(String, String)>> {
        self.require_owner(community_id)?;
        self.store.bot_vars_list(community_id, bot_id)
    }

    pub fn bot_var_set(
        &self,
        community_id: &str,
        bot_id: &str,
        key: &str,
        value: &str,
    ) -> Result<()> {
        self.require_owner(community_id)?;
        if self
            .store
            .bots_list(community_id)?
            .iter()
            .all(|b| b.id != bot_id)
        {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        }
        self.store.bot_var_set(community_id, bot_id, key, value)
    }

    /// O bot troca a **própria** config em tempo de execução (rota
    /// `POST /v1/commands` da ponte). Regras que não podem cair:
    ///
    /// - a config inteira é revalidada pelo parser do core;
    /// - `perms` **não** muda por aqui: um bot nunca se concede poder;
    /// - o bot precisa existir e estar online, como em qualquer ação.
    pub fn bot_replace_config(&self, community_id: &str, bot_id: &str, raw: &str) -> Result<usize> {
        self.require_owner(community_id)?;
        let Some(bot) = self
            .store
            .bots_list(community_id)?
            .into_iter()
            .find(|b| b.id == bot_id)
        else {
            return Err(DistorrentError::Protocol("bot inexistente".into()));
        };
        if !bot.online {
            return Err(DistorrentError::Protocol(
                "bot está offline — ative-o no painel".into(),
            ));
        }
        let mut parsed = crate::bots::parse_config(raw).map_err(DistorrentError::Protocol)?;
        // Política do DONO, não do bot: um `POST /v1/commands` não pode religar
        // rede privada nem trocar o webhook por um endereço próprio. Sem isto o
        // bot desfazia o opt-in do dono e abria o SSRF que a guarda fecha.
        let atual = crate::bots::parse_config(&bot.config).unwrap_or_default();
        parsed.block_private = atual.block_private;
        parsed.http_allow = atual.http_allow.clone();
        // Segredo: vem da coluna local (nunca do JSON sincronizado) e o bot não consegue trocá-lo pela ponte.
        parsed.webhook_secret = Some(bot.webhook_secret.clone());
        // Grava a forma NORMALIZADA (v3): o que o parser descartou não volta, e os campos novos não somem quando o bot edita o próprio comando.
        let normalized = crate::bots::normalize(&parsed).to_string();
        let n = parsed.commands.len();
        // `perms: None` de propósito: o bot NÃO altera as próprias permissões.
        self.store.bot_update_patch(
            community_id,
            bot_id,
            &crate::storage::BotPatch {
                config: Some(normalized),
                ..Default::default()
            },
        )?;
        self.broadcast_community_state(community_id);
        Ok(n)
    }
}
