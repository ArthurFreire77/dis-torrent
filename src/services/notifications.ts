import { services } from './index'
import { appStateSnapshot, setTrayUnread } from './appState'
import { getPrefs, levelFor } from '../shared/prefs'
import { avatarCacheGet, avatarCacheSet } from '../shared/avatar'
import { isAndroidRuntime } from '../shared/runtime.ts'
import { invoke } from '@tauri-apps/api/core'
import {
  createSeenTracker, decideMessageNotice, decideReactionNotice, levelAllows,
  notificationIdFor, reactionNoticeBody, reactionNoticeKey, truncate,
} from './notificationRules'

function inForeground(): boolean {
  return appStateSnapshot().activity === 'active'
}

let openConversation: string | null = null
export function setOpenConversation(convId: string | null) {
  openConversation = convId
  if (convId) void clearConversation(convId)
}

const seen = createSeenTracker(600)

export function resetNotificationState() {
  seen.clear()
  perConv.clear()
  callsInFlight.clear()
  missedNotified.clear()
  publishUnread()
}

interface ConvAgg { count: number; preview: string; ts: number }
const perConv = new Map<string, ConvAgg>()

function publishUnread() {
  let total = 0
  for (const a of perConv.values()) total += a.count
  setTrayUnread(total)
}

export { notificationIdFor }

export interface MessageNotice {
  id: string
  conversationId: string
  title: string
  preview: string
  mentioned: boolean
  serverId?: string
  ts: number
}

export function notifyMessage(n: MessageNotice): boolean {
  if (!n.conversationId || !n.id) return false
  if (seen.seen(`msg:${n.id}`)) return false

  const level = levelFor(n.conversationId, n.serverId)
  if (!levelAllows(level, n.mentioned)) return false

  if (inForeground() && openConversation === n.conversationId) return false

  const prev = perConv.get(n.conversationId)
  const count = (prev?.count ?? 0) + 1
  const agg: ConvAgg = { count, preview: truncate(n.preview), ts: n.ts }
  perConv.set(n.conversationId, agg)
  publishUnread()

  const prefs = getPrefs()
  const decision = decideMessageNotice({
    level,
    mentioned: n.mentioned,
    activity: inForeground() ? 'active' : 'background',
    openConversation,
    conversationId: n.conversationId,
    systemEnabled: prefs.notifySystem,
    previewEnabled: prefs.notifyPreview,
    count,
    preview: agg.preview,
  })
  if (!decision.show) return false

  return show({
    id: notificationIdFor(`conv:${n.conversationId}`),
    title: n.title,
    body: decision.body,
    conversation: n.conversationId,
    silent: !prefs.notifySounds,
  })
}

export interface ReactionNotice {
  msgId: string
  conversationId: string
  emoji: string
  reactorFp: string
  myFp?: string
  reactorNome?: string
  minhaMensagem: boolean
  add: boolean
  serverId?: string
}

export function notifyReaction(n: ReactionNotice): boolean {
  if (!n.conversationId || !n.msgId || !n.reactorFp) return false
  const eu = n.myFp ?? ''
  if (eu && n.reactorFp === eu) return false
  if (seen.seen(reactionNoticeKey(n.msgId, n.emoji, n.reactorFp))) return false

  const level = levelFor(n.conversationId, n.serverId)
  const mostrar = decideReactionNotice({
    minhaMensagem: n.minhaMensagem,
    euReagi: !!eu && n.reactorFp === eu,
    add: n.add,
    level,
    activity: inForeground() ? 'active' : 'background',
    openConversation,
    conversationId: n.conversationId,
    systemEnabled: getPrefs().notifySystem,
  })
  if (!mostrar) return false

  const prefs = getPrefs()
  return show({
    id: notificationIdFor(`rx:${n.conversationId}`),
    title: n.conversationId,
    body: reactionNoticeBody(n.reactorNome ?? n.reactorFp.slice(0, 8), n.emoji),
    conversation: n.conversationId,
    silent: !prefs.notifySounds,
  })
}

