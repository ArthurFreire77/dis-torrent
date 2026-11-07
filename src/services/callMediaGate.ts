import { getIceServers } from './callIce'

/** `getUserMedia({audio,video})` é atômico: sem vídeo, tenta só o áudio. */
export function describeMediaError(e: unknown): string | null {
  const name = (e as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError') return 'microfone/câmera bloqueados — libere a permissão do sistema e tente de novo'
  if (name === 'NotFoundError') return 'nenhum microfone/câmera encontrado neste aparelho'
  if (name === 'NotReadableError') return 'microfone/câmera em uso por outro app — feche e tente de novo'
  if (name === 'OverconstrainedError') return 'câmera/microfone não atende aos requisitos — tente só voz'
  if (name === 'SecurityError') return 'permissão de mídia bloqueada pelo contexto (HTTPS/app nativo exigido)'
  return null
}

export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
}

let capturaFila: Promise<unknown> = Promise.resolve()

/** Serializa as capturas: dois `getUserMedia` simultâneos disputam o mesmo device. */
export function comFilaDeCaptura<T>(fn: () => Promise<T>): Promise<T> {
  const vez = capturaFila.catch(() => undefined).then(fn)
  capturaFila = vez.catch(() => undefined)
  return vez
}

export { getIceServers }
