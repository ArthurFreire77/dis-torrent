import { getIceServers } from './callIce'

/** `getUserMedia({audio,video})` é atômico: sem vídeo, tenta só o áudio. */
export function describeMediaError(e: unknown): string | null {
  const name = (e as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError') return 'microfone/câmera bloqueados — libere a permissão do sistema e tente de novo'
  if (name === 'NotFoundError') return 'nenhum microfone/câmera encontrado neste aparelho'
  if (name === 'NotReadableError') return 'microfone/câmera em uso por outro app — feche e tente de novo'
  if (name === 'OverconstrainedError') return 'câmera/microfone não atende aos requisitos — tente só voz'
  if (name === 'SecurityError') return 'permissão de mídia bloqueada pelo contexto (HTTPS/app nativo exigido)'
  return null
}

let capturaFila: Promise<unknown> = Promise.resolve()

/** Serializa as capturas: dois `getUserMedia` simultâneos disputam o mesmo device. */
export function comFilaDeCaptura<T>(fn: () => Promise<T>): Promise<T> {
  const vez = capturaFila.catch(() => undefined).then(fn)
  capturaFila = vez.catch(() => undefined)
  return vez
}

export function newPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: getIceServers() as any,
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4,
  } as RTCConfiguration)
}

export function tuneOpusSdp(sdp: string): string {
  try {
    if (!sdp || sdp.toLowerCase().indexOf('opus') < 0) return sdp
    const m = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i)
    if (!m) return sdp
    const pt = m[1]
    const params: [string, string][] = [
      ['minptime', '10'],
      ['useinbandfec', '1'],
      ['usedtx', '1'],
      ['stereo', '0'],
      ['sprop-stereo', '0'],
      ['maxplaybackrate', '48000'],
      ['maxaveragebitrate', '32000'],
    ]
    const lines = sdp.split(/\r\n|\n/)
    const fmtpPrefix = `a=fmtp:${pt}`
    let idx = lines.findIndex(l => l.startsWith(fmtpPrefix))
    const existing: Record<string, string> = {}
    if (idx >= 0) {
      lines[idx].slice(fmtpPrefix.length).trim().split(';').forEach(kv => {
        const [k, v] = kv.split('=')
        if (k && k.trim()) existing[k.trim()] = (v ?? '').trim()
      })
    } else {
      const rpm = lines.findIndex(l => l.toLowerCase().startsWith(`a=rtpmap:${pt} `))
      if (rpm < 0) return sdp
      idx = rpm + 1
      lines.splice(idx, 0, fmtpPrefix)
    }
    for (const [k, v] of params) existing[k] = v
    lines[idx] = `${fmtpPrefix} ` + Object.entries(existing).map(([k, v]) => (v ? `${k}=${v}` : k)).join(';')
    if (!lines.some(l => l.trim() === 'a=ptime:20')) {
      const mi = lines.findIndex(l => l.startsWith('m=audio'))
      if (mi >= 0) lines.splice(mi + 1, 0, 'a=ptime:20')
    }
    return lines.join('\r\n')
  } catch { return sdp }
}

export async function createTunedOffer(
  pc: RTCPeerConnection,
  opts?: { iceRestart?: boolean },
): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer(opts?.iceRestart ? { iceRestart: true } : undefined)
  offer.sdp = tuneOpusSdp(offer.sdp ?? '')
  return offer
}

export async function createTunedAnswer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const answer = await pc.createAnswer()
  answer.sdp = tuneOpusSdp(answer.sdp ?? '')
  return answer
}
