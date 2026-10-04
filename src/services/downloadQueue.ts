// DownloadQueue — lógica PURA da fila de downloads (sem DOM/fileSwarm).
// Estados, transições, progresso e verificação de integridade (blake3).
// O DownloadManager (src/services/downloadManager.ts) aplica isto sobre o
// FileSwarm real; manter a regra aqui permite testar sem rede/DOM.

import { blake3 } from '@noble/hashes/blake3.js'

export type DownloadStatus =
  | 'queued' // na fila (ainda não começou / aguardando vaga)
  | 'downloading' // chunks vindo do swarm
  | 'paused' // pausado pelo usuário (retoma de onde parou)
  | 'verifying' // completo — conferindo hash blake3
  | 'saving' // hash ok — gravando em Downloads (save_file nativo/âncora)
  | 'completed' // salvo e íntegro
  | 'failed' // erro (sem seeder, hash divergente, save falhou)
  | 'cancelled' // cancelado pelo usuário

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
  /** 0..100 */
  progress: number
  /** chunks íntegros em mãos (resume real: reinicia o swarm daqui). */
  have: number
  /** bytes/s suavizados (janela curta) — 0 quando pausado. */
  speedBps: number
  error?: string
  /** caminho salvo (desktop/Android) quando completed. */
  savedPath?: string
  startedAt: number
  updatedAt: number
}

export type DownloadEvent =
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'progress' // chunks chegando (permanece downloading)
  | 'chunks-complete' // swarm fechou o arquivo
  | 'verify-ok'
  | 'verify-fail'
  | 'save-ok'
  | 'save-fail'
  | 'fail'
  | 'retry'

/** Transição pura de status — fontes de verdade das botões da UI. */
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
      // `save-fail`/`fail` TAMBÉM acontecem a partir de `verifying`: o
      // `finalize` marca `verifying` e qualquer erro depois disso (blob OOM,
      // divergência na montagem, falha de `arrayBuffer`) caía num `return
      // status` — o item ficava PRESO em 'verifying' com 100% e sem botão de
      // retry (`canRetry` só aceita 'failed').
      if (ev === 'save-fail' || ev === 'fail') return 'failed'
      if (ev === 'cancel') return 'cancelled'
      return status
    case 'saving':
      if (ev === 'save-ok') return 'completed'
      if (ev === 'save-fail') return 'failed'
      if (ev === 'cancel') return 'cancelled'
      return status
    case 'completed':
      // `completed` e `cancelled` sao terminais. `canRetry` e `canCancel`
      // recusam os dois, entao nenhum evento chega aqui vindo da UI — e
      // qualquer outro evento mantem o status.
      return status
    case 'failed':
      if (ev === 'retry' || ev === 'resume') return 'queued'
      if (ev === 'cancel') return 'cancelled'
      return status
    default:
      return status // completed/cancelled são terminais
  }
}

export function canPause(s: DownloadStatus): boolean { return s === 'downloading' || s === 'queued' }
export function canResume(s: DownloadStatus): boolean { return s === 'paused' || s === 'failed' }
export function canCancel(s: DownloadStatus): boolean { return s !== 'completed' && s !== 'cancelled' }
export function canRetry(s: DownloadStatus): boolean { return s === 'failed' }

/** Progresso 0..100 a partir dos chunks em mãos (total 0 → 0 honesto). */
export function computeProgress(have: number, total: number): number {
  if (!Number.isFinite(have) || !Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((have / total) * 100)))
}

/** blake3 hex (64 chars) — mesmo algoritmo do swarm/fileSwarm. */
export function blake3Hex(bytes: Uint8Array): string {
  const h = blake3(bytes)
  let out = ''
  for (let i = 0; i < h.length; i++) out += h[i].toString(16).padStart(2, '0')
  return out
}

/**
 * Validação de integridade pós-download: recomputa o blake3 do arquivo
 * montado e compara com o hash anunciado. O swarm já verifica POR CHUNK
 * (quando há chunk_hashes); esta é a barreira final do arquivo completo —
 * cobre anúncios legados sem chunk_hashes e montagem.
 */
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

/** Serialização estável para persistir a fila (localStorage) — sem campos voláteis. */
export function serializeQueue(items: DownloadItem[]): string {
  return JSON.stringify(items.map((it) => ({
    id: it.id, file_id: it.file_id, name: it.name, size: it.size, chunks: it.chunks,
    hash: it.hash, status: it.status, progress: it.progress, have: it.have,
    error: it.error ?? null, savedPath: it.savedPath ?? null,
    startedAt: it.startedAt, updatedAt: it.updatedAt,
  })))
}

/** Parse tolerante do que foi persistido (versões antigas/corrompidas → []). */
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

/**
 * Ao carregar a fila do disco, itens "no meio do caminho" voltam a um estado
 * coerente: downloading/saving/verifying → queued (retoma), completed
 * permanece, failed permanece (usuário decide retry).
 */
export function rehydrateStatus(s: DownloadStatus): DownloadStatus {
  if (s === 'downloading' || s === 'saving' || s === 'verifying' || s === 'queued') return 'queued'
  return s
}
