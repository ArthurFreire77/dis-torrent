export const dark = {
  rail: '#1e1f22',
  sidebar: '#2b2d31',
  main: '#313338',
  composer: '#383a40',
  input: '#1e1f22',
  hover: '#35373c',
  selected: '#404249',
  border: '#26272b',
  borderStrong: '#3f4147',
  panel: '#2b2d31',
  footer: '#232428',
  accent: '#5865f2',
  accentHover: '#4752c4',
  link: '#00a8fc',
  green: '#23a559',
  yellow: '#f0b232',
  red: '#f23f42',
  pink: '#eb459e',
  blurple: '#5865f2',
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
} as const

export const light = {
  rail: '#e3e5e8',
  sidebar: '#f2f3f5',
  main: '#ffffff',
  composer: '#f2f3f5',
  input: '#ebedef',
  hover: '#e3e5e8',
  selected: '#d4d7dc',
  border: '#e3e5e8',
  borderStrong: '#b5bac1',
  panel: '#f2f3f5',
  footer: '#e3e5e8',
  accent: '#5865f2',
  accentHover: '#4752c4',
  link: '#00a8fc',
  green: '#23a559',
  yellow: '#c98a12',
  red: '#da373c',
  pink: '#eb459e',
  blurple: '#5865f2',
  text: '#060607',
  heading: '#060607',
  muted: '#5c5e66',
} as const

export type ThemeName = 'dark' | 'light' | 'system' | 'custom' | 'midnight' | 'forest' | 'sunset' | 'ocean' | 'dracula'
export type Tokens = Record<keyof typeof dark, string>

/** Superfície de renderização: o mobile tem paleta própria no tema escuro. */
export type Surface = 'desktop' | 'mobile'

/** Base escura do celular (mantém a cara atual no tema Escuro). */
export const mobileDark: Tokens = {
  ...dark,
  rail: '#0f1115',
  sidebar: '#1a1d23',
  main: '#14161a',
  composer: '#1f2126',
  input: '#23262f',
  hover: '#2a2d36',
  selected: '#2e313c',
  border: '#242830',
  borderStrong: '#32363f',
  panel: '#1e2128',
  footer: '#0f1115',
  text: '#f2f3f5',
  heading: '#ffffff',
  muted: '#8e929b',
}

/** Tema customizado pelo usuário. */
export interface CustomTheme {
  name: string
  tokens: Partial<Tokens>
}

