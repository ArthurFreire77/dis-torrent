// Painel de um SERVIDOR no celular: canais por categoria, quem está na voz e
// as ações que fazem sentido com o dedo (entrar/sair da chamada, criar,
// renomear e apagar canal).
//
// Por que é um arquivo separado: a tela vivia inline no `MobileShell.tsx`
// (193 KB) e despejava os canais numa lista corrida, sem tipo, sem quem está
// na voz e sem ação — o servidor no celular parecia "só leitura". Aqui a
// lista é a mesma fonte de verdade do desktop (`services.channelList`).

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

/** Linha de UM canal: ícone do tipo, nome, quem está na voz e ação. */
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
  // Fonte de participantes é o MOTOR (o mesmo da barra de voz do desktop).
  // Só canais de chamada consultam: um poll por canal de TEXTO era N×15 s de
  // SQLite à toa numa lista longa.
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

/**
 * Lista completa do servidor no celular.
 *
 * - canais agrupados por categoria (mesma ordem do desktop);
 * - voz/vídeo entram na chamada ao tocar (câmera é opcional, dentro da chamada);
 * - o dono ganha as ações de criar/renomear/apagar.
 */
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
  /** Canal em que EU estou na chamada agora (null = fora). */
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
  /** Cargos/tags do servidor — o membro PRECISA ver as tags criadas pelo dono. */
  const [roles, setRoles] = useState<RoleView[]>([])

  const owner = canManageChannels(community.owner_fp, myFp)

  // Recarrega quando o servidor muda e quando o motor avisa que a estrutura
  // mudou (tag/canal criado no PC, sync de estado, entrada de membro).
  useEffect(() => {
    let vivo = true
    const ler = () => {
      services.channelList(community.id)
        .then((list) => { if (vivo) setChannels(Array.isArray(list) ? list : []) })
        .catch(() => { if (vivo) setChannels([]) })
        .finally(() => { if (vivo) setLoading(false) })
    }
    ler()
    // TAGS/CARGOS: vêm do mesmo sync do estado. Sem esta chamada o celular
    // mostrava os canais mas nenhuma tag criada pelo dono no PC.
    let rolesVivo = true
    const lerRoles = () => {
      services.rolesList(community.id)
        .then((list) => { if (rolesVivo) setRoles(Array.isArray(list) ? list : []) })
        .catch(() => { /* sem motor: mantém a lista anterior */ })
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
    // Celular: a WebView congela em segundo plano; ao voltar, relê a lista.
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
    // `groupByCategory` preserva a ordem e devolve categoria vazia agrupada.
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
            {(['text', 'voice', 'video'] as const).map((k) => (
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
                {k === 'text' ? 'texto' : k === 'voice' ? 'voz' : 'vídeo'}
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

      {/* TAGS/CARGOS do servidor: o membro comum via nenhuma tag no celular
          porque esta seção não existia. Leitura pura (edição é do dono no PC). */}
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
