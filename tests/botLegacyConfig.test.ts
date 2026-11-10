import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBotConfig,
  serializeBotConfig,
  commandProblem,
  defaultBotConfig,
} from '../src/services/botCommands.ts'

/**
 * Regressão do "NÃO SALVO" eterno: o parser descartava comandos `music`/`sfx`
 * de configs antigas. Resultado no painel: o `cfg` carregado não batia com o
 * salvo (badge "não salvo" para sempre) e o Salvar acusava "escreva a resposta
 * fixa" num comando que o usuário nem conseguia ver.
 */

const comLegado = JSON.stringify({
  schema: 3,
  mode: 'declarative',
  runtime: 'none',
  prefix: '!',
  commands: [
    { name: 'ping', exec: 'reply', reply: 'pong' },
    { name: 'play', exec: 'music', music: 'play' },
    { name: 'sfx', exec: 'sfx', sfx: 'builtin:coin' },
  ],
})

test('comando legado sobrevive ao parse (não some da config)', () => {
  const cfg = parseBotConfig(comLegado)
  assert.equal(cfg?.commands.length, 3, 'os três comandos precisam continuar visíveis')
  const play = cfg?.commands.find((c) => c.name === 'play')
  assert.ok(play, 'o comando de música sumiu')
  assert.equal(play?.exec, 'music')
  assert.equal(play?.music, 'play')
  assert.equal(play?.enabled, false, 'legado fica desligado, não executável')
})

test('legado não bloqueia o salvar do resto', () => {
  const cfg = parseBotConfig(comLegado)!
  for (const c of cfg.commands) {
    const others = cfg.commands.filter((o) => o !== c)
    assert.equal(commandProblem(c, others), null, `${c.name} não pode ser erro`)
  }
})

test('round-trip preserva o legado (nada é apagado em silêncio)', () => {
  const cfg = parseBotConfig(comLegado)!
  const json = serializeBotConfig(cfg)
  const back = parseBotConfig(json)!
  assert.equal(back.commands.length, 3)
  assert.ok(back.commands.some((c) => c.name === 'play' && c.music === 'play'))
  assert.ok(back.commands.some((c) => c.name === 'sfx' && c.sfx === 'builtin:coin'))
})

test('o painel abre sem "não salvo" em bot com legado', () => {
  // Simula o que o BotPanel compara: parse do salvo vs estado inicial.
  const cfg = parseBotConfig(comLegado)
  const inicial = { ...cfg }
  assert.equal(
    JSON.stringify(cfg),
    JSON.stringify(inicial),
    'se o parse descartasse comando, o dirty ficaria true para sempre',
  )
})

test('bot novo sem legado continua sem comandos fantasma', () => {
  const cfg = defaultBotConfig()
  cfg.commands = [{ name: 'oi', method: 'GET', url: '', exec: 'reply', reply: 'olá' }]
  const back = parseBotConfig(serializeBotConfig(cfg))
  assert.equal(back?.commands.length, 1)
  assert.equal(back?.commands[0].name, 'oi')
})
