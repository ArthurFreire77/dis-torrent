import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addVoiceParticipant,
  removeVoiceParticipant,
  setParticipantNickname,
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

test('apelido real substitui o hex do fingerprint (sem isso "ninguém aparece")', () => {
  const participants: CallParticipantView[] = []
  addVoiceParticipant(participants, 'a3f92c11')
  assert.equal(participants[0].nickname, 'a3f92c')

  assert.equal(setParticipantNickname(participants, 'a3f92c11', 'Lucas'), true)
  assert.equal(participants[0].nickname, 'Lucas')
  assert.equal(setParticipantNickname(participants, 'a3f92c11', 'Lucas'), false)
  assert.equal(setParticipantNickname(participants, 'nao-existe', 'Fantasma'), false)
  assert.equal(participants.length, 1)
})

test('adicionar participante clona a lista antes de emitir (invalida o useMemo da UI)', () => {
  const participants: CallParticipantView[] = []
  addVoiceParticipant(participants, 'peer-b')
  const tilesVistos = participants.map((p) => p.fp)
  addVoiceParticipant(participants, 'peer-c')
  const tilesDepois = participants.map((p) => p.fp)
  assert.deepEqual(tilesVistos, ['peer-b'])
  assert.deepEqual(tilesDepois, ['peer-b', 'peer-c'])
  assert.notDeepEqual(tilesVistos, tilesDepois)
})
