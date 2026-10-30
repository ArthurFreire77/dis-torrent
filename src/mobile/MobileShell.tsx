import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { services } from '../services'
import { Icon, Icons } from '../shared/icons'
import { useConversations, useEngineEvents, useMessages, useNetwork } from '../app/hooks'
import ConnectionDiagnostics from '../components/ConnectionDiagnostics'
import CallDiagnostics from '../components/CallDiagnostics'
import CallTileComponent from '../components/calls/CallTile'
import ScreenStage from '../components/calls/ScreenStage'
import { buildCallTiles, sortTilesForPin } from '../services/callTiles'
import DownloadsPanel from '../components/DownloadsPanel'
import CallPhaseBadge from '../components/CallPhaseBadge'
import { UpdateOverlay, useUpdateGate } from '../components/UpdateGate'
import { UpdateBootScreen } from '../components/UpdateBootScreen'
import { downloadManager } from '../services/downloadManager'
import { applyParticipantPlayback } from '../services/callPlayback'
import { botRuntime } from '../services/botRuntime'
import { StormVaultPanel } from '../components/vault/StormVaultPanel'
import { coalesceAsyncRefresh, throttleTrailing } from '../shared/perf'
import { attachStream } from '../shared/mediaAttach'
import { fileSwarm, encodeFileBody, parseFileBody, formatFileSize, type FileMsgMeta } from '../services/fileSwarm'
import ScreenSharePicker from '../components/ScreenSharePicker'
import {
  InvitePanel,
  JoinServerForm,
  MemberPairingList,
  ServerList,
  summarize,
  type ServerSummary,
} from '../components/server/ServerHub'
import { consumeInvite, peekInvite, subscribeInvite } from '../services/deepLink'
import { callManager, setCallIdentity, supportsScreenShare, getCallsSupport, getCallsUnavailableMessage, hasRelayConfigured, CALLS_UNAVAILABLE_MSG, SCREEN_UNAVAILABLE_MSG, screenShareUnavailableReason, ICE_RELAY_MSG, ICE_FAILED_MSG, getStoredQuality, getTurnUrl, isValidTurnUrl, setCallPrivacyForIce, type CallQuality, type IncomingCall } from '../services/callManager'
import { sfxMessage, sfxRingStart, sfxRingStop, sfxCallConnect, sfxCallEnd } from '../services/sfx'
import MobileMessage from './MobileMessage'
import { EmojiPicker } from '../shared/EmojiPicker'
import { NAMED_EMOJI } from '../shared/emojiSet'
import { activeToken } from '../shared/markdown'
import { RichText, type InlineCtx } from '../shared/richText'
import { useSocialWindow, useMessageActions, usePresence, PRESENCE_COLOR, PRESENCE_LABEL, useReadState } from '../app/useSocial'
import { BookmarksPanel } from '../components/social/Social'
import { GroupPanel } from '../components/social/GroupPanel'
import { shouldNotify, usePrefs } from '../shared/prefs'
import { AppearanceSettings } from '../components/prefs/AppearanceSettings'
import { NotificationSettings } from '../components/prefs/NotificationSettings'
import { SystemNotificationSettings } from '../components/prefs/SystemNotificationSettings'
import {
  notifyMessage, notifyIncomingCall, endCallNotice, markCallHandled,
  setOpenConversation, onOpenConversation,
} from '../services/notifications'
import { setDesiredPresence } from '../services/appState'
import { VoiceDeviceSettings } from '../components/prefs/VoiceDeviceSettings'
import type { BotView, PresenceStatus, SearchHit, ProfileView } from '../services/models'
import type { Conversation, Identity, NetworkState, CommunityView, PrivacyMode, StoredMessage, MemberPairing } from '../services/models'
import { PRIVACY_MODES } from '../services/models'

// DisTorrent mobile — top design mobile-first (não clone do PC antigo)
// Glass + blur, bottom-nav, cards arredondados, composer flutuante — 100% mobile
const MONO = "'JetBrains Mono', monospace"

/** Fingerprint = 12 hex chars (blake3 truncado, ver distorrent-core/identity.rs). */
const FP_RE = /^[0-9a-f]{12}$/

/** Item do autocompletar do composer mobile (mesma forma do desktop). */
interface AutoItemMobile {
  key: string
  kind: 'mention' | 'emoji' | 'slash'
  label: string
  hint?: string
  color?: string
  glyph?: string
  insert: string
  fp?: string
}

// `isImageName`/`isVideoName` vêm de `fileRules` (fonte única): a lista de
// extensões era copiada aqui e já divergia do desktop (faltava `heic`/`ico`).
import { isImageName, isVideoName } from '../services/fileRules'
// Os tetos de auto-carregamento (12MB imagem / 40MB vídeo) vivem em
// `mediaAutoFetchCap` no fileSwarm — é lá que o `prepareMedia` decide, e o
// desktop usa a MESMA constante. Duplicar aqui fazia os dois divergirem.

const t = {
  rail: '#0f1115', sidebar: '#1a1d23', main: '#14161a', composer: '#1f2126',
  input: '#23262f', hover: '#2a2d36', selected: '#2e313c', border: '#242830',
  panel: '#1e2128', footer: '#0f1115',
  accent: '#5865f2', accentHover: '#4752c4', link: '#00a8fc',
  green: '#23a559', yellow: '#f0b232', red: '#f23f42',
  text: '#f2f3f5', heading: '#ffffff', muted: '#8e929b',
}


const stateLabel: Record<NetworkState, string> = {
  CONNECTED: 'CONECTADO', CONNECTING: 'CONECTANDO', RECONNECTING: 'RECONECTANDO', DISCONNECTED: 'OFFLINE',
}

type Tab = 'home' | 'servers' | 'chats' | 'friends' | 'profile'

function avatarColor(fp: string): string {
  const palette = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc']
  let h = 0
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}

