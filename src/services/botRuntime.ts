// BotRuntime — conecta os bots configurados à web (HTTP GET/POST + webhook).
// Executa SOMENTE no dispositivo do DONO do servidor (owner_fp === identidade
// local): em mesh cada dono responde pelos próprios bots, sem duplicar.
// Nunca derruba o app: toda rede/parse é best-effort com try/catch.

import {
  parseBotConfig,
  parseBotCommand,
  channelInScope,
  findCommand,
  renderTemplate,
  renderBotReply,
  type BotCommandDef,
} from './botCommands'
import { services } from './index'

export interface BotRuntimeIdentity {
  fingerprint: string
}

interface BotRuntimeDeps {
  subscribe: (cb: (ev: any) => void) => () => void
  communitiesList: () => Promise<{ id: string; owner_fp: string }[]>
  botsList: (cid: string) => Promise<{ id: string; name: string; config?: string }[]>
  channelList: (cid: string) => Promise<{ id: string }[]>
  httpFetch: (
    url: string,
    method: 'GET' | 'POST',
    headers: Record<string, string>,
    body: string | null,
    timeoutMs: number,
  ) => Promise<{ status: number; body: string }>
  botPostMessage: (cid: string, channelId: string, botId: string, body: string) => Promise<unknown>
}

const HTTP_TIMEOUT_MS = 10_000

export class BotRuntime {
  constructor(
    private deps: BotRuntimeDeps,
    private getIdentity: () => BotRuntimeIdentity | null,
  ) {}

  /** Assina eventos de mensagem; retorna stop(). */
  start(): () => void {
    return this.deps.subscribe((ev: any) => {
      void this.handleEvent(ev)
    })
  }

  private async handleEvent(ev: any): Promise<void> {
    try {
      if (!ev || ev.type !== 'message_new') return
      // só mensagens que chegaram (não as que eu/bots postaram) — evita loop
      if (ev.direction !== 'in') return
      if (ev.bot_id) return
      const body = typeof ev.body === 'string' ? ev.body : ''
      if (!body) return
      const me = this.getIdentity()
      if (!me) return
      const convId = typeof ev.conv_id === 'string' ? ev.conv_id : ''
      if (!convId) return

      let communities: { id: string; owner_fp: string }[]
      try {
        communities = await this.deps.communitiesList()
      } catch {
        return
      }
      for (const community of communities) {
        // SOMENTE dono responde (evita resposta duplicada em mesh)
        if (community.owner_fp !== me.fingerprint) continue
        try {
          await this.handleCommunity(community.id, convId, ev)
        } catch {
          /* honesto e silencioso: nunca crasha o app */
        }
      }
    } catch {
      /* nunca crasha o app */
    }
  }

  private async handleCommunity(cid: string, convId: string, ev: any): Promise<void> {
    let bots: { id: string; name: string; config?: string }[]
    try {
      bots = await this.deps.botsList(cid)
    } catch {
      return
    }
    if (!bots || bots.length === 0) return
    let channelIds: Set<string>
    try {
      const channels = await this.deps.channelList(cid)
      channelIds = new Set((channels ?? []).map((c) => c.id))
    } catch {
      channelIds = new Set()
    }
    // conversa fora deste servidor → não é daqui
    if (channelIds.size > 0 && !channelIds.has(convId)) return

    const body: string = ev.body
    for (const bot of bots) {
      if (!bot.config) continue
      const config = parseBotConfig(bot.config)
      if (!config) continue
      if (!channelInScope(config, convId)) continue
      try {
        // webhook de saída: recebe CADA mensagem do escopo (comando ou não)
        if (config.webhook?.url) {
          await this.fireWebhook(config.webhook.url, ev, convId)
        }
        const parsed = parseBotCommand(config.prefix, body)
        if (!parsed) continue
        const cmd = findCommand(config, parsed.name)
        if (!cmd) continue
        await this.runCommand(cid, convId, bot.id, cmd, parsed.args)
      } catch {
        /* um bot quebrado não cala os outros */
      }
    }
  }

  private async fireWebhook(url: string, ev: any, convId: string): Promise<void> {
    try {
      const payload = JSON.stringify({
        author: ev.author_fp ?? '',
        nickname: ev.author_fp ?? '',
        channel: convId,
        body: typeof ev.body === 'string' ? ev.body : '',
        ts: typeof ev.ts === 'number' ? ev.ts : Date.now(),
      })
      await this.deps.httpFetch(url, 'POST', { 'content-type': 'application/json' }, payload, HTTP_TIMEOUT_MS)
    } catch {
      /* webhook é best-effort */
    }
  }

  private async runCommand(
    cid: string,
    channelId: string,
    botId: string,
    cmd: BotCommandDef,
    args: string[],
  ): Promise<void> {
    const url = renderTemplate(cmd.url, { args })
    if (!url) return
    const reqBody = cmd.method === 'POST' && cmd.body ? renderTemplate(cmd.body, { args }) : null
    let res: { status: number; body: string }
    try {
      res = await this.deps.httpFetch(url, cmd.method, cmd.headers ?? {}, reqBody, HTTP_TIMEOUT_MS)
    } catch {
      return
    }
    if (!res || typeof res.body !== 'string') return
    const reply = renderBotReply(cmd, args, res.body)
    if (!reply) return
    try {
      await this.deps.botPostMessage(cid, channelId, botId, reply)
    } catch {
      /* post falhou: sem retry (evita flood) */
    }
  }
}

// Identidade síncrona para o singleton: cache atualizado de forma best-effort.
let cachedFingerprint: string | null = null
function refreshIdentityCache(): void {
  services.identityGet().then(
    (id) => { cachedFingerprint = id?.fingerprint ?? null },
    () => { /* mantém o cache anterior */ },
  )
}
refreshIdentityCache()

/** Singleton ligado aos services reais. Chame botRuntime.start() uma vez no boot. */
export const botRuntime = new BotRuntime(
  {
    subscribe: (cb) => services.subscribe(cb),
    communitiesList: () => services.communitiesList(),
    botsList: (cid) => services.botsList(cid),
    channelList: (cid) => services.channelList(cid),
    httpFetch: (url, method, headers, body, timeoutMs) =>
      services.httpFetch(url, method, headers, body, timeoutMs),
    botPostMessage: (cid, channelId, botId, body) =>
      services.botPostMessage(cid, channelId, botId, body),
  },
  () => {
    if (!cachedFingerprint) refreshIdentityCache()
    return cachedFingerprint ? { fingerprint: cachedFingerprint } : null
  },
)
