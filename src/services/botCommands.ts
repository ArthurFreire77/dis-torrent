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

export type BotMode = 'declarative' | 'plugin' | 'service' | 'remote'
export type BotRuntime = 'none' | 'process' | 'wasm'

export const BOT_MODES: { id: BotMode; label: string; hint: string }[] = [
  {
    id: 'declarative',
    label: 'Declarativo',
    hint: 'Só config: resposta fixa, HTTP, DSL e ação administrativa. Nada de código roda.',
  },
  {
    id: 'plugin',
    label: 'Plugin local',
    hint: 'Código do criador roda no PC do dono, falando pela ponte 127.0.0.1. Capacidade total, sem hospedagem.',
  },
  {
    id: 'service',
    label: 'Serviço externo',
    hint: 'O criador hospeda e recebe eventos por webhook assinado. Exige o app do dono aberto.',
  },
  {
    id: 'remote',
    label: 'Bot remoto',
    hint: 'O criador conecta de fora por TLS. Quebra a promessa "nada roda em nuvem" — desligado por padrão.',
  },
]

/** Primitivas: o que o bot pode ENTREGAR. Nome igual ao do core. */
export interface BotPrimitives {
  text: boolean
  ephemeral: boolean
  dm: boolean
  embed: boolean
  component: boolean
  attachment: boolean
  reaction: boolean
  pin: boolean
  thread: boolean
  poll: boolean
  edit: boolean
  audioFrame: boolean
  videoFrame: boolean
  screenFrame: boolean
  http: boolean
  blob: boolean
  kv: boolean
  job: boolean
  template: boolean
  invokeBot: boolean
}

export interface BotPrimitiveDef {
  id: keyof BotPrimitives
  label: string
  hint: string
  /** `false` = o campo existe no schema, mas a plataforma não entrega ainda. */
  implemented: boolean
}

/**
 * O catálogo das 20 primitivas. `implemented:false` não vira rota: o painel
 * mostra "ainda não existe" em vez de um botão que mente (§13 da doc).
 */
export const BOT_PRIMITIVES: BotPrimitiveDef[] = [
  { id: 'text', label: 'Texto', hint: 'Mensagem em markdown no canal.', implemented: true },
  { id: 'ephemeral', label: 'Resposta discreta', hint: 'Só quem interagiu vê (prefixo -#).', implemented: true },
  { id: 'dm', label: 'Mensagem direta', hint: 'Conversa privada com um membro.', implemented: false },
  { id: 'embed', label: 'Embed', hint: 'Cartão com título, campos e imagem.', implemented: false },
  { id: 'component', label: 'Componentes', hint: 'Botões, selects e modais.', implemented: false },
  { id: 'attachment', label: 'Anexo', hint: 'Arquivo por URL ou upload.', implemented: false },
  { id: 'reaction', label: 'Reação', hint: 'Emoji em mensagem.', implemented: true },
  { id: 'pin', label: 'Fixar', hint: 'Fixar/desafixar mensagem.', implemented: true },
  { id: 'thread', label: 'Thread', hint: 'Criar e arquivar thread.', implemented: true },
  { id: 'poll', label: 'Enquete', hint: 'Pergunta com opções.', implemented: true },
  { id: 'edit', label: 'Editar', hint: 'Editar mensagem própria (streaming).', implemented: false },
  { id: 'audioFrame', label: 'Áudio', hint: 'Pacotes Opus na chamada.', implemented: false },
  { id: 'videoFrame', label: 'Vídeo', hint: 'Pacotes de vídeo na chamada.', implemented: false },
  { id: 'screenFrame', label: 'Tela', hint: 'Pacotes de compartilhamento de tela.', implemented: false },
  { id: 'http', label: 'HTTP de saída', hint: 'GET/POST para a allowlist.', implemented: true },
  { id: 'blob', label: 'Blob', hint: 'Armazenamento binário por bot.', implemented: false },
  { id: 'kv', label: 'Chave-valor', hint: 'Variáveis persistentes com TTL.', implemented: true },
  { id: 'job', label: 'Agendamento', hint: 'Cron/atraso com retry.', implemented: false },
  { id: 'template', label: 'Template', hint: 'Placeholders na resposta.', implemented: true },
  { id: 'invokeBot', label: 'Chamar outro bot', hint: 'Bot-a-bot com profundidade limitada.', implemented: false },
]

