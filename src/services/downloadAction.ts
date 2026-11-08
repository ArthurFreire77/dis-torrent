import { fileSwarm, type FileMsgMeta } from './fileSwarm'
import { downloadManager } from './downloadManager'
import { decideDownloadAction, type DownloadActionKind } from './downloadActionRules'
import { services } from './index'
import { LARGE_DOWNLOAD_BYTES, requestDownloadDir } from './downloadDirPrompt'

export type { DownloadActionKind }

/**
 * Arquivo grande escolhe a pasta ANTES de baixar: 1 GB no disco do sistema sem
 * o usuário saber é surpresa ruim, e o `Download` padrão pode estar sem espaço.
 * Cancelar no modal não baixa nada (honesto em vez de salvar escondido).
 */
async function confirmLargeDestination(meta: FileMsgMeta): Promise<boolean> {
  if (services.kind !== 'native') return true
  if (!Number.isFinite(meta.size) || meta.size < LARGE_DOWNLOAD_BYTES) return true
  try {
    const atual = await services.downloadDirGet()
    let livre = 0
    try { livre = (await services.downloadDirSpace(atual.dir)).free_bytes } catch { livre = 0 }
    const escolhida = await requestDownloadDir({
      name: meta.name,
      size: meta.size,
      dir: atual.dir,
      freeBytes: livre,
    })
    if (escolhida === null) return false
    if (escolhida !== atual.dir) await services.downloadDirSet(escolhida)
    return true
  } catch {
    // Falha ao perguntar não pode virar download sem confirmação: o usuário
    // ainda pode mandar baixar de novo pela pasta padrão.
    return true
  }
}

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
  const primeiraVez = !queued || queued.status === 'cancelled'
  if (primeiraVez && !(await confirmLargeDestination(meta))) {
    throw new Error('download cancelado — escolha uma pasta para continuar')
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
