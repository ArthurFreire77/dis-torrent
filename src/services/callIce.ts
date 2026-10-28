// Servidores ICE/TURN da chamada + privacidade por modo.
//
// POR QUÃŠ UM MÃ“DULO PRÃ“PRIO (mesmo padrÃ£o do callWire.ts): o callManager
// importa a Ã¡rvore de services (localStorage/@tauri) e nÃ£o Ã© carregÃ¡vel
// pelo runner de testes unit (node strip-types); este arquivo Ã© standalone
// e testÃ¡vel. O callManager reexporta tudo â€” shells importam como sempre.
//
// PRIVACIDADE Ã— ICE: em proxy/full os SERVIDORES PÃšBLICOS de reserva
// (Google STUN, openrelay TURN) NÃƒO entram na lista â€” o ICE do WebRTC usa
// sockets UDP diretos do WebView (fora do SOCKS5/Tor do app), entÃ£o
// consultÃ¡-los entregaria o IP real a terceiros que o modo promete
// esconder. Fica sÃ³ o TURN/STUN configurado EXPLICITAMENTE pelo usuÃ¡rio.
// Ver THREAT_MODEL.md ("LimitaÃ§Ãµes assumidas").

import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
// .ts explícito: node strip-types exige a extensão; o tsconfig do projeto
// tem allowImportingTsExtensions e o Vite resolve igual.
import { isIcePublicFallbackSuppressed } from './callIcePrivacy.ts'
export const TURN_URL_KEY = 'distorrent:turn_url'

export function isValidTurnUrl(u: string): boolean {
  const v = (u ?? '').trim()
  if (!(v.startsWith('turn:') || v.startsWith('turns:'))) return false
  const rest = v.replace(/^turns?:/, '')
  // exige host após o esquema (ex.: turn:host:porta) e proíbe espaços
  return rest.length > 0 && !rest.startsWith('/') && !/\s/.test(v)
}

export function getTurnUrl(): string {
  try {
    return typeof localStorage !== 'undefined' ? (localStorage.getItem(TURN_URL_KEY) ?? '') : ''
  } catch { return '' }
}

// ── P2P puro: nenhum servidor de terceiro no padrão ─────────────────────────
// A lista padrão de ICE é VAZIA (só candidatos host locais) + o que o usuário
// configurar explicitamente (distorrent:turn_url / VITE_TURN_URL). Os fallbacks
// públicos (Google STUN, openrelay TURN com credencial pública e cota de
// ~20 GB/mês) SAÍRAM do padrão: mídia 100% P2P, sem VPS e sem terceiro.
// Consequência honesta: fora da LAN, NAT restritivo/4G pode não fechar rota —
// a UI avisa (hasRelayConfigured) em vez de fingir. As funções abaixo seguem
// exportadas para opt-in explícito, não para o caminho padrão.
const FALLBACK_TURN_HOST = 'staticauth.openrelay.metered.ca'
const FALLBACK_TURN_SECRET = 'openrelayprojectsecret'
/** Validade da credencial efêmera gerada localmente (o coturn aceita até o epoch). */
const FALLBACK_TURN_TTL_S = 24 * 3600

/**
 * STUN público: descobre o IP/porta mapped do NAT (candidato `srflx`) SEM
 * envolver nenhum terceiro no tráfego — o STUN só responde "qual é o meu
 * endereço"; a mídia continua indo direto de um peer para o outro.
 * Sem nenhum `stun:` na lista, atrás de NAT o ICE só produzia candidatos
 * `host` (endereço privado), que nenhum peer de fora consegue alcançar — e a
 * chamada morria sem nunca tentar a rota direta.
 */
const FALLBACK_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:global.stun.twilio.com:3478',
]

/** Servidores STUN de reserva (sem credencial, sem mídia passando por eles). */
export function getFallbackStunServers(): RTCIceServer[] {
  return FALLBACK_STUN_URLS.map((urls) => ({ urls }))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  // btoa existe no browser/Tauri/Node16+; se indisponível, lança → chamador retorna null
  return btoa(bin)
}

/**
 * Gera credencial TURN efêmera (esquema static-auth-secret do coturn) de forma
 * síncrona via @noble/hashes (já é dependência do projeto). Retorna null se algo
 * falhar — o chamador então segue só com o relay configurado, sem quebrar nada.
 */
export function getFallbackTurnCredential(nowMs: number = Date.now()): { username: string; credential: string } | null {
  try {
    const expiry = Math.floor(nowMs / 1000) + FALLBACK_TURN_TTL_S
    const username = `${expiry}:distorrent`
    const mac = hmac(sha1, new TextEncoder().encode(FALLBACK_TURN_SECRET), new TextEncoder().encode(username))
    return { username, credential: bytesToBase64(mac) }
  } catch { return null }
}

