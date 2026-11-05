import test from 'node:test'
import assert from 'node:assert/strict'

import { mergeRemoteStream, type RemoteStreamLike, type RemoteTrackLike } from '../src/services/callRemoteTracks.ts'

class FakeStream implements RemoteStreamLike<RemoteTrackLike> {
  tracks: RemoteTrackLike[] = []
  constructor(tracks: RemoteTrackLike[] = []) { this.tracks = tracks }
  getTracks() { return this.tracks }
  addTrack(track: RemoteTrackLike) {
    if (!this.tracks.some((t) => t.id === track.id)) this.tracks.push(track)
  }
  removeTrack(track: RemoteTrackLike) {
    this.tracks = this.tracks.filter((t) => t.id !== track.id)
  }
}

const audio = (id = 'a1'): RemoteTrackLike => ({ id, kind: 'audio' })
const video = (id: string): RemoteTrackLike => ({ id, kind: 'video' })

test('áudio e vídeo novos entram no stream', () => {
  const alvo = new FakeStream([audio()])
  const mudou = mergeRemoteStream(alvo, new FakeStream([video('v1')]))
  assert.equal(mudou, true)
  assert.deepEqual(alvo.getTracks().map((t) => t.id).sort(), ['a1', 'v1'])
})

test('track repetida não duplica nem marca mudança', () => {
  const alvo = new FakeStream([audio(), video('v1')])
  assert.equal(mergeRemoteStream(alvo, new FakeStream([video('v1')])), false)
  assert.equal(alvo.getTracks().length, 2)
})

test('vídeo novo SUBSTITUI o antigo (troca de fonte na mesma m-line)', () => {
  const alvo = new FakeStream([audio(), video('camera')])
  const mudou = mergeRemoteStream(alvo, new FakeStream([video('tela')]))
  assert.equal(mudou, true)
  assert.deepEqual(alvo.getTracks().map((t) => t.id), ['a1', 'tela'], 'a câmera antiga não pode continuar na frente')
})

test('áudio nunca é removido pela troca de vídeo', () => {
  const alvo = new FakeStream([audio('mic'), video('camera')])
  mergeRemoteStream(alvo, new FakeStream([audio('sistema'), video('tela')]))
  const ids = alvo.getTracks().map((t) => t.id)
  assert.ok(ids.includes('mic'), 'o áudio que já estava não pode sumir')
  assert.ok(ids.includes('sistema'), 'o áudio novo entra junto')
  assert.deepEqual(ids.filter((id) => id === 'camera' || id === 'tela'), ['tela'])
})
