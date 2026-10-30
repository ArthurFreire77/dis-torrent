// Atalhos de teclado e paleta de comandos.
//
// Extraído de `Social.tsx` (que tinha 1508 linhas e 27 exports) por
// `scripts/split-social.mjs`. O conteúdo é o MESMO — a divisão é só de
// responsabilidade: um arquivo por assunto, para achar e revisar sem rolar
// 1,5 mil linhas. `Social.tsx` continua reexportando tudo, então nenhum
// importador precisou mudar.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Ic } from '../../shared/icons'
import { T } from './socialTheme'

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
