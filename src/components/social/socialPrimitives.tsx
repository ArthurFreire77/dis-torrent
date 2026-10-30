// Primitivas visuais da camada social: texto rico, presença, avatar e os
// campos/botões que os painéis compartilham.
//
// Extraído de `Social.tsx` (1508 linhas, 27 exports). O conteúdo é o MESMO — a
// divisão é só de responsabilidade; `Social.tsx` reexporta tudo.

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { PresenceStatus } from '../../services/models'
import { Markdown } from '../../shared/markdown'
import { getNote, setNote } from '../../shared/prefs'
import { T, PRESENCE_COLOR, PRESENCE_LABEL } from './socialTheme'

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
    // `compressImage` (shared/avatar.ts) SEMPRE produz JPEG. Declarar PNG aqui
    // funcionava só porque o navegador fareja os bytes — contrato errado que
    // quebra em engines estritos (Android) e confunde o cache.
    return <img src={`data:image/jpeg;base64,${avatarB64}`} onError={() => setErr(true)} alt={name}
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

/** Cabeçalho de seção dentro de um painel (caixa alta, discreto). */
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