/** Temas pré-definidos além de dark/light. */
export const PRESET_THEMES: Record<string, { name: string; tokens: Partial<Tokens> }> = {
  dark: { name: 'Escuro', tokens: dark },
  light: { name: 'Claro', tokens: light },
  midnight: {
    name: 'Meia-noite',
    tokens: {
      ...dark,
      rail: '#0a0a0f',
      sidebar: '#12121a',
      main: '#1a1a24',
      composer: '#22222e',
      input: '#12121a',
      hover: '#252532',
      selected: '#2e2e3e',
      border: '#1e1e28',
      borderStrong: '#32323e',
      panel: '#16161e',
      footer: '#101016',
      accent: '#7c3aed',
      accentHover: '#6d28d9',
      link: '#a78bfa',
      text: '#e2e8f0',
      heading: '#f1f5f9',
      muted: '#94a3b8',
    },
  },
  forest: {
    name: 'Floresta',
    tokens: {
      ...dark,
      rail: '#0d1a0f',
      sidebar: '#14261a',
      main: '#1a3322',
      composer: '#1f4028',
      input: '#14261a',
      hover: '#264d33',
      selected: '#2d5c3d',
      border: '#1a3322',
      borderStrong: '#2d5c3d',
      panel: '#1a3322',
      footer: '#14261a',
      accent: '#22c55e',
      accentHover: '#16a34a',
      link: '#4ade80',
      text: '#dcfce7',
      heading: '#f0fdf4',
      muted: '#86efac',
    },
  },
  sunset: {
    name: 'Pôr do sol',
    tokens: {
      ...dark,
      rail: '#1a0f0a',
      sidebar: '#261812',
      main: '#33221a',
      composer: '#40281f',
      input: '#261812',
      hover: '#4d3326',
      selected: '#5c3d2d',
      border: '#33221a',
      borderStrong: '#5c3d2d',
      panel: '#33221a',
      footer: '#261812',
      accent: '#f97316',
      accentHover: '#ea580c',
      link: '#fb923c',
      text: '#fed7aa',
      heading: '#ffedd5',
      muted: '#fdba74',
    },
  },
  ocean: {
    name: 'Oceano',
    tokens: {
      ...dark,
      rail: '#0a0f1a',
      sidebar: '#121a26',
      main: '#1a2233',
      composer: '#1f2a40',
      input: '#121a26',
      hover: '#26334d',
      selected: '#2d3d5c',
      border: '#1a2233',
      borderStrong: '#3d4d6e',
      panel: '#1a2233',
      footer: '#121a26',
      accent: '#0ea5e9',
      accentHover: '#0284c7',
      link: '#38bdf8',
      text: '#e0f2fe',
      heading: '#f0f9ff',
      muted: '#7dd3fc',
    },
  },
  dracula: {
    name: 'Drácula',
    tokens: {
      ...dark,
      rail: '#1e1f29',
      sidebar: '#282a36',
      main: '#44475a',
      composer: '#4d5066',
      input: '#282a36',
      hover: '#565b73',
      selected: '#6272a4',
      border: '#44475a',
      borderStrong: '#6272a4',
      panel: '#383a47',
      footer: '#21222c',
      accent: '#bd93f9',
      accentHover: '#a370f7',
      link: '#8be9fd',
      text: '#f8f8f2',
      heading: '#ffffff',
      muted: '#6272a4',
      green: '#50fa7b',
      yellow: '#f1fa8c',
      red: '#ff5555',
      pink: '#ff79c6',
    },
  },
}

/** Nomes oferecidos na galeria de temas. */
export const THEME_CHOICES: ThemeName[] = ['dark', 'light', 'midnight', 'forest', 'sunset', 'ocean', 'dracula']

function baseTokens(name: ThemeName, surface: Surface = 'desktop'): Tokens {
  if (name === 'light') return { ...light }
  if (name === 'system') {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      try {
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return { ...light }
      } catch {  }
    }
    return surface === 'mobile' ? { ...mobileDark } : { ...dark }
  }
  if (name === 'dark') return surface === 'mobile' ? { ...mobileDark } : { ...dark }
  const preset = PRESET_THEMES[name]
  if (preset) return { ...dark, ...preset.tokens }
  return surface === 'mobile' ? { ...mobileDark } : { ...dark }
}

/**
 * Resolve o tema efetivo. `custom` parte do tema `customBase` (padrão: escuro),
 * senão personalizar um tema claro sempre voltaria a fundo escuro.
 */
export function resolveTheme(
  name: ThemeName,
  customTokens?: Partial<Tokens>,
  customBase?: ThemeName,
  surface: Surface = 'desktop',
): Tokens {
  if (name === 'custom') {
    const base = customBase && customBase !== 'custom' ? baseTokens(customBase, surface) : baseTokens('dark', surface)
    return { ...base, ...(customTokens ?? {}) }
  }
  return baseTokens(name, surface)
}

/* ------------------------------------------------------------------ *
 * Paleta viva: os módulos declaram `const t = themedPalette({...})` e
 * cada leitura devolve o token do tema ativo. Sem isso a cor ficava
 * congelada no valor do import e a personalização não saía do papel.
 * ------------------------------------------------------------------ */

let liveTokens: Record<Surface, Tokens> = { desktop: { ...dark }, mobile: { ...mobileDark } }

/**
 * Fonte das preferências. O runtime registra isto; o módulo de tema fica puro
 * para poder ser importado por testes sem localStorage nem React.
 */
export type ThemeSource = () => { theme: ThemeName; customTheme?: Record<string, string>; customBase?: string }

let themeSource: ThemeSource | null = null
let cachedSource: ReturnType<ThemeSource> | null = null

