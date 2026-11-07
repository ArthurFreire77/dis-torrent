import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseBotConfig,
  serializeBotConfig,
  defaultBotConfig,
  defaultPrimitives,
  BOT_PRIMITIVES,
  BOT_MODES,
  hostAllowed,
  urlProblem,
  isPrivateHost,
  isBlockedHost,
  permAllows,
  BOT_PERMS,
  BOT_PERM_ALL,
  BOT_ADMIN_ACTIONS,
} from '../src/services/botCommands.ts'
import {
  signWebhook,
  verifyWebhook,
  buildWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
} from '../src/services/botWebhook.ts'

test('schema v3: config nova sai com schema, modo e runtime explícitos', () => {
  const cfg = defaultBotConfig()
  assert.equal(cfg.schema, 3)
  assert.equal(cfg.mode, 'declarative')
  assert.equal(cfg.runtime, 'none')
  const json = JSON.parse(serializeBotConfig(cfg))
  assert.equal(json.schema, 3)
  assert.equal(json.mode, 'declarative')
  assert.equal(json.runtime, 'none')
  assert.ok(json.primitives.text, 'texto é o mínimo que um bot entrega')
})

test('schema v3: config v1/v2 (sem schema) continua válida e é migrada', () => {
  const antiga = JSON.stringify({
    prefix: '!',
    commands: [{ name: 'ping', reply: 'pong' }],
    events: ['member_joined'],
    webhook: { url: 'https://h.exemplo/x' },
  })
  const cfg = parseBotConfig(antiga)
  assert.ok(cfg, 'bot existente não pode virar config inválida')
  assert.equal(cfg.schema, 3, 'a leitura devolve o schema atual')
  assert.equal(cfg.mode, 'declarative', 'sem mode, o padrão é não rodar código')
  assert.equal(cfg.runtime, 'none')
  assert.equal(cfg.commands.length, 1)
  assert.deepEqual(cfg.events, ['member_joined'])
  assert.equal(cfg.webhook?.url, 'https://h.exemplo/x')
})

test('schema v3: modo plugin sem runtime declarado assume processo', () => {
  const cfg = parseBotConfig(JSON.stringify({ schema: 3, mode: 'plugin', prefix: '!' }))
  assert.ok(cfg)
  assert.equal(cfg.runtime, 'process')
})

test('schema v3: runtime wasm é recusado com honestidade (não existe)', () => {
  assert.equal(parseBotConfig(JSON.stringify({ schema: 3, mode: 'plugin', runtime: 'wasm' })), null)
})

test('schema v3: schema fora de 1..3 é recusado', () => {
  assert.equal(parseBotConfig(JSON.stringify({ schema: 4 })), null)
  assert.equal(parseBotConfig(JSON.stringify({ schema: 0 })), null)
})

test('schema v3: modo desconhecido é recusado', () => {
  assert.equal(parseBotConfig(JSON.stringify({ schema: 3, mode: 'telepatia' })), null)
})

test('schema v3: primitivas desligadas sobrevivem ao round-trip', () => {
  const cfg = defaultBotConfig()
  cfg.primitives = { ...defaultPrimitives(), embed: true, http: false, dm: true }
  const round = parseBotConfig(serializeBotConfig(cfg))
  assert.ok(round)
  assert.equal(round.primitives.embed, true)
  assert.equal(round.primitives.dm, true)
  assert.equal(round.primitives.http, false)
})

test('schema v3: comando de resposta some se a primitiva de texto está desligada', () => {
  const cfg = parseBotConfig(
    JSON.stringify({
      schema: 3,
      primitives: { text: false, ephemeral: false, template: false },
      commands: [{ name: 'oi', exec: 'reply', reply: 'olá' }],
    }),
  )
  assert.ok(cfg)
  assert.equal(cfg.commands.length, 0, 'sem text/ephemeral, respondência fixa não existe')
})

