import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SCREEN_DEFAULT_OPTIONS,
  SCREEN_QUALITY_STEPS,
  SCREEN_FPS_OPTIONS,
  ScreenShareError,
  buildDisplayMediaConstraints,
  buildSenderTuning,
  buildSourceChoices,
  classifyScreenShareError,
  detectScreenEnvironment,
  fpsOf,
  isScreenSampleBad,
  lowerScreenQuality,
  raiseScreenQuality,
  normalizeOptions,
  pickMonitorLabel,
  resolveFps,
  resolveStep,
  screenConstraints,
  screenShareErrorMessage,
  ScreenCaptureMonitor,
  ScreenStatsCollector,
  emptyScreenMetrics,
  type ScreenShareMetrics,
  type ScreenShareOptions,
} from '../src/services/screenShare.ts'

function fakeTrack(opts: { width?: number; height?: number } = {}): MediaStreamTrack {
  return {
    kind: 'video',
    readyState: 'live',
    getSettings: () => ({ width: opts.width ?? 1920, height: opts.height ?? 1080 }),
    applyConstraints: async () => undefined,
    stop: () => undefined,
  } as unknown as MediaStreamTrack
}

function statsReport(entries: Record<string, unknown>[]): RTCStatsReport {
  const map = new Map<string, Record<string, unknown>>()
  for (const e of entries) map.set(String(e.id ?? Math.random()), e)
  return map as unknown as RTCStatsReport
}

// ── degraus de qualidade ────────────────────────────────────────────────────

test('qualidade: piso operacional é 480p e os degraus sobem em ordem', () => {
  assert.equal(SCREEN_QUALITY_STEPS[0].key, '480p')
  assert.equal(SCREEN_QUALITY_STEPS[0].height, 480)
  const keys = SCREEN_QUALITY_STEPS.map(s => s.key)
  assert.deepEqual(keys, ['480p', '720p', '1080p'])
  for (let i = 1; i < SCREEN_QUALITY_STEPS.length; i++) {
    const prev = SCREEN_QUALITY_STEPS[i - 1]
    const cur = SCREEN_QUALITY_STEPS[i]
    assert.ok(cur.width >= prev.width, `${cur.key} não pode ser menor que ${prev.key}`)
    assert.ok(cur.maxBitrateKbps >= prev.maxBitrateKbps, `${cur.key} precisa de mais banda que ${prev.key}`)
    assert.ok(cur.scaleDown <= prev.scaleDown, 'escala só pode melhorar subindo de degrau')
  }
})

test('degrau de qualidade: sobe e desce sem passar da ponta', () => {
  assert.equal(lowerScreenQuality('1080p'), '720p')
  assert.equal(lowerScreenQuality('720p'), '480p')
  assert.equal(lowerScreenQuality('480p'), '480p')
  assert.equal(lowerScreenQuality('auto'), '720p')
  assert.equal(raiseScreenQuality('480p'), '720p')
  assert.equal(raiseScreenQuality('1080p'), '1080p')
  assert.equal(raiseScreenQuality('auto'), 'auto')
})

test('FPS: "auto" não fixa nada; 120 é pedido e nunca inventado', () => {
  assert.equal(resolveFps({ ...SCREEN_DEFAULT_OPTIONS, fps: 'auto' }), null)
  assert.equal(resolveFps({ ...SCREEN_DEFAULT_OPTIONS, fps: '30' }), 30)
  assert.equal(resolveFps({ ...SCREEN_DEFAULT_OPTIONS, fps: '120' }), 120)
  assert.deepEqual(SCREEN_FPS_OPTIONS, ['auto', '30', '60', '120'])
})

