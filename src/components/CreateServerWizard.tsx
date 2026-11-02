// ASSISTENTE DE CRIAÇÃO DE SERVIDOR — estado da sessão, navegação e criação.
// Regras puras/dados em wizardModel.ts; passos em wizardSteps*.tsx; resumo em
// wizardSummary.tsx (antes 1191 linhas em um arquivo só).
// Contrato que NÃO muda: `onCreated(id)` UMA vez e só com servidor existente;
// reabrir reseta tudo; modal não fecha com `busy`; convite wildcard (000000000000).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ic, type IconName } from '../shared/icons'
import { Modal, Notice, ui } from '../shared/ui'
import { WIDTHS } from '../shared/ui'
import { LocalLink } from '../shared/LocalLink'
import { services } from '../services'
import { isTauriRuntime } from '../shared/runtime'
import {
  MODELOS,
  PASSO_CONCLUIDO,
  PASSO_REGRAS,
  categoryFor,
  channelErrorsOf,
  checkServerName,
  initialChannels,
  initialRoles,
  nomeVazio,
  slugChannel,
  type ChannelKind,
  type RolePreset,
  type WizardChannel,
} from './server/wizardModel'
import { StepIdentity } from './server/wizardSteps'
import { StepChannels, StepRoles, StepRules } from './server/wizardChannelSteps'
import { StepBots, type WizardBot } from './server/wizardBotStep'
import { botTemplateConfig } from './server/botDocs'
import { WizardSummary } from './server/wizardSummary'
import { WizardFooter, WizardStepper } from './server/wizardChrome'
import { css, layout } from './server/wizardStyles'