export function defaultPrimitives(): BotPrimitives {
  return {
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
    audioFrame: false,
    videoFrame: false,
    screenFrame: false,
    http: true,
    blob: false,
    kv: true,
    job: false,
    template: true,
    invokeBot: false,
  }
}

export interface BotConfig {
  /** 1/2 = config antiga (migrada na leitura), 3 = atual. */
  schema: number
  /** Explícito, nunca inferido do que foi preenchido. */
  mode: BotMode
  runtime: BotRuntime
  primitives: BotPrimitives
  prefix: string
  commands: BotCommandDef[]
  channels: string[]
  /** Tipos de canal onde o bot age. Vazio = todos os tipos. */
  channelKinds: BotChannelKind[]
  webhook?: BotWebhookDef
  events: string[]
  blockPrivate: boolean
  maxRepliesPerMinute: number
  /** Domínios que o bot pode chamar. Vazio = qualquer http(s) público. */
  httpAllow: string[]
  maxHttpPerMinute: number
  /** Segredo do HMAC do webhook. Nunca vai no corpo, no log nem no export. */
  webhookSecret?: string
  maxMessagesPerExecution: number
  retentionHours: number
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
  /** Reagir, fixar, thread, enquete e emoji. Não apaga nada de outro. */
  CONTENT: 1 << 6,
} as const

export const BOT_PERM_ALL =
  BOT_PERMS.BAN |
  BOT_PERMS.MUTE |
  BOT_PERMS.DELETE |
  BOT_PERMS.MANAGE |
  BOT_PERMS.STRUCTURE |
  BOT_PERMS.PURGE |
  BOT_PERMS.CONTENT

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
    hint: 'Permite /mute, /unmute, /warn, /warnings e limpar avisos.',
    commands: ['mute', 'unmute', 'warn', 'warnings', 'warnings_clear'],
  },
  {
    bit: BOT_PERMS.DELETE,
    label: 'Apagar mensagens',
    hint: 'Permite /delete_msg (uma mensagem pelo id).',
    commands: ['delete_msg'],
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
    hint: 'Permite criar/renomear/excluir canais e cargos, mudar tópico/categoria, descrição e entrada pública, e gerar convite.',
    commands: [
      'channel_create',
      'channel_delete',
      'channel_edit',
      'channel_topic',
      'channel_category',
      'role_create',
      'role_delete',
      'role_edit',
      'server_edit',
      'server_meta',
      'server_public',
      'make_invite',
    ],
  },
  {
    bit: BOT_PERMS.PURGE,
    label: 'Limpar canais',
    hint: 'Permite /clear e /lock, /unlock e /slowmode em qualquer canal.',
    commands: ['clear', 'lock', 'unlock', 'slowmode'],
  },
  {
    bit: BOT_PERMS.CONTENT,
    label: 'Conteúdo e organização',
    hint: 'Permite reagir, fixar mensagem, criar thread, enquete e emoji. Não apaga nada de outro autor.',
    commands: [
      'react',
      'pin',
      'unpin',
      'thread_create',
      'thread_archive',
      'poll_create',
      'emoji_add',
      'emoji_del',
      'typing',
    ],
  },
]

