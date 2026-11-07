//! Modelo executável dos bots: config, permissões, guarda de URL, DSL e logs.
//!
//! Tudo aqui é puro (sem rede, sem banco) para poder ser testado sem motor.
//! O host (src-tauri) injeta HTTP e variáveis persistentes através de `BotHost`.

use std::collections::BTreeMap;

#[path = "bots_script.rs"]
mod bots_script;

#[path = "bots_render.rs"]
mod bots_render;

#[path = "bots_url.rs"]
mod bots_url;

#[path = "bots_parse.rs"]
mod bots_parse;

pub use bots_parse::parse_command;
pub(crate) use bots_parse::{b, parse_args, parse_headers, parse_list};
pub(crate) use bots_render::{json_path, normalize, render, render_key, url_encode, RenderCtx};
pub(crate) use bots_script::{
    eval_cond, parse_cond, parse_line, parse_script, push_reply, run_script, strip_quotes, truthy,
    Cond, Stmt,
};
pub(crate) use bots_url::{canonical_host, is_blocked_host, is_ipv4};
pub use bots_url::{host_allowed, is_private_host, url_allowed, url_ok};

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
    cfg.commands.retain(|c| match c.exec {
        Exec::Reply => cfg.primitives.text || cfg.primitives.ephemeral,
        Exec::Http => cfg.primitives.http,
        _ => true,
    });
    Ok(cfg)
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
        None => true,
    }
}

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

#[cfg(test)]
mod tests {
    use super::bots_parse::{b, parse_command, parse_list};
    use super::bots_render::{normalize, render, RenderCtx};
    use super::bots_script::{parse_script, run_script};
    use super::bots_url::{host_allowed, url_allowed, url_ok};
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
