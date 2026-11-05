import { useState } from 'react'
import type { BotView, RoleView } from '../../services/models'
import { Tooltip } from '../../shared/Tooltip'
import { validateBotEntryName } from './botModel'
import { BotDocsAccordion } from './BotDocsAccordion'
import { BOT_DOCS_FILE_NAME, botDocsMarkdown } from './botDocs'
import { baixarTexto } from './botDocsDownload'
import { botSummary } from './BotPanel'
import { BOT_PERM_DEFS } from '../../services/botCommands'
import {
  Button,
  EmptyState,
  IconButton,
  Modal,
  Notice,
  Select,
  TextField,
  WIDTHS,
  ui,
} from '../../shared/ui'

export function validateBotName(
  nome: string,
  existentes: BotView[],
  editandoId?: string | null,
): string | null {
  const outros = existentes
    .filter((b) => b.id !== editandoId)
    .map((b) => b.name)
  return validateBotEntryName(nome, outros)
}

export function BotManager({
  bots,
  roles,
  ehDono,
  onCreate,
  onUpdate,
  onDelete,
  onConfigure,
  onImportFolder,
}: {
  bots: BotView[]
  roles: RoleView[]
  ehDono: boolean
  onCreate: (data: { name: string; roleId: string | null }) => Promise<void>
  onUpdate: (id: string, patch: { name?: string; roleId?: string | null; online?: boolean; perms?: number }) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onConfigure: (botId: string) => void
  /** Importa uma pasta de bot (`bot.json`): cria o bot com a config e permissões. */
  onImportFolder?: (dir: string) => Promise<string>
}) {
  const [criando, setCriando] = useState(false)
  const [importando, setImportando] = useState(false)
  const [importDir, setImportDir] = useState('')
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [editandoId, setEditandoId] = useState<string | null>(null)
  const [paraRemover, setParaRemover] = useState<BotView | null>(null)
  const [copiado, setCopiado] = useState<string | null>(null)
  const [falhaDownload, setFalhaDownload] = useState(false)

  function copiar(id: string, token: string) {
    navigator.clipboard
      ?.writeText(token)
      .then(() => {
        setCopiado(id)
        setTimeout(() => setCopiado(null), 2000)
      })
      .catch(() => {})
  }

  return (
    <div style={{ maxWidth: 860, display: 'flex', flexDirection: 'column', gap: ui.lg }}>
      <div style={{ display: 'flex', gap: ui.md, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Notice tone="info" icon="info">
          Bots são membros automatizados: entram no servidor, recebem um token e um cargo,
          e podem responder a comandos. O token é a credencial — quem tiver pode falar como
          este bot.
        </Notice>
      </div>

      <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          variant="secondary"
          icon="download"
          onClick={() => {
            const ok = baixarTexto(BOT_DOCS_FILE_NAME, botDocsMarkdown())
            if (!ok) setFalhaDownload(true)
          }}
        >
          Baixar documentação (.md)
        </Button>
        <span style={{ fontSize: 11.5, color: ui.muted, flex: '1 1 220px', minWidth: 0 }}>
          Guia completo para criar e integrar bots, pronto para repassar. Vai sem token —
          pode compartilhar.
        </span>
      </div>

      {falhaDownload && (
        <Notice tone="warning" icon="warn">
          O navegador embutido bloqueou o download. Copie o texto do acordeão abaixo ou abra pelo
          app do desktop.
        </Notice>
      )}

      <BotDocsAccordion />

      {ehDono && (
        <div style={{ display: 'flex', gap: ui.sm, flexWrap: 'wrap', alignItems: 'center' }}>
          <Button variant="success" icon="plus" onClick={() => setCriando(true)}>
            Criar bot
          </Button>
          {onImportFolder && (
            <Button variant="secondary" icon="download" onClick={() => setImportando(true)}>
              Adicionar bot existente
            </Button>
          )}
          <span style={{ fontSize: 11.5, color: ui.muted }}>
            “Adicionar” lê a pasta de um bot (bot.json + código) e cria no servidor.
          </span>
        </div>
      )}

      {bots.length === 0 ? (
        <EmptyState
          icon="bot"
          title="Nenhum bot neste servidor"
          hint="Crie um bot para automatizar tarefas, responder mensagens ou integrar seu serviço. Ele entra como um membro comum, com as permissões do cargo que você escolher."
          action={
            ehDono ? (
              <Button variant="success" icon="plus" onClick={() => setCriando(true)}>
                Criar o primeiro bot
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
          {bots.map((b) => {
            const cargo = roles.find((r) => r.id === b.roleId) ?? null
            return (
              <BotRow
                key={b.id}
                bot={b}
                cargo={cargo}
                roles={roles}
                ehDono={ehDono}
                isEditing={editandoId === b.id}
                copied={copiado === b.id}
                onCopy={() => copiar(b.id, b.token)}
                onStartEdit={() => setEditandoId(b.id)}
                onCancelEdit={() => setEditandoId(null)}
                onSaveEdit={async (patch) => {
                  await onUpdate(b.id, patch)
                  setEditandoId(null)
                }}
                onToggleOnline={() => onUpdate(b.id, { online: !b.online })}
                onConfigure={() => onConfigure(b.id)}
                onRemove={() => setParaRemover(b)}
              />
            )
          })}
        </div>
      )}

      <BotCreateModal
        open={criando}
        onClose={() => setCriando(false)}
        bots={bots}
        roles={roles}
        onCreate={async (data) => {
          await onCreate(data)
          setCriando(false)
        }}
      />

      <Modal
        open={importando}
        onClose={() => setImportando(false)}
        title="Adicionar bot existente"
        subtitle="Informe a pasta que contém o bot.json do bot."
        width={WIDTHS.md}
        footer={
          <>
            <span style={{ flex: 1 }} />
            <Button onClick={() => setImportando(false)} disabled={importBusy}>
              Cancelar
            </Button>
            <Button
              variant="success"
              icon="check"
              busy={importBusy}
              onClick={async () => {
                if (!onImportFolder) return
                setImportBusy(true)
                setImportError(null)
                try {
                  const nome = await onImportFolder(importDir.trim())
                  setImportando(false)
                  setImportDir('')
                  setEditandoId(null)
                  void nome
                } catch (e: unknown) {
                  setImportError(e instanceof Error ? e.message : String(e))
                } finally {
                  setImportBusy(false)
                }
              }}
            >
              Importar pasta
            </Button>
          </>
        }
      >
        {importError && (
          <div style={{ marginBottom: ui.lg }}>
            <Notice tone="danger">{importError}</Notice>
          </div>
        )}
        <TextField
          label="Pasta do bot"
          value={importDir}
          mono
          autoFocus
          ariaLabel="Pasta do bot a importar"
          placeholder="C:\\bots\\freirebot"
          hint="A pasta precisa ter um bot.json com name e config. Nada roda sem você confirmar."
          onChange={setImportDir}
        />
        <Notice tone="info" icon="info">
          A importação só cria o bot e a configuração. O token é gerado pelo servidor e o código só roda
          quando você iniciar o plugin no painel do bot.
        </Notice>
      </Modal>

      <Modal
        open={paraRemover !== null}
        onClose={() => setParaRemover(null)}
        title="Remover bot?"
        subtitle={paraRemover ? `${paraRemover.name} sai do servidor` : undefined}
        width={480}
        footer={
          <>
            <span style={{ flex: 1 }} />
            <Button onClick={() => setParaRemover(null)}>Cancelar</Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={async () => {
                if (paraRemover) await onDelete(paraRemover.id)
                setParaRemover(null)
              }}
            >
              Remover
            </Button>
          </>
        }
      >
        <Notice tone="warning" icon="warn">
          O bot perde acesso ao servidor imediatamente. O token é invalidado e as
          integrações que o usarem vão começar a falhar.
        </Notice>
      </Modal>
    </div>
  )
}

// Seção 1: BotRow
function BotRow({
  bot,
  cargo,
  roles,
  ehDono,
  isEditing,
  copied,
  onCopy,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleOnline,
  onConfigure,
  onRemove,
}: {
  bot: BotView
  cargo: RoleView | null
  roles: RoleView[]
  ehDono: boolean
  isEditing: boolean
  copied: boolean
  onCopy: () => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSaveEdit: (patch: { name?: string; roleId?: string | null }) => Promise<void>
  onToggleOnline: () => void
  onConfigure: () => void
  onRemove: () => void
}) {
  const [nome, setNome] = useState(bot.name)
  const [roleId, setRoleId] = useState(bot.roleId ?? '')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const erroNome = validateBotName(nome, [bot], bot.id)

  async function salvar() {
    if (erroNome) return
    setSalvando(true)
    setErro(null)
    try {
      await onSaveEdit({ name: nome.trim(), roleId: roleId || null })
    } catch (e: any) {
      setErro(String(e?.message ?? e))
    } finally {
      setSalvando(false)
    }
  }

  const cor = cargo?.color ?? ui.accent
  const summary = botSummary(bot)

  return (
    <div
      style={{
        background: ui.surface,
        border: `1px solid ${ui.border}`,
        borderRadius: ui.radius,
        padding: '13px 15px',
      }}
    >
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <span
          style={{
            width: 38,
            height: 38,
            borderRadius: '50%',
            background: `${cor}33`,
            border: `2px solid ${cor}`,
            color: cor,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: 16,
            flexShrink: 0,
          }}
        >
          {bot.name.charAt(0).toUpperCase()}
        </span>

        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          {isEditing ? (
            <div>
              <input
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                aria-label="Nome do bot"
                autoFocus
                style={{
                  width: '100%',
                  background: ui.input,
                  border: `1px solid ${erroNome ? ui.danger : ui.border}`,
                  borderRadius: ui.radiusSm,
                  padding: '7px 9px',
                  color: ui.text,
                  fontSize: 13,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
              {erroNome && (
                <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 4 }}>{erroNome}</div>
              )}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 800, color: cor }}>{bot.name}</span>
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 800,
                  background: ui.accent,
                  color: '#fff',
                  padding: '2px 6px',
                  borderRadius: 4,
                }}
              >
                BOT
              </span>
              <span style={{ fontSize: 11, color: ui.muted, fontFamily: 'JetBrains Mono, monospace' }}>
                #{bot.discriminator}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  color: bot.online ? ui.success : ui.muted,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: bot.online ? ui.success : ui.muted,
                  }}
                />
                {bot.online ? 'Online' : 'Offline'}
              </span>
            </div>
          )}

          {!isEditing && (
            <div style={{ fontSize: 11, color: ui.muted, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span>{cargo ? `Cargo: ${cargo.name}` : 'Sem cargo — herda só o básico'}</span>
              <span style={{ color: ui.borderStrong }}>·</span>
              <span>{summary.commands} comando(s)</span>
              {summary.events > 0 && (
                <>
                  <span style={{ color: ui.borderStrong }}>·</span>
                  <span>{summary.events} evento(s)</span>
                </>
              )}
              {summary.perms !== 0 && (
                <>
                  <span style={{ color: ui.borderStrong }}>·</span>
                  <span style={{ color: ui.warning, fontWeight: 700 }}>
                    {BOT_PERM_DEFS.filter((d) => (summary.perms & d.bit) !== 0).length} permissõe(s) admin
                  </span>
                </>
              )}
              {summary.broken && (
                <>
                  <span style={{ color: ui.borderStrong }}>·</span>
                  <span style={{ color: '#ff9c9c', fontWeight: 700 }}>config inválida</span>
                </>
              )}
            </div>
          )}
          {isEditing && erro && (
            <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 5 }}>{erro}</div>
          )}
        </div>

        {isEditing ? (
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            <select
              // Seção 2: value
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              aria-label="Cargo do bot"
              style={{
                background: ui.input,
                color: ui.text,
                border: `1px solid ${ui.border}`,
                borderRadius: ui.radiusSm,
                padding: '7px 9px',
                fontSize: 12,
                maxWidth: 140,
              }}
            >
              <option value="">Sem cargo</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            <Button variant="success" icon="check" onClick={salvar} disabled={salvando || !!erroNome} busy={salvando}>
              Salvar
            </Button>
            <Button onClick={onCancelEdit} disabled={salvando}>
              Cancelar
            </Button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexShrink: 0 }}>
            <Tooltip label="Configurar comandos, token e escopos">
              <IconButton icon="settings" label={`Configurar ${bot.name}`} onClick={onConfigure} size={30} />
            </Tooltip>
            {ehDono && (
              <>
                <Tooltip label={bot.online ? 'Marcar como offline' : 'Marcar como online'}>
                  <IconButton
                    icon={bot.online ? 'eye' : 'eyeOff'}
                    label={bot.online ? `Marcar ${bot.name} como offline` : `Marcar ${bot.name} como online`}
                    onClick={onToggleOnline}
                    size={30}
                  />
                </Tooltip>
                <Tooltip label="Copiar token">
                  <IconButton
                    icon={copied ? 'check' : 'copy'}
                    label={`Copiar o token de ${bot.name}`}
                    onClick={onCopy}
                    size={30}
                  />
                </Tooltip>
                <Tooltip label="Editar nome e cargo">
                  <IconButton icon="edit" label={`Editar ${bot.name}`} onClick={onStartEdit} size={30} />
                </Tooltip>
                <Tooltip label="Remover do servidor">
                  <IconButton icon="trash" label={`Remover ${bot.name}`} onClick={onRemove} size={30} />
                </Tooltip>
              </>
            )}
          </div>
        )}
      </div>

      {!isEditing && copied && (
        <div role="status" style={{ fontSize: 11, color: ui.success, marginTop: 8 }}>
          Token copiado para a área de transferência.
        </div>
      )}
    </div>
  )
}

