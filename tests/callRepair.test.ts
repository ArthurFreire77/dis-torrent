import test from 'node:test'
import assert from 'node:assert/strict'

import { PAIR_WAIT_BUDGET_MS, shouldInitiatePair } from '../src/services/callRepair.ts'

const ALTO = 'ffffffffffff'
const BAIXO = '000000000000'

test('lado maior oferece na hora', () => {
  assert.equal(
    shouldInitiatePair({ myFp: ALTO, peerFp: BAIXO, hasPair: false, nowMs: 1_000 }),
    true,
  )
})

test('lado menor espera o orçamento antes de oferecer', () => {
  const base = { myFp: BAIXO, peerFp: ALTO, hasPair: false }
  assert.equal(shouldInitiatePair({ ...base, nowMs: 1_000 }), false)
  assert.equal(
    shouldInitiatePair({ ...base, waitingSinceMs: 1_000, nowMs: 1_000 + PAIR_WAIT_BUDGET_MS - 1 }),
    false,
    'um pouco antes do orçamento ainda espera a offer do outro',
  )
  assert.equal(
    shouldInitiatePair({ ...base, waitingSinceMs: 1_000, nowMs: 1_000 + PAIR_WAIT_BUDGET_MS }),
    true,
    'estourou o orçamento: assume a offer (era o "Conectando" eterno)',
  )
})

test('par já criado não é recriado por esta regra', () => {
  assert.equal(
    shouldInitiatePair({ myFp: ALTO, peerFp: BAIXO, hasPair: true, nowMs: 1_000 }),
    false,
  )
})

test('sem identidade ou par consigo mesmo não oferece', () => {
  assert.equal(shouldInitiatePair({ myFp: '', peerFp: BAIXO, hasPair: false, nowMs: 5_000 }), false)
  assert.equal(shouldInitiatePair({ myFp: ALTO, peerFp: ALTO, hasPair: false, nowMs: 5_000 }), false)
})
