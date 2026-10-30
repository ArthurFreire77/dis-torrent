// Espera assíncrona mínima — fonte ÚNICA.
//
// `fileSwarm.ts` e `downloadManager.ts` tinham cada um o seu `sleep`. Era a
// mesma linha duplicada, mas o custo real apareceu no dia em que um dos dois
// precisou de cancelamento: o outro continuou com `setTimeout` puro e o
// download ficou 5 s preso depois de o usuário cancelar. Centralizar aqui deixa
// claro que nenhum dos dois tem cancelamento — e onde implementá-lo se preciso.

/** Espera `ms` milissegundos. Não cancela: para isso, veja `sleepAbortable`. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Espera que aborta cedo quando o `signal` dispara.
 *
 * `resolve()` (não `reject`) de propósito: todo laço de rede do projeto trata
 * "acordou" como "cheque o estado de novo", e uma rejeição viraria erro de
 * download no painel do usuário por causa de um cancelamento pedido por ele.
 */
export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const id = setTimeout(finish, ms)
    function finish() {
      clearTimeout(id)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}
