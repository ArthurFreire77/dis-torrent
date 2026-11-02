// Preferências de mídia da chamada (dispositivo, resolução, FPS).
//
// Módulo PURO: sem DOM, sem React, sem Tauri — a UI lê/escreve aqui e o
// `CallManager` consome. Motivo: a escolha de microfone/câmera/resolução estava
// espalhada em constantes (`QUALITY_CONSTRAINTS`) e não havia como o usuário
// trocar de dispositivo sem sair e entrar na chamada.

/** Degraus de resolução expostos na UI (mesmos nomes do resto do app). */
export type CallVideoQuality = '480p' | '720p' | '1080p' | '4K'

export const CALL_VIDEO_QUALITIES: CallVideoQuality[] = ['480p', '720p', '1080p', '4K']

/** FPS alvo. `auto` = deixa o navegador/encoder escolher (sem teto artificial). */
export type CallFps = 'auto' | '15' | '24' | '30' | '60'

export const CALL_FPS_OPTIONS: CallFps[] = ['auto', '15', '24', '30', '60']

export interface CallMediaPrefs {
  /** `deviceId` do microfone; vazio = padrão do sistema. */
  audioInputId: string
  /** `deviceId` da câmera; vazio = padrão do sistema. */
  videoInputId: string
  quality: CallVideoQuality
  fps: CallFps
  /** Cancelamento de eco / supressão de ruído / ganho automático. */
  echoCancellation: boolean
  noiseSuppression: boolean
  autoGainControl: boolean
}

export const CALL_MEDIA_PREFS_KEY = 'distorrent:call_media_prefs'

export const DEFAULT_CALL_MEDIA_PREFS: CallMediaPrefs = {
  audioInputId: '',
  videoInputId: '',
  quality: '720p',
  fps: 'auto',
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
}

/** Resolução em pixels por degradação (usada nos constraints e nos rótulos). */
export const QUALITY_PIXELS: Record<CallVideoQuality, { width: number; height: number }> = {
  '480p': { width: 640, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '4K': { width: 3840, height: 2160 },
}

/** `auto` vira `undefined`: sem teto, o navegador escolhe o melhor. */
export function fpsToMax(fps: CallFps): number | undefined {
  if (fps === 'auto') return undefined
  const n = Number(fps)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Constraints de VÍDEO para captura.
 *
 * `min` folgado de propósito: pedir `min: 24` fazia `OverconstrainedError` em
 * câmera frontal fraca e a câmera nem abria (a chamada ficava só de voz).
 * O que o usuário escolhe entra como `ideal`/`max` — pedido, não exigência.
 */
export function videoConstraintsFromPrefs(p: CallMediaPrefs): MediaTrackConstraints {
  const px = QUALITY_PIXELS[p.quality] ?? QUALITY_PIXELS['720p']
  const maxFps = fpsToMax(p.fps)
  const c: MediaTrackConstraints = {
    width: { min: 320, ideal: px.width, max: px.width },
    height: { min: 240, ideal: px.height, max: px.height },
  }
  // `frameRate` só existe com teto definido; `auto` deixa o device decidir.
  if (maxFps !== undefined) {
    c.frameRate = { min: Math.min(15, maxFps), ideal: maxFps, max: maxFps }
  }
  if (p.videoInputId) c.deviceId = { exact: p.videoInputId }
  return c
}

/** Constraints de ÁUDIO: dispositivo escolhido + processamento de voz. */
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

/**
 * Normaliza o que veio do `localStorage` (JSON pode estar velho/corrompido ou
 * vir de outra versão). Campo inválido volta ao padrão — nunca lança.
 */
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

/** Rótulo honesto de um degrau: "1280×720 · 60 fps" / "1280×720 · auto". */
export function qualityLabel(q: CallVideoQuality, fps: CallFps): string {
  const px = QUALITY_PIXELS[q] ?? QUALITY_PIXELS['720p']
  return `${px.width}×${px.height} · ${fps === 'auto' ? 'fps auto' : `${fps} fps`}`
}

/** Nome legível de um dispositivo; `default`/vazio vira "padrão do sistema". */
export function deviceLabel(d: { deviceId: string; label: string }, fallback: string): string {
  const l = (d.label || '').trim()
  if (l) return l
  return d.deviceId === 'default' || !d.deviceId ? `padrão do sistema (${fallback})` : fallback
}
