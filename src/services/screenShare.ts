export type ScreenSourceKind = 'screen' | 'window' | 'monitor'
export type ScreenAudioMode = 'none' | 'system' | 'mic' | 'system+mic'
export type ScreenQualityKey = 'auto' | '480p' | '720p' | '1080p'
export type ScreenFpsKey = 'auto' | '30' | '60' | '120'

export interface ScreenQualityStep {
  key: Exclude<ScreenQualityKey, 'auto'>
  width: number
  height: number
  maxBitrateKbps: number
  minBitrateKbps: number
  scaleDown: number
  label: string
}

export const SCREEN_QUALITY_STEPS: ScreenQualityStep[] = [
  { key: '480p', width: 854, height: 480, maxBitrateKbps: 1500, minBitrateKbps: 300, scaleDown: 4, label: '480p' },
  { key: '720p', width: 1280, height: 720, maxBitrateKbps: 3000, minBitrateKbps: 600, scaleDown: 2, label: '720p' },
  { key: '1080p', width: 1920, height: 1080, maxBitrateKbps: 6000, minBitrateKbps: 1200, scaleDown: 1, label: '1080p' },
]

export const SCREEN_MIN_OPERATIONAL = '480p'
export const SCREEN_FPS_OPTIONS: ScreenFpsKey[] = ['auto', '30', '60', '120']
export const SCREEN_DEFAULT_QUALITY: ScreenQualityKey = '720p'
export const SCREEN_DEFAULT_FPS: ScreenFpsKey = '60'

export interface ScreenShareOptions {
  source: ScreenSourceKind
  audio: ScreenAudioMode
  quality: ScreenQualityKey
  fps: ScreenFpsKey
  /** Identificador do monitor escolhido (id do Tauri's available_monitors) quando source='monitor'. */
  monitorId?: string | null
  /** Rótulo do monitor/janela para exibir na UI. */
  monitorLabel?: string | null
}

export const SCREEN_DEFAULT_OPTIONS: ScreenShareOptions = {
  source: 'screen',
  audio: 'system',
  quality: SCREEN_DEFAULT_QUALITY,
  fps: SCREEN_DEFAULT_FPS,
  monitorId: null,
  monitorLabel: null,
}

export type ScreenShareErrorCode =
  | 'denied'
  | 'cancelled'
  | 'no-source'
  | 'unavailable'
  | 'insecure'
  | 'ended'
  | 'unsupported'
  | 'unknown'

export class ScreenShareError extends Error {
  code: ScreenShareErrorCode
  retryable: boolean
  cause?: unknown
  constructor(code: ScreenShareErrorCode, message: string, retryable: boolean, cause?: unknown) {
    super(message)
    this.name = 'ScreenShareError'
    this.code = code
    this.retryable = retryable
    this.cause = cause
  }
}

const MESSAGES: Record<ScreenShareErrorCode, string> = {
  denied: 'permissão de compartilhamento de tela negada — autorize e tente de novo',
  cancelled: 'compartilhamento de tela cancelado',
  'no-source': 'nenhuma fonte de captura disponível (tela, monitor ou janela)',
  unavailable: 'captura de tela indisponível neste aparelho — a fonte pode estar ocupada ou o SO recusou',
  insecure: 'contexto não seguro: a captura de tela exige app://, https:// ou localhost',
  ended: 'o compartilhamento de tela foi encerrado pelo sistema',
  unsupported: 'este aparelho não expõe captura de tela (getDisplayMedia ausente)',
  unknown: 'não foi possível compartilhar a tela',
}

export function classifyScreenShareError(e: unknown): ScreenShareError {
  if (e instanceof ScreenShareError) return e
  const anyE = e as { name?: string; message?: string; cause?: unknown } | null
  const name = String(anyE?.name ?? '')
  let code: ScreenShareErrorCode = 'unknown'
  if (name === 'NotAllowedError' || name === 'SecurityError') code = 'denied'
  else if (name === 'AbortError') code = 'cancelled'
  else if (name === 'NotFoundError' || name === 'OverconstrainedError') code = 'no-source'
  else if (name === 'NotReadableError' || name === 'TrackStartError') code = 'unavailable'
  else if (/getDisplayMedia/i.test(String(anyE?.message ?? ''))) code = 'unsupported'
  const retryable = RETRYABLE_CODES.has(code)
  const extra = name && name !== 'Error' ? ` (${name})` : ''
  return new ScreenShareError(code, `${MESSAGES[code]}${extra}`, retryable, e)
}