function BotCreateModal({
  open,
  onClose,
  bots,
  roles,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  bots: BotView[]
  roles: RoleView[]
  onCreate: (data: { name: string; roleId: string | null }) => Promise<void>
}) {
  const [nome, setNome] = useState('')
  const [roleId, setRoleId] = useState('')
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [tocou, setTocou] = useState(false)

  const erroNome = validateBotName(nome, bots)

  async function criar() {
    setTocou(true)
    if (erroNome) return
    setSalvando(true)
    setErro(null)
    try {
      await onCreate({ name: nome.trim(), roleId: roleId || null })
      setNome('')
      setRoleId('')
      setTocou(false)
    } catch (e: any) {
      setErro(String(e?.message ?? e))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Criar bot"
      subtitle="O bot entra no servidor como um membro com um token próprio."
      width={WIDTHS.sm}
      footer={
        <>
          <span style={{ flex: 1 }} />
          <Button onClick={onClose} disabled={salvando}>
            Cancelar
          </Button>
          <Button
            variant="success"
            icon="check"
            onClick={criar}
            disabled={salvando}
            busy={salvando}
          >
            Criar bot
          </Button>
        </>
      }
    >
      {erro && (
        <div style={{ marginBottom: ui.lg }}>
          <Notice tone="danger" icon="warn">
            {erro}
          </Notice>
        </div>
      )}

      <TextField
        label="Nome do bot"
        value={nome}
        onChange={(v) => {
          setNome(v)
          setTocou(true)
        }}
        placeholder="ex.: BotDoClima"
        maxLength={32}
        error={tocou ? erroNome : null}
        autoFocus
        hint="Como o bot aparece na lista de membros deste servidor."
      />

      <Select
        label="Cargo"
        // Seção 3: value
        value={roleId}
        onChange={setRoleId}
        options={[
          { value: '', label: 'Sem cargo (só o básico)' },
          ...roles.map((r) => ({ value: r.id, label: r.name })),
        ]}
        hint="As permissões do bot vêm do cargo escolhido. Dê um cargo restrito a menos que ele realmente precise."
      />

      <Notice tone="info" icon="key">
        O token é criado junto. Ele funciona como senha do bot — quem tiver pode falar
        como ele neste servidor. Você pode vê-lo e regenerá-lo a qualquer momento na
        configuração do bot.
      </Notice>
    </Modal>
  )
}