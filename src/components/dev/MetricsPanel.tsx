// Painel dev: métricas de runtime do motor (contadores + RTT por peer).
// Só expõe contagens/latências — nunca conteúdo de mensagens.

import { useCallback, useEffect, useState } from 'react'
import { services } from '../../services'

const t = {
  input: '#1e1f22', border: '#26272b',
  text: '#dbdee1', muted: '#949ba4', accent: '#5865f2', green: '#23a559',
}
const box: React.CSSProperties = {
  background: t.input, border: `1px solid ${t.border}`, borderRadius: 10,
  padding: '10px 14px', flex: 1, minWidth: 120,
}
const label: React.CSSProperties = { fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted }
const value: React.CSSProperties = { fontSize: 16, fontWeight: 800, color: t.text, marginTop: 2 }

export function MetricsPanel() {
  const [snap, setSnap] = useState<Record<string, unknown> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      setSnap(await services.metricsSnapshot())
      setErr(null)
    } catch (e) {
      setErr(String((e as Error)?.message ?? e))
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  if (err) return <div style={{ color: '#ff9c9c', fontSize: 12 }}>{err}</div>
  if (!snap) return <div style={{ color: t.muted, fontSize: 12 }}>carregando métricas…</div>
  const classes = (snap.classes as string[]) ?? ['realtime', 'control', 'message', 'bulk']
  const tx = (snap.frames_tx as number[]) ?? []
  const rx = (snap.frames_rx as number[]) ?? []
  const rtt = (snap.rtt_by_peer_ms as Record<string, number>) ?? {}
  const peers = Object.entries(rtt).slice(0, 20)
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={box}><div style={label}>FRAMES TX</div><div style={value}>{tx.reduce((a, b) => a + b, 0)}</div></div>
        <div style={box}><div style={label}>FRAMES RX</div><div style={value}>{rx.reduce((a, b) => a + b, 0)}</div></div>
        <div style={box}><div style={label}>BYTES ↑</div><div style={value}>{fmtNum(Number(snap.bytes_tx ?? 0))}</div></div>
        <div style={box}><div style={label}>BYTES ↓</div><div style={value}>{fmtNum(Number(snap.bytes_rx ?? 0))}</div></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <div style={box}><div style={label}>SPAM BLOQUEADO</div><div style={{ ...value, color: '#f23f43' }}>{String(snap.spam_rejected ?? 0)}</div></div>
        <div style={box}><div style={label}>MSG IN/OUT</div><div style={value}>{String(snap.messages_in ?? 0)}/{String(snap.messages_out ?? 0)}</div></div>
        <div style={box}><div style={label}>CACHE HITS</div><div style={value}>{String(snap.cache_hits ?? 0)}</div></div>
        <div style={box}><div style={label}>CACHE MISSES</div><div style={value}>{String(snap.cache_misses ?? 0)}</div></div>
      </div>
      <div style={{ ...label, marginBottom: 6 }}>POR CLASSE DE TRÁFEGO (QoS)</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {classes.map((c, i) => (
          <div key={c} style={box}>
            <div style={label}>{c.toUpperCase()}</div>
            <div style={{ ...value, fontSize: 13 }}>↑{tx[i] ?? 0} ↓{rx[i] ?? 0}</div>
          </div>
        ))}
      </div>
      <div style={{ ...label, marginBottom: 6 }}>LATÊNCIA (RTT) POR PEER — ms</div>
      {peers.length === 0
        ? <div style={{ fontSize: 12, color: t.muted }}>sem amostras ainda (conecte-se a um peer)</div>
        : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: '4px 12px', fontSize: 12, fontFamily: 'JetBrains Mono' }}>
            {peers.map(([fp, ms]) => (
              <div key={fp} style={{ display: 'contents' }}>
                <span style={{ color: t.muted, wordBreak: 'break-all' }}>{fp}</span>
                <span style={{ color: ms < 150 ? t.green : ms < 400 ? '#faa61a' : '#f23f43', fontWeight: 700 }}>{ms}</span>
              </div>
            ))}
          </div>
        )}
      <button onClick={() => void refresh()} style={{ marginTop: 12, width: '100%', background: t.input, border: `1px solid ${t.border}`, color: t.text, borderRadius: 8, padding: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>Atualizar</button>
    </div>
  )
}

function fmtNum(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
