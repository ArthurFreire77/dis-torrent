import test from 'node:test'
import assert from 'node:assert/strict'
import {
  nextCallPhase,
  CALL_PHASE_LABELS,
  isCallPhaseActive,
  isMediaPhase,
  type CallPhase,
  type CallEvent,
} from '../src/services/callPhases.ts'

const ALL_PHASES: CallPhase[] = [
  'idle', 'outgoing', 'incoming', 'connecting', 'connected',
  'reconnecting', 'ended', 'rejected', 'failed', 'missed',
]

test('idle: dial → outgoing; ring → incoming; demais eventos → idle', () => {
  assert.equal(nextCallPhase('idle', 'dial'), 'outgoing')
  assert.equal(nextCallPhase('idle', 'ring'), 'incoming')
  const others: CallEvent[] = ['accept', 'signal', 'media-connected', 'ice-failed', 'hangup']
  for (const ev of others) {
    assert.equal(nextCallPhase('idle', ev), 'idle', `idle + ${ev}`)
  }
})

test('outgoing: accept/signal → connecting; recusa/desligar → terminais', () => {
  assert.equal(nextCallPhase('outgoing', 'accept'), 'connecting')
  assert.equal(nextCallPhase('outgoing', 'signal'), 'connecting')
  assert.equal(nextCallPhase('outgoing', 'remote-reject'), 'rejected')
  assert.equal(nextCallPhase('outgoing', 'hangup'), 'ended')
  assert.equal(nextCallPhase('outgoing', 'remote-ended'), 'ended')
  // mídia do outro lado não conecta sozinha — sigo em "chamando"
  assert.equal(nextCallPhase('outgoing', 'media-connected'), 'outgoing')
})

test('incoming: accept → connecting; hangup → rejected; remote-ended → missed; ice-failed → incoming', () => {
  assert.equal(nextCallPhase('incoming', 'accept'), 'connecting')
  assert.equal(nextCallPhase('incoming', 'hangup'), 'rejected')
  assert.equal(nextCallPhase('incoming', 'remote-ended'), 'missed')
  assert.equal(nextCallPhase('incoming', 'ice-failed'), 'incoming')
})

test('connecting: media-connected → connected; remote-ended/hangup → ended', () => {
  assert.equal(nextCallPhase('connecting', 'media-connected'), 'connected')
  assert.equal(nextCallPhase('connecting', 'remote-ended'), 'ended')
  assert.equal(nextCallPhase('connecting', 'hangup'), 'ended')
})

test('connecting: ice-failed → reconnecting (senão o watchdog de CGNAT é no-op e trava em Conectando…)', () => {
  // Atrás de CGNAT o ICE não chega a 'failed': ele fica em 'checking' para
  // sempre. O watchdog de 'connecting' detecta a ausência de mídia e emite
  // 'ice-failed' — mas sem esta transição a fase ficaria presa em
  // 'connecting' (overlay "Conectando…" infinito) e o watchdog de reconexão
  // (que é o que encerra a chamada com aviso honesto) nunca seria armado.
  assert.equal(nextCallPhase('connecting', 'ice-failed'), 'reconnecting')
  // De 'connecting' não se volta para 'connecting' por 'signal' (senão o
  // watchdog de conexão re-armaria em loop).
  assert.equal(nextCallPhase('connecting', 'signal'), 'connecting')
  assert.equal(nextCallPhase('connecting', 'accept'), 'connecting')
  // E de 'reconnecting' o ICE falhar de novo não reinicia o ciclo.
  assert.equal(nextCallPhase('reconnecting', 'ice-failed'), 'reconnecting')
})

test('CGNAT: o caminho connecting → terminating é TERMINAL (nada de "Conectando…" infinito)', () => {
  // Este é o contrato do watchdog de conexão no CGNAT: ICE mudo → 'ice-failed'
  // → 'reconnecting' → orçamento de restarts esgotado → 'reconnect-timeout' →
  // 'failed' (terminal). Se algum elo sumisse, a chamada ficaria presa em
  // overlay para sempre, que é exatamente o sintoma reportado.
  let p: CallPhase = 'connecting'
  p = nextCallPhase(p, 'ice-failed')
  assert.equal(p, 'reconnecting')
  p = nextCallPhase(p, 'ice-failed')
  assert.equal(p, 'reconnecting', 'ICE repetido não abre novo ciclo')
  p = nextCallPhase(p, 'reconnect-timeout')
  assert.equal(p, 'failed')
  // Terminal de verdade: nem mesmo um novo ice-failed reabre.
  assert.equal(nextCallPhase(p, 'ice-failed'), 'failed')
  assert.equal(isCallPhaseActive(p), false)
})

