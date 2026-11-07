import { services } from '../services'
import { canOpenExternally, isExternalUrl } from './externalLinks'

let installed = false

/** Aviso para a UI quando o SO recusa abrir o endereço. */
export const OPEN_EXTERNAL_FAILED_EVENT = 'distorrent:open_external_failed'

export interface OpenExternalFailure {
  url: string
  message: string
}

function avisarFalha(url: string, message: string): void {
  try {
    window.dispatchEvent(
      new CustomEvent<OpenExternalFailure>(OPEN_EXTERNAL_FAILED_EVENT, { detail: { url, message } }),
    )
  } catch {  }
}

async function openOutside(url: string): Promise<void> {
  try {
    await services.openExternal(url)
    return
  } catch (e) {
    try {
      const w = window.open(url, '_blank', 'noopener,noreferrer')
      if (w) return
    } catch {  }
    const message = String((e as Error)?.message ?? e)
    console.warn('[distorrent] não foi possível abrir o endereço externo:', message)
    avisarFalha(url, message)
  }
}

export function installExternalLinkHandler(): () => void {
  if (typeof document === 'undefined') return () => {}
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const onClick = (ev: MouseEvent) => {
    if (ev.defaultPrevented) return
    const alvo = ev.target as Element | null
    const link = alvo?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link) return
    const href = link.getAttribute('href') ?? ''
    if (!href) return
    const externo = isExternalUrl(href, origin) || canOpenExternally(href)
    if (!externo) return
    ev.preventDefault()
    ev.stopPropagation()
    void openOutside(link.href && canOpenExternally(link.href) ? link.href : href)
  }
  document.addEventListener('click', onClick, true)
  document.addEventListener('auxclick', onClick as EventListener, true)
  installed = true
  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('auxclick', onClick as EventListener, true)
    installed = false
  }
}

export function isExternalLinkHandlerInstalled(): boolean {
  return installed
}