test('constraints de tela: pedem a resolução do degrau e o FPS escolhido', () => {
  const opts: ScreenShareOptions = { ...SCREEN_DEFAULT_OPTIONS, quality: '720p', fps: '60' }
  const c = screenConstraints(opts) as Record<string, any>
  assert.equal(c.width.ideal, 1280)
  assert.equal(c.height.ideal, 720)
  assert.equal(c.frameRate.max, 60)
  const step = resolveStep(opts)
  assert.equal(step?.key, '720p')
  assert.equal(fpsOf(step, opts), 60)
})

test('constraints de tela: 120 FPS com 1080p vira o degrau mais pesado', () => {
  const opts: ScreenShareOptions = { ...SCREEN_DEFAULT_OPTIONS, quality: '1080p', fps: '120' }
  const tuning = buildSenderTuning(opts)
  const base = buildSenderTuning({ ...opts, fps: '60' })
  assert.ok(tuning.maxBitrate > base.maxBitrate, '120 FPS precisa de mais bitrate que 60')
  assert.equal(tuning.scaleResolutionDownBy, 1, '1080p não escala para baixo')
})

test('constraints de tela: sem degrau (auto) não trava nem upscale', () => {
  const c = screenConstraints({ ...SCREEN_DEFAULT_OPTIONS, quality: 'auto' }) as Record<string, any>
  assert.equal(c.width, undefined)
  assert.equal(c.height, undefined)
  assert.equal(buildSenderTuning({ ...SCREEN_DEFAULT_OPTIONS, quality: 'auto' }).scaleResolutionDownBy, 1)
})

// ── fonte / áudio ───────────────────────────────────────────────────────────

test('constraints de captura: tela inteira pede monitor e áudio conforme pedido', () => {
  const env = { ...detectScreenEnvironment(), displaySurfaces: ['screen', 'window', 'monitor'], systemAudio: true } as any
  const c = buildDisplayMediaConstraints(
    { ...SCREEN_DEFAULT_OPTIONS, source: 'screen', audio: 'system' },
    env,
  )
  assert.equal((c.video as any).displaySurface, 'monitor')
  assert.equal(c.audio, true)
  assert.equal(c.systemAudio, 'include')
  assert.equal(c.selfBrowserSurface, 'exclude')
})

test('constraints de captura: janela usa displaySurface=window; monitor o pede explicitamente', () => {
  const env = { ...detectScreenEnvironment(), displaySurfaces: ['screen', 'window', 'monitor'] } as any
  const win = buildDisplayMediaConstraints({ ...SCREEN_DEFAULT_OPTIONS, source: 'window' }, env)
  assert.equal((win.video as any).displaySurface, 'window')
  const mon = buildDisplayMediaConstraints({ ...SCREEN_DEFAULT_OPTIONS, source: 'monitor' }, env)
  assert.equal((mon.video as any).displaySurface, 'monitor')
  assert.equal(mon.monitorTypeSurfaces, 'include')
})

test('constraints de captura: "somente tela" não pede áudio algum', () => {
  const env = { ...detectScreenEnvironment(), systemAudio: true } as any
  const c = buildDisplayMediaConstraints({ ...SCREEN_DEFAULT_OPTIONS, audio: 'none' }, env)
  assert.equal(c.audio, false)
  assert.equal(c.systemAudio, 'exclude')
})

test('fontes indisponíveis aparecem desabilitadas COM o motivo', () => {
  const env = { ...detectScreenEnvironment(), hasDisplayMedia: true, displaySurfaces: ['screen'] } as any
  const choices = buildSourceChoices(env, 'screen')
  const win = choices.find(c => c.kind === 'window')
  assert.equal(win?.available, false)
  assert.match(String(win?.detail), /não suportado/)
  assert.equal(choices.find(c => c.kind === 'screen')?.available, true)
  // Sem getDisplayMedia NENHUMA fonte pode ser oferecida (nem a tela inteira).
  const noApi = buildSourceChoices({ ...detectScreenEnvironment(), hasDisplayMedia: false } as any, 'screen')
  assert.equal(noApi.every(c => !c.available), true)
})

