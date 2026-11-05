import { blake3 } from '@noble/hashes/blake3.js'

export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface DownloadMeta {
  file_id: string
  name: string
  size: number
  chunks: number
  hash: string
}

export interface DownloadItem extends DownloadMeta {
  id: string
  status: DownloadStatus
  progress: number
  have: number
  speedBps: number
  error?: string
  savedPath?: string
  startedAt: number
  updatedAt: number
}

export type DownloadEvent =
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'progress'
  | 'chunks-complete'
  | 'verify-ok'
  | 'verify-fail'
  | 'save-ok'
  | 'save-fail'
  | 'fail'
  | 'retry'

export function nextDownloadStatus(status: DownloadStatus, ev: DownloadEvent): DownloadStatus {
  switch (status) {
    case 'queued':
      if (ev === 'start') return 'downloading'
      if (ev === 'cancel') return 'cancelled'
      return status
    case 'downloading':
      if (ev === 'pause') return 'paused'
      if (ev === 'cancel') return 'cancelled'
      if (ev === 'progress') return 'downloading'
      if (ev === 'chunks-complete') return 'verifying'
      if (ev === 'fail') return 'failed'
      return status
    case 'paused':
      if (ev === 'resume' || ev === 'start') return 'downloading'
      if (ev === 'cancel') return 'cancelled'
      return status
    case 'verifying':
      if (ev === 'verify-ok') return 'saving'
      if (ev === 'verify-fail') return 'failed'
      if (ev === 'save-fail' || ev === 'fail') return 'failed'
      if (ev === 'cancel') return 'cancelled'
      return status
    case 'saving':
      if (ev === 'save-ok') return 'completed'
      if (ev === 'save-fail') return 'failed'
      if (ev === 'cancel') return 'cancelled'
      return status
    case 'completed':
      return status
    case 'failed':
      if (ev === 'retry' || ev === 'resume') return 'queued'
      if (ev === 'cancel') return 'cancelled'
      return status
    default:
      return status
  }
}

export function canPause(s: DownloadStatus): boolean { return s === 'downloading' || s === 'queued' }
export function canResume(s: DownloadStatus): boolean { return s === 'paused' || s === 'failed' }
export function canCancel(s: DownloadStatus): boolean { return s !== 'completed' && s !== 'cancelled' }
export function canRetry(s: DownloadStatus): boolean { return s === 'failed' }

export function computeProgress(have: number, total: number): number {
  if (!Number.isFinite(have) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((have / total) * 100)))
}

export function blake3Hex(bytes: Uint8Array): string {
  const h = blake3(bytes)
  let out = ''
  for (let i = 0; i < h.length; i++) out += h[i].toString(16).padStart(2, '0')
  return out
}

export function verifyFileIntegrity(bytes: Uint8Array, announcedHash: string): boolean {
  try {
    const announced = (announcedHash ?? '').trim().toLowerCase()
    if (!announced) return false
    const got = blake3Hex(bytes).slice(0, announced.length)
    return got === announced
  } catch {
    return false
  }
}

export function serializeQueue(items: DownloadItem[]): string {
  return JSON.stringify(items.map((it) => ({
    id: it.id, file_id: it.file_id, name: it.name, size: it.size, chunks: it.chunks,
    hash: it.hash, status: it.status, progress: it.progress, have: it.have,
    error: it.error ?? null, savedPath: it.savedPath ?? null,
    startedAt: it.startedAt, updatedAt: it.updatedAt,
  })))
}

export function deserializeQueue(raw: string | null): DownloadItem[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: DownloadItem[] = []
    for (const it of parsed) {
      if (!it || typeof it.file_id !== 'string' || typeof it.name !== 'string') continue
      out.push({
        id: typeof it.id === 'string' ? it.id : it.file_id,
        file_id: it.file_id,
        name: it.name,
        size: Number(it.size ?? 0),
        chunks: Number(it.chunks ?? 0),
        hash: String(it.hash ?? ''),
        status: (VALID_STATUSES as readonly string[]).includes(it.status) ? it.status : 'queued',
        progress: Number(it.progress ?? 0),
        have: Number(it.have ?? 0),
        speedBps: 0,
        error: typeof it.error === 'string' ? it.error : undefined,
        savedPath: typeof it.savedPath === 'string' ? it.savedPath : undefined,
        startedAt: Number(it.startedAt ?? Date.now()),
        updatedAt: Number(it.updatedAt ?? Date.now()),
      })
    }
    return out
  } catch {
    return []
  }
}

const VALID_STATUSES = [
  'queued', 'downloading', 'paused', 'verifying', 'saving', 'completed', 'failed', 'cancelled',
] as const

export function rehydrateStatus(s: DownloadStatus): DownloadStatus {
  if (s === 'downloading' || s === 'saving' || s === 'verifying' || s === 'queued') return 'queued'
  return s
}
