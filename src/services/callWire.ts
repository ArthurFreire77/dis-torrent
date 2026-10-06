// callWire — formato da sinalização no fio.
//
// O caminho do navegador trafega {type,sdp} em JSON; a camada nativa (Rust,
// webrtc-rs) trafega SDP/candidato CRUS. Sem aceitar os dois, chamada mista
// (Linux nativo ↔ Windows navegador) nunca negociava.

export interface WireSdp {
  type: 'offer' | 'answer'
  sdp: string
}

/** Aceita `{"type":"offer","sdp":..}` (navegador) ou SDP cru `v=0…` (Rust). */
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

/** Aceita candidato em JSON (navegador) ou cru `candidate:…` (Rust). */
export function parseWireCandidate(raw: unknown): RTCIceCandidateInit | null {
  if (typeof raw !== 'string') return null
  const t = raw.trimStart()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t)
      if (j && typeof j === 'object' && typeof j.candidate === 'string') {
        return j as RTCIceCandidateInit
      }
      return null
    } catch {
      return null
    }
  }
  // nativo: "candidate:…" ou string vazia (fim do gathering)
  if (t.startsWith('candidate:') || t === '') return { candidate: raw, sdpMLineIndex: 0 }
  return null
}
