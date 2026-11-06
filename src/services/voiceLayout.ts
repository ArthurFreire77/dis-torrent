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

/** Largura mínima para conversar: coluna de texto legível. */
export const MAIN_MIN_WIDTH_PX = 560

/** Chrome fixo à esquerda e à direita (rail 72 + lista lateral 240). */
export const FIXED_CHROME_PX = 312

/** Abaixo disso o painel flutuante não serve: é melhor sobrepor. */
export const PANEL_MIN_WIDTH_PX = 300

export type CallPanelSize = 'compact' | 'normal' | 'expanded'

/** Largura efetiva do painel flutuante da chamada, em px, para uma janela. */
export function callPanelWidth(size: CallPanelSize, widthPx: number): number {
  const w = typeof widthPx === 'number' && Number.isFinite(widthPx) ? Math.max(0, widthPx) : 0
  if (size === 'compact') return 300
  if (size === 'expanded') return Math.min(720, w * 0.56)
  return Math.min(520, Math.max(320, w * 0.36))
}

export interface CallDockInput {
  hasActiveCall: boolean
  inThisCall: boolean
  panelSize: CallPanelSize
  /**
   * Largura REAL do chrome fixo (rail + listas), medida no DOM como
   * `pai.clientWidth - coluna.clientWidth`. Preferida sobre a constante porque
   * com servidor aberto entra a lista de membros e a soma muda.
   */
  chromePx?: number
  widthPx?: number
}

export interface CallDock {
  /** O painel da chamada aparece como coluna flutuante à direita. */
  panelVisible: boolean
  /** Reserva de espaço (margin-right) da coluna principal, em px. */
  mainInsetPx: number
  /** O painel cabe ao lado sem esmagar a conversa; senão precisa sobrepor. */
  sideBySide: boolean
}

function chromeReal(input: CallDockInput): number {
  const medido = input.chromePx
  if (typeof medido === 'number' && Number.isFinite(medido) && medido > 0) return medido
  return FIXED_CHROME_PX
}

/** Espaço livre para a coluna principal (janela menos o chrome fixo). */
function espacoLivre(input: CallDockInput): number {
  const width = typeof input.widthPx === 'number' && Number.isFinite(input.widthPx) ? input.widthPx : 0
  if (width <= 0) return 0
  return Math.max(0, width - chromeReal(input))
}

/**
 * Decide como o painel da chamada convive com a coluna principal.
 *
 * Antes o shell reservava `clamp(320px,36vw,520px)` só com `marginRight`, sem
 * teto: em 1280px o composer caía de 546px para 85px (uma letra por linha) e
 * em 1100px para 0. Aqui a margem é o menor valor entre o que o painel quer e
 * o que sobra acima do mínimo legível; se nem o mínimo cabe, o painel sobrepõe.
 */
export function resolveCallDock(input: CallDockInput): CallDock {
  const visivel = input.hasActiveCall === true && input.inThisCall !== true
  if (!visivel) return { panelVisible: false, mainInsetPx: 0, sideBySide: true }

  const livre = espacoLivre(input)
  const desejado = callPanelWidth(input.panelSize, livre || input.widthPx || 0)
  if (livre <= 0) return { panelVisible: true, mainInsetPx: desejado, sideBySide: true }

  const sobra = livre - MAIN_MIN_WIDTH_PX
  if (sobra < PANEL_MIN_WIDTH_PX) return { panelVisible: true, mainInsetPx: 0, sideBySide: false }
  return { panelVisible: true, mainInsetPx: Math.min(desejado, sobra), sideBySide: true }
}

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
