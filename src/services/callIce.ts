import { isIcePublicFallbackSuppressed } from './callIcePrivacy.ts'
export const TURN_URL_KEY = 'distorrent:turn_url'

export function isValidTurnUrl(u: string): boolean {
  const v = (u ?? '').trim()
  if (!(v.startsWith('turn:') || v.startsWith('turns:'))) return false
  const rest = v.replace(/^turns?:/, '')
  return rest.length > 0 && !rest.startsWith('/') && !/\s/.test(v)
}

export function getTurnUrl(): string {
  try {
    return typeof localStorage !== 'undefined' ? (localStorage.getItem(TURN_URL_KEY) ?? '') : ''
  } catch { return '' }
}

const FALLBACK_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
]

export function getFallbackStunServers(): RTCIceServer[] {
  return FALLBACK_STUN_URLS.map((urls) => ({ urls }))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

/**
 * Credencial TURN de um servidor do usuário (URL + usuário + senha).
 *
 * O "TURN público de reserva" (openrelay.metered.ca) FOI REMOVIDO: o domínio
 * resolve para 192.0.2.1 (faixa de documentação, RFC 5737) e não responde UDP
 * nem na 3478, nem na 80, nem na 443. Anunciá-lo fazia o ICE coletar candidatos
 * para um relay inexistente e a chamada ficar "Conectando..." para sempre,
 * porque o navegador só desiste depois de esgotar o TURN. Com a lista vazia o
 * ICE fecha rápido e o app cai na rota de áudio pela sinalização.
 */
export function getFallbackTurnCredential(): { username: string; credential: string } | null {
  return null
}

export function getFallbackTurnServer(): RTCIceServer | null {
  return null
}

export function getClassicTurnServer(): RTCIceServer | null {
  return null
}

export function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = []
  const env: any = (import.meta as any)?.env ?? {}
  const turnUser = (env.VITE_TURN_USERNAME as string | undefined) || 'distorrent'
  const turnCred = (env.VITE_TURN_CREDENTIAL as string | undefined) || 'distorrent'
  try {
    const ls = getTurnUrl()
    if (ls && isValidTurnUrl(ls)) servers.push({ urls: ls.trim(), username: turnUser, credential: turnCred })
  } catch {  }
  try {
    const viteTurn = env.VITE_TURN_URL as string | undefined
    if (viteTurn && isValidTurnUrl(viteTurn) && viteTurn.trim() !== getTurnUrl().trim()) {
      servers.push({ urls: viteTurn.trim(), username: turnUser, credential: turnCred })
    }
  } catch {  }
  if (isIcePublicFallbackSuppressed()) {
    return servers
  }
  try {
    const seen = new Set(servers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)).trim()))
    for (const s of getFallbackStunServers()) {
      const key = (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)).trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      servers.push(s)
    }
  } catch {  }
  return servers
}

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
