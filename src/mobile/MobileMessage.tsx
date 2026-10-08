// Linha de mensagem do shell MOBILE com a camada social completa (paridade
// Discord): resposta inline, markdown/spoiler/links, reações, editar, apagar,
// fixar, encaminhar, copiar, denunciar, preview de arquivo e edição no lugar.
//
// Toque longo (500ms) ou botão "..." abre a folha de ações; tocar em uma
// reação alterna (o motor valida e difunde). Tudo passa por `services`.

import { memo, useEffect, useRef, useState } from 'react'
import type { MsgMetaView, ReactionSummary, StoredMessage } from '../services/models'
import { Icon, Icons } from '../shared/icons'
import { RichText, type InlineCtx } from '../shared/richText'
import { EmojiPicker } from '../shared/EmojiPicker'
import { QUICK_REACTIONS } from '../shared/emojiSet'
import { ReactionWhoPopover, LinkUnfurl } from '../components/social/Social'
import { FILE_PREFIX } from '../services/fileSwarm'

const T = {
  rail: '#1e1f22', sidebar: '#2b2d31', main: '#313338', composer: '#383a40',
  input: '#1e1f22', hover: '#35373c', selected: '#404249', border: '#26272b',
  panel: '#2b2d31', accent: '#5865f2', green: '#23a559', yellow: '#f0b232',
  red: '#f23f42', text: '#dbdee1', heading: '#f2f3f5', muted: '#949ba4',
  mentionBg: 'rgba(240,178,50,0.08)',
}
const MONO = 'JetBrains Mono, monospace'

export function avatarColor(fp: string): string {
  const palette = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc']
  let h = 0
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

function Avatar({ name, fp, size = 36, avatarB64, accent }: {
  name: string
  fp: string
  size?: number
  avatarB64?: string
  /** cor de destaque do perfil (personalização do usuário, paridade Discord). */
  accent?: string
}) {
  const [err, setErr] = useState(false)
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  const ring = accent ? `2px solid ${accent}` : undefined
  // Avatar salvo pelo usuário tem precedência sobre a cor gerada por fp.
  if (avatarB64 && !err) {
    return (
      <img src={`data:image/png;base64,${avatarB64}`} onError={() => setErr(true)} alt={name}
        style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0, border: ring }} />
    )
  }
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: accent || avatarColor(fp), color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: size * 0.42, flexShrink: 0, border: ring }}>
      {initial}
    </span>
  )
}

export interface MobileMessageProps {
  m: StoredMessage
  mine: boolean
  authorName: string
  authorFp: string
  /** avatar salvo no perfil (paridade Discord: respeita upload do usuário). */
  authorAvatar?: string
  /** cor de destaque do perfil, aplicada em avatar e nome. */
  authorAccent?: string
  /** corpo efetivo (edição aplicada pelo motor) */
  body: string
  meta: MsgMetaView | undefined
  reactions: ReactionSummary[]
  grouped: boolean
  ctx: InlineCtx
  /** fp → nome, para o popover "quem reagiu" no chip de reação. */
  resolveName?: (fp: string) => string
  /** mensagem citada (para o preview da resposta) */
  replyTo: { name: string; body: string } | null
  onJumpToReply?: (msgId: string) => void
  onReact: (emoji: string) => void
  onEdit: (body: string) => void
  onDelete: () => void
  onPin: () => void
  onReply: () => void
  onCopy: () => void
  onReport: () => void
  onForward: () => void
  onOpenThread?: () => void
  onOpenProfile?: (fp: string) => void
  isBot?: boolean
  botName?: string
  highlighted?: boolean
  renderFile?: (m: StoredMessage) => React.ReactNode
  fontSize?: number
}

  type SheetAction = { id: string; label: string; icon?: string; svg?: string; danger?: boolean }

