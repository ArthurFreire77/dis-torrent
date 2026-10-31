// NOTIFICAÇÕES DO SISTEMA — o aviso que aparece fora do DisTorrent.
// Regras: só notifica o que o motor RECEBEU; 1 notificação por conversa
// (atualiza contador+prévia); dedupe por id; prévia genérica se desligada;
// em primeiro plano quem avisa é a UI. O clique abre a conversa guardada
// pelo Rust (`distorrent://notification-action`).

import { services } from './index'
import { appStateSnapshot, setTrayUnread } from './appState'
import { getPrefs, levelFor } from '../shared/prefs'
import { avatarCacheGet, avatarCacheSet } from '../shared/avatar'
import { isAndroidRuntime } from '../shared/runtime.ts'
import { invoke } from '@tauri-apps/api/core'
import {
  createSeenTracker, decideMessageNotice, levelAllows, notificationIdFor, truncate,
} from './notificationRules'

/** Janela em uso? Quando ativa, quem avisa é a UI, não o sistema. */
function inForeground(): boolean {
  return appStateSnapshot().activity === 'active'
}

/** Conversa aberta agora — não faz sentido notificar o que está na tela. */
let openConversation: string | null = null
export function setOpenConversation(convId: string | null) {
  openConversation = convId
  if (convId) void clearConversation(convId)
}

// ---------- dedupe ----------
const seen = createSeenTracker(600)

/** Para testes: limpa memória de dedupe/agregação. */
export function resetNotificationState() {
  seen.clear()
  perConv.clear()
  callsInFlight.clear()
  missedNotified.clear()
  publishUnread()
}

// ---------- agregação por conversa ----------
interface ConvAgg { count: number; preview: string; ts: number }
const perConv = new Map<string, ConvAgg>()

function publishUnread() {
  let total = 0
  for (const a of perConv.values()) total += a.count
  setTrayUnread(total)
}

export { notificationIdFor }

export interface MessageNotice {
  /** id único da mensagem (dedupe). */
  id: string
  conversationId: string
  /** Nome do remetente ou do canal — vem de quem conhece o contexto. */
  title: string
  /** Prévia do texto (só é usada se o usuário permitir prévias). */
  preview: string
  mentioned: boolean
  serverId?: string
  ts: number
}

/**
 * Registra uma mensagem recebida e, se fizer sentido, mostra o aviso do SO.
 * Retorna `true` quando uma notificação foi realmente enviada.
 */
