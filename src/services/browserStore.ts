// Persistência do MODO NAVEGADOR (`browserServices`) — fonte ÚNICA.
//
// O mock web gravava e lia as mesmas chaves em `localStorage` com o MESMO bloco
// copiado 11 vezes:
//
//     const raw = localStorage.getItem('distorrent:extras:communities') ?? '[]'
//     let list: CommunityView[] = []
//     try { list = JSON.parse(raw) } catch { /* browser mode */ }
//
// Cada cópia repetia as duas decisões que importam: JSON corrompido vira lista
// vazia (em vez de derrubar a tela) e a gravação falha em silêncio quando o
// `localStorage` está cheio ou bloqueado por modo privado. Isso é intencional —
// mas precisa ser decidido em UM lugar, senão uma das cópias "melhora" o
// comportamento sem as outras e o mock passa a divergir de si mesmo.
//
// Não é código de produção nativo: só o `browserServices` usa isto.

/** Lê uma lista JSON; qualquer problema (ausente, corrompido, sem storage) dá `[]`. */
export function readList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

/** Lê um objeto JSON chave→valor; qualquer problema dá `{}`. */
export function readMap<T>(key: string): Record<string, T> {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, T>
  } catch {
    return {}
  }
}

/**
 * Grava JSON. Devolve `true` quando gravou de fato.
 *
 * Quem precisa saber (ex.: mostrar "não foi possível salvar") usa o retorno; o
 * resto ignora. O importante é NÃO lançar: um `localStorage` cheio não pode
 * derrubar o fluxo de mensagem no modo web.
 */
export function writeJson(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Lê uma string crua. */
export function readString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Grava uma string crua (texto de regras, por exemplo). */
export function writeString(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

/** Chaves do mock web. Centralizadas porque duas delas são escritas em 3 telas. */
export const WEB_KEYS = {
  communities: 'distorrent:extras:communities',
  channels: 'distorrent:extras:channels',
  roles: 'distorrent:extras:roles',
  rules: (cid: string) => `distorrent:rules:${cid}`,
  rulesText: (cid: string) => `distorrent:rules:text:${cid}`,
} as const
