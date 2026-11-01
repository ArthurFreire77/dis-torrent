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

/**
 * `true` quando a sala tem MAIS DE DUAS pessoas (eu + 2), ou é canal de voz.
 *
 * BUG CORRIGIDO (a chamada "fantasma" e o "já existe uma chamada em
 * andamento"): o critério era `size > 1`, que conta **eu + uma pessoa** — ou
 * seja, toda chamada 1:1 era classificada como coletiva. Em `leaveOutcome`,
 * coletiva devolve `keep` sempre, então quando o outro desligava numa chamada
 * de dois o lado que ficava **não encerrava nada**: o overlay sumia pelo evento
 * do shell, mas o `CallManager` mantinha `state` vivo. A próxima chamada batia
 * em "já existe uma chamada em andamento" e o botão Entrar ficava travado.
 * Coletiva é 3+ pessoas; dois é 1:1.
 */
export function isCollectiveRoom(input: CollectiveRoomInput | null | undefined): boolean {
  if (!input) return false
  if (typeof input.callId === 'string' && input.callId.startsWith('voice-')) return true
  const noRoster = new Set(
    (Array.isArray(input.participants) ? input.participants : []).filter(
      (fp): fp is string => typeof fp === 'string' && fp.length > 0,
    ),
  )
  // Roster ainda não semeado: os convidados são a única pista de "sala de grupo".
  // DOIS convidados (ou mais) = grupo; UM convidado é chamada 1:1.
  if (noRoster.size <= 1) {
    const convidados = (Array.isArray(input.invited) ? input.invited : []).filter(
      (i): i is string => typeof i === 'string' && i.length > 0,
    )
    return convidados.length > 1
  }
  return noRoster.size > 2
}

/**
 * Decisão de "esta chamada continua?" quando UM peer sai.
 *
 * O erro que isto corrige: recalcular a coletividade com o roster JÁ reduzido.
 * Numa sala de 5, sair o primeiro deixava 4 (coletiva, ok); sair o segundo
 * deixava só eu — a regra então dizia "não é coletiva" e encerrava a chamada
 * de todo mundo. O caráter coletivo é uma propriedade da SALA, não do número
 * de pessoas no instante da checagem, então ele é travado no início.
 */
export interface LeaveDecisionInput {
  /** A sala foi coletiva em algum momento? (trava do `CallManager`) */
  collective: boolean
  /** Ainda restam outros participantes (fora eu) depois de remover quem saiu? */
  othersRemain: boolean
}

/** `keep` = continua para os que ficaram; `end` = encerrar a chamada inteira. */
export function leaveOutcome(input: LeaveDecisionInput): 'keep' | 'end' {
  // Sala coletiva continua mesmo que eu fique sozinho: o dono pediu que ela só
  // acabe quando não houver mais ninguém (e quem decide sair sou eu).
  if (input.collective) return 'keep'
  // Chamada 1:1: o outro lado saiu, não há mais ninguém — encerra.
  return input.othersRemain ? 'keep' : 'end'
}
