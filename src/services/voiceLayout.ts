export type VoiceScreenMode =
  | 'lobby'
  | 'in-call'

export interface VoiceLayoutInput {
  isChannel: boolean
  inThisCall: boolean
  hasActiveCall: boolean
  widthPx?: number
}

export interface VoiceLayout {
  mode: VoiceScreenMode
  stageFill: boolean
  controlsWidthPx: number
  showChannelHeader: boolean
  showText: boolean
  showMemberList: boolean
}

export const CONTROLS_WIDTH_PX = 320
export const MEMBERS_MIN_WIDTH_PX = 1180

export function resolveVoiceLayout(input: VoiceLayoutInput): VoiceLayout {
  const isChannel = input.isChannel === true
  const inCall = input.inThisCall === true
  const width = typeof input.widthPx === 'number' && Number.isFinite(input.widthPx)
    ? input.widthPx
    : 0

  if (inCall) {
    return {
      mode: 'in-call',
      stageFill: true,
      controlsWidthPx: CONTROLS_WIDTH_PX,
      showChannelHeader: isChannel,
      showText: false,
      showMemberList: width === 0 ? true : width >= MEMBERS_MIN_WIDTH_PX,
    }
  }

  if (isChannel) {
    return {
      mode: 'lobby',
      stageFill: false,
      controlsWidthPx: 0,
      showChannelHeader: true,
      showText: false,
      showMemberList: width === 0 ? true : width >= MEMBERS_MIN_WIDTH_PX,
    }
  }

  return {
    mode: 'lobby',
    stageFill: false,
    controlsWidthPx: 0,
    showChannelHeader: false,
    showText: true,
    showMemberList: width === 0 ? true : width >= MEMBERS_MIN_WIDTH_PX,
  }
}

export function callScreenTitle(input: {
  channelName?: string | null
  conversationTitle?: string | null
  peerName?: string | null
  fallback?: string
}): string {
  const nome = input.channelName || input.conversationTitle || input.peerName
  const limpo = typeof nome === 'string' ? nome.trim() : ''
  return limpo || input.fallback || 'Chamada'
}

export function participantsLabel(total: number): string {
  const n = Number.isFinite(total) ? Math.max(0, Math.floor(total)) : 0
  if (n === 0) return 'ninguém na chamada'
  return `${n} ${n === 1 ? 'pessoa' : 'pessoas'} na chamada`
}
