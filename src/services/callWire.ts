export interface WireSdp {
  type: 'offer' | 'answer'
  sdp: string
}

export function parseWireSdp(raw: unknown, want: 'offer' | 'answer'): WireSdp | null {
  if (typeof raw !== 'string' || !raw) return null
  const t = raw.trimStart()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t)
      if (j && typeof j === 'object' && j.type === want && typeof j.sdp === 'string' && j.sdp) {
        return { type: want, sdp: j.sdp }
      }
      return null
    } catch {
      return null
    }
  }
  if (t.startsWith('v=0')) return { type: want, sdp: raw }
  return null
}

export function parseWireCandidate(raw: unknown, mid?: string): RTCIceCandidateInit | null {
  if (typeof raw !== 'string') return null
  const t = raw.trimStart()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t)
      if (j && typeof j === 'object' && typeof j.candidate === 'string') {
        const out = j as RTCIceCandidateInit
        if (!out.sdpMid && !(typeof out.sdpMLineIndex === 'number')) {
          if (mid) out.sdpMid = mid
        }
        return out
      }
      return null
    } catch {
      return null
    }
  }
  if (t.startsWith('candidate:') || t === '') {
    const numeric = mid !== undefined && /^\d+$/.test(mid)
    return {
      candidate: raw,
      ...(numeric ? { sdpMLineIndex: Number(mid) } : { sdpMLineIndex: 0, ...(mid ? { sdpMid: mid } : {}) }),
    }
  }
  return null
}
