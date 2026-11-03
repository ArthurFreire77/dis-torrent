export type CallVideoQuality = '480p' | '720p' | '1080p' | '4K'

export const CALL_VIDEO_QUALITIES: CallVideoQuality[] = ['480p', '720p', '1080p', '4K']

export type CallFps = 'auto' | '15' | '24' | '30' | '60'

export const CALL_FPS_OPTIONS: CallFps[] = ['auto', '15', '24', '30', '60']

export interface CallMediaPrefs {
  audioInputId: string
  videoInputId: string
  /** '' = padrão do sistema. Usado quando o aparelho não expõe ids distintos. */
  facingMode: '' | 'user' | 'environment'
  quality: CallVideoQuality
  fps: CallFps
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

export const CALL_MEDIA_PREFS_KEY = 'distorrent:call_media_prefs'

export const DEFAULT_CALL_MEDIA_PREFS: CallMediaPrefs = {
  audioInputId: '',
  videoInputId: '',
  facingMode: '',
  quality: '720p',
  fps: 'auto',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

export const QUALITY_PIXELS: Record<CallVideoQuality, { width: number; height: number }> = {
  '480p': { width: 640, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4K': { width: 3840, height: 2160 },
}

export function fpsToMax(fps: CallFps): number | undefined {
  if (fps === 'auto') return undefined
  const n = Number(fps)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export function videoConstraintsFromPrefs(p: CallMediaPrefs): MediaTrackConstraints {
  const px = QUALITY_PIXELS[p.quality] ?? QUALITY_PIXELS['720p']
  const maxFps = fpsToMax(p.fps)
  const c: MediaTrackConstraints = {
    width: { min: 320, ideal: px.width, max: px.width },
    height: { min: 240, ideal: px.height, max: px.height },
  }
  if (maxFps !== undefined) {
    c.frameRate = { min: Math.min(15, maxFps), ideal: maxFps, max: maxFps }
  }
  if (p.facingMode) c.facingMode = { ideal: p.facingMode }
  if (p.videoInputId) c.deviceId = { exact: p.videoInputId }
  return c
}

export function audioConstraintsFromPrefs(p: CallMediaPrefs): MediaTrackConstraints {
  const c: MediaTrackConstraints = {
    echoCancellation: p.echoCancellation,
    noiseSuppression: p.noiseSuppression,
    autoGainControl: p.autoGainControl,
    channelCount: 1,
  }
  if (p.audioInputId) c.deviceId = { exact: p.audioInputId }
  return c
}

export function parseCallMediaPrefs(raw: unknown): CallMediaPrefs {
  const base = { ...DEFAULT_CALL_MEDIA_PREFS }
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch { return base }
  }
  if (!raw || typeof raw !== 'object') return base
  const o = raw as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)

  const audio = str(o.audioInputId)
  if (audio !== null) base.audioInputId = audio
  const video = str(o.videoInputId)
  if (video !== null) base.videoInputId = video
  // Pseudo-id nunca vira `deviceId: {exact}`: device inexistente faz o
  // getUserMedia falhar para sempre e a preferência fica envenenada.
  if (base.videoInputId.startsWith('__')) {
    base.facingMode = base.videoInputId === '__user' ? 'user' : 'environment'
    base.videoInputId = ''
  }
  const facing = str(o.facingMode)
  if (facing === 'user' || facing === 'environment') base.facingMode = facing

  const q = str(o.quality)
  if (q && (CALL_VIDEO_QUALITIES as string[]).includes(q)) base.quality = q as CallVideoQuality

  const f = str(o.fps) ?? (typeof o.fps === 'number' ? String(o.fps) : null)
  if (f && (CALL_FPS_OPTIONS as string[]).includes(f)) base.fps = f as CallFps

  const ec = bool(o.echoCancellation)
  if (ec !== null) base.echoCancellation = ec
  const ns = bool(o.noiseSuppression)
  if (ns !== null) base.noiseSuppression = ns
  const ag = bool(o.autoGainControl)
  if (ag !== null) base.autoGainControl = ag

  return base
}

export function qualityLabel(q: CallVideoQuality, fps: CallFps): string {
  const px = QUALITY_PIXELS[q] ?? QUALITY_PIXELS['720p']
  return `${px.width}×${px.height} · ${fps === 'auto' ? 'fps auto' : `${fps} fps`}`
}

export function deviceLabel(d: { deviceId: string; label: string }, fallback: string): string {
  const l = (d.label || '').trim()
  if (l) return l
  return d.deviceId === 'default' || !d.deviceId ? `padrão do sistema (${fallback})` : fallback
}
