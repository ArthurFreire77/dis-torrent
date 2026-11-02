// Regras PURAS da interface de servidor no celular (testáveis sem DOM).
//
// Ficam aqui para o componente `MobileServerPanel` só desenhar: a mesma regra
// de "canal que entra em chamada" usada no desktop (`app/channels.ts`) não pode
// divergir entre as duas telas.

import type { ChannelMeta } from '../services/models'
import { isCallableChannel } from '../app/channels.ts'

/** Ícone do canal na lista do celular. */
export function channelIcon(kind: ChannelMeta['kind'] | undefined): 'speaker' | 'video' | 'hash' | 'tag' {
  if (kind === 'voice') return 'speaker'
  if (kind === 'video') return 'video'
  if (kind === 'forum') return 'tag'
  return 'hash'
}

/**
 * O que o toque no canal FAZ, em texto (usado no title/aria do botão).
 * `peers` = gente no canal agora; `inChannel` = eu estou neste canal.
 */
export function channelActionLabel(
  kind: ChannelMeta['kind'] | undefined,
  peers: number,
  inChannel: boolean,
): string {
  if (!isCallableChannel(kind)) return 'Abrir canal de texto'
  const nome = kind === 'video' ? 'chamada de vídeo' : 'chamada de voz'
  if (inChannel) return `Sair da ${nome}`
  if (peers > 0) return `Entrar na ${nome} — ${peers} ${peers === 1 ? 'pessoa' : 'pessoas'}`
  return `Entrar na ${nome}`
}

/** Só o dono altera canais (o core também recusa qualquer outro). */
export function canManageChannels(ownerFp: string | undefined, myFp: string | undefined): boolean {
  return !!ownerFp && !!myFp && ownerFp === myFp
}

/** Subcategoria padrão por tipo — mesma regra do core (`channel_create`). */
export function defaultCategoryFor(kind: ChannelMeta['kind'] | undefined): string {
  if (kind === 'voice') return 'CANAIS DE VOZ'
  if (kind === 'video') return 'CANAIS DE VÍDEO'
  return 'CANAIS DE TEXTO'
}

/** Nome digitado → nome canônico do canal (o core re-valida de qualquer forma). */
export function normalizeChannelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-')
}
