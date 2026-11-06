import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const swarm = readFileSync('src/services/fileSwarm.ts', 'utf8')
const manager = readFileSync('src/services/downloadManager.ts', 'utf8')

test('bloco que esgota tentativas fica REGISTRADO (não some em silêncio)', () => {
  const bloco = swarm.slice(swarm.indexOf('const eligible = missing.filter'))
  assert.match(bloco.slice(0, 1400), /sf\.failedChunks = new Set\(presos\)/, 'marca os blocos presos')
  assert.match(bloco.slice(0, 1400), /this\.lastError =/, 'explica o motivo')
  assert.doesNotMatch(
    bloco.slice(0, 1400),
    /if \(ciclos >= MAX_RETRY_CYCLES\) \{\s*return\s*\}/,
    'return mudo era o "trava em 0% para sempre"',
  )
})

test('o laço transforma bloco preso em falha visível', () => {
  assert.match(manager, /sf\.failedChunks && sf\.failedChunks\.size > 0/, 'olha os blocos presos')
  assert.match(manager, /STALL_FAIL_MS/, 'tem prazo, não fica esperando para sempre')
  assert.match(manager, /this\.setStatus\(\s*st,\s*'fail'/, 'vira failed com mensagem')
})

test('progresso aparece antes da janela de 2 s (card não fica em "Baixar")', () => {
  const trecho = manager.slice(manager.indexOf('if (have !== lastHave)'))
  assert.match(trecho.slice(0, 900), /itNow\.progress = computeProgress/, 'atualiza no instante em que chega bloco')
  assert.match(trecho.slice(0, 900), /this\.emit\(\)/, 'avisa a UI na hora')
})

test('clique em Baixar religa um download travado', () => {
  const enq = manager.slice(manager.indexOf('enqueue(meta: DownloadMeta)'))
  assert.match(enq.slice(0, 1200), /wantsTransfer\(existing\.status\) && !this\.running\.has/, 'detecta status sem laço vivo')
  assert.match(enq.slice(0, 1200), /this\.kick\(meta\.file_id\)/, 'volta a pedir blocos')
})

test('retry limpa tentativas, ciclos e peers ruins', () => {
  const retry = manager.slice(manager.indexOf('  retry(fileId: string)'))
  assert.match(retry.slice(0, 900), /resetForRetry\(fileId\)/, 'zera o estado esgotado')
  const reset = swarm.slice(swarm.indexOf('resetForRetry('))
  assert.match(reset.slice(0, 800), /resetAttempts\(file_id\)/)
  assert.match(reset.slice(0, 800), /badPeers/)
  assert.match(reset.slice(0, 800), /failedChunks = undefined/)
})
