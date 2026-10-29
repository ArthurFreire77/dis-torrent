import type { NetDiag, NetworkState, PeerView, RelayLegStatus } from './models'

export const stateLabel: Record<NetworkState, string> = {
  CONNECTED: 'CONECTADO',
  CONNECTING: 'CONECTANDO',
  RECONNECTING: 'RECONECTANDO',
  DISCONNECTED: 'OFFLINE',
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
  redactSensitive?: boolean
}): string {
  const redact = args.redactSensitive === true
  const lines: string[] = []
  lines.push('DisTorrent — relatório de conexão (colar no suporte)')
  lines.push(`versão: ${args.version || '?'}`)
  lines.push(`fingerprint: ${redact ? '(ocultado)' : args.fp || '?'}`)
  lines.push(`apelido: ${redact ? '(ocultado)' : args.nickname || '?'}`)
  lines.push(`modo: ${args.kind}`)
  lines.push(`estado: ${args.state ? stateLabel[args.state] : '?'} (${args.onlinePeers} online, porta ${redact ? '(ocultada)' : `:${args.listenPort}`})`)
  const nd = args.netDiag
  if (nd) {
    if (nd.stun_ok === null) lines.push('STUN: ainda não testado')
    else if (nd.stun_ok) lines.push(`STUN: ok (${redact ? 'endereço oculto' : nd.stun_addr ?? '?'})`)
    else lines.push('STUN: falhou (sem binding NAT; conectividade direta não comprovada)')
    if (nd.dht_ok === null) lines.push('DHT BitTorrent: não informado (estado ainda desconhecido)')
    else if (nd.dht_ok) lines.push('DHT BitTorrent: ok — nó anunciando na rede BitTorrent')
    else lines.push('DHT BitTorrent: falhou (UDP bloqueado?)')
    if (nd.announce_addr) lines.push(`anúncio: ${redact ? 'endereço oculto' : nd.announce_addr}${nd.nat_source ? ` (via ${nd.nat_source === 'upnp' ? 'UPnP/NAT-PMP local, sem servidor' : nd.nat_source === 'public-ip' ? 'IP público direto' : 'STUN público'})` : ''}`)
    else lines.push('anúncio: não anunciado; STUN usa UDP e não comprova que a porta TCP aceita conexões')
  }
  lines.push(`peers (${args.peers.length}):`)
  if (args.peers.length === 0) {
    lines.push('- (nenhum peer conhecido)')
  } else {
    for (const [index, p] of args.peers.entries()) {
      const via = p.via_relay ? 'via relay' : 'direta'
      const stuck = p.state === 'CONNECTING' && (p.direct_attempts ?? 0) >= 6
      const state = stuck ? 'SEM ROTA DIRETA' : (p.state ? stateLabel[p.state] : '?')
      lines.push(`- ${redact ? `peer ${index + 1}` : shortFp(p.fp)} (${redact ? 'identificador oculto' : p.nickname || '?'}, ${state}, ${via})`)
      if (p.last_direct_error) lines.push(`  direto: ${redact ? 'falha observada (detalhe de rede ocultado)' : p.last_direct_error} (${p.direct_attempts ?? 0} tentativas)`)
      if (stuck) lines.push('  → rota direta ainda não estabelecida; firewall, NAT ou endpoint indisponível podem explicar as falhas')
      if (p.last_relay_error) lines.push(`  relay: ${redact ? 'falha observada (detalhe de rede ocultado)' : p.last_relay_error} (${p.relay_attempts ?? 0} tentativas)`)
      if (p.announce_seen_ms && Date.now() - p.announce_seen_ms < 10 * 60 * 1000) lines.push('  announce do peer visto há pouco')
    }
  }
  lines.push(`relay (${args.legs.length}):`)
  if (args.legsError) {
    lines.push(`- indisponível: ${redact ? 'detalhe de rede ocultado' : args.legsError}`)
  } else if (args.legs.length === 0) {
    lines.push('- (sem pernas)')
  } else {
    for (const [index, l] of args.legs.entries()) {
      const name = redact ? `perna ${index + 1}` : l.name
      if (l.ok) lines.push(`- ${name}: broker alcançável (${l.latency_ms ?? '?'} ms)`)
      else lines.push(`- ${name}: falha (${redact ? 'detalhe de rede ocultado' : l.last_error ?? 'erro desconhecido'})`)
    }
  }
  if (redact) lines.push('privacidade: fingerprints, apelidos, portas e endereços de rede foram ocultados')
  lines.push('nota: broker alcançável não comprova que um relay encaminhou sessão entre peers')
  lines.push(`gerado em: ${new Date().toISOString()}`)
  return lines.join('\n')
}
