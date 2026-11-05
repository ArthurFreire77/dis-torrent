const CHUNK = 8192

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

export function base64ToBytes(value: string): Uint8Array {
  const bin = atob(value)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function tryBase64ToBytes(value: string): Uint8Array | null {
  try {
    return base64ToBytes(value)
  } catch {
    return null
  }
}