export function screenShareErrorMessage(code: ScreenShareErrorCode): string {
  return MESSAGES[code]
}

const RETRYABLE_CODES: ReadonlySet<ScreenShareErrorCode> = new Set<ScreenShareErrorCode>([
  'denied', 'unavailable', 'ended', 'unknown',
])

export type ScreenRuntimePlatform = 'windows' | 'linux' | 'android' | 'ios' | 'macos' | 'unknown'

export interface ScreenEnvironment {
  platform: ScreenRuntimePlatform
  hasDisplayMedia: boolean
  secureContext: boolean
  displaySurfaces: ScreenSourceKind[]
  systemAudio: boolean
  microphone: boolean
  surfaceSwitching: boolean
  maxRefreshingRate: number | null
  notes: string[]
}

function ua(): string {
  try {
    return typeof navigator === 'undefined' ? '' : String((navigator as unknown as { userAgent?: string }).userAgent ?? '')
  } catch { return '' }
}

export function isAndroidRuntime(): boolean {
  try {
    return /Android/i.test(ua())
  } catch { return false }
}

export function isIOSRuntime(): boolean {
  try {
    const u = ua()
    return /iPhone|iPad|iPod/i.test(u) || (/Macintosh/i.test(u) && ((navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints ?? 0) > 1)
  } catch { return false }
}

export function isLinuxRuntime(): boolean {
  try {
    const u = ua()
    if (/Android/i.test(u)) return false
    if (/Linux|X11/i.test(u) && !/Macintosh/i.test(u)) return true
    const p = detectPlatformHint()
    return p === 'linux'
  } catch { return false }
}

export function isWindowsRuntime(): boolean {
  try {
    const u = ua()
    if (/Windows/i.test(u)) return true
    return detectPlatformHint() === 'windows'
  } catch { return false }
}

export function detectPlatformHint(): 'windows' | 'linux' | 'android' | 'ios' | 'macos' | 'unknown' {
  try {
    const g = globalThis as Record<string, unknown>
    const os = (g as { __TAURI_OS__?: unknown }).__TAURI_OS__
    if (typeof os === 'string') {
      if (os === 'windows') return 'windows'
      if (os === 'linux') return 'linux'
      if (os === 'android') return 'android'
      if (os === 'ios') return 'ios'
      if (os === 'macos') return 'macos'
    }
  } catch { /* ignore */ }
  return 'unknown'
}

export function detectScreenEnvironment(): ScreenEnvironment {
  const notes: string[] = []
  let platform: ScreenRuntimePlatform = 'unknown'
  if (isAndroidRuntime() || detectPlatformHint() === 'android') platform = 'android'
  else if (isWindowsRuntime()) platform = 'windows'
  else if (isIOSRuntime()) platform = 'ios'
  else if (isLinuxRuntime()) platform = 'linux'
  else if (detectPlatformHint() === 'macos') platform = 'macos'

  const md = (typeof navigator !== 'undefined' ? (navigator as unknown as { mediaDevices?: Record<string, unknown> }).mediaDevices : null) ?? null
  const hasDisplayMedia = typeof md?.getDisplayMedia === 'function'
  let secureContext: boolean
  try { secureContext = typeof isSecureContext === 'undefined' ? true : !!isSecureContext } catch { secureContext = true }

  const displaySurfaces: ScreenSourceKind[] = ['screen']
  let systemAudio = false
  let surfaceSwitching = false

  if (platform === 'windows') {
    displaySurfaces.push('window', 'monitor')
    systemAudio = true
    surfaceSwitching = true
    notes.push('Windows: captura via WebView2/Chromium (Windows Graphics Capture nativo do engine, aceleração por hardware quando disponível)')
  } else if (platform === 'linux') {
    displaySurfaces.push('window')
    if (hasDisplayMedia) {
      systemAudio = true
      surfaceSwitching = true
      notes.push('Linux: captura via portal xdg-desktop/PipeWire quando o WebView expõe getDisplayMedia')
    } else {
      notes.push('Linux: este WebView (WebKitGTK 4.x) não implementa getDisplayMedia — a captura nativa exigiria um build GTK4/WebKit 6 ou integração em Rust')
    }
  } else if (platform === 'android') {
    systemAudio = true
    surfaceSwitching = false
    if (hasDisplayMedia) notes.push('Android: captura via MediaProjection do sistema (diálogo oficial aberto pelo app)')
    else notes.push('Android: o WebView do sistema ainda não expõe getDisplayMedia nesta versão')
  } else if (platform === 'ios') {
    notes.push('iOS/iPadOS não oferece captura de tela para apps de terceiros')
  }

  if (!hasDisplayMedia) notes.push('getDisplayMedia ausente: compartilhamento de tela indisponível neste engine')
  if (!secureContext) notes.push('contexto inseguro: getDisplayMedia é bloqueado pelo browser')

  return {
    platform,
    hasDisplayMedia,
    secureContext,
    displaySurfaces,
    systemAudio,
    microphone: !!md && typeof md.getUserMedia === 'function',
    surfaceSwitching,
    maxRefreshingRate: null,
    notes,
  }
}

export function hasDisplayMedia(): boolean {
  try {
    const md = (typeof navigator !== 'undefined' ? (navigator as unknown as { mediaDevices?: Record<string, unknown> }).mediaDevices : null) ?? null
    return typeof md?.getDisplayMedia === 'function'
  } catch { return false }
}

export function supportsScreenSource(env: ScreenEnvironment, kind: ScreenSourceKind): boolean {
  return env.hasDisplayMedia && env.displaySurfaces.includes(kind)
}

export function buildDisplayMediaConstraints(
  opts: ScreenShareOptions,
  env: ScreenEnvironment,
): Record<string, unknown> {
  const wantsSystemAudio = opts.audio === 'system' || opts.audio === 'system+mic'
  const displaySurface = opts.source === 'window' ? 'window' : 'monitor'
  const constraints: Record<string, unknown> = {
    video: { displaySurface },
    audio: wantsSystemAudio,
    systemAudio: wantsSystemAudio ? 'include' : 'exclude',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: env.surfaceSwitching ? 'include' : 'exclude',
    monitorTypeSurfaces: opts.source === 'monitor' ? 'include' : 'exclude',
    preferCurrentTab: false,
  }
  if (opts.audio === 'system+mic' || opts.audio === 'mic') {
    constraints.audio = wantsSystemAudio
  }
  return constraints
}

export function resolveFps(opts: ScreenShareOptions): number | null {
  if (opts.fps === 'auto') return null
  const n = Number(opts.fps)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(240, Math.max(1, Math.round(n)))
}

export function resolveStep(opts: ScreenShareOptions): ScreenQualityStep | null {
  if (opts.quality === 'auto') return null
  return SCREEN_QUALITY_STEPS.find(s => s.key === opts.quality) ?? null
}

export function fpsOf(step: ScreenQualityStep | null, opts: ScreenShareOptions): number | null {
  const explicit = resolveFps(opts)
  if (explicit !== null) return explicit
  return step ? 60 : 60
}

export function screenConstraints(opts: ScreenShareOptions): MediaTrackConstraints {
  const step = resolveStep(opts)
  const fps = fpsOf(step, opts)
  const c: Record<string, unknown> = {}
  if (step) {
    c.width = { ideal: step.width, max: step.width }
    c.height = { ideal: step.height, max: step.height }
  }
  if (fps) c.frameRate = { ideal: fps, max: fps }
  return c as MediaTrackConstraints
}

export async function applyScreenConstraints(track: MediaStreamTrack, opts: ScreenShareOptions): Promise<boolean> {
  try {
    await track.applyConstraints(screenConstraints(opts) as MediaTrackConstraints)
    return true
  } catch { return false }
}

export function setScreenContentHint(track: MediaStreamTrack | null, kind: ScreenSourceKind): void {
  try {
    ;(track as unknown as { contentHint?: string }).contentHint = kind === 'window' ? 'text' : 'detail'
  } catch { /* hint é best-effort */ }
}

export interface ScreenSenderTuning {
  degradationPreference: RTCDegradationPreference
  scaleResolutionDownBy: number
  maxBitrate: number
  minBitrate: number
  priority?: RTCPriorityType
}

export function buildSenderTuning(opts: ScreenShareOptions): ScreenSenderTuning {
  const step = resolveStep(opts)
  const scaleDown = step ? step.scaleDown : (opts.quality === 'auto' ? 1 : 1)
  const sourceHint = opts.source === 'window'
  const fps = fpsOf(step, opts)
  const bitrateFactor = fps && fps >= 120 ? 1.6 : (fps && fps <= 30 ? 0.6 : 1)
  const maxKbps = step ? Math.round(step.maxBitrateKbps * bitrateFactor) : 6000
  const minKbps = step ? Math.round(step.minBitrateKbps * bitrateFactor) : 800
  return {
    degradationPreference: sourceHint ? 'maintain-framerate' : 'balanced',
    scaleResolutionDownBy: scaleDown,
    maxBitrate: maxKbps * 1000,
    minBitrate: minKbps * 1000,
    priority: 'high',
  }
}

export async function applySenderTuning(sender: RTCRtpSender, opts: ScreenShareOptions): Promise<boolean> {
  try {
    const tuning = buildSenderTuning(opts)
    const params = sender.getParameters()
    params.degradationPreference = tuning.degradationPreference
    const target = params.encodings && params.encodings.length ? params.encodings[0] : undefined
    if (target) {
      const enc = target as RTCRtpEncodingParameters & { minBitrate?: number }
      enc.scaleResolutionDownBy = tuning.scaleResolutionDownBy
      enc.maxBitrate = tuning.maxBitrate
      // minBitrate não existe no DOM typings de todo engine; só quem entender
      // o parâmetro o usa. Ausente = ignorado pelo encoder, não quebra.
      enc.minBitrate = tuning.minBitrate
      if (tuning.priority) target.priority = tuning.priority
      target.networkPriority = 'high'
    }
    await sender.setParameters(params)
    return true
  } catch { return false }
}

export interface ScreenFpsSample {
  fps: number | null
  width: number | null
  height: number | null
  frames: number
  elapsedMs: number
  presentedFrames: number
  dropped: number | null
}

export class ScreenCaptureMonitor {
  private track: MediaStreamTrack | null = null
  private el: HTMLVideoElement | null = null
  private stream: MediaStream | null = null
  private frames = 0
  private firstAt = 0
  private lastAt = 0
  private rvfcHandle: number | null = null
  private started = false

  attach(track: MediaStreamTrack): void {
    this.detach()
    this.track = track
    this.frames = 0
    this.firstAt = 0
    this.lastAt = 0
    try {
      const doc: Document | null = typeof document !== 'undefined' ? document : null
      if (doc) {
        const el = doc.createElement('video')
        el.muted = true
        el.playsInline = true
        const st = new MediaStream()
        st.addTrack(track)
        this.el = el
        this.stream = st
        el.srcObject = st
        const play = el.play()
        if (play && typeof (play as Promise<void>).catch === 'function') (play as Promise<void>).catch(() => {})
      }
    } catch { /* monitor é acessório: sem vídeo oculto segue contando por settings */ }
    this.started = true
    this.schedule()
  }

  private schedule(): void {
    if (!this.started || !this.el) return
    const el = this.el as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: (now: number, meta: unknown) => void) => number
    }
    if (typeof el.requestVideoFrameCallback !== 'function') return
    this.rvfcHandle = el.requestVideoFrameCallback((now: number) => {
      if (!this.started) return
      this.frames += 1
      if (!this.firstAt) this.firstAt = now
      this.lastAt = now
      this.schedule()
    })
  }

  detach(): void {
    this.started = false
    this.track = null
    if (this.rvfcHandle !== null && this.el) {
      const el = this.el as HTMLVideoElement & {
        cancelVideoFrameCallback?: (h: number) => void
      }
      try { if (typeof el.cancelVideoFrameCallback === 'function') el.cancelVideoFrameCallback(this.rvfcHandle) } catch { /* ignore */ }
    }
    this.rvfcHandle = null
    try { if (this.el) { this.el.srcObject = null } } catch { /* ignore */ }
    this.el = null
    this.stream = null
  }

  sample(): ScreenFpsSample {
    const elapsedMs = this.firstAt && this.lastAt ? Math.max(0, this.lastAt - this.firstAt) : 0
    const fps = elapsedMs > 0 ? Math.round((this.frames * 1000) / elapsedMs) : null
    let width: number | null = null
    let height: number | null = null
    try {
      const st = this.track?.getSettings() ?? {}
      width = typeof st.width === 'number' ? st.width : null
      height = typeof st.height === 'number' ? st.height : null
    } catch { /* settings indisponível */ }
    return { fps, width, height, frames: this.frames, elapsedMs, presentedFrames: this.frames, dropped: null }
  }
}