export function setThemeSource(source: ThemeSource | null) {
  themeSource = source
  cachedSource = null
}

/** Força o recálculo depois de uma troca de tema. */
export function refreshActiveTheme() {
  cachedSource = null
}

function computeTokens(): Record<Surface, Tokens> {
  if (!themeSource) return { desktop: { ...dark }, mobile: { ...mobileDark } }
  const p = themeSource()
  return {
    desktop: resolveTheme(p.theme, p.customTheme as Partial<Tokens>, p.customBase as ThemeName, 'desktop'),
    mobile: resolveTheme(p.theme, p.customTheme as Partial<Tokens>, p.customBase as ThemeName, 'mobile'),
  }
}

/** Tokens do tema ativo para a superfície pedida. */
export function activeTokens(surface: Surface = 'desktop'): Tokens {
  if (!themeSource) return liveTokens[surface]
  const p = themeSource()
  // Compara por identidade: `prefs` devolve o mesmo objeto enquanto nada muda.
  if (p !== cachedSource) {
    cachedSource = p
    liveTokens = computeTokens()
  }
  return liveTokens[surface]
}

/**
 * Paleta reativa: tokens que existem no tema vêm do tema ativo; o resto
 * (chaves locais de cada componente) cai no fallback do próprio arquivo.
 */
export function themedPalette<F extends Record<string, string | number>>(fallback: F, surface: Surface = 'desktop'): F {
  const read = (prop: string): string | number | undefined => {
    const v = (activeTokens(surface) as Record<string, string>)[prop]
    if (typeof v === 'string') return v
    return fallback[prop]
  }
  return new Proxy({} as F, {
    get: (_alvo, prop) => (typeof prop === 'string' ? read(prop) : undefined),
    has: (_alvo, prop) => typeof prop === 'string' && (prop in fallback || prop in activeTokens(surface)),
    ownKeys: () => Array.from(new Set([...Object.keys(fallback), ...Object.keys(activeTokens(surface))])),
    getOwnPropertyDescriptor: (_alvo, prop) => (
      typeof prop === 'string'
        ? { enumerable: true, configurable: true, value: read(prop) }
        : undefined
    ),
  })
}

/** Publica os tokens como variáveis CSS, inclusive para os arquivos .css. */
export function applyThemeVars(tokens: Tokens = activeTokens()) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (!root) return
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(`--dt-${k}`, v)
  const surface = tokens.main || '#313338'
  root.style.colorScheme = isLightSurface(surface) ? 'light' : 'dark'
}

const HEX_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i

/** Normaliza `#abc`/`#AABBCC` para `#aabbcc`; devolve null se inválido. */
export function normalizeHex(input: string): string | null {
  const raw = (input ?? '').trim()
  if (!HEX_RE.test(raw)) return null
  const hex = raw.slice(1).toLowerCase()
  return hex.length === 3 ? `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : `#${hex}`
}

function rgbOf(hex: string): [number, number, number] {
  const h = normalizeHex(hex) ?? '#000000'
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

function toHex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
}

/** Clareia (positivo) ou escurece (negativo) uma cor por uma fração 0..1. */
export function shade(hex: string, amount: number): string {
  const [r, g, b] = rgbOf(hex)
  const mix = (c: number) => (amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`
}

/** Texto legível sobre a cor informada (contraste WCAG aproximado). */
export function readableOn(hex: string): string {
  const [r, g, b] = rgbOf(hex).map((c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return lum > 0.55 ? '#111214' : '#ffffff'
}

/** Superfície clara? Usado para escolher esquema de rolagem/controles nativos. */
export function isLightSurface(hex: string): boolean {
  return readableOn(hex) === '#111214'
}

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const

export const radius = { sm: 6, md: 8, lg: 12, pill: 999 } as const

export const motion = { fast: 150, normal: 200 } as const

export const AVATAR_SIZES = { full: 40, compact: 32, large: 80 } as const

export function avatarColor(fp: string): string {
  const palette = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc']
  let h = 0
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}
