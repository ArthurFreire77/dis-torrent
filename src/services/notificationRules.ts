export type Presenca = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'
export type AppAtividade = 'active' | 'background'
export type NivelNotif = 'all' | 'mentions' | 'none'

export function derivePresence(
  desired: Presenca,
  activity: AppAtividade,
  keepOnline: boolean,
): Presenca {
  if (desired !== 'online') return desired
  if (activity === 'active') return 'online'
  return keepOnline ? 'online' : 'idle'
}

export function notificationIdFor(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
  return (Math.abs(h) % 2_000_000_000) + 1
}

export function truncate(s: string, n = 140): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean
}

export function levelAllows(level: NivelNotif, mentioned: boolean): boolean {
  if (level === 'none') return false
  if (level === 'mentions') return mentioned
  return true
}

export interface MessageDecisionInput {
  level: NivelNotif
  mentioned: boolean
  activity: AppAtividade
  openConversation: string | null
  conversationId: string
  systemEnabled: boolean
  previewEnabled: boolean
  count: number
  preview: string
}

export interface MessageDecision {
  show: boolean
  body: string
  counts: boolean
}

export function decideMessageNotice(i: MessageDecisionInput): MessageDecision {
  const counts = levelAllows(i.level, i.mentioned)
  const body = !i.previewEnabled
    ? 'Nova mensagem'
    : (i.preview.trim() ? truncate(i.preview) : 'Nova mensagem')

  if (!counts) return { show: false, body, counts: false }
  if (i.activity === 'active') return { show: false, body, counts: true }
  if (i.openConversation === i.conversationId) return { show: false, body, counts: true }
  if (!i.systemEnabled) return { show: false, body, counts: true }
  return { show: true, body, counts: true }
}

export function reactionNoticeKey(msgId: string, emoji: string, reactorFp: string): string {
  return `rx:${msgId}:${emoji}:${reactorFp}`
}

export interface ReactionDecisionInput {
  minhaMensagem: boolean
  euReagi: boolean
  add: boolean
  level: NivelNotif
  activity: AppAtividade
  openConversation: string | null
  conversationId: string
  systemEnabled: boolean
}

export function decideReactionNotice(i: ReactionDecisionInput): boolean {
  if (!i.minhaMensagem || i.euReagi || !i.add) return false
  if (i.level !== 'all') return false
  if (i.activity === 'active') return false
  if (i.openConversation === i.conversationId) return false
  if (!i.systemEnabled) return false
  return true
}

export function reactionNoticeBody(nome: string, emoji: string): string {
  const quem = (nome || '').trim() || 'alguém'
  const e = (emoji || '').trim()
  return e
    ? `${quem} reagiu ${e} na sua mensagem`
    : `${quem} reagiu na sua mensagem`
}

export function createSeenTracker(max = 600) {
  const set = new Set<string>()
  const order: string[] = []
  return {
    seen(id: string): boolean {
      if (!id) return false
      if (set.has(id)) return true
      set.add(id)
      order.push(id)
      if (order.length > max) {
        const old = order.shift()
        if (old) set.delete(old)
      }
      return false
    },
    clear() {
      set.clear()
      order.length = 0
    },
    get size() { return set.size },
  }
}