export interface ScreenShareMetrics {
  capturedFps: number | null
  sentFps: number | null
  receivedFps: number | null
  captureWidth: number | null
  captureHeight: number | null
  outboundWidth: number | null
  outboundHeight: number | null
  sendBitrateKbps: number | null
  receiveBitrateKbps: number | null
  rttMs: number | null
  jitterMs: number | null
  packetsLost: number | null
  packetLossPct: number | null
  framesEncoded: number | null
  framesDecoded: number | null
  framesDropped: number | null
  freezeCount: number | null
  totalFreezeDurationS: number | null
  codec: string | null
  keyFramesDecoded: number | null
  qualityLimitationReason: string | null
}

export function emptyScreenMetrics(): ScreenShareMetrics {
  return {
    capturedFps: null, sentFps: null, receivedFps: null,
    captureWidth: null, captureHeight: null,
    outboundWidth: null, outboundHeight: null,
    sendBitrateKbps: null, receiveBitrateKbps: null,
    rttMs: null, jitterMs: null, packetsLost: null, packetLossPct: null,
    framesEncoded: null, framesDecoded: null, framesDropped: null,
    freezeCount: null, totalFreezeDurationS: null,
    codec: null, keyFramesDecoded: null, qualityLimitationReason: null,
  }
}

interface StatsBaseline {
  bytesSent: number
  bytesReceived: number
  framesEncoded: number
  framesSent: number
  framesDecoded: number
  framesReceived: number
  packetsSent: number
  packetsReceived: number
  packetsLost: number
  at: number
}

