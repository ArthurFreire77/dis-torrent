// Seção recolhível + "ver mais" — anti-poluição de tela (pedido do dono):
// listas longas não despejam tudo de uma vez; cada bloco tem cabeçalho
// clicável (recolhe/expande) e, quando passa do limite, um botão "ver mais".

import { Children, ReactNode, useState } from 'react'
import { Icon, Icons } from './icons'

export interface SectionProps {
  title: ReactNode
  /** aberta por padrão? (default: true) */
  defaultOpen?: boolean
  /** quantos itens mostrar antes do "ver mais" (0 = sempre tudo) */
  maxVisible?: number
  /** recolhida ocupa menos espaço? (oculta o corpo inteiro) */
  collapsible?: boolean
  /** escondido atrás de "ver mais" (contagem opcional) */
  hiddenCount?: number
  children: ReactNode
  /** estilos do shell (desktop usa paleta própria, mobile a `T`) */
  variant: 'desktop' | 'mobile'
  /** conteúdo extra à direita do título (badge, botão "+") */
  actions?: ReactNode
}

export function Section({
  title,
  defaultOpen = true,
  maxVisible = 0,
  collapsible = true,
  hiddenCount,
  children,
  variant,
  actions,
}: SectionProps) {
  const [open, setOpen] = useState(defaultOpen)
  const [expanded, setExpanded] = useState(false)
  const muted = variant === 'desktop' ? '#949ba4' : '#8e929b'
  const accent = '#5865f2'
  const arr = Children.toArray(children)
  const items = maxVisible > 0 && !expanded ? arr.slice(0, maxVisible) : arr
  const total = arr.length
  const restantes = total - items.length
  return (
    <>
      <button
        type="button"
        onClick={() => collapsible && setOpen(v => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
          background: 'transparent', border: 'none', padding: variant === 'desktop' ? '2px 8px' : '2px 0',
          cursor: collapsible ? 'pointer' : 'default', marginTop: variant === 'desktop' ? 16 : 0,
          color: muted, flexShrink: 0,
        }}
      >
        {collapsible && (
          <span style={{ display: 'flex', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}>
            <Icon d={Icons.chevron} size={10} />
          </span>
        )}
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
          {title}
        </span>
        {actions}
      </button>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6 }}>
          {items}
          {(restantes > 0 || (hiddenCount ?? 0) > 0) && (
            <button
              type="button"
              onClick={() => setExpanded(v => !v)}
              style={{
                background: 'transparent', border: 'none', color: accent, cursor: 'pointer',
                fontSize: 12, fontWeight: 700, textAlign: 'left', padding: '6px 8px', borderRadius: 6,
              }}
            >
              {expanded ? 'ver menos' : `ver mais${restantes > 0 ? ` (${restantes})` : (hiddenCount ? ` (${hiddenCount})` : '')}`}
            </button>
          )}
        </div>
      )}
    </>
  )
}
