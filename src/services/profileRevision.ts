// Identidade de VERSÃO de um perfil, compartilhada pelos dois runtimes
// (nativo via Tauri e mock do navegador).
//
// O motor Rust é a autoridade quando existe (`social::profile_content_hash`):
// aqui só reproduzimos a mesma conta para o mock e para os testes unitários,
// com a MESMA regra — campos públicos em ordem fixa, cada um prefixado pelo
// tamanho (para "ab"+"c" não colidir com "a"+"bc"), blake3 truncado em 32 hex.
//
// `updated_at` NÃO entra: é relógio de quem grava. `rev` NÃO entra: duas
// edições no mesmo contador são conflito real, não "mesmo conteúdo".

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

/** Hash de conteúdo do perfil (32 hex = 128 bits), igual ao do core. */
export function profileContentHash(p: ProfileContent): string {
  const parts = [p.display_name, p.about, p.avatar_b64, p.banner_b64, p.accent]
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    const bytes = new TextEncoder().encode(part)
    // tamanho em 8 bytes LE, idêntico a `(len as u64).to_le_bytes()` no Rust
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

/**
 * Resolve conflito entre a versão local e uma recebida, com a mesma política do
 * motor. Retorna `true` se a remota deve substituir a local.
 *
 * Devolve `false` para "nada mudou" — a UI não deve re-renderizar nem baixar
 * imagem nenhuma nesse caso.
 */
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
  // Mesmo rev e conteúdo diferente: desempate determinístico (todos os peers
  // escolhem o mesmo vencedor, a rede converge em vez de oscilar).
  return rhash > lhash
}
