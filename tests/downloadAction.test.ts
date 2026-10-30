// Ação do botão "Baixar": a MESMA no PC e no celular.
//
// A regra pura vive em `downloadActionRules.ts` (testado em Node). Aqui os
// casos que já divergiram entre as plataformas — e o que cada um garante.

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
  // Este é o caminho que o desktop pulava: chamava `fileSwarm.download` direto
  // e gravava em Downloads sem a verificação blake3 do arquivo montado.
  assert.equal(decideDownloadAction(true, undefined), 'enqueued')
})

test('completo e ainda na fila (verificando/salvando) não duplica o ciclo', () => {
  // `verifying`/`saving` já estão a caminho de gravar: entrar na fila de novo
  // criaria um segundo finalize.
  assert.equal(decideDownloadAction(true, 'verifying'), 'enqueued')
  assert.equal(decideDownloadAction(true, 'saving'), 'enqueued')
})

test('botão só habilita quando o anúncio chegou', () => {
  assert.equal(canDownload(false), false)
  assert.equal(canDownload(true), true)
})
