import test from 'node:test'
import assert from 'node:assert/strict'
import { getIceServers } from '../src/services/callIce.ts'
import {
  setCallPrivacyForIce,
  getCallPrivacyForIce,
  isIcePublicFallbackSuppressed,
} from '../src/services/callIcePrivacy.ts'

function allUrls(list: ReturnType<typeof getIceServers>): string {
  return list.map(s => (Array.isArray(s.urls) ? s.urls.join(' ') : String(s.urls ?? ''))).join(' ')
}

test('modo comum (normal): STUN de reserva presente e NENHUM TURN morto anunciado', () => {
  setCallPrivacyForIce('normal')
  const urls = allUrls(getIceServers())
  assert.ok(urls.includes('stun:'), 'modo normal precisa de STUN de reserva (4G/CGNAT depende disto)')
  assert.ok(!urls.includes('turn:'), 'TURN público quebrado não pode voltar para a lista')
  assert.ok(!urls.includes('openrelay'), 'openrelay saiu: o domínio não serve mais relay')
})

test('modo encrypted: igual ao normal (padrão do app)', () => {
  setCallPrivacyForIce('encrypted')
  assert.ok(allUrls(getIceServers()).includes('stun:'))
})

test('proxy: NENHUM servidor público de terceiros na lista', () => {
  setCallPrivacyForIce('proxy')
  const urls = allUrls(getIceServers())
  assert.ok(!urls.includes('stun:'), 'em proxy, STUN público vazaria o IP para terceiros')
  assert.ok(!urls.includes('turn:'), 'em proxy, TURN público vazaria o IP para terceiros')
  assert.equal(getIceServers().length, 0, 'sem TURN configurado pelo usuário, a lista fica VAZIA (honesto)')
})

test('full (Tor): NENHUM servidor público — mesmo sem passar pelo Tor', () => {
  setCallPrivacyForIce('full')
  const urls = allUrls(getIceServers())
  assert.ok(!urls.includes('stun:'), 'em Tor, STUN público vazaria o IP real')
  assert.ok(!urls.includes('turn:'))
})

test('override da UI tem precedência e volta ao normal', () => {
  setCallPrivacyForIce('full')
  assert.equal(getCallPrivacyForIce(), 'full')
  assert.equal(isIcePublicFallbackSuppressed(), true)
  setCallPrivacyForIce('encrypted')
  assert.equal(isIcePublicFallbackSuppressed(), false)
  assert.ok(allUrls(getIceServers()).includes('stun:'), 'voltou ao modo comum: reservas presentes')
})

test('null = sem override (comportamento legado do browser)', () => {
  setCallPrivacyForIce(null)
  assert.equal(getCallPrivacyForIce(), null, 'sem override e sem localStorage: null honesto')
  assert.equal(typeof isIcePublicFallbackSuppressed(), 'boolean')
})