function newBaseline(): StatsBaseline {
  return {
    bytesSent: 0, bytesReceived: 0, framesEncoded: 0, framesSent: 0, framesDecoded: 0,
    framesReceived: 0, packetsSent: 0, packetsReceived: 0, packetsLost: 0, at: 0,
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export class ScreenStatsCollector {
  private baseline = newBaseline()
  private prevCodec: string | null = null

  reset(): void {
    this.baseline = newBaseline()
  }

  /**
   * Lê uma amostra de `RTCStatsReport` e devolve métricas REAIS por delta.
   *
   * `nowMs` existe para teste determinístico: sem ele a janela depende do
   * relógio e um teste de 20ms não produz taxa por segundo nenhuma. Em
   * produção é sempre omitido (usa Date.now).
   */
  read(stats: RTCStatsReport | null | undefined, capture: ScreenFpsSample | null, previousRttMs: number | null, nowMs?: number): ScreenShareMetrics {
    const out = emptyScreenMetrics()
    if (capture) {
      out.capturedFps = capture.fps
      out.captureWidth = capture.width
      out.captureHeight = capture.height
    }
    if (!stats) return out
    const found: {
      out?: Record<string, unknown>
      in?: Record<string, unknown>
      remoteIn?: Record<string, unknown>
    } = {}
    let codec: string | null = null
    let limitation: string | null = null
    try {
      stats.forEach((raw: unknown) => {
        const r = raw as Record<string, unknown>
        const type = String(r?.type ?? '')
        if (type === 'outbound-rtp' && r.kind === 'video') {
          if (!found.out || num(r.bytesSent) !== null) found.out = r
          if (limitation === null && typeof r.qualityLimitationReason === 'string') limitation = r.qualityLimitationReason
        } else if (type === 'inbound-rtp' && r.kind === 'video') {
          if (!found.in || num(r.bytesReceived) !== null) found.in = r
        } else if (type === 'remote-inbound-rtp' && r.kind === 'video') {
          found.remoteIn = r
        } else if (type === 'codec') {
          if (typeof r.mimeType === 'string' && String(r.mimeType).startsWith('video/')) codec = String(r.mimeType).split('/')[1] ?? null
        }
      })
    } catch { /* stats parcial */ }
    this.prevCodec = codec ?? this.prevCodec
    out.codec = this.prevCodec
    out.qualityLimitationReason = limitation

    const outb = found.out
    const inb = found.in
    const remoteIn = found.remoteIn
    const now = nowMs ?? Date.now()
    if (this.baseline.at === 0 && outb) {
      this.baseline = {
        bytesSent: num(outb.bytesSent) ?? 0,
        bytesReceived: num(inb?.bytesReceived) ?? 0,
        framesEncoded: num(outb.framesEncoded) ?? 0,
        framesSent: num(outb.framesSent) ?? 0,
        framesDecoded: num(inb?.framesDecoded) ?? 0,
        framesReceived: num(inb?.framesReceived) ?? 0,
        packetsSent: num(outb.packetsSent) ?? 0,
        packetsReceived: num(inb?.packetsReceived) ?? 0,
        packetsLost: num(inb?.packetsLost) ?? 0,
        at: now,
      }
      return out
    }
    const dtSec = (now - this.baseline.at) / 1000
    if (dtSec <= 0) return out

    if (outb) {
      const sentBytes = num(outb.bytesSent)
      const bytes = (sentBytes ?? this.baseline.bytesSent) - this.baseline.bytesSent
      if (bytes >= 0) out.sendBitrateKbps = Math.round((bytes * 8) / dtSec / 1000)
      const encTotal = num(outb.framesEncoded)
      if (encTotal !== null) out.framesEncoded = encTotal
      const sentTotal = num(outb.framesSent)
      const fs = (sentTotal ?? this.baseline.framesSent) - this.baseline.framesSent
      if (fs >= 0 && dtSec >= 1) out.sentFps = Math.round(fs / dtSec)
      out.outboundWidth = num(outb.frameWidth)
      out.outboundHeight = num(outb.frameHeight)
      this.baseline.bytesSent = sentBytes ?? this.baseline.bytesSent
      this.baseline.framesEncoded = encTotal ?? this.baseline.framesEncoded
      this.baseline.framesSent = sentTotal ?? this.baseline.framesSent
      this.baseline.packetsSent = num(outb.packetsSent) ?? this.baseline.packetsSent
    }
    if (inb) {
      const recvBytes = num(inb.bytesReceived)
      const bytes = (recvBytes ?? this.baseline.bytesReceived) - this.baseline.bytesReceived
      if (bytes >= 0) out.receiveBitrateKbps = Math.round((bytes * 8) / dtSec / 1000)
      const recvTotal = num(inb.framesReceived)
      const fr = (recvTotal ?? this.baseline.framesReceived) - this.baseline.framesReceived
      if (fr >= 0 && dtSec >= 1) out.receivedFps = Math.round(fr / dtSec)
      const lost = num(inb.packetsLost)
      if (lost !== null) {
        out.packetsLost = lost
        const recv = (num(inb.packetsReceived) ?? 0) + lost
        if (recv > 0) out.packetLossPct = Math.round((lost / recv) * 1000) / 10
      }
      const jit = num(inb.jitter)
      if (jit !== null) out.jitterMs = Math.round(jit * 1000)
      out.framesDecoded = num(inb.framesDecoded)
      out.framesDropped = num(inb.framesDropped)
      out.freezeCount = num(inb.freezeCount)
      out.totalFreezeDurationS = num(inb.totalFreezesDuration)
      out.keyFramesDecoded = num(inb.keyFramesDecoded)
      this.baseline.bytesReceived = recvBytes ?? this.baseline.bytesReceived
      this.baseline.framesDecoded = num(inb.framesDecoded) ?? this.baseline.framesDecoded
      this.baseline.framesReceived = recvTotal ?? this.baseline.framesReceived
      this.baseline.packetsReceived = num(inb.packetsReceived) ?? this.baseline.packetsReceived
      this.baseline.packetsLost = lost ?? this.baseline.packetsLost
    }
    if (remoteIn) {
      const rtt = num(remoteIn.roundTripTime)
      if (rtt !== null) out.rttMs = Math.round(rtt * 1000)
      else if (previousRttMs !== null) out.rttMs = previousRttMs
      const rl = num(remoteIn.packetsLost)
      if (rl !== null) out.packetsLost = rl
    }
    this.baseline.at = now
    return out
  }
}

export function isScreenSampleBad(m: ScreenShareMetrics): boolean {
  const loss = m.packetLossPct
  const jitter = m.jitterMs
  if (loss !== null && loss >= 5) return true
  if (jitter !== null && jitter > 80) return true
  if (m.sentFps !== null && m.capturedFps !== null && m.capturedFps >= 20 && m.sentFps < m.capturedFps * 0.5) return true
  return false
}

export function lowerScreenQuality(q: ScreenQualityKey): ScreenQualityKey {
  if (q === 'auto') return '720p'
  const i = SCREEN_QUALITY_STEPS.findIndex(s => s.key === q)
  if (i <= 0) return SCREEN_QUALITY_STEPS[0].key
  return SCREEN_QUALITY_STEPS[i - 1].key
}

export function raiseScreenQuality(q: ScreenQualityKey): ScreenQualityKey {
  if (q === 'auto') return 'auto'
  const i = SCREEN_QUALITY_STEPS.findIndex(s => s.key === q)
  if (i < 0 || i >= SCREEN_QUALITY_STEPS.length - 1) return q
  return SCREEN_QUALITY_STEPS[i + 1].key
}

export function normalizeOptions(patch: Partial<ScreenShareOptions> | null | undefined, base: ScreenShareOptions): ScreenShareOptions {
  const out: ScreenShareOptions = { ...base }
  if (!patch) return out
  if (patch.source === 'screen' || patch.source === 'window' || patch.source === 'monitor') out.source = patch.source
  if (patch.audio === 'none' || patch.audio === 'system' || patch.audio === 'mic' || patch.audio === 'system+mic') out.audio = patch.audio
  if (patch.quality === 'auto' || patch.quality === '480p' || patch.quality === '720p' || patch.quality === '1080p') out.quality = patch.quality
  if (patch.fps === 'auto' || patch.fps === '30' || patch.fps === '60' || patch.fps === '120') out.fps = patch.fps
  if (typeof patch.monitorId === 'string' || patch.monitorId === null) out.monitorId = patch.monitorId
  if (typeof patch.monitorLabel === 'string' || patch.monitorLabel === null) out.monitorLabel = patch.monitorLabel
  return out
}

export interface ScreenSourceChoice {
  kind: ScreenSourceKind
  label: string
  available: boolean
  detail: string
}

export function buildSourceChoices(env: ScreenEnvironment, selected: ScreenSourceKind): ScreenSourceChoice[] {
  const base: ScreenSourceChoice[] = [
    { kind: 'screen', label: 'Tela inteira', available: supportsScreenSource(env, 'screen'), detail: env.platform === 'android' ? 'todo o conteúdo da tela do aparelho' : 'todos os monitores' },
    { kind: 'window', label: 'Janela / aplicativo', available: supportsScreenSource(env, 'window'), detail: 'uma janela ou aba específica' },
    { kind: 'monitor', label: 'Monitor específico', available: supportsScreenSource(env, 'monitor'), detail: 'escolha qual monitor enviar' },
  ]
  return base.map(c => ({ ...c, available: c.available, detail: c.available ? c.detail : 'não suportado neste aparelho' }))
    .map(c => (c.kind === selected ? c : c))
}

export interface MonitorInfo {
  id: string
  name: string | null
  width: number
  height: number
  scale: number
  primary: boolean
}

export function pickMonitorLabel(monitors: MonitorInfo[] | null | undefined, id: string | null | undefined): string | null {
  if (!id || !Array.isArray(monitors)) return null
  const m = monitors.find(x => x.id === id)
  return m ? `${m.name ?? 'monitor'} ${m.width}x${m.height}` : null
}