import { useEffect, useMemo } from 'react'
import { getPrefs, usePrefs } from './prefs'
import {
  applyThemeVars, resolveTheme, setThemeSource,
  type Surface, type ThemeName, type Tokens,
} from './theme'

// O módulo de tema fica puro (sem React/localStorage) para os testes; aqui ele
// aprende de onde ler as preferências do usuário.
setThemeSource(() => {
  const p = getPrefs()
  return { theme: p.theme as ThemeName, customTheme: p.customTheme, customBase: p.customBase }
})

/**
 * Fonte única do tema em runtime: grava as variáveis CSS (`--dt-*`) e devolve
 * uma assinatura estável para os componentes saberem que a paleta mudou.
 */
export function useThemeRevision(surface: Surface = 'desktop'): string {
  const prefs = usePrefs()
  const tokens = useMemo(
    () => resolveTheme(prefs.theme, prefs.customTheme as Partial<Tokens>, prefs.customBase as ThemeName, surface),
    [prefs.theme, prefs.customTheme, prefs.customBase, surface],
  )
  useEffect(() => { applyThemeVars(tokens) }, [tokens])
  return useMemo(
    () => `${prefs.theme}|${prefs.customBase ?? ''}|${JSON.stringify(prefs.customTheme ?? {})}`,
    [prefs.theme, prefs.customBase, prefs.customTheme],
  )
}

/** Assina as prefs para que componentes `memo` também repintem ao trocar o tema. */
export function usePalette() {
  usePrefs()
}
