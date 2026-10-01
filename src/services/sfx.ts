// Efeitos sonoros sintetizados (WebAudio) — sem arquivos, funciona offline.
// Sons curtos estilo Discord: mensagem (blipe), chamando (ring), atendeu e
// encerrou. Tudo best-effort: se o AudioContext não existir, é no-op.

let ctx: AudioContext | null = null
let ringTimer: number | null = null
let muted = false

/** Liga/desliga todos os efeitos (ex.: modo silencioso do usuário). */
export function setSfxMuted(m: boolean) { muted = m }
export function isSfxMuted(): boolean { return muted }

function ensure(): AudioContext | null {
  try {
    if (muted) return null
    if (!ctx) {
      const AC: typeof AudioContext | undefined =
        (typeof AudioContext !== 'undefined' && AudioContext) ||
        (typeof window !== 'undefined' ? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined)
      if (!AC) return null
      ctx = new AC()
    }
    if (ctx.state === 'suspended') void ctx.resume().catch(() => { /* gesto do usuário resolve */ })
    return ctx
  } catch { return null }
}

/** Um tom com envelope (evita clique) agendado a partir de `start` segundos. */
function tone(freq: number, start: number, dur: number, type: OscillatorType = 'sine', vol = 0.15) {
  const c = ctx
  if (!c) return
  try {
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, c.currentTime + start)
    g.gain.setValueAtTime(0.0001, c.currentTime + start)
    g.gain.linearRampToValueAtTime(vol, c.currentTime + start + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur)
    o.connect(g)
    g.connect(c.destination)
    o.start(c.currentTime + start)
    o.stop(c.currentTime + start + dur + 0.03)
  } catch { /* nunca derruba a UI */ }
}

/** Mensagem nova — blipe curto e agradável. */
export function sfxMessage() {
  if (!ensure()) return
  tone(880, 0, 0.09, 'sine', 0.12)
  tone(1320, 0.06, 0.10, 'sine', 0.10)
}

/** Chamada conectou — acorde ascendente. */
export function sfxCallConnect() {
  if (!ensure()) return
  tone(660, 0, 0.12, 'sine', 0.13)
  tone(880, 0.11, 0.13, 'sine', 0.12)
  tone(1175, 0.23, 0.16, 'sine', 0.11)
}

/** Chamada encerrou — descendente. */
export function sfxCallEnd() {
  if (!ensure()) return
  tone(660, 0, 0.12, 'sine', 0.12)
  tone(440, 0.11, 0.22, 'sine', 0.12)
}

/** Alguém entrou/saiu da sala. */
export function sfxJoin() { if (!ensure()) return; tone(520, 0, 0.07, 'triangle', 0.08) }
export function sfxLeave() { if (!ensure()) return; tone(380, 0, 0.09, 'triangle', 0.08) }

/** Toque de chamada recebida (repete até `sfxRingStop`). */
export function sfxRingStart() {
  if (!ensure()) return
  sfxRingStop()
  const ring = () => {
    if (!ensure()) return
    tone(880, 0, 0.35, 'sine', 0.14)
    tone(660, 0.18, 0.35, 'sine', 0.12)
  }
  ring()
  ringTimer = window.setInterval(ring, 1800)
}

/** Para o toque de chamada. */
export function sfxRingStop() {
  if (ringTimer !== null) { try { clearInterval(ringTimer) } catch { /* ignore */ } ; ringTimer = null }
}
