export const CALL_QUALITY_KEY = 'distorrent:call_quality'
export const QUALITY_ORDER: CallQuality[] = ['480p', '720p', '1080p', '4K']
export type CallQuality = '480p' | '720p' | '1080p' | '4K'

// `min` fica baixo de propósito: câmera fraca recusa `min` igual ao ideal.
export const QUALITY_CONSTRAINTS: Record<CallQuality, MediaTrackConstraints> = {
  '480p': { width: { min: 640, ideal: 640, max: 1280 }, height: { min: 480, ideal: 480, max: 720 }, frameRate: { min: 15, ideal: 60, max: 120 } },
  '720p': { width: { min: 640, ideal: 1280, max: 1920 }, height: { min: 480, ideal: 720, max: 1080 }, frameRate: { min: 15, ideal: 60, max: 120 } },
  '1080p': { width: { min: 640, ideal: 1920, max: 1920 }, height: { min: 480, ideal: 1080, max: 1080 }, frameRate: { min: 15, ideal: 60, max: 120 } },
  '4K': { width: { min: 640, ideal: 3840, max: 3840 }, height: { min: 480, ideal: 2160, max: 2160 }, frameRate: { min: 15, ideal: 60, max: 120 } },
}

export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { min: 640, ideal: 1280, max: 1920 },
  height: { min: 480, ideal: 720, max: 1080 },
  frameRate: { min: 15, ideal: 60, max: 120 },
}

export interface VideoDeviceLimits {
  maxWidth: number | null
  maxHeight: number | null
  maxFrameRate: number | null
  curWidth: number | null
  curHeight: number | null
  curFrameRate: number | null
}

export function probeVideoLimits(track?: MediaStreamTrack | null): VideoDeviceLimits | null {
  try {
    if (!track || track.kind !== 'video' || track.readyState !== 'live') return null
    const caps: any = typeof (track as any).getCapabilities === 'function' ? (track as any).getCapabilities() : null
    const st: any = typeof track.getSettings === 'function' ? track.getSettings() : {}
    const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return {
      maxWidth: num(caps?.width?.max) ?? null,
      maxHeight: num(caps?.height?.max) ?? null,
      maxFrameRate: num(caps?.frameRate?.max) ?? null,
      curWidth: num(st?.width) ?? null,
      curHeight: num(st?.height) ?? null,
      curFrameRate: num(st?.frameRate) ?? null,
    }
  } catch { return null }
}

export function formatVideoLimits(l: VideoDeviceLimits | null): string | null {
  try {
    if (!l) return null
    const w = l.curWidth ?? l.maxWidth
    const h = l.curHeight ?? l.maxHeight
    const f = l.curFrameRate ?? l.maxFrameRate
    if (!w || !h) return null
    return `até ${w}x${h}${f ? `@${Math.round(f)}` : ''}`
  } catch { return null }
}

export function getStoredQuality(): CallQuality {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(CALL_QUALITY_KEY) : null
    if (v === '480p' || v === '720p' || v === '1080p' || v === '4K') return v
  } catch {  }
  return '720p'
}

export function lowerQuality(q: CallQuality): CallQuality | null {
  const i = QUALITY_ORDER.indexOf(q)
  return i > 0 ? QUALITY_ORDER[i - 1] : null
}

export function isBadStatsSample(packetsLostDelta: number, jitter: number): boolean {
  return packetsLostDelta > 20 || jitter > 0.1
}
