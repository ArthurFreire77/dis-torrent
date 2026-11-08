export interface FileCardProgress {
  pct: number
  speed: number
  status: string
  error?: string
}

const SPEED_UNITS = ['B/s', 'KB/s', 'MB/s'] as const

/** Azul = ainda não começou, amarelo = em andamento, verde = baixado, vermelho = falhou. */
export type DownloadTone = 'idle' | 'busy' | 'done' | 'failed'

export interface DownloadButtonState {
  label: string
  tone: DownloadTone
  icon: 'download' | 'refresh' | 'check' | 'play'
  spinning: boolean
  clickable: boolean
  /** Verde só aparece depois de concluir; o re-download é o botão vermelho. */
  showRedownload: boolean
}

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

export function downloadButtonState(
  has: boolean,
  done: boolean,
  prog: FileCardProgress | undefined,
): DownloadButtonState {
  if (!has) {
    return { label: 'Baixar', tone: 'idle', icon: 'download', spinning: false, clickable: false, showRedownload: false }
  }
  if (done || prog?.status === 'completed') {
    return { label: 'Baixado', tone: 'done', icon: 'check', spinning: false, clickable: false, showRedownload: true }
  }
  if (prog?.status === 'failed') {
    return { label: 'Tentar de novo', tone: 'failed', icon: 'refresh', spinning: false, clickable: true, showRedownload: false }
  }
  if (prog?.status === 'paused') {
    return { label: 'Retomar', tone: 'busy', icon: 'play', spinning: false, clickable: true, showRedownload: false }
  }
  if (prog?.status === 'verifying') {
    return { label: 'Conferindo…', tone: 'busy', icon: 'refresh', spinning: true, clickable: false, showRedownload: false }
  }
  if (prog?.status === 'saving') {
    return { label: 'Salvando…', tone: 'busy', icon: 'refresh', spinning: true, clickable: false, showRedownload: false }
  }
  if (prog?.status === 'downloading') {
    const pct = prog.pct ?? 0
    return {
      label: pct > 0 ? `Baixando ${pct}%` : 'Baixando…',
      tone: 'busy',
      icon: 'refresh',
      spinning: true,
      clickable: false,
      showRedownload: false,
    }
  }
  if (prog?.status === 'queued') {
    return { label: 'Na fila…', tone: 'busy', icon: 'refresh', spinning: true, clickable: false, showRedownload: false }
  }
  return { label: 'Baixar', tone: 'idle', icon: 'download', spinning: false, clickable: true, showRedownload: false }
}

export function downloadButtonLabel(
  has: boolean,
  done: boolean,
  prog: FileCardProgress | undefined,
  hasPreview = false,
): string {
  if (done && hasPreview) return 'Salvar'
  return downloadButtonState(has, done, prog).label
}
