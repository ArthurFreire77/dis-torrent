import { createEmitter } from '../shared/emitter.ts'

type Listener = (token: string) => void

let pendingToken: string | null = null
const seen = new Set<string>()
const invites = createEmitter<string>()

export function tokenFromInviteUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (!value.includes('://') && !value.startsWith('/')) {
    return value
  }
  try {
    const url = new URL(value.startsWith('/') ? `http://local${value}` : value)
    const fromQuery = url.searchParams.get('invite') || url.searchParams.get('token')
    if (fromQuery) return fromQuery.trim() || null
    const seg = url.pathname.split('/').filter(Boolean).pop()
    return seg ? decodeURIComponent(seg) : null
  } catch {
    return null
  }
}

export function offerInvite(raw: string): boolean {
  const token = tokenFromInviteUrl(raw)
  if (!token) return false
  if (seen.has(token)) {
    return false
  }
  seen.add(token)
  if (seen.size > 32) {
    const first = seen.values().next()
    if (!first.done) seen.delete(first.value)
  }
  pendingToken = token
  invites.emit(token)
  return true
}

export function peekInvite(): string | null {
  return pendingToken
}

export function consumeInvite(): string | null {
  const token = pendingToken
  pendingToken = null
  return token
}

export function subscribeInvite(cb: Listener): () => void {
  return invites.subscribe(cb)
}

export function __resetInviteForTests(): void {
  pendingToken = null
  seen.clear()
  invites.clear()
}
