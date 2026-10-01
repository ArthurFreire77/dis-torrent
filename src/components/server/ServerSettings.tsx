// Configurações do servidor.
//
// O problema anterior não era宽度 mas arquitetura: cinco abas num modal de
// 960px, nav de 220px, e cada aba reescrevendo seus próprios inputs. Canais,
// cargos, bots e membros eram quatro formulários diferentes para quatro tarefas
// que pertencem ao mesmo lugar.
//
// Agora é uma tela de verdade: navegação lateral fixa, uma seção por vez, cada
// seção com largura de leitura confortável (~72 caracteres) e uma explicação do
// que cada coisa faz. Os modais de criação/edição saem daqui para
// ChannelManager / RoleEditor / BotConfigPanel.

import { useEffect, useMemo, useState } from 'react'
import type { BotView, ChannelMeta, RoleView } from '../../services/models'
import { mergeChannels } from '../../app/channels'
import { Ic, type IconName } from '../../shared/icons'
import { Tooltip } from '../../shared/Tooltip'
import { LocalLink } from '../../shared/LocalLink'
import {
  Button,
  EmptyState,
  IconButton,
  Notice,
  ui,
} from '../../shared/ui'
import { ChannelEditor, ChannelList, CategoryManager, CATEGORIAS_PADRAO } from './ChannelManager'
import { RoleEditor, RoleList } from './RoleEditor'
import { BotManager } from './BotManager'
import { MemberManager } from './MemberManager'
import { OverviewSection } from './OverviewSection'

export type ServerSection =
  | 'visao-geral'
  | 'canais'
  | 'categorias'
  | 'cargos'
  | 'membros'
  | 'bots'
  | 'convites'

const SECTIONS: { key: ServerSection; label: string; icon: IconName; desc: string }[] = [
  { key: 'visao-geral', label: 'Visão geral', icon: 'server', desc: 'Nome, descrição e identidade do servidor' },
  { key: 'canais', label: 'Canais', icon: 'hash', desc: 'Conversas de texto, voz e vídeo' },
  { key: 'categorias', label: 'Categorias', icon: 'folder', desc: 'Agrupamento dos canais' },
  { key: 'cargos', label: 'Cargos', icon: 'crown', desc: 'Permissões e hierarquia' },
  { key: 'membros', label: 'Membros', icon: 'users', desc: 'Quem participa e com quais cargos' },
  { key: 'bots', label: 'Bots', icon: 'bot', desc: 'Membros automatizados' },
  { key: 'convites', label: 'Convites', icon: 'link', desc: 'Como entrar neste servidor' },
]

export interface ServerSettingsProps {
  serverId: string
  serverName: string
  ownerFp: string
  myFp: string | undefined
  description?: string
  category?: string
  /** Canais: as DUAS listas, já deduplicadas por `mergeChannels`. */
  channelsSummary: [string, string][] | undefined
  channelsFull: ChannelMeta[] | undefined
  members: [string, string, string][]
  roles: RoleView[]
  bots: BotView[]
  memberRoles: Record<string, string[]>
  onClose: () => void
  onRename: (nome: string) => Promise<void>
  onSetMeta: (patch: { description?: string; category?: string }) => Promise<void>
  onChannelCreate: (data: { name: string; topic: string; category: string; kind: 'text' | 'voice' | 'video' }) => Promise<void>
  onChannelUpdate: (id: string, data: { name: string; topic: string; category: string; kind: 'text' | 'voice' | 'video' }) => Promise<void>
  onChannelDelete: (id: string) => Promise<void>
  onChannelMove: (id: string, categoria: string) => Promise<void>
  onRoleSave: (data: { name: string; color: string; permissions: number; hoist: boolean; mentionable: boolean; position: number }, id: string | null) => Promise<void>
  onRoleDelete: (id: string) => Promise<void>
  onMemberAssign: (fp: string, roleId: string) => Promise<void>
  onMemberUnassign: (fp: string, roleId: string) => Promise<void>
  onMemberKick: (fp: string) => Promise<void>
  onBotCreate: (data: { name: string; roleId: string | null }) => Promise<void>
  onBotUpdate: (id: string, patch: { name?: string; roleId?: string | null; online?: boolean }) => Promise<void>
  onBotDelete: (id: string) => Promise<void>
  onConfigBot: (botId: string) => void
  onMakeInvite: () => Promise<string>
  onRefresh: () => void
  error?: string | null
  onError: (msg: string | null) => void
  /** Abre já na seção pedida (o menu da sidebar sabe qual é). */
  initialSection?: ServerSection
  /** Canal a abrir em edição assim que a tela montar. */
  editChannelId?: string | null
  /** Categoria pré-escolhida ao criar canal. */
  presetCategory?: string | null
  onConsumedPending?: () => void
}

