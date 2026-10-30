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

/**
 * Aceita candidato em JSON (navegador) ou cru `candidate:…` (Rust).
 *
 * `mid` é o m-line index/mid que veio no FRAME (`CallIce`). Ele tem de chegar
 * ao `RTCIceCandidateInit`: o `sdpMLineIndex: 0` fixo mandava todo candidato do
 * Rust para a primeira m-line — com `max-bundle` "funciona por acidente", mas
 * quando o bundle é desfeito (vídeo/tela separados) o candidato da segunda
 * m-line era aplicado na m-line errada e rejeitado em silêncio (o `catch` do
 * `addIceCandidate` era vazio), deixando aquele par sem rota.
 */
export function parseWireCandidate(raw: unknown, mid?: string): RTCIceCandidateInit | null {
  if (typeof raw !== 'string') return null
  const t = raw.trimStart()
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t)
      if (j && typeof j === 'object' && typeof j.candidate === 'string') {
        const out = j as RTCIceCandidateInit
        // O JSON do browser normalmente já traz `sdpMid`; quando não traz,
        // usamos o do frame em vez de assumir 0.
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
  // nativo: "candidate:…" ou string vazia (fim do gathering)
  if (t.startsWith('candidate:') || t === '') {
    const numeric = mid !== undefined && /^\d+$/.test(mid)
    return {
      candidate: raw,
      ...(numeric ? { sdpMLineIndex: Number(mid) } : { sdpMLineIndex: 0, ...(mid ? { sdpMid: mid } : {}) }),
    }
  }
  return null
}
