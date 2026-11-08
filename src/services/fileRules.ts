export const CHUNK = 256 * 1024

import { formatFileSize as formatSize } from '../shared/bytes.ts'

const MAX_FILE_MB = (() => {
  const raw = (() => {
    try {
      const meta = import.meta as unknown as { env?: Record<string, string> }
      return meta.env?.VITE_DISTORRENT_MAX_FILE_MB
    } catch { return undefined }
  })()
  const n = Number(raw)
  // 500 GiB: o teto anterior (50 GB) recusava arquivos grandes no anúncio.
  return Number.isFinite(n) && n > 0 ? n : 512000
})()

export const MAX_FILE_SIZE = MAX_FILE_MB * 1024 * 1024
export const MAX_CHUNKS = Math.ceil(MAX_FILE_SIZE / CHUNK) + 1
export const MAX_FILE_MB_LABEL = Math.round(MAX_FILE_MB) >= 1024
  ? `${(MAX_FILE_MB / 1024).toFixed(MAX_FILE_MB % 1024 === 0 ? 0 : 1)} GB`
  : `${Math.round(MAX_FILE_MB)} MB`

export function validateAnnounce(size: number, chunks: number): string | null {
  if (!Number.isFinite(size) || size < 0) return 'tamanho de arquivo inválido'
  if (size > MAX_FILE_SIZE) return `arquivo muito grande (limite ${MAX_FILE_MB_LABEL})`
  if (!Number.isFinite(chunks) || chunks <= 0) return 'anúncio de arquivo inválido (chunks)'
  if (chunks > MAX_CHUNKS) return `arquivo rejeitado: ${chunks} chunks acima do limite de ${MAX_FILE_MB_LABEL}`
  const expected = Math.max(1, Math.ceil(size / CHUNK))
  if (chunks !== expected) return 'arquivo rejeitado: chunks incompatíveis com o tamanho'
  return null
}

export function chunkCountFor(size: number): number {
  return Math.max(1, Math.ceil(size / CHUNK))
}

export function expectedChunkSize(index: number, chunks: number, size: number): number {
  if (index < 0 || index >= chunks) return -1
  return index === chunks - 1 ? size - index * CHUNK : CHUNK
}

export function formatFileSize(size: number): string {
  return formatSize(size)
}

export const FILE_MARKER = '__DISTORRENT_FILE__'
export const FILE_PREFIX = '\u{1F4CE} '

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  heic: 'image/heic',
  ico: 'image/x-icon', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  m4v: 'video/x-m4v', mkv: 'video/x-matroska', ogv: 'video/ogg',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', zip: 'application/zip',
}

export function mimeFor(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return MIME_BY_EXT[ext] ?? 'application/octet-stream'
}

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic)$/i
const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|ogv)$/i

export function isImageName(name: string): boolean {
  return IMAGE_RE.test(name.trim())
}

export function isVideoName(name: string): boolean {
  return VIDEO_RE.test(name.trim())
}

export function isMediaName(name: string): boolean {
  return isImageName(name) || isVideoName(name)
}

/** Cache de prévias: só imagem pequena e vídeo curto ficam no disco. */
export const MEDIA_CACHE_IMAGE_MAX = 7 * 1024 * 1024
export const MEDIA_CACHE_VIDEO_MAX = 250 * 1024 * 1024
export const MEDIA_CACHE_TTL_DAYS = 7

export function mediaCacheLimit(name: string): number {
  if (isImageName(name)) return MEDIA_CACHE_IMAGE_MAX
  if (isVideoName(name)) return MEDIA_CACHE_VIDEO_MAX
  return 0
}

/** Arquivo que vale a pena guardar no cache (imagem ≤7 MB, vídeo ≤250 MB). */
export function shouldCacheMedia(name: string, size: number): boolean {
  const cap = mediaCacheLimit(name)
  return cap > 0 && Number.isFinite(size) && size > 0 && size <= cap
}

/** Bloco em memória só para montar a prévia; acima disso a mídia vai para o spool. */
export function mediaAutoFetchCap(name: string): number {
  if (isVideoName(name)) return 40 * 1024 * 1024
  if (isImageName(name)) return MEDIA_CACHE_IMAGE_MAX
  return 0
}

/** `chunk_hashes` de 2 milhões de blocos estouraria o frame de 1 MB do protocolo. */
export const MAX_ANNOUNCED_CHUNK_HASHES = 4096

export function chunkHashesForAnnounce(count: number): boolean {
  return count > 0 && count <= MAX_ANNOUNCED_CHUNK_HASHES
}

export function spoolKey(file_id: string, index: number): string {
  return `swarm:${file_id}:${index}`
}

export function chunkKey(file_id: string, index: number): string {
  return `${file_id}:${index}`
}

export interface FileMsgMeta {
  file_id: string
  name: string
  size: number
  chunks: number
  hash: string
}

export function seederIsStale(lastSeen: number, now: number, idleMs: number): boolean {
  if (lastSeen <= 0) return false
  return now - lastSeen > idleMs
}

export function swarmProgress(have: number, chunks: number): number {
  if (!Number.isFinite(chunks) || chunks <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((have / chunks) * 100)))
}

export function safeFileName(raw: string): string {
  const base = String(raw ?? '').split(/[\\/]/).pop()?.trim() ?? ''
  const cleaned = Array.from(base).filter((c) => c.charCodeAt(0) > 31).join('').slice(0, 200)
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.startsWith('.')) return ''
  return cleaned
}
