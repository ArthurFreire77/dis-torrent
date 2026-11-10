export const CALL_PLAYBACK_STORAGE_KEY = 'distorrent:call-playback:v1'

/** Acima de 100% o áudio é amplificado por um GainNode; 200% é o teto seguro. */
export const MAX_PARTICIPANT_VOLUME = 200

export interface ParticipantPlaybackSettings {
  volume: number
  muted: boolean
}

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const DEFAULT_PARTICIPANT_PLAYBACK: ParticipantPlaybackSettings = {
  volume: 100,
  muted: false,
}

const MAX_SAVED_PARTICIPANTS = 256

function browserStorage(): KeyValueStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function validParticipantId(fp: string): boolean {
  return typeof fp === 'string' && fp.length > 0 && fp.length <= 128
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.round(Math.min(MAX_PARTICIPANT_VOLUME, Math.max(0, value)))
}

function normalizeSettings(value: unknown): ParticipantPlaybackSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PARTICIPANT_PLAYBACK }
  const record = value as Record<string, unknown>
  return {
    volume: clampVolume(Number(record.volume)),
    muted: record.muted === true,
  }
}

function readAll(storage: KeyValueStorage | null): Record<string, ParticipantPlaybackSettings> {
  if (!storage) return {}
  try {
    const value: unknown = JSON.parse(storage.getItem(CALL_PLAYBACK_STORAGE_KEY) ?? '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([fp]) => validParticipantId(fp))
      .slice(-MAX_SAVED_PARTICIPANTS)
    return Object.fromEntries(entries.map(([fp, settings]) => [fp, normalizeSettings(settings)]))
  } catch {
    return {}
  }
}

export function getParticipantPlaybackSettings(
  fp: string,
  storage: KeyValueStorage | null = browserStorage(),
): ParticipantPlaybackSettings {
  if (!validParticipantId(fp)) return { ...DEFAULT_PARTICIPANT_PLAYBACK }
  return readAll(storage)[fp] ?? { ...DEFAULT_PARTICIPANT_PLAYBACK }
}

export function saveParticipantPlaybackSettings(
  fp: string,
  patch: Partial<ParticipantPlaybackSettings>,
  storage: KeyValueStorage | null = browserStorage(),
): ParticipantPlaybackSettings {
  const next = normalizeSettings({ ...getParticipantPlaybackSettings(fp, storage), ...patch })
  if (!validParticipantId(fp) || !storage) return next
  const all = readAll(storage)
  delete all[fp]
  all[fp] = next
  const trimmed = Object.fromEntries(Object.entries(all).slice(-MAX_SAVED_PARTICIPANTS))
  try {
    storage.setItem(CALL_PLAYBACK_STORAGE_KEY, JSON.stringify(trimmed))
  } catch {  }
  return next
}

/**
 * Separa o volume do elemento do ganho do amplificador: até 100% basta
 * `element.volume`, acima disso o elemento vai a 1 e o GainNode multiplica.
 */
export function playbackGain(volume: number): { elementVolume: number; gain: number } {
  const v = clampVolume(volume)
  if (v <= 100) return { elementVolume: v / 100, gain: 1 }
  return { elementVolume: 1, gain: v / 100 }
}

interface BoostGraph {
  context: AudioContext
  source: MediaElementAudioSourceNode
  gain: GainNode
  /** Ligado pela stream (call): o elemento fica mudo e o grafo toca. */
  stream?: boolean
}

const boostGraphs = new WeakMap<HTMLMediaElement, BoostGraph>()
/** Elementos que não aceitam boost: usar só `element.volume`. */
const boostFailed = new WeakSet<HTMLMediaElement>()
let boostContext: AudioContext | null = null

function audioContextCtor(): typeof AudioContext | null {
  try {
    if (typeof AudioContext !== 'undefined') return AudioContext
    const w = typeof window !== 'undefined'
      ? (window as unknown as { webkitAudioContext?: typeof AudioContext })
      : null
    return w?.webkitAudioContext ?? null
  } catch {
    return null
  }
}

function graphFor(element: HTMLMediaElement): BoostGraph | null {
  const existente = boostGraphs.get(element)
  if (existente) return existente
  if (boostFailed.has(element)) return null
  const Ctor = audioContextCtor()
  if (!Ctor) return null
  try {
    boostContext = boostContext && boostContext.state !== 'closed' ? boostContext : new Ctor()
    const ctx = boostContext
    if (!ctx || ctx.state === 'closed') return null
    // `srcObject` (áudio da call): MediaElementSource fica MUDO no WebView2
    // (medido: pico 0). A stream, ao contrário, passa — então usamos ela.
    const stream = element.srcObject
    let source: AudioNode
    if (stream instanceof MediaStream) {
      source = ctx.createMediaStreamSource(stream)
    } else {
      source = ctx.createMediaElementSource(element)
    }
    const gain = ctx.createGain()
    source.connect(gain)
    gain.connect(ctx.destination)
    const graph = {
      context: ctx,
      source: source as MediaElementAudioSourceNode,
      gain,
      stream: stream instanceof MediaStream,
    }
    boostGraphs.set(element, graph)
    return graph
  } catch {
    boostFailed.add(element)
    return null
  }
}

/** O elemento aceita amplificação acima de 100%? A UI usa para não mentir. */
export function canBoost(element: unknown): boolean {
  if (!isMediaElement(element)) return false
  return !boostFailed.has(element)
}

function isMediaElement(value: unknown): value is HTMLMediaElement {
  try {
    return typeof HTMLMediaElement !== 'undefined' && value instanceof HTMLMediaElement
  } catch {
    return false
  }
}

function applyBoost(element: HTMLMediaElement, gain: number): void {
  if (gain <= 1) {
    const graph = boostGraphs.get(element)
    if (graph) try { graph.gain.gain.value = 1 } catch {  }
    return
  }
  const graph = graphFor(element)
  if (!graph) return
  try {
    if (graph.context.state === 'suspended') void graph.context.resume().catch(() => {})
    graph.gain.gain.value = gain
  } catch {  }
}

/**
 * Amplificação real disponível? Medido no WebView2: MediaElementSource com
 * `srcObject` fica mudo, mas MediaStreamSource funciona — então 200% é real
 * quando existe AudioContext.
 */
export function volumeBoostSupported(): boolean {
  return !!audioContextCtor()
}

export function applyParticipantPlayback(
  element: Pick<HTMLMediaElement, 'volume' | 'muted'>,
  fp: string,
  callDeafened = false,
  settings = getParticipantPlaybackSettings(fp),
): void {
  const { elementVolume, gain } = playbackGain(settings.volume)
  const mudo = callDeafened || settings.muted
  if (isMediaElement(element)) {
    applyBoost(element, gain)
    const graph = boostGraphs.get(element)
    // Com o grafo da stream no comando, o elemento fica mudo (senão o som
    // sairia DUAS vezes) e o volume/mute vai todo pelo GainNode.
    const pelaStream = !!graph?.stream
    if (pelaStream) {
      try { graph!.gain.gain.value = mudo ? 0 : gain } catch {  }
      element.muted = true
      element.volume = 1
    } else {
      element.muted = mudo
      element.volume = elementVolume
    }
    return
  }
  element.muted = mudo
  element.volume = elementVolume
}

export function applyMountedParticipantPlayback(
  fp: string,
  callDeafened = false,
  settings = getParticipantPlaybackSettings(fp),
): void {
  if (!validParticipantId(fp) || typeof document === 'undefined') return
  try {
    document.querySelectorAll<HTMLAudioElement>('audio[data-call-audio-fp]').forEach((element) => {
      if (element.dataset.callAudioFp === fp) {
        applyParticipantPlayback(element, fp, callDeafened, settings)
      }
    })
  } catch {  }
}
