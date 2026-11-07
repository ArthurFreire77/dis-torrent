import test from 'node:test'
import assert from 'node:assert/strict'

import { isCollectiveRoom, leaveOutcome } from '../src/services/callRoomRules.ts'

test('canal de voz é sempre coletivo', () => {
  assert.equal(isCollectiveRoom({ callId: 'voice-c1-ch1', participants: ['eu'] }), true)
})

test('DM 1:1 não é coletiva (sair encerra para os dois)', () => {
  assert.equal(isCollectiveRoom({ callId: 'call-abc', participants: ['eu'] }), false)
  assert.equal(isCollectiveRoom({ callId: 'call-abc', participants: ['eu', 'fulano'] }), false)
})

test('sala com MAIS DE DUAS pessoas é coletiva — mesmo com um único PC', () => {
  assert.equal(
    isCollectiveRoom({ callId: 'call-abc', participants: ['eu', 'fulano', 'ciclano'] }),
    true,
  )
})

test('roster vazio: dois convidados são grupo, um convidado é 1:1', () => {
  assert.equal(
    isCollectiveRoom({ callId: 'call-abc', participants: ['eu'], invited: ['a', 'b'] }),
    true,
  )
  assert.equal(
    isCollectiveRoom({ callId: 'call-abc', participants: ['eu'], invited: ['a'] }),
    false,
  )
})

test('entrada inválida nunca derruba a chamada', () => {
  assert.equal(isCollectiveRoom(null), false)
  assert.equal(isCollectiveRoom(undefined), false)
  assert.equal(isCollectiveRoom({ callId: '', participants: [] }), false)
})

test('grupo de DUAS pessoas continua até o último sair (não é 1:1)', () => {
  assert.equal(
    isCollectiveRoom({ callId: 'call-g', participants: ['eu'], invited: ['amigo'], group: true }),
    true,
  )
  assert.equal(isCollectiveRoom({ callId: 'call-g', participants: ['eu'], group: true }), true)
  // Sem a marca de grupo o comportamento de DM não muda.
  assert.equal(isCollectiveRoom({ callId: 'call-dm', participants: ['eu'] }), false)
})

test('sala coletiva continua mesmo quando eu fico sozinho', () => {
  assert.equal(leaveOutcome({ collective: true, othersRemain: true }), 'keep')
  assert.equal(leaveOutcome({ collective: true, othersRemain: false }), 'keep')
})

test('chamada 1:1 encerra quando o outro sai', () => {
  assert.equal(leaveOutcome({ collective: false, othersRemain: false }), 'end')
  assert.equal(leaveOutcome({ collective: false, othersRemain: true }), 'keep')
})

test('sequência real: 3 pessoas, duas saem, a chamada NÃO acaba', () => {
  const collective = true
  assert.equal(leaveOutcome({ collective, othersRemain: true }), 'keep')
  assert.equal(leaveOutcome({ collective, othersRemain: false }), 'keep')
})
