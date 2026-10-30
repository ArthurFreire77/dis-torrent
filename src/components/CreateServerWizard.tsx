// ASSISTENTE DE CRIAÇÃO DE SERVIDOR.
//
// ## Por que este arquivo é pequeno agora
//
// Ele tinha 1191 linhas e fazia cinco trabalhos: catálogo de modelos/ícones,
// validação de nome (com limite 60 divergente do core, que usa 64), os quatro
// passos de formulário, o resumo lateral e a criação. Era impossível testar
// qualquer regra e qualquer mudança no passo 3 arriscava o passo 1.
//
// Agora:
//   - `wizardModel.ts`      → dados + regras PURAS (testadas em Node);
//   - `wizardSteps.tsx`     → passo 1 (identidade);
//   - `wizardChannelSteps.tsx` → passos 2-4 (canais, cargos, regras);
//   - `wizardSummary.tsx`   → resumo lateral;
//   - este arquivo          → estado da sessão, navegação e criação.
//
// ## Contrato que NÃO pode mudar (o shell depende)
//   - `onCreated(communityId)` é chamado UMA vez, e só depois de o servidor
//     existir de verdade;
//   - reabrir o modal reseta tudo;
//   - o modal não fecha enquanto `busy`;
//   - o convite é wildcard (`000000000000`) para valer em qualquer aparelho.

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
import { WizardSummary } from './server/wizardSummary'
import { WizardFooter, WizardStepper } from './server/wizardChrome'
import { css } from './server/wizardStyles'

export default function CreateServerWizard({
  open,
  onClose,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  /** Id do servidor criado, como string — é o que o shell consome. */
  onCreated: (communityId: string) => void
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
  const [expandedRole, setExpandedRole] = useState<string | null>(null)
  const [rulesText, setRulesText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inviteUrl, setInviteUrl] = useState('')
  const [createdId, setCreatedId] = useState('')

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
    setExpandedRole(null)
    setRulesText('')
    setBusy(false)
    setError(null)
    setInviteUrl('')
    setCreatedId('')
  }, [open])

  // Trocar de passo volta o scroll ao topo. Sem isso, ir do passo 1 (alto) para
  // o passo 3 (curto) deixa a pessoa no meio do vazio.
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
   * O que impede de seguir. Não é só um booleano: a lista é o que aparece na
   * tela. Botão desabilitado sem dizer o porquê obriga a pessoa a adivinhar.
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
   * Modelo preenche descrição, ícone e canais. NÃO mexe no nome: é a única
   * coisa que a pessoa necessariamente escreveu sozinha, e sobrescrever o que
   * ela digitou é o pior que um botão de "atalho" pode fazer.
   */
  function aplicarModelo(id: string) {
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
    // Guarda de 1 já está no botão; repetir aqui protege contra clique duplo.
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
          // O backend guarda `icon` como texto livre e exibe a inicial do nome
          // quando está vazio. Mandamos o NOME do ícone, não um emoji: é o que
          // identifica a categoria escolhida e sobrevive a uma troca de fonte.
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
      // Convite público do wizard: o link precisa valer para qualquer pessoa,
      // não ficar preso ao fingerprint do aparelho que criou o servidor.
      // O wildcard é o formato já aceito pelo Rust e pelo modo navegador.
      const token = await services.makeInvite(id, '000000000000')
      setCreatedId(id)
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

    // Passo concluído
    return (
      <>
        <div className="csw-done">
          <span className="csw-done-ic">
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
      </>
    )
  })()

  // Título STÁVEL em todos os passos, para o diálogo não trocar de nome a cada
  // etapa. Quem dá o contexto é o `StepHead` dentro do conteúdo.
  const subtitulo = concluido ? 'Pronto. O convite está abaixo.' : 'Leva menos de um minuto.'

  return (
    <>
      <style>{css}</style>
      <Modal
        open={open}
        onClose={busy ? () => {} : onClose}
        title="Criar servidor"
        subtitle={subtitulo}
        width={WIDTHS.wizard}
        labelId="csw-title"
        dialogLabel="Criar servidor"
        footer={
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
        }
      >
        <WizardStepper step={step} visited={visited} busy={busy} onGo={goTo} />

        <div className="csw-cols" ref={mainRef}>
          {/* `role="group"` + `aria-label` para o leitor de tela anunciar a troca
              de contexto, não só a troca de texto. */}
          <div
            className="csw-main"
            role="group"
            aria-label={concluido ? 'Servidor criado' : `Passo ${step + 1} de 4: Criar servidor`}
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
            />
          )}
        </div>
      </Modal>
    </>
  )
}

/** Reexportado para quem já importava o slug daqui. */
export { slugChannel }
