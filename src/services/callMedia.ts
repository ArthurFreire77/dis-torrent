export type CallVideoDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' | 'stopped'

export interface CallVideoTransceiver {
  direction: CallVideoDirection
}

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

export interface OfferSession {
  readonly signalingState: string
  createOffer(options?: { iceRestart?: boolean }): Promise<{ type: string; sdp?: string }>
  setLocalDescription(desc: any): Promise<void>
}

export async function applyOfferInStable<T extends { type: string; sdp?: string }>(
  pc: OfferSession,
  opts?: { iceRestart?: boolean; tuneSdp?: (sdp: string) => string },
): Promise<T | null> {
  const sig = (): string => String(pc.signalingState ?? '')
  if (sig() !== 'stable') return null
  const offer = (await pc.createOffer(
    opts?.iceRestart ? { iceRestart: true } : undefined,
  )) as T
  if (sig() !== 'stable') return null
  if (opts?.tuneSdp) offer.sdp = opts.tuneSdp(offer.sdp ?? '')
  await pc.setLocalDescription(offer)
  return offer
}
