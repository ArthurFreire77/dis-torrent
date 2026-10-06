// Modo navegador (npm run dev sem Tauri): 100% funcional localmente.
// - Identidade ed25519 REAL
// - Mensagens DM e canal funcionais (persistidas em localStorage, broadcast cross-tab)
// - Presença real via heartbeat + BroadcastChannel (online/offline correto)
// - Eventos engine simulados com fidelidade ao forge-core (message_new, message_status, peer_online/offline, etc)
// Não inventa peers fake: online = heartbeat recente (<15s) ou BroadcastChannel ativo.

import type {
  AuditEntry,
  Conversation,
  EngineEvent,
  ForgeServices,
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
  PollTally,
  EventView,
  EmojiView,
  ReadCursor,
  SearchQuery,
  SearchHit,
} from './models'
import { validateNameLocal, randomNameLocal } from '../core/security/names'
import { createIdentity, type UserIdentity } from '../core/identity/identity'
import { LocalDriver } from '../core/storage/localDriver'
import { SessionDriver } from '../core/storage/sessionDriver'
import { IdentityStore } from '../core/storage/identityStore'
import * as LX from './localExtras'

const sharedDriver = new LocalDriver()
const identityDriver = new SessionDriver()
// migração: se já existe identidade em localStorage (antigo) e não em sessionStorage, copia
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
} catch { /* ignore */ }
const store = new IdentityStore(identityDriver)
// driver alias para compatibilidade legada (usado em helpers antigos) — aponta para sharedDriver
const driver = sharedDriver

function nsKey(base: string): string {
  const fp = store.load()?.fingerprint
  return fp ? `${base}:${fp}` : base
}

// helpers com namespace por fingerprint + migração de chaves antigas (sem namespace e double prefix)
function getNamespaced<T>(base: string, fallbackKeys: string[] = []): T | null {
  const ns = nsKey(base)
  let v = sharedDriver.get<T>(ns)
  if (v !== null) return v
  for (const k of fallbackKeys) {
    try {
      // tenta via sharedDriver com chave direta (ex: 'friends:pending_in')
      v = sharedDriver.get<T>(k)
      if (v !== null) {
        // migra para namespaced
        sharedDriver.set(ns, v)
        return v
      }
      // tenta double prefix legado 'forge:forge:...' via localStorage direto
      const doubleKey = `forge:forge:${k}`
      const raw = localStorage.getItem(doubleKey)
      if (raw) {
        const parsed = JSON.parse(raw) as T
        sharedDriver.set(ns, parsed)
        localStorage.removeItem(doubleKey)
        return parsed
      }
      const singleRaw = localStorage.getItem(`forge:${k}`)
      if (singleRaw) {
        const parsed = JSON.parse(singleRaw) as T
        sharedDriver.set(ns, parsed)
        return parsed
      }
    } catch { /* ignore */ }
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

// friends helpers namespaced
function getFriends(status: string): FriendView[] {
  return getNamespaced<FriendView[]>(`friends:${status}`, [`friends:${status}`, `forge:friends:${status}`]) ?? []
}
function setFriends(status: string, list: FriendView[]): void {
  setNamespaced(`friends:${status}`, list)
}

// ---------- Event bus + BroadcastChannel ----------
type CB = (ev: EngineEvent) => void
const listeners = new Set<CB>()
// Dedupe: eventos entregues via `listeners` não devem ser re-entregues via
// window 'forge:bus' (emit faz os dois). Marcamos o objeto; o listener de
// window em subscribe() pula os marcados, mas ainda recebe eventos externos
// (ex.: testes que disparam window.dispatchEvent direto).
const viaListeners = new WeakSet<object>()
let bc: BroadcastChannel | null = null
try {
  if (typeof BroadcastChannel !== 'undefined') {
    bc = new BroadcastChannel('forge-bus-v2')
    bc.onmessage = (ev) => {
      const data = ev.data as EngineEvent
      // entrega local sem re-broadcast
      for (const cb of listeners) {
        try { cb(data) } catch { /* ignore */ }
      }
      viaListeners.add(data)
      // também dispara window event para fileSwarm/voice compat
      try { window.dispatchEvent(new CustomEvent('forge:bus', { detail: data })) } catch { /* ignore */ }
      // mensagens cross-tab: persistência já compartilhada via localStorage,
      // mas para DM com direction invertida, tratamos aqui
      handleIncomingBroadcast(data)
    }
  }
} catch { bc = null }

function emit(ev: EngineEvent) {
  for (const cb of listeners) try { cb(ev) } catch { /* ignore */ }
  viaListeners.add(ev)
  try { bc?.postMessage(ev) } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent('forge:bus', { detail: ev })) } catch { /* ignore */ }
}

function isChannelMessageId(convId: string): boolean {
  try {
    const raw = localStorage.getItem('forge:extras:communities') ?? '[]'
    const list = JSON.parse(raw) as any[]
    for (const c of list) if (c.channels?.some(([cid]: any) => cid === convId)) return true
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) ?? ''
      if (k.startsWith('forge:extras:channels:')) {
        const arr = JSON.parse(localStorage.getItem(k) ?? '[]') as any[]
        if (arr.some((x: any) => x.id === convId)) return true
      }
    }
  } catch { /* ignore */ }
  return false
}

