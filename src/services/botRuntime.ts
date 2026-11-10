import { BotEngine } from './botEngine'
import { services } from './index'

export type { BotRuntimeDeps, BotRuntimeIdentity, BotRuntimeLog } from './botEngine'
export { BotEngine } from './botEngine'

let cachedFingerprint: string | null = null

function refreshIdentityCache(): void {
  services.identityGet().then(
    (id) => {
      cachedFingerprint = id?.fingerprint ?? null
    },
    () => {},
  )
}
refreshIdentityCache()

/**
 * Instância única do runtime. Só o dono do servidor executa bots; a checagem de
 * dono acontece dentro do `BotEngine` (compara `owner_fp` com o meu).
 */
export const botRuntime = new BotEngine(
  {
    subscribe: (cb) => services.subscribe(cb),
    communitiesList: () => services.communitiesList(),
    botsList: (cid) => services.botsList(cid),
    channelList: (cid) => services.channelList(cid),
    httpFetch: (url, method, headers, body, timeoutMs, allowPrivate) =>
      services.httpFetch(url, method, headers, body, timeoutMs, allowPrivate),
    botPostMessage: (cid, channelId, botId, body) =>
      services.botPostMessage(cid, channelId, botId, body),
    botAdmin: (cid, botId, action, target, reason, number, channel) =>
      services.botAdmin
        ? services.botAdmin(cid, botId, action, target, reason, number, channel)
        : Promise.reject(new Error('execução administrativa indisponível nesta plataforma')),
    botLog: (cid, botId, level, message) =>
      services.botLogAppend
        ? services.botLogAppend(cid, botId, level, message)
        : Promise.resolve(),
    botVarGet: (cid, botId, key) =>
      services.botVarGet ? services.botVarGet(cid, botId, key) : Promise.resolve(null),
    botVarSet: (cid, botId, key, value) =>
      services.botVarSet ? services.botVarSet(cid, botId, key, value) : Promise.resolve(),
  },
  () => {
    if (!cachedFingerprint) refreshIdentityCache()
    return cachedFingerprint ? { fingerprint: cachedFingerprint } : null
  },
)
