export type CallPhase =
  | 'idle'
  | 'outgoing'
  | 'incoming'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended'
  | 'rejected'
  | 'failed'
  | 'missed'

export type CallEvent =
  | 'dial'
  | 'ring'
  | 'accept'
  | 'signal'
  | 'media-connected'
  | 'relay-audio-live'
  | 'ice-failed'
  | 'media-reconnected'
  | 'remote-reject'
  | 'remote-ended'
  | 'reconnect-timeout'
  | 'hangup'

export function nextCallPhase(phase: CallPhase, ev: CallEvent): CallPhase {
  switch (phase) {
    case 'idle':
      if (ev === 'dial') return 'outgoing'
      if (ev === 'ring') return 'incoming'
      return phase
    case 'incoming':
      if (ev === 'accept' || ev === 'signal') return 'connecting'
      if (ev === 'hangup') return 'rejected'
      if (ev === 'remote-ended') return 'missed'
      if (ev === 'remote-reject') return 'ended'
      if (ev === 'reconnect-timeout') return 'missed'
      return phase
    case 'outgoing':
      if (ev === 'accept' || ev === 'signal') return 'connecting'
      if (ev === 'media-connected') return 'connected'
      if (ev === 'relay-audio-live') return 'connected'
      if (ev === 'ice-failed') return 'reconnecting'
      if (ev === 'reconnect-timeout') return 'failed'
      if (ev === 'remote-reject') return 'rejected'
      if (ev === 'remote-ended') return 'ended'
      if (ev === 'hangup') return 'ended'
      return phase
    case 'connecting':
      if (ev === 'media-connected' || ev === 'relay-audio-live') return 'connected'
      if (ev === 'remote-ended' || ev === 'hangup') return 'ended'
      if (ev === 'remote-reject') return 'rejected'
      if (ev === 'ice-failed') return 'reconnecting'
      return phase
    case 'connected':
      if (ev === 'ice-failed') return 'reconnecting'
      if (ev === 'remote-ended' || ev === 'hangup') return 'ended'
      return phase
    case 'reconnecting':
      if (ev === 'media-connected' || ev === 'media-reconnected' || ev === 'relay-audio-live') return 'connected'
      if (ev === 'reconnect-timeout') return 'failed'
      if (ev === 'remote-ended' || ev === 'hangup') return 'ended'
      return phase
    default:
      return phase
  }
}

export const CALL_PHASE_LABELS: Record<CallPhase, string> = {
  idle: '',
  outgoing: 'Chamando…',
  incoming: 'Recebendo chamada',
  connecting: 'Conectando…',
  connected: 'Conectado',
  reconnecting: 'Reconectando…',
  ended: 'Chamada encerrada',
  rejected: 'Chamada recusada',
  failed: 'Chamada falhou',
  missed: 'Chamada perdida',
}

export function isCallPhaseActive(phase: CallPhase): boolean {
  return phase === 'outgoing' || phase === 'incoming' || phase === 'connecting'
    || phase === 'connected' || phase === 'reconnecting'
}

export function isMediaPhase(phase: CallPhase): boolean {
  return phase === 'connecting' || phase === 'connected' || phase === 'reconnecting'
}
