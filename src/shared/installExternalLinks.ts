// Interceptador GLOBAL de links: nenhum `<a target="_blank">` pode criar janela
// interna do WebView.
//
// POR QUE EXISTE (bug de campo, com print): clicar num endereço dentro do app
// abria uma aba preta com `ECONNREFUSED: Unable to connect`. O WebView não tem
// navegador embutido: `target="_blank"` vira uma janela dele mesmo apontando
// para o endereço. Com `http://tauri.localhost` (o esquema interno do Tauri) ou
// com `distorrent://`, nada atende naquele endereço e a janela nasce morta.
//
// A correção tem duas camadas:
//  1. aqui: um único listener em `document` (fase de CAPTURA) desvia cliques em
//     links externos para o SO (`open_external`) — vale para markdown, unfurl,
//     convite e qualquer link futuro, sem tocar em cada componente;
//  2. no Rust: `open_external` só aceita esquemas da allowlist.
//
// Links internos (mesma origem) seguem o router normalmente.

import { services } from '../services'
import { canOpenExternally, isExternalUrl } from './externalLinks'

let installed = false

/** Entrega ao SO; nunca deixa uma exceção subir pelo clique. */
function openOutside(url: string): void {
  try {
    void services.openExternal(url).catch((e) => {
      // Falhou (ex.: app não instalado para o esquema): avisa no console para
      // quem depura; a UI mantém o endereço copiável.
      console.warn('[distorrent] não foi possível abrir o endereço externo:', String(e))
    })
  } catch (e) {
    console.warn('[distorrent] abrir endereço externo falhou:', String(e))
  }
}

/**
 * Instala o interceptador uma vez por processo e devolve a função de remoção.
 * Idempotente: chamadas repetidas não empilham listeners.
 */
export function installExternalLinkHandler(): () => void {
  if (typeof document === 'undefined') return () => {}
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const onClick = (ev: MouseEvent) => {
    // Respeita middle-click? Não: o botão do meio também abriria janela interna.
    if (ev.defaultPrevented) return
    const alvo = ev.target as Element | null
    const link = alvo?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!link) return
    const href = link.getAttribute('href') ?? ''
    if (!href) return
    // `mailto:`/`tel:` e afins: já são "externos" por definição.
    const externo = isExternalUrl(href, origin) || canOpenExternally(href)
    if (!externo) return
    ev.preventDefault()
    ev.stopPropagation()
    openOutside(link.href && canOpenExternally(link.href) ? link.href : href)
  }
  // Captura: roda antes de qualquer handler da aplicação (inclusive os que
  // fazem `stopPropagation`, como o do markdown).
  document.addEventListener('click', onClick, true)
  // `auxclick` = botão do meio; sem isto ele abria a janela interna também.
  document.addEventListener('auxclick', onClick as EventListener, true)
  installed = true
  return () => {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('auxclick', onClick as EventListener, true)
    installed = false
  }
}

/** O interceptador já foi instalado neste processo? (diagnóstico/teste) */
export function isExternalLinkHandlerInstalled(): boolean {
  return installed
}
