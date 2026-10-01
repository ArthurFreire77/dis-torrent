import { generateKeypair, fingerprintOf, hex } from './crypto'

// Mesma forma do forge-core::identity::Identity (serde snake_case) —
// o modo navegador espelha exatamente o contrato do motor nativo.
export type UserIdentity = {
  fingerprint: string // 12 hex
  pubkey_hex: string // 64 hex (32 bytes)
  nickname: string
  created_at: number
}

// priv nunca sai daqui serializado para UI; armazenado separado e não exportado para componentes
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
