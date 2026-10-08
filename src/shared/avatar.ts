// Avatar/banner: comprime no aparelho antes do P2P (avatar ≤128px/100KB,
// banner ≤512px/300KB). Compressão 100% local, sem rede.

export const AVATAR_MAX_PX = 128
export const AVATAR_MAX_BYTES = 100_000
export const BANNER_MAX_PX = 512
export const BANNER_MAX_BYTES = 300_000

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image()
    img.onload = () => res(img)
    img.onerror = () => rej(new Error('não foi possível ler a imagem'))
    img.src = dataUrl
  })
}

/** Redimensiona + comprime. Retorna base64 SEM o prefixo data:. */
export async function compressImage(
  file: File,
  maxPx: number,
  maxBytes: number,
  quality = 0.82,
): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('o arquivo precisa ser uma imagem')
  if (file.size > 12 * 1024 * 1024) throw new Error('imagem grande demais (máx 12 MB)')
  const dataUrl = await new Promise<string>((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result))
    r.onerror = () => rej(new Error('falha ao ler imagem'))
    r.readAsDataURL(file)
  })
  const img = await loadImage(dataUrl)
  const scale = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight))
  const w = Math.max(1, Math.round(img.naturalWidth * scale))
  const h = Math.max(1, Math.round(img.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas indisponível')
  ctx.drawImage(img, 0, 0, w, h)
  // Tenta JPEG primeiro (menor); se estourar, reduz qualidade em 2 passos.
  for (const q of [quality, 0.7, 0.55]) {
    const url = canvas.toDataURL('image/jpeg', q)
    const b64 = url.slice(url.indexOf(',') + 1)
    if (b64.length * 0.75 <= maxBytes) return b64
  }
  throw new Error(
    maxPx === AVATAR_MAX_PX
      ? 'avatar ainda passa de 100 KB após compressão — use uma imagem menor'
      : 'banner ainda passa de 300 KB após compressão — use uma imagem menor',
  )
}

export const compressAvatar = (f: File) => compressImage(f, AVATAR_MAX_PX, AVATAR_MAX_BYTES)
export const compressBanner = (f: File) => compressImage(f, BANNER_MAX_PX, BANNER_MAX_BYTES)

// ---------- cache LRU em memória (peers vistos nesta sessão) ----------

const MEMO_MAX = 300
const memo = new Map<string, string>()

export function avatarCacheGet(fp: string): string | undefined {
  const v = memo.get(fp)
  if (v !== undefined) {
    memo.delete(fp)
    memo.set(fp, v)
  }
  return v
}

export function avatarCacheSet(fp: string, b64: string): void {
  if (memo.has(fp)) memo.delete(fp)
  memo.set(fp, b64)
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next()
    if (!oldest.done) memo.delete(oldest.value)
  }
}

export function avatarCacheClear(): void {
  memo.clear()
}
