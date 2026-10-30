// Convites recebidos por DEEP LINK — um único ponto de entrada para os dois
// shells.
//
// ## O problema que isto resolve
//
// O `App.tsx` já escutava `deep-link://new-url`, mas só fazia `navigate(...)`
// com a query `?invite=`. Os shells liam `window.location.search` UMA VEZ, na
// montagem (deps `[]` / `[phase]`). Com o app JÁ ABERTO — o caso normal de
// quem clica no convite recebido — nenhum efeito reexecutava e o convite era
// descartado em silêncio, deixando a URL poluída.
//
// ## Desenho
//
// Um store de módulo com:
//   - `pendingToken`: o convite ainda não consumido;
//   - `subscribe`: os shells escutam e abrem o modal na hora;
//   - `consume`: leitura destrutiva, para o MESMO convite não ser processado
//     duas vezes (deep link + `?invite=` da URL de boot).
//
// Não guarda nada em disco: convite é efêmero. O token persistido de verdade é
// o `join.pending.*` do Rust, que sobrevive a reinício.

import { createEmitter } from '../shared/emitter.ts'

type Listener = (token: string) => void

let pendingToken: string | null = null
/** Últimos tokens processados — dedupe por igualdade exata. */
const seen = new Set<string>()
// Emissor compartilhado: isola falha de um shell e devolve cancelamento
// idempotente (antes era um `Set` + laço próprio, igual ao de appState/notifications).
const invites = createEmitter<string>()

/**
 * Extrai o token de qualquer forma aceita: `distorrent://invite?invite=TOKEN`,
 * `...?token=TOKEN`, `/invite/TOKEN` ou o token cru.
 *
 * Não valida criptografia (isso é do core): só separa o payload do link. Um
 * token inválido precisa chegar ao core para produzir a mensagem específica
 * ("expirado", "para outro fingerprint"), em vez de um "link inválido" vago.
 */
export function tokenFromInviteUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (!value.includes('://') && !value.startsWith('/')) {
    return value // token cru (base64url / local-invite no modo dev)
  }
  try {
    const url = new URL(value.startsWith('/') ? `http://local${value}` : value)
    const fromQuery = url.searchParams.get('invite') || url.searchParams.get('token')
    if (fromQuery) return fromQuery.trim() || null
    // /invite/TOKEN — o último segmento não vazio.
    const seg = url.pathname.split('/').filter(Boolean).pop()
    return seg ? decodeURIComponent(seg) : null
  } catch {
    return null
  }
}

/**
 * Registra um convite recebido. Idempotente: o mesmo token não notifica duas
 * vezes (deep link no boot + query da URL são caminhos que se sobrepõem).
 * Devolve `true` se era novo.
 */
export function offerInvite(raw: string): boolean {
  const token = tokenFromInviteUrl(raw)
  if (!token) return false
  if (seen.has(token)) {
    return false
  }
  seen.add(token)
  if (seen.size > 32) {
    // anti-crescimento: convites antigos não interessam mais.
    const first = seen.values().next()
    if (!first.done) seen.delete(first.value)
  }
  pendingToken = token
  invites.emit(token)
  return true
}

/** Convite que chegou antes de o shell montar (boot). Não destrutivo. */
export function peekInvite(): string | null {
  return pendingToken
}

/** Lê e limpa. Quem chamar assume a responsabilidade de abrir o fluxo. */
export function consumeInvite(): string | null {
  const token = pendingToken
  pendingToken = null
  return token
}

export function subscribeInvite(cb: Listener): () => void {
  return invites.subscribe(cb)
}

/** Só para testes: limpa o estado do módulo entre casos. */
export function __resetInviteForTests(): void {
  pendingToken = null
  seen.clear()
  invites.clear()
}