function handleIncomingBroadcast(ev: EngineEvent) {
  // amizade: pedido chegando de outra aba → vira pending_in REAL nesta aba
  if ((ev as any).type === 'friend_request_in') {
    const { fp, nickname } = ev as any
    const me = store.load()
    if (!me || !fp || fp === me.fingerprint) return
    const pendingIn = getFriends('pending_in')
    if (pendingIn.some(f => f.fp === fp)) return
    setFriends('pending_in', [...pendingIn, { fp, nickname: nickname || fp.slice(0, 8), addr: 'local', pubkey_hex: '', last_seen: Date.now() }])
    for (const cb of listeners) try { cb({ type: 'friend_request_in', fp, nickname } as any) } catch { /* ignore */ }
  }
  // amizade: a outra aba ACEITOU meu pedido → pending_out vira accepted + DM criada
  if ((ev as any).type === 'friend_accepted') {
    const { fp, nickname } = ev as any // fp = quem aceitou
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
      for (const cb of listeners) try { cb({ type: 'friend_accepted', fp, nickname } as any) } catch { /* ignore */ }
    }
  }
  // Quando outra aba envia message_new, a aba receptora deve armazenar a cópia com direction='in' se for para ela
  if ((ev as any).type === 'message_new') {
    const m = ev as unknown as StoredMessage & { type: 'message_new' }
    // ignora mensagens de canal — já tratadas via channel_message_new
    if (m.conv_id && isChannelMessageId(m.conv_id)) return
    const me = store.load()
    if (!me) return
    if (typeof m.author_fp !== 'string' || typeof m.id !== 'string') return // evento corrompido: ignora
    // se a mensagem é de outro autor e a conversa é comigo (conv contém meu fp ou peer_fp = meu fp)
    // No browser, conv.id = 'local-' + peerFp.slice(0,8). Então verificamos peer_fp
    const isForMe = m.author_fp !== me.fingerprint
    if (!isForMe) return
    // verifica se já temos essa mensagem (dedupe por id)
    const all = readMsgs()
    if (all.some(x => x.id === m.id)) return
    // determina conv correspondente no receptor: precisa existir conv com peer = author
    const convs = readConvos()
    let targetConv = convs.find(c => c.peer_fp === m.author_fp)
    if (!targetConv) {
      // cria conversa automaticamente se for amigo aceito ou mensagem espontânea
      const title = m.author_fp.slice(0, 8)
      targetConv = { id: `local-${m.author_fp.slice(0, 8)}`, kind: 'dm', title, peer_fp: m.author_fp, created_at: Date.now() }
      writeConvos([targetConv, ...convs])
      emit({ type: 'peer_discovered', fp: m.author_fp, nickname: title, addr: 'local' })
    }
    const inbound: StoredMessage = { ...m, conv_id: targetConv.id, direction: 'in', status: 'ok' }
    // garante conv_id consistente com o receptor
    writeMsgs([...all, inbound])
    // entrega local sem loop de broadcast — marca viaListeners p/ não duplicar no window
    const inboundEv: any = { ...inbound, type: 'message_new' }
    for (const cb of listeners) try { cb(inboundEv) } catch { /* ignore */ }
    viaListeners.add(inboundEv)
    try { window.dispatchEvent(new CustomEvent('forge:bus', { detail: inboundEv })) } catch { /* ignore */ }
  }
  // grupo: a aba criadora persiste a conversa no PRÓPRIO namespace (por fp) e
  // anuncia via group_synced — o receptor cria o espelho no namespace dele.
  if ((ev as any).type === 'group_synced') {
    const { conv_id, title } = ev as any
    if (!conv_id) return
    const me = store.load()
    if (!me) return
    let members: [string, string][]
    try { members = JSON.parse(localStorage.getItem(`forge:extras:group_members:${conv_id}`) ?? '[]') } catch { members = [] }
    const isMember = members.some(([fp]) => fp === me.fingerprint)
    if (!isMember) return
    const convs = readConvos()
    if (!convs.some(c => c.id === conv_id)) {
      writeConvos([{ id: conv_id, kind: 'group', title: title || 'Grupo', peer_fp: '', created_at: Date.now() }, ...convs])
    }
    const gsEv: any = { type: 'group_synced', conv_id, title: title || 'Grupo' }
    for (const cb of listeners) try { cb(gsEv) } catch { /* ignore */ }
    viaListeners.add(gsEv)
    try { window.dispatchEvent(new CustomEvent('forge:bus', { detail: gsEv })) } catch { /* ignore */ }
  }
  // canal: replica channel message para outras abas se ainda não tiver
  if ((ev as any).type === 'channel_message_new') {
    const { channelId, msg } = ev as any
    void channelId
    const m = (msg ?? {}) as Partial<StoredMessage>
    if (typeof m.id !== 'string' || typeof m.author_fp !== 'string') return // evento corrompido: ignora sem quebrar o bus
    const all = readMsgs()
    if (all.some(x => x.id === m.id)) return
    const me = store.load()
    const cloned: StoredMessage = { ...(msg as StoredMessage), direction: (msg as StoredMessage).author_fp === me?.fingerprint ? 'out' : 'in' } as any
    writeMsgs([...all, cloned])
    const chEv: any = { ...cloned, type: 'message_new' }
    for (const cb of listeners) try { cb(chEv) } catch { /* ignore */ }
    viaListeners.add(chEv)
    try { window.dispatchEvent(new CustomEvent('forge:bus', { detail: chEv })) } catch { /* ignore */ }
  }
}

// ---------- Presença (heartbeat) ----------
const PRESENCE_PREFIX = 'forge:presence:'
const PRESENCE_TTL_MS = 15000
let heartbeatTimer: number | null = null

function presenceKey(fp: string) { return PRESENCE_PREFIX + fp }

function touchPresence() {
  const me = store.load()
  if (!me) return
  const payload = { fp: me.fingerprint, nickname: me.nickname, pubkey_hex: me.pubkey_hex, ts: Date.now() }
  try { localStorage.setItem(presenceKey(me.fingerprint), JSON.stringify(payload)) } catch { /* ignore */ }
  try { localStorage.setItem('forge:presence:heartbeat', String(Date.now())) } catch { /* ignore */ }
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
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
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
      // identidade removida — para heartbeat
      stopHeartbeat()
      return
    }
    touchPresence()
    flushPendingFriendRequests()
    // limpa presenças expiradas e notifica peer_offline se necessário
    const now = Date.now()
    const map = getPresenceMap()
    for (const [fp, v] of map) {
      if (now - v.ts > PRESENCE_TTL_MS + 5000) {
        try { localStorage.removeItem(presenceKey(fp)) } catch { /* ignore */ }
        emit({ type: 'peer_offline', fp })
        emit({ type: 'state_changed', state: 'DISCONNECTED', online_peers: onlineCount() })
      }
    }
  }, 2000) as unknown as number
  // marca online imediatamente
  window.addEventListener('beforeunload', onBeforeUnload)
}

