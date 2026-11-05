import { sanitizeText } from '../core/security/sanitize.ts'

/**
 * Modelo do bot no front-end. Precisa espelhar `distorrent-core/src/bots.rs`:
 * o core valida de novo e descarta o que não entende, então divergência aqui
 * vira "salvei e não funcionou".
 */

export type BotExec = 'http' | 'reply' | 'script' | 'admin'

export type BotNeed = '' | 'moderate' | 'manage' | 'owner'

export interface BotArgDef {
  name: string
  required?: boolean
  rest?: boolean
}

export interface BotCommandDef {
  name: string
  aliases?: string[]
  description?: string
  exec?: BotExec
  method: 'GET' | 'POST'
  url: string
  headers?: Record<string, string>
  body?: string
  responsePath?: string
  template?: string
  reply?: string
  script?: string
  admin?: string
  permission?: BotNeed
  cooldownMs?: number
  ephemeral?: boolean
  enabled?: boolean
  autocomplete?: boolean
  args?: BotArgDef[]
}

export interface BotWebhookDef {
  url: string
}

/** Tipo de canal em que o bot pode agir. */
export type BotChannelKind = 'text' | 'voice' | 'video' | 'forum'

export const BOT_CHANNEL_KINDS: { id: BotChannelKind; label: string; hint: string }[] = [
  { id: 'text', label: 'Texto', hint: 'Comandos e respostas em #canais normais.' },
  { id: 'forum', label: 'Fórum', hint: 'Canais de fórum (posts e tópicos).' },
  { id: 'voice', label: 'Voz', hint: 'Só eventos (entrou/saiu). O bot não fala na call.' },
  { id: 'video', label: 'Vídeo', hint: 'Só eventos. O bot não envia imagem nem som.' },
]

export interface BotConfig {
  prefix: string
  commands: BotCommandDef[]
  channels: string[]
  /** Tipos de canal onde o bot age. Vazio = todos os tipos. */
  channelKinds: BotChannelKind[]
  webhook?: BotWebhookDef
  events: string[]
  blockPrivate: boolean
  maxRepliesPerMinute: number
}

export const BOT_CONFIG_MAX_JSON = 64 * 1024
export const BOT_MAX_COMMANDS = 48
export const BOT_MAX_ALIASES = 4
export const BOT_MAX_ARGS = 8
export const BOT_MAX_REPLY = 1900
export const BOT_MAX_SCRIPT_LINES = 200
export const BOT_DEFAULT_COOLDOWN_MS = 1_500
export const BOT_MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** Permissões administrativas que o dono pode conceder a um bot. */
export const BOT_PERMS = {
  BAN: 1 << 0,
  MUTE: 1 << 1,
  DELETE: 1 << 2,
  MANAGE: 1 << 3,
  /** Criar/renomear/excluir canais e cargos, e mudar o servidor. */
  STRUCTURE: 1 << 4,
  /** Apagar mensagens de qualquer autor e limpar canais inteiros. */
  PURGE: 1 << 5,
} as const

export const BOT_PERM_ALL =
  BOT_PERMS.BAN |
  BOT_PERMS.MUTE |
  BOT_PERMS.DELETE |
  BOT_PERMS.MANAGE |
  BOT_PERMS.STRUCTURE |
  BOT_PERMS.PURGE

export interface BotPermDef {
  bit: number
  label: string
  hint: string
  commands: string[]
}

export const BOT_PERM_DEFS: BotPermDef[] = [
  {
    bit: BOT_PERMS.BAN,
    label: 'Banir e desbanir',
    hint: 'Permite /ban e /unban. O dono do servidor nunca é alvo.',
    commands: ['ban', 'unban'],
  },
  {
    bit: BOT_PERMS.MUTE,
    label: 'Silenciar',
    hint: 'Permite /mute, /unmute, /warn e /warnings.',
    commands: ['mute', 'unmute', 'warn', 'warnings'],
  },
  {
    bit: BOT_PERMS.DELETE,
    label: 'Apagar mensagens',
    hint: 'Permite /clear.',
    commands: ['clear'],
  },
  {
    bit: BOT_PERMS.MANAGE,
    label: 'Gerenciar membros',
    hint: 'Permite /kick e /role_assign, /role_unassign (dar e tirar cargo).',
    commands: ['kick', 'role_assign', 'role_unassign'],
  },
  {
    bit: BOT_PERMS.STRUCTURE,
    label: 'Montar o servidor',
    hint: 'Permite criar/renomear/excluir canais e cargos e renomear o servidor.',
    commands: ['channel_create', 'channel_delete', 'channel_edit', 'role_create', 'role_delete', 'server_edit'],
  },
  {
    bit: BOT_PERMS.PURGE,
    label: 'Limpar canais',
    hint: 'Permite /clear e /lock, /unlock e /slowmode em qualquer canal.',
    commands: ['clear', 'lock', 'unlock', 'slowmode'],
  },
]

