// Regras puras do soundboard: duração, tamanho e magic bytes (extensão não vale).

export const SOUND_MAX_SECONDS = 10
export const SOUND_MAX_BYTES = 2 * 1024 * 1024
export const SOUND_MAX_SLOTS = 120

export type SoundExt = 'wav' | 'ogg' | 'flac' | 'm4a' | 'mp3'

export interface SoundMeta {
  id: string
  name: string
  ext: string
  bytes: number
  seconds: number
  source: string
  created_at: number
}

const MIME_BY_EXT: Record<SoundExt, string> = {
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
}

export function soundMime(ext: string): string {
  return MIME_BY_EXT[(ext as SoundExt)] ?? 'audio/wav'
}

/** Magic bytes: espelha `sniff_audio` do Rust. */
export function sniffAudioExt(bytes: Uint8Array): SoundExt | null {
  if (!bytes || bytes.length < 12) return null
  const b = bytes
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x41 && b[10] === 0x56 && b[11] === 0x45) return 'wav'
  if (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) return 'ogg'
  if (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) return 'flac'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'm4a'
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3'
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3'
  return null
}

/** Estimativa de duração de WAV pelo byte rate; o resto depende do decoder. */
export function estimateWavSeconds(bytes: Uint8Array): number {
  if (!bytes || bytes.length < 44) return 0
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== 0x46464952) return 0
  const byteRate = view.getUint32(28, true)
  if (!byteRate) return 0
  return Math.max(0, (bytes.length - 44) / byteRate)
}

export function soundNameSlug(raw: string): string {
  const base = String(raw ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  const noQuery = base.split('?')[0] ?? base
  const stem = noQuery.includes('.') ? noQuery.slice(0, noQuery.lastIndexOf('.')) : noQuery
  const cleaned = Array.from(stem.replace(/[%+]/g, ' '))
    .filter(c => c.charCodeAt(0) > 31)
    .join('')
    .trim()
  return (cleaned || 'som').slice(0, 40)
}

export interface SoundCheck {
  ok: boolean
  reason?: string
  ext?: SoundExt
  seconds?: number
}

/** Valida antes de gravar: usa a duração decodificada ou a estimativa do cabeçalho. */
export function checkSoundUpload(input: {
  bytes: Uint8Array
  decodedSeconds?: number | null
  name?: string
}): SoundCheck {
  const bytes = input.bytes
  if (!bytes || bytes.length === 0) return { ok: false, reason: 'arquivo vazio' }
  if (bytes.length > SOUND_MAX_BYTES) {
    return {
      ok: false,
      reason: `som grande demais (${Math.round(bytes.length / 1024)} KB, máximo ${SOUND_MAX_BYTES / 1024} KB)`,
    }
  }
  const ext = sniffAudioExt(bytes)
  if (!ext) return { ok: false, reason: 'formato não reconhecido — use WAV, OGG, FLAC, M4A ou MP3' }
  const seconds = typeof input.decodedSeconds === 'number' && Number.isFinite(input.decodedSeconds) && input.decodedSeconds > 0
    ? input.decodedSeconds
    : ext === 'wav' ? estimateWavSeconds(bytes) : 0
  if (seconds > SOUND_MAX_SECONDS + 0.25) {
    return { ok: false, reason: `som com ${seconds.toFixed(1)}s — o limite é ${SOUND_MAX_SECONDS}s`, ext, seconds }
  }
  return { ok: true, ext, seconds }
}

/** URL de download: só https com host válido. */
export function isDownloadableSoundUrl(raw: string): boolean {
  const v = String(raw ?? '').trim()
  if (!/^https:\/\//i.test(v)) return false
  if (/\s/.test(v)) return false
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:') return false
    if (!u.hostname || u.hostname === 'localhost') return false
    return true
  } catch { return false }
}

/** Host da origem, para a UI mostrar de onde veio o som. */
export function soundSourceHost(raw: string): string {
  try { return new URL(raw).hostname } catch { return '' }
}

export const SOUND_SUGGESTIONS: { label: string; detail: string; query: string }[] = [
  { label: 'Buzina', detail: 'clássico de chamada', query: 'honk sound effect short mp3' },
  { label: 'Tambores', detail: 'ba-dum-tss', query: 'badum tss drum sting mp3' },
  { label: 'Aplausos', detail: 'plateia curta', query: 'short applause sound effect mp3' },
  { label: 'Rimshot', detail: 'piada', query: 'rimshot sound effect mp3' },
  { label: 'Vinheta', detail: 'entrada triunfal', query: 'short airhorn sound effect mp3' },
  { label: 'Erro', detail: 'buzzer', query: 'wrong answer buzzer sound effect mp3' },
]
