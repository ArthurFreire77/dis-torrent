import type {
  AuditEntry,
  Conversation,
  EngineEvent,
  DisTorrentServices,
  FriendView,
  ModerationAction,
  NameKind,
  PeerView,
  PrivacyMode,
  RelayLegStatus,
  ReputationView,
  ServerRules,
  StoredMessage,
  ReactionSummary,
  MsgMetaView,
  PresenceView,
  PresenceStatus,
  ProfileView,
  ThreadView,
  BanView,
  PollView,
  EventView,
  EmojiView,
  ReadCursor,
  SearchHit,
} from './models'
import { validateNameLocal, randomNameLocal } from '../core/security/names'
import { createIdentity, type UserIdentity } from '../core/identity/identity'
import { LocalDriver } from '../core/storage/localDriver'
import { version as APP_VERSION } from '../../package.json'
import { profileContentHash } from './profileRevision'
import { SessionDriver } from '../core/storage/sessionDriver'
import { IdentityStore } from '../core/storage/identityStore'
import * as LX from './localExtras'
import { WEB_KEYS, readList, readString, writeJson, writeString } from './browserStore'
import { parseBotConfig } from './botCommands'

const sharedDriver = new LocalDriver()
const identityDriver = new SessionDriver()
try {
  const oldId = sharedDriver.get<UserIdentity>('identity')
  const sessId = identityDriver.get<UserIdentity>('identity')
  if (oldId && !sessId) {
    const oldPriv = sharedDriver.get<string>('identity:priv')
    if (oldPriv) {
      identityDriver.set('identity', oldId)
      identityDriver.set('identity:priv', oldPriv)
    }
  }
} catch {  }
const store = new IdentityStore(identityDriver)
const driver = sharedDriver

function nsKey(base: string): string {
  const fp = store.load()?.fingerprint
  return fp ? `${base}:${fp}` : base
}

function getNamespaced<T>(base: string, fallbackKeys: string[] = []): T | null {
  const ns = nsKey(base)
  let v = sharedDriver.get<T>(ns)
  if (v !== null) return v
  for (const k of fallbackKeys) {
    try {
      v = sharedDriver.get<T>(k)
      if (v !== null) {
        sharedDriver.set(ns, v)
        return v
      }
      const doubleKey = `distorrent:distorrent:${k}`
      const raw = localStorage.getItem(doubleKey)
      if (raw) {
        const parsed = JSON.parse(raw) as T
        sharedDriver.set(ns, parsed)
        localStorage.removeItem(doubleKey)
        return parsed
      }
      const singleRaw = localStorage.getItem(`distorrent:${k}`)
      if (singleRaw) {
        const parsed = JSON.parse(singleRaw) as T
        sharedDriver.set(ns, parsed)
        return parsed
      }
    } catch {  }
  }
  return null
}
function setNamespaced<T>(base: string, value: T): void {
  sharedDriver.set(nsKey(base), value)
}

const CONV_BASE = 'conversations'
const MSG_BASE = 'messages'

function readConvos(): Conversation[] {
  return getNamespaced<Conversation[]>(CONV_BASE, [CONV_BASE]) ?? []
}
function writeConvos(list: Conversation[]) {
  setNamespaced(CONV_BASE, list)
}
function readMsgs(): StoredMessage[] {
  return getNamespaced<StoredMessage[]>(MSG_BASE, [MSG_BASE]) ?? []
}
function writeMsgs(list: StoredMessage[]) {
  setNamespaced(MSG_BASE, list)
}

function getFriends(status: string): FriendView[] {
  return getNamespaced<FriendView[]>(`friends:${status}`, [`friends:${status}`, `distorrent:friends:${status}`]) ?? []
}
function setFriends(status: string, list: FriendView[]): void {
  setNamespaced(`friends:${status}`, list)
}

type CB = (ev: EngineEvent) => void
const listeners = new Set<CB>()
const viaListeners = new WeakSet<object>()
let bc: BroadcastChannel | null = null
const roomsInBrowser = new Map<string, { call_id: string; conv_id: string; kind: string; state: string; participants: string[]; host_fp: string }>()
try {
  if (typeof BroadcastChannel !== 'undefined') {
    bc = new BroadcastChannel('distorrent-bus-v2')
    bc.onmessage = (ev) => {
      const data = ev.data as EngineEvent
      for (const cb of listeners) {
        try { cb(data) } catch {  }
      }
      viaListeners.add(data)
      try { window.dispatchEvent(new CustomEvent('distorrent:bus', { detail: data })) } catch {  }
      handleIncomingBroadcast(data)
    }
  }
} catch { bc = null }

function emit(ev: EngineEvent) {
  for (const cb of listeners) try { cb(ev) } catch {  }
  viaListeners.add(ev)
  try { bc?.postMessage(ev) } catch {  }
  try { window.dispatchEvent(new CustomEvent('distorrent:bus', { detail: ev })) } catch {  }
}

function isChannelMessageId(convId: string): boolean {
  try {
    for (const c of readList<{ channels?: [string, string][] }>(WEB_KEYS.communities)) {
      if (c.channels?.some(([cid]) => cid === convId)) return true
    }
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? ''
      if (k.startsWith('distorrent:extras:channels:')) {
        const arr = readList<{ id?: string }>(k)
        if (arr.some((x) => x.id === convId)) return true
      }
    }
  } catch {  }
  return false
}

function handleIncomingBroadcast(ev: EngineEvent) {
  if ((ev as any).type === 'friend_request_in') {
    const { fp, nickname } = ev as any
    const me = store.load()
    if (!me || !fp || fp === me.fingerprint) return
    const pendingIn = getFriends('pending_in')
    if (pendingIn.some(f => f.fp === fp)) return
    setFriends('pending_in', [...pendingIn, { fp, nickname: nickname || fp.slice(0, 8), addr: 'local', pubkey_hex: '', last_seen: Date.now() }])
    for (const cb of listeners) try { cb({ type: 'friend_request_in', fp, nickname } as any) } catch {  }
  }
  if ((ev as any).type === 'friend_accepted') {
    const { fp, nickname } = ev as any
    const me = store.load()
    if (!me || !fp || fp === me.fingerprint) return
    const pendingOut = getFriends('pending_out')
    if (pendingOut.some(f => f.fp === fp)) {
      setFriends('pending_out', pendingOut.filter(f => f.fp !== fp))
      const accepted = getFriends('accepted')
      if (!accepted.some(f => f.fp === fp)) {
        setFriends('accepted', [...accepted, { fp, nickname: nickname || fp.slice(0, 8), addr: 'local', pubkey_hex: '', last_seen: Date.now() }])
      }
      const convs = readConvos()
      if (!convs.some(c => c.peer_fp === fp)) {
        writeConvos([{ id: 'local-' + fp.slice(0, 8), kind: 'dm', title: nickname || fp.slice(0, 8), peer_fp: fp, created_at: Date.now() }, ...convs])
      }
      for (const cb of listeners) try { cb({ type: 'friend_accepted', fp, nickname } as any) } catch {  }
    }
  }
  if ((ev as any).type === 'message_new') {
    const m = ev as unknown as StoredMessage & { type: 'message_new' }
    if (m.conv_id && isChannelMessageId(m.conv_id)) return
    const me = store.load()
    if (!me) return
    if (typeof m.author_fp !== 'string' || typeof m.id !== 'string') return
    const isForMe = m.author_fp !== me.fingerprint
    if (!isForMe) return
    const all = readMsgs()
    if (all.some(x => x.id === m.id)) return
    const convs = readConvos()
    let targetConv = convs.find(c => c.peer_fp === m.author_fp)
    if (!targetConv) {
      const title = m.author_fp.slice(0, 8)
      targetConv = { id: `local-${m.author_fp.slice(0, 8)}`, kind: 'dm', title, peer_fp: m.author_fp, created_at: Date.now() }
      writeConvos([targetConv, ...convs])
      emit({ type: 'peer_discovered', fp: m.author_fp, nickname: title, addr: 'local' })
    }
    const inbound: StoredMessage = { ...m, conv_id: targetConv.id, direction: 'in', status: 'ok' }
    writeMsgs([...all, inbound])
    const inboundEv: any = { ...inbound, type: 'message_new' }
    for (const cb of listeners) try { cb(inboundEv) } catch {  }
    viaListeners.add(inboundEv)
    try { window.dispatchEvent(new CustomEvent('distorrent:bus', { detail: inboundEv })) } catch {  }
  }
  if ((ev as any).type === 'group_synced') {
    const { conv_id, title } = ev as any
    if (!conv_id) return
    const me = store.load()
    if (!me) return
    let members: [string, string][]
    try { members = JSON.parse(localStorage.getItem(`distorrent:extras:group_members:${conv_id}`) ?? '[]') } catch { members = [] }
    const isMember = members.some(([fp]) => fp === me.fingerprint)
    if (!isMember) return
    const convs = readConvos()
    if (!convs.some(c => c.id === conv_id)) {
      writeConvos([{ id: conv_id, kind: 'group', title: title || 'Grupo', peer_fp: '', created_at: Date.now() }, ...convs])
    }
    const gsEv: any = { type: 'group_synced', conv_id, title: title || 'Grupo' }
    for (const cb of listeners) try { cb(gsEv) } catch {  }
    viaListeners.add(gsEv)
    try { window.dispatchEvent(new CustomEvent('distorrent:bus', { detail: gsEv })) } catch {  }
  }
  if ((ev as any).type === 'channel_message_new') {
    const { channelId, msg } = ev as any
    void channelId
    const m = (msg ?? {}) as Partial<StoredMessage>
    if (typeof m.id !== 'string' || typeof m.author_fp !== 'string') return
    const all = readMsgs()
    if (all.some(x => x.id === m.id)) return
    const me = store.load()
    const cloned: StoredMessage = { ...(msg as StoredMessage), direction: (msg as StoredMessage).author_fp === me?.fingerprint ? 'out' : 'in' } as any
    writeMsgs([...all, cloned])
    const chEv: any = { ...cloned, type: 'message_new' }
    for (const cb of listeners) try { cb(chEv) } catch {  }
    viaListeners.add(chEv)
    try { window.dispatchEvent(new CustomEvent('distorrent:bus', { detail: chEv })) } catch {  }
  }
}

const PRESENCE_PREFIX = 'distorrent:presence:'
const PRESENCE_TTL_MS = 30000
let heartbeatTimer: number | null = null

function presenceKey(fp: string) { return PRESENCE_PREFIX + fp }

function touchPresence() {
  const me = store.load()
  if (!me) return
  const payload = { fp: me.fingerprint, nickname: me.nickname, pubkey_hex: me.pubkey_hex, ts: Date.now() }
  try { localStorage.setItem(presenceKey(me.fingerprint), JSON.stringify(payload)) } catch {  }
  try { localStorage.setItem('distorrent:presence:heartbeat', String(Date.now())) } catch {  }
  try {
    const all = loadAll<PresenceView>(PRESENCE_BASE)
    const current = all[me.fingerprint]
    if (current) {
      all[me.fingerprint] = { ...current, updated_at: Date.now() }
      saveAll(PRESENCE_BASE, all)
    }
  } catch {  }
}

function getPresenceMap(): Map<string, { fp: string; nickname: string; pubkey_hex: string; ts: number }> {
  const map = new Map<string, { fp: string; nickname: string; pubkey_hex: string; ts: number }>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? ''
      if (!k.startsWith(PRESENCE_PREFIX)) continue
      try {
        const v = JSON.parse(localStorage.getItem(k) ?? '')
        if (v?.fp && typeof v.ts === 'number') map.set(v.fp, v)
      } catch {  }
    }
  } catch {  }
  return map
}

function isOnline(fp: string): boolean {
  const m = getPresenceMap().get(fp)
  if (!m) return false
  return Date.now() - m.ts < PRESENCE_TTL_MS
}