/** Ações administrativas nativas e a permissão que cada uma exige. */
export const BOT_ADMIN_ACTIONS: { action: string; perm: number; label: string }[] = [
  { action: 'ban', perm: BOT_PERMS.BAN, label: 'Banir membro' },
  { action: 'unban', perm: BOT_PERMS.BAN, label: 'Desbanir membro' },
  { action: 'kick', perm: BOT_PERMS.MANAGE, label: 'Expulsar membro' },
  { action: 'mute', perm: BOT_PERMS.MUTE, label: 'Silenciar por N minutos' },
  { action: 'unmute', perm: BOT_PERMS.MUTE, label: 'Remover silêncio' },
  { action: 'warn', perm: BOT_PERMS.MUTE, label: 'Registrar aviso' },
  { action: 'warnings', perm: BOT_PERMS.MUTE, label: 'Listar avisos' },
  { action: 'clear', perm: BOT_PERMS.PURGE, label: 'Apagar N mensagens' },
  { action: 'lock', perm: BOT_PERMS.PURGE, label: 'Trancar canal' },
  { action: 'unlock', perm: BOT_PERMS.PURGE, label: 'Destrancar canal' },
  { action: 'slowmode', perm: BOT_PERMS.PURGE, label: 'Definir slowmode (s)' },
  { action: 'channel_create', perm: BOT_PERMS.STRUCTURE, label: 'Criar canal' },
  { action: 'channel_delete', perm: BOT_PERMS.STRUCTURE, label: 'Excluir canal' },
  { action: 'channel_edit', perm: BOT_PERMS.STRUCTURE, label: 'Renomear canal' },
  { action: 'role_create', perm: BOT_PERMS.STRUCTURE, label: 'Criar cargo' },
  { action: 'role_delete', perm: BOT_PERMS.STRUCTURE, label: 'Excluir cargo' },
  { action: 'role_assign', perm: BOT_PERMS.MANAGE, label: 'Dar cargo a membro' },
  { action: 'role_unassign', perm: BOT_PERMS.MANAGE, label: 'Tirar cargo de membro' },
  { action: 'server_edit', perm: BOT_PERMS.STRUCTURE, label: 'Renomear servidor' },
  { action: 'userinfo', perm: 0, label: 'Informações do membro' },
  { action: 'serverinfo', perm: 0, label: 'Informações do servidor' },
  { action: 'ping', perm: 0, label: 'Latência do bot' },
]

export function permAllows(botPerms: number, action: string): boolean {
  const def = BOT_ADMIN_ACTIONS.find((a) => a.action === action)
  if (!def) return false
  return def.perm === 0 || (botPerms & def.perm) !== 0
}

export function permMaskFrom(list: number[]): number {
  return list.reduce((acc, bit) => acc | bit, 0) & BOT_PERM_ALL
}

export function permList(mask: number): number[] {
  return BOT_PERM_DEFS.filter((d) => (mask & d.bit) !== 0).map((d) => d.bit)
}

