import test from 'node:test'
import assert from 'node:assert/strict'

import { shouldFallbackToRelay, shouldDropRelayAfterIceRecovered, relayCoversVideo } from '../src/services/callRelayFallback.ts'

const base = { relayActive: false, relaySupported: true, phase: 'connecting', relayManual: false }

test('cai para o áudio da sinalização quando o ICE não fecha (era o "conectando infinito")', () => {
  assert.equal(shouldFallbackToRelay(base), true)
})

test('não tenta duas vezes quando o relay já está no ar', () => {
  assert.equal(shouldFallbackToRelay({ ...base, relayActive: true }), false)
})

test('sem MediaRecorder/AudioContext não promete uma rota que não existe', () => {
  assert.equal(shouldFallbackToRelay({ ...base, relaySupported: false }), false)
})

test('escolha manual do usuário não é sobrescrita pela queda automática', () => {
  assert.equal(shouldFallbackToRelay({ ...base, relayManual: true }), false)
})

test('não mexe em chamada que já terminou ou nem começou', () => {
  for (const phase of ['idle', 'ended', 'failed', 'rejected', 'missed', 'connected']) {
    assert.equal(shouldFallbackToRelay({ ...base, phase }), false, `fase ${phase} não deve ligar o relay`)
  }
})

test('vale nas fases em que a chamada ainda pode conectar', () => {
  for (const phase of ['outgoing', 'connecting', 'reconnecting']) {
    assert.equal(shouldFallbackToRelay({ ...base, phase }), true, `fase ${phase} precisa da rede de segurança`)
  }
})

test('quando o ICE volta, o relay automático sai de cena (evita áudio duplicado)', () => {
  assert.equal(shouldDropRelayAfterIceRecovered({ relayActive: true, relayManual: false }), true)
  assert.equal(shouldDropRelayAfterIceRecovered({ relayActive: true, relayManual: true }), false)
  assert.equal(shouldDropRelayAfterIceRecovered({ relayActive: false, relayManual: false }), false)
})

test('a rota de reserva carrega só áudio — nunca prometer vídeo por ela', () => {
  assert.equal(relayCoversVideo(), false)
})
