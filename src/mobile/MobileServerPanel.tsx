import { useEffect, useMemo, useState } from 'react'
import { Ic } from '../shared/icons'
import { services } from '../services'
import type { ChannelMeta, CommunityView, RoleView } from '../services/models'
import { groupByCategory } from '../app/channels'
import { useChannelVoicePeers } from '../components/calls/ChannelVoicePeers'
import {
  canManageChannels,
  channelActionLabel,
  channelIcon,
  defaultCategoryFor,
  normalizeChannelName,
} from './mobileServerModel'

const T = {
  rail: '#0f1115', panel: '#1e2128', input: '#23262f', hover: '#2a2d36',
  border: '#242830', accent: '#5865f2', green: '#23a559', red: '#f23f42',
  text: '#f2f3f5', heading: '#ffffff', muted: '#8e929b', yellow: '#f0b232',
}

/** Cargos no celular: criar e dar/tirar de cada membro. Antes só as tags apareciam. */
function CargosPanel({
  community,
  myFp,
  roles,
  onRolesChanged,
  onError,
}: {
  community: CommunityView
  myFp: string
  roles: RoleView[]
  onRolesChanged: (lista: RoleView[]) => void
  onError: (msg: string) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [nome, setNome] = useState('')
  const [cor, setCor] = useState('#5865f2')
  const [salvando, setSalvando] = useState(false)
  const [membro, setMembro] = useState<string>('')
  const [doMembro, setDoMembro] = useState<string[]>([])

  const membros = (community.members ?? []).map(([fp, nickname]) => ({ fp, nickname }))

  const recarregar = async () => {
    try { onRolesChanged(await services.rolesList(community.id)) } catch {  }
  }

  useEffect(() => {
    if (!aberto || !membro) { setDoMembro([]); return }
    let vivo = true
    services.memberRoles(community.id, membro)
      .then((l) => { if (vivo) setDoMembro(Array.isArray(l) ? l : []) })
      .catch(() => { if (vivo) setDoMembro([]) })
    return () => { vivo = false }
  }, [aberto, membro, community.id])

  async function criarCargo() {
    const limpo = nome.trim()
    if (!limpo || salvando) return
    setSalvando(true)
    try {
      await services.roleCreate(community.id, {
        name: limpo,
        color: cor,
        permissions: 96,
        hoist: false,
        mentionable: true,
        position: roles.length,
      })
      setNome('')
      await recarregar()
    } catch (e) {
      onError((e as Error)?.message ?? String(e))
    } finally {
      setSalvando(false)
    }
  }

  async function alternarCargo(roleId: string) {
    if (!membro || !roleId) return
    try {
      if (doMembro.includes(roleId)) {
        await services.memberUnassignRole(community.id, membro, roleId)
        setDoMembro((cur) => cur.filter((r) => r !== roleId))
      } else {
        await services.memberAssignRole(community.id, membro, roleId)
        setDoMembro((cur) => [...cur, roleId])
      }
    } catch (e) {
      onError((e as Error)?.message ?? String(e))
    }
  }

  async function apagarCargo(roleId: string) {
    try {
      await services.roleDelete(community.id, roleId)
      await recarregar()
    } catch (e) {
      onError((e as Error)?.message ?? String(e))
    }
  }

  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        aria-expanded={aberto}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%',
          background: aberto ? T.accent : T.input, border: `1px solid ${T.border}`,
          color: aberto ? '#fff' : T.text, borderRadius: 8,
          padding: '8px 10px', fontSize: 12, fontWeight: 800, cursor: 'pointer',
        }}
      >
        <Ic name="crown" size={13} />
        <span style={{ flex: 1, textAlign: 'left' }}>Cargos{roles.length > 0 ? ` · ${roles.length}` : ''}</span>
        <span style={{ fontSize: 10, opacity: 0.8 }}>{aberto ? 'fechar' : 'gerenciar'}</span>
      </button>

      {aberto && (
        <>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              placeholder="nome do cargo"
              aria-label="Nome do novo cargo"
              maxLength={32}
              style={{ flex: 1, minWidth: 0, background: T.input, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, padding: '8px 10px', fontSize: 13 }}
            />
            <input
              type="color"
              value={cor}
              onChange={(e) => setCor(e.target.value)}
              aria-label="Cor do cargo"
              style={{ width: 42, background: T.input, border: `1px solid ${T.border}`, borderRadius: 8, padding: 2 }}
            />
            <button
              type="button"
              onClick={() => void criarCargo()}
              disabled={salvando || !nome.trim()}
              style={{ background: T.green, border: 'none', color: '#fff', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 800, opacity: salvando || !nome.trim() ? 0.6 : 1 }}
            >{salvando ? '…' : 'Criar'}</button>
          </div>

          {roles.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {roles.map((r) => (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8, padding: '5px 8px' }}>
                  <span style={{ width: 9, height: 9, borderRadius: '50%', background: r.color || T.muted, flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                  <button
                    type="button"
                    onClick={() => void apagarCargo(r.id)}
                    aria-label={`Apagar cargo ${r.name}`}
                    style={{ background: 'transparent', border: 'none', color: T.muted, cursor: 'pointer', padding: 4, display: 'flex' }}
                  ><Ic name="trash" size={13} /></button>
                </div>
              ))}
            </div>
          )}

          {membros.length > 0 && roles.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: T.input, border: `1px solid ${T.border}`, borderRadius: 10, padding: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.6, color: T.muted }}>DAR CARGO A UM MEMBRO</div>
              <select
                value={membro}
                onChange={(e) => setMembro(e.target.value)}
                aria-label="Escolher membro"
                style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, padding: '7px 8px', fontSize: 12.5 }}
              >
                <option value="">escolha o membro…</option>
                {membros.map((m) => (
                  <option key={m.fp} value={m.fp}>
                    {m.nickname || m.fp.slice(0, 8)}{m.fp === myFp ? ' (você)' : ''}
                  </option>
                ))}
              </select>

              {membro && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {[...roles]
                    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
                    .map((r) => {
                      const tem = doMembro.includes(r.id)
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => void alternarCargo(r.id)}
                          aria-pressed={tem}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            background: tem ? `${r.color || T.accent}33` : T.panel,
                            border: `1px solid ${tem ? (r.color || T.accent) : T.border}`,
                            color: tem ? T.heading : T.muted,
                            borderRadius: 99, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                          }}
                        >
                          {tem ? '✓ ' : '+ '}{r.name}
                        </button>
                      )
                    })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ChannelRow({
  communityId,
  channel,
  myFp,
  selected,
  inChannel,
  onOpenText,
  onJoinCall,
  onManage,
}: {
  communityId: string
  channel: ChannelMeta
  myFp: string
  selected: boolean
  inChannel: boolean
  onOpenText: () => void
  onJoinCall: () => void
  onManage?: () => void
}) {
  const callable = channel.kind === 'voice' || channel.kind === 'video'
  const peers = useChannelVoicePeers(communityId, channel.id, callable, myFp)
  const isCall = callable

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 2,
        borderRadius: 8, padding: '2px 2px',
        background: selected ? T.hover : 'transparent',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <button
          type="button"
          onClick={callable ? onJoinCall : onOpenText}
          aria-label={channelActionLabel(channel.kind, peers.length, inChannel)}
          title={channelActionLabel(channel.kind, peers.length, inChannel)}
          aria-current={selected ? 'true' : undefined}
          style={{
            flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8,
            background: 'transparent', border: 'none', cursor: 'pointer',
            color: inChannel ? T.green : T.text, textAlign: 'left',
            padding: '8px 6px', fontSize: 13.5, fontWeight: 600,
          }}
        >
          <span style={{ display: 'flex', flexShrink: 0, opacity: 0.75 }}>
            <Ic name={channelIcon(channel.kind)} size={16} />
          </span>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {channel.name}
          </span>
          {callable && (
            <span style={{
              fontSize: 9.5, fontWeight: 800, letterSpacing: 0.3, flexShrink: 0,
              color: inChannel ? T.green : T.muted,
              border: `1px solid ${inChannel ? T.green : T.border}`,
              borderRadius: 99, padding: '1px 6px',
            }}>
              {inChannel ? 'NA CHAMADA' : 'ENTRAR'}
            </span>
          )}
        </button>
        {onManage && (
          <button
            type="button"
            onClick={onManage}
            aria-label={`Gerenciar canal ${channel.name}`}
            title="Gerenciar canal"
            style={{
              width: 34, height: 34, flexShrink: 0, borderRadius: 8,
              background: T.input, border: `1px solid ${T.border}`,
              color: T.muted, display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Ic name="edit" size={14} />
          </button>
        )}
      </div>
      {isCall && peers.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, paddingLeft: 30, paddingBottom: 4 }}>
          {peers.map((p) => {
            const eu = p.fp === myFp
            const mudo = p.muted || p.deafened
            return (
              <span
                key={p.fp}
                title={p.deafened ? 'surdo' : p.muted ? 'microfone mudo' : 'com microfone aberto'}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  fontSize: 10, fontWeight: 700, color: mudo ? T.muted : T.text,
                  background: T.input, border: `1px solid ${T.border}`,
                  borderRadius: 99, padding: '2px 7px', maxWidth: 150,
                }}
              >
                <span style={{ display: 'flex', color: mudo ? T.red : T.green }}>
                  <Ic name={p.deafened ? 'volumeX' : p.muted ? 'micOff' : 'mic'} size={9} />
                </span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {eu ? 'você' : p.fp.slice(0, 8)}
                </span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function MobileServerPanel({
  community,
  myFp,
  selectedChannelId,
  inCallChannelId,
  onOpenText,
  onJoinCall,
  onLeaveCall,
  onError,
}: {
  community: CommunityView
  myFp: string
  selectedChannelId: string | null
  inCallChannelId: string | null
  onOpenText: (channelId: string) => void
  onJoinCall: (channelId: string) => void
  onLeaveCall: () => void
  onError: (msg: string) => void
}) {
  const [channels, setChannels] = useState<ChannelMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [novoNome, setNovoNome] = useState('')
  const [novoTipo, setNovoTipo] = useState<'text' | 'voice' | 'video'>('text')
  const [criando, setCriando] = useState(false)
  const [menuCanal, setMenuCanal] = useState<ChannelMeta | null>(null)
  const [roles, setRoles] = useState<RoleView[]>([])

  const owner = canManageChannels(community.owner_fp, myFp)

  useEffect(() => {
    let vivo = true
    const ler = () => {
      services.channelList(community.id)
        .then((list) => { if (vivo) setChannels(Array.isArray(list) ? list : []) })
        .catch(() => { if (vivo) setChannels([]) })
        .finally(() => { if (vivo) setLoading(false) })
    }
    ler()
    let rolesVivo = true
    const lerRoles = () => {
      services.rolesList(community.id)
        .then((list) => { if (rolesVivo) setRoles(Array.isArray(list) ? list : []) })
        .catch(() => {  })
    }
    lerRoles()
    const off = services.subscribe((ev) => {
      if (
        ev.type === 'community_joined' ||
        ev.type === 'channel_created' ||
        ev.type === 'channel_deleted' ||
        ev.type === 'role_created' ||
        ev.type === 'role_deleted' ||
        ev.type === 'group_synced'
      ) {
        ler()
        lerRoles()
      }
    })
    const onVisible = () => { if (!document.hidden) { ler(); lerRoles() } }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      vivo = false
      rolesVivo = false
      off()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [community.id])

  const grupos = useMemo(() => {
    return groupByCategory(channels)
  }, [channels])

  async function criar() {
    const nome = normalizeChannelName(novoNome)
    if (!nome || busy) return
    setBusy(true)
    try {
      await services.channelCreate(community.id, nome, {
        kind: novoTipo,
        category: defaultCategoryFor(novoTipo),
      })
      setNovoNome('')
      setCriando(false)
      setChannels(await services.channelList(community.id))
    } catch (e) {
      onError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function apagar(ch: ChannelMeta) {
    if (!confirm(`Apagar o canal #${ch.name}? O histórico dele some.`)) return
    try {
      await services.channelDelete(community.id, ch.id)
      setMenuCanal(null)
      setChannels(await services.channelList(community.id))
    } catch (e) {
      onError((e as Error)?.message ?? String(e))
    }
  }

  async function renomear(ch: ChannelMeta) {
    const novo = prompt(`Novo nome para #${ch.name}:`, ch.name)
    if (novo === null) return
    const limpo = normalizeChannelName(novo)
    if (!limpo || limpo === ch.name) { setMenuCanal(null); return }
    try {
      await services.channelRename(community.id, ch.id, limpo)
      setMenuCanal(null)
      setChannels(await services.channelList(community.id))
    } catch (e) {
      onError((e as Error)?.message ?? String(e))
    }
  }

  function abrirCanal(ch: ChannelMeta) {
    if (ch.kind === 'voice' || ch.kind === 'video') {
      if (inCallChannelId === ch.id) onLeaveCall()
      else onJoinCall(ch.id)
      return
    }
    onOpenText(ch.id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 800, letterSpacing: 0.8, color: T.muted }}>
          CANAIS
        </div>
        {owner && (
          <button
            type="button"
            onClick={() => setCriando((v) => !v)}
            aria-expanded={criando}
            aria-label="Criar canal"
            title="Criar canal"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: criando ? T.accent : T.input, border: `1px solid ${T.border}`,
              color: criando ? '#fff' : T.text, borderRadius: 8,
              padding: '7px 10px', fontSize: 11.5, fontWeight: 800,
            }}
          >
            <Ic name="plus" size={13} /> Canal
          </button>
        )}
      </div>

      {owner && criando && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, background: T.input, border: `1px solid ${T.border}`, borderRadius: 10, padding: 8 }}>
          <input
            value={novoNome}
            onChange={(e) => setNovoNome(e.target.value)}
            placeholder="nome-do-canal"
            aria-label="Nome do novo canal"
            maxLength={64}
            style={{ background: T.panel, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, padding: '8px 10px', fontSize: 13 }}
          />
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {
}
            {(['text', 'voice'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setNovoTipo(k)}
                aria-pressed={novoTipo === k}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: novoTipo === k ? T.accent : T.panel,
                  border: `1px solid ${T.border}`, borderRadius: 99,
                  color: novoTipo === k ? '#fff' : T.text,
                  padding: '5px 10px', fontSize: 11, fontWeight: 700,
                }}
              >
                <Ic name={channelIcon(k)} size={12} />
                {k === 'text' ? 'texto' : 'voz'}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              onClick={() => void criar()}
              disabled={busy || !normalizeChannelName(novoNome)}
              style={{ flex: 1, background: T.green, border: 'none', color: '#fff', borderRadius: 8, padding: '9px', fontSize: 12.5, fontWeight: 800, opacity: busy || !normalizeChannelName(novoNome) ? 0.6 : 1 }}
            >
              {busy ? 'Criando…' : 'Criar'}
            </button>
            <button
              type="button"
              onClick={() => { setCriando(false); setNovoNome('') }}
              style={{ background: T.panel, border: `1px solid ${T.border}`, color: T.text, borderRadius: 8, padding: '9px 12px', fontSize: 12.5 }}
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 12, color: T.muted, padding: '8px 2px' }}>Carregando canais…</div>
      ) : grupos.length === 0 ? (
        <div style={{ fontSize: 12, color: T.muted, lineHeight: 1.6, padding: '6px 2px' }}>
          Nenhum canal sincronizado ainda. Se você acabou de entrar, o dono precisa estar online
          uma vez para o estado do servidor chegar aqui.
        </div>
      ) : (
        grupos.map((g) => (
          <div key={g.category} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.7, color: T.muted, padding: '4px 6px' }}>
              {g.category.toUpperCase()}
            </div>
            {g.channels.map((ch) => (
              <ChannelRow
                key={ch.id}
                communityId={community.id}
                channel={ch}
                myFp={myFp}
                selected={selectedChannelId === ch.id}
                inChannel={inCallChannelId === ch.id}
                onOpenText={() => abrirCanal(ch)}
                onJoinCall={() => abrirCanal(ch)}
                onManage={owner ? () => setMenuCanal(ch) : undefined}
              />
            ))}
          </div>
        ))
      )}

      {
}
      {roles.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
          <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.7, color: T.muted, padding: '4px 6px' }}>
            TAGS DO SERVIDOR
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {[...roles]
              .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
              .map((r) => (
                <span
                  key={r.id}
                  title={r.hoist ? `${r.name} — seção própria` : r.name}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    fontSize: 11, fontWeight: 700,
                    color: r.color || T.text,
                    background: `${r.color || '#8e929b'}22`,
                    border: `1px solid ${r.color || T.border}`,
                    borderRadius: 99, padding: '3px 9px',
                  }}
                >
                  {r.name}
                </span>
              ))}
          </div>
        </div>
      )}

      {owner && (
        <CargosPanel
          community={community}
          myFp={myFp}
          roles={roles}
          onRolesChanged={(lista) => setRoles(lista)}
          onError={onError}
        />
      )}

      {menuCanal && (
        <div
          role="dialog"
          aria-label={`Canal ${menuCanal.name}`}
          onClick={() => setMenuCanal(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 340, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: '100%', background: T.panel, borderTop: `1px solid ${T.border}`, borderRadius: 16, padding: 14, paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
          >
            <div style={{ fontSize: 14, fontWeight: 800, color: T.heading, marginBottom: 4 }}>#{menuCanal.name}</div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 12 }}>
              {menuCanal.kind === 'voice' ? 'Canal de voz' : menuCanal.kind === 'video' ? 'Canal de vídeo (câmera opcional)' : 'Canal de texto'}
              {menuCanal.topic ? ` · ${menuCanal.topic}` : ''}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button
                type="button"
                onClick={() => void renomear(menuCanal)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.input, border: `1px solid ${T.border}`, color: T.text, borderRadius: 8, padding: '11px 12px', fontSize: 13, fontWeight: 600 }}
              >
                <Ic name="edit" size={15} /> Renomear
              </button>
              <button
                type="button"
                onClick={() => void apagar(menuCanal)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, background: T.input, border: `1px solid ${T.border}`, color: T.red, borderRadius: 8, padding: '11px 12px', fontSize: 13, fontWeight: 600 }}
              >
                <Ic name="trash" size={15} /> Apagar canal
              </button>
              <button
                type="button"
                onClick={() => setMenuCanal(null)}
                style={{ background: 'transparent', border: 'none', color: T.muted, padding: '10px', fontSize: 12.5 }}
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