export default function ServerSettings(props: ServerSettingsProps) {
  const [section, setSection] = useState<ServerSection>(props.initialSection ?? 'visao-geral')
  const [navAberta, setNavAberta] = useState(false)
  const [editChannel, setEditChannel] = useState<ChannelMeta | null>(null)
  const [channelModal, setChannelModal] = useState(false)
  const [editRoleId, setEditRoleId] = useState<string | null>(null)
  const [roleModal, setRoleModal] = useState(false)

  const ehDono = props.ownerFp === props.myFp

  // FONTE ÚNICA DE VERDADE dos canais. Este é o ponto que elimina o bug de
  // duplicação: antes, cada aba fazia seu próprio merge das duas listas e um
  // deles (painel de bot) não filtrava duplicata.
  const channels = useMemo(
    () => mergeChannels(props.channelsSummary, props.channelsFull),
    [props.channelsSummary, props.channelsFull],
  )
  const categorias = useMemo(() => {
    const achadas = channels.map((c) => c.category).filter(Boolean)
    return [...new Set([...achadas, ...CATEGORIAS_PADRAO])]
  }, [channels])

  const contagemCargo = useMemo(() => {
    const out: Record<string, number> = {}
    for (const lista of Object.values(props.memberRoles)) {
      for (const r of lista) out[r] = (out[r] ?? 0) + 1
    }
    return out
  }, [props.memberRoles])

  const roleEmEdicao = editRoleId ? (props.roles.find((r) => r.id === editRoleId) ?? null) : null

  // Pedido de abertura vinda de fora (menu da sidebar). Consome uma vez só —
  // sem isso o modal reabria a edição a cada re-render.
  useEffect(() => {
    if (props.editChannelId) {
      const c = channels.find((x) => x.id === props.editChannelId)
      if (c) {
        setSection('canais')
        setEditChannel(c)
        setChannelModal(true)
      }
      props.onConsumedPending?.()
    } else if (props.presetCategory) {
      setSection('canais')
      setEditChannel(null)
      setChannelModal(true)
      props.onConsumedPending?.()
    }
    // Só reage à mudança da identidade do pedido, não de cada render.
  }, [props.editChannelId, props.presetCategory])

  // Em tela pequena a nav vira gaveta; trocar de seção a fecha.
  function irPara(s: ServerSection) {
    setSection(s)
    setNavAberta(false)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.75)',
        zIndex: 85,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: ui.lg,
      }}
      onClick={props.onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Configurações de ${props.serverName}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          width: '100%',
          maxWidth: 1120,
          height: '100%',
          maxHeight: '100dvh',
          background: ui.bg,
          border: `1px solid ${ui.border}`,
          borderRadius: ui.radiusLg,
          overflow: 'hidden',
          boxSizing: 'border-box',
        }}
      >
        {/* ---------- navegação ---------- */}
        <nav
          aria-label="Seções do servidor"
          // Em tela estreita a nav só entra no DOM quando a gaveta está aberta
          // (o CSS esconde a versão fixa). No desktop ela é sempre renderizada.
          className={`srv-settings-nav${navAberta ? ' srv-nav-open' : ''}`}
          style={{
            width: 248,
            flexShrink: 0,
            background: ui.surface,
            borderRight: `1px solid ${ui.border}`,
            display: 'flex',
            flexDirection: 'column',
            padding: `${ui.lg}px 10px`,
            boxSizing: 'border-box',
          }}
        >
          <div style={{ padding: `0 ${ui.sm}px ${ui.md}px`, minWidth: 0 }}>
            <div
              style={{
                fontSize: 10,
                fontWeight: 800,
                letterSpacing: 0.8,
                color: ui.muted,
                marginBottom: 6,
              }}
            >
              SERVIDOR
            </div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 800,
                color: ui.heading,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {props.serverName}
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto', flex: 1 }}>
            {SECTIONS.map((s) => {
              const ativo = section === s.key
              const n = contagemDe(s.key, {
                channels: channels.length,
                roles: props.roles.length,
                members: props.members.length,
                bots: props.bots.length,
                categorias: new Set(channels.map((c) => c.category)).size,
              })
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => irPara(s.key)}
                  aria-current={ativo ? 'page' : undefined}
                  title={s.desc}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 11px',
                    background: ativo ? ui.accent : 'transparent',
                    color: ativo ? '#fff' : ui.text,
                    border: 'none',
                    borderRadius: ui.radiusSm,
                    cursor: 'pointer',
                    fontSize: 13,
                    fontWeight: ativo ? 800 : 600,
                    textAlign: 'left',
                    width: '100%',
                  }}
                >
                  <span style={{ display: 'inline-flex', opacity: ativo ? 1 : 0.8 }}>
                    <Ic name={s.icon} size={16} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>{s.label}</span>
                  {n != null && (
                    <span style={{ fontSize: 11, fontWeight: 700, opacity: 0.75 }}>{n}</span>
                  )}
                </button>
              )
            })}
          </div>

          <div style={{ padding: ui.sm, borderTop: `1px solid ${ui.border}`, marginTop: ui.sm }}>
            <Button icon="x" onClick={props.onClose} full>
              Fechar
            </Button>
          </div>
        </nav>

        {/* ---------- conteúdo ---------- */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* barra superior em telas pequenas: gaveta + título da seção */}
          <div
            className="srv-settings-topbar"
            style={{
              display: 'none',
              alignItems: 'center',
              gap: ui.sm,
              padding: `${ui.sm}px ${ui.md}px`,
              borderBottom: `1px solid ${ui.border}`,
              flexShrink: 0,
            }}
          >
            <IconButton
              icon="menu"
              label="Abrir seções"
              onClick={() => setNavAberta(true)}
              size={34}
            />
            <span style={{ flex: 1, fontSize: 14, fontWeight: 800, color: ui.heading, minWidth: 0 }}>
              {SECTIONS.find((s) => s.key === section)?.label}
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: ui.xxl }}>
            {/* Gaveta de seções no mobile */}
            {navAberta && (
              <div
                onClick={() => setNavAberta(false)}
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(0,0,0,.6)',
                  zIndex: 2,
                }}
              />
            )}

            <SectionHead
              icon={SECTIONS.find((s) => s.key === section)!.icon}
              title={SECTIONS.find((s) => s.key === section)!.label}
              desc={SECTIONS.find((s) => s.key === section)!.desc}
            />

            {!ehDono && section !== 'convites' && (
              <div style={{ marginBottom: ui.xl }}>
                <Notice tone="info" icon="info">
                  Só o dono do servidor pode mudar estas configurações. Você pode
                  convidar pessoas e ver quem participa.
                </Notice>
              </div>
            )}

            {props.error && (
              <div style={{ marginBottom: ui.xl }}>
                <Notice tone="danger" icon="warn">
                  {props.error}
                </Notice>
              </div>
            )}

            {/* as seções só abrem para o dono, exceto membros/convites/bots */}
            {section === 'visao-geral' && (
              <OverviewSection
                serverName={props.serverName}
                description={props.description}
                category={props.category}
                ownerFp={props.ownerFp}
                myFp={props.myFp}
                serverId={props.serverId}
                ehDono={ehDono}
                onRename={props.onRename}
                onSetMeta={props.onSetMeta}
                onError={props.onError}
              />
            )}

            {section === 'canais' && (
              <>
              <div
                style={{
                  display: 'flex',
                  gap: ui.sm,
                  justifyContent: 'flex-end',
                  marginBottom: ui.lg,
                  flexWrap: 'wrap',
                }}
              >
                {/* O botão precisa existir TAMBÉM quando há canais. Só no
                    estado vazio ele some quando você cria o primeiro — e aí
                    não há mais como criar o segundo. */}
                {channels.length > 0 && (
                  <Button
                    variant="success"
                    icon="plus"
                    onClick={() => {
                      setEditChannel(null)
                      setChannelModal(true)
                    }}
                  >
                    Criar canal
                  </Button>
                )}
              </div>
              <ChannelList
                channels={channels}
                onEdit={(c) => {
                  setEditChannel(c)
                  setChannelModal(true)
                }}
                onCreate={() => {
                  setEditChannel(null)
                  setChannelModal(true)
                }}
              />
              </>
            )}

            {section === 'categorias' && (
              <CategoryManager
                channels={channels}
                onCreate={(nome) =>
                  props.onChannelCreate({
                    name: 'geral',
                    topic: '',
                    category: nome,
                    kind: 'text',
                  })
                }
                onMoveChannels={props.onChannelMove}
              />
            )}

            {section === 'cargos' && (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(200px, 260px) 1fr',
                  gap: ui.xl,
                  alignItems: 'start',
                }}
                className="srv-roles-grid"
              >
                <RoleList
                  roles={props.roles}
                  selectedId={editRoleId}
                  memberCount={contagemCargo}
                  onSelect={(id) => {
                    setEditRoleId(id)
                    setRoleModal(true)
                  }}
                  onCreate={() => {
                    setEditRoleId(null)
                    setRoleModal(true)
                  }}
                />
                <div style={{ minWidth: 0 }}>
                  {props.roles.length === 0 ? (
                    <EmptyState
                      icon="crown"
                      title="Nenhum cargo ainda"
                      hint="Cargos dizem o que cada pessoa pode fazer. Comece com um cargo “Membro” que só vê e escreve nos canais."
                      action={
                        <Button
                          variant="success"
                          icon="plus"
                          onClick={() => {
                            setEditRoleId(null)
                            setRoleModal(true)
                          }}
                        >
                          Criar primeiro cargo
                        </Button>
                      }
                    />
                  ) : (
                    <RoleSummary
                      roles={props.roles}
                      memberCount={contagemCargo}
                      onEdit={(id) => {
                        setEditRoleId(id)
                        setRoleModal(true)
                      }}
                    />
                  )}
                </div>
              </div>
            )}

            {section === 'membros' && (
              <MemberManager
                members={props.members}
                roles={props.roles}
                memberRoles={props.memberRoles}
                ownerFp={props.ownerFp}
                myFp={props.myFp}
                onAssign={props.onMemberAssign}
                onUnassign={props.onMemberUnassign}
                onKick={props.onMemberKick}
              />
            )}

            {section === 'bots' && (
              <BotManager
                bots={props.bots}
                roles={props.roles}
                ehDono={ehDono}
                onCreate={props.onBotCreate}
                onUpdate={props.onBotUpdate}
                onDelete={props.onBotDelete}
                onConfigure={props.onConfigBot}
              />
            )}

            {section === 'convites' && (
              <ConviteSection
                serverName={props.serverName}
                onMakeInvite={props.onMakeInvite}
                memberCount={props.members.length}
                channels={channels}
              />
            )}
          </div>
        </div>
      </div>

      {/* ---------- modais ---------- */}
      <ChannelEditor
        open={channelModal}
        onClose={() => setChannelModal(false)}
        channels={channels}
        channel={editChannel}
        categorias={categorias}
        presetCategory={props.presetCategory ?? undefined}
        onSave={async (data) => {
          if (editChannel) await props.onChannelUpdate(editChannel.id, data)
          else await props.onChannelCreate(data)
        }}
        onDelete={async (c) => {
          await props.onChannelDelete(c.id)
        }}
      />

      <RoleEditor
        open={roleModal}
        onClose={() => setRoleModal(false)}
        roles={props.roles}
        role={roleEmEdicao}
        memberCount={contagemCargo}
        onSave={(data) => props.onRoleSave(data, editRoleId)}
        onDelete={(r) => props.onRoleDelete(r.id)}
      />
    </div>
  )
}

