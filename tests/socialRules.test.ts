import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canOpenConversation,
  contactBadge,
  effectivePresence,
  introState,
  pendingRequestsCount,
  relationOf,
} from '../src/services/socialRules.ts'

test('relação traduz cada status persistido', () => {
  const me = 'aaaaaaaaaaaa'
  assert.equal(relationOf(null, me), 'none')
  assert.equal(relationOf({ fp: me, status: 'accepted' }, me), 'self')
  assert.equal(relationOf({ fp: 'bbbbbbbbbbbb', status: 'accepted' }, me), 'friend')
  assert.equal(relationOf({ fp: 'bbbbbbbbbbbb', status: 'blocked' }, me), 'blocked')
  assert.equal(relationOf({ fp: 'bbbbbbbbbbbb', status: 'pending_in' }, me), 'request_in')
  assert.equal(relationOf({ fp: 'bbbbbbbbbbbb', status: 'pending_out' }, me), 'request_out')
  assert.equal(relationOf({ fp: 'bbbbbbbbbbbb', status: 'rejected' }, me), 'none')
})

test('contato elegível abre conversa; desconhecido e bloqueado não', () => {
  assert.equal(canOpenConversation({ relation: 'friend' }), true)
  assert.equal(canOpenConversation({ relation: 'none', sharedGroup: true }), true)
  assert.equal(canOpenConversation({ relation: 'none', sharedCommunity: true }), true)
  assert.equal(canOpenConversation({ relation: 'none' }), false, 'desconhecido não pode')
  assert.equal(canOpenConversation({ relation: 'blocked', sharedGroup: true }), false)
  assert.equal(canOpenConversation({ relation: 'self' }), false)
})

test('limite de três mensagens: contagem, esgotamento e liberação', () => {
  const first = introState({ isFriend: false, used: 0 })
  assert.equal(first.remaining, 3)
  assert.equal(first.blocked, false)
  assert.match(first.hint ?? '', /3 mensagens/)

  const second = introState({ isFriend: false, used: 2 })
  assert.equal(second.remaining, 1)
  assert.match(second.hint ?? '', /3/)

  const exhausted = introState({ isFriend: false, used: 3 })
  assert.equal(exhausted.remaining, 0)
  assert.equal(exhausted.blocked, true)
  assert.match(exhausted.hint ?? '', /solicitação/i)

  const friend = introState({ isFriend: true, used: 99 })
  assert.equal(friend.unlimited, true)
  assert.equal(friend.blocked, false)
  assert.equal(friend.hint, null, 'amigo não vê faixa de limite')
})

test('contador acima do limite é limitado, nunca negativo', () => {
  const st = introState({ isFriend: false, used: -5 })
  assert.equal(st.remaining, 3)
  assert.equal(introState({ isFriend: false, used: 999 }).remaining, 0)
})

test('badge do contato diz a relação real', () => {
  assert.equal(contactBadge({ relation: 'friend' }), 'amigo')
  assert.equal(contactBadge({ relation: 'request_in' }), 'solicitação')
  assert.equal(contactBadge({ relation: 'request_out' }), 'solicitado')
  assert.equal(contactBadge({ relation: 'blocked' }), 'bloqueado')
  assert.equal(contactBadge({ relation: 'none', sharedGroup: true }), 'mesmo grupo')
  assert.equal(contactBadge({ relation: 'none', sharedCommunity: true }), 'mesmo servidor')
  assert.equal(contactBadge({ relation: 'none' }), 'contato')
})

test('presença: invisível não vira online só por estar conectado', () => {
  assert.equal(effectivePresence({ connected: true }), 'online')
  assert.equal(effectivePresence({ connected: true, chosen: 'invisible' }), 'invisible')
  assert.equal(effectivePresence({ connected: true, chosen: 'idle' }), 'idle')
  assert.equal(effectivePresence({ connected: true, chosen: 'dnd' }), 'dnd')
  assert.equal(
    effectivePresence({ connected: false, chosen: 'online' }),
    'offline',
    'sem link não há como conversar: offline vence o status escolhido',
  )
})

test('só pedidos recebidos contam como pendentes', () => {
  assert.equal(
    pendingRequestsCount([
      { fp: 'a', status: 'pending_in' },
      { fp: 'b', status: 'pending_out' },
      { fp: 'c', status: 'accepted' },
      { fp: 'd', status: 'pending_in' },
    ]),
    2,
  )
})
