//! Modelo executável dos bots: config, permissões, guarda de URL, DSL e logs.
//!
//! Tudo aqui é puro (sem rede, sem banco) para poder ser testado sem motor.
//! O host (src-tauri) injeta HTTP e variáveis persistentes através de `BotHost`.

use std::collections::BTreeMap;

use unicode_normalization::UnicodeNormalization;

pub const BOT_CONFIG_MAX: usize = 64 * 1024;
pub const BOT_MAX_COMMANDS: usize = 48;
pub const BOT_MAX_ALIASES: usize = 4;
pub const BOT_MAX_ARGS: usize = 8;
pub const BOT_MAX_SCRIPT_LINES: usize = 200;
pub const BOT_MAX_REPLY: usize = 1900;
pub const BOT_MAX_RESPONSE: usize = 256 * 1024;
pub const DEFAULT_COOLDOWN_MS: i64 = 1_500;
pub const MIN_COOLDOWN_MS: i64 = 0;
pub const MAX_COOLDOWN_MS: i64 = 24 * 60 * 60 * 1000;

/// Permissões que um comando pode exigir do AUTOR (nunca maior que a do bot).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    None,
    Moderate,
    Manage,
    Owner,
}

impl Need {
    pub fn parse(raw: &str) -> Need {
        match raw.trim().to_ascii_lowercase().as_str() {
            "moderate" | "moderator" => Need::Moderate,
            "manage" | "manager" => Need::Manage,
            "owner" | "admin" | "administrator" => Need::Owner,
            _ => Need::None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Need::None => "",
            Need::Moderate => "moderate",
            Need::Manage => "manage",
            Need::Owner => "owner",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Exec {
    /// Chamada HTTP + template (formato antigo, continua válido).
    Http,
    /// Resposta fixa com placeholders.
    Reply,
    /// DSL linha a linha (`script`).
    Script,
    /// Ação administrativa nativa (`admin`).
    Admin,
}

impl Exec {
    pub fn as_str(self) -> &'static str {
        match self {
            Exec::Http => "http",
            Exec::Reply => "reply",
            Exec::Script => "script",
            Exec::Admin => "admin",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BotArg {
    pub name: String,
    pub required: bool,
    pub rest: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BotCommand {
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub exec: Exec,
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
    pub response_path: Option<String>,
    pub template: Option<String>,
    pub reply: Option<String>,
    pub script: Option<String>,
    pub admin: Option<String>,
    pub need: Need,
    pub cooldown_ms: i64,
    pub ephemeral: bool,
    pub enabled: bool,
    pub autocomplete: bool,
    pub args: Vec<BotArg>,
}

impl BotCommand {
    fn defaults(name: String) -> BotCommand {
        BotCommand {
            name,
            aliases: Vec::new(),
            description: String::new(),
            exec: Exec::Reply,
            method: "GET".into(),
            url: String::new(),
            headers: BTreeMap::new(),
            body: None,
            response_path: None,
            template: None,
            reply: None,
            script: None,
            admin: None,
            need: Need::None,
            cooldown_ms: DEFAULT_COOLDOWN_MS,
            ephemeral: false,
            enabled: true,
            autocomplete: false,
            args: Vec::new(),
        }
    }

    /// Todos os nomes que disparam o comando (nome + aliases), sem duplicata.
    pub fn triggers(&self) -> Vec<String> {
        let mut out = vec![self.name.clone()];
        for a in &self.aliases {
            if !out.contains(a) {
                out.push(a.clone());
            }
        }
        out
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct BotConfig {
    /// Versão do schema. 1/2 = config antiga (migrada na leitura), 3 = atual.
    pub schema: u32,
    /// Onde a lógica roda. Explícito, nunca inferido do que foi preenchido.
    pub mode: Mode,
    /// Como o código roda dentro do modo `plugin`.
    pub runtime: Runtime,
    /// O que este bot pode entregar. Desligar aqui nega a rota/ação.
    pub primitives: Primitives,
    pub prefix: String,
    pub commands: Vec<BotCommand>,
    pub channels: Vec<String>,
    /// Tipos de canal onde o bot age (text/voice/video/forum). Vazio = todos.
    pub channel_kinds: Vec<String>,
    pub webhook: Option<String>,
    pub events: Vec<String>,
    /// Bloqueia destinos em rede privada (RFC1918/loopback). Padrão: ligado.
    pub block_private: bool,
    pub max_replies_per_min: u32,
    /// Domínios que o bot pode chamar. Vazio = qualquer http(s) público.
    pub http_allow: Vec<String>,
    pub max_http_per_min: u32,
    /// Segredo do HMAC do webhook de saída. Nunca vai no corpo nem no log.
    pub webhook_secret: Option<String>,
    pub max_messages_per_exec: u32,
    /// Retenção do console/replay em horas. 0 = não guarda.
    pub retention_hours: u32,
}

/// Modo de execução declarado pelo criador.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Mode {
    /// Só config: resposta fixa, HTTP, DSL e ação administrativa.
    #[default]
    Declarative,
    /// Código do criador no PC do dono, pela ponte local.
    Plugin,
    /// Serviço externo do criador, por webhook assinado.
    Service,
    /// Criador conecta de fora por TLS. Desligado por padrão e avisado.
    Remote,
}

impl Mode {
    pub fn parse(raw: &str) -> Option<Mode> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "declarative" | "declarativo" => Some(Mode::Declarative),
            "plugin" | "local" => Some(Mode::Plugin),
            "service" | "servico" | "serviço" | "webhook" => Some(Mode::Service),
            "remote" | "remoto" => Some(Mode::Remote),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Declarative => "declarative",
            Mode::Plugin => "plugin",
            Mode::Service => "service",
            Mode::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Runtime {
    /// Sem processo: só a DSL embutida.
    #[default]
    None,
    /// Processo filho do criador (Node/Python/etc.).
    Process,
    /// Módulo WASM. Não implementado: declarar isto é recusado na leitura.
    Wasm,
}

impl Runtime {
    pub fn parse(raw: &str) -> Option<Runtime> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "" | "none" | "nenhum" => Some(Runtime::None),
            "process" | "processo" | "node" => Some(Runtime::Process),
            "wasm" => Some(Runtime::Wasm),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Runtime::None => "none",
            Runtime::Process => "process",
            Runtime::Wasm => "wasm",
        }
    }
}

/// Primitivas de saída. Só as implementadas mudam comportamento; as demais são
/// lidas, devolvidas em `/v1/limits` como `implemented:false` e nunca fingem
/// funcionar (§13 da doc: "não existe" é resposta).
#[derive(Debug, Clone, PartialEq)]
pub struct Primitives {
    pub text: bool,
    pub ephemeral: bool,
    pub dm: bool,
    pub embed: bool,
    pub component: bool,
    pub attachment: bool,
    pub reaction: bool,
    pub pin: bool,
    pub thread: bool,
    pub poll: bool,
    pub edit: bool,
    pub audio_frame: bool,
    pub video_frame: bool,
    pub screen_frame: bool,
    pub http: bool,
    pub blob: bool,
    pub kv: bool,
    pub job: bool,
    pub template: bool,
    pub invoke_bot: bool,
}

impl Default for Primitives {
    fn default() -> Self {
        // Ligado = o que o bot já fazia antes do v3, para nenhum bot existente
        // perder capacidade com a migração. O que ainda não existe nasce
        // desligado em vez de prometer rota que não há.
        Primitives {
            text: true,
            ephemeral: true,
            dm: false,
            embed: false,
            component: false,
            attachment: false,
            reaction: true,
            pin: true,
            thread: true,
            poll: true,
            edit: true,
            audio_frame: false,
            video_frame: false,
            screen_frame: false,
            http: true,
            blob: false,
            kv: true,
            job: false,
            template: true,
            invoke_bot: false,
        }
    }
}

impl Primitives {
    pub fn parse(v: Option<&serde_json::Value>) -> Primitives {
        let mut p = Primitives::default();
        let Some(serde_json::Value::Object(map)) = v else {
            return p;
        };
        macro_rules! set {
            ($($key:literal => $field:ident),* $(,)?) => {
                $(if let Some(x) = map.get($key) { p.$field = b(x); })*
            };
        }
        set!(
            "text" => text,
            "ephemeral" => ephemeral,
            "dm" => dm,
            "embed" => embed,
            "component" => component,
            "attachment" => attachment,
            "reaction" => reaction,
            "pin" => pin,
            "thread" => thread,
            "poll" => poll,
            "edit" => edit,
            "audioFrame" => audio_frame,
            "videoFrame" => video_frame,
            "screenFrame" => screen_frame,
            "http" => http,
            "blob" => blob,
            "kv" => kv,
            "job" => job,
            "template" => template,
            "invokeBot" => invoke_bot,
        );
        p
    }

    /// Nome canônico (`audioFrame`) e se a plataforma implementa de verdade.
    pub fn iter(&self) -> Vec<(&'static str, bool, bool)> {
        vec![
            ("text", self.text, true),
            ("ephemeral", self.ephemeral, true),
            ("dm", self.dm, false),
            ("embed", self.embed, false),
            ("component", self.component, false),
            ("attachment", self.attachment, false),
            ("reaction", self.reaction, true),
            ("pin", self.pin, true),
            ("thread", self.thread, true),
            ("poll", self.poll, true),
            ("edit", self.edit, false),
            ("audioFrame", self.audio_frame, false),
            ("videoFrame", self.video_frame, false),
            ("screenFrame", self.screen_frame, false),
            ("http", self.http, true),
            ("blob", self.blob, false),
            ("kv", self.kv, true),
            ("job", self.job, false),
            ("template", self.template, true),
            ("invokeBot", self.invoke_bot, false),
        ]
    }

    pub fn allows(&self, id: &str) -> bool {
        self.iter()
            .into_iter()
            .find(|(name, _, _)| *name == id)
            .map(|(_, on, implemented)| on && implemented)
            .unwrap_or(false)
    }
}

pub fn normalize_command_name(raw: &str) -> String {
    // NFD + remoção de diacríticos: `/tópico` e `/topico` precisam ser o mesmo
    // comando, e descartar a letra (como antes) virava `tpico`.
    let lower = raw.trim().to_lowercase();
    let base: String = lower.nfc().collect();
    let mut out = String::new();
    for c in base.chars() {
        let mapped = match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            other => other,
        };
        if mapped.is_whitespace() {
            out.push('-');
        } else if mapped.is_ascii_alphanumeric() || mapped == '-' || mapped == '_' {
            out.push(mapped);
        }
        if out.chars().count() >= 32 {
            break;
        }
    }
    out
}

/// Bytes aleatórios em hex, do gerador do próprio core (`rand`, já dependência).
pub fn random_secret(n_bytes: usize) -> String {
    use rand::RngCore;
    let mut buf = vec![0u8; n_bytes.clamp(8, 64)];
    rand::thread_rng().fill_bytes(&mut buf);
    let mut out = String::with_capacity(buf.len() * 2);
    for b in buf {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn url_ok(url: &str) -> bool {
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

fn is_ipv4(host: &str) -> Option<[u8; 4]> {
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
    // 169.254.169.254 é o endpoint de metadados de nuvem; link-local inteiro e
    // 0.0.0.0 entram junto porque nunca são destino legítimo de um bot.
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
            // 0.0.0.0/8 ("este host"), loopback, link-local, CGNAT e
            // "broadcast limitado" não são destino de bot.
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
    // IPv6 loopback, unspecified, ULA (fc00::/7), link-local (fe80::/10) e
    // IPv4 mapeado (::ffff:127.0.0.1) — este último era o furo: o endereço
    // textual começa com `::ffff:` e escapava de todas as checagens IPv4.
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

fn parse_headers(v: Option<&serde_json::Value>) -> BTreeMap<String, String> {
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

fn parse_args(v: Option<&serde_json::Value>) -> Vec<BotArg> {
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

fn parse_command(v: &serde_json::Value) -> Option<BotCommand> {
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

fn b(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        serde_json::Value::String(s) => matches!(s.as_str(), "1" | "true" | "yes" | "on"),
        _ => false,
    }
}

fn parse_list(v: Option<&serde_json::Value>, max: usize, max_len: usize) -> Vec<String> {
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

/// Eventos que o runtime entrega a um bot. Lista fechada: o que não está aqui
/// não existe, e a doc não deve inventar.
pub const BOT_EVENTS: &[&str] = &[
    "message_new",
    "message_edited",
    "message_deleted",
    "mention",
    "reaction",
    "member_joined",
    "member_left",
    "channel_created",
    "channel_deleted",
    "call_started",
    "call_ended",
    "voice_joined",
    "voice_left",
];

pub fn parse_config(raw: &str) -> Result<BotConfig, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(BotConfig {
            schema: 3,
            prefix: "!".into(),
            block_private: true,
            max_replies_per_min: 20,
            max_http_per_min: 60,
            max_messages_per_exec: 20,
            retention_hours: 24,
            ..Default::default()
        });
    }
    if raw.len() > BOT_CONFIG_MAX {
        return Err(format!(
            "config de bot muito grande (máx {} KB)",
            BOT_CONFIG_MAX / 1024
        ));
    }
    let v: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("config de bot não é JSON válido: {e}"))?;
    if !v.is_object() {
        return Err("config de bot precisa ser um objeto JSON".into());
    }
    let prefix = match v.get("prefix").and_then(|x| x.as_str()) {
        Some(p) => {
            let p = p.trim();
            let chars: Vec<char> = p.chars().collect();
            if chars.len() != 1 || !"!/.$@#%-".contains(chars[0]) {
                return Err("prefixo precisa ser 1 caractere de ! / . $ @ # % -".into());
            }
            p.to_string()
        }
        None => "!".into(),
    };
    let commands: Vec<BotCommand> = match v.get("commands") {
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .take(BOT_MAX_COMMANDS)
            .filter_map(parse_command)
            .collect(),
        _ => Vec::new(),
    };
    let webhook = v
        .get("webhook")
        .and_then(|w| w.get("url").or(Some(w)))
        .and_then(|u| u.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| url_ok(s));
    let events: Vec<String> = parse_list(v.get("events"), BOT_EVENTS.len(), 32)
        .into_iter()
        .filter(|e| BOT_EVENTS.contains(&e.as_str()))
        .collect();
    // v1/v2 não tinham `schema`: a ausência é migração, não erro. O modo é
    // explícito a partir do v3 porque inferir `plugin` de um `run` presente
    // faria um bot antigo abrir processo sem o dono ter pedido.
    let schema = v
        .get("schema")
        .and_then(|x| x.as_u64())
        .map(|n| n as u32)
        .unwrap_or(if v.get("schema").is_some() { 3 } else { 2 });
    if !(1..=3).contains(&schema) {
        return Err(format!(
            "schema {schema} não é suportado (este app entende 1, 2 e 3)"
        ));
    }
    let mode = match v.get("mode").and_then(|x| x.as_str()) {
        Some(raw) => Mode::parse(raw).ok_or_else(|| {
            format!("modo desconhecido: `{raw}` (use declarative|plugin|service|remote)")
        })?,
        None => Mode::Declarative,
    };
    let runtime = match v.get("runtime").and_then(|x| x.as_str()) {
        Some(raw) => Runtime::parse(raw)
            .ok_or_else(|| format!("runtime desconhecido: `{raw}` (use none|process|wasm)"))?,
        None if mode == Mode::Plugin => Runtime::Process,
        None => Runtime::None,
    };
    if runtime == Runtime::Wasm {
        return Err(
            "runtime `wasm` ainda não existe nesta versão — use `process` (plugin) ou `declarative`"
                .into(),
        );
    }
    let prim = Primitives::parse(v.get("primitives"));
    let (http_allow, max_http_per_min, webhook_secret, max_messages, retention_hours) =
        parse_integrations(v.get("integrations"));
    let mut cfg = BotConfig {
        schema,
        mode,
        runtime,
        primitives: prim,
        prefix,
        commands,
        channels: parse_list(v.get("channels"), 256, 128),
        channel_kinds: parse_list(v.get("channelKinds"), 4, 16),
        webhook,
        events,
        block_private: v.get("blockPrivate").map(b).unwrap_or(true),
        max_replies_per_min: v
            .get("maxRepliesPerMinute")
            .and_then(|x| x.as_u64())
            .unwrap_or(20)
            .clamp(1, 120) as u32,
        http_allow,
        max_http_per_min,
        webhook_secret,
        max_messages_per_exec: max_messages,
        retention_hours,
    };
    // Primitiva desligada nega o comando que depende dela JÁ na leitura: se a
    // resposta é `text` e não há `text`, o comando não pode existir "meio vivo".
    cfg.commands.retain(|c| match c.exec {
        Exec::Reply => cfg.primitives.text || cfg.primitives.ephemeral,
        Exec::Http => cfg.primitives.http,
        _ => true,
    });
    Ok(cfg)
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
    // O segredo do webhook NÃO é serializado aqui de propósito: ele vive na
    // coluna `bots.webhook_secret`, porque este JSON é sincronizado para todos
    // os membros do servidor. Aqui só vai o marcador de que há assinatura.
    if cfg.webhook_secret.as_deref().map(str::is_empty) == Some(false) {
        integ["webhook"] = serde_json::json!({ "signed": true });
    }
    out["integrations"] = integ;
    out
}

fn parse_integrations(
    v: Option<&serde_json::Value>,
) -> (Vec<String>, u32, Option<String>, u32, u32) {
    let Some(integ) = v else {
        return (Vec::new(), 60, None, 20, 24);
    };
    let http = integ.get("http");
    let allow: Vec<String> = http
        .and_then(|h| h.get("allowDomains"))
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .take(256)
                .filter_map(|x| x.as_str())
                .map(|s| s.trim().to_ascii_lowercase())
                .filter(|s| !s.is_empty() && s.len() <= 253 && !s.contains('/'))
                .collect()
        })
        .unwrap_or_default();
    let per_min = http
        .and_then(|h| h.get("maxCallsPerMinute"))
        .and_then(|x| x.as_u64())
        .unwrap_or(60)
        .clamp(1, 600) as u32;
    let secret = integ
        .get("webhook")
        .and_then(|w| w.get("secret"))
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() >= 16 && s.len() <= 128);
    let max_messages = integ
        .get("limits")
        .and_then(|l| l.get("maxMessagesPerExecution"))
        .and_then(|x| x.as_u64())
        .unwrap_or(20)
        .clamp(1, 20) as u32;
    let retention = integ
        .get("retention")
        .and_then(|r| r.get("hours"))
        .and_then(|x| x.as_u64())
        .unwrap_or(24)
        .min(30 * 24) as u32;
    (allow, per_min, secret, max_messages, retention)
}

/// Texto depois do prefixo: `!clima sao paulo` → ("clima", ["sao","paulo"]).
pub fn parse_invocation(prefix: &str, body: &str) -> Option<(String, Vec<String>)> {
    let body = body.trim();
    let rest = body.strip_prefix(prefix)?;
    // `!!x` e `!` sozinho não são comando (evita tratar risada como chamada).
    if rest.starts_with(prefix.chars().next().unwrap_or('!')) {
        return None;
    }
    let mut parts = rest.split_whitespace();
    let name = normalize_command_name(parts.next()?);
    if name.is_empty() {
        return None;
    }
    let args: Vec<String> = parts.take(16).map(|s| s.to_string()).collect();
    Some((name, args))
}

pub fn find_command<'a>(cfg: &'a BotConfig, name: &str) -> Option<&'a BotCommand> {
    let name = normalize_command_name(name);
    cfg.commands
        .iter()
        .find(|c| c.enabled && c.triggers().iter().any(|t| *t == name))
}

pub fn channel_in_scope(cfg: &BotConfig, channel_id: &str) -> bool {
    cfg.channels.is_empty() || cfg.channels.iter().any(|c| c == channel_id)
}

/// Escopo por TIPO de canal. Vazio = todos os tipos.
pub fn kind_in_scope(cfg: &BotConfig, kind: Option<&str>) -> bool {
    if cfg.channel_kinds.is_empty() {
        return true;
    }
    match kind {
        Some(k) => cfg.channel_kinds.iter().any(|x| x == k),
        // Tipo desconhecido (evento sem canal) não é bloqueado: o escopo por
        // tipo é filtro de canal, não de evento global.
        None => true,
    }
}

// ---------------------------------------------------------------------------
// Template / JSON path (compatível com o formato antigo)
// ---------------------------------------------------------------------------

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

fn url_encode(s: &str) -> String {
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

fn render_key(key: &str, ctx: &RenderCtx<'_>) -> String {
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

// ---------------------------------------------------------------------------
// DSL de scripts
// ---------------------------------------------------------------------------

/// Ação administrativa do script. Deixa de ser um enum fechado: a validade é
/// conferida pelo registro único em [`crate::moderation::BOT_ACTIONS`], senão a
/// DSL aceitaria menos ações do que o painel e a ponte oferecem.
#[derive(Debug, Clone, PartialEq)]
pub struct AdminAction(pub String);

impl AdminAction {
    pub fn parse(raw: &str) -> Option<AdminAction> {
        let name = crate::moderation::bot_action(raw)?.action;
        Some(AdminAction(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AdminCall {
    pub action: AdminAction,
    pub target: String,
    pub reason: String,
    pub number: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HttpCall {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ScriptResult {
    pub messages: Vec<String>,
    pub admin: Vec<AdminCall>,
    pub http_calls: usize,
    pub stopped: bool,
}

/// O host executa o que o interpretador não pode: rede e persistência.
pub trait BotHost {
    fn http(&mut self, call: &HttpCall) -> Result<(u16, String), String>;
    fn var_get(&mut self, key: &str) -> Option<String>;
    fn var_set(&mut self, key: &str, value: &str);
}

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

fn parse_cond(raw: &str) -> Result<Cond, String> {
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

fn strip_quotes(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2 && t.starts_with('"') && t.ends_with('"') {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

fn parse_line(line: &str) -> Result<Stmt, String> {
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

fn truthy(v: &str) -> bool {
    let t = v.trim();
    !t.is_empty() && t != "0" && !t.eq_ignore_ascii_case("false")
}

fn eval_cond(cond: &Cond, ctx: &RenderCtx<'_>) -> bool {
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

fn push_reply(result: &mut ScriptResult, text: &str, ephemeral: bool) {
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

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeHost {
        replies: std::collections::HashMap<String, String>,
        vars: BTreeMap<String, String>,
        calls: Vec<HttpCall>,
    }

    impl BotHost for FakeHost {
        fn http(&mut self, call: &HttpCall) -> Result<(u16, String), String> {
            self.calls.push(call.clone());
            Ok((
                200,
                self.replies
                    .get(&call.url)
                    .cloned()
                    .unwrap_or_else(|| "{}".into()),
            ))
        }
        fn var_get(&mut self, key: &str) -> Option<String> {
            self.vars.get(key).cloned()
        }
        fn var_set(&mut self, key: &str, value: &str) {
            self.vars.insert(key.to_string(), value.to_string());
        }
    }

    fn host() -> FakeHost {
        FakeHost {
            replies: Default::default(),
            vars: Default::default(),
            calls: Vec::new(),
        }
    }

    #[test]
    fn config_antigo_continua_valido() {
        let cfg = parse_config(
            r#"{"prefix":"!","commands":[{"name":"clima","method":"GET","url":"https://api.x/y?q={{query}}","responsePath":"d.t","template":"{{value}}C"}],"channels":[],"webhook":{"url":"https://h/x"}}"#,
        )
        .unwrap();
        assert_eq!(cfg.prefix, "!");
        assert_eq!(cfg.commands.len(), 1);
        let c = &cfg.commands[0];
        assert_eq!(c.exec, Exec::Http);
        assert_eq!(c.cooldown_ms, DEFAULT_COOLDOWN_MS);
        assert_eq!(cfg.webhook.as_deref(), Some("https://h/x"));
        assert!(cfg.block_private, "padrão seguro bloqueia rede privada");
        assert_eq!(cfg.schema, 2, "config sem schema é v2, migrada na leitura");
        assert_eq!(cfg.mode, Mode::Declarative);
        assert_eq!(cfg.runtime, Runtime::None);
    }

    #[test]
    fn schema_v3_e_explicito_e_wasm_nao_e_aceito() {
        let cfg = parse_config(r#"{"schema":3,"mode":"plugin","prefix":"!"}"#).unwrap();
        assert_eq!(cfg.schema, 3);
        assert_eq!(cfg.mode, Mode::Plugin);
        assert_eq!(
            cfg.runtime,
            Runtime::Process,
            "plugin sem runtime é processo"
        );
        assert!(parse_config(r#"{"schema":3,"runtime":"wasm"}"#).is_err());
        assert!(parse_config(r#"{"schema":4}"#).is_err());
        assert!(parse_config(r#"{"schema":3,"mode":"telepatia"}"#).is_err());
    }

    #[test]
    fn normalize_devolve_v3_e_nunca_serializa_o_segredo() {
        let cfg = parse_config(
            r#"{"schema":3,"integrations":{"webhook":{"secret":"segredo-bem-longo-123"}},"prefix":"!"}"#,
        )
        .unwrap();
        assert_eq!(cfg.webhook_secret.as_deref(), Some("segredo-bem-longo-123"));
        let out = normalize(&cfg).to_string();
        assert!(
            !out.contains("segredo-bem-longo-123"),
            "o segredo do webhook não pode voltar na config: {out}"
        );
        assert!(out.contains("\"schema\":3"));
        assert!(out.contains("\"signed\":true"));
    }

    #[test]
    fn primitiva_desligada_nega_o_comando_que_depende_dela() {
        let cfg = parse_config(
            r#"{"schema":3,"primitives":{"text":false,"ephemeral":false,"template":false},"commands":[{"name":"oi","exec":"reply","reply":"ola"}]}"#,
        )
        .unwrap();
        assert!(
            cfg.commands.is_empty(),
            "sem text/ephemeral a resposta fixa não existe"
        );
        assert!(!cfg.primitives.allows("embed"), "embed não é implementado");
        assert!(
            !cfg.primitives.allows("text"),
            "text foi desligado nesta config"
        );
        assert!(!cfg.primitives.allows("ephemeral"));
        assert!(cfg.primitives.allows("reaction"), "react segue ligado");
        let padrao = Primitives::default();
        assert!(padrao.allows("text"));
        assert!(!padrao.allows("audioFrame"), "mídia por bot não existe");
        assert!(!padrao.allows("blob"));
    }

    #[test]
    fn config_rejeita_prefixo_ruim_e_url_nao_http() {
        assert!(parse_config(r#"{"prefix":"ab"}"#).is_err());
        let cfg = parse_config(r#"{"commands":[{"name":"x","url":"ftp://x"}]}"#).unwrap();
        assert!(cfg.commands.is_empty());
    }

    #[test]
    fn admin_e_script_sao_inferidos() {
        let cfg = parse_config(
            r#"{"commands":[{"name":"ban","admin":"ban"},{"name":"oi","script":"reply \"oi\""}]}"#,
        )
        .unwrap();
        assert_eq!(cfg.commands[0].exec, Exec::Admin);
        assert_eq!(cfg.commands[1].exec, Exec::Script);
    }

    #[test]
    fn aliases_e_cooldown() {
        let cfg = parse_config(
            r#"{"commands":[{"name":"ajuda","aliases":["help","AJUDA"],"reply":"x","cooldownMs":5000}]}"#,
        )
        .unwrap();
        let c = find_command(&cfg, "help").unwrap();
        assert_eq!(c.name, "ajuda");
        assert_eq!(c.cooldown_ms, 5000);
        assert_eq!(c.triggers(), vec!["ajuda", "help"]);
    }

    #[test]
    fn invocation_respeita_prefixo() {
        assert_eq!(
            parse_invocation("!", "!clima sao paulo"),
            Some(("clima".into(), vec!["sao".into(), "paulo".into()]))
        );
        assert_eq!(parse_invocation("!", "oi !clima"), None);
        assert_eq!(parse_invocation("!", "!!risos"), None);
        assert_eq!(parse_invocation("!", "!"), None);
    }

    #[test]
    fn template_antigo_funciona() {
        let mut vars = BTreeMap::new();
        vars.insert("x".to_string(), "9".to_string());
        let ctx = RenderCtx {
            args: &["a b".to_string(), "c".to_string()],
            value: Some("25"),
            json: Some(&serde_json::json!({"data":{"t":"v"}})),
            raw_body: "{\"a\":1}",
            vars: &vars,
        };
        assert_eq!(render("{{arg0}}", &ctx), "a%20b");
        assert_eq!(render("{{query}}", &ctx), "a%20b+c");
        assert_eq!(render("{{raw.args}}", &ctx), "a b c");
        assert_eq!(render("{{value}}", &ctx), "25");
        assert_eq!(render("{{json.data.t}}", &ctx), "v");
        assert_eq!(render("{{var.x}}", &ctx), "9");
    }

    #[test]
    fn guarda_de_url_bloqueia_metadados_e_privado_com_flag() {
        assert!(url_allowed("https://api.exemplo.com/x", true).is_ok());
        assert!(url_allowed("http://169.254.169.254/latest/meta-data", false).is_err());
        assert!(url_allowed("http://192.168.0.10/x", true).is_err());
        assert!(url_allowed("http://192.168.0.10/x", false).is_ok());
        assert!(url_allowed("file:///etc/passwd", false).is_err());
        assert!(url_allowed("https://", false).is_err());
    }

    #[test]
    fn guarda_de_url_resolve_o_host_canonico() {
        // Os três primeiros passavam quando o host era comparado como texto.
        for u in [
            "http://2130706433/x",
            "http://127.1/x",
            "http://evil.com@127.0.0.1:8080/x",
            "http://0.0.0.0/x",
            "http://[::ffff:127.0.0.1]/x",
            "http://100.64.0.1/x",
            "http://198.18.0.1/x",
            "http://192.0.2.10/x",
        ] {
            assert!(
                url_allowed(u, true).is_err(),
                "deveria bloquear como destino privado: {u}"
            );
        }
        assert!(url_allowed("https://api.exemplo.com/x", true).is_ok());
        assert!(url_allowed("https://8.8.8.8/x", true).is_ok());
    }

    #[test]
    fn allowlist_de_dominio_aceita_subdominio_e_recusa_sufixo_solto() {
        let allow = vec!["exemplo.com".to_string()];
        assert!(host_allowed("https://api.exemplo.com/x", &allow));
        assert!(host_allowed("https://exemplo.com/x", &allow));
        assert!(!host_allowed("https://evil-exemplo.com/x", &allow));
        assert!(!host_allowed("https://outro.com/x", &allow));
        assert!(
            host_allowed("https://qualquer.com/x", &[]),
            "lista vazia = qualquer destino publico"
        );
    }

    #[test]
    fn script_faz_http_e_formata() {
        let mut h = host();
        h.replies.insert(
            "https://api.x/cep/123".into(),
            r#"{"logradouro":"Rua A","uf":"SP"}"#.into(),
        );
        let src = r#"
            http get "https://api.x/cep/{{args}}"' as cep
            reply "{{cep.logradouro}}/{{cep.uf}}"
        "#
        .replace('\'', "");
        let out = run_script(&src, &["123".to_string()], &mut h).unwrap();
        assert_eq!(out.messages, vec!["Rua A/SP"]);
        assert_eq!(out.http_calls, 1);
    }

    #[test]
    fn script_if_else_pula_bloco() {
        let mut h = host();
        let out = run_script(
            "if args is empty\nreply \"uso: oi nome\"\nelse\nreply \"ola {{raw.args}}\"\nend",
            &["ana".to_string()],
            &mut h,
        )
        .unwrap();
        assert_eq!(out.messages, vec!["ola ana"]);
    }

    #[test]
    fn script_variavel_persistente_incrementa() {
        let mut h = host();
        run_script("incvar pontos + 3\nreply \"{{pontos}}\"", &[], &mut h).unwrap();
        let out = run_script("incvar pontos + 2\nreply \"{{pontos}}\"", &[], &mut h).unwrap();
        assert_eq!(h.vars.get("pontos").map(String::as_str), Some("5"));
        assert_eq!(out.messages, vec!["5"]);
    }

    #[test]
    fn script_admin_emite_chamada() {
        let mut h = host();
        let out = run_script(
            "admin ban \"{{args}}\" motivo: spam",
            &["abc".into()],
            &mut h,
        )
        .expect("script válido");
        assert_eq!(out.admin.len(), 1);
        assert_eq!(out.admin[0].action.as_str(), "ban");
        assert_eq!(out.admin[0].target, "abc");
    }

    #[test]
    fn script_invalido_da_erro_com_linha() {
        let err = parse_script("reply \"x\"\nif a == b\nreply \"y\"").unwrap_err();
        assert!(err.contains("sem"), "{err}");
        assert!(parse_script("voar").is_err());
    }

    #[test]
    fn resposta_do_script_e_sanitizada_e_limitada() {
        let mut h = host();
        let out = run_script(&format!("reply \"{}\"", "x".repeat(3000)), &[], &mut h).unwrap();
        assert_eq!(out.messages[0].chars().count(), BOT_MAX_REPLY);
    }
}
