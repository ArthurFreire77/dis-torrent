/**
 * Pedido de pasta para download grande. Arquivo de 1 GB não pode cair no disco
 * do sistema sem o usuário escolher — a promessa é resolvida pelo modal
 * montado nos dois shells, com `null` quando a pessoa cancela.
 */
export interface DownloadDirPromptInfo {
  name: string
  size: number
  dir: string
  freeBytes: number
}

const EVENT = 'distorrent:download-dir-choice'

export function requestDownloadDir(info: DownloadDirPromptInfo): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    let done = false
    const finish = (value: string | null) => {
      if (done) return
      done = true
      window.removeEventListener(EVENT, onChoice as EventListener)
      resolve(value)
    }
    const onChoice = (ev: Event) => {
      const det = (ev as CustomEvent<{ path?: string | null }>).detail
      finish(det?.path ?? null)
    }
    window.addEventListener(EVENT, onChoice as EventListener)
    try {
      window.dispatchEvent(new CustomEvent('distorrent:download-dir-ask', { detail: info }))
    } catch {
      finish(null)
    }
  })
}

export function answerDownloadDir(path: string | null): void {
  if (typeof window === 'undefined') return
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { path } }))
  } catch {  }
}

/** A partir disto a pasta é perguntada (o resto vai para a padrão). */
export const LARGE_DOWNLOAD_BYTES = 512 * 1024 * 1024
