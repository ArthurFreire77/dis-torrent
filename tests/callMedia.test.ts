import test from 'node:test'
import assert from 'node:assert/strict'
import { setCallVideoSending, type CallVideoDirection } from '../src/services/callMedia.ts'

function transceiver(direction: CallVideoDirection) {
  return { direction }
}

test('regressão: compartilhar tela promove vídeo recvonly para sendrecv', () => {
  const video = transceiver('recvonly')
  assert.equal(setCallVideoSending(video, true), true)
  assert.equal(video.direction, 'sendrecv')
})

test('regressão: transceiver inactive também é promovido ao enviar câmera ou tela', () => {
  const video = transceiver('inactive')
  assert.equal(setCallVideoSending(video, true), true)
  assert.equal(video.direction, 'sendrecv')
})

test('regressão: parar vídeo local preserva a recepção remota', () => {
  const video = transceiver('sendrecv')
  assert.equal(setCallVideoSending(video, false), true)
  assert.equal(video.direction, 'recvonly')
})

test('direção não muda quando o estado de envio já está aplicado', () => {
  const video = transceiver('sendrecv')
  assert.equal(setCallVideoSending(video, true), false)
  assert.equal(video.direction, 'sendrecv')
})
