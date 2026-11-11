import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { PresenceStatus } from '../../services/models'
import { Markdown } from '../../shared/markdown'
import { getNote, setNote } from '../../shared/prefs'
import { Avatar as AvatarView } from '../../shared/avatarView'
import { T, PRESENCE_COLOR, PRESENCE_LABEL } from './socialTheme'

const EMOJI_SHORT: Record<string, string> = {
  smile: '😄', joy: '😂', heart: '❤️', fire: '🔥', tada: '🎉', eyes: '👀',
  rocket: '🚀', pray: '🙏', ok: '👌', thumbsup: '👍', thumbsdown: '👎',
  thinking: '🤔', cry: '😢', skull: '💀', 100: '💯', check: '✅', x: '❌',
  zap: '⚡', star: '⭐', sparkles: '✨', wave: '👋', clap: '👏', bug: '🐛',
}

export function RichText({
  body,
  highlight,
  onMention,
  serverEmojis,
}: {
  body: string
  highlight?: string
  onMention?: (fp: string) => void
  /** Emojis do servidor (`nome -> glifo`) resolvidos em `:nome:`. */
  serverEmojis?: Record<string, string>
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
      resolveEmoji={(name) => serverEmojis?.[name] ?? EMOJI_SHORT[name.toLowerCase()] ?? null}
      theme={{ text: T.text, link: '#00a8fc' }}
    />
  )
}

function extractUrls(body: string): string[] {
  return (body.match(/https?:\/\/[^\s<>"']+/g) ?? []).slice(0, 3)
}

function isImageUrl(url: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/i.test(url)
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(url)
}

function isYouTubeUrl(url: string): boolean {
  return /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)/i.test(url)
}

function extractYouTubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i)
  return m?.[1] ?? null
}

function isTwitterUrl(url: string): boolean {
  return /(?:twitter\.com|x\.com)\/\w+\/status\/\d+/i.test(url)
}

/** Detecta se a URL é do GitHub. */
function isGitHubUrl(url: string): boolean {
  return /github\.com\/[\w-]+\/[\w-]+/i.test(url)
}

export function LinkUnfurl({ body }: { body: string }) {
  const urls = useMemo(() => extractUrls(body), [body])
  if (urls.length === 0) return null
  return (
    <>
      {urls.map((u) => {
        let host = u
        let favicon = ''
        try {
          const parsed = new URL(u)
          host = parsed.hostname
          favicon = `${parsed.origin}/favicon.ico`
        } catch {  }

        // Preview de imagem
        if (isImageUrl(u)) {
          return (
            <a key={u} href={u} target="_blank" rel="noreferrer noopener"
              style={{ display: 'block', marginTop: 6, borderRadius: 8, overflow: 'hidden', maxWidth: 400 }}>
              <img src={u} alt="" style={{ width: '100%', maxHeight: 300, objectFit: 'cover', display: 'block' }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
            </a>
          )
        }

        // Preview de vídeo
        if (isVideoUrl(u)) {
          return (
            <div key={u} style={{ marginTop: 6, borderRadius: 8, overflow: 'hidden', maxWidth: 400, background: '#000' }}>
              <video src={u} controls style={{ width: '100%', maxHeight: 300, display: 'block' }} />
            </div>
          )
        }

        // Preview do YouTube
        if (isYouTubeUrl(u)) {
          const videoId = extractYouTubeId(u)
          if (videoId) {
            return (
              <a key={u} href={u} target="_blank" rel="noreferrer noopener"
                style={{ display: 'block', marginTop: 6, borderRadius: 8, overflow: 'hidden', maxWidth: 480, textDecoration: 'none', background: T.sidebar, border: `1px solid ${T.border}` }}>
                <div style={{ position: 'relative', paddingTop: '56.25%', background: '#000' }}>
                  <img src={`https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`} alt=""
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { (e.target as HTMLImageElement).src = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` }} />
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div style={{ width: 68, height: 48, background: 'rgba(255,0,0,0.9)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <div style={{ width: 0, height: 0, borderLeft: '18px solid #fff', borderTop: '11px solid transparent', borderBottom: '11px solid transparent', marginLeft: 4 }} />
                    </div>
                  </div>
                </div>
                <div style={{ padding: '10px 12px' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 2 }}>YouTube</div>
                  <div style={{ fontSize: 11, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</div>
                </div>
              </a>
            )
          }
        }

        // Preview do Twitter/X
        if (isTwitterUrl(u)) {
          return (
            <a key={u} href={u} target="_blank" rel="noreferrer noopener"
              style={{ display: 'block', marginTop: 6, borderLeft: `3px solid #1da1f2`, background: T.sidebar, borderRadius: 6, padding: '10px 12px', maxWidth: 420, textDecoration: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#1da1f2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 900 }}>𝕏</div>
                <span style={{ fontSize: 12, fontWeight: 800, color: '#1da1f2' }}>Twitter / X</span>
              </div>
              <div style={{ fontSize: 11, color: T.muted, fontFamily: 'JetBrains Mono', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</div>
            </a>
          )
        }

        // Preview do GitHub
        if (isGitHubUrl(u)) {
          const match = u.match(/github\.com\/([\w-]+\/[\w-]+)/i)
          const repo = match?.[1] ?? ''
          return (
            <a key={u} href={u} target="_blank" rel="noreferrer noopener"
              style={{ display: 'block', marginTop: 6, borderLeft: `3px solid #6e5494`, background: T.sidebar, borderRadius: 6, padding: '10px 12px', maxWidth: 420, textDecoration: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: '#6e5494', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 900 }}>GH</div>
                <span style={{ fontSize: 12, fontWeight: 800, color: '#6e5494' }}>GitHub</span>
                {repo && <span style={{ fontSize: 11, color: T.text, fontFamily: 'JetBrains Mono' }}>{repo}</span>}
              </div>
              <div style={{ fontSize: 11, color: T.muted, fontFamily: 'JetBrains Mono', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</div>
            </a>
          )
        }

        // Preview genérico
        return (
          <a key={u} href={u} target="_blank" rel="noreferrer noopener"
            style={{ display: 'block', marginTop: 6, borderLeft: `3px solid ${T.accent}`, background: T.sidebar, borderRadius: 6, padding: '10px 12px', maxWidth: 420, textDecoration: 'none' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              {favicon && (
                <img src={favicon} alt="" width={16} height={16} style={{ borderRadius: 2 }}
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              )}
              <span style={{ fontSize: 12, fontWeight: 800, color: '#00a8fc' }}>{host}</span>
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: 'JetBrains Mono', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u}</div>
          </a>
        )
      })}
    </>
  )
}

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

export function Avatar({ name, fp, size = 40, avatarB64, ring, effect, accent, emoji }: {
  name: string
  fp: string
  size?: number
  avatarB64?: string
  ring?: string
  effect?: string
  /** Cor de destaque do perfil; a aura usa esta cor. */
  accent?: string
  /** Emoji do bot (`🎵`) no lugar da inicial. */
  emoji?: string
}) {
  return <AvatarView name={name} fp={fp} size={size} avatarB64={avatarB64} ring={ring} effect={effect} accent={accent} emoji={emoji} />
}

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
      {
}
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

export const secHead: React.CSSProperties = {
  fontSize: 10, fontWeight: 800, letterSpacing: 1, color: T.muted, margin: '12px 0 4px',
}

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
