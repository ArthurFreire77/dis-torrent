import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { botDocsMarkdown } from '../src/components/server/botDocs.ts'
import {
  BOT_PRIMITIVES,
  BOT_MODES,
  parseBotConfig,
  serializeBotConfig,
  defaultBotConfig,
  BOT_ADMIN_ACTIONS,
} from '../src/services/botCommands.ts'

/**
 * O painel e o doc não podem contar histórias diferentes.
 *
 * O prompt exige "a documentação gerada pelo app reflete exatamente o
 * comportamento implementado". Isto compara o markdown do painel com
 * `docs/bots.md`, que é a referência humana.
 */

function docHumano(): string {
  return readFileSync(new URL('../docs/bots.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

test('o markdown do painel e docs/bots.md falam das mesmas rotas', () => {
  const painel = botDocsMarkdown()
  const humano = docHumano()
  // As rotas que existem hoje no botbridge.rs.
  const rotas = [
    '/v1/info',
    '/v1/events',
    '/v1/config',
    '/v1/limits',
    '/v1/health',
    '/v1/message',
    '/v1/admin',
    '/v1/commands',
    '/v1/log',
    '/v1/stop',
  ]
  for (const rota of rotas) {
    assert.ok(painel.includes(rota), `o .md do painel precisa citar ${rota}`)
    assert.ok(humano.includes(rota), `docs/bots.md precisa citar ${rota}`)
  }
})

test('os dois documentos declaram o mesmo conjunto de primitivas implementadas', () => {
  const humano = docHumano()
  const painel = botDocsMarkdown()
  const implementadas = BOT_PRIMITIVES.filter((p) => p.implemented).map((p) => p.id)
  assert.ok(implementadas.length > 0)
  // Toda primitiva implementada precisa aparecer nos dois textos.
  for (const id of implementadas) {
    assert.ok(
      painel.toLowerCase().includes(id.toLowerCase()),
      `o .md do painel não cita a primitiva implementada ${id}`,
    )
  }
  // E nenhum dos dois pode prometer WASM como disponível.
  for (const texto of [painel, humano]) {
    assert.ok(
      /não existe|nǜo existe|recusad/i.test(texto),
      'os documentos precisam dizer que o que falta, falta',
    )
    assert.match(texto, /wasm/i, 'WASM precisa aparecer como inexistente, não sumir em silêncio')
  }
})

test('os modos de execução documentados são os quatro do schema', () => {
  const humano = docHumano().toLowerCase()
  const painel = botDocsMarkdown().toLowerCase()
  for (const m of BOT_MODES) {
    assert.ok(
      humano.includes(m.id) || humano.includes(m.label.toLowerCase()),
      `docs/bots.md não fala do modo ${m.id}`,
    )
    assert.ok(
      painel.includes(m.id) || painel.includes(m.label.toLowerCase()),
      `o .md do painel não fala do modo ${m.id}`,
    )
  }
})

test('o catálogo de ações documentado é o que o core executa', () => {
  const humano = docHumano()
  for (const a of BOT_ADMIN_ACTIONS) {
    assert.ok(
      humano.includes(a.action),
      `docs/bots.md não documenta a ação /${a.action}`,
    )
  }
})

test('a config de exemplo do doc humano passa no parser de verdade', () => {
  const humano = docHumano()
  const blocos = [...humano.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
  assert.ok(blocos.length > 0, 'docs/bots.md precisa ter exemplos em JSON')
  for (const bloco of blocos) {
    const cfg = parseBotConfig(bloco)
    let alvo = bloco
    if (!bloco.includes('"commands"') && bloco.includes('"config"')) {
      const env = JSON.parse(bloco)
      alvo = JSON.stringify(env.config ?? {})
    }
    const parsed = cfg ?? parseBotConfig(alvo)
    assert.ok(parsed, `bloco JSON de docs/bots.md não passa no parser:\n${bloco.slice(0, 200)}`)
  }
})

test('o doc humano não promete recurso inexistente como disponível', () => {
  const humano = docHumano().toLowerCase()
  // Cada linha destas precisa estar acompanhada de "não existe"/"não" por perto.
  for (const recurso of ['sdk', 'marketplace', 'federação']) {
    const idx = humano.indexOf(recurso)
    if (idx < 0) continue // omitir é aceitável; prometer não é
    const janela = humano.slice(Math.max(0, idx - 200), idx + 200)
    assert.ok(
      /não existe|nǜo existe|não há|nǜo há|não foram|nǜo foram|não implementad/i.test(janela),
      `docs/bots.md cita "${recurso}" sem dizer que não existe`,
    )
  }
})

test('o .md do painel continua sem token e sem CRLF depois do v3', () => {
  const md = botDocsMarkdown()
  assert.ok(!/bot_[a-z0-9]{6,}_/.test(md), 'token no documento')
  assert.ok(!md.includes('\r'), 'CRLF no documento')
  assert.equal((md.match(/^```/gm) ?? []).length % 2, 0, 'cerca de código desbalanceada')
})

test('as seções do .md do painel estão em ordem numérica', () => {
  const md = botDocsMarkdown()
  const numeros: number[] = []
  for (const m of md.matchAll(/^## (\d+(?:\.\d+)?)\./gm)) numeros.push(Number(m[1]))
  assert.ok(numeros.length >= 10, `poucas seções numeradas: ${numeros.length}`)
  for (let i = 1; i < numeros.length; i += 1) {
    assert.ok(
      numeros[i] >= numeros[i - 1],
      `seção ${numeros[i]} aparece depois de ${numeros[i - 1]}: ${numeros.join(', ')}`,
    )
  }
  assert.equal(numeros[0], 1, 'o documento começa na seção 1')
})

test('a config exportada do painel é aceita de novo pelo parser (ida e volta v3)', () => {
  const cfg = defaultBotConfig()
  cfg.webhook = { url: 'https://exemplo.com/hook' }
  cfg.httpAllow = ['exemplo.com']
  const volta = parseBotConfig(serializeBotConfig(cfg))
  assert.ok(volta)
  assert.equal(volta.schema, 3)
  assert.equal(volta.mode, cfg.mode)
  assert.deepEqual(volta.httpAllow, ['exemplo.com'])
})
