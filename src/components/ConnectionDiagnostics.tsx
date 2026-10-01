// Diagnóstico de conexão — FORGE visual congelado: usa a mesma paleta/tipografia
// do ThemeShell (t.*), sem redesenhar nada. Reutilizado no desktop e no mobile.
import { useEffect, useMemo, useState } from 'react'
import { services } from '../services'
import { diagnoseCallsSupport } from '../services/callManager'
import type { NetworkState, PeerView, RelayLegStatus, NetDiag } from '../services/models'

const t = {
  sidebar: '#2b2d31', main: '#313338', input: '#1e1f22', border: '#26272b',
  panel: '#2b2d31', accent: '#5865f2', green: '#23a559', yellow: '#f0b232',
  red: '#f23f42', text: '#dbdee1', heading: '#f2f3f5', muted: '#949ba4',
}

const stateLabel: Record<NetworkState, string> = {
  CONNECTED: 'CONECTADO', CONNECTING: 'CONECTANDO', RECONNECTING: 'RECONECTANDO', DISCONNECTED: 'OFFLINE',
}

export function shortFp(fp: string): string {
  const clean = (fp ?? '').trim()
  if (clean.length <= 12) return clean
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`
}

export function buildDiagReport(args: {
  version: string
  fp: string
  nickname: string
  state: NetworkState | null
  onlinePeers: number
  listenPort: number
  peers: PeerView[]
  legs: RelayLegStatus[]
  legsError: string | null
  netDiag: NetDiag | null
  kind: string
}): string {
  const lines: string[] = []
  lines.push('DisTorrent — relatório de conexão (colar no suporte)')
  lines.push(`versão: ${args.version || '?'}`)
  lines.push(`fingerprint: ${args.fp || '?'}`)
  lines.push(`apelido: ${args.nickname || '?'}`)
  lines.push(`modo: ${args.kind}`)
  lines.push(`estado: ${args.state ? stateLabel[args.state] : '?' } (${args.onlinePeers} online, porta :${args.listenPort})`)
  const nd = args.netDiag
  if (nd) {
    if (nd.stun_ok === null) lines.push('STUN: ainda não testado')
    else if (nd.stun_ok) lines.push(`STUN: ok (${nd.stun_addr ?? '?'})`)
    else lines.push('STUN: falhou (sem binding NAT — direto impossível, relay resolve)')
    if (nd.dht_ok === null) lines.push('DHT BitTorrent: desligada (FORGE_NO_DHT ou modo proxy/Tor)')
    else if (nd.dht_ok) lines.push('DHT BitTorrent: ok — nó anunciando na rede BitTorrent')
    else lines.push('DHT BitTorrent: falhou (UDP bloqueado?)')
    if (nd.announce_addr) lines.push(`anúncio: ${nd.announce_addr}${nd.nat_source ? ` (via ${nd.nat_source === 'upnp' ? 'UPnP/NAT-PMP local, sem servidor' : nd.nat_source === 'public-ip' ? 'IP público direto' : 'STUN público'})` : ''}`)
    else lines.push('anúncio: não anunciado (STUN é UDP e não abre a porta TCP; sem UPnP o par não chega — relay/túnel cobrem)')
  }
  lines.push(`peers (${args.peers.length}):`)
  if (args.peers.length === 0) {
    lines.push('- (nenhum peer conhecido)')
  } else {
    for (const p of args.peers) {
      const via = p.via_relay ? 'via relay' : 'direta'
      // Honestidade: peer preso em CONNECTING com várias tentativas diretas
      // não está "conectando" — está INALCANÇÁVEL por rota direta (CGNAT/NAT
      // simétrico). Dizer "CONECTANDO" para sempre era mentira de status.
      const stuck = p.state === 'CONNECTING' && (p.direct_attempts ?? 0) >= 6
      const state = stuck ? 'SEM ROTA DIRETA' : (p.state ? stateLabel[p.state] : '?')
      lines.push(`- ${shortFp(p.fp)} (${p.nickname || '?'}, ${state}, ${via})`)
      if (p.last_direct_error) lines.push(`  direto: ${p.last_direct_error} (${p.direct_attempts ?? 0} tentativas)`)
      if (stuck) lines.push('  → sem porta aberta dos dois lados; caminho real é relay/túnel')
      if (p.last_relay_error) lines.push(`  relay: ${p.last_relay_error} (${p.relay_attempts ?? 0} tentativas)`)
      if (p.announce_seen_ms && Date.now() - p.announce_seen_ms < 10 * 60 * 1000) lines.push('  announce do peer visto há pouco')
    }
  }
  lines.push(`relay (${args.legs.length}):`)
  if (args.legsError) {
    lines.push(`- indisponível: ${args.legsError}`)
  } else if (args.legs.length === 0) {
    lines.push('- (sem pernas)')
  } else {
    for (const l of args.legs) {
      if (l.ok) lines.push(`- ${l.name}: ok (${l.latency_ms ?? '?'} ms)`)
      else lines.push(`- ${l.name}: falha (${l.last_error ?? 'erro desconhecido'})`)
    }
  }
  lines.push(`gerado em: ${new Date().toISOString()}`)
  return lines.join('\n')
}

export default function ConnectionDiagnostics({ onClose }: { onClose?: () => void }) {
  const [version, setVersion] = useState('')
  const [fp, setFp] = useState('')
  const [nickname, setNickname] = useState('')
  const [state, setState] = useState<NetworkState | null>(null)
  const [onlinePeers, setOnlinePeers] = useState(0)
  const [listenPort, setListenPort] = useState(0)
  const [peers, setPeers] = useState<PeerView[]>([])
  const [legs, setLegs] = useState<RelayLegStatus[]>([])
  const [legsError, setLegsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState<string | null>(null)
  const [netDiag, setNetDiag] = useState<NetDiag | null>(null)

  useEffect(() => {
    let alive = true
    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const [v, id, net, peerList, nd] = await Promise.all([
          services.version().catch(() => '?'),
          services.identityGet().catch(() => null),
          services.networkStatus().catch(() => null),
          services.peersList().catch(() => [] as PeerView[]),
          services.netDiag().catch(() => null),
        ])
        if (!alive) return
        setVersion(typeof v === 'string' ? v : '?')
        setFp(id?.fingerprint ?? '')
        setNickname(id?.nickname ?? '')
        setNetDiag(nd)
        if (net) {
          setState(net.state)
          setOnlinePeers(net.online_peers)
          setListenPort(net.listen_port)
        } else {
          setState('DISCONNECTED')
        }
        setPeers(Array.isArray(peerList) ? peerList : [])
        try {
          const r = await services.relayStatus()
          if (!alive) return
          setLegs(Array.isArray(r) ? r : [])
          setLegsError(null)
        } catch (e: unknown) {
          if (!alive) return
          setLegs([])
          setLegsError(e instanceof Error ? e.message : String(e ?? 'indisponível'))
        }
      } catch (e: unknown) {
        if (!alive) return
        setLoadError(e instanceof Error ? e.message : String(e ?? 'falha ao carregar'))
      } finally {
        if (alive) setLoading(false)
      }
    }
    void load()
    return () => { alive = false }
  }, [])

  const report = useMemo(
    () => buildDiagReport({ version, fp, nickname, state, onlinePeers, listenPort, peers, legs, legsError, netDiag, kind: services.kind }),
    [version, fp, nickname, state, onlinePeers, listenPort, peers, legs, legsError, netDiag],
  )

  // Capacidade de chamada deste aparelho (WebView antigo = sem WebRTC).
  const callsDiag = useMemo(() => {
    try { return diagnoseCallsSupport() } catch {
      return { hasRTC: false, hasGetUserMedia: false, isWebViewLike: false, level: 'none' as const, missing: ['diagnóstico indisponível'] }
    }
  }, [])
  const uaLine = useMemo(() => {
    try { return String((navigator as any)?.userAgent ?? 'user-agent desconhecido') } catch { return 'user-agent desconhecido' }
  }, [])

  async function copyReport() {
    setCopyError(null)
    setCopied(false)
    try {
      const text = report
      const nav = navigator as Navigator & { clipboard?: { writeText?: (s: string) => Promise<void> } }
      if (nav.clipboard?.writeText) {
        await nav.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      setCopied(true)
    } catch (e: unknown) {
      setCopyError(e instanceof Error ? e.message : 'falha ao copiar')
    }
  }

  return (
    <div data-testid="diag-panel" style={{ fontFamily: 'Inter', color: t.text }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h3 style={{ fontWeight: 900, color: t.heading, margin: 0, fontSize: 17, flex: 1 }}>Diagnóstico de conexão</h3>
        {onClose && (
          <button onClick={onClose} aria-label="Fechar diagnóstico" style={{ background: 'transparent', border: 'none', color: t.muted, cursor: 'pointer', fontSize: 16 }}>x</button>
        )}
      </div>

      {loading && <div style={{ fontSize: 12, color: t.muted }}>carregando diagnóstico…</div>}
      {loadError && <div style={{ fontSize: 12, color: '#ff9c9c', background: '#2a1518', border: `1px solid ${t.red}55`, borderRadius: 8, padding: '8px 12px', marginBottom: 12 }}>{loadError}</div>}

      {!loading && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 140px', background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted }}>VERSÃO</div>
              <div data-testid="diag-version" style={{ fontSize: 14, fontWeight: 800, color: t.heading, marginTop: 2, fontFamily: "'JetBrains Mono', monospace" }}>{version || '?'}</div>
            </div>
            <div style={{ flex: '1 1 140px', background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted }}>ESTADO</div>
              <div data-testid="diag-state" style={{ fontSize: 14, fontWeight: 800, color: t.heading, marginTop: 2 }}>{state ? stateLabel[state] : '?'} • {onlinePeers} online • :{listenPort}</div>
            </div>
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>FINGERPRINT PRÓPRIO</div>
          <div data-testid="diag-fp" style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px', fontFamily: "'JetBrains Mono', monospace", fontSize: 13, color: t.heading, wordBreak: 'break-all', marginBottom: 14 }}>{fp || '(sem identidade)'}</div>

          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>PEERS ({peers.length})</div>
          <div data-testid="diag-peers" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {peers.length === 0 && <div style={{ fontSize: 12, color: t.muted }}>nenhum peer conhecido — adicione um amigo pelo fingerprint.</div>}
            {peers.map((p) => (
              <div key={p.fp} style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.state === 'CONNECTED' ? t.green : p.state === 'DISCONNECTED' ? '#80848e' : t.yellow, flexShrink: 0 }} />
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: t.heading, fontWeight: 700 }}>{shortFp(p.fp)}</span>
                  <span style={{ fontSize: 11, color: t.muted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.nickname || ''}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: t.muted }}>{p.state ? stateLabel[p.state] : '?'}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, color: p.via_relay ? t.accent : t.green, border: `1px solid ${t.border}`, borderRadius: 99, padding: '2px 8px', whiteSpace: 'nowrap' }}>{p.via_relay ? 'via relay' : 'direta'}</span>
                </div>
                {(p.state !== 'CONNECTED') && (p.last_direct_error || p.last_relay_error) && (
                  <div data-testid="diag-peer-error" style={{ fontSize: 10.5, color: t.muted, marginTop: 5, lineHeight: 1.5, fontFamily: "'JetBrains Mono', monospace" }}>
                    {p.last_direct_error && <div>direto: {p.last_direct_error} · {p.direct_attempts ?? 0}x</div>}
                    {p.last_relay_error && <div>relay: {p.last_relay_error} · {p.relay_attempts ?? 0}x</div>}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>REDE</div>
          <div data-testid="diag-net" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 11, color: t.muted, lineHeight: 1.5 }}>
              {netDiag == null && 'diagnóstico de rede indisponível neste modo'}
              {netDiag != null && netDiag.stun_ok === null && 'STUN: ainda não testado (aguarde o próximo ciclo de descoberta)'}
              {netDiag?.stun_ok === true && <span>STUN: <span style={{ color: t.green, fontWeight: 800 }}>ok</span> ({netDiag.stun_addr ?? '?'})</span>}
              {netDiag?.stun_ok === false && <span>STUN: <span style={{ color: t.yellow, fontWeight: 800 }}>falhou</span> — sem binding NAT; conexão direta só se o par puder receber</span>}
              {netDiag?.announce_addr
                ? <div>anúncio: {netDiag.announce_addr}{netDiag.nat_source ? ` (via ${netDiag.nat_source === 'upnp' ? 'UPnP/NAT-PMP local, sem servidor' : netDiag.nat_source === 'public-ip' ? 'IP público direto' : 'STUN público'})` : ''}</div>
                : netDiag != null && <div>anúncio: não anunciado — STUN é UDP e não abre porta TCP; sem UPnP o par não chega. Relay e túnel cobrem isso (e é por isso que o overlay não fica mais preso em “Conectando…”).</div>}
              {netDiag?.dht_ok === true && <div>DHT BitTorrent: <span style={{ color: t.green, fontWeight: 800 }}>ok</span> — descoberta descentralizada ativa</div>}
              {netDiag?.dht_ok === false && <div>DHT BitTorrent: <span style={{ color: t.yellow, fontWeight: 800 }}>off/falhou</span> — (FORGE_NO_DHT, UDP bloqueado ou modo proxy/Tor)</div>}
            </div>
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>RELAY ({legs.length || (legsError ? 0 : 0)})</div>
          <div data-testid="diag-relay" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
            {legsError && <div style={{ fontSize: 12, color: t.yellow, background: '#2a1f0a', border: `1px solid ${t.yellow}55`, borderRadius: 8, padding: '8px 12px' }}>{legsError}</div>}
            {!legsError && legs.map((l) => (
              <div key={l.name} style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.ok ? t.green : t.red, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 800, color: t.heading, flex: 1 }}>{l.name}</span>
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: l.ok ? t.green : t.red }}>{l.ok ? `OK${l.latency_ms != null ? ` • ${l.latency_ms} ms` : ''}` : 'FALHA'}</span>
                </div>
                {!l.ok && l.last_error && <div style={{ fontSize: 11, color: t.muted, marginTop: 4, lineHeight: 1.5 }}>{l.last_error}</div>}
              </div>
            ))}
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>CHAMADAS NESTE APARELHO</div>
          <div data-testid="diag-calls" style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px', fontSize: 11, color: t.muted, lineHeight: 1.6, marginBottom: 14 }}>
            <div>
              modo:{' '}
              <span style={{ color: callsDiag.level === 'full' ? t.green : t.red, fontWeight: 800 }}>
                {callsDiag.level === 'full' ? 'WebRTC direto' : 'indisponível'}
              </span>
            </div>
            <div>WebRTC: {callsDiag.hasRTC ? 'ok' : 'ausente (WebView sem RTCPeerConnection)'} · microfone: {callsDiag.hasGetUserMedia ? 'ok' : 'sem getUserMedia'}{callsDiag.isWebViewLike ? ' · WebView' : ''}</div>
            {callsDiag.level === 'none' && <div style={{ color: t.red }}>Falta: {callsDiag.missing.join('; ')}</div>}
            <div style={{ color: t.muted }}>Rota: ICE host/STUN/TURN. Sem áudio-via-relay: se a rota não fechar, a chamada encerra com aviso.</div>
            <div style={{ opacity: 0.7, marginTop: 4, wordBreak: 'break-all' }}>{uaLine}</div>
          </div>

          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>RELATÓRIO P/ SUPORTE</div>
          <pre data-testid="diag-report-text" style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 11, lineHeight: 1.6, color: t.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto', margin: 0, fontFamily: "'JetBrains Mono', monospace" }}>{report}</pre>

          <button onClick={copyReport} style={{ width: '100%', marginTop: 10, background: t.accent, color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 14 }}>Copiar relatório</button>
          {copied && <div style={{ marginTop: 8, fontSize: 12, color: '#8cf5b8', background: '#1a3329', border: `1px solid ${t.green}55`, borderRadius: 8, padding: '8px 12px' }}>Relatório copiado!</div>}
          {copyError && <div style={{ marginTop: 8, fontSize: 12, color: '#ff9c9c' }}>{copyError}</div>}
          <div style={{ fontSize: 11, color: t.muted, marginTop: 8, lineHeight: 1.5 }}>Se o relay não conecta no 4G, copie e cole no suporte com o nome da operadora.</div>
        </>
      )}
    </div>
  )
}
