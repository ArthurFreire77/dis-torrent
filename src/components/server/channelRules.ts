import type { ChannelMeta } from '../../services/models'

export const CATEGORIAS_PADRAO = ['CANAIS DE TEXTO', 'CANAIS DE VOZ', 'CANAIS DE VÍDEO']

export const CANAL_MIN = 2
export const CANAL_MAX = 40

export function normChannelName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-')
}

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
