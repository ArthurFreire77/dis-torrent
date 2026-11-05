export const JANELA_COMPAT = 5

export function distanciaEntreVersoes(a: string, b: string): number {
  const pa = parse(a)
  const pb = parse(b)
  if (!pa || !pb) return Number.POSITIVE_INFINITY
  if (pa.major !== pb.major || pa.minor !== pb.minor) {
    return Math.abs(pa.major - pb.major) * 1000 + Math.abs(pa.minor - pb.minor) * 100
  }
  return Math.abs(pa.patch - pb.patch)
}

interface Versao {
  major: number
  minor: number
  patch: number
}

function parse(raw: string): Versao | null {
  const s = String(raw ?? '').trim().replace(/^v/i, '')
  const core = s.split('-')[0] ?? ''
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(core)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
}

export function versoesCompativeis(minha: string, dele: string): boolean {
  const d = distanciaEntreVersoes(minha, dele)
  if (!Number.isFinite(d)) return true
  return d <= JANELA_COMPAT
}

export function avisoForaDaJanela(minha: string, dele: string): string | null {
  if (versoesCompativeis(minha, dele)) return null
  return `as versões estão muito distantes (a sua ${minha || '?'} e a dele ${dele || '?'}); `
    + `atualize os dois lados para conversar — até ${JANELA_COMPAT} versões de diferença funciona`
}

export const RECURSO_MIN_VERSAO = {
  voiceVideoFrame: '1.1.40',
  voiceStats: '1.1.40',
  reciboLeitura: '1.1.30',
} as const

export type RecursoGated = keyof typeof RECURSO_MIN_VERSAO

export function podeUsarRecurso(recurso: RecursoGated, dele: string): boolean {
  const min = RECURSO_MIN_VERSAO[recurso]
  if (!dele) return false
  const d = parse(dele)
  const m = parse(min)
  if (!d || !m) return false
  if (d.major !== m.major) return d.major > m.major
  if (d.minor !== m.minor) return d.minor > m.minor
  return d.patch >= m.patch
}
