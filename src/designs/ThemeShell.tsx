import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { Icon, Icons } from '../shared/icons'
import { activeToken, applyFormat } from '../shared/markdown'
import { NAMED_EMOJI } from '../shared/emojiSet'
import { EmojiPicker } from '../shared/EmojiPicker'
import MessageList, { type MessageListHandle } from '../components/social/MessageList'
import { BookmarksPanel, ChannelSettingsModal, CommandPalette, EventPanel, InboxPanel, ModerationPanel, PinsPanel, ProfileModal, SearchPanel, ThreadList, ThreadViewModal, useShortcuts, type Command, type InboxTab } from '../components/social/Social'
import { services } from '../services'
import type { Identity, NetworkState, PeerView, CommunityView, PrivacyMode, RoleView, BotView, ChannelMeta, StoredMessage, MemberPairing } from '../services/models'
import { PRIVACY_MODES } from '../services/models'
import {
  useConversations,
  useEngineEvents,
  useMessages,
  useNetwork,
  useIdentity as useIdentityBase,
} from '../app/hooks'
import ConnectionDiagnostics from '../components/ConnectionDiagnostics'
import CallDiagnostics from '../components/CallDiagnostics'
import CallTileComponent from '../components/calls/CallTile'
import ScreenStage from '../components/calls/ScreenStage'
import { ChannelVoicePeers } from '../components/calls/ChannelVoicePeers'
import { buildCallTiles, sortTilesForPin } from '../services/callTiles'
import ScreenSharePicker from '../components/ScreenSharePicker'
import DownloadsPanel from '../components/DownloadsPanel'
import { FileCard } from '../components/FileCard'
import CreateServerWizard from '../components/CreateServerWizard'
import BotConfigPanel from '../components/BotConfigPanel'
import { UpdateOverlay, useUpdateGate } from '../components/UpdateGate'
import { UpdateBootScreen } from '../components/UpdateBootScreen'
import ServerSettings from '../components/server/ServerSettings'
import {
  ServerHubModal,
  InvitePanel,
  summarize,
  type ServerSummary,
} from '../components/server/ServerHub'
import { consumeInvite, peekInvite, subscribeInvite } from '../services/deepLink'
import { Modal, Notice } from '../shared/ui'
import { WIDTHS } from '../shared/ui'
import { GroupPanel } from '../components/social/GroupPanel'
import { copyText } from '../shared/clipboard'
import { mergeChannels } from '../app/channels'
import CallPhaseBadge from '../components/CallPhaseBadge'
import { downloadManager } from '../services/downloadManager'
import { startDownload } from '../services/downloadAction'
import { botRuntime } from '../services/botRuntime'
import { StormVaultPanel } from '../components/vault/StormVaultPanel'
import { MetricsPanel } from '../components/dev/MetricsPanel'
import { callManager, setCallIdentity, supportsScreenShare, diagnoseCallsSupport, detectNativeVoice, getCallsSupport, getCallsUnavailableMessage, hasRelayConfigured, CALLS_UNAVAILABLE_MSG, SCREEN_UNAVAILABLE_MSG, screenShareUnavailableReason, ICE_RELAY_MSG, ICE_FAILED_MSG, getStoredQuality, getTurnUrl, isValidTurnUrl, setCallPrivacyForIce, type CallQuality, type IncomingCall } from '../services/callManager'
import { fileSwarm, encodeFileBody, parseFileBody } from '../services/fileSwarm'
import { isMediaName } from '../services/fileRules'
import { sfxMessage, sfxRingStart, sfxRingStop, sfxCallConnect, sfxCallEnd } from '../services/sfx'
import { throttleTrailing } from '../shared/perf'
import { addFolder, folderOf, isMutedServer, moveServerToFolder, removeFolder, renameFolder, shouldNotify, toggleMuteChannel, toggleMuteServer, usePrefs } from '../shared/prefs'
import { AppearanceSettings } from '../components/prefs/AppearanceSettings'
import { NotificationSettings } from '../components/prefs/NotificationSettings'
import { SystemNotificationSettings } from '../components/prefs/SystemNotificationSettings'
import {
  notifyMessage, notifyIncomingCall, endCallNotice, markCallHandled,
  setOpenConversation, onOpenConversation, onCallNotificationAction, registerConversationPeer,
} from '../services/notifications'
import { setDesiredPresence } from '../services/appState'
import { VoiceDeviceSettings } from '../components/prefs/VoiceDeviceSettings'

// DisTorrent — visual Discord original. Dados 100% reais do motor (distorrent-core).
// Fluxo: criar conta (nome + senha opcional) → desbloqueio por senha a cada abertura.

const t = {
  rail: '#1e1f22', sidebar: '#2b2d31', main: '#313338', composer: '#383a40',
  input: '#1e1f22', hover: '#35373c', selected: '#404249', border: '#26272b',
  panel: '#2b2d31', footer: '#232428',
  accent: '#5865f2', accentHover: '#4752c4', link: '#00a8fc',
  green: '#23a559', yellow: '#f0b232', red: '#f23f42',
  text: '#dbdee1', heading: '#f2f3f5', muted: '#949ba4',
  lbg: '#ffffff', lsidebar: '#f2f3f5', lrail: '#e3e5e8', ltext: '#060607',
  lmuted: '#5c5e66', lborder: '#e3e5e8', linput: '#ebedef',
}

const stateColor: Record<NetworkState, string> = {
  CONNECTED: t.green, CONNECTING: t.yellow, RECONNECTING: t.yellow, DISCONNECTED: '#80848e',
}
const stateLabel: Record<NetworkState, string> = {
  CONNECTED: 'CONECTADO', CONNECTING: 'CONECTANDO', RECONNECTING: 'RECONECTANDO', DISCONNECTED: 'OFFLINE',
}

// Modelos de servidor agora vivem DENTRO do `CreateServerWizard` (é lá que o
// usuário escolhe, com ícone/descrição/canais aplicados de uma vez). A lista
// `SERVER_TEMPLATES`/`pickTemplate` que existia aqui era o resquício do wizard
// legado: nada a consumia e o botão de modelo não fazia o que prometia.


function avatarColor(fp: string): string {
  const palette = ['#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e', '#00a8fc']
  let h = 0
  for (let i = 0; i < fp.length; i++) h = (h * 31 + fp.charCodeAt(i)) >>> 0
  return palette[h % palette.length]
}


function Avatar({ name, fp, size, avatarB64, accent }: { name: string; fp: string; size: number; avatarB64?: string; accent?: string }) {
  const initial = (name || '?').trim().charAt(0).toUpperCase()
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: accent || avatarColor(fp), color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, fontSize: size * 0.42, flexShrink: 0, overflow: 'hidden', boxShadow: accent ? `0 0 0 2px ${accent}55` : undefined }}>
      {avatarB64
        ? <img src={`data:image/jpeg;base64,${avatarB64}`} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        : initial}
    </span>
  )
}

function PeerDot({ s }: { s: NetworkState }) {
  const c = stateColor[s]
  return <span style={{ position: 'absolute', right: -2, bottom: -2, width: 12, height: 12, background: c, border: '3px solid var(--sidebar)', borderRadius: '50%' }} />
}


// ---------- telas de conta ----------

// Tela de boot. Antes era um `<div>` cinza VAZIO: no desktop o boot mexe em
// keyring do SO + SQLite + listener de rede, e o app ficava parado numa tela
// sem explicação (a usuária chamou de "tela cinza"). Agora tem barra, texto e
// aviso honesto se demorar. Estilo em `src/styles/mobile.css` (.boot*), para
// valer desde o primeiro paint.
function BootScreen(){
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
      </div>
    </div>
  )
}

function AuthCard({ children }: { children: any }) {
  const perks = [
    { icon: Icons.lock, title: 'Cifrado fim-a-fim', desc: 'só os aparelhos leem' },
    { icon: Icons.users, title: 'Sem servidor', desc: 'direto entre peers' },
    { icon: Icons.key, title: 'Sua chave', desc: 'sem conta online' },
  ]
  return (
    <div style={{ minHeight: '100vh', background: t.main, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, fontFamily: 'Inter' }}>
      <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 12, padding: 28, width: 440, boxShadow: '0 8px 32px rgba(0,0,0,.45)' }}>
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: 26, fontWeight: 900, color: t.heading, letterSpacing: 1 }}>DisTorrent</span>
          <div style={{ fontSize: 12, color: t.muted, marginTop: 4 }}>chat, voz e arquivos P2P — sem servidor, sem cadastro</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
          {perks.map(p => (
            <div key={p.title} style={{ flex: 1, background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '9px 6px', textAlign: 'center' }}>
              <span style={{ color: t.accent, display: 'inline-flex' }}><Icon d={p.icon} size={17} /></span>
              <div style={{ fontSize: 11, fontWeight: 800, color: t.heading, marginTop: 5 }}>{p.title}</div>
              <div style={{ fontSize: 10, color: t.muted, marginTop: 2 }}>{p.desc}</div>
            </div>
          ))}
        </div>
        {children}
      </div>
    </div>
  )
}

const inputStyle: any = { width: '100%', background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '11px 12px', color: t.text, fontSize: 14, outline: 'none', boxSizing: 'border-box' }
const btnStyle: any = { width: '100%', background: t.accent, color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 14 }

