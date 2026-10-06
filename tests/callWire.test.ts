// Testes do formato de sinalização no fio: o caminho do navegador usa
// {type,sdp} em JSON e a camada nativa (Rust) usa SDP/candidato crus. Os dois
// têm que ser aceitos — chamada mista (Linux nativo ↔ Windows navegador)
// dependia disto para negociar.

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseWireSdp, parseWireCandidate } from '../src/services/callWire.ts'

const JSON_OFFER = JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' })
const RAW_OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n'
const JSON_ANSWER = JSON.stringify({ type: 'answer', sdp: 'v=0\r\na=answer\r\n' })
const RAW_ANSWER = 'v=0\r\na=answer\r\n'

test('parseWireSdp: JSON do navegador', () => {
  assert.deepEqual(parseWireSdp(JSON_OFFER, 'offer'), { type: 'offer', sdp: JSON.parse(JSON_OFFER).sdp })
  assert.deepEqual(parseWireSdp(JSON_ANSWER, 'answer'), { type: 'answer', sdp: JSON.parse(JSON_ANSWER).sdp })
})

test('parseWireSdp: SDP cru da camada nativa (Rust)', () => {
  assert.deepEqual(parseWireSdp(RAW_OFFER, 'offer'), { type: 'offer', sdp: RAW_OFFER })
  assert.deepEqual(parseWireSdp(RAW_ANSWER, 'answer'), { type: 'answer', sdp: RAW_ANSWER })
})

test('parseWireSdp: lixo/nada/typo confuso não passa', () => {
  assert.equal(parseWireSdp(null, 'offer'), null)
  assert.equal(parseWireSdp('', 'offer'), null)
  assert.equal(parseWireSdp('isto-nao-e-um-sdp', 'offer'), null)
  assert.equal(parseWireSdp('{quebrado', 'offer'), null)
  // tipo trocado não vale
  assert.equal(parseWireSdp(JSON_OFFER, 'answer'), null)
  assert.equal(parseWireSdp(JSON_ANSWER, 'offer'), null)
  // JSON sem sdp
  assert.equal(parseWireSdp(JSON.stringify({ type: 'offer' }), 'offer'), null)
})

test('parseWireCandidate: JSON do navegador', () => {
  const c = { candidate: 'candidate:1 1 udp 1 0.0.0.0 9 typ host', sdpMid: '0' }
  assert.deepEqual(parseWireCandidate(JSON.stringify(c)), c)
})

test('parseWireCandidate: candidato cru da camada nativa', () => {
  const raw = 'candidate:1 1 udp 2130706431 192.168.0.10 50000 typ host'
  const got = parseWireCandidate(raw)
  assert.ok(got)
  assert.equal(got!.candidate, raw)
})

test('parseWireCandidate: string vazia = fim do gathering (válida)', () => {
  const got = parseWireCandidate('')
  assert.ok(got)
  assert.equal(got!.candidate, '')
})

test('parseWireCandidate: lixo não passa', () => {
  assert.equal(parseWireCandidate(null), null)
  assert.equal(parseWireCandidate(42 as unknown), null)
  assert.equal(parseWireCandidate('não-candidato'), null)
  assert.equal(parseWireCandidate('{"candidate": 7}'), null)
})
