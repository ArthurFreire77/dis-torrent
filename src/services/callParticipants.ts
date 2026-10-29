export interface CallParticipantView {
  fp: string
  nickname: string
  stream?: MediaStream
  speaking?: boolean
  muted?: boolean
  deafened?: boolean
  cameraOn?: boolean
  sharing?: boolean
  disconnected?: boolean
}

export function addVoiceParticipant(participants: CallParticipantView[], fp: string): boolean {
  if (!fp || participants.some((participant) => participant.fp === fp)) return false
  participants.push({ fp, nickname: fp.slice(0, 6), muted: false, deafened: false })
  return true
}

export function removeVoiceParticipant(participants: CallParticipantView[], fp: string): boolean {
  const index = participants.findIndex((participant) => participant.fp === fp)
  if (index < 0) return false
  participants.splice(index, 1)
  return true
}

export function updateVoiceParticipantState(
  participants: CallParticipantView[],
  fp: string,
  muted: boolean,
  deafened: boolean,
): boolean {
  const participant = participants.find((item) => item.fp === fp)
  if (!participant) return false
  const changed = participant.muted !== muted || participant.deafened !== deafened
  participant.muted = muted
  participant.deafened = deafened
  return changed
}
