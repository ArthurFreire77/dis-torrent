import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBotConfig,
  parseBotCommand,
  renderTemplate,
  extractPath,
  channelInScope,
  kindInScope,
  findCommand,
  renderBotReply,
  botIsActive,
  serializeBotConfig,
  urlProblem,
  commandProblem,
  permAllows,
  BOT_PERMS,
  BOT_PERM_ALL,
  BOT_PERM_DEFS,
  BOT_ADMIN_ACTIONS,
  BOT_EVENTS,
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
  assert.equal(parseBotCommand('!', 'oi !ping'), null)
  assert.equal(parseBotCommand('!', '!'), null)
  assert.equal(parseBotCommand('!', '!!duplo'), null)
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

test('parseBotConfig: config vazia é config padrão (bot recém-criado não é "inválido")', () => {
  // O core devolve config "" ao criar o bot e o parse_config aceita vazio como
  // padrão. Marcar isso como inválido pintava todo bot novo de "config inválida".
  for (const vazio of ['', '   ', '\n']) {
    const cfg = parseBotConfig(vazio)
    assert.ok(cfg, `config ${JSON.stringify(vazio)} precisa ser válida`)
    assert.equal(cfg.prefix, '!')
    assert.deepEqual(cfg.commands, [])
  }
})

test('parseBotConfig: config acima de 64KB → null', () => {
  const big = JSON.stringify({ prefix: '!', pad: 'a'.repeat(70_000) })
  assert.ok(big.length > 64 * 1024)
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

test('kindInScope: escopo por TIPO de canal (texto, voz, vídeo, fórum)', () => {
  const todos: BotConfig = { prefix: '!', commands: [], channels: [], channelKinds: [] }
  assert.equal(kindInScope(todos, 'text'), true, 'sem tipo marcado = todos')
  assert.equal(kindInScope(todos, 'voice'), true)
  assert.equal(kindInScope(todos, undefined), true)

  const soTexto: BotConfig = { prefix: '!', commands: [], channels: [], channelKinds: ['text'] }
  assert.equal(kindInScope(soTexto, 'text'), true)
  assert.equal(kindInScope(soTexto, 'voice'), false, 'não age em canal de voz')
  assert.equal(kindInScope(soTexto, 'forum'), false)
  // Evento sem canal (ex.: membro entrou no servidor) não é filtrado por tipo.
  assert.equal(kindInScope(soTexto, undefined), true)
})

test('config do bot: channelKinds é lido, validado e sobrevive ao round-trip', () => {
  const cfg = parseBotConfig(
    JSON.stringify({ prefix: '!', channelKinds: ['text', 'forum', 'inexistente', 42] }),
  )
  assert.ok(cfg)
  assert.deepEqual(cfg.channelKinds, ['text', 'forum'], 'só os tipos conhecidos entram')
  const volta = parseBotConfig(serializeBotConfig(cfg))
  assert.ok(volta)
  assert.deepEqual(volta.channelKinds, ['text', 'forum'])
})

test('permissões: os bits antigos não perdem poder depois da separação', () => {
  // Quem já tinha o bit "gerenciar" continua podendo montar/limpar: a
  // atualização não pode tirar poder de bot que já estava configurado.
  assert.equal(BOT_PERM_ALL & BOT_PERMS.MANAGE, BOT_PERMS.MANAGE)
  assert.equal((BOT_PERM_ALL & BOT_PERMS.STRUCTURE) !== 0, true)
  assert.equal((BOT_PERM_ALL & BOT_PERMS.PURGE) !== 0, true)
  assert.equal(permAllows(BOT_PERM_ALL, 'channel_create'), true)
  assert.equal(permAllows(BOT_PERM_ALL, 'clear'), true)
  assert.equal(permAllows(0, 'channel_create'), false, 'sem bit, não monta servidor')
  assert.equal(permAllows(0, 'ping'), true, 'ação sem permissão é livre')
})

test('botIsActive: só o false EXPLÍCITO desliga (payload antigo sem online segue ligado)', () => {
  assert.equal(botIsActive(false), false)
  assert.equal(botIsActive(true), true)
  assert.equal(botIsActive(undefined), true)
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
  assert.equal(findCommand(cfg, 'clima')?.url, 'https://api.exemplo.com/x')
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

test('parseBotConfig: webhook só http(s) — igual à regra dos comandos', () => {
  const ok = parseBotConfig(JSON.stringify({ prefix: '!', commands: [], webhook: { url: 'https://x.hook/y' } }))
  assert.equal(ok?.webhook?.url, 'https://x.hook/y')
  const ruas = parseBotConfig(JSON.stringify({ prefix: '!', commands: [], webhook: { url: 'file:///c:/boom' } }))
  assert.equal(ruas?.webhook, undefined, 'esquema inválido não vira webhook ativo')
  const vazio = parseBotConfig(JSON.stringify({ prefix: '!', commands: [], webhook: { url: '   ' } }))
  assert.equal(vazio?.webhook, undefined)
})

test('renderBotReply: texto vindo da API é sanitizado (bidi/zero-width/controle)', () => {
  const cmd: BotCommandDef = {
    name: 'x',
    method: 'GET',
    url: 'https://x',
    responsePath: 'v',
    template: '{{value}}',
  }
  const out = renderBotReply(cmd, [], JSON.stringify({ v: 'seguro\u202Egnp.exe\u200B\x07' }))
  assert.ok(out)
  assert.ok(!out!.includes('\u202E'), 'override bidi forjaria o texto exibido')
  assert.ok(!out!.includes('\u200B'), 'zero-width esconderia conteúdo')
  assert.ok(!out!.includes('\x07'), 'controle não pode virar mensagem')
  assert.match(out!, /gnp\.exe/)
})

// --- Superfície nova: aliases, exec, permissões, admin, guarda de URL ---

test('parseBotConfig: alias, cooldown, args e permissão são lidos', () => {
  const cfg = parseBotConfig(
    JSON.stringify({
      prefix: '/',
      commands: [
        {
          name: 'ajuda',
          aliases: ['help', 'AJUDA'],
          reply: 'olá',
          cooldownMs: 5000,
          permission: 'moderate',
          ephemeral: true,
          args: [{ name: 'Tópico', required: true }],
        },
      ],
    }),
  )
  assert.ok(cfg)
  const c = cfg.commands[0]
  assert.equal(cfg.prefix, '/')
  assert.deepEqual(c.aliases, ['help'])
  assert.equal(c.exec, 'reply')
  assert.equal(c.cooldownMs, 5000)
  assert.equal(c.permission, 'moderate')
  assert.equal(c.ephemeral, true)
  assert.equal(c.args?.[0].name, 'topico')
  assert.equal(c.args?.[0].required, true)
})

test('parseBotConfig: admin e script definem exec sem url', () => {
  const cfg = parseBotConfig(
    JSON.stringify({
      commands: [
        { name: 'ban', admin: 'ban' },
        { name: 'oi', script: 'reply "olá"' },
      ],
    }),
  )
  assert.ok(cfg)
  assert.equal(cfg.commands[0].exec, 'admin')
  assert.equal(cfg.commands[0].admin, 'ban')
  assert.equal(cfg.commands[1].exec, 'script')
})

test('parseBotConfig: comando sem corpo válido é descartado', () => {
  const cfg = parseBotConfig(
    JSON.stringify({
      commands: [
        { name: 'vazio', exec: 'reply', reply: '   ' },
        { name: 'ok', reply: 'funciona' },
      ],
    }),
  )
  assert.ok(cfg)
  assert.equal(cfg.commands.length, 1)
  assert.equal(cfg.commands[0].name, 'ok')
})

test('findCommand: acha por alias e ignora comando desabilitado', () => {
  const cfg = parseBotConfig(
    JSON.stringify({
      commands: [
        { name: 'ajuda', aliases: ['help'], reply: 'x' },
        { name: 'off', reply: 'y', enabled: false },
      ],
    }),
  )
  assert.ok(cfg)
  assert.equal(findCommand(cfg, 'help')?.name, 'ajuda')
  assert.equal(findCommand(cfg, 'off'), undefined, 'desabilitado não dispara')
})

test('parseBotCommand: aceita hífen no nome e não trata "!!" como comando', () => {
  assert.deepEqual(parseBotCommand('/', '/bom-dia ana'), {
    name: 'bom-dia',
    args: ['ana'],
  })
  assert.equal(parseBotCommand('!', '!!risos'), null)
})

test('urlProblem: bloqueia metadados sempre e rede privada por flag', () => {
  assert.equal(urlProblem('https://api.exemplo.com/x', true), null)
  assert.ok(urlProblem('http://169.254.169.254/latest/meta-data', false))
  assert.ok(urlProblem('http://192.168.0.10/x', true))
  assert.equal(urlProblem('http://192.168.0.10/x', false), null)
  assert.ok(urlProblem('http://localhost:8080/x', true))
  assert.ok(urlProblem('file:///etc/passwd', false))
  assert.ok(urlProblem('https://', false))
})

test('events: lista fechada — evento desconhecido é descartado', () => {
  const cfg = parseBotConfig(
    JSON.stringify({ events: ['message_new', 'teleportou', 'member_joined'] }),
  )
  assert.ok(cfg)
  assert.deepEqual(cfg.events, ['message_new', 'member_joined'])
})

test('serializeBotConfig: ida e volta preserva o que importa', () => {
  const original = {
    prefix: '$',
    commands: [
      { name: 'ping', method: 'GET', url: 'https://x/y', responsePath: 't', template: '{{value}}' },
      { name: 'ban', admin: 'ban', permission: 'moderate' },
    ],
    channels: ['c1'],
    events: ['message_new'],
    blockPrivate: false,
    maxRepliesPerMinute: 5,
    webhook: { url: 'https://h/x' },
  }
  const parsed = parseBotConfig(JSON.stringify(original))
  assert.ok(parsed)
  const round = parseBotConfig(serializeBotConfig(parsed))
  assert.ok(round)
  assert.equal(round.prefix, '$')
  assert.equal(round.commands.length, 2)
  assert.equal(round.commands[0].responsePath, 't')
  assert.equal(round.commands[1].admin, 'ban')
  assert.equal(round.blockPrivate, false)
  assert.equal(round.maxRepliesPerMinute, 5)
  assert.equal(round.webhook?.url, 'https://h/x')
})

test('permAllows: cada ação administrativa exige o bit certo', () => {
  assert.equal(permAllows(BOT_PERMS.BAN, 'ban'), true)
  assert.equal(permAllows(0, 'ban'), false)
  assert.equal(permAllows(BOT_PERMS.MANAGE, 'kick'), true)
  assert.equal(permAllows(BOT_PERMS.BAN, 'kick'), false)
  assert.equal(permAllows(0, 'ping'), true, 'leitura não exige permissão')
  assert.equal(permAllows(BOT_PERM_ALL, 'inexistente'), false)
})

test('permAllows: ações de conteúdo têm bit próprio e não dão moderação', () => {
  assert.equal(permAllows(BOT_PERMS.CONTENT, 'react'), true)
  assert.equal(permAllows(BOT_PERMS.CONTENT, 'pin'), true)
  assert.equal(permAllows(BOT_PERMS.CONTENT, 'poll_create'), true)
  assert.equal(permAllows(BOT_PERMS.CONTENT, 'ban'), false, 'conteúdo não bane')
  assert.equal(permAllows(BOT_PERMS.CONTENT, 'delete_msg'), false)
  assert.equal(permAllows(BOT_PERMS.DELETE, 'delete_msg'), true)
  assert.equal(permAllows(BOT_PERMS.DELETE, 'clear'), false, 'delete_msg ≠ limpar canal')
  assert.equal(permAllows(0, 'audit'), true, 'consulta é livre')
  assert.equal(permAllows(0, 'channels'), true)
})

test('BOT_ADMIN_ACTIONS cobre todos os bits e não tem ação repetida', () => {
  const nomes = BOT_ADMIN_ACTIONS.map((a) => a.action)
  assert.equal(new Set(nomes).size, nomes.length, 'ação duplicada no registro')
  for (const nome of nomes) assert.match(nome, /^[a-z_]+$/, `ação fora do padrão: ${nome}`)
  for (const def of BOT_PERM_DEFS) {
    assert.ok(
      BOT_ADMIN_ACTIONS.some((a) => a.perm === def.bit),
      `bit ${def.label} não corresponde a nenhuma ação`,
    )
    for (const c of def.commands) {
      assert.ok(nomes.includes(c), `/${c} citado em ${def.label} não existe no registro`)
    }
  }
})

test('commandProblem: valida nome, duplicata e corpo por exec', () => {
  const base: BotCommandDef = { name: 'a', method: 'GET', url: 'https://x/y', exec: 'http' }
  assert.equal(commandProblem(base, []), null)
  assert.ok(commandProblem({ ...base, name: '' }, []))
  assert.ok(commandProblem({ ...base, name: 'b' }, [{ ...base, name: 'b', exec: 'reply', reply: 'x' }]))
  assert.ok(commandProblem({ ...base, url: 'ftp://x' }, []))
  assert.ok(commandProblem({ ...base, exec: 'reply', reply: '' }, []))
  assert.ok(commandProblem({ ...base, exec: 'script', script: ' ' }, []))
  assert.ok(commandProblem({ ...base, exec: 'admin', admin: undefined }, []))
  assert.ok(commandProblem({ ...base, exec: 'admin', admin: 'roubar' }, []))
})

test('BOT_EVENTS só tem ids que o parser aceita', () => {
  const cfg = parseBotConfig(
    JSON.stringify({ events: BOT_EVENTS.map((e) => e.id) }),
  )
  assert.ok(cfg)
  assert.equal(cfg.events.length, BOT_EVENTS.length, 'todo evento documentado precisa ser aceito')
})
// Seção 1: fim
