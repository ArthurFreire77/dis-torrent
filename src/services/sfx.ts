let ctx: AudioContext | null = null
let ringTimer: number | null = null
let muted = false
let ringToken = 0
let ringUnlisten: (() => void) | null = null

import { isTauriAndroid, isTauriRuntime } from '../shared/runtime.ts'

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
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {  })
    return ctx
  } catch { return null }
}

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
  } catch {  }
}

export function sfxMessage() {
  if (!ensure()) return
  tone(880, 0, 0.09, 'sine', 0.12)
  tone(1320, 0.06, 0.10, 'sine', 0.10)
}

export function sfxCallConnect() {
  if (!ensure()) return
  tone(660, 0, 0.12, 'sine', 0.13)
  tone(880, 0.11, 0.13, 'sine', 0.12)
  tone(1175, 0.23, 0.16, 'sine', 0.11)
}

export function sfxCallEnd() {
  if (!ensure()) return
  tone(660, 0, 0.12, 'sine', 0.12)
  tone(440, 0.11, 0.22, 'sine', 0.12)
}

export function sfxJoin() { if (!ensure()) return; tone(520, 0, 0.07, 'triangle', 0.08) }
export function sfxLeave() { if (!ensure()) return; tone(380, 0, 0.09, 'triangle', 0.08) }

function isAndroidRuntimeSfx(): boolean {
  return isTauriAndroid()
}

function ringBeep() {
  if (!ensure()) return
  tone(880, 0, 0.35, 'sine', 0.14)
  tone(660, 0.18, 0.35, 'sine', 0.12)
}

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
      await invoke('plugin:callfg|ringStart')
      return
    }
    const { listen } = await import('@tauri-apps/api/event')
    const un = await listen('distorrent://ring', () => { ringBeep() })
    if (token !== ringToken) { try { un() } catch {  }; return }
    ringUnlisten = un
    await invoke('call_ring_start', { callId: 'incoming' })
  } catch {
    if (token === ringToken) startIntervalRing()
  }
}

function stopLocalRing() {
  ringToken++
  if (ringTimer !== null) { try { clearInterval(ringTimer) } catch {  } ; ringTimer = null }
  if (ringUnlisten) { try { ringUnlisten() } catch {  } ; ringUnlisten = null }
}

function stopNativeRing() {
  if (!isTauriRuntime()) return
  void import('@tauri-apps/api/core')
    .then(({ invoke }) => {
      if (isAndroidRuntimeSfx()) void invoke('plugin:callfg|ringStop').catch(() => {})
      else void invoke('call_ring_stop').catch(() => {})
    })
    .catch(() => {  })
}

export function sfxRingStart() {
  stopLocalRing()
  if (!ensure()) return
  const token = ringToken
  if (isTauriRuntime()) {
    void startNativeRing(token)
    return
  }
  startIntervalRing()
}

export function sfxRingStop() {
  stopLocalRing()
  stopNativeRing()
}
