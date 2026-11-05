/**
 * Regras PURAS de quando cair para o áudio pela sinalização.
 *
 * POR QUE: a chamada ficava em "Conectando..." para sempre quando o ICE não
 * fechava (celular no 4G/CGNAT, escola com UDP bloqueado). O caminho de áudio
 * de reserva existia no `callManager` mas nunca era ligado sozinho — só pelo
 * botão manual. Extraído aqui para ser testável em Node, sem serviço/WebRTC.
 */

export interface RelayFallbackInput {
  /** Já está tocando pelo relay? */
  relayActive: boolean
  /** A plataforma tem MediaRecorder + AudioContext (dá para mandar/receber). */
  relaySupported: boolean
  /** Fase atual da chamada. */
  phase: string
  /** O usuário escolheu relay de propósito? Nesse caso nada desliga sozinho. */
  relayManual: boolean
}

/** Vale a pena tentar o áudio pela sinalização agora? */
export function shouldFallbackToRelay(input: RelayFallbackInput): boolean {
  if (input.relayActive) return false
  if (!input.relaySupported) return false
  if (input.relayManual) return false
  // Só faz sentido enquanto a chamada ainda pode virar "conectada".
  return input.phase === 'outgoing'
    || input.phase === 'connecting'
    || input.phase === 'reconnecting'
}

/**
 * Quando o ICE volta, o relay automático tem de sair de cena: manter os dois
 * tocando gera áudio duplicado e atrasado. Relay manual nunca sai sozinho.
 */
export function shouldDropRelayAfterIceRecovered(input: {
  relayActive: boolean
  relayManual: boolean
}): boolean {
  return input.relayActive && !input.relayManual
}

/**
 * A sinalização só carrega áudio. Para vídeo/tela continuamos dependendo do
 * WebRTC, então a UI precisa dizer a verdade em vez de prometer imagem.
 */
export function relayCoversVideo(): boolean {
  return false
}
