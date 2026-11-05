export const PAIR_WAIT_BUDGET_MS = 8_000

export interface PairInitiativeInput {
  myFp: string
  peerFp: string
  hasPair: boolean
  waitingSinceMs?: number
  nowMs: number
  waitBudgetMs?: number
}

export function shouldInitiatePair(input: PairInitiativeInput): boolean {
  if (!input.myFp || !input.peerFp || input.myFp === input.peerFp) return false
  if (input.hasPair) return false
  if (input.myFp > input.peerFp) return true
  const desde = input.waitingSinceMs ?? 0
  if (!desde) return false
  return input.nowMs - desde >= (input.waitBudgetMs ?? PAIR_WAIT_BUDGET_MS)
}