function ensureHeartbeat() {
  if (heartbeatTimer !== null) return
  touchPresence()
  heartbeatTimer = window.setInterval(() => {
    if (!store.load()) {
      stopHeartbeat()
      return
    }
    touchPresence()
    flushPendingFriendRequests()
    const now = Date.now()
    const map = getPresenceMap()
    for (const [fp, v] of map) {
      if (now - v.ts > PRESENCE_TTL_MS + 5000) {
        try { localStorage.removeItem(presenceKey(fp)) } catch {  }
        emit({ type: 'peer_offline', fp })
        emit({ type: 'state_changed', state: 'DISCONNECTED', online_peers: onlineCount() })
      }
    }
  }, 2000) as unknown as number
  window.addEventListener('beforeunload', onBeforeUnload)
}

function onBeforeUnload() {
  const me = store.load()
  if (me) try { localStorage.removeItem(presenceKey(me.fingerprint)) } catch {  }
}

export function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  window.removeEventListener('beforeunload', onBeforeUnload)
}

function onlineCount(): number {
  const me = store.load()
  const map = getPresenceMap()
  let c = 0
  for (const [fp] of map) if (fp !== me?.fingerprint && Date.now() - (map.get(fp)?.ts ?? 0) < PRESENCE_TTL_MS) c++
  return c
}

try { if (store.load()) ensureHeartbeat() } catch {  }

function onBrowserStorageEvent(e: StorageEvent) {
  if (!e.key) return
  if (e.key.startsWith(PRESENCE_PREFIX)) {
    const fp = e.key.slice(PRESENCE_PREFIX.length)
    if (e.newValue) {
      try {
        const v = JSON.parse(e.newValue)
        emit({ type: 'peer_online', fp, nickname: v?.nickname ?? fp.slice(0, 8) })
        emit({ type: 'peer_discovered', fp, nickname: v?.nickname ?? fp.slice(0, 8), addr: 'local' })
        flushPendingFriendRequests()
      } catch {  }
    } else {
      emit({ type: 'peer_offline', fp })
    }
    emit({ type: 'state_changed', state: store.load() ? 'CONNECTED' : 'DISCONNECTED', online_peers: onlineCount() })
  }
}

function onLegacyFriendRequest() {  }

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onBrowserStorageEvent)
  window.addEventListener('distorrent:friend_request' as any, onLegacyFriendRequest as EventListener)
}

export function disposeBrowserGlobalListeners() {
  if (typeof window === 'undefined') return
  window.removeEventListener('storage', onBrowserStorageEvent)
  window.removeEventListener('distorrent:friend_request' as any, onLegacyFriendRequest as EventListener)
}

try {
  const hot = (import.meta as any)?.hot
  if (hot?.dispose) hot.dispose(() => disposeBrowserGlobalListeners())
} catch {  }

function flushPendingFriendRequests() {
  const pendingOut = getFriends('pending_out')
  const me = store.load()
  if (!me || pendingOut.length === 0) return
  for (const p of pendingOut) {
    if (isOnline(p.fp)) {
      try { bc?.postMessage({ type: 'friend_request_in', fp: me.fingerprint, nickname: me.nickname }) } catch {  }
      emit({ type: 'peer_discovered' as any, fp: p.fp, nickname: p.nickname, addr: 'local' } as any)
    }
  }
}

function genMsgId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function pushMessageDirect(msg: StoredMessage) {
  const all = readMsgs()
  writeMsgs([...all, msg])
}

const RX_BASE = 'social:reactions'
const META_BASE = 'social:meta'
const PRESENCE_BASE = 'social:presence'
const PROFILE_BASE = 'social:profiles'
const READ_BASE = 'social:read'
const THREADS_BASE = 'social:threads'
const POLLS_BASE = 'social:polls'
const EVENTS_BASE = 'social:events'
const EMOJIS_BASE = 'social:emojis'
const BANS_BASE = 'social:bans'
const CFG_BASE = 'social:channelcfg'

function loadAll<T>(base: string): Record<string, T> {
  return (getNamespaced<Record<string, T>>(base, [base]) ?? {}) as Record<string, T>
}
function saveAll<T>(base: string, all: Record<string, T>) {
  setNamespaced(base, all)
}
function meFp(): string {
  return store.load()?.fingerprint ?? ''
}