test('monitor: rótulo montado a partir do id escolhido', () => {
  const monitors = [{ id: 'm1', name: 'LG 27"', width: 2560, height: 1440, scale: 1, primary: true }]
  assert.equal(pickMonitorLabel(monitors, 'm1'), 'LG 27" 2560x1440')
  assert.equal(pickMonitorLabel(monitors, 'nao-existe'), null)
  assert.equal(pickMonitorLabel(null, 'm1'), null)
})

// ── permissões / erros ──────────────────────────────────────────────────────

test('erro de permissão vira código "denied" com mensagem em pt-BR e retry', () => {
  const err = classifyScreenShareError({ name: 'NotAllowedError' })
  assert.ok(err instanceof ScreenShareError)
  assert.equal(err.code, 'denied')
  assert.equal(err.retryable, true)
  assert.match(err.message, /permissão/i)
})

test('erro de cancelamento não é falha e não pede retry', () => {
  const err = classifyScreenShareError({ name: 'AbortError' })
  assert.equal(err.code, 'cancelled')
  assert.equal(err.retryable, false)
})

test('erro de fonte/sistema com código honesto', () => {
  assert.equal(classifyScreenShareError({ name: 'NotFoundError' }).code, 'no-source')
  assert.equal(classifyScreenShareError({ name: 'NotReadableError' }).code, 'unavailable')
  assert.equal(classifyScreenShareError({ name: 'OverconstrainedError' }).code, 'no-source')
  const unknown = classifyScreenShareError(new Error('boom'))
  assert.equal(unknown.code, 'unknown')
  assert.equal(unknown.retryable, true)
})

test('erro já classificado passa direto (não reembala)', () => {
  const original = new ScreenShareError('no-source', 'x', false)
  assert.equal(classifyScreenShareError(original), original)
})

test('toda causa tem mensagem legível (nunca string vazia)', () => {
  const codes = ['denied', 'cancelled', 'no-source', 'unavailable', 'insecure', 'ended', 'unsupported', 'unknown'] as const
  for (const c of codes) assert.ok(screenShareErrorMessage(c).length > 5, c)
})

test('ambiente: sem getDisplayMedia a nota explica o porquê', () => {
  const env = detectScreenEnvironment()
  assert.ok(Array.isArray(env.notes))
  if (!env.hasDisplayMedia) assert.ok(env.notes.some(n => /getDisplayMedia/.test(n)))
})

// ── normalização de opções ──────────────────────────────────────────────────

test('opções: patch parcial preserva o resto e ignora valores inválidos', () => {
  const base: ScreenShareOptions = { ...SCREEN_DEFAULT_OPTIONS, source: 'window', quality: '1080p' }
  const next = normalizeOptions({ quality: '720p', audio: 'system+mic' } as any, base)
  assert.equal(next.quality, '720p')
  assert.equal(next.audio, 'system+mic')
  assert.equal(next.source, 'window', 'fonte não mudou mas não pode ser perdida')
  const bad = normalizeOptions({ quality: '4k' } as any, base)
  assert.equal(bad.quality, '1080p', 'valor inválido mantém o anterior')
  assert.deepEqual(normalizeOptions(null, base), base)
})

// ── detecção de amostra ruim ─────────────────────────────────────────────────

test('amostra ruim: perda alta, jitter alto ou FPS enviado muito abaixo', () => {
  const base = emptyScreenMetrics()
  assert.equal(isScreenSampleBad(base), false)
  const loss: ScreenShareMetrics = { ...base, packetLossPct: 8 }
  assert.equal(isScreenSampleBad(loss), true)
  const jitter: ScreenShareMetrics = { ...base, jitterMs: 120 }
  assert.equal(isScreenSampleBad(jitter), true)
  const stall: ScreenShareMetrics = { ...base, capturedFps: 60, sentFps: 10 }
  assert.equal(isScreenSampleBad(stall), true)
  const fine: ScreenShareMetrics = { ...base, capturedFps: 60, sentFps: 55, packetLossPct: 0.4, jitterMs: 5 }
  assert.equal(isScreenSampleBad(fine), false)
})

