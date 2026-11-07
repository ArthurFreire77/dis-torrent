export const RELAY_TIMESLICE_MS = 500
export const RELAY_ICE_FAIL_MS = 5000
export const RELAY_MAX_DELAY_MS = 2000
export const RELAY_MID = 'audio-relay'
export const RELAY_VIA_LABEL = 'via relay (latência alta)'
export const RELAY_BC_NAME = 'distorrent-call-relay-v1'
export const RELAY_WINDOW_EVENT = 'distorrent:call-relay'

export interface RelayChunkPayload {
  kind: 'audio-chunk'
  seq: number
  data: string
  ts: number
  mime: string
}

export function isRelayChunkPayload(v: any): v is RelayChunkPayload {
  return !!v && typeof v === 'object' && (v as any).kind === 'audio-chunk'
    && typeof (v as any).seq === 'number' && typeof (v as any).data === 'string'
}

export function pickRelayMime(): string | undefined {
  try {
    const MR: any = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null
    if (!MR) return undefined
    const cands = [
      'audio/webm;codecs=opus', 'audio/webm',
      'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac',
      'audio/ogg;codecs=opus',
    ]
    for (const m of cands) {
      try { if (typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(m)) return m } catch {  }
    }
  } catch {  }
  return undefined
}

export function buildRelayRecorder(MR: any, stream: MediaStream): { rec: any; mime: string } {
  const tried: string[] = []
  const candidates: string[] = []
  const preferred = pickRelayMime()
  if (preferred) candidates.push(preferred)
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus']) {
    if (m !== preferred) candidates.push(m)
  }
  for (const m of candidates) {
    try {
      if (typeof MR.isTypeSupported === 'function' && !MR.isTypeSupported(m)) continue
      return { rec: new MR(stream, { mimeType: m }), mime: m }
    } catch {
      tried.push(m)
    }
  }
  try { return { rec: new MR(stream), mime: preferred ?? 'audio/webm' } } catch {  }
  throw new Error(
    `neste aparelho o áudio não pode ser gravado (MediaRecorder sem codec suportado; tentados: ${tried.join(', ') || 'nenhum'})`,
  )
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

export function supportsRelayPlayback(): boolean {
  try {
    if (typeof AudioContext !== 'undefined' && AudioContext) return true
    const w: any = typeof window !== 'undefined' ? (window as any) : null
    if (w && w.webkitAudioContext) return true
    return false
  } catch { return false }
}

export function supportsRelayFallback(): boolean {
  try {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder) return false
    if (!supportsRelayPlayback()) return false
    if (typeof navigator === 'undefined' || !(navigator as any).mediaDevices?.getUserMedia) return false
    return true
  } catch { return false }
}
