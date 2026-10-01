// Componentes da CAMADA SOCIAL v3 — paridade Discord.
// Todos consomem `services` (nativo OU browser): a UI não sabe a diferença
// e nunca decide permissão — quem valida é o motor.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { services } from '../../services'
import type {
  BanView,
  ChannelMeta,
  EmojiView,
  EventView,
  MsgMetaView,
  PollView,
  PollTally,
  PresenceStatus,
  PresenceView,
  ProfileView,
  ReactionSummary,
  SearchHit,
  StoredMessage,
  ThreadView,
} from '../../services/models'

// ============================== TEMA ==============================

const T = {
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

const QUICK_REACTIONS = ['👍', '❤️', '🔥', '😂', '🎉', '👀', '🚀', '🙏']

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

// ======================= TEXTO RICO (markdown Discord) =======================

const EMOJI_SHORT: Record<string, string> = {
  smile: '😄', joy: '😂', heart: '❤️', fire: '🔥', tada: '🎉', eyes: '👀',
  rocket: '🚀', pray: '🙏', ok: '👌', thumbsup: '👍', thumbsdown: '👎',
  thinking: '🤔', cry: '😢', skull: '💀', 100: '💯', check: '✅', x: '❌',
  zap: '⚡', star: '⭐', sparkles: '✨', wave: '👋', clap: '👏', bug: '🐛',
}

/**
 * Renderiza markdown no estilo Discord: negrito, itálico, tachado, spoiler
 * (||...||), código inline, bloco de código com highlighting de linguagem,
 * citação, títulos, links, menções e shortcodes :emoji:.
 * Destaca `highlight` (usado pela busca).
 */
export function RichText({
  body,
  highlight,
  onMention,
}: {
  body: string
  highlight?: string
  onMention?: (fp: string) => void
}) {
  const [spoilers, setSpoilers] = useState<Record<number, boolean>>({})
  const nodes = useMemo(
    () => parseDiscord(body, highlight, onMention, spoilers, setSpoilers),
    [body, highlight, onMention, spoilers],
  )
  return <>{nodes}</>
}

function parseDiscord(
  body: string,
  highlight: string | undefined,
  onMention: ((fp: string) => void) | undefined,
  spoilers: Record<number, boolean>,
  setSpoilers: React.Dispatch<React.SetStateAction<Record<number, boolean>>>,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const lines = body.split('\n')
  let key = 0

  lines.forEach((line, li) => {
    // bloco de código
    const fence = line.match(/^```(\w+)?\s*$/)
    if (fence) {
      const lang = fence[1] || ''
      const buf: string[] = []
      let i = li + 1
      for (; i < lines.length; i++) {
        if (/^```\s*$/.test(lines[i])) break
        buf.push(lines[i])
      }
      out.push(
        <pre key={key++} style={codeBlockStyle(lang)}>
          <span style={codeHeaderStyle}>{lang || 'texto'}</span>
          <code>{highlightLines(buf.join('\n'), lang)}</code>
        </pre>,
      )
      return
    }

    // spoiler ||texto||
    if (line.includes('||')) {
      const parts = line.split('||')
      const idx = key
      const children: React.ReactNode[] = []
      parts.forEach((p, i) => {
        if (i % 2 === 1) {
          children.push(
            <span
              key={key++}
              onClick={() => setSpoilers(s => ({ ...s, [idx]: !s[idx] }))}
              title="Clique para revelar"
              style={{
                background: spoilers[idx] ? 'transparent' : 'rgba(255,255,255,.12)',
                color: spoilers[idx] ? 'inherit' : 'transparent',
                borderRadius: 3,
                cursor: 'pointer',
                textShadow: spoilers[idx] ? 'none' : '0 0 7px rgba(0,0,0,.95)',
              }}
            >
              {renderInline(p, highlight, onMention, () => key++)}
            </span>,
          )
        } else {
          children.push(<span key={key++}>{renderInline(p, highlight, onMention, () => key++)}</span>)
        }
      })
      out.push(<div key={idx} style={{ whiteSpace: 'pre-wrap' }}>{children}</div>)
      return
    }

    // citação
    if (line.startsWith('> ')) {
      out.push(
        <div key={key++} style={{ borderLeft: '4px solid #4e5058', paddingLeft: 10, margin: '2px 0', color: T.muted, whiteSpace: 'pre-wrap' }}>
          {renderInline(line.slice(2), highlight, onMention, () => key++)}
        </div>,
      )
      return
    }

    // título
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const size = [18, 16, 15][h[1].length - 1]
      out.push(
        <div key={key++} style={{ fontWeight: 800, color: T.heading, fontSize: size, margin: '4px 0 2px' }}>
          {renderInline(h[2], highlight, onMention, () => key++)}
        </div>,
      )
      return
    }

    out.push(
      <div key={key++} style={{ whiteSpace: 'pre-wrap', minHeight: line ? undefined : 4 }}>
        {renderInline(line, highlight, onMention, () => key++)}
      </div>,
    )
  })
  return out
}

function codeBlockStyle(lang: string): React.CSSProperties {
  return {
    background: '#2b2d31',
    border: `1px solid ${T.border}`,
    borderRadius: 6,
    padding: '8px 10px 10px',
    margin: '4px 0',
    overflowX: 'auto',
    position: 'relative',
    fontSize: 12.5,
    lineHeight: 1.5,
  }
}
const codeHeaderStyle: React.CSSProperties = {
  position: 'absolute',
  top: -1,
  right: 6,
  fontSize: 9,
  color: T.muted,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
}

const KEYWORDS: Record<string, string[]> = {
  rust: ['fn', 'let', 'mut', 'pub', 'struct', 'impl', 'match', 'use', 'enum', 'return'],
  typescript: ['const', 'let', 'function', 'return', 'async', 'await', 'interface', 'type', 'import', 'export'],
  javascript: ['const', 'let', 'var', 'function', 'return', 'async', 'await', 'import', 'export'],
  python: ['def', 'return', 'import', 'from', 'class', 'if', 'else', 'with', 'lambda'],
  sql: ['select', 'from', 'where', 'insert', 'update', 'delete', 'join', 'create', 'table'],
}
const KEYWORD_COLOR = '#c678dd'
const STRING_COLOR = '#98c379'
const COMMENT_COLOR = '#5c6370'