function blankMeta(msgId: string, convId: string): MsgMetaView {
  return { msg_id: msgId, conv_id: convId, reply_to: '', forwarded_from: '', edited_body: '', edited_at: 0, deleted: false, pinned: false, pinned_by: '', pinned_at: 0, mentioned: false }
}
export const browserServices: DisTorrentServices = {
  kind: 'browser',

  version: async () => `${APP_VERSION}-web`,

  identityGet: () => Promise.resolve(store.load()),

  identityCreate: (nickname, password) => {
    if (password) return Promise.reject(new Error('senha por cofre disponível no app nativo'))
    const existing = store.load()
    if (existing) {
      ensureHeartbeat()
      return Promise.resolve(existing)
    }
    const { identity, privHex } = createIdentity(nickname)
    store.save(identity, privHex)
    ensureHeartbeat()
    touchPresence()
    emit({ type: 'state_changed', state: 'CONNECTED', online_peers: onlineCount() })
    return Promise.resolve(identity)
  },

  vaultStatus: () => Promise.resolve({ has_identity: !!store.load(), has_vault: false }),

  vaultUnlock: () =>
    Promise.reject(new Error('cofre disponível no app nativo')),

  localAddresses: (port) => {
    const p = port ?? (Number(window.location.port) || 5173)
    return Promise.resolve({
      localhost: `${window.location.protocol}//localhost:${p}`,
      lan: null,
      lan_all: [],
      port: p,
    })
  },

  identityRename: (nickname) => {
    const id = store.load()
    if (!id) return Promise.reject(new Error('sem identidade'))
    const updated: UserIdentity = { ...id, nickname }
    const priv = store.loadPrivHex()
    if (priv) store.save(updated, priv)
    touchPresence()
    return Promise.resolve(updated)
  },

  networkStatus: () => {
    const me = store.load()
    if (!me) return Promise.resolve({ state: 'DISCONNECTED', online_peers: 0, listen_port: 0 })
    const n = onlineCount()
    return Promise.resolve({ state: n > 0 ? 'CONNECTED' : 'DISCONNECTED', online_peers: n, listen_port: 0 })
  },

  relayStatus: (): Promise<RelayLegStatus[]> =>
    Promise.reject(new Error('relay indisponível no navegador (sem motor P2P) — use o app nativo para diagnóstico real')),

  peersList: () => {
    const me = store.load()
    const presence = getPresenceMap()
    const accepted = getFriends('accepted')
    const pendingIn = getFriends('pending_in')
    const out: PeerView[] = []

    for (const f of accepted) {
      const pres = presence.get(f.fp)
      const online = pres ? Date.now() - pres.ts < PRESENCE_TTL_MS : false
      out.push({
        fp: f.fp,
        pubkey_hex: f.pubkey_hex || pres?.pubkey_hex || '',
        nickname: f.nickname || pres?.nickname || f.fp.slice(0, 8),
        addr: online ? 'local' : null,
        last_seen: pres?.ts ?? f.last_seen ?? 0,
        origin: 'friend',
        state: online ? 'CONNECTED' : 'DISCONNECTED',
      })
    }
    for (const [fp, pres] of presence) {
      if (me && fp === me.fingerprint) continue
      if (out.some(p => p.fp === fp)) continue
      const alreadyPending = pendingIn.some(f => f.fp === fp)
      if (alreadyPending) continue
      if (Date.now() - pres.ts < PRESENCE_TTL_MS) {
        out.push({
          fp,
          pubkey_hex: pres.pubkey_hex || '',
          nickname: pres.nickname || fp.slice(0, 8),
          addr: 'local',
          last_seen: pres.ts,
          origin: 'discovery',
          state: 'CONNECTED',
        })
      }
    }
    out.sort((a, b) => {
      if (a.state !== b.state) return a.state === 'CONNECTED' ? -1 : 1
      return a.nickname.localeCompare(b.nickname)
    })
    return Promise.resolve(out)
  },

  connectAddr: () =>
    Promise.reject(new Error('rede P2P requer o app nativo (Tauri). No navegador, use abas diferentes na mesma máquina — elas se veem via BroadcastChannel.')),

  disconnectPeer: () => Promise.resolve(undefined),

  friendsList: (status) => {
    if (!status || status === 'all') {
      const all = [...getFriends('accepted'), ...getFriends('pending_in'), ...getFriends('pending_out'), ...getFriends('blocked')]
      return Promise.resolve(all)
    }
    return Promise.resolve(getFriends(status))
  },

  friendRequest: (peerFp) => {
    const fp = peerFp.trim().toLowerCase()
    if (!fp) return Promise.reject(new Error('fingerprint vazio'))
    if (fp.length < 6) return Promise.reject(new Error('fingerprint muito curto'))
    const me = store.load()
    if (me && fp === me.fingerprint) return Promise.reject(new Error('não pode adicionar a si mesmo'))
    const pendingOut = getFriends('pending_out')
    if (pendingOut.some(f => f.fp === fp)) return Promise.reject(new Error('solicitação já enviada'))
    const accepted = getFriends('accepted')
    if (accepted.some(f => f.fp === fp)) return Promise.reject(new Error('já são amigos'))
    const entry: FriendView = { fp, nickname: fp.slice(0, 8), addr: null, pubkey_hex: '', last_seen: Date.now() }
    setFriends('pending_out', [...pendingOut, entry])
    try { bc?.postMessage({ type: 'friend_request_in', fp: me?.fingerprint ?? 'local', nickname: me?.nickname ?? 'alguém' }) } catch {  }
    emit({ type: 'peer_discovered', fp, nickname: entry.nickname, addr: 'local' } as any)
    try { window.dispatchEvent(new CustomEvent('distorrent:friend_request', { detail: entry })) } catch {  }
    const outcome = isOnline(fp) ? 'sent' : 'queued_offline'
    return Promise.resolve(outcome as any)
  },

  friendRespond: (peerFp, accept) => {
    const pendingIn = getFriends('pending_in')
    const acc = getFriends('accepted')
    if (accept) {
      const found = pendingIn.find(f => f.fp === peerFp)
      const entry = found ?? { fp: peerFp, nickname: peerFp.slice(0, 8), addr: 'local', pubkey_hex: '', last_seen: Date.now() }
      setFriends('pending_in', pendingIn.filter(f => f.fp !== peerFp))
      if (!acc.some(f => f.fp === peerFp)) {
        setFriends('accepted', [...acc, { ...entry, last_seen: Date.now() }])
      }
      const convs = readConvos()
      if (!convs.some(c => c.peer_fp === peerFp)) {
        const conv: Conversation = { id: 'local-' + peerFp.slice(0, 8), kind: 'dm', title: entry.nickname || peerFp, peer_fp: peerFp, created_at: Date.now() }
        writeConvos([conv, ...convs])
      }
      const pendingOut = getFriends('pending_out')
      if (pendingOut.some(f => f.fp === peerFp)) {
        setFriends('pending_out', pendingOut.filter(f => f.fp !== peerFp))
      }
      emit({ type: 'friend_accepted', fp: peerFp, nickname: entry.nickname })
      emit({ type: 'state_changed', state: 'CONNECTED', online_peers: onlineCount() })
      try { bc?.postMessage({ type: 'friend_accepted', fp: store.load()?.fingerprint ?? 'local', nickname: store.load()?.nickname ?? 'alguém' }) } catch {  }
    } else {
      setFriends('pending_in', pendingIn.filter(f => f.fp !== peerFp))
      emit({ type: 'friend_removed', fp: peerFp })
    }
    return Promise.resolve()
  },

  friendRemove: (peerFp) => {
    const acc = getFriends('accepted')
    setFriends('accepted', acc.filter(f => f.fp !== peerFp))
    const pendingOut = getFriends('pending_out')
    if (pendingOut.some(f => f.fp === peerFp)) setFriends('pending_out', pendingOut.filter(f => f.fp !== peerFp))
    const pendingIn = getFriends('pending_in')
    if (pendingIn.some(f => f.fp === peerFp)) setFriends('pending_in', pendingIn.filter(f => f.fp !== peerFp))
    emit({ type: 'friend_removed', fp: peerFp })
    return Promise.resolve()
  },

  friendBlock: (peerFp) => {
    const blocked = getFriends('blocked')
    if (!blocked.some(f => f.fp === peerFp)) setFriends('blocked', [...blocked, { fp: peerFp, nickname: peerFp.slice(0, 8), addr: null, pubkey_hex: '', last_seen: Date.now() }])
    const acc = getFriends('accepted')
    setFriends('accepted', acc.filter(f => f.fp !== peerFp))
    emit({ type: 'friend_removed', fp: peerFp })
    return Promise.resolve()
  },

  friendUnblock: (peerFp) => {
    const blocked = getFriends('blocked')
    setFriends('blocked', blocked.filter(f => f.fp !== peerFp))
    return Promise.resolve()
  },

  friendRequestsEnabled: () => Promise.resolve(getNamespaced<boolean>('friends:requests') !== false),

  friendRequestsSet: (enabled) => {
    setNamespaced('friends:requests', !!enabled)
    return Promise.resolve()
  },

  vaultChange: () =>
    Promise.reject(new Error('cofre disponível no app nativo')),

  communitiesList: () => {
    return Promise.resolve(readList<import('./models').CommunityView>(WEB_KEYS.communities))
  },

  createCommunity: (name, channels, opts) => {
    const list = readList<import('./models').CommunityView>(WEB_KEYS.communities)
    const cid = `local-${Math.random().toString(36).slice(2, 10)}`
    const seeds: { name: string; kind: 'text' | 'voice' | 'video'; category: string }[] = opts?.channelsMeta?.length
      ? opts.channelsMeta
      : (channels.length ? channels : ['geral']).map(c => ({ name: c, kind: 'text' as const, category: 'CANAIS DE TEXTO' }))
    const chanTuples: [string, string][] = seeds.map(c => [`${cid}-${c.name.toLowerCase().replace(/\s+/g, '-')}`, c.name] as [string, string])
    const me = store.load()
    const cv: import('./models').CommunityView = {
      id: cid, name, owner_fp: me?.fingerprint ?? 'local', channels: chanTuples,
      members: me ? [[me.fingerprint, me.nickname, 'owner']] : [],
      description: opts?.description ?? '', category: opts?.category ?? '', icon: opts?.icon ?? '',
      is_owner: true,
    }
    list.push(cv)
    writeJson(WEB_KEYS.communities, list)
    seeds.forEach((c, i) => {
      LX.createLocalChannel(cid, c.name, { kind: c.kind, category: c.category, id: chanTuples[i][0] })
    })
    for (const r of opts?.roles ?? []) LX.createLocalRole(cid, r)
    LX.saveCommunityMeta(cid, { description: opts?.description, category: opts?.category, icon: opts?.icon })
    if (opts?.rulesText) {
      writeJson(WEB_KEYS.rules(cid), { community_id: cid, spam_level: 'medium', banned_words: [], blocked_domains: [], moderators: [], shadow_banned: [], updated_at: Date.now() })
      writeString(WEB_KEYS.rulesText(cid), opts.rulesText)
    }
    emit({ type: 'community_joined', community_id: cid, name } as any)
    try { bc?.postMessage({ type: 'community_joined', community_id: cid, name }) } catch {  }
    return Promise.resolve(cid)
  },

  communitySetMeta: (communityId, patch) => {
    const list = readList<import('./models').CommunityView>(WEB_KEYS.communities)
    const idx = list.findIndex(c => c.id === communityId)
    if (idx < 0) return Promise.reject(new Error('comunidade não encontrada'))
    list[idx] = {
      ...list[idx],
      description: patch.description ?? list[idx].description ?? '',
      category: patch.category ?? list[idx].category ?? '',
      icon: patch.icon ?? list[idx].icon ?? '',
    }
    writeJson(WEB_KEYS.communities, list)
    LX.saveCommunityMeta(communityId, patch)
    return Promise.resolve()
  },

  communityRename: (communityId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return Promise.reject(new Error('nome vazio'))
    const list = readList<import('./models').CommunityView>(WEB_KEYS.communities)
    const idx = list.findIndex(c => c.id === communityId)
    if (idx < 0) return Promise.reject(new Error('comunidade não encontrada'))
    list[idx] = { ...list[idx], name: trimmed }
    writeJson(WEB_KEYS.communities, list)
    emit({ type: 'community_joined', community_id: communityId, name: trimmed } as any)
    try { bc?.postMessage({ type: 'community_joined', community_id: communityId, name: trimmed }) } catch {  }
    return Promise.resolve()
  },

  communitySetPublic: (communityId, isPublic) => {
    const list = readList<import('./models').CommunityView>(WEB_KEYS.communities)
    const idx = list.findIndex(c => c.id === communityId)
    if (idx < 0) return Promise.reject(new Error('comunidade não encontrada'))
    list[idx] = { ...list[idx], is_public: isPublic }
    writeJson(WEB_KEYS.communities, list)
    emit({ type: 'community_synced', community_id: communityId } as any)
    return Promise.resolve()
  },

  joinPublicCommunity: (hostFp, communityId) => {
    // Modo navegador não tem host remoto: só existe o servidor desta máquina.
    const list = readList<import('./models').CommunityView>(WEB_KEYS.communities)
    const sala = list.find(c => c.id === communityId)
    if (!sala) return Promise.reject(new Error('servidor não encontrado'))
    if (!sala.is_public) return Promise.reject(new Error('este servidor é privado — peça um convite'))
    void hostFp
    return Promise.resolve(communityId)
  },

  makeInvite: (cid) => Promise.resolve(`local-invite:${cid}:${btoa(cid).slice(0, 8)}`),

  makeInviteLink: (cid) => {
    const token = `local-invite:${cid}:${btoa(cid).slice(0, 8)}`
    return Promise.resolve({
      token,
      link: `distorrent://invite?invite=${token}`,
      expires_at_ms: Date.now() + 7 * 24 * 3600 * 1000,
      scope: 'open' as const,
    })
  },

  communityMembers: (cid) => {
    const list = readList<import('./models').CommunityView>(WEB_KEYS.communities)
    const me = store.load()
    const cv = list.find(c => c.id === cid)
    if (!cv) return Promise.resolve([])
    const out: import('./models').MemberPairing[] = (cv.members ?? []).map(([fp, nick, role]) => ({
      fp,
      nickname: nick,
      role,
      state: me && fp === me.fingerprint ? 'connected' : 'offline',
      via_relay: false,
      is_owner: fp === cv.owner_fp,
      is_self: !!me && fp === me.fingerprint,
    }))
    return Promise.resolve(out)
  },
  joinCommunity: (rawToken) => {
    let token = rawToken.trim()
    try {
      if (token.includes('://') || token.startsWith('/')) {
        const u = new URL(token.startsWith('/') ? `${window.location.origin}${token}` : token)
        token = u.searchParams.get('invite') || u.searchParams.get('token') ||
          (u.pathname.split('/').filter(Boolean).pop() ?? '')
      }
      token = decodeURIComponent(token)
    } catch {
      return Promise.reject(new Error('link de convite inválido'))
    }
    const m = token.match(/^local-invite:([^:]+):/)
    if (!m) return Promise.reject(new Error('token inválido'))
    const cid = m[1]
    const list = readList<import('./models').CommunityView>(WEB_KEYS.communities)
    if (!list.some(c => c.id === cid)) {
      const me = store.load()
      const chanId = `${cid}-geral`
      const cv: import('./models').CommunityView = {
        id: cid,
        name: 'Servidor (convite)',
        owner_fp: 'remoto',
        channels: [[chanId, 'geral']],
        members: me ? [[me.fingerprint, me.nickname, 'member']] : [],
      }
      list.push(cv)
      writeJson(WEB_KEYS.communities, list)
      emit({ type: 'community_joined', community_id: cid, name: cv.name } as any)
      try { bc?.postMessage({ type: 'community_joined', community_id: cid, name: cv.name }) } catch {  }
    }
    return Promise.resolve(cid)
  },
  sendChannelMessage: (_cid, channelId, body) => {
    const trimmed = body.trim()
    if (!trimmed) return Promise.reject(new Error('mensagem vazia'))
    const me = store.load()
    const id = genMsgId()
    const m: StoredMessage = { id, conv_id: channelId, author_fp: me?.fingerprint ?? 'local', body: trimmed, ts: Date.now(), sig: 'local', direction: 'out', status: 'sent' }
    const all = readMsgs()
    writeMsgs([...all, m])
    const ev: any = { ...m, type: 'message_new' }
    for (const cb of listeners) try { cb(ev) } catch {  }
    try { bc?.postMessage({ type: 'channel_message_new', channelId, msg: m }) } catch {  }
    setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'delivered' } as any), 200)
    return Promise.resolve(m)
  },

  conversationsList: () => Promise.resolve(readConvos()),
  conversationsOverview: () => Promise.resolve(readConvos().map((c) => {
    const msgs = readMsgs().filter((m) => m.conv_id === c.id)
    const last = msgs.length ? msgs.reduce((a, b) => (a.ts >= b.ts ? a : b)) : null
    const cursor = loadAll<ReadCursor>(READ_BASE)[c.id]?.last_read_ts ?? 0
    return {
      ...c,
      last_ts: last?.ts ?? 0,
      last_body: last?.body ?? '',
      unread_count: msgs.filter((m) => m.ts > cursor && m.direction === 'in').length,
    }
  })),
  conversationDelete: (convId) => { writeConvos(readConvos().filter(c => c.id !== convId)); return Promise.resolve() },

  dmOpen: (peerFp, peerNick) => {
    const list = readConvos()
    const found = list.find((c) => c.peer_fp === peerFp)
    if (found) return Promise.resolve(found)
    const conv: Conversation = {
      id: 'local-' + peerFp.slice(0, 8),
      kind: 'dm',
      title: peerNick || peerFp.slice(0, 8),
      peer_fp: peerFp,
      created_at: Date.now(),
    }
    writeConvos([conv, ...list])
    return Promise.resolve(conv)
  },

  messagesList: (convId) => Promise.resolve(readMsgs().filter((m) => m.conv_id === convId).sort((a, b) => a.ts - b.ts)),

  messageSend: (convId, body) => {
    const trimmed = body.trim()
    if (!trimmed) return Promise.reject(new Error('mensagem vazia'))
    if (!convId) return Promise.reject(new Error('conversa não selecionada'))
    const me = store.load()
    if (!me) return Promise.reject(new Error('sem identidade — crie uma conta primeiro'))
    const convs = readConvos()
    const conv = convs.find(c => c.id === convId)
    if (!conv) return Promise.reject(new Error('conversa não encontrada'))
    const targetFp = conv.peer_fp
    const targetOnline = targetFp ? isOnline(targetFp) : false
    const blocked = getFriends('blocked')
    if (targetFp && blocked.some(f => f.fp === targetFp)) return Promise.reject(new Error('peer bloqueado'))

    const ehAmigo = !!targetFp && getFriends('accepted').some(f => f.fp === targetFp)
    if (!ehAmigo) {
      const key = `distorrent:intro:${convId}`
      const usados = Math.max(0, Number(readString(key) ?? 0))
      if (usados >= 3) {
        return Promise.reject(new Error('limite de 3 mensagens antes da amizade — envie uma solicitação para continuar'))
      }
      writeString(key, String(usados + 1))
    }

    const id = genMsgId()
    const msg: StoredMessage = {
      id,
      conv_id: convId,
      author_fp: me.fingerprint,
      body: trimmed,
      ts: Date.now(),
      sig: 'local',
      direction: 'out',
      status: targetOnline ? 'sent' : 'pending',
    }
    pushMessageDirect(msg)
    const evNew: any = { ...msg, type: 'message_new' }
    emit(evNew)

    if (targetOnline) {
      setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'sent' } as any), 80)
      setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'delivered' } as any), 350)
      setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'read' } as any), 1200)
      setTimeout(() => {
        const all = readMsgs()
        const idx = all.findIndex(x => x.id === id)
        if (idx >= 0) { all[idx] = { ...all[idx], status: 'delivered' as const }; writeMsgs(all) }
      }, 360)
    } else {
      setTimeout(() => {
        if (targetFp && isOnline(targetFp)) {
          emit({ type: 'message_status', msg_id: id, status: 'sent' } as any)
          setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'delivered' } as any), 200)
        }
      }, 1200)
    }
    return Promise.resolve(msg)
  },

  messageResend: (msgId) => {
    const all = readMsgs()
    const idx = all.findIndex(x => x.id === msgId)
    if (idx < 0) return Promise.reject(new Error('mensagem não encontrada'))
    const msg = { ...all[idx], status: 'pending' as const }
    all[idx] = msg
    writeMsgs(all)
    emit({ type: 'message_status', msg_id: msgId, status: 'pending' } as any)
    setTimeout(() => {
      const cur = readMsgs()
      const i = cur.findIndex(x => x.id === msgId)
      if (i >= 0) { cur[i] = { ...cur[i], status: 'sent' as const }; writeMsgs(cur) }
      emit({ type: 'message_status', msg_id: msgId, status: 'sent' } as any)
    }, 300)
    return Promise.resolve(msg)
  },

  sendTyping: (convId) => {
    const me = store.load()
    if (!me || !convId) return Promise.resolve()
    try { bc?.postMessage({ type: 'typing', conv_id: convId, convId, fp: me.fingerprint, nickname: me.nickname }) } catch {  }
    return Promise.resolve()
  },

  channelCreate: (cid, name, opts) => Promise.resolve(LX.createLocalChannel(cid, name, opts)),
  channelDelete: (cid, channelId) => { LX.deleteLocalChannel(cid, channelId); emit({ type: 'channel_deleted' as any, community_id: cid, channel_id: channelId } as any); try { bc?.postMessage({ type: 'channel_deleted', community_id: cid, channel_id: channelId }) } catch {  }; return Promise.resolve() },
  channelRename: (cid, channelId, newName) => { LX.updateLocalChannel(cid, channelId, { name: newName.toLowerCase().replace(/\s+/g, '-') }); try { bc?.postMessage({ type: 'channel_created', community_id: cid, channel_id: channelId, name: newName }) } catch {  }; return Promise.resolve() },
  channelSetTopic: (cid, channelId, topic) => { LX.updateLocalChannel(cid, channelId, { topic }); return Promise.resolve() },
  channelSetCategory: (cid, channelId, category) => { LX.updateLocalChannel(cid, channelId, { category }); return Promise.resolve() },
  channelList: (cid) => Promise.resolve(LX.extraChannels(cid)),

  roleCreate: (cid, data) => Promise.resolve(LX.createLocalRole(cid, data)),
  roleUpdate: (cid, roleId, patch) => { LX.updateLocalRole(cid, roleId, patch); return Promise.resolve() },
  roleDelete: (cid, roleId) => { LX.deleteLocalRole(cid, roleId); return Promise.resolve() },
  rolesList: (cid) => Promise.resolve(LX.roles(cid)),
  memberRoles: (cid, fp) => Promise.resolve(LX.memberRoles(cid, fp)),
  memberAssignRole: (cid, fp, roleId) => { LX.assignRole(cid, fp, roleId); return Promise.resolve() },
  memberUnassignRole: (cid, fp, roleId) => { LX.unassignRole(cid, fp, roleId); return Promise.resolve() },
  memberKick: (cid, fp) => { LX.kickLocal(cid, fp); return Promise.resolve() },

  botCreate: (cid, data) => {
    const me = store.load()
    return Promise.resolve(LX.createLocalBot(cid, data, me?.fingerprint ?? 'local'))
  },
  botUpdate: (cid, botId, patch) => { LX.updateLocalBot(cid, botId, patch); return Promise.resolve() },
  botDelete: (cid, botId) => { LX.deleteLocalBot(cid, botId); return Promise.resolve() },
  botsList: (cid) => Promise.resolve(LX.botsList(cid)),
  botPostMessage: (_cid, channelId, botId, body) => {
    const trimmed = body.trim()
    if (!trimmed) return Promise.reject(new Error('mensagem vazia'))
    const bot = LX.botsList(_cid).find(b => b.id === botId)
    const me = store.load()
    const id = genMsgId()
    const m: StoredMessage = {
      id, conv_id: channelId, author_fp: me?.fingerprint ?? 'local', body: trimmed,
      ts: Date.now(), sig: 'local', direction: 'out', status: 'sent', bot_id: botId,
    }
    writeMsgs([...readMsgs(), m])
    const ev: any = { ...m, type: 'message_new', bot_name: bot?.name }
    for (const cb of listeners) try { cb(ev) } catch {  }
    try { bc?.postMessage({ type: 'channel_message_new', channelId, msg: m } as any) } catch {  }
    return Promise.resolve(m)
  },
  botRegenToken: (cid, botId) => {
    const tok = LX.regenLocalBotToken(cid, botId)
    if (!tok) return Promise.reject(new Error('bot não encontrado'))
    return Promise.resolve(tok)
  },
  botAdmin: () =>
    Promise.reject(
      new Error('comandos administrativos de bot só existem no app nativo (precisam do core)'),
    ),
  botLogAppend: () => Promise.resolve(),
  botLogs: () => Promise.resolve([]),
  botLogsClear: () => Promise.resolve(0),
  botVarGet: () => Promise.resolve(null),
  botVarSet: () => Promise.resolve(),
  botVarsList: () => Promise.resolve([]),
  botMusicSave: () =>
    Promise.reject(new Error('guardar faixa de música só existe no app nativo')),
  botMusicRead: () =>
    Promise.reject(new Error('ler faixa de música só existe no app nativo')),
  botMusicDelete: () => Promise.resolve(false),
  botZipSave: () =>
    Promise.reject(new Error('importar .zip só existe no app nativo')),
  botConfigValidate: async (config) => {
    const cfg = parseBotConfig(config)
    if (!cfg) throw new Error('config de bot inválida')
    return { prefix: cfg.prefix, commands: cfg.commands.length, events: cfg.events }
  },
  botWarningsList: () => Promise.resolve([]),
  botBridgeStart: () =>
    Promise.reject(new Error('a ponte local (127.0.0.1) só existe no app nativo')),
  botBridgeStop: () => Promise.resolve(false),
  botBridgeStatus: () => Promise.resolve(null),
  botBridgeList: () => Promise.resolve([]),
  botFolderRead: () =>
    Promise.reject(new Error('importar pasta de bot só existe no app nativo')),
  botZipRead: () =>
    Promise.reject(new Error('importar arquivo .zip de bot só existe no app nativo')),
  botPluginStart: () =>
    Promise.reject(new Error('executar código de bot só existe no app nativo')),
  botPluginStop: () => Promise.resolve(false),
  botPluginStatus: () => Promise.resolve(null),
  botPluginList: () => Promise.resolve([]),
  httpFetch: async (url, method, headers, body, timeoutMs) => {
    const ctrl = new AbortController()
    // Mesmo teto do app nativo (90s): LLM responde devagar.
    const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(timeoutMs, 90_000)))
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: method === 'POST' ? body : undefined,
        signal: ctrl.signal,
      })
      const text = await res.text()
      return { status: res.status, body: text.slice(0, 256 * 1024) }
    } catch (e: any) {
      throw new Error(`HTTP falhou: ${String(e?.message ?? e)}`)
    } finally {
      clearTimeout(timer)
    }
  },

  subscribe: (cb) => {
    listeners.add(cb)
    try {
      const presence = getPresenceMap()
      for (const [fp, v] of presence) {
        if (store.load()?.fingerprint === fp) continue
        if (Date.now() - v.ts < PRESENCE_TTL_MS) cb({ type: 'peer_online', fp, nickname: v.nickname } as any)
      }
    } catch {  }
    const onBus = (e: Event) => {
      const detail = (e as CustomEvent).detail as EngineEvent
      if (detail && typeof detail === 'object' && viaListeners.has(detail)) return
      try { cb(detail) } catch {  }
    }
    window.addEventListener('distorrent:bus', onBus as EventListener)
    return () => {
      listeners.delete(cb)
      window.removeEventListener('distorrent:bus', onBus as EventListener)
    }
  },

  webrtcReport: () => Promise.resolve(),
  netDiag: () => Promise.reject(new Error('diagnóstico de rede só existe no app nativo')),

  firewallStatus: () => Promise.reject(new Error('firewall só existe no app nativo')),

  firewallAllow: () => Promise.reject(new Error('firewall só existe no app nativo')),

  openFirewallConsole: () => Promise.reject(new Error('firewall só existe no app nativo')),

  updateCheck: () => Promise.reject(new Error('atualização automática só existe no app nativo')),
  updateCheckForce: () => Promise.reject(new Error('atualização automática só existe no app nativo')),
  updateDownload: () => Promise.reject(new Error('atualização automática só existe no app nativo')),
  updateApply: () => Promise.reject(new Error('atualização automática só existe no app nativo')),
  updateVerifyReady: () => Promise.reject(new Error('atualização automática só existe no app nativo')),
  updateTrustInfo: () => Promise.reject(new Error('confiança de releases só existe no app nativo')),
  peerTrustInfo: () => Promise.resolve({ policy: 'block_revoked', policies: [] }),
  peerTrustPolicySet: () => Promise.reject(new Error('confiança de releases só existe no app nativo')),
  updateAutoGet: () => Promise.resolve(false),
  updateAutoSet: () => Promise.resolve(),
  updateFlagGet: () => Promise.resolve(null),
  updateFlagSet: () => Promise.resolve(),
  updateCleanup: () => Promise.resolve(0),
  openReleasePage: async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  openExternal: async (url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer')
  },

  privacyGet: () => {
    const stored = driver.get<string>('privacy_mode') ?? 'encrypted'
    const mode = stored as PrivacyMode
    const isProxy = mode === 'proxy'
    const isFull = mode === 'full'
    return Promise.resolve({
      mode,
      encryption_enabled: mode !== 'normal',
      tor_proxy: isFull,
      udp_discovery: mode === 'normal' || mode === 'encrypted',
      metadata_padding: isFull,
      traffic_obfuscation: isProxy || isFull,
      proxy_effective: false,
    })
  },

  privacySet: (mode: PrivacyMode) => {
    driver.set('privacy_mode', mode)
    const isProxy = mode === 'proxy'
    const isFull = mode === 'full'
    return Promise.resolve({
      mode,
      encryption_enabled: mode !== 'normal',
      tor_proxy: isFull,
      udp_discovery: mode === 'normal' || mode === 'encrypted',
      metadata_padding: isFull,
      traffic_obfuscation: isProxy || isFull,
      proxy_effective: false,
    })
  },

  proxyAddrGet: (mode) => {
    const target = mode ?? (driver.get<string>('privacy_mode') ?? 'encrypted')
    const key = target === 'full' ? 'privacy_tor_addr' : 'privacy_proxy_addr'
    const saved = driver.get<string>(key)
    return Promise.resolve({
      addr: saved && saved.trim() !== '' ? saved.trim() : (target === 'full' ? '127.0.0.1:9050' : '127.0.0.1:1080'),
      is_default: !(saved && saved.trim() !== ''),
    })
  },

  proxyAddrSet: (addr, mode) => {
    const target = mode ?? (driver.get<string>('privacy_mode') ?? 'encrypted')
    const key = target === 'full' ? 'privacy_tor_addr' : 'privacy_proxy_addr'
    const v = addr.trim()
    if (v === '') driver.remove(key)
    else driver.set(key, v)
    return Promise.resolve()
  },

  proxyTest: () => Promise.reject(new Error('teste online do proxy só existe no app nativo — modo navegador não faz SOCKS5')),

  vaultExport: () => Promise.reject(new Error('export disponível no app nativo')),
  vaultImport: () => Promise.reject(new Error('import disponível no app nativo')),
  accountsList: () => Promise.resolve([]),
  accountSaveImported: () => Promise.reject(new Error('disponível no app nativo')),
  accountSwitch: () => Promise.reject(new Error('disponível no app nativo')),
  accountRemoveImported: () => Promise.reject(new Error('disponível no app nativo')),

  createGroup: (title, members) => {
    const id = `group-${Math.random().toString(36).slice(2, 8)}`
    const me = store.load()
    const conv: Conversation = { id, kind: 'group', title: title || members.slice(0, 2).join(', '), peer_fp: '', created_at: Date.now() }
    const all = [conv, ...readConvos()]
    writeConvos(all)
    localStorage.setItem(`distorrent:extras:group_members:${id}`, JSON.stringify(members.map((fp: string) => [fp, ''] as [string, string])))
    if (me) {
      const k = `distorrent:extras:group_members:${id}`
      try {
        const cur = JSON.parse(localStorage.getItem(k) ?? '[]')
        if (!cur.find((x: any) => x[0] === me.fingerprint)) {
          cur.push([me.fingerprint, me.nickname])
          localStorage.setItem(k, JSON.stringify(cur))
        }
      } catch {  }
    }
    try { bc?.postMessage({ type: 'group_synced', conv_id: id, title }) } catch {  }
    window.dispatchEvent(new CustomEvent('distorrent:groups_changed'))
    emit({ type: 'group_synced' as any, conv_id: id, title } as any)
    return Promise.resolve(conv)
  },
  groupMembers: (cid) => {
    try { const v = localStorage.getItem(`distorrent:extras:group_members:${cid}`); if (v) return Promise.resolve(JSON.parse(v)) } catch {  }
    return Promise.resolve([])
  },
  groupOwner: (cid) => {
    // No navegador o dono é o primeiro membro (mesma convenção do core quando
    // não há registro explícito).
    try {
      const v = localStorage.getItem(`distorrent:extras:group_members:${cid}`)
      const mems = v ? JSON.parse(v) as [string, string][] : []
      return Promise.resolve(mems.length > 0 ? mems[0][0] : null)
    } catch { return Promise.resolve(null) }
  },
  groupPairNow: () => Promise.resolve(),
  communityPairNow: () => Promise.resolve(),
  communitySyncNow: () => Promise.resolve(),
  groupAdd: (cid, fp) => {
    try { const k = `distorrent:extras:group_members:${cid}`; const cur = JSON.parse(localStorage.getItem(k) ?? '[]'); if (!cur.find((x: any) => x[0] === fp)) { cur.push([fp, '']); localStorage.setItem(k, JSON.stringify(cur)) } } catch {  }
    window.dispatchEvent(new CustomEvent('distorrent:groups_changed'))
    try { bc?.postMessage({ type: 'channel_created', community_id: cid, channel_id: fp, name: fp } as any) } catch {  }
    emit({ type: 'group_synced' as any, conv_id: cid, title: '' } as any)
    try { bc?.postMessage({ type: 'group_synced', conv_id: cid, title: '' }) } catch {  }
    return Promise.resolve()
  },
  groupRemove: (cid, fp) => {
    try {
      const k = `distorrent:extras:group_members:${cid}`
      const cur = JSON.parse(localStorage.getItem(k) ?? '[]') as [string, string][]
      localStorage.setItem(k, JSON.stringify(cur.filter(([f]) => f !== fp)))
    } catch {  }
    emit({ type: 'group_synced' as any, conv_id: cid, title: '' } as any)
    try { bc?.postMessage({ type: 'group_synced', conv_id: cid, title: '' }) } catch {  }
    return Promise.resolve()
  },
  groupRename: (cid, title) => {
    const nome = title.trim()
    if (!nome) return Promise.reject(new Error('título vazio'))
    writeConvos(readConvos().map((c) => (c.id === cid ? { ...c, title: nome } : c)))
    emit({ type: 'group_synced' as any, conv_id: cid, title: nome } as any)
    try { bc?.postMessage({ type: 'group_synced', conv_id: cid, title: nome }) } catch {  }
    return Promise.resolve()
  },
  groupLeave: (cid) => {
    try { localStorage.removeItem(`distorrent:extras:group_members:${cid}`) } catch {  }
    writeConvos(readConvos().filter((c) => c.id !== cid))
    emit({ type: 'group_synced' as any, conv_id: cid, title: '' } as any)
    return Promise.resolve()
  },
  groupDelete: (cid) => {
    try { localStorage.removeItem(`distorrent:extras:group_members:${cid}`) } catch {  }
    writeConvos(readConvos().filter((c) => c.id !== cid))
    emit({ type: 'group_synced' as any, conv_id: cid, title: '' } as any)
    try { bc?.postMessage({ type: 'group_synced', conv_id: cid, title: '' }) } catch {  }
    return Promise.resolve()
  },
  groupDeleteLocal: (cid) => {
    try { localStorage.removeItem(`distorrent:extras:group_members:${cid}`) } catch {  }
    writeConvos(readConvos().filter((c) => c.id !== cid))
    emit({ type: 'group_synced' as any, conv_id: cid, title: '' } as any)
    return Promise.resolve()
  },
  callRoomPublish: (callId, convId, kind, participants) => {
    const sala = { call_id: callId, conv_id: convId, kind, state: 'open', participants, host_fp: participants[0] ?? '' }
    if (callId) roomsInBrowser.set(convId, sala)
    emit({ type: 'call_room', ...sala } as any)
    return Promise.resolve()
  },
  callRoomClose: (convId) => {
    roomsInBrowser.delete(convId)
    emit({ type: 'call_room', conv_id: convId, state: 'closed', participants: [] } as any)
    return Promise.resolve()
  },
  callRoomLeave: (convId) => {
    roomsInBrowser.delete(convId)
    emit({ type: 'call_room', conv_id: convId, state: 'closed', participants: [] } as any)
    return Promise.resolve()
  },
  callRoomJoin: (convId) => {
    const sala = roomsInBrowser.get(convId)
    if (!sala) return Promise.reject(new Error('a chamada encerrou ou ainda não foi anunciada'))
    return Promise.resolve([sala.call_id, sala.participants.slice()] as [string, string[]])
  },
  callRoomsList: () => Promise.resolve([...roomsInBrowser.values()]),
  callInvite: (targetFp, kind) => {
    const rand = (() => {
      try {
        const b = new Uint8Array(6)
        crypto.getRandomValues(b)
        return Array.from(b).map(x => x.toString(36)).join('').slice(0, 8)
      } catch { return Math.random().toString(36).slice(2, 8) }
    })()
    const callId = `call-${Date.now().toString(36)}-${rand}`
    try {
      localStorage.setItem(`distorrent:call:invite:${callId}`, JSON.stringify({ targetFp, kind, at: Date.now() }))
      const ev: any = { type: 'call_incoming', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local', kind, target_fp: targetFp }
      emit(ev)
      setTimeout(() => {
        try { emit({ type: 'call_ringing', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local' } as any) } catch {  }
      }, 0)
    } catch {  }
    return Promise.resolve(callId)
  },
  callRingRetry: () => Promise.resolve(),
  callAccept: (callId, _fromFp) => {
    try { emit({ type: 'call_accepted', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local' } as any) } catch {  }
    return Promise.resolve()
  },
  callReject: (callId, _fromFp, reason) => {
    try { emit({ type: 'call_rejected', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local', reason } as any) } catch {  }
    return Promise.resolve()
  },
  callEnd: (callId) => {
    try { emit({ type: 'call_ended', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local' } as any) } catch {  }
    return Promise.resolve()
  },
  callOffer: (targetFp, callId, sdp) => {
    try {
      emit({ type: 'call_offer', from_fp: store.load()?.fingerprint ?? 'local', call_id: callId, sdp } as any)
    } catch {  }
    void targetFp
    return Promise.resolve()
  },
  callAnswer: (targetFp, callId, sdp) => {
    try {
      emit({ type: 'call_answer', from_fp: store.load()?.fingerprint ?? 'local', call_id: callId, sdp } as any)
    } catch {  }
    void targetFp
    return Promise.resolve()
  },
  callIce: (targetFp, callId, candidate, mid) => {
    try {
      emit({ type: 'call_ice', from_fp: store.load()?.fingerprint ?? 'local', call_id: callId, candidate, mid } as any)
    } catch {  }
    void targetFp
    return Promise.resolve()
  },
  callAddParticipant: (targetFp, callId, fp, kind) => {
    emit({ type: 'call_participant_added', call_id: callId, fp } as any)
    if (kind) emit({ type: 'call_incoming', call_id: callId, from_fp: fp, kind } as any)
    void targetFp
    return Promise.resolve()
  },
  screenShareOffer: (targetFp, callId, sdp) => {
    emit({ type: 'screen_share_offer', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local', sdp } as any)
    void targetFp
    return Promise.resolve()
  },
  screenShareAnswer: () => Promise.resolve(),
  voiceJoin: (cid, ch) => {
    const me = store.load(); if (!me) return Promise.resolve()
    const k = `distorrent:voice:${cid}:${ch}`
    let arr: any[] = []; try { arr = JSON.parse(localStorage.getItem(k) ?? '[]') } catch {  }
    if (!arr.find((x: any) => x[0] === me.fingerprint)) { arr.push([me.fingerprint, false, false]); localStorage.setItem(k, JSON.stringify(arr)) }
    window.dispatchEvent(new CustomEvent('distorrent:voice_changed'))
    emit({ type: 'voice_joined' as any, community_id: cid, channel_id: ch, fp: me.fingerprint } as any)
    return Promise.resolve()
  },
  voiceLeave: (cid, ch) => {
    const me = store.load(); if (!me) return Promise.resolve()
    const k = `distorrent:voice:${cid}:${ch}`
    let arr: any[] = []; try { arr = JSON.parse(localStorage.getItem(k) ?? '[]') } catch {  }
    arr = arr.filter((x: any) => x[0] !== me.fingerprint); localStorage.setItem(k, JSON.stringify(arr))
    window.dispatchEvent(new CustomEvent('distorrent:voice_changed'))
    emit({ type: 'voice_left' as any, community_id: cid, channel_id: ch, fp: me.fingerprint } as any)
    return Promise.resolve()
  },
  voiceState: (cid, ch, muted, deaf) => {
    const me = store.load(); if (!me) return Promise.resolve()
    const k = `distorrent:voice:${cid}:${ch}`
    let arr: any[] = []; try { arr = JSON.parse(localStorage.getItem(k) ?? '[]') } catch {  }
    const idx = arr.findIndex((x: any) => x[0] === me.fingerprint)
    if (idx >= 0) { arr[idx] = [me.fingerprint, muted, deaf]; localStorage.setItem(k, JSON.stringify(arr)) }
    window.dispatchEvent(new CustomEvent('distorrent:voice_changed'))
    emit({ type: 'voice_state_changed' as any, community_id: cid, channel_id: ch, fp: me.fingerprint, muted, deafened: deaf } as any)
    return Promise.resolve()
  },
  voiceStates: (cid, ch) => {
    try { const v = localStorage.getItem(`distorrent:voice:${cid}:${ch}`); if (v) return Promise.resolve(JSON.parse(v)) } catch {  }
    return Promise.resolve([])
  },
  fileAnnounce: (fid, name, size, chunks, hash, chunkHashes?: string[]) => {
    try {
      if (chunkHashes?.length) {
        try { localStorage.setItem(`distorrent:file:chunk_hashes:${fid}`, JSON.stringify(chunkHashes)) } catch {  }
        try { localStorage.setItem(`distorrent:filemeta:${fid}`, JSON.stringify({ name, size, chunks, hash, chunkHashes })) } catch {  }
      }
      localStorage.setItem(`distorrent:file:${fid}`, JSON.stringify({ name, size, chunks, hash, chunk_hashes: chunkHashes ?? null, at: Date.now(), from: store.load()?.fingerprint ?? 'local' }))
      const ev: any = { type: 'file_announce', file_id: fid, name, size, chunks, hash, chunk_hashes: chunkHashes ?? null, from_fp: store.load()?.fingerprint ?? 'local' }
      emit(ev)
      try { bc?.postMessage(ev) } catch {  }
      window.dispatchEvent(new CustomEvent('distorrent:file_announce', { detail: { file_id: fid, name, size, chunks, hash } }))
    } catch {  }
    return Promise.resolve()
  },
  fileRequestChunk: (fileId: string, index: number, holderFp: string) => {
    try {
      const me = store.load()?.fingerprint ?? 'local'
      const ev: any = { type: 'file_chunk_request', file_id: fileId, index, from_fp: me, holder_fp: holderFp }
      emit(ev)
      try { bc?.postMessage(ev) } catch {  }
      window.dispatchEvent(new CustomEvent('distorrent:file_chunk_request', { detail: ev }))
    } catch {  }
    return Promise.resolve()
  },
  fileSendChunk: (targetFp: string, fileId: string, index: number, dataB64: string) => {
    try {
      const me = store.load()?.fingerprint ?? 'local'
      const ev: any = { type: 'file_chunk_data', file_id: fileId, index, data_b64: dataB64, from_fp: me, target_fp: targetFp }
      emit(ev)
      try { bc?.postMessage(ev) } catch {  }
      window.dispatchEvent(new CustomEvent('distorrent:file_chunk_data', { detail: ev }))
    } catch {  }
    return Promise.resolve()
  },

  // Sem disco no navegador: o fileSwarm cai no caminho em memória.
  spoolBegin: () => Promise.reject(new Error('download em disco disponível apenas no app nativo')),
  spoolPut: () => Promise.reject(new Error('download em disco disponível apenas no app nativo')),
  spoolPutBatch: () => Promise.reject(new Error('download em disco disponível apenas no app nativo')),
  spoolGet: () => Promise.resolve(null),
  spoolBitmap: () => Promise.resolve({ have: 0, bitmap_b64: '', dir: '' }),
  spoolFinish: () => Promise.reject(new Error('download em disco disponível apenas no app nativo')),
  spoolDiscard: () => Promise.resolve(),
  spoolStats: () => Promise.resolve({ bytes: 0, entries: 0 }),
  spoolGc: () => Promise.resolve(0),
  downloadDirGet: () => Promise.resolve({ dir: 'Downloads do navegador', is_default: true }),
  downloadDirSet: () => Promise.reject(new Error('escolher pasta só no app nativo — o navegador usa o Downloads dele')),
  downloadDirReset: () => Promise.resolve({ dir: 'Downloads do navegador', is_default: true }),
  downloadDirBrowse: () => Promise.reject(new Error('navegar pastas só no app nativo')),
  downloadDirOpen: () => Promise.reject(new Error('abrir pasta só no app nativo')),
  downloadDirSpace: () => Promise.resolve({ free_bytes: 0, total_bytes: 0 }),
  seedRegister: () => Promise.reject(new Error('semear por caminho só no app nativo')),
  seedUnregister: () => Promise.resolve(),
  seedList: () => Promise.resolve([]),
  seedReadChunk: () => Promise.resolve(null),
  cacheGetTtl: () => Promise.resolve(Number(localStorage.getItem('distorrent:cache:ttl_days') ?? '7') || 7),
  cacheSetTtl: (days) => {
    try { localStorage.setItem('distorrent:cache:ttl_days', String(days)) } catch {  }
    return Promise.resolve()
  },

  serverRulesGet: (cid) => {
    try {
      const raw = localStorage.getItem(`distorrent:rules:${cid}`)
      if (raw) return Promise.resolve(JSON.parse(raw) as ServerRules)
    } catch {  }
    return Promise.resolve({
      community_id: cid, spam_level: 'medium', banned_words: [], blocked_domains: [],
      moderators: [], shadow_banned: [], updated_at: Date.now(),
    })
  },
  serverRulesSet: (rules) => {
    try { localStorage.setItem(`distorrent:rules:${rules.community_id}`, JSON.stringify({ ...rules, updated_at: Date.now() })) } catch {  }
    appendLocalAudit(rules.community_id, 'rules', '', 'regras atualizadas')
    return Promise.resolve()
  },
  auditList: (cid, limit) => {
    try {
      const raw = localStorage.getItem(`distorrent:audit:${cid}`)
      const list = raw ? (JSON.parse(raw) as AuditEntry[]) : []
      return Promise.resolve(list.slice(-(limit ?? 100)).reverse())
    } catch { return Promise.resolve([]) }
  },
  reputationGet: (fp) => {
    try {
      const raw = localStorage.getItem(`distorrent:repute:${fp}`)
      if (raw) {
        const v = JSON.parse(raw) as { trust: ReputationView['trust']; score: number; reports: number }
        return Promise.resolve(v)
      }
    } catch {  }
    return Promise.resolve({ trust: 'new', score: 0, reports: 0 })
  },
  safetyNumber: (peerFp) => {
    const me = store.load()
    if (!me) return Promise.reject(new Error('sem identidade'))
    const pres = getPresenceMap().get(peerFp)
    const peerPub = pres?.pubkey_hex
    if (!peerPub) return Promise.reject(new Error('peer sem chave pública local — verifique no app nativo'))
    return Promise.resolve(formatSafetyNumber(me.fingerprint, me.pubkey_hex, peerFp, peerPub))
  },
  moderate: (cid, action: ModerationAction, target, reason) => {
    appendLocalAudit(cid, action, target, reason ?? '')
    try {
      const cur = JSON.parse(localStorage.getItem(`distorrent:repute:${target}`) ?? '{"trust":"new","score":0,"reports":0}')
      if (action === 'ban') { cur.trust = 'banned'; cur.score = -100 }
      if (action === 'unban' || action === 'unmute') { cur.trust = 'new'; cur.score = 0 }
      if (action === 'mute') { cur.trust = 'suspicious'; cur.score = Math.min(cur.score, -15) }
      localStorage.setItem(`distorrent:repute:${target}`, JSON.stringify(cur))
    } catch {  }
    if (action === 'shadow_ban' || action === 'unshadow') {
      try {
        const rk = `distorrent:rules:${cid}`
        const rules = JSON.parse(localStorage.getItem(rk) ?? '{}') as Partial<ServerRules>
        const list = new Set(rules.shadow_banned ?? [])
        if (action === 'shadow_ban') list.add(target)
        else list.delete(target)
        localStorage.setItem(rk, JSON.stringify({ ...rules, community_id: cid, shadow_banned: [...list] }))
      } catch {  }
    }
    return Promise.resolve()
  },
  reportUser: (targetFp, cid, reason) => {
    appendLocalAudit(cid ?? '', 'report', targetFp, reason ?? '')
    try {
      const cur = JSON.parse(localStorage.getItem(`distorrent:repute:${targetFp}`) ?? '{"trust":"new","score":0,"reports":0}')
      cur.score = Math.max(-100, (cur.score ?? 0) - 10)
      cur.reports = (cur.reports ?? 0) + 1
      if (cur.score <= -30) cur.trust = 'banned'
      else if (cur.score <= -10) cur.trust = 'suspicious'
      localStorage.setItem(`distorrent:repute:${targetFp}`, JSON.stringify(cur))
    } catch {  }
    return Promise.resolve()
  },
  validateName: (kind: NameKind, raw, existing) =>
    Promise.resolve(validateNameLocal(kind, raw, existing ?? [])),
  randomName: () => Promise.resolve(randomNameLocal()),

  messagesWindow: (convId, beforeTs, limit) => Promise.resolve(
    readMsgs()
      .filter((m) => m.conv_id === convId && (beforeTs == null || m.ts < beforeTs))
      .sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1))
      .slice(0, Math.max(1, Math.min(limit, 1000)))
      .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1))
  ),
  stormvaultExport: () => Promise.reject(new Error('Cofre portátil disponível apenas no app nativo (instale o DisTorrent)')),
  stormvaultImportFile: () => Promise.reject(new Error('Cofre portátil disponível apenas no app nativo')),
  stormvaultBackupsList: () => Promise.resolve([]),
  stormvaultBackupNow: () => Promise.reject(new Error('Backups disponíveis apenas no app nativo')),
  stormvaultBackupRestore: () => Promise.reject(new Error('Backups disponíveis apenas no app nativo')),
  stormvaultBackupSetRetention: () => Promise.resolve(),
  stormvaultBackupGetRetention: () => Promise.resolve(7),
  vaultWipe: (confirm) => {
    if (confirm !== 'APAGAR') return Promise.reject(new Error('digite APAGAR para confirmar'))
    try {
      for (const storage of [localStorage, sessionStorage]) {
        const doomed: string[] = []
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i)
          if (k && k.startsWith('distorrent:')) doomed.push(k)
        }
        doomed.forEach((k) => storage.removeItem(k))
      }
    } catch {  }
    return Promise.resolve({ leftovers: [] })
  },
  metricsSnapshot: () => Promise.resolve({
    frames_tx: [0, 0, 0, 0], frames_rx: [0, 0, 0, 0],
    classes: ['realtime', 'control', 'message', 'bulk'],
    bytes_tx: 0, bytes_rx: 0, spam_rejected: 0, messages_in: 0, messages_out: 0,
    cache_hits: 0, cache_misses: 0, vault_ops: 0, rtt_by_peer_ms: {},
  }),
  peerRtt: () => Promise.resolve(null),
  cacheGet: (key) => {
    try { return Promise.resolve(localStorage.getItem(`distorrent:cache:${key}`)) } catch { return Promise.resolve(null) }
  },
  cachePut: (key, dataB64) => {
    try { localStorage.setItem(`distorrent:cache:${key}`, dataB64) } catch {  }
    return Promise.resolve()
  },
  cacheDelete: (key) => {
    try { localStorage.removeItem(`distorrent:cache:${key}`) } catch {  }
    return Promise.resolve()
  },
  cacheStats: () => {
    try {
      let total = 0
      let entries = 0
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith('distorrent:cache:')) {
          entries++
          total += (localStorage.getItem(k) ?? '').length
        }
      }
      return Promise.resolve({ cap_mb: 16, total_bytes: total, entries })
    } catch {
      return Promise.resolve({ cap_mb: 16, total_bytes: 0, entries: 0 })
    }
  },
  cacheSetCap: () => Promise.resolve(),
  mediaSafetyGet: () => Promise.resolve({
    strip_exif: localStorage.getItem('distorrent:media:strip_exif') !== '0',
    block_executables: localStorage.getItem('distorrent:media:block_exec') !== '0',
  }),
  mediaSafetySet: (stripExif, blockExecutables) => {
    try {
      localStorage.setItem('distorrent:media:strip_exif', stripExif ? '1' : '0')
      localStorage.setItem('distorrent:media:block_exec', blockExecutables ? '1' : '0')
    } catch {  }
    return Promise.resolve()
  },
  retentionGet: () => {
    const days = Number(localStorage.getItem('distorrent:retention:days') ?? '30')
    return Promise.resolve({
      days: Number.isFinite(days) ? days : 30,
      servers: localStorage.getItem('distorrent:retention:servers') !== '0',
      groups: localStorage.getItem('distorrent:retention:groups') !== '0',
      dms: localStorage.getItem('distorrent:retention:dms') === '1',
    })
  },
  retentionSet: (days, servers, groups, dms) => {
    try {
      localStorage.setItem('distorrent:retention:days', String(days))
      localStorage.setItem('distorrent:retention:servers', servers ? '1' : '0')
      localStorage.setItem('distorrent:retention:groups', groups ? '1' : '0')
      localStorage.setItem('distorrent:retention:dms', dms ? '1' : '0')
    } catch {  }
    return Promise.resolve({ days, servers, groups, dms })
  },
  retentionRun: () => Promise.resolve(0),
  voiceMediaAvailable: () => Promise.resolve(false),
  voiceMediaStats: () => Promise.resolve(null),
  voiceSetMuted: () => Promise.resolve(),
  voiceSetDeafened: () => Promise.resolve(),
  voiceHangup: () => Promise.resolve(),
  voiceVideoStart: () => Promise.reject(new Error('vídeo nativo indisponível no navegador')),
  voiceVideoStop: () => Promise.resolve(),
  voiceVideoFrame: () => Promise.resolve(null),
  voiceMicTestStart: () => Promise.reject(new Error('teste de mic nativo indisponível no navegador')),
  voiceMicTestLevel: () => Promise.resolve(0),
  voiceMicTestStop: () => Promise.resolve(),
  voiceMicName: () => Promise.resolve(''),

  react: async (convId, msgId, emoji, superReact) => {
    const all = loadAll<ReactionSummary[]>(RX_BASE)
    let list = all[msgId] ?? []
    const mineIdx = list.findIndex(r => r.emoji === emoji && r.reactors.includes(meFp()))
    if (mineIdx >= 0) {
      const r = list[mineIdx]
      r.reactors = r.reactors.filter(f => f !== meFp())
      r.count = r.reactors.length
      r.mine = false
      if (superReact && (r.super_count ?? 0) > 0) r.super_count = (r.super_count ?? 0) - 1
      if (r.count === 0) list = list.filter((_, i) => i !== mineIdx)
    } else {
      const hit = list.find(r => r.emoji === emoji)
      if (hit) {
        hit.count++; hit.mine = true; hit.reactors.push(meFp())
        if (superReact) hit.super_count = (hit.super_count ?? 0) + 1
      } else {
        list.push({
          msg_id: msgId, emoji, count: 1, reactors: [meFp()], mine: true,
          super_count: superReact ? 1 : 0,
        })
      }
    }
    all[msgId] = list
    saveAll(RX_BASE, all)
    emit({ type: 'reaction_changed', msg_id: msgId, conv_id: convId, emoji, add: mineIdx < 0, reactor_fp: meFp() })
    return mineIdx < 0
  },
  reactions: async (msgId) => (loadAll<ReactionSummary[]>(RX_BASE)[msgId] ?? []).map(r => ({
    ...r, mine: r.reactors.includes(meFp()),
  })),
  reactionsBulk: async (msgIds) => {
    const all = loadAll<ReactionSummary[]>(RX_BASE)
    const me = meFp()
    const out: ReactionSummary[] = []
    for (const id of msgIds) for (const r of (all[id] ?? [])) out.push({ ...r, mine: r.reactors.includes(me) })
    return out
  },
  reply: async (convId, msgId, replyTo) => {
    const all = loadAll<MsgMetaView>(META_BASE)
    all[msgId] = { ...blankMeta(msgId, convId), reply_to: replyTo }
    saveAll(META_BASE, all)
    emit({ type: 'message_reply', msg_id: msgId, reply_to: replyTo })
  },
  editMessage: async (convId, msgId, body) => {
    const msgs = readMsgs()
    const m = msgs.find(x => x.id === msgId)
    if (!m) throw new Error('mensagem inexistente')
    if (m.author_fp !== meFp()) throw new Error('só o autor edita')
    const all = loadAll<MsgMetaView>(META_BASE)
    const cur = all[msgId] ?? blankMeta(msgId, convId)
    all[msgId] = { ...cur, edited_body: body, edited_at: Date.now() }
    saveAll(META_BASE, all)
    emit({ type: 'message_edited', msg_id: msgId, conv_id: convId, body })
  },
  deleteMessage: async (convId, msgId) => {
    const all = loadAll<MsgMetaView>(META_BASE)
    const cur = all[msgId] ?? blankMeta(msgId, convId)
    all[msgId] = { ...cur, deleted: true }
    saveAll(META_BASE, all)
    emit({ type: 'message_deleted', msg_id: msgId, conv_id: convId })
  },
  pin: async (convId, msgId, pinned) => {
    const all = loadAll<MsgMetaView>(META_BASE)
    const cur = all[msgId] ?? blankMeta(msgId, convId)
    all[msgId] = { ...cur, pinned, pinned_by: meFp() }
    saveAll(META_BASE, all)
    emit({ type: 'message_pinned', msg_id: msgId, conv_id: convId, pinned })
  },
  pins: async (convId) => {
    const all = loadAll<MsgMetaView>(META_BASE)
    return Object.values(all).filter(m => m.conv_id === convId && m.pinned)
  },
  metaBulk: async (msgIds) => {
    const all = loadAll<MsgMetaView>(META_BASE)
    return msgIds.map(id => all[id] ?? blankMeta(id, ''))
  },
  messageReceipts: async (msgIds) => {
    // Modo navegador não tem peer real: só existe o que este app registrou.
    const all = loadAll<{ fp?: string; read_at?: number }>('distorrent:extras:receipts:')
    const out: [string, string, number][] = []
    for (const id of msgIds) {
      const r = all[id]
      if (r && r.fp && typeof r.read_at === 'number') out.push([id, r.fp, r.read_at])
    }
    return out
  },
  effectiveBodies: async (msgIds) => {
    const all = loadAll<MsgMetaView>(META_BASE)
    return msgIds.flatMap(id => {
      const m = readMsgs().find(x => x.id === id)
      if (!m) return []
      const meta = all[id]
      return [[id, meta?.edited_body ? meta.edited_body : m.body] as [string, string]]
    })
  },
  forward: async (srcMsgId, targetConv, targetChannel, fromLabel) => {
    const all = loadAll<MsgMetaView>(META_BASE)
    const src = readMsgs().find(x => x.id === srcMsgId)
    if (!src) throw new Error('mensagem inexistente')
    const body = all[srcMsgId]?.edited_body || src.body
    const id = `fwd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const msg: StoredMessage = {
      id, conv_id: targetConv, author_fp: meFp(), body, ts: Date.now(),
      sig: '', direction: 'out', status: 'delivered',
    }
    writeMsgs([...readMsgs(), msg])
    const meta = all[id] ?? blankMeta(id, targetConv)
    all[id] = { ...meta, forwarded_from: fromLabel }
    saveAll(META_BASE, all)
    void targetChannel
    return msg
  },

  readSet: async (convId, ts) => {
    const all = loadAll<ReadCursor>(READ_BASE)
    const cur = all[convId]?.last_read_ts ?? 0
    all[convId] = { conv_id: convId, last_read_ts: Math.max(cur, ts), updated_at: Date.now() }
    saveAll(READ_BASE, all)
  },
  readAll: async () => Object.values(loadAll<ReadCursor>(READ_BASE)),
  unreadCount: async (convId) => {
    const cur = loadAll<ReadCursor>(READ_BASE)[convId]?.last_read_ts ?? 0
    return readMsgs().filter(m => m.conv_id === convId && m.ts > cur).length
  },
  unreadMentions: async () => {
    const me = meFp()
    const cursors = loadAll<ReadCursor>(READ_BASE)
    const metas = loadAll<MsgMetaView>(META_BASE)
    return readMsgs().filter(m =>
      m.author_fp !== me && metas[m.id]?.mentioned &&
      m.ts > (cursors[m.conv_id]?.last_read_ts ?? 0)).length
  },
  dmIntroState: async (convId) => {
    const conv = readConvos().find(c => c.id === convId)
    const friends = getFriends('accepted')
    const isFriend = !!conv && friends.some(f => f.fp === conv.peer_fp)
    const limit = 3
    const key = `distorrent:intro:${convId}`
    const usados = Math.max(0, Number(readString(key) ?? 0))
    const used = isFriend ? 0 : Math.min(usados, limit)
    return { used, limit, is_friend: isFriend, remaining: isFriend ? limit : Math.max(0, limit - used) }
  },

  backgroundPrefs: async () => ({
    close_to_tray: false,
    start_minimized: false,
    autostart: false,
    tray: false,
    notification_permission: 'unsupported',
  }),
  backgroundPrefsSet: async () => {},
  autostartGet: async () => false,
  autostartSet: async () => false,
  autostartEnsure: async () => false,
  notificationShow: async () => {},
  notificationCancel: async () => {},
  notificationCancelAll: async () => {},
  notificationPermission: async () => 'unsupported',
  notificationRequestPermission: async () => 'unsupported',
  notifyPrefsSet: async () => {},
  notifyUiAlive: async () => {},
  backgroundServiceSet: async () => false,
  callPendingAction: async () => ({ action: '', call_id: '' }),
  callNotifyShow: async () => {},
  callNotifyCancel: async () => {},
  appShowWindow: async () => {},
  appHideToTray: async () => {},
  hideShareBar: async () => {},
  shareBarWatch: async () => {},
  windowToggleFullscreen: async () => {
    try {
      if (typeof document === 'undefined') return false
      if (document.fullscreenElement) { await document.exitFullscreen?.(); return false }
      await document.documentElement.requestFullscreen?.()
      return true
    } catch { return false }
  },
  appQuit: async () => {},
  backgroundSetConnection: async () => {},

  presenceSet: async (status, custom, customEmoji) => {
    const all = loadAll<PresenceView>(PRESENCE_BASE)
    all[meFp()] = { fp: meFp(), status, custom, custom_emoji: customEmoji, updated_at: Date.now() }
    saveAll(PRESENCE_BASE, all)
    emit({ type: 'presence_changed', fp: meFp(), status, custom, custom_emoji: customEmoji })
  },
  presenceList: async () => Object.values(loadAll<PresenceView>(PRESENCE_BASE)).map((presence) => {
    if (presence.status !== 'offline' && presence.updated_at < Date.now() - PRESENCE_TTL_MS) {
      return { ...presence, status: 'offline' as PresenceStatus, custom: '', custom_emoji: '' }
    }
    return presence
  }),
  presenceGet: async (fp) => {
    const presence = loadAll<PresenceView>(PRESENCE_BASE)[fp]
    if (!presence) return {
      fp, status: 'offline' as PresenceStatus, custom: '', custom_emoji: '', updated_at: 0,
    }
    if (presence.status !== 'offline' && presence.updated_at < Date.now() - PRESENCE_TTL_MS) {
      return { ...presence, status: 'offline' as PresenceStatus, custom: '', custom_emoji: '' }
    }
    return presence
  },
  profileSet: async (patch) => {
    const all = loadAll<ProfileView>(PROFILE_BASE)
    const me = meFp()
    const cur = all[me] ?? { fp: me, display_name: '', about: '', avatar_b64: '', banner_b64: '', accent: '', updated_at: 0 }
    const next: ProfileView = {
      fp: me,
      display_name: patch.display_name,
      about: patch.about,
      avatar_b64: patch.remove_avatar ? '' : (patch.avatar_b64 || cur.avatar_b64),
      banner_b64: patch.remove_banner ? '' : (patch.banner_b64 || cur.banner_b64),
      accent: patch.accent,
      updated_at: Date.now(),
      rev: (cur.rev ?? 0) + 1,
      profile_theme: patch.profile_theme ?? cur.profile_theme ?? '',
      avatar_effect: patch.avatar_effect ?? cur.avatar_effect ?? '',
      decoration: patch.decoration ?? cur.decoration ?? '',
    }
    next.content_hash = profileContentHash(next)
    all[me] = next
    saveAll(PROFILE_BASE, all)
    emit({ type: 'profile_changed', fp: me, profile: next })
    return next
  },
  profileGet: async (fp) => loadAll<ProfileView>(PROFILE_BASE)[fp] ?? {
    fp, display_name: '', about: '', avatar_b64: '', banner_b64: '', accent: '', updated_at: 0,
  },
  profileList: async () => Object.values(loadAll<ProfileView>(PROFILE_BASE)),
  profileSyncNow: async () => {  },
  nicknameSet: async (communityId, fp, nickname) => {
    const all = loadAll<string>('social:nicknames')
    all[`${communityId}:${fp}`] = nickname
    saveAll('social:nicknames', all)
  },
  nicknameGet: async (communityId, fp) => loadAll<string>('social:nicknames')[`${communityId}:${fp}`] ?? '',

  searchMessages: async (q) => {
    const metas = loadAll<MsgMetaView>(META_BASE)
    const needle = q.text.trim().toLowerCase()
    const hits: SearchHit[] = []
    for (const m of readMsgs()) {
      if (metas[m.id]?.deleted) continue
      if (q.from && m.author_fp !== q.from) continue
      if (q.conv && m.conv_id !== q.conv) continue
      if (q.before > 0 && m.ts >= q.before) continue
      if (needle && !m.body.toLowerCase().includes(needle)) continue
      if (q.has === 'link' && !/https?:\/\//.test(m.body)) continue
      if (q.has === 'file' && !m.body.includes('"file"')) continue
      if (q.has === 'mention' && !m.body.includes('@')) continue
      hits.push({ id: m.id, conv_id: m.conv_id, author_fp: m.author_fp, body: m.body, ts: m.ts, direction: m.direction, community_id: '', channel_id: m.conv_id })
      if (hits.length >= (q.limit || 50)) break
    }
    return hits
  },
  messagesAround: async (convId, ts, limit) => {
    const all = readMsgs().filter(m => m.conv_id === convId)
    const before = all.filter(m => m.ts < ts).slice(-Math.floor(limit / 2))
    const after = all.filter(m => m.ts >= ts).slice(0, Math.floor(limit / 2))
    return [...before, ...after]
  },

  threadCreate: async (communityId, parentChannel, name, kind = 'thread', tags = '') => {
    const all = loadAll<ThreadView>(THREADS_BASE)
    const t: ThreadView = {
      id: `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      community_id: communityId, parent_channel: parentChannel, name, author_fp: meFp(),
      created_at: Date.now(), archived: false, kind, tags,
    }
    all[t.id] = t
    saveAll(THREADS_BASE, all)
    emit({ type: 'thread_created', community_id: communityId, thread: t })
    return t
  },
  threadList: async (communityId, parentChannel) =>
    Object.values(loadAll<ThreadView>(THREADS_BASE))
      .filter(t => t.community_id === communityId && t.parent_channel === parentChannel && !t.archived),
  threadMessages: async (threadId, limit = 200) =>
    readMsgs().filter(m => (m as unknown as { thread_id?: string }).thread_id === threadId).slice(-limit),
  threadSend: async (communityId, threadId, body) => {
    const msg: StoredMessage = {
      id: `th-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      conv_id: threadId, author_fp: meFp(), body, ts: Date.now(),
      sig: '', direction: 'out', status: 'delivered',
    } as StoredMessage & { thread_id: string }
    ;(msg as unknown as { thread_id: string }).thread_id = threadId
    writeMsgs([...readMsgs(), msg])
    void communityId
    return msg
  },
  threadArchive: async (threadId, archived) => {
    const all = loadAll<ThreadView>(THREADS_BASE)
    if (all[threadId]) all[threadId] = { ...all[threadId], archived }
    saveAll(THREADS_BASE, all)
  },

  ban: async (communityId, fp, untilMs, reason) => {
    const all = loadAll<Record<string, BanView>>(BANS_BASE)
    all[communityId] = all[communityId] ?? {}
    all[communityId][fp] = { fp, reason, actor_fp: meFp(), created_at: Date.now(), until_ms: untilMs }
    saveAll(BANS_BASE, all)
    emit({ type: 'moderation_applied', community_id: communityId, target_fp: fp, kind: 'ban', until_ms: untilMs, reason })
  },
  unban: async (communityId, fp) => {
    const all = loadAll<Record<string, BanView>>(BANS_BASE)
    if (all[communityId]) delete all[communityId][fp]
    saveAll(BANS_BASE, all)
  },
  timeout: async (communityId, fp, untilMs, reason) => {
    const all: Record<string, Record<string, BanView>> = loadAll<Record<string, BanView>>(BANS_BASE)
    all[communityId] = all[communityId] ?? {}
    all[communityId]['t:' + fp] = { fp, reason, actor_fp: meFp(), created_at: Date.now(), until_ms: untilMs }
    saveAll(BANS_BASE, all)
    emit({ type: 'moderation_applied', community_id: communityId, target_fp: fp, kind: 'timeout', until_ms: untilMs, reason })
  },
  banList: async (communityId) => {
    const now = Date.now()
    return Object.values(loadAll<Record<string, BanView>>(BANS_BASE)[communityId] ?? {})
      .filter(b => !b.fp.startsWith('t:') && !(b.until_ms > 0 && b.until_ms < now))
  },
  timeoutList: async (communityId) => {
    const now = Date.now()
    return Object.values(loadAll<Record<string, BanView>>(BANS_BASE)[communityId] ?? {})
      .filter(b => b.fp.startsWith('t:') && b.until_ms > now)
  },
  channelCfgSet: async (_communityId, channelId, slowmodeSecs, nsfw) => {
    const all = loadAll<{ slowmode: number; nsfw: boolean }>(CFG_BASE)
    all[channelId] = { slowmode: slowmodeSecs, nsfw }
    saveAll(CFG_BASE, all)
  },
  channelCfgGet: async (channelId) => loadAll<{ slowmode: number; nsfw: boolean }>(CFG_BASE)[channelId]?.slowmode ?? 0,

  pollCreate: async (communityId, channelId, question, options, multi, endsAt) => {
    const all = loadAll<PollView>(POLLS_BASE)
    const p: PollView = {
      id: `pl-${Date.now().toString(36)}`, community_id: communityId, channel_id: channelId,
      question, options, multi, author_fp: meFp(), created_at: Date.now(), ends_at: endsAt, closed: false,
    }
    all[p.id] = p
    saveAll(POLLS_BASE, all)
    emit({ type: 'poll_updated', community_id: communityId, channel_id: channelId, poll_id: p.id })
    return p
  },
  pollList: async (communityId, channelId) =>
    Object.values(loadAll<PollView>(POLLS_BASE)).filter(p => p.community_id === communityId && p.channel_id === channelId),
  pollVote: async (communityId, channelId, pollId, optionIdx) => {
    const all = loadAll<PollView>(POLLS_BASE)
    const p = all[pollId]
    if (!p) throw new Error('enquete inexistente')
    if (p.closed) throw new Error('enquete encerrada')
    if (optionIdx < 0 || optionIdx >= p.options.length) throw new Error('opção inválida')
    const votes: Record<string, number[]> = loadAll<number[]>('social:votes')
    votes[pollId] = [optionIdx]
    saveAll('social:votes', votes)
    emit({ type: 'poll_updated', community_id: communityId, channel_id: channelId, poll_id: pollId })
  },
  pollTally: async (pollId) => {
    const chosen: number[] = loadAll<number[]>('social:votes')[pollId] ?? []
    const poll = loadAll<PollView>(POLLS_BASE)[pollId]
    const nOpts = poll?.options?.length ?? 0
    const counts = new Array<number>(nOpts).fill(0)
    for (const idx of chosen) {
      if (idx >= 0 && idx < nOpts) counts[idx]++
    }
    return { counts, total: chosen.length, mine: chosen }
  },

  eventUpsert: async (ev) => {
    const all = loadAll<EventView>(EVENTS_BASE)
    all[ev.id] = { ...ev, entity_fp: meFp() }
    saveAll(EVENTS_BASE, all)
    emit({ type: 'event_updated', community_id: ev.community_id, event_id: ev.id })
  },
  eventList: async (communityId) => Object.values(loadAll<EventView>(EVENTS_BASE)).filter(e => e.community_id === communityId),
  eventInterest: async (communityId, eventId) => {
    const all = loadAll<EventView>(EVENTS_BASE)
    const e = all[eventId]
    if (!e) return
    const me = meFp()
    e.interested = e.interested.includes(me) ? e.interested.filter(f => f !== me) : [...e.interested, me]
    all[eventId] = e
    saveAll(EVENTS_BASE, all)
  },
  eventDelete: async (communityId, eventId) => {
    const all = loadAll<EventView>(EVENTS_BASE)
    delete all[eventId]
    saveAll(EVENTS_BASE, all)
  },

  emojiUpsert: async (e) => {
    const all = loadAll<EmojiView>(EMOJIS_BASE)
    all[e.id] = e
    saveAll(EMOJIS_BASE, all)
    emit({ type: 'emoji_updated', community_id: e.community_id, emoji_id: e.id })
  },
  emojiList: async (communityId) => Object.values(loadAll<EmojiView>(EMOJIS_BASE)).filter(e => e.community_id === communityId),
  emojiDelete: async (communityId, id) => {
    const all = loadAll<EmojiView>(EMOJIS_BASE)
    delete all[id]
    saveAll(EMOJIS_BASE, all)
  },

  bookmarkSet: async (convId, name, payload) => {
    const all: Record<string, Record<string, string>> = loadAll<Record<string, string>>('social:bookmarks')
    all[convId] = all[convId] ?? {}
    all[convId][name] = payload
    saveAll('social:bookmarks', all)
  },
  bookmarkList: async (convId) => Object.entries(loadAll<Record<string, string>>('social:bookmarks')[convId] ?? {}),
}

function appendLocalAudit(communityId: string, action: string, target: string, reason: string) {
  try {
    const k = `distorrent:audit:${communityId}`
    const list = JSON.parse(localStorage.getItem(k) ?? '[]') as AuditEntry[]
    const me = store.load()?.fingerprint ?? 'local'
    list.push({
      id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      community_id: communityId, actor_fp: me, action, target_fp: target,
      reason: reason.slice(0, 280), created_at: Date.now(),
    })
    localStorage.setItem(k, JSON.stringify(list.slice(-500)))
  } catch {  }
}

async function formatSafetyNumber(fpA: string, pubA: string, fpB: string, pubB: string): Promise<string> {
  const [x, y] = fpA <= fpB ? [[fpA, pubA], [fpB, pubB]] : [[fpB, pubB], [fpA, pubA]]
  const data = new TextEncoder().encode(`storm/safety-number/v1|${x[0]}|${x[1]}|${y[0]}|${y[1]}`)
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource)
  const v = new DataView(d)
  const groups: string[] = []
  for (let i = 0; i < 8; i++) groups.push(String(v.getUint32(i * 4) % 100_000).padStart(5, '0'))
  return groups.join(' ')
}

export type { EngineEvent }
