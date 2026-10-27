// Testes de PRIVACIDADE × ICE: em proxy/full os SERVIDORES PÚBLICOS de
// STUN/TURN (Google, openrelay) NÃO podem entrar na lista — o ICE do WebRTC
// usa sockets UDP diretos do WebView (fora do SOCKS5/Tor do app), então
// consultá-los entregaria o IP real a terceiros que o modo promete esconder.
// Este é o bug real que o gate corrige: a lista era IGUAL em todos os modos.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getIceServers,
  setCallPrivacyForIce,
  getCallPrivacyForIce,
  isIcePublicFallbackSuppressed,
} from '../src/services/callManager.ts'

// helper: todas as URLs de uma lista de ICE como string única (comparações)
function allUrls(list: ReturnType<typeof getIceServers>): string {
  return list.map(s => (Array.isArray(s.urls) ? s.urls.join(' ') : String(s.urls ?? ''))).join(' ')
}

test('modo comum (normal): rotas públicas de reserva presentes', () => {
  setCallPrivacyForIce('normal')
  const urls = allUrls(getIceServers())
  assert.ok(urls.includes('stun:'), 'modo normal precisa de STUN de reserva (4G/CGNAT depende disto)')
  assert.ok(urls.includes('turn:'), 'modo normal precisa de TURN de reserva')
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
  // isIcePublicFallbackSuppressed não pode explodir sem modo conhecido
  assert.equal(typeof isIcePublicFallbackSuppressed(), 'boolean')
})
