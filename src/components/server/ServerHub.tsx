// Hub de servidores — o MESMO fluxo no desktop e no celular (`mode`):
// desktop pode criar e entrar por convite; mobile só entra (decisão de produto).
// Unifica três caminhos desktop de convite que antes divergiam (um gerava token
// com o fp do criador — inútil a terceiros; outro usava `tauri.localhost`).
// Honestidade: `joinCommunity` devolve "pedido enviado" (não "membro"); estado
// de membro vem de `communityMembers`; silenciar é preferência local.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Ic } from '../../shared/icons'
import { Button, IconButton, Modal, Notice, TextField, ui } from '../../shared/ui'
import { isMutedServer, toggleMuteServer } from '../../shared/prefs'
import { services } from '../../services'
import type { CommunityView, InviteView, MemberPairing } from '../../services/models'
import { tokenFromInviteUrl } from '../../services/deepLink'

/** Item da lista de servidores com o resumo de pareamento. */
export interface ServerSummary {
  community: CommunityView
  online: number
  total: number
  /** `true` quando o próprio nó ainda aguarda confirmação de entrada. */
  pending: boolean
}

const PAIR_LABEL: Record<MemberPairing['state'], string> = {
  connected: 'Conectado',
  relay: 'Conectado por relay',
  connecting: 'Conectando',
  reconnecting: 'Reconectando',
  pending_join: 'Aguardando o dono',
  offline: 'Indisponível',
}

const PAIR_COLOR = (state: MemberPairing['state']): string => {
  switch (state) {
    case 'connected':
      return '#23a559'
    case 'relay':
      return '#f0b232'
    case 'connecting':
    case 'reconnecting':
      return '#5865f2'
    case 'pending_join':
      return '#f0b232'
    default:
      return '#80848e'
  }
}

/** Resumo dos membros de um servidor, calculado a partir dos estados reais. */
export function summarize(members: MemberPairing[]): { online: number; total: number; pending: boolean } {
  const total = members.length
  let online = 0
  let pending = false
  for (const m of members) {
    if (m.state === 'connected' || m.state === 'relay') online += 1
    if (m.state === 'pending_join') pending = true
  }
  return { online, total, pending }
}

// `copyText`/`readClipboard` em `shared/clipboard.ts` (fonte única); reexportados
// pois shells e formulário de convite já importam daqui.
import { copyText, readClipboard } from '../../shared/clipboard'
export { copyText, readClipboard }

// ---------------------------------------------------------------- lista

