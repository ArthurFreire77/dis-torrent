// Inbox: menções, não lidas e marcadores numa aba só.
//
// Extraído de `Social.tsx`. Sem ela o badge de menção é um número morto — é por
// aqui que o usuário chega ao que realmente precisa ver.

import React, { useEffect, useMemo, useState } from 'react'
import type { ProfileView, SearchHit } from '../../services/models'
import { services } from '../../services'
import { T, displayNameOf, fmtClock, fmtDay } from './socialTheme'

export type InboxTab = 'mentions' | 'unreads' | 'bookmarks'

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
    } catch { /* mantém o que já estava na tela */ } finally { setBusy(false) }
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
