import test from 'node:test'
import assert from 'node:assert/strict'
import { BotEngine, type BotRuntimeDeps } from '../src/services/botEngine.ts'
import { serializeBotConfig, type BotConfig } from '../src/services/botCommands.ts'

type Ev = Record<string, unknown>

function makeDeps(over: Partial<BotRuntimeDeps> = {}) {
  const posted: { cid: string; channel: string; bot: string; body: string }[] = []
  const admin: { action: string; target: string; reason: string; number: number | null }[] = []
  const logs: { level: string; message: string }[] = []
  const vars = new Map<string, string>()
  const fetchCalls: string[] = []
  const listeners: ((ev: Ev) => void)[] = []
  let bots: { id: string; name: string; online?: boolean; config?: string; perms?: number }[] = []

  const deps: BotRuntimeDeps = {
    subscribe: (cb) => {
      listeners.push(cb)
      return () => {
        const i = listeners.indexOf(cb)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    communitiesList: async () => [{ id: 'srv', owner_fp: 'me' }],
    botsList: async () => bots,
    channelList: async () => [{ id: 'geral', name: 'geral', kind: 'text' }],
    communityMembers: async () => [],
    httpFetch: async (url) => {
      fetchCalls.push(url)
      return { status: 200, body: JSON.stringify({ logradouro: 'Rua A', uf: 'SP' }) }
    },
    botPostMessage: async (cid, channel, bot, body) => {
      posted.push({ cid, channel, bot, body })
      return {}
    },
    botAdmin: async (_cid, _bot, action, target, reason, number) => {
      admin.push({ action, target, reason, number })
      return `${action} ok`
    },
    botLog: async (_cid, _bot, level, message) => {
      logs.push({ level, message })
    },
    botVarGet: async (_cid, _bot, key) => vars.get(key) ?? null,
    botVarSet: async (_cid, _bot, key, value) => {
      vars.set(key, value)
    },
    ...over,
  }

  return {
    deps,
    posted,
    admin,
    logs,
    vars,
    fetchCalls,
    setBots: (b: typeof bots) => {
      bots = b
    },
    emit: (ev: Ev) => {
      for (const cb of listeners) cb(ev)
    },
    listeners,
  }
}

function cfg(partial: Partial<BotConfig>): string {
  return serializeBotConfig({
    prefix: '!',
    commands: [],
    channels: [],
    events: [],
    blockPrivate: true,
    maxRepliesPerMinute: 20,
    ...partial,
  })
}

/** Espera as promises pendentes do handler assíncrono. */
const tick = () => new Promise((r) => setTimeout(r, 12))

function runtime(deps: BotRuntimeDeps, now?: () => number) {
  return new BotEngine(deps, () => ({ fingerprint: 'me' }), now ?? (() => Date.now()))
}

test('runtime: comando de resposta fixa posta no canal', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Ajuda',
      online: true,
      config: cfg({ commands: [{ name: 'ajuda', method: 'GET', url: '', exec: 'reply', reply: 'olá {{raw.args}}' }] }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ajuda mundo' })
  await tick()
  stop()
  assert.equal(d.posted.length, 1)
  assert.equal(d.posted[0].body, 'olá mundo')
  assert.equal(d.posted[0].bot, 'b1')
})

test('runtime: bot offline não responde nem chama rede', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Ajuda',
      online: false,
      config: cfg({ commands: [{ name: 'ping', method: 'GET', url: 'https://x/y' }] }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ping' })
  await tick()
  stop()
  assert.equal(d.posted.length, 0)
  assert.equal(d.fetchCalls.length, 0)
})

test('runtime: alias dispara o comando', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Ajuda',
      online: true,
      config: cfg({
        commands: [{ name: 'ajuda', aliases: ['help'], method: 'GET', url: '', exec: 'reply', reply: 'ok' }],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!help' })
  await tick()
  stop()
  assert.equal(d.posted[0].body, 'ok')
})

test('runtime: cooldown por autor bloqueia o segundo uso imediato', async () => {
  let now = 1_000_000
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'X',
      online: true,
      config: cfg({
        commands: [{ name: 'ping', method: 'GET', url: '', exec: 'reply', reply: 'pong', cooldownMs: 5000 }],
      }),
    },
  ])
  const rt = runtime(d.deps, () => now)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ping' })
  await tick()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ping' })
  await tick()
  assert.equal(d.posted.length, 1, 'segundo uso em cooldown')
  // Outro autor não é afetado.
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'bia', body: '!ping' })
  await tick()
  assert.equal(d.posted.length, 2)
  now += 6000
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ping' })
  await tick()
  stop()
  assert.equal(d.posted.length, 3, 'cooldown expira')
})

