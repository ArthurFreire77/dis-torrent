export interface CollectiveRoomInput {
  callId: string
  participants: string[]
  invited?: string[]
  /** A conversa é um grupo/servidor: a chamada dura até o último sair. */
  group?: boolean
}

export function isCollectiveRoom(input: CollectiveRoomInput | null | undefined): boolean {
  if (!input) return false
  if (typeof input.callId === 'string' && input.callId.startsWith('voice-')) return true
  if (input.group === true) return true
  const noRoster = new Set(
    (Array.isArray(input.participants) ? input.participants : []).filter(
      (fp): fp is string => typeof fp === 'string' && fp.length > 0,
    ),
  )
  if (noRoster.size <= 1) {
    const convidados = (Array.isArray(input.invited) ? input.invited : []).filter(
      (i): i is string => typeof i === 'string' && i.length > 0,
    )
    return convidados.length > 1
  }
  return noRoster.size > 2
}

export interface LeaveDecisionInput {
  collective: boolean
  othersRemain: boolean
}

export function leaveOutcome(input: LeaveDecisionInput): 'keep' | 'end' {
  if (input.collective) return 'keep'
  return input.othersRemain ? 'keep' : 'end'
}
