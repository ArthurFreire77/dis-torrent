// Parser de comando de bot. Separado de bots.rs para nenhum arquivo passar de 1.000 linhas.

use super::*;

pub fn parse_command(v: &serde_json::Value) -> Option<BotCommand> {
    let name = normalize_command_name(v.get("name")?.as_str()?);
    if name.is_empty() {
        return None;
    }
    let mut cmd = BotCommand::defaults(name);
    cmd.description = v
        .get("description")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .chars()
        .take(200)
        .collect();
    if let Some(serde_json::Value::Array(arr)) = v.get("aliases") {
        for a in arr.iter().take(BOT_MAX_ALIASES) {
            if let Some(s) = a.as_str() {
                let n = normalize_command_name(s);
                if !n.is_empty() && n != cmd.name && !cmd.aliases.contains(&n) {
                    cmd.aliases.push(n);
                }
            }
        }
    }
    cmd.method = if v
        .get("method")
        .and_then(|m| m.as_str())
        .map(|m| m.eq_ignore_ascii_case("POST"))
        .unwrap_or(false)
    {
        "POST".into()
    } else {
        "GET".into()
    };
    cmd.url = v
        .get("url")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(2048)
        .collect();
    cmd.headers = parse_headers(v.get("headers"));
    cmd.body = v
        .get("body")
        .and_then(|x| x.as_str())
        .map(|s| s.chars().take(8192).collect());
    cmd.response_path = v
        .get("responsePath")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() <= 128);
    cmd.template = v
        .get("template")
        .and_then(|x| x.as_str())
        .map(|s| s.chars().take(BOT_MAX_REPLY).collect());
    cmd.reply = v
        .get("reply")
        .and_then(|x| x.as_str())
        .map(|s| s.chars().take(BOT_MAX_REPLY).collect());
    cmd.script = v
        .get("script")
        .and_then(|x| x.as_str())
        .map(|s| s.chars().take(BOT_MAX_SCRIPT_LINES * 160).collect());
    cmd.admin = v
        .get("admin")
        .and_then(|x| x.as_str())
        .map(|s| normalize_command_name(s))
        .filter(|s| !s.is_empty());
    cmd.need = Need::parse(v.get("permission").and_then(|x| x.as_str()).unwrap_or(""));
    cmd.cooldown_ms = v
        .get("cooldownMs")
        .and_then(|x| x.as_i64())
        .unwrap_or(DEFAULT_COOLDOWN_MS)
        .clamp(MIN_COOLDOWN_MS, MAX_COOLDOWN_MS);
    cmd.ephemeral = v.get("ephemeral").map(b).unwrap_or(false);
    cmd.enabled = v.get("enabled").map(b).unwrap_or(true);
    cmd.autocomplete = v.get("autocomplete").map(b).unwrap_or(false);
    cmd.args = parse_args(v.get("args"));

    // Execução: o campo explícito manda; senão infere pelo que foi preenchido.
    cmd.exec = match v.get("exec").and_then(|x| x.as_str()) {
        Some("http") => Exec::Http,
        Some("reply") => Exec::Reply,
        Some("script") => Exec::Script,
        Some("admin") => Exec::Admin,
        _ if cmd.admin.is_some() => Exec::Admin,
        _ if cmd.script.is_some() => Exec::Script,
        _ if cmd.url.is_empty() && cmd.reply.is_some() => Exec::Reply,
        _ => Exec::Http,
    };

    match cmd.exec {
        Exec::Http if !url_ok(&cmd.url) => return None,
        Exec::Admin if cmd.admin.is_none() => return None,
        Exec::Script
            if cmd
                .script
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true) =>
        {
            return None
        }
        Exec::Reply
            if cmd
                .reply
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true) =>
        {
            return None
        }
        _ => {}
    }
    Some(cmd)
}

pub(crate) fn parse_args(v: Option<&serde_json::Value>) -> Vec<BotArg> {
    let Some(serde_json::Value::Array(items)) = v else {
        return Vec::new();
    };
    items
        .iter()
        .take(BOT_MAX_ARGS)
        .filter_map(|it| {
            let name = it.get("name")?.as_str()?;
            let name = normalize_command_name(name);
            if name.is_empty() {
                return None;
            }
            Some(BotArg {
                name,
                required: it
                    .get("required")
                    .and_then(|b| b.as_bool())
                    .unwrap_or(false),
                rest: it.get("rest").and_then(|b| b.as_bool()).unwrap_or(false),
            })
        })
        .collect()
}

pub(crate) fn parse_headers(v: Option<&serde_json::Value>) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(serde_json::Value::Object(map)) = v {
        for (k, val) in map.iter().take(16) {
            if let Some(s) = val.as_str() {
                let k = k.trim();
                if !k.is_empty() && k.len() <= 64 && s.len() <= 1024 {
                    out.insert(k.to_string(), s.to_string());
                }
            }
        }
    }
    out
}

pub(crate) fn b(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        serde_json::Value::String(s) => matches!(s.as_str(), "1" | "true" | "yes" | "on"),
        _ => false,
    }
}

pub(crate) fn parse_list(v: Option<&serde_json::Value>, max: usize, max_len: usize) -> Vec<String> {
    let Some(serde_json::Value::Array(items)) = v else {
        return Vec::new();
    };
    items
        .iter()
        .take(max)
        .filter_map(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.len() <= max_len)
        .collect()
}
