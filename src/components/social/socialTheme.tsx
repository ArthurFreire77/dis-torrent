import type { PresenceStatus, ProfileView } from '../../services/models'

export const T = {
  main: '#313338',
  sidebar: '#2b2d31',
  rail: '#1e1f22',
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
  border: '#3f4147',
  input: '#1e1f22',
  accent: '#5865f2',
  green: '#23a55a',
  red: '#da373c',
  yellow: '#f0b232',
  pink: '#eb459e',
  blurple: '#5865f2',
}

export const PRESENCE_COLOR: Record<PresenceStatus, string> = {
  online: '#23a55a',
  idle: '#f0b232',
  dnd: '#ed4245',
  invisible: '#80848e',
  offline: '#80848e',
}

export const PRESENCE_LABEL: Record<PresenceStatus, string> = {
  online: 'Online',
  idle: 'Ausente',
  dnd: 'Não perturbe',
  invisible: 'Invisível',
  offline: 'Offline',
}

export function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

export function fmtDay(ts: number): string {
  const d = new Date(ts)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  if (sameDay) return 'Hoje'
  const y = new Date(today.getTime() - 86400000)
  if (d.toDateString() === y.toDateString()) return 'Ontem'
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function displayNameOf(
  fp: string,
  nickname: string | undefined | null,
  profiles: Record<string, ProfileView>,
): string {
  if (nickname) return nickname
  return profiles[fp]?.display_name || nickname || fp
}
