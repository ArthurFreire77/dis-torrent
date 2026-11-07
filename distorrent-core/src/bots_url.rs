// Validação de URL/allowlist de bot. Separado de bots.rs para nenhum arquivo passar de 1.000 linhas.

use super::*;

pub fn url_ok(url: &str) -> bool {
    let u = url.trim();
    if u.len() > 2048 {
        return false;
    }
    let lower = u.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return false;
    }
    // `http://` sozinho não tem host.
    let rest = &lower[if lower.starts_with("https://") { 8 } else { 7 }..];
    !rest.is_empty() && !rest.starts_with('/')
}

/// URL permitida para saída de bot. Barra sempre destinos de metadados de nuvem
/// e link-local; rede privada é opcional porque um bot de LAN é caso legítimo.
pub fn url_allowed(url: &str, block_private: bool) -> Result<(), String> {
    if !url_ok(url) {
        return Err("url precisa ser http:// ou https://".into());
    }
    let host = canonical_host(url).ok_or_else(|| "url sem host".to_string())?;
    if is_blocked_host(&host) {
        return Err(format!("destino bloqueado: {host}"));
    }
    if block_private && is_private_host(&host) {
        return Err(format!(
            "destino em rede privada bloqueado ({host}) — desligue \"bloquear rede local\" para permitir"
        ));
    }
    Ok(())
}

/// Host canônico da URL, já normalizado pelo parser do WHATWG.
///
/// Usa `url::Url` de propósito: `http://2130706433/`, `http://127.1/` e
/// `http://a@127.0.0.1/` têm host textual diferente de `127.0.0.1`, e o split
/// antigo em `:` liberava os três. O parser resolve todos para `127.0.0.1`
/// antes de qualquer comparação.
pub fn canonical_host(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url.trim()).ok()?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return None;
    }
    let host = match parsed.host()? {
        url::Host::Ipv4(ip) => ip.to_string(),
        url::Host::Ipv6(ip) => ip.to_string(),
        url::Host::Domain(d) => d.trim_end_matches('.').to_ascii_lowercase(),
    };
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

pub(crate) fn is_ipv4(host: &str) -> Option<[u8; 4]> {
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut out = [0u8; 4];
    for (i, p) in parts.iter().enumerate() {
        if p.is_empty() || p.len() > 3 || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        out[i] = p.parse::<u8>().ok()?;
    }
    Some(out)
}

/// Metadados de nuvem e link-local: nunca são destino de bot, nem por opt-in.
pub fn is_blocked_host(host: &str) -> bool {
    if host == "metadata.google.internal" || host == "metadata" {
        return true;
    }
    matches!(is_ipv4(host), Some([169, 254, _, _]) | Some([0, 0, 0, 0])) || host == "::"
}

/// Host está na allowlist declarada? Lista vazia = qualquer destino público.
pub fn host_allowed(url: &str, allow: &[String]) -> bool {
    if allow.is_empty() {
        return true;
    }
    let Some(host) = canonical_host(url) else {
        return false;
    };
    allow.iter().any(|rule| {
        let rule = rule.trim().trim_start_matches("*.").to_ascii_lowercase();
        host == rule || host.ends_with(&format!(".{rule}"))
    })
}

pub fn is_private_host(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if let Some(ip) = is_ipv4(host) {
        return match ip {
            [0, ..] | [10, ..] | [127, ..] | [255, 255, 255, 255] => true,
            [100, b, ..] if (64..=127).contains(&b) => true,
            [172, b, ..] if (16..=31).contains(&b) => true,
            [192, 168, ..] | [198, 18, ..] | [198, 19, ..] => true,
            [169, 254, ..] => true,
            // Faixa de documentação/teste (RFC 5737) também não é destino real.
            [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _] => true,
            _ => false,
        };
    }
    let h = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    if h == "::1" || h == "::" || h.starts_with("fc") || h.starts_with("fd") {
        return true;
    }
    if let Some(rest) = h.strip_prefix("fe80") {
        let _ = rest;
        return true;
    }
    if let Some(v4) = h.strip_prefix("::ffff:") {
        return is_private_host(v4);
    }
    false
}
