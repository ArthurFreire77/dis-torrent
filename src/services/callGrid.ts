// callGrid — quantas colunas o palco da chamada usa (regra PURA).
//
// POR QUE EXISTE: a grade usava `ceil(sqrt(n))`, que olha só a QUANTIDADE de
// pessoas e ignora o tamanho da janela. Efeitos reais (print do dono):
//   - 2 pessoas num monitor largo → 2 colunas enormes, cada card com um avatar
//     minúsculo no meio de um retângulo vazio;
//   - 6 pessoas numa janela estreita → 3 colunas apertadas, cards ilegíveis;
//   - numa chamada de servidor com muita gente o card encolhia até não dar
//     para reconhecer quem é.
//
// A regra certa é a mesma de qualquer videochamada: existe um tamanho MÍNIMO
// confortável por card; as colunas são as que cabem nesse mínimo, limitadas
// pelo número de pessoas. O card nunca fica menor que o mínimo — se não couber,
// a grade rola em vez de esmagar.

/** Largura confortável mínima de um card de pessoa (px). */
export const CARD_MIN_WIDTH_PX = 300
/** Altura confortável mínima (16:9 do mínimo de largura, arredondado). */
export const CARD_MIN_HEIGHT_PX = 180
/** Teto de colunas: mais que isto o card vira selo. */
export const MAX_COLS = 4

/**
 * Colunas para `total` cards numa área de `larguraPx`.
 *
 * - `larguraPx` desconhecida (0/NaN — SSR, primeiro paint) cai no formato
 *   quadrado por raiz, que era o comportamento antigo e é um bom palpite.
 * - Nunca devolve 0: uma coluna no mínimo.
 */
export function colunasQueCabem(total: number, larguraPx = 0, gap = 12, padding = 12): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  if (n <= 0) return 1
  if (n === 1) return 1
  const largura = Number.isFinite(larguraPx) ? larguraPx : 0
  if (largura <= 0) return Math.min(MAX_COLS, Math.max(1, Math.ceil(Math.sqrt(n))))

  const util = largura - padding * 2
  // Quantas colunas de CARD_MIN_WIDTH_PX cabem (cada uma com um gap entre).
  const cabem = Math.floor((util + gap) / (CARD_MIN_WIDTH_PX + gap))
  const cols = Math.max(1, Math.min(MAX_COLS, cabem, n))
  return cols
}

/**
 * Linhas necessárias para `total` em `cols` colunas.
 *
 * A UI usa para decidir se precisa rolar (muitos participantes) e para não
 * tentar comprimir tudo numa tela só.
 */
export function linhasNecessarias(total: number, cols: number): number {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  const c = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 1
  return Math.ceil(n / c)
}

/**
 * `true` quando a grade não cabe na altura e precisa rolar.
 *
 * Evita o efeito de "esmagar todo mundo": com 12 pessoas e 3 linhas, o certo é
 * rolar, não encolher cada card até virar um selo.
 */
export function precisaRolar(total: number, cols: number, alturaPx: number, gap = 12): boolean {
  const linhas = linhasNecessarias(total, cols)
  if (linhas <= 1) return false
  const h = Number.isFinite(alturaPx) ? alturaPx : 0
  if (h <= 0) return false
  const necessario = linhas * CARD_MIN_HEIGHT_PX + (linhas - 1) * gap
  return necessario > h
}