function contagemDe(
  k: ServerSection,
  c: { channels: number; roles: number; members: number; bots: number; categorias: number },
): number | null {
  switch (k) {
    case 'canais':
      return c.channels
    case 'categorias':
      return c.categorias
    case 'cargos':
      return c.roles
    case 'membros':
      return c.members
    case 'bots':
      return c.bots
    default:
      return null
  }
}

function SectionHead({ icon, title, desc }: { icon: IconName; title: string; desc: string }) {
  return (
    <div style={{ display: 'flex', gap: ui.md, alignItems: 'flex-start', marginBottom: ui.xxl }}>
      <span style={{ color: ui.accent, marginTop: 2, display: 'inline-flex' }}>
        <Ic name={icon} size={22} />
      </span>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: 21, fontWeight: 800, color: ui.heading, margin: 0 }}>{title}</h2>
        <p style={{ fontSize: 13, color: ui.muted, marginTop: 5, lineHeight: 1.5, maxWidth: 640 }}>
          {desc}
        </p>
      </div>
    </div>
  )
}

/** Resumo dos cargos: visão geral sem abrir modal. */
function RoleSummary({
  roles,
  memberCount,
  onEdit,
}: {
  roles: RoleView[]
  memberCount: Record<string, number>
  onEdit: (id: string) => void
}) {
  const ordenados = useMemo(
    () => [...roles].sort((a, b) => b.position - a.position),
    [roles],
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm }}>
      <Notice tone="info" icon="info">
        A posição define a ordem na lista de membros: quanto maior o número, mais embaixo o
        cargo aparece. Permissões são explicadas dentro de cada cargo.
      </Notice>
      {ordenados.map((r) => (
        <button
          key={r.id}
          type="button"
          onClick={() => onEdit(r.id)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            background: ui.surface,
            border: `1px solid ${ui.border}`,
            borderLeft: `3px solid ${r.color}`,
            borderRadius: ui.radius,
            padding: '12px 14px',
            cursor: 'pointer',
            textAlign: 'left',
            width: '100%',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: r.color }}>{r.name}</div>
            <div style={{ fontSize: 11, color: ui.muted, marginTop: 3 }}>
              {memberCount[r.id] ?? 0} pessoa{(memberCount[r.id] ?? 0) === 1 ? '' : 's'} · posição{' '}
              {r.position}
              {r.hoist ? ' · seção própria' : ''}
            </div>
          </div>
          <Tooltip label={`Editar ${r.name}`}>
            <span style={{ display: 'inline-flex' }}>
              <Ic name="edit" size={15} color={ui.muted} />
            </span>
          </Tooltip>
        </button>
      ))}
    </div>
  )
}

