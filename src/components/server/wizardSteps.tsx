// Passo 1 do assistente: identidade do servidor (modelo, nome, descrição, ícone).
//
// Componente de APRESENTAÇÃO: recebe o estado e devolve mudanças por callback.
// Toda regra (limite de nome, catálogo de ícones, modelos) vem de `wizardModel`,
// que é puro e testável. Antes este bloco vivia no meio de um arquivo de 1191
// linhas com estado, criação e os outros três passos.

import { Ic, type IconName } from '../../shared/icons'
import { Notice, TextArea, TextField, ui } from '../../shared/ui'
import {
  ICON_CATEGORIES,
  LIMITE_NOME,
  MODELOS,
  type ChannelKind,
  type NameCheck,
} from './wizardModel'

export function StepCap({ children }: { children: React.ReactNode }) {
  return <div className="csw-cap">{children}</div>
}

/** Título + explicação do passo. Fica no conteúdo (abaixo do stepper). */
export function StepHead({ step, title, sub }: { step: number; title: string; sub: string }) {
  return (
    <div className="csw-step-head">
      <span className="csw-step-num" aria-hidden>{step}</span>
      <div style={{ minWidth: 0 }}>
        <div className="csw-step-title">{title}</div>
        <div className="csw-step-sub">{sub}</div>
      </div>
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
}) {
  return (
    <>
      <StepHead step={1} title="Identidade" sub="Como o servidor aparece na lista e para quem pensa em entrar." />

      <div>
        <StepCap>Comece por um modelo (opcional)</StepCap>
        <div className="csw-models">
          {MODELOS.map((m) => (
            <button
              key={m.id}
              type="button"
              className="csw-model"
              aria-pressed={modeloId === m.id}
              onClick={() => onModelo(m.id)}
            >
              <span className="csw-model-row">
                <span style={{ color: modeloId === m.id ? ui.accent : ui.muted, display: 'flex' }}>
                  <Ic name={m.icon} size={15} />
                </span>
                <span className="csw-model-t">{m.label}</span>
              </span>
              <span className="csw-model-d">{m.desc}</span>
            </button>
          ))}
        </div>
      </div>
      {modeloId && (
        <Notice tone="info" icon="info">
          O modelo preencheu a descrição, o ícone e os canais abaixo. Pode trocar
          qualquer um deles — inclusive escolher outro modelo.
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

      <div>
        <StepCap>Ícone — {ICON_CATEGORIES.find((c) => c.id === iconId)?.label ?? 'Servidor'}</StepCap>
        <div className="csw-cats" role="group" aria-label="Ícone do servidor">
          {ICON_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              className="csw-cat"
              aria-pressed={iconId === c.id}
              onClick={() => onIcon(c.id)}
            >
              <span className="csw-cat-ic">
                <Ic name={c.id} size={16} />
              </span>
              <span className="csw-cat-body">
                <span className="csw-cat-t">{c.label}</span>
                <span className="csw-cat-d">{c.desc}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

/** Usado pelo passo de canais ao trocar o tipo. */
export type { ChannelKind }
