/**
 * Estado honesto de uma chamada de canal de voz.
 *
 * Entrar num canal de voz sozinho não é "conectar com alguém": não existe par
 * para negociar. Mesmo assim a fase ficava `connecting` para sempre, e o botão
 * verde e o selo mostravam "Conectando…" eterno. A chamada só está conectando
 * quando há outro participante para parear.
 */

export interface VoiceCallPhaseInput {
  callId?: string | null
  phase?: string | null
  participants?: Array<{ fp?: string | null }> | null
  myFp?: string | null
}

/** Quantos participantes além de mim estão na chamada. */
export function outrosNaChamada(input: VoiceCallPhaseInput): number {
  const me = typeof input.myFp === 'string' ? input.myFp : ''
  return (Array.isArray(input.participants) ? input.participants : [])
    .filter((p) => typeof p?.fp === 'string' && p.fp && p.fp !== me)
    .length
}

/**
 * Um canal de voz sozinho já está "na chamada": não há o que conectar.
 * Devolve `true` só quando é canal de voz, a fase é `connecting` e não há par.
 */
export function canalDeVozSozinho(input: VoiceCallPhaseInput): boolean {
  const callId = typeof input.callId === 'string' ? input.callId : ''
  if (!callId.startsWith('voice-')) return false
  if (input.phase !== 'connecting') return false
  return outrosNaChamada(input) === 0
}

/** Fase exibida: canal sozinho não mente dizendo "Conectando…". */
export function faseExibida(input: VoiceCallPhaseInput): string {
  if (canalDeVozSozinho(input)) return 'connected'
  const fase = typeof input.phase === 'string' ? input.phase : ''
  return fase || 'idle'
}