const MobileMessage = memo(function MobileMessage(props: MobileMessageProps) {
  const {
    m, mine, authorName, authorFp, authorAvatar, authorAccent, body, meta, reactions, grouped, ctx,
    replyTo, onJumpToReply, onReact, onEdit, onDelete, onPin, onReply, onCopy,
    onReport, onForward, onOpenThread, onOpenProfile, isBot, botName, highlighted,
    renderFile, resolveName, fontSize,
  } = props
  const fs = fontSize && fontSize > 0 ? fontSize : 15

  const [whoEmoji, setWhoEmoji] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(body)
  const [sheet, setSheet] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  // Mensagem de arquivo tem TEXTO no corpo (o marker __FORGE_FILE__:base64).
  // Checar `!body` nunca era verdadeiro, entao o card nunca aparecia e o
  // RichText imprimia o marker cru. Detecta pelo prefixo, como o desktop.
  const isFile = !!renderFile && body.startsWith(FILE_PREFIX)
  const deleted = !!meta?.deleted
  const edited = !!meta?.edited_at && !deleted

  useEffect(() => { setDraft(body) }, [body])
  useEffect(() => { if (editing) setTimeout(() => textareaRef.current?.focus(), 40) }, [editing])

  const startPress = () => {
    pressTimer.current = setTimeout(() => setSheet(true), 480)
  }
  const cancelPress = () => {
    if (pressTimer.current) { clearTimeout(pressTimer.current); pressTimer.current = null }
  }

  if (deleted) {
    return (
      <div style={{ display: 'flex', gap: 10, padding: '4px 6px', opacity: 0.62 }}>
        <Avatar name={authorName} fp={authorFp} size={28} />
        <div style={{ fontSize: 13, color: T.muted, fontStyle: 'italic', paddingTop: 4 }}>
          <span style={{ fontWeight: 600, color: T.muted }}>{authorName}</span>: esta mensagem foi apagada
        </div>
      </div>
    )
  }

  const actions: SheetAction[] = [
    ...QUICK_REACTIONS.slice(0, 4).map((e) => ({ id: `react:${e}`, label: e })),
    { id: 'react-more', label: 'Mais reações', svg: Icons.smile },
    { id: 'reply', label: 'Responder', svg: Icons.send },
    ...(mine ? [{ id: 'edit', label: 'Editar', svg: Icons.edit }] : []),
    { id: 'copy', label: 'Copiar texto', svg: Icons.copy },
    { id: 'pin', label: meta?.pinned ? 'Desafixar' : 'Fixar mensagem', svg: Icons.pin },
    { id: 'forward', label: 'Encaminhar', svg: Icons.externalLink },
    ...(mine ? [] : [{ id: 'report', label: 'Denunciar', svg: Icons.warn, danger: true }]),
    { id: 'delete', label: 'Apagar', svg: Icons.trash, danger: true },
  ]

  const runAction = (id: string) => {
    if (id.startsWith('react:')) { onReact(id.slice(6)); setSheet(false); return }
    setSheet(false)
    switch (id) {
      case 'react-more': setEmojiOpen((v) => !v); break
      case 'reply': onReply(); break
      case 'edit': setEditing(true); break
      case 'copy': onCopy(); break
      case 'pin': onPin(); break
      case 'forward': onForward(); break
      case 'report': onReport(); break
      case 'delete': onDelete(); break
    }
  }

  return (
    <div
      onContextMenu={(e) => { e.preventDefault(); setSheet(true) }}
      onTouchStart={startPress}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
      style={{
        display: 'flex', gap: 10, padding: grouped ? '2px 6px' : '6px',
        borderRadius: 8, background: highlighted ? T.mentionBg : 'transparent',
        boxShadow: meta?.pinned ? 'inset 0 0 0 1px rgba(240,178,50,0.35)' : 'none',
      }}
    >
      {grouped ? <span style={{ width: 36, flexShrink: 0 }} /> : <Avatar name={authorName} fp={authorFp} size={36} avatarB64={authorAvatar} accent={authorAccent} />}
      <div style={{ flex: 1, minWidth: 0 }}>
        {!grouped && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <button
              onClick={() => onOpenProfile?.(authorFp)}
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: onOpenProfile ? 'pointer' : 'default' }}
            >
              <span style={{ fontWeight: 700, fontSize: Math.round(fs * 0.93), color: isBot ? T.accent : (authorAccent || T.heading) }}>{botName ?? authorName}</span>
            </button>
            {isBot && <span style={{ fontSize: 9, background: T.accent, color: '#fff', padding: '1px 4px', borderRadius: 4, fontWeight: 800 }}>BOT</span>}
            <span style={{ fontSize: 10, color: T.muted, fontFamily: MONO }}>{authorFp.slice(0, 8)}</span>
            <span style={{ fontSize: 11, color: T.muted }}>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        )}

        {meta?.forwarded_from && (
          <div style={{ fontSize: 11, color: T.muted, margin: '2px 0 2px', fontStyle: 'italic' }}>
            ↪ encaminhado de {meta.forwarded_from}
          </div>
        )}

        {replyTo && (
          <button
            onClick={() => onJumpToReply?.(meta?.reply_to ?? '')}
            style={{
              display: 'flex', flexDirection: 'column', gap: 1, alignItems: 'flex-start',
              background: T.input, border: 'none', borderLeft: `3px solid ${T.accent}`,
              borderRadius: 4, padding: '4px 8px', margin: '3px 0 4px', maxWidth: '100%',
              cursor: onJumpToReply ? 'pointer' : 'default', textAlign: 'left',
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 800, color: T.heading }}>{replyTo.name}</span>
            <span style={{ fontSize: 11, color: T.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' }}>{replyTo.body || 'anexo'}</span>
          </button>
        )}

        {editing ? (
          <div style={{ margin: '4px 0' }}>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              aria-label="Editar mensagem"
              style={{
                width: '100%', boxSizing: 'border-box', background: T.input, color: T.text,
                border: `1px solid ${T.accent}`, borderRadius: 8, padding: 8, fontSize: 15,
                fontFamily: 'Inter, sans-serif', resize: 'vertical', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6, justifyContent: 'flex-end' }}>
              <button onClick={() => { setEditing(false); setDraft(body) }} style={{ background: 'transparent', color: T.muted, border: 'none', padding: '6px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>cancelar</button>
              <button
                onClick={() => {
                  const v = draft.trim()
                  setEditing(false)
                  if (v && v !== body) onEdit(v)
                }}
                style={{ background: T.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12, fontWeight: 800, cursor: 'pointer' }}
              >salvar</button>
            </div>
            <div style={{ fontSize: 10, color: T.muted, marginTop: 4 }}>Esc cancela · Ctrl+Enter salva</div>
          </div>
        ) : isFile ? (
          renderFile!(m)
        ) : (
          <div onDoubleClick={() => { if (mine) onReply() }}>
            <RichText body={body} ctx={ctx} color={T.text} fontSize={fs} />
            {edited && <span style={{ fontSize: 10, color: T.muted, marginLeft: 4 }} title={new Date(meta!.edited_at).toLocaleString()}>(editado)</span>}
          </div>
        )}

        {/* Preview de link — paridade com o desktop (que usa LinkUnfurl). */}
        {!editing && !deleted && <LinkUnfurl body={body} />}

        {onOpenThread && (
          <button
            onClick={onOpenThread}
            style={{ marginTop: 6, background: T.input, color: T.text, border: `1px solid ${T.border}`, borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 5 }}
          >
            <Icon d={Icons.hash} size={12} /> Discussão
          </button>
        )}

        {reactions.length > 0 && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
            {reactions.map((r) => (
              <div key={r.emoji} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                {/* toque = alterna a MINHA reação (como o Discord) */}
                <button
                  onClick={() => onReact(r.emoji)}
                  aria-label={`${r.emoji}, ${r.count} reações. Toque para alternar a sua`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13,
                    background: r.mine ? 'rgba(88,101,242,0.22)' : T.input,
                    border: `1px solid ${r.mine ? T.accent : T.border}`,
                    color: r.mine ? T.heading : T.text, borderRadius: 8, padding: '3px 8px',
                    cursor: 'pointer', fontWeight: 700,
                  }}
                >
                  <span style={{ fontSize: 14 }}>{r.emoji}</span>
                  <span style={{ fontSize: 12 }}>{r.count}</span>
                </button>
                {/* com 2+ pessoas, o separador mostra QUEM reagiu */}
                {r.count > 1 && resolveName && (
                  <button
                    onClick={() => setWhoEmoji(w => w === r.emoji ? null : r.emoji)}
                    aria-label={`Ver quem reagiu com ${r.emoji}`}
                    style={{
                      position: 'absolute', right: -9, bottom: 6, width: 18, height: 18,
                      borderRadius: '50%', background: T.rail, border: `1px solid ${T.border}`,
                      color: T.muted, fontSize: 9, fontWeight: 800, display: 'inline-flex',
                      alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer',
                    }}
                  >?</button>
                )}
                {whoEmoji === r.emoji && resolveName && (
                  <ReactionWhoPopover r={r} resolve={resolveName} onClose={() => setWhoEmoji(null)} />
                )}
              </div>
            ))}
            <button
              onClick={() => setEmojiOpen((v) => !v)}
              aria-label="Adicionar reação"
              style={{ background: T.input, border: `1px solid ${T.border}`, color: T.muted, borderRadius: 8, padding: '3px 8px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center' }}
            ><Icon d={Icons.smile} size={14} /></button>
          </div>
        )}

        {!grouped && reactions.length === 0 && (
          <button
            onClick={() => setEmojiOpen((v) => !v)}
            aria-label="Reagir à mensagem"
            title="Reagir"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 3,
              background: 'transparent', border: `1px solid ${T.border}`, color: T.muted,
              borderRadius: 99, padding: '1px 8px 1px 5px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
            }}
          ><Icon d={Icons.smile} size={12} /> reagir</button>
        )}

        <div style={{ position: 'relative' }}>
          {emojiOpen && (
            <EmojiPicker
              open
              onClose={() => setEmojiOpen(false)}
              onPick={(e) => { onReact(e); setEmojiOpen(false) }}
              serverEmojis={[]}
              anchor="up"
            />
          )}
        </div>
      </div>

      <button
        onClick={() => setSheet(true)}
        aria-label="Ações da mensagem"
        style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', alignSelf: 'flex-start', padding: 4, display: 'flex' }}
      >
        <span style={{ fontSize: 16, lineHeight: 1 }}>⋯</span>
      </button>

      {sheet && (
        <div
          onClick={() => setSheet(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,.55)', display: 'flex', alignItems: 'flex-end' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Ações da mensagem"
            style={{ width: '100%', background: T.panel, borderTop: `1px solid ${T.border}`, borderRadius: 16, padding: 10, paddingBottom: 'calc(14px + env(safe-area-inset-bottom))' }}
          >
            <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 8, borderBottom: `1px solid ${T.border}`, marginBottom: 6 }}>
              {[...QUICK_REACTIONS, '👍🏿', '🎉', '😎'].map((e) => (
                <button
                  key={e}
                  onClick={() => runAction(`react:${e}`)}
                  style={{ background: T.input, border: `1px solid ${T.border}`, borderRadius: 99, width: 44, height: 44, fontSize: 22, cursor: 'pointer', flexShrink: 0 }}
                >{e}</button>
              ))}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {actions.filter((a) => !a.id.startsWith('react:')).map((a) => (
                <button
                  key={a.id}
                  onClick={() => runAction(a.id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6, background: T.input,
                    color: a.danger ? '#ff9c9c' : T.text, border: `1px solid ${T.border}`,
                    borderRadius: 8, padding: '9px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                  }}
                >{a.svg ? <span style={{ display: 'flex', color: a.danger ? '#ff9c9c' : T.muted }}><Icon d={a.svg} size={14} /></span> : (a.icon ? <span>{a.icon}</span> : null)}{a.label}</button>
              ))}
            </div>
            <button onClick={() => setSheet(false)} style={{ width: '100%', marginTop: 8, background: 'transparent', color: T.muted, border: 'none', padding: 10, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>cancelar</button>
          </div>
        </div>
      )}
    </div>
  )
})

export default MobileMessage
