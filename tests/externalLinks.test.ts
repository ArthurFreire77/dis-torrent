import test from 'node:test'
import assert from 'node:assert/strict'

import { canOpenExternally, isDeepLinkUrl, isExternalUrl } from '../src/shared/externalLinks.ts'

const APP = 'http://tauri.localhost'

test('endereço externo (https) é de fora do app', () => {
  assert.equal(isExternalUrl('https://github.com/ArthurFreire77/dis-torrent', APP), true)
})

test('deep link do próprio app é externo: quem abre é o SO', () => {
  assert.equal(isExternalUrl('distorrent://invite?invite=abc', APP), true)
})

test('navegação interna do router não é externa', () => {
  assert.equal(isExternalUrl('/d/distorrent', APP), false)
  assert.equal(isExternalUrl('#secao', APP), false)
  assert.equal(isExternalUrl('?invite=abc', APP), false)
  assert.equal(isExternalUrl('http://tauri.localhost/invite/abc', APP), false)
})

test('esquemas perigosos não viram "externo" (não saem para o SO)', () => {
  assert.equal(isExternalUrl('javascript:alert(1)', APP), false)
  assert.equal(isExternalUrl('file:///C:/Windows/System32/calc.exe', APP), false)
  assert.equal(isExternalUrl('data:text/html,<h1>x</h1>', APP), false)
  assert.equal(canOpenExternally('javascript:alert(1)'), false)
  assert.equal(canOpenExternally('file:///etc/passwd'), false)
})

test('allowlist de abertura repete a do backend', () => {
  assert.equal(canOpenExternally('https://exemplo.com'), true)
  assert.equal(canOpenExternally('http://192.168.0.10:5173/invite/abc'), true)
  assert.equal(canOpenExternally('distorrent://invite?invite=abc'), true)
  assert.equal(canOpenExternally('mailto:alguem@exemplo.com'), true)
})

test('endereço vazio ou malformado nunca é externo', () => {
  assert.equal(isExternalUrl('', APP), false)
  assert.equal(isExternalUrl('   ', APP), false)
  assert.equal(canOpenExternally('nada'), false)
})

test('isDeepLinkUrl separa esquema próprio de http(s)', () => {
  assert.equal(isDeepLinkUrl('distorrent://invite?invite=abc'), true)
  assert.equal(isDeepLinkUrl('https://exemplo.com'), false)
  assert.equal(isDeepLinkUrl('http://localhost:5173/invite/abc'), false)
  assert.equal(isDeepLinkUrl('lixo'), false)
})
