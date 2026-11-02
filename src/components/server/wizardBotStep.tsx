// Passo "Bots" do assistente de criação de servidor.
//
// Antes só era possível criar bot DEPOIS de o servidor existir, no painel de
// configurações — quem estava criando o servidor não tinha como saber que bots
// existiam nem como configurar um. Aqui a pessoa cria o primeiro bot junto com
// o servidor e já lê as regras reais (quem executa, o que não funciona).

import { Ic } from '../../shared/icons'
import { Button, Notice, Select, TextField, ui } from '../../shared/ui'
import { layout } from './wizardStyles'
import { StepCap, StepHead } from './wizardSteps'
import { BOT_CONFIG_MAX_KB, BOT_TEMPLATES, type BotTemplate } from './botDocs'
import { validateBotEntryName } from './botModel'
import { BotDocsAccordion } from './BotDocsAccordion'

export interface WizardBot {
  name: string
  /** `key` do preset de cargo (o id real só existe depois de criar o servidor). */
  roleKey: string | null
  template: BotTemplate
}

export function StepBots({
  bots,
  roles,
  onAdd,
  onRemove,
  onRename,
  onTemplate,
  onRole,
}: {
  bots: WizardBot[]
  /** Cargos ATIVOS deste servidor (presets do passo anterior). */
  roles: { key: string; name: string }[]
  onAdd: () => void
  onRemove: (index: number) => void
  onRename: (index: number, name: string) => void
  onTemplate: (index: number, template: BotTemplate) => void
  onRole: (index: number, roleKey: string | null) => void
}) {
  return (
    <>
      <StepHead
        step={4}
        title="Bots"
        sub="Opcional. Um membro automatizado que responde comandos e avisa um endereço seu."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
        {bots.length === 0 && (
          <div style={layout.emptyBox}>
            Nenhum bot. Você pode criar depois, em Configurações do servidor → Bots.
          </div>
        )}

        {bots.map((bot, i) => {
          // Mesma regra do painel de Bots: nome único entre os bots deste passo.
          const outros = bots.filter((_, idx) => idx !== i).map((b) => b.name)
          const erro = bot.name.trim() ? validateBotEntryName(bot.name, outros) : null
          return (
            <div key={i} style={layout.botCard}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={layout.botAvatar}>
                  <Ic name="bot" size={15} />
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 800, color: ui.heading }}>
                  Bot {i + 1}
                </span>
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  aria-label={`Remover bot ${i + 1}`}
                  title="Remover este bot"
                  style={layout.botIconBtn}
                >
                  <Ic name="trash" size={13} />
                </button>
              </div>

              <TextField
                label="Nome do bot"
                value={bot.name}
                onChange={(v) => onRename(i, v)}
                placeholder="ex.: BotDoClima"
                maxLength={32}
                ariaLabel={`Nome do bot ${i + 1}`}
                error={erro}
              />

              <div>
                <StepCap>Modelo</StepCap>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {BOT_TEMPLATES.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => onTemplate(i, t.id)}
                      aria-pressed={bot.template === t.id}
                      style={layout.botChip(bot.template === t.id)}
                    >
                      <Ic name={t.id === 'clima' ? 'globe' : 'plus'} size={12} />
                      {t.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.5, marginTop: 5 }}>
                  {BOT_TEMPLATES.find((t) => t.id === bot.template)?.desc}
                </div>
              </div>

              {roles.length > 0 && (
                <Select
                  label="Cargo (permissões do bot)"
                  value={bot.roleKey ?? ''}
                  onChange={(v) => onRole(i, v || null)}
                  options={[
                    { value: '', label: 'Sem cargo (só o básico)' },
                    ...roles.map((r) => ({ value: r.key, label: r.name })),
                  ]}
                  hint="Dê o cargo mais restrito possível: as permissões do bot vêm dele."
                />
              )}
            </div>
          )
        })}

        <div>
          <Button variant="secondary" icon="plus" onClick={onAdd}>
            Adicionar bot
          </Button>
        </div>
      </div>

      {/* DOCUMENTAÇÃO no próprio passo: quem cria não precisa sair procurando. */}
      <div>
        <StepCap>Como o bot funciona (leia antes de criar)</StepCap>
        <BotDocsAccordion initial="O que é um bot aqui" />
        <div style={{ marginTop: 8 }}>
          <Notice tone="info" icon="file">
            Config (JSON) até {BOT_CONFIG_MAX_KB} KB. O token é criado junto com o bot e só
            aparece para o dono do servidor.
          </Notice>
        </div>
      </div>
    </>
  )
}