interface ShowArgs {
  id: number
  title: string
  body: string
  conversation?: string
  silent?: boolean
}

function show(a: ShowArgs): boolean {
  if (services.kind !== 'native') return false
  if (isAndroidRuntime()) {
    const avatar = buscarAvatarDoAviso(a.conversation)
    void invoke('plugin:msgnotif|show', {
      conversation: a.conversation ?? '',
      title: a.title,
      body: a.body,
      avatarB64: avatar,
      silent: a.silent ?? false,
    }).catch(() => {
      void services.notificationShow({
        id: a.id,
        title: a.title,
        body: a.body,
        conversation: a.conversation ?? null,
        silent: a.silent ?? false,
      }).catch(() => {  })
    })
    return true
  }
  void services.notificationShow({
    id: a.id,
    title: a.title,
    body: a.body,
    conversation: a.conversation ?? null,
    silent: a.silent ?? false,
  }).catch(() => {  })
  return true
}

function buscarAvatarDoAviso(convId: string | undefined): string {
  if (!convId) return ''
  const fp = peerFpDaConversa(convId)
  if (!fp) {
    void services.profileList()
      .then((list) => {
        for (const p of list) {
          if (p.avatar_b64) avatarCacheSet(p.fp, p.avatar_b64)
        }
      })
      .catch(() => {})
    return ''
  }
  const hit = avatarCacheGet(fp)
  if (hit) return hit
  void services.profileList()
    .then((list) => {
      for (const p of list) {
        if (p.avatar_b64) avatarCacheSet(p.fp, p.avatar_b64)
      }
    })
    .catch(() => {})
  return ''
}

function peerFpDaConversa(convId: string): string | null {
  return conversationPeers.get(convId) ?? null
}

const conversationPeers = new Map<string, string>()

export function registerConversationPeer(convId: string, fp: string) {
  if (!convId || !fp) return
  conversationPeers.set(convId, fp)
}

export async function clearConversation(convId: string) {
  const had = perConv.delete(convId)
  publishUnread()
  if (!had) return
  if (services.kind === 'native') {
    await services.notificationCancel(notificationIdFor(`conv:${convId}`)).catch(() => {})
  }
}

const callsInFlight = new Map<string, { title: string; since: number }>()
const missedNotified = new Set<string>()

export interface FriendNotice {
  kind: 'request' | 'accepted' | 'removed'
  nome: string
}

/**
 * Aviso de amizade. É curto e informativo: pedido chegando pede ação, aceite
 * libera a conversa e remoção avisa que a outra pessoa encerrou.
 *
 * Sem isto, o pedido só aparecia como badge — quem estava em outra conversa
 * não via nada até abrir a aba Amigos.
 */
export function notifyFriend(n: FriendNotice): boolean {
  const nome = (n.nome || '').trim() || 'alguém'
  if (!getPrefs().notifySystem) return false
  if (typeof document !== 'undefined' && document.hasFocus() && n.kind !== 'request') {
    return false
  }
  const body =
    n.kind === 'request'
      ? `${nome} quer adicionar você — abra Amigos para aceitar`
      : n.kind === 'accepted'
        ? `${nome} aceitou sua solicitação de amizade`
        : `${nome} não é mais seu amigo`
  return show({
    id: notificationIdFor(`friend:${n.kind}:${nome}`),
    title: n.kind === 'request' ? 'Solicitação de amizade' : n.kind === 'accepted' ? 'Amizade aceita' : 'Amizade removida',
    body,
    silent: !getPrefs().notifySounds,
  })
}