function highlightLines(code: string, lang: string): React.ReactNode[] {
  const kw = KEYWORDS[(lang || '').toLowerCase()]
  if (!kw) return [code]
  const parts: React.ReactNode[] = []
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|\s+|.)/g
  let m: RegExpExecArray | null
  let i = 0
  while ((m = re.exec(code)) !== null) {
    const tok = m[0]
    let color: string | undefined
    if (kw.includes(tok)) color = KEYWORD_COLOR
    else if (/^["']/.test(tok)) color = STRING_COLOR
    else if (/^\d/.test(tok)) color = '#d19a66'
    else if (tok.startsWith('//') || tok.startsWith('#')) color = COMMENT_COLOR
    parts.push(color ? <span key={i++} style={{ color }}>{tok}</span> : <span key={i++}>{tok}</span>)
  }
  return parts
}

function renderInline(
  text: string,
  highlight: string | undefined,
  onMention: ((fp: string) => void) | undefined,
  k: () => number,
): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const token = /(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(~~[^~]+~~)|(`[^`\n]+`)|(https?:\/\/\S+)|(<@[a-f0-9]{8,64}>)|(:[a-z0-9_+-]{2,}:)/gi
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = token.exec(text)) !== null) {
    if (m.index > last) out.push(withHighlight(text.slice(last, m.index), highlight, k))
    const t = m[0]
    if (t.startsWith('**')) out.push(<b key={k()} style={{ color: T.heading }}>{withHighlight(t.slice(2, -2), highlight, k)}</b>)
    else if (t.startsWith('~~')) out.push(<s key={k()} style={{ color: T.muted }}>{withHighlight(t.slice(2, -2), highlight, k)}</s>)
    else if (t.startsWith('*')) out.push(<em key={k()}>{withHighlight(t.slice(1, -1), highlight, k)}</em>)
    else if (t.startsWith('`')) out.push(<code key={k()} style={{ background: '#2b2d31', padding: '1px 4px', borderRadius: 4, fontFamily: 'JetBrains Mono, monospace', fontSize: 12.5 }}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('http')) out.push(<a key={k()} href={t} target="_blank" rel="noreferrer noopener" style={{ color: '#00a8fc', textDecoration: 'none' }} onClick={e => e.stopPropagation()}>{t}</a>)
    else if (t.startsWith('<@')) {
      const fp = t.slice(2, -1)
      out.push(
        <span key={k()} onClick={e => { e.stopPropagation(); onMention?.(fp) }} style={{ background: 'rgba(88,101,242,.3)', color: '#c9cdfb', borderRadius: 4, padding: '1px 4px', cursor: onMention ? 'pointer' : 'inherit', fontWeight: 600 }}>
          @{fp.slice(0, 8)}
        </span>,
      )
    } else if (t.startsWith(':')) {
      const name = t.slice(1, -1).toLowerCase()
      const e = EMOJI_SHORT[name]
      out.push(<span key={k()} title={`:${name}:`}>{e || t}</span>)
    }
    last = m.index + t.length
    i++
  }
  if (last < text.length) out.push(withHighlight(text.slice(last), highlight, k))
  return out
}

function withHighlight(text: string, highlight: string | undefined, k: () => number): React.ReactNode {
  if (!highlight || highlight.length < 2) return text
  const idx = text.toLowerCase().indexOf(highlight.toLowerCase())
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: '#f0b232', color: '#1e1f22', borderRadius: 2 }}>{text.slice(idx, idx + highlight.length)}</mark>
      {text.slice(idx + highlight.length)}
    </>
  )
}

/** Card de pré-visualização de link (unfurl) — sem rede: domínio + URL. */
export function LinkUnfurl({ body }: { body: string }) {
  const urls = useMemo(() => (body.match(/https?:\/\/[^\s<>"']+/g) ?? []).slice(0, 2), [body])
  if (urls.length === 0) return null
  return (
    <>
      {urls.map((u) => {
        let host = u
        try { host = new URL(u).hostname } catch { /* ignore */ }
        return (
          <a key={u} href={u} target="_blank" rel="noreferrer noopener"
            style={{ display: 'block', marginTop: 6, borderLeft: `3px solid ${T.accent}`, background: T.sidebar, borderRadius: 6, padding: '8px 10px', maxWidth: 420, textDecoration: 'none' }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: '#00a8fc' }}>{host}</div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: 'JetBrains Mono', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</div>
          </a>
        )
      })}
    </>
  )
}

// ============================== PRESENÇA ==============================

export function PresenceDot({ status, size = 10, ring }: { status: PresenceStatus; size?: number; ring?: string }) {
  return (
    <span style={{
      position: 'absolute', right: -2, bottom: -2, width: size, height: size,
      background: PRESENCE_COLOR[status] ?? T.muted,
      border: `2px solid ${ring ?? T.sidebar}`, borderRadius: '50%', display: 'inline-block',
    }} />
  )
}

export function StatusPicker({ value, onChange }: { value: PresenceStatus; onChange: (s: PresenceStatus) => void }) {
  const opts: PresenceStatus[] = ['online', 'idle', 'dnd', 'invisible']
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {opts.map((s) => (
        <button key={s} onClick={() => onChange(s)} title={PRESENCE_LABEL[s]}
          style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '8px 10px',
            background: value === s ? 'rgba(88,101,242,.2)' : T.input,
            border: `1px solid ${value === s ? T.accent : T.border}`, borderRadius: 8,
            color: value === s ? T.heading : T.muted, cursor: 'pointer', fontSize: 10, fontWeight: 700,
          }}>
          <span style={{ width: 14, height: 14, borderRadius: '50%', background: PRESENCE_COLOR[s] }} />
          {PRESENCE_LABEL[s]}
        </button>
      ))}
    </div>
  )
}

// ============================== AVATAR ==============================

export function Avatar({ name, fp, size = 40, avatarB64, ring }: {
  name: string
  fp: string
  size?: number
  avatarB64?: string
  ring?: string
}) {
  const [err, setErr] = useState(false)
  if (avatarB64 && !err) {
    return <img src={`data:image/png;base64,${avatarB64}`} onError={() => setErr(true)} alt={name}
      style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: ring ? `2px solid ${ring}` : 'none' }} />
  }
  const h = Array.from(fp || name).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  const hue = h % 360
  const initial = (name || fp || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <span style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `hsl(${hue} 45% 32%)`,
      color: '#fff', fontWeight: 800, fontSize: size * 0.42,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      border: ring ? `2px solid ${ring}` : 'none', userSelect: 'none',
    }}>{initial}</span>
  )
}

// ============================== REAÇÕES ==============================