test('schema v3: catálogo de primitivas não mente sobre o que existe', () => {
  const implementadas = BOT_PRIMITIVES.filter((p) => p.implemented).map((p) => p.id)
  assert.deepEqual(
    implementadas.sort(),
    ['ephemeral', 'http', 'kv', 'pin', 'poll', 'reaction', 'template', 'text', 'thread'].sort(),
  )
  assert.ok(BOT_PRIMITIVES.length === 20, 'o catálogo tem as 20 do schema')
  for (const m of BOT_MODES) assert.ok(m.hint.length > 20, `modo ${m.id} precisa explicar o trade-off`)
})

test('schema v3: segredo do webhook nunca volta na config serializada', () => {
  const cfg = defaultBotConfig()
  cfg.webhook = { url: 'https://h.exemplo/x' }
  cfg.webhookSecret = 'segredo-super-longo-1234'
  const json = serializeBotConfig(cfg)
  assert.ok(!json.includes('segredo-super-longo-1234'), 'vazou o segredo no JSON exportado')
  const parsed = JSON.parse(json)
  assert.equal(parsed.integrations.webhook.signed, true, 'só o marcador vai')
})

test('urlProblem: literais IPv4 não canônicos não furam mais a guarda', () => {
  // Estes três passavam antes porque o host era comparado como texto.
  for (const u of [
    'http://2130706433/x',
    'http://127.1/x',
    'http://evil.com@127.0.0.1:8080/x',
    'http://0.0.0.0/x',
    'http://[::ffff:127.0.0.1]/x',
  ]) {
    assert.ok(urlProblem(u, true), `deveria bloquear ${u}`)
  }
})

test('urlProblem: rede privada larga e documentação são bloqueadas', () => {
  for (const u of [
    'http://100.64.0.1/x', // CGNAT
    'http://198.18.0.1/x', // benchmark
    'http://192.0.2.10/x', // documentação
    'http://203.0.113.9/x',
    'http://172.20.0.1/x',
  ]) {
    assert.ok(urlProblem(u, true), `deveria bloquear ${u}`)
  }
  // Público continua passando.
  assert.equal(urlProblem('https://api.exemplo.com/x', true), null)
  assert.equal(urlProblem('https://8.8.8.8/x', true), null)
})

test('urlProblem: metadados de nuvem nunca passam, nem com opt-in', () => {
  assert.ok(urlProblem('http://169.254.169.254/latest/meta-data', false))
  assert.ok(urlProblem('http://metadata.google.internal/x', false))
})