// memo: avatar/dot puros — antes recriavam DOM virtual a cada render do shell
// (cada tecla no composer, cada chunk do swarm, cada poll de 3s).
const Avatar = memo(function Avatar({ name, fp, size, avatarB64, accent }: { name: string; fp: string; size: number; avatarB64?: string; accent?: string }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: accent || avatarColor(fp), color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: size * 0.42, flexShrink: 0, overflow: 'hidden', boxShadow: accent ? `0 0 0 2px ${accent}55` : undefined }}>
      {avatarB64
        ? <img src={`data:image/jpeg;base64,${avatarB64}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initial}
    </span>
  )
})

const PeerDot = memo(function PeerDot({ on, ring }: { on: boolean; ring?: string }) {
  return <span style={{ position: 'absolute', right: -2, bottom: -2, width: 12, height: 12, borderRadius: '50%', background: on ? t.green : '#80848e', border: `3px solid ${ring ?? t.main}` }} />
})

// Linhas memoizadas — JSX idêntico ao das helpers antigas (convRow/serverRow/
// friendRow), só que como componentes memo: linhas cujas props não mudaram
// pulam o re-render (antes TODAS eram recriadas a cada setState do shell).
const ConvRow = memo(function ConvRow({ c, online, selected, onOpen, onDelete }: {
  c: Conversation
  online: boolean
  selected: boolean
  onOpen: (c: Conversation) => void
  onDelete: (id: string, title: string, isSelected: boolean) => void
}) {
  return (
    <div className="m-row" onClick={() => onOpen(c)}>
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
        <Avatar name={c.title} fp={c.peer_fp} size={40} />
        <PeerDot on={online} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14, color: t.heading, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
          <span style={{ fontSize: 10, color: t.muted, flexShrink: 0 }}>{(c as any).last_ts ? fmtTime((c as any).last_ts) : ''}</span>
        </div>
        <div style={{ fontSize: 12, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>{(c as any).last_body || 'Toque para conversar'}</div>
      </div>
      {((c as any).unread_count ?? 0) > 0 && <span className="m-badge">{(c as any).unread_count > 9 ? '9+' : (c as any).unread_count}</span>}
      <button title="Apagar conversa" aria-label="Apagar conversa" onClick={(e) => { e.stopPropagation(); void onDelete(c.id, c.title, selected) }} style={{ background: 'transparent', border: 'none', padding: 6, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8e929b' }}><Icon d={Icons.trash} size={16} /></button>
    </div>
  )
})

const ServerRow = memo(function ServerRow({ c, active, onSelect }: {
  c: CommunityView
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button className={'nav-row' + (active ? ' active' : '')} onClick={() => onSelect(c.id)}>
      <Avatar name={c.name} fp={c.id} size={28} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{c.name}</span>
      <span style={{ fontSize: 10, color: t.muted, flexShrink: 0 }}>{c.channels.length} canais • {c.members.length} membros</span>
    </button>
  )
})

const FriendRow = memo(function FriendRow({ f, online, onOpen, onRemove, onBlock }: {
  f: { fp: string, nickname: string }
  online: boolean
  onOpen: (fp: string, nick?: string) => void
  onRemove: (fp: string, nickname: string) => void
  onBlock: (fp: string, nickname: string) => void
}) {
  return (
    <div className="friend-row" onClick={() => onOpen(f.fp, f.nickname)}>
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
        <Avatar name={f.nickname || f.fp} fp={f.fp} size={32} />
        <PeerDot on={online} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nickname || f.fp}</div>
        <div style={{ fontSize: 11, color: t.muted, fontFamily: MONO }}>{f.fp.slice(0, 12)}</div>
      </div>
      <button title="Conversar" aria-label="Conversar" className="row-icon" onClick={e => { e.stopPropagation(); onOpen(f.fp, f.nickname) }}><Icon d={Icons.send} size={15} /></button>
      <button title="Bloquear" aria-label="Bloquear" className="row-icon no" onClick={e => { e.stopPropagation(); onBlock(f.fp, f.nickname) }}>⊘</button>
      <button title="Remover amigo" aria-label="Remover amigo" className="row-icon no" onClick={e => { e.stopPropagation(); void onRemove(f.fp, f.nickname) }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12 M18 6L6 18"/></svg></button>
    </div>
  )
})

// Item de mensagem memoizado — JSX idêntico ao map inline antigo (texto +
// cartão de arquivo com Baixar/progresso). Props primitivas (pct/done/
// announced) para o memo detectar mudança real de progresso; o parse do corpo
// e o lookup no swarm acontecem 1x por mensagem no useMemo pai (antes: a cada
// tecla digitada no composer e a cada chunk recebido).
/** Card de arquivo (swarm): usado pela linha de mensagem e pelo preview. */
export function FileCard({ m, mine, fmeta, pct, done, announced, previewUrl, onDownload, onRetry }: {
  m: StoredMessage
  mine: boolean
  fmeta: FileMsgMeta
  pct: number
  done: boolean
  announced: boolean
  previewUrl?: string
  onDownload: (fileId: string) => void
  onRetry: (m: StoredMessage) => void
}) {
  return (
    <div style={{ marginTop: 6, background: t.input, border: `1px solid ${t.border}`, borderRadius: 12, padding: '10px 12px' }}>
      {previewUrl && isVideoName(fmeta.name) && (
        <video src={previewUrl} controls preload="metadata" style={{ width: '100%', maxHeight: 340, borderRadius: 10, display: 'block', marginBottom: 10, background: '#000' }} />
      )}
      {previewUrl && !isVideoName(fmeta.name) && (
        <img src={previewUrl} alt={fmeta.name} style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 10, display: 'block', marginBottom: 10 }} />
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'flex', flexShrink: 0, color: '#8e929b' }}><Icon d={Icons.attach} size={20} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmeta.name}</div>
          <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>{formatFileSize(fmeta.size)} • {fmeta.chunks} chunks</div>
        </div>
      </div>
      {announced && !done && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <div style={{ flex: 1, height: 6, background: t.main, borderRadius: 99, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: t.accent, transition: 'width .3s' }} />
          </div>
          <span style={{ fontSize: 11, fontWeight: 800, color: t.muted, fontFamily: MONO }}>{pct}%</span>
        </div>
      )}
      <button className="m-btn" style={{ marginTop: 8, width: '100%', padding: '10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => onDownload(fmeta.file_id)}><Icon d={Icons.download} size={14} /> {previewUrl ? 'Salvar' : done ? 'Baixar' : announced ? `Baixar (${pct}%)` : 'Baixar'}</button>
      {!announced && <div style={{ fontSize: 11, color: t.muted, marginTop: 6 }}>aguardando anúncio do swarm…</div>}
      {mine && m.status === 'failed' && (<button className="m-btn ghost" style={{ marginTop: 8, width: '100%', padding: '10px 0' }} onClick={() => onRetry(m)}>Tentar novamente</button>)}
    </div>
  )
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function useIdentityBase() {
  const [identity, setIdentity] = useState<Identity | null>(null)
  return { identity, setIdentity }
}

function EmptyBlock({ msg, sub }: { msg: string; sub?: any }) {
  return (
    <div style={{ padding: '28px 12px', textAlign: 'center', color: t.muted }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>{msg}</div>
      {sub && <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>{sub}</div>}
    </div>
  )
}

// ---------- telas de conta (estilo desktop) ----------

function AuthCard({ children }: { children: any }) {
  const perks = [
    { icon: Icons.lock, title: 'Cifrado', desc: 'fim-a-fim' },
    { icon: Icons.users, title: 'Sem servidor', desc: 'P2P direto' },
    { icon: Icons.key, title: 'Sua chave', desc: 'sem conta' },
  ]
  return (
    <div style={{ minHeight: '100dvh', background: t.main, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, fontFamily: 'Inter' }}>
      <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 12, padding: 24, width: '100%', maxWidth: 380, boxShadow: '0 8px 32px rgba(0,0,0,.45)' }}>
        <div style={{ textAlign: 'center', marginBottom: 12 }}>
          <span style={{ fontSize: 24, fontWeight: 900, color: t.heading, letterSpacing: 1 }}>DisTorrent</span>
          <div style={{ fontSize: 12, color: t.muted, marginTop: 4 }}>chat, voz e arquivos P2P — sem cadastro</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {perks.map(p => (
            <div key={p.title} style={{ flex: 1, background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 4px', textAlign: 'center' }}>
              <span style={{ color: t.accent, display: 'inline-flex' }}><Icon d={p.icon} size={16} /></span>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.heading, marginTop: 4 }}>{p.title}</div>
              <div style={{ fontSize: 10, color: t.muted }}>{p.desc}</div>
            </div>
          ))}
        </div>
        {children}
      </div>
    </div>
  )
}

const inputStyle: any = { width: '100%', background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '12px 12px', color: t.text, fontSize: 16, outline: 'none', boxSizing: 'border-box' }
const btnStyle: any = { width: '100%', background: t.accent, color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 15 }

function CreateAccount({ onDone }: { onDone: (id: Identity) => void }) {
  const [nick, setNick] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  async function submit() {
    setErr(null)
    if (!nick.trim()) return setErr('escolha seu nome')
    setBusy(true)
    try {
      const id = await services.identityCreate(nick.trim(), null)
      onDone(id)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally {
      setBusy(false)
    }
  }

  /** Já tem conta em outro aparelho? Importa o cofre direto (sem conta nova).
   *  Usa campos na tela: `window.prompt` não funciona no WebView/WebKitGTK. */
  const [vaultFileName, setVaultFileName] = useState<string | null>(null)
  const [vaultB64, setVaultB64] = useState('')
  const [vaultPass, setVaultPass] = useState('')

  async function pickVaultFile() {
    if (services.kind !== 'native') {
      setErr('importar cofre precisa do app instalado')
      return
    }
    if (!fileRef.current) return
    fileRef.current.onchange = () => {
      const f = fileRef.current!.files?.[0]
      if (!f) return
      setVaultFileName(f.name)
      f.arrayBuffer()
        .then((ab) => {
          const buf = new Uint8Array(ab)
          let bin = ''
          const CH = 0x8000
          for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH))
          setVaultB64(btoa(bin))
        })
        .catch(() => setErr('falha ao ler o arquivo — tente de novo'))
    }
    fileRef.current.click()
  }

  async function doImportVault() {
    if (!vaultB64 || vaultPass.length < 8) {
      setErr('a senha do cofre precisa de pelo menos 8 caracteres')
      return
    }
    setBusy(true); setErr(null)
    try {
      const r = await services.stormvaultImportFile(vaultB64, vaultPass)
      if (r.identity_installed) {
        window.location.reload()
        return
      }
      setErr('o cofre foi mesclado, mas este aparelho já tem outra conta — abra o cofre em Configurações.')
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally { setBusy(false) }
  }

  return (
    <AuthCard>
      <div style={{ fontWeight: 800, color: t.heading, fontSize: 16, marginBottom: 4 }}>Criar conta</div>
      <div style={{ fontSize: 12, color: t.muted, marginBottom: 14, lineHeight: 1.5 }}>Escolha seu nome. Sua chave é gerada neste dispositivo — <b>sem senha</b>, login direto pela chave.</div>
      <input style={inputStyle} placeholder="Seu nome" value={nick} onChange={e => setNick(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} autoCapitalize="none" spellCheck={false} />
      {err && <div style={{ fontSize: 12, color: '#ff9c9c', background: '#2a1518', border: `1px solid ${t.red}55`, borderRadius: 6, padding: '6px 10px', marginTop: 10 }}>{err}</div>}
      <button style={{ ...btnStyle, marginTop: 14 }} disabled={busy || !nick.trim()} onClick={submit}>{busy ? 'criando…' : 'Criar conta'}</button>
      <input ref={fileRef} type="file" accept=".stormvault" style={{ display: 'none' }} aria-label="Escolher cofre para importar" />
      <button onClick={pickVaultFile} disabled={busy} style={{ width: '100%', background: 'transparent', color: t.muted, border: 'none', padding: 12, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12, marginTop: 10 }}>
        {vaultFileName ? `Cofre: ${vaultFileName}` : 'Já tenho conta em outro aparelho — importar cofre'}
      </button>
      {vaultB64 && (
        <div style={{ marginTop: 8 }}>
          <input style={inputStyle} type="password" placeholder="senha do cofre" aria-label="Senha do cofre"
            value={vaultPass} onChange={e => setVaultPass(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void doImportVault() }} />
          <button onClick={() => void doImportVault()} disabled={busy || vaultPass.length < 8} style={{ ...btnStyle, marginTop: 10 }}>
            {busy ? 'importando…' : 'Importar e entrar'}
          </button>
        </div>
      )}
      <div style={{ fontSize: 11, color: t.muted, marginTop: 2, textAlign: 'center' }}>Sem senha — o app verifica se você tem a chave local.</div>
    </AuthCard>
  )
}

function LockScreen({ nickname, onUnlock }: { nickname: string; onUnlock: (id: Identity) => void }) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit() {
    setErr(null); setBusy(true)
    try {
      const id = await services.vaultUnlock(pass)
      onUnlock(id)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally { setBusy(false) }
  }

  return (
    <AuthCard>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
        <Avatar name={nickname} fp="0000" size={64} />
      </div>
      <div style={{ textAlign: 'center', fontWeight: 800, color: t.heading, fontSize: 16 }}>Bem-vindo de volta, {nickname}</div>
      <div style={{ textAlign: 'center', fontSize: 12, color: t.muted, marginTop: 4, marginBottom: 14 }}>Digite sua senha para desbloquear</div>
      <input style={inputStyle} autoFocus type="password" placeholder="Sua senha" value={pass}
        onChange={e => setPass(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && pass && submit()} />
      {err && <div style={{ fontSize: 12, color: '#ff9c9c', background: '#2a1518', border: `1px solid ${t.red}55`, borderRadius: 6, padding: '6px 10px', marginTop: 10 }}>{err}</div>}
      <button style={{ ...btnStyle, marginTop: 14 }} disabled={busy || !pass} onClick={submit}>{busy ? 'entrando…' : 'Entrar'}</button>
    </AuthCard>
  )
}

// ---------- tela de carregamento (boot) ----------

// Antes era `<div style={{height:'100dvh',background:t.main}}/>`: uma tela
// CINZA VAZIA enquanto a identidade e o motor P2P subiam. No desktop, onde o
// boot mexe em keyring do SO + SQLite + listener de rede, isso levava
// segundos e o app parecia travado. Agora tem barra, texto e — se demorar
// demais — aviso honesto em vez de silêncio.
function BootScreen({ native }: { native: boolean }){
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const tm = setTimeout(() => setSlow(true), 5000)
    return () => clearTimeout(tm)
  }, [])
  return (
    <div className="boot">
      <div className="boot-logo">DisTorrent</div>
      <div className="boot-bar"><i /></div>
      <div className="boot-sub">
        {slow
          ? 'ainda iniciando o nó P2P — se demorar muito, confirme se o app nativo está rodando (não só o navegador).'
          : 'abrindo sua identidade e o nó P2P…'}
        {!native && <><br />modo navegador: a rede P2P só conecta abas desta máquina.</>}
      </div>
    </div>
  )
}

// ---------- app principal ----------

export default function MobileShell() {
  const prefs = usePrefs()
  const [phase, setPhase] = useState<'loading' | 'create' | 'lock' | 'app'>('loading')
  const { identity, setIdentity } = useIdentityBase()
  const { status, peers } = useNetwork(4000)
  const [tab, setTab] = useState<Tab>('home')
  const [selConv, setSelConv] = useState<string | null>(null)
  const [selPeerFp, setSelPeerFp] = useState<string | null>(null)
  const { conversations, refresh: refreshConvos } = useConversations(phase === 'app')
  const { messages, append, patchStatus, replaceOptimistic, failOptimistic } = useMessages(selConv)
  const [input, setInput] = useState('')
  const draftKey = (c: string) => `distorrent:draft:${c}`
  useEffect(() => {
    if (!selConv) return
    try { setInput(localStorage.getItem(draftKey(selConv)) ?? '') } catch { setInput('') }
  }, [selConv])
  useEffect(() => {
    if (!selConv) return
    try {
      if (input) localStorage.setItem(draftKey(selConv), input)
      else localStorage.removeItem(draftKey(selConv))
    } catch { /* quota cheia: rascunho fica só na sessão */ }
  }, [input, selConv])
  const [communities, setCommunities] = useState<CommunityView[]>([])
  const [callActionBusy, setCallActionBusy] = useState(false)
  const [selCommunity, setSelCommunity] = useState<string | null>(null)
  const [showDrawer, setShowDrawer] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [friendsTab, setFriendsTab] = useState<'online' | 'todos' | 'pendentes' | 'bloqueados' | 'adicionar'>('online')
  const [friendRequests, setFriendRequests] = useState<{ fp: string, nickname: string }[]>([])
  const [friendsAccepted, setFriendsAccepted] = useState<{ fp: string, nickname: string }[]>([])
  // O core mantem `blocked`; nenhum dos dois shells buscava esse status.
  const [friendsBlocked, setFriendsBlocked] = useState<{ fp: string, nickname: string }[]>([])
  const [pendingOut, setPendingOut] = useState<{ fp: string, nickname: string }[]>([])
  const [friendFpInput, setFriendFpInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // v6 — fila de downloads (painel) + relógio p/ o badge de fase da chamada.
  const [showDownloads, setShowDownloads] = useState(false)
  const [dlCount, setDlCount] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [friendSuccess, setFriendSuccess] = useState<string | null>(null)
  const [addingFriend, setAddingFriend] = useState(false)
  const [friendErr, setFriendErr] = useState<string | null>(null)
  const friendInputRef = useRef<HTMLInputElement | null>(null)
  // T1: sem bloqueio global sending — permite digitar/enviar a proxima durante o envio.
  // So barra duplo-submit da MESMA tecla Enter em <300ms.
  const lastSendRef = useRef(0)
  const [searchQ, setSearchQ] = useState('')
  // --- camada social (5.5) ---
  const [bots, setBots] = useState<BotView[]>([])
  const [replyToMsg, setReplyToMsg] = useState<{ id: string; name: string; body: string } | null>(null)
  const [forwardFrom, setForwardFrom] = useState<{ id: string; name: string; body: string } | null>(null)
  const [profilePeer, setProfilePeer] = useState<{ fp: string; name: string } | null>(null)
  const [threadFor, setThreadFor] = useState<{ parent: string; name: string; body: string } | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [showPins, setShowPins] = useState(false)
  const [showBookmarks, setShowBookmarks] = useState(false)
  // Mobile é invite-only: criar servidor só no desktop.
  const [showThread, setShowThread] = useState(false)
  const [threadMsgs, setThreadMsgs] = useState<StoredMessage[]>([])
  const [threadInput, setThreadInput] = useState('')
  const [customStatus, setCustomStatus] = useState('')
  const [myPresence, setMyPresence] = useState<PresenceStatus>('online')
  const [composerEmoji, setComposerEmoji] = useState(false)
  /** Quem está digitando na conversa aberta (fp → nome, expira em 3,5s). */
  const [typingPeers, setTypingPeers] = useState<Record<string, { nick: string; at: number }>>({})
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [flash, setFlash] = useState<string | null>(null)
  const [pinnedMsgs, setPinnedMsgs] = useState<{ id: string; body: string; author: string }[]>([])
  const readRef = useRef<Set<string>>(new Set())
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const [myStatusBusy, setMyStatusBusy] = useState(false)
  const [topMenu, setTopMenu] = useState(false)
  const [showPrivacy, setShowPrivacy] = useState(false)
  /** Seletor completo de compartilhamento (fonte/áudio/qualidade/FPS). */
  const [showScreenPicker, setShowScreenPicker] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('encrypted')
  // PRIVACIDADE × CHAMADAS (mesma regra do ThemeShell): o ICE do WebRTC não
  // passa pelo SOCKS5 do app — em proxy/full os SERVIDORES PÚBLICOS de
  // STUN/TURN ficam fora da lista e a UI avisa que a chamada não é anônima.
  const [privacyProxyEffective, setPrivacyProxyEffective] = useState(false)
  useEffect(() => {
    setCallPrivacyForIce(privacyMode)
    // Estado EFETIVO do proxy (relay roteando por SOCKS5 de fato?) — o modal
    // não pode vender "proxy ativado" com o proxy morto (fail-closed).
    services.privacyGet().then(s => setPrivacyProxyEffective(!!s.proxy_effective)).catch(() => {})
  }, [privacyMode])
  // --- proxy SOCKS5 (modo proxy/Tor): endereço + teste online + ativação ---
  const [proxyAddr, setProxyAddr] = useState('')
  const [proxyIsDefault, setProxyIsDefault] = useState(true)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyTestOk, setProxyTestOk] = useState<number | null>(null)
  const [proxyTestErr, setProxyTestErr] = useState<string | null>(null)
  const [proxyPendingMode, setProxyPendingMode] = useState<PrivacyMode | null>(null)
  /** Último envio de "digitando" (throttle de 2s, igual desktop/Discord). */
  const lastTypingSent = useRef(0)
  /** Momento de abertura do app — usado pelo /uptime (paridade com desktop). */
  const bootAtMobile = useRef(Date.now())

  /** Avisa a conversa que estou digitando. Throttled: no máximo 1x/2s. */
  function notifyTyping(v: string) {
    try {
      if (!selConv || !v.trim()) return
      const now = Date.now()
      if (now - lastTypingSent.current < 2000) return
      lastTypingSent.current = now
      void services.sendTyping?.(selConv).catch(() => {})
    } catch { /* digitando é cosmético: nunca derruba a digitação */ }
  }

  async function refreshPrivacyExtras(mode?: PrivacyMode) {
    try {
      // endereço do MODO-ALVO (proxy × Tor): sem isto, escolher Tor trazia o
      // default do SOCKS5 (1080) e "Ativar" gravava a porta errada.
      const pc = await services.proxyAddrGet(mode)
      setProxyAddr(pc.addr)
      setProxyIsDefault(pc.is_default)
    } catch {
      setProxyAddr(mode === 'full' ? '127.0.0.1:9050' : '127.0.0.1:1080')
      setProxyIsDefault(true)
    }
  }

  async function runProxyTest() {
    setProxyTesting(true); setProxyTestOk(null); setProxyTestErr(null)
    try {
      const ms = await services.proxyTest(proxyAddr.trim())
      setProxyTestOk(ms)
    } catch (e: any) {
      setProxyTestErr(String(e?.message ?? e))
    } finally {
      setProxyTesting(false)
    }
  }

  async function saveProxyAndActivate(mode: PrivacyMode) {
    try {
      // grava na chave do modo-alvo antes de trocar o modo (ordem inversa
      // faria o motor re-rotar o relay com o endereço antigo)
      await services.proxyAddrSet(proxyAddr.trim(), mode)
      const r = await services.privacySet(mode)
      setPrivacyMode(r.mode)
      setPrivacyProxyEffective(!!r.proxy_effective)
      setProxyPendingMode(null)
      setProxyTestOk(null)
      setProxyTestErr(null)
      setError(null)
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  function pickPrivacyMode(pm: PrivacyMode) {
    // proxy/Tor: pede o IP do proxy + teste online ANTES de ativar (nunca
    // liga proxy às cegas). Os outros modos aplicam direto.
    if (pm === 'proxy' || pm === 'full') {
      setProxyPendingMode(pm)
      setProxyTestOk(null); setProxyTestErr(null)
      void refreshPrivacyExtras(pm)
      return
    }
    setProxyPendingMode(null)
    services.privacySet(pm).then(r => {
      setPrivacyMode(r.mode)
      setPrivacyProxyEffective(!!r.proxy_effective)
      setError(null)
    }).catch((e: any) => setError(String(e?.message ?? e)))
  }

  /** Fecha o painel e descarta o formulário de proxy pendente (sem aplicar). */
  function closePrivacy() {
    setShowPrivacy(false)
    setProxyPendingMode(null)
    setProxyTestOk(null)
    setProxyTestErr(null)
  }
  const [version, setVersion] = useState('')
  const [fileList, setFileList] = useState<any[]>([])
  /** Prévia de imagens (file_id → blob URL) renderizada inline, sem salvar. */
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const previewsRef = useRef<Record<string, string>>({})
  const previewUrlsRef = useRef<string[]>([])
  /**
   * Publica a blob URL no estado. Substituindo uma prévia anterior, revoga a
   * URL velha — sem isso cada retry de um card que falhou deixava um blob
   * órfão segurando o arquivo inteiro na memória do WebView.
   */
  const mountPreview = useCallback((fileId: string, blob: Blob) => {
    if (previewsRef.current[fileId]) return
    const url = URL.createObjectURL(blob)
    previewUrlsRef.current.push(url)
    previewsRef.current[fileId] = url
    setPreviews({ ...previewsRef.current })
  }, [])
  // --- CALL: bind real no CallManager (voz/vídeo P2P igual desktop) ---
  const [activeCall, setActiveCall] = useState<any>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  // fp → apelido (memo do ring): nome > fingerprint no "está ligando…".
  const peerNickCacheRef = useRef<Record<string, string>>({})
  const [callDuration, setCallDuration] = useState(0)
  const [callPanelSize, setCallPanelSize] = useState<'compact' | 'normal' | 'expanded'>('normal')
  // Seleção por ID DE TRANSMISSÃO (`p:<fp>` / `s:<fp>`): a tela é um quadrado
  // próprio e precisa de fixação/expansão independentes da pessoa.
  const [pinnedTileId, setPinnedTileId] = useState<string | null>(null)
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [callQuality, setCallQuality] = useState<CallQuality>(() => getStoredQuality())
  const [qualityError, setQualityError] = useState<string | null>(null)
  const [showCallDiag, setShowCallDiag] = useState(false)
  const [turnInput, setTurnInput] = useState(() => getTurnUrl())
  const [turnMsg, setTurnMsg] = useState<string | null>(null)
  const swarmNotifyRef = useRef<() => void>(() => {})
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // link de convite público (?invite=TOKEN)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteInput, setInviteInput] = useState('')
  /** Pareamento REAL dos membros do servidor selecionado. */
  const [memberPairing, setMemberPairing] = useState<MemberPairing[]>([])
  const [showServerDetails, setShowServerDetails] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    services.version().then(setVersion).catch(() => {})
    services.privacyGet().then(s => setPrivacyMode(s.mode)).catch(() => {})
    services.identityGet().then(id => {
      if (id) { setIdentity(id); setPhase('app') }
      else {
        services.vaultStatus().then(v => {
          if (!v.has_identity) setPhase('create')
          else if (v.has_vault) services.vaultUnlock('').then(u => { setIdentity(u); setPhase('app') }).catch(() => setPhase('lock'))
          else services.identityGet().then(retry => { if (retry) { setIdentity(retry); setPhase('app') } else setPhase('create') }).catch(() => setPhase('create'))
        }).catch(() => setPhase('create'))
      }
    }).catch(() => setPhase('create'))
  }, [])

  // link de convite público: a URL de boot foi centralizada em App.tsx
  // (services/deepLink). Aqui só consumimos o que estiver pendente quando o
  // app está destravado — inclusive convite que chega com o app JÁ aberto.
  useEffect(() => {
    if (phase !== 'app') return
    const token = consumeInvite() ?? peekInvite()
    if (!token) return
    setInviteInput(token)
    setShowInvite(true)
  }, [phase])

  useEffect(() => {
    return subscribeInvite((token) => {
      setInviteInput(token)
      setShowInvite(true)
      setTab('servers')
    })
  }, [])

  // Pareamento do servidor aberto (evidência real: direto/relay/offline).
  useEffect(() => {
    setMemberPairing([])
    if (!selCommunity) return
    let alive = true
    const load = () => {
      services
        .communityMembers(selCommunity)
        .then((m) => {
          if (alive) setMemberPairing(m ?? [])
        })
        .catch(() => { /* motor subindo */ })
    }
    load()
    const t = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [selCommunity, communities.length])

  // identidade real no CallManager (sem isso chamadas falham "sem identidade")
  useEffect(() => {
    setCallIdentity(identity ? { fingerprint: identity.fingerprint, nickname: identity.nickname } : null)
  }, [identity])
  useEffect(() => {
    callManager.bind(setActiveCall)
    let stopBots: (() => void) | undefined
    try { stopBots = botRuntime.start() } catch { /* runtime é best-effort */ }
    try { downloadManager.load() } catch { /* fila segue vazia */ }
    let unCount = () => {}
    try {
      unCount = downloadManager.subscribe((items) => {
        try { setDlCount(items.filter(i => i.status === 'queued' || i.status === 'downloading' || i.status === 'verifying' || i.status === 'saving').length) } catch { /* ignore */ }
      })
    } catch { /* sem contador */ }
    const unNotice = callManager.onCallNotice
    callManager.onCallNotice = (msg: string) => {
      try { setNotice(msg); window.setTimeout(() => setNotice(null), 6000) } catch { /* ignore */ }
    }
    const unIce = callManager.onIceFailed
    callManager.onIceFailed = (info) => {
      try {
        setNotice(info.state === 'failed' ? ICE_FAILED_MSG : ICE_RELAY_MSG)
        window.setTimeout(() => setNotice(null), 6000)
      } catch { /* ignore */ }
    }
    const unIncomingGone = callManager.onIncomingGone
    callManager.onIncomingGone = (callId: string) => {
      setIncomingCall((cur: any) => (cur && cur.call_id === callId ? null : cur))
      try { sfxRingStop() } catch { /* ignore */ }
    }
    return () => { callManager.unbind(); try { stopBots?.() } catch { /* ignore */ }; try { unCount() } catch { /* ignore */ }; callManager.onCallNotice = unNotice; callManager.onIceFailed = unIce; callManager.onIncomingGone = unIncomingGone }
  }, [])
  // Conversa aberta = aviso daquela conversa cancelado; clique na notificação
  // abre a conversa certa (id vem do shell nativo).
  useEffect(() => { setOpenConversation(selConv) }, [selConv])
  useEffect(() => onOpenConversation((conv) => { setSelConv(conv); setSelPeerFp(null) }), [])
  useEffect(() => {
    if (!activeCall) return
    setCallDuration(Math.floor((Date.now() - activeCall.startAt) / 1000))
    const timer = window.setInterval(() => { setCallDuration(Math.floor((Date.now() - activeCall.startAt) / 1000)); setNowMs(Date.now()) }, 1000)
    return () => window.clearInterval(timer)
  }, [activeCall?.callId])
  useEffect(() => {
    const q = (activeCall as any)?.quality as CallQuality | undefined
    if (q === '480p' || q === '720p' || q === '1080p' || q === '4K') setCallQuality(q)
  }, [activeCall?.quality])

  // Quadrados da chamada (mesma regra pura do desktop). A mídia do "eu" vem do
  // manager — no mobile o roster também pode não ter o stream local, e era por
  // isso que quem transmitia não via a própria câmera.
  const callTilesMobile = useMemo(() => buildCallTiles({
    participants: (activeCall?.participants ?? []) as any[],
    myFp: identity?.fingerprint ?? null,
    local: activeCall ? {
      stream: (activeCall as any).localStream ?? null,
      screenStream: (activeCall as any).localScreenStream ?? null,
      sharing: !!activeCall.sharing,
      cameraOn: !!activeCall.cameraOn,
      muted: !!activeCall.muted,
      nativeMedia: !!(activeCall as any).nativeMedia,
    } : null,
  }), [
    // Ver o comentário do `onUpdate` no callManager: o roster é clonado para
    // que este memo veja `push`/`splice`. Sem isso, quem entra depois não
    // ganhava tile (e no desktop, sem tile, não há `<audio>` = silêncio).
    activeCall?.participants,
    activeCall?.sharing,
    activeCall?.cameraOn,
    activeCall?.muted,
    (activeCall as any)?.localStream,
    (activeCall as any)?.localScreenStream,
    (activeCall as any)?.nativeMedia,
    identity?.fingerprint,
  ])

  // Idem desktop: verde só com mídia de verdade (ver CallPhaseBadge).
  const mediaLiveMobile = useMemo(() => {
    if (!activeCall) return false
    for (const p of ((activeCall as any).participants ?? []) as any[]) {
      if (p?.videoUrl) return true
      const tracks = p?.stream?.getTracks?.() as any[] | undefined
      if (tracks?.some((t) => t?.readyState === 'live')) return true
    }
    const tracks = (activeCall as any).localStream?.getTracks?.() as any[] | undefined
    return !!tracks?.some((t) => t?.readyState === 'live')
  }, [activeCall?.participants, (activeCall as any)?.localStream])

  const visibleCallTilesMobile = useMemo(() => {
    const valid = callTilesMobile.map((tile) => tile.id)
    const pin = pinnedTileId && valid.includes(pinnedTileId) ? pinnedTileId : null
    return pin ? sortTilesForPin(callTilesMobile, pin) : callTilesMobile
  }, [callTilesMobile, pinnedTileId])

  /** Quadrado aberto em TELA CHEIA no mobile (null = layout normal). */
  const stageTileMobile = useMemo(
    () => (expandedTileId ? callTilesMobile.find((tile) => tile.id === expandedTileId) ?? null : null),
    [callTilesMobile, expandedTileId],
  )

  useEffect(() => {
    if (pinnedTileId && !callTilesMobile.some((tile) => tile.id === pinnedTileId)) setPinnedTileId(null)
    // Tela cheia fantasma (mesmo bug do desktop): `buildCallTiles` sintetiza o
    // tile local mesmo sem chamada, então o id do quadrado expandido nunca
    // "deixava de existir". Sair da chamada fecha a tela cheia aqui.
    if (!activeCall && expandedTileId) setExpandedTileId(null)
  }, [callTilesMobile, pinnedTileId])
  useEffect(() => {
    if (expandedTileId && !callTilesMobile.some((tile) => tile.id === expandedTileId)) setExpandedTileId(null)
  }, [callTilesMobile, expandedTileId])
  async function changeQuality(q: CallQuality) {
    setQualityError(null)
    try { await callManager.setQuality(q); setCallQuality(q) }
    catch (e: any) { setQualityError(String(e?.message ?? e)) }
  }
  function saveTurnUrl() {
    const v = turnInput.trim()
    if (v !== '' && !isValidTurnUrl(v)) { setTurnMsg('formato inválido — use turn:host:porta (ex: turn:seu-vps:3478)'); return }
    try {
      if (v === '') localStorage.removeItem('distorrent:turn_url')
      else localStorage.setItem('distorrent:turn_url', v)
      setTurnMsg(v === '' ? 'TURN removido — P2P puro (só rede local/NAT aberto).' : 'TURN salvo! Vale para as próximas chamadas.')
    } catch { setTurnMsg('não foi possível salvar neste aparelho.') }
  }

  // GARGALO 1 (polling redundante): antes refreshFriends rodava a cada 3s via
  // setInterval + 1x por evento de amizade + 1x por ação do usuário — cada um =
  // 3 chamadas friendsList + 3 setState + re-render total. Agora: coalescing com
  // no máximo 1 execução/5s (leading imediato = sync ao vivo preservado,
  // trailing único absorve a tempestade), polling espaçado p/ 10s e pausado com
  // a aba oculta (WebView em background não gasta bateria).
  const refreshFriendsImpl = useCallback(async () => { try { const [a, b, c, d] = await Promise.all([services.friendsList('pending_in').catch(() => [] as any), services.friendsList('accepted').catch(() => [] as any), services.friendsList('pending_out').catch(() => [] as any), services.friendsList('blocked').catch(() => [] as any)]); setFriendRequests(a ?? []); setFriendsAccepted(b ?? []); setPendingOut(c ?? []); setFriendsBlocked(d ?? []) } catch { /* ignore */ } }, [])
  const refreshFriends = useMemo(() => coalesceAsyncRefresh(refreshFriendsImpl, 5000), [refreshFriendsImpl])
  async function refreshCommunities() { try { setCommunities(await services.communitiesList() ?? []) } catch { /* ignore */ } }
  useEffect(() => { if (phase !== 'app') return; refreshFriends(); refreshCommunities(); const id = window.setInterval(() => { if (!document.hidden) refreshFriends() }, 30000); return () => window.clearInterval(id) }, [phase, refreshFriends])
  useEffect(() => () => refreshFriends.cancel(), [refreshFriends])
  // GARGALO 2 (fileSwarm.onChange): 1 setState por chunk de 256KB (4 em
  // paralelo = tempestade de re-renders da árvore inteira). Throttle de 300ms
  // com trailing: progresso continua ao vivo, sem render por chunk.
  useEffect(() => {
    const notify = throttleTrailing(() => setFileList([...fileSwarm.files.values()]), 300)
    swarmNotifyRef.current = notify
    const prev = fileSwarm.onChange
    fileSwarm.onChange = notify
    setFileList([...fileSwarm.files.values()])
    return () => { notify.cancel(); swarmNotifyRef.current = () => {}; fileSwarm.onChange = prev }
  }, [])
  // Prévia de MÍDIA (imagem + vídeo): monta blob URL para cada arquivo
  // completo sem prévia. `prepareMedia` reidrata do spool em disco ANTES de
  // qualquer rede — o que já foi baixado numa sessão anterior renderiza
  // sozinho ao abrir o app, sem baixar de novo e sem se importar com o cap
  // de tamanho. Acima do cap e sem nada em disco, o card mostra o botão.
  // URLs revogados no unmount.
  const previewFetchingRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    for (const sf of fileSwarm.files.values()) {
      const isImg = isImageName(sf.name)
      const isVid = isVideoName(sf.name)
      if (!isImg && !isVid) continue
      if (previewsRef.current[sf.file_id]) continue
      // já montado em memória: nada a fazer (evita revogar URL viva)
      const blob = fileSwarm.blobFor(sf.file_id)
      if (blob) {
        mountPreview(sf.file_id, blob)
        continue
      }
      // uma tentativa por vez por arquivo; `tries` limita a repetição pra
      // rede ruim não virar tempestade de requisições
      const tries = previewFetchingRef.current.get(sf.file_id) ?? 0
      if (tries >= 3) continue
      previewFetchingRef.current.set(sf.file_id, tries + 1)
      void fileSwarm.prepareMedia(sf)
        .then(() => {
          const b = fileSwarm.blobFor(sf.file_id)
          if (b) { mountPreview(sf.file_id, b); previewFetchingRef.current.delete(sf.file_id) }
        })
        .catch(() => { /* card mostra o motivo; próxima varredura tenta de novo */ })
    }
  }, [fileList])
  useEffect(() => () => {
    for (const u of previewUrlsRef.current) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
    previewUrlsRef.current = []
  }, [])
  // O corpo da MENSAGEM já traz os metadados do arquivo (file_id/name/size/
  // chunks/hash). Registra o swarm a partir da mensagem, SEM depender do frame
  // FileAnnounce separado (que podia se perder e travava em "aguardando anúncio").
  useEffect(() => {
    let changed = false
    for (const m of messages) {
      const fmeta = parseFileBody(m.body)
      if (!fmeta || fileSwarm.files.has(fmeta.file_id)) continue
      const fromFp = m.direction === 'out' ? (identity?.fingerprint ?? '') : m.author_fp
      if (fileSwarm.onAnnounce(fmeta.file_id, fmeta.name, fmeta.size, fmeta.chunks, fmeta.hash, fromFp)) changed = true
    }
    if (changed) swarmNotifyRef.current()
  }, [messages, identity])
  useEngineEvents(ev => {
    // mensagem em QUALQUER conversa atualiza a lista (DM nova aparecia só após restart)
    if (ev.type === 'message_new') {
      const mentioned = !!identity && typeof (ev as unknown as { body?: unknown }).body === 'string'
        && (ev as unknown as { body: string }).body.includes(identity.fingerprint)
      const notify = shouldNotify(ev.conv_id, undefined, mentioned)
      if (ev.conv_id === selConv) append(ev)
      refreshConvos()
      if (notify && myPresence !== 'dnd') sfxMessage()
      if (notify) {
        const evAny = ev as unknown as { id?: string; author_fp?: string; body?: string; ts?: number; nickname?: string }
        const chName = communities
          .find(c => c.channels.some(([id]) => id === ev.conv_id))
          ?.channels.find(([id]) => id === ev.conv_id)?.[1]
        notifyMessage({
          id: String(evAny.id ?? ''),
          conversationId: ev.conv_id,
          title: chName ? `#${chName}` : (evAny.nickname || (evAny.author_fp ?? '').slice(0, 8) || 'DisTorrent'),
          preview: String(evAny.body ?? ''),
          mentioned,
          ts: Number(evAny.ts) || Date.now(),
        })
      }
    }
    if (ev.type === 'message_status') patchStatus(ev.msg_id, ev.status)
    // "digitando…" — o desktop já mostrava; no mobile faltava (lacuna auditada).
    if (ev.type === 'typing') {
      const cid = (ev as unknown as { conv_id?: string; convId?: string }).conv_id ?? (ev as unknown as { convId?: string }).convId
      const fp = (ev as unknown as { fp?: string }).fp
      if (!cid || !fp || fp === identity?.fingerprint) return
      if (cid !== selConv) return
      const nick = (ev as unknown as { nickname?: string }).nickname ?? fp.slice(0, 8)
      setTypingPeers(prev => ({ ...prev, [fp]: { nick, at: Date.now() } }))
      if (typingTimeouts.current[fp]) clearTimeout(typingTimeouts.current[fp])
      typingTimeouts.current[fp] = setTimeout(() => {
        setTypingPeers(prev => {
          const next = { ...prev }
          delete next[fp]
          return next
        })
      }, 3500)
    }
    // aceite cria DM no store — refresca conversas junto (era só friends)
    if (ev.type === 'friend_request_in' || ev.type === 'friend_accepted' || ev.type === 'friend_removed') { refreshFriends(); refreshConvos() }
    if (ev.type === 'community_joined') { refreshCommunities(); refreshConvos() }
    if (ev.type === 'community_removed') { refreshCommunities(); refreshConvos(); if (selCommunity === ev.community_id) { setSelCommunity(null); setSelConv(null); setSelPeerFp(null) } }
    if (ev.type === 'group_synced') { refreshConvos(); refreshCommunities() }
    if (ev.type === 'call_incoming') {
      const fp = ev.from_fp
      // SELF-RING (modo navegador): eco do próprio invite não toca o telefone
      // de quem ligou (ver filtro irmão no callManager bind).
      if (fp && identity?.fingerprint && fp === identity.fingerprint) return
      // Nome, nunca fingerprint: "Ana está ligando" é reconhecível, um fp não.
      const known = peers.find((p) => p.fp === fp)?.nickname
        || peerNickCacheRef.current[fp]
        || (ev as unknown as { nickname?: string }).nickname
      if (known && known !== fp) {
        peerNickCacheRef.current[fp] = known
        setIncomingCall({ ...ev, nickname: known })
      } else {
        setIncomingCall(ev)
      }
      if (myPresence !== 'dnd') sfxRingStart()
      // Com a tela apagada/outro app na frente, o aviso do sistema é o que
      // faz a chamada aparecer (o overlay da UI está atrás).
      notifyIncomingCall({ callId: ev.call_id, title: known || fp.slice(0, 8) })
    }
    if (ev.type === 'call_ended') {
      const mine = activeCall?.callId === ev.call_id || incomingCall?.call_id === ev.call_id
      if (mine) { setActiveCall(null); setIncomingCall(null); sfxRingStop(); sfxCallEnd() }
      endCallNotice(ev.call_id)
    }
    if (ev.type === 'file_announce') {
      const ok = fileSwarm.onAnnounce(ev.file_id, ev.name, ev.size, ev.chunks, ev.hash, ev.from_fp, (ev as any).chunk_hashes ?? undefined)
      if (!ok && fileSwarm.lastError) setError(fileSwarm.lastError)
      swarmNotifyRef.current()
      // Mídia que acabou de chegar: busca (SEM salvar em Downloads) só para
      // RENDERIZAR inline. `prepareMedia` respeita o cap e reidrata do disco.
      // Arquivos não-mídia continuam baixando SÓ no toque em "Baixar".
      if (ok && (isImageName(ev.name) || isVideoName(ev.name))) {
        const sf = fileSwarm.files.get(ev.file_id)
        if (sf) void fileSwarm.prepareMedia(sf).then(() => swarmNotifyRef.current()).catch(() => {})
      }
    }
    if (ev.type === 'file_chunk_request') fileSwarm.onChunkRequest(ev.file_id, ev.index, ev.from_fp)
    if (ev.type === 'file_chunk_data') { fileSwarm.onChunkData(ev.file_id, ev.index, ev.data_b64, ev.from_fp); swarmNotifyRef.current() }
  })
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, selConv])

  // GARGALO 3 (listas sem memo): estes derivados rodavam a cada render — cada
  // tecla no composer, cada chunk do swarm, cada poll. Com useMemo só
  // recalculam quando a fonte muda; combinados às linhas memo, teclas e chunks
  // não recriam mais as listas.
  const selConvObj = useMemo(() => conversations.find(c => c.id === selConv) ?? null, [conversations, selConv])
  const peerTitle = useMemo(() => selConvObj?.title || peers.find(p => p.fp === selPeerFp)?.nickname || selPeerFp || '', [selConvObj, peers, selPeerFp])
  const activeComm = useMemo(() => selCommunity ? communities.find(c => c.id === selCommunity) ?? null : null, [communities, selCommunity])
  const onlineFps = useMemo(() => new Set(peers.filter(p => p.state === 'CONNECTED').map(p => p.fp)), [peers])
  const { presence } = usePresence()
  const filteredConvs = useMemo(() => conversations.filter(c => !searchQ || c.title.toLowerCase().includes(searchQ.toLowerCase())), [conversations, searchQ])
  const filteredComms = useMemo(() => communities.filter(c => !searchQ || c.name.toLowerCase().includes(searchQ.toLowerCase())), [communities, searchQ])
  const onlineFriends = useMemo(() => friendsAccepted.filter(f =>
    onlineFps.has(f.fp) && presence.get(f.fp)?.status !== 'invisible'
  ), [friendsAccepted, onlineFps, presence])
  const shownFriends = friendsTab === 'online' ? onlineFriends : friendsAccepted
  const unreadTotal = useMemo(() => conversations.reduce((a, c) => a + (((c as any).unread_count as number) || 0), 0), [conversations])
  const netState: NetworkState | null = status?.state ?? null
  // Honesta: verde só com ≥1 peer Online real; nó ouvindo sem peers ≠ ONLINE.
  const nativeKind = services.kind === 'native'
  const peerCount = status?.online_peers ?? 0
  const netOnline = peerCount > 0 && (netState === 'CONNECTED' || netState === 'DISCONNECTED')
  const pillColor = !nativeKind ? t.accent : netState === null ? t.yellow : netOnline ? t.green : netState === 'DISCONNECTED' ? '#80848e' : t.yellow
  const pillLabel = !nativeKind ? 'LOCAL' : netState === null ? 'INICIANDO…' : netOnline ? 'ONLINE' : stateLabel[netState as NetworkState]
  const privacyLabel = PRIVACY_MODES.find(pm => pm.mode === privacyMode)?.label ?? privacyMode

  // Callbacks estáveis (useCallback com deps estáveis) para as linhas memo
  // receberem props referenciais constantes — sem isso o memo não seguraria.
  const openDm = useCallback(async (fp: string, nick?: string) => { if (!fp || fp.trim() === '') { setError('Selecione um amigo válido'); return } try { const conv = await services.dmOpen(fp.trim(), (nick || fp).trim()); setSelCommunity(null); setSelPeerFp(fp.trim()); setSelConv(conv.id); setTab('chats'); refreshConvos() } catch (e: any) { setError(String(e?.message ?? e)) } }, [refreshConvos])
  const openConv = useCallback((c: Conversation) => { setSelCommunity(null); setSelConv(c.id); setSelPeerFp(c.peer_fp) }, [])
  const deleteConv = useCallback(async (id: string, title: string, isSelected: boolean) => { if (!confirm(`Apagar conversa com ${title}?`)) return; try { await services.conversationDelete(id); if (isSelected) setSelConv(null); refreshConvos() } catch (err: any) { setError(String(err?.message ?? err)) } }, [refreshConvos])
  const removeFriend = useCallback(async (fp: string, nickname: string) => { if (!confirm(`Remover ${nickname || fp} dos amigos?`)) return; try { await services.friendRemove(fp); refreshFriends(); refreshConvos() } catch (err: any) { setError(String(err?.message ?? err)) } }, [refreshFriends, refreshConvos])
  const blockFriend = useCallback(async (fp: string, nickname: string) => { if (!confirm(`Bloquear ${nickname || fp}? As mensagens recebidas serão rejeitadas.`)) return; try { await services.friendBlock(fp); refreshFriends(); refreshConvos(); setNotice('Participante bloqueado') } catch (err: any) { setError(String(err?.message ?? err)) } }, [refreshFriends, refreshConvos])
  // v6: a fila real mora no downloadManager (progresso/pausa/resume/validação);
  // o painel abre para acompanhar. O card continua lendo o fileSwarm (sincronizado).
  const downloadFile = useCallback((fileId: string) => {
    try {
      const cur = fileSwarm.files.get(fileId)
      if (!cur) { setError('anúncio do arquivo ainda não chegou — aguarde uns segundos'); return }
      setError(null)
      try { downloadManager.enqueue({ file_id: fileId, name: cur.name, size: cur.size, chunks: cur.chunks, hash: cur.hash }) } catch (e: any) { setError(String(e?.message ?? e)); return }
      setShowDownloads(true)
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }, [])
  // Suporte a chamadas: 'full' = WebRTC direto, 'none' = desabilita com diagnóstico.
  // Sem modo áudio-via-relay: sem WebRTC a chamada falha honesto.
  const callsSupport = getCallsSupport()
  const callsOk = callsSupport !== 'none'
  const callsUnavailableDetail = callsSupport === 'none' ? getCallsUnavailableMessage() : CALLS_UNAVAILABLE_MSG
  function fmtCallDuration(s: number) {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }
  async function startCall(kind: 'voice' | 'video') {
    if (callActionBusy) return
    if (!selConv) return
    const fp = selPeerFp ?? selConvObj?.peer_fp
    if (!fp) { setError('selecione um amigo para ligar'); return }
    // Rota única: WebRTC direto (host/STUN/TURN) ou erro honesto.
    if (!callsOk) { setError(getCallsUnavailableMessage()); return }
    setCallActionBusy(true)
    try { await callManager.start(kind, selConv, [fp]) } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setCallActionBusy(false) }
  }
  async function handleIncomingAccept() {
    if (!incomingCall || callActionBusy) return
    const support = getCallsSupport()
    if (support === 'none') { setError(getCallsUnavailableMessage()); return }
    // Valida ANTES de avisar o peer: se o frame CallAccept sair e o
    // `acceptInbound` recusar, o chamador conecta sozinho e quem atendeu fica
    // sem chamada nenhuma (estado dos dois divergentes).
    const bloqueio = callManager.canAccept(incomingCall.call_id)
    if (bloqueio) { setError(bloqueio); setIncomingCall(null); sfxRingStop(); return }
    setCallActionBusy(true)
    try {
      await services.callAccept(incomingCall.call_id, incomingCall.from_fp)
      await callManager.acceptInbound(incomingCall.call_id, (incomingCall.kind as any) ?? 'voice', (selConv ?? incomingCall.call_id), incomingCall.from_fp, incomingCall.nickname)
      sfxRingStop()
      markCallHandled(incomingCall.call_id)
      setIncomingCall(null)
      sfxCallConnect()
    } catch (e: any) {
      setError(String(e?.message ?? e))
      sfxRingStop()
      setIncomingCall(null)
    } finally { setCallActionBusy(false) }
  }

  function handleIncomingReject() {
    if (!incomingCall) return
    sfxRingStop()
    markCallHandled(incomingCall.call_id)
    endCallNotice(incomingCall.call_id)
    callManager.rejectIncoming(incomingCall.call_id, incomingCall.from_fp)
    setIncomingCall(null)
  }
  function renderIncomingModal() {
    if (!incomingCall) return null
    return (
      <div className="m-overlay">
        <div className="m-modal" onClick={e => e.stopPropagation()} style={{ textAlign: 'center' }}>
          <div style={{ width: 72, height: 72, borderRadius: '50%', background: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: '#fff', fontWeight: 800, margin: '0 auto' }}>{(incomingCall.nickname || incomingCall.from_fp).charAt(0).toUpperCase()}</div>
          <div style={{ fontWeight: 800, color: t.heading, marginTop: 12, fontSize: 17 }}>{incomingCall.nickname || incomingCall.from_fp.slice(0, 12)} está ligando…</div>
          <div style={{ fontSize: 12, color: t.muted, marginTop: 4 }}>Chamada de {incomingCall.kind === 'video' ? 'vídeo' : 'voz'}</div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12 }}>
            <label htmlFor="m-incoming-quality" style={{ fontSize: 11, color: t.muted, fontWeight: 700 }}>Qualidade</label>
            <select id="m-incoming-quality" aria-label="Qualidade da chamada" value={callQuality} onChange={e => changeQuality(e.target.value as CallQuality)} style={{ background: t.input, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, padding: '6px 8px', fontSize: 12 }}>
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="4K">4K</option>
            </select>
          </div>
          {qualityError && <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 8 }}>{qualityError}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="m-btn red" style={{ flex: 1 }} onClick={handleIncomingReject}>Recusar</button>
            <button className="m-btn green" style={{ flex: 1 }} onClick={handleIncomingAccept}>Aceitar</button>
          </div>
        </div>
      </div>
    )
  }

  async function send() {
    const raw = input.trim()
    // Comando de barra: comportamento igual ao desktop (executa e posta o
    // texto de resposta na conversa, sem mandar para o peer como comando).
    if (raw.startsWith('/') && !/\s/.test(raw.split('\n')[0]!)) {
      const first = raw.split('\n')[0] ?? ''
      const sp = first.indexOf(' ')
      const name = (sp === -1 ? first.slice(1) : first.slice(1, sp)).toLowerCase()
      const rest = sp === -1 ? '' : raw.slice(sp + 1).trim()
      const out = await runSlashMobile(name, rest)
      setInput('')
      if (out && selConv) {
        const convId = selConv
        const communityId = selCommunity
        const myFp2 = identity?.fingerprint ?? ''
        const ts2 = Date.now()
        const optimistic: StoredMessage = { id: `pending-${ts2}`, conv_id: convId, author_fp: myFp2, body: out, ts: ts2, sig: 'pending', direction: 'out', status: 'sending' }
        append(optimistic)
        try {
          const m = communityId ? await services.sendChannelMessage(communityId, convId, out) : await services.messageSend(convId, out)
          replaceOptimistic(`pending-${ts2}`, m)
          if (!communityId) refreshConvos()
        } catch (e: any) { failOptimistic(`pending-${ts2}`); setError(String(e?.message ?? e)) }
      }
      return
    }
    const body = raw
    if (!body || !selConv) return
    const now = Date.now()
    if (now - lastSendRef.current < 300) return
    lastSendRef.current = now
    const convId = selConv
    const communityId = selCommunity
    const myFp = identity?.fingerprint ?? ''
    const ts = Date.now()
    const tempId = `pending-${ts}`
    // T1 eco otimista: monta StoredMessage local e append IMEDIATO + limpa input na hora.
    const optimistic: StoredMessage = { id: tempId, conv_id: convId, author_fp: myFp, body, ts, sig: 'pending', direction: 'out', status: 'sending' }
    append(optimistic)
    setInput('')
    setError(null)
    try {
      const m = communityId ? await services.sendChannelMessage(communityId, convId, body) : await services.messageSend(convId, body)
      // Substitui o otimista pelo definitivo (match por tempId; fallback body+ts proximo no hook).
      replaceOptimistic(tempId, m)
      // Resposta inline: o motor guarda o vínculo e difunde para os peers.
      if (replyToMsg) {
        void services.reply(convId, m.id, replyToMsg.id).catch(() => { /* vínculo é bônus, não bloqueia */ })
        setReplyToMsg(null)
      }
      if (!communityId) refreshConvos()
    } catch (e: any) {
      // Em erro marca failed com botao reenviar — nao some com o texto (fica no balao).
      failOptimistic(tempId)
      setError(String(e?.message ?? e))
    }
  }
  /** Comandos de barra do mobile — os mesmos do desktop (paridade). */
  const runSlashMobile = useCallback(async (name: string, args: string): Promise<string> => {
    try {
      switch (name) {
        case 'ajuda': return 'Comandos: /ajuda · /ping · /hora · /uptime · /meu-fp · /meu-status · /membros · /canais · /dado'
        case 'ping': return 'pong'
        case 'hora': return new Date().toLocaleString('pt-BR')
        case 'uptime': return `no ar desde ${new Date(bootAtMobile.current).toLocaleTimeString('pt-BR')}`
        case 'meu-fp': return identity?.fingerprint ?? '?'
        case 'meu-status': return `status: ${myPresence}`
        case 'membros': return `${activeComm?.members?.length ?? 0} membro(s) neste servidor`
        case 'canais': return `Canais: ${(activeComm?.channels ?? []).map(([, n]) => '#' + n).join(', ') || 'nenhum'}`
        case 'dado':
        case 'roll': {
          const n = Number(args) || 6
          if (n < 2 || n > 1000) return 'use /dado <2-1000>'
          return `saiu ${1 + Math.floor(Math.random() * n)} (d${n})`
        }
        default: return `comando desconhecido: /${name} — use /ajuda`
      }
    } catch (e: any) { return String(e?.message ?? e) }
  }, [identity, myPresence, activeComm])

  const resendMessage = useCallback(async (m: StoredMessage) => {
    if (!m.conv_id) return
    patchStatus(m.id, 'sending')
    setError(null)
    try {
      const fresh = selCommunity ? await services.sendChannelMessage(selCommunity, m.conv_id, m.body) : await services.messageSend(m.conv_id, m.body)
      replaceOptimistic(m.id, fresh)
      if (!selCommunity) refreshConvos()
    } catch (e: any) {
      patchStatus(m.id, 'failed')
      setError(String(e?.message ?? e))
    }
  }, [selCommunity, patchStatus, replaceOptimistic, refreshConvos])
  async function addFriend() {
    const fp = friendFpInput.trim().toLowerCase()
    if (!fp) return
    setError(null); setFriendSuccess(null); setFriendErr(null)
    if (!FP_RE.test(fp)) {
      setFriendErr('Fingerprint inválido — são 12 caracteres hexadecimais (ex.: a1b2c3d4e5f6).')
      return
    }
    if (fp === (identity?.fingerprint ?? '').toLowerCase()) {
      setFriendErr('Esse é o seu próprio fingerprint.')
      return
    }
    setAddingFriend(true)
    try {
      const r: any = await services.friendRequest(fp)
      setFriendFpInput('')
      if (r === 'queued_offline') setFriendSuccess('Peer offline — solicitação enfileirada e será enviada ao reconectar.')
      else setFriendSuccess('Solicitação enviada! Aguardando aceitação.')
      refreshFriends()
    } catch (e: any) {
      setFriendErr(String(e?.message ?? e))
    } finally {
      setAddingFriend(false)
    }
  }
  /** Cola o fingerprint da área de transferência (atalho de 1 toque no celular). */
  async function pasteFp() {
    try {
      const txt = (await navigator.clipboard?.readText?.()) ?? ''
      const clean = txt.trim().toLowerCase()
      if (!clean) { setFriendErr('Área de transferência vazia — copie o fingerprint do seu amigo.'); return }
      // se colou um texto maior, extrai o 1º bloco de 12 hex
      const found = clean.match(/[0-9a-f]{12}/)?.[0] ?? clean
      setFriendFpInput(found)
      setFriendErr(null)
      friendInputRef.current?.focus()
    } catch {
      setFriendErr('Não foi possível ler a área de transferência — cole manualmente no campo.')
    }
  }
  /** Reenvia agora um pedido pendente (a rede também reenvia sozinha a cada 15s). */
  async function retryFriendReq(fp: string) {
    setError(null); setFriendErr(null); setFriendSuccess(null)
    try { await services.friendRequest(fp); setFriendSuccess('Solicitação reenviada!'); refreshFriends() }
    catch (e: any) { setFriendErr(String(e?.message ?? e)) }
  }
  /** Cancela um pedido ainda não aceito (avisa o peer e limpa local). */
  async function cancelFriendReq(fp: string) {
    setError(null); setFriendErr(null); setFriendSuccess(null)
    try { await services.friendRemove(fp); refreshFriends() }
    catch (e: any) { setFriendErr(String(e?.message ?? e)) }
  }
  // foca o campo automaticamente ao abrir a aba "Adicionar amigo"
  useEffect(() => {
    if (friendsTab !== 'adicionar') return
    const id = window.setTimeout(() => friendInputRef.current?.focus(), 60)
    return () => window.clearTimeout(id)
  }, [friendsTab])
  async function respond(fp: string, ok: boolean) { try { await services.friendRespond(fp, ok); refreshFriends() } catch (e: any) { setError(String(e?.message ?? e)) } }
  async function copyMyFp() { await navigator.clipboard?.writeText(identity?.fingerprint ?? '').catch(() => {}); setError(null); setNotice('Fingerprint copiado!'); window.setTimeout(() => setNotice(null), 2500) }

  // Envio de arquivo no celular: <input type=file> real (funciona no browser e
  // no WebView mobile) + shareFile do swarm + mensagem com botão Baixar.
  // Faltava TUDO isso — o botão + era decorativo e nenhum evento era tratado.
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    try {
      const sf = await fileSwarm.shareFile(f)
      setFileList([...fileSwarm.files.values()])
      if (selConv) {
        const body = encodeFileBody(sf)
        try { const m = selCommunity ? await services.sendChannelMessage(selCommunity, selConv, body) : await services.messageSend(selConv, body); append(m); refreshConvos() } catch { /* silent */ }
      }
    } catch (err: any) { setError(String(err?.message ?? err)) }
    e.target.value = ''
  }

  // Entrada por convite: fluxo ÚNICO pelo `JoinServerForm` (mesmo componente do
  // desktop) dentro do sheet de convite. Havia aqui um segundo caminho
  // (`joinInvite` + `inviteBusy` + `inviteError`) que nenhum botão alcançava e
  // cujas mensagens de erro nunca eram renderizadas. Removido: o sheet já
  // mostra o erro real, e "validado ≠ membro" continua explicado no formulário.

  // Nós de mensagem memoizados: parse do corpo + lookup no swarm rodam 1x por
  // mensagem quando messages/fileList mudam (fileList atualiza no máx 1x/300ms
  // via throttle). Linhas com props iguais pulam o re-render (React.memo).
  //
  // v5.5: cada linha carrega a camada SOCIAL real (reações, edição, exclusão,
  // fixar, resposta) via `useSocialWindow` — uma chamada em LOTE por janela.
  // canal de servidor? (definido aqui porque `messageNodes` já precisa dele)
  const isChannel = !!selCommunity
  /** A conversa aberta é um grupo de DM? (afeta cabeçalho e painel de membros) */
  const isGroupConv = selConvObj?.kind === 'group'
  /**
   * Membros do grupo aberto — vem do MOTOR.
   *
   * No mobile o grupo era tratado como DM: o subtítulo dizia "online/offline" e
   * não havia como ver quem estava nele. O roster real está no SQLite
   * (`groupMembers`), então perguntamos a ele.
   */
  const [groupMemberCount, setGroupMemberCount] = useState(0)
  const [showGroupPanel, setShowGroupPanel] = useState(false)

  useEffect(() => {
    if (!selConv || !isGroupConv) { setGroupMemberCount(0); return }
    let vivo = true
    const ler = async () => {
      try {
        const mems = await services.groupMembers(selConv)
        if (vivo) setGroupMemberCount(mems.length)
      } catch { if (vivo) setGroupMemberCount(0) }
    }
    void ler()
    const off = services.subscribe((ev) => { if (ev.type === 'group_synced') void ler() })
    return () => { vivo = false; off() }
  }, [selConv, isGroupConv])

  const social = useSocialWindow(messages, selConv)
  const actions = useMessageActions((ids) => social.refreshIds(ids))

  // ---- autocompletar @menção / :emoji: / /comando (paridade com o desktop) ----
  const [activeAutocomplete, setActiveAutocomplete] = useState<{ kind: 'mention' | 'emoji' | 'slash'; query: string; start: number; end: number } | null>(null)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0)
  const [serverEmojiMap, setServerEmojiMap] = useState<Record<string, string>>({})

  // Emoji customizado do servidor: :nome: precisa renderizar no texto.
  useEffect(() => {
    if (!selCommunity) { setServerEmojiMap({}); return }
    let alive = true
    services.emojiList(selCommunity)
      .then(list => {
        if (!alive) return
        const m: Record<string, string> = {}
        for (const e of (list as any[])) m[e.name] = e.emoji || e.glyph || e.ch || '❔'
        setServerEmojiMap(m)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [selCommunity])

  // Membros do servidor atual (para @menção).
  const communityMembers = useMemo<{ fp: string; nickname: string }[]>(() => {
    if (!activeComm) return []
    return (activeComm.members ?? []).map(([fp, nick]) => ({ fp, nickname: nick || fp.slice(0, 8) }))
  }, [activeComm])

  const autocompleteItems = useMemo<AutoItemMobile[]>(() => {
    const tok = activeAutocomplete
    if (!tok) return []
    const q = tok.query.toLowerCase()
    if (tok.kind === 'mention') {
      const out: AutoItemMobile[] = []
      if (!q || 'everyone'.startsWith(q)) out.push({ key: 'm-everyone', kind: 'mention', label: 'everyone', hint: 'menciona todos do servidor', color: t.accent, insert: '@everyone ' })
      if (!q || 'here'.startsWith(q)) out.push({ key: 'm-here', kind: 'mention', label: 'here', hint: 'menciona quem está online', color: t.accent, insert: '@here ' })
      const seen = new Set<string>()
      for (const p of communityMembers) {
        const nm = p.nickname || p.fp
        if (seen.has(nm)) continue
        if (q && !nm.toLowerCase().includes(q) && !p.fp.startsWith(q)) continue
        seen.add(nm)
        out.push({ key: `m-c-${p.fp}`, kind: 'mention', label: nm, hint: p.fp.slice(0, 12), fp: p.fp, insert: `@${nm} ` })
      }
      return out.slice(0, 12)
    }
    if (tok.kind === 'emoji') {
      const out: AutoItemMobile[] = []
      for (const [name, glyph] of Object.entries(serverEmojiMap)) {
        if (!q || name.toLowerCase().includes(q)) out.push({ key: `e-${name}`, kind: 'emoji', label: name, glyph, insert: `:${name}: ` })
      }
      for (const e of NAMED_EMOJI) {
        if (!q || e.names.some(n => n.includes(q))) out.push({ key: `e-u-${e.char}`, kind: 'emoji', label: e.names[0], glyph: e.char, insert: e.char })
        if (out.length >= 24) break
      }
      return out.slice(0, 24)
    }
    const SLASH: { name: string; summary: string }[] = [
      { name: 'ajuda', summary: 'lista os comandos' },
      { name: 'ping', summary: 'mede o tempo de resposta' },
      { name: 'hora', summary: 'mostra a hora atual' },
      { name: 'uptime', summary: 'há quanto tempo estou online' },
      { name: 'meu-fp', summary: 'mostra meu fingerprint' },
      { name: 'meu-status', summary: 'mostra minha presença' },
      { name: 'membros', summary: 'conta os membros do servidor' },
      { name: 'canais', summary: 'lista os canais' },
      { name: 'dado', summary: 'rola um dado' },
    ]
    return SLASH
      .filter(c => !q || c.name.toLowerCase().includes(q))
      .map(c => ({ key: `s-${c.name}`, kind: 'slash' as const, label: c.name, hint: c.summary, insert: `/${c.name} ` }))
      .slice(0, 12)
  }, [activeAutocomplete, communityMembers, serverEmojiMap])
  useEffect(() => { setAutocompleteIdx(0) }, [activeAutocomplete?.query, activeAutocomplete?.kind])

  function applyAutocompleteMobile(it: AutoItemMobile) {
    if (!activeAutocomplete) return
    const { start, end } = activeAutocomplete
    const next = input.slice(0, start) + it.insert + input.slice(end)
    setInput(next)
    setActiveAutocomplete(null)
    const caret = start + it.insert.length
    setTimeout(() => { try { composerRef.current?.setSelectionRange(caret, caret); composerRef.current?.focus() } catch { /* ignore */ } }, 0)
  }

  // Perfis (avatar + cor de destaque) — paridade Discord: o autor aparece com
  // a identidade que ELE configurou, não com a cor gerada pelo fingerprint.
  const [profilesByFp, setProfilesByFp] = useState<Record<string, ProfileView>>({})
  useEffect(() => {
    let alive = true
    const load = () => {
      services.profileList()
        .then((p) => { if (alive) setProfilesByFp(Object.fromEntries((p as ProfileView[]).map(x => [x.fp, x]))) })
        .catch(() => {})
    }
    load()
    const h = window.setInterval(load, 15000)
    // O mobile não escutava `profile_changed`: uma foto nova levava até 15 s
    // para aparecer e, se o poll falhasse, não aparecia nunca. Mesmo padrão do
    // ThemeShell — a reconciliação periódica continua sendo a rede de segurança.
    const un = services.subscribe((ev: any) => {
      if (ev.type !== 'profile_changed') return
      setProfilesByFp(prev => ({ ...prev, [ev.fp]: ev.profile }))
    })
    return () => { alive = false; window.clearInterval(h); un() }
  }, [])
  const myFp = identity?.fingerprint ?? ''
  const readState = useReadState(selConv, myFp)
  const unreadMarkTs = readState.lastRead

  // Bots do canal (para o badge BOT nas mensagens) + mensagens fixadas.
  useEffect(() => {
    if (!selCommunity) { setBots([]); return }
    let alive = true
    services.botsList(selCommunity).then((b) => { if (alive) setBots(b ?? []) }).catch(() => { if (alive) setBots([]) })
    return () => { alive = false }
  }, [selCommunity, communities.length])

  useEffect(() => {
    if (!selConv) { setPinnedMsgs([]); return }
    let alive = true
    const load = () => {
      void services.pins(selConv).then(async (list) => {
        if (!alive) return
        const out: { id: string; body: string; author: string }[] = []
        for (const mm of list ?? []) {
          const real = messages.find((x) => x.id === mm.msg_id)
          out.push({
            id: mm.msg_id,
            body: real ? (social.bodies.get(real.id) ?? real.body) : (mm.edited_body || ''),
            author: real ? (real.direction === 'out' ? (identity?.nickname ?? 'você') : (selConvObj?.title ?? real.author_fp.slice(0, 8))) : 'mensagem',
          })
        }
        setPinnedMsgs(out)
      }).catch(() => { if (alive) setPinnedMsgs([]) })
    }
    load()
    const un = services.subscribe((ev) => {
      if (ev.type === 'message_pinned' || ev.type === 'message_edited' || ev.type === 'message_deleted') load()
    })
    return () => { alive = false; un() }
  }, [selConv, messages.length, social.bodies, identity, selConvObj])

  /** Contexto do renderer de texto: quem é "eu", nomes e emojis do servidor. */
  const richCtx = useMemo<InlineCtx>(() => {
    const names = new Map<string, string>()
    for (const m of messages) {
      if (m.direction === 'out') names.set(m.author_fp, identity?.nickname ?? 'você')
      else names.set(m.author_fp, selConvObj?.title ?? m.author_fp.slice(0, 8))
    }
    if (myFp) names.set(myFp, identity?.nickname ?? 'você')
    const mentionFps = new Set<string>()
    for (const m of messages) {
      if (m.direction === 'in' && social.meta.get(m.id)?.mentioned) mentionFps.add(myFp)
    }
    return { mentionFps, names, roleNames: new Map(), serverEmojis: new Map(), myFp }
  }, [messages, identity, selConvObj, myFp, social.meta])

  const messageNodes = useMemo(() => messages.map((m, idx) => {
    const mine = m.direction === 'out'
    const authorName = mine ? identity?.nickname ?? 'você' : selConvObj?.title ?? m.author_fp.slice(0, 8)
    const authorFp = mine ? identity?.fingerprint ?? '' : m.author_fp
    const fmeta = parseFileBody(m.body)
    const body = social.bodies.get(m.id) ?? m.body
    const meta = social.meta.get(m.id)
    let pct = 0, done = false, announced = false
    if (fmeta) {
      const sf = fileSwarm.files.get(fmeta.file_id)
      announced = !!sf
      pct = sf ? fileSwarm.progress(sf) : 0
      done = !!sf && sf.chunks > 0 && sf.have.size === sf.chunks
    }
    const prev = idx > 0 ? messages[idx - 1] : null
    const grouped = !!prev
      && prev.author_fp === m.author_fp && prev.direction === m.direction
      && (m.ts - prev.ts) < 5 * 60 * 1000
      && !social.meta.get(prev.id)?.deleted
    // mensagem citada (preview da resposta)
    const replyId = meta?.reply_to
    const replyMsg = replyId ? messages.find((x) => x.id === replyId) : undefined
    const replyTo = replyId
      ? {
          name: replyMsg ? (replyMsg.author_fp === myFp ? (identity?.nickname ?? 'você') : (selConvObj?.title ?? replyMsg.author_fp.slice(0, 8))) : 'mensagem',
          body: replyMsg ? (social.bodies.get(replyMsg.id) ?? replyMsg.body) : '',
        }
      : null

    const renderFile = fmeta
      ? (msg: StoredMessage) => (
          <FileCard
            m={msg} mine={mine}
            fmeta={fmeta} pct={pct} done={done} announced={announced}
            previewUrl={previews[fmeta.file_id]} onDownload={downloadFile} onRetry={resendMessage}
          />
        )
      : undefined

    return (
      <div key={m.id} id={`mmsg-${m.id}`} style={flash === m.id ? { boxShadow: 'inset 0 0 0 2px #f0b232', borderRadius: 8 } : undefined}>
      <MobileMessage
        m={m}
        mine={mine}
        authorName={authorName}
        authorFp={authorFp}
        authorAvatar={profilesByFp[authorFp]?.avatar_b64}
        authorAccent={profilesByFp[authorFp]?.accent}
        body={body}
        meta={meta}
        reactions={social.reactions.get(m.id) ?? []}
        grouped={grouped}
        ctx={richCtx}
        resolveName={(fp) => {
          if (fp === identity?.fingerprint) return 'você'
          const known = peers.find((p) => p.fp === fp)?.nickname
            || peerNickCacheRef.current[fp]
          return known || (fp === selConvObj?.peer_fp ? (selConvObj?.title ?? fp.slice(0, 8)) : fp.slice(0, 8))
        }}
        replyTo={replyTo}
        highlighted={!!meta?.mentioned}
        isBot={!!m.bot_id}
        botName={m.bot_id ? (bots.find((b) => b.id === m.bot_id)?.name ?? undefined) : undefined}
        renderFile={renderFile}
        fontSize={15 * prefs.fontScale}
        onJumpToReply={(id) => {
          const el = document.getElementById(`mmsg-${id}`)
          if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setFlash(id) }
          else setError('A mensagem citada está fora da janela carregada — use a busca.')
        }}
        onReact={(emoji) => { void actions.toggleReaction(selConv ?? '', m.id, emoji) }}
        onEdit={(nb) => { void actions.edit(selConv ?? '', m.id, nb) }}
        onDelete={() => { void actions.remove(selConv ?? '', m.id) }}
        onPin={() => { void actions.setPinned(selConv ?? '', m.id, !meta?.pinned) }}
        onReply={() => setReplyToMsg({ id: m.id, name: authorName, body }) }
        onCopy={() => { void navigator.clipboard?.writeText(body); setNotice('Texto copiado'); setTimeout(() => setNotice(null), 1800) }}
        onReport={() => { void actions.report(m.author_fp, selCommunity ?? undefined, 'spam/abuso') }}
        onForward={() => setForwardFrom({ id: m.id, name: authorName, body })}
        onOpenProfile={(fp) => setProfilePeer({ fp, name: authorName })}
        onOpenThread={isChannel ? () => openThread(selConv ?? '', `Discussão de ${authorName}`) : undefined}
      />
      </div>
    )
  }), [messages, identity, selConvObj, fileList, previews, downloadFile, resendMessage, social.reactions, social.meta, social.bodies, richCtx, selConv, selCommunity, actions, bots, myFp, setFlash, profilesByFp, peers, peerNickCacheRef])

  /** Refs de scroll: cada linha recebe id para o "pular para a citada". */
  useEffect(() => {
    // marca a conversa como lida ao abrir (cursor real do motor)
    if (selConv && messages.length) {
      const last = messages[messages.length - 1]
      if (last && !readRef.current.has(selConv)) {
        readRef.current.add(selConv)
        void services.readSet(selConv, last.ts).catch(() => {})
      }
    }
  }, [selConv, messages])


  // ================= SHEETS DA CAMADA SOCIAL (5.5) =================
  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [sheetSearchQ, setSheetSearchQ] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)

  /** Busca REAL no motor (SQL) com filtros `from:`/`in:`/`has:`. */
  async function runSearch(raw: string) {
    setSheetSearchQ(raw)
    const text = raw.trim()
    if (text.length < 2) { setSearchHits([]); return }
    setSearchBusy(true)
    try {
      const parts = text.split(/\s+/)
      const q = { text: '', from: '', conv: selConv ?? '', has: '', before: 0, limit: 50 }
      for (const p of parts) {
        if (p.startsWith('from:')) q.from = p.slice(5)
        else if (p.startsWith('in:')) q.conv = p.slice(3)
        else if (p.startsWith('has:')) q.has = p.slice(4)
        else q.text += (q.text ? ' ' : '') + p
      }
      const hits = await services.searchMessages(q)
      setSearchHits(hits ?? [])
      setError(null)
    } catch (e: any) {
      setError(String(e?.message ?? e))
      setSearchHits([])
    } finally { setSearchBusy(false) }
  }

  function openThread(parent: string, name: string) {
    void (async () => {
      try {
        const existing = await services.threadList(selCommunity ?? '', parent)
        const mine2 = (existing ?? []).find((x) => x.name === name)
        if (mine2) { setThreadId(mine2.id); setThreadFor({ parent, name, body: '' }); setShowThread(true); void loadThread(mine2.id); return }
        const created = await services.threadCreate(selCommunity ?? '', parent, name, 'thread', '')
        setThreadId(created.id)
        setThreadFor({ parent, name, body: '' })
        setShowThread(true)
        void loadThread(created.id)
        setError(null)
      } catch (e: any) { setError(String(e?.message ?? e)) }
    })()
  }
  async function loadThread(id: string) {
    try { setThreadMsgs(await services.threadMessages(id, 100) ?? []) } catch (e: any) { setError(String(e?.message ?? e)) }
  }
  async function sendThread() {
    if (!threadId || !threadInput.trim() || !selCommunity) return
    const body = threadInput.trim()
    setThreadInput('')
    try {
      await services.threadSend(selCommunity, threadId, body)
      await loadThread(threadId)
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }
  async function setMyStatus(st: PresenceStatus, txt: string, emoji = '') {
    setMyStatusBusy(true)
    try {
      await services.presenceSet(st, txt, emoji)
      // O estado central também passa a conhecer a escolha: é ele quem decide
      // o que anunciar quando a janela sai de foco.
      setDesiredPresence(st)
      setMyPresence(st)
      setCustomStatus(txt)
      setError(null)
    } catch (e: any) { setError(String(e?.message ?? e)) } finally { setMyStatusBusy(false) }
  }

  const sheetWrap = (title: string, body: React.ReactNode, onClose: () => void) => (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end' }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}
        style={{ width: '100%', maxHeight: '86dvh', background: t.panel, borderTop: `1px solid ${t.border}`, borderRadius: 16, padding: 12, paddingBottom: 'calc(16px + env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: 800, color: t.heading }}>{title}</div>
          <button onClick={onClose} aria-label="Fechar" style={{ background: 'transparent', border: 'none', color: t.muted, display: 'flex', padding: 4, cursor: 'pointer' }}><Icon d={Icons.x} size={18} /></button>
        </div>
        {body}
      </div>
    </div>
  )

  function renderMobileSheets() {
    return (
      <>
        {/* Painel do GRUPO: membros reais, renomear e remover.
            Fica aqui porque o sheet é o mesmo padrão dos outros painéis do
            mobile (busca, fixadas, salvas, thread). */}
        {showGroupPanel && isGroupConv && selConv && sheetWrap(
          selConvObj?.title || 'Grupo',
          <GroupPanel
            convId={selConv}
            title={selConvObj?.title || 'Grupo'}
            myFp={identity?.fingerprint ?? ''}
            friends={friendsAccepted}
            profiles={profilesByFp}
            onClose={() => setShowGroupPanel(false)}
            onRenamed={() => { refreshConvos() }}
            onChanged={() => {
              void services.groupMembers(selConv).then((m) => setGroupMemberCount(m.length)).catch(() => {})
              refreshConvos()
            }}
          />,
          () => setShowGroupPanel(false),
        )}
        {/* BUSCA */}
        {showSearch && sheetWrap('Buscar mensagens', (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ display: 'flex', alignItems: 'center', color: t.muted, paddingLeft: 8 }}><Icon d={Icons.search} size={16} /></span>
              <input
                value={sheetSearchQ}
                onChange={(e) => void runSearch(e.target.value)}
                placeholder="palavra  ·  from:fingerprint  ·  has:link"
                aria-label="Buscar mensagens"
                style={{ flex: 1, background: t.input, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 15, outline: 'none' }}
              />
            </div>
            <div style={{ fontSize: 10, color: t.muted }}>filtros: <b>from:</b>autor · <b>in:</b>conversa · <b>has:</b> link | file | mention</div>
            <div style={{ overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {searchBusy && <div style={{ fontSize: 12, color: t.muted, padding: 8 }}>buscando…</div>}
              {!searchBusy && searchHits.length === 0 && sheetSearchQ.length >= 2 && <div style={{ fontSize: 12, color: t.muted, padding: 8 }}>nada encontrado</div>}
              {searchHits.map((h) => (
                <button
                  key={h.id}
                  onClick={() => {
                    void services.messagesAround(h.conv_id, h.ts, 60).then((ms) => {
                      if (ms?.length) { append(ms[0]); setSelConv(h.conv_id); setShowSearch(false) }
                    })
                    setShowSearch(false)
                  }}
                  style={{ display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left', background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: 8, cursor: 'pointer', color: t.text }}
                >
                  <Avatar name={h.author_fp} fp={h.author_fp} size={26} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: t.muted }}>{h.author_fp.slice(0, 10)} · {new Date(h.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
                    <div style={{ fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as any}>{h.body}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ), () => { setShowSearch(false); setSearchHits([]) })}

        {/* FIXADAS */}
        {showPins && sheetWrap(`Mensagens fixadas (${pinnedMsgs.length})`, (
          <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {pinnedMsgs.length === 0 && <div style={{ fontSize: 12, color: t.muted, padding: 8 }}>nada fixado nesta conversa</div>}
            {pinnedMsgs.map((pm) => (
              <div key={pm.id} style={{ background: t.input, border: `1px solid ${t.border}`, borderLeft: `3px solid ${t.yellow}`, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: t.heading, marginBottom: 3 }}>{pm.author}</div>
                <div style={{ fontSize: 13, color: t.text, wordBreak: 'break-word' }}>{pm.body || '(anexo)'}</div>
                <button
                  onClick={() => { void actions.setPinned(selConv ?? '', pm.id, false); setShowPins(false) }}
                  style={{ marginTop: 8, background: 'transparent', border: `1px solid ${t.border}`, color: t.muted, borderRadius: 6, padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                >desafixar</button>
              </div>
            ))}
          </div>
        ), () => setShowPins(false))}

        {/* MARCADORES SALVOS — paridade com a inbox do desktop (Social.tsx) */}
        {showBookmarks && sheetWrap('Mensagens salvas', (
          <BookmarksPanel convId={selConv ?? ''} messages={messages} onClose={() => setShowBookmarks(false)} onJump={(id) => {
            setShowBookmarks(false)
            const el = document.getElementById(`mmsg-${id}`)
            if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setFlash(id) }
          }} />
        ), () => setShowBookmarks(false))}

        {/* THREAD */}
        {showThread && sheetWrap(threadFor?.name ? `Discussão — ${threadFor.name}` : 'Discussão', (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            {threadFor?.body && (
              <div style={{ fontSize: 12, color: t.muted, background: t.input, borderRadius: 8, padding: 8, borderLeft: `3px solid ${t.accent}` }}>{threadFor.body}</div>
            )}
            <div style={{ overflowY: 'auto', minHeight: 80, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {threadMsgs.length === 0 && <div style={{ fontSize: 12, color: t.muted }}>nenhuma mensagem na discussão ainda</div>}
              {threadMsgs.map((tm) => (
                <div key={tm.id} style={{ display: 'flex', gap: 8 }}>
                  <Avatar name={tm.author_fp} fp={tm.author_fp} size={24} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: t.muted }}>{tm.author_fp.slice(0, 10)} · {new Date(tm.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                    <RichText body={tm.body} ctx={richCtx} color={t.text} fontSize={14} />
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={threadInput}
                onChange={(e) => setThreadInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void sendThread() }}
                placeholder="Responder na discussão…"
                aria-label="Mensagem na discussão"
                style={{ flex: 1, background: t.input, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 12px', fontSize: 15, outline: 'none' }}
              />
              <button onClick={() => void sendThread()} disabled={!threadInput.trim()} style={{ background: t.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '0 14px', display: 'flex', cursor: threadInput.trim() ? 'pointer' : 'default', opacity: threadInput.trim() ? 1 : 0.5 }}><Icon d={Icons.send} size={16} /></button>
            </div>
          </div>
        ), () => { setShowThread(false); setThreadFor(null); setThreadId(null) })}

        {/* PERFIL DE OUTRO USUÁRIO */}
        {profilePeer && sheetWrap(profilePeer.name, (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ position: 'relative', display: 'inline-flex' }}>
                <Avatar name={profilePeer.name} fp={profilePeer.fp} size={56} />
                <PeerDot on={(presence.get(profilePeer.fp)?.status ?? (profilePeer.fp === myFp ? myPresence : 'offline')) !== 'offline'} ring={t.panel} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: t.heading }}>{profilePeer.name}</div>
                <div style={{ fontSize: 11, color: t.muted, fontFamily: MONO }}>{profilePeer.fp}</div>
                <div style={{ fontSize: 11, color: presence.get(profilePeer.fp)?.status === 'dnd' ? t.red : t.muted }}>
                  {PRESENCE_LABEL[(presence.get(profilePeer.fp)?.status ?? (profilePeer.fp === myFp ? myPresence : 'offline')) as PresenceStatus]}
                </div>
              </div>
            </div>
            {profilePeer.fp === myFp && (
              <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: t.muted, marginBottom: 6, textTransform: 'uppercase' }}>Meu status</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  {(['online', 'idle', 'dnd', 'invisible'] as PresenceStatus[]).map((st) => (
                    <button
                      key={st}
                      onClick={() => void setMyStatus(st, customStatus)}
                      disabled={myStatusBusy}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: myPresence === st ? 'rgba(88,101,242,.25)' : t.sidebar, border: `1px solid ${myPresence === st ? t.accent : t.border}`, color: t.text, borderRadius: 99, padding: '5px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: PRESENCE_COLOR[st] }} />{PRESENCE_LABEL[st]}
                    </button>
                  ))}
                </div>
                <input
                  value={customStatus}
                  onChange={(e) => setCustomStatus(e.target.value)}
                  onBlur={() => void setMyStatus(myPresence, customStatus)}
                  placeholder="O que você está fazendo?"
                  aria-label="Status personalizado"
                  style={{ width: '100%', boxSizing: 'border-box', background: t.sidebar, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, padding: '9px 10px', fontSize: 14, outline: 'none' }}
                />
                <div style={{ fontSize: 10, color: t.muted, marginTop: 6 }}>o status é assinado e vai pelo túnel P2P — só quem é seu amigo vê</div>
              </div>
            )}
            <button
              onClick={() => {
                setProfilePeer(null)
                if (profilePeer.fp !== myFp) { setSelPeerFp(profilePeer.fp); void openDm(profilePeer.fp, profilePeer.name) }
              }}
              style={{ background: t.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '11px 0', fontSize: 13, fontWeight: 800, cursor: 'pointer' }}
            >{profilePeer.fp === myFp ? 'Fechar' : 'Abrir conversa'}</button>
          </div>
        ), () => setProfilePeer(null))}

        {/* ENCAMINHAR */}
        {forwardFrom && sheetWrap(`Encaminhar de ${forwardFrom.name}`, (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, overflowY: 'auto' }}>
            <div style={{ fontSize: 12, color: t.muted, background: t.input, borderRadius: 8, padding: 8, borderLeft: `3px solid ${t.accent}` }}>{forwardFrom.body || '(anexo)'}</div>
            {conversations.filter((c) => c.id !== selConv).map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  void (async () => {
                    try {
                      await services.forward(forwardFrom.id, c.id, selCommunity ?? '', c.title)
                      setNotice(`Encaminhada para ${c.title}`)
                      setTimeout(() => setNotice(null), 2500)
                      setForwardFrom(null)
                    } catch (e: any) { setError(String(e?.message ?? e)) }
                  })()
                }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: 10, cursor: 'pointer', textAlign: 'left' }}
              >
                <Avatar name={c.title} fp={c.id} size={28} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: t.text, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</div>
              </button>
            ))}
            {conversations.filter((c) => c.id !== selConv).length === 0 && (
              <div style={{ fontSize: 12, color: t.muted }}>sem outras conversas para encaminhar</div>
            )}
          </div>
        ), () => setForwardFrom(null))}
      </>
    )
  }

  // ATUALIZAÇÃO ANTES DE ENTRAR (mesmo gate do desktop). Só aparece quando há
  // versão nova; falha de rede não atrapalha o boot.
  const updateGate = useUpdateGate(true)

  if (phase === 'loading') return (<><UpdateBootScreen api={updateGate} fallback={<BootScreen native={services.kind === 'native'} />} /><UpdateOverlay api={updateGate} /></>)
  if (phase === 'create') return <CreateAccount onDone={id => { setIdentity(id); setPhase('app') }} />
  if (phase === 'lock') return <LockScreen nickname={identity?.nickname ?? ''} onUnlock={id => { setIdentity(id); setPhase('app') }} />

  // ---- conversa em tela cheia (lista FLAT, igual desktop) ----
  if (selConv) {
    const channelName = activeComm?.channels.find(([id]) => id === selConv)?.[1] ?? selConvObj?.title ?? peerTitle
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: t.main, color: t.text, fontFamily: 'Inter', overflow: 'hidden' }}>
        {/* barra superior da conversa */}
        <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 8, paddingBottom: 0, paddingTop: 'env(safe-area-inset-top)', background: t.sidebar, borderBottom: `1px solid ${t.border}`, flexShrink: 0, boxShadow: '0 1px 0 rgba(0,0,0,.2)' }}>
          <button aria-label="Voltar" className="m-iconbtn" onClick={() => { setSelConv(null); setSelPeerFp(null); setShowMembers(false) }}>
            <span style={{ display: 'flex', transform: 'rotate(90deg)' }}><Icon d={Icons.chevron} size={18} /></span>
          </button>
          {isChannel
            ? <span style={{ color: t.muted, display: 'flex', flexShrink: 0 }}><Icon d={Icons.hash} size={20} /></span>
            : <Avatar name={peerTitle} fp={selPeerFp ?? selConv} size={26} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: t.heading, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{isChannel ? channelName : peerTitle}</div>
            <div style={{ fontSize: 11, color: t.muted }}>
              {isChannel
                ? `${activeComm?.members?.length ?? 0} membros`
                : isGroupConv
                  ? `${groupMemberCount} ${groupMemberCount === 1 ? 'membro' : 'membros'}`
                  : onlineFps.has(selPeerFp ?? '') ? 'online' : 'offline'}
            </div>
          </div>
          {!isChannel && (
            <>
              {/* Sem hard-disable: o clique sempre responde. Se o WebView não tiver
                  WebRTC/permissão, `startCall` mostra o diagnóstico real em vez de
                  o botão ficar morto e sem explicação (o `callsSupport` é snapshot de render). */}
              <span title={callsOk ? 'Iniciar chamada de voz' : `Iniciar chamada de voz — ${callsUnavailableDetail}`} style={{ display: 'flex', flexShrink: 0 }}>
                <button aria-label="Chamada de voz" title={callsOk ? 'Iniciar chamada de voz' : `Iniciar chamada de voz — ${callsUnavailableDetail}`} className="m-iconbtn" style={callsOk ? undefined : { opacity: 0.75, color: t.red }} onClick={() => startCall('voice')}><Icon d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" size={17} /></button>
              </span>
              <span title={callsOk ? 'Iniciar chamada de vídeo' : `Iniciar chamada de vídeo — ${callsUnavailableDetail}`} style={{ display: 'flex', flexShrink: 0 }}>
                <button aria-label="Chamada de vídeo" title={callsOk ? 'Iniciar chamada de vídeo' : `Iniciar chamada de vídeo — ${callsUnavailableDetail}`} className="m-iconbtn" style={callsOk ? undefined : { opacity: 0.75, color: t.red }} onClick={() => startCall('video')}><Icon d="M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" size={17} /></button>
              </span>
            </>
          )}
          {isChannel && (
            <button aria-label="Membros" className="m-iconbtn" onClick={() => setShowMembers(v => !v)}><Icon d={Icons.users} size={17} /></button>
          )}
          {isGroupConv && (
            <button aria-label="Membros do grupo" title="Membros, renomear ou remover" className="m-iconbtn" onClick={() => setShowGroupPanel(true)}><Icon d={Icons.users} size={17} /></button>
          )}
          <button aria-label="Mais opções" title="Mais" className="m-iconbtn" onClick={() => setTopMenu((v) => !v)}><span style={{ fontSize: 18, lineHeight: 1 }}>⋯</span></button>
          {topMenu && (
            <div onClick={() => setTopMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 150, background: 'rgba(0,0,0,.4)' }}>
              <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: 52, right: 8, background: t.panel, border: `1px solid ${t.border}`, borderRadius: 10, padding: 6, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 190, boxShadow: '0 8px 24px rgba(0,0,0,.5)' }}>
                {[
                  { id: 'search', label: 'Buscar mensagens', icon: Icons.search },
                  { id: 'pins', label: `Fixadas (${pinnedMsgs.length})`, icon: Icons.pin },
                  { id: 'downloads', label: dlCount > 0 ? `Downloads (${dlCount})` : 'Downloads', icon: Icons.download },
                  ...(isChannel ? [{ id: 'members', label: 'Membros do canal', icon: Icons.users }] : []),
                  { id: 'status', label: 'Meu status', icon: Icons.smile },
                ].map((it) => (
                  <button
                    key={it.id}
                    onClick={() => {
                      setTopMenu(false)
                      if (it.id === 'search') setShowSearch(true)
                      else if (it.id === 'pins') setShowPins(true)
                      else if (it.id === 'downloads') setShowDownloads(true)
                      else if (it.id === 'members') setShowMembers(true)
                      else if (it.id === 'status') setProfilePeer({ fp: myFp, name: identity?.nickname ?? 'você' })
                    }}
                    style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'transparent', border: 'none', color: t.text, textAlign: 'left', padding: '9px 10px', borderRadius: 6, fontSize: 13, cursor: 'pointer' }}
                  ><span style={{ color: t.muted, display: 'flex' }}><Icon d={it.icon} size={15} /></span>{it.label}</button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* drawer de membros do canal */}
        {showMembers && isChannel && (
          <div style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(0,0,0,.5)' }} onClick={() => setShowMembers(false)}>
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 260, maxWidth: '80vw', background: t.sidebar, borderLeft: `1px solid ${t.border}`, padding: '14px 8px', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
              <div className="member-group-head">MEMBROS — {activeComm?.members?.length ?? 0}</div>
              {(activeComm?.members ?? []).map(([fp, nick]) => (
                <div key={fp} className="member-row">
                  <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                    <Avatar name={nick || fp} fp={fp} size={28} />
                    <PeerDot on={onlineFps.has(fp) || (!!identity?.fingerprint && fp === identity.fingerprint)} ring={t.sidebar} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick || fp.slice(0, 8)}</div>
                    <div style={{ fontSize: 10, color: t.muted, fontFamily: MONO }}>{fp.slice(0, 10)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="m-err" style={{ margin: '10px 12px 0' }}>
            {error}
            <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#ff9c9c', cursor: 'pointer' }}>x</button>
          </div>
        )}

        {renderIncomingModal()}

        <DownloadsPanel
          open={showDownloads}
          onClose={() => setShowDownloads(false)}
          onDoneToast={(msg) => { try { setNotice(msg); window.setTimeout(() => setNotice(null), 6000) } catch { /* ignore */ } }}
        />

        {activeCall && (
          <div data-testid="mobile-call-panel" style={{ margin: '10px 12px 0', background: t.panel, border: `1px solid ${t.green}55`, borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0, maxHeight: callPanelSize === 'compact' ? 190 : callPanelSize === 'normal' ? '46vh' : '68vh', overflowY: 'auto', transition: 'max-height 180ms ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {(activeCall.participants ?? []).filter((p: any) => p.fp !== identity?.fingerprint && p.stream).map((p: any) => (
                <audio
                  key={p.fp}
                  autoPlay
                  playsInline
                  data-call-audio-fp={p.fp}
                  ref={(el: HTMLAudioElement | null) => {
                    attachStream(el, p.stream)
                    if (el) applyParticipantPlayback(el, p.fp, !!activeCall.deafened)
                  }}
                  style={{ display: 'none' }}
                />
              ))}
              <span style={{ fontSize: 13, fontWeight: 800, color: t.heading, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{activeCall.kind === 'video' ? <Icon d={Icons.video} size={15} /> : <Icon d={Icons.phone} size={15} />} Em chamada • {fmtCallDuration(callDuration)} • {(activeCall.participants ?? []).length} na sala</span>
              </span>
              {/* HONESTIDADE (proxy/full): a mÃ­dia WebRTC sai direto (UDP do
                  WebView), fora do proxy/Tor do app â€” nÃ£o apresentar o modo
                  como protetor da chamada. */}
              {(privacyMode === 'proxy' || privacyMode === 'full') && (
                <span
                  title="A mÃ­dia (Ã¡udio/vÃ­deo/tela) usa sockets UDP diretos do WebRTC, fora do proxy/Tor do app. Os participantes veem seu IP real. Mensagens e arquivos seguem protegidos."
                  style={{ fontSize: 9, fontWeight: 800, background: `${t.yellow}22`, color: t.yellow, padding: '2px 7px', borderRadius: 99, whiteSpace: 'nowrap', cursor: 'help', flexShrink: 0 }}
                >nÃ£o anÃ´nima</span>
              )}
              {/* v6: fase (chamando/conectando/reconectando…) com elapsed */}
              <CallPhaseBadge phase={activeCall.phase} startAt={activeCall.startAt} nowMs={nowMs} mediaLive={mediaLiveMobile} />
              <button type="button" data-testid="call-panel-smaller" aria-label="Diminuir painel da chamada" title={callPanelSize === 'compact' ? 'Painel já está compacto' : 'Diminuir painel'} disabled={callPanelSize === 'compact'} onClick={() => setCallPanelSize(callPanelSize === 'expanded' ? 'normal' : 'compact')} style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${t.border}`, background: t.input, color: callPanelSize === 'compact' ? t.muted : t.text, opacity: callPanelSize === 'compact' ? 0.5 : 1 }}>↑</button>
              <button type="button" data-testid="call-panel-larger" aria-label="Aumentar painel da chamada" title={callPanelSize === 'expanded' ? 'Painel já está expandido' : 'Aumentar painel'} disabled={callPanelSize === 'expanded'} onClick={() => setCallPanelSize(callPanelSize === 'compact' ? 'normal' : 'expanded')} style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${t.border}`, background: t.input, color: callPanelSize === 'expanded' ? t.muted : t.text, opacity: callPanelSize === 'expanded' ? 0.5 : 1 }}>↓</button>
              <button aria-label={isMuted ? 'Ativar microfone' : 'Silenciar'} title={isMuted ? 'Ativar microfone' : 'Silenciar'} className="m-iconbtn" style={isMuted ? { background: t.red, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' } : { display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => { const nm = !isMuted; setIsMuted(nm); callManager.toggleMute() }}>{isMuted ? <Icon d={Icons.micOff} size={16} /> : <Icon d={Icons.mic} size={16} />}</button>
              <button aria-label={(activeCall as any)?.cameraOn ? 'Desligar câmera' : 'Ligar câmera'} title={(activeCall as any)?.cameraOn ? 'Desligar câmera' : 'Ligar câmera'} className="m-iconbtn" style={(activeCall as any)?.cameraOn ? { background: t.green, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' } : { display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => callManager.toggleCamera().catch((e: any) => setError(String(e?.message ?? e)))}><Icon d={Icons.video} size={16} /></button>
              <button className="m-btn red" style={{ padding: '9px 14px' }} onClick={() => { callManager.leave().catch((e: any) => setError(String(e?.message ?? e))) }}>Sair</button>
            </div>
            {callPanelSize !== 'compact' && <div style={{ fontSize: 11, color: t.muted }} role="status">rota: {callManager.getRungSummary()}</div>}
            {callPanelSize !== 'compact' && <button onClick={() => setShowCallDiag((v) => !v)} aria-label="Diagnóstico da chamada" style={{ background: showCallDiag ? t.accent : t.input, border: `1px solid ${t.border}`, color: showCallDiag ? '#fff' : t.text, borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>{showCallDiag ? 'Ocultar diagnóstico' : 'Diagnóstico'}</button>}
            {showCallDiag && <CallDiagnostics compact />}
            {(activeCall as any)?.relayActive && (
              <div title="Áudio via relay pela sinalização — latência alta, WebRTC indisponível" style={{ fontSize: 11, fontWeight: 800, background: '#f0b232', color: '#000', padding: '4px 8px', borderRadius: 8, textAlign: 'center' }}>via relay (latência alta)</div>
            )}
            {callPanelSize !== 'compact' && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label htmlFor="m-call-quality" style={{ fontSize: 11, color: t.muted, fontWeight: 700 }}>Qualidade</label>
              <select id="m-call-quality" aria-label="Qualidade da chamada" value={(activeCall.quality as CallQuality | undefined) ?? callQuality} onChange={e => changeQuality(e.target.value as CallQuality)} style={{ background: t.input, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, padding: '6px 8px', fontSize: 12 }}>
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="4K">4K</option>
              </select>
              {(((activeCall as any)?.qualityNotice as string | undefined) || qualityError) && (
                <span role="status" style={{ fontSize: 11, color: qualityError ? '#ff9c9c' : t.yellow }}>{qualityError ?? ((activeCall as any)?.qualityNotice as string) ?? ((activeCall as any)?.relayActive ? `modo compatibilidade ativo (${(activeCall as any)?.relayReason ?? 'relay'}) — áudio via relay (latência alta)` : null)}</span>
              )}
              {/* `disabled` escondia o porquê: no Android o botão não tem
                  getDisplayMedia, mas o usuário só descobria tentando e não
                  acontecendo nada. Deixar clicável + mensagem honesta é melhor —
                  é o mesmo padrão do desktop. */}
              <button onClick={() => { if ((activeCall as any)?.sharing) { callManager.stopScreenShare().catch((e: any) => setError(String(e?.message ?? e))); return } if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return } setShowScreenPicker(true) }} data-testid="mobile-screen-share" title={supportsScreenShare() ? 'Compartilhar tela (escolher fonte, áudio e qualidade)' : (screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG)} aria-label="Compartilhar tela" style={{ background: (activeCall as any)?.sharing ? t.green : t.input, border: `1px solid ${t.border}`, color: (activeCall as any)?.sharing ? '#fff' : t.text, opacity: supportsScreenShare() || (activeCall as any)?.sharing ? 1 : 0.5, borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon d={Icons.screen} size={12} /> {(activeCall as any)?.sharing ? 'compartilhando' : 'tela'}</button>
            </div>}
            {/* Quadrados da chamada no mobile: MESMO modelo do desktop
                (`callTiles.ts`) e mesmo componente. A tela ganha quadrado
                próprio; fixar/expandir vale para pessoa E para tela. */}
            {(() => {
              if (callTilesMobile.length === 0) return null
              const cols = pinnedTileId ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)'
              return (
                <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 8 }}>
                  {visibleCallTilesMobile.map((tile) => (
                    <div
                      key={tile.id}
                      style={{
                        // TELA CHEIA é overlay (ScreenStage), não um quadrado
                        // maior: no celular "expandir" dentro do painel de 46vh
                        // continuava pequeno.
                        height: callPanelSize === 'compact' ? 92 : tile.kind === 'screen' ? 168 : 124,
                        transition: 'height 180ms ease',
                      }}
                    >
                      <CallTileComponent
                        tile={tile}
                        pinned={tile.id === pinnedTileId}
                        onPin={(id) => setPinnedTileId((cur) => (cur === id ? null : id))}
                        onExpand={(id) => setExpandedTileId((cur) => (cur === id ? null : id))}
                        callDeafened={!!activeCall.deafened}
                        palette={{ heading: t.heading, muted: t.muted, green: t.green, red: t.red, accent: t.accent, border: t.border }}
                        minHeight={callPanelSize === 'compact' ? 92 : 124}
                        avatarColor={avatarColor}
                      />
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
        )}

        {/* TELA CHEIA no mobile: mesmo overlay do desktop. O painel (e os
            `<audio>` remotos) continua montado atrás. */}
        {stageTileMobile && (
          <ScreenStage
            tile={stageTileMobile}
            palette={{ heading: t.heading, muted: t.muted, green: t.green, red: t.red, accent: t.accent, border: t.border }}
            onCollapse={() => setExpandedTileId(null)}
            muted={!!activeCall?.muted}
            onToggleMute={() => { const nm = !isMuted; setIsMuted(nm); callManager.toggleMute() }}
            cameraOn={!!activeCall?.cameraOn}
            onToggleCamera={() => { void callManager.toggleCamera() }}
            onLeave={() => { void callManager.leave() }}
            callTitle={peerTitle ?? channelName ?? undefined}
          />
        )}

        {/* mensagens — lista flat estilo desktop */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.length === 0 ? (
            isChannel ? (
              <div style={{ padding: '8px 4px' }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#41434a', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span style={{ fontSize: 28, color: '#fff', fontWeight: 800 }}>#</span>
                </div>
                <div style={{ fontSize: 21, fontWeight: 900, color: t.heading, marginTop: 12 }}>Bem-vindo(a) a #{channelName}!</div>
                <div style={{ fontSize: 13, color: t.muted, marginTop: 6 }}>Este é o começo do canal #{channelName}.</div>
              </div>
            ) : (
              <EmptyBlock msg="Nenhuma mensagem ainda" sub="Envie a primeira. Se o peer estiver offline, fica pendente e sai ao reconectar." />
            )
          ) : messageNodes}
          <div ref={endRef} style={{ height: 1, flexShrink: 0 }} />
        </div>

        {/* LINHA DE NÃO LIDAS */}
        {unreadMarkTs > 0 && messages.some((x) => x.ts > unreadMarkTs) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px', background: t.main, flexShrink: 0 }}>
            <span style={{ flex: 1, height: 1, background: t.red }} />
            <span style={{ fontSize: 10, fontWeight: 800, color: t.red, textTransform: 'uppercase' }}>novas mensagens</span>
            <span style={{ flex: 1, height: 1, background: t.red }} />
          </div>
        )}

        {/* barra de mensagens fixadas */}
        {pinnedMsgs.length > 0 && (
          <button
            onClick={() => setShowPins(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: t.input, border: 'none', borderBottom: `1px solid ${t.border}`, padding: '6px 12px', cursor: 'pointer', flexShrink: 0 }}
          >
            <span style={{ color: t.muted, display: 'flex', flexShrink: 0 }}><Icon d={Icons.pin} size={13} /></span>
            <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <b style={{ color: t.text }}>{pinnedMsgs[0].author}</b>: {pinnedMsgs[0].body}
              {pinnedMsgs.length > 1 && <span style={{ marginLeft: 6 }}>+{pinnedMsgs.length - 1}</span>}
            </span>
          </button>
        )}

        {/* barra de resposta inline */}
        {replyToMsg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: t.sidebar, borderTop: `1px solid ${t.border}`, padding: '6px 12px', flexShrink: 0 }}>
            <span style={{ flex: 1, minWidth: 0, borderLeft: `3px solid ${t.accent}`, paddingLeft: 8 }}>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 800, color: t.text }}>↩ {replyToMsg.name}</span>
              <span style={{ display: 'block', fontSize: 11, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyToMsg.body || 'anexo'}</span>
            </span>
            <button onClick={() => setReplyToMsg(null)} aria-label="Cancelar resposta" style={{ background: 'transparent', border: 'none', color: t.muted, cursor: 'pointer', display: 'flex', padding: 4 }}><Icon d={Icons.x} size={16} /></button>
          </div>
        )}

        {/* compositor estilo desktop — textarea (Shift+Enter quebra linha de verdade) */}
        <div style={{ padding: '8px 10px calc(10px + env(safe-area-inset-bottom))', background: t.main, borderTop: `1px solid ${t.border}`, flexShrink: 0, position: 'relative' }}>
          {Object.values(typingPeers).length > 0 && (
            <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: t.muted, marginBottom: 6, paddingLeft: 2 }}>
              <span className="spin" style={{ width: 9, height: 9, border: `2px solid ${t.muted}`, borderTopColor: t.accent, borderRadius: '50%', display: 'inline-block', flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {Object.values(typingPeers).map(p => p.nick).join(', ')} está digitando…
              </span>
            </div>
          )}
          {activeAutocomplete && autocompleteItems.length > 0 && (
            <div role="listbox" style={{
              position: 'absolute', bottom: 'calc(100% - 4px)', left: 10, right: 10, zIndex: 60,
              background: t.rail, border: `1px solid ${t.border}`, borderRadius: 8,
              boxShadow: '0 -8px 28px rgba(0,0,0,.55)', overflow: 'hidden', maxHeight: 210,
              display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ maxHeight: 190, overflowY: 'auto' }}>
                {autocompleteItems.map((it, i) => (
                  <button
                    key={it.key}
                    role="option"
                    aria-selected={i === autocompleteIdx}
                    onMouseDown={(e) => { e.preventDefault(); applyAutocompleteMobile(it) }}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                      background: i === autocompleteIdx ? t.accent : 'transparent',
                      border: 'none', color: '#fff', textAlign: 'left',
                      padding: '7px 10px', cursor: 'pointer', fontSize: 13,
                    }}
                  >
                    <span style={{
                      width: 22, height: 22, borderRadius: '50%', flexShrink: 0,
                      background: it.glyph ? 'transparent' : (it.color || t.accent),
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: it.glyph ? 14 : 10, fontWeight: 800,
                    }}>{it.glyph || it.label.slice(0, 1).toUpperCase()}</span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 700, display: 'block' }}>{it.label}</span>
                      {it.hint && <span style={{ fontSize: 10, opacity: .75, fontFamily: MONO }}>{it.hint}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {composerEmoji && (
            <EmojiPicker
              open
              onClose={() => setComposerEmoji(false)}
              onPick={(em) => { setInput((v) => v + em); setComposerEmoji(false); setTimeout(() => composerRef.current?.focus(), 20) }}
              anchor="up"
            />
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, background: t.composer, borderRadius: 8, padding: '8px 10px' }}>
            <input type="file" ref={(el: any) => fileInputRef.current = el} onChange={onPickFile} style={{ display: 'none' }} />
            <button aria-label="Anexar" title="Anexar arquivo (todos semeiam)" onClick={() => fileInputRef.current?.click()} style={{ width: 28, height: 28, borderRadius: '50%', background: t.accent, color: '#fff', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon d={Icons.plus} size={16} /></button>
            <textarea
              ref={composerRef}
              value={input}
              rows={1}
              onChange={e => {
                const v = e.target.value
                setInput(v)
                const el = e.currentTarget
                el.style.height = 'auto'
                el.style.height = `${Math.min(140, el.scrollHeight)}px`
                const caret = el.selectionStart ?? v.length
                setActiveAutocomplete(activeToken(v, caret))
                // avisa o outro lado que estou digitando (throttled 2s, como o
                // desktop) — sem isto o indicador mobile nunca apareceria
                notifyTyping(v)
              }}
              onKeyDown={e => {
                // navegação do autocompletar tem prioridade sobre o envio
                if (autocompleteItems.length > 0) {
                  if (e.key === 'ArrowDown') { e.preventDefault(); setAutocompleteIdx(i => Math.min(i + 1, autocompleteItems.length - 1)); return }
                  if (e.key === 'ArrowUp') { e.preventDefault(); setAutocompleteIdx(i => Math.max(i - 1, 0)); return }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    applyAutocompleteMobile(autocompleteItems[autocompleteIdx] ?? autocompleteItems[0]!)
                    return
                  }
                  if (e.key === 'Escape') { e.preventDefault(); setActiveAutocomplete(null); return }
                }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
              placeholder={isChannel ? `Conversar em #${channelName}` : `Conversar com ${peerTitle || 'amigo'}`}
              aria-label="Mensagem"
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: t.text, fontSize: 15, fontFamily: 'Inter, sans-serif', resize: 'none', maxHeight: 140, lineHeight: 1.4 }}
            />
            <button aria-label="Emoji" onClick={() => setComposerEmoji((v) => !v)} style={{ background: 'transparent', border: 'none', color: composerEmoji ? t.accent : t.muted, display: 'flex', flexShrink: 0, cursor: 'pointer', padding: 2 }}><Icon d={Icons.smile} size={18} /></button>
            <button onClick={send} disabled={!input.trim()} aria-label="Enviar"
              style={{ background: input.trim() ? t.accent : 'transparent', color: input.trim() ? '#fff' : t.muted, border: 'none', borderRadius: 8, padding: '6px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: !input.trim() ? 'default' : 'pointer', opacity: !input.trim() ? 0.45 : 1 }}>
              <Icon d={Icons.send} size={16} />
            </button>
          </div>
          <div style={{ fontSize: 10, color: t.muted, marginTop: 6, textAlign: 'center', opacity: 0.7 }}>Enter envia • Shift+Enter quebra linha • offline: pendente → enviado → entregue</div>
        </div>

        {renderMobileSheets()}
      </div>
    )
  }

  // ---- shell principal ----
  return (
    <div className="m-root" style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: t.main, color: t.text, fontFamily: 'Inter', overflow: 'hidden', position: 'relative' } as any}>

      {/* header — fundo sidebar, título bold, pill de rede do desktop, avatar 32px */}
      <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, paddingBottom: 0, paddingTop: 'env(safe-area-inset-top)', background: t.sidebar, borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <button aria-label="Menu" className="m-iconbtn" onClick={() => setShowDrawer(v => !v)}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><span style={{ width: 16, height: 2, background: 'currentColor', borderRadius: 99 }} /><span style={{ width: 16, height: 2, background: 'currentColor', borderRadius: 99 }} /><span style={{ width: 10, height: 2, background: 'currentColor', borderRadius: 99 }} /></span>
        </button>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: t.heading, whiteSpace: 'nowrap' }}>DisTorrent</span>
          <span className="m-pill">
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: pillColor, boxShadow: netOnline && nativeKind ? `0 0 6px ${t.green}` : 'none', flexShrink: 0 }} />
            {pillLabel}{status && status.online_peers > 0 ? ` • ${status.online_peers}` : ''}
          </span>
        </div>
        {identity && (
          <button aria-label="Você" onClick={() => setTab('profile')} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}>
            <Avatar
              name={identity.nickname}
              fp={identity.fingerprint}
              size={32}
              avatarB64={profilesByFp[identity.fingerprint]?.avatar_b64}
            />
          </button>
        )}
      </div>

      {/* drawer */}
      {showDrawer && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(0,0,0,.5)', display: 'flex' }} onClick={() => setShowDrawer(false)}>
          <div style={{ width: 280, maxWidth: '84vw', background: t.sidebar, borderRight: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${t.border}`, paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
              {identity && <Avatar
                name={profilesByFp[identity.fingerprint]?.display_name || identity.nickname}
                fp={identity.fingerprint}
                size={40}
                avatarB64={profilesByFp[identity.fingerprint]?.avatar_b64}
              />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{identity?.nickname}</div>
                <div style={{ fontSize: 10, color: t.muted, fontFamily: MONO }}>{identity?.fingerprint.slice(0, 14)}</div>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {([
                { id: 'home', label: 'Início', icon: Icons.home },
                { id: 'servers', label: 'Servidores', icon: Icons.server },
                { id: 'chats', label: 'Conversas', icon: Icons.send },
                { id: 'friends', label: 'Amigos', icon: Icons.users },
                { id: 'profile', label: 'Perfil', icon: Icons.settings },
              ] as { id: Tab, label: string, icon: string }[]).map(it => (
                <button key={it.id} className={'nav-row' + (tab === it.id ? ' active' : '')} onClick={() => { setTab(it.id); setShowDrawer(false) }}>
                  <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={it.icon} size={17} /></span>{it.label}
                </button>
              ))}
              <div style={{ height: 1, background: t.border, margin: '10px 0' }} />
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: t.muted, padding: '4px 8px' }}>REDE</div>
              <div style={{ fontSize: 12, color: t.muted, padding: '4px 8px' }}>{peers.length} peers • {communities.length} servidores</div>
              <button className="link-btn" style={{ fontSize: 13, padding: '6px 8px', textAlign: 'left' }} onClick={() => { setShowDrawer(false); setInviteInput(''); setShowInvite(true) }}>Entrar com convite</button>
            </div>
            <div style={{ padding: 10, background: t.footer, borderTop: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: pillColor, flexShrink: 0 }} />
              <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: t.muted }}>{pillLabel}</span>
            </div>
          </div>
        </div>
      )}

      {/* busca */}
      <div style={{ padding: '8px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px' }}>
          <span style={{ color: t.muted, display: 'flex', flexShrink: 0 }}><Icon d={Icons.search} size={15} /></span>
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder={tab === 'servers' ? 'Buscar servidores…' : tab === 'chats' ? 'Buscar conversas…' : 'Buscar…'} style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: t.text, fontSize: 14 }} />
          {searchQ && <button aria-label="Limpar" onClick={() => setSearchQ('')} style={{ color: t.muted, background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}>x</button>}
        </div>
      </div>

      {/* banners de erro/aviso */}
      {error && (
        <div className="m-err" style={{ margin: '0 12px 8px', flexShrink: 0 }}>
          {error}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#ff9c9c', cursor: 'pointer' }}>x</button>
        </div>
      )}
      {notice && <div className="m-ok" style={{ margin: '0 12px 8px', flexShrink: 0 }}>{notice}</div>}

      {/* conteúdo */}
      <div className="hide-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '0 12px', paddingBottom: 'calc(76px + env(safe-area-inset-bottom))' }}>

        {tab === 'home' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 8, padding: '12px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: pillColor, boxShadow: netOnline && nativeKind ? `0 0 6px ${t.green}` : 'none', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: t.heading }}>{netState ? stateLabel[netState as NetworkState] : 'INICIANDO…'}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>{onlineFriends.length} amigos online{status && status.listen_port > 0 ? ` • porta ${status.listen_port}` : ''}</div>
            </div>
            <span style={{ fontSize: 10, color: t.muted, fontFamily: MONO, flexShrink: 0 }}>{identity?.fingerprint.slice(0, 8)}</span>
          </div>

          <div className="m-sec">AMIGOS ONLINE — {onlineFriends.length}</div>
          {onlineFriends.length === 0
            ? <EmptyBlock msg="Ninguém online agora — é silencioso demais aqui." sub={<span>Um amigo que trabalha em equipe é uma coisa boa — <button className="link-btn" onClick={() => setFriendsTab('adicionar')}>adicione alguém!</button></span>} />
            : <div style={{ display: 'flex', flexDirection: 'column' }}>{onlineFriends.map(f => <FriendRow key={f.fp} f={f} online={onlineFps.has(f.fp)} onOpen={openDm} onRemove={removeFriend} onBlock={blockFriend} />)}</div>}

          <div className="m-sec">CONVERSAS RECENTES</div>
          {filteredConvs.length === 0
            ? <EmptyBlock msg="Nenhuma conversa" sub="Adicione amigos e comece a conversar." />
            : <div style={{ display: 'flex', flexDirection: 'column' }}>{filteredConvs.slice(0, 5).map(c => <ConvRow key={c.id} c={c} online={onlineFps.has(c.peer_fp)} selected={selConv === c.id} onOpen={openConv} onDelete={deleteConv} />)}</div>}

          <div className="m-sec">SEUS SERVIDORES — {filteredComms.length}</div>
          {filteredComms.length === 0
            ? <EmptyBlock msg="Nenhum servidor ainda" sub={<span>Tem um convite de amigo? <button className="link-btn" onClick={() => { setInviteInput(''); setShowInvite(true) }}>Entrar com convite</button></span>} />
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{filteredComms.map(c => <ServerRow key={c.id} c={c} active={selCommunity === c.id} onSelect={setSelCommunity} />)}</div>}
        </>}

        {tab === 'servers' && (() => {
          // RESUMO por servidor com base no pareamento REAL (não em
          // `c.members.length`, que é o roster sincronizado e não diz quem
          // está online). Só o servidor aberto tem `memberPairing` carregado;
          // os demais mostram o roster como total e 0 pareados até serem
          // abertos — o que é honesto.
          const summaries: ServerSummary[] = filteredComms.map((c) => {
            const st = c.id === selCommunity ? memberPairing : []
            const s = summarize(st)
            return {
              community: c,
              online: s.online,
              total: s.total > 0 ? s.total : c.members.length,
              pending: s.pending,
            }
          })
          return (
            <>
              {/* MOBILE É INVITE-ONLY. Criar servidor exige o assistente
                  completo (canais/cargos/regras), que só existe no desktop —
                  esconder o botão sem esconder a rota era o bug anterior. */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button
                  onClick={() => { setInviteInput(''); setShowInvite(true) }}
                  aria-label="Entrar em servidor com convite"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, background: t.accent, border: 'none', color: '#fff', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', fontSize: 13, fontWeight: 800 }}
                >
                  <span style={{ display: 'inline-flex', flexShrink: 0 }}><Icon d={Icons.plus} size={16} /></span>
                  Entrar com convite
                </button>
                {activeComm && (
                  <button
                    onClick={() => setShowServerDetails((v) => !v)}
                    aria-label="Detalhes e membros do servidor"
                    aria-expanded={showServerDetails}
                    style={{ width: 42, flexShrink: 0, background: showServerDetails ? t.hover : t.input, border: `1px solid ${t.border}`, color: t.text, borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon d={Icons.users} size={17} />
                  </button>
                )}
              </div>
              <div style={{ fontSize: 11, color: t.muted, marginBottom: 10, lineHeight: 1.5 }}>
                No celular você entra por convite. Para criar um servidor, use o app no PC.
              </div>

              {summaries.length === 0
                ? <EmptyBlock msg="Nenhum servidor ainda" sub={<span>Tem um convite de amigo? <button className="link-btn" onClick={() => { setInviteInput(''); setShowInvite(true) }}>Entrar com convite</button></span>} />
                : (
                  <ServerList
                    servers={summaries}
                    selectedId={selCommunity}
                    onSelect={(id) => { setSelCommunity(id); setShowServerDetails(false) }}
                    emptyHint="Nenhum servidor ainda."
                  />
                )}

              {activeComm && showServerDetails && (
                <div style={{ marginTop: 12, padding: 12, background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 10 }}>
                  <div className="m-sec" style={{ marginTop: 0 }}>MEMBROS — pareamento</div>
                  <MemberPairingList
                    members={memberPairing}
                    emptyHint="Nenhum membro sincronizado. Se você acabou de entrar, aguarde a confirmação do dono."
                  />
                  <div style={{ marginTop: 14 }}>
                    <div className="m-sec" style={{ marginTop: 0 }}>CONVITE</div>
                    <InvitePanel
                      communityId={activeComm.id}
                      canCreateInvite={activeComm.is_owner === true}
                      onError={(msg) => setError(msg)}
                    />
                  </div>
                </div>
              )}

              {activeComm && (() => {
                const c = activeComm
                return <>
                  <div className="m-sec">CANAIS</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    {c.channels.map(([id, name]) => (
                      <button key={id} className={'chan-row' + (selConv === id ? ' active' : '')} onClick={() => setSelConv(id)}>
                        <span style={{ display: 'flex', flexShrink: 0, opacity: 0.7 }}><Icon d={Icons.hash} size={16} /></span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>{name}</span>
                      </button>
                    ))}
                  </div>
                </>
              })()}
            </>
          )
        })()}

        {tab === 'chats' && <>
          <div className="m-sec">CONVERSAS DIRETAS — {filteredConvs.length}</div>
          {filteredConvs.length === 0
            ? <EmptyBlock msg="Nenhuma conversa" sub={<span>Adicione amigos em <button className="link-btn" onClick={() => setTab('friends')}>Amigos</button> e comece a conversar.</span>} />
            : <div style={{ display: 'flex', flexDirection: 'column' }}>{filteredConvs.map(c => <ConvRow key={c.id} c={c} online={onlineFps.has(c.peer_fp)} selected={selConv === c.id} onOpen={openConv} onDelete={deleteConv} />)}</div>}
        </>}

        {tab === 'friends' && <>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '12px 0 8px' }}>
            {([['online', 'Online'], ['todos', 'Todos'], ['pendentes', 'Pendentes'], ['bloqueados', 'Bloqueados']] as const).map(([id, label]) => (
              <button key={id} className={'m-tab' + (friendsTab === id ? ' on' : '')} onClick={() => setFriendsTab(id)}>
                {label}
                {id === 'pendentes' && friendRequests.length > 0 && <span className="m-badge">{friendRequests.length}</span>}
                {id === 'bloqueados' && friendsBlocked.length > 0 && <span className="m-badge">{friendsBlocked.length}</span>}
              </button>
            ))}
            <button className={'m-tab add' + (friendsTab === 'adicionar' ? ' on' : '')} onClick={() => setFriendsTab('adicionar')}>Adicionar amigo</button>
          </div>

          {friendsTab === 'adicionar' ? (
            <div style={{ padding: '8px 4px' }}>
              <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: t.heading }}>ADICIONAR AMIGO</div>
              <div style={{ fontSize: 13, color: t.muted, marginTop: 8, lineHeight: 1.6 }}>
                Adicione pelo fingerprint (12 caracteres). O seu é{' '}
                <button className="fp-copy" onClick={copyMyFp} title="Copiar seu fingerprint">{identity?.fingerprint}</button>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'stretch' }}>
                <input
                  ref={friendInputRef}
                  className="m-input mono"
                  style={{ flex: 1, minWidth: 0, borderColor: friendErr ? t.red : undefined }}
                  value={friendFpInput}
                  inputMode="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  enterKeyHint="send"
                  onChange={e => { setFriendFpInput(e.target.value); setFriendErr(null) }}
                  onKeyDown={e => e.key === 'Enter' && addFriend()}
                  placeholder="Ex.: a1b2c3d4e5f6"
                />
                <button className="m-btn" style={{ background: t.hover, color: t.text, whiteSpace: 'nowrap' }} onClick={pasteFp} title="Colar da área de transferência">Colar</button>
              </div>
              <button
                className="m-btn"
                style={{ background: t.green, width: '100%', marginTop: 10, opacity: FP_RE.test(friendFpInput.trim().toLowerCase()) && !addingFriend ? 1 : 0.5 }}
                disabled={!FP_RE.test(friendFpInput.trim().toLowerCase()) || addingFriend}
                onClick={addFriend}
              >{addingFriend ? 'Enviando…' : 'Enviar solicitação'}</button>
              {friendErr && <div style={{ marginTop: 10, color: t.red, fontSize: 12, lineHeight: 1.5 }}>{friendErr}</div>}
              {friendSuccess && <div className="m-ok" style={{ marginTop: 12 }}>{friendSuccess}</div>}
              {pendingOut.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: t.muted, marginBottom: 8 }}>ENVIADAS ({pendingOut.length}) — aguardando</div>
                  {pendingOut.map(r => (
                    <div key={r.fp} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, marginBottom: 6 }}>
                      <Avatar name={r.nickname || r.fp} fp={r.fp} size={28} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nickname || r.fp}</div>
                        <div style={{ fontSize: 10, color: t.muted, fontFamily: MONO }}>{r.fp.slice(0, 12)} · aguardando</div>
                      </div>
                      <button className="m-btn" style={{ background: t.hover, color: t.text, fontSize: 11, padding: '5px 9px', whiteSpace: 'nowrap' }} onClick={() => { void retryFriendReq(r.fp) }}>Reenviar</button>
                      <button className="m-btn" style={{ background: 'transparent', color: t.red, border: `1px solid ${t.red}`, fontSize: 11, padding: '5px 9px', whiteSpace: 'nowrap' }} onClick={() => { void cancelFriendReq(r.fp) }}>Cancelar</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : friendsTab === 'pendentes' ? (
            friendRequests.length === 0 ? (
              <EmptyBlock msg="Não há solicitações pendentes. Que pena." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {friendRequests.map(r => (
                  <div key={r.fp} className="friend-row">
                    <Avatar name={r.nickname || r.fp} fp={r.fp} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nickname || r.fp}</div>
                      <div style={{ fontSize: 11, color: t.muted }}>Solicitação de amizade recebida</div>
                    </div>
                    <button title="Aceitar" aria-label="Aceitar" className="row-icon ok" onClick={() => respond(r.fp, true)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 7"/></svg></button>
                    <button title="Recusar" aria-label="Recusar" className="row-icon no" onClick={() => respond(r.fp, false)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12 M18 6L6 18"/></svg></button>
                  </div>
                ))}
              </div>
            )
          ) : friendsTab === 'bloqueados' ? (
            friendsBlocked.length === 0 ? (
              <EmptyBlock msg="Ninguém bloqueado." />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {friendsBlocked.map(f => (
                  <div key={f.fp} className="friend-row">
                    <Avatar name={f.nickname || f.fp} fp={f.fp} size={32} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nickname || f.fp}</div>
                      <div style={{ fontSize: 11, color: t.muted, fontFamily: MONO }}>{f.fp.slice(0, 12)} · não consegue te achar</div>
                    </div>
                    <button title="Desbloquear" aria-label="Desbloquear" className="row-icon ok" onClick={async () => { try { await services.friendUnblock(f.fp); refreshFriends() } catch (err: any) { setError(String(err?.message ?? err)) } }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M4 12l5 5L20 7" /></svg></button>
                  </div>
                ))}
              </div>
            )
          ) : shownFriends.length === 0 ? (
            <EmptyBlock msg={friendsTab === 'online' ? 'Ninguém online agora — é silencioso demais aqui.' : 'Que silêncio por aqui...'} sub={<span>Um amigo que trabalha em equipe é uma coisa boa — <button className="link-btn" onClick={() => setFriendsTab('adicionar')}>adicione alguém!</button></span>} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>{shownFriends.map(f => <FriendRow key={f.fp} f={f} online={onlineFps.has(f.fp)} onOpen={openDm} onRemove={removeFriend} onBlock={blockFriend} />)}</div>
          )}
        </>}

        {tab === 'profile' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 4px 8px' }}>
            {identity && <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Avatar
                name={profilesByFp[identity.fingerprint]?.display_name || identity.nickname}
                fp={identity.fingerprint}
                size={64}
                avatarB64={profilesByFp[identity.fingerprint]?.avatar_b64}
                accent={profilesByFp[identity.fingerprint]?.accent || undefined}
              />
              <PeerDot on={myPresence !== 'offline' && myPresence !== 'invisible'} ring={t.sidebar} />
            </span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 900, color: profilesByFp[identity?.fingerprint ?? '']?.accent || t.heading }}>{profilesByFp[identity?.fingerprint ?? '']?.display_name || identity?.nickname}</div>
              <div style={{ fontSize: 11, color: t.muted, fontFamily: MONO, wordBreak: 'break-all', marginTop: 2 }}>{identity?.fingerprint}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 6 }}>{friendsAccepted.length} amigos • {communities.length} servidores • {status?.online_peers ?? 0} online</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
            <button className="nav-row" onClick={() => { services.privacyGet().then(s => setPrivacyMode(s.mode)).catch(() => {}); setProxyPendingMode(null); void refreshPrivacyExtras(privacyMode); setShowPrivacy(true) }}>
              <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.settings} size={17} /></span>
              Privacidade
              <span style={{ marginLeft: 'auto', fontSize: 11, color: t.muted }}>{privacyLabel}</span>
            </button>
            <button className="nav-row" onClick={() => setShowDiagnostics(true)}>
              <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.search} size={17} /></span>
              Diagnóstico de conexão
              <span style={{ marginLeft: 'auto', fontSize: 11, color: t.muted }}>relay • peers • relatório</span>
            </button>
            <button className="nav-row" onClick={copyMyFp}>
              <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.copy} size={17} /></span>
              Copiar fingerprint
            </button>
            <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 14, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>CHAMADAS — QUALIDADE E TURN</div>
              <label htmlFor="m-quality-pref" style={{ display: 'block', fontSize: 11, fontWeight: 700, color: t.muted, marginBottom: 6 }}>Qualidade preferida</label>
              <select id="m-quality-pref" aria-label="Qualidade preferida das chamadas" value={callQuality} onChange={e => changeQuality(e.target.value as CallQuality)} className="m-input" style={{ marginBottom: 8 }}>
                <option value="480p">480p — economiza banda</option>
                <option value="720p">720p — equilibrado</option>
                <option value="1080p">1080p — alta definição</option>
                <option value="4K">4K — máxima (rede boa)</option>
              </select>
              {qualityError && <div className="m-err" style={{ marginBottom: 8 }}>{qualityError}</div>}
              <label htmlFor="m-turn-url" style={{ display: 'block', fontSize: 11, fontWeight: 700, color: t.muted, marginBottom: 6 }}>TURN URL (opcional — relay próprio)</label>
              {!hasRelayConfigured([{ urls: turnInput } as any]) && (
                <div role="status" style={{ fontSize: 11, color: t.yellow, marginBottom: 8, lineHeight: 1.5 }}>P2P puro: sem relay — fora da LAN pode falhar em NAT restritivo/4G.</div>
              )}
              <input id="m-turn-url" className="m-input mono" value={turnInput} onChange={e => { setTurnInput(e.target.value); setTurnMsg(null) }} placeholder="turn:seu-vps:3478" autoCapitalize="none" spellCheck={false} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="m-btn" style={{ flex: 1 }} onClick={saveTurnUrl}>Salvar TURN</button>
              </div>
              {turnMsg && <div className={turnMsg.startsWith('formato') ? 'm-err' : 'm-ok'} style={{ marginTop: 8 }}>{turnMsg}</div>}
              <div style={{ fontSize: 11, color: t.muted, marginTop: 8, lineHeight: 1.5 }}>Formato <span className="m-fp">turn:host:porta</span> • salvo em <span className="m-fp">distorrent:turn_url</span>.</div>
            </div>
            <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 14, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>MICROFONE</div>
              <VoiceDeviceSettings T={t} inputBg={t.input} borderColor={t.border} text={t.text} muted={t.muted} />
            </div>
            <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 14, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>NOTIFICAÇÕES</div>
              <SystemNotificationSettings T={t} inputBg={t.input} borderColor={t.border} text={t.text} muted={t.muted} />
              <div style={{ height: 12 }} />
              <NotificationSettings
                servers={communities.map(c => ({ id: c.id, name: c.name }))}
                channelsOf={(sid) => (communities.find(c => c.id === sid)?.channels ?? []).map(([id, name]) => ({ id, name }))}
                T={t} inputBg={t.input} borderColor={t.border} text={t.text} muted={t.muted}
              />
            </div>
            <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 14, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>APARÊNCIA</div>
              <AppearanceSettings T={t} inputBg={t.input} borderColor={t.border} text={t.text} muted={t.muted} hideTheme />
            </div>
            <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 14, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>COFRE &amp; BACKUP</div>
              <StormVaultPanel />
            </div>
            <button className="nav-row" style={{ color: t.red }} onClick={() => { setPhase('lock'); setIdentity(null as any); setSelConv(null); setSelPeerFp(null); setSelCommunity(null) }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Sair
            </button>
          </div>
          <div style={{ textAlign: 'center', marginTop: 18, fontSize: 11, color: t.muted, opacity: 0.8, paddingBottom: 8 }}>DisTorrent P2P • E2E{version ? ` • v${version}` : ''} • sem servidor</div>
        </>}

      </div>

      {showDiagnostics && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={() => setShowDiagnostics(false)}>
          <div style={{ width: '100%', maxWidth: 460, maxHeight: '88dvh', overflowY: 'auto', background: t.sidebar, borderTop: `1px solid ${t.border}`, borderRadius: '12px 12px 0 0', padding: '12px 14px calc(16px + env(safe-area-inset-bottom))' }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, borderRadius: 99, background: t.border, margin: '0 auto 12px' }} />
            <ConnectionDiagnostics onClose={() => setShowDiagnostics(false)} />
            <button className="m-btn ghost" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowDiagnostics(false)}>Fechar</button>
          </div>
        </div>
      )}

      {/* painel de privacidade — PRIVACY_MODES + privacyGet/privacySet (opções flat com radio, igual desktop) */}
      <ScreenSharePicker open={showScreenPicker} onClose={() => setShowScreenPicker(false)} onError={setError} />

      {showPrivacy && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }} onClick={closePrivacy}>
          <div style={{ width: '100%', maxWidth: 460, maxHeight: '80dvh', overflowY: 'auto', background: t.sidebar, borderTop: `1px solid ${t.border}`, borderRadius: '12px 12px 0 0', padding: '12px 14px calc(16px + env(safe-area-inset-bottom))' }} onClick={e => e.stopPropagation()}>
            <div style={{ width: 36, height: 4, borderRadius: 99, background: t.border, margin: '0 auto 12px' }} />
            <div style={{ fontWeight: 800, fontSize: 15, color: t.heading, marginBottom: 4 }}>Privacidade</div>
            <div style={{ fontSize: 12, color: t.muted, marginBottom: 12, lineHeight: 1.5 }}>Escolha como suas mensagens trafegam. Aplicado no motor em tempo real.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {PRIVACY_MODES.map(pm => {
                const active = privacyMode === pm.mode
                return (
                  <label key={pm.mode} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: active ? `${t.accent}14` : t.input, border: `1px solid ${active ? t.accent : t.border}`, borderRadius: 10, padding: '10px 12px', cursor: 'pointer' }}
                    onClick={() => pickPrivacyMode(pm.mode)}>
                    <input type="radio" checked={active} readOnly style={{ accentColor: t.accent, marginTop: 2 }} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: t.text }}>{pm.label}</div>
                      <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>{pm.description}</div>
                    </div>
                  </label>
                )
              })}
            </div>

            {/* Estado do proxy â€” sempre visÃ­vel, honesto: EFETIVO, nÃ£o sÃ³ o escolhido */}
            <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: t.muted }}>
                {(privacyMode === 'proxy' || privacyMode === 'full') ? (privacyProxyEffective ? 'PROXY: ATIVADO (efetivo)' : 'PROXY: OFFLINE â€” relay desligado (fail-closed)') : 'Proxy: Desativado'}
              </div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>
                {(privacyMode === 'proxy' || privacyMode === 'full')
                  ? (privacyProxyEffective
                      ? `relay saindo por ${proxyAddr || 'â€”'} (SOCKS5 â€” sem ntfy, sem HTTP externo)`
                      : 'o proxy nÃ£o respondeu ou Ã© invÃ¡lido: o relay fica DESLIGADO atÃ© ele voltar (fail-closed, sem fallback direto)')
                  : 'nenhuma conexÃ£o passa por proxy â€” relay MQTT direto dos brokers pÃºblicos'}
              </div>
            </div>

             {/* proxy flow: IP + test online + save */}
            {proxyPendingMode && (
              <div style={{ background: t.input, border: `1px solid ${t.accent}66`, borderRadius: 10, padding: '12px', marginBottom: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: t.heading, marginBottom: 6 }}>
                  {proxyPendingMode === 'full' ? 'Tor — proxy da rede Tor' : 'Proxy — endereço SOCKS5'}
                </div>
                <div style={{ fontSize: 11, color: t.muted, marginBottom: 8, lineHeight: 1.5 }}>
                  {proxyPendingMode === 'full'
                    ? 'Padrão 127.0.0.1:9050 (Tor daemon local). O relay sai pelos circuitos Tor.'
                    : 'Digite o IP:porta do seu proxy SOCKS5. O relay (mensagens, amigos, arquivos) sai só por ele.'}
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <input
                    value={proxyAddr}
                    onChange={e => { setProxyAddr(e.target.value); setProxyTestOk(null); setProxyTestErr(null) }}
                    placeholder={proxyPendingMode === 'full' ? '127.0.0.1:9050' : 'ex.: 127.0.0.1:1080'}
                    spellCheck={false}
                    autoCapitalize="none"
                    style={{ flex: 1, background: '#1e1f22', border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 12px', color: t.text, fontFamily: 'JetBrains Mono', fontSize: 13 }}
                  />
                  <button onClick={runProxyTest} disabled={proxyTesting || !proxyAddr.trim()}
                    style={{ background: t.accent, color: '#fff', border: 'none', padding: '0 14px', borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' }}>
                    {proxyTesting ? 'testando…' : 'Testar online'}
                  </button>
                </div>
                {proxyTesting && <div style={{ fontSize: 11, color: t.yellow, marginBottom: 6 }}>abrindo circuito pelos brokers MQTT via proxy…</div>}
                {proxyTestOk != null && (
                  <div style={{ fontSize: 11, color: '#8cf5b8', background: '#1a3329', border: `1px solid ${t.green}55`, borderRadius: 8, padding: '6px 10px', marginBottom: 8 }}>
                    proxy OK — circuito aberto em {proxyTestOk} ms
                  </div>
                )}
                {proxyTestErr && (
                  <div style={{ fontSize: 11, color: '#ff9c9c', background: '#2a1518', border: `1px solid ${t.red}55`, borderRadius: 8, padding: '6px 10px', marginBottom: 8 }}>
                    {proxyTestErr}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="m-btn ghost" style={{ flex: 1 }} onClick={() => { setProxyPendingMode(null); setProxyTestOk(null); setProxyTestErr(null) }}>Cancelar</button>
                  <button onClick={() => saveProxyAndActivate(proxyPendingMode)} disabled={!proxyAddr.trim()}
                    style={{ flex: 1, background: proxyTestOk != null ? t.green : '#3a3a3c', color: '#fff', border: 'none', padding: 10, borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 12 }}>
                    {proxyTestOk != null ? 'Ativar proxy' : 'Ativar sem teste'}
                  </button>
                </div>
                {proxyIsDefault && <div style={{ fontSize: 10, color: t.muted, marginTop: 6 }}>endereço padrão — edite se o seu proxy estiver noutra porta</div>}
              </div>
            )}
            <button className="m-btn ghost" style={{ width: '100%' }} onClick={closePrivacy}>Fechar</button>
          </div>
        </div>
      )}

      {/* modal de convite público — token pré-preenchido via ?invite=TOKEN */}
      {/* SEM modal de criação no mobile: invite-only por decisão de UX. */}

      {showInvite && (
        <div className="m-overlay" onClick={() => setShowInvite(false)}>
          <div className="m-modal" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <h3 style={{ fontWeight: 800, color: t.heading, margin: 0, flex: 1, fontSize: 18 }}>Entrar com convite</h3>
              <button aria-label="Fechar" onClick={() => setShowInvite(false)} style={{ background: 'transparent', border: 'none', color: t.muted, cursor: 'pointer', fontSize: 16 }}>x</button>
            </div>
            <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.5, marginBottom: 4 }}>
              Cole o token que você recebeu. Ele funciona em qualquer aparelho — o link é só um atalho.
            </div>
            {/* O campo/colar/validação vêm do MESMO componente do desktop: um
                caminho só, com botão de colar de verdade e mensagens claras. */}
            <JoinServerForm
              autoToken={inviteInput || null}
              compact
              onJoined={async (id) => {
                setShowInvite(false)
                setInviteInput('')
                await refreshCommunities()
                setSelCommunity(id)
                setSelConv(null)
                setSelPeerFp(null)
                setTab('servers')
              }}
            />
            <button className="m-btn ghost" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowInvite(false)}>Cancelar</button>
          </div>
        </div>
      )}

      {renderIncomingModal()}

      {/* bottom nav — 5 itens, fundo rail, ativo heading, inativo muted, badges vermelhas */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: t.rail, borderTop: `1px solid ${t.border}`, display: 'flex', padding: '6px 0 calc(6px + env(safe-area-inset-bottom))', zIndex: 10 }}>
        {([
          { id: 'home', label: 'Início', icon: Icons.home },
          { id: 'servers', label: 'Servidores', icon: Icons.server },
          { id: 'chats', label: 'Chats', icon: Icons.send, badge: unreadTotal },
          { id: 'friends', label: 'Amigos', icon: Icons.users, badge: friendRequests.length },
          { id: 'profile', label: 'Você', icon: Icons.settings },
        ] as { id: Tab, label: string, icon: string, badge?: number }[]).map(it => {
          const active = tab === it.id
          const badge = it.badge ?? 0
          return (
            <button key={it.id} onClick={() => setTab(it.id)} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, background: 'transparent', border: 'none', color: active ? t.heading : t.muted, padding: '5px 0', cursor: 'pointer', position: 'relative' }}>
              <span style={{ position: 'relative', display: 'flex' }}>
                <Icon d={it.icon} size={19} />
                {badge > 0 && (
                  <span style={{ position: 'absolute', top: -5, right: -7, minWidth: 15, height: 15, borderRadius: 99, background: t.red, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px', border: `2px solid ${t.rail}` }}>
                    {badge > 9 ? '9+' : badge}
                  </span>
                )}
              </span>
              <span style={{ fontSize: 10, fontWeight: active ? 700 : 500 }}>{it.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
