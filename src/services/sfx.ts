// Efeitos sonoros sintetizados (WebAudio) — sem arquivos, funciona offline.
// Sons curtos estilo Discord: mensagem (blipe), chamando (ring), atendeu e
// encerrou. Tudo best-effort: se o AudioContext não existir, é no-op.

let ctx: AudioContext | null = null
let ringTimer: number | null = null
let muted = false
// Toque nativo: no app instalado quem marca o RITMO é o processo nativo, não o
// `setInterval` da página. Motivo: com a janela escondida (bandeja) o Chromium
// estrangula timers de página oculta → o toque espaçava e podia parar de tocar.
let ringToken = 0
let ringUnlisten: (() => void) | null = null

import { isTauriAndroid, isTauriRuntime } from '../shared/runtime.ts'

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

function isAndroidRuntimeSfx(): boolean {
  return isTauriAndroid()
}

/** Um ciclo do toque (dois tons). */
function ringBeep() {
  if (!ensure()) return
  tone(880, 0, 0.35, 'sine', 0.14)
  tone(660, 0.18, 0.35, 'sine', 0.12)
}

/** Fallback (navegador puro ou shell sem os comandos nativos). */
function startIntervalRing() {
  if (ringTimer !== null) return
  ringBeep()
  ringTimer = window.setInterval(ringBeep, 1800)
}

async function startNativeRing(token: number) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    if (token !== ringToken) return
    if (isAndroidRuntimeSfx()) {
      // Android: Ringtone do SISTEMA (respeita silencioso/DND, continua com a
      // tela bloqueada porque quem toca é o MediaPlayer nativo, não a página).
      await invoke('plugin:callfg|ringStart')
      return
    }
    const { listen } = await import('@tauri-apps/api/event')
    const un = await listen('distorrent://ring', () => { ringBeep() })
    if (token !== ringToken) { try { un() } catch { /* ignore */ }; return }
    ringUnlisten = un
    await invoke('call_ring_start', { callId: 'incoming' })
  } catch {
    // Build antiga/plugin ausente: cai no timer da página (melhor que silêncio).
    if (token === ringToken) startIntervalRing()
  }
}

/** Limpa só o lado da página (timer, listener, token). */
function stopLocalRing() {
  ringToken++
  if (ringTimer !== null) { try { clearInterval(ringTimer) } catch { /* ignore */ } ; ringTimer = null }
  if (ringUnlisten) { try { ringUnlisten() } catch { /* ignore */ } ; ringUnlisten = null }
}

function stopNativeRing() {
  if (!isTauriRuntime()) return
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => {
      if (isAndroidRuntimeSfx()) void invoke('plugin:callfg|ringStop').catch(() => {})
      else void invoke('call_ring_stop').catch(() => {})
    })
    .catch(() => { /* sem Tauri: nada a parar no nativo */ })
}

/** Toque de chamada recebida (repete até `sfxRingStop`). */
export function sfxRingStart() {
  // Só limpa o lado local: mandar `stop` nativo aqui podia chegar DEPOIS do
  // `start` e calar o toque que estava começando.
  stopLocalRing()
  if (!ensure()) return
  const token = ringToken
  if (isTauriRuntime()) {
    void startNativeRing(token)
    return
  }
  startIntervalRing()
}

/** Para o toque de chamada (atendeu, recusou, encerrou, overlay fechou). */
export function sfxRingStop() {
  stopLocalRing()
  stopNativeRing()
}
