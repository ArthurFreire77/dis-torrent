// memberWindow — quantos membros uma lista de servidor pode PROCESSAR.
//
// ## O problema real (relato do dono)
//
// "um cara do server com 300 mil pessoas não entra; não deve aparecer ninguém
// caralho, imagina aparecer 300 mil pessoas nessa tela — isso vale para todo
// server."
//
// O painel de membros fazia `members.filter(...)` em TODOS os membros e só
// DEPOIS aplicava `maxVisible` na renderização. Filtrar 300 mil é rápido; o que
// travava era o que vinha antes disso: `activeComm.members` chega inteiro no
// estado do React e cada `memberRow` monta um `<Avatar>` (um `<img>`/`<span>`
// por pessoa). Com 300 mil o app congela no render e a chamada nem abre.
//
// A regra aqui é o corte na ORIGEM: nenhuma tela monta mais que `LIMITE` linhas
// por vez, e o resto é representado por um contador. É a mesma decisão para
// desktop e celular.

/**
 * Teto de linhas de membro renderizadas de uma vez.
 *
 * 200 é folgado para uso real (o Discord também pagina) e pequeno o bastante
 * para o React montar num frame: acima disso o painel rola e mostra "+N".
 */
export const LIMITE_MEMBROS = 200

export interface MemberWindow<T> {
  /** Só o que vai ser renderizado (nunca mais que `LIMITE_MEMBROS`). */
  visiveis: T[]
  /** Quantos ficaram de fora (0 = lista inteira cabe). */
  restantes: number
  /** Total na entrada (para o cabeçalho dizer o número honesto). */
  total: number
}

/**
 * Corta a lista ANTES de qualquer map/filter custoso.
 *
 * `preferirPrimeiro` (opcional) permite priorizar quem importa — no painel de
 * membros é a própria pessoa e quem está online, para não sumirem num servidor
 * gigante.
 */
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

  // Duas listas, ambas limitadas ao teto: a primeira pega só os preferidos
  // (eu, quem está online), a segunda completa com o resto. SEM `break`: num
  // servidor de 300 mil os preferidos podem estar no fim da lista, e parar
  // cedo faria "eu" sumir — que é justamente o que não pode acontecer.
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

/** Texto do rodapé: "mostrando 200 de 300.000 — refine a busca". */
export function memberWindowLabel(w: MemberWindow<unknown>): string | null {
  if (!w || w.restantes <= 0) return null
  const fmt = (n: number) => n.toLocaleString('pt-BR')
  return `mostrando ${fmt(w.visiveis.length)} de ${fmt(w.total)} — use a busca para achar alguém`
}
