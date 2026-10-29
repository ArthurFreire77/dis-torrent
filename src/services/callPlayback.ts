export const CALL_PLAYBACK_STORAGE_KEY = 'distorrent:call-playback:v1'

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

function normalizeSettings(value: unknown): ParticipantPlaybackSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_PARTICIPANT_PLAYBACK }
  const record = value as Record<string, unknown>
  const volume = Number(record.volume)
  return {
    volume: Number.isFinite(volume) ? Math.round(Math.min(100, Math.max(0, volume))) : 100,
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
  } catch { /* preferência local não pode interromper uma chamada */ }
  return next
}

export function applyParticipantPlayback(
  element: Pick<HTMLMediaElement, 'volume' | 'muted'>,
  fp: string,
  callDeafened = false,
  settings = getParticipantPlaybackSettings(fp),
): void {
  element.volume = settings.volume / 100
  element.muted = callDeafened || settings.muted
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
  } catch { /* controles de volume locais nunca derrubam a chamada */ }
}
