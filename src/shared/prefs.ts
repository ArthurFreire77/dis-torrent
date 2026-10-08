import { useSyncExternalStore } from 'react'

export type NotifLevel = 'all' | 'mentions' | 'none'

export interface Prefs {
  theme: 'dark' | 'light'
  fontScale: number
  compact: boolean
  notifDefault: NotifLevel
  mutedServers: string[]
  mutedChannels: string[]
  channelLevel: Record<string, NotifLevel>
  friendNotes: Record<string, string>
  serverFolders: { id: string; name: string; servers: string[] }[]
  audioIn: string
  echo: boolean
  noise: boolean
  gain: boolean
}

const KEY = 'forge:prefs:v1'

const DEFAULTS: Prefs = {
  theme: 'dark',
  fontScale: 1,
  compact: false,
  notifDefault: 'all',
  mutedServers: [],
  mutedChannels: [],
  channelLevel: {},
  friendNotes: {},
  serverFolders: [],
  audioIn: '',
  echo: true,
  noise: true,
  gain: true,
}

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    const p = JSON.parse(raw)
    return {
      ...DEFAULTS,
      ...p,
      mutedServers: Array.isArray(p.mutedServers) ? p.mutedServers : [],
      mutedChannels: Array.isArray(p.mutedChannels) ? p.mutedChannels : [],
      channelLevel: p.channelLevel && typeof p.channelLevel === 'object' ? p.channelLevel : {},
      friendNotes: p.friendNotes && typeof p.friendNotes === 'object' ? p.friendNotes : {},
      serverFolders: Array.isArray(p.serverFolders) ? p.serverFolders : [],
    }
  } catch {
    return { ...DEFAULTS }
  }
}

let state: Prefs = load()
const listeners = new Set<() => void>()

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state))
  } catch { /* noop */ }
  for (const l of listeners) l()
}

export function getPrefs(): Prefs {
  return state
}

export function setPrefs(patch: Partial<Prefs>) {
  state = { ...state, ...patch }
  save()
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    },
    () => state,
  )
}

export function isMutedServer(id: string): boolean {
  return state.mutedServers.includes(id)
}

export function toggleMuteServer(id: string) {
  const has = state.mutedServers.includes(id)
  setPrefs({ mutedServers: has ? state.mutedServers.filter(s => s !== id) : [...state.mutedServers, id] })
}

export function isMutedChannel(id: string): boolean {
  return state.mutedChannels.includes(id)
}

export function toggleMuteChannel(id: string) {
  const has = state.mutedChannels.includes(id)
  setPrefs({ mutedChannels: has ? state.mutedChannels.filter(s => s !== id) : [...state.mutedChannels, id] })
}

export function levelFor(channelId: string, serverId?: string): NotifLevel {
  if (state.mutedChannels.includes(channelId)) return 'none'
  if (serverId && state.mutedServers.includes(serverId)) return 'none'
  return state.channelLevel[channelId] ?? state.notifDefault
}

export function setLevel(channelId: string, level: NotifLevel) {
  setPrefs({ channelLevel: { ...state.channelLevel, [channelId]: level } })
}

export function shouldNotify(channelId: string, serverId: string | undefined, mentioned: boolean): boolean {
  const l = levelFor(channelId, serverId)
  if (l === 'none') return false
  if (l === 'mentions') return mentioned
  return true
}

export function getNote(fp: string): string {
  return state.friendNotes[fp] ?? ''
}

export function setNote(fp: string, text: string) {
  const next = { ...state.friendNotes }
  if (text.trim()) next[fp] = text.slice(0, 500)
  else delete next[fp]
  setPrefs({ friendNotes: next })
}

export function addFolder(name: string): string {
  const id = `f${Date.now().toString(36)}`
  setPrefs({ serverFolders: [...state.serverFolders, { id, name: name.slice(0, 32) || 'Pasta', servers: [] }] })
  return id
}

export function renameFolder(id: string, name: string) {
  setPrefs({ serverFolders: state.serverFolders.map(f => f.id === id ? { ...f, name: name.slice(0, 32) || f.name } : f) })
}

export function removeFolder(id: string) {
  setPrefs({ serverFolders: state.serverFolders.filter(f => f.id !== id) })
}

export function moveServerToFolder(serverId: string, folderId: string | null) {
  setPrefs({
    serverFolders: state.serverFolders.map(f => ({
      ...f,
      servers: f.id === folderId
        ? (f.servers.includes(serverId) ? f.servers : [...f.servers, serverId])
        : f.servers.filter(s => s !== serverId),
    })),
  })
}

export function folderOf(serverId: string): string | null {
  return state.serverFolders.find(f => f.servers.includes(serverId))?.id ?? null
}
