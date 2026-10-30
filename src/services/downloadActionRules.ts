// REGRA PURA do que o botão "Baixar" faz.
//
// Separada de `downloadAction.ts` (que fala com o swarm e a fila) para poder
// rodar no `node --test`: esta é a decisão que divergia entre PC e celular —
// o PC salvava direto, sem a verificação de integridade que a fila faz.

import type { DownloadStatus } from './downloadQueue.ts'

export type DownloadActionKind =
  /** Anúncio ainda não chegou: não há o que baixar. */
  | 'no-announce'
  /** Arquivo completo e já salvo: gravar OUTRA cópia em Downloads. */
  | 'resaved'
  /** Havia download pausado: retomar de onde parou. */
  | 'resumed'
  /** Havia falha: tentar de novo (botão explícito do usuário). */
  | 'retried'
  /** Entrar na fila (download novo OU arquivo completo ainda não salvo). */
  | 'enqueued'

/**
 * Decide a ação do botão a partir do estado REAL.
 *
 * - `complete` vem do bitfield do swarm (temos todos os blocos);
 * - `status` é o status na fila do `downloadManager` (undefined = não está nela).
 *
 * Regra que NÃO pode mudar: arquivo completo mas NUNCA SALVO passa por
 * `enqueued` (a fila), não por "salvar direto". É o que garante a verificação
 * blake3 antes de escrever em Downloads — o caminho que o desktop pulava.
 */
export function decideDownloadAction(
  complete: boolean,
  status: DownloadStatus | undefined,
): DownloadActionKind {
  if (status === 'paused') return 'resumed'
  if (status === 'failed') return 'retried'
  // Já salvado pela fila: um segundo enqueue não roda o ciclo de novo; o
  // usuário está pedindo outra cópia.
  if (status === 'completed') return 'resaved'
  // Sem status mas com o arquivo completo: pode ser um save que nunca passou
  // pela fila (ex.: semeado por você). Vai pela fila para ser verificado.
  if (complete) return 'enqueued'
  return 'enqueued'
}

/**
 * O anúncio chegou? Sem ele o botão fica desabilitado e o card diz por quê —
 * é a diferença entre "ainda não dá" e "não funcionou".
 */
export function canDownload(announced: boolean): boolean {
  return announced
}
