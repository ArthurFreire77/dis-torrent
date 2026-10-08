// Componentes da CAMADA SOCIAL v3 — paridade Discord.
// Todos consomem `services` (nativo OU browser): a UI não sabe a diferença
// e nunca decide permissão — quem valida é o motor.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { services } from '../../services'
import { Markdown } from '../../shared/markdown'
import { compressAvatar, compressBanner } from '../../shared/avatar'
import { Ic, type IconName } from '../../shared/icons'
import { getNote, setNote } from '../../shared/prefs'

const STATUS_ICONS: { id: string; icon: IconName; label: string }[] = [
  { id: 'game', icon: 'grid', label: 'Jogando' },
  { id: 'code', icon: 'terminal', label: 'Codando' },
  { id: 'music', icon: 'headphones', label: 'Ouvindo música' },
  { id: 'study', icon: 'file', label: 'Estudando' },
  { id: 'live', icon: 'video', label: 'Em chamada' },
  { id: 'chat', icon: 'smile', label: 'Conversando' },
  { id: 'work', icon: 'monitor', label: 'Trabalhando' },
  { id: 'hype', icon: 'sparkle', label: 'Hype' },
]

function statusIconName(id: string): IconName | null {
  return STATUS_ICONS.find(s => s.id === id)?.icon ?? null
}
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
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const toggle = useCallback((key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }, [])
  const q = (highlight ?? '').trim()
  if (q && !/[*_~`>|]/.test(body)) {
    const lower = body.toLowerCase()
    const needle = q.toLowerCase()
    const parts: React.ReactNode[] = []
    let i = 0
    let k = 0
    for (;;) {
      const at = lower.indexOf(needle, i)
      if (at < 0) { parts.push(body.slice(i)); break }
      if (at > i) parts.push(body.slice(i, at))
      parts.push(<mark key={k++}>{body.slice(at, at + q.length)}</mark>)
      i = at + q.length
    }
    return <span style={{ fontSize: 14, lineHeight: 1.375, color: T.text, wordBreak: 'break-word' }}>{parts}</span>
  }
  return (
    <Markdown
      body={body}
      revealedSpoilers={revealed}
      onRevealSpoiler={toggle}
      resolveMention={(token) => {
        const raw = token.trim()
        if (/^everyone$/i.test(raw)) return { kind: 'everyone', label: 'everyone', noteIndex: 0 }
        if (/^here$/i.test(raw)) return { kind: 'here', label: 'here', noteIndex: 0 }
        if (/^[a-f0-9]{8,64}$/i.test(raw)) return { kind: 'user', label: raw.slice(0, 8), fp: raw, noteIndex: 0 }
        return null
      }}
      onMentionClick={(hit) => { if (hit.fp) onMention?.(hit.fp) }}
      resolveEmoji={(name) => EMOJI_SHORT[name.toLowerCase()] ?? null}
      theme={{ text: T.text, link: '#00a8fc' }}
    />
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

/** Nome legível de um reator: recebe um resolvedor (nick/apelido) do shell. */
export type ReactorNameFn = (fp: string) => string

/**
 * Popover "quem reagiu" — o Discord abre a lista ao passar/clicar no chip.
 * Sem isto o contador ficava opaco e o usuário não sabia quem reagiu.
 * `resolve` devolve o nome bonito; cai no fp curto quando não há mapping.
 */
export function ReactionWhoPopover({ r, resolve, onClose }: {
  r: ReactionSummary
  resolve: ReactorNameFn
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])
  const names = r.reactors.map(resolve)
  return (
    <div ref={ref} style={{
      position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60,
      background: T.rail, border: `1px solid ${T.border}`, borderRadius: 8, padding: 8,
      boxShadow: '0 10px 30px rgba(0,0,0,.55)', minWidth: 170, maxWidth: 260,
    }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: .6, color: T.muted, marginBottom: 6, textTransform: 'uppercase' }}>
        {r.emoji} · {r.count} {r.count === 1 ? 'reação' : 'reações'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
        {names.map((n, i) => (
          <div key={r.reactors[i] + i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text }}>
            <span style={{ width: 16, height: 16, borderRadius: '50%', background: T.accent, color: '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {n.slice(0, 1).toUpperCase()}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ReactionBar({ reactions, onToggle, onHoverList, resolveName }: {
  reactions: ReactionSummary[]
  onToggle: (emoji: string) => void
  /** clique simples já alterna; este callback lista quem reagiu (opcional). */
  onHoverList?: (r: ReactionSummary) => void
  /** fp → nome bonito, para o popover "quem reagiu". */
  resolveName?: ReactorNameFn
}) {
  const [who, setWho] = useState<{ emoji: string; r: ReactionSummary } | null>(null)
  if (reactions.length === 0) return null
  const shown = who ? reactions.find(r => r.emoji === who.emoji) ?? null : null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {reactions.map((r) => (
        <div key={r.emoji} style={{ position: 'relative' }}>
          <button
            onClick={() => onToggle(r.emoji)}
            onMouseEnter={() => { setWho({ emoji: r.emoji, r }); onHoverList?.(r) }}
            title={`${r.count} · ${r.reactors.join(', ')}`}
            aria-label={`${r.emoji}, ${r.count} reações. Ver quem reagiu`}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8,
              background: r.mine ? 'rgba(88,101,242,.25)' : T.input,
              border: `1px solid ${r.mine ? T.accent : 'transparent'}`,
              color: T.text, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
            }}>
            <span style={{ fontSize: 15 }}>{r.emoji}</span>
            <span style={{ color: r.mine ? '#c9cdfb' : T.muted }}>{r.count}</span>
          </button>
          {shown && resolveName && (
            <ReactionWhoPopover r={shown} resolve={resolveName} onClose={() => setWho(null)} />
          )}
        </div>
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
      {/* role/aria-modal: leitores de tela anunciam isto como diálogo e o
          conteúdo atrás fica aria-hidden por padrão do papel dialog. */}
      <div role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()} style={{ background: T.main, border: `1px solid ${T.border}`, borderRadius: 12, width: '100%', maxWidth: width, maxHeight: '86vh', overflow: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,.6)' }}>
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

const secHead: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: T.muted, margin: '12px 0 4px' }

export function ProfileNote({ fp }: { fp: string }) {
  const [val, setVal] = useState(() => getNote(fp))
  const [saved, setSaved] = useState(false)
  return (
    <div>
      <div style={secHead}>ANOTAÇÃO · SÓ VOCÊ VÊ</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={val}
          onChange={e => { setVal(e.target.value); setSaved(false) }}
          onBlur={() => { setNote(fp, val); if (val.trim()) setSaved(true) }}
          maxLength={500}
          placeholder="Ex.: conheci no grupo de Rust"
          aria-label="Anotação privada sobre este usuário"
          style={inputStyle}
        />
      </div>
      {saved && <div style={{ fontSize: 11, color: T.green, marginTop: 4 }}>Salva neste aparelho.</div>}
    </div>
  )
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
  communityId?: string
  communityName?: string
  onRenamed?: () => void
}) {
  const [profile, setProfile] = useState<ProfileView | null>(null)
  const [presence, setPresence] = useState<PresenceView | null>(null)
  const isMe = fp === myFp
  const [editing, setEditing] = useState(false)
  const [tab, setTab] = useState<'sobre' | 'servidor' | 'p2p'>('sobre')
  const [displayName, setDisplayName] = useState('')
  const [about, setAbout] = useState('')
  const [accent, setAccent] = useState('#5865f2')
  const [avatar, setAvatar] = useState('')
  const [banner, setBanner] = useState('')
  const [status, setStatus] = useState<PresenceStatus>('online')
  const [custom, setCustom] = useState('')
  const [customEmoji, setCustomEmoji] = useState('')
  const [memberSince, setMemberSince] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const canNick = !!communityId && isMe
  const [nick, setNick] = useState(nickname)
  const [nickBusy, setNickBusy] = useState(false)

  useEffect(() => {
    if (!communityId) return
    let alive = true
    services.nicknameGet(communityId, fp)
      .then(n => { if (alive && n) setNick(n) })
      .catch(() => {})
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
        setCustomEmoji((pr as { custom_emoji?: string }).custom_emoji ?? '')
      })
      .catch(() => { if (alive) setProfile({ fp, display_name: nickname, about: '', avatar_b64: '', banner_b64: '', accent: '', updated_at: 0 }) })
    if (isMe) {
      services.identityGet()
        .then(id => { if (alive && id && typeof id.created_at === 'number' && id.created_at > 0) setMemberSince(id.created_at) })
        .catch(() => {})
    }
    return () => { alive = false }
  }, [fp, nickname])

  const readAvatar = (f: File): Promise<string> => compressAvatar(f)
  const readBanner = (f: File): Promise<string> => compressBanner(f)

  async function save() {
    setBusy(true); setErr(null)
    try {
      const p = await services.profileSet({ display_name: displayName, about, avatar_b64: avatar, banner_b64: banner, accent })
      setProfile(p)
      await services.presenceSet(status, custom, customEmoji)
      setPresence({ fp, status, custom, custom_emoji: customEmoji, updated_at: Date.now() })
      setEditing(false)
    } catch (e: any) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  async function copyFp() {
    try { await navigator.clipboard?.writeText(fp) } catch { /* clipboard indisponível */ }
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  const previewing = editing && isMe
  const name = previewing ? (displayName || nickname || fp) : (profile?.display_name || nickname || fp)
  const shownStatus = previewing ? status : (presence?.status ?? 'offline')
  const shownCustom = previewing ? custom : (presence?.custom ?? '')
  const shownEmoji = previewing ? customEmoji : ((presence as { custom_emoji?: string } | null)?.custom_emoji ?? '')
  const shownAbout = previewing ? about : (profile?.about ?? '')
  const shownAccent = previewing ? accent : (profile?.accent || T.accent)
  const shownAvatar = previewing ? (avatar || profile?.avatar_b64) : profile?.avatar_b64
  const bannerUrl = (previewing ? banner : (profile?.banner_b64 ?? banner))
    ? `url(data:image/jpeg;base64,${previewing ? banner : profile?.banner_b64})`
    : `linear-gradient(135deg, ${shownAccent} 0%, #1e1f22 130%)`
  const tabs = [{ id: 'sobre', label: 'Sobre' }, ...(communityId ? [{ id: 'servidor', label: 'Servidor' }] : []), { id: 'p2p', label: 'P2P' }] as const
  const activeTab = tab === 'servidor' && !communityId ? 'sobre' : tab
  return (
    <Modal title={isMe ? 'Meu perfil' : 'Perfil'} onClose={onClose} width={460}>
      <div style={{ margin: '-20px -20px 0', height: 160, backgroundImage: bannerUrl, backgroundSize: 'cover', backgroundPosition: 'center', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, transparent 40%, rgba(0,0,0,.45))' }} />
        {editing && isMe && (
          <label style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(0,0,0,.65)', color: '#fff', fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 8, cursor: 'pointer' }}>
            Trocar capa
            <input type="file" accept="image/*" aria-label="Escolher banner" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { setErr(null); setBanner(await readBanner(f)) } catch (err: any) { setErr(String(err?.message ?? err)) } }} />
          </label>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginTop: -44, marginBottom: 4, position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <label style={{ display: 'block', cursor: editing && isMe ? 'pointer' : 'default' }} title={editing && isMe ? 'Trocar avatar' : undefined}>
            <span style={{ display: 'block', borderRadius: '50%', border: '6px solid #313338', lineHeight: 0, boxShadow: `0 0 0 2px ${shownAccent}` }}>
              <Avatar name={name} fp={fp} size={88} avatarB64={shownAvatar} />
            </span>
            {editing && isMe && (
              <input type="file" accept="image/*" aria-label="Escolher avatar" hidden onChange={async e => { const f = e.target.files?.[0]; if (!f) return; try { setErr(null); setAvatar(await readAvatar(f)) } catch (err: any) { setErr(String(err?.message ?? err)) } }} />
            )}
          </label>
          <span style={{ position: 'absolute', bottom: 8, right: 8 }}>
            <PresenceDot status={shownStatus} size={22} ring="#313338" />
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: shownAccent, flexShrink: 0 }} />
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: T.muted }}>PERFIL</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: T.heading, lineHeight: 1.15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
          <div style={{ fontSize: 12, color: T.muted }}>@{fp.slice(0, 8)} · {PRESENCE_LABEL[shownStatus]}</div>
        </div>
        {editing && isMe && (
          <input type="color" value={accent} aria-label="Cor de destaque" title="Cor de destaque" onChange={e => setAccent(e.target.value)} style={{ width: 38, height: 30, background: T.input, border: `1px solid ${T.border}`, borderRadius: 8, cursor: 'pointer', flexShrink: 0 }} />
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, background: 'rgba(35,165,89,.15)', color: '#57f287', border: '1px solid rgba(35,165,89,.4)', padding: '3px 8px', borderRadius: 99 }}><Ic name="check" size={12} stroke={2.4} />ed25519 verificada</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, background: T.input, color: PRESENCE_COLOR[shownStatus], border: `1px solid ${T.border}`, padding: '3px 8px', borderRadius: 99 }}>
          {statusIconName(shownEmoji) ? <Ic name={statusIconName(shownEmoji)!} size={12} stroke={2} /> : null}{shownCustom || PRESENCE_LABEL[shownStatus]}</span>
        {communityName && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, background: T.input, color: T.muted, border: `1px solid ${T.border}`, padding: '3px 8px', borderRadius: 99 }}><Ic name="hash" size={12} />{communityName}</span>}
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {!isMe && onMessage && (
          <button onClick={() => { onMessage(fp); onClose() }} style={{ ...btnPrimary, flex: 1 }}>Mensagem</button>
        )}
        <button onClick={copyFp} style={{ ...btnGhost, flex: 1 }}>{copied ? 'Copiado!' : 'Copiar ID'}</button>
        {isMe && !editing && (
          <button onClick={() => setEditing(true)} style={{ ...btnPrimary, flex: 1 }}>Editar perfil</button>
        )}
      </div>
      <div style={{ display: 'flex', gap: 4, background: T.input, borderRadius: 8, padding: 4, marginBottom: 12 }}>
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id as typeof tab)}
            style={{ flex: 1, background: activeTab === t.id ? T.accent : 'transparent', color: activeTab === t.id ? '#fff' : T.muted, border: 'none', borderRadius: 6, padding: '7px 0', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}>{t.label}</button>
        ))}
      </div>
      {activeTab === 'sobre' && !editing && (
        <div style={{ background: T.input, borderRadius: 10, padding: '12px 14px' }}>
          <div style={secHead}>SOBRE MIM</div>
          <div style={{ fontSize: 13, color: shownAbout ? T.text : T.muted, whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{shownAbout || 'Nada por aqui ainda.'}</div>
          <div style={secHead}>MEMBRO DESDE</div>
          <div style={{ fontSize: 13, color: T.text }}>{memberSince ? new Date(memberSince).toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }) : (isMe ? '—' : 'visível só no próprio aparelho')}</div>
          <div style={secHead}>COR DO PERFIL</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ width: 22, height: 22, borderRadius: 6, background: shownAccent, border: `1px solid ${T.border}` }} />
            <span style={{ fontSize: 12, color: T.muted, fontFamily: 'JetBrains Mono' }}>{shownAccent}</span>
          </div>
          {!isMe && !editing && <ProfileNote fp={fp} />}
        </div>
      )}
      {activeTab === 'servidor' && communityId && !editing && (
        <div style={{ background: T.input, borderRadius: 10, padding: '12px 14px' }}>
          <div style={secHead}>NESTE SERVIDOR{communityName ? ` — ${communityName}` : ''}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={nick} onChange={e => setNick(e.target.value)} disabled={!canNick} maxLength={32}
              placeholder={canNick ? 'Seu apelido aqui…' : 'sem permissão'} style={{ ...inputStyle, flex: 1, opacity: canNick ? 1 : 0.5 }} />
            <button
              onClick={async () => {
                if (!canNick || !nick.trim()) return
                setNickBusy(true); setErr(null)
                try { await services.nicknameSet(communityId, fp, nick.trim()); onRenamed?.() }
                catch (e: any) { setErr(String(e?.message ?? e)) } finally { setNickBusy(false) }
              }}
              disabled={!canNick || nickBusy} style={{ ...btnPrimary, opacity: canNick && !nickBusy ? 1 : 0.5 }}>{nickBusy ? '…' : 'Salvar'}</button>
          </div>
          <div style={{ fontSize: 11, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>Apelido vale só aqui. Seu perfil global continua igual.</div>
        </div>
      )}
      {activeTab === 'p2p' && !editing && (
        <div style={{ background: T.input, borderRadius: 10, padding: '12px 14px' }}>
          <div style={secHead}>IDENTIDADE P2P</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ flex: 1, fontSize: 11, color: T.text, fontFamily: 'JetBrains Mono', wordBreak: 'break-all', lineHeight: 1.6 }}>{fp}</span>
            <button onClick={copyFp} style={{ ...btnGhost, padding: '6px 10px', fontSize: 11, flexShrink: 0 }}>{copied ? 'OK!' : 'Copiar'}</button>
          </div>
          <div style={secHead}>CONEXÃO</div>
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>
            Rota negociada sozinha entre aparelhos (direta ou via relay quando há NAT restritivo). Conteúdo sempre cifrado fim-a-fim — relay enxerga no máximo metadados de transporte.
          </div>
          <div style={secHead}>SINCRONIZAÇÃO</div>
          <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6 }}>
            Avatar e capa viajam comprimidos pelo swarm e ficam em cache nos peers. Sem servidor guardando nada.
          </div>
        </div>
      )}
      {editing && isMe && (
        <>
          <Field label="Nome de exibição">
            <input value={displayName} onChange={e => setDisplayName(e.target.value)} style={inputStyle} maxLength={48} placeholder="Como quer aparecer" />
          </Field>
          <Field label="Sobre mim" hint={`${about.length}/400`}>
            <textarea value={about} onChange={e => setAbout(e.target.value)} style={{ ...inputStyle, minHeight: 64, resize: 'vertical' }} maxLength={400} placeholder="Conte um pouco sobre você" />
          </Field>
          <Field label="Presença">
            <StatusPicker value={status} onChange={setStatus} />
          </Field>
          <Field label="Status personalizado" hint={`${custom.length}/128`}>
            <input value={custom} onChange={e => setCustom(e.target.value)} style={inputStyle} maxLength={128} placeholder="O que está fazendo agora?" />
          </Field>
          <Field label="Ícone do status">
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {STATUS_ICONS.map(s => (
                <button key={s.id} type="button" onClick={() => setCustomEmoji(customEmoji === s.id ? '' : s.id)} title={s.label} aria-label={s.label} aria-pressed={customEmoji === s.id}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 38, height: 38, background: customEmoji === s.id ? `${T.accent}33` : 'transparent', border: `1px solid ${customEmoji === s.id ? T.accent : T.border}`, borderRadius: 8, color: customEmoji === s.id ? '#fff' : T.muted, cursor: 'pointer' }}><Ic name={s.icon} size={18} /></button>
              ))}
              {customEmoji && !statusIconName(customEmoji) && <span style={{ fontSize: 11, color: T.muted }}>Ícone antigo: {customEmoji}</span>}
              {customEmoji && <button type="button" onClick={() => setCustomEmoji('')} style={{ ...btnGhost, padding: '4px 10px', fontSize: 11 }}>Limpar</button>}
            </div>
          </Field>
          <div style={{ fontSize: 11, color: T.muted, marginBottom: 12, lineHeight: 1.5 }}>Dica: toque na capa ou no avatar lá em cima para trocar a imagem. Tudo é comprimido no aparelho antes de ir ao P2P.</div>
          {err && <div style={{ color: '#ff9c9c', fontSize: 12, marginBottom: 10 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)} style={btnGhost}>Cancelar</button>
            <button onClick={save} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>{busy ? 'Salvando…' : 'Salvar'}</button>
          </div>
        </>
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
        <span style={{ display: 'flex', color: T.muted }}><Ic name="search" size={14} /></span>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T.muted }}><Ic name="pin" size={14} />Nenhuma mensagem fixada ainda — use Fixar no menu da mensagem.</div>
        <button onClick={onClose} style={{ ...btnGhost, marginTop: 8, padding: '5px 10px' }}>Fechar</button>
      </div>
    )
  }
  return (
    <div style={{ background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, margin: '0 16px 10px', overflow: 'hidden' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', borderBottom: `1px solid ${T.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 900, color: T.heading }}><Ic name="pin" size={14} />Mensagens fixadas ({pins.length})</div>
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

export function ThreadList({ communityId, parentChannel, channels, onOpen }: {
  communityId: string
  parentChannel: string
  channels: ChannelMeta[]
  onOpen: (t: ThreadView) => void
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
          <span style={{ opacity: 0.7, display: 'flex' }}><Ic name="edit" size={12} /></span> Criar post no fórum
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
        <span style={{ opacity: 0.7, display: 'flex' }}><Ic name="plus" size={12} /></span> Nova thread
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
  ['Ctrl + I', 'Inbox (menções / não lidas)'],
  ['Ctrl + Shift + P', 'Mensagens fixadas'],
  ['Ctrl + Shift + D', 'Mensagens salvas'],
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
      // Inbox (menções + não-lidas) e salvas — atalhos do próprio Discord
      // (Ctrl+I e Ctrl+Shift+D). Não colidem com nada acima.
      if (key && !e.shiftKey && e.key.toLowerCase() === 'i') { e.preventDefault(); ref.current.inbox?.(e); return }
      if (key && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); ref.current.bookmarks?.(e); return }
      if (e.key === 'Escape') { ref.current.escape?.(e); return }
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
    const raw = q.trim().toLowerCase()
    if (!raw) return commands.slice(0, 40)
    let group: string | null = null
    let n = raw
    if (raw[0] === '#') { group = 'canal'; n = raw.slice(1).trim() }
    else if (raw[0] === '@') { group = 'conversa'; n = raw.slice(1).trim() }
    else if (raw[0] === '*') { group = 'servidor'; n = raw.slice(1).trim() }
    const pool = group ? commands.filter(c => c.group === group) : commands
    if (!n) return pool.slice(0, 40)
    const starts: Command[] = []
    const rest: Command[] = []
    for (const c of pool) {
      const label = c.label.toLowerCase()
      if (label.startsWith(n) || label.includes('#' + n) || label.includes('@' + n)) starts.push(c)
      else if (label.includes(n) || c.group.toLowerCase().includes(n)) rest.push(c)
    }
    return [...starts, ...rest].slice(0, 40)
  }, [q, commands])

  useEffect(() => { setIdx(0) }, [q])

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 300, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '12vh' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: T.rail, border: `1px solid ${T.border}`, borderRadius: 10, width: '100%', maxWidth: 560, overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,.6)' }}>
        <div style={{ padding: 14, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: T.muted, display: 'flex' }}><Ic name="search" size={15} /></span>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, list.length - 1)) }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)) }
              if (e.key === 'Enter') { e.preventDefault(); list[idx]?.run(); onClose() }
              if (e.key === 'Escape') onClose()
            }}
            placeholder="Digite um comando ou pesquise… (# canal · @ conversa · * servidor)" style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: T.heading, fontSize: 15 }} />
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