// ── métricas reais ──────────────────────────────────────────────────────────

test('métricas: bitrate e FPS saem do DELTA entre duas amostras', async () => {
  const collector = new ScreenStatsCollector()
  const first = statsReport([{
    type: 'outbound-rtp', kind: 'video', bytesSent: 0, framesSent: 0, framesEncoded: 0,
    packetsSent: 0, frameWidth: 1280, frameHeight: 720,
  }])
  collector.read(first, { fps: 60, width: 1920, height: 1080, frames: 0, elapsedMs: 0, presentedFrames: 0, dropped: null }, null, 1_000_000)
  const second = statsReport([{
    type: 'outbound-rtp', kind: 'video', bytesSent: 125_000, framesSent: 60, framesEncoded: 60,
    packetsSent: 600, frameWidth: 1280, frameHeight: 720,
  }])
  // Janela de 1s exata: 125 kB/s ≈ 1000 kbps e 60 frames/s — números que só
  // aparecem se a taxa for derivada do DELTA e não do acumulado.
  const m = collector.read(second, { fps: 58, width: 1920, height: 1080, frames: 60, elapsedMs: 1000, presentedFrames: 60, dropped: null }, null, 1_001_000)
  assert.equal(m.captureWidth, 1920)
  assert.equal(m.outboundWidth, 1280)
  assert.equal(m.framesEncoded, 60)
  assert.equal(m.sentFps, 60)
  assert.equal(m.sendBitrateKbps, 1000)
  assert.equal(m.capturedFps, 58, 'FPS capturado vem do monitor, não do encoder')
})

test('métricas: perda e latência vêm do inbound/remote-inbound reais', () => {
  const collector = new ScreenStatsCollector()
  collector.read(statsReport([{ type: 'outbound-rtp', kind: 'video', bytesSent: 0, framesSent: 0, packetsSent: 0 }]), null, null, 1_000_000)
  const m = collector.read(statsReport([
    { type: 'outbound-rtp', kind: 'video', bytesSent: 1000, framesSent: 30, packetsSent: 30 },
    { type: 'inbound-rtp', kind: 'video', bytesReceived: 1000, framesReceived: 30, packetsReceived: 95, packetsLost: 5, jitter: 0.02, framesDecoded: 29, framesDropped: 1, keyFramesDecoded: 2 },
    { type: 'remote-inbound-rtp', kind: 'video', roundTripTime: 0.042, packetsLost: 5 },
    { type: 'codec', mimeType: 'video/VP8' },
  ]), null, null, 1_001_000)
  assert.equal(m.codec, 'VP8')
  assert.equal(m.rttMs, 42)
  assert.equal(m.jitterMs, 20)
  assert.equal(m.packetsLost, 5)
  assert.ok(m.packetLossPct !== null && m.packetLossPct > 4 && m.packetLossPct < 6, `perda=${m.packetLossPct}`)
  assert.equal(m.framesDropped, 1)
  assert.equal(m.keyFramesDecoded, 2)
})

test('métricas: codec continua informado mesmo quando a amostra seguinte não traz codec', () => {
  const collector = new ScreenStatsCollector()
  collector.read(statsReport([{ type: 'outbound-rtp', kind: 'video', bytesSent: 0, framesSent: 0, packetsSent: 0, }]), null, null, 1_000_000)
  const m = collector.read(statsReport([
    { type: 'outbound-rtp', kind: 'video', bytesSent: 500, framesSent: 10, packetsSent: 10 },
    { type: 'codec', mimeType: 'video/H264' },
  ]), null, null, 1_001_000)
  assert.equal(m.codec, 'H264')
  const m2 = collector.read(statsReport([{ type: 'outbound-rtp', kind: 'video', bytesSent: 900, framesSent: 20, packetsSent: 20 }]), null, null, 1_002_000)
  assert.equal(m2.codec, 'H264', 'o codec não pode piscar entre amostras')
})

