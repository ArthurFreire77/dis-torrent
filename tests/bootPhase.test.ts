import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBootPhase } from '../src/services/bootPhase.ts'

const vault = (has_identity: boolean, has_vault: boolean) => ({ has_identity, has_vault })
const id = { fingerprint: 'fp-eu', nickname: 'Eu' }

test('identidade carregada abre direto o app', () => {
  assert.equal(resolveBootPhase({ identity: id, vault: null, unlocked: null }), 'app')
})

test('sem identidade e sem cofre pede para criar conta', () => {
  assert.equal(
    resolveBootPhase({ identity: null, vault: vault(false, false), unlocked: null }),
    'create',
  )
})

test('cofre existente sem senha guardada pede a tela de destravar', () => {
  assert.equal(
    resolveBootPhase({ identity: null, vault: vault(true, true), unlocked: null }),
    'lock',
    'nunca abrir o app sem identidade só porque o destrave falhou',
  )
})

test('destrave automático deu certo: entra no app', () => {
  assert.equal(resolveBootPhase({ identity: null, vault: vault(true, true), unlocked: id }), 'app')
})

test('identidade no armazenamento local sem cofre entra no app', () => {
  assert.equal(
    resolveBootPhase({ identity: id, vault: vault(true, false), unlocked: null }),
    'app',
  )
})

test('cofre ilegível não vira app vazio', () => {
  assert.equal(
    resolveBootPhase({ identity: null, vault: null, unlocked: null }),
    'create',
    'sem resposta do cofre nada de abrir uma interface sem identidade — era a tela em branco',
  )
})

test('nunca decide app sem identidade nenhuma', () => {
  const casos = [
    { identity: null, vault: null, unlocked: null },
    { identity: null, vault: vault(false, false), unlocked: null },
    { identity: null, vault: vault(true, true), unlocked: null },
    { identity: null, vault: vault(true, false), unlocked: null },
  ]
  for (const c of casos) {
    assert.notEqual(
      resolveBootPhase(c),
      'app',
      'este é o estado que deixa a tela sem perfil e sem nada',
    )
  }
})
