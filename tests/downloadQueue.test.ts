import test from 'node:test'
import assert from 'node:assert/strict'
import {
  nextDownloadStatus,
  canPause,
  canResume,
  canCancel,
  canRetry,
  computeProgress,
  verifyFileIntegrity,
  blake3Hex,
  serializeQueue,
  deserializeQueue,
  rehydrateStatus,
  type DownloadItem,
  type DownloadStatus,
  type DownloadEvent,
} from '../src/services/downloadQueue.ts'
import { blake3 } from '@noble/hashes/blake3.js'

function makeItem(over: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'id1',
    file_id: 'f1',
    name: 'arquivo.zip',
    size: 1024,
    chunks: 4,
    hash: 'abc',
    status: 'queued',
    progress: 0,
    have: 0,
    speedBps: 0,
    startedAt: 1,
    updatedAt: 2,
    ...over,
  }
}

const ALL_STATUSES: DownloadStatus[] = [
  'queued', 'downloading', 'paused', 'verifying', 'saving', 'completed', 'failed', 'cancelled',
]

test('queued: start → downloading; cancel → cancelled', () => {
  assert.equal(nextDownloadStatus('queued', 'start'), 'downloading')
  assert.equal(nextDownloadStatus('queued', 'cancel'), 'cancelled')
})

test('downloading: pause/progress/chunks-complete/fail/cancel', () => {
  assert.equal(nextDownloadStatus('downloading', 'pause'), 'paused')
  assert.equal(nextDownloadStatus('downloading', 'progress'), 'downloading')
  assert.equal(nextDownloadStatus('downloading', 'chunks-complete'), 'verifying')
  assert.equal(nextDownloadStatus('downloading', 'fail'), 'failed')
  assert.equal(nextDownloadStatus('downloading', 'cancel'), 'cancelled')
})

test('paused: resume → downloading; cancel → cancelled', () => {
  assert.equal(nextDownloadStatus('paused', 'resume'), 'downloading')
  assert.equal(nextDownloadStatus('paused', 'cancel'), 'cancelled')
})

test('verifying: verify-ok → saving; verify-fail → failed', () => {
  assert.equal(nextDownloadStatus('verifying', 'verify-ok'), 'saving')
  assert.equal(nextDownloadStatus('verifying', 'verify-fail'), 'failed')
})

test('saving: save-ok → completed; save-fail → failed', () => {
  assert.equal(nextDownloadStatus('saving', 'save-ok'), 'completed')
  assert.equal(nextDownloadStatus('saving', 'save-fail'), 'failed')
})

test('failed: retry → queued; cancel → cancelled', () => {
  assert.equal(nextDownloadStatus('failed', 'retry'), 'queued')
  assert.equal(nextDownloadStatus('failed', 'cancel'), 'cancelled')
})

test('completed/cancelled: terminais para QUALQUER evento', () => {
  const events: DownloadEvent[] = [
    'start', 'pause', 'resume', 'cancel', 'progress', 'chunks-complete',
    'verify-ok', 'verify-fail', 'save-ok', 'save-fail', 'fail', 'retry',
  ]
  for (const ev of events) {
    assert.equal(nextDownloadStatus('completed', ev), 'completed', `completed + ${ev}`)
    assert.equal(nextDownloadStatus('cancelled', ev), 'cancelled', `cancelled + ${ev}`)
  }
})

test('canPause/canResume/canRetry/canCancel cobrem todos os status', () => {
  for (const s of ALL_STATUSES) {
    assert.equal(canPause(s), s === 'downloading' || s === 'queued', `canPause(${s})`)
    assert.equal(canResume(s), s === 'paused' || s === 'failed', `canResume(${s})`)
    assert.equal(canRetry(s), s === 'failed', `canRetry(${s})`)
    assert.equal(canCancel(s), s !== 'completed' && s !== 'cancelled', `canCancel(${s})`)
  }
})

test('computeProgress: percentuais com clamp e casos degenerados', () => {
  assert.equal(computeProgress(0, 10), 0)
  assert.equal(computeProgress(5, 10), 50)
  assert.equal(computeProgress(10, 10), 100)
  assert.equal(computeProgress(-1, 10), 0)
  assert.equal(computeProgress(11, 10), 100)
  assert.equal(computeProgress(0, 0), 0)
  assert.equal(computeProgress(NaN, 10), 0)
  assert.equal(computeProgress(5, NaN), 0)
})

test('verifyFileIntegrity: blake3 ok/nok/vazio (hash anunciado em slice 32)', () => {
  const bytes = new Uint8Array([1, 2, 3])
  const full = Array.from(blake3(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  assert.equal(full.length, 64)
  assert.equal(blake3Hex(bytes), full) // módulo usa o mesmo algoritmo
  assert.equal(verifyFileIntegrity(bytes, full), true) // 64 chars
  assert.equal(verifyFileIntegrity(bytes, full.slice(0, 32)), true) // 32 chars (anúncio legado)
  const flipped = full.slice(0, 31) + (full[31] === '0' ? '1' : '0')
  assert.equal(verifyFileIntegrity(bytes, flipped), false) // 1 char diferente
  assert.equal(verifyFileIntegrity(new Uint8Array([1, 2, 4]), full.slice(0, 32)), false) // outro conteúdo
  assert.equal(verifyFileIntegrity(bytes, ''), false)
})

test('serializeQueue/deserializeQueue: ida e volta preserva campos', () => {
  const item = makeItem({ status: 'downloading', progress: 42, have: 3 })
  const back = deserializeQueue(serializeQueue([item]))
  assert.equal(back.length, 1)
  assert.equal(back[0].file_id, 'f1')
  assert.equal(back[0].name, 'arquivo.zip')
  assert.equal(back[0].status, 'downloading')
  assert.equal(back[0].progress, 42)
  assert.equal(back[0].have, 3)
})

test('deserializeQueue: lixo/corrompido → []; status inválido → queued', () => {
  assert.deepEqual(deserializeQueue('lixo{{{'), [])
  assert.deepEqual(deserializeQueue(null), [])
  assert.deepEqual(deserializeQueue('{"nao": "array"}'), [])
  const bad = deserializeQueue(JSON.stringify([{ file_id: 'f', name: 'n', status: 'bogus' }]))
  assert.equal(bad.length, 1)
  assert.equal(bad[0].status, 'queued')
})

test('rehydrateStatus: meio-do-caminho → queued; resto permanece', () => {
  const toQueued: DownloadStatus[] = ['downloading', 'saving', 'verifying', 'queued']
  for (const s of toQueued) {
    assert.equal(rehydrateStatus(s), 'queued', `rehydrate(${s})`)
  }
  assert.equal(rehydrateStatus('completed'), 'completed')
  assert.equal(rehydrateStatus('failed'), 'failed')
  assert.equal(rehydrateStatus('paused'), 'paused')
  assert.equal(rehydrateStatus('cancelled'), 'cancelled')
})
