// Regras PURAS do cartão de arquivo (sem React).
//
// Separadas de `FileCard.tsx` de propósito: o runner de unit roda em Node e não
// carrega `.tsx`. Estas são justamente as decisões que já erraram na UI —
// botão dizendo "Baixar" com download ativo, "0 KB/s" fingindo velocidade,
// "Baixar (43%)" congelado ao pausar — então precisam de teste de verdade.

export interface FileCardProgress {
  /** 0..100 */
  pct: number
  /** bytes/s (0 = parado/pausado). */
  speed: number
  /** Status REAL da fila (`downloading`, `paused`, `failed`, ...). */
  status: string
  error?: string
}

const SPEED_UNITS = ['B/s', 'KB/s', 'MB/s'] as const

/** Bytes por segundo legível. 0 → 'parado' (honesto: não inventa número). */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return 'parado'
  let v = bps
  let i = 0
  while (v >= 1024 && i < SPEED_UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${SPEED_UNITS[i]}`
}

/**
 * Texto do botão, derivado do estado REAL.
 *
 * `has` = o anúncio já chegou (o arquivo é alcançável). `done` = o arquivo
 * está completo localmente. `hasPreview` = a mídia já foi buscada só para
 * exibir — nesse caso "Salvar" é o que o usuário espera (ele já vê a foto).
 */
export function downloadButtonLabel(
  has: boolean,
  done: boolean,
  prog: FileCardProgress | undefined,
  hasPreview: boolean,
): string {
  if (!has) return 'Baixar'
  if (done) return hasPreview ? 'Salvar' : 'Baixar de novo'
  if (prog?.status === 'paused') return 'Retomar'
  if (prog?.status === 'failed') return 'Tentar de novo'
  const pct = prog?.pct ?? 0
  return pct > 0 ? `Baixando ${pct}%` : 'Baixar'
}
