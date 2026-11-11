/**
 * Regras sociais puras, compartilhadas pelo desktop e pelo mobile.
 *
 * A UI não decide sozinha quem pode conversar nem quantas mensagens iniciais
 * restam: o Rust é a autoridade. Estas funções só traduzem o estado que o
 * motor devolve para o que a tela mostra — e são testáveis sem Tauri.
 */

export type FriendStatus =
  | 'accepted'
  | 'pending_in'
  | 'pending_out'
  | 'blocked'
  | 'rejected'
  | 'removed'
  | string

export type SocialRelation = 'self' | 'friend' | 'blocked' | 'request_in' | 'request_out' | 'none'

export interface FriendStateView {
  fp: string
  status: FriendStatus
  /// Quem pediu, quando pendente. `''` nos demais estados.
  requested_by?: string
}

/** Traduz o status persistido para a relação que a UI entende. */
export function relationOf(state: FriendStateView | null | undefined, myFp: string): SocialRelation {
  if (!state) return 'none'
  if (state.fp === myFp) return 'self'
  switch (state.status) {
    case 'accepted':
      return 'friend'
    case 'blocked':
      return 'blocked'
    case 'pending_in':
      return 'request_in'
    case 'pending_out':
      return 'request_out'
    default:
      return 'none'
  }
}

/**
 * Posso abrir uma conversa com esta pessoa?
 *
 * Amigo sempre pode. Contato elegível (mesmo grupo/servidor) também — é a
 * "introdução" de até três mensagens. Bloqueado nunca. Desconhecido não:
 * apresentar um botão que o motor vai recusar é estado falso.
 */
export function canOpenConversation(input: {
  relation: SocialRelation
  sharedGroup?: boolean
  sharedCommunity?: boolean
}): boolean {
  if (input.relation === 'friend') return true
  if (input.relation === 'blocked' || input.relation === 'self') return false
  return !!input.sharedGroup || !!input.sharedCommunity
}

export interface IntroState {
  /// Mensagens iniciais ainda disponíveis nesta direção.
  remaining: number
  /// A conversa está liberada (amizade aceita) — sem limite.
  unlimited: boolean
  /// Não pode mais enviar sem amizade.
  blocked: boolean
  /// Texto pronto para a faixa do compositor, ou `null` quando não há nada.
  hint: string | null
}

/**
 * Estado do limite de três mensagens.
 *
 * `used` vem do motor (persistido por conversa e por autor). A amizade
 * aceita zera o limite: o histórico continua, mas a conversa deixa de ser
 * uma introdução.
 */
export function introState(input: {
  isFriend: boolean
  used: number
  limit?: number
}): IntroState {
  const limit = input.limit ?? 3
  if (input.isFriend) {
    return { remaining: Infinity, unlimited: true, blocked: false, hint: null }
  }
  const used = Math.max(0, Math.min(Math.floor(input.used || 0), limit))
  const remaining = Math.max(0, limit - used)
  if (remaining === 0) {
    return {
      remaining: 0,
      unlimited: false,
      blocked: true,
      hint: 'Limite de mensagens iniciais atingido — envie uma solicitação de amizade para continuar.',
    }
  }
  return {
    remaining,
    unlimited: false,
    blocked: false,
    hint:
      remaining === limit
        ? `Você pode enviar até ${limit} mensagens iniciais antes de virar amizade.`
        : `Mensagem inicial ${used + 1} de ${limit} — depois disso, só com amizade.`,
  }
}

/** Rótulo do contato na lista. Diz a verdade sobre o relacionamento em vez de chamar todo mundo de "contato" ou de "amigo". */
export function contactBadge(input: {
  relation: SocialRelation
  sharedGroup?: boolean
  sharedCommunity?: boolean
}): 'amigo' | 'solicitação' | 'solicitado' | 'bloqueado' | 'mesmo grupo' | 'mesmo servidor' | 'contato' {
  switch (input.relation) {
    case 'friend':
      return 'amigo'
    case 'request_in':
      return 'solicitação'
    case 'request_out':
      return 'solicitado'
    case 'blocked':
      return 'bloqueado'
    default:
      if (input.sharedGroup) return 'mesmo grupo'
      if (input.sharedCommunity) return 'mesmo servidor'
      return 'contato'
  }
}

/**
 * Presença que a UI deve pintar.
 *
 * Conexão P2P e status escolhido são coisas diferentes: estar conectado não
 * significa "online" se a pessoa escolheu invisível. E offline vence sempre,
 * porque um peer sem link não está disponível para conversar agora.
 */
export function effectivePresence(input: {
  connected: boolean
  chosen?: string
}): 'online' | 'idle' | 'dnd' | 'invisible' | 'offline' {
  if (!input.connected) return 'offline'
  const c = input.chosen
  if (c === 'invisible') return 'invisible'
  if (c === 'idle') return 'idle'
  if (c === 'dnd') return 'dnd'
  return 'online'
}

/**
 * A pessoa conta como "online" na interface?
 *
 * Invisível é conexão válida, mas não pode acender o ponto verde: a lista e a
 * conversa precisavam concordar — antes a lista pintava verde e o cabeçalho
 * dizia offline para o mesmo peer.
 */
export function isPresenceOnline(input: {
  connected: boolean
  chosen?: string
}): boolean {
  const p = effectivePresence(input)
  return p !== 'offline' && p !== 'invisible'
}

export type ConversationFilter = 'todos' | 'amigos' | 'contatos' | 'grupos'

/**
 * Filtro da área de conversas diretas. Grupo só entra em "todos"/"grupos";
 * contato é toda DM cujo peer NÃO tem amizade aceita.
 */
export function conversationMatchesFilter(input: {
  kind: string
  peerFp?: string
  filter: ConversationFilter
  friendFps: ReadonlySet<string> | readonly string[]
}): boolean {
  if (input.filter === 'todos') return true
  const isGroup = input.kind === 'group'
  if (input.filter === 'grupos') return isGroup
  if (isGroup) return false
  const amigos = input.friendFps instanceof Set ? input.friendFps : new Set(input.friendFps)
  const isFriend = !!input.peerFp && amigos.has(input.peerFp)
  return input.filter === 'amigos' ? isFriend : !isFriend
}

/**
 * Chamada 1:1 só entre amizade aceita. Grupo/canal continua valendo pela
 * participação no grupo/servidor — a UI usa esta função apenas em DM.
 */
export function canCallPeer(relation: SocialRelation): { ok: boolean; reason: string | null } {
  if (relation === 'friend') return { ok: true, reason: null }
  if (relation === 'blocked') return { ok: false, reason: 'esta pessoa está bloqueada' }
  if (relation === 'self') return { ok: false, reason: 'não é possível ligar para você mesmo' }
  if (relation === 'request_in' || relation === 'request_out') {
    return { ok: false, reason: 'a amizade ainda não foi aceita — só amigos podem ligar' }
  }
  return {
    ok: false,
    reason: 'só amigos aceitos podem ligar — envie uma solicitação de amizade primeiro',
  }
}

/** Quantos pedidos de amizade estão esperando resposta (só os recebidos). */
export function pendingRequestsCount(list: FriendStateView[]): number {
  return list.filter((f) => f.status === 'pending_in').length
}
