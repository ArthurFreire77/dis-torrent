import { test } from 'node:test'
import assert from 'node:assert/strict'
import { notificationIdFor } from '../src/services/notificationRules.ts'

// A regra de amizade usa o mesmo `notificationIdFor` das mensagens. Testamos o
// contrato que importa: ids estáveis por chave e distintos entre tipos, para
// um pedido não sobrescrever o aviso de mensagem da mesma pessoa.
test('id de aviso é estável e distinto por tipo de evento', () => {
  const pedido = notificationIdFor('friend:request:abcd1234')
  assert.equal(pedido, notificationIdFor('friend:request:abcd1234'))
  assert.notEqual(pedido, notificationIdFor('friend:accepted:abcd1234'))
  assert.notEqual(pedido, notificationIdFor('friend:removed:abcd1234'))
  assert.notEqual(pedido, notificationIdFor('conv:abcd1234'))
  assert.ok(pedido > 0)
})

test('id fica na faixa aceita pelo SO', () => {
  for (const key of ['friend:request:a', 'friend:accepted:b', 'friend:removed:c', 'conv:x']) {
    const id = notificationIdFor(key)
    assert.ok(id >= 1 && id <= 2_000_000_000, `fora da faixa: ${id}`)
  }
})
