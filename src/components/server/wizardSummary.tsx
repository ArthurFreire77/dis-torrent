// Resumo lateral do assistente: prévia do servidor + canais/cargos/regras.
//
// Layout vem de `layout` (inline) — o resumo é a única confirmação do que está
// sendo criado, então ele não pode colapsar quando a folha de estilo não carrega.

import { Ic, type IconName } from '../../shared/icons'
import { ui } from '../../shared/ui'
import { layout } from './wizardStyles'
import { KIND_ICON, type RolePreset, type WizardChannel } from './wizardModel'

function SideBox({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <div style={layout.sideBox}>
      <div style={layout.sideTitle}>
        <Ic name={icon} size={12} />
        {title}
      </div>
      {children}
    </div>
  )
}

export function WizardSummary({
  iconId,
  name,
  description,
  channels,
  channelErrors,
  canaisTexto,
  canaisVoz,
  cargosAtivos,
  rulesText,
}: {
  iconId: IconName
  name: string
  description: string
  channels: WizardChannel[]
  channelErrors: (string | null)[]
  canaisTexto: number
  canaisVoz: number
  cargosAtivos: RolePreset[]
  rulesText: string
}) {
  return (
    <aside className="csw-side" style={layout.side} aria-label="Resumo do servidor">
      <div style={layout.prev}>
        <span style={layout.prevIcon}>
          <Ic name={iconId} size={20} />
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={layout.prevName}>{name.trim() || 'Sem nome ainda'}</span>
          <span style={layout.prevDesc}>{description.trim() || 'Sem descrição'}</span>
        </span>
      </div>

      <SideBox icon="hash" title="Canais">
        <div style={layout.list}>
          {channels.length === 0 && <div style={layout.empty}>nenhum</div>}
          {channels.map((c, i) => (
            <div key={i} style={layout.listItem}>
              <span style={layout.listIcon}>
                <Ic name={KIND_ICON[c.kind]} size={13} />
              </span>
              <span style={{ ...layout.ellipsis, color: channelErrors[i] ? '#ff9c9c' : undefined }}>
                {c.name || '(sem nome)'}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 9, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={layout.tag}>{canaisTexto} texto</span>
          {canaisVoz > 0 && <span style={layout.tag}>{canaisVoz} voz</span>}
        </div>
      </SideBox>

      <SideBox icon="shield" title="Cargos">
        {cargosAtivos.length === 0 ? (
          <div style={layout.empty}>nenhum cargo marcado</div>
        ) : (
          <div style={layout.list}>
            {cargosAtivos.map((r) => (
              <div key={r.key} style={layout.listItem}>
                <span style={layout.roleDot(r.color)} />
                <span style={layout.ellipsis}>{r.name.trim() || r.key}</span>
              </div>
            ))}
          </div>
        )}
      </SideBox>

      <SideBox icon="file" title="Regras">
        {rulesText.trim() ? (
          <div
            style={{
              fontSize: 12,
              color: ui.text,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              maxHeight: 88,
              overflowY: 'auto',
            }}
          >
            {rulesText.trim()}
          </div>
        ) : (
          <div style={layout.empty}>nenhuma — opcional</div>
        )}
      </SideBox>
    </aside>
  )
}
