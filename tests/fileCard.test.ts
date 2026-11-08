import test from 'node:test'
import assert from 'node:assert/strict'
import {
  downloadButtonLabel,
  downloadButtonState,
  formatSpeed,
  type FileCardProgress,
} from '../src/components/fileCardRules.ts'

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

test('sem anúncio é azul "Baixar" e o botão não é clicável', () => {
  const st = downloadButtonState(false, false, undefined)
  assert.equal(st.label, 'Baixar')
  assert.equal(st.tone, 'idle')
  assert.equal(st.clickable, false)
  assert.equal(downloadButtonLabel(false, false, undefined), 'Baixar')
})

test('baixando vira AMARELO com spinner e percentual real', () => {
  const st = downloadButtonState(true, false, prog({ pct: 43, status: 'downloading' }))
  assert.equal(st.label, 'Baixando 43%')
  assert.equal(st.tone, 'busy')
  assert.equal(st.spinning, true)
  assert.equal(st.clickable, false)
  const zero = downloadButtonState(true, false, prog({ pct: 0, status: 'downloading' }))
  assert.equal(zero.label, 'Baixando…')
  assert.equal(zero.tone, 'busy')
})

test('concluído vira VERDE "Baixado" e só libera o re-download pelo botão vermelho', () => {
  const st = downloadButtonState(true, true, prog({ pct: 100, status: 'completed' }))
  assert.equal(st.label, 'Baixado')
  assert.equal(st.tone, 'done')
  assert.equal(st.icon, 'check')
  assert.equal(st.clickable, false)
  assert.equal(st.showRedownload, true)
  assert.equal(downloadButtonLabel(true, true, prog({ pct: 100, status: 'completed' }), true), 'Salvar')
})

test('falha vira VERMELHO e pede nova tentativa', () => {
  const st = downloadButtonState(true, false, prog({ pct: 40, status: 'failed' }))
  assert.equal(st.label, 'Tentar de novo')
  assert.equal(st.tone, 'failed')
  assert.equal(st.clickable, true)
  assert.equal(st.showRedownload, false)
})

test('pausado retoma; verificando e salvando têm rótulo próprio', () => {
  assert.equal(downloadButtonState(true, false, prog({ pct: 40, status: 'paused' })).label, 'Retomar')
  assert.equal(downloadButtonState(true, false, prog({ pct: 100, status: 'verifying' })).label, 'Conferindo…')
  assert.equal(downloadButtonState(true, false, prog({ pct: 100, status: 'saving' })).label, 'Salvando…')
})

test('na fila não anuncia percentual falso', () => {
  const st = downloadButtonState(true, false, prog({ pct: 0, status: 'queued' }))
  assert.equal(st.label, 'Na fila…')
  assert.equal(st.tone, 'busy')
})
