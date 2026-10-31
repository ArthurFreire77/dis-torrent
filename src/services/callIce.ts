// Servidores ICE/TURN da chamada + privacidade por modo.
// Módulo standalone (mesmo padrão do callWire.ts): o callManager importa a
// árvore de services e não é carregável no unit (node strip-types); o
// callManager reexporta tudo.
// PRIVACIDADE × ICE: em proxy/full os SERVIDORES PÚBLICOS de reserva NÃO
// entram — o ICE usa UDP direto do WebView (fora do SOCKS5/Tor) e consultá-los
// entregaria o IP real. Fica só o TURN/STUN configurado pelo usuário.
// Ver THREAT_MODEL.md ("Limitações assumidas").

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

// ── P2P puro: lista padrão de ICE VAZIA (só candidatos host) + o que o
// usuário configurar (localStorage/env). Os fallbacks públicos SAÍRAM do
// padrão (mídia 100% P2P, sem terceiro); fora da LAN, NAT restritivo/4G pode
// não fechar rota — a UI avisa (hasRelayConfigured). Seguem exportados para
// opt-in explícito.
const FALLBACK_TURN_HOST = 'staticauth.openrelay.metered.ca'
const FALLBACK_TURN_SECRET = 'openrelayprojectsecret'
/** Validade da credencial efêmera gerada localmente (o coturn aceita até o epoch). */
const FALLBACK_TURN_TTL_S = 24 * 3600

/** STUN público: descobre o mapped address do NAT (srflx) sem tocar na mídia. */
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

/** Credencial TURN efêmera (static-auth-secret do coturn); null se falhar. */
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

/** TURN público clássico (openrelay, credencial estática) como reserva adicional. */
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
  // Privacidade × ICE: o ICE não passa pelo SOCKS5/Tor do app (limitação do
  // THREAT_MODEL). Em proxy/full, servidores públicos de reserva ficam FORA —
  // consultá-los entregaria o IP real. Só o que o usuário configurou + host.
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
  // Reserva automática: sem ela a lista saía vazia e a chamada ficava muda em
  // 4G/CGNAT. Em proxy/full os servidores públicos ficam fora (IP real exposto);
  // a lista pode ficar vazia e a chamada só fechar na LAN — honesto.
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
