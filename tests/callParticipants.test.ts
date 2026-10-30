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
  // Regressão: todo participante de canal nascia com `fp.slice(0, 6)`, então a
  // lista mostrava `a3f92c` em vez do nome. Para o usuário, "fulano não
  // apareceu" — ele aparecia, sem nome.
  const participants: CallParticipantView[] = []
  addVoiceParticipant(participants, 'a3f92c11')
  assert.equal(participants[0].nickname, 'a3f92c')

  assert.equal(setParticipantNickname(participants, 'a3f92c11', 'Lucas'), true)
  assert.equal(participants[0].nickname, 'Lucas')
  // Idempotente: o reconciliador de roster roda a cada 10 s.
  assert.equal(setParticipantNickname(participants, 'a3f92c11', 'Lucas'), false)
  // Fingerprint fora do roster não inventa entrada.
  assert.equal(setParticipantNickname(participants, 'nao-existe', 'Fantasma'), false)
  assert.equal(participants.length, 1)
})

test('adicionar participante clona a lista antes de emitir (invalida o useMemo da UI)', () => {
  // O bug mais grave do "conectado mas não vejo ninguém": os shells memoízam os
  // tiles por IDENTIDADE do array de participantes. Como o manager mutava o
  // array in-place e emitia `{ ...state }` (cópia rasa), o `useMemo` não
  // recalculava — o cabeçalho contava 3 e o grid (e os `<audio>`) ficavam
  // presos em 1. Aqui provamos que a leitura da UI muda com o roster.
  const participants: CallParticipantView[] = []
  addVoiceParticipant(participants, 'peer-b')
  const tilesVistos = participants.map((p) => p.fp)
  addVoiceParticipant(participants, 'peer-c')
  const tilesDepois = participants.map((p) => p.fp)
  assert.deepEqual(tilesVistos, ['peer-b'])
  assert.deepEqual(tilesDepois, ['peer-b', 'peer-c'])
  assert.notDeepEqual(tilesVistos, tilesDepois)
})
