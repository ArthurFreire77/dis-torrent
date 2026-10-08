// Tokens centrais — valores congelados, só centraliza os hex em produção.

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

export type ThemeName = 'dark' | 'light' | 'system'
export type Tokens = Record<keyof typeof dark, string>

export function resolveTheme(name: ThemeName): Tokens {
  if (name === 'light') return { ...light }
  if (name === 'system' && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      if (window.matchMedia('(prefers-color-scheme: light)').matches) return { ...light }
    } catch { /* ignora: cai para dark */ }
  }
  return { ...dark }
}

/** Espaçamento em múltiplos de 4 — mesma escala do DESIGN_SYSTEM.md. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const

/** Raio de canto padrão. */
export const radius = { sm: 6, md: 8, lg: 12, pill: 999 } as const

/** Durações de transição (respeita prefers-reduced-motion no CSS global). */
export const motion = { fast: 150, normal: 200 } as const

export const AVATAR_SIZES = { full: 40, compact: 32, large: 80 } as const

/** Cor determinística de fallback do avatar a partir do fingerprint. */
export function avatarColor(fp: string): string {
  const palette = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc']
  let h = 0
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}
