export interface VoiceChannelRef {
  communityId: string
  channelId: string
}

export const VOICE_CALL_PREFIX = 'voice-'

export function isVoiceChannelCall(callId: unknown): callId is string {
  return typeof callId === 'string' && callId.startsWith(VOICE_CALL_PREFIX)
}

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

export function voiceCallId(communityId: string, channelId: string): string {
  return `${VOICE_CALL_PREFIX}${communityId}-${channelId}`
}
