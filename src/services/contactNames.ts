/**
 * Nome de exibição de um contato. Regra única para os dois shells.
 *
 * O nome de um SERVIDOR nunca é nome de pessoa: usar `community.name` como
 * fallback fazia o dono do servidor aparecer na chamada com o nome do servidor.
 */

export interface ContactNameInput {
  fp: string
  myFp?: string | null
  myNickname?: string | null
  /** Apelido dentro do servidor aberto (não o nome do servidor). */
  serverNickname?: string | null
  /** `display_name` do perfil público. */
  profileName?: string | null
  /** Apelido do registro de peer/amigo. */
  knownNickname?: string | null
}

export function shortFp(fp: string): string {
  return String(fp ?? '').slice(0, 8)
}

export function resolveContactName(input: ContactNameInput): string {
  const fp = typeof input.fp === 'string' ? input.fp : ''
  if (!fp) return ''
  if (input.myFp && fp === input.myFp) {
    const eu = (input.myNickname ?? '').trim()
    return eu || 'você'
  }
  const candidatos = [
    input.serverNickname,
    input.profileName,
    input.knownNickname,
  ]
  for (const c of candidatos) {
    const nome = typeof c === 'string' ? c.trim() : ''
    if (nome) return nome
  }
  return shortFp(fp)
}

/** Nome usado quando o contato ainda não tem perfil nem apelido conhecido. */
export function fallbackContactLabel(fp: string): string {
  return shortFp(fp)
}