function ConviteSection({
  serverName,
  onMakeInvite,
  memberCount,
  channels,
}: {
  serverName: string
  onMakeInvite: () => Promise<string>
  memberCount: number
  channels: ChannelMeta[]
}) {
  const [token, setToken] = useState('')
  const [gerando, setGerando] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  useEffect(() => {
    if (!copiado) return
    const t = setTimeout(() => setCopiado(false), 2200)
    return () => clearTimeout(t)
  }, [copiado])

  async function gerar() {
    setGerando(true)
    setErro(null)
    try {
      setToken(await onMakeInvite())
    } catch (e: any) {
      setErro(String(e?.message ?? e))
    } finally {
      setGerando(false)
    }
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const inviteUrl = token ? `${origin}/invite/${token}` : ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.xl, maxWidth: 720 }}>
      {erro && <Notice tone="danger" icon="warn">{erro}</Notice>}

      <Notice tone="info" icon="info">
        Um convite dá acesso a este servidor. Quem tem o link entra direto, sem precisar
        de autorização sua. Se vazar, gere outro — o antigo deixa de valer.
      </Notice>

      <div
        style={{
          display: 'flex',
          gap: ui.md,
          alignItems: 'center',
          background: ui.surface,
          border: `1px solid ${ui.border}`,
          borderRadius: ui.radius,
          padding: ui.lg,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: ui.heading }}>
            Gerar link de convite
          </div>
          <div style={{ fontSize: 12, color: ui.muted, marginTop: 3, lineHeight: 1.5 }}>
            {memberCount} pessoa{memberCount === 1 ? '' : 's'} neste servidor ·{' '}
            {channels.length} canal{channels.length === 1 ? '' : 'is'}
          </div>
        </div>
        <Button
          variant="success"
          icon={token ? 'refresh' : 'link'}
          onClick={gerar}
          disabled={gerando}
          busy={gerando}
        >
          {token ? 'Gerar outro' : 'Gerar convite'}
        </Button>
      </div>

      {token && (
        <>
          <LocalLink
            url={inviteUrl}
            label="Link de convite"
            context={`Link para entrar em ${serverName}. Qualquer pessoa com ele entra direto.`}
          />
          <div
            style={{
              display: 'flex',
              gap: ui.sm,
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Button
              icon={copiado ? 'check' : 'copy'}
              variant={copiado ? 'success' : 'secondary'}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(inviteUrl)
                  setCopiado(true)
                } catch {
                  setErro('Não foi possível copiar. Selecione o link acima e copie.')
                }
              }}
            >
              {copiado ? 'Copiado' : 'Copiar link'}
            </Button>
            <Button
              icon="terminal"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token)
                  setCopiado(true)
                } catch {
                  setErro('Não foi possível copiar o token.')
                }
              }}
            >
              Copiar só o token
            </Button>
          </div>
          <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.5 }}>
            O token puro é útil para quem prefere colar em “Entrar com convite” em vez de
            abrir o link.
          </div>
        </>
      )}

      {channels.length === 0 && (
        <EmptyState
          icon="hash"
          title="Este servidor ainda não tem canais"
          hint="Crie um canal antes de convidar — quem entra sem nenhum canal não tem onde conversar."
        />
      )}
    </div>
  )
}