export function notifyMessage(n: MessageNotice): boolean {
  if (!n.conversationId || !n.id) return false
  if (seen.seen(`msg:${n.id}`)) return false

  // Preferência por canal/servidor — mesma decisão que a UI usa.
  const level = levelFor(n.conversationId, n.serverId)
  if (!levelAllows(level, n.mentioned)) return false

  // Em primeiro plano NA conversa aberta o usuário está lendo: sem aviso.
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

interface ShowArgs {
  id: number
  title: string
  body: string
  conversation?: string
  silent?: boolean
}

function show(a: ShowArgs): boolean {
  if (services.kind !== 'native') return false
  // ANDROID: plugin próprio (`msgnotif`) com foto do remetente e
  // MessagingStyle (nome em destaque). Falha cai no aviso comum.
  if (isAndroidRuntime()) {
    const avatar = buscarAvatarDoAviso(a.conversation)
    void invoke('plugin:msgnotif|show', {
      conversation: a.conversation ?? '',
      title: a.title,
      body: a.body,
      avatarB64: avatar,
      silent: a.silent ?? false,
    }).catch(() => {
      // Plugin ausente (build antigo): o aviso genérico ainda serve.
      void services.notificationShow({
        id: a.id,
        title: a.title,
        body: a.body,
        conversation: a.conversation ?? null,
        silent: a.silent ?? false,
      }).catch(() => { /* permissão negada / SO sem suporte */ })
    })
    return true
  }
  void services.notificationShow({
    id: a.id,
    title: a.title,
    body: a.body,
    conversation: a.conversation ?? null,
    silent: a.silent ?? false,
  }).catch(() => { /* permissão negada / SO sem suporte: a UI segue normal */ })
  return true
}

/**
 * Foto (base64) do remetente, do cache de avatares; aquece o cache em
 * background se faltar. Não bloqueia o aviso.
 */
function buscarAvatarDoAviso(convId: string | undefined): string {
  if (!convId) return ''
  const fp = peerFpDaConversa(convId)
  if (!fp) {
    // Sem mapa ainda: aquece o cache e segue.
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

/** fp do peer de uma conversa, quando o shell registrou (ver `registerConversationPeer`). */
function peerFpDaConversa(convId: string): string | null {
  return conversationPeers.get(convId) ?? null
}

const conversationPeers = new Map<string, string>()

/**
 * O shell informa de quem é cada conversa DM (o módulo de notificação não tem
 * acesso ao banco). Chamado ao abrir a conversa e no boot.
 */
export function registerConversationPeer(convId: string, fp: string) {
  if (!convId || !fp) return
  conversationPeers.set(convId, fp)
}

/** Conversa aberta/lida → some o aviso e zera o contador dela. */
export async function clearConversation(convId: string) {
  const had = perConv.delete(convId)
  publishUnread()
  if (!had) return
  if (services.kind === 'native') {
    await services.notificationCancel(notificationIdFor(`conv:${convId}`)).catch(() => {})
  }
}

/** Chamadas em andamento/notificadas: call_id → título (para "perdida"). */
const callsInFlight = new Map<string, { title: string; since: number }>()
const missedNotified = new Set<string>()

/**
 * Chamada recebida. Em segundo plano vira notificação do sistema; em primeiro
 * plano quem toca é o overlay da UI (sem duplicar aviso).
 */
export function notifyIncomingCall(a: { callId: string; title: string }): boolean {
  if (!a.callId) return false
  // Chamada repetida (frame reenviado) não cria segunda entrada.
  if (callsInFlight.has(a.callId)) return false
  callsInFlight.set(a.callId, { title: a.title, since: Date.now() })

  if (inForeground()) return false
  if (!getPrefs().notifySystem) return false
  const body = getPrefs().notifyPreview
    ? 'Chamada recebida — abra o DisTorrent para atender ou recusar'
    : 'Chamada recebida'
  // ANDROID: notificação de CHAMADA própria (tela cheia + Atender/Recusar);
  // falha cai no aviso comum.
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

/** Atendeu/recusou na UI: não é mais "perdida". */
export function markCallHandled(callId: string) {
  callsInFlight.delete(callId)
  if (services.kind === 'native') {
    // O aviso de chamada do Android continua na tela se o usuário atendeu por
    // dentro do app (o overlay), não pela notificação.
    void services.callNotifyCancel(callId).catch(() => {})
  }
}

/** Fim da sinalização: cancela o aviso e, se ninguém atendeu, avisa perdida. */
export function endCallNotice(callId: string) {
  const was = callsInFlight.get(callId)
  callsInFlight.delete(callId)
  if (services.kind === 'native') {
    void services.notificationCancel(notificationIdFor(`call:${callId}`)).catch(() => {})
    // A notificação de chamada do Android (full-screen + botões) some junto.
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

// ---------- clique → abrir conversa ----------
type OpenHandler = (convId: string) => void
const openHandlers = new Set<OpenHandler>()

export function onOpenConversation(cb: OpenHandler): () => void {
  openHandlers.add(cb)
  return () => { openHandlers.delete(cb) }
}

function dispatchOpen(convId: string) {
  for (const h of openHandlers) {
    try { h(convId) } catch { /* handler quebrado não impede os outros */ }
  }
}

let startWired = false

  /**
   * Liga o ouvinte do clique na notificação. Idempotente; o Rust emite
   * `distorrent://notification-action` com a conversa que ele mesmo guardou.
   */
export function initNotifications() {
  if (startWired) return
  startWired = true
  if (services.kind !== 'native') return
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
    .catch(() => { /* shell sem o evento: clique só foca a janela */ })

  // ANDROID — "Atender"/"Recusar" da notificação: via plugin (app vivo) ou
  // drenando a intenção guardada UMA vez (boot a frio), senão a chamada
  // continuava tocando com o processo morto.
  void import('@tauri-apps/api/core')
    .then(async ({ addPluginListener }) => {
      await addPluginListener<{ call_id?: string; action?: string }>(
        'callnotif',
        'action',
        (p) => dispatchCallAction(p?.call_id ?? '', p?.action ?? 'open'),
      )
    })
    .catch(() => { /* desktop/shell sem o plugin: nada a fazer */ })

  // Boot a frio (uma vez): pequeno atraso para o shell montar o listener.
  setTimeout(() => {
    void services
      .callPendingAction()
      .then((r) => {
        if (r.action || r.call_id) dispatchCallAction(r.call_id, r.action || 'open')
      })
      .catch(() => {})
  }, 1200)
}

// ---------- ação de chamada vinda da notificação ----------
type CallActionHandler = (callId: string, action: string) => void
const callActionHandlers = new Set<CallActionHandler>()

/**
 * Registra quem sabe atender/recusar uma chamada a partir da notificação.
 * Usado pelos shells (que têm o `callManager` e a navegação).
 */
export function onCallNotificationAction(cb: CallActionHandler): () => void {
  callActionHandlers.add(cb)
  return () => { callActionHandlers.delete(cb) }
}

function dispatchCallAction(callId: string, action: string) {
  if (!callId) return
  for (const h of callActionHandlers) {
    try { h(callId, action) } catch { /* handler quebrado não impede os outros */ }
  }
}

/** Permissão do SO (Android 13+ pergunta; desktop é sempre concedida). */
export async function notificationPermission(): Promise<string> {
  if (services.kind !== 'native') return 'unsupported'
  try { return await services.notificationPermission() } catch { return 'unknown' }
}

export async function requestNotificationPermission(): Promise<string> {
  if (services.kind !== 'native') return 'unsupported'
  try { return await services.notificationRequestPermission() } catch { return 'denied' }
}

/** Botão "testar som" das configurações. */
export function testNotificationSound(): void {
  void show({
    id: notificationIdFor(`test:${Date.now()}`),
    title: 'DisTorrent',
    body: 'É assim que um aviso aparece.',
    silent: false,
  })
}
