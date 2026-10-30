// Regras PURAS de canal: categorias e validação de nome.
//
// Estavam dentro de `ChannelManager.tsx` (um componente React que importa
// `services` e `ui`). Isso obrigava o assistente de criação de servidor — que
// também valida nomes de canal — a carregar a tela inteira de gerenciamento só
// para chamar uma função de string, e impedia testar a regra no `node --test`.
//
// A regra espelha o core (`names.rs`, `NameKind::Channel`: 2–40, só
// `[a-z0-9-]`, único no escopo). Divergir daqui significa o core recusar um
// canal que a UI disse estar válido.

import type { ChannelMeta } from '../../services/models'

export const CATEGORIAS_PADRAO = ['CANAIS DE TEXTO', 'CANAIS DE VOZ', 'CANAIS DE VÍDEO']

/** Limites do core para canal. */
export const CANAL_MIN = 2
export const CANAL_MAX = 40

export function normChannelName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-')
}

/**
 * Valida o nome de um canal.
 * `editandoId` é o canal que está sendo renomeado: ele não conta como duplicata.
 */
export function validateChannelName(
  nome: string,
  existentes: ChannelMeta[],
  editandoId?: string | null,
): string | null {
  const n = nome.trim()
  if (!n) return 'Dê um nome ao canal.'
  if (!/^[a-z0-9-]+$/.test(n.toLowerCase())) {
    return 'Use apenas letras minúsculas, números e hífen. Ex.: geracao-antiga'
  }
  if (n.length < CANAL_MIN) return `O nome precisa ter pelo menos ${CANAL_MIN} caracteres.`
  if (n.length > CANAL_MAX) return `O nome pode ter no máximo ${CANAL_MAX} caracteres.`
  const alvo = normChannelName(n)
  const dup = existentes.some((c) => c.id !== editandoId && normChannelName(c.name) === alvo)
  if (dup) return 'Já existe um canal com esse nome.'
  return null
}
