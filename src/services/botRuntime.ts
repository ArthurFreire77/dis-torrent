import {
  parseBotConfig,
  parseBotCommand,
  channelInScope,
  findCommand,
  renderTemplate,
  renderBotReply,
  botIsActive,
  type BotCommandDef,
} from './botCommands'
import { services } from './index'

export interface BotRuntimeIdentity {
  fingerprint: string
}

interface BotRuntimeDeps {
  subscribe: (cb: (ev: any) => void) => () => void
  communitiesList: () => Promise<{ id: string; owner_fp: string }[]>
  botsList: (cid: string) => Promise<{ id: string; name: string; online?: boolean; config?: string }[]>
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

  start(): () => void {
    return this.deps.subscribe((ev: any) => {
      void this.handleEvent(ev)
    })
  }

  private async handleEvent(ev: any): Promise<void> {
    try {
      if (!ev || ev.type !== 'message_new') return
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
        if (community.owner_fp !== me.fingerprint) continue
        try {
          await this.handleCommunity(community.id, convId, ev)
        } catch {}
      }
    } catch {}
  }

  private async handleCommunity(cid: string, convId: string, ev: any): Promise<void> {
    let bots: { id: string; name: string; online?: boolean; config?: string }[]
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
    if (channelIds.size > 0 && !channelIds.has(convId)) return

    const body: string = ev.body
    for (const bot of bots) {
      if (!bot.config) continue
      if (!botIsActive(bot.online)) continue
      const config = parseBotConfig(bot.config)
      if (!config) continue
      if (!channelInScope(config, convId)) continue
      try {
        if (config.webhook?.url) {
          await this.fireWebhook(config.webhook.url, ev, convId)
        }
        const parsed = parseBotCommand(config.prefix, body)
        if (!parsed) continue
        const cmd = findCommand(config, parsed.name)
        if (!cmd) continue
        await this.runCommand(cid, convId, bot.id, cmd, parsed.args)
      } catch {}
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
    } catch {}
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
    } catch {}
  }
}

let cachedFingerprint: string | null = null
function refreshIdentityCache(): void {
  services.identityGet().then(
    (id) => { cachedFingerprint = id?.fingerprint ?? null },
    () => {  },
  )
}
refreshIdentityCache()

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
// Seção 1: fim
