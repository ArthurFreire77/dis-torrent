import test from 'node:test'
import assert from 'node:assert/strict'

import { canalDeVozSozinho, faseExibida, outrosNaChamada } from '../src/services/voiceCallPhase.ts'

const ME = 'aaaaaaaaaaaa'

test('sozinho num canal de voz não fica "Conectando…" para sempre', () => {
  const input = {
    callId: 'voice-comunidade-canal',
    phase: 'connecting',
    participants: [{ fp: ME }],
    myFp: ME,
  }
  assert.equal(outrosNaChamada(input), 0)
  assert.equal(canalDeVozSozinho(input), true, 'não há par para negociar')
  assert.equal(faseExibida(input), 'connected', 'quem entrou no canal já está na chamada')
})

test('com outra pessoa no canal a fase real manda (conectando é honesto)', () => {
  const input = {
    callId: 'voice-c-c',
    phase: 'connecting',
    participants: [{ fp: ME }, { fp: 'bbbbbbbbbbbb' }],
    myFp: ME,
  }
  assert.equal(outrosNaChamada(input), 1)
  assert.equal(canalDeVozSozinho(input), false)
  assert.equal(faseExibida(input), 'connecting', 'há par: conectar é trabalho de verdade')
})

test('chamada de DM nunca vira "sozinho" por esta regra', () => {
  const input = {
    callId: 'call-abc-123',
    phase: 'connecting',
    participants: [{ fp: ME }],
    myFp: ME,
  }
  assert.equal(canalDeVozSozinho(input), false, 'só canal de voz usa a regra')
  assert.equal(faseExibida(input), 'connecting')
})

test('entrar no canal depois que o outro saiu volta a ser sozinho', () => {
  const comAlguem = {
    callId: 'voice-c-c',
    phase: 'connected',
    participants: [{ fp: ME }, { fp: 'bbbbbbbbbbbb' }],
    myFp: ME,
  }
  assert.equal(canalDeVozSozinho(comAlguem), false)
  const sozinho = { ...comAlguem, participants: [{ fp: ME }] }
  assert.equal(outrosNaChamada(sozinho), 0)
  assert.equal(faseExibida(sozinho), 'connected')
})

test('entrada inválida não quebra nem inventa fase', () => {
  assert.equal(outrosNaChamada({}), 0)
  assert.equal(canalDeVozSozinho({}), false)
  assert.equal(faseExibida({}), 'idle')
  assert.equal(faseExibida({ phase: 'connected' }), 'connected')
})

test('participante sem fp não conta como par', () => {
  const input = {
    callId: 'voice-c-c',
    phase: 'connecting',
    participants: [{ fp: '' }, { fp: null }, {}],
    myFp: ME,
  }
  assert.equal(outrosNaChamada(input), 0)
  assert.equal(canalDeVozSozinho(input), true)
})
