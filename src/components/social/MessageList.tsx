// Lista de mensagens com a camada social completa: reações, respostas,
// edição, exclusão, fixar, encaminhar, thread, enquetes, markdown, spoiler,
// links, divisores de data e barra de não-lidas.
// O motor valida tudo; aqui só refletimos o resultado real.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { services } from '../../services'
import type {
  EmojiView,
  MsgMetaView,
  PollTally,
  PollView,
  ProfileView,
  ReactionSummary,
  StoredMessage,
} from '../../services/models'
import {
  Avatar,
  DayDivider,
  LinkUnfurl,
  PollCard,
  PresenceDot,
  ReactionBar,
  ReactionPicker,
  RichText,
  UnreadDivider,
  fmtClock,
} from './Social'

const FILE_PREFIX = '{"file"'
const QUICK = ['👍', '❤️', '🔥', '😂', '🎉', '👀']

export interface MessageListProps {
  messages: StoredMessage[]
  convId: string
  myFp: string
  /** nome de exibição resolvido pelo shell (apelido do grupo / bot) */
  nameOf: (fp: string) => string
  profiles: Record<string, ProfileView>
  presence: Record<string, string>
  emptyBlock: React.ReactNode
  onReply: (m: StoredMessage) => void
  onProfile: (fp: string) => void
  onForward: (m: StoredMessage) => void
  onThread: (m: StoredMessage) => void
  onToast: (s: string) => void
  renderFile?: (m: StoredMessage, grouped: boolean) => React.ReactNode
  /** enquetes do canal (nativo; vazio no browser até criar) */
  pollChannel?: { communityId: string; channelId: string }
  pollHighlight?: string
}

