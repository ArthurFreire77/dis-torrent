// REGRAS PURAS de notificação/presença — sem I/O, sem DOM, sem Tauri.
//
// Existem separadas de `notifications.ts`/`appState.ts` por um motivo prático:
// são as decisões que erram fácil ("notificou duplicado", "ficou online em
// segundo plano", "vazou prévia") e por isso precisam de teste unitário que
// roda em Node puro, sem WebView nem SO.

export type Presenca = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'
export type AppAtividade = 'active' | 'background'
export type NivelNotif = 'all' | 'mentions' | 'none'

/**
 * CONEXÃO ≠ PRESENÇA.
 *
 * - `online` com a janela fora de foco vira `idle` (ausente) por padrão;
 * - `dnd`/`invisible`/`offline`/`idle` escolhidos pelo usuário NÃO mudam
 *   sozinhos (são decisões explícitas);
 * - `keepOnline` é a preferência "continuar online mesmo minimizado".
 */
export function derivePresence(
  desired: Presenca,
  activity: AppAtividade,
  keepOnline: boolean,
): Presenca {
  if (desired !== 'online') return desired
  if (activity === 'active') return 'online'
  return keepOnline ? 'online' : 'idle'
}

/** Id estável e positivo por conversa (substitui o aviso anterior dela). */
export function notificationIdFor(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
  return (Math.abs(h) % 2_000_000_000) + 1
}

export function truncate(s: string, n = 140): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean
}

/** Mesma decisão da UI: silenciado > nível do canal > padrão. */
export function levelAllows(level: NivelNotif, mentioned: boolean): boolean {
  if (level === 'none') return false
  if (level === 'mentions') return mentioned
  return true
}

export interface MessageDecisionInput {
  level: NivelNotif
  mentioned: boolean
  activity: AppAtividade
  /** Conversa aberta na UI (null = nenhuma). */
  openConversation: string | null
  conversationId: string
  /** Avisos do SO ligados nas preferências. */
  systemEnabled: boolean
  /** Prévia do texto ligada. */
  previewEnabled: boolean
  /** Quantas mensagens já agregadas nesta conversa (inclui a atual). */
  count: number
  preview: string
}

export interface MessageDecision {
  /** Vai para o SO? `false` = a UI já cobre (badge/som) ou está silenciado. */
  show: boolean
  /** Corpo do aviso (já respeitando a preferência de prévia). */
  body: string
  /** Contabiliza como não-lida? (silenciado não conta no badge do SO) */
  counts: boolean
}

/**
 * Decide o aviso de uma mensagem recebida.
 *
 * Primeiro plano NUNCA gera aviso do SO: quem avisa é a própria interface. O
 * contador de não-lidas continua atualizando, para o badge e a bandeja.
 */
export function decideMessageNotice(i: MessageDecisionInput): MessageDecision {
  const counts = levelAllows(i.level, i.mentioned)
  const body = !i.previewEnabled
    ? (i.count > 1 ? `${i.count} novas mensagens` : 'Nova mensagem')
    : (i.count > 1 ? `${i.count} novas mensagens · ${truncate(i.preview)}` : truncate(i.preview))

  if (!counts) return { show: false, body, counts: false }
  if (i.activity === 'active') return { show: false, body, counts: true }
  if (i.openConversation === i.conversationId) return { show: false, body, counts: true }
  if (!i.systemEnabled) return { show: false, body, counts: true }
  return { show: true, body, counts: true }
}

/**
 * Tracker de dedupe com teto (LRU simples). Evita o mesmo `id` de mensagem
 * gerar dois avisos (evento reaplicado, reconexão, replay do relay).
 */
export function createSeenTracker(max = 600) {
  const set = new Set<string>()
  const order: string[] = []
  return {
    /** `true` se já tinha visto. Marca como visto. */
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
