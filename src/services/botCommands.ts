// BotCommands — parsing/rendering PURO para bots conectados à web.
// Um bot tem: prefixo (ex.: '!'), comandos (REST GET/POST com template),
// escopos (canais onde atua) e webhook de saída opcional.
// O runtime (src/services/botRuntime.ts) usa estas funções sobre eventos de
// mensagem reais; aqui é testável sem DOM/rede.

export interface BotCommandDef {
  /** palavra que dispara (sem o prefixo), ex.: 'clima'. */
  name: string
  method: 'GET' | 'POST'
  /** URL com {{args}} / {{arg0}} / {{query}} placeholders. */
  url: string
  headers?: Record<string, string>
  /** Corpo POST com placeholders (JSON string). */
  body?: string
  /** Caminho pontilhado no JSON de resposta: 'data.temp'. */
  responsePath?: string
  /** Template da resposta final com {{value}} / {{json.*}} / {{args}}. */
  template?: string
}

export interface BotWebhookDef {
  /** POST {author, nickname, channel, body, ts} a cada mensagem do escopo. */
  url: string
}

export interface BotConfig {
  prefix: string
  commands: BotCommandDef[]
  /** IDs de canais onde o bot atua — [] = todos os canais do servidor. */
  channels: string[]
  webhook?: BotWebhookDef
}

export const BOT_CONFIG_MAX_JSON = 16 * 1024

/** Parse+sanitize da config JSON vinda do painel/storage (hostil por padrão). */
export function parseBotConfig(raw: unknown): BotConfig | null {
  if (!raw) return null
  let obj: any
  if (typeof raw === 'string') {
    if (!raw.trim() || raw.length > BOT_CONFIG_MAX_JSON) return null
    try { obj = JSON.parse(raw) } catch { return null }
  } else if (typeof raw === 'object') {
    obj = raw
  } else {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const prefix = typeof obj.prefix === 'string' && obj.prefix.trim() ? obj.prefix.trim().slice(0, 4) : '!'
  if (!/^[!/.$@#%-]$/.test(prefix)) return null // 1 char, sem espaço
  const commands: BotCommandDef[] = Array.isArray(obj.commands) ? (obj.commands as unknown[]).slice(0, 16).map(parseCommand).filter((c): c is BotCommandDef => !!c) : []
  const channels: string[] = Array.isArray(obj.channels) ? obj.channels.filter((c: unknown) => typeof c === 'string' && c.length > 0 && c.length < 128).slice(0, 64) : []
  const webhook = typeof obj.webhook === 'object' && obj.webhook && typeof (obj.webhook as any).url === 'string' && (obj.webhook as any).url.trim()
    ? { url: (obj.webhook as any).url.trim().slice(0, 512) }
    : undefined
  return { prefix, commands, channels, webhook }
}

function parseCommand(c: any): BotCommandDef | null {
  if (!c || typeof c !== 'object') return null
  const name = typeof c.name === 'string' ? c.name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32) : ''
  const url = typeof c.url === 'string' ? c.url.trim().slice(0, 512) : ''
  if (!name || !/^https?:\/\//i.test(url)) return null
  const method = c.method === 'POST' ? 'POST' : 'GET'
  let headers: Record<string, string> | undefined
  if (c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)) {
    const h: Record<string, string> = {}
    for (const [k, v] of Object.entries(c.headers).slice(0, 16)) {
      if (typeof k === 'string' && typeof v === 'string' && k.length > 0 && k.length < 64) {
        h[k.slice(0, 64)] = v.slice(0, 512)
      }
    }
    if (Object.keys(h).length > 0) headers = h
  }
  return {
    name,
    method,
    url,
    headers,
    body: typeof c.body === 'string' ? c.body.slice(0, 2048) : undefined,
    responsePath: typeof c.responsePath === 'string' && c.responsePath.trim() ? c.responsePath.trim().slice(0, 128) : undefined,
    template: typeof c.template === 'string' ? c.template.slice(0, 512) : undefined,
  }
}

/**
 * Reconhece "`` !clima são paulo`` " → { name: 'clima', args: ['são','paulo'] }.
 * Prefixo + nome imediato (sem espaço entre eles). null = não é comando.
 */
export function parseBotCommand(prefix: string, body: string): { name: string; args: string[] } | null {
  if (typeof body !== 'string' || !body) return null
  const trimmed = body.trim()
  if (!trimmed.startsWith(prefix)) return null
  const rest = trimmed.slice(prefix.length)
  const m = rest.match(/^([a-z0-9-]+)(?:\s+([\s\S]*))?$/i)
  if (!m) return null
  const name = m[1].toLowerCase()
  if (!name) return null
  const args = (m[2] ?? '').trim().length > 0 ? m[2].trim().split(/\s+/).slice(0, 16) : []
  return { name, args }
}

/** Escapa um valor para uso seguro dentro de URL query (?/encodeURIComponent). */
function encodeForUrl(v: string): string {
  try { return encodeURIComponent(v) } catch { return '' }
}

/**
 * Renderiza templates de URL/corpo: {{args}} (junto, encoded), {{arg0}}..
 * {{argN}} (encoded), {{query}} (args unidos por '+' encoded), {{raw.args}}
 * (sem encode — NÃO use em URL; só em corpo).
 */
export function renderTemplate(tpl: string, vars: { args: string[]; value?: string; json?: unknown }): string {
  return tpl
    .replace(/\{\{\s*args\s*\}\}/g, () => vars.args.map(encodeForUrl).join('/'))
    .replace(/\{\{\s*query\s*\}\}/g, () => vars.args.map(encodeForUrl).join('+'))
    .replace(/\{\{\s*arg(\d+)\s*\}\}/g, (_m, d) => {
      const i = Number(d)
      return i < vars.args.length ? encodeForUrl(vars.args[i]) : ''
    })
    .replace(/\{\{\s*raw\.args\s*\}\}/g, () => vars.args.join(' '))
    .replace(/\{\{\s*value\s*\}\}/g, () => vars.value ?? '')
    .replace(/\{\{\s*json\.([\w.$-]+)\s*\}\}/g, (_m, path: string) => {
      const v = extractPath(vars.json, path)
      return v ?? ''
    })
}

/** Extrai caminho pontilhado de objeto/array: 'data.items[0].name' ou 'data.items.0.name'. */
export function extractPath(obj: unknown, path: string): string | null {
  if (!obj || !path) return null
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || cur === undefined) return null
    if (Array.isArray(cur)) {
      const i = Number(p)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return null
      cur = cur[i]
      continue
    }
    if (typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[p]
  }
  if (cur === null || cur === undefined) return null
  if (typeof cur === 'string') return cur
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur)
  try { return JSON.stringify(cur) } catch { return null }
}