export function ReactionBar({ reactions, onToggle, onHoverList }: {
  reactions: ReactionSummary[]
  onToggle: (emoji: string) => void
  onHoverList?: (r: ReactionSummary) => void
}) {
  if (reactions.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {reactions.map((r) => (
        <button key={r.emoji} onClick={() => onToggle(r.emoji)}
          onMouseEnter={() => onHoverList?.(r)}
          title={`${r.count} · ${r.reactors.join(', ')}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8,
            background: r.mine ? 'rgba(88,101,242,.25)' : T.input,
            border: `1px solid ${r.mine ? T.accent : 'transparent'}`,
            color: T.text, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
          }}>
          <span style={{ fontSize: 15 }}>{r.emoji}</span>
          <span style={{ color: r.mine ? '#c9cdfb' : T.muted }}>{r.count}</span>
        </button>
      ))}
    </div>
  )
}

export function ReactionPicker({ onPick, customEmojis, onClose }: {
  onPick: (e: string) => void
  customEmojis?: EmojiView[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])
  return (
    <div ref={ref} style={{
      position: 'absolute', bottom: '100%', right: 0, marginBottom: 6, zIndex: 40,
      background: T.sidebar, border: `1px solid ${T.border}`, borderRadius: 8, padding: 10,
      boxShadow: '0 8px 24px rgba(0,0,0,.45)', width: 250,
    }}>
      {customEmojis && customEmojis.length > 0 && (
        <>
          <div style={pickerHead}>{customEmojis[0].community_id ? 'Emojis do servidor' : ''}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
            {customEmojis.map((e) => (
              <button key={e.id} onClick={() => { onPick(e.char); onClose() }} title={`:${e.name}:`}
                style={{ background: T.input, border: 'none', borderRadius: 6, fontSize: 17, cursor: 'pointer', width: 28, height: 28 }}>{e.char}</button>
            ))}
          </div>
        </>
      )}
      <div style={pickerHead}>Reações rápidas</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {QUICK_REACTIONS.map((e) => (
          <button key={e} onClick={() => { onPick(e); onClose() }}
            style={{ background: T.input, border: 'none', borderRadius: 6, fontSize: 17, cursor: 'pointer', width: 28, height: 28 }}>{e}</button>
        ))}
      </div>
      <div style={{ ...pickerHead, marginTop: 10 }}>Unicode</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {Object.values(EMOJI_SHORT).map((e) => (
          <button key={e} onClick={() => { onPick(e); onClose() }}
            style={{ background: T.input, border: 'none', borderRadius: 6, fontSize: 17, cursor: 'pointer', width: 28, height: 28 }}>{e}</button>
        ))}
      </div>
    </div>
  )
}
const pickerHead: React.CSSProperties = { fontSize: 10, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }

// ============================== MODAL ==============================

export function Modal({ title, onClose, children, width = 520, footer }: {
  title: string
  onClose: () => void
  children: React.ReactNode
  width?: number
  footer?: React.ReactNode
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.7)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: T.main, border: `1px solid ${T.border}`, borderRadius: 12, width: '100%', maxWidth: width, maxHeight: '86vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${T.border}`, position: 'sticky', top: 0, background: T.main, zIndex: 1 }}>
          <div style={{ fontSize: 17, fontWeight: 900, color: T.heading }}>{title}</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.muted, fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: 20 }}>{children}</div>
        {footer && <div style={{ padding: '12px 20px 20px', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>{footer}</div>}
      </div>
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: T.muted, marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

export const inputStyle: React.CSSProperties = {
  width: '100%', background: T.input, border: `1px solid ${T.border}`, borderRadius: 6,
  padding: '9px 11px', color: T.text, fontSize: 13, outline: 'none', fontFamily: 'inherit',
}

export const btnPrimary: React.CSSProperties = {
  background: T.accent, color: '#fff', border: 'none', padding: '9px 18px',
  borderRadius: 6, cursor: 'pointer', fontWeight: 800, fontSize: 13,
}
export const btnGhost: React.CSSProperties = {
  background: T.input, color: T.text, border: `1px solid ${T.border}`,
  padding: '9px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 13,
}
export const btnDanger: React.CSSProperties = {
  background: 'transparent', color: '#ff9c9c', border: `1px solid ${T.red}`,
  padding: '8px 14px', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 13,
}

// ============================== PERFIL ==============================

export function ProfileModal({ fp, nickname, myFp, onClose, onMessage, communityId, communityName, onRenamed }: {
  fp: string
  nickname: string
  myFp: string
  onClose: () => void
  onMessage?: (fp: string) => void
  /** Se informado, habilita o apelido por servidor (Discord #165). */
  communityId?: string
  communityName?: string
  onRenamed?: () => void
}) {
  const [profile, setProfile] = useState<ProfileView | null>(null)
  const [presence, setPresence] = useState<PresenceView | null>(null)
  const isMe = fp === myFp
  const [editing, setEditing] = useState(isMe)
  const [displayName, setDisplayName] = useState('')
  const [about, setAbout] = useState('')
  const [accent, setAccent] = useState('#5865f2')
  const [avatar, setAvatar] = useState('')
  const [banner, setBanner] = useState('')
  const [status, setStatus] = useState<PresenceStatus>('online')
  const [custom, setCustom] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  // apelido por servidor: como EU apareço naquele servidor, separado do
  // display_name global. O motor valida a permissão antes de gravar.
  const canNick = !!communityId && isMe
  const [nick, setNick] = useState(nickname)
  const [nickBusy, setNickBusy] = useState(false)

  // carrega o apelido REAL daquele servidor (o `nickname` recebido é o do
  // objeto da comunidade, que pode ser de outro servidor em DM).
  useEffect(() => {
    if (!communityId) return
    let alive = true
    services.nicknameGet(communityId, fp)
      .then(n => { if (alive && n) setNick(n) })
      .catch(() => { /* sem apelido próprio: mantém o herdado */ })
    return () => { alive = false }
  }, [communityId, fp])

  useEffect(() => {
    let alive = true
    Promise.all([services.profileGet(fp), services.presenceGet(fp)])
      .then(([p, pr]) => {
        if (!alive) return
        setProfile(p); setPresence(pr)
        setDisplayName(p.display_name || nickname)
        setAbout(p.about)
        setAccent(p.accent || '#5865f2')
        setAvatar(p.avatar_b64); setBanner(p.banner_b64)
        setStatus(pr.status === 'offline' ? 'online' : pr.status)
        setCustom(pr.custom)
      })
      .catch(() => { if (alive) setProfile({ fp, display_name: nickname, about: '', avatar_b64: '', banner_b64: '', accent: '', updated_at: 0 }) })
    return () => { alive = false }
  }, [fp, nickname])

  const readImage = (f: File, max: number): Promise<string> => new Promise((res, rej) => {
    if (f.size > max) { rej(new Error('imagem grande demais')); return }
    const r = new FileReader()
    r.onload = () => { const s = String(r.result); res(s.slice(s.indexOf(',') + 1)) }
    r.onerror = () => rej(new Error('falha ao ler imagem'))
    r.readAsDataURL(f)
  })

  async function save() {
    setBusy(true); setErr(null)
    try {
      const p = await services.profileSet({ display_name: displayName, about, avatar_b64: avatar, banner_b64: banner, accent })
      setProfile(p)
      await services.presenceSet(status, custom, '')
      setEditing(false)
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  const name = profile?.display_name || nickname || fp
  return (
    <Modal title={isMe ? 'Meu perfil' : 'Perfil'} onClose={onClose} width={560}>
      {banner && (
        <div style={{ margin: '-20px -20px 0', height: 130, backgroundImage: `url(data:image/png;base64,${banner})`, backgroundSize: 'cover', backgroundPosition: 'center' }} />
      )}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', marginTop: banner ? -34 : 0, marginBottom: 16, position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <Avatar name={name} fp={fp} size={80} avatarB64={profile?.avatar_b64} ring={profile?.accent || T.accent} />
          {presence && (
            <span style={{ position: 'absolute', bottom: 2, right: 2 }}>
              <PresenceDot status={presence.status} size={20} ring={T.main} />
            </span>
          )}
        </div>
        <div style={{ flex: 1, paddingBottom: 6 }}>
          <div style={{ fontSize: 20, fontWeight: 900, color: T.heading }}>{name}</div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: 'JetBrains Mono' }}>{fp}</div>
          <div style={{ fontSize: 12, color: PRESENCE_COLOR[presence?.status ?? 'offline'], marginTop: 4 }}>
            {PRESENCE_LABEL[presence?.status ?? 'offline']}{presence?.custom ? ` — ${presence.custom}` : ''}
          </div>
        </div>
        {!isMe && onMessage && (
          <button onClick={() => { onMessage(fp); onClose() }} style={{ ...btnPrimary, marginBottom: 6 }}>Mensagem</button>
        )}
      </div>

      {profile?.about && <div style={{ fontSize: 13, color: T.text, whiteSpace: 'pre-wrap', marginBottom: 16, background: T.input, borderRadius: 8, padding: '10px 12px' }}>{profile.about}</div>}

      {editing && isMe ? (
        <>
          <Field label="Nome de exibição">
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} maxLength={48} />
          </Field>
          <Field label="Sobre mim" hint="Máx 400 caracteres">
            <textarea value={about} onChange={e => setAbout(e.target.value)} style={{ ...inputStyle, minHeight: 70, resize: 'vertical' }} maxLength={400} />
          </Field>
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Avatar">
              <input type="file" accept="image/*" onChange={async e => { try { setAvatar(await readImage(e.target.files![0], 400_000)) } catch (err: any) { setErr(String(err.message)) } }}
                style={{ fontSize: 11, color: T.muted, width: '100%' }} />
            </Field>
            <Field label="Banner">
              <input type="file" accept="image/*" onChange={async e => { try { setBanner(await readImage(e.target.files![0], 900_000)) } catch (err: any) { setErr(String(err.message)) } }}
                style={{ fontSize: 11, color: T.muted, width: '100%' }} />
            </Field>
          </div>
          <Field label="Cor de destaque">
            <input type="color" value={accent} onChange={e => setAccent(e.target.value)} style={{ width: 54, height: 30, background: T.input, border: `1px solid ${T.border}`, borderRadius: 6 }} />
          </Field>
          <Field label="Status">
            <StatusPicker value={status} onChange={setStatus} />
          </Field>
          <Field label="Status personalizado" hint="O que você está fazendo? (até 128 caracteres)">
            <input value={custom} onChange={e => setCustom(e.target.value)} style={inputStyle} maxLength={128} placeholder="ex.: estudando Rust 🦀" />
          </Field>
          {err && <div style={{ color: '#ff9c9c', fontSize: 12, marginBottom: 10 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={btnGhost}>Cancelar</button>
            <button onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>{busy ? 'Salvando…' : 'Salvar perfil'}</button>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: T.muted, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <span>Identidade ed25519</span><span>·</span><span>Cifrada fim-a-fim</span><span>·</span><span>Sem servidor</span>
          {isMe && <button onClick={() => setEditing(true)} style={{ ...btnGhost, marginLeft: 'auto', padding: '6px 12px' }}>Editar perfil</button>}
        </div>
      )}

      {/* Apelido por servidor — só faz sentido dentro de um servidor, e é
          separado do display_name: é o nome que o DONO daquele servidor vê. */}
      {communityId && (
        <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 16, paddingTop: 14 }}>
          <Field
            label={`Apelido neste servidor${communityName ? ` — ${communityName}` : ''}`}
            hint="Como você aparece aqui. Não altera seu perfil global."
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={nick}
                onChange={e => setNick(e.target.value)}
                disabled={!canNick}
                maxLength={32}
                placeholder={canNick ? 'apelido…' : 'sem permissão para renomear'}
                style={{ ...inputStyle, flex: 1, opacity: canNick ? 1 : 0.5 }}
              />
              <button
                onClick={async () => {
                  if (!canNick || !nick.trim()) return
                  setNickBusy(true); setErr(null)
                  try {
                    await services.nicknameSet(communityId, fp, nick.trim())
                    onRenamed?.()
                  } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setNickBusy(false) }
                }}
                disabled={!canNick || nickBusy}
                style={{ ...btnPrimary, opacity: canNick && !nickBusy ? 1 : 0.5 }}
              >{nickBusy ? '…' : 'Salvar'}</button>
            </div>
          </Field>
        </div>
      )}
    </Modal>
  )
}

// ============================== BUSCA ==============================

export function SearchPanel({ convId, convLabel, profiles, onClose, onJump }: {
  convId: string
  convLabel: string
  profiles: Record<string, ProfileView>
  onClose: () => void
  onJump: (hit: SearchHit) => void
}) {
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [has, setHas] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [busy, setBusy] = useState(false)

  async function run() {
    setBusy(true)
    try {
      const r = await services.searchMessages({ text: q, from, conv: '', has, before: 0, limit: 50 })
      setHits(r)
    } catch { setHits([]) } finally { setBusy(false) }
  }
  useEffect(() => { const t = setTimeout(run, 220); return () => clearTimeout(t) }, [q, from, has])

  return (
    <div style={{
      background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, margin: '0 16px 10px',
      display: 'flex', flexDirection: 'column', maxHeight: 380, boxShadow: '0 8px 24px rgba(0,0,0,.35)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 13, color: T.muted }}>🔍</span>
        <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder={`Buscar em ${convLabel}… (digite from:uuid, has:link)`}
          style={{ flex: 1, background: T.input, border: `1px solid ${T.border}`, borderRadius: 6, padding: '7px 10px', color: T.text, fontSize: 13, outline: 'none' }} />
        <select value={has} onChange={e => setHas(e.target.value)} style={{ background: T.input, color: T.muted, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 8px', fontSize: 11 }}>
          <option value="">tudo</option>
          <option value="link">links</option>
          <option value="file">arquivos</option>
          <option value="mention">menções</option>
        </select>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      <input value={from} onChange={e => setFrom(e.target.value)} placeholder="from: (fingerprint do autor)"
        style={{ margin: '8px 10px 0', background: T.input, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', color: T.text, fontSize: 11, outline: 'none', fontFamily: 'JetBrains Mono' }} />
      <div style={{ overflowY: 'auto', padding: 8 }}>
        {busy && <div style={{ fontSize: 11, color: T.muted, padding: 6 }}>buscando…</div>}
        {!busy && hits.length === 0 && <div style={{ fontSize: 12, color: T.muted, padding: 10, textAlign: 'center' }}>nada encontrado</div>}
        {hits.map((h) => (
          <button key={h.id} onClick={() => onJump(h)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 6, padding: '7px 9px', cursor: 'pointer' }}
            onMouseEnter={e => (e.currentTarget.style.background = T.input)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
            <div style={{ fontSize: 10, color: T.muted, display: 'flex', gap: 8 }}>
              <span style={{ fontWeight: 800, color: T.heading }}>{displayNameOf(h.author_fp, profiles[h.author_fp]?.display_name, profiles)}</span>
              <span>{fmtDay(h.ts)} {fmtClock(h.ts)}</span>
              {h.conv_id !== convId && <span style={{ color: T.yellow }}>· outra conversa</span>}
            </div>
            <div style={{ fontSize: 12.5, color: T.text, marginTop: 2 }}><RichText body={h.body} highlight={q} /></div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ============================== FIXADOS ==============================

export function PinsPanel({ convId, messages, onClose, onJump }: {
  convId: string
  messages: StoredMessage[]
  onClose: () => void
  onJump: (m: StoredMessage) => void
}) {
  const [pins, setPins] = useState<MsgMetaView[]>([])
  useEffect(() => { services.pins(convId).then(setPins).catch(() => setPins([])) }, [convId, messages.length])
  const byId = useMemo(() => new Map(messages.map(m => [m.id, m])), [messages])
  const bodies = pins.map(p => byId.get(p.msg_id)?.body ?? p.edited_body).filter(Boolean)
  if (pins.length === 0) {
    return (
      <div style={{ background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, margin: '0 16px 10px', padding: 14 }}>
        <div style={{ fontSize: 12, color: T.muted }}>📌 Nenhuma mensagem fixada ainda — passe o mouse e use 📌 no menu da mensagem.</div>
        <button onClick={onClose} style={{ ...btnGhost, marginTop: 8, padding: '5px 10px' }}>Fechar</button>
      </div>
    )
  }
  return (
    <div style={{ background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, margin: '0 16px 10px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 900, color: T.heading }}>📌 Mensagens fixadas ({pins.length})</div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {pins.map((p, i) => (
          <button key={p.msg_id} onClick={() => { const m = byId.get(p.msg_id); if (m) onJump(m) }}
            style={{ display: 'block', width: '100%', textAlign: 'left', background: i % 2 ? T.sidebar : 'transparent', border: 'none', borderLeft: `3px solid ${T.accent}`, padding: '9px 12px', cursor: 'pointer' }}>
            <div style={{ fontSize: 10, color: T.muted }}>fixado por {p.pinned_by.slice(0, 8)} · {fmtClock(p.pinned_at || p.edited_at)}</div>
            <div style={{ fontSize: 12.5, color: T.text, marginTop: 2 }}><RichText body={bodies[i] ?? ''} /></div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ============================== ENQUETE ==============================

export function PollCard({ poll, tally, onVote, communityId, channelId }: {
  poll: PollView
  tally: PollTally
  onVote: (idx: number) => void
  communityId: string
  channelId: string
}) {
  void communityId; void channelId
  const total = Math.max(1, tally.total)
  return (
    <div style={{ background: T.sidebar, border: `1px solid ${T.border}`, borderRadius: 10, padding: 12, margin: '6px 0', maxWidth: 420 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: T.heading, marginBottom: 8 }}>{poll.question}</div>
      {poll.options.map((opt, i) => {
        const c = tally.counts[i] ?? 0
        const pct = Math.round((c / total) * 100)
        const mine = tally.mine.includes(i)
        return (
          <button key={i} onClick={() => onVote(i)} style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 6, position: 'relative', cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}>
            <div style={{ position: 'relative', background: T.input, borderRadius: 6, overflow: 'hidden', border: `1px solid ${mine ? T.accent : T.border}` }}>
              <div style={{ position: 'absolute', inset: 0, width: `${pct}%`, background: mine ? 'rgba(88,101,242,.35)' : 'rgba(255,255,255,.07)', transition: 'width .3s' }} />
              <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', padding: '7px 10px', fontSize: 12.5 }}>
                <span style={{ color: mine ? '#c9cdfb' : T.text, fontWeight: mine ? 800 : 500 }}>{mine ? '✓ ' : ''}{opt}</span>
                <span style={{ color: T.muted, fontFamily: 'JetBrains Mono' }}>{pct}%</span>
              </div>
            </div>
          </button>
        )
      })}
      <div style={{ fontSize: 10.5, color: T.muted, marginTop: 4 }}>
        {tally.total} voto{tally.total === 1 ? '' : 's'} · {poll.multi ? 'múltipla escolha' : 'escolha única'}
        {poll.ends_at > 0 && ` · encerra ${fmtDay(poll.ends_at)} ${fmtClock(poll.ends_at)}`}
      </div>
    </div>
  )
}

// ============================== THREADS ==============================

export function ThreadList({ communityId, parentChannel, channels, onOpen, onCreate }: {
  communityId: string
  parentChannel: string
  channels: ChannelMeta[]
  onOpen: (t: ThreadView) => void
  onCreate: (name: string) => void
}) {
  const [threads, setThreads] = useState<ThreadView[]>([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    services.threadList(communityId, parentChannel).then(setThreads).catch(() => setThreads([]))
  }, [communityId, parentChannel])
  const parent = channels.find(c => c.id === parentChannel)
  if (parent?.kind === 'forum' && threads.length === 0 && !open) {
    return (
      <div style={{ padding: '4px 8px' }}>
        <button onClick={() => setOpen(true)} className="chan-row" style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', color: T.muted, fontSize: 12, fontWeight: 700 }}>
          <span style={{ opacity: 0.7 }}>📝</span> Criar post no fórum
        </button>
      </div>
    )
  }
  return (
    <div style={{ padding: '2px 0 6px' }}>
      {threads.map(t => (
        <button key={t.id} onClick={() => onOpen(t)} className="chan-row" style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer' }}>
          <span style={{ opacity: 0.7, fontSize: 11 }}>#</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>{t.name}</span>
        </button>
      ))}
      <button onClick={() => setOpen(o => !o)} className="chan-row" style={{ width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', color: T.muted }}>
        <span style={{ opacity: 0.7 }}>＋</span> Nova thread
      </button>
      {open && (
        <div style={{ display: 'flex', gap: 4, padding: '4px 8px' }}>
          <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="nome da thread"
            style={{ flex: 1, background: T.input, border: `1px solid ${T.border}`, borderRadius: 5, padding: '5px 8px', color: T.text, fontSize: 11, outline: 'none' }} />
          <button onClick={async () => {
            if (!name.trim()) return
            setBusy(true)
            try { const t = await services.threadCreate(communityId, parentChannel, name.trim(), parent?.kind === 'forum' ? 'forum' : 'thread'); onOpen(t) } finally { setBusy(false) }
          }} disabled={busy} style={{ background: T.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '5px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Criar</button>
        </div>
      )}
    </div>
  )
}

export function ThreadViewModal({ communityId, thread, onClose, authorName }: {
  communityId: string
  thread: ThreadView
  onClose: () => void
  authorName: (fp: string) => string
}) {
  const [msgs, setMsgs] = useState<StoredMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { services.threadMessages(thread.id, 100).then(setMsgs).catch(() => setMsgs([])) }, [thread.id, msgs.length])
  async function send() {
    const body = input.trim()
    if (!body) return
    setBusy(true)
    try { const m = await services.threadSend(communityId, thread.id, body); setMsgs(a => [...a, m]); setInput('') } catch { /* erroshown no composer */ } finally { setBusy(false) }
  }
  return (
    <Modal title={`# ${thread.name}`} onClose={onClose} width={620}>
      <div style={{ fontSize: 11, color: T.muted, marginBottom: 12 }}>
        thread criada por {authorName(thread.author_fp)} · em #{thread.parent_channel}
        {thread.kind === 'forum' && ' · post de fórum'}
      </div>
      <div style={{ maxHeight: 380, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
        {msgs.length === 0 && <div style={{ fontSize: 12, color: T.muted, textAlign: 'center', padding: 20 }}>sem mensagens ainda</div>}
        {msgs.map(m => (
          <div key={m.id} style={{ display: 'flex', gap: 10 }}>
            <Avatar name={authorName(m.author_fp)} fp={m.author_fp} size={32} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, color: T.muted }}>{authorName(m.author_fp)} · {fmtClock(m.ts)}</div>
              <div style={{ fontSize: 13.5, color: T.text, marginTop: 2 }}><RichText body={m.body} /></div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={`Mensar em ${thread.name}`} style={{ ...inputStyle, flex: 1 }} />
        <button onClick={send} disabled={busy || !input.trim()} style={{ ...btnPrimary, opacity: busy || !input.trim() ? 0.6 : 1 }}>Enviar</button>
      </div>
    </Modal>
  )
}

// ============================== MODERAÇÃO ==============================

export function ModerationPanel({ communityId, members, isOwner, onClose, onToast }: {
  communityId: string
  members: [string, string, string][]
  isOwner: boolean
  onClose: () => void
  onToast: (s: string) => void
}) {
  const [bans, setBans] = useState<BanView[]>([])
  const [timeouts, setTimeouts] = useState<BanView[]>([])
  const [tab, setTab] = useState<'membros' | 'banidos' | 'silenciados'>('membros')
  const [target, setTarget] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [dur, setDur] = useState(60)

  const reload = () => {
    services.banList(communityId).then(setBans).catch(() => setBans([]))
    services.timeoutList(communityId).then(setTimeouts).catch(() => setTimeouts([]))
  }
  useEffect(reload, [communityId])

  async function act(kind: 'ban' | 'timeout' | 'kick') {
    if (!target) return
    try {
      if (kind === 'kick') {
        await services.moderate(communityId, 'ban', target, reason || 'expulso')
        onToast(`${target.slice(0, 8)} expulso`)
      } else if (kind === 'ban') {
        await services.ban(communityId, target, 0, reason)
        onToast(`${target.slice(0, 8)} banido`)
      } else {
        await services.timeout(communityId, target, Date.now() + dur * 60_000, reason)
        onToast(`${target.slice(0, 8)} silenciado por ${dur} min`)
      }
      setTarget(null); setReason(''); reload()
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  if (!isOwner) {
    return <Modal title="Moderação" onClose={onClose}><div style={{ fontSize: 13, color: T.muted }}>Apenas o dono do servidor pode banir/silenciar.</div></Modal>
  }
  return (
    <Modal title="Moderação do servidor" onClose={onClose} width={640}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {(['membros', 'banidos', 'silenciados'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...btnGhost, padding: '6px 12px', background: tab === t ? T.accent : T.input, color: tab === t ? '#fff' : T.muted, border: 'none' }}>{t}</button>
        ))}
      </div>
      {tab === 'membros' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {members.map(([fp, nick]) => (
            <div key={fp} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 9px', background: T.input, borderRadius: 7 }}>
              <Avatar name={nick || fp} fp={fp} size={28} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: T.heading }}>{nick || fp.slice(0, 12)}</div>
                <div style={{ fontSize: 10, color: T.muted, fontFamily: 'JetBrains Mono' }}>{fp.slice(0, 16)}</div>
              </div>
              <button onClick={() => { setTarget(fp); setReason('') }} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>Moderar</button>
            </div>
          ))}
        </div>
      )}
      {tab === 'banidos' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {bans.length === 0 && <div style={{ fontSize: 12, color: T.muted, textAlign: 'center', padding: 16 }}>ninguém banido</div>}
          {bans.map(b => (
            <div key={b.fp} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 9px', background: T.input, borderRadius: 7 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, color: T.text, fontFamily: 'JetBrains Mono' }}>{b.fp.slice(0, 16)}</div>
                <div style={{ fontSize: 10, color: T.muted }}>{b.reason || 'sem motivo'} · {b.until_ms > 0 ? `até ${fmtDay(b.until_ms)}` : 'permanente'}</div>
              </div>
              <button onClick={async () => { await services.unban(communityId, b.fp); reload() }} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>Desbanir</button>
            </div>
          ))}
        </div>
      )}
      {tab === 'silenciados' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {timeouts.length === 0 && <div style={{ fontSize: 12, color: T.muted, textAlign: 'center', padding: 16 }}>ninguém silenciado</div>}
          {timeouts.map(b => (
            <div key={b.fp} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '7px 9px', background: T.input, borderRadius: 7 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12.5, color: T.text, fontFamily: 'JetBrains Mono' }}>{b.fp.slice(0, 16)}</div>
                <div style={{ fontSize: 10, color: T.muted }}>até {fmtClock(b.until_ms)} · {b.reason || 'sem motivo'}</div>
              </div>
              <button onClick={async () => { await services.timeout(communityId, b.fp, 0, ''); reload() }} style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>Remover</button>
            </div>
          ))}
        </div>
      )}
      {target && (
        <div style={{ marginTop: 14, padding: 12, background: T.input, borderRadius: 8, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 12, color: T.heading, marginBottom: 8 }}>Moderar {target.slice(0, 12)}</div>
          <input value={reason} onChange={e => setReason(e.target.value)} placeholder="motivo" style={{ ...inputStyle, marginBottom: 8 }} />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 }}>
            <span style={{ fontSize: 11, color: T.muted }}>silenciar por</span>
            <select value={dur} onChange={e => setDur(Number(e.target.value))} style={{ background: T.input, color: T.text, border: `1px solid ${T.border}`, borderRadius: 5, padding: '4px 6px', fontSize: 11 }}>
              {[1, 5, 10, 60, 360, 1440].map(m => <option key={m} value={m}>{m < 60 ? `${m} min` : `${m / 60} h`}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={() => act('timeout')} style={{ ...btnGhost, fontSize: 11, padding: '6px 10px' }}>⏱ Silenciar</button>
            <button onClick={() => act('kick')} style={{ ...btnGhost, fontSize: 11, padding: '6px 10px' }}>👢 Expulsar</button>
            <button onClick={() => act('ban')} style={{ ...btnDanger, fontSize: 11, padding: '6px 10px' }}>🔨 Banir</button>
            <button onClick={() => setTarget(null)} style={{ ...btnGhost, fontSize: 11, padding: '6px 10px' }}>Cancelar</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ============================== EVENTOS ==============================

export function EventPanel({ communityId, channels, onClose, onToast }: {
  communityId: string
  channels: ChannelMeta[]
  onClose: () => void
  onToast: (s: string) => void
}) {
  const [events, setEvents] = useState<EventView[]>([])
  const [name, setName] = useState('')
  const [where, setWhere] = useState('')
  const [desc, setDesc] = useState('')
  const [inHours, setInHours] = useState(24)
  const [channelId, setChannelId] = useState('')
  useEffect(() => { services.eventList(communityId).then(setEvents).catch(() => setEvents([])) }, [communityId])

  async function create() {
    if (!name.trim()) return
    try {
      await services.eventUpsert({
        id: `ev-${Date.now().toString(36)}`, community_id: communityId, name: name.trim(),
        description: desc, location: where || 'aqui', starts_at: Date.now() + inHours * 3600_000,
        ends_at: Date.now() + (inHours + 2) * 3600_000, channel_id: channelId, entity_fp: '',
        status: 'scheduled', interested: [],
      })
      setName(''); setDesc(''); setWhere('')
      services.eventList(communityId).then(setEvents)
      onToast('evento agendado')
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  return (
    <Modal title="Eventos agendados" onClose={onClose} width={560}>
      <div style={{ background: T.input, borderRadius: 8, padding: 12, marginBottom: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: T.muted, textTransform: 'uppercase', marginBottom: 8 }}>Novo evento</div>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="nome do evento" style={{ ...inputStyle, marginBottom: 6 }} />
        <input value={where} onChange={e => setWhere(e.target.value)} placeholder="onde (link, sala, local)" style={{ ...inputStyle, marginBottom: 6 }} />
        <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="descrição" style={{ ...inputStyle, minHeight: 50, marginBottom: 6, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 6 }}>
          <select value={inHours} onChange={e => setInHours(Number(e.target.value))} style={{ background: T.input, color: T.text, border: `1px solid ${T.border}`, borderRadius: 5, padding: '6px 8px', fontSize: 11 }}>
            {[1, 2, 6, 24, 72, 168].map(h => <option key={h} value={h}>em {h < 24 ? `${h}h` : `${h / 24}d`}</option>)}
          </select>
          <select value={channelId} onChange={e => setChannelId(e.target.value)} style={{ flex: 1, background: T.input, color: T.text, border: `1px solid ${T.border}`, borderRadius: 5, padding: '6px 8px', fontSize: 11 }}>
            <option value="">sem canal</option>
            {channels.filter(c => c.kind === 'voice').map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
          <button onClick={create} style={{ ...btnPrimary, padding: '7px 14px', fontSize: 12 }}>Criar</button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {events.length === 0 && <div style={{ fontSize: 12, color: T.muted, textAlign: 'center', padding: 12 }}>nenhum evento agendado</div>}
        {events.map(e => (
          <div key={e.id} style={{ background: T.sidebar, border: `1px solid ${T.border}`, borderLeft: `3px solid ${T.pink}`, borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: T.heading }}>{e.name}</div>
              <span style={{ fontSize: 10, color: T.pink, fontWeight: 800, textTransform: 'uppercase' }}>{e.status}</span>
            </div>
            <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>
              {fmtDay(e.starts_at)} {fmtClock(e.starts_at)} · {e.location} · {e.interested.length} interessado(s)
            </div>
            {e.description && <div style={{ fontSize: 12, color: T.text, marginTop: 5 }}>{e.description}</div>}
            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={async () => { await services.eventInterest(communityId, e.id); services.eventList(communityId).then(setEvents) }}
                style={{ ...btnGhost, padding: '5px 10px', fontSize: 11 }}>{e.interested.length > 0 ? 'Tenho interesse' : 'Interesse'}</button>
              <button onClick={async () => { await services.eventDelete(communityId, e.id); services.eventList(communityId).then(setEvents) }}
                style={{ ...btnDanger, padding: '5px 10px', fontSize: 11 }}>Excluir</button>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}

// ============================== SLOWMODE / EMOJI ==============================

export function ChannelSettingsModal({ communityId, channel, isOwner, onClose, onToast }: {
  communityId: string
  channel: ChannelMeta
  isOwner: boolean
  onClose: () => void
  onToast: (s: string) => void
}) {
  const [slow, setSlow] = useState(0)
  const [nsfw, setNsfw] = useState(false)
  const [emojiName, setEmojiName] = useState('')
  const [emojiChar, setEmojiChar] = useState('')
  const [emojis, setEmojis] = useState<EmojiView[]>([])

  useEffect(() => {
    services.channelCfgGet(channel.id).then(setSlow).catch(() => setSlow(0))
    services.emojiList(communityId).then(setEmojis).catch(() => setEmojis([]))
  }, [channel.id, communityId])

  return (
    <Modal title={`Configurar #${channel.name}`} onClose={onClose} width={480}>
      {!isOwner && <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>Você não é o dono — as opções serão recusadas pelo motor.</div>}
      <Field label="Slowmode (segundos entre mensagens)" hint="0 = desativado. Moderadores são isentos.">
        <select value={slow} onChange={e => setSlow(Number(e.target.value))} style={inputStyle}>
          {[0, 3, 5, 10, 30, 60, 300, 1800, 3600].map(s => <option key={s} value={s}>{s === 0 ? 'desativado' : `${s}s`}</option>)}
        </select>
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12.5, color: T.text, marginBottom: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={nsfw} onChange={e => setNsfw(e.target.checked)} /> Canal NSFW
      </label>
      <button onClick={async () => {
        try { await services.channelCfgSet(communityId, channel.id, slow, nsfw); onToast('canal atualizado') } catch (e: any) { onToast(String(e?.message ?? e)) }
      }} style={btnPrimary}>Salvar canal</button>

      <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
        <div style={pickerHead}>Emojis do servidor</div>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <input value={emojiChar} onChange={e => setEmojiChar(e.target.value)} placeholder="😀" style={{ ...inputStyle, width: 70 }} maxLength={4} />
          <input value={emojiName} onChange={e => setEmojiName(e.target.value)} placeholder="nome" style={{ ...inputStyle, flex: 1 }} maxLength={32} />
          <button onClick={async () => {
            if (!emojiName.trim() || !emojiChar.trim()) return
            try {
              await services.emojiUpsert({ id: `em-${Date.now().toString(36)}`, community_id: communityId, name: emojiName.trim(), char: emojiChar.trim(), created_at: Date.now() })
              setEmojiName(''); setEmojiChar('')
              services.emojiList(communityId).then(setEmojis)
            } catch (e: any) { onToast(String(e?.message ?? e)) }
          }} style={{ ...btnPrimary, padding: '8px 12px', fontSize: 12 }}>Adicionar</button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {emojis.map(e => (
            <span key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: T.input, borderRadius: 6, padding: '3px 7px', fontSize: 11 }}>
              <span style={{ fontSize: 15 }}>{e.char}</span>
              <span style={{ color: T.muted }}>:{e.name}:</span>
              <button onClick={async () => { await services.emojiDelete(communityId, e.id); services.emojiList(communityId).then(setEmojis) }}
                style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 12 }}>×</button>
            </span>
          ))}
        </div>
      </div>
    </Modal>
  )
}

// ============================== ATALHOS ==============================

export const SHORTCUTS: [string, string][] = [
  ['Ctrl + K', 'Paleta de comandos'],
  ['Ctrl + F', 'Buscar mensagens'],
  ['Ctrl + Shift + P', 'Mensagens fixadas'],
  ['Ctrl + Shift + M', 'Mute/desmute'],
  ['Alt + ↑ / ↓', 'Navegar conversas'],
  ['Esc', 'Fechar painel'],
  ['Enter', 'Enviar mensagem'],
  ['Shift + Enter', 'Quebra de linha'],
]

/** Hook de atalhos globais (ignora campos de texto). */
export function useShortcuts(handlers: Record<string, (e: KeyboardEvent) => void>) {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      const key = e.ctrlKey || e.metaKey
      if (key && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current.cmdk?.(e); return }
      if (key && !e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); ref.current.search?.(e); return }
      if (key && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); ref.current.pins?.(e); return }
      if (key && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); ref.current.mute?.(e); return }
      if (!typing && e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); (e.key === 'ArrowDown' ? ref.current.next : ref.current.prev)?.(e) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

// ============================== PALETA DE COMANDOS ==============================

export interface Command {
  id: string
  label: string
  hint?: string
  group: string
  run: () => void
}

export function CommandPalette({ commands, onClose }: { commands: Command[]; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const list = useMemo(() => {
    const n = q.trim().toLowerCase()
    const filtered = n ? commands.filter(c => c.label.toLowerCase().includes(n) || c.group.toLowerCase().includes(n)) : commands
    return filtered.slice(0, 40)
  }, [q, commands])

  useEffect(() => { setIdx(0) }, [q])

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 300, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, width: '100%', maxWidth: 560, overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,.6)' }}>
        <div style={{ padding: 14, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: T.muted, fontSize: 15 }}>⌘</span>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, list.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)) }
              if (e.key === 'Enter') { e.preventDefault(); list[idx]?.run(); onClose() }
              if (e.key === 'Escape') onClose()
            }}
            placeholder="Digite um comando ou pesquise…" style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.heading, fontSize: 15 }} />
          <span style={{ fontSize: 10, color: T.muted }}>ESC</span>
        </div>
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          {list.length === 0 && <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: T.muted }}>nenhum comando</div>}
          {list.map((c, i) => (
            <button key={c.id} onMouseEnter={() => setIdx(i)} onClick={() => { c.run(); onClose() }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 14px', background: i === idx ? 'rgba(88,101,242,.22)' : 'transparent', border: 'none', cursor: 'pointer', color: i === idx ? T.heading : T.text }}>
              <span style={{ fontSize: 10, fontWeight: 800, color: T.muted, textTransform: 'uppercase', minWidth: 74 }}>{c.group}</span>
              <span style={{ flex: 1, fontSize: 13 }}>{c.label}</span>
              {c.hint && <span style={{ fontSize: 10, color: T.muted, fontFamily: 'JetBrains Mono' }}>{c.hint}</span>}
            </button>
          ))}
        </div>
        <div style={{ padding: '8px 14px', borderTop: `1px solid ${T.border}`, fontSize: 10, color: T.muted, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {SHORTCUTS.slice(0, 5).map(([k, v]) => <span key={k}><b style={{ color: T.text }}>{k}</b> {v}</span>)}
        </div>
      </div>
    </div>
  )
}

// ============================== DIVISOR DE DATA ==============================

export function DayDivider({ ts }: { ts: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '10px 0 6px' }}>
      <div style={{ flex: 1, height: 1, background: T.border }} />
      <span style={{ fontSize: 10, fontWeight: 800, color: T.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>{fmtDay(ts)}</span>
      <div style={{ flex: 1, height: 1, background: T.border }} />
    </div>
  )
}

export function UnreadDivider({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', background: 'transparent', border: 'none', cursor: 'pointer', margin: '8px 0' }}>
      <span style={{ flex: 1, height: 1, background: T.red }} />
      <span style={{ fontSize: 10, fontWeight: 800, color: T.red, textTransform: 'uppercase' }}>Novas mensagens ↓</span>
      <span style={{ flex: 1, height: 1, background: T.red }} />
    </button>
  )
}

// ============================== BOOKMARKS ==============================

/**
 * Mensagens salvas pelo usuário (`bookmarkSet` no motor). O Discord trata
 * isto como recurso Nitro; aqui é de graça — a chave é a conversa, então o
 * marcador atravessa reinstalação sem servidor.
 */
export function BookmarksPanel({ convId, onClose, onJump, messages }: {
  convId: string
  onClose: () => void
  onJump?: (msgId: string) => void
  messages: StoredMessage[]
}) {
  const [marks, setMarks] = useState<[string, string][]>([])
  const [nonce, setNonce] = useState(0)
  const [name, setName] = useState('')

  useEffect(() => {
    let alive = true
    services.bookmarkList(convId)
      .then(l => { if (alive) setMarks(l ?? []) })
      .catch(() => { if (alive) setMarks([]) })
    return () => { alive = false }
  }, [convId, nonce])

  const body = useMemo(() => {
    const byId = new Map(messages.map(m => [m.id, m]))
    return marks
      .map(([id, payload]) => {
        let msg = byId.get(id)
        if (!msg) {
          // marcador de mensagem que saiu da janela: mostra o que foi salvo
          try { msg = JSON.parse(payload) as StoredMessage } catch { msg = undefined }
        }
        return msg ? { id, msg } : null
      })
      .filter(Boolean) as { id: string; msg: StoredMessage }[]
  }, [marks, messages])

  async function save(msg: StoredMessage) {
    const label = (msg.body || '').slice(0, 60) || `msg-${msg.id.slice(0, 8)}`
    setName(label)
    await services.bookmarkSet(convId, label, JSON.stringify(msg))
    setNonce(n => n + 1)
  }

  return (
    <div style={{
      background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, margin: '0 16px 10px',
      display: 'flex', flexDirection: 'column', maxHeight: 380, boxShadow: '0 8px 24px rgba(0,0,0,.35)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10, borderBottom: `1px solid ${T.border}` }}>
        <span style={{ fontSize: 13, color: T.muted }}>🔖</span>
        <b style={{ flex: 1, fontSize: 13, color: T.heading }}>Mensagens salvas</b>
        <span style={{ fontSize: 10, color: T.muted }}>{marks.length}</span>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: `1px solid ${T.border}` }}>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="nome do marcador"
          style={{ flex: 1, background: T.input, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 10px', color: T.text, fontSize: 11, outline: 'none' }} />
        <button onClick={async () => {
          const last = messages[messages.length - 1]
          if (last) await save(last)
        }} style={{ background: T.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '6px 12px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>Salvar última</button>
      </div>
      <div style={{ overflowY: 'auto', padding: 8 }}>
        {body.length === 0 && <div style={{ fontSize: 12, color: T.muted, padding: 10, textAlign: 'center' }}>nenhuma mensagem salva</div>}
        {body.map(({ id, msg }) => (
          <div key={id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 9px', borderRadius: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 10, color: T.muted }}>{fmtDay(msg.ts)} {fmtClock(msg.ts)} · {msg.author_fp.slice(0, 12)}</div>
              <div style={{ fontSize: 12, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.body}</div>
            </div>
            {onJump && <button onClick={() => onJump(id)} style={{ ...btnGhost, fontSize: 10, padding: '3px 8px' }}>ir</button>}
            <button onClick={async () => { await services.bookmarkSet(convId, '', ''); setNonce(n => n + 1) }}
              style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer' }} title="remover">×</button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ============================== INBOX ==============================

export type InboxTab = 'mentions' | 'unreads' | 'bookmarks'

/**
 * Inbox do Discord: uma aba que junta as três filas que o usuário precisa
 * realmente ver — menções, não-lidas e marcadores. Sem ela o badge de menção
 * é um número morto.
 */
export function InboxPanel({ tab, onTab, profiles, onJump, onClose }: {
  tab: InboxTab
  onTab: (t: InboxTab) => void
  profiles: Record<string, ProfileView>
  onJump: (convId: string, msgId: string) => void
  onClose: () => void
}) {
  const [mentions, setMentions] = useState<SearchHit[]>([])
  const [unreads, setUnreads] = useState<SearchHit[]>([])
  const [mentionCount, setMentionCount] = useState(0)
  const [busy, setBusy] = useState(false)

  const load = useMemo(() => async () => {
    setBusy(true)
    try {
      if (tab === 'mentions') {
        const n = Number(await services.unreadMentions().catch(() => 0)) || 0
        setMentionCount(n)
        setMentions(await services.searchMessages({ text: '', from: '', conv: '', has: 'mention', before: 0, limit: 50 }))
      } else if (tab === 'unreads') {
        setUnreads(await services.searchMessages({ text: '', from: '', conv: '', has: '', before: 0, limit: 50 }))
      } else {
        setUnreads([])
      }
    } catch { /* mantém */ } finally { setBusy(false) }
  }, [tab])

  useEffect(() => { void load() }, [load])

  const list = tab === 'mentions' ? mentions : unreads

  return (
    <div style={{ background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, margin: '0 16px 10px', boxShadow: '0 8px 24px rgba(0,0,0,.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: 8, borderBottom: `1px solid ${T.border}` }}>
        {([['mentions', mentionCount > 0 ? `Menções (${mentionCount})` : 'Menções'], ['unreads', 'Não lidas'], ['bookmarks', 'Salvas']] as [InboxTab, string][]).map(([k, lbl]) => (
          <button key={k} onClick={() => onTab(k)} style={{
            padding: '5px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 800,
            background: tab === k ? T.accent : 'transparent', color: tab === k ? '#fff' : T.muted, border: 'none',
          }}>{lbl}</button>
        ))}
        <span style={{ flex: 1 }} />
        {tab === 'bookmarks' && <span style={{ fontSize: 10, color: T.muted }}>use 🔖 na mensagem</span>}
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', fontSize: 18 }}>×</button>
      </div>
      {tab === 'bookmarks' ? (
        <div style={{ padding: 12, fontSize: 12, color: T.muted, textAlign: 'center' }}>
          Abra uma conversa e use <b style={{ color: T.text }}>🔖 Salvar</b> no menu da mensagem.
        </div>
      ) : (
        <div style={{ maxHeight: 320, overflowY: 'auto', padding: 8 }}>
          {busy && <div style={{ fontSize: 11, color: T.muted, padding: 6 }}>carregando…</div>}
          {!busy && list.length === 0 && (
            <div style={{ fontSize: 12, color: T.muted, padding: 14, textAlign: 'center' }}>
              {tab === 'mentions' ? 'nenhuma menção' : 'tudo lido ✓'}
            </div>
          )}
          {list.map((h) => (
            <button key={h.id} onClick={() => onJump(h.conv_id, h.id)} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none', borderRadius: 6, padding: '7px 9px', cursor: 'pointer' }}
              onMouseEnter={e => (e.currentTarget.style.background = T.input)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
              <div style={{ fontSize: 10, color: T.muted, display: 'flex', gap: 8 }}>
                <span style={{ fontWeight: 800, color: T.heading }}>{displayNameOf(h.author_fp, profiles[h.author_fp]?.display_name, profiles)}</span>
                <span>{fmtDay(h.ts)} {fmtClock(h.ts)}</span>
              </div>
              <div style={{ fontSize: 12, color: T.text, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.body}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
