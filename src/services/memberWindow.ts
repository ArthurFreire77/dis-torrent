export const LIMITE_MEMBROS = 200

export interface MemberWindow<T> {
  visiveis: T[]
  restantes: number
  total: number
}

export function windowMembers<T>(
  lista: readonly T[] | null | undefined,
  limite: number = LIMITE_MEMBROS,
  preferirPrimeiro?: (item: T) => boolean,
): MemberWindow<T> {
  const arr = Array.isArray(lista) ? lista : []
  const total = arr.length
  const teto = Number.isFinite(limite) && limite > 0 ? Math.floor(limite) : LIMITE_MEMBROS
  if (total <= teto) return { visiveis: arr.slice(), restantes: 0, total }

  if (!preferirPrimeiro) {
    return { visiveis: arr.slice(0, teto), restantes: total - teto, total }
  }

  const preferidos: T[] = []
  const outros: T[] = []
  for (const item of arr) {
    if (preferirPrimeiro(item)) {
      if (preferidos.length < teto) preferidos.push(item)
    } else if (outros.length < teto) {
      outros.push(item)
    }
  }
  const visiveis = [...preferidos, ...outros.slice(0, Math.max(0, teto - preferidos.length))]
  return { visiveis, restantes: Math.max(0, total - visiveis.length), total }
}

export function memberWindowLabel(w: MemberWindow<unknown>): string | null {
  if (!w || w.restantes <= 0) return null
  const fmt = (n: number) => n.toLocaleString('pt-BR')
  return `mostrando ${fmt(w.visiveis.length)} de ${fmt(w.total)} — use a busca para achar alguém`
}