function onBeforeUnload() {
  const me = store.load()
  if (me) try { localStorage.removeItem(presenceKey(me.fingerprint)) } catch { /* ignore */ }
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

// inicia heartbeat se já houver identidade carregada
try { if (store.load()) ensureHeartbeat() } catch { /* ignore */ }

// Escuta storage events para sincronizar presença e mensagens entre abas sem BroadcastChannel
// Handlers nomeados + teardown explícito: evita duplicar listeners em HMR/StrictMode
// (listeners anônimos sem cleanup causavam flicker ONLINE/OFFLINE por emit duplicado).
function onBrowserStorageEvent(e: StorageEvent) {
  if (!e.key) return
  if (e.key.startsWith(PRESENCE_PREFIX)) {
    // presença mudou
    const fp = e.key.slice(PRESENCE_PREFIX.length)
    if (e.newValue) {
      try {
        const v = JSON.parse(e.newValue)
        emit({ type: 'peer_online', fp, nickname: v?.nickname ?? fp.slice(0, 8) })
        emit({ type: 'peer_discovered', fp, nickname: v?.nickname ?? fp.slice(0, 8), addr: 'local' })
        flushPendingFriendRequests()
      } catch { /* ignore */ }
    } else {
      emit({ type: 'peer_offline', fp })
    }
    emit({ type: 'state_changed', state: store.load() ? 'CONNECTED' : 'DISCONNECTED', online_peers: onlineCount() })
  }
  if (e.key === 'forge:messages' || e.key === 'forge:conversations') {
    // outra aba escreveu mensagens/conversas — notifica listeners para refresh
    // não faz broadcast adicional, apenas sinaliza
  }
}

function onLegacyFriendRequest() { /* mantém compat */ }

if (typeof window !== 'undefined') {
  window.addEventListener('storage', onBrowserStorageEvent)
  // fallback BroadcastChannel via CustomEvent 'forge:friend_request' legado
  window.addEventListener('forge:friend_request' as any, onLegacyFriendRequest as EventListener)
}

export function disposeBrowserGlobalListeners() {
  if (typeof window === 'undefined') return
  window.removeEventListener('storage', onBrowserStorageEvent)
  window.removeEventListener('forge:friend_request' as any, onLegacyFriendRequest as EventListener)
}

// HMR (Vite): descarrega listeners globais no hot-reload para não duplicar emits.
try {
  const hot = (import.meta as any)?.hot
  if (hot?.dispose) hot.dispose(() => disposeBrowserGlobalListeners())
} catch { /* ignore */ }

// reenvia pedidos pendentes cujo peer ficou online
function flushPendingFriendRequests() {
  const pendingOut = getFriends('pending_out')
  const me = store.load()
  if (!me || pendingOut.length === 0) return
  for (const p of pendingOut) {
    if (isOnline(p.fp)) {
      try { bc?.postMessage({ type: 'friend_request_in', fp: me.fingerprint, nickname: me.nickname }) } catch { /* ignore */ }
      emit({ type: 'peer_discovered' as any, fp: p.fp, nickname: p.nickname, addr: 'local' } as any)
    }
  }
}

// ---------- Helpers mensagem ----------
function genMsgId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function pushMessageDirect(msg: StoredMessage) {
  const all = readMsgs()
  writeMsgs([...all, msg])
}

// ---------- Implementação ForgeServices ----------

// =====================================================================
// CAMADA SOCIAL v3 — implementação local (localStorage + BroadcastChannel).
// Mesma OBSERVÁVEL das commands nativas: a UI chama exatamente o mesmo
// contrato e não muda de caminho entre navegador e app.
// =====================================================================

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
export const browserServices: ForgeServices = {
  kind: 'browser',

  version: async () => '0.2.0-web',

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

  // Endereços locais. No browser puro o IP de LAN não é descobrível com
  // segurança (WebRTC painfully). `localhost` é honesto; `lan` fica null e a
  // UI diz que não há endereço de rede disponível — melhor que inventar um.
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

    // 1) Amigos aceitos → estado baseado em presença real
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
    // 2) Pendentes inbound também aparecem como peers descobertos (para UI de solicitações)
    // não adiciona como peer full, mas garante que peersList contenha descoberta para badge
    // 3) Descobertos via presença que não são amigos → mostra como peer descoberto (permite adicionar)
    for (const [fp, pres] of presence) {
      if (me && fp === me.fingerprint) continue
      if (out.some(p => p.fp === fp)) continue
      // se já é amigo (accepted) já coberto; se não, cria peer descoberto
      const alreadyPending = pendingIn.some(f => f.fp === fp)
      if (alreadyPending) continue // já está em pending_in, não precisa duplicar
      // só adiciona se foi visto recentemente
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
    // ordena: online primeiro, depois alfabético
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
      // retorna todos juntos (raramente usado) — concatena
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
    // SEMPRE broadcast — se a outra aba/device estiver aberta no mesmo domínio via BroadcastChannel,
    // ela recebe mesmo que isOnline ainda false (race de presença). O isOnline decide o outcome honesto.
    try { bc?.postMessage({ type: 'friend_request_in', fp: me?.fingerprint ?? 'local', nickname: me?.nickname ?? 'alguém' }) } catch { /* ignore */ }
    // também emite local para o listener de handleIncomingBroadcast criar pending_in no receptor
    // (em multi-tab o bc já entrega; emit aqui garante que sender também veja peer_discovered)
    emit({ type: 'peer_discovered', fp, nickname: entry.nickname, addr: 'local' } as any)
    try { window.dispatchEvent(new CustomEvent('forge:friend_request', { detail: entry })) } catch { /* ignore */ }
    const outcome = isOnline(fp) ? 'sent' : 'queued_offline'
    return Promise.resolve(outcome as any)
  },

  friendRespond: (peerFp, accept) => {
    const pendingIn = getFriends('pending_in')
    const acc = getFriends('accepted')
    if (accept) {
      const found = pendingIn.find(f => f.fp === peerFp)
      // fallback: se não achou no pending_in mas é resposta a um peer descoberto, cria entry
      const entry = found ?? { fp: peerFp, nickname: peerFp.slice(0, 8), addr: 'local', pubkey_hex: '', last_seen: Date.now() }
      setFriends('pending_in', pendingIn.filter(f => f.fp !== peerFp))
      if (!acc.some(f => f.fp === peerFp)) {
        setFriends('accepted', [...acc, { ...entry, last_seen: Date.now() }])
      }
      // cria conversa DM automaticamente
      const convs = readConvos()
      if (!convs.some(c => c.peer_fp === peerFp)) {
        const conv: Conversation = { id: 'local-' + peerFp.slice(0, 8), kind: 'dm', title: entry.nickname || peerFp, peer_fp: peerFp, created_at: Date.now() }
        writeConvos([conv, ...convs])
      }
      // também remove de pending_out se existia (caso de aceitação mútua local)
      const pendingOut = getFriends('pending_out')
      if (pendingOut.some(f => f.fp === peerFp)) {
        setFriends('pending_out', pendingOut.filter(f => f.fp !== peerFp))
      }
      emit({ type: 'friend_accepted', fp: peerFp, nickname: entry.nickname })
      emit({ type: 'state_changed', state: 'CONNECTED', online_peers: onlineCount() })
      // notifica outra aba via BC que foi aceito
      try { bc?.postMessage({ type: 'friend_accepted', fp: store.load()?.fingerprint ?? 'local', nickname: store.load()?.nickname ?? 'alguém' }) } catch { /* ignore */ }
    } else {
      setFriends('pending_in', pendingIn.filter(f => f.fp !== peerFp))
      emit({ type: 'friend_removed', fp: peerFp })
    }
    return Promise.resolve()
  },

  friendRemove: (peerFp) => {
    const acc = getFriends('accepted')
    setFriends('accepted', acc.filter(f => f.fp !== peerFp))
    // também limpa pendentes (cancelamento de ENVIADAS)
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

  vaultChange: () =>
    Promise.reject(new Error('cofre disponível no app nativo')),

  communitiesList: () => {
    const raw = localStorage.getItem('forge:extras:communities') ?? '[]'
    try { return Promise.resolve(JSON.parse(raw)) } catch { return Promise.resolve([]) }
  },

  createCommunity: (name, channels, opts) => {
    const raw = localStorage.getItem('forge:extras:communities') ?? '[]'
    let list: import('./models').CommunityView[] = []
    try { list = JSON.parse(raw) } catch { /* browser mode */ }
    const cid = `local-${Math.random().toString(36).slice(2, 10)}`
    // wizard: canais com tipo/categoria quando opts.channelsMeta veio; senão CSV simples (compat)
    const seeds: { name: string; kind: 'text' | 'voice' | 'video'; category: string }[] = opts?.channelsMeta?.length
      ? opts.channelsMeta
      : (channels.length ? channels : ['geral']).map(c => ({ name: c, kind: 'text' as const, category: 'CANAIS DE TEXTO' }))
    const chanTuples: [string, string][] = seeds.map(c => [`${cid}-${c.name.toLowerCase().replace(/\s+/g, '-')}`, c.name] as [string, string])
    const me = store.load()
    const cv: import('./models').CommunityView = {
      id: cid, name, owner_fp: me?.fingerprint ?? 'local', channels: chanTuples,
      members: me ? [[me.fingerprint, me.nickname, 'owner']] : [],
      description: opts?.description ?? '', category: opts?.category ?? '', icon: opts?.icon ?? '',
    }
    list.push(cv)
    localStorage.setItem('forge:extras:communities', JSON.stringify(list))
    // materializa canais com kind/categoria para o sidebar/voice funcionarem.
    // Reaproveita o MESMO id da tupla acima, senão o canal aparece duplicado.
    seeds.forEach((c, i) => {
      LX.createLocalChannel(cid, c.name, { kind: c.kind, category: c.category, id: chanTuples[i][0] })
    })
    // cargos do wizard (presets admin/mod/membro) + regras + meta
    for (const r of opts?.roles ?? []) LX.createLocalRole(cid, r)
    LX.saveCommunityMeta(cid, { description: opts?.description, category: opts?.category, icon: opts?.icon })
    if (opts?.rulesText) {
      try { localStorage.setItem(`forge:rules:${cid}`, JSON.stringify({ community_id: cid, spam_level: 'medium', banned_words: [], blocked_domains: [], moderators: [], shadow_banned: [], updated_at: Date.now() })) } catch { /* ignore */ }
      try { localStorage.setItem(`forge:rules:text:${cid}`, opts.rulesText) } catch { /* ignore */ }
    }
    emit({ type: 'community_joined', community_id: cid, name } as any)
    try { bc?.postMessage({ type: 'community_joined', community_id: cid, name }) } catch { /* ignore */ }
    return Promise.resolve(cid)
  },

  communitySetMeta: (communityId, patch) => {
    const raw = localStorage.getItem('forge:extras:communities') ?? '[]'
    let list: import('./models').CommunityView[] = []
    try { list = JSON.parse(raw) } catch { /* browser mode */ }
    const idx = list.findIndex(c => c.id === communityId)
    if (idx < 0) return Promise.reject(new Error('comunidade não encontrada'))
    list[idx] = {
      ...list[idx],
      description: patch.description ?? list[idx].description ?? '',
      category: patch.category ?? list[idx].category ?? '',
      icon: patch.icon ?? list[idx].icon ?? '',
    }
    localStorage.setItem('forge:extras:communities', JSON.stringify(list))
    LX.saveCommunityMeta(communityId, patch)
    return Promise.resolve()
  },

  communityRename: (communityId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return Promise.reject(new Error('nome vazio'))
    const raw = localStorage.getItem('forge:extras:communities') ?? '[]'
    let list: import('./models').CommunityView[] = []
    try { list = JSON.parse(raw) } catch { /* browser mode */ }
    const idx = list.findIndex(c => c.id === communityId)
    if (idx < 0) return Promise.reject(new Error('comunidade não encontrada'))
    list[idx] = { ...list[idx], name: trimmed }
    localStorage.setItem('forge:extras:communities', JSON.stringify(list))
    emit({ type: 'community_joined', community_id: communityId, name: trimmed } as any)
    try { bc?.postMessage({ type: 'community_joined', community_id: communityId, name: trimmed }) } catch { /* ignore */ }
    return Promise.resolve()
  },

  makeInvite: (cid) => Promise.resolve(`local-invite:${cid}:${btoa(cid).slice(0, 8)}`),
  joinCommunity: (token) => {
    const m = token.match(/^local-invite:([^:]+):/)
    if (!m) return Promise.reject(new Error('token inválido'))
    const cid = m[1]
    // modo navegador (dev local, sem rede): cria o espelho local do servidor
    // para o fluxo de convite funcionar 100% dentro do escopo local honesto
    const raw = localStorage.getItem('forge:extras:communities') ?? '[]'
    let list: import('./models').CommunityView[] = []
    try { list = JSON.parse(raw) } catch { /* browser mode */ }
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
      localStorage.setItem('forge:extras:communities', JSON.stringify(list))
      emit({ type: 'community_joined', community_id: cid, name: cv.name } as any)
      try { bc?.postMessage({ type: 'community_joined', community_id: cid, name: cv.name }) } catch { /* ignore */ }
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
    // local: entrega direta sem broadcast (evita duplicar nas outras abas)
    const ev: any = { ...m, type: 'message_new' }
    for (const cb of listeners) try { cb(ev) } catch { /* ignore */ }
    // cross-tab: só channel_message_new (message_new seria tratado como DM e duplicaria)
    try { bc?.postMessage({ type: 'channel_message_new', channelId, msg: m }) } catch { /* ignore */ }
    // simula delivered para quem estiver no canal (todos recebem)
    setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'delivered' } as any), 200)
    return Promise.resolve(m)
  },

  conversationsList: () => Promise.resolve(readConvos()),
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
    // verifica se é DM para peer bloqueado
    const blocked = getFriends('blocked')
    if (targetFp && blocked.some(f => f.fp === targetFp)) return Promise.reject(new Error('peer bloqueado'))

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

    // simula ciclo de status realista
    if (targetOnline) {
      setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'sent' } as any), 80)
      setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'delivered' } as any), 350)
      // atualiza storage para refletir delivered
      setTimeout(() => {
        const all = readMsgs()
        const idx = all.findIndex(x => x.id === id)
        if (idx >= 0) { all[idx] = { ...all[idx], status: 'delivered' as const }; writeMsgs(all) }
      }, 360)
    } else {
      // pending → se peer ficar online, reenvia automaticamente (listener de peer_online)
      // aqui fica pending mesmo
      setTimeout(() => {
        // tenta re-entrega se ficou online entretanto
        if (targetFp && isOnline(targetFp)) {
          emit({ type: 'message_status', msg_id: id, status: 'sent' } as any)
          setTimeout(() => emit({ type: 'message_status', msg_id: id, status: 'delivered' } as any), 200)
        }
      }, 1200)
    }
    return Promise.resolve(msg)
  },

  sendTyping: (convId) => {
    const me = store.load()
    if (!me || !convId) return Promise.resolve()
    // efêmero: só broadcast, sem persistir (igual Discord — some em ~3s)
    try { bc?.postMessage({ type: 'typing', conv_id: convId, convId, fp: me.fingerprint, nickname: me.nickname }) } catch { /* ignore */ }
    return Promise.resolve()
  },

  // Canais
  channelCreate: (cid, name, opts) => Promise.resolve(LX.createLocalChannel(cid, name, opts)),
  channelDelete: (cid, channelId) => { LX.deleteLocalChannel(cid, channelId); emit({ type: 'channel_deleted' as any, community_id: cid, channel_id: channelId } as any); try { bc?.postMessage({ type: 'channel_deleted', community_id: cid, channel_id: channelId }) } catch { /* ignore */ }; return Promise.resolve() },
  channelRename: (cid, channelId, newName) => { LX.updateLocalChannel(cid, channelId, { name: newName.toLowerCase().replace(/\s+/g, '-') }); try { bc?.postMessage({ type: 'channel_created', community_id: cid, channel_id: channelId, name: newName }) } catch { /* ignore */ }; return Promise.resolve() },
  channelSetTopic: (cid, channelId, topic) => { LX.updateLocalChannel(cid, channelId, { topic }); return Promise.resolve() },
  channelSetCategory: (cid, channelId, category) => { LX.updateLocalChannel(cid, channelId, { category }); return Promise.resolve() },
  channelList: (cid) => Promise.resolve(LX.extraChannels(cid)),

  // Cargos
  roleCreate: (cid, data) => Promise.resolve(LX.createLocalRole(cid, data)),
  roleUpdate: (cid, roleId, patch) => { LX.updateLocalRole(cid, roleId, patch); return Promise.resolve() },
  roleDelete: (cid, roleId) => { LX.deleteLocalRole(cid, roleId); return Promise.resolve() },
  rolesList: (cid) => Promise.resolve(LX.roles(cid)),
  memberRoles: (cid, fp) => Promise.resolve(LX.memberRoles(cid, fp)),
  memberAssignRole: (cid, fp, roleId) => { LX.assignRole(cid, fp, roleId); return Promise.resolve() },
  memberUnassignRole: (cid, fp, roleId) => { LX.unassignRole(cid, fp, roleId); return Promise.resolve() },
  memberKick: (cid, fp) => { LX.kickLocal(cid, fp); return Promise.resolve() },

  // Bots
  botCreate: (cid, data) => {
    const me = store.load()
    return Promise.resolve(LX.createLocalBot(cid, data, me?.fingerprint ?? 'local'))
  },
  botUpdate: (cid, botId, patch) => { LX.updateLocalBot(cid, botId, patch); return Promise.resolve() },
  botDelete: (cid, botId) => { LX.deleteLocalBot(cid, botId); return Promise.resolve() },
  botsList: (cid) => Promise.resolve(LX.botsList(cid)),
  // Posta COMO o bot (browser: persiste + emite com bot_id — igual nativo).
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
    for (const cb of listeners) try { cb(ev) } catch { /* ignore */ }
    try { bc?.postMessage({ type: 'channel_message_new', channelId, msg: m } as any) } catch { /* ignore */ }
    return Promise.resolve(m)
  },
  botRegenToken: (cid, botId) => {
    const tok = LX.regenLocalBotToken(cid, botId)
    if (!tok) return Promise.reject(new Error('bot não encontrado'))
    return Promise.resolve(tok)
  },
  // HTTP do runtime de bots no browser: fetch comum (CORS se aplica — honesto).
  httpFetch: async (url, method, headers, body, timeoutMs) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), Math.max(1000, Math.min(timeoutMs, 15000)))
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
      // lib ES2020 não tem Error cause — detalhe original preservado na mensagem
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`HTTP falhou: ${String(e?.message ?? e)}`)
    } finally {
      clearTimeout(timer)
    }
  },

  subscribe: (cb) => {
    listeners.add(cb)
    // reenvia presença inicial para quem acabou de subscrever
    try {
      const presence = getPresenceMap()
      for (const [fp, v] of presence) {
        if (store.load()?.fingerprint === fp) continue
        if (Date.now() - v.ts < PRESENCE_TTL_MS) cb({ type: 'peer_online', fp, nickname: v.nickname } as any)
      }
    } catch { /* ignore */ }
    // Compat: eventos disparados direto no window (fora do emit, ex.: testes
    // e2e, fileSwarm legado) ainda chegam aqui. Os que já passaram por
    // `listeners` são pulados via WeakSet — sem entrega dupla, sem perda.
    const onBus = (e: Event) => {
      const detail = (e as CustomEvent).detail as EngineEvent
      if (detail && typeof detail === 'object' && viaListeners.has(detail)) return
      try { cb(detail) } catch { /* ignore */ }
    }
    window.addEventListener('forge:bus', onBus as EventListener)
    return () => {
      listeners.delete(cb)
      window.removeEventListener('forge:bus', onBus as EventListener)
    }
  },

  // modo navegador (dev, sem motor): diagnóstico global indisponível — honesto
  // Só existe no app nativo (Rust); no navegador não há WebKitGTK para diagnosticar.
  webrtcReport: () => Promise.resolve(),
  netDiag: () => Promise.reject(new Error('diagnóstico de rede só existe no app nativo')),

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
    })
  },

  proxyAddrGet: () => {
    const saved = driver.get<string>('privacy_proxy_addr')
    return Promise.resolve({
      addr: saved && saved.trim() !== '' ? saved.trim() : (driver.get<string>('privacy_mode') === 'full' ? '127.0.0.1:9050' : '127.0.0.1:1080'),
      is_default: !(saved && saved.trim() !== ''),
    })
  },

  proxyAddrSet: (addr: string) => {
    const v = addr.trim()
    if (v === '') driver.remove('privacy_proxy_addr')
    else driver.set('privacy_proxy_addr', v)
    return Promise.resolve()
  },

  // modo navegador (dev, sem motor): proxy test indisponível — honesto
  proxyTest: () => Promise.reject(new Error('teste online do proxy só existe no app nativo — modo navegador não faz SOCKS5')),

  vaultExport: () => Promise.reject(new Error('export disponível no app nativo')),
  vaultImport: () => Promise.reject(new Error('import disponível no app nativo')),
  accountsList: () => Promise.resolve([]),
  accountSaveImported: () => Promise.reject(new Error('disponível no app nativo')),
  accountSwitch: () => Promise.reject(new Error('disponível no app nativo')),
  accountRemoveImported: () => Promise.reject(new Error('disponível no app nativo')),

  // Grupos + chamadas + voz + arquivos — browser fallback 100% funcional
  createGroup: (title, members) => {
    const id = `group-${Math.random().toString(36).slice(2, 8)}`
    const me = store.load()
    const conv: Conversation = { id, kind: 'group', title: title || members.slice(0, 2).join(', '), peer_fp: '', created_at: Date.now() }
    const all = [conv, ...readConvos()]
    writeConvos(all)
    localStorage.setItem(`forge:extras:group_members:${id}`, JSON.stringify(members.map((fp: string) => [fp, ''] as [string, string])))
    if (me) {
      const k = `forge:extras:group_members:${id}`
      try {
        const cur = JSON.parse(localStorage.getItem(k) ?? '[]')
        if (!cur.find((x: any) => x[0] === me.fingerprint)) {
          cur.push([me.fingerprint, me.nickname])
          localStorage.setItem(k, JSON.stringify(cur))
        }
      } catch { /* silent */ }
    }
    try { bc?.postMessage({ type: 'group_synced', conv_id: id, title }) } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent('forge:groups_changed'))
    emit({ type: 'group_synced' as any, conv_id: id, title } as any)
    return Promise.resolve(conv)
  },
  groupMembers: (cid) => {
    try { const v = localStorage.getItem(`forge:extras:group_members:${cid}`); if (v) return Promise.resolve(JSON.parse(v)) } catch { /* silent */ }
    return Promise.resolve([])
  },
  groupAdd: (cid, fp) => {
    try { const k = `forge:extras:group_members:${cid}`; const cur = JSON.parse(localStorage.getItem(k) ?? '[]'); if (!cur.find((x: any) => x[0] === fp)) { cur.push([fp, '']); localStorage.setItem(k, JSON.stringify(cur)) } } catch { /* silent */ }
    window.dispatchEvent(new CustomEvent('forge:groups_changed'))
    try { bc?.postMessage({ type: 'channel_created', community_id: cid, channel_id: fp, name: fp } as any) } catch { /* ignore */ }
    emit({ type: 'group_synced' as any, conv_id: cid, title: '' } as any)
    try { bc?.postMessage({ type: 'group_synced', conv_id: cid, title: '' }) } catch { /* ignore */ }
    return Promise.resolve()
  },
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
      localStorage.setItem(`forge:call:invite:${callId}`, JSON.stringify({ targetFp, kind, at: Date.now() }))
      const ev: any = { type: 'call_incoming', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local', kind, target_fp: targetFp }
      // emit() já faz listeners + bc.postMessage + window — sem post duplo
      emit(ev)
    } catch { /* silent */ }
    return Promise.resolve(callId)
  },
  callAccept: () => Promise.resolve(),
  callReject: () => Promise.resolve(),
  callEnd: () => Promise.resolve(),
  callOffer: (targetFp, callId, sdp) => {
    try {
      emit({ type: 'call_offer', from_fp: store.load()?.fingerprint ?? 'local', call_id: callId, sdp } as any)
    } catch { /* best-effort */ }
    void targetFp
    return Promise.resolve()
  },
  callAnswer: (targetFp, callId, sdp) => {
    try {
      emit({ type: 'call_answer', from_fp: store.load()?.fingerprint ?? 'local', call_id: callId, sdp } as any)
    } catch { /* best-effort */ }
    void targetFp
    return Promise.resolve()
  },
  callIce: (targetFp, callId, candidate, mid) => {
    try {
      emit({ type: 'call_ice', from_fp: store.load()?.fingerprint ?? 'local', call_id: callId, candidate, mid } as any)
    } catch { /* best-effort */ }
    void targetFp
    return Promise.resolve()
  },
  // Grupo (demo multi-aba): avisa quem está na chamada sobre o novo peer.
  // kind não-vazio toca o "telefone" do convidado (call_incoming na outra aba).
  callAddParticipant: (targetFp, callId, fp, kind) => {
    emit({ type: 'call_participant_added', call_id: callId, fp } as any)
    if (kind) emit({ type: 'call_incoming', call_id: callId, from_fp: fp, kind } as any)
    void targetFp
    return Promise.resolve()
  },
  // Sinal dedicado de tela: o receptor marca participant.sharing (badge TELA).
  screenShareOffer: (targetFp, callId, sdp) => {
    emit({ type: 'screen_share_offer', call_id: callId, from_fp: store.load()?.fingerprint ?? 'local', sdp } as any)
    void targetFp
    return Promise.resolve()
  },
  screenShareAnswer: () => Promise.resolve(),
  voiceJoin: (cid, ch) => {
    const me = store.load(); if (!me) return Promise.resolve()
    const k = `forge:voice:${cid}:${ch}`
    let arr: any[] = []; try { arr = JSON.parse(localStorage.getItem(k) ?? '[]') } catch { /* silent */ }
    if (!arr.find((x: any) => x[0] === me.fingerprint)) { arr.push([me.fingerprint, false, false]); localStorage.setItem(k, JSON.stringify(arr)) }
    window.dispatchEvent(new CustomEvent('forge:voice_changed'))
    emit({ type: 'voice_joined' as any, community_id: cid, channel_id: ch, fp: me.fingerprint } as any)
    return Promise.resolve()
  },
  voiceLeave: (cid, ch) => {
    const me = store.load(); if (!me) return Promise.resolve()
    const k = `forge:voice:${cid}:${ch}`
    let arr: any[] = []; try { arr = JSON.parse(localStorage.getItem(k) ?? '[]') } catch { /* silent */ }
    arr = arr.filter((x: any) => x[0] !== me.fingerprint); localStorage.setItem(k, JSON.stringify(arr))
    window.dispatchEvent(new CustomEvent('forge:voice_changed'))
    emit({ type: 'voice_left' as any, community_id: cid, channel_id: ch, fp: me.fingerprint } as any)
    return Promise.resolve()
  },
  voiceState: (cid, ch, muted, deaf) => {
    const me = store.load(); if (!me) return Promise.resolve()
    const k = `forge:voice:${cid}:${ch}`
    let arr: any[] = []; try { arr = JSON.parse(localStorage.getItem(k) ?? '[]') } catch { /* silent */ }
    const idx = arr.findIndex((x: any) => x[0] === me.fingerprint)
    if (idx >= 0) { arr[idx] = [me.fingerprint, muted, deaf]; localStorage.setItem(k, JSON.stringify(arr)) }
    window.dispatchEvent(new CustomEvent('forge:voice_changed'))
    emit({ type: 'voice_state_changed' as any, community_id: cid, channel_id: ch, fp: me.fingerprint, muted, deafened: deaf } as any)
    return Promise.resolve()
  },
  voiceStates: (cid, ch) => {
    try { const v = localStorage.getItem(`forge:voice:${cid}:${ch}`); if (v) return Promise.resolve(JSON.parse(v)) } catch { /* silent */ }
    return Promise.resolve([])
  },
  fileAnnounce: (fid, name, size, chunks, hash, chunkHashes?: string[]) => {
    try {
      // persiste chunk_hashes para verificação (browser local) — usado pelo receptor
      if (chunkHashes?.length) {
        try { localStorage.setItem(`forge:file:chunk_hashes:${fid}`, JSON.stringify(chunkHashes)) } catch { /* ignore */ }
        try { localStorage.setItem(`forge:filemeta:${fid}`, JSON.stringify({ name, size, chunks, hash, chunkHashes })) } catch { /* ignore */ }
      }
      localStorage.setItem(`forge:file:${fid}`, JSON.stringify({ name, size, chunks, hash, chunk_hashes: chunkHashes ?? null, at: Date.now(), from: store.load()?.fingerprint ?? 'local' }))
      const ev: any = { type: 'file_announce', file_id: fid, name, size, chunks, hash, chunk_hashes: chunkHashes ?? null, from_fp: store.load()?.fingerprint ?? 'local' }
      emit(ev)
      try { bc?.postMessage(ev) } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('forge:file_announce', { detail: { file_id: fid, name, size, chunks, hash } }))
    } catch { /* silent */ }
    return Promise.resolve()
  },
  fileRequestChunk: (fileId: string, index: number, holderFp: string) => {
    try {
      const me = store.load()?.fingerprint ?? 'local'
      const ev: any = { type: 'file_chunk_request', file_id: fileId, index, from_fp: me, holder_fp: holderFp }
      // emite localmente para o holder na mesma tab (caso self) e broadcast para outras abas
      emit(ev)
      try { bc?.postMessage(ev) } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('forge:file_chunk_request', { detail: ev }))
    } catch { /* silent */ }
    return Promise.resolve()
  },
  fileSendChunk: (targetFp: string, fileId: string, index: number, dataB64: string) => {
    try {
      const me = store.load()?.fingerprint ?? 'local'
      const ev: any = { type: 'file_chunk_data', file_id: fileId, index, data_b64: dataB64, from_fp: me, target_fp: targetFp }
      emit(ev)
      try { bc?.postMessage(ev) } catch { /* ignore */ }
      window.dispatchEvent(new CustomEvent('forge:file_chunk_data', { detail: ev }))
    } catch { /* silent */ }
    return Promise.resolve()
  },

  // Segurança / moderação — modo navegador: regras/auditoria/reputação locais
  // (localStorage por identidade). Sem motor P2P não há enforcement remoto;
  // o app nativo aplica no core. Honesto: funciona entre abas locais.
  serverRulesGet: (cid) => {
    try {
      const raw = localStorage.getItem(`forge:rules:${cid}`)
      if (raw) return Promise.resolve(JSON.parse(raw) as ServerRules)
    } catch { /* ignore */ }
    return Promise.resolve({
      community_id: cid, spam_level: 'medium', banned_words: [], blocked_domains: [],
      moderators: [], shadow_banned: [], updated_at: Date.now(),
    })
  },
  serverRulesSet: (rules) => {
    try { localStorage.setItem(`forge:rules:${rules.community_id}`, JSON.stringify({ ...rules, updated_at: Date.now() })) } catch { /* ignore */ }
    appendLocalAudit(rules.community_id, 'rules', '', 'regras atualizadas')
    return Promise.resolve()
  },
  auditList: (cid, limit) => {
    try {
      const raw = localStorage.getItem(`forge:audit:${cid}`)
      const list = raw ? (JSON.parse(raw) as AuditEntry[]) : []
      return Promise.resolve(list.slice(-(limit ?? 100)).reverse())
    } catch { return Promise.resolve([]) }
  },
  reputationGet: (fp) => {
    try {
      const raw = localStorage.getItem(`forge:repute:${fp}`)
      if (raw) {
        const v = JSON.parse(raw) as { trust: ReputationView['trust']; score: number; reports: number }
        return Promise.resolve(v)
      }
    } catch { /* ignore */ }
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
    // browser local: ban/mute aplicam reputação local honesta
    try {
      const cur = JSON.parse(localStorage.getItem(`forge:repute:${target}`) ?? '{"trust":"new","score":0,"reports":0}')
      if (action === 'ban') { cur.trust = 'banned'; cur.score = -100 }
      if (action === 'unban' || action === 'unmute') { cur.trust = 'new'; cur.score = 0 }
      if (action === 'mute') { cur.trust = 'suspicious'; cur.score = Math.min(cur.score, -15) }
      localStorage.setItem(`forge:repute:${target}`, JSON.stringify(cur))
    } catch { /* ignore */ }
    if (action === 'shadow_ban' || action === 'unshadow') {
      try {
        const rk = `forge:rules:${cid}`
        const rules = JSON.parse(localStorage.getItem(rk) ?? '{}') as Partial<ServerRules>
        const list = new Set(rules.shadow_banned ?? [])
        if (action === 'shadow_ban') list.add(target)
        else list.delete(target)
        localStorage.setItem(rk, JSON.stringify({ ...rules, community_id: cid, shadow_banned: [...list] }))
      } catch { /* ignore */ }
    }
    return Promise.resolve()
  },
  reportUser: (targetFp, cid, reason) => {
    appendLocalAudit(cid ?? '', 'report', targetFp, reason ?? '')
    try {
      const cur = JSON.parse(localStorage.getItem(`forge:repute:${targetFp}`) ?? '{"trust":"new","score":0,"reports":0}')
      cur.score = Math.max(-100, (cur.score ?? 0) - 10)
      cur.reports = (cur.reports ?? 0) + 1
      if (cur.score <= -30) cur.trust = 'banned'
      else if (cur.score <= -10) cur.trust = 'suspicious'
      localStorage.setItem(`forge:repute:${targetFp}`, JSON.stringify(cur))
    } catch { /* ignore */ }
    return Promise.resolve()
  },
  validateName: (kind: NameKind, raw, existing) =>
    Promise.resolve(validateNameLocal(kind, raw, existing ?? [])),
  randomName: () => Promise.resolve(randomNameLocal()),

  // --- cofre portátil / janela de mensagens / métricas / cache (5.4) ---
  // Modo browser = dev sem motor nativo: janela e cache funcionam sobre
  // localStorage; cofre/backups/wipe exigem o app nativo (erros honestos).
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
          if (k && k.startsWith('forge:')) doomed.push(k)
        }
        doomed.forEach((k) => storage.removeItem(k))
      }
    } catch { /* ignore */ }
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
    try { return Promise.resolve(localStorage.getItem(`forge:cache:${key}`)) } catch { return Promise.resolve(null) }
  },
  cachePut: (key, dataB64) => {
    try { localStorage.setItem(`forge:cache:${key}`, dataB64) } catch { /* quota — silencioso */ }
    return Promise.resolve()
  },
  cacheDelete: (key) => {
    try { localStorage.removeItem(`forge:cache:${key}`) } catch { /* ignore */ }
    return Promise.resolve()
  },
  cacheStats: () => {
    try {
      let total = 0
      let entries = 0
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith('forge:cache:')) {
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
    strip_exif: localStorage.getItem('forge:media:strip_exif') !== '0',
    block_executables: localStorage.getItem('forge:media:block_exec') !== '0',
  }),
  mediaSafetySet: (stripExif, blockExecutables) => {
    try {
      localStorage.setItem('forge:media:strip_exif', stripExif ? '1' : '0')
      localStorage.setItem('forge:media:block_exec', blockExecutables ? '1' : '0')
    } catch { /* ignore */ }
    return Promise.resolve()
  },
  // Voz nativa NÃO existe no browser: o áudio é o `RTCPeerConnection` da
  // própria página. Devolver false/null mantém a UI no mesmo caminho de antes,
  // sem nenhum branching novo.
  voiceMediaAvailable: () => Promise.resolve(false),
  voiceMediaStats: () => Promise.resolve(null),
  voiceSetMuted: () => Promise.resolve(),
  voiceSetDeafened: () => Promise.resolve(),
  voiceHangup: () => Promise.resolve(),

  // ================= CAMADA SOCIAL v3 =================
  react: async (convId, msgId, emoji) => {
    const all = loadAll<ReactionSummary[]>(RX_BASE)
    let list = all[msgId] ?? []
    const mineIdx = list.findIndex(r => r.emoji === emoji && r.reactors.includes(meFp()))
    if (mineIdx >= 0) {
      const r = list[mineIdx]
      r.reactors = r.reactors.filter(f => f !== meFp())
      r.count = r.reactors.length
      r.mine = false
      if (r.count === 0) list = list.filter((_, i) => i !== mineIdx)
    } else {
      const hit = list.find(r => r.emoji === emoji)
      if (hit) { hit.count++; hit.mine = true; hit.reactors.push(meFp()) }
      else list.push({ msg_id: msgId, emoji, count: 1, reactors: [meFp()], mine: true })
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

  presenceSet: async (status, custom, customEmoji) => {
    const all = loadAll<PresenceView>(PRESENCE_BASE)
    all[meFp()] = { fp: meFp(), status, custom, custom_emoji: customEmoji, updated_at: Date.now() }
    saveAll(PRESENCE_BASE, all)
    emit({ type: 'presence_changed', fp: meFp(), status, custom, custom_emoji: customEmoji })
  },
  presenceList: async () => Object.values(loadAll<PresenceView>(PRESENCE_BASE)),
  presenceGet: async (fp) => loadAll<PresenceView>(PRESENCE_BASE)[fp] ?? {
    fp, status: 'offline' as PresenceStatus, custom: '', custom_emoji: '', updated_at: 0,
  },
  profileSet: async (patch) => {
    const all = loadAll<ProfileView>(PROFILE_BASE)
    const me = meFp()
    const cur = all[me] ?? { fp: me, display_name: '', about: '', avatar_b64: '', banner_b64: '', accent: '', updated_at: 0 }
    const next: ProfileView = {
      fp: me,
      display_name: patch.display_name,
      about: patch.about,
      avatar_b64: patch.avatar_b64 || cur.avatar_b64,
      banner_b64: patch.banner_b64 || cur.banner_b64,
      accent: patch.accent,
      updated_at: Date.now(),
    }
    all[me] = next
    saveAll(PROFILE_BASE, all)
    emit({ type: 'profile_changed', fp: me, profile: next })
    return next
  },
  profileGet: async (fp) => loadAll<ProfileView>(PROFILE_BASE)[fp] ?? {
    fp, display_name: '', about: '', avatar_b64: '', banner_b64: '', accent: '', updated_at: 0,
  },
  profileList: async () => Object.values(loadAll<ProfileView>(PROFILE_BASE)),
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
    // `social:votes[polllId]` guarda os ÍNDICES escolhidos por quem votou, não as
    // contagens por opção. Somar em um contador por opção — senão 1 voto em
    // "Tokio" produzia counts[0]=0 e a barra mostrava 0%.
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
    const k = `forge:audit:${communityId}`
    const list = JSON.parse(localStorage.getItem(k) ?? '[]') as AuditEntry[]
    const me = store.load()?.fingerprint ?? 'local'
    list.push({
      id: `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      community_id: communityId, actor_fp: me, action, target_fp: target,
      reason: reason.slice(0, 280), created_at: Date.now(),
    })
    localStorage.setItem(k, JSON.stringify(list.slice(-500)))
  } catch { /* ignore */ }
}

async function formatSafetyNumber(fpA: string, pubA: string, fpB: string, pubB: string): Promise<string> {
  // SHA-256 no browser (o core usa BLAKE3 — números SÓ coincidem no nativo;
  // aqui serve para comparação local entre abas).
  const [x, y] = fpA <= fpB ? [[fpA, pubA], [fpB, pubB]] : [[fpB, pubB], [fpA, pubA]]
  const data = new TextEncoder().encode(`storm/safety-number/v1|${x[0]}|${x[1]}|${y[0]}|${y[1]}`)
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource)
  const v = new DataView(d)
  const groups: string[] = []
  for (let i = 0; i < 8; i++) groups.push(String(v.getUint32(i * 4) % 100_000).padStart(5, '0'))
  return groups.join(' ')
}

export type { EngineEvent }
