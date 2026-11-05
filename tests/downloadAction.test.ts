import test from 'node:test'
import assert from 'node:assert/strict'
import { decideDownloadAction, canDownload } from '../src/services/downloadActionRules.ts'

test('download novo entra na fila', () => {
  assert.equal(decideDownloadAction(false, undefined), 'enqueued')
})

test('pausado retoma (não reinicia nem duplica)', () => {
  assert.equal(decideDownloadAction(false, 'paused'), 'resumed')
})

test('falhou tenta de novo pelo gesto do usuário', () => {
  assert.equal(decideDownloadAction(false, 'failed'), 'retried')
})

test('já concluído pela fila: salvar OUTRA cópia', () => {
  assert.equal(decideDownloadAction(true, 'completed'), 'resaved')
})

test('completo no swarm e nunca salvo passa pela FILA (verifica o hash)', () => {
  assert.equal(decideDownloadAction(true, undefined), 'enqueued')
})

test('completo e ainda na fila (verificando/salvando) não duplica o ciclo', () => {
  assert.equal(decideDownloadAction(true, 'verifying'), 'enqueued')
  assert.equal(decideDownloadAction(true, 'saving'), 'enqueued')
})

test('botão só habilita quando o anúncio chegou', () => {
  assert.equal(canDownload(false), false)
  assert.equal(canDownload(true), true)
})
