export interface VoiceRow {
  fp: string
  muted: boolean
  deafened: boolean
}

export interface PresencaFiltro {
  myFp: string
  onlineFps: ReadonlySet<string>
  filtrar?: boolean
}

export function filterLiveVoiceRows(rows: VoiceRow[], filtro: PresencaFiltro): VoiceRow[] {
  if (!Array.isArray(rows) || rows.length === 0) return []
  if (filtro.filtrar === false) return rows.slice()
  const meu = filtro.myFp ?? ''
  return rows.filter((r) => {
    if (!r?.fp) return false
    if (meu && r.fp === meu) return true
    return filtro.onlineFps.has(r.fp)
  })
}

export function temAlguemVivo(rows: VoiceRow[], myFp: string, onlineFps: ReadonlySet<string>): boolean {
  return rows.some((r) => !!r.fp && (r.fp === myFp || onlineFps.has(r.fp)))
}

export function contarNaChamada(rows: VoiceRow[], filtro: PresencaFiltro): number {
  return filterLiveVoiceRows(rows, filtro).length
}
