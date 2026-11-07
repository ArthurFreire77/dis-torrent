import { ui } from '../../shared/ui'

export const css = `
.botp-navbtn:hover{ background:${ui.surfaceHover}; color:${ui.text} }
.botp-navbtn:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.botp-row:hover{ background:${ui.surfaceHover}; border-color:${ui.borderStrong} }
.botp-row:focus-visible{ outline:2px solid ${ui.link}; outline-offset:2px }
.botp-console::-webkit-scrollbar{ width:8px }
.botp-console::-webkit-scrollbar-thumb{ background:${ui.borderStrong}; border-radius:4px }
@media (max-width: 720px){
  .botp-head{ flex-wrap:wrap }
}
`

export type Tab = 'credenciais' | 'comandos' | 'permissoes' | 'primitivas' | 'eventos' | 'runtime' | 'console'

const CHIP_TONE: Record<string, { color: string; background: string; borderColor: string }> = {
  ok: { color: '#a5e5bd', background: 'rgba(35,165,89,.14)', borderColor: 'rgba(35,165,89,.5)' },
  bad: { color: '#ffb3b3', background: 'rgba(242,63,66,.14)', borderColor: 'rgba(242,63,66,.5)' },
  warn: { color: '#ffe0a3', background: 'rgba(240,178,50,.14)', borderColor: 'rgba(240,178,50,.5)' },
}

export const chip = (tone?: 'ok' | 'bad' | 'warn'): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  padding: '2px 7px',
  borderRadius: 99,
  border: `1px solid ${tone ? CHIP_TONE[tone].borderColor : ui.border}`,
  background: tone ? CHIP_TONE[tone].background : ui.input,
  color: tone ? CHIP_TONE[tone].color : ui.muted,
  fontSize: 9.5,
  fontWeight: 800,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
})

export const mono: React.CSSProperties = { fontFamily: 'JetBrains Mono, ui-monospace, monospace' }

export const consoleStyle: React.CSSProperties = {
  ...mono,
  fontSize: 11.5,
  background: '#15171b',
  border: `1px solid ${ui.border}`,
  borderRadius: 8,
  padding: '9px 10px',
  maxHeight: 260,
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
}

export const lineStyle = (level?: string): React.CSSProperties => ({
  display: 'flex',
  gap: 7,
  padding: '1px 0',
  color: level === 'error' ? '#ff9c9c' : level === 'warn' ? '#ffe0a3' : undefined,
})