export default function MessageList(props: MessageListProps) {
  const {
    messages, convId, myFp, nameOf, profiles, presence, emptyBlock,
    onReply, onProfile, onForward, onThread, onToast, renderFile, pollChannel,
  } = props

  const [metas, setMetas] = useState<Record<string, MsgMetaView>>({})
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [reactions, setReactions] = useState<Record<string, ReactionSummary[]>>({})
  const [polls, setPolls] = useState<PollView[]>([])
  const [tallies, setTallies] = useState<Record<string, PollTally>>({})
  const [emojis, setEmojis] = useState<EmojiView[]>([])
  const [unreadBefore, setUnreadBefore] = useState<number | null>(null)
  const [picker, setPicker] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [stickBottom, setStickBottom] = useState(true)

  const ids = useMemo(() => messages.map(m => m.id), [messages])

  // carga de meta + reações + corpos efetivos (1 chamada cada, em lote)
  useEffect(() => {
    if (ids.length === 0) { setMetas({}); setReactions({}); setBodies({}); return }
    let alive = true
    services.metaBulk(ids).then(r => { if (alive) setMetas(Object.fromEntries(r.map(m => [m.msg_id, m]))) }).catch(() => {})
    services.reactionsBulk(ids).then(r => {
      if (!alive) return
      const map: Record<string, ReactionSummary[]> = {}
      for (const x of r) (map[x.msg_id] ??= []).push(x)
      setReactions(map)
    }).catch(() => {})
    services.effectiveBodies(ids).then(r => { if (alive) setBodies(Object.fromEntries(r)) }).catch(() => {})
    return () => { alive = false }
  }, [ids.join(',')])

  useEffect(() => {
    if (stickBottom) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, stickBottom])

  useEffect(() => {
    if (!pollChannel) { setPolls([]); return }
    let alive = true
    services.pollList(pollChannel.communityId, pollChannel.channelId)
      .then(async ps => {
        if (!alive) return
        setPolls(ps)
        const t: Record<string, PollTally> = {}
        for (const p of ps) t[p.id] = await services.pollTally(p.id).catch(() => ({ counts: [], total: 0, mine: [] }))
        if (alive) setTallies(t)
      })
      .catch(() => setPolls([]))
    return () => { alive = false }
  }, [pollChannel?.communityId, pollChannel?.channelId, messages.length])

  useEffect(() => {
    if (!pollChannel) return
    services.emojiList(pollChannel.communityId).then(setEmojis).catch(() => setEmojis([]))
  }, [pollChannel?.communityId])

  // cursor de leitura: onde estavam as não-lidas quando entrou na conversa
  useEffect(() => {
    let alive = true
    services.readSet(convId, 0).catch(() => {})
    services.unreadCount(convId).then(n => {
      if (!alive) return
      if (n > 0) {
        // procura a 1ª mensagem acima do cursor
        services.readAll().then(cur => {
          const last = cur.find(c => c.conv_id === convId)?.last_read_ts ?? 0
          if (last > 0) setUnreadBefore(last)
        })
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [convId])

  useEffect(() => {
    const close = () => { setMenu(null); setPicker(null) }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  async function toggleReact(msgId: string, emoji: string) {
    try {
      await services.react(convId, msgId, emoji)
      const r = await services.reactions(msgId)
      setReactions(s => ({ ...s, [msgId]: r }))
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  async function doEdit(id: string) {
    if (!editing) return
    try {
      await services.editMessage(convId, id, editing.body)
      setBodies(b => ({ ...b, [id]: editing.body }))
      setMetas(m => ({ ...m, [id]: { ...(m[id] ?? emptyMeta(id, convId)), edited_body: editing.body, edited_at: Date.now() } }))
      setEditing(null)
      onToast('mensagem editada')
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  async function doDelete(id: string) {
    if (!confirm('Apagar esta mensagem para todos?')) return
    try {
      await services.deleteMessage(convId, id)
      setMetas(m => ({ ...m, [id]: { ...(m[id] ?? emptyMeta(id, convId)), deleted: true } }))
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  async function doPin(id: string) {
    const cur = metas[id]
    try {
      await services.pin(convId, id, !cur?.pinned)
      setMetas(m => ({ ...m, [id]: { ...(m[id] ?? emptyMeta(id, convId)), pinned: !cur?.pinned, pinned_by: myFp, pinned_at: Date.now() } }))
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  function jumpTo(id: string) {
    const el = scrollRef.current?.querySelector(`[data-mid="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
  useEffect(() => { if (unreadBefore) setUnreadBefore(null) }, [messages.length])

  if (messages.length === 0) return <>{emptyBlock}</>

  const visible = messages.filter(m => !(metas[m.id]?.deleted))
  const deletedCount = messages.length - visible.length

  return (
    <div ref={scrollRef} onScroll={e => {
      const el = e.currentTarget
      setStickBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
    }} style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 2 }}>
      {visible.map((m, idx) => {
        const mine = m.direction === 'out'
        const authorFp = mine ? myFp : m.author_fp
        const authorName = nameOf(authorFp)
        const meta = metas[m.id]
        const body = meta?.deleted ? '' : (bodies[m.id] ?? m.body)
        const prev = idx > 0 ? visible[idx - 1] : null
        const grouped = !!prev && !prev.body.startsWith(FILE_PREFIX)
          && prev.author_fp === m.author_fp && prev.direction === m.direction
          && (m.ts - prev.ts) < 5 * 60_000
        const newDay = !prev || new Date(prev.ts).toDateString() !== new Date(m.ts).toDateString()
        const replyRef = meta?.reply_to ? messages.find(x => x.id === meta.reply_to) : undefined
        const rx = reactions[m.id] ?? []
        const isFile = m.body.startsWith(FILE_PREFIX)
        const pres = presence[authorFp] as never
        const showUnread = unreadBefore !== null && m.ts >= unreadBefore
        const wantsUnfurl = body.includes('<@') || body.includes('http://') || body.includes('https://')

        return (
          <React.Fragment key={m.id}>
            {newDay && <DayDivider ts={m.ts} />}
            {showUnread && <UnreadDivider onClick={() => setUnreadBefore(null)} />}
            <div
              data-mid={m.id}
              onContextMenu={e => { e.preventDefault(); setMenu({ id: m.id, x: e.clientX, y: e.clientY }) }}
              className="msg-row"
              style={{ display: 'flex', gap: 12, padding: grouped ? '1px 8px' : '8px', borderRadius: 8, marginTop: grouped ? -6 : 0, position: 'relative' }}
            >
              {grouped ? <span style={{ width: 40, flexShrink: 0 }} /> : (
                <span style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }} onClick={() => onProfile(authorFp)}>
                  <Avatar name={authorName} fp={authorFp} size={40} avatarB64={profiles[authorFp]?.avatar_b64} />
                  {pres && <PresenceDot status={pres} size={12} ring={T_MAIN} />}
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {!grouped && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: profiles[authorFp]?.accent || T_HEADING, cursor: 'pointer' }}
                      onClick={() => onProfile(authorFp)}>{authorName}</span>
                    <span style={{ fontSize: 11, color: T_MUTED, fontFamily: 'JetBrains Mono' }}>{authorFp.slice(0, 12)}</span>
                    <span style={{ fontSize: 11, color: T_MUTED }}>{fmtClock(m.ts)}</span>
                    {meta?.edited_at ? <span style={{ fontSize: 10, color: T_MUTED }} title={new Date(meta.edited_at).toLocaleString('pt-BR')}>(editado)</span> : null}
                    {meta?.pinned ? <span title="fixada" style={{ fontSize: 10 }}>📌</span> : null}
                    {meta?.forwarded_from ? <span style={{ fontSize: 10, color: T_MUTED }}>↪ encaminhada de {meta.forwarded_from}</span> : null}
                    {mine && m.status !== 'ok' && <StatusGlyph status={m.status} />}
                  </div>
                )}

                {meta?.forwarded_from && !grouped && (
                  <div style={{ fontSize: 10, color: T_MUTED, marginTop: 2 }}>↪ Encaminhada de {meta.forwarded_from}</div>
                )}

                {replyRef && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3, fontSize: 11.5, color: T_MUTED }}>
                    <span style={{ width: 22, height: 10, borderLeft: `2px solid ${T_MUTED}`, borderTop: `2px solid ${T_MUTED}`, borderTopLeftRadius: 6 }} />
                    <span style={{ fontWeight: 700, color: T_TEXT }}>{nameOf(replyRef.direction === 'out' ? myFp : replyRef.author_fp)}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 380 }}>{replyRef.body.slice(0, 120)}</span>
                  </div>
                )}

                {editing?.id === m.id ? (
                  <div style={{ marginTop: 4 }}>
                    <textarea autoFocus value={editing.body} onChange={e => setEditing({ id: m.id, body: e.target.value })}
                      style={{ width: '100%', minHeight: 60, background: T_INPUT, border: `1px solid ${T_BORDER}`, borderRadius: 8, padding: 10, color: T_TEXT, fontSize: 14, outline: 'none', resize: 'vertical', fontFamily: 'inherit' }} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button onClick={() => setEditing(null)} style={BTN_GHOST}>cancelar</button>
                      <button onClick={() => doEdit(m.id)} disabled={!editing.body.trim()} style={{ ...BTN_PRIMARY, opacity: editing.body.trim() ? 1 : 0.5 }}>salvar</button>
                      <span style={{ fontSize: 10, color: T_MUTED, alignSelf: 'center' }}>Enter salva · Esc cancela</span>
                    </div>
                  </div>
                ) : isFile && renderFile ? renderFile(m, grouped) : (
                  <>
                    <div style={{ fontSize: 14, color: T_TEXT, marginTop: grouped ? 0 : 2 }}>
                      <RichText body={body} onMention={onProfile} />
                    </div>
                    {wantsUnfurl && <LinkUnfurl body={body} />}
                  </>
                )}

                <ReactionBar reactions={rx} onToggle={e => toggleReact(m.id, e)}
                  onHoverList={r => onToast(`${r.emoji} ${r.count} · ${r.reactors.map(f => f.slice(0, 8)).join(', ')}`)} />

                {polls.length > 0 && idx === visible.length - 1 - Math.min(3, polls.length) && polls.map(p => (
                  <PollCard key={p.id} poll={p} tally={tallies[p.id] ?? { counts: [], total: 0, mine: [] }}
                    communityId={pollChannel?.communityId ?? ''} channelId={pollChannel?.channelId ?? ''}
                    onVote={async i => {
                      if (!pollChannel) return
                      try { await services.pollVote(pollChannel.communityId, pollChannel.channelId, p.id, i) } catch (e: any) { onToast(String(e?.message ?? e)) }
                    }} />
                ))}
              </div>

              {/* barra de ações no hover — estilo Discord */}
              <div className="msg-tools" style={{ position: 'absolute', top: -14, right: 12, display: 'none', gap: 2, background: T_MAIN, border: `1px solid ${T_BORDER}`, borderRadius: 8, padding: 2, boxShadow: '0 4px 12px rgba(0,0,0,.4)', zIndex: 5 }}>
                {QUICK.slice(0, 4).map(e => (
                  <button key={e} title={`Reagir ${e}`} onClick={e2 => { e2.stopPropagation(); toggleReact(m.id, e) }}
                    style={TOOL_BTN}>{e}</button>
                ))}
                <button title="Mais reações" onClick={e2 => { e2.stopPropagation(); setPicker(picker === m.id ? null : m.id) }} style={TOOL_BTN}>😊</button>
                <button title="Responder" onClick={e2 => { e2.stopPropagation(); onReply(m) }} style={{ ...TOOL_BTN, width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 800 }}>Responder</button>
                <button title="Mais" onClick={e2 => { e2.stopPropagation(); setMenu({ id: m.id, x: e2.clientX, y: e2.clientY }) }} style={TOOL_BTN}>⋯</button>
                {picker === m.id && (
                  <div onClick={e2 => e2.stopPropagation()}>
                    <ReactionPicker onPick={em => toggleReact(m.id, em)} customEmojis={emojis} onClose={() => setPicker(null)} />
                  </div>
                )}
              </div>
            </div>

            {menu?.id === m.id && (
              <div onClick={e => e.stopPropagation()} style={{
                position: 'fixed', left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 300),
                zIndex: 210, background: T_MAIN, border: `1px solid ${T_BORDER}`, borderRadius: 8, padding: 4,
                boxShadow: '0 12px 34px rgba(0,0,0,.5)', minWidth: 190,
              }}>
              <MenuItem label="📌 Fixar / desafixar" onClick={() => { doPin(m.id); setMenu(null) }} />
              <MenuItem label="↪ Encaminhar" onClick={() => { onForward(m); setMenu(null) }} />
              <MenuItem label="🧵 Criar thread" onClick={() => { onThread(m); setMenu(null) }} />
              {(mine || meta) && <MenuItem label="✏️ Editar" onClick={() => { setEditing({ id: m.id, body }); setMenu(null) }} />}
              <MenuItem label="🔎 Copiar texto" onClick={() => { navigator.clipboard?.writeText(body); onToast('copiado'); setMenu(null) }} />
              <MenuItem label="🔖 Salvar marcador" onClick={async () => {
                try { await services.bookmarkSet(convId, body.slice(0, 24) || 'mensagem', m.id); onToast('marcador salvo') } catch (e: any) { onToast(String(e?.message ?? e)) }
                setMenu(null)
              }} />
              <MenuItem label="🗑 Apagar" danger onClick={() => { doDelete(m.id); setMenu(null) }} />
            </div>
            )}
          </React.Fragment>
        )
      })}

      {deletedCount > 0 && (
        <div style={{ fontSize: 11, color: T_MUTED, textAlign: 'center', padding: 8 }}>
          {deletedCount} mensagem{deletedCount === 1 ? '' : 'ns'} apagada{deletedCount === 1 ? '' : 's'}
        </div>
      )}
      <div ref={bottomRef} style={{ height: 1, flexShrink: 0 }} />
      <JumpToBottom visible={!stickBottom} onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })} />
    </div>
  )
}

function JumpToBottom({ visible, onClick }: { visible: boolean; onClick: () => void }) {
  if (!visible) return null
  return (
    <button onClick={onClick} style={{
      position: 'sticky', bottom: 8, alignSelf: 'center', background: T_MAIN, color: T_TEXT,
      border: `1px solid ${T_BORDER}`, borderRadius: 20, padding: '6px 14px', fontSize: 11,
      fontWeight: 800, cursor: 'pointer', boxShadow: '0 4px 14px rgba(0,0,0,.4)',
    }}>↓ Novas mensagens</button>
  )
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{
      display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
      color: danger ? '#ff9c9c' : T_TEXT, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
      fontSize: 12.5, fontWeight: 600,
    }} onMouseEnter={e => (e.currentTarget.style.background = T_INPUT)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {label}
    </button>
  )
}

function StatusGlyph({ status }: { status: string }) {
  const g = status === 'delivered' ? '✓✓' : status === 'sent' ? '✓' : status === 'failed' ? '✕' : '○'
  return <span title={status} style={{ fontSize: 10, color: status === 'failed' ? '#ff9c9c' : T_MUTED, fontFamily: 'monospace' }}>{g}</span>
}

function emptyMeta(id: string, convId: string): MsgMetaView {
  return { msg_id: id, conv_id: convId, reply_to: '', forwarded_from: '', edited_body: '', edited_at: 0, deleted: false, pinned: false, pinned_by: '', pinned_at: 0, mentioned: false }
}

// paleta local (espelha o FORGE do shell)
const T_MAIN = '#313338'
const T_INPUT = '#1e1f22'
const T_BORDER = '#3f4147'
const T_TEXT = '#dbdee1'
const T_HEADING = '#f2f3f5'
const T_MUTED = '#949ba4'
const BTN_PRIMARY: React.CSSProperties = { background: T_HEADING, color: '#1e1f22', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 800, fontSize: 12 }
const BTN_GHOST: React.CSSProperties = { background: 'transparent', color: T_MUTED, border: `1px solid ${T_BORDER}`, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 12 }
const TOOL_BTN: React.CSSProperties = { background: 'transparent', border: 'none', color: T_TEXT, cursor: 'pointer', fontSize: 14, width: 28, height: 26, borderRadius: 4 }
