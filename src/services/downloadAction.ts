// AÇÃO DE BAIXAR — uma implementação para os DOIS shells.
//
// Antes cada shell decidia sozinho o que "Baixar" faz, e eles divergiam:
//
//   • celular: sempre `downloadManager.enqueue` → a fila verifica o blake3 do
//     arquivo montado ANTES de gravar, avisa no painel e dispara o toast;
//   • PC: com o arquivo já completo chamava `fileSwarm.download()` direto —
//     gravava em Downloads SEM a verificação de integridade, sem toast e sem
//     notificação. O mesmo botão, comportamentos diferentes (e o do PC era o
//     inseguro: um chunk corrompido ia para o disco).
//
// Aqui a regra é única: passar SEMPRE pela fila, que é quem sabe verificar,
// salvar e avisar. A única exceção é "salvar de novo" um arquivo que a fila
// já deu como concluído (a fila guarda esse estado para as ações do usuário e
// não roda o ciclo outra vez).
//
// Importa `services`/`fileSwarm`/`downloadManager` (runtime real), então NÃO
// roda no `node --test` — o que é puro (a decisão) fica em
// `downloadActionRules.ts`.

import { fileSwarm, type FileMsgMeta } from './fileSwarm'
import { downloadManager } from './downloadManager'
import { decideDownloadAction, type DownloadActionKind } from './downloadActionRules'

export type { DownloadActionKind }

/**
 * Executa a ação de baixar/salvar de um arquivo do swarm.
 *
 * Lança quando não há anúncio (o card precisa dizer isso) ou quando a gravação
 * falha; o chamador mostra a mensagem.
 */
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
    // A fila já marcou "concluído": um segundo `enqueue` não faria nada. Aqui o
    // usuário quer OUTRA cópia em Downloads, com nome único (`foto (1).png`).
    if (sf) await fileSwarm.download(sf)
    return kind
  }
  // `enqueued`: cobre tanto o download novo quanto o arquivo que já está
  // completo no swarm mas nunca foi salvo — a fila verifica o hash, grava e
  // avisa. Este era o caminho que o PC pulava.
  downloadManager.enqueue({
    file_id: meta.file_id,
    name: meta.name,
    size: meta.size,
    chunks: meta.chunks,
    hash: meta.hash,
  })
  return kind
}
