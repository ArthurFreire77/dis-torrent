// CallPhases — máquina de estados PURA da chamada (sem DOM/WebRTC).
// Espelha os estados do produto: chamando, recebendo, conectando, conectado,
// reconectando, encerrado, recusado, falhou, perdida.
// O CallManager aplica os eventos reais (WebRTC/engine) e consulta estas
// transições — assim a regra de negócio é testável sem navegador.

/** Fases visíveis de uma chamada (labels pt-BR em CALL_PHASE_LABELS). */
export type CallPhase =
  | 'idle' // sem chamada
  | 'outgoing' // chamando (eu disparei, aguardando aceite)
  | 'incoming' // recebendo (telefone tocando)
  | 'connecting' // sinalização ok, mídia negociando
  | 'connected' // mídia ativa (ICE connected/completed)
  | 'reconnecting' // caiu a rota, tentando voltar (ICE restart / re-invite)
  | 'ended' // encerrada por qualquer lado
  | 'rejected' // recusada
  | 'failed' // reconexão/ICE falhou de vez
  | 'missed' // perdida (desligaram antes de eu atender)

/** Eventos que movem a máquina (emitidos pelo CallManager). */
export type CallEvent =
  | 'dial' // disquei (start)
  | 'ring' // chegou call_incoming
  | 'accept' // aceite/atendimento local ou remoto
  | 'signal' // offer/answer/ICE fluindo
  | 'media-connected' // ICE connected/completed
  /**
   * Mídiaestablished SEM WebRTC (relay-only): o audio-chunk saiu e o
   * AudioContext está tocando. Sem este evento a chamada relay ficava
   * presa em 'connecting' para sempre — não existe RTCPeerConnection para
   * emitir ICE connected, então 'media-connected' nunca chegava.
   */
  | 'relay-audio-live'
  | 'ice-failed' // ICE failed / rota caiu
  | 'media-reconnected' // mídia voltou após restart
  | 'remote-reject' // o outro lado recusou
  | 'remote-ended' // o outro lado desligou / call_ended
  | 'reconnect-timeout' // gastou o orçamento de reconexão sem voltar
  | 'hangup' // desliguei

/**
 * Transição pura. Estados terminais (ended/rejected/failed/missed) não
 * reabrem — a próxima chamada começa de 'idle' via dial/ring.
 */
export function nextCallPhase(phase: CallPhase, ev: CallEvent): CallPhase {
  switch (phase) {
    case 'idle':
      if (ev === 'dial') return 'outgoing'
      if (ev === 'ring') return 'incoming'
      return phase
    case 'incoming':
      if (ev === 'accept' || ev === 'signal') return 'connecting'
      if (ev === 'hangup') return 'rejected' // recusei
      if (ev === 'remote-ended') return 'missed' // desligaram antes de eu atender
      if (ev === 'remote-reject') return 'ended'
      return phase
    case 'outgoing':
      if (ev === 'accept' || ev === 'signal') return 'connecting'
      // Chamada relay-only: o outro lado não tem PC nenhum para mandar ICE, e
      // quem chama nunca recebe `accept` (o motor emite CallAcceptedEv só no
      // host da chamada). Sem esta transição, `relay-audio-live` — que chega
      // assim que o áudio sai — era ignorado e a fase ficava presa em
      // "Chamando…" para sempre.
      if (ev === 'relay-audio-live') return 'connected'
      if (ev === 'remote-reject') return 'rejected'
      if (ev === 'remote-ended') return 'ended'
      if (ev === 'hangup') return 'ended' // cancelei antes de atenderem
      return phase
    case 'connecting':
      if (ev === 'media-connected' || ev === 'relay-audio-live') return 'connected'
      if (ev === 'remote-ended' || ev === 'hangup') return 'ended'
      if (ev === 'remote-reject') return 'rejected'
      // Atrás de CGNAT o ICE não chega a 'failed' — ele fica em 'checking'
      // para sempre, porque o candidate pair nunca é aceito pelos dois lados.
      // O watchdog de conexão do CallManager existe para quebrar esse silêncio
      // (CONNECT_TIMEOUT_MS sem mídia viva → 'ice-failed'), mas sem esta
      // transição ele era um no-op: a fase ficava presa em 'connecting' com o
      // overlay "Conectando…" para sempre, e como o watchdog de RECONEXÃO
      // só arma ao entrar em 'reconnecting', a chamada nunca encerrava com
      // aviso honesto. Aqui a falha de rota sai de 'connecting' pelo mesmo
      // caminho de 'connected', gaining o ICE restart + fallback de relay.
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
      return phase // peer-online/sinal mantém tentando
    default:
      return phase // terminal
  }
}

/** Labels honestos em pt-BR para a UI (chips do overlay). */
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

/** Fases que mantêm o overlay de chamada aberto. */
export function isCallPhaseActive(phase: CallPhase): boolean {
  return phase === 'outgoing' || phase === 'incoming' || phase === 'connecting'
    || phase === 'connected' || phase === 'reconnecting'
}

/** Fases "de vida" da mídia — usadas para decidir se há alguém na linha. */
export function isMediaPhase(phase: CallPhase): boolean {
  return phase === 'connecting' || phase === 'connected' || phase === 'reconnecting'
}
