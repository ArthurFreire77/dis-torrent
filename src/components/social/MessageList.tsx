import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { services } from '../../services'
import { FILE_PREFIX } from '../../services/fileSwarm'
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
  ReactionWhoPopover,
  RichText,
  UnreadDivider,
  fmtClock,
} from './Social'
import { Icon, Icons } from '../../shared/icons'
import { EmojiPicker } from '../../shared/EmojiPicker'
import {
  buildReceipts, groupStatus, receiptsHeadline, statusGlyph, statusTitle, statusTitleFor,
  type ReceiptsView,
} from './messageStatus'
import { ReceiptsPanel } from './Social'
import { useConversationRoster, useMessageReceipts } from './socialHooks'

export interface MessageListProps {
  messages: StoredMessage[]
  convId: string
  myFp: string
  nameOf: (fp: string) => string
  profiles: Record<string, ProfileView>
  presence: Record<string, string>
  peerOnline?: boolean
  emptyBlock: React.ReactNode
  onReply: (m: StoredMessage) => void
  onProfile: (fp: string) => void
  onForward: (m: StoredMessage) => void
  onThread: (m: StoredMessage) => void
  onToast: (s: string) => void
  onResend?: (m: StoredMessage) => void
  renderFile?: (m: StoredMessage, grouped: boolean) => React.ReactNode
  pollChannel?: { communityId: string; channelId: string }
  pollHighlight?: string
  compact?: boolean
  fontScale?: number
}

export interface MessageListHandle {
  reloadPolls: () => void
}

