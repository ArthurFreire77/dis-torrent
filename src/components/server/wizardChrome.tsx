// Rodapé e barra de etapas do assistente.
//
// Puramente visuais: recebem a decisão já tomada (`busy`, `error`, `pendencias`,
// `step`) e não conhecem `services`, estado nem criação. Layout inline para não
// depender da folha (os 4 segmentos colavam como "1Identidade 2Canais" quando o
// `<style>` não era aplicado).

import { Ic } from '../../shared/icons'
import { Button, ui } from '../../shared/ui'
import { layout } from './wizardStyles'
import { PASSO_CONCLUIDO, PASSO_REGRAS, STEP_LABELS } from './wizardModel'

/**
 * Rodapé do modal: erro real, o que falta e a ação do passo.
 *
 * O aviso de "Falta:" é `role=status` (não `alert`): é orientação de
 * preenchimento, e um alert dispararia leitura imediata a cada tecla digitada.
 * Já a falha de criação é `role=alert` — ali aconteceu algo que a pessoa
 * precisa saber na hora.
 */
export function WizardFooter({
  step,
  busy,
  error,
  pendencias,
  onBack,
  onNext,
  onCreate,
  onConclude,
}: {
  step: number
  busy: boolean
  error: string | null
  pendencias: string[]
  onBack: () => void
  onNext: () => void
  onCreate: () => void
  onConclude: () => void
}) {
  const bloqueado = pendencias.length > 0
  const concluido = step === PASSO_CONCLUIDO

  return (
    <div style={{ width: '100%' }}>
      {error && (
        <div style={{ ...layout.notice, marginBottom: ui.md }} role="alert">
          <span style={{ flexShrink: 0, marginTop: 1 }}>
            <Ic name="info" size={14} />
          </span>
          <span>
            <strong style={{ color: ui.heading }}>Não foi possível criar:</strong> {error}
          </span>
        </div>
      )}
      {!concluido && bloqueado && (
        <div style={{ ...layout.notice, marginBottom: ui.md }} role="status">
          <span style={{ flexShrink: 0, marginTop: 1 }}>
            <Ic name="info" size={14} />
          </span>
          <span>
            <strong style={{ color: ui.heading }}>Falta:</strong> {pendencias.join(' ')}
          </span>
        </div>
      )}
      <div style={{ display: 'flex', gap: ui.sm, flexWrap: 'wrap', alignItems: 'center' }}>
        {step > 0 && !concluido && (
          <Button icon="chevronLeft" onClick={onBack} disabled={busy}>
            Voltar
          </Button>
        )}
        <div style={{ flex: 1 }} />
        {concluido ? (
          <Button variant="primary" icon="check" onClick={onConclude}>
            Concluir
          </Button>
        ) : step === PASSO_REGRAS ? (
          <Button variant="success" icon="check" busy={busy} disabled={bloqueado} onClick={onCreate}>
            {busy ? 'Criando servidor' : 'Criar servidor'}
          </Button>
        ) : (
          <Button
            variant="primary"
            icon="chevronRight"
            disabled={bloqueado}
            onClick={onNext}
            title={bloqueado ? pendencias[0] : undefined}
          >
            Continuar
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * Barra de etapas: 4 segmentos. Clicar só volta para passo já alcançado —
 * pular direto para cargos deixaria canais vazios (o servidor não existe sem
 * canal de texto).
 */
export function WizardStepper({
  step,
  visited,
  busy,
  onGo,
}: {
  step: number
  visited: number
  busy: boolean
  onGo: (i: number) => void
}) {
  return (
    <nav aria-label="Etapas da criação" style={layout.segWrap}>
      {STEP_LABELS.map((label, i) => {
        const state = step === PASSO_CONCLUIDO || i < step ? 'done' : i === step ? 'now' : 'todo'
        const podeIr = i <= visited && step !== PASSO_CONCLUIDO && !busy
        return (
          <button
            key={label}
            type="button"
            className="csw-seg"
            style={layout.seg(state)}
            disabled={!podeIr}
            aria-current={i === step ? 'step' : undefined}
            aria-label={`Etapa ${i + 1}: ${label}${state === 'done' ? ', concluída' : state === 'now' ? ', atual' : ''}`}
            onClick={() => onGo(i)}
          >
            <span style={layout.segBar(state)} />
            <span className="csw-seg-l" style={layout.segLabel(state)}>
              <span style={layout.segNum(state)}>
                {state === 'done' ? <Ic name="check" size={9} stroke={3} /> : i + 1}
              </span>
              <span className="csw-seg-t" style={layout.segText}>{label}</span>
            </span>
          </button>
        )
      })}
    </nav>
  )
}