/** Escopo: [] = todos os canais; senão só os listados. */
export function channelInScope(config: BotConfig, channelId: string): boolean {
  if (!config.channels || config.channels.length === 0) return true
  return config.channels.includes(channelId)
}

export function findCommand(config: BotConfig, name: string): BotCommandDef | undefined {
  return config.commands.find((c) => c.name === name)
}

/** Monta a resposta final do comando a partir do corpo retornado. */
export function renderBotReply(cmd: BotCommandDef, args: string[], bodyText: string, json?: unknown): string | null {
  let jsonParsed: unknown = json
  if (jsonParsed === undefined) {
    try { jsonParsed = JSON.parse(bodyText) } catch { jsonParsed = undefined }
  }
  let value: string | null = null
  if (cmd.responsePath) {
    value = extractPath(jsonParsed, cmd.responsePath)
    if (value === null) return null // caminho não existe → comando falha honesto
  }
  const tpl = cmd.template ?? (value !== null ? '{{value}}' : '{{json}}')
  const out = renderTemplate(tpl, { args, value: value ?? undefined, json: jsonParsed })
    .replace(/\{\{\s*json\s*\}\}/g, () => (jsonParsed !== undefined ? bodyText : ''))
  const trimmed = out.trim()
  if (!trimmed) return null
  return trimmed.slice(0, 1900) // cabe no limite de 64KB com folga; evita flood
}
