import type { CallState } from './callManager'

export type IceFailureState = 'failed' | 'disconnected'
export interface IceFailureInfo { fp: string; callId: string; state: IceFailureState }
export const ICE_DISCONNECTED_GRACE_MS = 12000

export type MediaRung = 'direto-host' | 'direto-srflx' | 'relay' | 'conectando' | 'falhou' | 'sem-rota'
export const RUNG_LABEL: Record<MediaRung, string> = {
  'direto-host': 'direta (rede local)',
  'direto-srflx': 'direta (NAT furado)',
  'relay': 'via relay configurado',
  'conectando': 'conectando…',
  'falhou': 'sem rota',
  'sem-rota': 'sem rota',
}

export interface IceMediaReport {
  iceState: string
  localType: string | null
  remoteType: string | null
  rttMs: number | null
  bytesOut: number
}
export interface DistorrentNatEndpoint { addr: string; source: string }

export interface CallDiagnostics {
  fp: string
  connectionState: string
  iceConnectionState: string
  signalingState: string
  localType: string | null
  remoteType: string | null
  selectedPair: string | null
  rttMs: number | null
  audioBitrateKbps: number | null
  videoBitrateKbps: number | null
  resolution: string | null
  fps: number | null
  framesReceived: number | null
  framesLost: number | null
  packetsLost: number | null
  packetLossPct: number | null
  codec: string | null
  jitterMs: number | null
  camera: string
  microphone: string
}

export function buildPeerDiagnostics(
  fp: string,
  pc: RTCPeerConnection,
  stats: RTCStatsReport | null,
  rep: IceMediaReport | null,
  st: CallState | null,
): CallDiagnostics {
  const safe = (v: unknown): string => {
    try { return String((v as any) ?? '?') } catch { return '?' }
  }
  let rttMs: number | null = rep?.rttMs ?? null
  let localType: string | null = rep?.localType ?? null
  let remoteType: string | null = rep?.remoteType ?? null
  let selectedPair: string | null = null
  let resolution: string | null = null
  let fps: number | null = null
  let framesReceived: number | null = null
  let framesLost: number | null = null
  let packetsLost: number | null = null
  let packetLossPct: number | null = null
  let codec: string | null = null
  let jitterMs: number | null = null
  try {
    if (stats) {
      const byId = new Map<string, any>()
      try { stats.forEach((r: any) => { if (r && r.id) byId.set(String(r.id), r) }) } catch {  }
      let pair: any = null
      try {
        stats.forEach((r: any) => {
          if (r && r.type === 'candidate-pair' && (r.nominated || r.selected)) pair = r
        })
        if (!pair) stats.forEach((r: any) => {
          if (!pair && r && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r
        })
      } catch {  }
      if (pair) {
        const local = byId.get(String(pair.localCandidateId ?? ''))
        const remote = byId.get(String(pair.remoteCandidateId ?? ''))
        if (local?.candidateType && !localType) localType = String(local.candidateType)
        if (remote?.candidateType && !remoteType) remoteType = String(remote.candidateType)
        if (typeof pair.currentRoundTripTime === 'number') rttMs = Math.round(pair.currentRoundTripTime * 1000)
        try {
          const lt = local ? `${local.candidateType ?? '?'}:${local.protocol ?? 'udp'}` : '?'
          const rt = remote ? `${remote.candidateType ?? '?'}` : '?'
          selectedPair = `${lt} ↔ ${rt}`
        } catch {  }
      }
      let aPkts = 0; let aLost = 0
      stats.forEach((r: any) => {
        try {
          if (!r) return
          if (r.type === 'inbound-rtp') {
            if (typeof r.jitter === 'number' && jitterMs === null) jitterMs = Math.round(r.jitter * 1000)
            if (typeof r.packetsLost === 'number') {
              packetsLost = (packetsLost ?? 0) + r.packetsLost
              if (r.kind === 'audio' || String(r.mediaType ?? '') === 'audio') { aLost += r.packetsLost }
            }
            if (typeof r.packetsReceived === 'number' && (r.kind === 'audio' || String(r.mediaType ?? '') === 'audio')) {
              aPkts += r.packetsReceived
            }
            if ((r.kind === 'video' || String(r.mediaType ?? '') === 'video')) {
              if (typeof r.framesReceived === 'number') framesReceived = (framesReceived ?? 0) + r.framesReceived
              if (typeof r.framesDropped === 'number' || typeof r.framesLost === 'number') {
                framesLost = (framesLost ?? 0) + Number(r.framesDropped ?? r.framesLost ?? 0)
              }
              if (typeof r.frameWidth === 'number' && typeof r.frameHeight === 'number') {
                resolution = `${r.frameWidth}x${r.frameHeight}`
              }
              if (typeof r.framesPerSecond === 'number') fps = Math.round(r.framesPerSecond)
            }
            if (typeof r.mimeType === 'string' && !codec) codec = r.mimeType.replace('video/', '').replace('audio/', '')
            if (typeof r.codecId === 'string' && byId.has(r.codecId)) {
              const c = byId.get(r.codecId)
              if (c?.mimeType && !codec) codec = String(c.mimeType).replace('video/', '').replace('audio/', '')
            }
          }
          if (r.type === 'outbound-rtp') {
            if ((r.kind === 'video' || String(r.mediaType ?? '') === 'video')) {
              if (typeof r.frameWidth === 'number' && typeof r.frameHeight === 'number' && !resolution) {
                resolution = `${r.frameWidth}x${r.frameHeight}`
              }
              if (typeof r.framesPerSecond === 'number' && fps === null) fps = Math.round(r.framesPerSecond)
            }
          }
        } catch {  }
      })
      if (aPkts + aLost > 0) packetLossPct = Math.round((aLost / (aPkts + aLost)) * 1000) / 10
    }
  } catch {  }
  let camera = 'desligada'
  let microphone = 'desligado'
  try {
    const p: any = (st?.participants as any[])?.find((x: any) => x.fp === fp)
    const stream: MediaStream | undefined = p?.stream
    if (stream) {
      try {
        const vt = stream.getVideoTracks()[0]
        camera = vt ? (vt.readyState === 'live' ? (vt.enabled ? `ativa (${vt.label || 'câmera'})` : 'mutada') : 'encerrada') : 'sem vídeo'
      } catch { camera = 'desconhecida' }
      try {
        const at = stream.getAudioTracks()[0]
        microphone = at ? (at.readyState === 'live' ? (at.enabled ? 'ativo' : 'mutado') : 'encerrado') : 'sem áudio'
      } catch { microphone = 'desconhecido' }
    } else {
      camera = 'sem track remota'
      microphone = 'sem track remota'
    }
  } catch {  }
  return {
    fp,
    connectionState: safe((pc as any).connectionState),
    iceConnectionState: safe((pc as any).iceConnectionState),
    signalingState: safe((pc as any).signalingState),
    localType, remoteType, selectedPair, rttMs,
    audioBitrateKbps: null, videoBitrateKbps: null,
    resolution, fps, framesReceived, framesLost,
    packetsLost, packetLossPct, codec, jitterMs,
    camera, microphone,
  }
}
