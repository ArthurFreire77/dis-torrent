import { blake3 } from '@noble/hashes/blake3.js'

export interface ProfileContent {
  display_name: string
  about: string
  avatar_b64: string
  banner_b64: string
  accent: string
}

function toHex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export function profileContentHash(p: ProfileContent): string {
  const parts = [p.display_name, p.about, p.avatar_b64, p.banner_b64, p.accent]
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part)
    const len = new Uint8Array(8)
    new DataView(len.buffer).setBigUint64(0, BigInt(bytes.length), true)
    chunks.push(len, bytes)
  }
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { buf.set(c, off); off += c.length }
  return toHex(blake3(buf)).slice(0, 32)
}

export function shouldApplyRemoteProfile(
  local: { rev?: number; content_hash?: string } | null | undefined,
  remote: { rev?: number; content_hash?: string },
): boolean {
  const lrev = local?.rev ?? 0
  const rrev = remote.rev ?? 0
  if (rrev > lrev) return true
  if (rrev < lrev) return false
  const lhash = local?.content_hash ?? ''
  const rhash = remote.content_hash ?? ''
  if (lhash && lhash === rhash) return false
  if (rrev === 0) return lhash !== rhash
  return rhash > lhash
}
