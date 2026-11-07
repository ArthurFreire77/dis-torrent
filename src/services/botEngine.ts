import {
  parseBotConfig,
  parseBotCommand,
  renderTemplate,
  renderBotReply,
  channelInScope,
  kindInScope,
  findCommand,
  botIsActive,
  normalizeBotCommandName,
  urlProblem,
  hostAllowed,
  permAllows,
  BOT_MAX_COOLDOWN_MS,
  BOT_MAX_SCRIPT_LINES,
  type BotChannelKind,
  BOT_MAX_REPLY,
  type BotCommandDef,
  type BotConfig,
} from './botCommands.ts'
import { sanitizeText } from '../core/security/sanitize.ts'
import { buildWebhook } from './botWebhook.ts'

/**
 * Núcleo executável do bot, sem importar `services`.
 *
 * Aqui mora a regra que decide O QUE fazer com um evento; quem chama define
 * como postar, chamar HTTP e executar admin. Isso mantém a lógica testável no
 * `node --test` (o `botRuntime.ts`, que importa `services`, não é).
 */

export interface BotRuntimeIdentity {
  fingerprint: string
}

export interface BotRuntimeDeps {
  subscribe: (cb: (ev: any) => void) => () => void
  communitiesList: () => Promise<{ id: string; owner_fp: string; name?: string }[]>
  botsList: (cid: string) => Promise<
    {
      id: string
      name: string
      online?: boolean
      config?: string
      perms?: number
      /** Segredo local do HMAC do webhook (nunca sincronizado). */
      webhook_secret?: string
    }[]
  >
  channelList: (cid: string) => Promise<{ id: string; name?: string; kind?: string }[]>
  httpFetch: (
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | null,
    timeoutMs: number,
    allowPrivate?: boolean,
  ) => Promise<{ status: number; body: string }>
  botPostMessage: (cid: string, channelId: string, botId: string, body: string) => Promise<unknown>
  botAdmin: (
    cid: string,
    botId: string,
    action: string,
    target: string,
    reason: string,
    number: number | null,
    channel?: string,
  ) => Promise<string>
  botLog: (cid: string, botId: string, level: string, message: string) => Promise<unknown>
  botVarGet: (cid: string, botId: string, key: string) => Promise<string | null>
  botVarSet: (cid: string, botId: string, key: string, value: string) => Promise<void>
}

export interface BotRuntimeLog {
  at: number
  cid: string
  botId: string
  level: 'info' | 'warn' | 'error'
  message: string
}

const HTTP_TIMEOUT_MS = 10_000
const RATE_WINDOW_MS = 60_000
const MAX_REPLY_CHARS = BOT_MAX_REPLY

interface RateState {
  stamps: number[]
}

export class BotEngine {
  private logs: BotRuntimeLog[] = []
  private rate = new Map<string, RateState>()
  private cooldownMap = new Map<string, number>()
  private onLog: ((l: BotRuntimeLog) => void) | null = null
  private started = false
  private deps: BotRuntimeDeps
  private getIdentity: () => BotRuntimeIdentity | null
  private now: () => number

  constructor(
    deps: BotRuntimeDeps,
    getIdentity: () => BotRuntimeIdentity | null,
    now: () => number = () => Date.now(),
  ) {
    this.deps = deps
    this.getIdentity = getIdentity
    this.now = now
  }

  setLogSink(cb: ((l: BotRuntimeLog) => void) | null): void {
    this.onLog = cb
  }

  recentLogs(): BotRuntimeLog[] {
    return [...this.logs]
  }

  isRunning(): boolean {
    return this.started
  }

  start(): () => void {
    this.started = true
    const unsub = this.deps.subscribe((ev: any) => {
      void this.handleEvent(ev)
    })
    return () => {
      this.started = false
      this.rate.clear()
      this.cooldownMap.clear()
      try {
        unsub()
      } catch {}
    }
  }

