import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { playbackGain, MAX_PARTICIPANT_VOLUME } from '../src/services/callPlayback.ts'

/**
 * Regressão do volume: no WebView2 o `createMediaElementSource` com `srcObject`
 * (o áudio da call) deixa o som MUDO — medido no app real (pico 0.0). O boost
 * só pode usar MediaElementSource para arquivo; para a call, MediaStreamSource.
 */

const src = readFileSync(new URL('../src/services/callPlayback.ts', import.meta.url), 'utf8')

test('até 100% o ganho é o volume do elemento; acima, o GainNode amplifica', () => {
  assert.deepEqual(playbackGain(0), { elementVolume: 0, gain: 1 })
  assert.deepEqual(playbackGain(50), { elementVolume: 0.5, gain: 1 })
  assert.deepEqual(playbackGain(100), { elementVolume: 1, gain: 1 })
  assert.deepEqual(playbackGain(150), { elementVolume: 1, gain: 1.5 })
  assert.deepEqual(playbackGain(200), { elementVolume: 1, gain: 2 })
  assert.equal(MAX_PARTICIPANT_VOLUME, 200)
})

test('a call usa MediaStreamSource, nunca MediaElementSource com srcObject', () => {
  assert.match(
    src,
    /createMediaStreamSource\(stream\)/,
    'a stream da call precisa entrar pelo MediaStreamSource (MediaElement fica mudo)',
  )
  // O comentário registra a medição para ninguém "otimizar" de volta.
  assert.match(src, /pico 0|MUDO/i, 'o motivo precisa estar escrito no código')
})

test('com o grafo da stream, o elemento fica mudo e o volume vai pelo gain', () => {
  assert.match(src, /pelaStream/, 'precisa distinguir o caminho da stream')
  assert.match(
    src,
    /element\.muted = true/,
    'sem mutar o elemento o som sairia duas vezes',
  )
  assert.match(
    src,
    /graph!\.gain\.gain\.value = mudo \? 0 : gain/,
    'mute e volume precisam ser aplicados no ganho da stream',
  )
})

test('falha ao criar o grafo não pode deixar o som mudo em silêncio', () => {
  assert.match(src, /boostFailed/, 'precisa marcar o elemento que não aceita boost')
  assert.match(
    src,
    /boostFailed\.add\(element\)/,
    'sem a marca, cada render tentaria de novo e o áudio ficaria fora do ar',
  )
})
