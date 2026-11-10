// Customizações do perfil com lista fechada; espelha o allowlist do core.
import type React from 'react'

export const PROFILE_THEMES = ['none', 'aurora', 'sunset', 'ocean', 'neon', 'forest'] as const
export type ProfileTheme = (typeof PROFILE_THEMES)[number]

export const AVATAR_EFFECTS = ['none', 'glow', 'pulse', 'rainbow', 'sparkle'] as const
export type AvatarEffect = (typeof AVATAR_EFFECTS)[number]

export interface Gradient {
  from: string
  to: string
}

const THEME_GRADIENTS: Record<Exclude<ProfileTheme, 'none'>, Gradient> = {
  aurora: { from: '#00c2a8', to: '#5865f2' },
  sunset: { from: '#ff7a59', to: '#eb459e' },
  ocean: { from: '#00a8fc', to: '#1e3a8a' },
  neon: { from: '#b026ff', to: '#00ffa3' },
  forest: { from: '#23a55a', to: '#14532d' },
}

export function normalizeTheme(value: string | null | undefined): ProfileTheme {
  const v = (value ?? '').trim().toLowerCase()
  return (PROFILE_THEMES as readonly string[]).includes(v) ? (v as ProfileTheme) : 'none'
}

export function normalizeAvatarEffect(value: string | null | undefined): AvatarEffect {
  const v = (value ?? '').trim().toLowerCase()
  return (AVATAR_EFFECTS as readonly string[]).includes(v) ? (v as AvatarEffect) : 'none'
}

export function themeGradient(theme: string | null | undefined, accent: string): Gradient {
  const t = normalizeTheme(theme)
  if (t === 'none') return { from: accent, to: '#1e1f22' }
  return THEME_GRADIENTS[t]
}

/** Fundo CSS do banner; `accent` é o fallback de quem não escolheu tema. */
export function bannerBackground(
  theme: string | null | undefined,
  accent: string,
  bannerB64: string,
): string {
  if (bannerB64) return `url("data:image/jpeg;base64,${bannerB64}")`
  const g = themeGradient(theme, accent)
  return `linear-gradient(135deg, ${g.from} 0%, ${g.to} 130%)`
}

/** Cor da aura. `none` devolve null para o componente não desenhar nada. */
export function effectColor(effect: string | null | undefined, accent: string): string | null {
  switch (normalizeAvatarEffect(effect)) {
    case 'none': return null
    case 'glow': return accent
    case 'pulse': return accent
    case 'rainbow': return 'conic-gradient(from 0deg, #ff5757, #ffb703, #23a55a, #00a8fc, #5865f2, #eb459e, #ff5757)'
    case 'sparkle': return '#ffe066'
    default: return null
  }
}

/** Classes CSS da aura (keyframes em global.css). */
export function effectClass(effect: string | null | undefined): string {
  const e = normalizeAvatarEffect(effect)
  return e === 'none' ? '' : `pfx pfx-${e}`
}

/**
 * Variável CSS da aura com a cor do perfil. O CSS usa `var(--pfx-aura, #5865f2)`,
 * então o anel deixa de ser sempre azul quando a pessoa escolhe outra cor.
 */
export function effectStyle(effect: string | null | undefined, accent: string): React.CSSProperties | undefined {
  const e = normalizeAvatarEffect(effect)
  if (e === 'none' || e === 'rainbow' || e === 'sparkle') return undefined
  const cor = (accent || '').trim()
  if (!cor) return undefined
  return { ['--pfx-aura' as string]: cor } as React.CSSProperties
}

/** Decoração: até 3 grafemas, sem letras — texto comum viraria apelido não moderado. */
export function normalizeDecoration(value: string | null | undefined): string {
  const raw = (value ?? '').replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim()
  if (!raw) return ''
  const chars = Array.from(raw)
  if (chars.length > 3) return ''
  if (chars.some(c => /[\p{L}\p{N}]/u.test(c))) return ''
  return raw
}

export interface StyleChoice<T extends string> {
  id: T
  label: string
  detail: string
}

export const THEME_CHOICES: StyleChoice<ProfileTheme>[] = [
  { id: 'none', label: 'Nenhum', detail: 'usa a cor de destaque do perfil' },
  { id: 'aurora', label: 'Aurora', detail: 'verde-água para azul' },
  { id: 'sunset', label: 'Pôr do sol', detail: 'laranja para rosa' },
  { id: 'ocean', label: 'Oceano', detail: 'azul claro para anil' },
  { id: 'neon', label: 'Neon', detail: 'violeta para verde-limão' },
  { id: 'forest', label: 'Floresta', detail: 'verde profundo' },
]

export const EFFECT_CHOICES: StyleChoice<AvatarEffect>[] = [
  { id: 'none', label: 'Nenhum', detail: 'avatar limpo' },
  { id: 'glow', label: 'Brilho', detail: 'halo na cor do perfil' },
  { id: 'pulse', label: 'Pulsar', detail: 'halo que respira' },
  { id: 'rainbow', label: 'Arco-íris', detail: 'anel girando em todas as cores' },
  { id: 'sparkle', label: 'Brilhos', detail: 'faíscas ao redor do avatar' },
]

export const DECORATION_CHOICES = ['', '🌸', '⭐', '👑', '🔥', '🎮', '🎧', '💎', '⚡', '🌙']
