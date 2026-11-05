import { fileSwarm, type FileMsgMeta } from './fileSwarm'
import { downloadManager } from './downloadManager'
import { decideDownloadAction, type DownloadActionKind } from './downloadActionRules'

export type { DownloadActionKind }

export async function startDownload(meta: FileMsgMeta): Promise<DownloadActionKind> {
  const sf = fileSwarm.files.get(meta.file_id)
  const queued = downloadManager.get(meta.file_id)
  const complete = !!sf && sf.chunks > 0 && sf.have.size >= sf.chunks
  const kind = decideDownloadAction(complete, queued?.status)
  if (kind === 'no-announce') {
    throw new Error('o anúncio deste arquivo ainda não chegou — aguarde uns segundos')
  }
  if (kind === 'resumed') {
    downloadManager.resume(meta.file_id)
    return kind
  }
  if (kind === 'retried') {
    downloadManager.retry(meta.file_id)
    return kind
  }
  if (kind === 'resaved') {
    if (sf) await fileSwarm.download(sf)
    return kind
  }
  downloadManager.enqueue({
    file_id: meta.file_id,
    name: meta.name,
    size: meta.size,
    chunks: meta.chunks,
    hash: meta.hash,
  })
  return kind
}
