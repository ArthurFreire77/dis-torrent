// Renderização de mensagem de bot. Separado de bots.rs para nenhum arquivo passar de 1.000 linhas.

use super::*;

pub struct RenderCtx<'a> {
    pub args: &'a [String],
    pub value: Option<&'a str>,
    pub json: Option<&'a serde_json::Value>,
    pub raw_body: &'a str,
    pub vars: &'a BTreeMap<String, String>,
}

pub fn render(tpl: &str, ctx: &RenderCtx<'_>) -> String {
    let mut out = String::with_capacity(tpl.len());
    let bytes = tpl.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'{' && i + 1 < bytes.len() && bytes[i + 1] == b'{' {
            if let Some(end) = tpl[i + 2..].find("}}") {
                let key = tpl[i + 2..i + 2 + end].trim();
                out.push_str(&render_key(key, ctx));
                i = i + 2 + end + 2;
                continue;
            }
        }
        let ch = tpl[i..].chars().next().unwrap_or(' ');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

pub(crate) fn render_key(key: &str, ctx: &RenderCtx<'_>) -> String {
    match key {
        "args" => ctx
            .args
            .iter()
            .map(|a| url_encode(a))
            .collect::<Vec<_>>()
            .join("/"),
        "query" => ctx
            .args
            .iter()
            .map(|a| url_encode(a))
            .collect::<Vec<_>>()
            .join("+"),
        "raw.args" => ctx.args.join(" "),
        // Args escapados para colar dentro de um literal JSON de corpo POST.
        "jsonargs" => json_encode(&ctx.args.join(" ")),
        "value" => ctx.value.unwrap_or("").to_string(),
        "json" => {
            if let Some(j) = ctx.json {
                j.to_string()
            } else {
                ctx.raw_body.to_string()
            }
        }
        _ => {
            if let Some(rest) = key.strip_prefix("arg") {
                if let Ok(i) = rest.parse::<usize>() {
                    return url_encode(&ctx.args.get(i).cloned().unwrap_or_default());
                }
            }
            if let Some(name) = key.strip_prefix("var.") {
                return ctx.vars.get(name).cloned().unwrap_or_default();
            }
            if let Some(path) = key.strip_prefix("json.") {
                return ctx
                    .json
                    .and_then(|j| json_path(j, path))
                    .unwrap_or_default();
            }
            let mut parts = key.splitn(2, '.');
            let head = parts.next().unwrap_or("");
            let tail = parts.next().unwrap_or("");
            if let Some(v) = ctx.vars.get(head) {
                if tail.is_empty() {
                    return v.clone();
                }
                if let Ok(j) = serde_json::from_str::<serde_json::Value>(v) {
                    return json_path(&j, tail).unwrap_or_default();
                }
            }
            String::new()
        }
    }
}

/// Config normalizada para gravar: só o que o parser entende.
pub fn normalize(cfg: &BotConfig) -> serde_json::Value {
    let mut out = serde_json::json!({
        "schema": 3,
        "mode": cfg.mode.as_str(),
        "runtime": cfg.runtime.as_str(),
        "prefix": cfg.prefix,
        "channels": cfg.channels,
        "channelKinds": cfg.channel_kinds,
        "events": cfg.events,
        "blockPrivate": cfg.block_private,
        "maxRepliesPerMinute": cfg.max_replies_per_min,
    });
    let mut prim = serde_json::Map::new();
    for (name, on, _) in cfg.primitives.iter() {
        prim.insert(name.to_string(), serde_json::json!(on));
    }
    out["primitives"] = serde_json::Value::Object(prim);
    out["commands"] = serde_json::json!(cfg
        .commands
        .iter()
        .map(|c| {
            let mut o = serde_json::json!({
                "name": c.name,
                "method": c.method,
                "exec": c.exec.as_str(),
                "cooldownMs": c.cooldown_ms,
                "enabled": c.enabled,
            });
            if !c.aliases.is_empty() {
                o["aliases"] = serde_json::json!(c.aliases);
            }
            if !c.description.is_empty() {
                o["description"] = serde_json::json!(c.description);
            }
            if !c.need.as_str().is_empty() {
                o["permission"] = serde_json::json!(c.need.as_str());
            }
            if let Some(t) = c.timeout_ms {
                o["timeoutMs"] = serde_json::json!(t);
            }
            if c.ephemeral {
                o["ephemeral"] = serde_json::json!(true);
            }
            if c.autocomplete {
                o["autocomplete"] = serde_json::json!(true);
            }
            if !c.url.is_empty() {
                o["url"] = serde_json::json!(c.url);
            }
            if !c.headers.is_empty() {
                o["headers"] = serde_json::json!(c.headers);
            }
            if let Some(b) = &c.body {
                o["body"] = serde_json::json!(b);
            }
            if let Some(p) = &c.response_path {
                o["responsePath"] = serde_json::json!(p);
            }
            if let Some(t) = &c.template {
                o["template"] = serde_json::json!(t);
            }
            if let Some(r) = &c.reply {
                o["reply"] = serde_json::json!(r);
            }
            if let Some(s) = &c.script {
                o["script"] = serde_json::json!(s);
            }
            if let Some(a) = &c.admin {
                o["admin"] = serde_json::json!(a);
            }
            if let Some(m) = &c.music {
                o["music"] = serde_json::json!(m);
            }
            if let Some(s) = &c.sfx {
                o["sfx"] = serde_json::json!(s);
            }
            if !c.args.is_empty() {
                o["args"] = serde_json::json!(c
                    .args
                    .iter()
                    .map(|a| serde_json::json!({
                        "name": a.name, "required": a.required, "rest": a.rest,
                    }))
                    .collect::<Vec<_>>());
            }
            o
        })
        .collect::<Vec<_>>());
    if let Some(w) = &cfg.webhook {
        out["webhook"] = serde_json::json!({ "url": w });
    }
    let mut integ = serde_json::json!({
        "http": {
            "allowDomains": cfg.http_allow,
            "maxCallsPerMinute": cfg.max_http_per_min,
        },
        "limits": { "maxMessagesPerExecution": cfg.max_messages_per_exec },
        "retention": { "hours": cfg.retention_hours },
    });
    if cfg.webhook_secret.as_deref().map(str::is_empty) == Some(false) {
        integ["webhook"] = serde_json::json!({ "signed": true });
    }
    out["integrations"] = integ;
    out
}

pub fn json_path(root: &serde_json::Value, path: &str) -> Option<String> {
    if path.trim().is_empty() {
        return None;
    }
    let norm = path.replace('[', ".").replace(']', "");
    let mut cur = root;
    for part in norm.split('.').filter(|p| !p.is_empty()) {
        cur = match cur {
            serde_json::Value::Array(arr) => arr.get(part.parse::<usize>().ok()?)?,
            serde_json::Value::Object(map) => map.get(part)?,
            _ => return None,
        };
    }
    Some(match cur {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => return None,
        other => other.to_string(),
    })
}

pub(crate) fn url_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Escapa uma string para caber DENTRO de um literal JSON (sem aspas externas).
pub(crate) fn json_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            other if (other as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", other as u32)),
            other => out.push(other),
        }
    }
    out
}