function CreateAccount({ onDone }: { onDone: (identity: Identity) => void }) {
  const [nick, setNick] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  async function submit() {
    setErr(null)
    if (!nick.trim()) return setErr('escolha seu nome')
    setBusy(true)
    try {
      // 100% sem senha — chave ed25519 é a identidade, sem cofre
      const id = await services.identityCreate(nick.trim(), null)
      onDone(id)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Já tem conta em outro aparelho? Importa direto daqui — sem criar conta
   * nova e sem digitar fingerprint. Escolhe o .stormvault, digita a senha do
   * cofre e o app entra com a identidade que estava no arquivo.
   */
  async function importVault() {
    if (services.kind !== 'native') {
      setErr('importar cofre precisa do app instalado (nativo)')
      return
    }
    const f = await new Promise<File | null>((resolve) => {
      if (!fileRef.current) return resolve(null)
      fileRef.current.onchange = () => resolve(fileRef.current!.files?.[0] ?? null)
      fileRef.current.click()
    })
    if (!f) return
    const pass = prompt(`Senha do cofre ${f.name}:`)
    if (pass == null) return
    setBusy(true); setErr(null)
    try {
      const buf = new Uint8Array(await f.arrayBuffer())
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH))
      const r = await services.stormvaultImportFile(btoa(bin), pass)
      if (r.identity_installed) {
        window.location.reload() // entra no app já com a conta importada
        return
      }
      setErr('o cofre foi mesclado, mas este aparelho já tem outra conta — use "Importar cofre" na tela de entrada.')
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally { setBusy(false) }
  }

  return (
    <AuthCard>
      <div style={{ fontWeight: 800, color: t.heading, fontSize: 16, marginBottom: 4 }}>Criar conta</div>
      <div style={{ fontSize: 12, color: t.muted, marginBottom: 14 }}>Escolha seu nome. Sua chave é gerada neste computador — <b>sem senha</b>, login direto pela chave.</div>
      <input style={inputStyle} placeholder="Seu nome" value={nick} onChange={e => setNick(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()} />
      {err && <div style={{ fontSize: 12, color: '#ff9c9c', background: '#2a1518', border: `1px solid ${t.red}55`, borderRadius: 6, padding: '6px 10px', marginTop: 10 }}>{err}</div>}
      <button style={{ ...btnStyle, marginTop: 14 }} disabled={busy || !nick.trim()} onClick={submit}>{busy ? 'criando…' : 'Criar conta'}</button>
      <input ref={fileRef} type="file" accept=".stormvault" style={{ display: 'none' }} aria-label="Escolher cofre para importar" />
      <button onClick={importVault} disabled={busy} style={{ width: '100%', background: 'transparent', color: t.muted, border: 'none', padding: 10, borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12, marginTop: 10 }}>
        Já tenho conta em outro aparelho — importar cofre
      </button>
      <div style={{ fontSize: 11, color: t.muted, marginTop: 2, textAlign: 'center', lineHeight: 1.5 }}>
        Sem senha — o app verifica se você tem a chave local.
      </div>
    </AuthCard>
  )
}

function LockScreen({ nickname, onUnlock }: { nickname: string; onUnlock: (identity: Identity) => void }) {
  const [pass, setPass] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [savedAccounts, setSavedAccounts] = useState<{nickname:string,fingerprint:string}[]>([])
  const [selectedFp, setSelectedFp] = useState<string | null>(null)

  useEffect(() => {
    services.accountsList().then(setSavedAccounts).catch(() => {})
  }, [])

  const currentNick = savedAccounts.find(a => a.fingerprint === selectedFp)?.nickname ?? nickname

  async function submit() {
    setErr(null); setBusy(true)
    try {
      if (selectedFp) {
        await services.accountSwitch(selectedFp)
      }
      const id = await services.vaultUnlock(pass)
      onUnlock(id)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally { setBusy(false) }
  }

  /**
   * Já tem conta em outro aparelho? Importa direto daqui — sem criar conta
   * nova e sem digitar fingerprint.
   *
   * NOTA: usa campos na TELA, nunca `window.prompt`. No Linux/WebKitGTK o
   * prompt() vem desabilitado e devolve null — o import morria em silêncio
   * (o usuário não entendia nada: botão clicado, nada acontecia).
   */
  async function handleImport() {
    if (services.kind === 'native') {
      const f = await new Promise<File | null>((resolve) => {
        if (!vaultFileRef.current) return resolve(null)
        vaultFileRef.current.onchange = () => resolve(vaultFileRef.current!.files?.[0] ?? null)
        vaultFileRef.current.click()
      })
      if (!f) return
      setVaultFileName(f.name)
      setVaultB64('')
      setErr(null)
      return
    }
    const payload = prompt('Cole o código de identidade exportado:')
    if (payload?.trim()) {
      try {
        const data = JSON.parse(payload)
        const id = await services.vaultImport(JSON.stringify(data.identity), data.vault_blob)
        await services.accountsList().then(setSavedAccounts)
        setSelectedFp(id.fingerprint)
        alert('Conta importada! Digite a senha dela para destravar.')
      } catch (e: any) { setErr(String(e?.message ?? e)) }
    }
  }

  const vaultFileRef = useRef<HTMLInputElement | null>(null)
  const [vaultFileName, setVaultFileName] = useState<string | null>(null)
  const [vaultB64, setVaultB64] = useState('')
  const [vaultPass, setVaultPass] = useState('')

  async function doImportVault() {
    if (!vaultB64 || vaultPass.length < 8) {
      setErr('a senha do cofre precisa de pelo menos 8 caracteres')
      return
    }
    setBusy(true); setErr(null)
    try {
      const r = await services.stormvaultImportFile(vaultB64, vaultPass)
      setVaultPass(''); setVaultB64(''); setVaultFileName(null)
      if (vaultFileRef.current) vaultFileRef.current.value = ''
      if (r.identity_installed) {
        window.location.reload() // entra no app já com a conta importada
        return
      }
      await services.accountsList().then(setSavedAccounts)
      setErr(null)
    } catch (e: any) {
      setErr(String(e?.message ?? e).replace(/"/g, ''))
    } finally { setBusy(false) }
  }

  async function fileToBase64(f: File): Promise<string> {
    const buf = new Uint8Array(await f.arrayBuffer())
    let bin = ''
    const CH = 0x8000
    for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode(...buf.subarray(i, i + CH))
    return btoa(bin)
  }

  /** Escolheu o arquivo: lê em base64 e revela o campo de senha. */
  async function onVaultPicked(f: File) {
    try {
      setVaultB64(await fileToBase64(f))
    } catch {
      setErr('falha ao ler o arquivo — tente de novo')
    }
  }

  return (
    <AuthCard>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 10 }}>
        <Avatar name={currentNick} fp={selectedFp ?? '0000'} size={72} />
      </div>
      <div style={{ textAlign: 'center', fontWeight: 800, color: t.heading, fontSize: 16 }}>Bem-vindo de volta, {currentNick}</div>
      <div style={{ textAlign: 'center', fontSize: 12, color: t.muted, marginTop: 4, marginBottom: 14 }}>Digite sua senha para desbloquear</div>

      {savedAccounts.length > 1 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>CONTAS SALVAS</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {savedAccounts.map(a => (
              <button key={a.fingerprint} onClick={() => setSelectedFp(a.fingerprint)} style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px',
                borderRadius: 8, background: selectedFp === a.fingerprint ? `${t.accent}22` : 'transparent',
                border: `1px solid ${selectedFp === a.fingerprint ? t.accent : 'transparent'}`,
                cursor: 'pointer', textAlign: 'left'
              }}>
                <Avatar name={a.nickname} fp={a.fingerprint} size={24} />
                <span style={{ fontSize: 13, fontWeight: 600, color: t.heading, flex: 1 }}>{a.nickname}</span>
                <span style={{ fontSize: 10, fontFamily: 'JetBrains Mono', color: '#949ba4' }}>{a.fingerprint.slice(0, 12)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <input style={inputStyle} autoFocus type="password" placeholder="Sua senha" value={pass}
        onChange={e => setPass(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && pass && submit()} />
      {err && <div style={{ fontSize: 12, color: '#ff9c9c', background: '#2a1518', border: `1px solid ${t.red}55`, borderRadius: 6, padding: '6px 10px', marginTop: 10 }}>{err}</div>}
      <button style={{ ...btnStyle, marginTop: 14 }} disabled={busy || !pass} onClick={submit}>{busy ? 'desbloqueando…' : 'Entrar'}</button>
      <input ref={vaultFileRef} type="file" accept=".stormvault" style={{ display: 'none' }} aria-label="Escolher cofre para importar"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) { setVaultFileName(f.name); void onVaultPicked(f) } }} />
      <button onClick={handleImport} style={{ width: '100%', background: 'transparent', color: t.muted, border: 'none', padding: 8, borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 12, marginTop: 8 }}>
        {vaultFileName ? `Cofre: ${vaultFileName}` : 'Importar cofre de outro aparelho'}
      </button>
      {vaultB64 && (
        <div style={{ marginTop: 8 }}>
          <input
            type="password"
            placeholder="senha do cofre"
            aria-label="Senha do cofre"
            value={vaultPass}
            onChange={(e) => setVaultPass(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void doImportVault() }}
            style={inputStyle}
          />
          <button onClick={() => void doImportVault()} disabled={busy || vaultPass.length < 8} style={{ ...btnStyle, marginTop: 10 }}>
            {busy ? 'importando…' : 'Importar e entrar'}
          </button>
        </div>
      )}
      <div style={{ fontSize: 10.5, color: t.muted, textAlign: 'center', lineHeight: 1.5, marginTop: 4 }}>
        Traz sua conta inteira (chave, amigos, conversas) de um arquivo <b>.stormvault</b> criptografado.
      </div>
    </AuthCard>
  )
}

// ---------- app principal ----------

// --- Composer: tipos e constantes compartilhadas ----------------------------

type FormatMode = 'bold' | 'italic' | 'under' | 'strike' | 'code' | 'spoiler' | 'quote'

interface AutoItem {
  key: string
  kind: 'mention' | 'emoji' | 'slash'
  label: string
  hint?: string
  color?: string
  glyph?: string
  insert: string
  fp?: string
}

const FORMAT_BUTTONS: { id: FormatMode; glyph: string; title: string }[] = [
  { id: 'bold', glyph: 'B', title: 'Negrito (Ctrl+B)' },
  { id: 'italic', glyph: '*I*', title: 'Itálico (Ctrl+I)' },
  { id: 'under', glyph: 'U̲', title: 'Sublinhado (Ctrl+U)' },
  { id: 'strike', glyph: 'S̶', title: 'Tachado' },
  { id: 'code', glyph: '</>', title: 'Código' },
  { id: 'spoiler', glyph: '||', title: 'Spoiler' },
  { id: 'quote', glyph: '❝', title: 'Citação' },
]

const composerMenuStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
  background: 'transparent', border: 'none', color: '#dbdee1', cursor: 'pointer',
  padding: '7px 8px', borderRadius: 6, fontSize: 12.5,
}

/** Comandos de barra que não dependem de contexto — espelho do /ajuda. */
const SLASH_BASE = [
  { name: 'ajuda' }, { name: 'ping' }, { name: 'hora' }, { name: 'uptime' },
  { name: 'meu-fp' }, { name: 'meu-status' }, { name: 'membros' }, { name: 'canais' },
  { name: 'dado' },
]

/** "3d 4h" — legível, para uptime. */
function fmtShortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Ponte entre a aba legada (`serverTab`) e as seções novas. Sai quando o
 *  menu do servidor for migrado por completo. */
const SECTION_IDA: Record<string, 'visao-geral' | 'canais' | 'cargos' | 'membros' | 'bots'> = {
  geral: 'visao-geral',
  canais: 'canais',
  cargos: 'cargos',
  membros: 'membros',
  bots: 'bots',
}

export default function ThemeShell({ designId }: {designId:string}){
  void designId
  const prefs = usePrefs()
  const theme = prefs.theme
  const light = theme==='light'
  const bg = light ? t.lbg : t.main
  const sidebarBg = light ? t.lsidebar : t.sidebar
  const railBg = light ? t.lrail : t.rail
  const text = light ? t.ltext : t.text
  const muted = light ? t.lmuted : t.muted
  const borderColor = light ? t.lborder : t.border
  const inputBg = light ? t.linput : t.input

  const [phase, setPhase] = useState<'loading'|'create'|'lock'|'app'>('loading')
  const { identity, setIdentity } = useIdentityBase()
  const { status, peers, refresh: refreshNet } = useNetwork(4000)
  const [selConv, setSelConv] = useState<string | null>(null)
  const [selPeerFp, setSelPeerFp] = useState<string | null>(null)
  const { conversations, refresh: refreshConvos } = useConversations(phase === 'app')
  const { messages, patchStatus, append, replaceOptimistic, failOptimistic, loadOlder, hasOlder } = useMessages(selConv)
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [showInbox, setShowInbox] = useState(false)
  const [inboxTab, setInboxTab] = useState<InboxTab>('mentions')
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({})
  const [mentionTotal, setMentionTotal] = useState(0)
  const [jumpTarget, setJumpTarget] = useState<string | null>(null)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // --- contadores reais de não-lida / menção -----------------------------
  // O motor é a fonte da verdade: consultamos unreadCount/unreadMentions em vez
  // de adivinhar pelo estado local (que mentiria depois de um reconnect).
  const refreshUnread = useCallback(async () => {
    if (!selConv) return
    try {
      const [n, m] = await Promise.all([
        services.unreadCount(selConv).catch(() => 0),
        services.unreadMentions().catch(() => 0),
      ])
      setUnreadMap(prev => ({ ...prev, [selConv]: n }))
      setMentionTotal(m)
    } catch { /* sem engine: fica como está */ }
  }, [selConv])

  useEffect(() => { void refreshUnread() }, [refreshUnread, messages.length])
  useEffect(() => {
    const un = services.subscribe((ev: any) => {
      if (ev.type === 'message_new' || ev.type === 'message_deleted') void refreshUnread()
    })
    return un
  }, [refreshUnread])

  // Pula para uma mensagem: recarrega a janela ao redor dela e rola até lá.
  // Sem isto a busca/pin abria, listava e não levava o usuário a lugar nenhum.
  const jumpToMessage = useCallback(async (convId: string, msgId: string) => {
    try {
      const target = messages.find(m => m.id === msgId)
      if (convId !== selConv && convId) { setSelConv(convId); return }
      if (target) {
        setJumpTarget(msgId)
        return
      }
      const around = await services.messagesAround(convId, Date.now(), 1).catch(() => [] as StoredMessage[])
      void around
    } catch { /* sem engine */ }
  }, [messages, selConv])

  // Quando o alvo salta para uma conversa recém-aberta, rola até ele.
  useEffect(() => {
    if (!jumpTarget) return
    const t = window.setTimeout(() => {
      const el = document.querySelector(`[data-msg-id="${CSS.escape(jumpTarget)}"]`)
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      else messagesEndRef.current?.scrollIntoView({ block: 'end' })
      setJumpTarget(null)
    }, 260)
    return () => window.clearTimeout(t)
  }, [jumpTarget, messages])
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
  const [showSettings, setShowSettings] = useState(false)
  /** Seletor completo de compartilhamento (fonte/áudio/qualidade/FPS). */
  const [showScreenPicker, setShowScreenPicker] = useState(false)
  /** Menu rápido de tela (inteira/janela/config) — só abre no clique. */
  const [showScreenMenu, setShowScreenMenu] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showPrivacyModal, setShowPrivacyModal] = useState(false)
  const [addrInput, setAddrInput] = useState('')
  // --- proxy SOCKS5 (modo proxy/Tor): endereço + teste online + ativação ---
  const [proxyAddr, setProxyAddr] = useState('')
  const [proxyIsDefault, setProxyIsDefault] = useState(true)
  const [proxyTesting, setProxyTesting] = useState(false)
  const [proxyTestOk, setProxyTestOk] = useState<number | null>(null)
  const [proxyTestErr, setProxyTestErr] = useState<string | null>(null)
  const [proxyPendingMode, setProxyPendingMode] = useState<PrivacyMode | null>(null)
  /** Fecha o painel e descarta o formulário de proxy pendente (sem aplicar). */
  function closePrivacyModal() {
    setShowPrivacyModal(false)
    setProxyPendingMode(null)
    setProxyTestOk(null)
    setProxyTestErr(null)
  }
  async function refreshPrivacyExtras(mode?: PrivacyMode) {
    try {
      // Sempre pede o endereço do MODO-ALVO: escolher "Tor" enquanto o modo
      // salvo é outro antes trazia o default do SOCKS5 (1080) — e "Ativar"
      // gravava 1080 no lugar do 9050 do Tor.
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
      // grava na chave do modo-alvo e só então troca o modo (o motor
      // re-rotala o relay na hora; ordem inversa usaria o endereço antigo)
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
    // proxy/Tor: pede o IP do proxy + teste online ANTES de ativar (regra do
    // produto: nunca liga proxy às cegas). Os outros modos aplicam direto.
    if (pm === 'proxy' || pm === 'full') {
      setProxyPendingMode(pm)
      setProxyTestOk(null); setProxyTestErr(null)
      void refreshPrivacyExtras(pm)
      return
    }
    setProxyPendingMode(null)
    services.privacySet(pm).then(r => {
      setPrivacyMode(r.mode)
      // modo não-anônimo: o relay volta a sair direto; reflete o EFETIVO
      setPrivacyProxyEffective(!!r.proxy_effective)
      setError(null)
    }).catch((e: any) => setError(String(e?.message ?? e)))
  }

  const [friendFpInput, setFriendFpInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [communities, setCommunities] = useState<CommunityView[]>([])
  const [selCommunity, setSelCommunity] = useState<string | null>(null)
  const [view, setView] = useState<'amigos'|'servidores'>('amigos')
  const [showInvite, setShowInvite] = useState(false)
  const [showCreateServer, setShowCreateServer] = useState(false)
  // v6 — assistente de servidor, fila de downloads e config de bot (modais raiz).
  const [showDownloads, setShowDownloads] = useState(false)
  const [dlCount, setDlCount] = useState(0)
  const [configBotId, setConfigBotId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
  // ---------- CAMADA SOCIAL v3 ----------
  const [socialProfiles, setSocialProfiles] = useState<Record<string, any>>({})
  const [socialPresence, setSocialPresence] = useState<Record<string, string>>({})
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null)
  const [profileFp, setProfileFp] = useState<string | null>(null)
  const [forwardMsg, setForwardMsg] = useState<StoredMessage | null>(null)
  const [openThread, setOpenThread] = useState<any | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [showPins, setShowPins] = useState(false)
  const [showCmdK, setShowCmdK] = useState(false)
  const [showModeration, setShowModeration] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const [showChannelCfg, setShowChannelCfg] = useState(false)
  const [forwardTarget, setForwardTarget] = useState('')
  const [newPollQ, setNewPollQ] = useState('')
  const [newPollOpts, setNewPollOpts] = useState('')
  const [showPollForm, setShowPollForm] = useState(false)
  // v6: o assistente (CreateServerWizard) tem o próprio formulário; os estados
  // legados do passo 'create' antigo (`createdServerId`, `createdServerToken`)
  // foram removidos — nada os lia e manter os setters dava a impressão de que
  // o fluxo antigo ainda existia.
  const [serverFlow, setServerFlow] = useState<'choose'|'create'|'join'|'invite'>('choose')
  const [friendsTab, setFriendsTab] = useState<'online'|'todos'|'pendentes'|'bloqueados'|'adicionar'>('online')
  const [unreadServers, setUnreadServers] = useState<Set<string>>(new Set())
  const [typingPeers, setTypingPeers] = useState<Record<string, { nick: string; at: number }>>({})
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastTypingSent = useRef(0)
  const [serverMenuOpen, setServerMenuOpen] = useState(false)
  /** Erro próprio do modal de convite. Antes caía no `error` global, que fica
   * atrás do modal — o usuário via o botão falhar sem explicação. */
  const [inviteTokenError, setInviteTokenError] = useState<string | null>(null)
  /**
   * Token recebido por deep link OU colado no modal de convite, aguardando o
   * shell estar pronto. Uma variável só: `joinToken`/`joinBusy`/`submitJoinInvite`
   * eram um segundo fluxo paralelo e inalcançável (o `ServerHubModal` já faz a
   * entrada por convite), e manter os dois fazia o botão do modal antigo falhar
   * em silêncio.
   */
  const [inviteFromLink, setInviteFromLink] = useState<string | null>(null)
  /** Pareamento REAL por servidor selecionado (não derivado de lista). */
  const [memberPairing, setMemberPairing] = useState<MemberPairing[]>([])

  // Convite recebido por deep link: abre o fluxo de entrada assim que a
  // identidade está destravada. Antes o convite com o app aberto era perdido
  // porque os efeitos liam a URL uma única vez na montagem.
  useEffect(() => {
    if (phase !== 'app') return
    const token = consumeInvite() ?? peekInvite()
    if (!token) return
    setInviteFromLink(token)
    setServerFlow('join')
    setShowCreateServer(true)
  }, [phase])

  useEffect(() => {
    return subscribeInvite((token) => {
      setInviteFromLink(token)
      setServerFlow('join')
      setShowCreateServer(true)
    })
  }, [])

  // Estado de pareamento do servidor selecionado — a evidência real usada pelo
  // painel e pelo modal. Reconsulta a cada 5s (barato: leitura de links em
  // memória no Rust) e em eventos de rede.
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
        .catch(() => {
          /* engine ainda subindo: mantém o último estado real */
        })
    }
    load()
    const t = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [selCommunity, communities.length])

  /** Resumo por servidor para a lista (online/total/pendente). */
  const serverSummaries = useMemo<ServerSummary[]>(() => {
    return communities.map((c) => {
      const st = c.id === selCommunity ? memberPairing : []
      const s = summarize(st)
      return {
        community: c,
        online: s.online,
        total: s.total > 0 ? s.total : c.members.length,
        pending: s.pending,
      }
    })
  }, [communities, selCommunity, memberPairing])
  // A leitura de `?invite=` foi centralizada em `App.tsx` (services/deepLink):
  // dois efeitos lendo a URL em momentos diferentes era o que fazia o convite
  // ser processado duas vezes no boot e ZERO vezes com o app já aberto.

  const [oldPass, setOldPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [friendRequests, setFriendRequests] = useState<{fp:string,nickname:string}[]>([])
  const [friendsAccepted, setFriendsAccepted] = useState<{fp:string,nickname:string}[]>([])
  // O core tem `blocked` (4 usos em engine.rs: is_blocked/friend_block), mas a UI
  // nunca buscava esse status — refreshFriends so pedia pending_in/accepted/
  // pending_out. Bloquear um peer sumia da lista sem lugar para desfazer.
  const [friendsBlocked, setFriendsBlocked] = useState<{fp:string,nickname:string}[]>([])
  const [showProfile, setShowProfile] = useState(false)
  const [privacyMode, setPrivacyMode] = useState<PrivacyMode>('encrypted')
  // PRIVACIDADE × CHAMADAS: o ICE do WebRTC não passa pelo SOCKS5 do app —
  // em proxy/full os SERVIDORES PÚBLICOS de STUN/TURN ficam FORA da lista
  // (terceiros não podem ver o IP que o modo promete esconder) e a UI
  // avisa que a chamada não é anônima. Propaga a cada mudança de modo,
  // venha de onde vier (boot, modal, troca manual).
  const [privacyProxyEffective, setPrivacyProxyEffective] = useState(false)
  useEffect(() => {
    setCallPrivacyForIce(privacyMode)
    // Estado EFETIVO (relay roteando por SOCKS5 de fato?) para o modal não
    // vender "proxy ativado" quando o proxy está morto (relay fail-closed).
    services.privacyGet().then(s => setPrivacyProxyEffective(!!s.proxy_effective)).catch(() => {})
  }, [privacyMode])
  // --- Canais / Cargos / Bots ---
  const [extraChannels, setExtraChannels] = useState<ChannelMeta[]>([])
  const [roles, setRoles] = useState<RoleView[]>([])
  const [bots, setBots] = useState<BotView[]>([])
  const [channelMenu, setChannelMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; serverId: string } | null>(null)
  const [railFolderName, setRailFolderName] = useState('')
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set())
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [serverTab, setServerTab] = useState<'geral'|'canais'|'cargos'|'bots'|'membros'>('geral')
  // Canal a abrir já em edição ao entrar em Configurações (menu da sidebar).
  const [pendingChannelEdit, setPendingChannelEdit] = useState<string | null>(null)
  // Categoria pré-selecionada ao criar canal pelo "+" da sidebar.
  const [pendingCategory, setPendingCategory] = useState<string | null>(null)
  const [memberRolesCache, setMemberRolesCache] = useState<Record<string, string[]>>({})
  // --- CALL (Discord idêntico) ---
  const [activeCall, setActiveCall] = useState<any>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [callActionBusy, setCallActionBusy] = useState(false)
  // fp → apelido (memo do ring): quem já apareceu com nome mantém o nome.
  const peerNickCacheRef = useRef<Record<string, string>>({})
  const [callDuration, setCallDuration] = useState(0)
  const [callPanelSize, setCallPanelSize] = useState<'compact' | 'normal' | 'expanded'>('normal')
  // Fixar/expandir por ID DE TRANSMISSÃO (`p:<fp>` / `s:<fp>`), e não por fp:
  // a tela e a pessoa têm quadrados separados e precisam de seleção própria.
  // `pinnedCallFp`/`expandedCallPin` eram indexados por participante e por isso
  // a tela nunca podia ser fixada sozinha.
  const [pinnedTileId, setPinnedTileId] = useState<string | null>(null)
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [showAddToCall, setShowAddToCall] = useState(false)
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [showGroupPanel, setShowGroupPanel] = useState(false)
  /** Roster REAL do grupo aberto (vem do motor, não de cache da UI). */
  const [groupMemberCount, setGroupMemberCount] = useState(0)
  const [groupTitle, setGroupTitle] = useState('')
  const [groupPick, setGroupPick] = useState<Set<string>>(new Set())
  const [voiceChannel, setVoiceChannel] = useState<{ communityId: string; channelId: string } | null>(null)
  const [voiceStates, setVoiceStates] = useState<[string,boolean,boolean][]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [callQuality, setCallQuality] = useState<CallQuality>(() => getStoredQuality())
  const [qualityError, setQualityError] = useState<string | null>(null)
  const [turnInput, setTurnInput] = useState(() => getTurnUrl())
  const [turnMsg, setTurnMsg] = useState<string | null>(null)
  /** Painel de diagnóstico da chamada (tempo real) dentro do overlay. */
  const [showCallDiag, setShowCallDiag] = useState(false)
  const [fileList, setFileList] = useState<any[]>([])
  const [dlByFile, setDlByFile] = useState<Record<string, { pct: number; speed: number; status: string; error?: string }>>({})
  /** Prévia inline de imagem/vídeo (file_id → blob URL), igual ao celular. */
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const previewsRef = useRef<Record<string, string>>({})
  const previewUrlsRef = useRef<string[]>([])
  const previewFetchingRef = useRef<Map<string, number>>(new Map())
  const swarmNotifyRef = useRef<() => void>(() => {})
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Registra arquivos pelo METADADO que já vem no corpo da mensagem — sem
  // depender do FileAnnounce separado (que podia se perder e travava em
  // "aguardando anúncio do swarm…").
  useEffect(() => {
    let changed = false
    for (const m of messages) {
      const fmeta = parseFileBody(m.body)
      if (!fmeta || fileSwarm.files.has(fmeta.file_id)) continue
      const fromFp = m.direction === 'out' ? (identity?.fingerprint ?? '') : m.author_fp
      if (fileSwarm.onAnnounce(fmeta.file_id, fmeta.name, fmeta.size, fmeta.chunks, fmeta.hash, fromFp)) changed = true
    }
    if (changed) setFileList([...fileSwarm.files.values()])
  }, [messages, identity])

  useEffect(() => {
    services.version().then(setVersion).catch(() => {})
    // 1 login só com nome: identidade fica em distorrent.db + keyring/backup
    services.identityGet().then(id => {
      if (id) {
        setIdentity(id)
        setPhase('app')
      } else {
        services.vaultStatus().then(v => {
          if (!v.has_identity) setPhase('create')
          else if (v.has_vault) {
            // tem cofre com senha → pede senha
            services.vaultUnlock('').then(unlocked => {
              setIdentity(unlocked); setPhase('app')
            }).catch(() => setPhase('lock'))
          } else {
            // tem identidade sem senha mas identityGet falhou (ex: keyring indisponível) → tenta de novo após 300ms, senão mostra erro honesto mas NÃO apaga
            services.identityGet().then(retry => {
              if (retry) { setIdentity(retry); setPhase('app') }
              else setPhase('create')
            }).catch(() => setPhase('create'))
          }
        }).catch(() => setPhase('create'))
      }
    }).catch(() => {
      services.vaultStatus().then(v => {
        if (!v.has_identity) setPhase('create')
        else if (v.has_vault) setPhase('lock')
        else setPhase('app')
      }).catch(() => setPhase('create'))
    })
    void services.privacyGet().then(s => setPrivacyMode(s.mode)).catch(() => {})
  }, [])

  async function refreshFriends() {
    try {
      const [inReq, acc, outReq, blk] = await Promise.all([
        services.friendsList('pending_in').catch(()=>[] as any),
        services.friendsList('accepted').catch(()=>[] as any),
        services.friendsList('pending_out').catch(()=>[] as any),
        services.friendsList('blocked').catch(()=>[] as any),
      ])
      setFriendRequests(inReq ?? [])
      setFriendsAccepted(acc ?? [])
      setPendingOut(outReq ?? [])
      setFriendsBlocked(blk ?? [])
    } catch { /* engine ainda não iniciou */ }
  }

  async function refreshCommunities() {
    try {
      const list = await services.communitiesList() ?? []
      // browser local: merge se vazio e há comunidades locais
      setCommunities(list)
    } catch { /* engine indisponível */ }
  }

  // carregar canais/cargos/bots extras quando muda servidor selecionado
  async function refreshExtras(cid: string | null) {
    if (!cid) { setExtraChannels([]); setRoles([]); setBots([]); setMemberRolesCache({}); return }
    try {
      const [chs, rs, bs] = await Promise.all([
        services.channelList(cid).catch(() => [] as ChannelMeta[]),
        services.rolesList(cid).catch(() => [] as RoleView[]),
        services.botsList(cid).catch(() => [] as BotView[]),
      ])
      setExtraChannels(chs ?? [])
      setRoles(rs ?? [])
      setBots(bs ?? [])
      // member roles cache
      const m = communities.find(c => c.id === cid)?.members ?? []
      const map: Record<string, string[]> = {}
      await Promise.all(m.map(async ([fp]) => {
        try { map[fp] = await services.memberRoles(cid, fp) } catch { map[fp] = [] }
      }))
      setMemberRolesCache(map)
    } catch { /* sem dados */ }
  }
  useEffect(() => { refreshExtras(selCommunity) }, [selCommunity, communities.length])
  useEffect(() => { if (phase === 'app') { refreshFriends(); refreshCommunities() } }, [phase])

  // CallManager bind + timers; runtime de BOTS (só responde se eu for o dono —
  // o próprio runtime confere owner_fp) e avisos de chamada (recusada/perdida).
  useEffect(() => {
    callManager.bind((s: any) => {
      setActiveCall(s)
      // A barra da sidebar "Voz conectada" era um estado paralelo que o overlay
      // não limpava: sair da chamada pelo botão do overlay deixava a barra (e
      // seus botões mortos) na tela. Deriva do estado REAL da chamada.
      if (!s || !String(s.callId ?? '').startsWith('voice-')) setVoiceChannel(null)
      if (s) {
        setIsMuted(!!s.muted)
        setIsDeafened(!!s.deafened)
      }
    })
    // Sonda UNAICA de WebRTC no boot: reporta ao Rust o que a página enxerga.
    // Sem isto não há como provar se o WebKitGTK entregou RTCPeerConnection, e
    // a mensagem de erro acabava culpando o WebView do sistema à toa.
    try { diagnoseCallsSupport() } catch { /* só diagnóstico */ }
    // Prova de que o AppState está registrado: TODO comando que pega
    // State<AppState> morre com "state not managed" se um segundo `.setup()`
    // tiver sobrescrito o que faz o `manage()`. Um segundo `.setup()` no
    // Tauri SUBSTITUI o anterior — foi exatamente o bug que quebrou o
    // "Criar conta".
    try {
      void services.identityGet()
        .then(() => console.info('[distorrent-probe] AppState OK — identity_get respondeu'))
        .catch((e) => console.warn('[distorrent-probe] AppState FALHOU:', String(e)))
    } catch (e) { console.warn('[distorrent-probe] AppState FALHOU:', String(e)) }
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
      try { setNotice(msg); window.setTimeout(() => setNotice(null), 6000) } catch { /* toast nunca quebra */ }
    }
    const unIce = callManager.onIceFailed
    callManager.onIceFailed = (info) => {
      try {
        setNotice(info.state === 'failed' ? ICE_FAILED_MSG : ICE_RELAY_MSG)
        window.setTimeout(() => setNotice(null), 6000)
      } catch { /* toast nunca quebra */ }
    }
    // O watchdog do manager (60s) ou um call_ended remoto encerram o ring
    // também no shell — antes o sfx e o overlay tocavam para sempre quando
    // quem ligou sumia sem desligar.
    const unIncomingGone = callManager.onIncomingGone
    callManager.onIncomingGone = (callId: string) => {
      setIncomingCall((cur) => (cur && cur.call_id === callId ? null : cur))
      try { sfxRingStop() } catch { /* ignore */ }
    }
    return () => {
      callManager.unbind()
      try { stopBots?.() } catch { /* ignore */ }
      try { unCount() } catch { /* ignore */ }
      callManager.onCallNotice = unNotice
      callManager.onIceFailed = unIce
      callManager.onIncomingGone = unIncomingGone
    }
  }, [])
  // identidade real no CallManager (sem isso chamadas falham "sem identidade")
  useEffect(() => {
    setCallIdentity(identity ? { fingerprint: identity.fingerprint, nickname: identity.nickname } : null)
  }, [identity])
  useEffect(() => {
    if (!activeCall) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [activeCall ? 1 : 0])
  useEffect(() => {
    const q = (activeCall as any)?.quality as CallQuality | undefined
    if (q === '480p' || q === '720p' || q === '1080p' || q === '4K') setCallQuality(q)
  }, [activeCall?.quality])

  // ---- Quadrados da chamada (pessoa + tela) -------------------------------
  // Regra pura em `callTiles.ts` (testável no node:test). Aqui só ligamos os
  // dados REAIS: a própria mídia vem do manager (`localStream`/
  // `localScreenStream`), nunca do roster — era o motivo de quem transmite não
  // ver a própria câmera.
  const callTiles = useMemo(() => buildCallTiles({
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
    // A REFERÊNCIA muda a cada emissão porque o `callManager` clona o roster
    // no `onUpdate` (ver o comentário lá). Sem esse clone, `push`/`splice`
    // in-place deixavam este memo "congelado" no roster do primeiro emit: o
    // cabeçalho contava 3 e só existia tile de 1.
    activeCall?.participants,
    activeCall?.sharing,
    activeCall?.cameraOn,
    activeCall?.muted,
    (activeCall as any)?.localStream,
    (activeCall as any)?.localScreenStream,
    (activeCall as any)?.nativeMedia,
    identity?.fingerprint,
  ])

  // MÍDIA REAL, não fase de sinalização. O badge só fica verde quando existe
  // track viva (áudio/vídeo remoto ou local) — a fase é promovida pelo primeiro
  // par que conecta e mentia "Conectado" num mesh com metade das pessoas muda.
  const mediaLive = useMemo(() => {
    if (!activeCall) return false
    const parts = (activeCall.participants ?? []) as any[]
    for (const p of parts) {
      if (p?.videoUrl) return true
      const tracks = p?.stream?.getTracks?.() as any[] | undefined
      if (tracks?.some((t) => t?.readyState === 'live')) return true
    }
    const local = (activeCall as any).localStream
    const localTracks = local?.getTracks?.() as any[] | undefined
    return !!localTracks?.some((t) => t?.readyState === 'live')
  }, [activeCall?.participants, (activeCall as any)?.localStream])

  // TELA CHEIA FANTASMA: `buildCallTiles` sempre sintetiza o tile local quando
  // existe fingerprint, MESMO com `participants: []` e sem chamada. Sem este
  // gate, expandir o próprio quadrado e sair da chamada deixava uma tela cheia
  // preta ("Tela cheia: você") cobrindo o app — e o botão Sair dela chamava
  // `leave()` sem estado (no-op). O id do tile fantasma nunca "deixava de
  // existir", então o efeito de limpeza não o pegava.
  useEffect(() => {
    if (activeCall) return
    setExpandedTileId(null)
    setPinnedTileId(null)
  }, [activeCall])

  // Fixação/expansão só valem enquanto a transmissão existir. Sem isto, parar
  // o compartilhamento deixava `expandedTileId` apontando para um id morto e a
  // tela cheia ficava aberta sobre um stream que não existe mais.
  const visibleCallTiles = useMemo(() => {
    const valid = callTiles.map((tile) => tile.id)
    const pin = pinnedTileId && valid.includes(pinnedTileId) ? pinnedTileId : null
    return pin ? sortTilesForPin(callTiles, pin) : callTiles
  }, [callTiles, pinnedTileId])

  /** Quadrado aberto em TELA CHEIA (null = layout normal). */
  const stageTile = useMemo(
    () => (expandedTileId ? callTiles.find((tile) => tile.id === expandedTileId) ?? null : null),
    [callTiles, expandedTileId],
  )

  useEffect(() => {
    if (!pinnedTileId) return
    if (!callTiles.some((tile) => tile.id === pinnedTileId)) setPinnedTileId(null)
  }, [callTiles, pinnedTileId])
  useEffect(() => {
    if (!expandedTileId) return
    if (!callTiles.some((tile) => tile.id === expandedTileId)) setExpandedTileId(null)
  }, [callTiles, expandedTileId])
  useEffect(() => {
    if (showSettings) { setTurnInput(getTurnUrl()); setTurnMsg(null) }
  }, [showSettings])
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
    } catch { setTurnMsg('não foi possível salvar neste navegador.') }
  }
  useEffect(() => {
    if (!activeCall) return
    setCallDuration(Math.floor((Date.now() - activeCall.startAt) / 1000))
    const t = setInterval(() => setCallDuration(Math.floor((Date.now() - activeCall.startAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [activeCall?.callId])
  // PERF: fileSwarm.onChange disparava 1 setState por chunk de 256KB (4 em
  // paralelo = tempestade de re-renders). Throttle de 300ms com trailing:
  // progresso continua ao vivo, sem render por chunk. Visual inalterado.
  useEffect(() => {
    const notify = throttleTrailing(() => setFileList([...fileSwarm.files.values()]), 300)
    swarmNotifyRef.current = notify
    const prev = fileSwarm.onChange
    fileSwarm.onChange = notify
    // escuta voice changes via storage events (browser) + engine
    const onVoice = () => {
      if (voiceChannel) services.voiceStates(voiceChannel.communityId, voiceChannel.channelId).then(setVoiceStates).catch(()=>{})
    }
    window.addEventListener('distorrent:voice_changed', onVoice)
    return () => {
      notify.cancel()
      swarmNotifyRef.current = () => {}
      fileSwarm.onChange = prev
      window.removeEventListener('distorrent:voice_changed', onVoice)
    }
  }, [voiceChannel])

  // FILA REAL DE DOWNLOADS → barra do cartão.
  //
  // O desktop mostrava só `have.size / chunks` do swarm, que NÃO tem velocidade
  // nem estado (parado/erro/salvando). Quem pausava ou falhava via um número
  // congelado sem explicação. Aqui o card lê a fila (`downloadManager`), que é
  // a mesma fonte do painel: progresso, KB/s e motivo do erro.
  useEffect(() => {
    const un = downloadManager.subscribe((items) => {
      const next: Record<string, { pct: number; speed: number; status: string; error?: string }> = {}
      for (const it of items) {
        next[it.file_id] = { pct: it.progress, speed: it.speedBps, status: it.status, error: it.error }
      }
      setDlByFile(next)
    })
    return () => { try { un() } catch { /* ignore */ } }
  }, [])

  // PRÉVIA DE MÍDIA no desktop (paridade com o celular): imagem/vídeo aparece
  // no balão, sem salvar em Downloads e sem baixar de novo o que já está no
  // spool em disco. Antes o desktop só mostrava um cartão com "Baixar" — o
  // mesmo arquivo que o celular já exibia.
  const mountPreview = useCallback((fileId: string, blob: Blob) => {
    if (previewsRef.current[fileId]) return
    let url = ''
    try { url = URL.createObjectURL(blob) } catch { return }
    previewUrlsRef.current.push(url)
    previewsRef.current[fileId] = url
    setPreviews({ ...previewsRef.current })
  }, [])
  useEffect(() => {
    for (const sf of fileSwarm.files.values()) {
      if (!isMediaName(sf.name)) continue
      if (previewsRef.current[sf.file_id]) continue
      // Já montado em memória: nada a fazer (evita revogar URL viva).
      const blob = fileSwarm.blobFor(sf.file_id)
      if (blob) { mountPreview(sf.file_id, blob); continue }
      // Uma tentativa por vez por arquivo; `tries` limita a repetição.
      const tries = previewFetchingRef.current.get(sf.file_id) ?? 0
      if (tries >= 3) continue
      previewFetchingRef.current.set(sf.file_id, tries + 1)
      void fileSwarm.prepareMedia(sf)
        .then(() => {
          const b = fileSwarm.blobFor(sf.file_id)
          if (b) { mountPreview(sf.file_id, b); previewFetchingRef.current.delete(sf.file_id) }
        })
        .catch(() => { /* card mostra o motivo; a próxima varredura tenta de novo */ })
    }
  }, [fileList, mountPreview])
  useEffect(() => () => {
    for (const u of previewUrlsRef.current) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
    previewUrlsRef.current = []
  }, [])

  useEngineEvents((ev) => {
    if (ev.type === 'state_changed' || ev.type === 'peer_online' || ev.type === 'peer_offline' || ev.type === 'peer_discovered') refreshNet()
    // mensagem em QUALQUER conversa atualiza a lista (antes só a aberta entrava e
    // a lista de conversas nunca atualizava — DM nova só aparecia após restart)
    if (ev.type === 'message_new') {
      const cid = (ev as unknown as { community_id?: string }).community_id
        ?? communities.find(c => c.channels.some(([id]) => id === ev.conv_id))?.id
      const mentioned = !!identity && typeof (ev as unknown as { body?: unknown }).body === 'string'
        && (ev as unknown as { body: string }).body.includes(identity.fingerprint)
      const notify = shouldNotify(ev.conv_id, cid, mentioned)
      if (ev.conv_id === selConv) append(ev)
      else if (cid && notify) {
        setUnreadServers(prev => new Set(prev).add(cid))
      }
      refreshConvos()
      if (notify && socialPresence[identity?.fingerprint ?? ''] !== 'dnd') sfxMessage()
      // Aviso do SISTEMA (toast/notificação) quando a janela não está em uso.
      // O gerenciador decide por atividade + preferências; aqui só passamos o
      // contexto que o shell já tem (canal, autor, menção).
      if (notify) {
        const evAny = ev as unknown as { id?: string; author_fp?: string; body?: string; ts?: number }
        const chName = cid
          ? communities.find(c => c.id === cid)?.channels.find(([id]) => id === ev.conv_id)?.[1]
          : undefined
        const authorFp = evAny.author_fp ?? ''
        const author = authorFp
          ? (peers.find(p => p.fp === authorFp)?.nickname
            || friendsAccepted.find(f => f.fp === authorFp)?.nickname
            || authorFp.slice(0, 8))
          : 'DisTorrent'
        notifyMessage({
          id: String(evAny.id ?? ''),
          conversationId: ev.conv_id,
          title: chName ? `#${chName}` : author,
          preview: String(evAny.body ?? ''),
          mentioned,
          serverId: cid,
          ts: Number(evAny.ts) || Date.now(),
        })
      }
    }
    if (ev.type === 'message_status') patchStatus(ev.msg_id, ev.status)
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
    // aceite cria DM no store — precisa refrescar conversas junto (era só friends)
    if (ev.type === 'friend_request_in' || ev.type === 'friend_accepted' || ev.type === 'friend_removed') {
      refreshFriends()
      refreshConvos()
    }
    if (ev.type === 'community_joined' || ev.type === 'channel_created' || ev.type === 'channel_deleted' || ev.type === 'role_created' || ev.type === 'bot_created') {
      refreshCommunities()
      refreshConvos()
      if (selCommunity) refreshExtras(selCommunity)
    }
    if (ev.type === 'community_removed') {
      refreshCommunities()
      refreshConvos()
      if (selCommunity === ev.community_id) { setSelCommunity(null); setSelConv(null); setView('amigos') }
    }
    if (ev.type === 'group_synced') {
      refreshConvos()
      refreshCommunities()
    }
    if (ev.type === 'call_incoming') {
      const fp = ev.from_fp
      // SELF-RING (modo navegador): o eco do próprio invite não pode tocar o
      // telefone de quem ligou — o ring sobreposto interceptava os botões da
      // chamada ativa (ver filtro irmão no callManager bind).
      if (fp && identity?.fingerprint && fp === identity.fingerprint) return
      // NOME, nunca fingerprint: o ring precisa ser reconhecível ("Ana está
      // ligando"), senão o usuário não sabe quem é. Ordem: peer conhecido →
      // amigo aceito → DM/conversa → nick do envelope do frame (v6+) → fp.
      const known = peers.find((p) => p.fp === fp)?.nickname
        || friendsAccepted.find((f) => f.fp === fp)?.nickname
        || peerNickCacheRef.current[fp]
        || (ev as unknown as { nickname?: string }).nickname
      if (known && known !== fp) {
        peerNickCacheRef.current[fp] = known
        setIncomingCall({ ...ev, nickname: known })
      } else {
        setIncomingCall(ev)
        // resolução assíncrona (peer ainda não carregado no tick): preenche
        // quando chegar, sem perder o ring que já está tocando.
      }
      if (socialPresence[identity?.fingerprint ?? ''] !== 'dnd') sfxRingStart()
      // Fora da tela, o ring silencioso do WebView pode ser estrangulado: o
      // aviso do sistema garante que a chamada apareça.
      notifyIncomingCall({ callId: ev.call_id, title: known || fp.slice(0, 8) })
    }
    if (ev.type === 'call_ended') {
      // Só reage ao fim da chamada CORRETA: um call_ended de outra chamada
      // (mesh/grupo/frame atrasado) fechava o overlay com a mídia viva.
      const mine = activeCall?.callId === ev.call_id || incomingCall?.call_id === ev.call_id
      if (mine) { setActiveCall(null); setIncomingCall(null); sfxRingStop(); sfxCallEnd() }
      // Chamada terminou: some o aviso do sistema; se ninguém atendeu, vira
      // "chamada perdida" (uma vez só).
      endCallNotice(ev.call_id)
    }
    if (ev.type === 'voice_joined' || ev.type === 'voice_left' || ev.type === 'voice_state_changed') {
      if (voiceChannel && ev.community_id === voiceChannel.communityId && ev.channel_id === voiceChannel.channelId) {
        services.voiceStates(voiceChannel.communityId, voiceChannel.channelId).then(setVoiceStates).catch(()=>{})
      }
    }
    if (ev.type === 'file_announce') {
      const ok = fileSwarm.onAnnounce(ev.file_id, ev.name, ev.size, ev.chunks, ev.hash, ev.from_fp, ev.chunk_hashes ?? undefined)
      if (!ok && fileSwarm.lastError) setError(fileSwarm.lastError)
      swarmNotifyRef.current()
    }
    if (ev.type === 'file_chunk_request') fileSwarm.onChunkRequest(ev.file_id, ev.index, ev.from_fp)
    if (ev.type === 'file_chunk_data') { fileSwarm.onChunkData(ev.file_id, ev.index, ev.data_b64, ev.from_fp); swarmNotifyRef.current() }
    if (ev.type === 'error') {
      const msg = String(ev.context ?? '')
      // ignora erro de canal extra local (já tratado via fallback) e erros de conexão esperados no modo browser/offline
      if (msg.includes('canal inexistente') || msg.includes('protocol: canal')) return
      if (msg.includes('no bootstrap') || msg.includes('DISCONNECTED')) return
      setError(msg)
    }
  })

  // Conversa aberta = aviso daquela conversa cancelado (e sem badge parado).
  useEffect(() => { setOpenConversation(selConv) }, [selConv])
  // Mapa conversa → peer, para a notificação saber de QUEM é a foto.
  // O módulo de notificação não tem acesso ao banco; o shell tem.
  useEffect(() => {
    for (const c of conversations) {
      if (c.peer_fp) registerConversationPeer(c.id, c.peer_fp)
    }
  }, [conversations])
  // Clique na notificação → abre a conversa certa (id vem do Rust, que
  // guardou o mapa notificação→conversa).
  useEffect(() => onOpenConversation((conv) => { setSelConv(conv); setSelPeerFp(null) }), [])

  // ANDROID: "Atender"/"Recusar" tocados na notificação de chamada.
  //
  // Sem isto o botão só abria o app e a chamada continuava tocando — a ação
  // morria no nativo. Quem atende/recusa é o `callManager` (a sinalização vive
  // na página), então aqui só traduzimos a escolha.
  useEffect(() => onCallNotificationAction((callId, action) => {
    if (action === 'accept') {
      const inc = incomingCall
      if (!inc || inc.call_id !== callId) return
      void services.callAccept(callId, inc.from_fp)
        .then(() => callManager.acceptInbound(callId, (inc.kind as any) ?? 'voice', (selConv ?? callId), inc.from_fp, inc.nickname))
        .then(() => { markCallHandled(callId); setIncomingCall(null); sfxRingStop(); sfxCallConnect() })
        .catch((e: any) => setError(String(e?.message ?? e)))
      return
    }
    if (action === 'reject') {
      const inc = incomingCall
      if (inc && inc.call_id === callId) {
        markCallHandled(callId)
        endCallNotice(callId)
        callManager.rejectIncoming(callId, inc.from_fp)
        setIncomingCall(null)
        sfxRingStop()
      }
      return
    }
    // "open": só trouxe o app à frente — a UI já mostra o modal de atender.
  }), [incomingCall, selConv])

  const selPeer: PeerView | null = selPeerFp ? peers.find(p => p.fp === selPeerFp) ?? null : null
  const selConvObj = conversations.find(c => c.id === selConv) ?? null
  const peerTitle = selConvObj?.title || selPeer?.nickname || selPeer?.fp || ''
  const ehGrupo = selConvObj?.kind === 'group'

  // Roster do grupo: pergunta ao MOTOR (SQLite) sempre que a conversa muda e
  // quando chega `group_synced`. O contador antigo lia uma chave de
  // `localStorage` que só existe no modo navegador — no app nativo dava sempre 0.
  useEffect(() => {
    if (!selConv || !ehGrupo) { setGroupMemberCount(0); return }
    let vivo = true
    const ler = async () => {
      try {
        const mems = await services.groupMembers(selConv)
        if (vivo) setGroupMemberCount(mems.length)
      } catch { if (vivo) setGroupMemberCount(0) }
    }
    void ler()
    const off = services.subscribe((ev) => {
      if (ev.type === 'group_synced') void ler()
    })
    return () => { vivo = false; off() }
  }, [selConv, ehGrupo])
  // PRESENÇA HONESTA: "online" é SÓ sessão estabelecida (verde). CONECTANDO/
  // RECONECTANDO são bolinha amarela e NÃO aparecem em "AMIGOS ONLINE" —
  // era o bug de "aparecia online sem estar" (amarelo listado como online).
  const onlinePeers = peers.filter(p => p.state === 'CONNECTED')
  const activeComm = view === 'servidores' && selCommunity ? communities.find(c => c.id === selCommunity) ?? null : null
  const mergedChannelsForLabel = (() => {
    if (!activeComm) return [] as { id: string; name: string }[]
    const base = activeComm.channels.map(([id, name]) => {
      const ov = extraChannels.find(c => c.id === id)
      return ov ? { id: ov.id, name: ov.name } : { id, name }
    })
    const extras = extraChannels.filter(ec => !activeComm.channels.some(([id]) => id === ec.id)).map(c => ({ id: c.id, name: c.name }))
    return [...base, ...extras]
  })()
  const channelLabel = mergedChannelsForLabel.find(c => c.id === selConv)?.name ?? (activeComm?.channels.find(([cid]) => cid === selConv)?.[1] ?? 'canal')
  const onlineFps = new Set(onlinePeers.map(p => p.fp))
  const shownFriends = friendsTab === 'online'
    ? friendsAccepted.filter(f => onlineFps.has(f.fp) && socialPresence[f.fp] !== 'invisible')
    : friendsAccepted
  // Suporte a chamadas: 'full' = WebRTC direto, 'none' = sem WebRTC neste
  // aparelho. Não existe mais o modo áudio-via-relay: sem WebRTC a chamada
  // falha honesto em vez de degradar para um caminho de latência alta.
  // Os botões NUNCA são hard-disabled:
  // este check é um snapshot de render e o WebView pode ganhar WebRTC/permissão
  // depois (ou perder por um instante). Botão morto sem feedback deixava o
  // usuário sem clique E sem diagnóstico — o clique mostra o motivo real.
  // `detectNativeVoice()` é ASSÍNCRONO (consulta o core Rust) e popula o cache
  // que `getCallsSupport()` lê. Sem esta re-renderização, o primeiro render
  // acontecia antes da resposta e o app se anunciava "indisponível" mesmo com a
  // voz nativa ativa — o botão ficava morto e o clique dava o erro errado.
  const [, forceCallsRefresh] = useState(0)
  useEffect(() => {
    let alive = true
    void detectNativeVoice()
      .catch(() => false)
      .then((ok) => {
        try { void services.webrtcReport(`detectNativeVoice=${ok} getCallsSupport=${getCallsSupport()}`) } catch { /* browser */ }
        return ok
      })
      .finally(() => { if (alive) forceCallsRefresh((n) => n + 1) })
    return () => { alive = false }
  }, [])
  const callsSupport = getCallsSupport()
  const callsOk = callsSupport !== 'none'
  const callsUnavailableDetail = callsSupport === 'none' ? getCallsUnavailableMessage() : CALLS_UNAVAILABLE_MSG

  async function openDm(p: { fp: string; nickname?: string }) {
    if (!p?.fp || p.fp.trim() === '') { setError('Selecione um amigo válido'); return }
    setError(null)
    try {
      const conv = await services.dmOpen(p.fp.trim(), (p.nickname || p.fp).trim())
      setSelPeerFp(p.fp.trim())
      setSelConv(conv.id)
      refreshConvos()
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  // T1: sem bloqueio global sending — permite digitar/enviar a proxima durante o envio.
  // So barra duplo-submit da MESMA tecla Enter em <300ms.
  //
  // A chave é a CONVERSA, não o relógio global. Antes era um único instante:
  // mandar para A e, em menos de 300ms, mandar para B DESCARTava o envio de B
  // sem aviso (o `return` acontece antes de limpar o input), e o Enter parecia
  // morto ao trocar de conversa. Duplo-submit é por conversa — é ela que repete.
  const lastSendByConvRef = useRef<{ conv: string; at: number }>({ conv: '', at: 0 })
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    // só autoscroll se já está perto do fim (não rouba scroll em histórico, igual Discord)
    const el = messagesScrollRef.current
    if (!el) { messagesEndRef.current?.scrollIntoView({ block: 'end' }); return }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, selConv])

  // Ao abrir conversa: limpa badge não-lido do servidor + limpa typing
  useEffect(() => {
    setTypingPeers({})
    if (!selConv) return
    const cid = communities.find(c => c.channels.some(([id]) => id === selConv))?.id
    if (cid) setUnreadServers(prev => {
      if (!prev.has(cid)) return prev
      const next = new Set(prev)
      next.delete(cid)
      return next
    })
  }, [selConv])

  // Fecha popovers do composer ao trocar de conversa — senão o emoji fica
  // aberto por cima de outro canal.
  useEffect(() => { setComposerMenu(false); setShowEmojiPicker(false); setActiveAutocomplete(null) }, [selConv])

  async function send() {
    const body = input.trim()
    if (!body || !selConv) return

    // Comando de barra: NÃO vai para a rede. Executa local e mostra a resposta
    // como mensagem real do autor — é o comportamento do Discord e evita gastar
    // largura de banda com texto que é resultado de um cálculo local.
    if (body.startsWith('/') && /^\/[A-Za-zÀ-ÿ][\w-]*(\s|$)/.test(body)) {
      setInput('')
      setActiveAutocomplete(null)
      const nowSlash = Date.now()
      const ans = await runSlash(body)
      const convIdSlash = selConv
      const cidSlash = communities.find(c => c.channels.some(([id]) => id === convIdSlash))?.id ?? null
      const meFpSlash = identity?.fingerprint ?? ''
      const tempSlash: StoredMessage = { id: `pending-cmd-${nowSlash}`, conv_id: convIdSlash, author_fp: meFpSlash, body, ts: nowSlash, sig: 'pending', direction: 'out', status: 'sending' }
      const ansMsg: StoredMessage = { id: `pending-ans-${nowSlash}`, conv_id: convIdSlash, author_fp: meFpSlash, body: ans, ts: nowSlash + 1, sig: 'pending', direction: 'out', status: 'sending' }
      append(tempSlash); append(ansMsg)
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 30)
      try {
        if (cidSlash) {
          const r1 = await services.sendChannelMessage(cidSlash, convIdSlash, body)
          replaceOptimistic(tempSlash.id, r1)
        } else {
          const r1 = await services.messageSend(convIdSlash, body)
          replaceOptimistic(tempSlash.id, r1)
        }
      } catch { /* o comando local já respondeu; a falha de rede não apaga nada */ }
      return
    }

    const now = Date.now()
    const convId = selConv
    // Antiduplo-SUBMIT por conversa (ver `lastSendByConvRef`): mandar para outra
    // pessoa no mesmo segundo não pode ser engolido.
    if (lastSendByConvRef.current.conv === convId && now - lastSendByConvRef.current.at < 300) return
    lastSendByConvRef.current = { conv: convId, at: now }
    // `selCommunity` sobrevive à abertura de DM (só a aba "amigos" o limpa),
    // então ele não é prova de que a conversa selecionada é um canal. O
    // membership real é a única fonte: mandar num id de DM com community setado
    // produzia "canal inexistente" para toda mensagem escrita numa conversa
    // privada depois de visitar um servidor.
    const isChannelConv = !!selCommunity && communities.some(c =>
      c.id === selCommunity && c.channels.some(([cid]) => cid === selConv),
    )
    const communityId = isChannelConv ? selCommunity : null
    const myFp = identity?.fingerprint ?? ''
    const ts = Date.now()
    const tempId = `pending-${ts}`
    // T1 eco otimista: monta StoredMessage local e append IMEDIATO + limpa input na hora.
    const optimistic: StoredMessage = { id: tempId, conv_id: convId, author_fp: myFp, body, ts, sig: 'pending', direction: 'out', status: 'sending' }
    append(optimistic)
    setInput('')
    setError(null)
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 30)
    try {
      const m = communityId
        ? await services.sendChannelMessage(communityId, convId, body)
        : await services.messageSend(convId, body)
      // Substitui o otimista pelo definitivo (match por tempId; fallback body+ts proximo no hook).
      replaceOptimistic(tempId, m)
      if (replyTo) {
        // resposta: liga a mensagem nova à citada (meta persistida + difusão P2P)
        services.reply(convId, m.id, replyTo.id).catch(() => {})
        setReplyTo(null)
      }
      if (!communityId) refreshConvos()
      // força scroll imediato
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 50)
    } catch (e: any) {
      // Em erro marca failed com botao reenviar — nao some com o texto (fica no balao).
      failOptimistic(tempId)
      setError(String(e?.message ?? e))
    }
  }

  async function resendMessage(m: StoredMessage) {
    if (!m.conv_id) return
    patchStatus(m.id, 'sending')
    setError(null)
    // resolve a comunidade pela PRÓPRIA mensagem, não pelo estado da UI: a
    // falha original pode ter vindo de outro canal, e o reenvio não pode
    // herdar o mesmo `selCommunity` que a recusou.
    const cid = communities.find(c => c.channels.some(([id]) => id === m.conv_id))?.id ?? null
    try {
      const fresh = cid
        ? await services.sendChannelMessage(cid, m.conv_id, m.body)
        : await services.messageSend(m.conv_id, m.body)
      replaceOptimistic(m.id, fresh)
      if (!cid) refreshConvos()
    } catch (e: any) {
      patchStatus(m.id, 'failed')
      setError(String(e?.message ?? e))
    }
  }

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // O autocompletar (@menção, :emoji:, /comando) tem prioridade sobre enviar.
    if (autocompleteItems.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAutocompleteIdx(i => Math.min(i + 1, autocompleteItems.length - 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAutocompleteIdx(i => Math.max(i - 1, 0)); return }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        applyAutocomplete(autocompleteItems[autocompleteIdx])
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); setAutocompleteIdx(-1); setActiveAutocomplete(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  // ---------- composer: formatação, autocompletar, emoji ----------
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  // o MessageList expõe reloadPolls() para o shell forçar a releitura das
  // enquetes do canal logo após criar uma (o efeito interno só reage a
  // mensagens novas e a eventos de enquete, que o browser não emite).
  const msgListRef = useRef<MessageListHandle | null>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [composerMenu, setComposerMenu] = useState(false)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0)
  const [activeAutocomplete, setActiveAutocomplete] = useState<{ kind: 'mention' | 'emoji' | 'slash'; query: string; start: number; end: number } | null>(null)
  const [serverEmojiMap, setServerEmojiMap] = useState<Record<string, string>>({})

  // Membros da comunidade atual (para @menção e lista de membros).
  const communityMembers = useMemo<{ fp: string; nickname: string }[]>(() => {
    if (!activeComm) return []
    return (activeComm.members ?? []).map(([fp, nick]) => ({ fp, nickname: nick || nameOfFp(fp) }))
  }, [activeComm, socialProfiles, peers])

  // Comandos de barra REAIS: cada um roda localmente e devolve texto.
  // Nenhum depende de servidor — é o que um app P2P honesto pode oferecer.
  const slashCommands = useMemo(() => [
    { name: 'ajuda', summary: 'lista os comandos', run: async () => 'Comandos: ' + SLASH_BASE.map(c => '/' + c.name).join(', ') },
    { name: 'ping', summary: 'mede o tempo de resposta', run: async () => `🏓 pong — ${Math.max(1, Date.now() - slashPingAt.current)} ms` },
    { name: 'hora', summary: 'mostra a hora atual', run: async () => `🕐 ${new Date().toLocaleString('pt-BR')}` },
    { name: 'uptime', summary: 'há quanto tempo estou online', run: async () => `⏱ no ar há ${fmtShortDuration(Date.now() - bootAt.current)}` },
    { name: 'meu-fp', summary: 'mostra meu fingerprint', run: async () => `🔑 ${identity?.fingerprint ?? '?'}` },
    { name: 'meu-status', summary: 'mostra minha presença', run: async () => `🟢 status: ${identity ? socialPresence[identity.fingerprint] ?? 'online' : 'online'}` },
    { name: 'membros', summary: 'conta os membros do servidor', run: async () => `👥 ${communityMembers.length} membro(s) neste servidor` },
    { name: 'canais', summary: 'lista os canais', run: async () => 'Canais: ' + (extraChannels.map(c => '#' + c.name).join(', ') || 'nenhum') },
  ], [identity, communityMembers, extraChannels, selCommunity, socialPresence])

  const slashPingAt = useRef(Date.now())
  const bootAt = useRef(Date.now())

  // Executa um comando de barra e devolve o texto da resposta.
  const runSlash = useCallback(async (line: string): Promise<string> => {
    const trimmed = line.trim()
    const sp = trimmed.indexOf(' ')
    const name = (sp === -1 ? trimmed.slice(1) : trimmed.slice(1, sp)).toLowerCase()
    const args = sp === -1 ? '' : trimmed.slice(sp + 1)
    const cmd = slashCommands.find(c => c.name === name)
    if (!cmd) return `❌ comando desconhecido: /${name} — use /ajuda`
    if (name === 'ping') slashPingAt.current = Date.now()
    if (name === 'roll' || name === 'dado') {
      const n = Number(args) || 6
      if (n < 2 || n > 1000) return '❌ use /dado <2-1000>'
      return `🎲 saiu ${1 + Math.floor(Math.random() * n)} (d${n})`
    }
    try { return await (cmd.run as (a: string) => Promise<string>)(args) } catch (e: any) { return `❌ ${String(e?.message ?? e)}` }
  }, [slashCommands])

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

  // Candidatos do autocompletar. Recalculado só quando o token ou o contexto muda.
  const autocompleteItems = useMemo<AutoItem[]>(() => {
    const tok = activeAutocomplete
    if (!tok) return []
    const q = tok.query.toLowerCase()
    if (tok.kind === 'mention') {
      const out: AutoItem[] = []
      if (!q || 'everyone'.startsWith(q)) out.push({ key: 'm-everyone', kind: 'mention', label: 'everyone', hint: 'menciona todos do servidor', color: t.accent, insert: '@everyone ' })
      if (!q || 'here'.startsWith(q)) out.push({ key: 'm-here', kind: 'mention', label: 'here', hint: 'menciona quem está online', color: t.accent, insert: '@here ' })
      for (const r of roles.filter(r => r.mentionable !== false)) {
        if (!q || r.name.toLowerCase().includes(q)) out.push({ key: `m-r-${r.id}`, kind: 'mention', label: r.name, hint: 'cargo', color: r.color || t.accent, insert: `@${r.name} ` })
      }
      const seen = new Set<string>()
      for (const p of peers) {
        const nm = p.nickname || p.fp
        if (seen.has(nm)) continue
        if (q && !nm.toLowerCase().includes(q) && !p.fp.startsWith(q)) continue
        seen.add(nm)
        out.push({ key: `m-p-${p.fp}`, kind: 'mention', label: nm, hint: p.fp.slice(0, 12), fp: p.fp, insert: `@${nm} ` })
      }
      for (const m of communityMembers) {
        const nm = m.nickname || m.fp
        if (seen.has(nm)) continue
        if (q && !nm.toLowerCase().includes(q) && !m.fp.startsWith(q)) continue
        seen.add(nm)
        out.push({ key: `m-c-${m.fp}`, kind: 'mention', label: nm, hint: 'membro', fp: m.fp, insert: `@${nm} ` })
      }
      return out.slice(0, 12)
    }
    if (tok.kind === 'emoji') {
      const out: AutoItem[] = []
      for (const [name, glyph] of Object.entries(serverEmojiMap)) {
        if (!q || name.toLowerCase().includes(q)) out.push({ key: `e-${name}`, kind: 'emoji', label: name, glyph, insert: `:${name}: ` })
      }
      for (const e of NAMED_EMOJI) {
        if (!q || e.names.some(n => n.includes(q))) out.push({ key: `e-u-${e.char}`, kind: 'emoji', label: e.names[0], glyph: e.char, insert: e.char })
        if (out.length >= 24) break
      }
      return out.slice(0, 24)
    }
    // slash: comandos reais disponíveis agora
    return slashCommands
      .filter(c => !q || c.name.toLowerCase().includes(q))
      .map(c => ({ key: `s-${c.name}`, kind: 'slash' as const, label: c.name, hint: c.summary, insert: `/${c.name} ` }))
      .slice(0, 12)
  }, [activeAutocomplete, roles, peers, communityMembers, serverEmojiMap, slashCommands])

  useEffect(() => { setAutocompleteIdx(0) }, [activeAutocomplete?.query, activeAutocomplete?.kind])

  function onComposerChange(v: string) {
    setInput(v)
    const ta = composerRef.current
    const caret = ta ? ta.selectionStart : v.length
    setActiveAutocomplete(activeToken(v, caret))
    // typing efêmero throttled 2s (igual Discord)
    const now = Date.now()
    if (selConv && now - lastTypingSent.current > 2000 && v.trim()) {
      lastTypingSent.current = now
      services.sendTyping?.(selConv).catch(() => {})
    }
  }

  // O auto-resize vivia só no onChange, então limpar o campo depois de enviar
  // (setInput(''), que não passa pelo onChange) deixava a caixa com a altura
  // que a mensagem multi-linha tinha criado — o composer ficava gigante para
  // sempre. Sincroniza em qualquer mudança de `input`, inclusive automática.
  useEffect(() => {
    const ta = composerRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`
  }, [input])

  function applyAutocomplete(it: AutoItem | undefined) {
    if (!it || !activeAutocomplete) return
    const { start, end } = activeAutocomplete
    setInput(prev => prev.slice(0, start) + it.insert + prev.slice(end))
    setActiveAutocomplete(null)
    requestAnimationFrame(() => {
      const ta = composerRef.current
      if (!ta) return
      const p = start + it.insert.length
      ta.focus()
      ta.setSelectionRange(p, p)
    })
  }

  function wrapComposer(mode: FormatMode) {
    const ta = composerRef.current
    const start = ta ? ta.selectionStart : input.length
    const end = ta ? ta.selectionEnd : input.length
    const r = applyFormat(input, start, end, mode)
    setInput(r.text)
    setActiveAutocomplete(null)
    requestAnimationFrame(() => {
      ta?.focus()
      ta?.setSelectionRange(r.caret, r.caret)
    })
  }

  // Ctrl/Cmd+E abre o emoji; Ctrl/Cmd+B/I/U formatam (como no Discord).
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!selConv) return
      const mod = e.ctrlKey || e.metaKey
      if (!mod) return
      const k = e.key.toLowerCase()
      const fmt: Record<string, FormatMode> = { b: 'bold', i: 'italic', u: 'under' }
      if (fmt[k]) { e.preventDefault(); wrapComposer(fmt[k]); return }
      if (k === 'e') { e.preventDefault(); setComposerMenu(v => !v); setShowEmojiPicker(false) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [input, selConv, activeAutocomplete])

  // --- helpers CALL idêntico Discord ---
  function fmtDuration(s: number) {
    const m = Math.floor(s / 60).toString().padStart(2, '0')
    const sec = (s % 60).toString().padStart(2, '0')
    return `${m}:${sec}`
  }
  async function startCall(kind: 'voice' | 'video') {
    if (callActionBusy) return
    if (!selConv) return
    const conv = conversations.find(c => c.id === selConv)
    const isGroup = conv?.kind === 'group'
    let fps: string[] = []
    if (isGroup) {
      try { const mems = await services.groupMembers(selConv); fps = mems.map(([fp]) => fp).filter(fp => fp !== identity?.fingerprint) } catch { /* silent */ }
    } else if (selPeerFp) fps = [selPeerFp]
    else if (conv?.peer_fp) fps = [conv.peer_fp]
    if (fps.length === 0) { setError('selecione um amigo ou crie um grupo'); return }
    // Rota única: WebRTC direto (host/STUN/TURN) ou erro honesto dizendo o
    // que falta neste aparelho.
    if (!callsOk) { setError(getCallsUnavailableMessage()); return }
    if (activeCall) { setError('já existe uma chamada em andamento'); return }
    setCallActionBusy(true)
    try { await callManager.start(kind, selConv, fps) } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setCallActionBusy(false) }
  }
  async function handleIncomingAccept() {
    if (!incomingCall || callActionBusy) return
    // Sem WebRTC: mostra o que falta em vez de aceitar uma chamada muda.
    if (!callsOk) { setError(getCallsUnavailableMessage()); return }
    // O ring SÓ para quando o aceite de fato sucedeu — antes o catch deixava
    // o overlay parado no limbo, sem ring e sem chamada.
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
    } finally {
      setCallActionBusy(false)
    }
  }

  function handleIncomingReject() {
    if (!incomingCall) return
    sfxRingStop()
    markCallHandled(incomingCall.call_id)
    endCallNotice(incomingCall.call_id)
    callManager.rejectIncoming(incomingCall.call_id, incomingCall.from_fp)
    setIncomingCall(null)
  }
  async function createGroupNow() {
    if (groupPick.size === 0) return
    try {
      const conv = await services.createGroup(groupTitle || 'Grupo', [...groupPick])
      setShowCreateGroup(false); setGroupTitle(''); setGroupPick(new Set()); refreshConvos(); setSelConv(conv.id); setSelPeerFp(null)
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }
  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    try {
      const sf = await fileSwarm.shareFile(f)
      setFileList([...fileSwarm.files.values()])
      // envia mensagem com attachment info (hash) para swarm — todos que têm o arquivo semeiam
      if (selConv) {
        const body = encodeFileBody(sf)
        // mesmo critério do envio de texto: só communityId se selConv for um
        // canal DELE. Ver comentário em `send()`.
        const chCid = selCommunity && communities.some(c =>
          c.id === selCommunity && c.channels.some(([cid]) => cid === selConv),
        ) ? selCommunity : null
        try {
          const m = chCid
            ? await services.sendChannelMessage(chCid, selConv, body)
            : await services.messageSend(selConv, body)
          append(m)
          refreshConvos()
        } catch (err: any) { setError(String(err?.message ?? err)) }
      }
    } catch (err: any) { setError(String(err?.message ?? err)) }
    e.target.value = ''
  }

  const [friendSuccess, setFriendSuccess] = useState<string | null>(null)
  const [pendingOut, setPendingOut] = useState<{fp:string,nickname:string}[]>([])

  async function addFriend() {
    if (!friendFpInput.trim()) return
    setError(null); setFriendSuccess(null)
    try {
      const res: any = await services.friendRequest(friendFpInput.trim())
      setFriendFpInput('')
      if (res === 'sent' || res === undefined) setFriendSuccess('Solicitação enviada! Aguardando aceitação.')
      else if (res === 'queued_offline') setFriendSuccess('Peer offline — solicitação enfileirada e será enviada ao reconectar.')
      else setFriendSuccess('Solicitação enviada.')
      refreshFriends()
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  async function respondFriend(fp: string, accept: boolean) {
    try { await services.friendRespond(fp, accept); refreshFriends() }
    catch (e: any) { setError(String(e?.message ?? e)) }
  }

  function openServer(id: string, firstChannel: string | null) {
    setView('servidores')
    setSelCommunity(id)
    setSelConv(firstChannel)
    setSelPeerFp(null)
    setServerMenuOpen(false)
    setUnreadServers(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  /**
   * Token de convite ABERTO do servidor selecionado.
   *
   * Antes esta função passava `identity.fingerprint` como `member_fp` e, no
   * `catch`, devolvia o ID do servidor como se fosse token. Os dois erros
   * juntos explicam o sintoma "o token nunca funciona": o convite ficava
   * preso ao fingerprint de quem gerou (o convidado recebia "convite é para
   * outro fingerprint") e, quando a geração falhava, a UI copiava um id que
   * nem base64 é.
   *
   * Agora: sem `memberFp` = convite aberto, e erro é erro (sem fallback
   * mentiroso). Quem não é dono recebe a mensagem do core.
   */
  // O `InvitePanel` (dentro do modal) gera, mostra e copia o convite — ele é a
  // fonte única. Aqui só abrimos o modal: gerar um token antes criava um
  // segundo convite que ninguém lia, e era isso que deixava o botão "Convidar"
  // assinando um token diferente do que o painel mostrava.
  function openInviteModal() {
    if (!selCommunity) return
    setServerMenuOpen(false)
    setInviteTokenError(null)
    setShowInvite(true)
  }

  /** Atalho do menu do servidor: copia um convite sem abrir o modal. */
  async function copyServerToken() {
    if (!selCommunity) return
    setServerMenuOpen(false)
    try {
      const tok = await services.makeInvite(selCommunity)
      const ok = await copyText(tok)
      if (ok) setNotice('Token copiado — envie por qualquer mensageiro')
      else {
        // Sem permissão de clipboard: abre o painel, que tem o token e um botão
        // de copiar próprio. Não inventamos "copiado".
        setShowInvite(true)
        setError('não foi possível copiar automaticamente — copie o token do painel')
      }
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  // v6: o modelo é escolhido DENTRO do assistente; aqui só abrimos o passo 'create'.

  // v6: criação legada removida — o CreateServerWizard (raiz) cria com
  // canais/cargos/meta/regras via services.createCommunity(name, nomes, opts).

  function closeServerModal() {
    setShowCreateServer(false)
    setServerFlow('choose')
    setInviteFromLink(null)
  }

  // ----------efeitos da camada social ----------
  useEffect(() => {
    if (phase !== 'app') return
    let alive = true
    const load = () => {
      services.profileList().then(p => { if (alive) setSocialProfiles(Object.fromEntries((p as any[]).map(x => [x.fp, x]))) }).catch(() => {})
      services.presenceList().then(p => { if (alive) setSocialPresence(Object.fromEntries((p as any[]).map(x => [x.fp, x.status]))) }).catch(() => {})
    }
    load()
    const h = window.setInterval(load, 15000)
    return () => { alive = false; window.clearInterval(h) }
  }, [phase])

  // eventos do motor que mudam a camada social
  useEffect(() => {
    return services.subscribe((ev: any) => {
      if (ev.type === 'profile_changed') setSocialProfiles(p => ({ ...p, [ev.fp]: ev.profile }))
      else if (ev.type === 'presence_changed') setSocialPresence(p => ({ ...p, [ev.fp]: ev.status }))
      else if (ev.type === 'muted') setNotice(ev.reason)
      else if (ev.type === 'moderation_applied') setNotice(`Moderação: ${ev.kind} aplicado a ${String(ev.target_fp).slice(0, 8)}${ev.reason ? ` — ${ev.reason}` : ''}`)
    })
  }, [selCommunity])

  // Apelidos por servidor: `fp → apelido naquele servidor`. O motor é a
  // fonte da verdade; a UI só espelha. Sem isto o `nicknameSet` grava no
  // banco e NUNCA aparece — o nome vinha do objeto da comunidade.
  // `members` é `[fp, nickname, role]`, então o espelho é direto.
  const serverNicks = useMemo<Record<string, string>>(() => {
    const next: Record<string, string> = {}
    for (const m of (activeComm?.members ?? []) as [string, string, string][]) {
      if (m[0] && m[1]) next[m[0]] = m[1]
    }
    return next
  }, [activeComm?.members])

  const nameOfFp = (fp: string): string => {
    if (fp === identity?.fingerprint) return identity?.nickname ?? 'você'
    // apelido deste servidor tem precedência sobre tudo
    const sn = serverNicks[fp]
    if (sn) return sn
    const c = communities.find(x => x.owner_fp === fp)
    if (c) return c.name
    const f = peers.find(p => p.fp === fp)
    const nick = f?.nickname || (socialProfiles[fp]?.display_name ?? '')
    return nick || String(fp).slice(0, 8)
  }

  async function createThreadFrom(m: StoredMessage) {
    if (!selCommunity || !selConv) { setError('threads são de servidor — abra um canal de comunidade'); return }
    try {
      const t = await services.threadCreate(selCommunity, selConv, m.body.slice(0, 40) || 'thread')
      setOpenThread(t)
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  const commands: Command[] = useMemo(() => {
    const list: Command[] = []
    for (const c of conversations) {
      list.push({ id: c.id, label: `Ir para ${c.title || c.id.slice(0, 8)}`, group: 'conversa', run: () => { setSelConv(c.id); setSelPeerFp(c.peer_fp || null) } })
    }
    if (selCommunity) {
      for (const ch of extraChannels) {
        if (!ch.id) continue
        list.push({ id: ch.id, label: `Ir para #${ch.name}`, group: 'canal', run: () => setSelConv(ch.id) })
      }
      list.push({ id: 'mod', label: 'Abrir moderação do servidor', group: 'servidor', run: () => setShowModeration(true) })
      list.push({ id: 'ev', label: 'Eventos agendados', group: 'servidor', run: () => setShowEvents(true) })
      list.push({ id: 'cfg', label: 'Configurar este canal (slowmode/emoji)', group: 'servidor', run: () => setShowChannelCfg(true) })
      list.push({ id: 'poll', label: 'Criar enquete neste canal', group: 'servidor', run: () => setShowPollForm(true) })
    }
    list.push({ id: 'me', label: 'Meu perfil / status', group: 'perfil', run: () => setProfileFp(identity?.fingerprint ?? '') })
    list.push({ id: 'search', label: 'Buscar mensagens', hint: 'Ctrl+F', group: 'navegar', run: () => setShowSearch(true) })
    list.push({ id: 'pins', label: 'Mensagens fixadas', hint: 'Ctrl+Shift+P', group: 'navegar', run: () => setShowPins(true) })
    list.push({ id: 'shortcuts', label: 'Ver atalhos de teclado', group: 'ajuda', run: () => setShowShortcuts(true) })
    // Presença pelo estado central: com a janela fechada, "online" cai para
    // "ausente" sozinho (conexão ≠ presença).
    list.push({ id: 'on', label: 'Ficar online', group: 'presença', run: () => setDesiredPresence('online') })
    list.push({ id: 'idle', label: 'Ficar ausente', group: 'presença', run: () => setDesiredPresence('idle') })
    list.push({ id: 'dnd', label: 'Não perturbe', group: 'presença', run: () => setDesiredPresence('dnd') })
    list.push({ id: 'inv', label: 'Ficar invisível', group: 'presença', run: () => setDesiredPresence('invisible') })
    return list
  }, [conversations, selCommunity, extraChannels, identity])

  const [showShortcuts, setShowShortcuts] = useState(false)

  useShortcuts({
    cmdk: () => setShowCmdK(true),
    search: () => setShowSearch(s => !s),
    pins: () => setShowPins(s => !s),
    inbox: () => setShowInbox(s => !s),
    bookmarks: () => setShowBookmarks(s => !s),
    escape: () => { setShowSearch(false); setShowPins(false); setShowCmdK(false); setShowInbox(false); setShowBookmarks(false) },
    mute: () => { try { callManager.toggleMute() } catch { /* noop */ } },
    next: () => { const i = conversations.findIndex(c => c.id === selConv); const nx = conversations[(i + 1) % Math.max(1, conversations.length)]; if (nx) { setSelConv(nx.id); setSelPeerFp(nx.peer_fp || null) } },
    prev: () => { const i = conversations.findIndex(c => c.id === selConv); const pv = conversations[(i - 1 + conversations.length) % Math.max(1, conversations.length)]; if (pv) { setSelConv(pv.id); setSelPeerFp(pv.peer_fp || null) } },
  })

  // marca a conversa como lida quando chega no fim
  useEffect(() => {
    if (selConv && messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last.direction === 'in') services.readSet(selConv, last.ts).catch(() => { /* ignore */ })
    }
  }, [selConv, messages.length])

  async function doForward() {
    if (!forwardMsg || !forwardTarget) return
    try {
      const isChannel = forwardTarget.startsWith('ch:')
      const target = isChannel ? forwardTarget.slice(3) : forwardTarget
      await services.forward(forwardMsg.id, target, isChannel ? target : '', isChannel ? `#canal` : 'DM')
      setForwardMsg(null); setForwardTarget('')
      setNotice('Mensagem encaminhada')
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  async function createPoll() {
    if (!selCommunity || !selConv || !newPollQ.trim()) return
    const opts = newPollOpts.split('\n').map(x => x.trim()).filter(Boolean)
    if (opts.length < 2) { setError('enquete precisa de 2+ opções (uma por linha)'); return }
    try {
      await services.pollCreate(selCommunity, selConv, newPollQ.trim(), opts, false, Date.now() + 86400000)
      setNewPollQ(''); setNewPollOpts(''); setShowPollForm(false)
      setNotice('enquete criada')
      // O MessageList so recarrega as enquetes quando chega mensagem ou chega
      // evento de enquete; o backend de browser não emite esse evento, então
      // damos um toque para a lista aparecer na hora.
      msgListRef.current?.reloadPolls()
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  // ATUALIZAÇÃO ANTES DE ENTRAR — o gate roda em paralelo com o boot e só
  // aparece quando há versão nova de verdade (ver `components/UpdateGate.tsx`).
  const updateGate = useUpdateGate(true)

  if (phase === 'loading') return (<><UpdateBootScreen api={updateGate} fallback={<BootScreen />} /><UpdateOverlay api={updateGate} /></>)
  if (phase === 'create') return <CreateAccount onDone={(id) => { setIdentity(id); setPhase('app'); refreshNet(); refreshFriends() }} />
  if (phase === 'lock') return <LockScreen nickname={identity?.nickname ?? ''} onUnlock={(id) => { setIdentity(id); setPhase('app'); refreshNet(); refreshFriends() }} />

  const railStyle: any = {
    width: 72, background: railBg, borderRight: `1px solid ${borderColor}`,
    display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0', gap: 8, flexShrink: 0,
  }

  // Pill de rede HONESTA: motor ativo = ONLINE (mesmo sem peers — você está
  // motor acessível = ONLINE mesmo sem peers; null = INICIANDO (não OFFLINE falso)
  // Paridade Discord: pill só aparece com ?debug — status vai pro tooltip do avatar.
  const showNet = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug')
  const netPill = (st: typeof status) => {
    if (!showNet) return null
    const native = services.kind === 'native'
    const listening = (st?.listen_port ?? 0) > 0
    const state = st?.state ?? null
    const count = st?.online_peers ?? 0
    if (!native) {
      const tip = 'modo navegador (dev) — sem motor de rede; rode o app nativo para P2P real'
      return (
        <span title={tip} style={{ display: 'flex', alignItems: 'center', gap: 6, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 99, padding: '4px 10px', fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: muted }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.accent }} />LOCAL
        </span>
      )
    }
    if (state === null) {
      return (
        <span title="iniciando motor P2P..." style={{ display: 'flex', alignItems: 'center', gap: 6, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 99, padding: '4px 10px', fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: muted }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.yellow, animation: 'pulse 1s infinite' }} />INICIANDO…
        </span>
      )
    }
    // Honesta: verde só com ≥1 peer Online real. Nó ouvindo sem peers é
    // "nó no ar", não ONLINE — separa acessibilidade de alcance real.
    const hasPeers = count > 0
    const online = hasPeers && (state === 'CONNECTED' || state === 'DISCONNECTED')
    const color = online ? t.green : state === 'DISCONNECTED' ? '#80848e' : t.yellow
    const label = online ? 'ONLINE' : stateLabel[state as NetworkState]
    // CONTAGEM DE PESSOAS ONLINE NA REDE.
    //
    // É o total de peers com sessão viva (amigos E membros de servidor), não
    // "amigos online": o pedido é "quantas pessoas estão online na rede". O
    // tooltip separa as duas coisas para ninguém achar que o número é a lista
    // de amigos. Com 0 o número aparece: "0" é informação honesta, não sumiço.
    const tip = !hasPeers && listening
        ? `Nó no ar em :${st?.listen_port} — 0 pessoas online na rede; adicione amigo pelo fingerprint`
        : `${count} ${count === 1 ? 'pessoa online' : 'pessoas online'} na rede`
    return (
      <span title={tip} style={{ display: 'flex', alignItems: 'center', gap: 6, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 99, padding: '4px 10px', fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: muted }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: online && native ? `0 0 6px ${t.green}` : 'none' }} />
        {label} · {count}
      </span>
    )
  }

  const emptyBlock = (msg: string, sub?: string) => (
    <div style={{ padding: '24px 12px', textAlign: 'center', color: muted }}>
      <div style={{ fontSize: 12, opacity: 0.9 }}>{msg}</div>
      {sub && <div style={{ fontSize: 11, marginTop: 6, opacity: 0.7 }}>{sub}</div>}
    </div>
  )

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: bg, color: text, fontFamily: 'Inter', ['--sidebar' as any]: sidebarBg } as any}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={railStyle} className="hide-mobile">
          {/* Botão home (DMs / Amigos) */}
          <div className="rail-item">
            <span className={'rail-pill' + (view === 'amigos' && !selCommunity ? ' on' : '')} />
            <button
              onClick={() => { setView('amigos'); setSelCommunity(null); setSelConv(null); setSelPeerFp(null); setServerMenuOpen(false) }}
              title="Amigos"
              className={'rail-btn' + (view === 'amigos' && !selCommunity ? ' active' : '')}
              style={{ background: view === 'amigos' && !selCommunity ? t.accent : inputBg, color: '#fff' }}
            >
              <Icon d={Icons.users} size={20} />
            </button>
          </div>
          <div style={{ width: 32, height: 2, background: '#35363c', borderRadius: 99, margin: '4px 0' }} />
          {(() => {
            const railBtn = (c: CommunityView) => {
              const active = view === 'servidores' && selCommunity === c.id
              const mutedSrv = isMutedServer(c.id)
              const unread = !mutedSrv && unreadServers.has(c.id)
              return (
                <div key={c.id} className="rail-item">
                  <span className={'rail-pill' + (active ? ' on' : unread ? ' dot' : '')} />
                  <button
                    onClick={() => openServer(c.id, c.channels[0]?.[0] ?? null)}
                    onContextMenu={e => { e.preventDefault(); setRailMenu({ x: e.clientX, y: e.clientY, serverId: c.id }) }}
                    title={c.name + (mutedSrv ? ' (silenciado)' : '')}
                    className={'rail-btn' + (active ? ' active' : '')}
                    style={{ background: avatarColor(c.id), opacity: !active && mutedSrv ? 0.55 : 1 }}
                  >
                    {(c.name || '?').charAt(0).toUpperCase()}
                  </button>
                  {!active && !mutedSrv && (unreadMap[c.id] || 0) > 0 && <span className="rail-badge">{unreadMap[c.id]}</span>}
                </div>
              )
            }
            const grouped = new Set(prefs.serverFolders.flatMap(f => f.servers))
            const loose = communities.filter(c => !grouped.has(c.id))
            return (
              <>
                {prefs.serverFolders.map(f => {
                  const items = f.servers.flatMap(id => { const c = communities.find(x => x.id === id); return c ? [c] : [] })
                  if (items.length === 0) return null
                  return (
                    <div key={f.id} style={{ background: 'rgba(0,0,0,.22)', borderRadius: 12, padding: '6px 0', margin: '2px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                      <span style={{ fontSize: 9, fontWeight: 800, color: muted, maxWidth: 52, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.name}>{f.name}</span>
                      {items.map(railBtn)}
                    </div>
                  )
                })}
                {loose.map(railBtn)}
              </>
            )
          })()}
          <button
            onClick={() => { setShowCreateServer(true); setServerFlow('choose') }}
            title="Adicionar um servidor"
            className="rail-btn"
            style={{ background: inputBg, color: t.green }}
          >
            <Icon d={Icons.plus} size={18} />
          </button>
        </div>
        {railMenu && (() => {
          const sid = railMenu.serverId
          const srv = communities.find(c => c.id === sid)
          const cur = folderOf(sid)
          const mutedSrv = isMutedServer(sid)
          const item: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', color: text, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, fontWeight: 600 }
          return (
            <div onClick={() => { setRailMenu(null); setRailFolderName('') }} style={{ position: 'fixed', inset: 0, zIndex: 200 }} onContextMenu={e => { e.preventDefault(); setRailMenu(null) }}>
              <div onClick={e => e.stopPropagation()} style={{ position: 'fixed', left: Math.min(railMenu.x, window.innerWidth - 250), top: Math.min(railMenu.y, window.innerHeight - 320), width: 230, background: t.panel, border: `1px solid ${borderColor}`, borderRadius: 10, padding: 6, boxShadow: '0 12px 34px rgba(0,0,0,.5)' }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: muted, padding: '6px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{srv?.name ?? 'Servidor'}</div>
                <button onClick={() => { toggleMuteServer(sid); setRailMenu(null) }} style={item}>
                  <span style={{ display: 'flex', color: muted }}><Icon d={mutedSrv ? Icons.eye : Icons.eyeOff} size={14} /></span>
                  {mutedSrv ? 'Ativar notificações' : 'Silenciar servidor'}
                </button>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1, color: muted, padding: '8px 10px 4px' }}>PASTA</div>
                {prefs.serverFolders.map(f => (
                  <button
                    key={f.id}
                    onClick={() => { moveServerToFolder(sid, cur === f.id ? null : f.id); setRailMenu(null) }}
                    style={{ ...item, color: cur === f.id ? t.accent : text }}
                  >
                    <span style={{ display: 'flex', color: muted }}><Icon d={Icons.menu} size={14} /></span>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cur === f.id ? 'Tirar de ' : 'Mover para '}{f.name}</span>
                  </button>
                ))}
                <div style={{ display: 'flex', gap: 6, padding: '4px 6px' }}>
                  <input
                    value={railFolderName}
                    onChange={e => setRailFolderName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && railFolderName.trim()) { const id = addFolder(railFolderName.trim()); moveServerToFolder(sid, id); setRailFolderName(''); setRailMenu(null) } }}
                    placeholder="Nova pasta…"
                    aria-label="Nome da nova pasta"
                    style={{ flex: 1, minWidth: 0, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 6, padding: '7px 9px', color: text, fontSize: 12, outline: 'none' }}
                  />
                  <button
                    onClick={() => { if (!railFolderName.trim()) return; const id = addFolder(railFolderName.trim()); moveServerToFolder(sid, id); setRailFolderName(''); setRailMenu(null) }}
                    style={{ background: t.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '0 12px', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}
                  >Criar</button>
                </div>
                {(() => {
                  const f = prefs.serverFolders.find(x => x.servers.includes(sid))
                  if (!f) return null
                  return (
                    <>
                      <div style={{ display: 'flex', gap: 6, padding: '4px 6px' }}>
                        <input
                          defaultValue={f.name}
                          key={f.id + f.name}
                          onKeyDown={e => { if (e.key === 'Enter') { const el = e.target as HTMLInputElement; if (el.value.trim()) renameFolder(f.id, el.value.trim()); setRailMenu(null) } }}
                          placeholder="Renomear pasta…"
                          aria-label="Renomear pasta"
                          style={{ flex: 1, minWidth: 0, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 6, padding: '7px 9px', color: text, fontSize: 12, outline: 'none' }}
                        />
                      </div>
                      <button
                        onClick={() => {
                          if (window.confirm(`Apagar a pasta "${f.name}"? Os servidores voltam para a lista.`)) { removeFolder(f.id); setRailMenu(null) }
                        }}
                        style={{ ...item, color: '#ff9c9c' }}
                      >
                        <span style={{ display: 'flex' }}><Icon d={Icons.trash} size={14} /></span>Apagar pasta
                      </button>
                    </>
                  )
                })()}
              </div>
            </div>
          )
        })()}

        <div style={{ width: 260, background: sidebarBg, borderRight: `1px solid ${borderColor}`, display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          {view === 'servidores' && selCommunity ? (() => {
            const comm = communities.find(c => c.id === selCommunity)
            return (
              <>
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  <button onClick={() => setServerMenuOpen(v => !v)} className="server-head">
                    <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{comm?.name ?? 'Servidor'}</span>
                    <Icon d={Icons.chevron} size={14} />
                  </button>
                  {serverMenuOpen && (
                    <>
                      <div className="dd-overlay" onClick={() => setServerMenuOpen(false)} />
                      <div className="dd-menu">
                        <button className="dd-item invite" onClick={openInviteModal}>
                          <span style={{ display: 'flex' }}><Icon d={Icons.users} size={14} /></span> Convidar pessoas
                        </button>
                        <button className="dd-item" onClick={copyServerToken}>
                          <span style={{ display: 'flex' }}><Icon d={Icons.copy} size={14} /></span> Copiar token do servidor
                        </button>
                        {(() => { const isOwner = comm?.owner_fp === identity?.fingerprint; if (!isOwner) return null; return (
                          <>
                            <div style={{ height: 1, background: borderColor, margin: '6px 0' }} />
                            <button className="dd-item" onClick={() => { setServerMenuOpen(false); setShowServerSettings(true); setServerTab('canais') }}>
                              <span style={{ display: 'flex' }}><Icon d={Icons.hash} size={14} /></span> Gerenciar canais
                            </button>
                            <button className="dd-item" onClick={() => { setServerMenuOpen(false); setShowServerSettings(true); setServerTab('cargos') }}>
                              <span style={{ display: 'flex' }}><Icon d={Icons.users} size={14} /></span> Cargos
                            </button>
                            <button className="dd-item" onClick={() => { setServerMenuOpen(false); setShowServerSettings(true); setServerTab('bots') }}>
                              <span style={{ display: 'flex' }}><Icon d={Icons.bot} size={14} /></span> Bots
                            </button>
                            <button className="dd-item" onClick={() => { setServerMenuOpen(false); setShowServerSettings(true); setServerTab('geral') }}>
                              <span style={{ display: 'flex' }}><Icon d={Icons.settings} size={14} /></span> Configurações
                            </button>
                          </>
                        )})()}
                      </div>
                    </>
                  )}
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
                  {(() => {
                    if (!comm) return null
                    const base: ChannelMeta[] = (comm.channels ?? []).map(([id, name], idx) => {
                      const ov = extraChannels.find(c => c.id === id)
                      if (ov) return ov
                      return { id, name, category: idx === 0 && comm.channels.length > 3 ? 'CANAIS DE TEXTO' : 'CANAIS DE TEXTO', position: idx, kind: 'text' as const, topic: '' }
                    })
                    const extras = extraChannels.filter(ec => !(comm.channels ?? []).some(([id]) => id === ec.id))
                    const merged: ChannelMeta[] = [...base, ...extras].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                    const grouped: Record<string, ChannelMeta[]> = {}
                    merged.forEach(ch => {
                      const cat = (ch.category || 'CANAIS DE TEXTO').toUpperCase()
                      if (!grouped[cat]) grouped[cat] = []
                      grouped[cat].push(ch)
                    })
                    // ordem: manter GERAL / CANAIS DE TEXTO primeiro, depois alfabético igual screenshot
                    const order = ['ATENDIMENTO E SUPORTE', 'GERAL', 'CANAIS DE TEXTO', 'PROJETOS', 'DESIGN', 'TESTES']
                    const cats = Object.keys(grouped).sort((a, b) => {
                      const ia = order.indexOf(a), ib = order.indexOf(b)
                      if (ia !== -1 || ib !== -1) { if (ia === -1) return 1; if (ib === -1) return -1; return ia - ib }
                      return a.localeCompare(b)
                    })
                    const isOwner = comm.owner_fp === identity?.fingerprint
                    return cats.map(cat => (
                      <div key={cat} style={{ marginBottom: 14 }}>
                        <div className="cat-head">
                          <button
                            onClick={() => setCollapsedCats(prev => { const n = new Set(prev); if (n.has(cat)) n.delete(cat); else n.add(cat); return n })}
                            style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 'inherit', fontWeight: 'inherit', letterSpacing: 'inherit', padding: 0 }}
                          >
                            <span style={{ display: 'flex', transform: collapsedCats.has(cat) ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform .15s' }}><Icon d={Icons.chevron} size={10} /></span>
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cat}</span>
                          </button>
                          {isOwner && (
                            <button
                              onClick={() => { setPendingCategory(cat); setShowServerSettings(true); setServerTab('canais') }}
                              className="cat-plus"
                              title="Criar canal nesta categoria"
                            ><Icon d={Icons.plus} size={12} /></button>
                          )}
                        </div>
                        {!collapsedCats.has(cat) && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 2 }}>
                            {grouped[cat].map(ch => (
                              <div key={ch.id} className={'chan-row-wrap' + (selConv === ch.id ? ' active' : '') + (voiceChannel?.channelId===ch.id ? ' voice-active' : '')}>
                                <button
                                  onClick={async () => {
                                    if (ch.kind === 'voice') {
                                      if (callActionBusy) return
                                      // Canal de voz: 'none' → detalhado; 'relay-only'/'full' → joinVoice (que delega p/ relay quando preciso).
                                      if (getCallsSupport() === 'none') { setError(getCallsUnavailableMessage()); return }
                                      setCallActionBusy(true)
                                      if (voiceChannel?.channelId === ch.id) {
                                        try {
                                          // `leaveVoice` já chama `services.voiceLeave`.
                                          // Repetir aqui mandava DOIS frames VoiceLeave na
                                          // rede (o outro lado processava a saída duas vezes).
                                          await callManager.leaveVoice(selCommunity!, ch.id)
                                        } catch (e: any) { setError(String(e?.message ?? e)) }
                                        setVoiceChannel(null); setVoiceStates([])
                                      } else {
                                        setSelConv(ch.id)
                                        try {
                                          // `joinVoice` JÁ anuncia ao core
                                          // (`services.voiceJoin`) internamente.
                                          // Chamar de novo criava uma segunda
                                          // sessão nativa para o mesmo canal
                                          // (offers/sessões duplicadas).
                                          await callManager.joinVoice(selCommunity!, ch.id)
                                        } catch (e: any) { setError(String(e?.message ?? e)); setVoiceChannel(null); setCallActionBusy(false); return }
                                        // Só marca a barra DEPOIS do join: se
                                        // havia outro canal de voz, o
                                        // `joinVoice` sai dele e emite
                                        // `onUpdate(null)` no meio — marcar antes
                                        // deixava a barra sumir (o bind limpa).
                                        setVoiceChannel({ communityId: selCommunity!, channelId: ch.id })
                                        services.voiceStates(selCommunity!, ch.id).then(setVoiceStates).catch(()=>{})
                                      }
                                      setCallActionBusy(false)
                                    } else setSelConv(ch.id)
                                  }}
                                  onContextMenu={e => { e.preventDefault(); setChannelMenu({ x: e.clientX, y: e.clientY, id: ch.id }) }}
                                  className={'chan-row' + (selConv === ch.id ? ' active' : '')}
                                >
                                  <span style={{ display: 'flex', flexShrink: 0, opacity: 0.7 }}>
                                    <Icon d={ch.kind === 'voice' ? Icons.speaker : Icons.hash} size={16} />
                                  </span>
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>{ch.name}</span>
                                  {ch.topic && <span style={{ fontSize: 10, color: muted, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.topic}</span>}
                                </button>
                                {/* QUEM ESTÁ NO CANAL DE VOZ — sempre visível.
                                    Como no Discord: dá para ver os nomes de quem
                                    está na chamada e entrar nela tocando no canal,
                                    sem precisar perguntar. Antes só quem já tinha
                                    entrado via a barra de voz; quem chegava depois
                                    não sabia que havia gente ali. */}
                                {ch.kind === 'voice' && (
                                  <ChannelVoicePeers
                                    communityId={selCommunity!}
                                    channelId={ch.id}
                                    myFp={identity?.fingerprint ?? ''}
                                    isCurrent={voiceChannel?.channelId === ch.id}
                                    nameOf={nameOfFp}
                                    palette={{ muted, text, heading: t.heading, green: t.green, red: t.red }}
                                  />
                                )}
                                {isOwner && (
                                  <button
                                    className="chan-gear"
                                    onClick={e => { e.stopPropagation(); setChannelMenu({ x: e.clientX, y: e.clientY, id: ch.id }) }}
                                    title="Gerenciar canal"
                                  ><Icon d={Icons.settings} size={11} /></button>
                                )}
                                {/* Threads aninhadas sob o canal-pai (como no Discord).
                                    Só monta para o canal ABERTO — abrir uma.ThreadList por
                                    canal faz N consultas de rede na lista toda. */}
                                {ch.kind !== 'voice' && selConv === ch.id && (
                                  <ThreadList
                                    communityId={selCommunity!}
                                    parentChannel={ch.id}
                                    channels={extraChannels}
                                    onOpen={(th) => setOpenThread(th)}
                                  />
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))
                  })()}
                </div>
              </>
            )
          })() : (
            <>
              <div style={{ padding: '10px 8px', borderBottom: `1px solid ${borderColor}`, flexShrink: 0 }}>
                <button onClick={() => { setSelConv(null); setSelPeerFp(null); setFriendsTab('adicionar') }} className="find-btn">
                  Encontrar ou iniciar uma conversa
                </button>
              </div>
              <div style={{ padding: 8, flex: 1, overflowY: 'auto' }}>
                <button onClick={() => { setSelConv(null); setSelPeerFp(null); setFriendsTab('online') }} className={'nav-row' + (!selConv ? ' active' : '')}>
                  <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.users} size={18} /></span>
                  Amigos
                  {friendRequests.length > 0 && <span className="nav-badge">{friendRequests.length}</span>}
                </button>

                <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px' }}><span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, color: muted, flex: 1 }}>CONVERSAS DIRETAS</span><button onClick={() => setShowCreateGroup(true)} title="Criar grupo (igual Discord)" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', display: 'flex' }}><Icon d={Icons.plus} size={12}/></button></div>
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {conversations.map(c => (
                    <div key={c.id} className={'nav-row' + (c.id === selConv ? ' active' : '')} onClick={() => { setSelConv(c.id); setSelPeerFp(c.peer_fp) }} style={{ cursor: 'pointer' }}>
                      <Avatar name={c.title} fp={c.peer_fp} size={28} avatarB64={socialProfiles[c.peer_fp]?.avatar_b64} />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{c.title}</span>
                      <button title="Apagar conversa" onClick={async (e) => { e.stopPropagation(); if (!confirm(`Apagar conversa com ${c.title}?`)) return; try { await services.conversationDelete(c.id); if (selConv === c.id) setSelConv(null); refreshConvos() } catch (err: any) { setError(String(err?.message ?? err)) } }} style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon d={Icons.trash} size={14} /></button>
                    </div>
                  ))}
                </div>

                {onlinePeers.filter(p => friendsAccepted.some(f => f.fp === p.fp)).length > 0 && (
                  <>
                    <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: 1, color: muted, padding: '0 8px' }}>AMIGOS ONLINE</div>
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {onlinePeers.filter(p => friendsAccepted.some(f => f.fp === p.fp)).map(p => (
                        <button key={p.fp} onClick={() => openDm({ fp: p.fp, nickname: p.nickname })} className={'nav-row' + (p.fp === selPeerFp && !selConv ? ' active' : '')}>
                          <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                            <Avatar name={p.nickname || p.fp} fp={p.fp} size={28} avatarB64={socialProfiles[p.fp]?.avatar_b64} />
                            <PeerDot s={p.state} />
                          </span>
                          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{p.nickname || p.fp}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}

                {friendRequests.length > 0 && (
                  <>
                    <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: 1, color: muted, padding: '0 8px' }}>SOLICITAÇÕES PENDENTES</div>
                    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {friendRequests.map(r => (
                        <div key={r.fp} className="req-row">
                          <Avatar name={r.nickname || r.fp} fp={r.fp} size={28} avatarB64={socialProfiles[r.fp]?.avatar_b64} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nickname || r.fp}</span>
                          <button onClick={() => respondFriend(r.fp, true)} title="Aceitar" className="req-btn ok"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 7"/></svg></button>
                          <button onClick={() => respondFriend(r.fp, false)} title="Recusar" className="req-btn no"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12 M18 6L6 18"/></svg></button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
          {/* VOICE BAR idêntico Discord — quando numa chamada de voz do servidor */}
          {voiceChannel && (
            <div style={{ background: '#232428', borderTop: `1px solid ${borderColor}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.green, boxShadow: `0 0 6px ${t.green}` }}/>
                <span style={{ fontSize: 11, fontWeight: 800, color: t.green, flex: 1 }}>Voz conectada</span>
                <span style={{ fontSize: 10, color: muted }}>/ {activeComm?.channels.find(([id])=>id===voiceChannel.channelId)?.[1] ?? voiceChannel.channelId.slice(0,8)}</span>
              </div>
              <div style={{ fontSize: 10, color: muted }}>{voiceStates.length} na voz • {voiceStates.filter(([,m])=>!m).length} com mic aberto • todos semeiam</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => { const nm=!isMuted; setIsMuted(nm); callManager.toggleMute(); services.voiceState(voiceChannel.communityId, voiceChannel.channelId, nm, isDeafened).catch(()=>{}) }} aria-label={isMuted ? 'Ativar microfone' : 'Silenciar'} style={{ flex: 1, background: isMuted ? t.red : inputBg, color: isMuted ? '#fff' : text, border: 'none', padding: '6px 0', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isMuted ? <Icon d={Icons.micOff} size={13} /> : <Icon d={Icons.mic} size={13} />}</button>
                <button onClick={() => { const nd=!isDeafened; setIsDeafened(nd); if(nd) setIsMuted(true); callManager.toggleDeafen(); services.voiceState(voiceChannel.communityId, voiceChannel.channelId, isMuted || nd, nd).catch(()=>{}) }} aria-label={isDeafened ? 'Ativar áudio' : 'Ensurdecer'} style={{ flex: 1, background: isDeafened ? t.red : inputBg, color: isDeafened ? '#fff' : text, border: 'none', padding: '6px 0', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isDeafened ? <Icon d={Icons.volumeX} size={13} /> : <Icon d={Icons.headphones} size={13} />}</button>
                <button onClick={async () => { try { await callManager.leaveVoice(voiceChannel.communityId, voiceChannel.channelId) } catch (e: any) { setError(String(e?.message ?? e)) } setVoiceChannel(null); setVoiceStates([]) }} style={{ background: t.red, color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 800 }}>Sair</button>
              </div>
              {voiceStates.length>0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{voiceStates.map(([fp,m,d]) => <span key={fp} title={fp} style={{ fontSize: 10, background: inputBg, border: `1px solid ${borderColor}`, padding: '2px 6px', borderRadius: 99, color: m? t.red : d? t.yellow : t.green }}>{fp.slice(0,6)} {m ? <Icon d={Icons.micOff} size={10} /> : d ? <Icon d={Icons.volumeX} size={10} /> : <Icon d={Icons.mic} size={10} />}</span>)}</div>}
            </div>
          )}
          <div style={{ marginTop: 'auto', padding: 10, background: t.footer, borderTop: `1px solid ${borderColor}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {identity && (
              <button onClick={() => setShowProfile(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 4px', borderRadius: 8, background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}>
                {(() => {
                  const meProfile = socialProfiles[identity.fingerprint]
                  const mePresence = socialPresence[identity.fingerprint] || 'online'
                  const presenceColors: Record<string, string> = { online: '#23a559', idle: '#f0b232', dnd: '#f23f42', invisible: '#80848e', offline: '#80848e' }
                  return (
                    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                      <Avatar name={meProfile?.display_name || identity.nickname} fp={identity.fingerprint} size={36} avatarB64={meProfile?.avatar_b64} accent={meProfile?.accent || undefined} />
                      <span style={{ position: 'absolute', right: -2, bottom: -2, width: 10, height: 10, borderRadius: '50%', background: presenceColors[mePresence] || '#80848e', border: '3px solid var(--sidebar)' }} />
                    </span>
                  )
                })()}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: socialProfiles[identity.fingerprint]?.accent || t.heading, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{socialProfiles[identity.fingerprint]?.display_name || identity.nickname}</div>
                  <div style={{ fontSize: 10, color: '#949ba4', fontFamily: 'JetBrains Mono', fontWeight: 600 }}>{identity.fingerprint.slice(0, 12)}</div>
                </div>
              </button>
            )}
            {/* BUG VISUAL do "ícone de configuração": os dois botões tinham
                `flex: 1` dentro de um flex row, então viravam barras de 118px
                de largura com 24px de altura e um glifo de 14px no meio — uma
                mancha ilegível, não um botão. Agora são quadrados de 34px com
                ícone de 17px, rótulo no aria e foco visível. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <button
                onClick={() => setShowSettings(true)}
                title="Configurações"
                aria-label="Configurações"
                data-testid="open-settings"
                style={{ width: 34, height: 34, border: `1px solid ${borderColor}`, background: inputBg, cursor: 'pointer', color: muted, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              ><Icon d={Icons.settings} size={17} /></button>
              <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: muted }}>Definições</span>
              <button
                onClick={() => { setPhase('lock'); setIdentity(null as any); setSelConv(null); setSelPeerFp(null) }}
                title="Sair"
                aria-label="Sair"
                data-testid="app-logout"
                style={{ width: 34, height: 34, border: `1px solid ${borderColor}`, background: inputBg, cursor: 'pointer', color: t.red, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              </button>
            </div>
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: bg, minWidth: 0, marginRight: activeCall ? (callPanelSize === 'compact' ? 300 : callPanelSize === 'normal' ? 'clamp(320px, 36vw, 520px)' : 'min(56vw, 720px)') : 0, transition: 'margin-right 180ms ease' }}>
          {view === 'servidores' && selCommunity ? (
            <div style={{ height: 48, borderBottom: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10, flexShrink: 0, boxShadow: '0 1px 0 rgba(0,0,0,.2)' }}>
              <span style={{ color: muted, display: 'flex' }}><Icon d={Icons.hash} size={20} /></span>
              <span style={{ fontWeight: 700, color: t.heading }}>{channelLabel}</span>
              <div style={{ width: 1, height: 20, background: borderColor, margin: '0 8px' }} />
              <span style={{ fontSize: 12, color: muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{extraChannels.find(c => c.id === selConv)?.topic || 'Bem-vindo ao canal'}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center', color: muted }}>
                <button onClick={() => setShowSearch(s => !s)} title="Buscar mensagens (Ctrl+F)" aria-label="Buscar" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Icon d={Icons.search} size={17} /></button>
                <button onClick={() => setShowInbox(s => !s)} title="Inbox: menções e não-lidas (Ctrl+I)" aria-label="Inbox" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', position: 'relative' }}>
                  <Icon d={Icons.bell} size={17} />
                  {mentionTotal > 0 && <span style={{ position: 'absolute', top: -6, right: -8, background: t.red, color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 99, minWidth: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{mentionTotal}</span>}
                </button>
                <button onClick={() => setShowBookmarks(s => !s)} title="Mensagens salvas" aria-label="Salvas" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Icon d={Icons.file} size={17} /></button>
                <button onClick={() => setShowPins(s => !s)} title="Mensagens fixadas (Ctrl+Shift+P)" aria-label="Fixadas" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Icon d={Icons.pin} size={17} /></button>
                <button onClick={() => setShowEvents(true)} title="Eventos agendados" aria-label="Eventos" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Icon d={Icons.history} size={17} /></button>
                <button onClick={() => setShowModeration(true)} title="Moderação do servidor" aria-label="Moderação" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Icon d={Icons.shield} size={17} /></button>
                <button onClick={() => setShowChannelCfg(true)} title="Configurar canal (slowmode, emojis)" aria-label="Configurar canal" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Icon d={Icons.settings} size={17} /></button>
                <button onClick={() => setShowCmdK(true)} title="Paleta de comandos (Ctrl+K)" aria-label="Comandos" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}><Icon d={Icons.terminal} size={17} /></button>
                <button onClick={() => setShowDownloads(true)} title="Downloads" aria-label="Downloads" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', position: 'relative' }}>
                  <Icon d={Icons.download} size={17} />
                  {dlCount > 0 && <span style={{ position: 'absolute', top: -6, right: -8, background: t.accent, color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 99, minWidth: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{dlCount}</span>}
                </button>
                {/* Estes três eram <Icon> PURO, sem onClick: pareciam botões e
                    não faziam NADA — era o "ícone de configuração bugado" (o
                    grid). Agora são botões de verdade: grid abre Configurações,
                    users vai para Amigos, e o sino some (não existe sistema de
                    notificação — ícone morto é pior que ícone ausente). */}
                <button
                  onClick={() => setShowSettings(true)}
                  title="Configurações"
                  aria-label="Configurações"
                  style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center' }}
                >
                  <Icon d={Icons.grid} size={17} />
                </button>
                <button
                  onClick={() => { setView('amigos'); setSelCommunity(null); setSelConv(null); setSelPeerFp(null) }}
                  title="Amigos"
                  aria-label="Amigos"
                  style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', position: 'relative' }}
                >
                  <Icon d={Icons.users} size={17} />
                  {friendRequests.length > 0 && <span style={{ position: 'absolute', top: -4, right: -6, background: t.red, color: '#fff', fontSize: 8, fontWeight: 800, borderRadius: 99, minWidth: 13, height: 13, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{friendRequests.length}</span>}
                </button>
                {netPill(status)}
              </span>
            </div>
          ) : selConv ? (
            <div style={{ height: 48, borderBottom: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10, flexShrink: 0, boxShadow: '0 1px 0 rgba(0,0,0,.2)' }}>
              <span style={{ color: muted, fontWeight: 800, fontSize: 18 }}>{conversations.find(c=>c.id===selConv)?.kind==='group' ? <Icon d={Icons.users} size={18}/> : '@'}</span>
              {/* CONTADOR DE MEMBROS: antes lia
                  `localStorage['distorrent:extras:group_members:<id>']` na mao -
                  chave que so existe no MODO NAVEGADOR. No app nativo lia null e
                  mostrava "0 membros" para sempre. Agora vem do motor, e o nome e'
                  clicavel para abrir o painel do grupo. */}
              {ehGrupo ? (
                <button
                  onClick={() => setShowGroupPanel(true)}
                  title="Ver membros, renomear ou remover alguem"
                  aria-label={`${peerTitle} - ${groupMemberCount} membros. Abrir painel do grupo`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', minWidth: 0, flex: 1, color: 'inherit', textAlign: 'left' }}
                >
                  <span style={{ fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peerTitle}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: muted, whiteSpace: 'nowrap' }}>
                    {groupMemberCount} {groupMemberCount === 1 ? 'membro' : 'membros'}
                  </span>
                </button>
              ) : (
                <span style={{ fontWeight: 700, color: t.heading, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peerTitle}</span>
              )}
              {/* CALL toolbar idêntico Discord — sem hard-disable: se o WebView
                  não tiver WebRTC/permissão, o clique explica o que falta em vez de
                  ser um botão morto (o snapshot de `callsSupport` é de render). */}
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <button onClick={() => setShowDownloads(true)} title="Downloads" aria-label="Downloads" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', position: 'relative' }}>
                  <Icon d={Icons.download} size={18} />
                  {dlCount > 0 && <span style={{ position: 'absolute', top: 0, right: 0, background: t.accent, color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 99, minWidth: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{dlCount}</span>}
                </button>
                <button onClick={() => startCall('voice')} title={callsOk ? 'Iniciar chamada de voz' : `Iniciar chamada de voz — ${callsUnavailableDetail}`} aria-label="Iniciar chamada de voz" style={{ background: 'transparent', border: 'none', color: callsOk ? muted : t.red, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', opacity: callsOk ? 1 : 0.75 }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 1 1 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a1 1 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button>
                <button onClick={() => startCall('video')} title={callsOk ? 'Iniciar chamada de vídeo' : `Iniciar chamada de vídeo — ${callsUnavailableDetail}`} aria-label="Iniciar chamada de vídeo" style={{ background: 'transparent', border: 'none', color: callsOk ? muted : t.red, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', opacity: callsOk ? 1 : 0.75 }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polygon points="23 7 13 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></button>
                <button onClick={() => setShowAddToCall(true)} title="Adicionar amigos à chamada" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg></button>
                <button onClick={() => setShowCreateGroup(true)} title="Criar grupo (igual Discord)" style={{ background: inputBg, border: `1px solid ${borderColor}`, color: t.accent, cursor: 'pointer', padding: '4px 8px', borderRadius: 6, fontSize: 11, fontWeight: 800 }}>+ Grupo</button>
                <span style={{ width: 1, height: 20, background: borderColor, margin: '0 4px' }}/>
                {/* Antes estes dois eram <Icon> PURO: pareciam botões e não
                    faziam nada. Agora abrem as caixas de menções e_fixados. */}
                <button
                  onClick={() => { setInboxTab('mentions'); setShowInbox(true) }}
                  title="Menções"
                  aria-label={`Menções${mentionTotal ? ` (${mentionTotal})` : ''}`}
                  data-testid="open-inbox"
                  style={{ position: 'relative', background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 5, borderRadius: 6, display: 'flex' }}
                >
                  <Icon d={Icons.bell} size={17} />
                  {mentionTotal > 0 && <span style={{ position: 'absolute', top: -2, right: -4, minWidth: 15, height: 15, padding: '0 4px', borderRadius: 99, background: t.red, color: '#fff', fontSize: 9.5, fontWeight: 900, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{mentionTotal > 99 ? '99+' : mentionTotal}</span>}
                </button>
                <button
                  onClick={() => { setInboxTab('bookmarks'); setShowInbox(true) }}
                  title="Marcadores"
                  aria-label="Mensagens salvas"
                  data-testid="open-bookmarks"
                  style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 5, borderRadius: 6, display: 'flex' }}
                ><Icon d={Icons.grid} size={17} /></button>
                <button
                  onClick={() => { setShowInbox(false); setShowBookmarks(true) }}
                  title="Fixadas e salvas deste canal"
                  aria-label="Fixadas e salvas"
                  style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 5, borderRadius: 6, display: 'flex' }}
                ><Icon d={Icons.pin} size={17} /></button>
                {netPill(status)}
              </span>
            </div>
          ) : (
            <div className="hide-scrollbar" style={{ height: 48, borderBottom: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 14, flexShrink: 0, boxShadow: '0 1px 0 rgba(0,0,0,.2)', minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}>
              <span style={{ color: muted, display: 'flex' }}><Icon d={Icons.users} size={20} /></span>
              <span style={{ fontWeight: 700, color: t.heading, flexShrink: 0 }}>Amigos</span>
              <div style={{ width: 1, height: 20, background: borderColor, margin: '0 6px', flexShrink: 0 }} />
              {([['online', 'Online'], ['todos', 'Todos'], ['pendentes', 'Pendentes'], ['bloqueados', 'Bloqueados']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setFriendsTab(id)} className={'tab-btn' + (friendsTab === id ? ' active' : '')} style={{ flexShrink: 0 }}>
                  {label}
                  {id === 'pendentes' && friendRequests.length > 0 && <span className="tab-badge">{friendRequests.length}</span>}
                  {id === 'bloqueados' && friendsBlocked.length > 0 && <span className="tab-badge">{friendsBlocked.length}</span>}
                </button>
              ))}
              <button onClick={() => setFriendsTab('adicionar')} className={'tab-btn add' + (friendsTab === 'adicionar' ? ' active' : '')} style={{ flexShrink: 0 }}>Adicionar amigo</button>
              <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4 }}>
                {netPill(status)}
                {/* Downloads acessível SEM conversa aberta — o swarm é global,
                    o painel não pode depender de um canal selecionado. */}
                <button onClick={() => setShowDownloads(true)} title="Downloads" aria-label="Downloads" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', position: 'relative' }}>
                  <Icon d={Icons.download} size={18} />
                  {dlCount > 0 && <span style={{ position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, borderRadius: 99, background: t.red, color: '#fff', fontSize: 9, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{dlCount > 9 ? '9+' : dlCount}</span>}
                </button>
              </span>
            </div>
          )}

          {error && (
            <div style={{ margin: '10px 16px 0', background: '#2a1518', border: `1px solid ${t.red}55`, color: '#ff9c9c', fontSize: 12, padding: '8px 12px', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              {error}
              <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#ff9c9c', cursor: 'pointer' }}>x</button>
            </div>
          )}
          {notice && (
            <div role="status" style={{ margin: '10px 16px 0', background: '#1a3329', border: `1px solid ${t.green}55`, color: '#8cf5b8', fontSize: 12, padding: '8px 12px', borderRadius: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
              {notice}
              <button onClick={() => setNotice(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#8cf5b8', cursor: 'pointer' }}>x</button>
            </div>
          )}

          {!selConv && view !== 'servidores' && (
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {friendsTab === 'adicionar' ? (
                <div style={{ padding: '20px 24px', maxWidth: 760 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1, color: t.heading }}>ADICIONAR AMIGO</div>
                  <div style={{ fontSize: 13, color: muted, marginTop: 8, lineHeight: 1.6 }}>
                    Você pode adicionar amigos pelo fingerprint único deles. O seu é{' '}
                    <button onClick={async () => { await navigator.clipboard?.writeText?.(identity?.fingerprint ?? '').catch(() => {}) }} className="fp-copy" title="Copiar seu fingerprint">{identity?.fingerprint}</button>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 16, borderBottom: `1px solid ${borderColor}`, paddingBottom: 16 }}>
                    <input value={friendFpInput} onChange={e => setFriendFpInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addFriend()} placeholder="Digite o fingerprint do seu amigo" style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: text, fontSize: 15, fontFamily: 'JetBrains Mono' }} />
                    <button onClick={addFriend} className="add-btn" style={{ opacity: friendFpInput.trim() ? 1 : 0.5, cursor: friendFpInput.trim() ? 'pointer' : 'not-allowed' }}>Enviar solicitação</button>
                  </div>
                  {friendSuccess && <div style={{ marginTop: 12, background: '#1a3329', border: `1px solid ${t.green}55`, color: '#8cf5b8', fontSize: 12, padding: '8px 12px', borderRadius: 8 }}>{friendSuccess}</div>}
                  {services.kind === 'browser' && (
                    <div style={{ marginTop: 12, background: '#2a1f0a', border: `1px solid ${t.yellow}55`, color: '#ffcc66', fontSize: 11, padding: '8px 12px', borderRadius: 8, lineHeight: 1.5 }}>
                      Modo navegador (LOCAL): só funciona entre abas do <b>mesmo PC</b> via BroadcastChannel. Para testar com celular, use o <b>app nativo Tauri</b> nos dois aparelhos na mesma Wi-Fi (descoberta LAN automática) ou use <b>Configurações → Avançado → digitar IP manual</b>.
                    </div>
                  )}
                  {services.kind === 'native' && (status as any)?.state === 'DISCONNECTED' && (
                    <div style={{ marginTop: 12, background: '#2a1518', border: `1px solid ${t.red}55`, color: '#ff9c9c', fontSize: 11, padding: '8px 12px', borderRadius: 8, lineHeight: 1.5 }}>
                      OFFLINE: seu nó está ouvindo em <b>:{(status as any)?.listen_port || '?'}</b> mas sem peers conectados. Adicione o amigo pelo fingerprint — quando ambos estiverem online na mesma rede, o pedido sai automaticamente (P2P com UPnP/DHT). Se estiver em redes diferentes, use o IP manual abaixo.
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <input value={addrInput} onChange={e=>setAddrInput(e.target.value)} placeholder="ip:porta (ex: 192.168.0.10:12345)" style={{ flex: 1, background: '#1e1f22', border: `1px solid ${t.border}`, borderRadius: 6, padding: '6px 8px', color: t.text, fontSize: 11, fontFamily: 'JetBrains Mono' }} />
                        <button onClick={async()=>{ if(!addrInput.trim()) return; try{ await services.connectAddr(addrInput.trim(),null); setAddrInput(''); refreshNet(); setError(null)}catch(e:any){setError(String(e?.message??e))} }} style={{ background: t.accent, color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontWeight: 800, cursor: 'pointer', fontSize: 11 }}>Conectar</button>
                      </div>
                    </div>
                  )}
                  {pendingOut.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: muted, marginBottom: 8 }}>ENVIADAS ({pendingOut.length}) — aguardando aceitação</div>
                      {pendingOut.map(r => {
                        const isQueued = !onlineFps.has(r.fp)
                        return (
                          <div key={r.fp} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, marginBottom: 6 }}>
                            <Avatar name={r.nickname || r.fp} fp={r.fp} size={28} avatarB64={socialProfiles[r.fp]?.avatar_b64} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: text }}>{r.nickname || r.fp}</div>
                              <div style={{ fontSize: 10, color: isQueued ? t.yellow : t.green }}>{isQueued ? 'offline — será entregue ao reconectar' : '✓ peer online — enviando…'}</div>
                            </div>
                            <span style={{ fontSize: 10, color: muted, fontFamily: 'JetBrains Mono' }}>{r.fp.slice(0,8)}</span>
                            <button onClick={async()=>{ try{ await services.friendRemove(r.fp); refreshFriends(); setFriendSuccess('Solicitação cancelada')}catch(e:any){setError(String(e?.message??e))}}} title="Cancelar" style={{ background: 'transparent', border: `1px solid ${borderColor}`, color: t.red, padding: '4px 8px', borderRadius: 6, cursor: 'pointer', fontSize: 10, fontWeight: 700 }}><Icon d={Icons.x} size={13} /></button>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : friendsTab === 'pendentes' ? (
                friendRequests.length === 0 && pendingOut.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: muted, fontSize: 13 }}>Não há solicitações pendentes. Que pena.</div>
                ) : friendRequests.map(r => (
                  <div key={r.fp} className="friend-row">
                    <Avatar name={r.nickname || r.fp} fp={r.fp} size={32} avatarB64={socialProfiles[r.fp]?.avatar_b64} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nickname || r.fp}</div>
                      <div style={{ fontSize: 11, color: muted }}>Solicitação de amizade recebida</div>
                    </div>
                    <button onClick={() => respondFriend(r.fp, true)} title="Aceitar" className="row-icon ok"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 7"/></svg></button>
                    <button onClick={() => respondFriend(r.fp, false)} title="Recusar" className="row-icon no"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12 M18 6L6 18"/></svg></button>
                  </div>
                ))
              ) : friendsTab === 'bloqueados' ? (
                friendsBlocked.length === 0 ? (
                  <div style={{ padding: 32, textAlign: 'center', color: muted, fontSize: 13 }}>Ninguém bloqueado.</div>
                ) : friendsBlocked.map(f => (
                  <div key={f.fp} className="friend-row">
                    <Avatar name={f.nickname || f.fp} fp={f.fp} size={32} avatarB64={socialProfiles[f.fp]?.avatar_b64} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nickname || f.fp}</div>
                      <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono' }}>{f.fp.slice(0, 12)} · não consegue te achar</div>
                    </div>
                    <button title="Desbloquear" className="row-icon ok" onClick={async e => { e.stopPropagation(); try { await services.friendUnblock(f.fp); refreshFriends(); setFriendSuccess('Desbloqueado') } catch (err: any) { setError(String(err?.message ?? err)) } }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M4 12l5 5L20 7" /></svg></button>
                  </div>
                ))
              ) : shownFriends.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', color: muted }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: t.heading }}>
                    {friendsTab === 'online' ? 'Ninguém online agora — é silencioso demais aqui.' : 'Que silêncio por aqui...'}
                  </div>
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    Um amigo que trabalha em equipe é uma coisa boa — <button onClick={() => setFriendsTab('adicionar')} className="link-btn">adicione alguém!</button>
                  </div>
                </div>
              ) : shownFriends.map(f => (
                <div key={f.fp} className={'friend-row' + (f.fp === selPeerFp ? ' active' : '')} onClick={() => openDm(f)}>
                  <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                    <Avatar name={f.nickname || f.fp} fp={f.fp} size={32} avatarB64={socialProfiles[f.fp]?.avatar_b64} />
                    <PeerDot s={onlineFps.has(f.fp) ? 'CONNECTED' : 'DISCONNECTED'} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: f.fp === selPeerFp ? t.heading : text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.nickname || f.fp}</div>
                    <div style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono' }}>{f.fp.slice(0, 12)}</div>
                  </div>
                  <button title="Conversar" className="row-icon" onClick={e => { e.stopPropagation(); openDm(f) }}><Icon d={Icons.send} size={15} /></button>
                  <button title="Bloquear" className="row-icon no" onClick={async e => { e.stopPropagation(); if (!confirm(`Bloquear ${f.nickname || f.fp}? Ele não consegue mais te achar e suas mensagens são rejeitadas.`)) return; try { await services.friendBlock(f.fp); refreshFriends(); refreshConvos(); setFriendSuccess('Amigo bloqueado') } catch (err: any) { setError(String(err?.message ?? err)) } }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M5.6 5.6l12.8 12.8" /></svg></button>
                  <button title="Remover amigo" className="row-icon no" onClick={async e => { e.stopPropagation(); if (!confirm(`Remover ${f.nickname || f.fp} dos amigos?`)) return; try { await services.friendRemove(f.fp); refreshFriends(); refreshConvos(); setFriendSuccess('Amigo removido') } catch (err: any) { setError(String(err?.message ?? err)) } }}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12 M18 6L6 18"/></svg></button>
                </div>
              ))}
            </div>
          )}

          {selConv && (
              <>
              {/* Histórico: o core pagina por timestamp, mas a UI nunca expôs o
                  `loadOlder` — conversas longas ficavam truncadas em 100. */}
              {hasOlder && (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}>
                  <button
                    onClick={async () => {
                      setLoadingOlder(true)
                      try { await loadOlder() } finally { setLoadingOlder(false) }
                    }}
                    disabled={loadingOlder}
                    style={{
                      background: inputBg, border: `1px solid ${borderColor}`, color: muted,
                      borderRadius: 99, padding: '6px 16px', fontSize: 12, fontWeight: 700,
                      cursor: loadingOlder ? 'progress' : 'pointer', opacity: loadingOlder ? 0.6 : 1,
                    }}
                  >{loadingOlder ? 'carregando…' : '↑ carregar mensagens anteriores'}</button>
                </div>
              )}
              <MessageList
                ref={msgListRef}
                messages={messages}
                convId={selConv}
                myFp={identity?.fingerprint ?? ''}
                nameOf={nameOfFp}
                profiles={socialProfiles}
                presence={socialPresence}
                emptyBlock={emptyBlock('Nenhuma mensagem ainda', 'Envie a primeira. Se o peer estiver offline, fica pendente e sai ao reconectar.')}
                onReply={(m) => { setReplyTo(m); setInput('') }}
                onProfile={(fp) => setProfileFp(fp)}
                onForward={(m) => setForwardMsg(m)}
                onThread={(m) => { void createThreadFrom(m) }}
                onToast={setNotice}
                onResend={(m) => { void resendMessage(m) }}
                compact={prefs.compact}
                fontScale={prefs.fontScale}
                pollChannel={view === 'servidores' && selCommunity ? { communityId: selCommunity, channelId: selConv } : undefined}
                renderFile={(m, _grouped) => {
                  const fmeta = parseFileBody(m.body)
                  if (!fmeta) return null
                  // O card lê o fileSwarm (bitfield = o que já temos) E a fila do
                  // `downloadManager` (progresso, VELOCIDADE, pausa/erro reais).
                  // Antes o desktop mostrava só `have/chunks` — um número que
                  // congelava ao pausar e não dizia por que tinha parado.
                  const sf = fileSwarm.files.get(fmeta.file_id) ?? null
                  const announced = !!sf
                  const complete = !!sf && sf.chunks > 0 && sf.have.size >= sf.chunks
                  // O item da fila tem prioridade (é o estado que a UI comanda);
                  // sem item, o bitfield do swarm dá o progresso "só leitura".
                  const queued = dlByFile[fmeta.file_id]
                  const progress = queued ?? (announced
                    ? {
                        pct: complete ? 100 : sf && sf.chunks > 0 ? Math.round((100 * sf.have.size) / sf.chunks) : 0,
                        speed: 0,
                        status: complete ? 'completed' : 'idle',
                      }
                    : { pct: 0, speed: 0, status: 'idle' })
                  // UMA ação para os dois shells (`services/downloadAction`):
                  // o PC salvava direto quando o arquivo já estava completo,
                  // pulando a verificação blake3 e o aviso de conclusão que o
                  // celular fazia. Agora ambos passam pela fila.
                  //
                  // NÃO abre o painel de downloads: o próprio cartão já mostra
                  // barra, % e velocidade, e a central abrindo por cima de
                  // QUALQUER download é intrusiva (pedido explícito do usuário).
                  // Quem quiser a lista toca no ícone de downloads ou no botão
                  // "Painel de downloads" do cartão.
                  const baixar = async () => {
                    setError(null)
                    try {
                      await startDownload(fmeta)
                    } catch (e: any) { setError(String(e?.message ?? e)) }
                  }
                  return (
                    <FileCard
                      name={fmeta.name}
                      size={fmeta.size}
                      chunks={fmeta.chunks}
                      mine={m.direction === 'out'}
                      mstatus={m.status}
                      announced={announced}
                      previewUrl={previews[fmeta.file_id]}
                      progress={progress}
                      pal={{ text, heading: t.heading, muted, accent: t.accent, input: inputBg, border: borderColor, main: t.main, green: t.green, red: t.red, yellow: t.yellow }}
                      onDownload={() => void baixar()}
                      onRetry={() => { void resendMessage(m) }}
                      extra={(
                        <button onClick={() => setShowDownloads(true)} style={{ background: 'transparent', color: muted, border: `1px solid ${borderColor}`, padding: '7px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Painel de downloads</button>
                      )}
                    />
                  )
                }}
              />
              </>
          )}

          {selConv && showSearch && (
            <SearchPanel
              convId={selConv}
              convLabel={view === 'servidores' ? '#' + channelLabel : (peerTitle || 'conversa')}
              profiles={socialProfiles}
              onClose={() => setShowSearch(false)}
              onJump={(hit) => { setShowSearch(false); void jumpToMessage(hit.conv_id || selConv, hit.id) }}
            />
          )}
          {selConv && showPins && (
            <PinsPanel
              convId={selConv}
              messages={messages}
              onClose={() => setShowPins(false)}
              onJump={(m) => { setShowPins(false); void jumpToMessage(m.conv_id || selConv, m.id) }}
            />
          )}
          {selConv && showBookmarks && (
            <BookmarksPanel
              convId={selConv}
              messages={messages}
              onClose={() => setShowBookmarks(false)}
              onJump={(id) => { setShowBookmarks(false); void jumpToMessage(selConv, id) }}
            />
          )}
          {showInbox && (
            <InboxPanel
              tab={inboxTab}
              onTab={setInboxTab}
              profiles={socialProfiles}
              onClose={() => setShowInbox(false)}
              onJump={(cid, mid) => { setShowInbox(false); void jumpToMessage(cid, mid) }}
            />
          )}
          {selConv && (
            <div style={{ padding: '0 16px 24px', flexShrink: 0 }}>
              {replyTo && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: inputBg, border: `1px solid ${borderColor}`, borderBottom: 'none', borderRadius: '8px 8px 0 0', padding: '6px 10px', fontSize: 11 }}>
                  <span style={{ color: muted }}>↩</span>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <b style={{ color: t.heading }}>{nameOfFp(replyTo.direction === 'out' ? (identity?.fingerprint ?? '') : replyTo.author_fp)}</b>{' '}
                    <span style={{ color: muted }}>{replyTo.body.slice(0, 80)}</span>
                  </span>
                  <button onClick={() => setReplyTo(null)} style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer' }}>×</button>
                </div>
              )}
              {showPollForm && selCommunity && (
                <div style={{ background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: 10, marginBottom: 6 }}>
                  <div style={{ fontSize: 10, fontWeight: 800, color: muted, marginBottom: 6 }}>NOVA ENQUETE</div>
                  <input value={newPollQ} onChange={e => setNewPollQ(e.target.value)} placeholder="Pergunta" style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: text, fontSize: 13, marginBottom: 6 }} />
                  <textarea value={newPollOpts} onChange={e => setNewPollOpts(e.target.value)} placeholder="Opções (uma por linha)" style={{ width: '100%', background: 'transparent', border: 'none', outline: 'none', color: text, fontSize: 12, minHeight: 48, resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button onClick={() => setShowPollForm(false)} style={{ background: 'transparent', border: `1px solid ${borderColor}`, color: muted, borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>cancelar</button>
                    <button onClick={createPoll} style={{ background: t.accent, color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>criar</button>
                  </div>
                </div>
              )}
              {Object.values(typingPeers).length > 0 && (
                <div style={{ fontSize: 11, color: muted, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span className="spin" style={{ width: 10, height: 10, border: `2px solid ${muted}`, borderTopColor: t.accent, borderRadius: '50%', display: 'inline-block' }} />
                  {Object.values(typingPeers).map(p => p.nick).join(', ')} está digitando…
                </div>
              )}
              <div style={{ position: 'relative' }}>
              {activeAutocomplete && autocompleteItems.length > 0 && (
                <div style={{
                  position: 'absolute', bottom: 'calc(100% + 6px)', left: 8, right: 8, zIndex: 60,
                  background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8,
                  boxShadow: '0 12px 34px rgba(0,0,0,.55)', overflow: 'hidden', maxHeight: 260,
                  display: 'flex', flexDirection: 'column',
                }}>
                  <div style={{ maxHeight: 236, overflowY: 'auto' }}>
                    {autocompleteItems.map((it, i) => (
                      <button
                        key={it.key}
                        onMouseDown={e => { e.preventDefault(); applyAutocomplete(it) }}
                        onMouseEnter={() => setAutocompleteIdx(i)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                          background: i === autocompleteIdx ? t.selected : 'transparent',
                          border: 'none', color: text, cursor: 'pointer', padding: '7px 10px', fontSize: 13,
                        }}
                      >
                        {it.glyph && <span style={{ fontSize: 16, width: 20, textAlign: 'center', flexShrink: 0 }}>{it.glyph}</span>}
                        <span style={{ fontWeight: 600, color: it.color ?? t.heading, flexShrink: 0 }}>{it.label}</span>
                        {it.hint && <span style={{ color: muted, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.hint}</span>}
                      </button>
                    ))}
                  </div>
                  <div style={{ borderTop: `1px solid ${borderColor}`, padding: '4px 10px', fontSize: 10, color: muted }}>
                    ↑↓ navegar • Enter/Tab escolher • Esc fechar
                  </div>
                </div>
              )}
              </div>
              {/* position:relative — os popovers ("+", autocomplete) são positionados
                  em relação a ESTE box com bottom:calc(100% + 6px). Sem isso o
                  ancestral de posicionamento era o viewport e o menu aparecia
                  acima da tela (y negativo), inalcançável. */}
              <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 8, background: t.composer, borderRadius: 8, padding: '8px 10px' }}>
                <input type="file" ref={(el:any)=> fileInputRef.current = el} onChange={onPickFile} style={{ display: 'none' }} />
                <button onClick={() => setShowEmojiPicker(v => !v)} className="composer-icon" title="Mais: arquivo, enquete, emoji" aria-label="Mais" aria-expanded={showEmojiPicker} style={{ background: showEmojiPicker ? t.accent : t.accent, color: '#fff', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><Icon d={Icons.plus} size={16} /></button>
                {showEmojiPicker && (
                  <div style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 8, zIndex: 60, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, boxShadow: '0 12px 34px rgba(0,0,0,.55)', padding: 8, width: 210 }}>
                    <button onClick={() => { fileInputRef.current?.click(); setShowEmojiPicker(false) }} style={composerMenuStyle}><Icon d={Icons.attach} size={14} /> Enviar arquivo</button>
                    {selCommunity && <button onClick={() => { setShowPollForm(v => !v); setShowEmojiPicker(false) }} style={composerMenuStyle}><Icon d={Icons.grid} size={14} /> Criar enquete</button>}
                    <button onClick={() => { setComposerMenu(v => !v); setShowEmojiPicker(false) }} style={composerMenuStyle}><Icon d={Icons.smile} size={14} /> Emoji</button>
                  </div>
                )}
                <textarea
                  ref={composerRef}
                  value={input}
                  onChange={e => { onComposerChange(e.target.value); e.currentTarget.style.height = 'auto'; e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 220)}px` }}
                  onKeyDown={handleComposerKeyDown}
                  rows={1}
                  placeholder={view === 'servidores' ? `Conversar em #${channelLabel}` : `Conversar com ${peerTitle || 'amigo'}`}
                  aria-label="Mensagem"
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: text, fontSize: 14, fontFamily: 'inherit', resize: 'none', maxHeight: 220, lineHeight: 1.375, padding: '4px 0' }}
                />
                {/* screen share quick */}
                {activeCall && <button onClick={async () => { try { if (!supportsScreenShare() && !activeCall.sharing) { setError(SCREEN_UNAVAILABLE_MSG); return } await callManager.toggleScreen(); setError(null) } catch (e: any) { setError(String(e?.message ?? e)) } }} disabled={!supportsScreenShare() && !activeCall.sharing} title={supportsScreenShare() ? 'Compartilhar sua tela com quem está na chamada (o vídeo da tela substitui o da câmera)' : 'Seu navegador não permite compartilhar tela — use a câmera'} aria-label="Compartilhar tela" style={{ background: activeCall.sharing ? t.green : 'transparent', border: `1px solid ${borderColor}`, color: activeCall.sharing ? '#fff' : (supportsScreenShare() ? muted : t.muted), opacity: supportsScreenShare() || activeCall.sharing ? 1 : 0.5, cursor: supportsScreenShare() || activeCall.sharing ? 'pointer' : 'not-allowed', padding: '5px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'center' }}><Icon d={Icons.screen} size={12} /> Tela</button>}
                <button onClick={() => { setShowEmojiPicker(true); setComposerMenu(v => !v) }} className="composer-icon" title="Emoji (Ctrl+E)" aria-label="Emoji" aria-expanded={composerMenu} style={{ alignSelf: 'center' }}><Icon d={Icons.smile} size={18} /></button>
                <button onClick={send} disabled={!input.trim()} className="composer-icon send" title={input.trim() ? 'Enviar (Enter)' : 'Digite uma mensagem'} aria-label="Enviar" style={{ opacity: !input.trim() ? 0.45 : 1, cursor: !input.trim() ? 'not-allowed' : 'pointer', background: input.trim() ? t.accent : 'transparent', color: input.trim() ? '#fff' : muted, borderRadius: 8, padding: '6px 10px', flexShrink: 0, alignSelf: 'flex-end' }}><Icon d={Icons.send} size={16} /></button>
              </div>
              {/* Barra de formatação markdown — visível só quando há texto, como no Discord. */}
              {input.trim().length > 0 && (
                <div style={{ display: 'flex', gap: 2, marginTop: 4, paddingLeft: 4, flexWrap: 'wrap' }}>
                  {FORMAT_BUTTONS.map(fb => (
                    <button
                      key={fb.id}
                      onClick={() => wrapComposer(fb.id)}
                      title={fb.title}
                      aria-label={fb.title}
                      className="composer-icon"
                      style={{ color: muted, padding: '3px 5px', fontSize: 12, fontWeight: 800 }}
                    >{fb.glyph}</button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 10, color: muted, marginTop: 6, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>{selPeer && selPeer.state !== 'CONNECTED' ? 'offline — mensagens ficarão pendentes e entregarão ao voltar' : '↵ Enter para enviar • Shift+Enter quebra linha'}</span>
                <span style={{ opacity: 0.7, display: 'none' } as any}></span>
              </div>
              <div style={{ fontSize: 10, color: muted, marginTop: 2, textAlign: 'center', opacity: 0.7 }}>Arquivos 256KB • todos semeiam • status: pending → sent → delivered</div>
            </div>
          )}
        </div>
        {/* Painel de membros à direita — estilo Discord original */}
        {view === 'servidores' && selCommunity && (
          <div style={{ width: 240, background: sidebarBg, borderLeft: `1px solid ${borderColor}`, display: 'flex', flexDirection: 'column', overflowY: 'auto', flexShrink: 0 }} className="hide-mobile">
            {bots.length > 0 && (
              <div style={{ padding: '12px 8px' }}>
                <div className="member-group-head">BOTS — {bots.length}</div>
                {bots.map(b => {
                  const botRole = roles.find(r => r.id === b.roleId)
                  return (
                    <div key={b.id} className="member-row">
                      <span style={{ width: 28, height: 28, borderRadius: '50%', background: botRole?.color ?? t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, flexShrink: 0 }}>{b.avatar}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: botRole?.color ?? text, display: 'flex', alignItems: 'center', gap: 4 }}>
                          {b.name}<span style={{ fontSize: 8, fontWeight: 800, background: t.accent, color: '#fff', padding: '1px 3px', borderRadius: 3 }}>BOT</span>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: b.online ? t.green : '#80848e', display: 'inline-block' }} />
                        </div>
                        <div style={{ fontSize: 10, color: muted }}>{botRole?.name ?? 'Bots'} • #{b.discriminator}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
            {roles.filter(r => r.hoist).sort((a, b) => b.position - a.position).map(role => {
              const membersInRole = (activeComm?.members ?? []).filter(([fp]) => (memberRolesCache[fp] ?? []).includes(role.id))
              if (membersInRole.length === 0) return null
              return (
                <div key={role.id} style={{ padding: '6px 8px' }}>
                  <div className="member-group-head" style={{ color: role.color }}>{role.name} — {membersInRole.length}</div>
                  {membersInRole.map(([fp, nick]) => (
                    <div key={fp} className="member-row">
                      <Avatar name={nick || fp} fp={fp} size={28} avatarB64={socialProfiles[fp]?.avatar_b64} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: role.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick || fp}</div>
                        <div style={{ fontSize: 10, color: muted, fontFamily: 'JetBrains Mono' }}>{fp.slice(0, 8)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )
            })}
            {(() => {
              const nonHoisted = (activeComm?.members ?? []).filter(([fp]) => {
                const r = memberRolesCache[fp] ?? []
                return !roles.some(x => x.hoist && r.includes(x.id))
              })
              const selfFp = identity?.fingerprint ?? ''
              const isOnlineFp = (fp: string) => onlineFps.has(fp) || (!!selfFp && fp === selfFp)
              const memberRow = ([fp, nick]: [string, string, string]) => {
                if (bots.some(b => b.name === nick)) return null
                const hasRole = (memberRolesCache[fp] ?? []).length > 0
                if (hasRole && roles.some(r => r.hoist && (memberRolesCache[fp] ?? []).includes(r.id))) return null
                const online = isOnlineFp(fp)
                return (
                  <div key={fp} className="member-row">
                    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}><Avatar name={nick || fp} fp={fp} size={28} avatarB64={socialProfiles[fp]?.avatar_b64} /><span style={{ position: 'absolute', right: -2, bottom: -2, width: 10, height: 10, background: online ? t.green : '#80848e', border: `2px solid ${sidebarBg}`, borderRadius: '50%' }} /></span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick || fp}</div>
                      <div style={{ fontSize: 10, color: muted }}>{online ? 'Online' : 'Offline'}</div>
                    </div>
                  </div>
                )
              }
              const onlineMembers = nonHoisted.filter(([fp]) => isOnlineFp(fp))
              const offlineMembers = nonHoisted.filter(([fp]) => !isOnlineFp(fp))
              return (
                <div style={{ padding: '6px 8px' }}>
                  <div className="member-group-head">ONLINE — {onlineMembers.length}</div>
                  {onlineMembers.map(memberRow)}
                  {offlineMembers.length > 0 && <div className="member-group-head">OFFLINE — {offlineMembers.length}</div>}
                  {offlineMembers.map(memberRow)}
                  {bots.length === 0 && roles.filter(r => r.hoist).length === 0 && onlinePeers.length === 0 && (
                    <div style={{ fontSize: 11, color: muted, padding: '6px 8px', opacity: 0.7 }}>Nenhum membro extra — convide amigos com o token do servidor.</div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>

      {/* PAINEL DE SERVIDORES — um único fluxo para criar/entrar/convidar.
          Substitui três modais (convite inline, choose/create legado e o
          "serverFlow" espalhado) que montavam o link cada um do seu jeito.
          O hub usa `ui.Modal` e o token/link reais do core. */}
      <ServerHubModal
        open={showCreateServer && serverFlow !== 'create'}
        onClose={closeServerModal}
        mode="desktop"
        servers={serverSummaries}
        selectedId={selCommunity}
        onSelect={(id) => {
          setSelCommunity(id)
          const c = communities.find((x) => x.id === id)
          setSelConv(c?.channels[0]?.[0] ?? null)
          setView('servidores')
        }}
        members={memberPairing}
        onCreate={() => setServerFlow('create')}
        onJoined={async (id) => {
          await refreshCommunities()
          setSelCommunity(id)
          setView('servidores')
          const list = await services.communitiesList().catch(() => [] as CommunityView[])
          const c = (list ?? []).find((x) => x.id === id)
          setSelConv(c?.channels[0]?.[0] ?? null)
          closeServerModal()
        }}
        autoToken={inviteFromLink}
        onError={(msg) => setError(msg)}
      />

      {/* Convite de um servidor JÁ aberto (menu do servidor → Convidar). */}
      <Modal
        open={showInvite}
        onClose={() => setShowInvite(false)}
        title={`Convidar para ${activeComm?.name ?? 'servidor'}`}
        subtitle="Envie o token — ele funciona em qualquer aparelho, sem depender de link."
        width={560}
        dialogLabel="Convidar pessoas"
      >
        {inviteTokenError ? (
          <Notice tone="danger" icon="warn">{inviteTokenError}</Notice>
        ) : selCommunity ? (
          <InvitePanel
            communityId={selCommunity}
            canCreateInvite={activeComm?.is_owner === true}
            onError={(msg) => setError(msg)}
          />
        ) : null}
      </Modal>

      {/* v6 — assistente de criação (4 passos + convite). O próprio wizard
          cria via services.createCommunity(name, canais, opts do wizard). */}
      <CreateServerWizard
        open={showCreateServer && serverFlow === 'create'}
        onClose={closeServerModal}
        onCreated={(id) => {
          setUnreadServers(prev => new Set(prev).add(id))
          refreshCommunities()
          closeServerModal()
          setSelCommunity(id)
        }}
      />

      <DownloadsPanel
        open={showDownloads}
        onClose={() => setShowDownloads(false)}
        onDoneToast={(msg) => { try { setNotice(msg); window.setTimeout(() => setNotice(null), 6000) } catch { /* ignore */ } }}
      />

      {/* v6 — painel do bot: prefixo, comandos REST, webhook, escopos, token. */}
      {(() => {
        const cb = configBotId ? bots.find(b => b.id === configBotId) ?? null : null
        if (!cb || !selCommunity) return null
        return (
          <BotConfigPanel
            communityId={selCommunity}
            bot={cb}
            // FONTE ÚNICA: `mergeChannels` deduplica por id E por nome. Antes esta
            // linha concatenava as duas listas sem filtro, e o mesmo canal
            // aparecia duas vezes na lista de escopos do bot.
            channels={mergeChannels(activeComm?.channels, extraChannels)}
            onSaved={() => { refreshExtras(selCommunity); setConfigBotId(null) }}
            onClose={() => setConfigBotId(null)}
          />
        )
      })()}

      {/* Menu de contexto do canal */}
      {channelMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 75 }} onClick={() => setChannelMenu(null)}>
          <div
            style={{ position: 'fixed', left: channelMenu.x, top: channelMenu.y, background: '#111214', borderRadius: 8, padding: 6, boxShadow: '0 8px 16px rgba(0,0,0,.4)', width: 200, zIndex: 76 }}
            onClick={e => e.stopPropagation()}
          >
            <button className="dd-item" onClick={() => { const id = channelMenu.id; setChannelMenu(null); const ch = mergeChannels(activeComm?.channels, extraChannels).find(c => c.id === id); if (ch) { setChannelMenu(null); setShowServerSettings(true); setServerTab('canais'); setPendingChannelEdit(ch.id) } }}><span style={{ display: 'inline-flex', marginRight: 2 }}><Icon d={Icons.edit} size={14} /></span> Editar canal</button>
            <button className="dd-item" onClick={async () => { if (!selCommunity) return; const id = channelMenu.id; setChannelMenu(null); if (!confirm('Excluir este canal?')) return; try { await services.channelDelete(selCommunity, id); refreshExtras(selCommunity); if (selConv === id) { const fallback = activeComm?.channels.find(([cid]) => cid !== id)?.[0] ?? extraChannels.find(c => c.id !== id)?.id ?? null; setSelConv(fallback) } } catch (e: any) { setError(String(e?.message ?? e)) } }} style={{ color: t.red }}><span style={{ display: 'inline-flex', marginRight: 2 }}><Icon d={Icons.trash} size={14} /></span> Excluir canal</button>
            <button className="dd-item" onClick={() => { const id = channelMenu.id; setChannelMenu(null); navigator.clipboard?.writeText?.(id).catch(() => {}) }}><span style={{ display: 'inline-flex', marginRight: 2 }}><Icon d={Icons.copy} size={14} /></span> Copiar ID</button>
            <button
              className="dd-item"
              onClick={() => { const id = channelMenu.id; setChannelMenu(null); toggleMuteChannel(id) }}
            ><span style={{ display: 'inline-flex', marginRight: 2 }}><Icon d={prefs.mutedChannels.includes(channelMenu.id) ? Icons.eye : Icons.eyeOff} size={14} /></span> {prefs.mutedChannels.includes(channelMenu.id) ? 'Ativar notificações' : 'Silenciar canal'}</button>
          </div>
        </div>
      )}

      {/* Configurações do servidor — componente próprio (server/ServerSettings).
          Substitui o modal de 5 abas que vivia inline aqui. */}
      {showServerSettings && selCommunity && activeComm && (
        <ServerSettings
          serverId={activeComm.id}
          serverName={activeComm.name}
          ownerFp={activeComm.owner_fp}
          myFp={identity?.fingerprint}
          description={activeComm.description}
          category={activeComm.category}
          channelsSummary={activeComm.channels}
          channelsFull={extraChannels}
          members={activeComm.members}
          roles={roles}
          bots={bots}
          memberRoles={memberRolesCache}
          error={error}
          onError={setError}
          onClose={() => setShowServerSettings(false)}
          onRename={async (nome) => {
            await services.communityRename(selCommunity, nome)
            refreshCommunities()
          }}
          onSetMeta={async (patch) => {
            await services.communitySetMeta(selCommunity, patch)
            refreshCommunities()
          }}
          onChannelCreate={async (d) => {
            const id = await services.channelCreate(selCommunity, d.name, {
              topic: d.topic,
              category: d.category,
              kind: d.kind,
            })
            refreshExtras(selCommunity)
            setSelConv(id)
          }}
          onChannelUpdate={async (id, d) => {
            await services.channelRename(selCommunity, id, d.name)
            await services.channelSetTopic(selCommunity, id, d.topic)
            await services.channelSetCategory(selCommunity, id, d.category)
            refreshExtras(selCommunity)
          }}
          onChannelDelete={async (id) => {
            await services.channelDelete(selCommunity, id)
            refreshExtras(selCommunity)
            if (selConv === id) {
              const fallback = mergeChannels(activeComm.channels, extraChannels).find(c => c.id !== id)?.id ?? null
              setSelConv(fallback)
            }
          }}
          onChannelMove={async (id, categoria) => {
            await services.channelSetCategory(selCommunity, id, categoria)
            refreshExtras(selCommunity)
          }}
          onRoleSave={async (d, id) => {
            if (id) await services.roleUpdate(selCommunity, id, d)
            else await services.roleCreate(selCommunity, d)
            refreshExtras(selCommunity)
          }}
          onRoleDelete={async (id) => {
            await services.roleDelete(selCommunity, id)
            refreshExtras(selCommunity)
          }}
          onMemberAssign={async (fp, roleId) => {
            await services.memberAssignRole(selCommunity, fp, roleId)
            refreshExtras(selCommunity)
          }}
          onMemberUnassign={async (fp, roleId) => {
            await services.memberUnassignRole(selCommunity, fp, roleId)
            refreshExtras(selCommunity)
          }}
          onMemberKick={async (fp) => {
            await services.memberKick(selCommunity, fp)
            refreshCommunities()
            refreshExtras(selCommunity)
          }}
          onBotCreate={async (d) => {
            await services.botCreate(selCommunity, d)
            refreshExtras(selCommunity)
          }}
          onBotUpdate={async (id, patch) => {
            await services.botUpdate(selCommunity, id, patch)
            refreshExtras(selCommunity)
          }}
          onBotDelete={async (id) => {
            await services.botDelete(selCommunity, id)
            refreshExtras(selCommunity)
          }}
          onConfigBot={setConfigBotId}
          onMakeInvite={async () =>
            services.makeInvite(selCommunity, identity?.fingerprint ?? '000000000000')
          }
          onRefresh={() => refreshExtras(selCommunity)}
          initialSection={SECTION_IDA[serverTab]}
          editChannelId={pendingChannelEdit}
          presetCategory={pendingCategory}
          onConsumedPending={() => {
            setPendingChannelEdit(null)
            setPendingCategory(null)
          }}
        />
      )}

      {/* INCOMING CALL — igual Discord: card escuro com aceitar/recusar */}
      {incomingCall && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 90 }}>
          <div style={{ background: '#232428', border: `1px solid ${borderColor}`, borderRadius: 12, padding: 24, width: 420, textAlign: 'center', boxShadow: '0 12px 32px rgba(0,0,0,.5)' }}>
            <div style={{ width: 72, height: 72, borderRadius: '50%', background: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, color: '#fff', fontWeight: 800 }}>{(incomingCall.nickname || incomingCall.from_fp).charAt(0).toUpperCase()}</div>
            <div style={{ fontWeight: 800, color: t.heading, marginTop: 12, fontSize: 18 }}>{incomingCall.nickname || incomingCall.from_fp.slice(0,12)} está ligando…</div>
            <div style={{ fontSize: 12, color: muted, marginTop: 4 }}>Chamada de {incomingCall.kind === 'video' ? 'vídeo' : 'voz'} • todos semeiam (mesh)</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 12 }}>
              <label htmlFor="incoming-quality" style={{ fontSize: 11, color: muted, fontWeight: 700 }}>Qualidade</label>
              <select id="incoming-quality" aria-label="Qualidade da chamada" value={callQuality} onChange={e => changeQuality(e.target.value as CallQuality)} style={{ background: '#1e1f22', color: t.text, border: `1px solid ${borderColor}`, borderRadius: 6, padding: '6px 8px', fontSize: 12 }}>
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="4K">4K</option>
              </select>
            </div>
            {qualityError && <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 8 }}>{qualityError}</div>}
            <div style={{ display: 'flex', gap: 12, marginTop: 18 }}>
              <button onClick={handleIncomingReject} style={{ flex: 1, background: t.red, color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontWeight: 800, cursor: 'pointer' }}>Recusar</button>
              <button onClick={handleIncomingAccept} style={{ flex: 1, background: t.green, color: '#fff', border: 'none', padding: 12, borderRadius: 8, fontWeight: 800, cursor: 'pointer' }}>Aceitar</button>
            </div>
          </div>
        </div>
      )}

      {/* Painel lateral: a navegação e a conversa permanecem acessíveis durante a chamada. */}
      {activeCall && (
        <div data-testid="call-panel" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: callPanelSize === 'compact' ? 300 : callPanelSize === 'normal' ? 'clamp(320px, 36vw, 520px)' : 'min(56vw, 720px)', background: '#0f0f0f', zIndex: 88, display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${borderColor}`, boxShadow: '-8px 0 28px rgba(0,0,0,.2)', transition: 'width 180ms ease' }}>
          <div style={{ minHeight: 56, height: 'auto', background: '#232428', borderBottom: `1px solid ${borderColor}`, display: 'flex', flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 250, flex: '1 1 250px' }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, background: `${t.accent}22`, color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{activeCall.kind === 'video' ? <Icon d={Icons.video} size={16} /> : <Icon d={Icons.phone} size={16} />}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 800, color: t.heading, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{conversations.find(c=>c.id===activeCall.convId)?.title ?? peerTitle ?? 'Chamada'}</span>
                {/* v6: fase da chamada (chamando/conectando/reconectando…) com elapsed */}
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                  <CallPhaseBadge phase={activeCall.phase} startAt={activeCall.startAt} nowMs={nowMs} mediaLive={mediaLive} />
                  {/* Cronômetro já conectado. Antes ficava grudado no título e
                      sumia quando o badge virava "Conectado • MM:SS". */}
                  <span style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', fontWeight: 600 }}>{fmtDuration(callDuration)}</span>
                </span>
              </span>
              <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }} aria-label="Tamanho do painel da chamada">
                <button type="button" data-testid="call-panel-smaller" aria-label="Diminuir painel da chamada" title={callPanelSize === 'compact' ? 'Painel já está compacto' : 'Diminuir painel'} disabled={callPanelSize === 'compact'} onClick={() => setCallPanelSize(callPanelSize === 'expanded' ? 'normal' : 'compact')} style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${borderColor}`, background: inputBg, color: callPanelSize === 'compact' ? muted : text, opacity: callPanelSize === 'compact' ? 0.5 : 1, cursor: callPanelSize === 'compact' ? 'default' : 'pointer' }}>↑</button>
                <button type="button" data-testid="call-panel-larger" aria-label="Aumentar painel da chamada" title={callPanelSize === 'expanded' ? 'Painel já está expandido' : 'Aumentar painel'} disabled={callPanelSize === 'expanded'} onClick={() => setCallPanelSize(callPanelSize === 'compact' ? 'normal' : 'expanded')} style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${borderColor}`, background: inputBg, color: callPanelSize === 'expanded' ? muted : text, opacity: callPanelSize === 'expanded' ? 0.5 : 1, cursor: callPanelSize === 'expanded' ? 'default' : 'pointer' }}>↓</button>
              </span>
            </span>
            <span style={{ width: 1, height: 26, background: borderColor, flexShrink: 0 }} />
            {/* PLURAL: '1 participantes' estava errado. E a rota (LAN/STUN/TURN)
                virou selo próprio — ela é a resposta de "por que não conecta?". */}
            <span style={{ fontSize: 12, color: muted, whiteSpace: 'nowrap' }}>{activeCall.participants.length} {activeCall.participants.length === 1 ? 'participante' : 'participantes'}</span>
            {/* HONESTIDADE (proxy/full): a mídia WebRTC NÃO passa pelo
                SOCKS5/Tor do app — não presenting o modo como protetor da
                chamada. O aviso fica visível o tempo todo no modo anônimo. */}
            {(privacyMode === 'proxy' || privacyMode === 'full') && (
              <span
                title="A mídia (áudio/vídeo/tela) usa sockets UDP diretos do WebRTC, fora do proxy/Tor do app. Os participantes da chamada veem seu IP real. Mensagens e arquivos seguem protegidos pelo modo."
                style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, background: `${t.yellow}22`, color: t.yellow, padding: '3px 8px', borderRadius: 99, whiteSpace: 'nowrap', cursor: 'help' }}
              >chamada não anônima</span>
            )}
            <span
              title={callManager.getRungSummary() === 'TURN' ? 'Rota via TURN: os dois estão atrás de CGNAT e o tráfego WebRTC sai pelo servidor TURN' : callManager.getRungSummary() === 'LAN' ? 'Rota direta na rede local' : 'Rota direta via STUN (saiu do NAT)'}
              style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, background: callManager.getRungSummary() === 'n/d' ? '#3a3a3c' : `${t.green}22`, color: callManager.getRungSummary() === 'n/d' ? muted : t.green, padding: '3px 8px', borderRadius: 99, whiteSpace: 'nowrap' }}
            >{callManager.getRungSummary() === 'n/d' ? 'sem rota' : `rota ${callManager.getRungSummary()}`}</span>
            <label htmlFor="call-quality" style={{ fontSize: 11, color: muted, fontWeight: 700, marginLeft: 4 }}>Qualidade</label>
            <select id="call-quality" aria-label="Qualidade da chamada" value={(activeCall.quality as CallQuality | undefined) ?? callQuality} onChange={e => changeQuality(e.target.value as CallQuality)} style={{ background: '#1e1f22', color: t.text, border: `1px solid ${borderColor}`, borderRadius: 6, padding: '4px 6px', fontSize: 11 }}>
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
              <option value="4K">4K</option>
            </select>
            {(activeCall as any)?.relayActive && (
              <span title="Áudio via relay pela sinalização — latência alta, WebRTC indisponível" style={{ fontSize: 10, fontWeight: 800, background: '#f0b232', color: '#000', padding: '3px 8px', borderRadius: 99, marginLeft: 8, whiteSpace: 'nowrap' }}>via relay (latência alta)</span>
            )}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button onClick={() => setShowCallDiag((v) => !v)} title="Diagnóstico da chamada em tempo real (ICE, RTT, FPS, causa da falha)" aria-label="Diagnóstico da chamada" style={{ background: showCallDiag ? t.accent : inputBg, border: `1px solid ${borderColor}`, color: showCallDiag ? '#fff' : text, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>Diagnóstico</button>
              <button onClick={() => setShowAddToCall(true)} style={{ background: inputBg, border: `1px solid ${borderColor}`, color: text, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>+ Adicionar amigo</button>
              <button onClick={() => fileInputRef.current?.click()} style={{ background: inputBg, border: `1px solid ${borderColor}`, color: text, padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 6 }}><Icon d={Icons.attach} size={13} /> Arquivo</button>
            </span>
          </div>
          {showCallDiag && (
            <div style={{ background: '#1a1a1a', borderBottom: `1px solid ${borderColor}`, padding: '8px 12px', maxHeight: 260, overflowY: 'auto' }}>
              <CallDiagnostics compact />
            </div>
          )}
          {((activeCall.qualityNotice as string | undefined) || qualityError || (activeCall as any)?.relayActive) && (
            <div style={{ background: '#232428', borderBottom: `1px solid ${borderColor}`, padding: '6px 16px', fontSize: 11, color: qualityError ? '#ff9c9c' : t.yellow }} role="status">
              {qualityError ?? (activeCall.qualityNotice as string) ?? ((activeCall as any)?.relayActive ? `modo compatibilidade ativo (${(activeCall as any)?.relayReason ?? 'relay'}) — áudio via relay (latência alta)` : null)}
            </div>
          )}
          {/* `alignContent: 'stretch'` + tile com altura mínima real: antes o
              grid deixava uma faixa vazia embaixo dos vídeos, porque as linhas
              não ocupavam a altura disponível. */}
          {/* Quadrados da chamada: PESSOA e TELA. A contagem de colunas vem do
              número de TILES (não de participantes) — com 2 pessoas + 1 tela o
              grid antigo abria 2 colunas para 3 itens e a tela caía sozinha
              numa linha. Fixar/expandir é por `id` de TRANSMISSÃO (`p:<fp>` /
              `s:<fp>`), então a tela tem vida própria.

              TELA CHEIA NÃO acontece aqui: ela é um overlay (`ScreenStage`)
              por cima de TUDO. Antes o "expandir" só aumentava o quadrado
              dentro do painel (`min(56vw, 720px)`), o que não é tela cheia. */}
          <div
            style={{
              flex: 1,
              display: 'grid',
              gridTemplateColumns: `repeat(${Math.min(callTiles.length, callPanelSize === 'compact' ? 1 : 2)}, minmax(0, 1fr))`,
              gridAutoRows: `minmax(${callPanelSize === 'compact' ? 112 : 150}px, 1fr)`,
              alignContent: 'stretch',
              gap: 10,
              padding: 12,
              overflowY: 'auto',
              background: '#1a1a1a',
              transition: 'grid-template-columns 180ms ease',
            }}
          >
            {visibleCallTiles.map((tile) => (
              <CallTileComponent
                key={tile.id}
                tile={tile}
                pinned={tile.id === pinnedTileId}
                onPin={(id) => {
                  setPinnedTileId((cur) => (cur === id ? null : id))
                  // Fixar NÃO abre tela cheia: são independentes.
                }}
                onExpand={(id) => setExpandedTileId((cur) => (cur === id ? null : id))}
                showAudioControls
                callDeafened={!!activeCall.deafened}
                palette={{ heading: t.heading, muted, green: t.green, red: t.red, accent: t.accent, border: borderColor }}
                minHeight={callPanelSize === 'compact' ? 112 : 150}
                avatarColor={avatarColor}
              />
            ))}
          </div>
          {/* A linha do aviso de mesh ficou FORA do grid de propósito: dentro
              dele virava mais uma linha (`gridColumn: 1 / -1`) e disputava a
              altura com os vídeos via `1fr` — metade da tela ficava vazia. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px 16px', fontSize: 11, color: muted, borderTop: `1px solid ${borderColor}`, background: '#1a1a1a', flexShrink: 0 }}>
            <Icon d={Icons.users} size={13} />
            <span>{activeCall.participants.length === 1 ? 'convide mais alguém para a mídia ir mais estável' : `mesh P2P • ${activeCall.participants.length} pessoas trocam áudio e tela entre si`}</span>
            <button onClick={() => fileInputRef.current?.click()} style={{ background: 'transparent', border: 'none', color: t.accent, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px' }}><Icon d={Icons.attach} size={12} /> enviar arquivo</button>
          </div>
          {/* controles Discord */}
          <div style={{ height: 76, background: '#232428', borderTop: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <button onClick={()=>{ setIsMuted(m=>!m); callManager.toggleMute() }} title={isMuted ? 'Ativar microfone' : 'Silenciar'} aria-label={isMuted ? 'Ativar microfone' : 'Silenciar'} style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: isMuted ? t.red : '#3a3a3c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isMuted ? <Icon d={Icons.micOff} size={18} /> : <Icon d={Icons.mic} size={18} />}</button>
            <button onClick={()=>{ setIsDeafened(d=>!d); callManager.toggleDeafen() }} title={isDeafened ? 'Ativar áudio' : 'Ensurdecer'} aria-label={isDeafened ? 'Ativar áudio' : 'Ensurdecer'} style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: isDeafened ? t.red : '#3a3a3c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isDeafened ? <Icon d={Icons.volumeX} size={18} /> : <Icon d={Icons.headphones} size={18} />}</button>
            <button onClick={()=> callManager.toggleCamera()} title="Câmera" aria-label="Câmera" style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: activeCall.cameraOn ? t.green : '#3a3a3c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon d={Icons.video} size={18} /></button>
            {/* TELA — antes: um botão só, sem estado no rótulo, sem escolha de
                fonte e sem forma de PARAR a não ser pelo botão nativo do SO.
                Agora: rótulo que muda ("Compartilhar"/"Parar"), escolha de
                tela-inteira vs janela, e o alvo some quando para. */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              {activeCall.sharing ? (
                <button
                  onClick={() => callManager.stopScreenShare().catch((e: any) => setError(String(e?.message ?? e)))}
                  data-testid="call-screen-stop"
                  title="Parar de compartilhar"
                  aria-label="Parar de compartilhar"
                  style={{ height: 48, width: 48, borderRadius: '50%', border: 'none', background: t.red, color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                ><Icon d={Icons.screen} size={18} /></button>
              ) : (
                <>
                  <button
                    onClick={() => { if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return } setShowScreenMenu(v => !v) }}
                    disabled={!supportsScreenShare()}
                    data-testid="call-screen-share"
                    title={supportsScreenShare() ? 'Compartilhar tela (escolher fonte)' : (screenShareUnavailableReason() ?? 'Este navegador não permite compartilhar tela')}
                    aria-label="Compartilhar tela"
                    aria-expanded={showScreenMenu}
                    style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: showScreenMenu ? t.accent : '#3a3a3c', color: '#fff', opacity: supportsScreenShare() ? 1 : 0.45, cursor: supportsScreenShare() ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  ><Icon d={Icons.screen} size={18} /></button>
                  {showScreenMenu && (
                  <>
                  <div
                    style={{ position: 'fixed', inset: 0, zIndex: 199, background: 'transparent' }}
                    onClick={() => setShowScreenMenu(false)}
                    aria-hidden
                  />
                  <div
                    style={{ position: 'absolute', bottom: 56, left: 0, background: '#232428', border: `1px solid ${borderColor}`, borderRadius: 8, padding: 6, boxShadow: '0 8px 24px rgba(0,0,0,.5)', zIndex: 200, display: 'flex', flexDirection: 'column', gap: 2 }}
                    onClick={e => e.stopPropagation()}
                    role="menu" aria-label="Compartilhar tela"
                  >
<button
                    onClick={() => { if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return } setShowScreenMenu(false); callManager.startScreenShare({ source: 'screen', audio: 'system' }).catch((e: any) => setError(String(e?.message ?? e))) }}
                    disabled={!supportsScreenShare()}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: 200, padding: '8px 10px', background: 'transparent', border: 'none', color: '#fff', cursor: supportsScreenShare() ? 'pointer' : 'not-allowed', fontSize: 12.5, fontWeight: 700, textAlign: 'left', borderRadius: 6 }}
                  ><Icon d={Icons.screen} size={16} /> Tela inteira</button>
                  <button
                    onClick={() => { if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return } setShowScreenMenu(false); callManager.startScreenShare({ source: 'window', audio: 'system' }).catch((e: any) => setError(String(e?.message ?? e))) }}
                    disabled={!supportsScreenShare()}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: 200, padding: '8px 10px', background: 'transparent', border: 'none', color: '#fff', cursor: supportsScreenShare() ? 'pointer' : 'not-allowed', fontSize: 12.5, fontWeight: 700, textAlign: 'left', borderRadius: 6 }}
                  ><Icon d={Icons.grid} size={16} /> Janela/Aba</button>
                    <div style={{ height: 1, background: borderColor, margin: '2px 0' }} />
                    <button
                      onClick={() => { if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return } setShowScreenMenu(false); setShowScreenPicker(true) }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, width: 200, padding: '8px 10px', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: 12.5, fontWeight: 700, textAlign: 'left', borderRadius: 6 }}
                    ><Icon d={Icons.settings} size={16} /> Configurações avançadas…</button>
                  </div>
                  </>
                  )}
                </>
              )}
            </div>
            <button onClick={() => callManager.leave()} data-testid="call-leave" aria-label="Sair da chamada" title="Sair da chamada" style={{ width: 64, height: 48, borderRadius: 24, border: 'none', background: t.red, color: '#fff', cursor: 'pointer', fontWeight: 800, fontSize: 13 }}>Sair</button>
          </div>
        </div>
      )}

      {/* CRIAR GRUPO — igual Discord */}
      {showCreateGroup && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }} onClick={() => setShowCreateGroup(false)}>
          <div style={{ background: t.panel, border: `1px solid ${borderColor}`, borderRadius: 12, padding: 22, width: 520 }} onClick={e=>e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h3 style={{ fontWeight: 900, color: t.heading, margin: 0, flex: 1 }}>Criar grupo — selecione amigos</h3>
              <button onClick={()=>setShowCreateGroup(false)} style={{ background:'transparent', border:'none', color:muted, cursor:'pointer', fontSize:16 }}>x</button>
            </div>
            <div style={{ fontSize: 11, color: muted, marginTop: 6 }}>Escolha até 9 amigos (você + 9 = 10 max, igual Discord). Depois você pode ligar com todos.</div>
            <label style={{ display:'block', fontSize:11, fontWeight:700, color:muted, marginTop:14, marginBottom:6 }}>NOME DO GRUPO (opcional)</label>
            <input value={groupTitle} onChange={e=>setGroupTitle(e.target.value)} placeholder="Ex: Squad" style={{ width:'100%', background: inputBg, border:`1px solid ${borderColor}`, borderRadius:8, padding:'10px 12px', color:text, boxSizing:'border-box' }} />
            <div style={{ fontSize: 11, fontWeight: 700, color: muted, marginTop: 14, marginBottom: 6 }}>AMIGOS ({friendsAccepted.length})</div>
            <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, border:`1px solid ${borderColor}`, borderRadius:8, padding:8, background: inputBg }}>
              {friendsAccepted.length===0 && <div style={{ fontSize:12, color:muted, padding:12, textAlign:'center' }}>Nenhum amigo — adicione em Amigos → Adicionar</div>}
              {friendsAccepted.map(f => {
                const checked = groupPick.has(f.fp)
                return (
                  <label key={f.fp} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 8px', borderRadius:6, background: checked? `${t.accent}22` : 'transparent', cursor:'pointer' }}>
                    <input type="checkbox" checked={checked} onChange={e=> setGroupPick(prev=>{ const n=new Set(prev); if(e.target.checked) n.add(f.fp); else n.delete(f.fp); return n })} />
                    <Avatar name={f.nickname||f.fp} fp={f.fp} size={28} avatarB64={socialProfiles[f.fp]?.avatar_b64} />
                    <span style={{ fontSize:13, fontWeight:600, color:text, flex:1 }}>{f.nickname || f.fp}</span>
                    <span style={{ fontSize:10, color:muted, fontFamily:'JetBrains Mono' }}>{f.fp.slice(0,8)}</span>
                  </label>
                )
              })}
            </div>
            <div style={{ display:'flex', gap:8, marginTop:16 }}>
              <button onClick={()=>setShowCreateGroup(false)} style={{ flex:1, background:inputBg, border:`1px solid ${borderColor}`, color:text, padding:10, borderRadius:8, fontWeight:700, cursor:'pointer' }}>Cancelar</button>
              <button onClick={createGroupNow} disabled={groupPick.size===0} style={{ flex:1, background: groupPick.size===0? '#3a3a3c' : t.green, color:'#fff', border:'none', padding:10, borderRadius:8, fontWeight:800, cursor: groupPick.size===0? 'not-allowed':'pointer', opacity: groupPick.size===0?0.5:1 }}>Criar grupo ({groupPick.size})</button>
            </div>
          </div>
        </div>
      )}

      {/* Painel do GRUPO: membros reais, renomear e remover.
          Abre ao clicar no nome do grupo no cabeçalho. */}
      {showGroupPanel && ehGrupo && selConv && (
        <Modal
          open
          onClose={() => setShowGroupPanel(false)}
          title={selConvObj?.title || 'Grupo'}
          subtitle="Membros, nome e quem pode entrar"
          width={WIDTHS.md}
          dialogLabel="Painel do grupo"
        >
          <GroupPanel
            convId={selConv}
            title={selConvObj?.title || 'Grupo'}
            myFp={identity?.fingerprint ?? ''}
            friends={friendsAccepted}
            profiles={socialProfiles}
            onClose={() => setShowGroupPanel(false)}
            onRenamed={() => {
              // A lista de conversas vem do hook; quem recarrega é o `refresh`.
              refreshConvos()
            }}
            onChanged={() => {
              void services.groupMembers(selConv).then((m) => setGroupMemberCount(m.length)).catch(() => {})
              refreshConvos()
            }}
          />
        </Modal>
      )}

      {/* TELA CHEIA da transmissão escolhida (tela ou câmera).
          Fica ACIMA do painel e o painel CONTINUA MONTADO atrás — é o que
          mantém os `<audio>` remotos tocando. Fechar com Esc, com o botão
          "Recolher" ou quando o stream termina (o `stageTile` vira null). */}
      {stageTile && (
        <ScreenStage
          tile={stageTile}
          palette={{ heading: t.heading, muted, green: t.green, red: t.red, accent: t.accent, border: borderColor }}
          onCollapse={() => setExpandedTileId(null)}
          muted={!!activeCall?.muted}
          onToggleMute={() => { callManager.toggleMute() }}
          cameraOn={!!activeCall?.cameraOn}
          onToggleCamera={() => { void callManager.toggleCamera() }}
          onLeave={() => { void callManager.leave() }}
          callTitle={conversations.find((c) => c.id === activeCall?.convId)?.title ?? peerTitle ?? undefined}
        />
      )}
      {showAddToCall && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:80 }} onClick={()=>setShowAddToCall(false)}>
          <div style={{ background:t.panel, border:`1px solid ${borderColor}`, borderRadius:12, padding:22, width:480 }} onClick={e=>e.stopPropagation()}>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <h3 style={{ fontWeight:900, color:t.heading, margin:0, flex:1 }}>Adicionar à chamada</h3>
              <button onClick={()=>setShowAddToCall(false)} style={{ background:'transparent', border:'none', color:muted, cursor:'pointer', fontSize:16 }}>x</button>
            </div>
            <div style={{ fontSize:11, color:muted, marginTop:6 }}>Todos na chamada semeiam áudio/vídeo/tela (mesh).</div>
            <div style={{ marginTop:12, display:'flex', flexDirection:'column', gap:6, maxHeight:260, overflowY:'auto' }}>
              {friendsAccepted.filter(f=> !activeCall?.participants.find((p:any)=>p.fp===f.fp)).length===0 && <div style={{ fontSize:12, color:muted, textAlign:'center', padding:12 }}>Todos os amigos já estão na chamada</div>}
              {friendsAccepted.filter(f=> !activeCall?.participants.find((p:any)=>p.fp===f.fp)).map(f=> (
                <div key={f.fp} style={{ display:'flex', alignItems:'center', gap:10, background:inputBg, border:`1px solid ${borderColor}`, borderRadius:8, padding:'8px 10px' }}>
                  <Avatar name={f.nickname||f.fp} fp={f.fp} size={32} avatarB64={socialProfiles[f.fp]?.avatar_b64}/>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:text }}>{f.nickname||f.fp}</div>
                    <div style={{ fontSize:10, color:muted, fontFamily:'JetBrains Mono' }}>{f.fp.slice(0,12)}</div>
                  </div>
                  <button onClick={()=>{
                    if(activeCall) callManager.addParticipant(f.fp, f.nickname||f.fp)
                    else if(selConv) services.groupAdd(selConv, f.fp).then(()=>refreshConvos()).catch((e:any)=>setError(String(e?.message??e)))
                    setShowAddToCall(false)
                  }} style={{ background:t.green, color:'#fff', border:'none', padding:'6px 14px', borderRadius:6, fontWeight:800, cursor:'pointer', fontSize:12 }}>Adicionar</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showProfile && identity && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }} onClick={() => setShowProfile(false)}>
          <div style={{ background: t.panel, border: `1px solid ${borderColor}`, borderRadius: 12, padding: 0, width: 480, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <div style={{
              backgroundImage: socialProfiles[identity.fingerprint]?.banner_b64 ? `url(data:image/jpeg;base64,${socialProfiles[identity.fingerprint].banner_b64})` : `linear-gradient(135deg, ${(socialProfiles[identity.fingerprint]?.accent || t.accent)}33, ${(socialProfiles[identity.fingerprint]?.accent || t.accent)}11)`,
              backgroundSize: 'cover', backgroundPosition: 'center', borderRadius: '12px 12px 0 0', padding: '24px 20px 16px', position: 'relative',
            }}>
              <button onClick={() => setShowProfile(false)} style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(0,0,0,0.4)', border: 'none', color: '#fff', cursor: 'pointer', borderRadius: '50%', width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>x</button>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16 }}>
                <div style={{ position: 'relative' }}>
                  <Avatar name={socialProfiles[identity.fingerprint]?.display_name || identity.nickname} fp={identity.fingerprint} size={80} avatarB64={socialProfiles[identity.fingerprint]?.avatar_b64} accent={socialProfiles[identity.fingerprint]?.accent || undefined} />
                  <div style={{ position: 'absolute', bottom: -2, right: -2, width: 20, height: 20, borderRadius: '50%', background: t.green, border: `3px solid ${t.panel}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                  </div>
                </div>
                <div style={{ flex: 1, paddingBottom: 4 }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: t.heading }}>{identity.nickname}</div>
                  <button onClick={async () => { await navigator.clipboard?.writeText?.(identity.fingerprint).catch(() => {}) }} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', cursor: 'pointer', color: '#949ba4', fontSize: 12, fontFamily: 'JetBrains Mono', fontWeight: 600, padding: 0 }}>
                    {identity.fingerprint.slice(0, 12)}<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  </button>
                </div>
              </div>
            </div>
            <div style={{ padding: '16px 20px' }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, color: muted }}>NOME</label>
              <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                <input id="profile-nick" defaultValue={identity.nickname} style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: '10px', color: text }} />
                <button onClick={async () => { const el = document.getElementById('profile-nick') as HTMLInputElement | null; if (el?.value) { try { const updated = await services.identityRename(el.value.trim()); setIdentity(updated); setShowProfile(false) } catch (e: any) { setError(String(e?.message ?? e)) } } }} style={{ background: t.accent, color: '#fff', border: 'none', padding: '0 14px', borderRadius: 8, fontWeight: 800, cursor: 'pointer' }}>Salvar</button>
              </div>

              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, marginTop: 14, color: muted }}>FINGERPRINT (IDENTIFICADOR ÚNICO)</label>
              <div style={{ marginTop: 6, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontFamily: 'JetBrains Mono', fontSize: 13, color: '#949ba4', fontWeight: 700, flex: 1, wordBreak: 'break-all' }}>{identity.fingerprint}</span>
                <button onClick={async () => { await navigator.clipboard?.writeText?.(identity.fingerprint).catch(() => {}) }} style={{ background: t.accent, color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 6, fontWeight: 700, cursor: 'pointer', fontSize: 11, whiteSpace: 'nowrap' }}>Copiar</button>
              </div>

              <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, marginTop: 14, color: muted }}>MODO</label>
              <div style={{ marginTop: 6, fontSize: 12, color: text }}>{services.kind === 'native' ? 'Nativo (P2P real)' : 'Navegador (sem rede)'}</div>
              {services.kind === 'native' && status && (
                <div style={{ marginTop: 4, fontSize: 12, color: muted }}>listener TCP :{status.listen_port} • {status.online_peers} online</div>
              )}

              <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={async () => {
                    try {
                      const data = await services.vaultExport()
                      const payload = JSON.stringify({ identity: data.identity, vault_blob: data.vault_blob })
                      await navigator.clipboard?.writeText?.(payload).catch(() => {})
                      alert('Identidade copiada! Cole no outro device em "Importar identidade".')
                    } catch (e: any) { alert('Erro ao exportar: ' + String(e?.message ?? e)) }
                  }} style={{ flex: 1, background: inputBg, color: text, border: `1px solid ${borderColor}`, padding: 10, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Exportar identidade</button>
                  <button onClick={async () => {
                    const payload = prompt('Cole o código de identidade exportado:')
                    if (payload?.trim()) {
                      try {
                        const data = JSON.parse(payload)
                        await services.vaultImport(JSON.stringify(data.identity), data.vault_blob)
                        alert('Importado! Faça login com a senha da conta original.')
                      } catch (e: any) { alert('Erro ao importar: ' + String(e?.message ?? e)) }
                    }
                  }} style={{ flex: 1, background: inputBg, color: text, border: `1px solid ${borderColor}`, padding: 10, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Importar identidade</button>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {/* IGUAL DISCORD: o popup do próprio perfil leva ao editor
                      COMPLETO (avatar/banner/about/status) — antes o editor só
                      era alcançável clicando no avatar de uma mensagem sua. */}
                  <button onClick={() => { setShowProfile(false); setProfileFp(identity?.fingerprint ?? '') }} style={{ flex: 1, background: t.accent, color: '#fff', border: 'none', padding: 10, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Editar perfil</button>
                  <button onClick={() => { setShowProfile(false); setShowSettings(true) }} style={{ flex: 1, background: inputBg, color: text, border: `1px solid ${borderColor}`, padding: 10, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>Configurações</button>
                  <button onClick={() => { setPhase('lock'); setIdentity(null as any); setSelConv(null); setSelPeerFp(null); setShowProfile(false) }} style={{ flex: 1, background: '#f23f4322', color: '#f23f43', border: `1px solid #f23f4355`, padding: 10, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13 }}>
                    Sair da conta
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {showSettings && identity && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 80 }} onClick={() => setShowSettings(false)}>
          <div style={{ background: t.panel, border: `1px solid ${borderColor}`, borderRadius: 16, padding: 28, width: 520, maxWidth: 'calc(100vw - 32px)', maxHeight: '85vh', overflowY: 'auto', boxSizing: 'border-box' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <Avatar name={identity.nickname} fp={identity.fingerprint} size={48} avatarB64={socialProfiles[identity.fingerprint]?.avatar_b64} />
              <div>
                <h3 style={{ fontWeight: 900, color: t.heading, margin: 0, fontSize: 20 }}>Configurações</h3>
                <div style={{ fontSize: 13, color: muted, marginTop: 2 }}>versão {version} • modo {services.kind === 'native' ? 'nativo (P2P real)' : 'navegador (sem rede)'}</div>
              </div>
            </div>

            {services.kind === 'native' && status && (
              <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                <div style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted }}>PORTA</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: t.heading, marginTop: 2 }}>:{status.listen_port}</div>
                </div>
                <div style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '10px 14px' }}>
                  <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted }}>ONLINE</div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: t.green, marginTop: 2 }}>{status.online_peers}</div>
                </div>
              </div>
            )}

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>SEU NOME</div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
              <input id="nick-rename" defaultValue={identity.nickname} style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', color: text, fontSize: 15 }} />
              <button onClick={async () => { const el = document.getElementById('nick-rename') as HTMLInputElement | null; if (el?.value) { try { const updated = await services.identityRename(el.value.trim()); setIdentity(updated); setShowSettings(false) } catch (e: any) { setError(String(e?.message ?? e)) } } }} style={{ background: t.accent, color: '#fff', border: 'none', padding: '0 20px', borderRadius: 10, fontWeight: 800, cursor: 'pointer', fontSize: 14 }}>Salvar</button>
            </div>

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>FINGERPRINT</div>
            <div style={{ background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
              <span style={{ fontFamily: 'JetBrains Mono', fontSize: 15, color: '#949ba4', fontWeight: 700, flex: 1, wordBreak: 'break-all' }}>{identity.fingerprint}</span>
              <button onClick={async () => { await navigator.clipboard?.writeText?.(identity.fingerprint).catch(() => {}) }} style={{ background: t.accent, color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>Copiar</button>
            </div>

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 6 }}>CONEXÃO AUTOMÁTICA — IGUAL TORRENT</div>
            <div style={{ fontSize: 11, color: muted, marginBottom: 12, lineHeight: 1.5 }}>
              Não precisa digitar IP. Basta adicionar pelo fingerprint — o app abre a porta sozinho via UPnP e encontra o amigo via DHT/bootstrap automaticamente.
            </div>
            <details style={{ marginBottom: 24 }}>
              <summary style={{ fontSize: 11, fontWeight: 700, color: muted, cursor: 'pointer' }}>Avançado — digitar IP manual (opcional)</summary>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input value={addrInput} onChange={e => setAddrInput(e.target.value)} placeholder="ip:porta ou dominio:porta" style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', color: text, fontFamily: 'JetBrains Mono', fontSize: 14 }} />
                <button onClick={async () => { if (addrInput.trim()) { try { await services.connectAddr(addrInput.trim(), null); refreshNet(); setAddrInput(''); setError(null) } catch(e:any){ setError(String(e?.message??e)) } } }} style={{ background: t.accent, color: '#fff', border: 'none', padding: '0 20px', borderRadius: 10, fontWeight: 800, cursor: 'pointer', fontSize: 14 }}>OK</button>
              </div>
            </details>

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 6 }}>CHAMADAS — QUALIDADE E TURN</div>
            <div style={{ fontSize: 11, color: muted, marginBottom: 8, lineHeight: 1.5 }}>
              Qualidade salva em <span style={{ fontFamily: 'JetBrains Mono' }}>distorrent:call_quality</span> • TURN em <span style={{ fontFamily: 'JetBrains Mono' }}>distorrent:turn_url</span> (formato <span style={{ fontFamily: 'JetBrains Mono' }}>turn:host:porta</span>).
            </div>
            <label htmlFor="call-quality-pref" style={{ display: 'block', fontSize: 11, fontWeight: 700, color: muted, marginBottom: 6 }}>QUALIDADE PREFERIDA</label>
            <select id="call-quality-pref" aria-label="Qualidade preferida das chamadas" value={callQuality} onChange={e => changeQuality(e.target.value as CallQuality)} style={{ width: '100%', background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', color: text, fontSize: 14, marginBottom: 12 }}>
              <option value="480p">480p — economiza banda</option>
              <option value="720p">720p — equilibrado</option>
              <option value="1080p">1080p — alta definição</option>
              <option value="4K">4K — máxima (rede boa)</option>
            </select>
            {qualityError && <div style={{ fontSize: 12, color: '#ff9c9c', marginBottom: 12 }}>{qualityError}</div>}
            <label htmlFor="turn-url" style={{ display: 'block', fontSize: 11, fontWeight: 700, color: muted, marginBottom: 6 }}>TURN URL (opcional — relay próprio)</label>
            {!hasRelayConfigured([{ urls: turnInput } as any]) && (
              <div role="status" style={{ fontSize: 11, color: t.yellow, marginBottom: 8, lineHeight: 1.5 }}>P2P puro: sem relay configurado — chamadas fora da LAN podem falhar em NAT restritivo/4G. Sem servidor público embutido por decisão do projeto.</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input id="turn-url" value={turnInput} onChange={e => { setTurnInput(e.target.value); setTurnMsg(null) }} placeholder="turn:seu-vps:3478" spellCheck={false} autoCapitalize="none" style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', color: text, fontFamily: 'JetBrains Mono', fontSize: 14 }} />
              <button onClick={saveTurnUrl} style={{ background: t.accent, color: '#fff', border: 'none', padding: '0 20px', borderRadius: 10, fontWeight: 800, cursor: 'pointer', fontSize: 14 }}>Salvar</button>
            </div>
            {turnMsg && <div style={{ fontSize: 12, color: turnMsg.startsWith('formato') ? '#ff9c9c' : '#8cf5b8', marginBottom: 24 }}>{turnMsg}</div>}
            {!turnMsg && <div style={{ marginBottom: 24 }} />}

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>APARÊNCIA</div>
            <div style={{ marginBottom: 8 }}>
              <AppearanceSettings T={t} inputBg={inputBg} borderColor={borderColor} text={text} muted={muted} />
            </div>

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>NOTIFICAÇÕES</div>
            <div style={{ marginBottom: 16 }}>
              <SystemNotificationSettings T={t} inputBg={inputBg} borderColor={borderColor} text={text} muted={muted} />
            </div>
            <div style={{ marginBottom: 8 }}>
              <NotificationSettings
                servers={communities.map(c => ({ id: c.id, name: c.name }))}
                channelsOf={(sid) => (communities.find(c => c.id === sid)?.channels ?? []).map(([id, name]) => ({ id, name }))}
                T={t} inputBg={inputBg} borderColor={borderColor} text={text} muted={muted}
              />
            </div>

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>VOZ E ÁUDIO</div>
            <div style={{ marginBottom: 8 }}>
              <VoiceDeviceSettings T={t} inputBg={inputBg} borderColor={borderColor} text={text} muted={muted} />
            </div>

            {services.kind === 'native' && (
              <>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>TROCAR SENHA DO COFRE</div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <input type="password" value={oldPass} onChange={e => setOldPass(e.target.value)} placeholder="senha atual" style={{ flex: '1 1 150px', minWidth: 0, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', color: text, fontSize: 14 }} />
                  <input type="password" value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="nova senha" style={{ flex: '1 1 150px', minWidth: 0, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', color: text, fontSize: 14 }} />
                  <button onClick={async () => { try { await services.vaultChange(oldPass, newPass); setOldPass(''); setNewPass(''); setError(null) } catch (e: any) { setError(String(e?.message ?? e)) } }} style={{ background: t.accent, color: '#fff', border: 'none', padding: '12px 20px', borderRadius: 10, fontWeight: 800, cursor: 'pointer', fontSize: 14, flexShrink: 0 }}>Trocar</button>
                </div>
                <div style={{ fontSize: 12, color: muted, marginBottom: 24, lineHeight: 1.5 }}>
                  Sem a senha não há como recuperar a identidade — ela é protegida só neste device.
                </div>
              </>
            )}

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>COFRE & BACKUP (.STORMVAULT)</div>
            <div style={{ marginBottom: 24 }}>
              <StormVaultPanel />
            </div>
            <details style={{ marginBottom: 24 }}>
              <summary style={{ fontSize: 11, fontWeight: 700, color: muted, cursor: 'pointer' }}>Métricas do motor (dev)</summary>
              <div style={{ marginTop: 8 }}>
                <MetricsPanel />
              </div>
            </details>

            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, marginTop: 16, color: muted }}>PRIVACIDADE</label>
            <div onClick={() => { services.privacyGet().then(r => setPrivacyMode(r.mode)).catch(() => {}); setProxyPendingMode(null); void refreshPrivacyExtras(privacyMode); setShowPrivacyModal(true) }}
              style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', cursor: 'pointer' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: text }}>Modo: {PRIVACY_MODES.find(pm => pm.mode === privacyMode)?.label ?? privacyMode} • {(privacyMode === 'proxy' || privacyMode === 'full') ? (privacyProxyEffective ? 'Proxy: Ativado' : 'Proxy: OFFLINE') : 'Proxy: Desativado'}</div>
                <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>Escolha como suas mensagens trafegam. Aplicado no motor em tempo real.</div>
              </div>
              <span style={{ color: muted }}>›</span>
            </div>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 1, marginTop: 16, color: muted }}>DIAGNÓSTICO</label>
            <button onClick={() => setShowDiagnostics(true)} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, width: '100%', background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', cursor: 'pointer', textAlign: 'left' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: text }}>Diagnóstico de conexão</div>
                <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>Versão, fingerprint, peers e relay — com relatório p/ suporte.</div>
              </div>
              <span style={{ color: muted }}>›</span>
            </button>
          </div>
        </div>
      )}

      {showDiagnostics && identity && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 85 }} onClick={() => setShowDiagnostics(false)}>
          <div style={{ background: t.panel, border: `1px solid ${borderColor}`, borderRadius: 16, padding: 24, width: 560, maxHeight: '85vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
            <ConnectionDiagnostics onClose={() => setShowDiagnostics(false)} />
            <button onClick={() => setShowDiagnostics(false)} style={{ width: '100%', marginTop: 12, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: 10, color: muted, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Fechar</button>
          </div>
        </div>
      )}

      {/* COMPARTILHAR TELA — seletor de fonte/áudio/qualidade/FPS */}
      <ScreenSharePicker open={showScreenPicker} onClose={() => setShowScreenPicker(false)} onError={setError} />

      {/* PRIVACIDADE — mesmo painel do celular */}
      {showPrivacyModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 92, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={closePrivacyModal}>
          <div style={{ width: 460, maxHeight: '80vh', overflowY: 'auto', background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 12, padding: '14px 16px 16px' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontWeight: 800, fontSize: 15, color: t.heading, flex: 1 }}>Privacidade</div>
              <button onClick={closePrivacyModal} style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', fontSize: 16 }}>x</button>
            </div>
            <div style={{ fontSize: 12, color: muted, marginBottom: 12, lineHeight: 1.5 }}>Escolha como suas mensagens trafegam. Aplicado no motor em tempo real.</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
              {PRIVACY_MODES.map(pm => {
                const active = privacyMode === pm.mode
                return (
                  <label key={pm.mode} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, background: active ? `${t.accent}14` : t.rail, border: `1px solid ${active ? t.accent : t.border}`, borderRadius: 10, padding: '10px 12px', cursor: 'pointer' }}
                    onClick={() => pickPrivacyMode(pm.mode)}>
                    <input type="radio" checked={active} readOnly style={{ accentColor: t.accent, marginTop: 2 }} />
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 13, color: t.text }}>{pm.label}</div>
                      <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>{pm.description}</div>
                    </div>
                  </label>
                )
              })}
            </div>

            {/* Estado do proxy â€” sempre visÃ­vel, honesto: mostra o EFETIVO, nÃ£o sÃ³ o escolhido */}
            <div style={{ background: t.rail, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: muted }}>
                {(privacyMode === 'proxy' || privacyMode === 'full') ? (privacyProxyEffective ? 'PROXY: ATIVADO (efetivo)' : 'PROXY: OFFLINE â€” relay desligado (fail-closed)') : 'Proxy: Desativado'}
              </div>
              <div style={{ fontSize: 11, color: muted, marginTop: 2 }}>
                {(privacyMode === 'proxy' || privacyMode === 'full')
                  ? (privacyProxyEffective
                      ? `trÃ¡fego do relay saindo por ${proxyAddr || 'â€”'} (SOCKS5 â€” sem ntfy, sem HTTP externo)`
                      : 'o proxy nÃ£o respondeu ou o endereÃ§o Ã© invÃ¡lido: o relay fica DESLIGADO atÃ© ele voltar (fail-closed, sem fallback direto)')
                  : 'nenhuma conexÃ£o passa por proxy â€” relay MQTT direto dos brokers pÃºblicos'}
              </div>
            </div>

            {/* proxy flow: IP + test online + save */}
            {proxyPendingMode && (
              <div style={{ background: t.rail, border: `1px solid ${t.accent}66`, borderRadius: 10, padding: '12px', marginBottom: 12 }}>
                <div style={{ fontWeight: 800, fontSize: 13, color: t.heading, marginBottom: 6 }}>
                  {proxyPendingMode === 'full' ? 'Tor — proxy da rede Tor' : 'Proxy — endereço SOCKS5'}
                </div>
                <div style={{ fontSize: 11, color: muted, marginBottom: 8, lineHeight: 1.5 }}>
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
                    style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: '10px 12px', color: text, fontFamily: 'JetBrains Mono', fontSize: 13 }}
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
                  <button onClick={() => { setProxyPendingMode(null); setProxyTestOk(null); setProxyTestErr(null) }} style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, color: muted, padding: 10, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>Cancelar</button>
                  <button onClick={() => saveProxyAndActivate(proxyPendingMode)} disabled={!proxyAddr.trim()}
                    style={{ flex: 1, background: proxyTestOk != null ? t.green : '#3a3a3c', color: '#fff', border: 'none', padding: 10, borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 12 }}>
                    {proxyTestOk != null ? 'Ativar proxy' : 'Ativar sem teste'}
                  </button>
                </div>
                {proxyIsDefault && <div style={{ fontSize: 10, color: muted, marginTop: 6 }}>endereço padrão — edite se o seu proxy estiver noutra porta</div>}
              </div>
            )}
            <button onClick={closePrivacyModal} style={{ width: '100%', background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: 10, color: muted, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>Fechar</button>
          </div>
        </div>
      )}

      {/* Estilos da área de servidores/mensagens.
          A maior parte do que vivia aqui DUPLICAVA global.css (rail, server-head,
          dd-menu, chan-row, nav-row, member-row, tpl-card, cat-head...) e, por
          vir depois no documento, vencia as regras da folha — o mobile e o
          desktop divergiam na mesma classe. Ficaram só as regras que NÃO têm
          equivalente na folha e que são específicas deste shell. */}
      <style>{`
        .msg-row:hover .msg-tools{display:flex !important}
        mark{background:#f0b232;color:#1e1f22;border-radius:2px}
      `}</style>

      {/* ---------- MODAIS DA CAMADA SOCIAL ---------- */}
      {profileFp && (
        <ProfileModal
          fp={profileFp}
          nickname={nameOfFp(profileFp)}
          myFp={identity?.fingerprint ?? ''}
          onClose={() => setProfileFp(null)}
          onMessage={fp => { setProfileFp(null); void openDm({ fp }) }}
          // Atualização IMEDIATA de todos os consumidores (avatar da barra
          // inferior, cabeçalho, mensagens já renderizadas). O evento
          // `profile_changed` do core também chega — aplicar os dois é
          // idempotente porque o objeto é o persistido, não um patch.
          onSaved={p => setSocialProfiles(prev => ({ ...prev, [p.fp]: p }))}
        />
      )}
      {showCmdK && <CommandPalette commands={commands} onClose={() => setShowCmdK(false)} />}
      {showModeration && selCommunity && (
        <ModerationPanel
          communityId={selCommunity}
          members={(activeComm?.members ?? []) as [string, string, string][]}
          isOwner={activeComm?.owner_fp === identity?.fingerprint}
          onClose={() => setShowModeration(false)}
          onToast={setNotice}
        />
      )}
      {showEvents && selCommunity && (
        <EventPanel communityId={selCommunity} channels={extraChannels} onClose={() => setShowEvents(false)} onToast={setNotice} />
      )}
      {showChannelCfg && selCommunity && extraChannels.find(c => c.id === selConv) && (
        <ChannelSettingsModal
          communityId={selCommunity}
          channel={extraChannels.find(c => c.id === selConv)!}
          isOwner={activeComm?.owner_fp === identity?.fingerprint}
          onClose={() => setShowChannelCfg(false)}
          onToast={setNotice}
        />
      )}
      {openThread && selCommunity && (
        <ThreadViewModal communityId={selCommunity} thread={openThread} onClose={() => setOpenThread(null)} authorName={nameOfFp} />
      )}
      {forwardMsg && (
        <div onClick={() => setForwardMsg(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 250, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: t.main, border: `1px solid ${borderColor}`, borderRadius: 12, padding: 20, width: 420, maxWidth: '92vw' }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: t.heading, marginBottom: 10 }}>↪ Encaminhar mensagem</div>
            <div style={{ fontSize: 12.5, color: text, background: inputBg, borderRadius: 8, padding: 10, marginBottom: 12, maxHeight: 120, overflowY: 'auto' }}>{forwardMsg.body.slice(0, 400)}</div>
            <select value={forwardTarget} onChange={e => setForwardTarget(e.target.value)} style={{ width: '100%', background: inputBg, color: text, border: `1px solid ${borderColor}`, borderRadius: 6, padding: '8px 10px', fontSize: 13, marginBottom: 12 }}>
              <option value="">escolha o destino…</option>
              {conversations.map(c => <option key={c.id} value={c.id}>{c.title || c.id.slice(0, 8)} (DM)</option>)}
              {view === 'servidores' && extraChannels.map(c => <option key={c.id} value={`ch:${c.id}`}>#{c.name}</option>)}
            </select>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setForwardMsg(null)} style={{ background: 'transparent', border: `1px solid ${borderColor}`, color: muted, padding: '8px 14px', borderRadius: 6, cursor: 'pointer' }}>cancelar</button>
              <button onClick={doForward} disabled={!forwardTarget} style={{ background: t.accent, color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 6, fontWeight: 800, cursor: forwardTarget ? 'pointer' : 'not-allowed', opacity: forwardTarget ? 1 : 0.5 }}>Encaminhar</button>
            </div>
          </div>
        </div>
      )}
      <EmojiPicker
        open={composerMenu}
        onClose={() => setComposerMenu(false)}
        onPick={(e) => {
          setInput(v => v + e)
          requestAnimationFrame(() => composerRef.current?.focus())
        }}
        anchor="up"
      />
      {showShortcuts && (
        <div onClick={() => setShowShortcuts(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', zIndex: 250, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: t.main, border: `1px solid ${borderColor}`, borderRadius: 12, padding: 20, width: 420, maxWidth: '92vw' }}>
            <div style={{ fontSize: 16, fontWeight: 900, color: t.heading, marginBottom: 12 }}>⌨️ Atalhos de teclado</div>
            {[['Ctrl + K', 'Paleta de comandos'], ['Ctrl + F', 'Buscar mensagens'], ['Ctrl + Shift + P', 'Mensagens fixadas'], ['Ctrl + Shift + M', 'Mute/desmute'], ['Alt + ↑ / ↓', 'Trocar de conversa'], ['Esc', 'Fechar painel'], ['Enter', 'Enviar'], ['Shift + Enter', 'Nova linha'], ['Clique direito na mensagem', 'Menu completo (editar/apagar/fixar/encaminhar/thread)']].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12.5, padding: '6px 0', borderBottom: `1px solid ${borderColor}` }}>
                <span style={{ color: text, fontWeight: 700 }}>{v}</span>
                <span style={{ color: muted, fontFamily: 'JetBrains Mono', fontSize: 11 }}>{k}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
