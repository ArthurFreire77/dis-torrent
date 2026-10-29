import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CALL_PLAYBACK_STORAGE_KEY,
  applyParticipantPlayback,
  getParticipantPlaybackSettings,
  saveParticipantPlaybackSettings,
  type KeyValueStorage,
} from '../src/services/callPlayback.ts'

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
  }
}

test('volume e mute por participante persistem sem afetar outras identidades', () => {
  const storage = memoryStorage()
  assert.deepEqual(getParticipantPlaybackSettings('peer-a', storage), { volume: 100, muted: false })
  saveParticipantPlaybackSettings('peer-a', { volume: 35, muted: true }, storage)
  saveParticipantPlaybackSettings('peer-b', { volume: 80 }, storage)
  assert.deepEqual(getParticipantPlaybackSettings('peer-a', storage), { volume: 35, muted: true })
  assert.deepEqual(getParticipantPlaybackSettings('peer-b', storage), { volume: 80, muted: false })
})

test('volume é limitado a 0–100 e JSON corrompido volta ao padrão', () => {
  const storage = memoryStorage()
  saveParticipantPlaybackSettings('peer-a', { volume: 1000 }, storage)
  assert.equal(getParticipantPlaybackSettings('peer-a', storage).volume, 100)
  storage.setItem(CALL_PLAYBACK_STORAGE_KEY, '{inválido')
  assert.deepEqual(getParticipantPlaybackSettings('peer-a', storage), { volume: 100, muted: false })
})

test('ganho local aplica mute individual e respeita o mute geral da chamada', () => {
  const audio = { volume: 1, muted: false }
  applyParticipantPlayback(audio, 'peer-a', false, { volume: 42, muted: false })
  assert.deepEqual(audio, { volume: 0.42, muted: false })
  applyParticipantPlayback(audio, 'peer-a', true, { volume: 42, muted: false })
  assert.deepEqual(audio, { volume: 0.42, muted: true })
  applyParticipantPlayback(audio, 'peer-a', false, { volume: 0, muted: true })
  assert.deepEqual(audio, { volume: 0, muted: true })
})
