import type { DownloadStatus } from './downloadQueue.ts'

export type DownloadActionKind =
  | 'no-announce'
  | 'resaved'
  | 'resumed'
  | 'retried'
  | 'enqueued'

export function decideDownloadAction(
  complete: boolean,
  status: DownloadStatus | undefined,
): DownloadActionKind {
  if (status === 'paused') return 'resumed'
  if (status === 'failed') return 'retried'
  if (status === 'completed') return 'resaved'
  if (complete) return 'enqueued'
  return 'enqueued'
}

export function canDownload(announced: boolean): boolean {
  return announced
}
