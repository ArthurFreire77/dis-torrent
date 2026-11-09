import test from 'node:test'
import assert from 'node:assert/strict'

import { fallbackContactLabel, resolveContactName, shortFp } from '../src/services/contactNames.ts'

const ME = 'aaaaaaaaaaaa'
const PEER = 'bbbbbbbbbbbb'

test('o meu nome sou eu, nunca o nome do servidor', () => {
  assert.equal(resolveContactName({ fp: ME, myFp: ME, myNickname: 'Lucas' }), 'Lucas')
  assert.equal(
    resolveContactName({ fp: ME, myFp: ME, myNickname: '', serverNickname: 'Servidor do Lucas' }),
    'você',
    'sem apelido meu, o rótulo é "você" — nunca o nome de um servidor',
  )
})

test('nome de SERVIDOR não vira nome de pessoa (bug da chamada)', () => {
  assert.equal(
    resolveContactName({ fp: PEER, myFp: ME, myNickname: 'Lucas', knownNickname: '' }),
    shortFp(PEER),
    'sem perfil/apelido a saída é o fingerprint curto, não o nome do servidor',
  )
})

test('apelido do servidor vence o perfil, que vence o registro de peer', () => {
  assert.equal(
    resolveContactName({
      fp: PEER,
      serverNickname: 'Nick do servidor',
      profileName: 'Nome do perfil',
      knownNickname: 'Apelido antigo',
    }),
    'Nick do servidor',
  )
  assert.equal(
    resolveContactName({ fp: PEER, profileName: 'Nome do perfil', knownNickname: 'Apelido antigo' }),
    'Nome do perfil',
  )
  assert.equal(resolveContactName({ fp: PEER, knownNickname: 'Apelido antigo' }), 'Apelido antigo')
})

test('campos vazios ou só espaços não viram nome', () => {
  assert.equal(
    resolveContactName({ fp: PEER, serverNickname: '   ', profileName: '', knownNickname: '  ' }),
    shortFp(PEER),
  )
})

test('sem fp não inventa nome', () => {
  assert.equal(resolveContactName({ fp: '' }), '')
  assert.equal(fallbackContactLabel(PEER), PEER.slice(0, 8))
  assert.equal(shortFp('curto'), 'curto')
})
