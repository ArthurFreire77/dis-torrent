// Painel de diagnóstico da chamada em tempo real (P2P, sem servidor central).
// Mostra por peer: connectionState, iceConnectionState, signalingState,
// candidate pair, tipo de candidate, RTT, bitrates, resolução, FPS, frames,
// packet loss, codec, jitter, câmera/mic — + causa técnica real da falha.
// Atualiza a cada 2s via callManager.getCallDiagnostics(); nunca derruba a chamada.
import { useEffect, useState } from 'react'
import {
  callManager,
  probeVideoLimits,
  formatVideoLimits,
  type CallDiagnostics as PeerDiag,
} from '../services/callManager'

const t = {
  panel: '#2b2d31', input: '#1e1f22', border: '#26272b',
  accent: '#5865f2', green: '#23a559', yellow: '#f0b232',
  red: '#f23f42', text: '#dbdee1', heading: '#f2f3f5', muted: '#949ba4',
}

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  return String(v)
}

export default function CallDiagnostics({ compact = false }: { compact?: boolean }) {
  const [rows, setRows] = useState<PeerDiag[]>([])
  const [cause, setCause] = useState<string>('')
  const [rung, setRung] = useState<string>('n/d')
  const [limits, setLimits] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null
    async function poll() {
      try {
        const d = await callManager.getCallDiagnostics().catch(() => [] as PeerDiag[])
        if (!alive) return
        setRows(Array.isArray(d) ? d : [])
        try { setCause(callManager.getCallFailureReason()) } catch { /* ignore */ }
        try { setRung(callManager.getRungSummary()) } catch { /* ignore */ }
        try {
          const anyMgr = callManager as any
          const stream: MediaStream | null = anyMgr?.localStream ?? null
          const track = stream?.getVideoTracks()?.[0] ?? null
          setLimits(formatVideoLimits(probeVideoLimits(track)))
        } catch { /* ignore */ }
      } catch { /* painel nunca derruba */ }
    }
    void poll()
    try { timer = setInterval(() => { setTick((n) => n + 1); void poll() }, 2000) } catch { timer = null }
    return () => {
      alive = false
      try { if (timer) clearInterval(timer) } catch { /* ignore */ }
    }
  }, [tick > 100000 ? 1 : 0])

  // Re-poll imediato quando a chamada muda (o intervalo de 2s cobre o resto).
  useEffect(() => { void (async () => {
    try {
      const d = await callManager.getCallDiagnostics().catch(() => [])
      setRows(Array.isArray(d) ? d : [])
      try { setCause(callManager.getCallFailureReason()) } catch { /* ignore */ }
    } catch { /* ignore */ }
  })() }, [])

  return (
    <div data-testid="call-diag" style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: compact ? '8px 10px' : '10px 12px', fontSize: 11, color: t.text, lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: t.muted }}>DIAGNÓSTICO DA CHAMADA (P2P)</span>
        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 800, color: rung === 'n/d' ? t.muted : t.green }}>rota: {rung}</span>
      </div>
      {limits && <div style={{ fontSize: 11, color: t.muted }}>limite real do aparelho: <span style={{ color: t.heading, fontWeight: 700 }}>{limits}</span> (120 FPS só se câmera/navegador suportarem)</div>}
      {rows.length === 0 && (
        <div style={{ fontSize: 11, color: t.muted }}>
          sem peers WebRTC ainda — {cell(cause)}
        </div>
      )}
      {rows.map((r) => (
        <div key={r.fp} style={{ borderTop: `1px solid ${t.border}`, paddingTop: 6, marginTop: 6 }}>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: t.heading, fontWeight: 800 }}>{r.fp.slice(0, 12)}</div>
          <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : '1fr 1fr 1fr', gap: '2px 12px', marginTop: 4 }}>
            <span>connection: <b>{cell(r.connectionState)}</b></span>
            <span>ice: <b>{cell(r.iceConnectionState)}</b></span>
            <span>signaling: <b>{cell(r.signalingState)}</b></span>
            <span>par: <b>{cell(r.selectedPair)}</b></span>
            <span>candidates: <b>{cell(r.localType)} / {cell(r.remoteType)}</b></span>
            <span>RTT: <b>{r.rttMs !== null ? `${r.rttMs} ms` : '—'}</b></span>
            <span>áudio: <b>{r.audioBitrateKbps !== null ? `${r.audioBitrateKbps} kbps` : '—'}</b></span>
            <span>vídeo: <b>{r.videoBitrateKbps !== null ? `${r.videoBitrateKbps} kbps` : '—'}</b></span>
            <span>resolução: <b>{cell(r.resolution)}</b></span>
            <span>FPS: <b>{r.fps !== null ? r.fps : '—'}</b></span>
            <span>frames rx: <b>{r.framesReceived !== null ? r.framesReceived : '—'}</b></span>
            <span>frames perdidos: <b>{r.framesLost !== null ? r.framesLost : '—'}</b></span>
            <span>pacotes perdidos: <b>{r.packetsLost !== null ? r.packetsLost : '—'}</b></span>
            <span>packet loss: <b>{r.packetLossPct !== null ? `${r.packetLossPct}%` : '—'}</b></span>
            <span>codec: <b>{cell(r.codec)}</b></span>
            <span>jitter: <b>{r.jitterMs !== null ? `${r.jitterMs} ms` : '—'}</b></span>
            <span>câmera: <b>{cell(r.camera)}</b></span>
            <span>microfone: <b>{cell(r.microphone)}</b></span>
          </div>
        </div>
      ))}
      {cause && (
        <div data-testid="call-diag-cause" style={{ marginTop: 8, fontSize: 11, color: cause.startsWith('sem falha') ? t.muted : t.yellow, background: cause.startsWith('sem falha') ? 'transparent' : '#2a1f0a', border: cause.startsWith('sem falha') ? 'none' : `1px solid ${t.yellow}55`, borderRadius: 8, padding: cause.startsWith('sem falha') ? '0' : '6px 10px' }}>
          causa: {cause}
        </div>
      )}
      <ScreenShareDebug compact={compact} />
    </div>
  )
}

