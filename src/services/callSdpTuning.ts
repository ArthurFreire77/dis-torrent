import { applyOfferInStable as applyOfferToSession } from './callMedia'
import { tuneOpusSdp } from './callPeer'

export { tuneOpusSdp }

/** Aplica a offer só em `stable`; se a offer remota chegar no meio, devolve null. */
export async function applyOfferInStable(
  pc: RTCPeerConnection,
  opts?: { iceRestart?: boolean },
): Promise<RTCSessionDescriptionInit | null> {
  return applyOfferToSession<RTCSessionDescriptionInit>(pc, {
    ...opts,
    tuneSdp: tuneOpusSdp,
  })
}
