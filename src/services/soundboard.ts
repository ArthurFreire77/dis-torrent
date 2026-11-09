// Soundboard: toca local e mistura na track do mic via Web Audio (sem renegociar).
import { checkSoundUpload, type SoundMeta } from './soundboardRules'
import { base64ToBytes, bytesToBase64 } from '../shared/base64'

interface SoundSink {
  /** Destino para onde o efeito é enviado (a track do mic). */
  destination: MediaStreamAudioDestinationNode | null
  /** Contexto do sink; nulo quando não há chamada. */
  ctx: AudioContext | null
}

const noopSink: SoundSink = { destination: null, ctx: null }

let sink: SoundSink = noopSink
let buffers = new Map<string, AudioBuffer>()
let localCtx: AudioContext | null = null
let playing: AudioBufferSourceNode | null = null
let playingId: string | null = null

function ac(): AudioContext | null {
  try {
    if (localCtx && localCtx.state !== 'closed') {
      if (localCtx.state === 'suspended') void localCtx.resume().catch(() => {})
      return localCtx
    }
    const AC: typeof AudioContext | undefined =
      (typeof AudioContext !== 'undefined' && AudioContext) ||
      (typeof window !== 'undefined' ? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined)
    if (!AC) return null
    localCtx = new AC()
    if (localCtx.state === 'suspended') void localCtx.resume().catch(() => {})
    return localCtx
  } catch { return null }
}

async function decode(meta: SoundMeta, bytes: Uint8Array): Promise<AudioBuffer | null> {
  const ctx = ac()
  if (!ctx) return null
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  try { return await ctx.decodeAudioData(ab) } catch { return null }
}

export const soundboard = {
  /** Liga o destino de mixagem criado pelo callManager. */
  attach(s: SoundSink): void {
    sink = s
    if (!s.ctx) {
      playing?.stop()
      playing = null
      playingId = null
    }
  },

  detach(): void {
    sink = noopSink
  },

  isLive(): boolean {
    return !!sink.destination
  },

  clearCache(): void {
    buffers = new Map()
  },

  /** Toca um som; com chamada viva o efeito também vai para os peers. */
  async play(meta: SoundMeta, toPeers = true): Promise<boolean> {
    const ctx = ac()
    if (!ctx) return false
    let buf = buffers.get(meta.id) ?? null
    if (!buf) {
      let bytes: Uint8Array
      try { bytes = base64ToBytes(await soundRead(meta.id)) } catch { return false }
      if (!bytes.length) return false
      buf = await decode(meta, bytes)
      if (!buf) return false
      buffers.set(meta.id, buf)
    }
    try {
      playing?.stop()
    } catch {  }
    const src = ctx.createBufferSource()
    src.buffer = buf
    const gain = ctx.createGain()
    gain.gain.value = 0.9
    src.connect(gain)
    gain.connect(ctx.destination)
    if (toPeers && sink.destination && sink.ctx && sink.ctx !== ctx) {
      // Contexto diferente: replica o buffer no destino do mic.
      try {
        const clone = sink.ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate)
        for (let c = 0; c < buf.numberOfChannels; c++) clone.copyToChannel(buf.getChannelData(c), c)
        const remote = sink.ctx.createBufferSource()
        remote.buffer = clone
        const rg = sink.ctx.createGain()
        rg.gain.value = 0.85
        remote.connect(rg)
        rg.connect(sink.destination)
        remote.start()
      } catch {  }
    } else if (toPeers && sink.destination) {
      try {
        const remote = ctx.createBufferSource()
        remote.buffer = buf
        const rg = ctx.createGain()
        rg.gain.value = 0.85
        remote.connect(rg)
        rg.connect(sink.destination)
        remote.start()
      } catch {  }
    }
    try { src.start() } catch { return false }
    playing = src
    playingId = meta.id
    src.onended = () => { if (playing === src) { playing = null; playingId = null } }
    return true
  },

  stop(): void {
    try { playing?.stop() } catch {  }
    playing = null
    playingId = null
  },

  currentId(): string | null {
    return playingId
  },

  /** Converte o arquivo escolhido pelo usuário em metadados + bytes. */
  async prepare(file: Blob & { name?: string }): Promise<{ meta: Omit<SoundMeta, 'id' | 'created_at'>; bytes: Uint8Array }> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const decoded = await decodeDuration(bytes)
    const check = checkSoundUpload({ bytes, decodedSeconds: decoded, name: file.name })
    if (!check.ok) throw new Error(check.reason ?? 'som inválido')
    const name = (file.name ?? 'som').replace(/\.[^.]+$/, '').slice(0, 40) || 'som'
    return {
      meta: {
        name,
        ext: check.ext ?? 'wav',
        bytes: bytes.length,
        seconds: check.seconds ?? 0,
        source: 'upload local',
      },
      bytes,
    }
  },
}

let durationCtx: AudioContext | null = null

/** Duração real do arquivo (o header só serve para WAV). */
export async function decodeDuration(bytes: Uint8Array): Promise<number | null> {
  try {
    const AC: typeof AudioContext | undefined =
      (typeof AudioContext !== 'undefined' && AudioContext) ||
      (typeof window !== 'undefined' ? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext : undefined)
    if (!AC) return null
    durationCtx = durationCtx ?? new AC()
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const buf = await durationCtx.decodeAudioData(ab)
    return buf.duration
  } catch { return null }
}

// Ponte com o Tauri; sem `invoke` (navegador) o soundboard fica vazio.
async function invokeSound<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const w = globalThis as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } }
  const inv = w.__TAURI_INTERNALS__?.invoke
  if (!inv) throw new Error('soundboard indisponível neste ambiente')
  return await inv(cmd, args) as T
}

export async function soundList(): Promise<SoundMeta[]> {
  try { return await invokeSound<SoundMeta[]>('sound_list') } catch { return [] }
}

export async function soundRead(id: string): Promise<string> {
  const data = await invokeSound<{ bytes_b64: string }>('sound_read', { id })
  return data.bytes_b64
}

export async function soundSave(
  meta: Omit<SoundMeta, 'id' | 'created_at'>,
  bytes: Uint8Array,
): Promise<SoundMeta> {
  const encoded = bytesToBase64(bytes)
  return await invokeSound<SoundMeta>('sound_save', {
    name: meta.name,
    bytesB64: encoded,
    seconds: meta.seconds,
    source: meta.source,
  })
}

export async function soundDelete(id: string): Promise<void> {
  await invokeSound<void>('sound_delete', { id })
}

export async function soundDownload(url: string): Promise<{ name: string; ext: string; bytes_b64: string; bytes: number }> {
  return await invokeSound('sound_download', { url })
}
