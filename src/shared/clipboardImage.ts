const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
}

export function isImageMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(IMAGE_EXT, String(mime ?? '').toLowerCase())
}

function extFromMime(mime: string): string {
  return IMAGE_EXT[String(mime ?? '').toLowerCase()] ?? 'png'
}

export function pastedImageName(mime: string, when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  return `imagem-${stamp}.${extFromMime(mime)}`
}

export interface ClipboardItemLike {
  kind?: string
  type?: string
  getAsFile?: () => { name?: string; type?: string; size?: number } | null
}

export interface ClipboardLike {
  files?: ArrayLike<{ name?: string; type?: string; size?: number }> | null
  items?: ArrayLike<ClipboardItemLike> | null
}

export interface PastedFile {
  name: string
  type: string
  size: number
  fileIndex: number
}

export function pastedImages(data: ClipboardLike | null | undefined, when: Date): PastedFile[] {
  const out: PastedFile[] = []
  const files = data?.files ? Array.from(data.files) : []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    const type = String(f?.type ?? '').toLowerCase()
    if (!isImageMime(type)) continue
    const size = Number(f?.size ?? 0)
    if (!Number.isFinite(size) || size <= 0) continue
    const original = String(f?.name ?? '').trim()
    const name = original && /\.[a-z0-9]{2,5}$/i.test(original) ? original : pastedImageName(type, when)
    out.push({ name, type, size, fileIndex: i })
  }
  if (out.length > 0) return out

  const items = data?.items ? Array.from(data.items) : []
  for (const it of items) {
    if (it?.kind && it.kind !== 'file') continue
    const type = String(it?.type ?? '').toLowerCase()
    if (!isImageMime(type)) continue
    const f = it.getAsFile ? it.getAsFile() : null
    if (!f) continue
    const size = Number(f.size ?? 0)
    if (!Number.isFinite(size) || size <= 0) continue
    out.push({ name: pastedImageName(type, when), type, size, fileIndex: out.length })
  }
  return out
}

export function hasPastedImage(data: ClipboardLike | null | undefined): boolean {
  return pastedImages(data, new Date(0)).length > 0
}
