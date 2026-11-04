import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BOT_CONFIG_MAX_KB,
  BOT_NAME_MAX,
  BOT_NAME_MIN,
  fitsBotConfig,
  validateBotEntryName,
} from '../src/components/server/botModel.ts'
import { BOT_DOCS, BOT_TEMPLATES, botTemplateConfig } from '../src/components/server/botDocs.ts'
import {
  BOT_DOCS_FILE_NAME,
  botDocsMarkdown,
} from '../src/components/server/botDocs.ts'
import { parseBotConfig, parseBotCommand } from '../src/services/botCommands.ts'

test('nome de bot: mesmos limites do painel e do core', () => {
  assert.equal(BOT_NAME_MIN, 2)
  assert.equal(BOT_NAME_MAX, 32)
  assert.equal(validateBotEntryName('', []), 'Dê um nome ao bot.')
  assert.match(String(validateBotEntryName('a', [])), /2 caracteres/)
  assert.match(String(validateBotEntryName('a'.repeat(33), [])), /32 caracteres/)
  assert.match(String(validateBotEntryName('bot/com/barra', [])), /letras, números/)
  assert.equal(validateBotEntryName('BotDoClima', []), null)
  assert.equal(validateBotEntryName('Bom dia', []), null, 'espaço é permitido')
})

test('nome de bot: duplicata ignora caixa e espaço nas pontas', () => {
  assert.match(String(validateBotEntryName('bot', ['BOT'])), /Já existe/)
  assert.match(String(validateBotEntryName('  Bot ', ['bot'])), /Já existe/)
  assert.equal(validateBotEntryName('Bot2', ['bot']), null)
})

test('config do bot não passa do teto do core (16 KB)', () => {
  assert.equal(BOT_CONFIG_MAX_KB, 16)
  assert.equal(fitsBotConfig('{}'), true)
  assert.equal(fitsBotConfig('a'.repeat(BOT_CONFIG_MAX_KB * 1024)), true)
  assert.equal(fitsBotConfig('a'.repeat(BOT_CONFIG_MAX_KB * 1024 + 1)), false)
})

test('modelo pronto do assistente é config VÁLIDA (não gera bot quebrado)', () => {
  const clima = botTemplateConfig('clima')
  assert.ok(clima.length > 0)
  const cfg = parseBotConfig(clima)
  assert.ok(cfg, 'o JSON do modelo precisa passar no parser real')
  assert.equal(cfg.prefix, '!')
  assert.equal(cfg.commands.length, 1)
  assert.equal(cfg.commands[0].name, 'clima')
  assert.match(cfg.commands[0].url, /^https:\/\//)
  const parsed = parseBotCommand(cfg.prefix, '!clima -23.55 -46.63')
  assert.deepEqual(parsed, { name: 'clima', args: ['-23.55', '-46.63'] })
  assert.equal(botTemplateConfig('vazio'), '', 'sem modelo = bot sem comandos')
})

test('todo modelo oferecido passa no parser; lista tem rótulo e descrição', () => {
  for (const t of BOT_TEMPLATES) {
    assert.ok(t.label.length > 3, `${t.id} precisa de rótulo`)
    assert.ok(t.desc.length > 10, `${t.id} precisa explicar o que faz`)
    if (!t.config) continue
    assert.ok(parseBotConfig(t.config), `${t.id} tem config inválida`)
  }
})

test('documentação cobre o que o bot NÃO faz (honestidade no passo)', () => {
  const texto = BOT_DOCS.flatMap((d) => [d.title, ...d.lines]).join(' ').toLowerCase()
  assert.ok(BOT_DOCS.length >= 4, 'o passo precisa de seções de verdade')
  assert.match(texto, /dono/, 'quem executa o bot')
  assert.match(texto, /fechado|não responde/, 'app fechado não responde')
  assert.match(texto, /token/, 'token é credencial')
  assert.match(texto, /não reage/, 'gatilhos que não existem')
})

test('markdown baixável: nome de arquivo, seções obrigatórias e sem token', () => {
  const md = botDocsMarkdown()
  assert.equal(BOT_DOCS_FILE_NAME, 'distorrent-bots.md')
  assert.match(BOT_DOCS_FILE_NAME, /\.md$/, 'o download precisa ser Markdown puro')

  const low = md.toLowerCase()
  assert.ok(md.length > 4000, `documento curto demais (${md.length} caracteres)`)
  for (const trecho of [
    'o que um bot não pode fazer',
    'por que um bot não vira vírus',
    '16 kb',
    'placeholders',
    'modelos prontos',
    'exemplos prontos',
    'quem executa',
    '!',
  ]) {
    assert.ok(low.includes(trecho), `o .md precisa falar de "${trecho}"`)
  }
  assert.match(md, /executa shell|não executa código/i, 'barreira de processo citada')
  assert.ok(!/bot_[a-z0-9]{6,}_/.test(md), 'o .md não pode vazar token')
  assert.ok(!md.includes('\r'), 'Markdown gerado usa \\n (sem CRLF)')

  // Cercas balanceadas: meia cerca quebra a renderização no editor de quem recebe.
  assert.equal((md.match(/^```/gm) ?? []).length % 2, 0, 'blocos de código precisam fechar')
  // As barreiras de segurança não podem sumir do documento sem o teste cair.
  for (const barreira of [
    'sanitiz',
    'online = false',
    'http://',
    'não executa shell',
    'está offline',
  ]) {
    assert.ok(low.includes(barreira), `o .md precisa manter a barreira "${barreira}"`)
  }
})

test('markdown baixável: todo bloco JSON de modelo é config válida', () => {
  const md = botDocsMarkdown()
  const blocos = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
  assert.ok(blocos.length >= 2, 'precisa mostrar modelos/config')
  for (const bloco of blocos) {
    assert.ok(parseBotConfig(bloco), `bloco JSON do .md não passa no parser:\n${bloco}`)
  }
})

test('markdown baixável: exemplos usam URL http(s) e comando reconhecível', () => {
  const md = botDocsMarkdown()
  const urls = [...md.matchAll(/^- URL: `([^`]+)`/gm)].map((m) => m[1])
  assert.ok(urls.length >= 3, 'exemplos prontos precisam de URL')
  for (const url of urls) assert.match(url, /^https?:\/\//i)
  const nomes = [...md.matchAll(/^- Nome: `([^`]+)`/gm)].map((m) => m[1])
  assert.ok(nomes.length === urls.length)
  for (const nome of nomes) {
    assert.ok(nome.length > 0 && !/\s/.test(nome), `nome de exemplo inválido: ${nome}`)
  }
  assert.ok(parseBotCommand('!', `!${nomes[0]}`), 'o primeiro exemplo precisa ser digitável')
})
