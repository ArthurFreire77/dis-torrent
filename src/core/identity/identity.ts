import { generateKeypair, fingerprintOf, hex } from './crypto'

export type UserIdentity = {
  fingerprint: string
  pubkey_hex: string
  nickname: string
  created_at: number
}

export function createIdentity(nickname: string): { identity: UserIdentity, privHex: string } {
  const { priv, pub } = generateKeypair()
  const fp = fingerprintOf(pub)
  const identity: UserIdentity = {
    fingerprint: fp,
    pubkey_hex: hex.toHex(pub),
    nickname: nickname.trim() || `user#${fp}`,
    created_at: Date.now(),
  }
  return { identity, privHex: hex.toHex(priv) }
}
