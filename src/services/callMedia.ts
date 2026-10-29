/** Direções válidas de um transceiver de vídeo da chamada. */
export type CallVideoDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' | 'stopped'

export interface CallVideoTransceiver {
  direction: CallVideoDirection
}

/**
 * Ajusta a direção do m-line de vídeo para o estado local desejado.
 * `replaceTrack()` troca o conteúdo, mas não altera a direção negociada: sem
 * esta promoção, compartilhar tela numa chamada de voz mantém o SDP `recvonly`
 * e a captura abre sem transmitir nenhum quadro ao outro participante.
 */
export function setCallVideoSending(
  transceiver: CallVideoTransceiver,
  sending: boolean,
): boolean {
  const next: CallVideoDirection = sending
    ? (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive'
      ? 'sendrecv'
      : transceiver.direction)
    : (transceiver.direction === 'sendrecv'
      ? 'recvonly'
      : transceiver.direction === 'sendonly'
        ? 'inactive'
        : transceiver.direction)

  if (next === transceiver.direction) return false
  transceiver.direction = next
  return true
}
