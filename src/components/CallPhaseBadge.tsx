import { CALL_PHASE_LABELS, type CallPhase } from '../services/callPhases'

const t = {
  accent: '#5865f2',
  green: '#23a559',
  yellow: '#f0b232',
  red: '#f23f42',
  link: '#00a8fc',
}

function formatDuration(nowMs: number, startAt: number): string {
  const total = Math.max(0, Math.floor((nowMs - startAt) / 1000))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

export default function CallPhaseBadge({ phase, startAt, nowMs, mediaLive }: {
  phase: CallPhase
  startAt: number
  nowMs: number
  /**
   * Existe mídia REAL fluindo/chegando? `false` (ou omitido) mantém o texto de
   * fase.
   *
   * POR QUE ESTE CAMPO EXISTE: a fase é de SINALIZAÇÃO e é promovida pelo
   * primeiro par que conecta (ou pelo agregado do core). Num mesh isso pintava
   * "Conectado" verde com metade dos participantes muda — o status mentia e o
   * usuário concluía que o app estava quebrado "sem motivo". Com `mediaLive`
   * falso o badge diz a verdade.
   */
  mediaLive?: boolean
}) {
  if (phase === 'idle') return null

  let background = t.red
  let color = '#fff'
  let text = CALL_PHASE_LABELS[phase]
  if (phase === 'connected') {
    background = t.green
    text = `Conectado • ${formatDuration(nowMs, startAt)}`
    if (mediaLive === false) {
      // Verde só quando há áudio/vídeo de verdade.
      background = t.yellow
      color = '#000'
      text = `Conectado sem mídia • ${formatDuration(nowMs, startAt)}`
    }
  } else if (phase === 'outgoing') {
    background = t.accent
    text = 'Chamando…'
  } else if (phase === 'incoming') {
    background = t.accent
    text = 'Recebendo chamada'
  } else if (phase === 'connecting') {
    background = t.link
    text = 'Conectando…'
  } else if (phase === 'reconnecting') {
    background = t.yellow
    color = '#000'
    text = 'Reconectando…'
  }

  return (
    <span
      title={text}
      aria-live="polite"
      style={{
        borderRadius: 99,
        padding: '3px 10px',
        fontSize: 11,
        fontWeight: 800,
        color,
        background,
      }}
    >
      {text}
    </span>
  )
}
