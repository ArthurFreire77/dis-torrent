// voiceChannelRef — de qual SERVIDOR/CANAL é a chamada de voz atual.
//
// POR QUE EXISTE: o id da chamada de canal é `voice-<communityId>-<channelId>`
// e os dois ids já contêm hífen, então cortar por `-` devolve lixo. A UI
// guardava o canal num estado paralelo (`voiceChannel`) que só era preenchido
// quando a entrada acontecia pela sidebar: entrar pelo botão da tela do canal,
// pelo celular ou reentrar depois de sair deixava o estado vazio/velho. Efeito
// real: o botão da sidebar reentrava em vez de sair, e o "Sair" do celular
// chamava `voiceLeave` no servidor ERRADO (a sala continuava te vendo lá).
//
// Aqui a resposta vem do próprio `callId` — uma fonte só, impossível divergir.

export interface VoiceChannelRef {
  communityId: string
  channelId: string
}

/** Prefixo fixo das chamadas de canal. */
export const VOICE_CALL_PREFIX = 'voice-'

/** `true` quando o id é de uma chamada de CANAL (e não de DM/grupo). */
export function isVoiceChannelCall(callId: unknown): callId is string {
  return typeof callId === 'string' && callId.startsWith(VOICE_CALL_PREFIX)
}

/**
 * Decompõe `voice-<community>-<channel>` usando o `convId` como âncora do
 * canal (ele é o id do canal, com hífens inclusive).
 *
 * Devolve `null` quando o id não é de canal ou não fecha com o `convId` — nesse
 * caso quem chama deve tratar como "não sei onde estou" em vez de inventar.
 */
export function parseVoiceCallId(callId: unknown, convId?: unknown): VoiceChannelRef | null {
  if (!isVoiceChannelCall(callId)) return null
  const channelId = typeof convId === 'string' ? convId : ''
  if (!channelId) return null
  const sufixo = `-${channelId}`
  if (!callId.endsWith(sufixo)) return null
  const communityId = callId.slice(VOICE_CALL_PREFIX.length, callId.length - sufixo.length)
  if (!communityId) return null
  return { communityId, channelId }
}

/** Monta o id canônico (mesmo formato do core). */
export function voiceCallId(communityId: string, channelId: string): string {
  return `${VOICE_CALL_PREFIX}${communityId}-${channelId}`
}
