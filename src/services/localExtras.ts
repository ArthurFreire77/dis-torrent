// Persistência local (localStorage) para canais/cargos/bots/member-roles.
// Funciona tanto no modo browser quanto como fallback no modo Tauri.
// Chaves versionadas para não conflitar com dados nativos.

import type { BotView, ChannelMeta, RoleView } from './models'
import { DEFAULT_ROLE_COLORS, PERMS, BOT_AVATARS } from './models'

const LS_PREFIX = 'forge:extras:'

function key(kind: string, communityId: string) {
  return `${LS_PREFIX}${kind}:${communityId}`
}

function load<T>(k: string, fallback: T): T {
  try {
    const v = localStorage.getItem(k)
    if (!v) return fallback
    return JSON.parse(v) as T
  } catch { return fallback }
}
function save<T>(k: string, v: T) {
  try { localStorage.setItem(k, JSON.stringify(v)) } catch { /* browser only */ }
}

// ---------- Comunidades (meta do wizard: descrição/categoria/ícone) ----------
export function communityMeta(communityId: string): { description: string; category: string; icon: string } {
  return load(key('communityMeta', communityId), { description: '', category: '', icon: '' })
}
export function saveCommunityMeta(communityId: string, meta: { description?: string; category?: string; icon?: string }) {
  const cur = communityMeta(communityId)
  save(key('communityMeta', communityId), { ...cur, ...meta })
}

// ---------- Channels ----------
export function extraChannels(communityId: string): ChannelMeta[] {
  return load<ChannelMeta[]>(key('channels', communityId), [])
}
export function saveExtraChannels(communityId: string, list: ChannelMeta[]) {
  save(key('channels', communityId), list)
}
export function createLocalChannel(communityId: string, name: string, opts?: { topic?: string; category?: string; kind?: 'text' | 'voice' | 'video' }): string {
  const list = extraChannels(communityId)
  const id = `${communityId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${Math.random().toString(36).slice(2, 6)}`
  const kind = opts?.kind ?? 'text'
  const meta: ChannelMeta = {
    id,
    name: name.toLowerCase().replace(/\s+/g, '-'),
    topic: opts?.topic ?? '',
    category: opts?.category ?? (kind === 'voice' ? 'CANAIS DE VOZ' : kind === 'video' ? 'CANAIS DE VÍDEO' : 'CANAIS DE TEXTO'),
    position: list.length,
    kind,
  }
  list.push(meta)
  saveExtraChannels(communityId, list)
  return id
}
export function deleteLocalChannel(communityId: string, channelId: string) {
  let list = extraChannels(communityId)
  list = list.filter(c => c.id !== channelId)
  saveExtraChannels(communityId, list)
}
export function updateLocalChannel(communityId: string, channelId: string, patch: Partial<ChannelMeta>) {
  const list = extraChannels(communityId)
  const idx = list.findIndex(c => c.id === channelId)
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch }
    saveExtraChannels(communityId, list)
  }
}

// ---------- Roles ----------
export function roles(communityId: string): RoleView[] {
  // apenas o que foi salvo de verdade — sem seeding fake
  return load<RoleView[]>(key('roles', communityId), [])
}
export function saveRoles(communityId: string, list: RoleView[]) {
  save(key('roles', communityId), list)
}
export function createLocalRole(communityId: string, data: Omit<RoleView, 'id' | 'community_id' | 'position'> & { position?: number }): string {
  const list = roles(communityId)
  const id = `${communityId}-role-${Math.random().toString(36).slice(2, 7)}`
  const role: RoleView = {
    id,
    community_id: communityId,
    name: data.name,
    color: data.color || DEFAULT_ROLE_COLORS[Math.floor(Math.random() * DEFAULT_ROLE_COLORS.length)],
    permissions: data.permissions ?? (PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES),
    hoist: data.hoist ?? true,
    mentionable: data.mentionable ?? true,
    position: data.position ?? (Math.max(0, ...list.map(r => r.position)) + 1),
    botManaged: data.botManaged,
  }
  list.push(role)
  list.sort((a, b) => a.position - b.position)
  saveRoles(communityId, list)
  return id
}
export function updateLocalRole(communityId: string, roleId: string, patch: Partial<Omit<RoleView, 'id' | 'community_id'>>) {
  const list = roles(communityId)
  const idx = list.findIndex(r => r.id === roleId)
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch }
    saveRoles(communityId, list)
  }
}
export function deleteLocalRole(communityId: string, roleId: string) {
  let list = roles(communityId)
  list = list.filter(r => r.id !== roleId)
  saveRoles(communityId, list)
  // limpar assignments
  const asgn = memberRolesMap(communityId)
  for (const fp of Object.keys(asgn)) {
    asgn[fp] = asgn[fp].filter(id => id !== roleId)
  }
  save(key('memberRoles', communityId), asgn)
  // bots que usavam o cargo voltam para null
  let bots = botsList(communityId)
  let changed = false
  bots = bots.map(b => {
    if (b.roleId === roleId) { changed = true; return { ...b, roleId: null } }
    return b
  })
  if (changed) save(key('bots', communityId), bots)
}

