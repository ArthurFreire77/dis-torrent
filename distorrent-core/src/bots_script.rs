// Interpretador de script de bot. Separado de bots.rs para nenhum arquivo passar de 1.000 linhas.

use super::*;

#[derive(Debug, Clone, PartialEq)]
pub enum Cond {
    Eq(String, String),
    Ne(String, String),
    Gt(String, String),
    Lt(String, String),
    Ge(String, String),
    Le(String, String),
    Empty(String),
    NotEmpty(String),
    Contains(String, String),
    StartsWith(String, String),
    Truthy(String),
    Always(bool),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Stmt {
    Let(String, String),
    VarGet(String, String),
    VarSet(String, String),
    VarInc(String, String, String),
    Reply(String, bool),
    Http {
        method: String,
        url: String,
        body: Option<String>,
        into: String,
    },
    Admin(AdminCall),
    Stop,
    If(Cond),
    Else,
    End,
}

pub(crate) fn parse_cond(raw: &str) -> Result<Cond, String> {
    let s = raw.trim();
    let lower = s.to_ascii_lowercase();
    for (op, make) in [
        (" contains ", Cond::Contains as fn(String, String) -> Cond),
        (
            " startswith ",
            Cond::StartsWith as fn(String, String) -> Cond,
        ),
        (" == ", Cond::Eq as fn(String, String) -> Cond),
        (" != ", Cond::Ne as fn(String, String) -> Cond),
        (" >= ", Cond::Ge as fn(String, String) -> Cond),
        (" <= ", Cond::Le as fn(String, String) -> Cond),
        (" > ", Cond::Gt as fn(String, String) -> Cond),
        (" < ", Cond::Lt as fn(String, String) -> Cond),
    ] {
        if let Some(pos) = lower.find(op) {
            let left = s[..pos].trim().to_string();
            let right = s[pos + op.len()..].trim().to_string();
            if left.is_empty() || right.is_empty() {
                return Err(format!("condição incompleta: {s}"));
            }
            return Ok(make(strip_quotes(&left), strip_quotes(&right)));
        }
    }
    if let Some(left) = lower.strip_suffix(" is empty") {
        return Ok(Cond::Empty(s[..left.len()].trim().to_string()));
    }
    if let Some(left) = lower.strip_suffix(" is not empty") {
        return Ok(Cond::NotEmpty(s[..left.len()].trim().to_string()));
    }
    if let Some(rest) = lower.strip_prefix("empty ") {
        let _ = rest;
        return Ok(Cond::Empty(s[6..].trim().to_string()));
    }
    if lower == "true" {
        return Ok(Cond::Always(true));
    }
    if lower == "false" {
        return Ok(Cond::Always(false));
    }
    // Condição de uma palavra: falsa para vazio, "0" e "false".
    Ok(Cond::Truthy(s.to_string()))
}

pub(crate) fn strip_quotes(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

pub(crate) fn parse_line(line: &str) -> Result<Stmt, String> {
    let s = line.trim();
    let (kw, rest) = match s.split_once(char::is_whitespace) {
        Some((k, r)) => (k.to_ascii_lowercase(), r.trim()),
        None => (s.to_ascii_lowercase(), ""),
    };
    match kw.as_str() {
        "let" | "set" => {
            let (name, value) = rest
                .split_once('=')
                .ok_or_else(|| format!("esperado <nome> = <valor> em: {s}"))?;
            let name = normalize_command_name(name);
            if name.is_empty() {
                return Err("nome de variável inválido".into());
            }
            Ok(Stmt::Let(name, strip_quotes(value)))
        }
        "getvar" => {
            let (name, key) = rest
                .split_once('=')
                .ok_or_else(|| format!("esperado getvar <nome> = <chave> em: {s}"))?;
            Ok(Stmt::VarGet(
                normalize_command_name(name),
                strip_quotes(key),
            ))
        }
        "setvar" => {
            let (key, value) = rest
                .split_once('=')
                .ok_or_else(|| format!("esperado setvar <chave> = <valor> em: {s}"))?;
            Ok(Stmt::VarSet(strip_quotes(key), strip_quotes(value)))
        }
        "incvar" => {
            let (key, by) = match rest.split_once('+') {
                Some((k, v)) => (strip_quotes(k), v.trim().to_string()),
                None => (strip_quotes(rest), "1".to_string()),
            };
            Ok(Stmt::VarInc(key.clone(), key, by))
        }
        "reply" => Ok(Stmt::Reply(strip_quotes(rest), false)),
        "reply_ephemeral" | "ephemeral" => Ok(Stmt::Reply(strip_quotes(rest), true)),
        "stop" => Ok(Stmt::Stop),
        "if" => Ok(Stmt::If(parse_cond(rest)?)),
        "else" => Ok(Stmt::Else),
        "end" | "endif" => Ok(Stmt::End),
        "http" => {
            let mut it = rest.splitn(2, char::is_whitespace);
            let method = it.next().unwrap_or("").to_ascii_uppercase();
            if method != "GET" && method != "POST" {
                return Err(format!("http aceita GET ou POST (recebido {method})"));
            }
            let tail = it.next().unwrap_or("").trim();
            let (url_part, into) = match tail.rsplit_once(" as ") {
                Some((u, name)) => (u.trim(), normalize_command_name(name)),
                None => (tail, "res".to_string()),
            };
            let (url, body) = match url_part.find(" body ") {
                Some(pos) => (
                    strip_quotes(&url_part[..pos]),
                    Some(strip_quotes(&url_part[pos + 6..])),
                ),
                None => (strip_quotes(url_part), None),
            };
            if url.is_empty() {
                return Err("http sem url".into());
            }
            if into.is_empty() {
                return Err("http sem nome de destino".into());
            }
            Ok(Stmt::Http {
                method,
                url,
                body,
                into,
            })
        }
        "admin" => {
            let mut parts = rest.splitn(3, char::is_whitespace);
            let action = parts.next().unwrap_or("");
            let act = AdminAction::parse(action)
                .ok_or_else(|| format!("ação administrativa desconhecida: {action}"))?;
            let target = parts.next().unwrap_or("").to_string();
            let reason = parts.next().unwrap_or("").to_string();
            let number = target.parse::<i64>().ok();
            Ok(Stmt::Admin(AdminCall {
                action: act,
                target: target.trim_matches('"').to_string(),
                reason: strip_quotes(&reason),
                number,
            }))
        }
        "" | "#" => Ok(Stmt::Stop),
        other => Err(format!("instrução desconhecida: {other}")),
    }
}

pub fn parse_script(src: &str) -> Result<Vec<Stmt>, String> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    for (n, raw) in src.lines().enumerate() {
        if n >= BOT_MAX_SCRIPT_LINES {
            return Err(format!(
                "script longo demais (máx {BOT_MAX_SCRIPT_LINES} linhas)"
            ));
        }
        let line = raw.split(" # ").next().unwrap_or("").trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.starts_with("//") {
            continue;
        }
        let stmt = parse_line(line).map_err(|e| format!("linha {}: {e}", n + 1))?;
        match stmt {
            Stmt::If(_) => depth += 1,
            Stmt::End => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!("linha {}: `end` sem `if`", n + 1));
                }
            }
            _ => {}
        }
        out.push(stmt);
    }
    if depth != 0 {
        return Err("script tem `if` sem `end`".into());
    }
    Ok(out)
}

