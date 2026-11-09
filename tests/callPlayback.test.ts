import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CALL_PLAYBACK_STORAGE_KEY,
  MAX_PARTICIPANT_VOLUME,
  applyParticipantPlayback,
  getParticipantPlaybackSettings,
  playbackGain,
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

test('volume é limitado a 0–200 e JSON corrompido volta ao padrão', () => {
  const storage = memoryStorage()
  saveParticipantPlaybackSettings('peer-a', { volume: 1000 }, storage)
  assert.equal(getParticipantPlaybackSettings('peer-a', storage).volume, MAX_PARTICIPANT_VOLUME)
  saveParticipantPlaybackSettings('peer-a', { volume: -50 }, storage)
  assert.equal(getParticipantPlaybackSettings('peer-a', storage).volume, 0)
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

test('volume acima de 100% é permitido e limitado a 200%', () => {
  const storage = memoryStorage()
  saveParticipantPlaybackSettings('peer-a', { volume: 150 }, storage)
  assert.equal(getParticipantPlaybackSettings('peer-a', storage).volume, 150)
  saveParticipantPlaybackSettings('peer-a', { volume: 900 }, storage)
  assert.equal(getParticipantPlaybackSettings('peer-a', storage).volume, MAX_PARTICIPANT_VOLUME)
  assert.equal(MAX_PARTICIPANT_VOLUME, 200)
})

test('até 100% usa o volume do elemento; acima disso o ganho do amplificador', () => {
  assert.deepEqual(playbackGain(0), { elementVolume: 0, gain: 1 })
  assert.deepEqual(playbackGain(55), { elementVolume: 0.55, gain: 1 })
  assert.deepEqual(playbackGain(100), { elementVolume: 1, gain: 1 })
  assert.deepEqual(playbackGain(150), { elementVolume: 1, gain: 1.5 })
  assert.deepEqual(playbackGain(200), { elementVolume: 1, gain: 2 })
  assert.deepEqual(playbackGain(1000), { elementVolume: 1, gain: 2 }, 'nada acima do teto')
})

test('elemento acima de 100% nunca recebe volume > 1 (o teto do HTMLMediaElement)', () => {
  const audio = { volume: 1, muted: false }
  applyParticipantPlayback(audio, 'peer-a', false, { volume: 180, muted: false })
  assert.equal(audio.volume, 1, 'o resto do ganho fica no GainNode, não no elemento')
  assert.equal(audio.muted, false)
})
