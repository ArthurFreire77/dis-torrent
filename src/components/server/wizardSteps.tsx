// Passo 1 do assistente: identidade do servidor (modelo, nome, descrição, ícone).
//
// Componente de APRESENTAÇÃO: recebe o estado e devolve mudanças por callback.
// Toda regra (limite de nome, catálogo de ícones, modelos) vem de `wizardModel`,
// que é puro e testável.
//
// O layout vem de `layout` (INLINE, em `wizardStyles`), não de folha de estilo.
// Assim rótulo e descrição nunca colam um no outro nem quando o `<style>` não é
// aplicado — era o defeito de "ServidorSem tema definido… Grudados" num build
// que perdeu a folha.

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

/** Título + explicação do passo. Fica no conteúdo (abaixo do stepper). */
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
        <div style={layout.models} className="csw-models">
          {MODELOS.map((m) => (
            <button
              key={m.id}
              type="button"
              className="csw-card"
              style={layout.card(modeloId === m.id)}
              aria-pressed={modeloId === m.id}
              onClick={() => onModelo(m.id)}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ color: modeloId === m.id ? ui.accent : ui.muted, display: 'flex', flexShrink: 0 }}>
                  <Ic name={m.icon} size={15} />
                </span>
                {/* `display:block` no título e na descrição é obrigatório: como
                    spans inline eles saíam grudados ("ComunidadeBate-papo…"). */}
                <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: ui.heading, ...layout.ellipsis }}>
                  {m.label}
                </span>
              </span>
              <span style={{ display: 'block', fontSize: 11, color: ui.muted, lineHeight: 1.45, minWidth: 0 }}>
                {m.desc}
              </span>
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