pub(crate) fn truthy(v: &str) -> bool {
    let t = v.trim();
    !t.is_empty() && t != "0" && !t.eq_ignore_ascii_case("false")
}

pub(crate) fn eval_cond(cond: &Cond, ctx: &RenderCtx<'_>) -> bool {
    let r = |s: &str| render(s, ctx);
    match cond {
        Cond::Always(b) => *b,
        Cond::Eq(a, b) => r(a) == r(b),
        Cond::Ne(a, b) => r(a) != r(b),
        Cond::Contains(a, b) => r(a).contains(&r(b)),
        Cond::StartsWith(a, b) => r(a).starts_with(&r(b)),
        Cond::Empty(a) => r(a).trim().is_empty(),
        Cond::NotEmpty(a) => !r(a).trim().is_empty(),
        Cond::Truthy(a) => truthy(&r(a)),
        Cond::Gt(a, b) | Cond::Lt(a, b) | Cond::Ge(a, b) | Cond::Le(a, b) => {
            let (x, y) = (r(a), r(b));
            match (x.parse::<f64>(), y.parse::<f64>()) {
                (Ok(x), Ok(y)) => match cond {
                    Cond::Gt(..) => x > y,
                    Cond::Lt(..) => x < y,
                    Cond::Ge(..) => x >= y,
                    _ => x <= y,
                },
                _ => match cond {
                    Cond::Gt(..) => x.as_str() > y.as_str(),
                    Cond::Lt(..) => x.as_str() < y.as_str(),
                    Cond::Ge(..) => x.as_str() >= y.as_str(),
                    _ => x.as_str() <= y.as_str(),
                },
            }
        }
    }
}

