export interface FileCardProgress {
  pct: number
  speed: number
  status: string
  error?: string
}

const SPEED_UNITS = ['B/s', 'KB/s', 'MB/s'] as const

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
