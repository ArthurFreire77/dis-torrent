// callRepair — QUEM assume a negociação de um par que não tem conexão (puro).
//
// POR QUE EXISTE: quem oferece era sempre o lado de fingerprint MAIOR; o menor
// esperava a offer do outro. Numa entrada em sala em andamento ("Entrar") essa
// offer pode se perder no caminho (frame perdido, link meio-aberto, peer que
// acabou de acordar). Aí o menor esperava para sempre: a chamada ficava em
// "Conectando…" com as duas pessoas na sala, e só sair/entrar de novo
// resolvia.
//
// A regra: o MAIOR continua sendo o primeiro a oferecer; o MENOR só assume a
// iniciativa depois de um orçamento sem par nenhum. Se os dois oferecerem
// juntos, o glare é resolvido pelo polite/impolite (`handleOffer`), então isto
// não cria negociação dupla.

/** Orçamento do lado menor esperando a offer do outro. */
export const PAIR_WAIT_BUDGET_MS = 8_000

export interface PairInitiativeInput {
  /** Meu fingerprint (vazio = ainda sem identidade: ninguém oferece). */
  myFp: string
  peerFp: string
  /** Já existe RTCPeerConnection para o par? */
  hasPair: boolean
  /** Desde quando espero sem par (0/undefined = começo a contar agora). */
  waitingSinceMs?: number
  nowMs: number
  waitBudgetMs?: number
}

/**
 * `true` = criar o par e mandar offer agora.
 * `false` = este lado só observa (o outro oferece).
 */
export function shouldInitiatePair(input: PairInitiativeInput): boolean {
  if (!input.myFp || !input.peerFp || input.myFp === input.peerFp) return false
  // Já há par: quem cuida dele é o orçamento de "par travado", não esta regra.
  if (input.hasPair) return false
  // Lado MAIOR é o primeiro da fila (regra determinística, anti-glare).
  if (input.myFp > input.peerFp) return true
  const desde = input.waitingSinceMs ?? 0
  if (!desde) return false
  return input.nowMs - desde >= (input.waitBudgetMs ?? PAIR_WAIT_BUDGET_MS)
}