/** Ações administrativas nativas e a permissão que cada uma exige. */
export const BOT_ADMIN_ACTIONS: { action: string; perm: number; label: string; args: string }[] = [
  { action: 'ban', perm: BOT_PERMS.BAN, label: 'Banir membro', args: '<membro> [motivo]' },
  { action: 'unban', perm: BOT_PERMS.BAN, label: 'Desbanir membro', args: '<membro>' },
  { action: 'kick', perm: BOT_PERMS.MANAGE, label: 'Expulsar membro', args: '<membro> [motivo]' },
  { action: 'mute', perm: BOT_PERMS.MUTE, label: 'Silenciar por N minutos', args: '<membro> [minutos] [motivo]' },
  { action: 'unmute', perm: BOT_PERMS.MUTE, label: 'Remover silêncio', args: '<membro> [motivo]' },
  { action: 'warn', perm: BOT_PERMS.MUTE, label: 'Registrar aviso', args: '<membro> [motivo]' },
  { action: 'warnings', perm: BOT_PERMS.MUTE, label: 'Listar avisos', args: '<membro>' },
  { action: 'warnings_clear', perm: BOT_PERMS.MUTE, label: 'Limpar avisos', args: '<membro>' },
  { action: 'delete_msg', perm: BOT_PERMS.DELETE, label: 'Apagar uma mensagem (id)', args: '<id-da-mensagem>' },
  { action: 'clear', perm: BOT_PERMS.PURGE, label: 'Apagar N mensagens', args: '[#canal] [N]' },
  { action: 'lock', perm: BOT_PERMS.PURGE, label: 'Trancar canal', args: '[#canal]' },
  { action: 'unlock', perm: BOT_PERMS.PURGE, label: 'Destrancar canal', args: '[#canal]' },
  { action: 'slowmode', perm: BOT_PERMS.PURGE, label: 'Definir slowmode (s)', args: '[#canal] [segundos]' },
  { action: 'channel_create', perm: BOT_PERMS.STRUCTURE, label: 'Criar canal', args: '<nome> [text|voice|video|forum]' },
  { action: 'channel_delete', perm: BOT_PERMS.STRUCTURE, label: 'Excluir canal', args: '[#canal]' },
  { action: 'channel_edit', perm: BOT_PERMS.STRUCTURE, label: 'Renomear canal', args: '<canal> <novo-nome>' },
  { action: 'channel_topic', perm: BOT_PERMS.STRUCTURE, label: 'Mudar tópico do canal', args: '<canal> <tópico>' },
  { action: 'channel_category', perm: BOT_PERMS.STRUCTURE, label: 'Mudar categoria do canal', args: '<canal> <categoria>' },
  { action: 'role_create', perm: BOT_PERMS.STRUCTURE, label: 'Criar cargo', args: '<nome> [#RRGGBB]' },
  { action: 'role_delete', perm: BOT_PERMS.STRUCTURE, label: 'Excluir cargo', args: '<cargo>' },
  { action: 'role_edit', perm: BOT_PERMS.STRUCTURE, label: 'Renomear/recolorir cargo', args: '<cargo> [novo-nome] [#RRGGBB]' },
  { action: 'role_assign', perm: BOT_PERMS.MANAGE, label: 'Dar cargo a membro', args: '<cargo> <membro>' },
  { action: 'role_unassign', perm: BOT_PERMS.MANAGE, label: 'Tirar cargo de membro', args: '<cargo> <membro>' },
  { action: 'server_edit', perm: BOT_PERMS.STRUCTURE, label: 'Renomear servidor', args: '<novo-nome>' },
  { action: 'server_meta', perm: BOT_PERMS.STRUCTURE, label: 'Mudar descrição do servidor', args: '[descrição]' },
  { action: 'server_public', perm: BOT_PERMS.STRUCTURE, label: 'Abrir/fechar entrada pública', args: '<on|off>' },
  { action: 'make_invite', perm: BOT_PERMS.STRUCTURE, label: 'Gerar convite', args: '[horas] [fp-alvo]' },
  { action: 'react', perm: BOT_PERMS.CONTENT, label: 'Reagir a mensagem', args: '<id-da-mensagem> <emoji>' },
  { action: 'pin', perm: BOT_PERMS.CONTENT, label: 'Fixar mensagem', args: '<id-da-mensagem>' },
  { action: 'unpin', perm: BOT_PERMS.CONTENT, label: 'Desafixar mensagem', args: '<id-da-mensagem>' },
  { action: 'thread_create', perm: BOT_PERMS.CONTENT, label: 'Criar thread', args: '<nome> [tag1,tag2]' },
  { action: 'thread_archive', perm: BOT_PERMS.CONTENT, label: 'Arquivar/desarquivar thread', args: '<id-da-thread> [on|off]' },
  { action: 'poll_create', perm: BOT_PERMS.CONTENT, label: 'Criar enquete', args: '<pergunta> | <opção> | <opção>' },
  { action: 'emoji_add', perm: BOT_PERMS.CONTENT, label: 'Adicionar emoji do servidor', args: '<nome> <emoji>' },
  { action: 'emoji_del', perm: BOT_PERMS.CONTENT, label: 'Remover emoji do servidor', args: '<nome>' },
  { action: 'typing', perm: BOT_PERMS.CONTENT, label: 'Mostrar "digitando"', args: '' },
  { action: 'userinfo', perm: 0, label: 'Informações do membro', args: '<membro>' },
  { action: 'serverinfo', perm: 0, label: 'Informações do servidor', args: '' },
  { action: 'ping', perm: 0, label: 'Latência do bot', args: '' },
  { action: 'audit', perm: 0, label: 'Últimas ações da auditoria', args: '[N]' },
  { action: 'bans', perm: 0, label: 'Membros banidos', args: '' },
  { action: 'timeouts', perm: 0, label: 'Membros silenciados', args: '' },
  { action: 'channels', perm: 0, label: 'Listar canais', args: '' },
  { action: 'roles', perm: 0, label: 'Listar cargos', args: '' },
]

