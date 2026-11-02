// Preferências de mídia da chamada (engrenagem): microfone/câmera, resolução,
// FPS e processamento de voz. Lógica pura — testada sem DOM.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CALL_MEDIA_PREFS,
  audioConstraintsFromPrefs,
  fpsToMax,
  parseCallMediaPrefs,
  qualityLabel,
  videoConstraintsFromPrefs,
  type CallMediaPrefs,
} from '../src/services/callMediaPrefs.ts'

const prefs = (patch: Partial<CallMediaPrefs> = {}): CallMediaPrefs => ({ ...DEFAULT_CALL_MEDIA_PREFS, ...patch })

test('padrão: 720p, fps automático, processamento de voz ligado', () => {
  const p = parseCallMediaPrefs(null)
  assert.equal(p.quality, '720p')
  assert.equal(p.fps, 'auto')
  assert.equal(p.echoCancellation, true)
  assert.equal(p.noiseSuppression, true)
  assert.equal(p.autoGainControl, true)
  assert.equal(p.audioInputId, '')
  assert.equal(p.videoInputId, '')
})

test('fps "auto" não fixa teto; número vira teto real', () => {
  // Sem teto = o aparelho escolhe (era o bug do "automático" virar 60).
  assert.equal(fpsToMax('auto'), undefined)
  assert.equal(fpsToMax('30'), 30)
  assert.equal(fpsToMax('60'), 60)
})

test('constraints de vídeo respeitam resolução e device escolhidos', () => {
  const c = videoConstraintsFromPrefs(prefs({ quality: '1080p', fps: '30', videoInputId: 'cam-2' }))
  assert.equal(c.width?.ideal, 1920)
  assert.equal(c.height?.ideal, 1080)
  assert.deepEqual(c.frameRate, { min: 15, ideal: 30, max: 30 })
  assert.deepEqual(c.deviceId, { exact: 'cam-2' })
})

test('fps automático NÃO manda frameRate (sem teto artificial)', () => {
  const c = videoConstraintsFromPrefs(prefs({ fps: 'auto' }))
  assert.equal(c.frameRate, undefined)
})

test('min de resolução fica folgado (câmera fraca não dá OverconstrainedError)', () => {
  // Pedir min igual ao ideal fazia a câmera frontal de celular nem abrir.
  const c = videoConstraintsFromPrefs(prefs({ quality: '4K' }))
  assert.equal((c.width as any).min, 320)
  assert.equal((c.height as any).min, 240)
})

test('constraints de áudio carregam processamento e device', () => {
  const c = audioConstraintsFromPrefs(prefs({
    audioInputId: 'mic-9', echoCancellation: false, noiseSuppression: true, autoGainControl: false,
  }))
  assert.equal(c.echoCancellation, false)
  assert.equal(c.noiseSuppression, true)
  assert.equal(c.autoGainControl, false)
  assert.equal(c.channelCount, 1)
  assert.deepEqual(c.deviceId, { exact: 'mic-9' })
})

test('sem device escolhido não manda deviceId (usa o padrão do sistema)', () => {
  const a = audioConstraintsFromPrefs(prefs())
  const v = videoConstraintsFromPrefs(prefs())
  assert.equal(a.deviceId, undefined)
  assert.equal(v.deviceId, undefined)
})

test('preferência corrompida ou de versão antiga cai no padrão sem lançar', () => {
  assert.equal(parseCallMediaPrefs('{{{ nao é json').quality, '720p')
  assert.equal(parseCallMediaPrefs(42).quality, '720p')
  // Valor fora das opções é descartado, o resto é preservado.
  const p = parseCallMediaPrefs({ quality: '8K', fps: '999', audioInputId: 'mic-1' })
  assert.equal(p.quality, '720p')
  assert.equal(p.fps, 'auto')
  assert.equal(p.audioInputId, 'mic-1')
})

test('JSON em string (localStorage) é lido igual a objeto', () => {
  const p = parseCallMediaPrefs(JSON.stringify({ quality: '1080p', fps: '60' }))
  assert.equal(p.quality, '1080p')
  assert.equal(p.fps, '60')
})

test('rótulo do degrau mostra resolução e fps honestos', () => {
  assert.equal(qualityLabel('720p', 'auto'), '1280×720 · fps auto')
  assert.equal(qualityLabel('1080p', '30'), '1920×1080 · 30 fps')
  assert.equal(qualityLabel('4K', '60'), '3840×2160 · 60 fps')
})
