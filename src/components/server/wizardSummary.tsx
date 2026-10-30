// Resumo lateral do assistente: prévia do servidor + canais/cargos/regras.
//
// Existia dentro do JSX do wizard (1176→1191) e recalculava `validosCount` no
// meio da renderização. Aqui recebe tudo pronto e só desenha.

import { Ic, type IconName } from '../../shared/icons'
import { ui } from '../../shared/ui'
import { KIND_ICON, type RolePreset, type WizardChannel } from './wizardModel'

function SideBox({ icon, title, children }: { icon: IconName; title: string; children: React.ReactNode }) {
  return (
    <div className="csw-side-box">
      <div className="csw-side-t">
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
    <aside className="csw-side" aria-label="Resumo do servidor">
      <div className="csw-prev">
        <span className="csw-prev-ic">
          <Ic name={iconId} size={20} />
        </span>
        <span className="csw-prev-body">
          <span className="csw-prev-n">{name.trim() || 'Sem nome ainda'}</span>
          <span className="csw-prev-d">{description.trim() || 'Sem descrição'}</span>
        </span>
      </div>

      <SideBox icon="hash" title="Canais">
        <div className="csw-list">
          {channels.length === 0 && <div className="csw-empty">nenhum</div>}
          {channels.map((c, i) => (
            <div key={i} className="csw-li">
              <span className="csw-li-i">
                <Ic name={KIND_ICON[c.kind]} size={13} />
              </span>
              <span style={{ color: channelErrors[i] ? '#ff9c9c' : undefined }}>
                {c.name || '(sem nome)'}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 9, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className="csw-tag">{canaisTexto} texto</span>
          {canaisVoz > 0 && <span className="csw-tag">{canaisVoz} voz</span>}
        </div>
      </SideBox>

      <SideBox icon="shield" title="Cargos">
        {cargosAtivos.length === 0 ? (
          <div className="csw-empty">nenhum cargo marcado</div>
        ) : (
          <div className="csw-list">
            {cargosAtivos.map((r) => (
              <div key={r.key} className="csw-li">
                <span className="csw-role-dot" style={{ background: r.color }} />
                <span>{r.name.trim() || r.key}</span>
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
          <div className="csw-empty">nenhuma — opcional</div>
        )}
      </SideBox>
    </aside>
  )
}
