// Sala COLETIVA: a saída de UMA pessoa não encerra a chamada dos outros.
//
// BUG QUE ISTO CORRIGE: o critério era `pcs.size > 1`. Numa chamada de grupo
// com 3 pessoas, se só um par tinha RTCPeerConnection aberto, `pcs.size` era 1
// e a saída de QUALQUER um caía no ramo "encerrar tudo" — a chamada acabava
// para todo mundo. O que define sala coletiva é o roster: além de mim, existe
// mais de uma pessoa? E canal de voz (`voice-*`) sempre é coletivo por
// natureza.

export interface CollectiveRoomInput {
  /** callId (`voice-<community>-<channel>` é canal). */
  callId: string
  /** fps das pessoas na sala, incluindo o meu. */
  participants: string[]
  /** Pessoas que ainda não entraram (contam só se o roster estiver vazio). */
  invited?: string[]
}

/** `true` quando a sala tem mais de uma pessoa (ou é canal de voz). */
export function isCollectiveRoom(input: CollectiveRoomInput | null | undefined): boolean {
  if (!input) return false
  if (typeof input.callId === 'string' && input.callId.startsWith('voice-')) return true
  const noRoster = new Set(
    (Array.isArray(input.participants) ? input.participants : []).filter(
      (fp): fp is string => typeof fp === 'string' && fp.length > 0,
    ),
  )
  // Roster ainda não semeado: os convidados são a única pista de "sala de grupo".
  if (noRoster.size <= 1) {
    const convidados = (Array.isArray(input.invited) ? input.invited : []).filter(
      (i): i is string => typeof i === 'string' && i.length > 0,
    )
    return convidados.length > 0
  }
  return noRoster.size > 1
}
