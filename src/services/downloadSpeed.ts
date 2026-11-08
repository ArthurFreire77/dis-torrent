/**
 * Teto de velocidade do download, em MB/s. 0 = sem teto de usuário (os limites
 * de segurança do core continuam valendo: um peer não pode saturar a máquina).
 *
 * Esta é a "alavanca única" da velocidade: ela controla quantos pedidos ficam
 * em voo e quanto se espera entre lotes. Aplicar de novo no core (rate limit)
 * contaria duas vezes e deixaria a barra em 5% do que o usuário escolheu.
 */
export const SPEED_PRESETS = [0, 5, 10, 20, 50, 100] as const
export type SpeedPreset = (typeof SPEED_PRESETS)[number]

const LS_KEY = 'distorrent:downloads:max_mbps'

export function getDownloadSpeedLimit(): number {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (raw === null) return 0
    const n = Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function setDownloadSpeedLimit(mbps: number): number {
  const v = Number.isFinite(mbps) && mbps > 0 ? Math.min(1000, Math.round(mbps)) : 0
  try { localStorage.setItem(LS_KEY, String(v)) } catch {  }
  return v
}

/**
 * Quantos blocos de 256 KiB podem ficar em voo para caber no teto.
 *
 * RTT típico de 40 ms: sem teto usamos o paralelismo máximo; com teto,
 * `MB/s × 1024 / 256 × RTT` blocos já enchem a janela. Piso de 4 para não
 * transformar 1 MB/s em 1 bloco por vez (latência dominaria).
 */
export function inFlightForLimit(mbps: number, rttMs = 40): number {
  if (mbps <= 0) return 64
  const blocosPorSegundo = (mbps * 1024) / 256
  const janela = (blocosPorSegundo * Math.max(10, rttMs)) / 1000
  return Math.max(4, Math.min(64, Math.ceil(janela)))
}

/** Pausa entre lotes para respeitar o teto (0 quando não há teto). */
export function batchDelayMs(mbps: number, blocosNoLote: number, chunkBytes = 256 * 1024): number {
  if (mbps <= 0 || blocosNoLote <= 0) return 0
  const bytes = blocosNoLote * chunkBytes
  const bytesPorSegundo = mbps * 1024 * 1024
  return Math.min(500, Math.max(0, Math.round((bytes / bytesPorSegundo) * 1000)))
}

export function labelForLimit(mbps: number): string {
  if (mbps <= 0) return 'sem teto (usa a rede inteira)'
  return `${mbps} MB/s`
}
