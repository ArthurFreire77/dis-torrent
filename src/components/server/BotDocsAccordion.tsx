import { useState } from 'react'
import { Ic } from '../../shared/icons'
import { ui } from '../../shared/ui'
import { BOT_DOCS } from './botDocs'
import { layout } from './wizardStyles'

/**
 * Acordeão das seções de ajuda. Cada tópico abre um por vez para o texto longo
 * não empurrar os botões do painel para fora da tela.
 */
export function BotDocsAccordion({ initial }: { initial?: string | null }) {
  const [aberto, setAberto] = useState<string | null>(initial ?? null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 11.5,
          color: ui.muted,
          lineHeight: 1.5,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <Ic name="info" size={12} />
        Toque num tópico para abrir. Comece por “Primeiros 2 minutos” se nunca criou um bot.
      </div>
      {BOT_DOCS.map((doc, index) => {
        const open = aberto === doc.title
        const id = `bot-doc-${index}`
        return (
          <div key={doc.title} style={layout.docCard(open)}>
            <button
              type="button"
              onClick={() => setAberto(open ? null : doc.title)}
              aria-expanded={open}
              aria-controls={id}
              aria-label={`${doc.title} — ${open ? 'recolher' : 'abrir'}`}
              style={layout.docHead}
            >
              <span style={{ display: 'flex', flexShrink: 0, color: doc.tone === 'warn' ? ui.warning : ui.accent }}>
                <Ic name={doc.tone === 'warn' ? 'warn' : 'info'} size={13} />
              </span>
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left', fontSize: 12, fontWeight: 800, color: ui.heading }}>
                {doc.title}
              </span>
              <span style={{ display: 'flex', transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .15s' }}>
                <Ic name="chevronRight" size={12} />
              </span>
            </button>
            {open && (
              <div id={id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 12px 12px 33px' }}>
                {doc.lines.map((line, li) => (
                  <div key={li} style={{ fontSize: 11.5, color: ui.text, lineHeight: 1.6 }}>
                    {line}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
