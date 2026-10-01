import * as ed from '@noble/ed25519'
import { blake3 } from '@noble/hashes/blake3.js'
import { sha512 } from '@noble/hashes/sha2.js'

// enable sync methods
;(ed as any).hashes.sha512 = sha512

function toHex(b: Uint8Array): string { return Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('') }
function fromHex(h: string): Uint8Array {
  const pairs = h.match(/.{2}/g)
  if (!pairs) throw new Error(`hex inválido: ${h}`)
  return Uint8Array.from(pairs.map(x => parseInt(x, 16)))
}

export function generateKeypair(): { priv: Uint8Array, pub: Uint8Array } {
  const { secretKey, publicKey } = ed.keygen()
  return { priv: secretKey, pub: publicKey }
}

export function fingerprintOf(pub: Uint8Array): string {
  return toHex(blake3(pub)).slice(0,12)
}

export async function sign(priv: Uint8Array, msg: Uint8Array): Promise<Uint8Array> {
  return await ed.signAsync(msg, priv)
}

export async function verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  return await ed.verifyAsync(sig, msg, pub)
}

export const hex = { toHex, fromHex }