export function permAllows(botPerms: number, action: string): boolean {
  const def = BOT_ADMIN_ACTIONS.find((a) => a.action === action)
  if (!def) return false
  if (def.perm === 0) return true
  if ((botPerms & def.perm) !== 0) return true
  const legado = BOT_PERMS.STRUCTURE | BOT_PERMS.PURGE | BOT_PERMS.MANAGE
  return (def.perm & legado) !== 0 && (botPerms & BOT_PERMS.MANAGE) !== 0
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
  try {
    const u = new URL(url.trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    const h = u.hostname.trim().replace(/\.$/, '').toLowerCase()
    if (!h) return null
    return h.startsWith('[') ? h.slice(1, -1) : h
  } catch {
    return null
  }
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
  if (!ip) return host === '::'
  return (ip[0] === 169 && ip[1] === 254) || ip.every((n) => n === 0)
}

export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const ip = parseIPv4(host)
  if (ip) {
    if (
      ip[0] === 0 ||
      ip[0] === 10 ||
      ip[0] === 127 ||
      (ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127) ||
      (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
      (ip[0] === 192 && (ip[1] === 168 || (ip[1] === 0 && ip[2] === 2))) ||
      (ip[0] === 198 && (ip[1] === 18 || ip[1] === 19)) ||
      (ip[0] === 198 && ip[1] === 51 && ip[2] === 100) ||
      (ip[0] === 203 && ip[1] === 0 && ip[2] === 113) ||
      (ip[0] === 169 && ip[1] === 254) ||
      (ip[0] === 255 && ip[1] === 255 && ip[2] === 255 && ip[3] === 255)
    ) {
      return true
    }
    return false
  }
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (h.startsWith('::ffff:')) {
    const tail = h.slice(7)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return isPrivateHost(tail)
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail)
    if (hex) {
      const hi = parseInt(hex[1], 16)
      const lo = parseInt(hex[2], 16)
      return isPrivateHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
    }
  }
  return h === '::1' || h === '::' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
}

