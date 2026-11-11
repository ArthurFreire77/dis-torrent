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

export type ThemeName = 'dark' | 'light' | 'system' | 'custom'
export type Tokens = Record<keyof typeof dark, string>

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

export function resolveTheme(name: ThemeName, customTokens?: Partial<Tokens>): Tokens {
  if (name === 'custom' && customTokens) {
    return { ...dark, ...customTokens }
  }
  if (name === 'light') return { ...light }
  if (name === 'system' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(prefers-color-scheme: light)').matches) return { ...light }
    } catch {  }
  }
  const preset = PRESET_THEMES[name]
  if (preset) return { ...dark, ...preset.tokens }
  return { ...dark }
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