// ---------- Member -> Roles ----------
export function memberRolesMap(communityId: string): Record<string, string[]> {
  return load<Record<string, string[]>>(key('memberRoles', communityId), {})
}
export function memberRoles(communityId: string, fp: string): string[] {
  return memberRolesMap(communityId)[fp] ?? []
}
export function assignRole(communityId: string, fp: string, roleId: string) {
  const map = memberRolesMap(communityId)
  const arr = map[fp] ?? []
  if (!arr.includes(roleId)) {
    map[fp] = [...arr, roleId]
    save(key('memberRoles', communityId), map)
  }
}
export function unassignRole(communityId: string, fp: string, roleId: string) {
  const map = memberRolesMap(communityId)
  const arr = map[fp] ?? []
  map[fp] = arr.filter(id => id !== roleId)
  save(key('memberRoles', communityId), map)
}

// ---------- Bots ----------
export function botsList(communityId: string): BotView[] {
  return load<BotView[]>(key('bots', communityId), [])
}
export function saveBots(communityId: string, list: BotView[]) {
  save(key('bots', communityId), list)
}
export function createLocalBot(communityId: string, data: { name: string; avatar?: string; roleId?: string | null }, ownerFp: string): string {
  const list = botsList(communityId)
  const id = `bot-${Math.random().toString(36).slice(2, 8)}`
  const disc = String(Math.floor(1000 + Math.random() * 9000))
  const token = `bot_${btoa(`${communityId}:${id}:${Date.now()}`).replace(/=+$/,'')}_${Math.random().toString(36).slice(2, 10)}`
  const bot: BotView = {
    id,
    community_id: communityId,
    name: data.name,
    discriminator: disc,
    avatar: data.avatar ?? BOT_AVATARS[Math.floor(Math.random() * BOT_AVATARS.length)],
    roleId: data.roleId ?? null,
    token,
    online: true,
    ownerFp,
    createdAt: Date.now(),
  }
  list.push(bot)
  saveBots(communityId, list)
  return id
}
export function updateLocalBot(communityId: string, botId: string, patch: Partial<Pick<BotView, 'name' | 'avatar' | 'roleId' | 'online' | 'config'>>) {
  const list = botsList(communityId)
  const idx = list.findIndex(b => b.id === botId)
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...patch }
    saveBots(communityId, list)
  }
}
/** Gera novo token local (o antigo é descartado — mesmo contrato do nativo). */
export function regenLocalBotToken(communityId: string, botId: string): string | null {
  const list = botsList(communityId)
  const idx = list.findIndex(b => b.id === botId)
  if (idx < 0) return null
  const token = `bot_${Math.random().toString(36).slice(2, 14)}_${Math.random().toString(36).slice(2, 10)}`
  list[idx] = { ...list[idx], token }
  saveBots(communityId, list)
  return token
}
export function deleteLocalBot(communityId: string, botId: string) {
  let list = botsList(communityId)
  list = list.filter(b => b.id !== botId)
  saveBots(communityId, list)
}

// ---------- Kick (member removal local-only) ----------
export function kickedMembers(communityId: string): string[] {
  return load<string[]>(key('kicked', communityId), [])
}
export function kickLocal(communityId: string, fp: string) {
  const list = kickedMembers(communityId)
  if (!list.includes(fp)) {
    list.push(fp)
    save(key('kicked', communityId), list)
  }
  // também limpar roles
  const map = memberRolesMap(communityId)
  delete map[fp]
  save(key('memberRoles', communityId), map)
}
