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

/** Estado de sinalização mínimo que a aplicação de offer precisa enxergar. */
export interface OfferSession {
  readonly signalingState: string
  createOffer(options?: { iceRestart?: boolean }): Promise<{ type: string; sdp?: string }>
  // `string` no tipo: o valor real é `RTCSdpType`, mas aqui só repassamos o
  // `type` da offer criada pelo próprio PC — sem conversão insegura no manager.
  setLocalDescription(desc: any): Promise<void>
}

/**
 * Cria a offer e a aplica SÓ se o PC continuar em `stable`.
 *
 * `createOffer()` é assíncrono: se uma oferta remota chegar no meio, o
 * `setLocalDescription` estoura "Failed to set local offer sdp: Called in
 * wrong state: have-remote-offer" e a renegociação (câmera, tela, qualidade,
 * ICE restart) se perde — era a chamada que só pegava na segunda tentativa.
 *
 * Devolve a offer aplicada, ou `null` quando o estado mudou (quem chamou
 * decide o que fazer). `tuneSdp` é injetado para manter esta função pura e
 * testável sem o resto do `callManager`.
 */
export async function applyOfferInStable<T extends { type: string; sdp?: string }>(
  pc: OfferSession,
  opts?: { iceRestart?: boolean; tuneSdp?: (sdp: string) => string },
): Promise<T | null> {
  const sig = (): string => String(pc.signalingState ?? '')
  if (sig() !== 'stable') return null
  const offer = (await pc.createOffer(
    opts?.iceRestart ? { iceRestart: true } : undefined,
  )) as T
  // O estado pode ter mudado DURANTE o createOffer: checar de novo, sempre.
  if (sig() !== 'stable') return null
  if (opts?.tuneSdp) offer.sdp = opts.tuneSdp(offer.sdp ?? '')
  await pc.setLocalDescription(offer)
  return offer
}
