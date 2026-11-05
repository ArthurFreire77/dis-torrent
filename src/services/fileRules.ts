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
  return Number.isFinite(n) && n > 0 ? n : 51200
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
export function mediaAutoFetchCap(name: string): number {
  return isVideoName(name) ? 40 * 1024 * 1024 : 12 * 1024 * 1024
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
