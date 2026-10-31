import test from 'node:test'
import assert from 'node:assert/strict'

import { isCollectiveRoom } from '../src/services/callRoomRules.ts'

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