/** Servidor TURN de emergência (último da lista) ou null se a credencial falhar. */
export function getFallbackTurnServer(): RTCIceServer | null {
  const cred = getFallbackTurnCredential()
  if (!cred) return null
  return {
    urls: [
      `turn:${FALLBACK_TURN_HOST}:80`,
      `turn:${FALLBACK_TURN_HOST}:443`,
      `turns:${FALLBACK_TURN_HOST}:443`,
    ],
    username: cred.username,
    credential: cred.credential,
  }
}

/**
 * TURN público CLÁSSICO (openrelay) com credenciais estáticas fixas. O host
 * segue no ar (o `staticauth...` acima está instável/fora). Entra como reserva
 * ADICIONAL — o ICE tenta todos e usa o que responder. Sem isso, no 4G/CGNAT
 * não há rota de mídia e a chamada fica muda.
 */
export function getClassicTurnServer(): RTCIceServer {
  return {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:3478',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  }
}

// Relay explícito do usuário: via localStorage distorrent:turn_url (ex: turn:seu-relay:3478)
// ou via env VITE_TURN_URL (+ VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL; padrão distorrent/distorrent).
// Padrão = só o configurado. Nenhum STUN/TURN público embutido (P2P puro).
export function getIceServers(): RTCIceServer[] {
  // â”€â”€ Privacidade Ã— ICE â€” MUDOU DE POLÃTICA (era: "a lista nÃ£o muda") â”€â”€
  // O ICE do WebRTC no browser/WebView NÃƒO passa pelo SOCKS5/Tor do app (o
  // proxy cobre o TCP do distorrent-core; a mÃ­dia usa sockets UDP do prÃ³prio
  // WebRTC). NÃ£o hÃ¡ como "rotear o ICE pelo Tor" a partir deste mÃ³dulo â€”
  // limitaÃ§Ã£o documentada no THREAT_MODEL.
  // O QUE MUDOU: em proxy/full os SERVIDORES PÃšBLICOS de reserva (Google
  // STUN, openrelay TURN) ficam FORA da lista â€” consultÃ¡-los entregaria o
  // IP real a terceiros que o modo promete esconder. Fica sÃ³ o TURN/STUN
  // configurado EXPLICITAMENTE pelo usuÃ¡rio (servidor dele, escolha dele)
  // + candidatos host (LAN). A chamada segue possÃ­vel na LAN; a UI mostra
  // "chamada nÃ£o anÃ´nima" enquanto houver chamada nesses modos.
  const servers: RTCIceServer[] = []
  // também tenta localStorage para UI dinâmica
  const env: any = (import.meta as any)?.env ?? {}
  const turnUser = (env.VITE_TURN_USERNAME as string | undefined) || 'distorrent'
  const turnCred = (env.VITE_TURN_CREDENTIAL as string | undefined) || 'distorrent'
  try {
    const ls = getTurnUrl()
    if (ls && isValidTurnUrl(ls)) servers.push({ urls: ls.trim(), username: turnUser, credential: turnCred })
  } catch { /* ignore */ }
  try {
    const viteTurn = env.VITE_TURN_URL as string | undefined
    if (viteTurn && isValidTurnUrl(viteTurn) && viteTurn.trim() !== getTurnUrl().trim()) {
      servers.push({ urls: viteTurn.trim(), username: turnUser, credential: turnCred })
    }
  } catch { /* ignore */ }
  // ── Reserva automática (Fase "funciona no 4G/CGNAT") ──────────────────────
  // Bug real que isto corrige: as funções abaixo existiam mas NUNCA eram
  // chamadas. Resultado: com nenhum TURN configurado no usuário, a lista de
  // ICE saía vazia de servidores → em 4G/CGNAT o ICE só tinha candidatos
  // host/srflx, nunca fechava, e a chamada ficava muda (ou caía no relay).
  // Agora, mesmo sem configurar nada, o ICE tem rotas de reserva públicas.
  // proxy/full: NÃO consulta os SERVIDORES PÚBLICOS de reserva (Google
  // STUN / openrelay veriam o IP real que o modo promete esconder). A lista
  // fica apenas com o que o usuário configurou explicitamente — pode ser
  // VAZIA, e aí a chamada só fecha na LAN. Comportamento honesto do modo.
  if (isIcePublicFallbackSuppressed()) {
    return servers
  }
  try {
    const classic = getClassicTurnServer()
    const fallback = getFallbackTurnServer()
    const seen = new Set(servers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)).trim()))
    for (const s of [...getFallbackStunServers(), classic, fallback]) {
      if (!s) continue
      const key = (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)).trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      servers.push(s)
    }
  } catch { /* ignore */ }
  return servers
}

/** True quando há degrau de relay explícito (turn:/turns: configurado). */
export function hasRelayConfigured(servers?: RTCIceServer[]): boolean {
  try {
    const list = servers ?? getIceServers()
    return list.some(s => {
      const u: unknown = (s as any)?.urls
      const all = Array.isArray(u) ? u.join(' ') : String(u ?? '')
      return /(^|\s)turns?:/i.test(all)
    })
  } catch { return false }
}
