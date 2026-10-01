import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBotConfig,
  parseBotCommand,
  renderTemplate,
  extractPath,
  channelInScope,
  findCommand,
  renderBotReply,
  type BotConfig,
  type BotCommandDef,
} from '../src/services/botCommands.ts'

test('parseBotCommand: "!clima sao paulo" → name+args', () => {
  assert.deepEqual(parseBotCommand('!', '!clima sao paulo'), { name: 'clima', args: ['sao', 'paulo'] })
})

test('parseBotCommand: "!ping" → args vazio', () => {
  assert.deepEqual(parseBotCommand('!', '!ping'), { name: 'ping', args: [] })
})

test('parseBotCommand: não-comandos → null', () => {
  assert.equal(parseBotCommand('!', 'oi !ping'), null) // não começa com prefixo
  assert.equal(parseBotCommand('!', '!'), null) // só o prefixo
  assert.equal(parseBotCommand('!', '!!duplo'), null) // nome inválido após o prefixo
  assert.equal(parseBotCommand('!', ''), null)
})

test('renderTemplate: args/arg0/query/raw.args/value/json', () => {
  assert.equal(renderTemplate('{{args}}', { args: ['a b', 'c'] }), 'a%20b/c')
  assert.equal(renderTemplate('{{arg0}}', { args: ['a b', 'c'] }), 'a%20b')
  assert.equal(renderTemplate('{{query}}', { args: ['a b', 'c'] }), 'a%20b+c')
  assert.equal(renderTemplate('{{raw.args}}', { args: ['a b', 'c'] }), 'a b c')
  assert.equal(renderTemplate('{{value}}', { args: [], value: 'ok' }), 'ok')
  assert.equal(renderTemplate('{{json.data.x}}', { args: [], json: { data: { x: 'v' } } }), 'v')
})

test('renderTemplate: URL com {{query}} usa "+" como separador', () => {
  assert.equal(
    renderTemplate('https://api.exemplo.com/x?q={{query}}', { args: ['a', 'b'] }),
    'https://api.exemplo.com/x?q=a+b',
  )
  // um único argumento com espaço é encodeURIComponent → %20 (sem "+" de separação)
  assert.equal(
    renderTemplate('https://api.exemplo.com/x?q={{query}}', { args: ['a b'] }),
    'https://api.exemplo.com/x?q=a%20b',
  )
})

test('extractPath: objeto aninhado e arrays', () => {
  assert.equal(extractPath({ a: { b: { c: 'deep' } } }, 'a.b.c'), 'deep')
  assert.equal(extractPath({ items: [{ name: 'first' }] }, 'items[0].name'), 'first')
  assert.equal(extractPath({ items: [{ name: 'first' }] }, 'items.0.name'), 'first')
})

test('extractPath: inexistente/nulo → null; número → string', () => {
  assert.equal(extractPath({ a: { b: 1 } }, 'a.zzz'), null)
  assert.equal(extractPath({ a: 42 }, 'a'), '42')
  assert.equal(extractPath(null, 'a'), null)
  assert.equal(extractPath(undefined, 'a'), null)
  assert.equal(extractPath({ a: null }, 'a'), null)
  assert.equal(extractPath({ a: undefined }, 'a'), null)
})

test('parseBotConfig: JSON válido → prefix/commands/channels', () => {
  const raw = JSON.stringify({
    prefix: '!',
    commands: [{ name: 'clima', url: 'https://api.exemplo.com/x' }],
    channels: ['geral'],
  })
  const cfg = parseBotConfig(raw)
  assert.ok(cfg)
  assert.equal(cfg.prefix, '!')
  assert.equal(cfg.commands.length, 1)
  assert.equal(cfg.commands[0].name, 'clima')
  assert.equal(cfg.commands[0].method, 'GET')
  assert.equal(cfg.commands[0].url, 'https://api.exemplo.com/x')
  assert.deepEqual(cfg.channels, ['geral'])
})

