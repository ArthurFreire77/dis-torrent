// Canais de um servidor — FONTE ÚNICA DE VERDADE.
// O bug: a UI juntava `communities_list` (resumo) com `channel_list` (completo)
// com merges manuais diferentes — um sem filtro duplicava canais. Aqui existe
// UM lugar que decide qual lista vale e deduplica por id e nome normalizado.

import type { ChannelMeta } from '../services/models'

/** Normaliza um nome de canal para comparação (minúsculas, sem acento, hífen). */
function norm(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Une a lista resumida (`CommunityView.channels`) com a completa (`channel_list`)
 * sem duplicatas: a completa vence, dedupe por id e por nome normalizado,
 * ordem por position → nome → id.
 */
export function mergeChannels(
  summary: readonly (readonly [string, string])[] | undefined,
  full: readonly ChannelMeta[] | undefined,
): ChannelMeta[] {
  const byId = new Map<string, ChannelMeta>()

  // 1) base: resumida primeiro (preserva a ordem quando a completa não traz o canal)
  const summaryList = summary ?? []
  summaryList.forEach((entry, idx) => {
    const [id, name] = entry
    if (!id || !name) return
    byId.set(id, {
      id,
      name,
      topic: '',
      category: 'CANAIS DE TEXTO',
      position: idx,
      kind: 'text',
    })
  })

  // 2) a completa sobrepõe a resumida (tipo/categoria/tópico/posição).
  for (const c of full ?? []) {
    if (!c?.id || !c?.name) continue
    byId.set(c.id, c)
  }

  // 3) dedup por nome normalizado: sobrevivente por `betterSurvivor` (não pela
  //    ordem de entrada — senão a sidebar mudava entre renders).
  const byName = new Map<string, ChannelMeta>()
  for (const c of byId.values()) {
    const key = norm(c.name)
    if (!key) continue
    const atual = byName.get(key)
    if (!atual) {
      byName.set(key, c)
      continue
    }
    if (betterSurvivor(c, atual)) byName.set(key, c)
  }

  // 4) ordenação estável (item 5).
  const out = [...byName.values()]
  out.sort(compareChannels)
  return out
}

/**
 * Escolhe o sobrevivente entre homônimos: metadados reais vencem o resumo;
 * empate → id menor (determinístico).
 */
function betterSurvivor(a: ChannelMeta, b: ChannelMeta): boolean {
  const aFull = isFullRow(a)
  const bFull = isFullRow(b)
  if (aFull !== bFull) return aFull
  return a.id < b.id
}

/** Linha veio de `channel_list` (tem metadados) vs. do resumo da comunidade. */
function isFullRow(c: ChannelMeta): boolean {
  return Boolean(c.topic) || c.kind !== 'text' || Boolean(c.category && c.category !== 'CANAIS DE TEXTO')
}

/**
 * Ordem total: posição, nome normalizado, id. O id no desempate final é
 * obrigatório (`localeCompare` dá 0 para 'ALFA' vs 'alfa' — sem ele a posição
 * na sidebar "saltava" entre renders).
 */
function compareChannels(a: ChannelMeta, b: ChannelMeta): number {
  const pa = a.position ?? 0
  const pb = b.position ?? 0
  if (pa !== pb) return pa - pb
  const na = norm(a.name)
  const nb = norm(b.name)
  if (na !== nb) return na < nb ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

/** Canais agrupados por categoria, na ordem em que aparecem. */
export function groupByCategory(
  channels: readonly ChannelMeta[],
): { category: string; channels: ChannelMeta[] }[] {
  const order: string[] = []
  const map = new Map<string, ChannelMeta[]>()
  for (const c of channels) {
    const cat = (c.category || 'SEM CATEGORIA').trim() || 'SEM CATEGORIA'
    if (!map.has(cat)) {
      map.set(cat, [])
      order.push(cat)
    }
    map.get(cat)!.push(c)
  }
  return order.map((category) => ({ category, channels: map.get(category)! }))
}

/** Canais de texto/voz/vídeo de uma lista já deduplicada. */
export function channelsOfKind(
  channels: readonly ChannelMeta[],
  kind: ChannelMeta['kind'],
): ChannelMeta[] {
  return channels.filter((c) => (c.kind || 'text') === kind)
}