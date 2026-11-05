import type { ChannelMeta } from '../services/models'
import { isCallableChannel } from '../app/channels.ts'

export function channelIcon(kind: ChannelMeta['kind'] | undefined): 'speaker' | 'video' | 'hash' | 'tag' {
  if (kind === 'voice') return 'speaker'
  if (kind === 'video') return 'video'
  if (kind === 'forum') return 'tag'
  return 'hash'
}

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

export function canManageChannels(ownerFp: string | undefined, myFp: string | undefined): boolean {
  return !!ownerFp && !!myFp && ownerFp === myFp
}

export function defaultCategoryFor(kind: ChannelMeta['kind'] | undefined): string {
  if (kind === 'voice') return 'CANAIS DE VOZ'
  if (kind === 'video') return 'CANAIS DE VÍDEO'
  return 'CANAIS DE TEXTO'
}

export function normalizeChannelName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, '-')
}