export function ServerList({
  servers,
  selectedId,
  onSelect,
  emptyHint,
}: {
  servers: ServerSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  emptyHint?: string
}) {
  if (servers.length === 0) {
    return (
      <div style={{ fontSize: 12.5, color: ui.muted, lineHeight: 1.6, padding: '10px 2px' }}>
        {emptyHint ?? 'Nenhum servidor ainda. Entre com um convite para começar.'}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {servers.map(({ community, online, total, pending }) => {
        const active = community.id === selectedId
        const muted = isMutedServer(community.id)
        return (
          <button
            key={community.id}
            type="button"
            onClick={() => onSelect(community.id)}
            aria-current={active ? 'true' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              minWidth: 0,
              textAlign: 'left',
              background: active ? ui.surfaceHover : 'transparent',
              border: `1px solid ${active ? ui.borderStrong : 'transparent'}`,
              borderRadius: ui.radius,
              padding: '9px 10px',
              color: ui.text,
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden
              style={{
                width: 30,
                height: 30,
                borderRadius: 10,
                flexShrink: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: active ? ui.accent : ui.input,
                color: active ? '#fff' : ui.muted,
                fontWeight: 800,
                fontSize: 13,
                opacity: muted ? 0.55 : 1,
              }}
            >
              {(community.name || '?').charAt(0).toUpperCase()}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 13.5,
                  fontWeight: 700,
                  color: active ? ui.heading : ui.text,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {community.name}
                {muted && (
                  <span title="Notificações silenciadas" style={{ marginLeft: 6, color: ui.muted }}>
                    <Ic name="eyeOff" size={11} />
                  </span>
                )}
              </span>
              <span style={{ display: 'block', fontSize: 11, color: ui.muted, marginTop: 2 }}>
                {pending
                  ? 'aguardando confirmação do dono'
                  : `${online}/${total} ${total === 1 ? 'membro pareado' : 'membros pareados'}`}
              </span>
            </span>
            {!muted && online > 0 && (
              <span
                title={`${online} online`}
                style={{ width: 8, height: 8, borderRadius: '50%', background: '#23a559', flexShrink: 0 }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------- membros

export function MemberPairingList({
  members,
  emptyHint,
}: {
  members: MemberPairing[]
  emptyHint?: string
}) {
  if (members.length === 0) {
    return (
      <div style={{ fontSize: 12, color: ui.muted, lineHeight: 1.6 }}>
        {emptyHint ?? 'Nenhum membro sincronizado ainda.'}
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {members.map((m) => (
        <div
          key={m.fp}
          style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', minWidth: 0 }}
        >
          <span
            aria-hidden
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: PAIR_COLOR(m.state),
              flexShrink: 0,
            }}
          />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 12.5,
                fontWeight: 600,
                color: ui.text,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {m.nickname || m.fp}
              {m.is_self && (
                <span style={{ color: ui.muted, fontWeight: 500 }}> (você)</span>
              )}
            </span>
            <span style={{ display: 'block', fontSize: 10.5, color: ui.muted, fontFamily: 'JetBrains Mono, monospace' }}>
              {m.is_owner ? 'dono · ' : ''}
              {m.fp.slice(0, 12)}
            </span>
          </span>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              color: PAIR_COLOR(m.state),
              flexShrink: 0,
              textAlign: 'right',
            }}
          >
            {PAIR_LABEL[m.state]}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- convite

/**
 * Painel de convite: gera, copia TOKEN (principal — funciona por qualquer app,
 * sem depender de esquema registrado) e link (atalho secundário).
 */
export function InvitePanel({
  communityId,
  canCreateInvite,
  onError,
}: {
  communityId: string
  /** Só o dono assina convite; membro comum vê a explicação, não o botão morto. */
  canCreateInvite: boolean
  onError: (msg: string) => void
}) {
  const [invite, setInvite] = useState<InviteView | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<'token' | 'link' | null>(null)

  useEffect(() => {
    setInvite(null)
    setCopied(null)
  }, [communityId])

  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(null), 2200)
    return () => window.clearTimeout(t)
  }, [copied])

  async function gerar() {
    if (busy) return
    setBusy(true)
    try {
      // Sem `memberFp`: convite ABERTO (fp próprio criava token inútil a terceiros).
      const v = await services.makeInviteLink(communityId)
      setInvite(v)
    } catch (e) {
      onError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  async function copiar(kind: 'token' | 'link') {
    if (!invite) return
    const ok = await copyText(kind === 'token' ? invite.token : invite.link)
    if (!ok) {
      onError('não foi possível copiar — selecione o texto e copie manualmente')
      return
    }
    setCopied(kind)
  }

  if (!canCreateInvite) {
    return (
      <Notice tone="info" icon="info">
        Só o dono do servidor gera convites. Peça um token a quem criou — qualquer
        membro pode entrar com ele pelo botão “Entrar com convite”.
      </Notice>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.md, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: ui.muted, lineHeight: 1.6 }}>
        O <strong style={{ color: ui.text }}>token</strong> é o mecanismo principal: cole-o
        no DisTorrent do outro aparelho e a entrada funciona em qualquer plataforma. O{' '}
        <strong style={{ color: ui.text }}>link</strong> é um atalho que só abre se o
        aplicativo estiver instalado.
      </div>

      {invite ? (
        <>
          <div
            style={{
              background: ui.input,
              border: `1px solid ${ui.border}`,
              borderRadius: ui.radius,
              padding: '10px 12px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
              minWidth: 0,
            }}
          >
            <code
              style={{
                flex: '1 1 220px',
                minWidth: 0,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11.5,
                color: ui.link,
                wordBreak: 'break-all',
                lineHeight: 1.55,
              }}
            >
              {invite.token}
            </code>
            <Button
              icon={copied === 'token' ? 'check' : 'copy'}
              variant={copied === 'token' ? 'success' : 'primary'}
              onClick={() => void copiar('token')}
            >
              {copied === 'token' ? 'Copiado' : 'Copiar token'}
            </Button>
          </div>

          <div style={{ display: 'flex', gap: ui.sm, flexWrap: 'wrap' }}>
            <Button
              icon={copied === 'link' ? 'check' : 'link'}
              variant="secondary"
              onClick={() => void copiar('link')}
            >
              {copied === 'link' ? 'Link copiado' : 'Copiar link'}
            </Button>
            <Button icon="refresh" variant="ghost" busy={busy} onClick={() => void gerar()}>
              Gerar outro
            </Button>
          </div>

          <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.55 }}>
            Vale até{' '}
            {new Date(invite.expires_at_ms).toLocaleString(undefined, {
              dateStyle: 'short',
              timeStyle: 'short',
            })}
            . {invite.scope === 'open'
              ? 'Convite aberto: qualquer pessoa com o token entra.'
              : 'Convite direcionado a um fingerprint específico.'}
            {' '}Não há revogação individual — para cortar um vazamento, remova o membro
            pelo gerenciador.
          </div>
        </>
      ) : (
        <div>
          <Button
            variant="success"
            icon="link"
            busy={busy}
            onClick={() => void gerar()}
          >
            {busy ? 'Gerando' : 'Gerar convite'}
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- entrada

/**
 * Entrada por token: `idle` → `validating` → `waiting` → `joined` (host
 * confirmou). Nunca pula para "membro" — isso fechava o modal sem servidor.
 */
export function JoinServerForm({
  onJoined,
  autoToken,
  compact,
}: {
  onJoined: (communityId: string) => void
  /** Token pré-preenchido por deep link. */
  autoToken?: string | null
  compact?: boolean
}) {
  const [token, setToken] = useState(autoToken ?? '')
  const [error, setError] = useState<string | null>(null)
  const [pasteMsg, setPasteMsg] = useState<string | null>(null)
  const [phase, setPhase] = useState<'idle' | 'validating' | 'waiting'>('idle')
  const [joinedName, setJoinedName] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (autoToken) {
      setToken(autoToken)
      setPhase('idle')
      setError(null)
    }
  }, [autoToken])

  const cleaned = useMemo(() => tokenFromInviteUrl(token) ?? '', [token])

  const submit = useCallback(async () => {
    if (!cleaned || phase !== 'idle') return
    setError(null)
    setPasteMsg(null)
    setPhase('validating')
    try {
      const cid = await services.joinCommunity(cleaned)
      // Core validou o token; falta o host confirmar — o evento leva ao servidor.
      setPhase('waiting')
      setJoinedName(cid)
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
      setPhase('idle')
    }
  }, [cleaned, phase])

    // Confirmação real do host via `community_joined`.
  useEffect(() => {
    if (phase !== 'waiting') return
    const un = services.subscribe((ev) => {
      if (ev.type === 'community_joined') {
        const id = (ev as { community_id?: string }).community_id
        if (id) {
          setPhase('idle')
          setToken('')
          onJoined(id)
        }
      }
    })
    // Timeout honesto: o join persiste e é reenviado quando o dono aparecer.
    const timeout = window.setTimeout(() => {
      setPhase('idle')
      setPasteMsg(
        'O convite foi validado e o pedido ficou salvo. O dono ainda não respondeu — ' +
          'quando ele ficar online, o servidor aparece sozinho. Não é preciso colar de novo.',
      )
    }, 25_000)
    return () => {
      un()
      window.clearTimeout(timeout)
    }
  }, [phase, onJoined])

  async function colar() {
    setPasteMsg(null)
    setError(null)
    const r = await readClipboard()
    if (!r.ok) {
      setPasteMsg(r.reason)
      return
    }
    setToken(r.text)
    inputRef.current?.focus()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.sm, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: ui.sm, alignItems: 'stretch', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <TextField
            value={token}
            onChange={(v) => {
              setToken(v)
              setError(null)
              setPasteMsg(null)
            }}
            label="Token ou link do convite"
            placeholder="cole o token que você recebeu"
            mono
            ariaLabel="Token de convite"
            error={error}
            hint={
              compact
                ? undefined
                : 'Aceita o token cru ou o link distorrent:// completo. Espaços e quebras de linha são ignorados.'
            }
          />
        </div>
        <div style={{ paddingTop: 20, display: 'flex', gap: ui.sm, alignItems: 'flex-start' }}>
          <Button icon="copy" variant="secondary" onClick={() => void colar()} title="Colar da área de transferência">
            Colar
          </Button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: ui.sm, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          variant="primary"
          icon={phase === 'idle' ? 'chevronRight' : 'refresh'}
          disabled={!cleaned}
          busy={phase !== 'idle'}
          onClick={() => void submit()}
        >
          {phase === 'validating'
            ? 'Validando token'
            : phase === 'waiting'
              ? 'Aguardando o dono'
              : 'Entrar no servidor'}
        </Button>
        {phase === 'waiting' && (
          <span style={{ fontSize: 11.5, color: ui.muted, lineHeight: 1.5 }}>
            Convite válido. Conectando ao dono…
          </span>
        )}
      </div>

      {phase === 'waiting' && joinedName && (
        <Notice tone="info" icon="info">
          Pedido enviado. O servidor aparece na lista assim que o dono confirmar — e
          continua tentando sozinho, mesmo se você fechar o app.
        </Notice>
      )}
      {pasteMsg && (
        <div style={{ fontSize: 12, color: '#ffe0a3', lineHeight: 1.5 }}>{pasteMsg}</div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- painel

/** Painel de um servidor: identidade, membros reais, convite e silenciamento. */
export function ServerDetails({
  community,
  members,
  canCreateInvite,
  onError,
  onSelectChannel,
}: {
  community: CommunityView
  members: MemberPairing[]
  canCreateInvite: boolean
  onError: (msg: string) => void
  onSelectChannel?: (channelId: string) => void
}) {
  const muted = isMutedServer(community.id)
  const resumo = summarize(members)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: ui.lg, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: ui.md, alignItems: 'center', minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 44,
            height: 44,
            borderRadius: 14,
            background: ui.accent,
            color: '#fff',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 900,
            fontSize: 18,
            flexShrink: 0,
          }}
        >
          {(community.name || '?').charAt(0).toUpperCase()}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 800, color: ui.heading, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {community.name}
          </div>
          <div style={{ fontSize: 11.5, color: ui.muted, marginTop: 2 }}>
            {resumo.total} {resumo.total === 1 ? 'membro' : 'membros'} ·{' '}
            {community.channels.length} {community.channels.length === 1 ? 'canal' : 'canais'} ·{' '}
            {resumo.online} {resumo.online === 1 ? 'pareado' : 'pareados'}
          </div>
        </div>
        <IconButton
          icon={muted ? 'eyeOff' : 'eye'}
          label={muted ? 'Reativar notificações' : 'Silenciar servidor'}
          active={muted}
          onClick={() => toggleMuteServer(community.id)}
        />
      </div>

      {community.description && (
        <div style={{ fontSize: 12.5, color: ui.text, lineHeight: 1.6 }}>{community.description}</div>
      )}

      <div style={{ fontSize: 11.5, color: muted ? '#ffe0a3' : ui.muted, lineHeight: 1.55 }}>
        {muted
          ? 'Notificações silenciadas: mensagens e arquivos continuam chegando, e o pareamento não para.'
          : 'Notificações ativas para este servidor.'}
      </div>

      <div>
        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, color: ui.muted, marginBottom: 6 }}>
          MEMBROS
        </div>
        <MemberPairingList
          members={members}
          emptyHint="Nenhum membro sincronizado. Se você acabou de entrar, aguarde a confirmação do dono."
        />
      </div>

      {onSelectChannel && community.channels.length > 0 && (
        <div>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, color: ui.muted, marginBottom: 6 }}>
            CANAIS
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {community.channels.map(([id, name]) => (
              <button
                key={id}
                type="button"
                onClick={() => onSelectChannel(id)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background: ui.input,
                  border: `1px solid ${ui.border}`,
                  borderRadius: 99,
                  padding: '4px 10px',
                  color: ui.text,
                  fontSize: 11.5,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Ic name="hash" size={11} />
                {name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 0.6, color: ui.muted, marginBottom: 6 }}>
          CONVITE
        </div>
        <InvitePanel communityId={community.id} canCreateInvite={canCreateInvite} onError={onError} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- modal

/** Modal de servidores (desktop): padrão visual do app (`ui.Modal`). */
export function ServerHubModal({
  open,
  onClose,
  mode,
  servers,
  selectedId,
  onSelect,
  members,
  onCreate,
  onJoined,
  autoToken,
  onError,
}: {
  open: boolean
  onClose: () => void
  /** `mobile` esconde a criação (decisão de produto) e prioriza o convite. */
  mode: 'desktop' | 'mobile'
  servers: ServerSummary[]
  selectedId: string | null
  onSelect: (id: string) => void
  members: MemberPairing[]
  onCreate: () => void
  onJoined: (id: string) => void
  autoToken?: string | null
  onError: (msg: string) => void
}) {
  const selected = servers.find((s) => s.community.id === selectedId)?.community ?? null
  const [tab, setTab] = useState<'join' | 'details'>(autoToken ? 'join' : 'details')

  useEffect(() => {
    if (open && autoToken) setTab('join')
  }, [open, autoToken])

  useEffect(() => {
    if (open && selected && !autoToken) setTab('details')
  }, [open, selected?.id, autoToken])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Servidores"
      subtitle={
        mode === 'mobile'
          ? 'Entre com o token que você recebeu. Para criar um servidor, use o app no computador.'
          : 'Crie um servidor, entre por convite e acompanhe o pareamento dos membros.'
      }
      width={720}
      labelId="server-hub-title"
      dialogLabel="Servidores"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: ui.lg, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => setTab('join')}
            style={{
              background: tab === 'join' ? ui.accent : ui.input,
              color: tab === 'join' ? '#fff' : ui.text,
              border: `1px solid ${tab === 'join' ? ui.accent : ui.border}`,
              borderRadius: 99,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Entrar com convite
          </button>
          <button
            type="button"
            onClick={() => setTab('details')}
            disabled={!selected}
            style={{
              background: tab === 'details' ? ui.accent : ui.input,
              color: tab === 'details' ? '#fff' : selected ? ui.text : ui.muted,
              border: `1px solid ${tab === 'details' ? ui.accent : ui.border}`,
              borderRadius: 99,
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              cursor: selected ? 'pointer' : 'not-allowed',
            }}
          >
            Meus servidores
          </button>
          {mode === 'desktop' && (
            <div style={{ flex: 1 }} />
          )}
        </div>

        {tab === 'join' ? (
          <JoinServerForm
            autoToken={autoToken}
            compact={mode === 'mobile'}
            onJoined={(id) => {
              onJoined(id)
              setTab('details')
            }}
          />
        ) : (
          <>
            {mode === 'desktop' && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button variant="primary" icon="plus" onClick={onCreate}>
                  Criar servidor
                </Button>
              </div>
            )}
            <ServerList
              servers={servers}
              selectedId={selectedId}
              onSelect={onSelect}
              emptyHint={
                mode === 'mobile'
                  ? 'Nenhum servidor ainda. Toque em “Entrar com convite” e cole o token.'
                  : 'Nenhum servidor ainda. Crie um ou entre com o token de alguém.'
              }
            />
            {selected && (
              <div style={{ borderTop: `1px solid ${ui.border}`, paddingTop: ui.lg }}>
                <ServerDetails
                  community={selected}
                  members={members}
                  canCreateInvite={selected.is_owner === true}
                  onError={onError}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