test('connected: ice-failed → reconnecting; remote-ended/hangup → ended; signal não muda', () => {
  assert.equal(nextCallPhase('connected', 'ice-failed'), 'reconnecting')
  assert.equal(nextCallPhase('connected', 'remote-ended'), 'ended')
  assert.equal(nextCallPhase('connected', 'hangup'), 'ended')
  assert.equal(nextCallPhase('connected', 'signal'), 'connected')
})

test('reconnecting: mídia volta → connected; timeout → failed; terminais; peer-online mantém', () => {
  assert.equal(nextCallPhase('reconnecting', 'media-connected'), 'connected')
  assert.equal(nextCallPhase('reconnecting', 'media-reconnected'), 'connected')
  assert.equal(nextCallPhase('reconnecting', 'reconnect-timeout'), 'failed')
  assert.equal(nextCallPhase('reconnecting', 'remote-ended'), 'ended')
  assert.equal(nextCallPhase('reconnecting', 'hangup'), 'ended')
  // peer-online não está no union CallEvent (comentário do módulo) — cast mantém o caso coberto
  assert.equal(nextCallPhase('reconnecting', 'peer-online' as CallEvent), 'reconnecting')
})

test('terminais (ended/rejected/failed/missed): nenhum evento reabre', () => {
  const terminals: CallPhase[] = ['ended', 'rejected', 'failed', 'missed']
  const events: CallEvent[] = ['dial', 'accept', 'media-connected']
  for (const st of terminals) {
    for (const ev of events) {
      assert.equal(nextCallPhase(st, ev), st, `${st} + ${ev}`)
    }
  }
})

test('isCallPhaseActive: true só nas fases de overlay aberto', () => {
  const active: CallPhase[] = ['outgoing', 'incoming', 'connecting', 'connected', 'reconnecting']
  const inactive: CallPhase[] = ['idle', 'ended', 'rejected', 'failed', 'missed']
  for (const p of active) assert.equal(isCallPhaseActive(p), true, `ativo: ${p}`)
  for (const p of inactive) assert.equal(isCallPhaseActive(p), false, `inativo: ${p}`)
  assert.equal(active.length + inactive.length, ALL_PHASES.length)
})

test('isMediaPhase: true só em connecting/connected/reconnecting', () => {
  const media: CallPhase[] = ['connecting', 'connected', 'reconnecting']
  const notMedia: CallPhase[] = ['idle', 'outgoing', 'incoming', 'ended', 'rejected', 'failed', 'missed']
  for (const p of media) assert.equal(isMediaPhase(p), true, `mídia: ${p}`)
  for (const p of notMedia) assert.equal(isMediaPhase(p), false, `sem mídia: ${p}`)
})

test('CALL_PHASE_LABELS: 10 fases cobertas, vazio só em idle', () => {
  assert.equal(Object.keys(CALL_PHASE_LABELS).length, 10)
  for (const p of ALL_PHASES) {
    assert.ok(p in CALL_PHASE_LABELS, `falta label para ${p}`)
    if (p === 'idle') assert.equal(CALL_PHASE_LABELS[p], '')
    else assert.notEqual(CALL_PHASE_LABELS[p], '', `label vazio em ${p}`)
  }
})

// ── relay-only: sem RTCPeerConnection não existe ICE, então a fase só pode
// sair de outgoing/connecting por `relay-audio-live` (áudio subindo/tocando).
test('relay-only sai de outgoing quando o áudio sobe', () => {
  assert.equal(nextCallPhase('outgoing', 'relay-audio-live'), 'connected')
})
test('relay-only sai de connecting quando o áudio toca', () => {
  assert.equal(nextCallPhase('connecting', 'relay-audio-live'), 'connected')
})
test('relay-audio-live tira de reconnecting também', () => {
  assert.equal(nextCallPhase('reconnecting', 'relay-audio-live'), 'connected')
})
test('relay-audio-live não mexe em connected nem em terminais', () => {
  assert.equal(nextCallPhase('connected', 'relay-audio-live'), 'connected')
  assert.equal(nextCallPhase('ended', 'relay-audio-live'), 'ended')
  assert.equal(nextCallPhase('rejected', 'relay-audio-live'), 'rejected')
  assert.equal(nextCallPhase('idle', 'relay-audio-live'), 'idle')
})
