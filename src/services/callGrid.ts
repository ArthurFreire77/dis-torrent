export const CARD_MIN_WIDTH_PX = 300
export const CARD_MIN_HEIGHT_PX = 180
export const MAX_COLS = 4

export function colunasQueCabem(total: number, larguraPx = 0, gap = 12, padding = 12): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  if (n <= 0) return 1
  if (n === 1) return 1
  const largura = Number.isFinite(larguraPx) ? larguraPx : 0
  if (largura <= 0) return Math.min(MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(n))))

  const util = largura - padding * 2
  const cabem = Math.floor((util + gap) / (CARD_MIN_WIDTH_PX + gap))
  const cols = Math.max(1, Math.min(MAX_COLS, cabem, n))
  return cols
}

export function linhasNecessarias(total: number, cols: number): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  const c = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 1
  return Math.ceil(n / c)
}

export function precisaRolar(total: number, cols: number, alturaPx: number, gap = 12): boolean {
  const linhas = linhasNecessarias(total, cols)
  if (linhas <= 1) return false
  const h = Number.isFinite(alturaPx) ? alturaPx : 0
  if (h <= 0) return false
  const necessario = linhas * CARD_MIN_HEIGHT_PX + (linhas - 1) * gap
  return necessario > h
}