/** Eventos que o runtime entrega. Fechado: o que não está aqui não existe. */
export const BOT_EVENTS: { id: string; label: string; hint: string }[] = [
  { id: 'message_new', label: 'Nova mensagem', hint: 'Qualquer mensagem no escopo de canais.' },
  { id: 'message_edited', label: 'Mensagem editada', hint: 'O corpo mudou depois de enviado.' },
  { id: 'message_deleted', label: 'Mensagem apagada', hint: 'A mensagem saiu do canal.' },
  { id: 'mention', label: 'Menção ao bot', hint: 'Alguém escreveu o nome do bot com @.' },
  { id: 'reaction', label: 'Reação', hint: 'Alguém reagiu a uma mensagem.' },
  { id: 'member_joined', label: 'Membro entrou', hint: 'Convite aceito ou entrada pública.' },
  { id: 'member_left', label: 'Membro saiu', hint: 'Saiu, foi expulso ou banido.' },
  { id: 'channel_created', label: 'Canal criado', hint: 'Um canal novo apareceu.' },
  { id: 'channel_deleted', label: 'Canal excluído', hint: 'Um canal foi removido.' },
  { id: 'call_started', label: 'Chamada iniciou', hint: 'Uma sala de chamada abriu.' },
  { id: 'call_ended', label: 'Chamada terminou', hint: 'A sala de chamada fechou.' },
  { id: 'voice_joined', label: 'Entrou na voz', hint: 'Alguém entrou num canal de voz.' },
  { id: 'voice_left', label: 'Saiu da voz', hint: 'Alguém saiu do canal de voz.' },
]

const VALID_PREFIXES = '!/.$@#%-'

export function normalizeBotCommandName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32)
}

