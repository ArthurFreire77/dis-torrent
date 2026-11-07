export type FormatMode = 'bold' | 'italic' | 'under' | 'strike' | 'code' | 'spoiler' | 'quote'

export interface AutoItem {
  key: string
  kind: 'mention' | 'emoji' | 'slash'
  label: string
  hint?: string
  color?: string
  glyph?: string
  insert: string
  fp?: string
}

export const FORMAT_BUTTONS: { id: FormatMode; glyph: string; title: string }[] = [
  { id: 'bold', glyph: 'B', title: 'Negrito (Ctrl+B)' },
  { id: 'italic', glyph: '*I*', title: 'Itálico (Ctrl+I)' },
  { id: 'under', glyph: 'U̲', title: 'Sublinhado (Ctrl+U)' },
  { id: 'strike', glyph: 'S̶', title: 'Tachado' },
  { id: 'code', glyph: '</>', title: 'Código' },
  { id: 'spoiler', glyph: '||', title: 'Spoiler' },
  { id: 'quote', glyph: '❝', title: 'Citação' },
]

export const composerMenuStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
  background: 'transparent', border: 'none', color: '#dbdee1', cursor: 'pointer',
  padding: '7px 8px', borderRadius: 6, fontSize: 12.5,
}

export const SLASH_BASE = [
  { name: 'ajuda' }, { name: 'ping' }, { name: 'hora' }, { name: 'uptime' },
  { name: 'meu-fp' }, { name: 'meu-status' }, { name: 'membros' }, { name: 'canais' },
  { name: 'dado' },
]

export function fmtShortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export const SECTION_IDA: Record<string, 'visao-geral' | 'canais' | 'cargos' | 'membros' | 'bots'> = {
  geral: 'visao-geral',
  canais: 'canais',
  cargos: 'cargos',
  membros: 'membros',
  bots: 'bots',
}
