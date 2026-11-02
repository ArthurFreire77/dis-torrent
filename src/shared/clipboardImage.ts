// Imagem colada no compositor (Ctrl+V).
//
// Colar uma imagem não dispara `onChange` do `<textarea>`: o conteúdo binário
// só aparece em `clipboardData.files`/`items`. Sem tratar `paste`, o Ctrl+V com
// um print na área de transferência não enviava nada — era o relatado.

/** Extensões que o envio por swarm trata como imagem (ver `fileRules`). */
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

/**
 * Nome para a imagem colada.
 *
 * Print de tela colado não tem nome de arquivo; usar só `"image.png"` criava
 * colisão no histórico e no disco de quem recebe. A data vai no nome para cada
 * paste ser único e reconhecível.
 */
export function pastedImageName(mime: string, when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp =
    `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  return `imagem-${stamp}.${extFromMime(mime)}`
}

/** Item mínimo de `DataTransferItemList` (permite testar sem DOM). */
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
  /** Nome do arquivo, já com extensão coerente com o tipo. */
  name: string
  type: string
  size: number
  /** Índice em `files` (o chamador mapeia para o `File` real). */
  fileIndex: number
}

/**
 * Imagens presentes no evento `paste`, em ordem e sem duplicar.
 *
 * `files` vem preenchido na maioria dos browsers, mas o WebView2 às vezes só
 * popula `items` — por isso os dois caminhos. Item que não é imagem é ignorado
 * (colar texto/imagem juntos continua colando o texto normalmente).
 */
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
    // Nome do SO quando existe (print do Windows vem com nome); senão gera.
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

/** Há imagem para colar? A UI usa para decidir se chama `preventDefault`. */
export function hasPastedImage(data: ClipboardLike | null | undefined): boolean {
  return pastedImages(data, new Date(0)).length > 0
}
