// Divisores de data/não-lidas e mensagens salvas.
//
// Extraído de `Social.tsx` (1508 linhas, 27 exports). O conteúdo é o MESMO — a
// divisão é só de responsabilidade, e `Social.tsx` reexporta tudo para nenhum
// importador precisar mudar.

import React, { useEffect, useMemo, useState } from 'react'
import type { StoredMessage } from '../../services/models'
import { services } from '../../services'
import { T, fmtClock, fmtDay } from './socialTheme'
import { btnGhost } from './socialPrimitives'

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