export default function CreateServerWizard({
  open,
  onClose,
  onCreated,
  onJoinInstead,
}: {
  open: boolean
  onClose: () => void
  /** Id do servidor criado, como string — é o que o shell consome. */
  onCreated: (communityId: string) => void
  /** "Já tem um convite?": leva para a entrada por token no hub. */
  onJoinInstead?: () => void
}) {
  const [step, setStep] = useState(0)
  /** Maior passo já alcançado. O stepper só volta para <= este. */
  const [visited, setVisited] = useState(0)
  const [modeloId, setModeloId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [iconId, setIconId] = useState<IconName>('server')
  const [channels, setChannels] = useState<WizardChannel[]>(initialChannels)
  const [roles, setRoles] = useState<RolePreset[]>(initialRoles)
  const [bots, setBots] = useState<WizardBot[]>([])
  const [expandedRole, setExpandedRole] = useState<string | null>(null)
  const [rulesText, setRulesText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState('')
  const [createdId, setCreatedId] = useState('')
  /** Bots que falharam ao criar (o servidor em si foi criado). */
  const [botsFalhos, setBotsFalhos] = useState<string[]>([])

  const mainRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    setStep(0)
    setVisited(0)
    setModeloId(null)
    setName('')
    setDescription('')
    setIconId('server')
    setChannels(initialChannels())
    setRoles(initialRoles())
    setBots([])
    setExpandedRole(null)
    setRulesText('')
    setBusy(false)
    setError(null)
    setInviteUrl('')
    setCreatedId('')
    setBotsFalhos([])
  }, [open])

  // Troca de passo volta o scroll ao topo (passos altos → curtos deixavam no vazio).
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0
  }, [step])

  const goTo = useCallback((next: number) => {
    if (next < 0) return
    setStep(next)
    setVisited((v) => (next > v ? next : v))
  }, [])

  const nomeCheck = useMemo(() => checkServerName(name), [name])
  const channelErrors = useMemo(() => channelErrorsOf(channels), [channels])

  const canaisTexto = channels.filter((c) => c.kind === 'text').length
  const canaisVoz = channels.filter((c) => c.kind === 'voice' || c.kind === 'video').length
  const cargosAtivos = roles.filter((r) => r.enabled)
  const validosCount = channels.length - channelErrors.filter((e) => e !== null).length

  /**
   * O que impede de seguir — a lista aparece na tela (botão mudo obrigava a
   * adivinhar).
   */
  const pendencias = useMemo((): string[] => {
    if (step === 0) {
      if (nomeVazio(name)) return ['Escreva um nome com pelo menos 2 caracteres.']
      if (nomeCheck.error) return [nomeCheck.error]
      return []
    }
    if (step === 1) {
      const out: string[] = []
      channelErrors.forEach((e, i) => {
        if (e) out.push(`Canal ${i + 1}: ${e}`)
      })
      if (canaisTexto === 0) out.push('Adicione pelo menos um canal de texto — é por ele que o servidor começa.')
      return out
    }
    return []
  }, [step, name, nomeCheck.error, channelErrors, canaisTexto])

  const concluido = step === PASSO_CONCLUIDO

  // ---------- mutações ----------

  /**
   * Modelo preenche descrição/ícone/canais; NÃO mexe no nome (única coisa que
   * a pessoa escreveu — sobrescrever é o pior que um atalho pode fazer).
   */
  function aplicarModelo(id: string) {
    if (id === 'custom') {
      setModeloId(null)
      setIconId('server')
      setDescription('')
      setChannels(initialChannels())
      return
    }
    const m = MODELOS.find((x) => x.id === id)
    if (!m) return
    if (modeloId === id) {
      setModeloId(null)
      return
    }
    setModeloId(id)
    setIconId(m.icon)
    setDescription(m.description)
    setChannels(m.channels.map((c) => ({ name: c.name, kind: c.kind, category: categoryFor(c.kind) })))
  }

  function updateChannel(i: number, patch: Partial<WizardChannel>) {
    setChannels((prev) =>
      prev.map((c, idx) => {
        if (idx !== i) return c
        const next = { ...c, ...patch }
        if (patch.kind) next.category = categoryFor(patch.kind)
        return next
      }),
    )
  }

  function addChannel() {
    setChannels((prev) => [
      ...prev,
      { name: `canal-${prev.length + 1}`, kind: 'text' as ChannelKind, category: categoryFor('text') },
    ])
  }

  function removeChannel(i: number) {
    // Guard de 1 repetido aqui: protege contra clique duplo.
    setChannels((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)))
  }

  function toggleRole(key: string) {
    setRoles((prev) => prev.map((r) => (r.key === key ? { ...r, enabled: !r.enabled } : r)))
  }

  function renameRole(key: string, nome: string) {
    setRoles((prev) => prev.map((r) => (r.key === key ? { ...r, name: nome } : r)))
  }

  function togglePerm(key: string, bit: number) {
    setRoles((prev) =>
      prev.map((r) => {
        if (r.key !== key) return r
        const has = (r.permissions & bit) !== 0
        return { ...r, permissions: has ? r.permissions & ~bit : r.permissions | bit }
      }),
    )
  }

  // ---------- bots ----------

  function addBot() {
    setBots((prev) => [
      ...prev,
      { name: `Bot ${prev.length + 1}`, roleKey: null, template: 'vazio' },
    ])
  }

  function removeBot(i: number) {
    setBots((prev) => prev.filter((_, idx) => idx !== i))
  }

  function renameBot(i: number, name: string) {
    setBots((prev) => prev.map((b, idx) => (idx === i ? { ...b, name } : b)))
  }

  function templateBot(i: number, template: WizardBot['template']) {
    setBots((prev) => prev.map((b, idx) => (idx === i ? { ...b, template } : b)))
  }

  function roleBot(i: number, roleKey: string | null) {
    setBots((prev) => prev.map((b, idx) => (idx === i ? { ...b, roleKey } : b)))
  }

  // ---------- criação ----------

  async function createServer() {
    setError(null)
    if (nomeVazio(name) || nomeCheck.error) {
      setStep(0)
      setError(nomeCheck.error ?? 'O nome do servidor precisa de pelo menos 2 caracteres.')
      return
    }
    setBusy(true)
    try {
      const validos = channels
        .map((c, i) => ({ c, err: channelErrors[i] }))
        .filter((x) => !x.err)
        .map(({ c }) => c)

      const id = await services.createCommunity(
        nomeCheck.normalized || name.trim(),
        validos.map((c) => c.name),
        {
          description: description.trim() || undefined,
          // `icon` é texto livre no backend: mandamos o NOME do ícone (não emoji).
          icon: iconId,
          category: modeloId ?? undefined,
          rulesText: rulesText.trim() || undefined,
          channelsMeta: validos.map((c) => ({ name: c.name, kind: c.kind, category: c.category })),
          roles: cargosAtivos.map((r) => ({
            name: r.name.trim() || r.key,
            color: r.color,
            permissions: r.permissions,
            hoist: r.hoist,
            mentionable: r.mentionable,
          })),
        },
      )
      // BOTS DO ASSISTENTE: criados DEPOIS do servidor existir, porque o core
      // exige o servidor e os cargos para validar (cargo fantasma é recusado).
      // Falha de bot não pode desfazer o servidor: o resultado é reportado.
      const botsFalhos: string[] = []
      if (bots.length > 0) {
        // presets de cargo → ids reais, na mesma ordem em que foram criados
        let cargosCriados: { id: string; name: string }[] = []
        try { cargosCriados = await services.rolesList(id) } catch { /* sem lista: bots sem cargo */ }
        for (const b of bots) {
          const nome = b.name.trim()
          if (!nome) continue
          const cargo = b.roleKey
            ? cargosCriados.find((r) => r.name === cargosAtivos.find((x) => x.key === b.roleKey)?.name.trim())
            : null
          try {
            const botId = await services.botCreate(id, { name: nome, roleId: cargo?.id ?? null })
            const cfg = botTemplateConfig(b.template)
            if (cfg) await services.botUpdate(id, botId, { config: cfg })
          } catch (e) {
            botsFalhos.push(`${nome}: ${(e as Error)?.message ?? String(e)}`)
          }
        }
      }
      // Convite público wildcard: vale em qualquer aparelho (formato aceito
      // pelo Rust e pelo modo navegador).
      const token = await services.makeInvite(id, '000000000000')
      setCreatedId(id)
      setBotsFalhos(botsFalhos)
      setInviteUrl(
        isTauriRuntime()
          ? `distorrent://invite?invite=${encodeURIComponent(token)}`
          : `${window.location.origin}/invite/${encodeURIComponent(token)}`,
      )
      setStep(PASSO_CONCLUIDO)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'não foi possível criar o servidor')
    } finally {
      setBusy(false)
    }
  }

  // ---------- conteúdo ----------

  const conteudo = ((): React.ReactNode => {
    if (step === 0) {
      return (
        <StepIdentity
          modeloId={modeloId}
          name={name}
          description={description}
          iconId={iconId}
          nomeCheck={nomeCheck}
          onModelo={aplicarModelo}
          onName={setName}
          onDescription={setDescription}
          onIcon={setIconId}
        />
      )
    }
    if (step === 1) {
      return (
        <StepChannels
          channels={channels}
          errors={channelErrors}
          onUpdate={updateChannel}
          onAdd={addChannel}
          onRemove={removeChannel}
        />
      )
    }
    if (step === 2) {
      return (
        <StepRoles
          roles={roles}
          expanded={expandedRole}
          onToggleRole={toggleRole}
          onRenameRole={renameRole}
          onTogglePerm={togglePerm}
          onExpand={setExpandedRole}
        />
      )
    }
    if (step === PASSO_REGRAS) {
      return <StepRules value={rulesText} onChange={setRulesText} />
    }
    if (step === 3) {
      return (
        <StepBots
          bots={bots}
          roles={cargosAtivos.map((r) => ({ key: r.key, name: r.name.trim() || r.key }))}
          onAdd={addBot}
          onRemove={removeBot}
          onRename={renameBot}
          onTemplate={templateBot}
          onRole={roleBot}
        />
      )
    }

    // Passo concluído
    return (
      <>
        <div className="csw-done" style={layout.done}>
          <span className="csw-done-ic" style={layout.doneIcon}>
            <Ic name="check" size={30} />
          </span>
          <div style={{ fontSize: 19, fontWeight: 900, color: ui.heading }}>Servidor criado</div>
          <div style={{ fontSize: 13, color: ui.muted, maxWidth: 460, lineHeight: 1.55 }}>
            {name.trim()} está no seu rail, com {validosCount} {validosCount === 1 ? 'canal' : 'canais'} e{' '}
            {cargosAtivos.length} {cargosAtivos.length === 1 ? 'cargo' : 'cargos'}. Para
            alguém entrar, mande o convite abaixo.
          </div>
        </div>
        <LocalLink
          url={inviteUrl}
          label="Convite"
          context="Dois endereços porque são para lugares diferentes: localhost só abre neste computador. Para mandar para o celular, use o endereço de rede."
        />
        <div style={{ marginTop: ui.lg }}>
          <Notice tone="warning" icon="warn">
            O endereço de rede só alcança o celular se os dois estiverem na mesma rede
            Wi-Fi. Fora disso, não há como entrar pelo link — o app é de rede local.
          </Notice>
        </div>
        {botsFalhos.length > 0 && (
          <div style={{ marginTop: ui.lg }}>
            <Notice tone="danger" icon="warn">
              O servidor foi criado, mas {botsFalhos.length === 1 ? 'um bot falhou' : `${botsFalhos.length} bots falharam`}:
              {' '}{botsFalhos.join(' · ')}. Crie de novo em Configurações → Bots.
            </Notice>
          </div>
        )}
      </>
    )
  })()

  // Título estável em todos os passos (o contexto fica no `StepHead` interno).
  const subtitulo = concluido
    ? 'Pronto. O convite está abaixo.'
    : 'Seu servidor é onde você e seus amigos se reúnem. Crie o seu e comece a interagir.'

  return (
    <>
      <style>{css}</style>
      <Modal
        open={open}
        onClose={busy ? () => {} : onClose}
        title="Criar seu servidor"
        subtitle={subtitulo}
        width={WIDTHS.wizard}
        labelId="csw-title"
        dialogLabel="Criar servidor"
        footer={
          <div style={{ width: '100%' }}>
            {!concluido && onJoinInstead && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  flexWrap: 'wrap',
                  paddingBottom: ui.md,
                  marginBottom: ui.md,
                  borderBottom: `1px solid ${ui.border}`,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 800, color: ui.heading }}>Já tem um convite?</span>
                <button
                  type="button"
                  onClick={onJoinInstead}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    padding: 0,
                    color: ui.link,
                    fontSize: 13,
                    fontWeight: 700,
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  Entrar em um servidor
                </button>
              </div>
            )}
            <WizardFooter
              step={step}
              busy={busy}
              error={error}
              pendencias={pendencias}
              onBack={() => goTo(step - 1)}
              onNext={() => goTo(step + 1)}
              onCreate={() => void createServer()}
              onConclude={() => {
                onCreated(createdId)
                onClose()
              }}
            />
          </div>
        }
      >
        <WizardStepper step={step} visited={visited} busy={busy} onGo={goTo} />

        <div className="csw-cols" style={layout.cols} ref={mainRef}>
          {/* `role="group"` para o leitor de tela anunciar a troca de contexto. */}
          <div
            className="csw-main"
            style={layout.main}
            role="group"
            aria-label={concluido ? 'Servidor criado' : `Passo ${step + 1} de 5: Criar servidor`}
          >
            {conteudo}
          </div>

          {!concluido && (
            <WizardSummary
              iconId={iconId}
              name={name}
              description={description}
              channels={channels}
              channelErrors={channelErrors}
              canaisTexto={canaisTexto}
              canaisVoz={canaisVoz}
              cargosAtivos={cargosAtivos}
              rulesText={rulesText}
              bots={bots}
            />
          )}
        </div>
      </Modal>
    </>
  )
}

/** Reexportado para quem já importava o slug daqui. */
export { slugChannel }
