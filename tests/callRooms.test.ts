import test from 'node:test'
import assert from 'node:assert/strict'

import { CallRoomStore, roomSummary } from '../src/services/callRooms.ts'
import { isCollectiveRoom, leaveOutcome } from '../src/services/callRoomRules.ts'

// Regressão do relato "chamada de 5 pessoas: um saiu, outro saiu e a chamada
// acabou". O CallManager trava a coletividade na primeira vez que ela é
// verdadeira; aqui reproduzimos a sequência de saídas sobre o MESMO valor
// travado, que era exatamente onde o cálculo errado acontecia.
test('cinco pessoas, duas saidas, a sala continua viva', () => {
  const room = { callId: 'call-grupo', participants: ['eu', 'a', 'b', 'c', 'd'] }
  // A sala é coletiva desde o início e a trava nunca é recalculada.
  const collective = isCollectiveRoom(room)
  assert.equal(collective, true)

  // 1ª saída: 'a' já foi removido do roster quando a checagem roda.
  let others = ['b', 'c', 'd']
  assert.equal(leaveOutcome({ collective, othersRemain: others.length > 0 }), 'keep')

  // 2ª saída: 'b' sai e a checagem roda com o roster ainda MENOR.
  others = ['c', 'd']
  assert.equal(leaveOutcome({ collective, othersRemain: others.length > 0 }), 'keep')

  // 3ª e 4ª saídas: mesmo eu ficando sozinho, a sala não é encerrada por isso.
  others = ['d']
  assert.equal(leaveOutcome({ collective, othersRemain: true }), 'keep')
  others = []
  assert.equal(leaveOutcome({ collective, othersRemain: false }), 'keep')
})

test('o calculo ERRADO (recalcular com roster reduzido) teria encerrado', () => {
  // Prova de que a correção importa: com 1 pessoa restante o cálculo antigo
  // dizia "não é coletiva", e era isso que matava a chamada.
  assert.equal(isCollectiveRoom({ callId: 'call-grupo', participants: ['eu'] }), false)
  // A trava evita consultar isso de novo no meio da chamada.
  assert.equal(leaveOutcome({ collective: true, othersRemain: false }), 'keep')
})

function open(convId: string, participants: string[] = ['host'], callId = `call-${convId}`) {
  return {
    conv_id: convId,
    call_id: callId,
    kind: 'voice',
    state: 'open',
    host_fp: participants[0] ?? 'host',
    participants,
  }
}

test('sala anunciada aparece e fecha com o evento do motor', () => {
  const s = new CallRoomStore()
  assert.equal(s.apply(open('conv-1')), true)
  assert.equal(s.get('conv-1')?.callId, 'call-conv-1')
  assert.equal(s.apply({ ...open('conv-1'), state: 'closed' }), true)
  assert.equal(s.get('conv-1'), null)
})

test('anúncio repetido não gera re-render (mesma referência)', () => {
  const s = new CallRoomStore()
  s.apply(open('conv-1', ['a', 'b']))
  const first = s.get('conv-1')
  // Mesmo conteúdo: não emite, não troca o objeto.
  assert.equal(s.apply(open('conv-1', ['a', 'b'])), false)
  assert.equal(s.get('conv-1'), first)
  // Lista diferente: atualiza.
  assert.equal(s.apply(open('conv-1', ['a', 'b', 'c'])), true)
  assert.equal(s.get('conv-1')?.participants.length, 3)
})

test('entrada e saída de gente atualiza a lista da sala', () => {
  const s = new CallRoomStore()
  s.apply(open('conv-1', ['host']))
  s.apply(open('conv-1', ['host', 'convidado']))
  assert.deepEqual(s.get('conv-1')?.participants, ['host', 'convidado'])
})

test('sala sem call_id é ignorada (não inventa chamada)', () => {
  const s = new CallRoomStore()
  assert.equal(s.apply({ ...open('conv-1'), call_id: '' }), false)
  assert.equal(s.get('conv-1'), null)
})

test('reset do boot descarta salas fechadas e lixo', () => {
  const s = new CallRoomStore()
  s.apply(open('velha'))
  s.reset([
    open('nova'),
    { ...open('fechada'), state: 'closed' },
    { conv_id: '' },
    null,
  ])
  assert.equal(s.get('velha'), null)
  assert.ok(s.get('nova'))
  assert.equal(s.get('fechada'), null)
})

test('assinantes recebem o mapa novo e um quebrado não derruba os outros', () => {
  const s = new CallRoomStore()
  let recebeu = 0
  s.subscribe(() => { throw new Error('assinante quebrado') })
  const off = s.subscribe((rooms) => { recebeu += rooms.size })
  s.apply(open('conv-1'))
  assert.equal(recebeu, 1)
  off()
  s.apply(open('conv-2'))
  assert.equal(recebeu, 1)
})

test('resumo da sala é honesto com 1 e com várias pessoas', () => {
  const nome = (fp: string) => ({ a: 'Ana', b: 'Bia', c: 'Caio' } as Record<string, string>)[fp] ?? fp
  assert.equal(roomSummary(null, nome), null)
  assert.equal(
    roomSummary({ convId: 'x', callId: 'c', kind: 'voice', hostFp: 'a', participants: ['a'] }, nome),
    '1 pessoa na chamada — Ana',
  )
  assert.equal(
    roomSummary({ convId: 'x', callId: 'c', kind: 'voice', hostFp: 'a', participants: ['a', 'b', 'c'] }, nome),
    '3 pessoas na chamada — Ana, Bia +1',
  )
  assert.equal(
    roomSummary({ convId: 'x', callId: 'c', kind: 'voice', hostFp: 'a', participants: [] }, nome),
    'chamada em andamento',
  )
})