test('parseBotConfig: JSON inválido / raw nulo → null', () => {
  assert.equal(parseBotConfig('{"prefix":'), null)
  assert.equal(parseBotConfig('lixo de verdade'), null)
  assert.equal(parseBotConfig(null), null)
  assert.equal(parseBotConfig(undefined), null)
})

test('parseBotConfig: config >16KB → null', () => {
  const big = JSON.stringify({ prefix: '!', pad: 'a'.repeat(20_000) })
  assert.ok(big.length > 16 * 1024)
  assert.equal(parseBotConfig(big), null)
})

test('parseBotConfig: URL não-http descarta o comando', () => {
  const cfg = parseBotConfig(JSON.stringify({
    prefix: '!',
    commands: [
      { name: 'bad', url: 'ftp://x' },
      { name: 'ok', url: 'https://api.exemplo.com/y' },
    ],
  }))
  assert.ok(cfg)
  assert.equal(cfg.commands.length, 1)
  assert.equal(cfg.commands[0].name, 'ok')
})

test('parseBotConfig: sem prefix → "!" ; prefix inválido → null', () => {
  const cfg = parseBotConfig('{"commands":[]}')
  assert.ok(cfg)
  assert.equal(cfg.prefix, '!')
  assert.equal(parseBotConfig('{"prefix":"ab","commands":[]}'), null)
})

test('channelInScope: [] = todos; lista = só os listados', () => {
  const all: BotConfig = { prefix: '!', commands: [], channels: [] }
  assert.equal(channelInScope(all, 'qualquer'), true)
  assert.equal(channelInScope(all, ''), true)
  const scoped: BotConfig = { prefix: '!', commands: [], channels: ['c1'] }
  assert.equal(channelInScope(scoped, 'c1'), true)
  assert.equal(channelInScope(scoped, 'c2'), false)
})

test('findCommand: acha por nome (nomes normalizados em minúsculas pelo parse)', () => {
  const cfg = parseBotConfig(JSON.stringify({
    prefix: '!',
    commands: [
      { name: 'CLIMA', url: 'https://api.exemplo.com/x' },
      { name: 'ping', url: 'https://api.exemplo.com/p' },
    ],
  }))
  assert.ok(cfg)
  // definição digitada em maiúsculas é normalizada para 'clima'
  assert.equal(findCommand(cfg, 'clima')?.url, 'https://api.exemplo.com/x')
  // usuário digita o comando em qualquer caixa → parseBotCommand rebaixa → acha
  const parsed = parseBotCommand('!', '!ClimA Sao')
  assert.ok(parsed)
  assert.equal(findCommand(cfg, parsed.name)?.name, 'clima')
  assert.equal(findCommand(cfg, 'nao-existe'), undefined)
})

test('renderBotReply: responsePath + template → valor formatado', () => {
  const cmd: BotCommandDef = {
    name: 'clima',
    method: 'GET',
    url: 'https://api.exemplo.com/x',
    responsePath: 'data.temp',
    template: '{{value}}°C',
  }
  assert.equal(renderBotReply(cmd, [], '{"data":{"temp":25}}'), '25°C')
})

test('renderBotReply: responsePath inexistente → null', () => {
  const cmd: BotCommandDef = {
    name: 'clima',
    method: 'GET',
    url: 'https://api.exemplo.com/x',
    responsePath: 'data.nope',
    template: '{{value}}',
  }
  assert.equal(renderBotReply(cmd, [], '{"data":{"temp":25}}'), null)
})

test('renderBotReply: resposta >1900 chars é truncada', () => {
  const long = 'x'.repeat(2000)
  const cmd: BotCommandDef = { name: 'long', method: 'GET', url: 'https://x', template: long }
  const out = renderBotReply(cmd, [], '{}')
  assert.equal(out?.length, 1900)
  assert.equal(out, long.slice(0, 1900))
})

test('renderBotReply: sem template e sem responsePath → corpo JSON bruto', () => {
  const cmd: BotCommandDef = { name: 'raw', method: 'GET', url: 'https://x' }
  assert.equal(renderBotReply(cmd, [], '{"a":1}'), '{"a":1}')
})
