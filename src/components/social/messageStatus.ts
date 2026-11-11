export function statusGlyph(status: string): string {
  switch (status) {
    case 'read':
    case 'delivered':
      return '✓✓'
    case 'sent':
      return '✓'
    case 'sending':
      return '○'
    case 'pending':
      return '🕓'
    case 'failed':
      return '✕'
    default:
      return ''
  }
}

export function statusTitle(status: string, peerOnline?: boolean): string {
  switch (status) {
    case 'read':
      return 'lida'
    case 'delivered':
      return 'entregue'
    case 'sent':
      return 'enviada'
    case 'sending':
      // "enviando…" só com o peer online; offline isso mentiria (a mensagem
      // pode nem ter saído do outbox). O texto certo é o de fila.
      return peerOnline ? 'enviando…' : 'na fila — entrega quando o contato voltar'
    case 'pending':
      return peerOnline
        ? 'na fila: o contato está online mas ainda não confirmou a entrega'
        : 'aguardando conexão'
    case 'failed':
      return 'não entregue — tentaremos de novo ao reconectar (ou clique para reenviar agora)'
    default:
      return ''
  }
}

export type ConversationKind = 'dm' | 'group' | 'channel'

export interface ReadReceipt {
  fp: string
  at: number
}

export interface ReceiptPerson {
  fp: string
  name: string
  readAt: number
  read: boolean
}

export interface ReceiptsView {
  kind: ConversationKind | null
  others: ReceiptPerson[]
  readers: ReceiptPerson[]
  missing: ReceiptPerson[]
  total: number
  membersKnown: boolean
  readersKnown: boolean
  allRead: boolean
}

export interface ReceiptGroupView {
  titulo: string
  pessoas: ReceiptPerson[]
  tom: 'read' | 'missing' | 'unknown'
}

export interface ConversationLike {
  id: string
  kind: string
}

export interface CommunityLike {
  channels: [string, string][]
}

export function conversationKindOf(
  convId: string,
  conversations: ConversationLike[],
  communities: CommunityLike[],
): ConversationKind | null {
  if (!convId) return null
  const conv = conversations.find((c) => c.id === convId)
  if (conv) {
    if (conv.kind === 'dm') return 'dm'
    if (conv.kind === 'group') return 'group'
    return 'channel'
  }
  const canal = communities.some((c) => c.channels.some(([id]) => id === convId))
  return canal ? 'channel' : null
}

export function buildReceipts(args: {
  kind: ConversationKind | null
  members: [string, string][]
  myFp: string
  status?: string
  membersKnown?: boolean
  receipts?: ReadReceipt[]
  receiptsKnown?: boolean
}): ReceiptsView {
  const vistos = new Set<string>()
  const others: ReceiptPerson[] = []
  for (const [fp, nick] of args.members) {
    if (!fp || fp === args.myFp || vistos.has(fp)) continue
    vistos.add(fp)
    others.push({ fp, name: nick || fp.slice(0, 8), readAt: 0, read: false })
  }
  const porFp = new Map(others.map((p) => [p.fp, p]))
  const receipts = args.receipts ?? []
  for (const r of receipts) {
    if (!r.at) continue
    const alvo = porFp.get(r.fp)
    if (!alvo || r.at < alvo.readAt) continue
    alvo.readAt = r.at
    alvo.read = true
  }
  let conhecido = args.receiptsKnown ?? receipts.length > 0
  // Só existe status agregado: com um único outro membro, "read" só pode ser dele.
  if (!conhecido && receipts.length === 0 && args.status === 'read' && others.length === 1) {
    others[0].read = true
    conhecido = true
  }
  const readers = others.filter((p) => p.read)
  const missing = others.filter((p) => !p.read)
  return {
    kind: args.kind,
    others,
    readers,
    missing,
    total: others.length,
    membersKnown: !!args.membersKnown,
    readersKnown: conhecido,
    allRead: others.length > 0 && readers.length === others.length,
  }
}

// Em grupo/canal o `read` do core pode vir de UM membro: só vira azul com todos.
export function groupStatus(status: string, view: ReceiptsView): string {
  if (view.kind !== 'group' && view.kind !== 'channel') return status
  if (status !== 'read') return status
  return view.allRead ? 'read' : 'delivered'
}

export function receiptsHeadline(view: ReceiptsView): string {
  if (!view.membersKnown) return 'lista de membros ainda carregando'
  if (view.total === 0) return 'sem outros membros'
  if (view.allRead) return `todos os ${view.total} visualizaram`
  if (!view.readersKnown) return 'ainda não chegou nenhuma confirmação de leitura'
  return `${view.readers.length} de ${view.total} visualizaram`
}

// Separar "não leu" de "não sei" evita acusar quem talvez tenha lido.
export function receiptGroups(view: ReceiptsView): ReceiptGroupView[] {
  if (view.total === 0) return []
  if (!view.readersKnown) {
    return [{ titulo: 'sem confirmação de leitura', pessoas: view.others, tom: 'unknown' }]
  }
  const grupos: ReceiptGroupView[] = []
  if (view.readers.length > 0) grupos.push({ titulo: 'visualizaram', pessoas: view.readers, tom: 'read' })
  if (view.missing.length > 0) grupos.push({ titulo: 'ainda não', pessoas: view.missing, tom: 'missing' })
  return grupos
}

export function statusTitleFor(status: string, view: ReceiptsView, peerOnline?: boolean): string {
  if (view.kind === 'dm') return statusTitle(status, peerOnline)
  switch (status) {
    case 'read':
      return view.allRead ? `lida por todos os ${view.total}` : 'lida por parte dos membros'
    case 'delivered':
      return view.readers.length > 0
        ? `entregue — ${view.readers.length} de ${view.total} já visualizaram`
        : 'entregue — ninguém confirmou leitura ainda'
    case 'sent':
      return 'enviada aos membros online'
    case 'pending':
      return 'aguardando os membros ficarem online'
    default:
      return statusTitle(status, peerOnline)
  }
}
