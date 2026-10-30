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

/**
 * Atualiza o apelido real de um participante.
 *
 * POR QUE ISTO EXISTE: todo participante de canal nascia com
 * `nickname: fp.slice(0, 6)` — a lista mostrava `a3f92c`, `7c1b04`. Para o
 * usuário, "fulano não apareceu": ele aparece, mas sem nome. O frontend já tem
 * a lista de membros do servidor (`communityMembers`), então resolve o nome
 * localmente, sem mexer no protocolo (nenhum frame novo no fio).
 */
export function setParticipantNickname(
  participants: CallParticipantView[],
  fp: string,
  nickname: string,
): boolean {
  if (!fp || !nickname) return false
  const participant = participants.find((item) => item.fp === fp)
  if (!participant || participant.nickname === nickname) return false
  participant.nickname = nickname
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
