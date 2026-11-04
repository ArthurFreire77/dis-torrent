import { Ic, type IconName } from '../../shared/icons'
import { Notice, TextArea, TextField, ui } from '../../shared/ui'
import { layout } from './wizardStyles'
import {
  ICON_CATEGORIES,
  LIMITE_NOME,
  MODELOS,
  type NameCheck,
} from './wizardModel'

export function StepCap({ children }: { children: React.ReactNode }) {
  return <div style={layout.cap}>{children}</div>
}

export function StepHead({ step, title, sub }: { step: number; title: string; sub: string }) {
  return (
    <div style={layout.stepHead}>
      <span style={layout.stepNum} aria-hidden>{step}</span>
      <div style={{ minWidth: 0 }}>
        <div style={layout.stepTitle}>{title}</div>
        <div style={layout.stepSub}>{sub}</div>
      </div>
    </div>
  )
}

export function ModelChevron({ selected }: { selected: boolean }) {
  return (
    <span style={layout.cardChevron} aria-hidden>
      <Ic name="chevronRight" size={14} rotate={selected ? 90 : 0} />
    </span>
  )
}

/**
 * "Público" é um interruptor, não um texto: quem lê a tela precisa entender na
 * hora que ligado = qualquer um entra e desligado = só com convite.
 */
export function PublicToggle({ value, onChange, disabled }: {
  value: boolean
  onChange: (v: boolean) => void | Promise<void>
  disabled?: boolean
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: ui.sm,
        background: value ? `${ui.accent}14` : ui.input,
        border: `1px solid ${value ? `${ui.accent}66` : ui.border}`,
        borderRadius: 10, padding: '10px 12px',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ display: 'flex', color: value ? ui.accent : ui.muted, flexShrink: 0 }}>
        <Ic name={value ? 'globe' : 'lock'} size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: ui.heading }}>
          Servidor público
        </div>
        <div style={{ fontSize: 11.5, color: ui.muted, lineHeight: 1.5, marginTop: 1 }}>
          {value
            ? 'Qualquer pessoa entra pelo servidor, sem convite — com limite de tentativas por pessoa.'
            : 'Privado: só entra quem receber convite. Você pode mudar isso depois nas configurações.'}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label="Servidor público"
        data-testid="wizard-public-toggle"
        disabled={disabled}
        onClick={() => { void onChange(!value) }}
        style={{
          width: 46, height: 26, borderRadius: 13, border: 'none', flexShrink: 0, padding: 0,
          background: value ? ui.accent : ui.border,
          cursor: disabled ? 'not-allowed' : 'pointer', position: 'relative',
          transition: 'background 140ms ease',
        }}
      >
        <span
          style={{
            position: 'absolute', top: 3, left: value ? 23 : 3,
            width: 20, height: 20, borderRadius: '50%', background: '#fff',
            transition: 'left 140ms ease', display: 'block',
          }}
        />
      </button>
    </div>
  )
}

export function StepIdentity({
  modeloId,
  name,
  description,
  iconId,
  nomeCheck,
  onModelo,
  onName,
  onDescription,
  onIcon,
  isPublic,
  onPublic,
}: {
  modeloId: string | null
  name: string
  description: string
  iconId: IconName
  nomeCheck: NameCheck
  onModelo: (id: string) => void
  onName: (v: string) => void
  onDescription: (v: string) => void
  onIcon: (id: IconName) => void
  isPublic: boolean
  onPublic: (v: boolean) => void
}) {
  return (
    <>
      <StepHead step={1} title="Identidade" sub="Como o servidor aparece na lista e para quem pensa em entrar." />

      <div>
        <StepCap>Começar de um molde</StepCap>
        <div style={layout.models} className="csw-models">
          {}
          <button
            type="button"
            className="csw-card"
            style={layout.card(modeloId === null)}
            aria-pressed={modeloId === null}
            onClick={() => onModelo('custom')}
          >
            <span style={{ ...layout.modelIcon(modeloId === null), color: modeloId === null ? '#fff' : ui.accent }}>
              <Ic name="plus" size={15} />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: ui.heading, ...layout.ellipsis }}>
                Criar o meu
              </span>
              <span style={{ display: 'block', fontSize: 11, color: ui.muted, lineHeight: 1.45, minWidth: 0 }}>
                do zero, só com um canal de texto
              </span>
            </span>
            <ModelChevron selected={modeloId === null} />
          </button>
          {MODELOS.map((m) => (
            <button
              key={m.id}
              type="button"
              className="csw-card"
              style={layout.card(modeloId === m.id)}
              aria-pressed={modeloId === m.id}
              onClick={() => onModelo(m.id)}
            >
              <span style={{ ...layout.modelIcon(modeloId === m.id), background: `${m.tint}26`, color: m.tint }}>
                <Ic name={m.icon} size={15} />
              </span>
              {
}
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: ui.heading, ...layout.ellipsis }}>
                  {m.label}
                </span>
                <span style={{ display: 'block', fontSize: 11, color: ui.muted, lineHeight: 1.45, minWidth: 0 }}>
                  {m.desc}
                </span>
              </span>
              <ModelChevron selected={modeloId === m.id} />
            </button>
          ))}
        </div>
      </div>
      {modeloId && modeloId !== 'custom' && (
        <Notice tone="info" icon="info">
          O molde preencheu descrição, ícone e canais. Pode trocar qualquer um —
          inclusive escolher outro.
        </Notice>
      )}

      <div>
        <TextField
          label="Nome do servidor"
          value={name}
          onChange={onName}
          maxLength={LIMITE_NOME + 20}
          placeholder="ex.: Prefeitura de Vila Nova"
          ariaLabel="Nome do servidor"
          error={nomeCheck.error}
          hint={`${name.trim().length}/${LIMITE_NOME} caracteres. Esse é o nome que a pessoa vê no rail.`}
        />
        {nomeCheck.warning && !nomeCheck.error && (
          <div style={{ marginTop: ui.sm }}>
            <Notice tone="warning" icon="info">
              {nomeCheck.warning}
            </Notice>
          </div>
        )}
      </div>

      <TextArea
        label="Descrição (opcional)"
        value={description}
        onChange={onDescription}
        rows={2}
        placeholder="do que é este servidor, em uma frase"
        ariaLabel="Descrição do servidor"
        hint="Aparece para quem está pensando em entrar. Uma linha basta."
      />

      <PublicToggle value={isPublic} onChange={onPublic} />

      <div>
        <StepCap>Ícone — {ICON_CATEGORIES.find((c) => c.id === iconId)?.label ?? 'Servidor'}</StepCap>
        <div style={layout.cats} className="csw-cats" role="group" aria-label="Ícone do servidor">
          {ICON_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className="csw-card"
              style={layout.catCard(iconId === c.id)}
              aria-pressed={iconId === c.id}
              onClick={() => onIcon(c.id)}
            >
              <span style={layout.catIcon(iconId === c.id)}>
                <Ic name={c.id} size={16} />
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontSize: 12, fontWeight: 800, color: ui.heading, lineHeight: 1.3, ...layout.ellipsis }}>
                  {c.label}
                </span>
                <span style={{ display: 'block', fontSize: 11, color: ui.muted, lineHeight: 1.45, marginTop: 2 }}>
                  {c.desc}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
// Seção 1: fim