test('métricas: sem stats continua devolvendo o FPS capturado (parcial, nunca zero falso)', () => {
  const collector = new ScreenStatsCollector()
  const m = collector.read(null, { fps: 42, width: 854, height: 480, frames: 42, elapsedMs: 1000, presentedFrames: 42, dropped: null }, null)
  assert.equal(m.capturedFps, 42)
  assert.equal(m.sendBitrateKbps, null)
  assert.equal(m.rttMs, null)
})

test('monitor de captura: conta framespresented e reporta resolução real', () => {
  const m = new ScreenCaptureMonitor()
  const track = fakeTrack({ width: 1280, height: 720 })
  try { (track as any).getSettings = () => ({ width: 1280, height: 720 }) } catch { /* ignore */ }
  m.attach(track)
  const s = m.sample()
  assert.equal(s.width, 1280)
  assert.equal(s.height, 720)
  assert.equal(typeof s.frames, 'number')
  m.detach()
  assert.equal(m.sample().width, null, 'detach limpa a referência da track')
})
test('constraints: microfone nunca vem do getDisplayMedia (só o áudio do sistema)', () => {
  const env = detectScreenEnvironment()
  // Modo "só mic": o getDisplayMedia NÃO deve pedir áudio de sistema — o mic vem
  // do getUserMedia como trilha separada (senão abriria o áudio errado).
  const onlyMic = buildDisplayMediaConstraints(
    { ...SCREEN_DEFAULT_OPTIONS, audio: 'mic' }, env)
  assert.equal(onlyMic.audio, false, 'audio:false quando o usuário pediu só o microfone')
  assert.equal(onlyMic.systemAudio, 'exclude')

  const onlySystem = buildDisplayMediaConstraints(
    { ...SCREEN_DEFAULT_OPTIONS, audio: 'system' }, env)
  assert.equal(onlySystem.audio, true, 'áudio do sistema é pedido ao getDisplayMedia')
  assert.equal(onlySystem.systemAudio, 'include')

  const both = buildDisplayMediaConstraints(
    { ...SCREEN_DEFAULT_OPTIONS, audio: 'system+mic' }, env)
  assert.equal(both.audio, true, 'sistema+mic ainda pede o áudio do sistema no display')

  const none = buildDisplayMediaConstraints(
    { ...SCREEN_DEFAULT_OPTIONS, audio: 'none' }, env)
  assert.equal(none.audio, false, '"somente tela" não captura áudio nenhum')
  assert.equal(none.systemAudio, 'exclude')
})

test('constraints: fonte janela vs monitor muda o displaySurface pedido', () => {
  const env = detectScreenEnvironment()
  const win = buildDisplayMediaConstraints({ ...SCREEN_DEFAULT_OPTIONS, source: 'window' }, env)
  assert.deepEqual(win.video, { displaySurface: 'window' })
  const mon = buildDisplayMediaConstraints({ ...SCREEN_DEFAULT_OPTIONS, source: 'monitor' }, env)
  assert.deepEqual(mon.video, { displaySurface: 'monitor' })
  assert.equal(mon.monitorTypeSurfaces, 'include')
  assert.equal(win.monitorTypeSurfaces, 'exclude')
})

test('monitores: fora do app nativo devolve lista vazia em vez de inventar', async () => {
  const { listShareableMonitors } = await import('../src/services/screenShare.ts')
  const list = await listShareableMonitors()
  // Em node puro não existe runtime Tauri: a lista é vazia, sem exceção.
  assert.ok(Array.isArray(list))
  assert.equal(list.length, 0, 'sem runtime Tauri não há monitores para listar')
})
