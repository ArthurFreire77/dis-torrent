import test from 'node:test'
import assert from 'node:assert/strict'

import { isCollectiveRoom, leaveOutcome } from '../src/services/callRoomRules.ts'

test('canal de voz é sempre coletivo', () => {
  assert.equal(isCollectiveRoom({ callId: 'voice-c1-ch1', participants: ['eu'] }), true)
})

test('DM 1:1 não é coletiva (sair encerra para os dois)', () => {
  assert.equal(isCollectiveRoom({ callId: 'call-abc', participants: ['eu'] }), false)
})

test('sala com mais de uma pessoa é coletiva — mesmo com um único PC', () => {
  // Era exatamente aqui que a chamada de grupo morria: pcs.size === 1.
  assert.equal(
    isCollectiveRoom({ callId: 'call-abc', participants: ['eu', 'fulano'] }),
    true,
  )
  assert.equal(
    isCollectiveRoom({ callId: 'call-abc', participants: ['eu', 'fulano', 'ciclano'] }),
    true,
  )
})

test('roster vazio mas com convidados conta como coletiva', () => {
  assert.equal(
    isCollectiveRoom({ callId: 'call-abc', participants: ['eu'], invited: ['a', 'b'] }),
    true,
  )
})

test('entrada inválida nunca derruba a chamada', () => {
  assert.equal(isCollectiveRoom(null), false)
  assert.equal(isCollectiveRoom(undefined), false)
  assert.equal(isCollectiveRoom({ callId: '', participants: [] }), false)
})

// O relato: "5 pessoas; um saiu, outro saiu e a chamada acabou". A regra não
// pode recalcular coletividade com o roster já reduzido.
test('sala coletiva continua mesmo quando eu fico sozinho', () => {
  assert.equal(leaveOutcome({ collective: true, othersRemain: true }), 'keep')
  assert.equal(leaveOutcome({ collective: true, othersRemain: false }), 'keep')
})

test('chamada 1:1 encerra quando o outro sai', () => {
  assert.equal(leaveOutcome({ collective: false, othersRemain: false }), 'end')
  assert.equal(leaveOutcome({ collective: false, othersRemain: true }), 'keep')
})

test('sequência real: 3 pessoas, duas saem, a chamada NÃO acaba', () => {
  // Trava do manager: uma vez coletiva, sempre coletiva.
  const collective = true
  assert.equal(leaveOutcome({ collective, othersRemain: true }), 'keep') // 1ª saída
  assert.equal(leaveOutcome({ collective, othersRemain: false }), 'keep') // 2ª saída
})
