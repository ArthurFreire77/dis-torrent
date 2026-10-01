// Canais de um servidor — FONTE ÚNICA DE VERDADE.
//
// O bug: a UI recebia a lista de canais de DOIS lugares ao mesmo tempo e
// juntava as duas com um merge manual. `communities_list` (o servidor embutido
// no objeto CommunityView) devolve `channels: [id, nome][]` de TODOS os canais
// do servidor, e `channel_list` devolve os mesmos canais de novo com tipo,
// categoria, tópico e posição. Os dois vêm da MESMA tabela `channels`.
//
// Cada merge manual da UI tinha um filtro de duplicata diferente — e um deles
// (o painel de bot, ThemeShell.tsx) não tinha filtro nenhum. Resultado: o
// mesmo canal aparecia duas vezes dependendo de onde você olhasse.
//
// A correção não é esconder: é existir UM lugar que decide qual lista vale e
// deduplica por id E por nome normalizado. Todo mundo consome este módulo.

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
 * Une a lista resumida (`CommunityView.channels`) com a lista completa
 * (`channel_list`) em UMA lista de canais, sem duplicatas.
 *
 * Regras, em ordem de prioridade:
 *  1. A lista completa vence: ela tem tipo, categoria, tópico e posição.
 *  2. Um id presente nas duas aparece UMA vez, com os dados da completa.
 *  3. Um id só na resumida aparece com os dados que existirem (para o caso de
 *     o servidor ainda não ter respondendo a `channel_list`).
 *  4. Deduplicação por NOME normalizado também: `cid-geral` e `outrocid-geral`
 *     são o mesmo canal para o usuário, mesmo com ids diferentes.
 *  5. Ordem final por `position`, depois por nome — determinístico.
 */
export function mergeChannels(
  summary: readonly (readonly [string, string])[] | undefined,
  full: readonly ChannelMeta[] | undefined,
): ChannelMeta[] {
  const byId = new Map<string, ChannelMeta>()

  // 1) base: a lista resumida entra primeiro, para preservar a ordem original
  //    quando a completa não trouxer o canal (item 3).
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

  // 2) a completa SOBREPÕE a resumida (item 1) — é a fonte de verdade do tipo,
  //    categoria, tópico e posição.
  for (const c of full ?? []) {
    if (!c?.id || !c?.name) continue
    byId.set(c.id, c)
  }

  // 3) dedup por nome normalizado (item 4).
  //
  //   Quando dois canais normalizam para o mesmo nome, o sobrevivente é
  //   escolhido por `betterSurvivor` — NÃO pela ordem de entrada. Sem isso,
  //   a mesma lista entregue em ordens diferentes produzia sobreviventes
  //   diferentes, e a sidebar mudava de ordem entre renders.
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
 * Escolhe qual dos dois canais homônimos fica. Determinístico e sem ordem de
 * entrada:
 *   1. o que tem metadados reais (veio de `channel_list`) vence o que veio só
 *      do resumo — o resumo não tem tipo, categoria nem tópico;
 *   2. empate: o id menor, para que a escolha não dependa de nada externo.
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
 * Ordem total e determinística: posição, depois nome normalizado, depois id.
 *
 * O id no desempate final é obrigatório. `localeCompare` devolve 0 para nomes
 * que só diferem em caixa ('ALFA' vs 'alfa'), e sem um desempate final a
 * ordem herdava da ordem de entrada — a mesma lista em ordens diferentes
 * produzia resultados diferentes, e a posição na sidebar "saltava".
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

/**
 * Canais agrupados por categoria, na ordem em que aparecem.
 * Usado pelo painel de configurações para não despejar tudo numa lista só.
 */
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