test('isPrivateHost/isBlockedHost: IPv4 mapeado em IPv6 é reconhecido', () => {
  assert.equal(isPrivateHost('::ffff:10.0.0.1'), true)
  assert.equal(isPrivateHost('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateHost('::ffff:8.8.8.8'), false)
  assert.equal(isBlockedHost('::'), true)
})

test('hostAllowed: lista vazia libera; lista restringe por domínio e subdomínio', () => {
  assert.equal(hostAllowed('https://qualquer.exemplo/x', []), true)
  assert.equal(hostAllowed('https://api.exemplo.com/x', ['exemplo.com']), true)
  assert.equal(hostAllowed('https://exemplo.com/x', ['exemplo.com']), true)
  assert.equal(hostAllowed('https://api.outro.com/x', ['exemplo.com']), false)
  assert.equal(hostAllowed('https://evil-exemplo.com/x', ['exemplo.com']), false, 'sufixo solto não vale')
  assert.equal(hostAllowed('https://api.exemplo.com/x', ['*.exemplo.com']), true)
})

test('permAllows espelha a exceção herdada do core (manage libera estrutura e purga)', () => {
  assert.equal(permAllows(BOT_PERMS.MANAGE, 'channel_create'), true)
  assert.equal(permAllows(BOT_PERMS.MANAGE, 'clear'), true)
  assert.equal(permAllows(BOT_PERMS.MANAGE, 'server_public'), true)
  // Mas não vira ban nem conteúdo.
  assert.equal(permAllows(BOT_PERMS.MANAGE, 'ban'), false)
  assert.equal(permAllows(BOT_PERMS.MANAGE, 'react'), false)
  assert.equal(permAllows(0, 'channel_create'), false)
  assert.equal(permAllows(BOT_PERMS.STRUCTURE, 'channel_create'), true)
  assert.equal(permAllows(BOT_PERMS.STRUCTURE, 'clear'), false, 'estrutura não purga')
})

test('permAllows: os sete bits continuam cobrindo todas as ações do registro', () => {
  for (const a of BOT_ADMIN_ACTIONS) {
    if (a.perm === 0) {
      assert.equal(permAllows(0, a.action), true, `${a.action} é consulta livre`)
      continue
    }
    assert.equal(permAllows(a.perm, a.action), true, `${a.action} precisa passar com seu bit`)
    assert.equal(permAllows(BOT_PERM_ALL, a.action), true)
  }
})

test('webhook: assinatura é HMAC-SHA256 determinística e cobre o timestamp', () => {
  const a = signWebhook('segredo', 1_700_000_000, '{"event":"x"}')
  const b = signWebhook('segredo', 1_700_000_000, '{"event":"x"}')
  assert.equal(a, b)
  assert.match(a, /^sha256=[0-9a-f]{64}$/)
  const outroTs = signWebhook('segredo', 1_700_000_001, '{"event":"x"}')
  assert.notEqual(a, outroTs, 'sem o timestamp na assinatura, replay não tem como ser recusado')
  assert.notEqual(a, signWebhook('outro', 1_700_000_000, '{"event":"x"}'))
})

test('webhook: verify aceita o correto e recusa adulteração, segredo errado e replay velho', () => {
  const ts = 1_700_000_000
  const body = '{"event":"message_new"}'
  const sig = signWebhook('segredo', ts, body)
  assert.equal(verifyWebhook('segredo', sig, ts, body, ts), true)
  assert.equal(verifyWebhook('segredo', sig, ts, body + ' ', ts), false, 'corpo adulterado')
  assert.equal(verifyWebhook('outro', sig, ts, body, ts), false, 'segredo errado')
  assert.equal(
    verifyWebhook('segredo', sig, ts, body, ts + WEBHOOK_TOLERANCE_SECONDS + 1),
    false,
    'timestamp velho é replay',
  )
  assert.equal(verifyWebhook('segredo', 'nao-assinado', ts, body, ts), false)
})

test('webhook: buildWebhook manda assinatura só quando há segredo', () => {
  const com = buildWebhook('message_new', { body: 'oi' }, 'segredo-longo-1234', 'd1', 1_700_000_000)
  assert.ok(com.headers[WEBHOOK_SIGNATURE_HEADER])
  assert.equal(com.headers[WEBHOOK_TIMESTAMP_HEADER], '1700000000')
  assert.equal(
    verifyWebhook('segredo-longo-1234', com.headers[WEBHOOK_SIGNATURE_HEADER], 1_700_000_000, com.body, 1_700_000_000),
    true,
    'o corpo que trafega tem que casar com a assinatura',
  )
  const sem = buildWebhook('message_new', { body: 'oi' }, undefined, 'd2', 1_700_000_000)
  assert.equal(sem.headers[WEBHOOK_SIGNATURE_HEADER], undefined, 'sem segredo, sem header falso')
})

test('webhook: payload limpa bidi/zero-width do texto do evento', () => {
  const { body } = buildWebhook(
    'message_new',
    { body: 'oi\u202Egnp\u200B' },
    undefined,
    'd3',
    1_700_000_000,
  )
  const parsed = JSON.parse(body)
  assert.ok(!parsed.data.body.includes('\u202E'), 'bidi forjaria o que a mensagem diz')
  assert.ok(!parsed.data.body.includes('\u200B'))
})

test('webhook: payload é limitado em profundidade e tamanho', () => {
  const gordo = { a: 'x'.repeat(9000), lista: new Array(200).fill('y') }
  const { body } = buildWebhook('message_new', gordo, undefined, 'd4', 1_700_000_000)
  const parsed = JSON.parse(body)
  assert.ok(parsed.data.a.length <= 4000)
  assert.ok(parsed.data.lista.length <= 50)
})
