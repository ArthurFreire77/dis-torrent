import type { ChannelMeta } from '../services/models'

function norm(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function mergeChannels(
  summary: readonly (readonly [string, string])[] | undefined,
  full: readonly ChannelMeta[] | undefined,
): ChannelMeta[] {
  const byId = new Map<string, ChannelMeta>()

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

  for (const c of full ?? []) {
    if (!c?.id || !c?.name) continue
    byId.set(c.id, c)
  }

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

  const out = [...byName.values()]
  out.sort(compareChannels)
  return out
}

function betterSurvivor(a: ChannelMeta, b: ChannelMeta): boolean {
  const aFull = isFullRow(a)
  const bFull = isFullRow(b)
  if (aFull !== bFull) return aFull
  return a.id < b.id
}

function isFullRow(c: ChannelMeta): boolean {
  return Boolean(c.topic) || c.kind !== 'text' || Boolean(c.category && c.category !== 'CANAIS DE TEXTO')
}

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

export function channelsOfKind(
  channels: readonly ChannelMeta[],
  kind: ChannelMeta['kind'],
): ChannelMeta[] {
  return channels.filter((c) => (c.kind || 'text') === kind)
}

export function isCallableChannel(kind: ChannelMeta['kind'] | string | undefined): boolean {
  return kind === 'voice' || kind === 'video'
}