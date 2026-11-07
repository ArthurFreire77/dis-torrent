import { useEffect } from 'react'

/**
 * Injeta CSS que o `style-src` do Tauri deixa passar.
 *
 * POR QUE NÃO `<style>`: o Tauri põe um `nonce` no CSP e, pela spec, a presença
 * de nonce ANULA o `'unsafe-inline'`. Toda tag `<style>` criada pelo React em
 * runtime é descartada — foi por isso que o painel do bot apareceu com os
 * botões crus do navegador. `adoptedStyleSheets` (CSSOM) não passa pelo parser
 * de HTML e entra normalmente; `insertRule` NÃO serve (também é bloqueado).
 *
 * Use só para o que `style=` inline não cobre: `:hover`, `:focus-visible` e
 * `@media`. Layout continua em `style=`.
 */
const folha: CSSStyleSheet | null = (() => {
  try {
    if (typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
      return new CSSStyleSheet()
    }
  } catch {}
  return null
})()

/** Regras já publicadas. As folhas continuam valendo mesmo sem componente montado. */
const publicadas = new Set<string>()

export function useDynamicStyles(css: string): void {
  useEffect(() => {
    if (!css.trim() || publicadas.has(css)) return
    publicadas.add(css)

    if (!folha) {
      const tag = document.createElement('style')
      tag.textContent = css
      document.head.appendChild(tag)
      return
    }

    try {
      folha.replaceSync([...publicadas].join('\n'))
      if (!document.adoptedStyleSheets.includes(folha)) {
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, folha]
      }
    } catch {
      // CSS inválido numa regra derrubaria as outras: solta e tenta na próxima.
      publicadas.delete(css)
    }
  }, [css])
}

/** Atalho declarativo para quem não quer chamar o hook direto. */
export function DynamicStyles({ css }: { css: string }): null {
  useDynamicStyles(css)
  return null
}