export function notifyIncomingCall(a: { callId: string; title: string }): boolean {  if (!a.callId) return false
  if (callsInFlight.has(a.callId)) return false
  callsInFlight.set(a.callId, { title: a.title, since: Date.now() })

  if (inForeground()) return false
  if (!getPrefs().notifySystem) return false
  const body = getPrefs().notifyPreview
    ? 'Chamada recebida — abra o DisTorrent para atender ou recusar'
    : 'Chamada recebida'
  void services
    .callNotifyShow(a.callId, a.title, body)
    .catch(() => {})
  return show({
    id: notificationIdFor(`call:${a.callId}`),
    title: a.title,
    body,
    silent: !getPrefs().notifyCallSounds,
  })
}

export function markCallHandled(callId: string) {
  callsInFlight.delete(callId)
  if (services.kind === 'native') {
    void services.callNotifyCancel(callId).catch(() => {})
  }
}

export function endCallNotice(callId: string) {
  const was = callsInFlight.get(callId)
  callsInFlight.delete(callId)
  if (services.kind === 'native') {
    void services.notificationCancel(notificationIdFor(`call:${callId}`)).catch(() => {})
    void services.callNotifyCancel(callId).catch(() => {})
  }
  if (!was) return
  if (missedNotified.has(callId)) return
  missedNotified.add(callId)
  if (inForeground()) return
  if (!getPrefs().notifySystem) return
  show({
    id: notificationIdFor(`missed:${callId}`),
    title: 'Chamada perdida',
    body: getPrefs().notifyPreview ? was.title : 'Você perdeu uma chamada',
    silent: !getPrefs().notifyCallSounds,
  })
}

type OpenHandler = (convId: string) => void
const openHandlers = new Set<OpenHandler>()

export function onOpenConversation(cb: OpenHandler): () => void {
  openHandlers.add(cb)
  return () => { openHandlers.delete(cb) }
}

function dispatchOpen(convId: string) {
  for (const h of openHandlers) {
    try { h(convId) } catch {  }
  }
}

let startWired = false

export function initNotifications() {
  if (startWired) return
  startWired = true
  if (services.kind !== 'native') return

  const beat = () => { void services.notifyUiAlive?.().catch(() => {}) }
  beat()
  setInterval(beat, 30_000)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', beat)
  }
  void import('@tauri-apps/api/event')
    .then(({ listen }) => listen<{ action?: string; conversation?: string | null }>(
      'distorrent://notification-action',
      (e) => {
        const conv = e.payload?.conversation
        if (conv) {
          void clearConversation(conv)
          dispatchOpen(conv)
        }
      },
    ))
    .catch(() => {  })

  void import('@tauri-apps/api/core')
    .then(async ({ addPluginListener }) => {
      await addPluginListener<{ call_id?: string; action?: string }>(
        'callnotif',
        'action',
        (p) => dispatchCallAction(p?.call_id ?? '', p?.action ?? 'open'),
      )
    })
    .catch(() => {  })

  setTimeout(() => {
    void services
      .callPendingAction()
      .then((r) => {
        if (r.action || r.call_id) dispatchCallAction(r.call_id, r.action || 'open')
      })
      .catch(() => {})
  }, 1200)
}

type CallActionHandler = (callId: string, action: string) => void
const callActionHandlers = new Set<CallActionHandler>()

export function onCallNotificationAction(cb: CallActionHandler): () => void {
  callActionHandlers.add(cb)
  return () => { callActionHandlers.delete(cb) }
}

function dispatchCallAction(callId: string, action: string) {
  if (!callId) return
  for (const h of callActionHandlers) {
    try { h(callId, action) } catch {  }
  }
}

export async function notificationPermission(): Promise<string> {
  if (services.kind !== 'native') return 'unsupported'
  try { return await services.notificationPermission() } catch { return 'unknown' }
}

export async function requestNotificationPermission(): Promise<string> {
  if (services.kind !== 'native') return 'unsupported'
  try { return await services.notificationRequestPermission() } catch { return 'denied' }
}

export function testNotificationSound(): void {
  void show({
    id: notificationIdFor(`test:${Date.now()}`),
    title: 'DisTorrent',
    body: 'É assim que um aviso aparece.',
    silent: false,
  })
}
