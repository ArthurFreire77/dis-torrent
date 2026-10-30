// Passos 2, 3 e 4 do assistente: canais, cargos e regras.
//
// Mesmo contrato do passo de identidade: só apresentação + callbacks. As regras
// (validação de nome de canal, ícones por tipo, categorias) vêm de
// `wizardModel`/`ChannelManager`, que são as fontes únicas.

import { Ic } from '../../shared/icons'
import { Button, IconButton, Notice, Select, TextArea, TextField, ui } from '../../shared/ui'
import { Tooltip } from '../../shared/Tooltip'
import { CATEGORIAS_PADRAO } from './ChannelManager'
import { PERMS, PERM_LABELS } from '../../services/models'
import {
  KIND_ICON,
  KIND_LABEL,
  KIND_OPCOES,
  LIMITE_REGRAS,
  categoryFor,
  slugChannel,
  type ChannelKind,
  type RolePreset,
  type WizardChannel,
} from './wizardModel'
import { StepCap, StepHead } from './wizardSteps'

export function StepChannels({
  channels,
  errors,
  onUpdate,
  onAdd,
  onRemove,
}: {
  channels: WizardChannel[]
  errors: (string | null)[]
  onUpdate: (i: number, patch: Partial<WizardChannel>) => void
  onAdd: () => void
  onRemove: (i: number) => void
}) {
  const validos = channels.length - errors.filter((e) => e !== null).length
  return (
    <>
      <StepHead
        step={2}
        title="Canais"
        sub="O que a pessoa vê ao entrar. Precisa de pelo menos um canal de texto."
      />
      <div className="csw-cap" style={{ marginBottom: 0 }}>
        {channels.length} {channels.length === 1 ? 'canal' : 'canais'}
        {validos !== channels.length && (
          <span style={{ color: ui.danger, marginLeft: 6 }}>
            • {channels.length - validos} com problema
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
        {channels.map((c, i) => (
          <div key={i} className="csw-chan" data-bad={errors[i] !== null}>
            <span className="csw-chan-ic">
              <Ic name={KIND_ICON[c.kind]} size={16} />
            </span>
            <div className="csw-chan-name">
              <TextField
                value={c.name}
                onChange={(v) => onUpdate(i, { name: slugChannel(v) })}
                placeholder="nome-do-canal"
                ariaLabel={`Nome do canal ${i + 1}`}
                error={errors[i]}
                hint="letras minúsculas, números e hífen"
              />
            </div>
            <div className="csw-chan-kind">
              <Select
                value={c.kind}
                onChange={(v) => onUpdate(i, { kind: v as ChannelKind, category: categoryFor(v as ChannelKind) })}
                options={KIND_OPCOES}
                ariaLabel={`Tipo do canal ${i + 1}`}
              />
            </div>
            <div className="csw-chan-cat">
              <Select
                value={c.category}
                onChange={(v) => onUpdate(i, { category: v })}
                options={CATEGORIAS_PADRAO.map((c2) => ({ value: c2, label: c2 }))}
                ariaLabel={`Categoria do canal ${i + 1}`}
              />
            </div>
            <div className="csw-chan-del" style={{ paddingTop: 4 }}>
              <Tooltip label={channels.length <= 1 ? 'O servidor precisa de um canal' : `Remover ${c.name}`}>
                <span>
                  <IconButton
                    icon="trash"
                    label={`Remover canal ${c.name || i + 1}`}
                    onClick={() => onRemove(i)}
                    disabled={channels.length <= 1}
                  />
                </span>
              </Tooltip>
            </div>
          </div>
        ))}
      </div>
      <div>
        <Button icon="plus" onClick={onAdd}>
          Adicionar canal
        </Button>
      </div>
    </>
  )
}

export function StepRoles({
  roles,
  expanded,
  onToggleRole,
  onRenameRole,
  onTogglePerm,
  onExpand,
}: {
  roles: RolePreset[]
  expanded: string | null
  onToggleRole: (key: string) => void
  onRenameRole: (key: string, name: string) => void
  onTogglePerm: (key: string, bit: number) => void
  onExpand: (key: string | null) => void
}) {
  const ativos = roles.filter((r) => r.enabled)
  return (
    <>
      <StepHead
        step={3}
        title="Cargos"
        sub="Quem pode fazer o quê. Os três abaixo vêm prontos — pode deixar como está."
      />
      <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
        {roles.map((r) => {
          const aberto = expanded === r.key
          return (
            <div key={r.key} className="csw-role" data-on={r.enabled}>
              <div className="csw-role-top">
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={() => onToggleRole(r.key)}
                  aria-label={`Criar cargo ${r.name}`}
                  style={{ margin: 0, width: 16, height: 16, cursor: 'pointer', accentColor: ui.accent }}
                />
                <span className="csw-role-dot" style={{ background: r.color }} />
                <div className="csw-role-name">
                  <TextField
                    value={r.name}
                    onChange={(v) => onRenameRole(r.key, v)}
                    ariaLabel={`Nome do cargo ${r.name}`}
                  />
                </div>
                <Tooltip label={aberto ? 'Fechar permissões' : 'Ajustar permissões deste cargo'}>
                  <span>
                    <IconButton
                      icon={aberto ? 'chevronDown' : 'chevronRight'}
                      label={`Permissões do cargo ${r.name}`}
                      active={aberto}
                      onClick={() => onExpand(aberto ? null : r.key)}
                    />
                  </span>
                </Tooltip>
              </div>
              <div className="csw-role-why">{r.why}</div>
              {aberto && (
                <div className="csw-perms">
                  {(Object.keys(PERMS) as (keyof typeof PERMS)[]).map((key) => {
                    const bit = PERMS[key]
                    const pl = (PERM_LABELS as Record<number, string>)[bit] ?? key
                    return (
                      <label key={key} className="csw-check">
                        <input
                          type="checkbox"
                          checked={(r.permissions & bit) !== 0}
                          onChange={() => onTogglePerm(r.key, bit)}
                        />
                        {pl}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {ativos.length === 0 && (
        <Notice tone="warning" icon="warn">
          Nenhum cargo marcado. O servidor funciona assim mesmo — todo mundo entra
          com o mesmo nível, e você pode criar cargos depois.
        </Notice>
      )}
    </>
  )
}

export function StepRules({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <StepHead
        step={4}
        title="Regras"
        sub="Opcional. Aparece para quem está pensando em entrar."
      />
      <TextArea
        label="Regras do servidor (opcional)"
        value={value}
        onChange={onChange}
        rows={8}
        maxLength={LIMITE_REGRAS}
        placeholder={'1. Respeite todo mundo.\n2. Nada de spam nem link quebrado.\n3. Duvida? Pergunta no canal geral.'}
        ariaLabel="Regras do servidor"
        hint="Uma regra por linha. Elas aparecem para quem está pensando em entrar."
      />
      <div className="csw-count">
        {value.length}/{LIMITE_REGRAS}
      </div>
    </>
  )
}

/** Rótulo de tipo de canal, exportado para o resumo lateral. */
export { KIND_LABEL, StepCap }