/**
 * Modo interno "Screen Share Debug": métricas REAIS do compartilhamento de
 * tela (FPS capturado/enviado/recebido, resolução, bitrate, RTT, jitter,
 * perda, frames, congelas, codec). Nada aqui é estimado — campo vazio
 * significa que o engine ainda não reportou, e o painel mostra "—".
 */
function ScreenShareDebug({ compact }: { compact: boolean }) {
  const [snap, setSnap] = useState(() => {
    try { return callManager.getScreenShareMetrics() } catch { return null }
  })
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setInterval> | null = null
    const poll = () => {
      try {
        const m = callManager.getScreenShareMetrics()
        if (alive) setSnap(m)
      } catch { /* painel nunca derruba */ }
    }
    poll()
    try { timer = setInterval(poll, 1000) } catch { timer = null }
    return () => {
      alive = false
      try { if (timer) clearInterval(timer) } catch { /* ignore */ }
    }
  }, [])

  if (!snap) return null
  const env = snap.env
  const anyActivity = snap.capturedFps !== null || snap.sendBitrateKbps !== null || !!snap.error
  return (
    <div data-testid="screen-share-debug" style={{ borderTop: `1px solid ${t.border}`, paddingTop: 6, marginTop: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: t.muted, marginBottom: 4 }}>
        SCREEN SHARE DEBUG (P2P)
      </div>
      <div style={{ fontSize: 11, color: t.muted }}>
        plataforma: <span style={{ color: t.heading, fontWeight: 700 }}>{env.platform}</span>
        {env.systemAudio ? ' · áudio do sistema: disponível' : ' · áudio do sistema: indisponível'}
        {' · '}getDisplayMedia: <span style={{ color: t.heading, fontWeight: 700 }}>{env.hasDisplayMedia ? 'sim' : 'não'}</span>
      </div>
      {!anyActivity && (
        <div style={{ fontSize: 11, color: t.muted, marginTop: 4 }}>
          sem compartilhamento ativo — as métricas aparecem ao iniciar a captura
        </div>
      )}
      {anyActivity && (
        <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : '1fr 1fr 1fr', gap: '2px 12px', marginTop: 4 }}>
          <span>FPS capturado: <b>{cell(snap.capturedFps)}</b></span>
          <span>FPS enviado: <b>{cell(snap.sentFps)}</b></span>
          <span>FPS recebido: <b>{cell(snap.receivedFps)}</b></span>
          <span>captura: <b>{snap.captureWidth && snap.captureHeight ? `${snap.captureWidth}x${snap.captureHeight}` : '—'}</b></span>
          <span>enviado: <b>{snap.outboundWidth && snap.outboundHeight ? `${snap.outboundWidth}x${snap.outboundHeight}` : '—'}</b></span>
          <span>bitrate: <b>{snap.sendBitrateKbps !== null ? `${snap.sendBitrateKbps} kbps` : '—'}</b></span>
          <span>RTT: <b>{snap.rttMs !== null ? `${snap.rttMs} ms` : '—'}</b></span>
          <span>jitter: <b>{snap.jitterMs !== null ? `${snap.jitterMs} ms` : '—'}</b></span>
          <span>packet loss: <b>{snap.packetLossPct !== null ? `${snap.packetLossPct}%` : '—'}</b></span>
          <span>frames codificados: <b>{cell(snap.framesEncoded)}</b></span>
          <span>frames decodificados: <b>{cell(snap.framesDecoded)}</b></span>
          <span>frames perdidos: <b>{cell(snap.framesDropped)}</b></span>
          <span>keyframes: <b>{cell(snap.keyFramesDecoded)}</b></span>
          <span>congelas: <b>{snap.freezeCount !== null ? `${snap.freezeCount} (${snap.totalFreezeDurationS ?? 0}s)` : '—'}</b></span>
          <span>codec: <b>{cell(snap.codec)}</b></span>
          <span>limitação: <b>{cell(snap.qualityLimitationReason)}</b></span>
          <span>opções: <b>{snap.options.source} · {snap.options.quality} · {snap.options.fps}fps · áudio {snap.options.audio}</b></span>
        </div>
      )}
      {snap.error && (
        <div data-testid="screen-share-error" style={{ marginTop: 6, fontSize: 11, color: '#ffb3b3', background: '#3a1f22', border: `1px solid ${t.red}55`, borderRadius: 8, padding: '6px 10px' }}>
          {snap.error.message} <span style={{ color: t.muted }}>({snap.error.code})</span>
        </div>
      )}
    </div>
  )
}