test('runtime: rate limit por minuto corta o excesso', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'X',
      online: true,
      config: cfg({
        maxRepliesPerMinute: 2,
        commands: [{ name: 'ping', method: 'GET', url: '', exec: 'reply', reply: 'pong', cooldownMs: 0 }],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  for (let i = 0; i < 5; i += 1) {
    d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: `u${i}`, body: '!ping' })
    await tick()
  }
  stop()
  assert.equal(d.posted.length, 2)
  assert.ok(d.logs.some((l) => l.message.includes('limite')))
})

test('runtime: comando HTTP renderiza template e posta', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'CEP',
      online: true,
      config: cfg({
        commands: [
          {
            name: 'cep',
            method: 'GET',
            url: 'https://api.x/{{args}}',
            responsePath: 'logradouro',
            template: 'achei {{value}}',
          },
        ],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!cep 123' })
  await tick()
  stop()
  assert.ok(d.fetchCalls[0].endsWith('/123'))
  assert.equal(d.posted[0].body, 'achei Rua A')
})

test('runtime: comando admin sem permissão não chama o core e avisa', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Mod',
      online: true,
      perms: 0,
      config: cfg({
        commands: [{ name: 'ban', method: 'GET', url: '', exec: 'admin', admin: 'ban' }],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ban alvo spam' })
  await tick()
  stop()
  assert.equal(d.admin.length, 0, 'sem permissão não chega ao core')
  assert.ok(d.posted[0].body.includes('não tem permissão'), d.posted[0]?.body)
})

test('runtime: comando admin com permissão chega ao core', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Mod',
      online: true,
      perms: 1, // PERM_BAN
      config: cfg({
        commands: [{ name: 'ban', method: 'GET', url: '', exec: 'admin', admin: 'ban', cooldownMs: 0 }],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ban alvo spam grave' })
  await tick()
  stop()
  assert.equal(d.admin.length, 1)
  assert.equal(d.admin[0].action, 'ban')
  assert.equal(d.admin[0].target, 'alvo')
  assert.ok(d.admin[0].reason.includes('spam'))
})

test('runtime: script com if/else e variável persistente', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Eco',
      online: true,
      config: cfg({
        commands: [
          {
            name: 'pontos',
            method: 'GET',
            url: '',
            exec: 'script',
            script: 'incvar placar + 5\nreply "você tem {{placar}} pontos"',
            cooldownMs: 0,
          },
        ],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!pontos' })
  await tick()
  stop()
  assert.equal(d.vars.get('placar'), '5')
  assert.equal(d.posted.at(-1)?.body, 'você tem 5 pontos')
})

test('runtime: script vazio-args mostra uso (if is empty)', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Uso',
      online: true,
      config: cfg({
        commands: [
          {
            name: 'oi',
            method: 'GET',
            url: '',
            exec: 'script',
            script: 'if args is empty\nreply "uso: !oi nome"\nelse\nreply "olá {{raw.args}}"\nend',
          },
        ],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!oi' })
  await tick()
  stop()
  assert.equal(d.posted[0].body, 'uso: !oi nome')
})

test('runtime: evento member_joined chega e mensagem também (webhook é de escopo)', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'on',
      name: 'Boas',
      online: true,
      config: cfg({
        events: ['member_joined'],
        webhook: { url: 'https://hook.example/x' },
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'member_joined', community_id: 'srv', fp: 'novo', nickname: 'Novo' })
  await tick()
  d.emit({ type: 'message_new', community_id: 'srv', direction: 'in', conv_id: 'geral', author_fp: 'a', body: 'oi' })
  await tick()
  stop()
  // Webhook recebe evento marcado E toda mensagem (mesma regra documentada).
  assert.equal(d.fetchCalls.filter((u) => u === 'https://hook.example/x').length, 2)
})

test('runtime: evento não marcado não dispara webhook', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'off',
      name: 'Outro',
      online: true,
      config: cfg({ events: [], webhook: { url: 'https://hook.example/x' } }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'member_joined', community_id: 'srv', fp: 'novo', nickname: 'Novo' })
  await tick()
  stop()
  assert.equal(d.fetchCalls.length, 0)
})

test('runtime: canal fora do escopo não dispara', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'X',
      online: true,
      config: cfg({
        channels: ['outro'],
        commands: [{ name: 'ping', method: 'GET', url: '', exec: 'reply', reply: 'pong', cooldownMs: 0 }],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ping' })
  await tick()
  stop()
  assert.equal(d.posted.length, 0)
})

test('runtime: mensagem do próprio bot não gera loop', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'X',
      online: true,
      config: cfg({ commands: [{ name: 'ping', method: 'GET', url: '', exec: 'reply', reply: 'pong', cooldownMs: 0 }] }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!ping', bot_id: 'b1' })
  await tick()
  stop()
  assert.equal(d.posted.length, 0)
})

test('runtime: script recebe o id da mensagem e o canal do evento', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'Reator',
      online: true,
      config: cfg({
        commands: [
          {
            name: 'fixar',
            method: 'GET',
            url: '',
            exec: 'script',
            cooldownMs: 0,
            script: 'reply "canal={{event.channel}} msg={{event.message_id}}"',
          },
        ],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({
    type: 'message_new',
    direction: 'in',
    conv_id: 'geral',
    id: 'm-123',
    author_fp: 'ana',
    body: '!fixar',
  })
  await tick()
  stop()
  assert.equal(d.posted.length, 1)
  assert.match(d.posted[0].body, /canal=geral/)
  assert.match(d.posted[0].body, /msg=m-123/, 'sem o id o bot não reage nem apaga o que recebeu')
})

test('runtime: ação administrativa manda o canal de contexto', async () => {
  const d = makeDeps()
  const calls: string[] = []
  d.setBots([
    {
      id: 'b1',
      name: 'Enquete',
      online: true,
      perms: 0x7f,
      config: cfg({
        commands: [
          {
            name: 'votar',
            method: 'GET',
            url: '',
            exec: 'admin',
            admin: 'poll_create',
            cooldownMs: 0,
          },
        ],
      }),
    },
  ])
  const deps = {
    ...d.deps,
    botAdmin: async (
      _cid: string,
      _bot: string,
      action: string,
      _target: string,
      _reason: string,
      _num: number | null,
      channel?: string,
    ) => {
      calls.push(`${action}|${channel ?? ''}`)
      return 'ok'
    },
  }
  const rt = runtime(deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!votar' })
  await tick()
  stop()
  assert.deepEqual(calls, ['poll_create|geral'])
})

test('runtime: stop() remove o assinante', async () => {
  const d = makeDeps()
  const rt = runtime(d.deps)
  const stop = rt.start()
  assert.equal(rt.isRunning(), true)
  assert.equal(d.listeners.length, 1)
  stop()
  assert.equal(rt.isRunning(), false)
  assert.equal(d.listeners.length, 0)
})

test('runtime: HTTP para rede privada é bloqueado antes da chamada', async () => {
  const d = makeDeps()
  d.setBots([
    {
      id: 'b1',
      name: 'X',
      online: true,
      config: cfg({
        commands: [{ name: 'lan', method: 'GET', url: 'http://192.168.0.5/x', cooldownMs: 0 }],
      }),
    },
  ])
  const rt = runtime(d.deps)
  const stop = rt.start()
  d.emit({ type: 'message_new', direction: 'in', conv_id: 'geral', author_fp: 'ana', body: '!lan' })
  await tick()
  stop()
  assert.equal(d.fetchCalls.length, 0)
  assert.ok(d.logs.some((l) => l.message.includes('rede privada') || l.message.includes('bloqueado')))
})
