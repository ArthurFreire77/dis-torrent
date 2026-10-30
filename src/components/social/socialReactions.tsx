// Reações: barra, popover de quem reagiu e seletor.
//
// Extraído de `Social.tsx` (que tinha 1508 linhas e 27 exports) por
// `scripts/split-social.mjs`. O conteúdo é o MESMO — a divisão é só de
// responsabilidade: um arquivo por assunto, para achar e revisar sem rolar
// 1,5 mil linhas. `Social.tsx` continua reexportando tudo, então nenhum
// importador precisou mudar.

import React, { useEffect, useRef, useState } from 'react'
import { Ic } from '../../shared/icons'
import { T } from './socialTheme'
import { EmojiPicker } from '../../shared/EmojiPicker'
import type { EmojiView, ReactionSummary } from '../../services/models'

export type ReactorNameFn = (fp: string) => string

/**
 * Popover "quem reagiu" — o Discord abre a lista ao passar/clicar no chip.
 * Sem isto o contador ficava opaco e o usuário não sabia quem reagiu.
 * `resolve` devolve o nome bonito; cai no fp curto quando não há mapping.
 */
export function ReactionWhoPopover({ r, resolve, onClose }: {
  r: ReactionSummary
  resolve: ReactorNameFn
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [onClose])
  const names = r.reactors.map(resolve)
  return (
    <div ref={ref} style={{
      position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 60,
      background: T.rail, border: `1px solid ${T.border}`, borderRadius: 8, padding: 8,
      boxShadow: '0 10px 30px rgba(0,0,0,.55)', minWidth: 170, maxWidth: 260,
    }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: .6, color: T.muted, marginBottom: 6, textTransform: 'uppercase' }}>
        {r.emoji} · {r.count} {r.count === 1 ? 'reação' : 'reações'}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto' }}>
        {names.map((n, i) => (
          <div key={r.reactors[i] + i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.text }}>
            <span style={{ width: 16, height: 16, borderRadius: '50%', background: T.accent, color: '#fff', fontSize: 9, fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {n.slice(0, 1).toUpperCase()}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{n}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function ReactionBar({ reactions, onToggle, onHoverList, resolveName, onAdd }: {
  reactions: ReactionSummary[]
  onToggle: (emoji: string) => void
  /** clique simples já alterna; este callback lista quem reagiu (opcional). */
  onHoverList?: (r: ReactionSummary) => void
  /** fp → nome bonito, para o popover "quem reagiu". */
  resolveName?: ReactorNameFn
  /** ícone "+" ao lado das pílulas — mesmo botão de reação do app mobile. */
  onAdd?: () => void
}) {
  const [who, setWho] = useState<{ emoji: string; r: ReactionSummary } | null>(null)
  if (reactions.length === 0) return null
  const shown = who ? reactions.find(r => r.emoji === who.emoji) ?? null : null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
      {reactions.map((r) => (
        <div key={r.emoji} style={{ position: 'relative' }}>
          <button
            onClick={() => onToggle(r.emoji)}
            onMouseEnter={() => { setWho({ emoji: r.emoji, r }); onHoverList?.(r) }}
            title={`${r.count} · ${r.reactors.join(', ')}`}
            aria-label={`${r.emoji}, ${r.count} reações. Ver quem reagiu`}
            style={{
              display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 8,
              background: r.mine ? 'rgba(88,101,242,.25)' : T.input,
              border: `1px solid ${r.mine ? T.accent : 'transparent'}`,
              color: T.text, cursor: 'pointer', fontSize: 12.5, fontWeight: 700,
            }}>
            <span style={{ fontSize: 15 }}>{r.emoji}</span>
            <span style={{ color: r.mine ? '#c9cdfb' : T.muted }}>{r.count}</span>
          </button>
          {shown && resolveName && (
            <ReactionWhoPopover r={shown} resolve={resolveName} onClose={() => setWho(null)} />
          )}
        </div>
      ))}
      {onAdd && (
        <button
          onClick={onAdd}
          aria-label="Adicionar reação"
          title="Adicionar reação"
          style={{
            background: T.input, border: '1px solid transparent', color: T.muted,
            borderRadius: 8, padding: '3px 8px', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center',
          }}
        ><Ic name="smile" size={14} color={T.muted} /></button>
      )}
    </div>
  )
}

/**
 * Seletor de reações do DESKTOP.
 *
 * Antes era um painel próprio do desktop: 8 "reações rápidas" + uma parede de
 * emojis Unicode sem busca e sem categorias, em 250px fixos. O Android já usava
 * o `EmojiPicker` compartilhado (busca, abas, recentes, emojis do servidor), e a
 * diferença entre as duas plataformas era exatamente o que o usuário via como
 * "a reação do PC é uma merda".
 *
 * Agora as duas usam o MESMO componente. `ReactionPicker` continua existindo
 * como fachada para não mexer em quem já o importa (`MessageList`).
 */
export function ReactionPicker({ onPick, customEmojis, onClose, placement = 'up' }: {
  onPick: (e: string) => void
  customEmojis?: EmojiView[]
  onClose: () => void
  /** Onde o painel abre em relação ao ponto de ancoragem. */
  placement?: 'up' | 'down'
}) {
  return (
    <div className="reaction-picker" data-popover>
      <EmojiPicker
        open
        onClose={onClose}
        onPick={(e) => { onPick(e); onClose() }}
        serverEmojis={customEmojis}
        anchor={placement}
        title="reações rápidas"
      />
    </div>
  )
}

/** Cabeçalho de seção dos painéis de emoji (formulário de emoji do servidor). */
