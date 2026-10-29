import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addVoiceParticipant,
  removeVoiceParticipant,
  updateVoiceParticipantState,
  type CallParticipantView,
} from '../src/services/callParticipants.ts'

test('roster de voz adiciona uma vez e remove a mídia lógica ao sair', () => {
  const participants: CallParticipantView[] = []
  assert.equal(addVoiceParticipant(participants, 'peer-123456'), true)
  assert.equal(addVoiceParticipant(participants, 'peer-123456'), false)
  assert.deepEqual(participants.map((participant) => participant.fp), ['peer-123456'])
  assert.equal(removeVoiceParticipant(participants, 'peer-123456'), true)
  assert.equal(removeVoiceParticipant(participants, 'peer-123456'), false)
  assert.equal(participants.length, 0)
})

test('estado remoto de microfone e ensurdecimento só muda quando chega um evento', () => {
  const participants: CallParticipantView[] = [{ fp: 'peer-1', nickname: 'peer-1' }]
  assert.equal(updateVoiceParticipantState(participants, 'peer-1', true, false), true)
  assert.equal(participants[0].muted, true)
  assert.equal(participants[0].deafened, false)
  assert.equal(updateVoiceParticipantState(participants, 'peer-1', true, false), false)
  assert.equal(updateVoiceParticipantState(participants, 'ausente', true, true), false)
})
