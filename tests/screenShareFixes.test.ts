// Regressões do compartilhamento de tela corrigidas na auditoria.
//
// Cada teste aqui trava um bug REAL que existia antes:
//  - modo padrão "tela inteira" mandava `monitorTypeSurfaces:'exclude'`, o que
//    escondia os monitores e matava o áudio do sistema no Chromium;
//  - a mesma resolução era reduzida duas vezes (captura + encoder), então
//    "720p" saía em 640×360 e "480p" em ~214×120;
//  - "FPS automático" era um teto fixo de 60 escondido;
//  - o caminho nativo (Linux/WebKitGTK) aparecia sem fonte disponível e com
//    áudio do sistema "disponível" mesmo sem existir captura de loopback.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCREEN_DEFAULT_OPTIONS,
  buildDisplayMediaConstraints,
  buildSenderTuning,
  buildSourceChoices,
  detectScreenEnvironment,
  fpsOf,
  resolveStep,
  screenConstraints,
  supportsScreenSource,
  type ScreenShareOptions,
} from '../src/services/screenShare.ts'

const ENV = {
  ...detectScreenEnvironment(),
  hasDisplayMedia: true,
  displaySurfaces: ['screen', 'window', 'monitor'],
  systemAudio: true,
} as ReturnType<typeof detectScreenEnvironment>

function opts(patch: Partial<ScreenShareOptions>): ScreenShareOptions {
  return { ...SCREEN_DEFAULT_OPTIONS, ...patch }
}

test('regressão: "tela inteira" NÃO esconde os monitores no seletor do sistema', () => {
  const screen = buildDisplayMediaConstraints(opts({ source: 'screen', audio: 'system' }), ENV)
  assert.equal(screen.monitorTypeSurfaces, 'include', 'exclude removia os monitores e o áudio do sistema')
  const monitor = buildDisplayMediaConstraints(opts({ source: 'monitor' }), ENV)
  assert.equal(monitor.monitorTypeSurfaces, 'include')
  const window = buildDisplayMediaConstraints(opts({ source: 'window' }), ENV)
  assert.equal(window.monitorTypeSurfaces, 'exclude', 'só janela pode excluir monitores')
})

test('regressão: áudio do sistema pede restrictOwnAudio (evita eco de retorno)', () => {
  const withSystem = buildDisplayMediaConstraints(opts({ audio: 'system' }), ENV)
  assert.equal(withSystem.restrictOwnAudio, 'include')
  const none = buildDisplayMediaConstraints(opts({ audio: 'none' }), ENV)
  assert.equal(none.restrictOwnAudio, 'exclude')
})

test('regressão: sem escala dupla — 720p sai 720p, não 640×360', () => {
  const o = opts({ quality: '720p', fps: '60' })
  const c = screenConstraints(o) as Record<string, any>
  assert.equal(c.width.max, 1280)
  assert.equal(c.height.max, 720)
  const tuning = buildSenderTuning(o)
  assert.equal(tuning.scaleResolutionDownBy, 1, 'a captura já entrega 720p; dividir de novo vira 360p')
  // 480p também não pode ser dividido por 4 em cima da captura de 854×480.
  assert.equal(buildSenderTuning(opts({ quality: '480p' })).scaleResolutionDownBy, 1)
})

test('regressão: "FPS automático" não inventa teto de 60', () => {
  const o = opts({ quality: '720p', fps: 'auto' })
  assert.equal(fpsOf(resolveStep(o), o), null)
  const c = screenConstraints(o) as Record<string, any>
  assert.equal(c.frameRate, undefined, 'auto não deve impor frameRate')
  // FPS explícito continua valendo.
  assert.equal(fpsOf(resolveStep(o), opts({ fps: '30' })), 30)
})

test('regressão: tela preserva RESOLUÇÃO sob congestionamento (texto legível)', () => {
  assert.equal(buildSenderTuning(opts({ source: 'window' })).degradationPreference, 'maintain-resolution')
  assert.equal(buildSenderTuning(opts({ source: 'monitor' })).degradationPreference, 'maintain-resolution')
})

test('regressão: caminho nativo só oferece tela inteira e nega áudio do sistema', () => {
  const native = detectScreenEnvironment(true)
  assert.equal(native.backend, 'native')
  assert.equal(native.systemAudio, false, 'o core não captura loopback de áudio')
  assert.equal(supportsScreenSource(native, 'screen'), true)
  assert.equal(supportsScreenSource(native, 'window'), false)
  assert.equal(supportsScreenSource(native, 'monitor'), false)
  const choices = buildSourceChoices(native, 'screen')
  const win = choices.find(c => c.kind === 'window')
  assert.equal(win?.available, false)
  assert.match(String(win?.detail), /tela inteira/, 'o motivo precisa dizer que o nativo manda a tela toda')
})

test('regressão: backend none não oferece fonte nenhuma', () => {
  const none = detectScreenEnvironment(false)
  assert.equal(none.backend, 'none')
  assert.equal(buildSourceChoices(none, 'screen').every(c => !c.available), true)
})
