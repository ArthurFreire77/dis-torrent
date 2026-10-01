// Utilitários compartilhados entre desktop (ThemeShell) e mobile (MobileShell).
// Elimina duplicação de código e garante consistência.

import type { NetworkState, MessageStatus } from '../services/models'

// ---------- Paleta de cores do tema ----------
export const themeColors = {
  rail: '#1e1f22',
  sidebar: '#2b2d31',
  main: '#313338',
  composer: '#383a40',
  input: '#1e1f22',
  hover: '#35373c',
  selected: '#404249',
  border: '#26272b',
  panel: '#2b2d31',
  footer: '#232428',
  accent: '#5865f2',
  accentHover: '#4752c4',
  link: '#00a8fc',
  green: '#23a559',
  yellow: '#f0b232',
  red: '#f23f42',
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
  // Light theme
  lbg: '#ffffff',
  lsidebar: '#f2f3f5',
  lrail: '#e3e5e8',
  ltext: '#060607',
  lmuted: '#5c5e66',
  lborder: '#e3e5e8',
  linput: '#ebedef',
} as const

// ---------- Cores de estado de rede ----------
export const stateColor: Record<NetworkState, string> = {
  CONNECTED: themeColors.green,
  CONNECTING: themeColors.yellow,
  RECONNECTING: themeColors.yellow,
  DISCONNECTED: '#80848e',
}

export const stateLabel: Record<NetworkState, string> = {
  CONNECTED: 'CONECTADO',
  CONNECTING: 'CONECTANDO',
  RECONNECTING: 'RECONECTANDO',
  DISCONNECTED: 'OFFLINE',
}

// ---------- Gerador de cores para avatar ----------
const AVATAR_PALETTE = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc']

export function avatarColor(fp: string): string {
  let h = 0
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

// ---------- Formatação de tempo ----------
export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// ---------- Status de mensagem ----------
export function statusText(s: MessageStatus): string {
  if (s === 'pending') return 'pendente'
  if (s === 'sending') return 'enviando'
  if (s === 'sent') return 'enviado'
  if (s === 'delivered') return 'entregue'
  return ''
}

// ---------- Glyphicon de status ----------
export function StatusGlyph({ s, color }: { s: MessageStatus; color?: string }): JSX.Element | null {
  const c = color ?? themeColors.muted
  if (s === 'delivered') return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={themeColors.green} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12l5 5L17 7"/><path d="M9 12l5 5L24 7" transform="translate(-3,0) scale(0.9)"/></svg>
  if (s === 'sent') return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 7"/></svg>
  if (s === 'sending') return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={c} strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9" strokeDasharray="40 16"/></svg>
  if (s === 'pending') return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={themeColors.yellow} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
  if (s === 'failed') return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={themeColors.red} strokeWidth="2.4" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5 M12 16h.01"/></svg>
  return null
}

// ---------- Componente Avatar ----------
export function Avatar({ name, fp, size }: { name: string; fp: string; size: number }): JSX.Element {
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  return (
    <span style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: avatarColor(fp),
      color: '#fff',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontWeight: 800,
      fontSize: size * 0.42,
      flexShrink: 0,
    }}>
      {initial}
    </span>
  )
}

// ---------- Dot de presença (online/offline) ----------
export function PeerDot({ on, ring }: { on: boolean; ring?: string }): JSX.Element {
  return (
    <span style={{
      position: 'absolute',
      right: -2,
      bottom: -2,
      width: 12,
      height: 12,
      borderRadius: '50%',
      background: on ? themeColors.green : '#80848e',
      border: `3px solid ${ring ?? themeColors.main}`,
    }} />
  )
}

// ---------- Estilos compartilhados ----------
export const inputStyle: React.CSSProperties = {
  width: '100%',
  background: themeColors.input,
  border: `1px solid ${themeColors.border}`,
  borderRadius: 8,
  padding: '11px 12px',
  color: themeColors.text,
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
}

export const btnStyle: React.CSSProperties = {
  width: '100%',
  background: themeColors.accent,
  color: '#fff',
  border: 'none',
  padding: 12,
  borderRadius: 8,
  fontWeight: 800,
  cursor: 'pointer',
  fontSize: 14,
}
