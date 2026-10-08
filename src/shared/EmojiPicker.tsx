// Seletor de emoji reutilizável (composer + barra de reações) — sem
// dependências. Categorias fixas, busca, emojis do servidor e recentes.

import { useEffect, useMemo, useRef, useState } from 'react'
import { EMOJI_GROUPS, ALL_EMOJI, type EmojiGroup } from '../shared/emojiSet'
import type { EmojiView } from '../services/models'
import { Icon, Icons } from '../shared/icons'

const DARK = {
  bg: '#2b2d31', panel: '#1e1f22', border: '#3f4147', text: '#dbdee1',
  heading: '#f2f3f5', muted: '#949ba4', accent: '#5865f2', hover: '#35373c',
}

export function EmojiPicker({
  open, onClose, onPick, serverEmojis, anchor, title = 'Emojis',
}: {
  open: boolean
  onClose: () => void
  onPick: (emoji: string) => void
  serverEmojis?: EmojiView[]
  /** posição do popover ('up'|'down') — mobile vs desktop */
  anchor?: 'up' | 'down'
  title?: string
}) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState<string>('recentes')
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('forge:emoji:recent') ?? '[]') as string[] } catch { return [] }
  })
  const searchRef = useRef<HTMLInputElement | null>(null)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (open) {
      setQ('')
      const t = setTimeout(() => searchRef.current?.focus(), 30)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey, true)
    // pointerdown com capture: não fecha quando o clique é dentro do popover
    setTimeout(() => window.addEventListener('mousedown', onDown, true), 0)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('mousedown', onDown, true)
    }
  }, [open, onClose])

  const groups: EmojiGroup[] = useMemo(() => {
    const srv: EmojiGroup[] = serverEmojis && serverEmojis.length
      ? [{
          id: 'servidor', label: `Emojis de ${title}`, icon: '⭐️',
          emojis: serverEmojis.map((e) => e.char).filter(Boolean),
        }]
      : []
    const rec: EmojiGroup[] = recent.length ? [{ id: 'recentes', label: 'Usados recentemente', icon: '🕘', emojis: recent }] : []
    return [...srv, ...rec, ...EMOJI_GROUPS.filter((g) => g.id !== 'recentes')]
  }, [serverEmojis, recent, title])

  const results = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return null
    return ALL_EMOJI.filter((e) => e.includes(s)).slice(0, 64)
  }, [q])

  if (!open) return null

  const pick = (e2: string) => {
    onPick(e2)
    const next = [e2, ...recent.filter((x) => x !== e2)].slice(0, 24)
    setRecent(next)
    try { localStorage.setItem('forge:emoji:recent', JSON.stringify(next)) } catch { /* quota */ }
  }

  const shown = results ? [{ id: 'busca', label: 'Resultados', icon: '', emojis: results }] : groups
  const activeTab = results ? 'busca' : tab

  return (
    <div
      ref={boxRef}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="Seletor de emoji"
      style={{
        position: 'absolute', zIndex: 120, width: 330, maxWidth: '92vw',
        ...(anchor === 'up' ? { bottom: '100%', marginBottom: 8 } : { top: '100%', marginTop: 8 }),
        background: DARK.panel, border: `1px solid ${DARK.border}`, borderRadius: 10,
        boxShadow: '0 8px 28px rgba(0,0,0,.55)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', gap: 6, padding: 8, borderBottom: `1px solid ${DARK.border}` }}>
        <span style={{ display: 'flex', alignItems: 'center', color: DARK.muted, paddingLeft: 4 }}><Icon d={Icons.search} size={15} /></span>
        <input
          ref={searchRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar emoji"
          aria-label="Buscar emoji"
          style={{ flex: 1, background: DARK.bg, border: 'none', outline: 'none', color: DARK.text, fontSize: 13, borderRadius: 6, padding: '6px 8px' }}
        />
        <button onClick={onClose} aria-label="Fechar" style={{ background: 'transparent', border: 'none', color: DARK.muted, cursor: 'pointer', display: 'flex', padding: 2 }}><Icon d={Icons.x} size={15} /></button>
      </div>

      <div style={{ display: 'flex', gap: 2, padding: '4px 6px', borderBottom: `1px solid ${DARK.border}`, overflowX: 'auto' }}>
        {shown.map((g) => (
          <button
            key={g.id}
            onClick={() => { setTab(g.id); document.getElementById(`emj-sec-${g.id}`)?.scrollIntoView({ block: 'start' }) }}
            title={g.label}
            aria-label={g.label}
            style={{
              background: activeTab === g.id ? DARK.hover : 'transparent', border: 'none', cursor: 'pointer',
              color: activeTab === g.id ? DARK.heading : DARK.muted, padding: '5px 7px', borderRadius: 6, flexShrink: 0,
              display: 'flex', alignItems: 'center',
            }}
          >{g.id === 'busca' ? <Icon d={Icons.search} size={15} /> : <span style={{ fontSize: 15, lineHeight: 1 }}>{g.icon}</span>}</button>
        ))}
      </div>

      <div style={{ maxHeight: 230, overflowY: 'auto', padding: 6 }}>
        {shown.map((g) => (
          <div key={g.id} id={`emj-sec-${g.id}`}>
            <div style={{ fontSize: 10, fontWeight: 800, color: DARK.muted, textTransform: 'uppercase', padding: '6px 4px 4px' }}>{g.label}</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 1 }}>
              {g.emojis.map((e2, i) => (
                <button
                  key={`${e2}-${i}`}
                  onClick={() => pick(e2)}
                  title={e2}
                  aria-label={`emoji ${e2}`}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 20, padding: '4px 0', borderRadius: 6, lineHeight: 1 }}
                  onMouseEnter={(e3) => { e3.currentTarget.style.background = DARK.hover }}
                  onMouseLeave={(e3) => { e3.currentTarget.style.background = 'transparent' }}
                >{e2}</button>
              ))}
            </div>
          </div>
        ))}
        {shown.length === 0 && <div style={{ padding: 12, fontSize: 12, color: DARK.muted }}>nada encontrado</div>}
      </div>
    </div>
  )
}