/// Executa o script. Blocos `if` viram saltos, sem recursão.
pub fn run_script(
    src: &str,
    base_args: &[String],
    host: &mut dyn BotHost,
) -> Result<ScriptResult, String> {
    let stmts = parse_script(src)?;
    let mut vars: BTreeMap<String, String> = BTreeMap::new();
    let mut result = ScriptResult::default();
    let mut args: Vec<String> = base_args.to_vec();
    let mut i = 0usize;
    let mut guard = 0usize;
    while i < stmts.len() {
        guard += 1;
        if guard > 4_000 {
            return Err("script excedeu o limite de execução".into());
        }
        let stmt = &stmts[i];
        match stmt {
            Stmt::If(cond) => {
                let take = {
                    // Contexto imutável só para avaliar a condição.
                    let ctx = RenderCtx {
                        args: &args,
                        value: None,
                        json: None,
                        raw_body: "",
                        vars: &vars,
                    };
                    eval_cond(cond, &ctx)
                };
                if take {
                    i += 1;
                    continue;
                }
                // Pula até `else` (executa) ou `end` (sai).
                let mut depth = 0i32;
                let mut j = i + 1;
                let mut target = None;
                while j < stmts.len() {
                    match &stmts[j] {
                        Stmt::If(_) => depth += 1,
                        Stmt::End => {
                            if depth == 0 {
                                target = Some(j);
                                break;
                            }
                            depth -= 1;
                        }
                        Stmt::Else if depth == 0 => {
                            target = Some(j);
                            break;
                        }
                        _ => {}
                    }
                    j += 1;
                }
                i = target.map(|j| j + 1).unwrap_or(stmts.len());
                continue;
            }
            Stmt::Else => {
                // Chegou aqui vindo do bloco verdadeiro: pula até o `end`.
                let mut depth = 0i32;
                let mut j = i + 1;
                let mut target = stmts.len();
                while j < stmts.len() {
                    match &stmts[j] {
                        Stmt::If(_) => depth += 1,
                        Stmt::End => {
                            if depth == 0 {
                                target = j;
                                break;
                            }
                            depth -= 1;
                        }
                        _ => {}
                    }
                    j += 1;
                }
                i = target + 1;
                continue;
            }
            Stmt::End => {
                i += 1;
                continue;
            }
            Stmt::Stop => {
                result.stopped = true;
                break;
            }
            _ => {}
        }

        let ctx = RenderCtx {
            args: &args,
            value: None,
            json: None,
            raw_body: "",
            vars: &vars,
        };
        match stmt {
            Stmt::Let(name, value) => {
                let v = render(value, &ctx);
                vars.insert(name.clone(), v);
            }
            Stmt::VarGet(name, key) => {
                let v = host.var_get(key).unwrap_or_default();
                vars.insert(name.clone(), v);
            }
            Stmt::VarSet(key, value) => {
                let v = render(value, &ctx);
                host.var_set(key, &v);
                vars.insert(key.rsplit(':').next().unwrap_or(key).to_string(), v);
            }
            Stmt::VarInc(key, name, by) => {
                let cur = host
                    .var_get(key)
                    .and_then(|v| v.parse::<i64>().ok())
                    .unwrap_or(0);
                let step = render(by, &ctx).parse::<i64>().unwrap_or(1);
                let next = cur.saturating_add(step);
                host.var_set(key, &next.to_string());
                vars.insert(name.clone(), next.to_string());
            }
            Stmt::Reply(tpl, ephemeral) => {
                let text = render(tpl, &ctx);
                push_reply(&mut result, &text, *ephemeral);
            }
            Stmt::Admin(call) => {
                let mut c = call.clone();
                c.target = render(&c.target, &ctx);
                c.reason = render(&c.reason, &ctx);
                c.number = c.number.or_else(|| c.target.parse::<i64>().ok());
                result.admin.push(c);
            }
            Stmt::Http {
                method,
                url,
                body,
                into,
            } => {
                let url = render(url, &ctx);
                let body = body.as_ref().map(|b| render(b, &ctx));
                let call = HttpCall {
                    method: method.clone(),
                    url,
                    headers: Vec::new(),
                    body,
                };
                let (status, text) = host.http(&call)?;
                result.http_calls += 1;
                let capped: String = text.chars().take(BOT_MAX_RESPONSE).collect();
                let json = serde_json::from_str::<serde_json::Value>(&capped).ok();
                vars.insert(format!("{into}.status"), status.to_string());
                vars.insert(into.clone(), capped.clone());
                if let Some(j) = &json {
                    vars.insert(format!("{into}.json"), j.to_string());
                    // `res.campo` funciona direto para JSON de objeto.
                    if let Some(obj) = j.as_object() {
                        for (k, v) in obj.iter().take(64) {
                            let flat = match v {
                                serde_json::Value::String(s) => s.clone(),
                                other => other.to_string(),
                            };
                            vars.insert(format!("{into}.{k}"), flat);
                        }
                    }
                }
                if status >= 400 {
                    let msg = format!(
                        "{} respondeu HTTP {status}",
                        call.url.chars().take(120).collect::<String>()
                    );
                    result.messages.push(msg);
                }
            }
            Stmt::If(_) | Stmt::Else | Stmt::End | Stmt::Stop => {}
        }
        i += 1;
    }
    // `args` pode ser reescrito por scripts futuros; mantém a variável viva.
    args.clear();
    Ok(result)
}

pub(crate) fn push_reply(result: &mut ScriptResult, text: &str, ephemeral: bool) {
    let clean = crate::names::sanitize_text(text, BOT_MAX_REPLY);
    if clean.is_empty() {
        return;
    }
    let out = if ephemeral {
        format!("-# {clean}")
    } else {
        clean
    };
    if result.messages.len() < 8 {
        result.messages.push(out);
    }
}