/** Host está na allowlist? Lista vazia = qualquer destino público. */
export function hostAllowed(url: string, allow: string[] | undefined): boolean {
  const list = (allow ?? []).filter((d) => d.trim().length > 0)
  if (list.length === 0) return true
  const host = hostOf(url)
  if (!host) return false
  return list.some((rule) => {
    const clean = rule.trim().toLowerCase().replace(/^\*\./, '')
    return host === clean || host.endsWith(`.${clean}`)
  })
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
    schema: 3,
    mode: 'declarative',
    runtime: 'none',
    primitives: defaultPrimitives(),
    prefix: '!',
    commands: [],
    channels: [],
    channelKinds: [],
    events: [],
    blockPrivate: true,
    maxRepliesPerMinute: 20,
    httpAllow: [],
    maxHttpPerMinute: 60,
    maxMessagesPerExecution: 20,
    retentionHours: 24,
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
  const schema = typeof obj.schema === 'number' ? Math.trunc(obj.schema) : 2
  if (schema < 1 || schema > 3) return null
  if (obj.mode !== undefined && !BOT_MODES.some((m) => m.id === obj.mode)) return null
  const mode: BotMode = (obj.mode as BotMode | undefined) ?? 'declarative'
  let runtime: BotRuntime = 'none'
  if (obj.runtime === 'process' || obj.runtime === 'none' || obj.runtime === 'wasm') runtime = obj.runtime
  else if (mode === 'plugin') runtime = 'process'
  // WASM ainda não existe. Recusar aqui é mais honesto que aceitar e não rodar.
  if (runtime === 'wasm') return null
  const primitives = { ...defaultPrimitives() }
  if (obj.primitives && typeof obj.primitives === 'object' && !Array.isArray(obj.primitives)) {
    for (const def of BOT_PRIMITIVES) {
      const v = (obj.primitives as Record<string, unknown>)[def.id]
      if (v !== undefined) primitives[def.id] = v === true
    }
  }
  const integ = obj.integrations && typeof obj.integrations === 'object' ? obj.integrations : {}
  const httpAllow: string[] = Array.isArray((integ as any).http?.allowDomains)
    ? (integ as any).http.allowDomains
        .filter((d: unknown): d is string => typeof d === 'string' && d.trim().length > 0 && d.length <= 253)
        .map((d: string) => d.trim().toLowerCase())
        .slice(0, 256)
    : []
  const cfg: BotConfig = {
    schema: 3,
    mode,
    runtime,
    primitives,
    prefix,
    commands: pruneByPrimitives(commands, primitives),
    channels,
    channelKinds,
    webhook,
    events,
    blockPrivate: obj.blockPrivate === undefined ? true : obj.blockPrivate !== false,
    maxRepliesPerMinute: Math.max(1, Math.min(120, numberOr(obj.maxRepliesPerMinute, 20))),
    httpAllow,
    maxHttpPerMinute: Math.max(1, Math.min(600, numberOr((integ as any).http?.maxCallsPerMinute, 60))),
    webhookSecret:
      typeof (integ as any).webhook?.secret === 'string' && (integ as any).webhook.secret.length >= 16
        ? String((integ as any).webhook.secret).slice(0, 128)
        : undefined,
    maxMessagesPerExecution: Math.max(
      1,
      Math.min(20, numberOr((integ as any).limits?.maxMessagesPerExecution, 20)),
    ),
    retentionHours: Math.max(0, Math.min(30 * 24, numberOr((integ as any).retention?.hours, 24))),
  }
  return cfg
}

/**
 * Primitiva desligada nega o comando que depende dela.
 *
 * Deixar o comando vivo responderia nada quando o membro o chamasse — pior que
 * não existir. O core faz o mesmo em `parse_config`.
 */
export function pruneByPrimitives(
  commands: BotCommandDef[],
  p: BotPrimitives,
): BotCommandDef[] {
  return commands.filter((c) => {
    const exec = c.exec ?? inferExec(c)
    if (exec === 'reply') return p.text || p.ephemeral
    if (exec === 'http') return p.http
    return true
  })
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
  const integrations: Record<string, unknown> = {
    http: { allowDomains: cfg.httpAllow ?? [], maxCallsPerMinute: cfg.maxHttpPerMinute ?? 60 },
    limits: { maxMessagesPerExecution: cfg.maxMessagesPerExecution ?? 20 },
    retention: { hours: cfg.retentionHours ?? 24 },
  }
  if (cfg.webhookSecret) {
    integrations.webhook = { signed: true }
  }
  return JSON.stringify({
    schema: 3,
    mode: cfg.mode,
    runtime: cfg.runtime,
    primitives: cfg.primitives,
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
    integrations,
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