function isHttpUrl(url: string): boolean {
  const u = url.trim()
  if (!u || u.length > 2048) return false
  if (!/^https?:\/\//i.test(u)) return false
  const rest = u.replace(/^https?:\/\//i, '')
  return rest.length > 0 && !rest.startsWith('/')
}

function hostOf(url: string): string | null {
  const u = url.trim()
  const m = /^https?:\/\/([^/?#]+)/i.exec(u)
  if (!m) return null
  const hostPort = m[1]
  const host = hostPort.startsWith('[')
    ? hostPort.slice(1, hostPort.indexOf(']'))
    : hostPort.split(':')[0]
  const clean = host.trim().replace(/\.$/, '').toLowerCase()
  return clean || null
}

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

/** Metadados de nuvem/link-local: nunca são destino de bot, nem por opt-in. */
export function isBlockedHost(host: string): boolean {
  if (host === 'metadata.google.internal' || host === 'metadata') return true
  const ip = parseIPv4(host)
  if (!ip) return false
  return ip[0] === 169 && ip[1] === 254
}

export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const ip = parseIPv4(host)
  if (ip) {
    if (ip[0] === 10 || ip[0] === 127) return true
    if (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) return true
    if (ip[0] === 192 && ip[1] === 168) return true
    if (ip[0] === 169 && ip[1] === 254) return true
    return false
  }
  const h = host.replace(/^\[|\]$/g, '')
  return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
}

/** Mesma regra do core, para o editor recusar ANTES de salvar. */
export function urlProblem(url: string, blockPrivate: boolean): string | null {
  if (!url.trim()) return 'informe a url'
  if (!isHttpUrl(url)) return 'precisa de uma url http:// ou https://'
  const host = hostOf(url)
  if (!host) return 'url sem host'
  if (isBlockedHost(host)) return `destino bloqueado (${host})`
  if (blockPrivate && isPrivateHost(host)) {
    return `rede privada bloqueada (${host}) — desligue "bloquear rede local" para permitir`
  }
  return null
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function parseArg(v: any): BotArgDef | null {
  if (!v || typeof v !== 'object') return null
  const name = normalizeBotCommandName(String(v.name ?? ''))
  if (!name) return null
  return { name, required: v.required === true, rest: v.rest === true }
}

function parseCommand(c: any): BotCommandDef | null {
  if (!c || typeof c !== 'object') return null
  const name = normalizeBotCommandName(String(c.name ?? ''))
  if (!name) return null
  const aliases: string[] = Array.isArray(c.aliases)
    ? c.aliases
        .slice(0, BOT_MAX_ALIASES)
        .map((a: unknown) => normalizeBotCommandName(String(a ?? '')))
        .filter((a: string) => a && a !== name)
    : []
  const url = typeof c.url === 'string' ? c.url.trim().slice(0, 2048) : ''
  const reply = typeof c.reply === 'string' ? c.reply.slice(0, BOT_MAX_REPLY) : undefined
  const script = typeof c.script === 'string' ? c.script.slice(0, 200 * 160) : undefined
  const admin =
    typeof c.admin === 'string' && c.admin.trim() ? normalizeBotCommandName(c.admin) : undefined
  let exec: BotExec = 'http'
  if (c.exec === 'http' || c.exec === 'reply' || c.exec === 'script' || c.exec === 'admin') {
    exec = c.exec
  } else if (admin) exec = 'admin'
  else if (script) exec = 'script'
  else if (!url && reply) exec = 'reply'
  if (exec === 'http' && !isHttpUrl(url)) return null
  if (exec === 'admin' && !admin) return null
  if (exec === 'script' && !(script ?? '').trim()) return null
  if (exec === 'reply' && !(reply ?? '').trim()) return null
  const headers: Record<string, string> = {}
  if (c.headers && typeof c.headers === 'object' && !Array.isArray(c.headers)) {
    for (const [k, v] of Object.entries(c.headers).slice(0, 16)) {
      if (typeof v === 'string' && k.length > 0 && k.length <= 64) headers[k.slice(0, 64)] = v.slice(0, 1024)
    }
  }
  const args: BotArgDef[] = Array.isArray(c.args)
    ? (c.args as unknown[]).slice(0, BOT_MAX_ARGS).map(parseArg).filter((a): a is BotArgDef => !!a)
    : []
  const perm = c.permission
  return {
    name,
    aliases,
    description: typeof c.description === 'string' ? c.description.slice(0, 200) : '',
    exec,
    method: String(c.method ?? '').toUpperCase() === 'POST' ? 'POST' : 'GET',
    url,
    headers: Object.keys(headers).length ? headers : undefined,
    body: typeof c.body === 'string' ? c.body.slice(0, 8192) : undefined,
    responsePath:
      typeof c.responsePath === 'string' && c.responsePath.trim()
        ? c.responsePath.trim().slice(0, 128)
        : undefined,
    template: typeof c.template === 'string' ? c.template.slice(0, BOT_MAX_REPLY) : undefined,
    reply,
    script,
    admin,
    permission: perm === 'moderate' || perm === 'manage' || perm === 'owner' ? perm : '',
    cooldownMs: Math.max(
      0,
      Math.min(BOT_MAX_COOLDOWN_MS, numberOr(c.cooldownMs, BOT_DEFAULT_COOLDOWN_MS)),
    ),
    ephemeral: c.ephemeral === true,
    enabled: c.enabled !== false,
    autocomplete: c.autocomplete === true,
    args: args.length ? args : undefined,
  }
}

export function defaultBotConfig(): BotConfig {
  return {
    prefix: '!',
    commands: [],
    channels: [],
    channelKinds: [],
    events: [],
    blockPrivate: true,
    maxRepliesPerMinute: 20,
  }
}

/**
 * Lê a config de `bots.config`. Devolve `null` só quando o texto não é JSON
 * objeto; campos desconhecidos são descartados (como no core). Texto vazio é
 * config padrão: é o que o bot recém-criado tem, e o core aceita igual.
 */
export function parseBotConfig(raw: unknown): BotConfig | null {
  if (raw === null || raw === undefined) return null
  let obj: any
  if (typeof raw === 'string') {
    if (!raw.trim()) return defaultBotConfig()
    if (raw.length > BOT_CONFIG_MAX_JSON) return null
    try {
      obj = JSON.parse(raw)
    } catch {
      return null
    }
  } else if (typeof raw === 'object') {
    obj = raw
  } else {
    return null
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
  const rawPrefix = typeof obj.prefix === 'string' ? obj.prefix.trim() : '!'
  const prefix = rawPrefix.length === 1 && VALID_PREFIXES.includes(rawPrefix) ? rawPrefix : '!'
  if (typeof obj.prefix === 'string' && obj.prefix.trim() && !VALID_PREFIXES.includes(obj.prefix.trim())) {
    return null
  }
  const commands: BotCommandDef[] = Array.isArray(obj.commands)
    ? (obj.commands as unknown[]).slice(0, BOT_MAX_COMMANDS).map(parseCommand).filter((c): c is BotCommandDef => !!c)
    : []
  const channels: string[] = Array.isArray(obj.channels)
    ? obj.channels
        .filter((c: unknown) => typeof c === 'string' && c.length > 0 && c.length < 128)
        .slice(0, 256)
    : []
  const hookRaw =
    typeof obj.webhook === 'object' && obj.webhook && typeof obj.webhook.url === 'string'
      ? obj.webhook.url.trim().slice(0, 2048)
      : typeof obj.webhook === 'string'
        ? obj.webhook.trim().slice(0, 2048)
        : ''
  const webhook = hookRaw && isHttpUrl(hookRaw) ? { url: hookRaw } : undefined
  const validEvents = new Set(BOT_EVENTS.map((e) => e.id))
  const events: string[] = Array.isArray(obj.events)
    ? obj.events.filter((e: unknown) => typeof e === 'string' && validEvents.has(e)).slice(0, 32)
    : []
  const validKinds = new Set(BOT_CHANNEL_KINDS.map((k) => k.id))
  const channelKinds: BotChannelKind[] = Array.isArray(obj.channelKinds)
    ? obj.channelKinds
        .filter((k: unknown): k is BotChannelKind => typeof k === 'string' && validKinds.has(k as BotChannelKind))
        .slice(0, 4)
    : []
  return {
    prefix,
    commands,
    channels,
    channelKinds,
    webhook,
    events,
    blockPrivate: obj.blockPrivate === undefined ? true : obj.blockPrivate !== false,
    maxRepliesPerMinute: Math.max(1, Math.min(120, numberOr(obj.maxRepliesPerMinute, 20))),
  }
}

/** Infere o tipo quando o editor não preencheu `exec` (retrocompatível). */
export function inferExec(c: BotCommandDef): BotExec {
  if (c.admin) return 'admin'
  if (c.script) return 'script'
  if (!c.url?.trim() && c.reply) return 'reply'
  return 'http'
}

/** Serializa de volta. Não inclui campo que o parser descartaria. */
export function serializeBotConfig(cfg: BotConfig): string {
  return JSON.stringify({
    prefix: cfg.prefix,
    commands: cfg.commands.map((c) => {
      const exec = c.exec ?? inferExec(c)
      const out: Record<string, unknown> = { name: c.name }
      if (c.aliases?.length) out.aliases = c.aliases
      if (c.description) out.description = c.description
      out.exec = exec
      if (exec === 'http') {
        out.method = c.method
        out.url = c.url.trim()
        if (c.headers && Object.keys(c.headers).length) out.headers = c.headers
        if (c.body) out.body = c.body
        if (c.responsePath) out.responsePath = c.responsePath
        if (c.template) out.template = c.template
      }
      if (exec === 'reply' && c.reply) out.reply = c.reply
      if (exec === 'script' && c.script) out.script = c.script
      if (exec === 'admin' && c.admin) out.admin = c.admin
      if (c.permission) out.permission = c.permission
      if (c.cooldownMs !== undefined) out.cooldownMs = c.cooldownMs
      if (c.ephemeral) out.ephemeral = true
      if (c.enabled === false) out.enabled = false
      if (c.autocomplete) out.autocomplete = true
      if (c.args?.length) out.args = c.args
      return out
    }),
    channels: cfg.channels,
    channelKinds: cfg.channelKinds,
    events: cfg.events,
    blockPrivate: cfg.blockPrivate,
    maxRepliesPerMinute: cfg.maxRepliesPerMinute,
    webhook: cfg.webhook,
  })
}

export function parseBotCommand(prefix: string, body: string): { name: string; args: string[] } | null {
  if (typeof body !== 'string' || !body) return null
  const trimmed = body.trim()
  if (!trimmed.startsWith(prefix)) return null
  const rest = trimmed.slice(prefix.length)
  // `!!x` é riso, não comando — mesma regra do core.
  if (rest.startsWith(prefix)) return null
  const m = rest.match(/^([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i)
  if (!m) return null
  const name = normalizeBotCommandName(m[1])
  if (!name) return null
  const args = (m[2] ?? '').trim().length > 0 ? m[2].trim().split(/\s+/).slice(0, 16) : []
  return { name, args }
}

function encodeForUrl(v: string): string {
  try {
    return encodeURIComponent(v)
  } catch {
    return ''
  }
}

export interface RenderVars {
  args: string[]
  value?: string
  json?: unknown
  vars?: Record<string, string>
}

export function renderTemplate(tpl: string, vars: RenderVars): string {
  const table = vars.vars ?? {}
  return tpl
    .replace(/\{\{\s*args\s*\}\}/g, () => vars.args.map(encodeForUrl).join('/'))
    .replace(/\{\{\s*query\s*\}\}/g, () => vars.args.map(encodeForUrl).join('+'))
    .replace(/\{\{\s*arg(\d+)\s*\}\}/g, (_m, d) => {
      const i = Number(d)
      return i < vars.args.length ? encodeForUrl(vars.args[i]) : ''
    })
    .replace(/\{\{\s*raw\.args\s*\}\}/g, () => vars.args.join(' '))
    .replace(/\{\{\s*value\s*\}\}/g, () => vars.value ?? '')
    .replace(/\{\{\s*var\.([\w.:-]+)\s*\}\}/g, (_m, k: string) => table[k] ?? '')
    .replace(/\{\{\s*json\.([\w.$-]+)\s*\}\}/g, (_m, path: string) => {
      const v = extractPath(vars.json, path)
      return v ?? ''
    })
}

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
  try {
    return JSON.stringify(cur)
  } catch {
    return null
  }
}

export function channelInScope(config: BotConfig, channelId: string): boolean {
  if (!config.channels || config.channels.length === 0) return true
  return config.channels.includes(channelId)
}

/**
 * Escopo por TIPO de canal. `channelId` pode ser omitido quando quem chama já
 * sabe o tipo (evento de voz, por exemplo).
 */
export function kindInScope(
  config: BotConfig,
  kind: BotChannelKind | undefined,
): boolean {
  const kinds = config.channelKinds ?? []
  if (kinds.length === 0) return true
  if (!kind) return true
  return kinds.includes(kind)
}

// `online` ausente em payload antigo conta como ligado; só o `false` explícito desliga.
export function botIsActive(online: boolean | undefined): boolean {
  return online !== false
}

export function findCommand(config: BotConfig, name: string): BotCommandDef | undefined {
  const n = normalizeBotCommandName(name)
  return config.commands.find(
    (c) => c.enabled !== false && (c.name === n || (c.aliases ?? []).includes(n)),
  )
}

export function renderBotReply(
  cmd: BotCommandDef,
  args: string[],
  bodyText: string,
  json?: unknown,
): string | null {
  let jsonParsed: unknown = json
  if (jsonParsed === undefined) {
    try {
      jsonParsed = JSON.parse(bodyText)
    } catch {
      jsonParsed = undefined
    }
  }
  let value: string | null = null
  if (cmd.responsePath) {
    value = extractPath(jsonParsed, cmd.responsePath)
    if (value === null) return null
  }
  const tpl = cmd.template ?? (value !== null ? '{{value}}' : '{{json}}')
  const out = renderTemplate(tpl, { args, value: value ?? undefined, json: jsonParsed })
    .replace(/\{\{\s*json\s*\}\}/g, () => (jsonParsed !== undefined ? bodyText : ''))
  // O texto vem de uma API de terceiro: bidi/zero-width aqui forjaria o que a
  // mensagem diz.
  const trimmed = sanitizeText(out, BOT_MAX_REPLY)
  if (!trimmed) return null
  return trimmed
}

/** Valida a definição de UM comando no editor, antes de salvar. */
export function commandProblem(cmd: BotCommandDef, others: BotCommandDef[]): string | null {
  const name = normalizeBotCommandName(cmd.name)
  if (!name) return 'informe um nome (ex.: clima)'
  if (others.some((o) => o !== cmd && o.name === name)) return 'já existe um comando com esse nome'
  if (others.some((o) => o !== cmd && (o.aliases ?? []).includes(name))) {
    return 'esse nome já é alias de outro comando'
  }
  for (const alias of cmd.aliases ?? []) {
    if (alias === name) return 'alias igual ao nome do comando'
    if (others.some((o) => o !== cmd && (o.name === alias || (o.aliases ?? []).includes(alias)))) {
      return `alias ${alias} já existe`
    }
  }
  if (cmd.exec === 'http') {
    if (!cmd.url.trim()) return 'informe a url'
    if (!isHttpUrl(cmd.url)) return 'a url precisa ser http:// ou https://'
  }
  if (cmd.exec === 'reply' && !(cmd.reply ?? '').trim()) return 'escreva a resposta fixa'
  if (cmd.exec === 'script' && !(cmd.script ?? '').trim()) return 'escreva o script'
  if (cmd.exec === 'admin') {
    if (!cmd.admin) return 'escolha a ação administrativa'
    if (!BOT_ADMIN_ACTIONS.some((a) => a.action === cmd.admin)) {
      return `ação desconhecida: ${cmd.admin}`
    }
  }
  return null
}

/** Compara o necessário para gerar/copiar a config sem sujar o bot. */
export function configSignature(cfg: BotConfig): string {
  return JSON.stringify(cfg)
}
