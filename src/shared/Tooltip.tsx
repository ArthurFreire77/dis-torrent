// Tooltip para ações cujo efeito não é óbvio pelo ícone sozinho.
//
// Requisitos queguiamos:
//   - não ocupa espaço permanente: só existe no hover/focus;
//   - some ao sair, sem "fantasma" preso na tela;
//   - funciona por TECLADO (o foco dispara igual ao hover) — um botão só com
//     ícone que nunca recebeu foco não pode ser o único caminho;
//   - some para leitor de tela? Não. O texto do tooltip entra como
//     `aria-describedby` do alvo, e o `aria-label` do botão continua sendo a
//     fonte da ação. O tooltip é decorativo visualmente e informativo para o
//     leitor, porque repetir a mesma frase nos dois é pior que omitir um.

import { useId, useRef, useState, type ReactNode } from 'react'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  /** O que o tooltip diz. Curto: "Gerenciar canais", não uma frase. */
  label: string
  children: ReactNode
  side?: TooltipSide
  /** Some no mobile: toque não tem hover e o tooltip vira barulho visual. */
  desktopOnly?: boolean
}

/**
 * Envolve QUALQUER elemento (botão, link, ícone). Não interfere no clique: o
 * clone recebe os handlers do filho preservados.
 */
export function Tooltip({ label, children, side = 'top', desktopOnly = true }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  function show() {
    // Pequeno atraso: evita o tooltip piscar quando o ponteiro só "passa"
    // pelo elemento going de um card para outro.
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), 220)
  }
  function hide() {
    if (timer.current) clearTimeout(timer.current)
    setOpen(false)
  }

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex' }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={hide}
      // `aria-describedby` no wrapper não é lido como descrição do botão; o
      // alvo é quem precisa. Por isso o id é exposto para o filho linkar.
      data-tooltip={id}
    >
      <span aria-describedby={open ? id : undefined} style={{ display: 'inline-flex' }}>
        {children}
      </span>
      {open && (
        <span
          id={id}
          role="tooltip"
          style={{
            position: 'absolute',
            zIndex: 200,
            pointerEvents: 'none',
            maxWidth: 260,
            width: 'max-content',
            whiteSpace: 'normal',
            background: '#111214',
            color: '#f2f3f5',
            border: '1px solid #2b2d31',
            borderRadius: 6,
            padding: '6px 9px',
            fontSize: 12,
            fontWeight: 600,
            lineHeight: 1.35,
            boxShadow: '0 6px 18px rgba(0,0,0,.45)',
            ...SIDE_STYLE[side],
          }}
          className={desktopOnly ? 'tooltip-desktop-only' : undefined}
        >
          {label}
        </span>
      )}
    </span>
  )
}

const SIDE_STYLE: Record<TooltipSide, React.CSSProperties> = {
  top: { bottom: '100%', left: '50%', transform: 'translate(-50%, -8px)' },
  bottom: { top: '100%', left: '50%', transform: 'translate(-50%, 8px)' },
  right: { left: '100%', top: '50%', transform: 'translate(8px, -50%)' },
  left: { right: '100%', top: '50%', transform: 'translate(-8px, -50%)' },
}