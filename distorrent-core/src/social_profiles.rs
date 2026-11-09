// Metodos de crate::storage::Store: profiles. Irmao de social.rs (mesma impl, mesmo tipo).

use super::*;

impl crate::storage::Store {
    pub fn presence_set(
        &self,
        fp: &str,
        status: &str,
        custom: &str,
        custom_emoji: &str,
    ) -> Result<(), String> {
        let now = crate::identity::now_ms();
        let conn = self.locked();
        conn.execute(
            "INSERT INTO presence (fp, status, custom, custom_emoji, since, updated_at)
             VALUES (?1,?2,?3,?4,?5,?5)
             ON CONFLICT(fp) DO UPDATE SET status=excluded.status, custom=excluded.custom,
               custom_emoji=excluded.custom_emoji, since=excluded.since, updated_at=excluded.updated_at",
            params![fp, status, custom, custom_emoji, now],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn presence_offline(&self, fp: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO presence (fp, status, updated_at) VALUES (?1,'offline',?2)
             ON CONFLICT(fp) DO UPDATE SET status='offline', updated_at=excluded.updated_at",
            params![fp, crate::identity::now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn presence_get(&self, fp: &str) -> Result<PresenceView, String> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT fp, status, custom, custom_emoji, updated_at FROM presence WHERE fp=?1",
                params![fp],
                |r| {
                    Ok(PresenceView {
                        fp: r.get(0)?,
                        status: r.get(1)?,
                        custom: r.get(2)?,
                        custom_emoji: r.get(3)?,
                        updated_at: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut presence = r.unwrap_or(PresenceView {
            fp: fp.to_string(),
            status: "offline".into(),
            custom: String::new(),
            custom_emoji: String::new(),
            updated_at: 0,
        });
        if presence.status != "offline"
            && presence.updated_at < crate::identity::now_ms() - PRESENCE_TTL_MS
        {
            presence.status = "offline".into();
            presence.custom.clear();
            presence.custom_emoji.clear();
        }
        Ok(presence)
    }

    pub fn presence_get_live(&self, fp: &str) -> Result<PresenceView, String> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT fp, status, custom, custom_emoji, updated_at FROM presence WHERE fp=?1",
                params![fp],
                |r| {
                    Ok(PresenceView {
                        fp: r.get(0)?,
                        status: r.get(1)?,
                        custom: r.get(2)?,
                        custom_emoji: r.get(3)?,
                        updated_at: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(r.unwrap_or(PresenceView {
            fp: fp.to_string(),
            status: "offline".into(),
            custom: String::new(),
            custom_emoji: String::new(),
            updated_at: 0,
        }))
    }

    pub fn presence_list(&self) -> Result<Vec<PresenceView>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare("SELECT fp, status, custom, custom_emoji, updated_at FROM presence ORDER BY updated_at DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(PresenceView {
                    fp: r.get(0)?,
                    status: r.get(1)?,
                    custom: r.get(2)?,
                    custom_emoji: r.get(3)?,
                    updated_at: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut rows = rows
            .collect::<Result<Vec<PresenceView>, _>>()
            .map_err(|e| e.to_string())?;
        let now = crate::identity::now_ms();
        for presence in &mut rows {
            if presence.status != "offline" && presence.updated_at < now - PRESENCE_TTL_MS {
                presence.status = "offline".into();
                presence.custom.clear();
                presence.custom_emoji.clear();
            }
        }
        Ok(rows)
    }

    pub fn profile_set_local(
        &self,
        fp: &str,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
        clear_avatar: bool,
        clear_banner: bool,
        profile_theme: &str,
        avatar_effect: &str,
        decoration: &str,
    ) -> Result<Option<ProfileView>, String> {
        let conn = self.locked();
        let cur_rev: i64 = conn
            .query_row("SELECT rev FROM profiles WHERE fp=?1", params![fp], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);

        let old_avatar: String = conn
            .query_row(
                "SELECT avatar_b64 FROM profiles WHERE fp=?1",
                params![fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let av = if clear_avatar {
            String::new()
        } else if avatar_b64.is_empty() {
            old_avatar
        } else {
            avatar_b64.to_string()
        };
        let old_banner: String = conn
            .query_row(
                "SELECT banner_b64 FROM profiles WHERE fp=?1",
                params![fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let bn = if clear_banner {
            String::new()
        } else if banner_b64.is_empty() {
            old_banner
        } else {
            banner_b64.to_string()
        };

        let new_hash = profile_content_hash(display_name, about, &av, &bn, accent);
        let old_hash: String = conn
            .query_row(
                "SELECT content_hash FROM profiles WHERE fp=?1",
                params![fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        let new_style = profile_style_key(profile_theme, avatar_effect, decoration);
        let old_style: String = conn
            .query_row(
                "SELECT profile_theme || char(31) || avatar_effect || char(31) || decoration FROM profiles WHERE fp=?1",
                params![fp],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default();
        if old_hash == new_hash && !old_hash.is_empty() && old_style == new_style {
            drop(conn);
            return Ok(None);
        }

        let rev = cur_rev + 1;
        conn.execute(
            "INSERT INTO profiles (fp, display_name, about, avatar_b64, banner_b64, accent, updated_at, rev, content_hash, profile_theme, avatar_effect, decoration)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(fp) DO UPDATE SET display_name=excluded.display_name, about=excluded.about,
               avatar_b64=excluded.avatar_b64,
               banner_b64=excluded.banner_b64,
               accent=excluded.accent, updated_at=excluded.updated_at,
               rev=excluded.rev, content_hash=excluded.content_hash,
               profile_theme=excluded.profile_theme, avatar_effect=excluded.avatar_effect,
               decoration=excluded.decoration",
            params![
                fp,
                display_name,
                about,
                av,
                bn,
                accent,
                crate::identity::now_ms(),
                rev,
                new_hash,
                profile_theme,
                avatar_effect,
                decoration
            ],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        Ok(Some(self.profile_get(fp)?))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn profile_apply_remote(
        &self,
        fp: &str,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
        rev: i64,
    ) -> Result<bool, String> {
        self.profile_apply_remote_full(
            fp,
            display_name,
            about,
            avatar_b64,
            banner_b64,
            accent,
            rev,
            "",
            "",
            "",
        )
    }

    /// Aplica perfil remoto incluindo as customizações visuais. A `rev` manda;
    /// no empate, o hash v1 e depois a chave de estilo desempatam — sem isso
    /// dois dispositivos com a mesma revisão ficariam alternando eternamente.
    #[allow(clippy::too_many_arguments)]
    pub fn profile_apply_remote_full(
        &self,
        fp: &str,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
        rev: i64,
        profile_theme: &str,
        avatar_effect: &str,
        decoration: &str,
    ) -> Result<bool, String> {
        let conn = self.locked();
        let cur = conn
            .query_row(
                "SELECT rev, content_hash, profile_theme, avatar_effect, decoration FROM profiles WHERE fp=?1",
                params![fp],
                |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let (cur_rev, cur_hash, cur_theme, cur_effect, cur_deco) = cur.unwrap_or((
            0,
            String::new(),
            String::new(),
            String::new(),
            String::new(),
        ));
        let new_hash = profile_content_hash(display_name, about, avatar_b64, banner_b64, accent);
        let new_style = profile_style_key(profile_theme, avatar_effect, decoration);
        let cur_style = profile_style_key(&cur_theme, &cur_effect, &cur_deco);

        let accept = if rev > cur_rev {
            true
        } else if rev < cur_rev {
            false
        } else if !cur_hash.is_empty() && cur_hash == new_hash {
            // Conteúdo igual: só aceita se o estilo mudou para um valor "maior".
            new_style != cur_style && new_style > cur_style
        } else if rev == 0 {
            cur_hash != new_hash || cur_style != new_style
        } else {
            new_hash > cur_hash || (new_hash == cur_hash && new_style > cur_style)
        };
        if !accept {
            return Ok(false);
        }

        conn.execute(
            "INSERT INTO profiles (fp, display_name, about, avatar_b64, banner_b64, accent, updated_at, rev, content_hash, profile_theme, avatar_effect, decoration)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(fp) DO UPDATE SET display_name=excluded.display_name, about=excluded.about,
               avatar_b64=excluded.avatar_b64,
               banner_b64=excluded.banner_b64,
               accent=excluded.accent, updated_at=excluded.updated_at,
               rev=excluded.rev, content_hash=excluded.content_hash,
               profile_theme=excluded.profile_theme, avatar_effect=excluded.avatar_effect,
               decoration=excluded.decoration",
            params![
                fp,
                display_name,
                about,
                avatar_b64,
                banner_b64,
                accent,
                crate::identity::now_ms(),
                rev,
                new_hash,
                profile_theme,
                avatar_effect,
                decoration
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn profile_set(
        &self,
        fp: &str,
        display_name: &str,
        about: &str,
        avatar_b64: &str,
        banner_b64: &str,
        accent: &str,
    ) -> Result<(), String> {
        let hash = profile_content_hash(display_name, about, avatar_b64, banner_b64, accent);
        let conn = self.locked();
        conn.execute(
            "INSERT INTO profiles (fp, display_name, about, avatar_b64, banner_b64, accent, updated_at, content_hash)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(fp) DO UPDATE SET display_name=excluded.display_name, about=excluded.about,
               avatar_b64=CASE WHEN excluded.avatar_b64='' THEN profiles.avatar_b64 ELSE excluded.avatar_b64 END,
               banner_b64=CASE WHEN excluded.banner_b64='' THEN profiles.banner_b64 ELSE excluded.banner_b64 END,
               accent=excluded.accent, updated_at=excluded.updated_at,
               content_hash=excluded.content_hash",
            params![
                fp,
                display_name,
                about,
                avatar_b64,
                banner_b64,
                accent,
                crate::identity::now_ms(),
                hash
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn profile_get(&self, fp: &str) -> Result<ProfileView, String> {
        let conn = self.locked();
        let r = conn
            .query_row(
                "SELECT fp, display_name, about, avatar_b64, banner_b64, accent, updated_at, rev, content_hash,
                        profile_theme, avatar_effect, decoration
                   FROM profiles WHERE fp=?1",
                params![fp],
                |r| {
                    Ok(ProfileView {
                        fp: r.get(0)?,
                        display_name: r.get(1)?,
                        about: r.get(2)?,
                        avatar_b64: r.get(3)?,
                        banner_b64: r.get(4)?,
                        accent: r.get(5)?,
                        updated_at: r.get(6)?,
                        rev: r.get(7)?,
                        content_hash: r.get(8)?,
                        profile_theme: r.get(9)?,
                        avatar_effect: r.get(10)?,
                        decoration: r.get(11)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(r.unwrap_or(ProfileView {
            fp: fp.to_string(),
            ..Default::default()
        }))
    }

    pub fn profile_list(&self) -> Result<Vec<ProfileView>, String> {
        let conn = self.locked();
        let mut stmt = conn
            .prepare(
                "SELECT fp, display_name, about, avatar_b64, banner_b64, accent, updated_at, rev, content_hash,
                        profile_theme, avatar_effect, decoration
                   FROM profiles ORDER BY updated_at DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(ProfileView {
                    fp: r.get(0)?,
                    display_name: r.get(1)?,
                    about: r.get(2)?,
                    avatar_b64: r.get(3)?,
                    banner_b64: r.get(4)?,
                    accent: r.get(5)?,
                    updated_at: r.get(6)?,
                    rev: r.get(7)?,
                    content_hash: r.get(8)?,
                    profile_theme: r.get(9)?,
                    avatar_effect: r.get(10)?,
                    decoration: r.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }

    pub fn nickname_set(&self, community_id: &str, fp: &str, nick: &str) -> Result<(), String> {
        let conn = self.locked();
        conn.execute(
            "INSERT INTO server_nicknames (community_id, fp, nickname) VALUES (?1,?2,?3)
             ON CONFLICT(community_id, fp) DO UPDATE SET nickname=excluded.nickname",
            params![community_id, fp, nick],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn nickname_get(&self, community_id: &str, fp: &str) -> Result<String, String> {
        let conn = self.locked();
        Ok(conn
            .query_row(
                "SELECT nickname FROM server_nicknames WHERE community_id=?1 AND fp=?2",
                params![community_id, fp],
                |r| r.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .unwrap_or_default())
    }
}
