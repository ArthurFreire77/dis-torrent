// Base64 de bytes — fonte ÚNICA.
//
// Existiam três cópias quase iguais (`fileBody.ts`, `fileSwarm.ts`,
// `callManager.ts`). Duas delas montavam a string byte a byte e estouravam a
// pilha em arquivos grandes; a de `fileBody` já usava o laço em blocos. Agora
// todo mundo usa a versão em blocos, que é a correta.
//
// Módulo puro: só depende de `btoa`/`atob`, que o Node expõe desde a v18.

/** Tamanho do bloco: 8 KiB cabe folgado na pilha e evita milhões de concatenações. */
const CHUNK = 8192

/** `Uint8Array` → base64 (sem prefixo `data:`). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK)
    let part = ''
    for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j])
    out += part
  }
  return btoa(out)
}

/** base64 → `Uint8Array`. Lança se o texto não for base64 válido. */
export function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** base64 → bytes, mas devolve `null` em vez de lançar (payload de terceiro). */
export function tryBase64ToBytes(value: string): Uint8Array | null {
  try {
    return base64ToBytes(value)
  } catch {
    return null
  }
}