const MessageList = forwardRef<MessageListHandle, MessageListProps>(function MessageListInner(props, ref) {
  const {
    messages, convId, myFp, nameOf, profiles, presence, emptyBlock,
    onReply, onProfile, onForward, onThread, onToast, renderFile, pollChannel, onResend,
    compact, fontScale, peerOnline,
  } = props
  const fs = fontScale && fontScale > 0 ? fontScale : 1

  const roster = useConversationRoster(convId, myFp)
  // Recibos reais por membro (tabela `read_receipts` do core).
  const recibos = useMessageReceipts(convId, messages as never)

  const receiptsOf = (m: StoredMessage): ReceiptsView => buildReceipts({
    kind: roster.kind,
    members: roster.members,
    membersKnown: !roster.loading,
    myFp,
    status: m.status,
    receipts: recibos[m.id] ?? [],
    receiptsKnown: !!recibos[m.id],
  })

  const [metas, setMetas] = useState<Record<string, MsgMetaView>>({})
  const [bodies, setBodies] = useState<Record<string, string>>({})
  const [reactions, setReactions] = useState<Record<string, ReactionSummary[]>>({})
  const [polls, setPolls] = useState<PollView[]>([])
  const [pollNonce, setPollNonce] = useState(0)
  useImperativeHandle(ref, () => ({ reloadPolls: () => setPollNonce(n => n + 1) }))
  const [tallies, setTallies] = useState<Record<string, PollTally>>({})
  const [emojis, setEmojis] = useState<EmojiView[]>([])
  const emojiMap = useMemo(() => {
    const m: Record<string, string> = {}
    for (const e of emojis) if (e.name) m[e.name] = e.char
    return m
  }, [emojis])
  const [unreadBefore, setUnreadBefore] = useState<number | null>(null)
  const [picker, setPicker] = useState<string | null>(null)
  const [whoReagiu, setWhoReagiu] = useState<string | null>(null)
  const [quemViu, setQuemViu] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [stickBottom, setStickBottom] = useState(true)

  const ids = useMemo(() => messages.map(m => m.id), [messages])

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
    const load = () => {
      services.pollList(pollChannel.communityId, pollChannel.channelId)
        .then(async ps => {
          if (!alive) return
          setPolls(ps)
          const t: Record<string, PollTally> = {}
          for (const p of ps) t[p.id] = await services.pollTally(p.id).catch(() => ({ counts: [], total: 0, mine: [] }))
          if (alive) setTallies(t)
        })
        .catch(() => { if (alive) setPolls([]) })
    }
    load()
    return () => { alive = false }
  }, [pollChannel?.communityId, pollChannel?.channelId, messages.length, pollNonce])

  useEffect(() => {
    if (!pollChannel) return
    const un = services.subscribe((ev) => {
      if (String(ev.type).includes('poll')) setPollNonce(n => n + 1)
    })
    return un
  }, [pollChannel?.communityId, pollChannel?.channelId])

  useEffect(() => {
    if (!pollChannel) return
    services.emojiList(pollChannel.communityId).then(setEmojis).catch(() => setEmojis([]))
  }, [pollChannel?.communityId])

  useEffect(() => {
    let alive = true
    services.readSet(convId, 0).catch(() => {})
    services.unreadCount(convId).then(n => {
      if (!alive) return
      if (n > 0) {
        services.readAll().then(cur => {
          const last = cur.find(c => c.conv_id === convId)?.last_read_ts ?? 0
          if (last > 0) setUnreadBefore(last)
        })
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [convId])

  useEffect(() => {
    const close = (e: MouseEvent) => {
      const el = e.target as Element | null
      if (el && typeof el.closest === 'function' && el.closest('[data-popover]')) return
      setMenu(null)
      setPicker(null)
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [])

  async function toggleReact(msgId: string, emoji: string, superReact = false) {
    try {
      await services.react(convId, msgId, emoji, superReact)
      const r = await services.reactions(msgId)
      setReactions(s => ({ ...s, [msgId]: r }))
    } catch (e: any) { onToast(String(e?.message ?? e)) }
  }

  useEffect(() => {
    if (!convId) return
    const un = services.subscribe((ev: any) => {
      try {
        if (ev?.type !== 'reaction_changed' || ev?.conv_id !== convId) return
        const mid = String(ev?.msg_id ?? '')
        if (!mid) return
        services.reactions(mid)
          .then(r => { setReactions(s => ({ ...s, [mid]: r })) })
          .catch(() => {})
      } catch {  }
    })
    return () => { try { un() } catch {  } }
  }, [convId])

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
  const pickerAnchor = (msgId: string): 'up' | 'down' => {
    try {
      const el = scrollRef.current?.querySelector(`[data-mid="${msgId}"]`)
      const box = el?.getBoundingClientRect()
      if (!box) return 'up'
      const spaceBelow = window.innerHeight - box.bottom
      return spaceBelow < 360 ? 'up' : 'down'
    } catch { return 'up' }
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
        const vistos = mine ? receiptsOf(m) : null
        const statusMostrado = vistos && m.status !== 'ok' ? groupStatus(m.status, vistos) : m.status

        return (
          <React.Fragment key={m.id}>
            {newDay && <DayDivider ts={m.ts} />}
            {showUnread && <UnreadDivider onClick={() => setUnreadBefore(null)} />}
            <div
              data-mid={m.id}
              onContextMenu={e => { e.preventDefault(); setMenu({ id: m.id, x: e.clientX, y: e.clientY }) }}
              className="msg-row"
              style={{ display: 'flex', gap: compact ? 8 : 12, padding: compact ? '2px 8px' : grouped ? '1px 8px' : '8px', borderRadius: 8, marginTop: grouped && !compact ? -6 : 0, position: 'relative' }}
            >
              {compact ? (
                <span style={{ fontSize: 11, color: T_MUTED, fontFamily: 'JetBrains Mono', flexShrink: 0, paddingTop: 2 }}>{fmtClock(m.ts)}</span>
              ) : grouped ? <span style={{ width: 40, flexShrink: 0 }} /> : (
                <span style={{ position: 'relative', flexShrink: 0, cursor: 'pointer' }} onClick={() => onProfile(authorFp)}>
                  <Avatar name={authorName} fp={authorFp} size={40} avatarB64={profiles[authorFp]?.avatar_b64} ring={profiles[authorFp]?.accent || undefined} effect={profiles[authorFp]?.avatar_effect || undefined} accent={profiles[authorFp]?.accent || undefined} />
                  {pres && <PresenceDot status={pres} size={12} ring={T_MAIN} />}
                </span>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                {compact ? (
                  <div style={{ fontSize: 14 * fs, color: T_TEXT, lineHeight: 1.4 }}>
                    <span style={{ fontWeight: 700, color: profiles[authorFp]?.accent || T_HEADING, cursor: 'pointer' }}
                      onClick={() => onProfile(authorFp)}>{authorName}</span>
                    {profiles[authorFp]?.decoration ? (
                      <span aria-hidden="true" style={{ fontSize: 12, marginRight: 4 }}>{profiles[authorFp]?.decoration}</span>
                    ) : null}
                    {!isFile && (
                      <>
                        <span style={{ color: T_MUTED }}>  </span>
                        <span style={{ overflowWrap: 'anywhere' }}><RichText body={body} onMention={onProfile} serverEmojis={emojiMap} /></span>
                      </>
                    )}
                    {meta?.edited_at ? <span style={{ fontSize: 10, color: T_MUTED }}> (editado)</span> : null}
                    {meta?.pinned ? <span title="fixada" style={{ display: 'inline-flex', color: T_MUTED, verticalAlign: 'middle' }}><Icon d={Icons.pin} size={11} /></span> : null}
                    {mine && m.status !== 'ok' && <span style={{ marginLeft: 6 }}><StatusGlyph status={statusMostrado} peerOnline={peerOnline} titulo={vistos ? statusTitleFor(statusMostrado, vistos, peerOnline) : undefined} /></span>}
                  </div>
                ) : !grouped && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 700, fontSize: 14 * fs, color: profiles[authorFp]?.accent || T_HEADING, cursor: 'pointer' }}
                      onClick={() => onProfile(authorFp)}>{authorName}</span>
                    {profiles[authorFp]?.decoration ? (
                      <span aria-hidden="true" title="decoração do perfil" style={{ fontSize: 13, marginLeft: -4 }}>{profiles[authorFp]?.decoration}</span>
                    ) : null}
                    <span style={{ fontSize: 11, color: T_MUTED, fontFamily: 'JetBrains Mono' }}>{authorFp.slice(0, 12)}</span>
                    <span style={{ fontSize: 11, color: T_MUTED }}>{fmtClock(m.ts)}</span>
                    {meta?.edited_at ? <span style={{ fontSize: 10, color: T_MUTED }} title={new Date(meta.edited_at).toLocaleString('pt-BR')}>(editado)</span> : null}
                    {meta?.pinned ? <span title="fixada" style={{ display: 'inline-flex', color: T_MUTED }}><Icon d={Icons.pin} size={11} /></span> : null}
                    {meta?.forwarded_from ? <span style={{ fontSize: 10, color: T_MUTED }}>↪ encaminhada de {meta.forwarded_from}</span> : null}
                    {mine && m.status !== 'ok' && <StatusGlyph status={statusMostrado} peerOnline={peerOnline} titulo={vistos ? statusTitleFor(statusMostrado, vistos, peerOnline) : undefined} />}
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
                      style={{ width: '100%', minHeight: 60, background: T_INPUT, border: `1px solid ${T_BORDER}`, borderRadius: 8, padding: 10, color: T_TEXT, fontSize: 14 * fs, outline: 'none', resize: 'vertical', fontFamily: 'inherit' }} />
                    <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                      <button onClick={() => setEditing(null)} style={BTN_GHOST}>cancelar</button>
                      <button onClick={() => doEdit(m.id)} disabled={!editing.body.trim()} style={{ ...BTN_PRIMARY, opacity: editing.body.trim() ? 1 : 0.5 }}>salvar</button>
                      <span style={{ fontSize: 10, color: T_MUTED, alignSelf: 'center' }}>Enter salva · Esc cancela</span>
                    </div>
                  </div>
                ) : isFile && renderFile ? renderFile(m, grouped) : compact ? null : (
                  <>
                    <div style={{ fontSize: 14 * fs, color: T_TEXT, marginTop: grouped ? 0 : 2 }}>
                      <RichText body={body} onMention={onProfile} serverEmojis={emojiMap} />
                    </div>
                    {wantsUnfurl && <LinkUnfurl body={body} />}
                  </>
                )}

                {
}
                <div style={{ position: 'relative' }} data-popover>
                  {rx.length > 0 && (
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
                      {rx.map(r => (
                        <div key={r.emoji} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                          {}
                          <button
                            onClick={(e) => { if (e.shiftKey) toggleReact(m.id, r.emoji, true); else toggleReact(m.id, r.emoji) }}
                            onContextMenu={(e) => { e.preventDefault(); toggleReact(m.id, r.emoji, true) }}
                            aria-label={`${r.emoji}, ${r.count} reações${(r.super_count ?? 0) > 0 ? `, ${r.super_count} super` : ''}. Clique para alternar a sua; Shift+clique para super`}
                            title={`${r.reactors.length ? r.reactors.join(', ') : ''}${(r.super_count ?? 0) > 0 ? ` · ${r.super_count} super` : ''} — Shift+clique envia super`}
                            className={(r.super_count ?? 0) > 0 ? 'rx-super' : undefined}
                            style={{
                              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13,
                              background: r.mine ? 'rgba(88,101,242,0.22)' : T_INPUT,
                              border: `1px solid ${r.mine ? T_ACCENT : (r.super_count ?? 0) > 0 ? '#ffd93d' : T_BORDER}`,
                              color: r.mine ? '#f2f3f5' : T_TEXT, borderRadius: 8, padding: '3px 8px',
                              cursor: 'pointer', fontWeight: 700,
                            }}
                          >
                            <span style={{ fontSize: 14, filter: (r.super_count ?? 0) > 0 ? 'drop-shadow(0 0 4px #ffd93d)' : undefined }}>{r.emoji}</span>
                            <span style={{ fontSize: 12 }}>{r.count}</span>
                          </button>
                          {}
                          {r.count > 1 && (
                            <button
                              onClick={() => setWhoReagiu(w => w === `${m.id}:${r.emoji}` ? null : `${m.id}:${r.emoji}`)}
                              aria-label={`Ver quem reagiu com ${r.emoji}`}
                              style={{
                                position: 'absolute', right: -9, bottom: 6, width: 18, height: 18,
                                borderRadius: '50%', background: T_SIDEBAR, border: `1px solid ${T_BORDER}`,
                                color: T_MUTED, fontSize: 9, fontWeight: 800, display: 'inline-flex',
                                alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer',
                              }}
                            >?</button>
                          )}
                          {whoReagiu === `${m.id}:${r.emoji}` && (
                            <ReactionWhoPopover
                              r={r as never}
                              resolve={(fp: string) => nameOf(fp)}
                              onClose={() => setWhoReagiu(null)}
                            />
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => setPicker(picker === m.id ? null : m.id)}
                        aria-label="Adicionar reação"
                        style={{ background: T_INPUT, border: `1px solid ${T_BORDER}`, color: T_MUTED, borderRadius: 8, padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
                      ><Icon d={Icons.smile} size={14} /></button>
                    </div>
                  )}

                  {!grouped && rx.length === 0 && (
                    <button
                      onClick={() => setPicker(picker === m.id ? null : m.id)}
                      aria-label="Reagir à mensagem"
                      title="Reagir"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 3,
                        background: 'transparent', border: `1px solid ${T_BORDER}`, color: T_MUTED,
                        borderRadius: 99, padding: '1px 8px 1px 5px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                      }}
                    ><Icon d={Icons.smile} size={12} /> reagir</button>
                  )}

                  {mine && vistos && roster.kind !== 'dm' && (
                    <div style={{ position: 'relative', display: 'inline-flex', marginTop: 3 }}>
                      <button
                        onClick={() => setQuemViu(quemViu === m.id ? null : m.id)}
                        aria-label="Ver quem visualizou"
                        title="Ver quem visualizou"
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          background: quemViu === m.id ? 'rgba(88,101,242,.22)' : 'transparent',
                          border: `1px solid ${T_BORDER}`, color: T_MUTED,
                          borderRadius: 99, padding: '1px 8px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                        }}
                      >⋯</button>
                      {quemViu === m.id && (
                        <ReceiptsPanel
                          view={vistos}
                          headline={receiptsHeadline(vistos)}
                          onClose={() => setQuemViu(null)}
                        />
                      )}
                    </div>
                  )}

                  {picker === m.id && (
                    <EmojiPicker
                      open
                      onClose={() => setPicker(null)}
                      onPick={e2 => { toggleReact(m.id, e2); setPicker(null) }}
                      serverEmojis={emojis}
                      anchor={pickerAnchor(m.id)}
                    />
                  )}
                </div>

                {
}
                {polls.map((p, pi) => {
                  const n = polls.length
                  const anchor = n <= visible.length ? visible.length - 1 - (n - 1 - pi) : visible.length - 1
                  if (idx !== anchor) return null
                  return (
                    <PollCard key={p.id} poll={p} tally={tallies[p.id] ?? { counts: [], total: 0, mine: [] }}
                      communityId={pollChannel?.communityId ?? ''} channelId={pollChannel?.channelId ?? ''}
                      onVote={async (i: number) => {
                        if (!pollChannel) return
                        try {
                          await services.pollVote(pollChannel.communityId, pollChannel.channelId, p.id, i)
                          const t = await services.pollTally(p.id).catch(() => ({ counts: [], total: 0, mine: [] }))
                          setTallies(prev => ({ ...prev, [p.id]: t }))
                        } catch (e: any) { onToast(String(e?.message ?? e)) }
                      }} />
                  )
                })}
              </div>

              {
}
              <div className="msg-tools" style={{ position: 'absolute', top: -14, right: 12, display: 'flex', gap: 2, background: T_MAIN, border: `1px solid ${T_BORDER}`, borderRadius: 8, padding: 2, boxShadow: '0 4px 12px rgba(0,0,0,.4)', zIndex: 5 }}>
                <button title="Reagir" aria-label="Reagir" onClick={e2 => { e2.stopPropagation(); setPicker(picker === m.id ? null : m.id) }} style={{ ...TOOL_BTN, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><Icon d={Icons.smile} size={15} /></button>
                <button title="Responder" onClick={e2 => { e2.stopPropagation(); onReply(m) }} style={{ ...TOOL_BTN, width: 'auto', padding: '0 8px', fontSize: 11, fontWeight: 800 }}>Responder</button>
                <button title="Mais" onClick={e2 => { e2.stopPropagation(); setMenu({ id: m.id, x: e2.clientX, y: e2.clientY }) }} style={TOOL_BTN}>⋯</button>
              </div>
            </div>

            {menu?.id === m.id && (
              <div onClick={e => e.stopPropagation()} style={{
                position: 'fixed', left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 300),
                zIndex: 210, background: T_MAIN, border: `1px solid ${T_BORDER}`, borderRadius: 8, padding: 4,
                boxShadow: '0 12px 34px rgba(0,0,0,.5)', minWidth: 190,
              }}>
              <MenuItem label="Fixar / desafixar" icon={Icons.pin} onClick={() => { doPin(m.id); setMenu(null) }} />
              <MenuItem label="Encaminhar" icon={Icons.externalLink} onClick={() => { onForward(m); setMenu(null) }} />
              <MenuItem label="Criar thread" icon={Icons.hash} onClick={() => { onThread(m); setMenu(null) }} />
              {(mine || meta) && <MenuItem label="Editar" icon={Icons.edit} onClick={() => { setEditing({ id: m.id, body }); setMenu(null) }} />}
              {
}
              {mine && m.status === 'failed' && onResend && (
                <MenuItem label="Reenviar" icon={Icons.refresh} onClick={() => { onResend(m); setMenu(null) }} />
              )}
              {mine && roster.kind !== 'dm' && (
                <MenuItem label="Quem visualizou" icon={Icons.eye} onClick={() => { setQuemViu(m.id); setMenu(null) }} />
              )}
              <MenuItem label="Marcar como não lida" icon={Icons.eye} onClick={() => {
                services.readSet(convId, Math.max(0, m.ts - 1)).catch(() => {})
                setUnreadBefore(m.ts)
                onToast('marcada como não lida')
                setMenu(null)
              }} />
              <MenuItem label="Copiar texto" icon={Icons.copy} onClick={() => { navigator.clipboard?.writeText(body); onToast('copiado'); setMenu(null) }} />
              <MenuItem label="Salvar marcador" icon={Icons.save} onClick={async () => {
                try { await services.bookmarkSet(convId, body.slice(0, 24) || 'mensagem', m.id); onToast('marcador salvo') } catch (e: any) { onToast(String(e?.message ?? e)) }
                setMenu(null)
              }} />
              {!mine && (
                <MenuItem label="Denunciar" icon={Icons.warn} danger onClick={async () => {
                  try {
                    await services.reportUser(authorFp, undefined, `Mensagem: ${body.slice(0, 80)}`)
                    onToast('denunciada')
                  } catch (e: any) { onToast(String(e?.message ?? e)) }
                  setMenu(null)
                }} />
              )}
              <MenuItem label="Apagar" icon={Icons.trash} danger onClick={() => { doDelete(m.id); setMenu(null) }} />
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
})

export default MessageList

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

function MenuItem({ label, icon, onClick, danger }: { label: string; icon?: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'transparent', border: 'none',
      color: danger ? '#ff9c9c' : T_TEXT, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
      fontSize: 12.5, fontWeight: 600,
    }} onMouseEnter={e => (e.currentTarget.style.background = T_INPUT)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
      {icon ? <span style={{ display: 'flex', color: danger ? '#ff9c9c' : T_MUTED }}><Icon d={icon} size={14} /></span> : null}{label}
    </button>
  )
}

function StatusGlyph({ status, peerOnline, titulo }: { status: string; peerOnline?: boolean; titulo?: string }) {
  const g = statusGlyph(status)
  if (!g) return null
  const cor =
    status === 'read' ? '#53bdeb'
    : status === 'failed' ? '#ff9c9c'
    : T_MUTED
  return (
    <span
      title={titulo ?? statusTitle(status, peerOnline)}
      style={{ fontSize: 11, color: cor, fontFamily: 'monospace', fontWeight: 700, letterSpacing: -2 }}
    >
      {g}
    </span>
  )
}

function emptyMeta(id: string, convId: string): MsgMetaView {
  return { msg_id: id, conv_id: convId, reply_to: '', forwarded_from: '', edited_body: '', edited_at: 0, deleted: false, pinned: false, pinned_by: '', pinned_at: 0, mentioned: false }
}

const T_MAIN = '#313338'
const T_INPUT = '#1e1f22'
const T_BORDER = '#3f4147'
const T_TEXT = '#dbdee1'
const T_HEADING = '#f2f3f5'
const T_MUTED = '#949ba4'
const T_ACCENT = '#5865f2'
const T_SIDEBAR = '#2b2d31'
const BTN_PRIMARY: React.CSSProperties = { background: T_HEADING, color: '#1e1f22', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 800, fontSize: 12 }
const BTN_GHOST: React.CSSProperties = { background: 'transparent', color: T_MUTED, border: `1px solid ${T_BORDER}`, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 12 }
const TOOL_BTN: React.CSSProperties = { background: 'transparent', border: 'none', color: T_TEXT, cursor: 'pointer', fontSize: 14, width: 28, height: 26, borderRadius: 4 }
