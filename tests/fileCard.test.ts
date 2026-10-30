// Cartão de arquivo — regras de APRESENTAÇÃO puras.
//
// O card mudou de "habitar dois componentes diferentes" para um só, e as
// decisões que ele toma (texto do botão, velocidade legível, o que mostrar)
// são justamente as que já erraram: botão dizendo "Baixar" com download
// ativo, "0 KB/s" fingindo velocidade, "Baixar (43%)" congelado ao pausar.
//
// Testar aqui (sem WebView) trava essas regressões.

import test from 'node:test'
import assert from 'node:assert/strict'
import { downloadButtonLabel, formatSpeed, type FileCardProgress } from '../src/components/fileCardRules.ts'

function prog(over: Partial<FileCardProgress> = {}): FileCardProgress {
  return { pct: 0, speed: 0, status: 'idle', ...over }
}

test('formatSpeed: 0 e valores inválidos dizem "parado" em vez de 0 KB/s', () => {
  assert.equal(formatSpeed(0), 'parado')
  assert.equal(formatSpeed(-5), 'parado')
  assert.equal(formatSpeed(NaN), 'parado')
})

test('formatSpeed: unidades legíveis e com 1 decimal abaixo de 10', () => {
  assert.equal(formatSpeed(512), '512 B/s')
  assert.equal(formatSpeed(1536), '1.5 KB/s')
  assert.equal(formatSpeed(820 * 1024), '820 KB/s')
  assert.equal(formatSpeed(2.5 * 1024 * 1024), '2.5 MB/s')
})

test('botão: sem anúncio é "Baixar" e o card não promete progresso', () => {
  assert.equal(downloadButtonLabel(false, false, undefined, false), 'Baixar')
})

test('botão: completo mostra ação de salvar (com prévia) ou baixar de novo', () => {
  const done = prog({ pct: 100, status: 'completed' })
  assert.equal(downloadButtonLabel(true, true, done, true), 'Salvar')
  assert.equal(downloadButtonLabel(true, true, done, false), 'Baixar de novo')
})

test('botão: baixando mostra o percentual REAL (não "Baixar")', () => {
  assert.equal(downloadButtonLabel(true, false, prog({ pct: 43, status: 'downloading' }), false), 'Baixando 43%')
  assert.equal(downloadButtonLabel(true, false, prog({ pct: 0, status: 'downloading' }), false), 'Baixar')
})

test('botão: pausado e com falha pedem a ação certa', () => {
  assert.equal(downloadButtonLabel(true, false, prog({ pct: 40, status: 'paused' }), false), 'Retomar')
  assert.equal(downloadButtonLabel(true, false, prog({ pct: 40, status: 'failed' }), false), 'Tentar de novo')
})

test('botão: status queued (na fila) não anuncia percentual falso', () => {
  const queued = prog({ pct: 0, status: 'queued' })
  assert.equal(downloadButtonLabel(true, false, queued, false), 'Baixar')
})
