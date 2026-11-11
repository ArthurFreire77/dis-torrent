// Roteador HTTP das pontes de bot (handle): o maior trecho de botbridge.rs.
// Fica separado para o arquivo nao passar de 1.000 linhas.

use super::*;

pub(super) fn handle(mut req: Request, shared: &Arc<Shared>, engine: &Arc<NetworkEngine>) {
    shared.requests.fetch_add(1, Ordering::Relaxed);

    if header(&req, "origin").is_some() {
        return respond(
            req,
            403,
            serde_json::json!({"error": "origem de navegador não é aceita pela ponte local"}),
        );
    }
    // Anti DNS-rebinding: o Host tem que ser o loopback desta porta.
    let host_ok = header(&req, "host")
        .map(|h| {
            let h = h.to_ascii_lowercase();
            h == format!("127.0.0.1:{}", shared.port) || h == format!("localhost:{}", shared.port)
        })
        .unwrap_or(false);
    if !host_ok {
        return respond(req, 421, serde_json::json!({"error": "Host inválido"}));
    }
    let raw_url = req.url().to_string();
    if !secret_matches(&raw_url, &shared.path) {
        return respond(req, 404, serde_json::json!({"error": "rota inexistente"}));
    }

    // Remove o prefixo secreto: as rotas continuam `/v1/...`.
    let rest_of_url = raw_url[shared.path.len()..].to_string();
    let path = rest_of_url.split('?').next().unwrap_or("").to_string();
    let query = rest_of_url
        .split_once('?')
        .map(|(_, q)| q.to_string())
        .unwrap_or_default();
    let method = req.method().clone();

    let per_route = if path == "/v1/events" {
        RATE_EVENTS_PER_MIN
    } else {
        RATE_WRITE_PER_MIN
    };
    let route_bucket = if path == "/v1/events" {
        &shared.window_events
    } else {
        &shared.window_write
    };
    if !rate_ok(&shared.window, RATE_PER_MIN) || !rate_ok(route_bucket, per_route) {
        shared.dropped.fetch_add(1, Ordering::Relaxed);
        return respond(
            req,
            429,
            serde_json::json!({
                "error": "limite de requisições por minuto",
                "hint": "respeite o Retry-After e diminua a frequência",
                "retry_after": 60,
            }),
        );
    }

    let idem_key = if method == Method::Post {
        header(&req, "idempotency-key")
            .map(|k| k.trim().to_string())
            .filter(|k| !k.is_empty() && k.len() <= 128)
    } else {
        None
    };
    if let Some(key) = &idem_key {
        if let Some((status, body)) = idem_lookup(shared, key) {
            let value = serde_json::from_str(&body)
                .unwrap_or_else(|_| serde_json::json!({"ok": true, "replayed": true}));
            return respond(req, status, value);
        }
    }

    match (&method, path.as_str()) {
        (Method::Get, "/v1/info") => {
            let channels = engine
                .store
                .channel_rows(&shared.community_id)
                .map(|rows| {
                    rows.into_iter()
                        .map(|c| serde_json::json!({"id": c.id, "name": c.name, "kind": c.kind}))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let members = engine
                .store
                .list_members(&shared.community_id)
                .map(|rows| {
                    rows.into_iter()
                        .map(|(fp, nick, role)| {
                            serde_json::json!({"fp": fp, "nickname": nick, "role": role})
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let me = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| {
                    serde_json::json!({
                        "id": b.id, "name": b.name, "discriminator": b.discriminator,
                        "perms": b.perms, "online": b.online,
                    })
                });
            let community = engine
                .store
                .get_community(&shared.community_id)
                .ok()
                .flatten()
                .map(|(id, name, owner)| {
                    serde_json::json!({"id": id, "name": name, "owner_fp": owner})
                });
            // O plugin descobre o repertório daqui em vez de adivinhar nomes.
            let actions = distorrent_core::moderation::BOT_ACTIONS
                .iter()
                .map(|a| {
                    serde_json::json!({
                        "action": a.action, "perm": a.perm, "args": a.args, "label": a.label,
                    })
                })
                .collect::<Vec<_>>();
            respond(
                req,
                200,
                serde_json::json!({
                    "api": "distorrent-bot/1",
                    "bot": me,
                    "community": community,
                    "channels": channels,
                    "members": members,
                    "actions": actions,
                }),
            );
        }
        (Method::Get, "/v1/events") => {
            let since: u64 = query
                .split('&')
                .find_map(|p| p.strip_prefix("since="))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            let wait_ms: u64 = query
                .split('&')
                .find_map(|p| p.strip_prefix("wait="))
                .and_then(|v| v.parse().ok())
                .unwrap_or(0)
                .min(25_000);
            let deadline = Instant::now() + Duration::from_millis(wait_ms);

            loop {
                {
                    let buf = shared.events.lock().unwrap_or_else(|e| e.into_inner());
                    let items: Vec<&QueuedEvent> = buf
                        .iter()
                        .filter(|e| e.seq > since)
                        .take(MAX_EVENTS_PER_POLL)
                        .collect();
                    if !items.is_empty() {
                        return respond(
                            req,
                            200,
                            serde_json::json!({"events": items, "since": items.last().map(|e| e.seq)}),
                        );
                    }
                }
                if shared.stop.load(Ordering::Relaxed) {
                    return respond(req, 503, serde_json::json!({"error": "ponte encerrada"}));
                }
                if Instant::now() >= deadline {
                    return respond(req, 200, serde_json::json!({"events": [], "since": null}));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
        }
        (Method::Get, "/v1/limits") => {
            let cfg = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| b.config)
                .unwrap_or_default();
            let parsed = distorrent_core::bots::parse_config(&cfg).unwrap_or_default();
            let prims: Vec<serde_json::Value> = parsed
                .primitives
                .iter()
                .into_iter()
                .map(|(id, on, implemented)| {
                    serde_json::json!({"id": id, "enabled": on, "implemented": implemented})
                })
                .collect();
            respond(
                req,
                200,
                serde_json::json!({
                    "api": "distorrent-bot/1",
                    "mode": parsed.mode.as_str(),
                    "runtime": parsed.runtime.as_str(),
                    "limits": {
                        "requestsPerMinute": RATE_PER_MIN,
                        "eventsPerPoll": MAX_EVENTS_PER_POLL,
                        "maxBodyBytes": MAX_BODY,
                        "maxMessageChars": MAX_POST_CHARS,
                        "maxRepliesPerMinute": parsed.max_replies_per_min,
                        "maxHttpPerMinute": parsed.max_http_per_min,
                        "maxMessagesPerExecution": parsed.max_messages_per_exec,
                        "retentionHours": parsed.retention_hours,
                    },
                    "primitives": prims,
                }),
            );
        }
        (Method::Get, "/v1/health") => {
            let pending = shared.events.lock().map(|q| q.len()).unwrap_or(0);
            let online = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| b.online)
                .unwrap_or(false);
            respond(
                req,
                200,
                serde_json::json!({
                    "ok": !shared.stop.load(Ordering::Relaxed),
                    "online": online,
                    "events_pending": pending,
                    "dropped": shared.dropped.load(Ordering::Relaxed),
                    "requests": shared.requests.load(Ordering::Relaxed),
                }),
            );
        }
        (Method::Get, "/v1/config") => {
            let cfg = engine
                .store
                .bots_list(&shared.community_id)
                .ok()
                .and_then(|bs| bs.into_iter().find(|b| b.id == shared.bot_id))
                .map(|b| b.config)
                .unwrap_or_default();
            let parsed = distorrent_core::bots::parse_config(&cfg).unwrap_or_default();
            respond(
                req,
                200,
                serde_json::json!({
                    "prefix": parsed.prefix,
                    "commands": parsed.commands.iter().map(|c| serde_json::json!({
                        "name": c.name,
                        "aliases": c.aliases,
                        "exec": c.exec.as_str(),
                        "permission": c.need.as_str(),
                    })).collect::<Vec<_>>(),
                    "events": parsed.events,
                    "channels": parsed.channels,
                }),
            );
        }
        (Method::Post, "/v1/commands") => {
            let body: ConfigBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            match engine.bot_replace_config(&shared.community_id, &shared.bot_id, &body.config) {
                Ok(n) => {
                    let _ = engine.store.bot_log(
                        &shared.community_id,
                        &shared.bot_id,
                        "info",
                        &format!("o bot atualizou a própria config ({n} comando(s))"),
                    );
                    respond(req, 200, serde_json::json!({"ok": true, "commands": n}))
                }
                Err(e) => respond(req, 400, serde_json::json!({"error": e.to_string()})),
            }
        }
        (Method::Post, "/v1/message") => {
            let body: MessageBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            let text = body.body.trim();
            if text.is_empty() {
                return respond(req, 400, serde_json::json!({"error": "mensagem vazia"}));
            }
            if text.chars().count() > MAX_POST_CHARS {
                return respond(
                    req,
                    400,
                    serde_json::json!({"error": format!("mensagem acima de {MAX_POST_CHARS} caracteres")}),
                );
            }
            // O texto do bot passa pela mesma limpeza de qualquer mensagem.
            let clean = distorrent_core::names::sanitize_text(text, MAX_POST_CHARS);
            if clean.is_empty() {
                return respond(req, 400, serde_json::json!({"error": "mensagem vazia"}));
            }
            let channel = match engine.resolve_channel(&shared.community_id, &body.channel) {
                Some(c) => c,
                None => {
                    return respond_idem(
                        req,
                        shared,
                        idem_key.as_ref(),
                        404,
                        serde_json::json!({"error": format!("canal `{}` não existe", body.channel)}),
                    )
                }
            };
            match engine.bot_post_message(&shared.community_id, &channel, &shared.bot_id, &clean) {
                Ok(m) => respond_idem(
                    req,
                    shared,
                    idem_key.as_ref(),
                    200,
                    serde_json::json!({"ok": true, "message_id": m.id, "channel": channel}),
                ),
                Err(e) => respond_idem(
                    req,
                    shared,
                    idem_key.as_ref(),
                    409,
                    serde_json::json!({"error": e.to_string()}),
                ),
            }
        }
        (Method::Post, "/v1/admin") => {
            let body: AdminBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            match engine.bot_action_in(
                &shared.community_id,
                &shared.bot_id,
                body.action.trim(),
                &body.target,
                &body.reason,
                body.number,
                body.channel.as_deref(),
            ) {
                Ok(text) => {
                    let _ =
                        engine
                            .store
                            .bot_log(&shared.community_id, &shared.bot_id, "info", &text);
                    respond_idem(
                        req,
                        shared,
                        idem_key.as_ref(),
                        200,
                        serde_json::json!({"ok": true, "result": text}),
                    )
                }
                Err(e) => respond_idem(
                    req,
                    shared,
                    idem_key.as_ref(),
                    403,
                    serde_json::json!({"error": e.to_string()}),
                ),
            }
        }
        (Method::Post, "/v1/audio/open") => {
            let key = format!("{}|{}", shared.community_id, shared.bot_id);
            let (abriu, _) = shared.music.open(&key);
            // O bot entra na call como PARTICIPANTE: o frontend lê este estado
            // e cria a track própria. O app não sabe que é música — aceita
            // qualquer áudio de participante.
            crate::botmusic::marcar_pedido_de_call(&shared.community_id, &shared.bot_id);
            respond(
                req,
                200,
                serde_json::json!({
                    "ok": true,
                    "opened": abriu,
                    "sample_rate": 48_000,
                    "channels": 1,
                    "joined_as": "participant",
                }),
            )
        }
        (Method::Post, "/v1/audio/frames") => {
            let body: AudioBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            use base64::Engine as _;
            let bytes = match base64::engine::general_purpose::STANDARD.decode(body.pcm.as_bytes())
            {
                Ok(b) => b,
                Err(e) => {
                    return respond(
                        req,
                        400,
                        serde_json::json!({"error": format!("base64 inválido: {e}")}),
                    )
                }
            };
            let key = format!("{}|{}", shared.community_id, shared.bot_id);
            match shared.music.push(&key, &bytes, body.gain.unwrap_or(1.0)) {
                Ok((acc, drop)) => respond(
                    req,
                    200,
                    serde_json::json!({
                        "ok": true,
                        "accepted": acc,
                        "dropped": drop,
                        // O áudio vira a track do participante na chamada.
                        "delivered": "participant",
                        "to_call": true,
                    }),
                ),
                Err(e) => respond(req, 409, serde_json::json!({"error": e})),
            }
        }
        (Method::Get, "/v1/audio/status") => {
            let key = format!("{}|{}", shared.community_id, shared.bot_id);
            let st = shared.music.status(&key);
            respond(
                req,
                200,
                match st {
                    Some((acc, drop)) => serde_json::json!({
                        "open": true,
                        "accepted": acc,
                        "dropped": drop,
                        "delivered": "participant",
                        "to_call": true,
                    }),
                    None => {
                        serde_json::json!({"open": false, "delivered": "participant", "to_call": true})
                    }
                },
            )
        }
        (Method::Post, "/v1/audio/stop") => {
            let key = format!("{}|{}", shared.community_id, shared.bot_id);
            let fechou = shared.music.close(&key);
            respond(req, 200, serde_json::json!({"ok": true, "closed": fechou}))
        }
        (Method::Post, "/v1/log") => {
            let body: LogBody = match read_json(&mut req) {
                Ok(b) => b,
                Err(e) => return respond(req, 400, serde_json::json!({"error": e})),
            };
            match engine.bot_log_append(
                &shared.community_id,
                &shared.bot_id,
                body.level.trim(),
                &body.message,
            ) {
                Ok(()) => respond(req, 200, serde_json::json!({"ok": true})),
                Err(e) => respond(req, 409, serde_json::json!({"error": e.to_string()})),
            }
        }
        (Method::Post, "/v1/stop") => {
            shared.stop.store(true, Ordering::SeqCst);
            respond(req, 200, serde_json::json!({"ok": true, "stopping": true}));
        }
        _ => respond(
            req,
            404,
            serde_json::json!({
                "error": "rota inexistente",
                "routes": ["GET /v1/info", "GET /v1/events?since=&wait=", "GET /v1/config",
                           "GET /v1/limits", "GET /v1/health",
                           "POST /v1/commands", "POST /v1/message", "POST /v1/admin",
                           "POST /v1/log", "POST /v1/stop"],
            }),
        ),
    }
}
