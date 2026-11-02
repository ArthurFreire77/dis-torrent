// Regras do bot no assistente de criação (nome, config, documentação).
//
// O bug que estes testes travam: o wizard criava servidor sem nenhuma opção de
// bot, e o painel de Bots validava o nome com uma regra própria (dentro de um
// componente React) que o assistente não conseguia reusar sem mentir sobre o
// tipo. Agora a regra é uma só (`botModel`) e o passo de bots usa ela.

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
  // E o comando do modelo responde ao texto que o usuário digita.
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
  // As três limitações que não podem desaparecer da documentação:
  assert.match(texto, /dono/, 'quem executa o bot')
  assert.match(texto, /fechado|não responde/, 'app fechado não responde')
  assert.match(texto, /token/, 'token é credencial')
  assert.match(texto, /não reage/, 'gatilhos que não existem')
})