  private log(cid: string, botId: string, level: BotRuntimeLog['level'], message: string): void {
    const entry: BotRuntimeLog = { at: this.now(), cid, botId, level, message }
    this.logs.push(entry)
    if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300)
    try {
      this.onLog?.(entry)
    } catch {}
    // Espelha no banco para o console sobreviver a um reload do painel.
    void this.deps.botLog(cid, botId, level, message).catch(() => {})
  }

  /** Rate limit por bot: no máximo `max` respostas na janela de 1 minuto. */
  private rateAllows(cid: string, botId: string, max: number): boolean {
    const key = `${cid}|${botId}`
    const st = this.rate.get(key) ?? { stamps: [] }
    const t = this.now()
    st.stamps = st.stamps.filter((s) => t - s < RATE_WINDOW_MS)
    if (st.stamps.length >= max) {
      this.rate.set(key, st)
      return false
    }
    st.stamps.push(t)
    this.rate.set(key, st)
    return true
  }

  private cooldownAllows(
    cid: string,
    botId: string,
    cmd: string,
    author: string,
    ms: number,
  ): boolean {
    if (ms <= 0) return true
    const key = `${cid}|${botId}|${cmd}|${author}`
    const last = this.cooldownMap.get(key) ?? 0
    const t = this.now()
    if (t - last < Math.min(ms, BOT_MAX_COOLDOWN_MS)) return false
    this.cooldownMap.set(key, t)
    // Limpeza simples: evita mapa infinito em servidor movimentado.
    if (this.cooldownMap.size > 4000) {
      for (const [k, ts] of this.cooldownMap) {
        if (t - ts > BOT_MAX_COOLDOWN_MS) this.cooldownMap.delete(k)
      }
    }
    return true
  }

  private async handleEvent(ev: any): Promise<void> {
    if (!ev || typeof ev !== 'object') return
    const type = typeof ev.type === 'string' ? ev.type : ''
    if (!type) return
    const me = this.getIdentity()
    if (!me) return

    let communities: { id: string; owner_fp: string }[]
    try {
      communities = await this.deps.communitiesList()
    } catch {
      return
    }
    for (const community of communities) {
      if (community.owner_fp !== me.fingerprint) continue
      try {
        if (type === 'message_new') await this.onMessage(community.id, ev)
        else await this.onOtherEvent(community.id, type, ev)
      } catch (e: unknown) {
        this.log(
          community.id,
          typeof ev.bot_id === 'string' ? ev.bot_id : '',
          'error',
          `evento ${type}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  private async channelIndex(cid: string): Promise<Map<string, BotChannelKind>> {
    try {
      const channels = await this.deps.channelList(cid)
      const map = new Map<string, BotChannelKind>()
      for (const c of channels ?? []) {
        if (typeof c.id !== 'string') continue
        map.set(c.id, (c.kind ?? 'text') as BotChannelKind)
      }
      return map
    } catch {
      return new Map()
    }
  }

  /** Mensagem: comando com prefixo E entrega de evento `message_new`. */
  private async onMessage(cid: string, ev: any): Promise<void> {
    if (ev.direction !== 'in') return
    if (ev.bot_id) return
    const body = typeof ev.body === 'string' ? ev.body : ''
    if (!body) return
    const convId = typeof ev.conv_id === 'string' ? ev.conv_id : ''
    if (!convId) return

    let bots: { id: string; name: string; online?: boolean; config?: string; perms?: number; webhook_secret?: string }[]
    try {
      bots = await this.deps.botsList(cid)
    } catch {
      return
    }
    if (!bots || bots.length === 0) return
    const ids = await this.channelIndex(cid)
    if (ids.size > 0 && !ids.has(convId)) return
    const kind = ids.get(convId)

    const author = typeof ev.author_fp === 'string' ? ev.author_fp : ''
    for (const bot of bots) {
      if (!bot.config) continue
      if (!botIsActive(bot.online)) continue
      const config = parseBotConfig(bot.config)
      if (!config) {
        this.log(cid, bot.id, 'warn', 'config inválida — o bot foi ignorado')
        continue
      }
      if (!channelInScope(config, convId)) continue
      if (!kindInScope(config, kind)) continue

      if (config.webhook?.url || config.events.includes('message_new')) {
        await this.deliverEvent(cid, bot, config, 'message_new', {
          channel: convId,
          author,
          body,
          ts: typeof ev.ts === 'number' ? ev.ts : this.now(),
          mention: this.mentionsBot(body, bot),
          // Sem o id, o bot não consegue reagir/apagar/fixar o que recebeu.
          message_id: typeof ev.id === 'string' ? ev.id : '',
        })
      }

      const parsed = parseBotCommand(config.prefix, body)
      if (!parsed) continue
      const cmd = findCommand(config, parsed.name)
      if (!cmd) continue

      if (cmd.permission && !this.authorAllowed(cmd, bot, ev)) {
        this.log(
          cid,
          bot.id,
          'warn',
          `/${cmd.name} recusado: ${author} não tem permissão (${cmd.permission})`,
        )
        continue
      }
      if (!this.cooldownAllows(cid, bot.id, cmd.name, author, cmd.cooldownMs ?? 0)) {
        this.log(cid, bot.id, 'info', `/${cmd.name} em cooldown para ${author}`)
        continue
      }
      if (!this.rateAllows(cid, bot.id, config.maxRepliesPerMinute)) {
        this.log(
          cid,
          bot.id,
          'warn',
          `limite de ${config.maxRepliesPerMinute} respostas/min atingido`,
        )
        continue
      }
      try {
        await this.runCommand(cid, convId, bot, config, cmd, parsed.args, author, ev)
      } catch (e: unknown) {
        this.log(
          cid,
          bot.id,
          'error',
          `/${cmd.name}: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }
  }

  /** Eventos que não nascem de mensagem. */
  private async onOtherEvent(cid: string, type: string, ev: any): Promise<void> {
    const eventId = this.mapEngineEvent(type, ev)
    if (!eventId) return
    let bots: { id: string; name: string; online?: boolean; config?: string; perms?: number; webhook_secret?: string }[]
    try {
      bots = await this.deps.botsList(cid)
    } catch {
      return
    }
    const convId =
      typeof ev.conv_id === 'string'
        ? ev.conv_id
        : typeof ev.channel_id === 'string'
          ? ev.channel_id
          : ''
    const ids = await this.channelIndex(cid)
    const kind = convId ? ids.get(convId) : undefined
    for (const bot of bots) {
      if (!bot.config || !botIsActive(bot.online)) continue
      const config = parseBotConfig(bot.config)
      if (!config) continue
      if (!config.events.includes(eventId)) continue
      if (convId && !channelInScope(config, convId)) continue
      if (!kindInScope(config, kind)) continue
      if (ids.size > 0 && convId && !ids.has(convId)) continue
      await this.deliverEvent(cid, bot, config, eventId, this.eventPayload(eventId, ev))
    }
  }

  private mapEngineEvent(type: string, ev: any): string | null {
    switch (type) {
      case 'message_edited':
        return 'message_edited'
      case 'message_deleted':
        return 'message_deleted'
      case 'reaction_changed':
        return 'reaction'
      case 'member_joined':
        return 'member_joined'
      case 'member_left':
        return 'member_left'
      case 'channel_created':
        return 'channel_created'
      case 'channel_deleted':
        return 'channel_deleted'
      case 'voice_joined':
        return 'voice_joined'
      case 'voice_left':
        return 'voice_left'
      case 'call_room': {
        const state = typeof ev.state === 'string' ? ev.state : ''
        return state === 'closed' ? 'call_ended' : 'call_started'
      }
      default:
        return null
    }
  }

  private eventPayload(eventId: string, ev: any): Record<string, unknown> {
    const base = {
      channel: ev.conv_id ?? ev.channel_id ?? '',
      author: ev.author_fp ?? ev.fp ?? ev.reactor_fp ?? '',
      at: this.now(),
    }
    switch (eventId) {
      case 'message_edited':
        return { ...base, message_id: ev.msg_id, body: ev.body ?? '' }
      case 'message_deleted':
        return { ...base, message_id: ev.msg_id }
      case 'reaction':
        return { ...base, message_id: ev.msg_id, emoji: ev.emoji ?? '', added: ev.add !== false }
      case 'member_joined':
      case 'member_left':
        return { ...base, fp: ev.fp ?? '', nickname: ev.nickname ?? '' }
      case 'channel_created':
        return { ...base, channel_id: ev.channel_id ?? '', name: ev.name ?? '' }
      case 'channel_deleted':
        return { ...base, channel_id: ev.channel_id ?? '' }
      case 'voice_joined':
      case 'voice_left':
        return { ...base, channel_id: ev.channel_id ?? '', fp: ev.fp ?? '' }
      case 'call_started':
      case 'call_ended':
        return {
          ...base,
          channel: ev.conv_id ?? '',
          call_id: ev.call_id ?? '',
          participants: Array.isArray(ev.participants) ? ev.participants : [],
        }
      default:
        return base
    }
  }

  /**
   * Webhook (POST) + script de evento. Sem rede quando não há nada a fazer.
   *
   * Retry exponencial curto (2 tentativas): endpois instável do criador perde
   * evento em silêncio hoje. O 5xx agora vira `warn` no console em vez de
   * desaparecer, e o corpo vai assinado quando há segredo configurado.
   */
  private async deliverEvent(
    cid: string,
    bot: { id: string; name: string; perms?: number; webhook_secret?: string },
    config: BotConfig,
    eventId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const payloadFull = { event: eventId, bot: bot.name, ...payload }
    if (config.webhook?.url) {
      const problem = urlProblem(config.webhook.url, config.blockPrivate)
      if (problem) {
        this.log(cid, bot.id, 'warn', `webhook ignorado: ${problem}`)
      } else {
        const delivery = `${cid}:${bot.id}:${eventId}:${this.now()}`
        const { body, headers } = buildWebhook(
          eventId,
          payloadFull,
          bot.webhook_secret || undefined,
          delivery,
          Math.floor(this.now() / 1000),
        )
        let lastStatus = 0
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const res = await this.deps.httpFetch(
              config.webhook.url,
              'POST',
              headers,
              body,
              HTTP_TIMEOUT_MS,
              !config.blockPrivate,
            )
            lastStatus = res.status
            if (res.status < 400) break
            if (res.status < 500) break
          } catch (e: unknown) {
            this.log(cid, bot.id, 'warn', `webhook falhou: ${e instanceof Error ? e.message : e}`)
          }
        }
        if (lastStatus >= 500) {
          this.log(cid, bot.id, 'warn', `webhook respondeu HTTP ${lastStatus} (evento ${eventId})`)
        } else if (lastStatus >= 400) {
          this.log(cid, bot.id, 'warn', `webhook recusou o evento (HTTP ${lastStatus})`)
        }
      }
    }
    const hook = config.commands.find(
      (c) => c.enabled !== false && c.exec === 'script' && c.name === eventId,
    )
    if (hook) {
      try {
        await this.runScript(cid, bot, config, hook, [], '', payloadFull)
      } catch (e: unknown) {
        this.log(
          cid,
          bot.id,
          'error',
          `evento ${eventId}: ${e instanceof Error ? e.message : e}`,
        )
      }
    }
  }

  private mentionsBot(body: string, bot: { id: string; name: string }): boolean {
    const b = body.toLowerCase()
    return b.includes(`@${bot.name.toLowerCase()}`) || b.includes(bot.id.toLowerCase())
  }

  /**
   * Autor tem a permissão exigida? A checagem final é sempre do core em
   * `bot_admin`; aqui cortamos cedo para não gastar rede à toa.
   */
  private authorAllowed(
    cmd: BotCommandDef,
    bot: { perms?: number },
    ev: any,
  ): boolean {
    const need = cmd.permission
    if (!need) return true
    if (need === 'owner') return ev?.author_is_owner === true
    const perms = typeof bot.perms === 'number' ? bot.perms : 0
    if (need === 'moderate') return permAllows(perms, 'warn') || perms === 0
    if (need === 'manage') return permAllows(perms, 'kick') || perms === 0
    return true
  }

  private async runCommand(
    cid: string,
    channelId: string,
    bot: { id: string; name: string; perms?: number },
    config: BotConfig,
    cmd: BotCommandDef,
    args: string[],
    author: string,
    ev?: any,
  ): Promise<void> {
    const started = this.now()
    switch (cmd.exec) {
      case 'reply': {
        const text = renderTemplate(cmd.reply ?? '', { args })
        await this.post(cid, channelId, bot, cmd, text)
        this.log(cid, bot.id, 'info', `/${cmd.name} respondeu (${this.now() - started}ms)`)
        return
      }
      case 'admin': {
        await this.runAdmin(cid, channelId, bot, cmd, args, author)
        return
      }
      case 'script': {
        const evt = {
          channel: channelId,
          author,
          message_id: typeof ev?.id === 'string' ? ev.id : '',
          mention: this.mentionsBot(String(ev?.body ?? ''), bot),
        }
        await this.runScript(cid, bot, config, cmd, args, author, evt, channelId)
        return
      }
      default:
        await this.runHttp(cid, channelId, bot, cmd, args, config)
    }
  }

  private async runHttp(
    cid: string,
    channelId: string,
    bot: { id: string; name: string },
    cmd: BotCommandDef,
    args: string[],
    config?: BotConfig,
  ): Promise<void> {
    const problem = urlProblem(cmd.url, config?.blockPrivate ?? true)
    if (problem) {
      this.log(cid, bot.id, 'warn', `/${cmd.name}: ${problem}`)
      return
    }
    const url = renderTemplate(cmd.url, { args })
    if (config && !hostAllowed(url, config.httpAllow)) {
      this.log(
        cid,
        bot.id,
        'warn',
        `/${cmd.name}: domínio fora da allowlist (${url.slice(0, 60)})`,
      )
      return
    }
    const reqBody = cmd.method === 'POST' && cmd.body ? renderTemplate(cmd.body, { args }) : null
    let res: { status: number; body: string }
    try {
      res = await this.deps.httpFetch(
        url,
        cmd.method,
        cmd.headers ?? {},
        reqBody,
        HTTP_TIMEOUT_MS,
        !(config?.blockPrivate ?? true),
      )
    } catch (e: unknown) {
      this.log(cid, bot.id, 'error', `/${cmd.name}: ${e instanceof Error ? e.message : e}`)
      return
    }
    if (!res || typeof res.body !== 'string') return
    if (res.status >= 400) {
      this.log(cid, bot.id, 'warn', `/${cmd.name}: HTTP ${res.status}`)
      return
    }
    const reply = renderBotReply(cmd, args, res.body)
    if (!reply) {
      this.log(cid, bot.id, 'warn', `/${cmd.name}: resposta vazia (responsePath/template)`)
      return
    }
    await this.post(cid, channelId, bot, cmd, reply)
    this.log(cid, bot.id, 'info', `/${cmd.name}: HTTP ${res.status}`)
  }

  private async runAdmin(
    cid: string,
    channelId: string,
    bot: { id: string; name: string; perms?: number },
    cmd: BotCommandDef,
    args: string[],
    author: string,
  ): Promise<void> {
    const action = cmd.admin ?? ''
    if (!action) return
    const botPerms = typeof bot.perms === 'number' ? bot.perms : 0
    if (!permAllows(botPerms, action)) {
      const msg = `o bot não tem permissão para /${action} — o dono precisa conceder no painel`
      this.log(cid, bot.id, 'warn', msg)
      await this.post(cid, channelId, bot, cmd, msg)
      return
    }
    const target = args[0] ?? ''
    const reason = args.slice(1).join(' ')
    const number = this.numericArg(action, args)
    try {
      const out = await this.deps.botAdmin(cid, bot.id, action, target, reason, number, channelId)
      this.log(cid, bot.id, 'info', `/${action} por ${author}: ${out}`)
      if (out) await this.post(cid, channelId, bot, cmd, out)
    } catch (e: unknown) {
      this.log(cid, bot.id, 'error', `/${action}: ${e instanceof Error ? e.message : e}`)
    }
  }

  private numericArg(action: string, args: string[]): number | null {
    // `/mute @x 10 motivo` → 10 minutos; `/slowmode #canal 30` → 30s.
    if (action === 'mute' || action === 'slowmode' || action === 'clear') {
      const n = Number(args[1])
      if (Number.isFinite(n) && n >= 0) return Math.trunc(n)
    }
    // `/make_invite 48` e `/audit 20` têm o número como primeiro argumento.
    if (action === 'make_invite' || action === 'audit') {
      const n = Number(args[0])
      if (Number.isFinite(n) && n >= 0) return Math.trunc(n)
    }
    return null
  }

  private async post(
    cid: string,
    channelId: string,
    bot: { id: string },
    cmd: BotCommandDef,
    text: string,
  ): Promise<void> {
    const clean = sanitizeText(text, MAX_REPLY_CHARS)
    if (!clean) return
    const body = cmd.ephemeral ? `-# ${clean}` : clean
    try {
      await this.deps.botPostMessage(cid, channelId, bot.id, body)
    } catch (e: unknown) {
      this.log(cid, bot.id, 'error', `post falhou: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Executa a DSL do script com rede e variáveis persistentes do bot. */
  private async runScript(
    cid: string,
    bot: { id: string; name: string; perms?: number },
    config: BotConfig,
    cmd: BotCommandDef,
    args: string[],
    author: string,
    event?: Record<string, unknown>,
    replyChannel?: string,
  ): Promise<void> {
    const src = cmd.script ?? ''
    if (!src.trim()) return
    const lines = src.split('\n').slice(0, BOT_MAX_SCRIPT_LINES)
    const replies: { text: string; ephemeral: boolean }[] = []
    const admins: { action: string; target: string; reason: string; number: number | null }[] = []
    const vars = new Map<string, string>()
    let httpCalls = 0
    let stopped = false

    const renderExpr = (tpl: string): string =>
      tpl.replace(/\{\{\s*([\w.:-]+)\s*\}\}/g, (_m, key: string) => {
        if (key === 'raw.args') return args.join(' ')
        if (key === 'args') return args.map((a) => encodeURIComponent(a)).join('/')
        if (key === 'author') return author
        if (key === 'bot') return bot.name
        if (key === 'channel') return String(event?.channel ?? '')
        if (key === 'mention') return String(event?.mention ?? '')
        if (key.startsWith('arg')) {
          const i = Number(key.slice(3))
          return Number.isInteger(i) ? (args[i] ?? '') : ''
        }
        if (key.startsWith('event.')) {
          const v = event?.[key.slice(6)]
          return v === undefined || v === null ? '' : String(v)
        }
        return vars.get(key) ?? ''
      })

    const resolveValue = (expr: string): string => {
      const t = expr.trim().replace(/^"|"$/g, '')
      if (t === 'args') return args.join(' ')
      if (t === 'raw.args') return args.join(' ')
      if (t === 'author') return author
      if (t === 'bot') return bot.name
      if (t === 'channel') return String(event?.channel ?? replyChannel ?? '')
      if (t.startsWith('event.')) {
        const v = event?.[t.slice(6)]
        return v === undefined || v === null ? '' : String(v)
      }
      if (t.startsWith('arg')) {
        const i = Number(t.slice(3))
        if (Number.isInteger(i)) return args[i] ?? ''
      }
      return vars.get(normalizeBotCommandName(t)) ?? vars.get(t) ?? ''
    }

    const evalCond = (raw: string): boolean => {
      const s = raw.trim()
      const lower = s.toLowerCase()
      const ops: [string, (a: string, b: string) => boolean][] = [
        [' contains ', (a, b) => a.includes(b)],
        [' startswith ', (a, b) => a.startsWith(b)],
        [' == ', (a, b) => a === b],
        [' != ', (a, b) => a !== b],
        [' >= ', (a, b) => Number(a) >= Number(b)],
        [' <= ', (a, b) => Number(a) <= Number(b)],
        [' > ', (a, b) => Number(a) > Number(b)],
        [' < ', (a, b) => Number(a) < Number(b)],
      ]
      for (const [op, fn] of ops) {
        const pos = lower.indexOf(op)
        if (pos >= 0) {
          const a = resolveValue(renderExpr(s.slice(0, pos)))
          const b = resolveValue(renderExpr(s.slice(pos + op.length)))
          return fn(a, b)
        }
      }
      if (lower.endsWith(' is empty')) {
        const left = s.slice(0, s.length - ' is empty'.length)
        return resolveValue(renderExpr(left)).trim() === ''
      }
      if (lower.endsWith(' is not empty')) {
        const left = s.slice(0, s.length - ' is not empty'.length)
        return resolveValue(renderExpr(left)).trim() !== ''
      }
      if (lower === 'true') return true
      if (lower === 'false') return false
      const v = resolveValue(renderExpr(s)).trim()
      return v !== '' && v !== '0' && v.toLowerCase() !== 'false'
    }

    let i = 0
    let guard = 0
    while (i < lines.length && !stopped) {
      guard += 1
      if (guard > 2000) {
        this.log(cid, bot.id, 'error', 'script excedeu o limite de execução')
        break
      }
      const rawLine = lines[i]
      const line = rawLine.split(' # ')[0].trim()
      i += 1
      if (!line || line.startsWith('#') || line.startsWith('//')) continue
      const [kw, ...restParts] = line.split(/\s+/)
      const rest = restParts.join(' ').trim()
      const keyword = kw.toLowerCase()
      if (keyword === 'if') {
        if (evalCond(rest)) continue
        let depth = 0
        let target = lines.length
        let fromElse = false
        for (let j = i; j < lines.length; j += 1) {
          const l = lines[j].split(' # ')[0].trim().toLowerCase()
          if (l === 'if' || l.startsWith('if ')) depth += 1
          else if (l === 'end' || l === 'endif') {
            if (depth === 0) {
              target = j
              break
            }
            depth -= 1
          } else if (l === 'else' && depth === 0) {
            target = j
            fromElse = true
            break
          }
        }
        i = fromElse ? target + 1 : target + 1
        continue
      }
      if (keyword === 'else') {
        let depth = 0
        let target = lines.length - 1
        for (let j = i; j < lines.length; j += 1) {
          const l = lines[j].split(' # ')[0].trim().toLowerCase()
          if (l === 'if' || l.startsWith('if ')) depth += 1
          else if (l === 'end' || l === 'endif') {
            if (depth === 0) {
              target = j
              break
            }
            depth -= 1
          }
        }
        i = target + 1
        continue
      }
      if (keyword === 'end' || keyword === 'endif') continue
      if (keyword === 'stop') {
        stopped = true
        break
      }
      if (keyword === 'reply' || keyword === 'ephemeral') {
        const tpl = rest.replace(/^"|"$/g, '')
        const text = sanitizeText(renderExpr(tpl), MAX_REPLY_CHARS)
        if (text && replies.length < 8) replies.push({ text, ephemeral: keyword === 'ephemeral' })
        continue
      }
      if (keyword === 'let' || keyword === 'set') {
        const eq = rest.indexOf('=')
        if (eq > 0) {
          const name = normalizeBotCommandName(rest.slice(0, eq))
          if (name) vars.set(name, renderExpr(rest.slice(eq + 1)).trim().replace(/^"|"$/g, ''))
        }
        continue
      }
      if (keyword === 'getvar') {
        const eq = rest.indexOf('=')
        if (eq > 0) {
          const name = normalizeBotCommandName(rest.slice(0, eq))
          const key = rest.slice(eq + 1).trim().replace(/^"|"$/g, '')
          try {
            const v = await this.deps.botVarGet(cid, bot.id, key)
            if (name) vars.set(name, v ?? '')
          } catch {}
        }
        continue
      }
      if (keyword === 'setvar') {
        const eq = rest.indexOf('=')
        if (eq > 0) {
          const key = rest.slice(0, eq).trim().replace(/^"|"$/g, '')
          const value = renderExpr(rest.slice(eq + 1)).trim().replace(/^"|"$/g, '')
          try {
            await this.deps.botVarSet(cid, bot.id, key, value)
            vars.set(key, value)
          } catch (e: unknown) {
            this.log(cid, bot.id, 'warn', `setvar ${key}: ${e instanceof Error ? e.message : e}`)
          }
        }
        continue
      }
      if (keyword === 'incvar') {
        const plus = rest.lastIndexOf('+')
        const key = (plus > 0 ? rest.slice(0, plus) : rest).trim().replace(/^"|"$/g, '')
        const by = plus > 0 ? renderExpr(rest.slice(plus + 1)).trim() : '1'
        try {
          const cur = Number((await this.deps.botVarGet(cid, bot.id, key)) ?? '0')
          const next = String((Number.isFinite(cur) ? cur : 0) + (Number(by) || 0))
          await this.deps.botVarSet(cid, bot.id, key, next)
          vars.set(key, next)
        } catch (e: unknown) {
          this.log(cid, bot.id, 'warn', `incvar ${key}: ${e instanceof Error ? e.message : e}`)
        }
        continue
      }
      if (keyword === 'http') {
        const m = /^(get|post)\s+(.+)$/i.exec(rest)
        if (!m) {
          this.log(cid, bot.id, 'warn', `linha http inválida: ${line}`)
          continue
        }
        const method = m[1].toUpperCase() === 'POST' ? 'POST' : 'GET'
        let tail = m[2].trim()
        let into = 'res'
        const asMatch = /\s+as\s+([\w-]+)$/i.exec(tail)
        if (asMatch) {
          into = normalizeBotCommandName(asMatch[1]) || 'res'
          tail = tail.slice(0, asMatch.index).trim()
        }
        let body: string | null = null
        const bodyPos = tail.indexOf(' body ')
        let urlPart = tail
        if (bodyPos >= 0) {
          urlPart = tail.slice(0, bodyPos).trim()
          body = renderExpr(tail.slice(bodyPos + 6)).trim().replace(/^"|"$/g, '')
        }
        const url = renderExpr(urlPart).trim().replace(/^"|"$/g, '')
        const problem = urlProblem(url, config.blockPrivate)
        if (problem) {
          this.log(cid, bot.id, 'warn', `http bloqueado: ${problem}`)
          vars.set(`${into}.status`, '0')
          continue
        }
        if (!hostAllowed(url, config.httpAllow)) {
          this.log(cid, bot.id, 'warn', `http bloqueado: domínio fora da allowlist`)
          vars.set(`${into}.status`, '0')
          continue
        }
        try {
          const res = await this.deps.httpFetch(
            url,
            method,
            body ? { 'content-type': 'application/json' } : {},
            body,
            HTTP_TIMEOUT_MS,
            !config.blockPrivate,
          )
          httpCalls += 1
          vars.set(`${into}.status`, String(res.status))
          vars.set(into, res.body)
          try {
            const parsed = JSON.parse(res.body)
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              for (const [k, v] of Object.entries(parsed).slice(0, 64)) {
                vars.set(`${into}.${k}`, typeof v === 'string' ? v : JSON.stringify(v))
              }
            }
            vars.set(`${into}.json`, JSON.stringify(parsed))
          } catch {}
        } catch (e: unknown) {
          this.log(
            cid,
            bot.id,
            'warn',
            `http ${url.slice(0, 60)}: ${e instanceof Error ? e.message : e}`,
          )
          vars.set(`${into}.status`, '0')
        }
        continue
      }
      if (keyword === 'admin') {
        const parts = rest.split(/\s+/)
        const action = (parts[0] ?? '').toLowerCase()
        const target = renderExpr(parts[1] ?? '').trim().replace(/^"|"$/g, '')
        const reason = renderExpr(parts.slice(2).join(' ')).trim().replace(/^"|"$/g, '')
        const number = target && Number.isFinite(Number(target)) ? Number(target) : null
        admins.push({ action, target, reason, number })
        continue
      }
      this.log(cid, bot.id, 'warn', `instrução desconhecida: ${keyword}`)
    }

    for (const r of replies) {
      const body = r.ephemeral ? `-# ${r.text}` : r.text
      const channel = replyChannel ?? String(event?.channel ?? '')
      if (!channel) {
        // Script de evento sem canal: a resposta fica no console.
        this.log(cid, bot.id, 'info', `resposta do script: ${r.text}`)
        continue
      }
      try {
        await this.deps.botPostMessage(cid, channel, bot.id, body)
      } catch (e: unknown) {
        this.log(cid, bot.id, 'error', `post do script: ${e instanceof Error ? e.message : e}`)
      }
    }
    for (const a of admins) {
      if (!permAllows(bot.perms ?? 0, a.action)) {
        this.log(cid, bot.id, 'warn', `script pediu /${a.action} sem permissão`)
        continue
      }
      try {
        const channel = replyChannel ?? String(event?.channel ?? '')
        const out = await this.deps.botAdmin(
          cid,
          bot.id,
          a.action,
          a.target,
          a.reason,
          a.number,
          channel || undefined,
        )
        this.log(cid, bot.id, 'info', `/admin ${a.action}: ${out}`)
        if (out && channel) {
          await this.deps.botPostMessage(cid, channel, bot.id, out).catch(() => {})
        }
      } catch (e: unknown) {
        this.log(cid, bot.id, 'error', `/admin ${a.action}: ${e instanceof Error ? e.message : e}`)
      }
    }
    this.log(
      cid,
      bot.id,
      'info',
      `script ${cmd.name}: ${replies.length} resposta(s), ${httpCalls} http, ${admins.length} admin`,
    )
  }
}
