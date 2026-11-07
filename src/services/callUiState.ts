import { isCallPhaseActive, type CallPhase } from './callPhases.ts'

/**
 * Regras puras da UI de chamada.
 *
 * O mesmo botão "Entrar" vive em cinco lugares (lobby do canal, cabeçalho da
 * conversa, lista lateral, modal da sala e celular). Antes cada um decidia
 * "posso entrar?" do seu jeito: uns olhavam `activeCall` cru (que continua
 * preenchido com fase `ended` até o cleanup) e ficavam desabilitados para
 * sempre; outros não olhavam nada e disparavam duas entradas no toque duplo.
 * A regra tem de ser uma só, e é aqui.
 */

export interface CallLike {
  phase?: CallPhase | string | null
}

/** `state` só conta como chamada viva enquanto a fase está ativa. */
export function callIsActive(state: CallLike | null | undefined): boolean {
  if (!state) return false
  // A máquina de fases é a única fonte: `ended`/`rejected`/`failed`/`missed`
  // continuam no state até o cleanup e não podem bloquear o próximo "Entrar".
  const phase = String(state.phase ?? '')
  if (!phase) return false
  return isCallPhaseActive(phase as CallPhase)
}

export type JoinTone = 'join' | 'busy' | 'unavailable' | 'joining'

export interface JoinButtonInput {
  /** Já estou NESTA chamada: o botão vira "Sair", então não se aplica. */
  inThisCall?: boolean
  /** Existe OUTRA chamada viva (ou um join em andamento). */
  busy?: boolean
  /** Entrada desta tela em andamento (clique já registrado). */
  joining?: boolean
  /** Motivo de indisponibilidade do aparelho (WebRTC/captura ausente). */
  unavailable?: string | null
}

export interface JoinButtonState {
  disabled: boolean
  label: string
  reason: string | null
  ariaLabel: string
  tone: JoinTone
}

export function joinButtonState(input: JoinButtonInput): JoinButtonState {
  const unavailable = typeof input.unavailable === 'string' && input.unavailable.trim()
    ? input.unavailable.trim()
    : null
  if (unavailable) {
    return {
      disabled: true,
      label: 'Chamada indisponível',
      reason: unavailable,
      ariaLabel: 'Chamada indisponível',
      tone: 'unavailable',
    }
  }
  if (input.busy) {
    return {
      disabled: true,
      label: 'Já existe uma chamada',
      reason: 'já existe uma chamada em andamento — encerre a atual antes de entrar',
      ariaLabel: 'Já existe uma chamada em andamento',
      tone: 'busy',
    }
  }
  if (input.joining) {
    return {
      disabled: true,
      label: 'Entrando…',
      reason: 'entrando na chamada',
      ariaLabel: 'Entrando na chamada',
      tone: 'joining',
    }
  }
  return {
    disabled: false,
    label: 'Entrar na chamada',
    reason: null,
    ariaLabel: 'Entrar na chamada',
    tone: 'join',
  }
}

/**
 * Deve o painel flutuante da chamada aparecer? Só com chamada VIVA e fora do
 * palco; e `hidden` não pode esconder para sempre — quem esconde ganha um
 * botão de reabrir (ver `callPanelReopenVisible`).
 */
export function callPanelVisible(input: {
  state: CallLike | null | undefined
  inThisCall: boolean
}): boolean {
  return callIsActive(input.state) && input.inThisCall !== true
}

/** Existe chamada viva que a tela atual NÃO mostra (precisa de "voltar"). */
export function callElsewhere(
  state: CallLike | null | undefined,
  showing: boolean,
): boolean {
  return callIsActive(state) && showing !== true
}

export interface MediaLiveInput {
  participants?: Array<{
    videoUrl?: string | null
    stream?: { getTracks?: () => Array<{ readyState?: string }> } | null
  }> | null
  localStream?: { getTracks?: () => Array<{ readyState?: string }> } | null
  localScreenStream?: { getTracks?: () => Array<{ readyState?: string }> } | null
  sharing?: boolean
}

function temTrilhaViva(stream: MediaLiveInput['localStream']): boolean {
  try {
    const tracks = stream?.getTracks?.() ?? []
    return tracks.some((t) => t?.readyState === 'live')
  } catch {
    return false
  }
}

/**
 * "Tem mídia viva?" inclui a TELA. Antes só câmera/stream remoto contavam e o
 * selo dizia "Conectado sem mídia" com a tela transmitindo e chegando.
 */
export function callMediaLive(input: MediaLiveInput): boolean {
  if (input.sharing === true) return true
  for (const p of input.participants ?? []) {
    if (p?.videoUrl) return true
    if (temTrilhaViva(p?.stream ?? null)) return true
  }
  return temTrilhaViva(input.localStream ?? null) || temTrilhaViva(input.localScreenStream ?? null)
}
