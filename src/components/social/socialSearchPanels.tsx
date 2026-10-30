// Busca, fixadas, enquetes e threads.
//
// Extraído de `Social.tsx` (que tinha 1508 linhas e 27 exports) por
// `scripts/split-social.mjs`. O conteúdo é o MESMO — a divisão é só de
// responsabilidade: um arquivo por assunto, para achar e revisar sem rolar
// 1,5 mil linhas. `Social.tsx` continua reexportando tudo, então nenhum
// importador precisou mudar.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ChannelMeta, MsgMetaView, PollTally, PollView, ProfileView, SearchHit, StoredMessage, ThreadView } from '../../services/models'
import { Ic } from '../../shared/icons'
import { T, displayNameOf, fmtClock, fmtDay } from './socialTheme'
import { Avatar, Modal, RichText, btnGhost, btnPrimary, inputStyle } from './socialPrimitives'
import { services } from '../../services'

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

