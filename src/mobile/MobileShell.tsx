import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Avatar as ViewAvatar, PeerDot as ViewPeerDot } from '../shared/avatarView'
import { BootScreen, CreateAccount, LockScreen } from '../designs/auth/AuthScreens'
import { avatarColor } from '../shared/theme'
import { services } from '../services'
import { usePrivacySettings } from '../services/usePrivacySettings'
import { Icon, Icons } from '../shared/icons'
import { Section } from '../shared/Section'
import { useConversations, useEngineEvents, useMessages, useNetwork } from '../app/hooks'
import ConnectionDiagnostics from '../components/ConnectionDiagnostics'
import CallDiagnostics from '../components/CallDiagnostics'
import ScreenStage from '../components/calls/ScreenStage'
import { buildCallTiles, sortTilesForPin } from '../services/callTiles'
import { callRooms, salaTemAlguemParaEntrar, syncCallRooms, ROOM_SYNC_MS, type CallRoomView } from '../services/callRooms'
import { FileCard } from '../components/FileCard'
import DownloadsPanel from '../components/DownloadsPanel'
import CallPhaseBadge from '../components/CallPhaseBadge'
import { UpdateOverlay, useUpdateGate } from '../components/UpdateGate'
import { UpdateBootScreen } from '../components/UpdateBootScreen'
import { downloadManager } from '../services/downloadManager'
import { startDownload } from '../services/downloadAction'
import { botRuntime } from '../services/botRuntime'
import { StormVaultPanel } from '../components/vault/StormVaultPanel'
import { UpdateSettingsBox } from '../components/UpdateSettingsBox'
import { coalesceAsyncRefresh, throttleTrailing } from '../shared/perf'
import { pastedImages } from '../shared/clipboardImage'
import { fileSwarm, encodeFileBody, parseFileBody, type FileMsgMeta } from '../services/fileSwarm'
import ScreenSharePicker from '../components/ScreenSharePicker'
import { SoundboardPanel } from '../components/calls/SoundboardPanel'
import { callIsActive, callMediaLive } from '../services/callUiState'
import { faseExibida } from '../services/voiceCallPhase'
import MobileServerPanel from './MobileServerPanel'
import MobileCallChannel from './MobileCallChannel'
import MobileCallStage from './MobileCallStage'
import { cameraCycleLabel, shouldShowCameraFlip } from '../services/callCameras'
import { useCallCameras } from '../services/useCallCameras'
import { parseVoiceCallId } from '../services/voiceChannelRef'
import { resolveBootPhase } from '../services/bootPhase'
import { isAndroidRuntime, isIOSRuntime } from '../shared/runtime'
import { windowMembers, LIMITE_MEMBROS } from '../services/memberWindow'
import { isCallableChannel } from '../app/channels'
import {
  InvitePanel,
  JoinServerForm,
  MemberPairingList,
  ServerList,
  summarize,
  type ServerSummary,
} from '../components/server/ServerHub'
import { consumeInvite, peekInvite, subscribeInvite } from '../services/deepLink'
import { callManager, setCallIdentity, supportsScreenShare, getCallsSupport, getCallsUnavailableMessage, hasRelayConfigured, CALLS_UNAVAILABLE_MSG, SCREEN_UNAVAILABLE_MSG, screenShareUnavailableReason, ICE_RELAY_MSG, ICE_FAILED_MSG, getStoredQuality, getTurnUrl, isValidTurnUrl, getCallMediaPrefs, type CallQuality, type IncomingCall } from '../services/callManager'
import { sfxMessage, sfxRingStart, sfxRingStop, sfxCallConnect, sfxCallEnd } from '../services/sfx'
import MobileMessage from './MobileMessage'
import { agruparComAnterior, autorDaMensagem } from '../components/social/messageAuthors'
import { EmojiPicker } from '../shared/EmojiPicker'
import { NAMED_EMOJI } from '../shared/emojiSet'
import { activeToken } from '../shared/markdown'
import { RichText, type InlineCtx } from '../shared/richText'
import { useSocialWindow, useMessageActions, usePresence, useReadState } from '../app/useSocial'
import { BookmarksPanel } from '../components/social/Social'
import { introState, relationOf, canCallPeer, canOpenConversation, conversationMatchesFilter, isPresenceOnline, type ConversationFilter } from '../services/socialRules'
import { resolveContactName } from '../services/contactNames'
import { ProfileModal } from '../components/social/socialProfile'
import { GroupPanel } from '../components/social/GroupPanel'
import { GroupLeaveDialog } from '../components/social/GroupLeaveDialog'
import { QuitDialog } from '../components/QuitDialog'
import { resolveSessionStart } from '../services/appUptime'
import { shouldNotify, usePrefs } from '../shared/prefs'
import { AppearanceSettings } from '../components/prefs/AppearanceSettings'
import { NotificationSettings } from '../components/prefs/NotificationSettings'
import { SystemNotificationSettings } from '../components/prefs/SystemNotificationSettings'
import {
  notifyMessage, notifyIncomingCall, notifyReaction, notifyFriend, endCallNotice, markCallHandled,
  setOpenConversation, onOpenConversation, onCallNotificationAction, registerConversationPeer,
} from '../services/notifications'
import { VoiceDeviceSettings } from '../components/prefs/VoiceDeviceSettings'
import { MessageRetentionSettings } from '../components/prefs/MessageRetentionSettings'
import type { BotView, PresenceStatus, SearchHit, ProfileView } from '../services/models'
import type { Conversation, Identity, NetworkState, CommunityView, StoredMessage, MemberPairing, ChannelMeta } from '../services/models'
import { PRIVACY_MODES } from '../services/models'

const MONO = "'JetBrains Mono', monospace"

const FP_RE = /^(?:[0-9a-f]{12}|[0-9a-f]{64})$/

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

import { isImageName, isVideoName } from '../services/fileRules'

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

const authPalette = {
  main: '#14161a', sidebar: '#1a1d23', input: '#23262f', border: '#242830',
  heading: '#ffffff', text: '#f2f3f5', muted: '#8e929b', accent: '#5865f2', red: '#f23f42',
}

type Tab = 'home' | 'servers' | 'chats' | 'friends' | 'profile'

const Avatar = memo(ViewAvatar)

const PeerDot = memo(function PeerDot({ on, ring }: { on: boolean; ring?: string }) {
  return <ViewPeerDot s={on ? 'CONNECTED' : 'DISCONNECTED'} ring={ring} />
})

const ConvRow = memo(function ConvRow({ c, online, selected, avatarB64, myFp, onOpen, onDelete, room, onJoinRoom }: {
  c: Conversation
  online: boolean
  selected: boolean
  avatarB64?: string
  myFp?: string
  onOpen: (c: Conversation) => void
  onDelete: (id: string, title: string, isSelected: boolean) => void
  room?: CallRoomView | null
  onJoinRoom?: (c: Conversation | null, room: CallRoomView) => void
}) {
  return (
    <div className="m-row" onClick={() => onOpen(c)}>
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, borderRadius: '50%', boxShadow: room ? `0 0 0 2px ${t.green}, 0 0 8px ${t.green}66` : undefined }}>
        <Avatar name={c.title} fp={c.peer_fp} size={40} avatarB64={avatarB64} />
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
      {room && onJoinRoom && salaTemAlguemParaEntrar(room, myFp) && (        <button
          type="button"
          title={`Entrar na chamada — ${room.participants.length || 1} na sala`}
          aria-label={`Entrar na chamada de ${c.title}`}
          data-testid="mobile-join-room"
          onClick={(e) => { e.stopPropagation(); onJoinRoom(c, room) }}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: t.green, color: '#fff', border: 'none', borderRadius: 99, padding: '7px 12px', fontSize: 12, fontWeight: 800, cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap', minHeight: 34 }}
        >
          <Icon d={Icons.phone} size={13} /> Entrar
        </button>
      )}
      <button title={c.kind === 'group' ? 'Sair do grupo' : 'Apagar conversa'} aria-label={c.kind === 'group' ? 'Sair do grupo' : 'Apagar conversa'} onClick={(e) => { e.stopPropagation(); void onDelete(c.id, c.title, selected) }} style={{ background: 'transparent', border: 'none', padding: 6, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8e929b' }}><Icon d={c.kind === 'group' ? Icons.minus : Icons.trash} size={16} /></button>
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

const FriendRow = memo(function FriendRow({ f, online, avatarB64, onOpen, onRemove, onBlock }: {
  f: { fp: string, nickname: string }
  online: boolean
  avatarB64?: string
  onOpen: (fp: string, nick?: string) => void
  onRemove: (fp: string, nickname: string) => void
  onBlock: (fp: string, nickname: string) => void
}) {
  return (
    <div className="friend-row" onClick={() => onOpen(f.fp, f.nickname)}>
      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
        <Avatar name={f.nickname || f.fp} fp={f.fp} size={32} avatarB64={avatarB64} />
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

function MobileFileCard({ m, mine, fmeta, pct, speed, status, error, announced, previewUrl, onDownload, onRetry }: {
  m: StoredMessage
  mine: boolean
  fmeta: FileMsgMeta
  pct: number
  speed: number
  status: string
  error?: string
  announced: boolean
  previewUrl?: string
  onDownload: (fileId: string) => void
  onRetry: (m: StoredMessage) => void
}) {
  return (
    <FileCard
      name={fmeta.name}
      size={fmeta.size}
      chunks={fmeta.chunks}
      mine={mine}
      mstatus={m.status}
      announced={announced}
      previewUrl={previewUrl}
      progress={{ pct, speed, status, error }}
      pal={{ text: t.text, heading: t.heading, muted: t.muted, accent: t.accent, input: t.input, border: t.border, main: t.main, green: t.green, red: t.red, yellow: t.yellow }}
      onDownload={() => onDownload(fmeta.file_id)}
      onRetry={() => onRetry(m)}
    />
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
    } catch {  }
  }, [input, selConv])
  const [communities, setCommunities] = useState<CommunityView[]>([])
  const [callActionBusy, setCallActionBusy] = useState(false)
  const [selCommunity, setSelCommunity] = useState<string | null>(null)
  const [showDrawer, setShowDrawer] = useState(false)
  const [showMembers, setShowMembers] = useState(false)
  const [friendsTab, setFriendsTab] = useState<'online' | 'todos' | 'pendentes' | 'bloqueados' | 'adicionar'>('online')
  const [friendRequests, setFriendRequests] = useState<{ fp: string, nickname: string }[]>([])
  const [friendRequestsAllowed, setFriendRequestsAllowed] = useState(true)
  const [friendsAccepted, setFriendsAccepted] = useState<{ fp: string, nickname: string }[]>([])
  const [friendsBlocked, setFriendsBlocked] = useState<{ fp: string, nickname: string }[]>([])
  const [pendingOut, setPendingOut] = useState<{ fp: string, nickname: string }[]>([])
  const [friendFpInput, setFriendFpInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showDownloads, setShowDownloads] = useState(false)
  const [dlCount, setDlCount] = useState(0)
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [friendSuccess, setFriendSuccess] = useState<string | null>(null)
  const [addingFriend, setAddingFriend] = useState(false)
  const [friendErr, setFriendErr] = useState<string | null>(null)
  const friendInputRef = useRef<HTMLInputElement | null>(null)
  const lastSendByConvRef = useRef<{ conv: string; at: number }>({ conv: '', at: 0 })
  const [searchQ, setSearchQ] = useState('')
  const [bots, setBots] = useState<BotView[]>([])
  const [replyToMsg, setReplyToMsg] = useState<{ id: string; name: string; body: string } | null>(null)
  const [forwardFrom, setForwardFrom] = useState<{ id: string; name: string; body: string } | null>(null)
  const [profilePeer, setProfilePeer] = useState<{ fp: string; name: string } | null>(null)
  const [threadFor, setThreadFor] = useState<{ parent: string; name: string; body: string } | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [showPins, setShowPins] = useState(false)
  const [showBookmarks, setShowBookmarks] = useState(false)
  const [showThread, setShowThread] = useState(false)
  const [threadMsgs, setThreadMsgs] = useState<StoredMessage[]>([])
  const [threadInput, setThreadInput] = useState('')
  const myPresence: PresenceStatus = prefs.myPresence
  const [composerEmoji, setComposerEmoji] = useState(false)
  const [typingPeers, setTypingPeers] = useState<Record<string, { nick: string; at: number }>>({})
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const [flash, setFlash] = useState<string | null>(null)
  const [pinnedMsgs, setPinnedMsgs] = useState<{ id: string; body: string; author: string }[]>([])
  const readRef = useRef<Set<string>>(new Set())
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const [topMenu, setTopMenu] = useState(false)
  const [showPrivacy, setShowPrivacy] = useState(false)
  const [showScreenPicker, setShowScreenPicker] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const privacy = usePrivacySettings(setError)
  const {
    mode: privacyMode,
    proxyEffective: privacyProxyEffective,
    proxyAddr,
    proxyIsDefault,
    testing: proxyTesting,
    testOk: proxyTestOk,
    testErr: proxyTestErr,
    pendingMode: proxyPendingMode,
    setMode: setPrivacyMode,
    setProxyAddr,
    resetTransient,
    refreshExtras: refreshPrivacyExtras,
    runTest: runProxyTest,
    saveAndActivate: saveProxyAndActivate,
    pickMode: pickPrivacyMode,
  } = privacy
  const lastTypingSent = useRef(0)
  const bootAtMobile = useRef(Date.now())
  const appStartedAt = useRef(resolveSessionStart(bootAtMobile.current, typeof sessionStorage !== 'undefined' ? sessionStorage : null))

  function notifyTyping(v: string) {
    try {
      if (!selConv || !v.trim()) return
      const now = Date.now()
      if (now - lastTypingSent.current < 2000) return
      lastTypingSent.current = now
      void services.sendTyping?.(selConv).catch(() => {})
    } catch {  }
  }

  function closePrivacy() {
    setShowPrivacy(false)
    resetTransient()
  }
  const [version, setVersion] = useState('')
  const [fileList, setFileList] = useState<any[]>([])
  const [dlByFile, setDlByFile] = useState<Record<string, { pct: number; speed: number; status: string; error?: string }>>({})
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const previewsRef = useRef<Record<string, string>>({})
  const previewUrlsRef = useRef<string[]>([])
  const mountPreview = useCallback((fileId: string, blob: Blob) => {
    if (previewsRef.current[fileId]) return
    const url = URL.createObjectURL(blob)
    previewUrlsRef.current.push(url)
    previewsRef.current[fileId] = url
    setPreviews({ ...previewsRef.current })
  }, [])
  const [activeCall, setActiveCall] = useState<any>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const peerNickCacheRef = useRef<Record<string, string>>({})
  const [callDuration, setCallDuration] = useState(0)
  const [callPanelSize, setCallPanelSize] = useState<'compact' | 'normal' | 'expanded'>('normal')
  const [pinnedTileId, setPinnedTileId] = useState<string | null>(null)
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [callQuality, setCallQuality] = useState<CallQuality>(() => getStoredQuality())
  const [qualityError, setQualityError] = useState<string | null>(null)
  const [showCallDiag, setShowCallDiag] = useState(false)
  const [showSoundboardMobile, setShowSoundboardMobile] = useState(false)
  const [callMediaPrefsState, setCallMediaPrefsState] = useState(() => getCallMediaPrefs())
  const [turnInput, setTurnInput] = useState(() => getTurnUrl())
  const [turnMsg, setTurnMsg] = useState<string | null>(null)
  const swarmNotifyRef = useRef<() => void>(() => {})
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [showInvite, setShowInvite] = useState(false)
  const [inviteInput, setInviteInput] = useState('')
  const [memberPairing, setMemberPairing] = useState<MemberPairing[]>([])
  const [channelListCache, setChannelListCache] = useState<ChannelMeta[]>([])
  const [showServerDetails, setShowServerDetails] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    services.version().then(setVersion).catch(() => {})
    services.privacyGet().then(s => setPrivacyMode(s.mode)).catch(() => {})
    const decidir = async () => {
      let id: Identity | null = null
      try {
        id = await services.identityGet()
      } catch {
        id = null
      }
      let vault: { has_identity: boolean; has_vault: boolean } | null = null
      try {
        vault = await services.vaultStatus()
      } catch {
        vault = null
      }
      let unlocked: Identity | null = null
      if (!id && vault?.has_vault) {
        try {
          unlocked = await services.vaultUnlock('')
        } catch {
          unlocked = null
        }
      }
      if (!id && !unlocked && vault && !vault.has_vault) {
        try {
          id = await services.identityGet()
        } catch {
          id = null
        }
      }
      const fase = resolveBootPhase({ identity: id, vault, unlocked })
      const pronto = unlocked ?? id
      if (pronto) setIdentity(pronto)
      setPhase(fase)
    }
    void decidir()
  }, [])

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

  useEffect(() => {
    setMemberPairing([])
    if (!selCommunity) { setChannelListCache([]); return }
    let alive = true
    const load = () => {
      services
        .communityMembers(selCommunity)
        .then((m) => {
          if (alive) setMemberPairing(m ?? [])
        })
        .catch(() => {  })
    }
    const loadChannels = () => {
      services
        .channelList(selCommunity)
        .then((list) => { if (alive) setChannelListCache(Array.isArray(list) ? list : []) })
        .catch(() => {  })
    }
    try { void services.communityPairNow?.(selCommunity)?.catch(() => {  }) } catch {  }
    try { void services.communitySyncNow?.(selCommunity)?.catch(() => {  }) } catch {  }
    load()
    loadChannels()
    const off = services.subscribe((ev) => {
      if (ev.type === 'community_joined' || ev.type === 'channel_created' || ev.type === 'channel_deleted') {
        loadChannels()
      }
    })
    const onVisible = () => {
      if (document.hidden) return
      load()
      loadChannels()
      try { void services.communitySyncNow?.(selCommunity)?.catch(() => {  }) } catch {  }
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    const t = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(t)
      off()
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [selCommunity, communities.length])

  useEffect(() => {
    setCallIdentity(identity ? { fingerprint: identity.fingerprint, nickname: identity.nickname } : null)
  }, [identity])
  useEffect(() => {
    callManager.bind((s: any) => {
      setActiveCall(s)
      if (s) { setIsMuted(!!s.muted); setIsDeafened(!!s.deafened) }
    })
    let stopBots: (() => void) | undefined
    try { stopBots = botRuntime.start() } catch {  }
    void downloadManager.load().catch(() => {  })
    let unCount = () => {}
    try {
      unCount = downloadManager.subscribe((items) => {
        try { setDlCount(items.filter(i => i.status === 'queued' || i.status === 'downloading' || i.status === 'verifying' || i.status === 'saving').length) } catch {  }
        try {
          const next: Record<string, { pct: number; speed: number; status: string; error?: string }> = {}
          for (const it of items) {
            next[it.file_id] = { pct: it.progress, speed: it.speedBps, status: it.status, error: it.error }
          }
          setDlByFile(next)
        } catch {  }
      })
    } catch {  }
    const unNotice = callManager.onCallNotice
    callManager.onCallNotice = (msg: string) => {
      try { setNotice(msg); window.setTimeout(() => setNotice(null), 6000) } catch {  }
    }
    const unIce = callManager.onIceFailed
    callManager.onIceFailed = (info) => {
      try {
        setNotice(info.state === 'failed' ? ICE_FAILED_MSG : ICE_RELAY_MSG)
        window.setTimeout(() => setNotice(null), 6000)
      } catch {  }
    }
    const unIncomingGone = callManager.onIncomingGone
    callManager.onIncomingGone = (callId: string) => {
      setIncomingCall((cur: any) => (cur && cur.call_id === callId ? null : cur))
      try { sfxRingStop() } catch {  }
    }
    callManager.onRoomsChanged = () => { void syncCallRooms(() => services.callRoomsList()) }
    return () => { callManager.unbind(); try { stopBots?.() } catch {  }; try { unCount() } catch {  }; callManager.onCallNotice = unNotice; callManager.onIceFailed = unIce; callManager.onIncomingGone = unIncomingGone; callManager.onRoomsChanged = null }
  }, [])
  useEffect(() => { setOpenConversation(selConv) }, [selConv])
  useEffect(() => {
    for (const c of conversations) {
      if (c.peer_fp) registerConversationPeer(c.id, c.peer_fp)
    }
  }, [conversations])
  useEffect(() => onOpenConversation((conv) => { setSelConv(conv); setSelPeerFp(null) }), [])

  useEffect(() => onCallNotificationAction((callId, action) => {
    const inc = incomingCall
    if (!inc || inc.call_id !== callId) return
    if (action === 'accept') {
      void (async () => {
        const bloqueio = callManager.canAccept(callId)
        if (bloqueio) { setError(bloqueio); return }
        try {
          await services.callAccept(callId, inc.from_fp)
          await callManager.acceptInbound(callId, (inc.kind as any) ?? 'voice', (selConv ?? callId), inc.from_fp, inc.nickname)
          sfxRingStop()
          markCallHandled(callId)
          setIncomingCall(null)
          sfxCallConnect()
        } catch (e: any) {
          setError(String(e?.message ?? e))
        }
      })()
      return
    }
    if (action === 'reject') {
      sfxRingStop()
      markCallHandled(callId)
      endCallNotice(callId)
      callManager.rejectIncoming(callId, inc.from_fp)
      setIncomingCall(null)
    }
  }), [incomingCall, selConv])
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
    activeCall?.participants,
    activeCall?.sharing,
    activeCall?.cameraOn,
    activeCall?.muted,
    (activeCall as any)?.localStream,
    (activeCall as any)?.localScreenStream,
    (activeCall as any)?.nativeMedia,
    identity?.fingerprint,
  ])

  const mediaLiveMobile = useMemo(() => (activeCall ? callMediaLive({
    participants: (activeCall.participants ?? []) as any[],
    localStream: (activeCall as any).localStream ?? null,
    localScreenStream: (activeCall as any).localScreenStream ?? null,
    sharing: !!activeCall.sharing,
  }) : false), [
    activeCall?.participants,
    activeCall?.sharing,
    (activeCall as any)?.localStream,
    (activeCall as any)?.localScreenStream,
  ])

  const visibleCallTilesMobile = useMemo(() => {
    const valid = callTilesMobile.map((tile) => tile.id)
    const pin = pinnedTileId && valid.includes(pinnedTileId) ? pinnedTileId : null
    return pin ? sortTilesForPin(callTilesMobile, pin) : callTilesMobile
  }, [callTilesMobile, pinnedTileId])

  const stageTileMobile = useMemo(
    () => (expandedTileId ? callTilesMobile.find((tile) => tile.id === expandedTileId) ?? null : null),
    [callTilesMobile, expandedTileId],
  )

  useEffect(() => {
    if (pinnedTileId && !callTilesMobile.some((tile) => tile.id === pinnedTileId)) setPinnedTileId(null)
    if (!activeCall && expandedTileId) setExpandedTileId(null)
  }, [callTilesMobile, pinnedTileId])
  useEffect(() => {
    if (expandedTileId && !callTilesMobile.some((tile) => tile.id === expandedTileId)) setExpandedTileId(null)
  }, [callTilesMobile, expandedTileId])

  const camerasMobile = useCallCameras(!!activeCall)
  const cameraSwitchLabelMobile = cameraCycleLabel(camerasMobile, callMediaPrefsState.videoInputId)
  const [cameraCount, setCameraCount] = useState(0)
  useEffect(() => {
    let vivo = true
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    const ler = async () => {
      if (!md?.enumerateDevices) return
      try {
        const lista = await md.enumerateDevices()
        const n = lista.filter((d) => d.kind === 'videoinput').length
        if (vivo) setCameraCount((cur) => (cur === n ? cur : n))
      } catch {
        /* sem enumerateDevices */
      }
    }
    void ler()
    let off: (() => void) | null = null
    try {
      md?.addEventListener?.('devicechange', ler)
      off = () => {
        try {
          md?.removeEventListener?.('devicechange', ler)
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* sem devicechange */
    }
    return () => {
      vivo = false
      off?.()
    }
  }, [activeCall, activeCall?.cameraOn])
  const mostrarTrocaCameraMobile = shouldShowCameraFlip({
    devices: camerasMobile,
    rawCount: cameraCount,
    mobile: isAndroidRuntime() || isIOSRuntime(),
  })
  const trocarCameraMobile = async () => {
    try {
      setError(null)
      await callManager.switchCamera()
      setCallMediaPrefsState(getCallMediaPrefs())
    } catch (e: any) {
      setError(String(e?.message ?? e))
    }
  }
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

  const refreshFriendsImpl = useCallback(async () => { try { const [a, b, c, d, ok] = await Promise.all([services.friendsList('pending_in').catch(() => [] as any), services.friendsList('accepted').catch(() => [] as any), services.friendsList('pending_out').catch(() => [] as any), services.friendsList('blocked').catch(() => [] as any), services.friendRequestsEnabled().catch(() => true)]); setFriendRequests(a ?? []); setFriendsAccepted(b ?? []); setPendingOut(c ?? []); setFriendsBlocked(d ?? []); setFriendRequestsAllowed(ok !== false) } catch {  } }, [])
  const refreshFriends = useMemo(() => coalesceAsyncRefresh(refreshFriendsImpl, 5000), [refreshFriendsImpl])
  async function refreshCommunities() { try { setCommunities(await services.communitiesList() ?? []) } catch {  } }
  useEffect(() => { if (phase !== 'app') return; refreshFriends(); refreshCommunities(); const id = window.setInterval(() => { if (!document.hidden) refreshFriends() }, 30000); return () => window.clearInterval(id) }, [phase, refreshFriends])
  useEffect(() => () => refreshFriends.cancel(), [refreshFriends])
  useEffect(() => {
    const notify = throttleTrailing(() => setFileList([...fileSwarm.files.values()]), 300)
    swarmNotifyRef.current = notify
    const prev = fileSwarm.onChange
    fileSwarm.onChange = notify
    setFileList([...fileSwarm.files.values()])
    return () => { notify.cancel(); swarmNotifyRef.current = () => {}; fileSwarm.onChange = prev }
  }, [])
  const previewFetchingRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    for (const sf of fileSwarm.files.values()) {
      const isImg = isImageName(sf.name)
      const isVid = isVideoName(sf.name)
      if (!isImg && !isVid) continue
      if (previewsRef.current[sf.file_id]) continue
      const blob = fileSwarm.blobFor(sf.file_id)
      if (blob) {
        mountPreview(sf.file_id, blob)
        continue
      }
      const tries = previewFetchingRef.current.get(sf.file_id) ?? 0
      if (tries >= 3) continue
      previewFetchingRef.current.set(sf.file_id, tries + 1)
      void fileSwarm.prepareMedia(sf)
        .then(() => {
          const b = fileSwarm.blobFor(sf.file_id)
          if (b) { mountPreview(sf.file_id, b); previewFetchingRef.current.delete(sf.file_id) }
        })
        .catch(() => {  })
    }
  }, [fileList])
  useEffect(() => () => {
    for (const u of previewUrlsRef.current) { try { URL.revokeObjectURL(u) } catch {  } }
    previewUrlsRef.current = []
  }, [])
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
    if (ev.type === 'reaction_changed') {
      const minha = messages.some(
        (m) => m.id === ev.msg_id && (m.direction === 'out' || m.author_fp === identity?.fingerprint),
      )
      if (minha) {
        const cid = communities.find(c => c.channels.some(([id]) => id === ev.conv_id))?.id
        const reactorNick = peers.find(p => p.fp === ev.reactor_fp)?.nickname
          || friendsAccepted.find(f => f.fp === ev.reactor_fp)?.nickname
        notifyReaction({
          msgId: ev.msg_id,
          conversationId: ev.conv_id,
          emoji: ev.emoji,
          reactorFp: ev.reactor_fp,
          myFp: identity?.fingerprint,
          reactorNome: reactorNick,
          minhaMensagem: true,
          add: ev.add,
          serverId: cid,
        })
      }
    }
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
    if (ev.type === 'friend_request_in' || ev.type === 'friend_accepted' || ev.type === 'friend_removed') { refreshFriends(); refreshConvos(); const nome = (ev as unknown as { nickname?: string }).nickname || String((ev as unknown as { fp?: string }).fp ?? '').slice(0, 8); notifyFriend({ kind: ev.type === 'friend_request_in' ? 'request' : ev.type === 'friend_accepted' ? 'accepted' : 'removed', nome }) }
    if (ev.type === 'community_joined') { refreshCommunities(); refreshConvos() }
    if (ev.type === 'community_removed') { refreshCommunities(); refreshConvos(); if (selCommunity === ev.community_id) { setSelCommunity(null); setSelConv(null); setSelPeerFp(null) } }
    if (ev.type === 'group_synced') { refreshConvos(); refreshCommunities() }
    if (ev.type === 'call_incoming') {
      const fp = ev.from_fp
      if (fp && identity?.fingerprint && fp === identity.fingerprint) return
      // Não-amigo não toca a campainha: recusa ANTES de notificar. O motor já
      // recusa o frame; isto cobre cliente antigo/alterado e o toque local.
      const emGrupoComum = groupMemberFps.some(([mfp]) => mfp === fp)
      if (!friendsAccepted.some((f) => f.fp === fp) && !emGrupoComum) {
        try { void services.callReject(ev.call_id, fp, 'não é amigo') } catch {  }
        return
      }
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
      if (ok && (isImageName(ev.name) || isVideoName(ev.name))) {
        const sf = fileSwarm.files.get(ev.file_id)
        if (sf) void fileSwarm.prepareMedia(sf).then(() => swarmNotifyRef.current()).catch(() => {})
      }
    }
    if (ev.type === 'file_chunk_request') fileSwarm.onChunkRequest(ev.file_id, ev.index, ev.from_fp)
    if (ev.type === 'file_chunk_data') { fileSwarm.onChunkData(ev.file_id, ev.index, ev.data_b64, ev.from_fp); swarmNotifyRef.current() }
  })
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages.length, selConv])

  const selConvObj = useMemo(() => conversations.find(c => c.id === selConv) ?? null, [conversations, selConv])
  const peerTitle = useMemo(() => selConvObj?.title || peers.find(p => p.fp === selPeerFp)?.nickname || selPeerFp || '', [selConvObj, peers, selPeerFp])
  const activeComm = useMemo(() => selCommunity ? communities.find(c => c.id === selCommunity) ?? null : null, [communities, selCommunity])
  const onlineFps = useMemo(() => new Set(peers.filter(p => p.state === 'CONNECTED').map(p => p.fp)), [peers])
  const { presence } = usePresence()
  const [convFilter, setConvFilter] = useState<ConversationFilter>('todos')
  const friendFpSet = useMemo(() => new Set(friendsAccepted.map((f) => f.fp)), [friendsAccepted])
  const filteredConvs = useMemo(() => {
    const q = searchQ.trim().toLowerCase()
    return conversations.filter((c) => {
      if (!conversationMatchesFilter({ kind: c.kind, peerFp: c.peer_fp, filter: convFilter, friendFps: friendFpSet })) return false
      if (!q) return true
      return c.title.toLowerCase().includes(q) || (c.peer_fp ?? '').toLowerCase().includes(q)
    })
  }, [conversations, convFilter, searchQ, friendFpSet])
  const filteredComms = useMemo(() => communities.filter(c => !searchQ || c.name.toLowerCase().includes(searchQ.toLowerCase())), [communities, searchQ])
  const onlineFriends = useMemo(() => friendsAccepted.filter(f =>
    isPresenceOnline({ connected: onlineFps.has(f.fp), chosen: presence.get(f.fp)?.status })
  ), [friendsAccepted, onlineFps, presence])
  const [groupMemberFps, setGroupMemberFps] = useState<[string, string][]>([])
  useEffect(() => {
    const grupos = conversations.filter((c) => c.kind === 'group')
    if (grupos.length === 0) { setGroupMemberFps([]); return }
    let vivo = true
    const ler = async () => {
      const pares: [string, string][] = []
      for (const g of grupos) {
        try {
          const mems = await services.groupMembers(g.id)
          for (const m of mems as unknown as [string, string][]) if (m?.[0]) pares.push(m)
        } catch {  }
      }
      if (vivo) setGroupMemberFps(pares)
    }
    void ler()
    const off = services.subscribe((ev) => { if (ev.type === 'group_synced') void ler() })
    return () => { vivo = false; off() }
  }, [conversations])

  useEffect(() => {
    if (!selConv) return
    const conv = conversations.find((c) => c.id === selConv)
    if (conv?.kind !== 'group') return
    try { void services.groupPairNow?.(selConv).catch(() => {  }) } catch {  }
  }, [selConv, conversations])

  const shownFriends = friendsTab === 'online' ? onlineFriends : friendsAccepted
  const linkedOnline = useMemo(() => {
    const s = new Set<string>()
    for (const p of peers) if (p.state === 'CONNECTED') s.add(p.fp)
    if (identity?.fingerprint) s.delete(identity.fingerprint)
    return s
  }, [peers, identity?.fingerprint])
  const unreadTotal = useMemo(() => conversations.reduce((a, c) => a + (((c as any).unread_count as number) || 0), 0), [conversations])
  const netState: NetworkState | null = status?.state ?? null
  const nativeKind = services.kind === 'native'
  const peerCount = status?.online_peers ?? 0
  const netOnline = peerCount > 0 && netState === 'CONNECTED'
  const pillColor = !nativeKind ? t.accent : netState === null ? t.yellow : netOnline ? t.green : netState === 'DISCONNECTED' ? '#80848e' : t.yellow
  const pillLabel = !nativeKind ? 'LOCAL' : netState === null ? 'INICIANDO…' : netOnline ? 'ONLINE' : stateLabel[netState as NetworkState]
  const linkedCount = linkedOnline.size || peerCount
  const onlineLabel = `${pillLabel} · ${linkedCount}`
  const privacyLabel = PRIVACY_MODES.find(pm => pm.mode === privacyMode)?.label ?? privacyMode

  const openDm = useCallback(async (fp: string, nick?: string) => {
    const alvo = fp.trim()
    if (!alvo) { setError('Selecione um amigo válido'); return }
    try {
      // Chave de identidade é o fingerprint; o nome só rotula. A conversa já
      // existente é reaproveitada (id determinístico), sem duplicar histórico.
      const conv = await services.dmOpen(alvo, (nick || alvo).trim() || alvo)
      setSelCommunity(null)
      setSelPeerFp(alvo)
      setSelConv(conv.id)
      setTab('chats')
      refreshConvos()
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }, [refreshConvos])
  const openConv = useCallback((c: Conversation) => { setSelCommunity(null); setSelConv(c.id); setSelPeerFp(c.peer_fp) }, [])
  const [callRoomsMap, setCallRoomsMap] = useState<Map<string, CallRoomView>>(() => callRooms.snapshot())
  useEffect(() => {
    const off = callRooms.subscribe(setCallRoomsMap)
    const sync = () => { void syncCallRooms(() => services.callRoomsList()) }
    sync()
    const t = window.setInterval(sync, ROOM_SYNC_MS)
    const onVisible = () => { if (!document.hidden) sync() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      off()
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])
  useEffect(() => {
    const un = services.subscribe((ev: any) => { if (ev?.type === 'call_room') callRooms.apply(ev) })
    return () => { try { un() } catch {  } }
  }, [])
  const joinRoom = useCallback(async (c: Conversation | null, room: CallRoomView) => {
    if (callActionBusy) return
    if (!c) { setError('conversa da chamada não encontrada — abra a conversa e tente de novo'); return }
    if (getCallsSupport() === 'none') { setError(getCallsUnavailableMessage()); return }
    if (callIsActive(activeCall)) { setError('já existe uma chamada em andamento'); return }
    if (!salaTemAlguemParaEntrar(room, identity?.fingerprint)) {
      setError('a chamada encerrou — ninguém mais está na sala')
      void syncCallRooms(() => services.callRoomsList())
      return
    }
    setCallActionBusy(true)
    try {
      setSelCommunity(null); setSelConv(c.id); setSelPeerFp(c.peer_fp)
      await callManager.enterRoom(c.id, room.kind)
    } catch (e: any) {
      setError(String(e?.message ?? e))
      void syncCallRooms(() => services.callRoomsList())
    }
    finally { setCallActionBusy(false) }
  }, [activeCall, callActionBusy, identity?.fingerprint])
  const enterCallChannel = useCallback(async (communityId: string, channelId: string) => {
    if (callActionBusy) return
    const support = getCallsSupport()
    if (support === 'none') { setError(getCallsUnavailableMessage()); return }
    // Já estou neste canal: o clique só abre a interface (não sai da call).
    if (activeCall && String((activeCall as any).callId ?? '').startsWith('voice-')) {
      const ref = parseVoiceCallId((activeCall as any).callId, (activeCall as any).convId)
      if (ref && ref.communityId === communityId && ref.channelId === channelId) {
        setSelCommunity(communityId)
        setSelConv(channelId)
        setSelPeerFp(null)
        setShowServerDetails(false)
        return
      }
    }
    setCallActionBusy(true)
    try {
      await callManager.joinVoice(communityId, channelId)
      setSelCommunity(communityId)
      setSelConv(channelId)
      setSelPeerFp(null)
      setShowServerDetails(false)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setCallActionBusy(false)
    }
  }, [activeCall, callActionBusy])
  const leaveCallChannel = useCallback(async () => {
    const st: any = activeCall
    const ref = parseVoiceCallId(st?.callId, st?.convId)
    if (!ref) {
      try { await callManager.leave() } catch (e: any) { setError(String(e?.message ?? e)) }
      return
    }
    try {
      await callManager.leaveVoice(ref.communityId, ref.channelId)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    }
  }, [activeCall])
  const [leaveTarget, setLeaveTarget] = useState<{ id: string; title: string; owner: boolean } | null>(null)
  const [showQuitConfirm, setShowQuitConfirm] = useState(false)
  const deleteConv = useCallback(async (id: string, title: string, isSelected: boolean) => {
    const conv = conversations.find((c) => c.id === id)
    if (conv?.kind === 'group') {
      const dono = await services.groupOwner(id).catch(() => null)
      setLeaveTarget({ id, title, owner: !!dono && dono === identity?.fingerprint })
      return
    }
    if (!confirm(`Apagar conversa com ${title}?`)) return
    try {
      await services.conversationDelete(id)
      if (isSelected) setSelConv(null)
      refreshConvos()
    } catch (err: any) { setError(String(err?.message ?? err)) }
  }, [conversations, identity?.fingerprint, refreshConvos])
  const removeFriend = useCallback(async (fp: string, nickname: string) => { if (!confirm(`Remover ${nickname || fp} dos amigos?`)) return; try { await services.friendRemove(fp); refreshFriends(); refreshConvos() } catch (err: any) { setError(String(err?.message ?? err)) } }, [refreshFriends, refreshConvos])
  const blockFriend = useCallback(async (fp: string, nickname: string) => { if (!confirm(`Bloquear ${nickname || fp}? As mensagens recebidas serão rejeitadas.`)) return; try { await services.friendBlock(fp); refreshFriends(); refreshConvos(); setNotice('Participante bloqueado') } catch (err: any) { setError(String(err?.message ?? err)) } }, [refreshFriends, refreshConvos])
  const downloadFile = useCallback((fileId: string) => {
    const cur = fileSwarm.files.get(fileId)
    if (!cur) { setError('anúncio do arquivo ainda não chegou — aguarde uns segundos'); return }
    setError(null)
    void startDownload({ file_id: fileId, name: cur.name, size: cur.size, chunks: cur.chunks, hash: cur.hash })
      .catch((e: any) => setError(String(e?.message ?? e)))
  }, [])
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
    const ehGrupo = selConvObj?.kind === 'group'
    let fps: string[] = []
    if (ehGrupo) {
      try {
        const mems = await services.groupMembers(selConv)
        fps = (mems as Array<{ fp?: string } | [string, string]>)
          .map((m) => (Array.isArray(m) ? m[0] : m?.fp) ?? '')
          .filter((fp) => !!fp && fp !== identity?.fingerprint)
      } catch {  }
      if (fps.length === 0) { setError('este grupo não tem membros para chamar'); return }
    } else {
      const fp = selPeerFp ?? selConvObj?.peer_fp
      if (!fp) { setError('selecione um amigo para ligar'); return }
      // 1:1 exige amizade ACEITA: pendente/contato/bloqueado não liga nem
      // recebe. A checagem de verdade também existe no motor.
      const rel = relationOf(selPeerState, identity?.fingerprint ?? '')
      const permissao = canCallPeer(rel === 'none' && friendFpSet.has(fp) ? 'friend' : rel)
      if (!permissao.ok) { setError(permissao.reason ?? 'só amigos podem ligar'); return }
      fps = [fp]
    }
    if (!callsOk) { setError(getCallsUnavailableMessage()); return }
    setCallActionBusy(true)
    try { await callManager.start(kind, selConv, fps, { group: ehGrupo }) } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setCallActionBusy(false) }
  }
  async function handleIncomingAccept() {
    if (!incomingCall || callActionBusy) return
    const support = getCallsSupport()
    if (support === 'none') { setError(getCallsUnavailableMessage()); return }
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
    if (raw.startsWith('/') && !/\s/.test(raw.split('\n')[0]!)) {
      const first = raw.split('\n')[0] ?? ''
      const sp = first.indexOf(' ')
      const name = (sp === -1 ? first.slice(1) : first.slice(1, sp)).toLowerCase()
      const rest = sp === -1 ? '' : raw.slice(sp + 1).trim()
      const out = await runSlashMobile(name, rest)
      setInput('')
      if (out && selConv) {
        const convId = selConv
        const communityId = selCommunity && communities.some(c =>
          c.id === selCommunity && c.channels.some(([cid]) => cid === convId),
        ) ? selCommunity : null
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
    const convId = selConv
    if (lastSendByConvRef.current.conv === convId && now - lastSendByConvRef.current.at < 300) return
    lastSendByConvRef.current = { conv: convId, at: now }
    const communityId = selCommunity && communities.some(c =>
      c.id === selCommunity && c.channels.some(([cid]) => cid === convId),
    ) ? selCommunity : null
    const myFp = identity?.fingerprint ?? ''
    const ts = Date.now()
    const tempId = `pending-${ts}`
    const optimistic: StoredMessage = { id: tempId, conv_id: convId, author_fp: myFp, body, ts, sig: 'pending', direction: 'out', status: 'sending' }
    append(optimistic)
    setInput('')
    setError(null)
    try {
      const m = communityId ? await services.sendChannelMessage(communityId, convId, body) : await services.messageSend(convId, body)
      replaceOptimistic(tempId, m)
      if (replyToMsg) {
        void services.reply(convId, m.id, replyToMsg.id).catch(() => {  })
        setReplyToMsg(null)
      }
      if (!communityId) refreshConvos()
    } catch (e: any) {
      failOptimistic(tempId)
      setError(String(e?.message ?? e))
    }
  }
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
      const fresh = await services.messageResend(m.id)
      replaceOptimistic(m.id, fresh)
      refreshConvos()
    } catch (e: any) {
      patchStatus(m.id, 'failed')
      setError(String(e?.message ?? e))
    }
  }, [patchStatus, replaceOptimistic, refreshConvos])
  async function addFriend() {
    const fp = friendFpInput.trim().toLowerCase()
    if (!fp) return
    setError(null); setFriendSuccess(null); setFriendErr(null)
    if (!FP_RE.test(fp)) {
      setFriendErr('Identificador inválido — use o fingerprint (12 hex, ex.: a1b2c3d4e5f6) ou a chave pública completa (64 hex).')
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
  async function pasteFp() {
    try {
      const txt = (await navigator.clipboard?.readText?.()) ?? ''
      const clean = txt.trim().toLowerCase()
      if (!clean) { setFriendErr('Área de transferência vazia — copie o fingerprint do seu amigo.'); return }
      const found = clean.match(/[0-9a-f]{12}/)?.[0] ?? clean
      setFriendFpInput(found)
      setFriendErr(null)
      friendInputRef.current?.focus()
    } catch {
      setFriendErr('Não foi possível ler a área de transferência — cole manualmente no campo.')
    }
  }
  async function retryFriendReq(fp: string) {
    setError(null); setFriendErr(null); setFriendSuccess(null)
    try { await services.friendRequest(fp); setFriendSuccess('Solicitação reenviada!'); refreshFriends() }
    catch (e: any) { setFriendErr(String(e?.message ?? e)) }
  }
  async function cancelFriendReq(fp: string) {
    setError(null); setFriendErr(null); setFriendSuccess(null)
    try { await services.friendRemove(fp); refreshFriends() }
    catch (e: any) { setFriendErr(String(e?.message ?? e)) }
  }
  useEffect(() => {
    if (friendsTab !== 'adicionar') return
    const id = window.setTimeout(() => friendInputRef.current?.focus(), 60)
    return () => window.clearTimeout(id)
  }, [friendsTab])
  async function respond(fp: string, ok: boolean) { try { await services.friendRespond(fp, ok); refreshFriends() } catch (e: any) { setError(String(e?.message ?? e)) } }
  async function copyMyFp() { await navigator.clipboard?.writeText(identity?.fingerprint ?? '').catch(() => {}); setError(null); setNotice('Fingerprint copiado!'); window.setTimeout(() => setNotice(null), 2500) }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]; if (!f) return
    await sendFileNow(f)
    e.target.value = ''
  }

  async function sendFileNow(f: File) {
    try {
      const sf = await fileSwarm.shareFile(f)
      setFileList([...fileSwarm.files.values()])
      if (selConv) {
        const body = encodeFileBody(sf)
        try { const m = selCommunity ? await services.sendChannelMessage(selCommunity, selConv, body) : await services.messageSend(selConv, body); append(m); refreshConvos() } catch {  }
      }
    } catch (err: any) { setError(String(err?.message ?? err)) }
  }

  async function handleComposerPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const dt = e.clipboardData
    const imagens = pastedImages(dt, new Date())
    if (imagens.length === 0) return
    e.preventDefault()
    if (!selConv) { setError('abra uma conversa antes de colar uma imagem'); return }
    for (const img of imagens) {
      const original = dt.files && dt.files[img.fileIndex] ? dt.files[img.fileIndex] : null
      if (!original) continue
      const file = original.name === img.name && original.type === img.type
        ? original
        : new File([original], img.name, { type: img.type })
      await sendFileNow(file)
    }
  }

  const isChannel = !!selCommunity
  const inCallChannelId = useMemo(() => {
    const st: any = activeCall
    if (!st || !String(st.callId ?? '').startsWith('voice-')) return null
    return typeof st.convId === 'string' && st.convId ? st.convId : null
  }, [activeCall])
  const [voiceStates, setVoiceStates] = useState<[string, boolean, boolean][]>([])
  useEffect(() => {
    if (!selCommunity || !selConv) { setVoiceStates((cur) => (cur.length === 0 ? cur : [])); return }
    let vivo = true
    const ler = () => {
      services.voiceStates(selCommunity, selConv)
        .then((v) => { if (vivo) setVoiceStates(Array.isArray(v) ? v : []) })
        .catch(() => {  })
    }
    ler()
    const t = window.setInterval(ler, 15_000)
    const onVisible = () => { if (!document.hidden) ler() }
    const un = services.subscribe((ev) => {
      if (
        ev.type === 'voice_joined' ||
        ev.type === 'voice_left' ||
        ev.type === 'voice_state_changed' ||
        ev.type === 'peer_offline'
      ) ler()
    })
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      vivo = false
      window.clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
      un()
    }
  }, [selCommunity, selConv])
  const selCallChannel = useMemo(() => {
    if (!isChannel || !selConv) return null
    const meta = channelListCache.find((c) => c.id === selConv)
    if (meta) return isCallableChannel(meta.kind) ? meta : null
    const st: any = activeCall
    if (st && String(st.callId ?? '').startsWith('voice-') && st.convId === selConv) {
      return {
        id: selConv,
        name: activeComm?.channels.find(([id]) => id === selConv)?.[1] ?? selConvObj?.title ?? 'canal',
        topic: '',
        category: '',
        position: 0,
        kind: 'voice',
      } as ChannelMeta
    }
    return null
  }, [isChannel, selConv, channelListCache, activeCall, activeComm, selConvObj])
  const isGroupConv = selConvObj?.kind === 'group'
  const selConvRoom = selConv ? callRoomsMap.get(selConv) ?? null : null

  // Relação e limite de introdução vêm do motor, não de uma cópia local.
  const selPeerState = selConvObj?.kind === 'dm' && selConvObj.peer_fp
    ? friendsAccepted.some(f => f.fp === selConvObj.peer_fp)
      ? { fp: selConvObj.peer_fp, status: 'accepted' }
      : friendRequests.some(f => f.fp === selConvObj.peer_fp)
        ? { fp: selConvObj.peer_fp, status: 'pending_in' }
        : pendingOut.some(f => f.fp === selConvObj.peer_fp)
          ? { fp: selConvObj.peer_fp, status: 'pending_out' }
          : friendsBlocked.some(f => f.fp === selConvObj.peer_fp)
            ? { fp: selConvObj.peer_fp, status: 'blocked' }
            : null
    : null
  const selRelation = relationOf(selPeerState, identity?.fingerprint ?? '')
  /** 1:1 só entre amigos aceitos; grupo/canal vale pela participação. */
  const chamadaBloqueada = (() => {
    if (!selConv) return { ok: false, reason: 'abra uma conversa' as string | null }
    if (isGroupConv) return { ok: true, reason: null as string | null }
    return canCallPeer(selRelation)
  })()
  const [introUsed, setIntroUsed] = useState(0)
  useEffect(() => {
    if (!selConv || selConvObj?.kind !== 'dm') { setIntroUsed(0); return }
    let vivo = true
    services.dmIntroState(selConv)
      .then((s) => { if (vivo) setIntroUsed(Number(s?.used) || 0) })
      .catch(() => { if (vivo) setIntroUsed(0) })
    return () => { vivo = false }
  }, [selConv, selConvObj?.kind, messages.length])
  const intro = selConvObj?.kind === 'dm'
    ? introState({ isFriend: selRelation === 'friend', used: introUsed })
    : null

  const [groupMemberCount, setGroupMemberCount] = useState(0)
  const [showGroupPanel, setShowGroupPanel] = useState(false)
  const [memberNicks, setMemberNicks] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!selConv || !isGroupConv) { setGroupMemberCount(0); setMemberNicks({}); return }
    let vivo = true
    const ler = async () => {
      try {
        const mems = await services.groupMembers(selConv)
        if (!vivo) return
        setGroupMemberCount(mems.length)
        const map: Record<string, string> = {}
        for (const m of mems as Array<{ fp?: string; nickname?: string }>) {
          if (m?.fp) map[m.fp] = m.nickname || ''
        }
        setMemberNicks(map)
      } catch { if (vivo) setGroupMemberCount(0) }
    }
    void ler()
    const off = services.subscribe((ev) => { if (ev.type === 'group_synced') void ler() })
    return () => { vivo = false; off() }
  }, [selConv, isGroupConv])

  const social = useSocialWindow(messages, selConv)
  const actions = useMessageActions((ids) => social.refreshIds(ids))

  const [activeAutocomplete, setActiveAutocomplete] = useState<{ kind: 'mention' | 'emoji' | 'slash'; query: string; start: number; end: number } | null>(null)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0)
  const [serverEmojiMap, setServerEmojiMap] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!selCommunity) { setServerEmojiMap({}); return }
    let alive = true
    services.emojiList(selCommunity)
      .then(list => {
        if (!alive) return
        const m: Record<string, string> = {}
        for (const e of (list as any[])) m[e.name] = e.char || e.emoji || e.glyph || e.ch || '❔'
        setServerEmojiMap(m)
      })
      .catch(() => {})
    return () => { alive = false }
  }, [selCommunity])

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
    setTimeout(() => { try { composerRef.current?.setSelectionRange(caret, caret); composerRef.current?.focus() } catch {  } }, 0)
  }

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
    const un = services.subscribe((ev: any) => {
      if (ev.type !== 'profile_changed') return
      setProfilesByFp(prev => ({ ...prev, [ev.fp]: ev.profile }))
    })
    return () => { alive = false; window.clearInterval(h); un() }
  }, [])
  const resolveMemberName = useCallback((fp: string): string => {
    if (!fp) return ''
    return resolveContactName({
      fp,
      myFp: identity?.fingerprint,
      myNickname: identity?.nickname,
      serverNickname: memberNicks[fp],
      profileName: profilesByFp[fp]?.display_name,
      knownNickname: peers.find((p) => p.fp === fp)?.nickname,
    })
  }, [memberNicks, profilesByFp, peers, identity])
  const myFp = identity?.fingerprint ?? ''
  const mobileCallAvatars = useMemo<Record<string, string | undefined>>(() => {
    const out: Record<string, string | undefined> = {}
    for (const [fp, p] of Object.entries(profilesByFp)) if (p?.avatar_b64) out[fp] = p.avatar_b64
    return out
  }, [profilesByFp])
  const readState = useReadState(selConv, myFp)
  const unreadMarkTs = readState.lastRead

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
    // A mensagem do bot é gravada como `out` do dono; o `bot_id` diz quem falou.
    const autor = autorDaMensagem(m, {
      myFp,
      bots,
      nomeDe: (fp) => {
        if (fp === identity?.fingerprint) return identity?.nickname ?? 'você'
        if (isChannel || selConvObj?.kind === 'group') return resolveMemberName(fp) || fp.slice(0, 8)
        const known = peers.find((p) => p.fp === fp)?.nickname || peerNickCacheRef.current[fp]
        return selConvObj?.title ?? known ?? fp.slice(0, 8)
      },
    })
    const authorName = autor.nome
    const authorFp = autor.fp
    const fmeta = parseFileBody(m.body)
    const body = social.bodies.get(m.id) ?? m.body
    const meta = social.meta.get(m.id)
    let pct = 0, announced = false, speed = 0, dlStatus = 'idle', dlError: string | undefined
    if (fmeta) {
      const sf = fileSwarm.files.get(fmeta.file_id)
      announced = !!sf
      pct = sf ? fileSwarm.progress(sf) : 0
      const q = dlByFile[fmeta.file_id]
      if (q) {
        pct = q.pct
        speed = q.speed
        dlStatus = q.status
        dlError = q.error
      } else if (sf && sf.chunks > 0 && sf.have.size === sf.chunks) {
        pct = 100
        dlStatus = 'completed'
      }
    }
    const prev = idx > 0 ? messages[idx - 1] : null
    const grouped = agruparComAnterior(m, prev, {
      anteriorApagada: !!social.meta.get(prev?.id ?? '')?.deleted,
    })
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
          <MobileFileCard
            m={msg} mine={mine}
            fmeta={fmeta} pct={pct} speed={speed} status={dlStatus} error={dlError} announced={announced}
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
        isBot={autor.bot}
        botName={autor.bot ? autor.nome : undefined}
        botAvatar={autor.bot ? autor.emoji : undefined}
        renderFile={renderFile}
        fontSize={15 * prefs.fontScale}
        peerOnline={selConvObj?.kind === 'dm' && !!selConvObj.peer_fp && onlineFps.has(selConvObj.peer_fp)}
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
  }), [messages, identity, selConvObj, fileList, previews, downloadFile, resendMessage, social.reactions, social.meta, social.bodies, richCtx, selConv, selCommunity, actions, bots, myFp, setFlash, profilesByFp, peers, peerNickCacheRef, onlineFps])

  useEffect(() => {
    if (selConv && messages.length) {
      const last = messages[messages.length - 1]
      if (last && !readRef.current.has(selConv)) {
        readRef.current.add(selConv)
        void services.readSet(selConv, last.ts).catch(() => {})
      }
    }
  }, [selConv, messages])

  const [searchHits, setSearchHits] = useState<SearchHit[]>([])
  const [searchBusy, setSearchBusy] = useState(false)
  const [sheetSearchQ, setSheetSearchQ] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)

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

  useEffect(() => {
    if (!showThread || !threadId) return
    let vivo = true
    const carregar = () => {
      services.threadMessages(threadId, 100)
        .then((list) => { if (vivo) setThreadMsgs(Array.isArray(list) ? list : []) })
        .catch(() => {  })
    }
    carregar()
    const off = services.subscribe((ev) => {
      if (ev.type !== 'message_new') return
      const m = ev as unknown as StoredMessage & { conv_id?: string }
      if (m.conv_id !== threadId) return
      setThreadMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
    })
    return () => { vivo = false; off() }
  }, [showThread, threadId])
  async function sendThread() {
    if (!threadId || !threadInput.trim() || !selCommunity) return
    const body = threadInput.trim()
    setThreadInput('')
    try {
      const m = await services.threadSend(selCommunity, threadId, body)
      setThreadMsgs((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
    } catch (e: any) {
      setThreadInput(body)
      setError(String(e?.message ?? e))
    }
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
        {}
        {showGroupPanel && isGroupConv && selConv && sheetWrap(
          selConvObj?.title || 'Grupo',
          <>
          <GroupPanel
            convId={selConv}
            title={selConvObj?.title || 'Grupo'}
            myFp={identity?.fingerprint ?? ''}
            friends={friendsAccepted}
            profiles={profilesByFp}
            onlineFps={onlineFps}
            onClose={() => setShowGroupPanel(false)}
            onRenamed={() => { refreshConvos() }}
            onChanged={() => {
              void services.groupMembers(selConv).then((m) => setGroupMemberCount(m.length)).catch(() => {})
              refreshConvos()
              services.conversationsList().then((l) => {
                if (!l.some((c) => c.id === selConv)) { setSelConv(null); setSelPeerFp(null) }
              }).catch(() => {  })
            }}
          />
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button
              type="button"
              onClick={async () => {
                const owner = (await services.groupOwner(selConv).catch(() => null)) === identity?.fingerprint
                setShowGroupPanel(false)
                setLeaveTarget({ id: selConv, title: selConvObj?.title || 'Grupo', owner })
              }}
              style={{ background: '#f23f42', color: '#fff', border: 'none', padding: '10px 14px', borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 13 }}
            >
              Sair ou apagar o grupo
            </button>
          </div>
          </>,
          () => setShowGroupPanel(false),
        )}
        {}
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
                  <Avatar name={h.author_fp} fp={h.author_fp} size={26} avatarB64={profilesByFp[h.author_fp]?.avatar_b64} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: t.muted }}>{h.author_fp.slice(0, 10)} · {new Date(h.ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</div>
                    <div style={{ fontSize: 13, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as any}>{h.body}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ), () => { setShowSearch(false); setSearchHits([]) })}

        {}
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

        {}
        {showBookmarks && sheetWrap('Mensagens salvas', (
          <BookmarksPanel convId={selConv ?? ''} messages={messages} onClose={() => setShowBookmarks(false)} onJump={(id) => {
            setShowBookmarks(false)
            const el = document.getElementById(`mmsg-${id}`)
            if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setFlash(id) }
          }} />
        ), () => setShowBookmarks(false))}

        {}
        {showThread && sheetWrap(threadFor?.name ? `Discussão — ${threadFor.name}` : 'Discussão', (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 }}>
            {threadFor?.body && (
              <div style={{ fontSize: 12, color: t.muted, background: t.input, borderRadius: 8, padding: 8, borderLeft: `3px solid ${t.accent}` }}>{threadFor.body}</div>
            )}
            <div style={{ overflowY: 'auto', minHeight: 80, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {threadMsgs.length === 0 && <div style={{ fontSize: 12, color: t.muted }}>nenhuma mensagem na discussão ainda</div>}
              {threadMsgs.map((tm) => (
                <div key={tm.id} style={{ display: 'flex', gap: 8 }}>
                  <Avatar name={tm.author_fp} fp={tm.author_fp} size={24} avatarB64={profilesByFp[tm.author_fp]?.avatar_b64} />
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

        {}
        {profilePeer && (
          <ProfileModal
            fp={profilePeer.fp}
            nickname={profilePeer.name}
            myFp={myFp}
            communityId={selCommunity ?? undefined}
            communityName={activeComm?.name}
            onClose={() => setProfilePeer(null)}
            onMessage={fp => { setProfilePeer(null); setSelPeerFp(fp); void openDm(fp) }}
            onSaved={p => setProfilesByFp(prev => ({ ...prev, [p.fp]: p }))}
          />
        )}

        {}
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
                <Avatar name={c.title} fp={c.id} size={28} avatarB64={profilesByFp[c.id]?.avatar_b64} />
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

  const updateGate = useUpdateGate(true)

  if (phase === 'loading') return (<><UpdateBootScreen api={updateGate} fallback={<BootScreen />} /><UpdateOverlay api={updateGate} /></>)
  if (phase === 'create') return <CreateAccount palette={authPalette} mobile onDone={id => { setIdentity(id); setPhase('app') }} />
  if (phase === 'lock') return <LockScreen palette={authPalette} mobile nickname={identity?.nickname ?? ''} onUnlock={id => { setIdentity(id); setPhase('app') }} />

  const renderCallTilesMobile = (_compact: boolean, strip = false) => {
    if (callTilesMobile.length === 0) return null
    return (
      <MobileCallStage
        tiles={visibleCallTilesMobile}
        pinnedId={pinnedTileId}
        expandedId={expandedTileId}
        onPin={(id) => setPinnedTileId((cur) => (cur === id ? null : id))}
        onExpand={(id) => setExpandedTileId((cur) => (cur === id ? null : id))}
        deafened={!!activeCall?.deafened}
        palette={{ heading: t.heading, muted: t.muted, green: t.green, red: t.red, accent: t.accent, border: t.border }}
        avatarColor={avatarColor}
        avatarB64={mobileCallAvatars}
        onOpenProfile={(fp) => setProfilePeer({ fp, name: resolveMemberName(fp) || fp.slice(0, 8) })}
        strip={strip}
      />
    )
  }

  if (selConv) {
    if (selCallChannel) {
      const st: any = activeCall
      const dentro = !!inCallChannelId && inCallChannelId === selCallChannel.id
      const faseMotor = faseExibida({ callId: st?.callId, phase: st?.phase, participants: st?.participants, myFp: identity?.fingerprint })
      const ligando = dentro && (faseMotor === 'connecting' || faseMotor === 'outgoing' || faseMotor === 'reconnecting')
      const porFp = new Map<string, { fp: string; nickname?: string; muted?: boolean; deafened?: boolean }>()
      const estadoMotor = new Map<string, { muted: boolean; deafened: boolean }>()
      for (const [fp, muted, deafened] of voiceStates) {
        if (!fp) continue
        estadoMotor.set(fp, { muted: !!muted, deafened: !!deafened })
      }
      for (const p of ((st?.participants ?? []) as any[])) {
        const fp = String(p?.fp ?? '')
        if (!fp) continue
        const motor = estadoMotor.get(fp)
        porFp.set(fp, {
          fp,
          nickname: resolveMemberName(fp) || (typeof p?.nickname === 'string' ? p.nickname : undefined),
          muted: p?.muted ?? motor?.muted,
          deafened: p?.deafened ?? motor?.deafened,
        })
      }
      const meuFp = identity?.fingerprint ?? ''
      if (dentro && meuFp && !porFp.has(meuFp)) {
        const motor = estadoMotor.get(meuFp)
        porFp.set(meuFp, { fp: meuFp, nickname: identity?.nickname ?? 'você', muted: motor?.muted, deafened: motor?.deafened })
      }
      const participantes = [...porFp.values()]
      return (
        <>
        <MobileCallChannel
          channelName={selCallChannel.name}
          kind={selCallChannel.kind === 'video' ? 'video' : 'voice'}
          communityName={activeComm?.name}
          inCall={dentro}
          connecting={!!ligando}
          seconds={dentro ? callDuration : 0}
          participants={participantes}
          media={dentro ? renderCallTilesMobile(false) : null}
          myFp={identity?.fingerprint ?? ''}
          muted={isMuted}
          deafened={isDeafened}
          cameraOn={!!st?.cameraOn}
          error={error}
          canSwitchCamera={mostrarTrocaCameraMobile}
          onSwitchCamera={() => { void trocarCameraMobile() }}
          canShareScreen={supportsScreenShare() || !!st?.sharing}
          sharing={!!st?.sharing}
          onToggleScreen={() => {
            if (st?.sharing) {
              void callManager.stopScreenShare().catch((e: any) => setError(String(e?.message ?? e)))
              return
            }
            if (!supportsScreenShare()) {
              setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG)
              return
            }
            setShowScreenPicker(true)
          }}
          joining={callActionBusy}
          onBack={() => { setSelConv(null); setSelPeerFp(null) }}
          onJoin={() => { if (!selCommunity || !selCallChannel) return; void enterCallChannel(selCommunity, selCallChannel.id) }}
          onLeave={() => { void leaveCallChannel() }}
          onToggleMute={() => { const nm = !isMuted; setIsMuted(nm); callManager.toggleMute() }}
          onToggleDeafen={() => { const nd = !isDeafened; setIsDeafened(nd); if (nd) setIsMuted(true); callManager.toggleDeafen() }}
          onToggleCamera={() => { void callManager.toggleCamera().catch((e: any) => setError(String(e?.message ?? e))) }}
          onSoundboard={() => setShowSoundboardMobile((v) => !v)}
          soundboardOpen={showSoundboardMobile}
        />
        {/* O botão de efeitos vive na barra do microfone: o painel precisa ser
            montado no mesmo `return`, senão o clique some (igual ao picker). */}
        {dentro && showSoundboardMobile && (
          <SoundboardPanel
            open
            onClose={() => setShowSoundboardMobile(false)}
            palette={{ input: t.input, border: t.border, text: t.text, muted: t.muted, accent: t.accent, panel: t.sidebar }}
          />
        )}
        {/* A vista do canal faz `return` antes do rodapé do shell: sem este
            picker aqui, "compartilhar tela" no canal só mudava estado. */}
        <ScreenSharePicker open={showScreenPicker} onClose={() => setShowScreenPicker(false)} onError={setError} />
        </>
      )
    }
    const channelName = activeComm?.channels.find(([id]) => id === selConv)?.[1] ?? selConvObj?.title ?? peerTitle
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: t.main, color: t.text, fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", overflow: 'hidden' }}>
        {}
        <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 10, paddingLeft: 8, paddingRight: 8, paddingBottom: 0, paddingTop: 'env(safe-area-inset-top)', background: t.sidebar, borderBottom: `1px solid ${t.border}`, flexShrink: 0, boxShadow: '0 1px 0 rgba(0,0,0,.2)' }}>
          <button aria-label="Voltar" className="m-iconbtn" onClick={() => { setSelConv(null); setSelPeerFp(null); setShowMembers(false) }}>
            <span style={{ display: 'flex', transform: 'rotate(90deg)' }}><Icon d={Icons.chevron} size={18} /></span>
          </button>
          {isChannel
            ? <span style={{ color: t.muted, display: 'flex', flexShrink: 0 }}><Icon d={Icons.hash} size={20} /></span>
            : <Avatar name={peerTitle} fp={selPeerFp ?? selConv} size={26} avatarB64={profilesByFp[selPeerFp ?? selConv ?? ""]?.avatar_b64} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: t.heading, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{isChannel ? channelName : peerTitle}</div>
            <div style={{ fontSize: 11, color: t.muted }}>
              {isChannel
                ? `${activeComm?.members?.length ?? 0} membros`
                : isGroupConv
                  ? `${groupMemberCount} ${groupMemberCount === 1 ? 'membro' : 'membros'}`
                  : isPresenceOnline({ connected: onlineFps.has(selPeerFp ?? ''), chosen: presence.get(selPeerFp ?? '')?.status }) ? 'online' : 'offline'}
            </div>
          </div>
          {!isChannel && (
            <>
              {
}
              {selConvRoom && !callIsActive(activeCall) && salaTemAlguemParaEntrar(selConvRoom, identity?.fingerprint) && (
                <button
                  type="button"
                  data-testid="mobile-header-join-room"
                  aria-label={`Entrar na chamada — ${selConvRoom.participants.length || 1} na sala`}
                  title={`Entrar na chamada em andamento (${selConvRoom.participants.length || 1} na sala)`}
                  aria-busy={callActionBusy || undefined}
                  disabled={callActionBusy}
                  onClick={() => { if (selConv && !callActionBusy) void joinRoom(selConvObj, selConvRoom) }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, background: t.accent, color: '#fff', border: 'none', borderRadius: 99, padding: '7px 12px', fontSize: 12, fontWeight: 800, cursor: callActionBusy ? 'wait' : 'pointer', whiteSpace: 'nowrap', opacity: callActionBusy ? 0.7 : 1 }}
                >
                  <Icon d={Icons.phone} size={13} /> {callActionBusy ? 'entrando…' : 'Entrar'}
                </button>
              )}
              {}
              <span title={!chamadaBloqueada.ok ? (chamadaBloqueada.reason ?? 'só amigos podem ligar') : callsOk ? 'Iniciar chamada de voz' : `Iniciar chamada de voz — ${callsUnavailableDetail}`} style={{ display: 'flex', flexShrink: 0 }}>
                <button aria-label="Chamada de voz" disabled={!callsOk || !chamadaBloqueada.ok} title={!chamadaBloqueada.ok ? (chamadaBloqueada.reason ?? 'só amigos podem ligar') : callsOk ? 'Iniciar chamada de voz' : `Iniciar chamada de voz — ${callsUnavailableDetail}`} className="m-iconbtn" style={callsOk ? (chamadaBloqueada.ok ? undefined : { opacity: 0.4, color: t.red, cursor: 'not-allowed' }) : { opacity: 0.75, color: t.red }} onClick={() => { if (chamadaBloqueada.ok) startCall('voice'); else setError(chamadaBloqueada.reason ?? 'só amigos podem ligar') }}><Icon d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" size={17} /></button>
              </span>
              <span title={!chamadaBloqueada.ok ? (chamadaBloqueada.reason ?? 'só amigos podem ligar') : callsOk ? 'Iniciar chamada de vídeo' : `Iniciar chamada de vídeo — ${callsUnavailableDetail}`} style={{ display: 'flex', flexShrink: 0 }}>
                <button aria-label="Chamada de vídeo" disabled={!callsOk || !chamadaBloqueada.ok} title={!chamadaBloqueada.ok ? (chamadaBloqueada.reason ?? 'só amigos podem ligar') : callsOk ? 'Iniciar chamada de vídeo' : `Iniciar chamada de vídeo — ${callsUnavailableDetail}`} className="m-iconbtn" style={callsOk ? (chamadaBloqueada.ok ? undefined : { opacity: 0.4, color: t.red, cursor: 'not-allowed' }) : { opacity: 0.75, color: t.red }} onClick={() => { if (chamadaBloqueada.ok) startCall('video'); else setError(chamadaBloqueada.reason ?? 'só amigos podem ligar') }}><Icon d="M23 7l-7 5 7 5V7z M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" size={17} /></button>
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

        {}
        {showMembers && isChannel && (() => {
          const janela = windowMembers(
            activeComm?.members ?? [],
            LIMITE_MEMBROS,
            ([fp]) => fp === identity?.fingerprint || onlineFps.has(fp),
          )
          return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 30, background: 'rgba(0,0,0,.5)' }} onClick={() => setShowMembers(false)}>
            <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 260, maxWidth: '80vw', background: t.sidebar, borderLeft: `1px solid ${t.border}`, padding: '14px 8px', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>
              <div className="member-group-head">MEMBROS — {activeComm?.members?.length ?? 0}</div>
              {janela.visiveis.map(([fp, nick]) => (
                <div
                  key={fp}
                  className="member-row"
                  role="button"
                  tabIndex={0}
                  title={`Ver perfil de ${nick || fp}`}
                  onClick={() => { setShowMembers(false); setProfilePeer({ fp, name: nick || fp.slice(0, 8) }) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { setShowMembers(false); setProfilePeer({ fp, name: nick || fp.slice(0, 8) }) } }}
                >
                  <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                    <Avatar name={nick || fp} fp={fp} size={28} avatarB64={profilesByFp[fp]?.avatar_b64} />
                    <PeerDot on={onlineFps.has(fp) || (!!identity?.fingerprint && fp === identity.fingerprint)} ring={t.sidebar} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nick || fp.slice(0, 8)}</div>
                    <div style={{ fontSize: 10, color: t.muted, fontFamily: MONO }}>{fp.slice(0, 10)}</div>
                  </div>
                </div>
              ))}
              {janela.restantes > 0 && (
                <div style={{ fontSize: 10.5, color: t.muted, padding: '6px 4px', lineHeight: 1.5 }}>
                  +{janela.restantes.toLocaleString('pt-BR')} membros não listados
                </div>
              )}
            </div>
          </div>
          )
        })()}

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
          onDoneToast={(msg) => { try { setNotice(msg); window.setTimeout(() => setNotice(null), 6000) } catch {  } }}
        />

        {activeCall && (
          <div data-testid="mobile-call-panel" style={{ margin: '8px 12px 0', background: t.panel, border: `1px solid ${t.green}55`, borderRadius: 12, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0, maxHeight: callPanelSize === 'compact' ? 168 : callPanelSize === 'normal' ? '38vh' : '60vh', overflowY: 'auto', transition: 'max-height 180ms ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {
}
              <span style={{ fontSize: 13, fontWeight: 800, color: t.heading, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{activeCall.kind === 'video' ? <Icon d={Icons.video} size={15} /> : <Icon d={Icons.phone} size={15} />} Em chamada • {fmtCallDuration(callDuration)} • {(activeCall.participants ?? []).length} na sala</span>
              </span>
              {}
              {callPanelSize !== 'compact' && (activeCall.participants ?? []).length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {(activeCall.participants ?? []).map((p: any) => {
                    const eu = p.fp === identity?.fingerprint
                    const nome = eu
                      ? (identity?.nickname ?? 'você')
                      : (resolveMemberName(p.fp) || p.nickname || p.fp.slice(0, 8))
                    const mudo = !!(p.muted || p.deafened)
                    return (
                      <span
                        key={p.fp}
                        title={p.deafened ? `${nome} — surdo` : p.muted ? `${nome} — mic mudo` : nome}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          fontSize: 10.5, fontWeight: 700,
                          background: t.input, border: `1px solid ${mudo ? `${t.red}66` : t.border}`,
                          color: mudo ? t.muted : t.text,
                          borderRadius: 99, padding: '3px 8px', maxWidth: 150,
                        }}
                      >
                        <span style={{ display: 'flex', flexShrink: 0, color: mudo ? t.red : t.green }}>
                          <Icon d={p.deafened ? Icons.volumeX : p.muted ? Icons.micOff : Icons.mic} size={9} />
                        </span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</span>
                      </span>
                    )
                  })}
                </div>
              )}
              {}
              {(privacyMode === 'proxy' || privacyMode === 'full') && (
                <span
                  title="A mídia (áudio/vídeo/tela) usa sockets UDP diretos do WebRTC, fora do proxy/Tor do app. Os participantes veem seu IP real. Mensagens e arquivos seguem protegidos."
                  style={{ fontSize: 9, fontWeight: 800, background: `${t.yellow}22`, color: t.yellow, padding: '2px 7px', borderRadius: 99, whiteSpace: 'nowrap', cursor: 'help', flexShrink: 0 }}
                >não anônima</span>
              )}
              {}
              <CallPhaseBadge phase={faseExibida({ callId: activeCall.callId, phase: activeCall.phase, participants: activeCall.participants, myFp: identity?.fingerprint }) as any} startAt={activeCall.startAt} nowMs={nowMs} mediaLive={mediaLiveMobile} ringing={activeCall.ringing} />
              {mostrarTrocaCameraMobile && (
                <button type="button" data-testid="call-camera-switch" aria-label={cameraSwitchLabelMobile ? `Trocar de câmera (${cameraSwitchLabelMobile})` : 'Trocar de câmera'} title={cameraSwitchLabelMobile ? `Trocar de câmera (${cameraSwitchLabelMobile})` : 'Trocar de câmera'} onClick={() => { void trocarCameraMobile() }} style={{ width: 38, height: 38, borderRadius: 8, border: `1px solid ${t.border}`, background: t.input, color: t.text, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon d={Icons.cameraSwitch} size={17} /></button>
              )}
              <button type="button" data-testid="call-panel-smaller" aria-label="Diminuir painel da chamada" title={callPanelSize === 'compact' ? 'Painel já está compacto' : 'Diminuir painel'} disabled={callPanelSize === 'compact'} onClick={() => setCallPanelSize(callPanelSize === 'expanded' ? 'normal' : 'compact')} style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${t.border}`, background: t.input, color: callPanelSize === 'compact' ? t.muted : t.text, opacity: callPanelSize === 'compact' ? 0.5 : 1 }}>↑</button>
              <button type="button" data-testid="call-panel-larger" aria-label="Aumentar painel da chamada" title={callPanelSize === 'expanded' ? 'Painel já está expandido' : 'Aumentar painel'} disabled={callPanelSize === 'expanded'} onClick={() => setCallPanelSize(callPanelSize === 'compact' ? 'normal' : 'expanded')} style={{ width: 34, height: 34, borderRadius: 8, border: `1px solid ${t.border}`, background: t.input, color: callPanelSize === 'expanded' ? t.muted : t.text, opacity: callPanelSize === 'expanded' ? 0.5 : 1 }}>↓</button>
              <button aria-label={isMuted ? 'Ativar microfone' : 'Silenciar'} title={isMuted ? 'Ativar microfone' : 'Silenciar'} className="m-iconbtn" style={isMuted ? { background: t.red, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' } : { display: 'flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => { const nm = !isMuted; setIsMuted(nm); callManager.toggleMute() }}>{isMuted ? <Icon d={Icons.micOff} size={16} /> : <Icon d={Icons.mic} size={16} />}</button>
              <button aria-label={(activeCall as any)?.cameraOn ? 'Desligar câmera' : 'Ligar câmera'} title={(activeCall as any)?.sharing && !(activeCall as any)?.cameraOn ? 'Pare a tela para ligar a câmera (as duas usam o mesmo vídeo)' : ((activeCall as any)?.cameraOn ? 'Desligar câmera' : 'Ligar câmera')} disabled={!!(activeCall as any)?.sharing && !(activeCall as any)?.cameraOn} className="m-iconbtn" style={(activeCall as any)?.cameraOn ? { background: t.green, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' } : { display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: (activeCall as any)?.sharing ? 0.45 : 1 }} onClick={() => callManager.toggleCamera().catch((e: any) => setError(String(e?.message ?? e)))}><Icon d={Icons.video} size={16} /></button>
              <button className="m-btn red" style={{ padding: '9px 14px' }} onClick={() => { callManager.leave().catch((e: any) => setError(String(e?.message ?? e))) }}>Sair</button>
            </div>
            {callPanelSize !== 'compact' && <div style={{ fontSize: 11, color: t.muted }} role="status">rota: {callManager.getRungSummary()}</div>}
            {callPanelSize !== 'compact' && <button onClick={() => setShowCallDiag((v) => !v)} aria-label="Diagnóstico da chamada" style={{ background: showCallDiag ? t.accent : t.input, border: `1px solid ${t.border}`, color: showCallDiag ? '#fff' : t.text, borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer' }}>{showCallDiag ? 'Ocultar diagnóstico' : 'Diagnóstico'}</button>}
            {showCallDiag && <CallDiagnostics compact />}
            {
}
            {(activeCall as any)?.relayActive && (
              <div title="Áudio via relay pela sinalização — latência alta, WebRTC indisponível" style={{ fontSize: 11, fontWeight: 800, background: '#f0b232', color: '#000', padding: '4px 8px', borderRadius: 8, textAlign: 'center' }}>via relay (latência alta)</div>
            )}
            {/* Qualidade/tela/efeitos ficam FORA do if de tamanho: no compacto
                eles desapareciam e o botão de tela "não existia". */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {callPanelSize !== 'compact' && <label htmlFor="m-call-quality" style={{ fontSize: 11, color: t.muted, fontWeight: 700 }}>Qualidade</label>}
              {callPanelSize !== 'compact' && <select id="m-call-quality" aria-label="Qualidade da chamada" value={(activeCall.quality as CallQuality | undefined) ?? callQuality} onChange={e => changeQuality(e.target.value as CallQuality)} style={{ background: t.input, color: t.text, border: `1px solid ${t.border}`, borderRadius: 8, padding: '6px 8px', fontSize: 12 }}>
                <option value="480p">480p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="4K">4K</option>
              </select>}
              {(((activeCall as any)?.qualityNotice as string | undefined) || qualityError) && (
                <span role="status" style={{ fontSize: 11, color: qualityError ? '#ff9c9c' : t.yellow }}>{qualityError ?? ((activeCall as any)?.qualityNotice as string) ?? ((activeCall as any)?.relayActive ? `modo compatibilidade ativo (${(activeCall as any)?.relayReason ?? 'relay'}) — áudio via relay (latência alta)` : null)}</span>
              )}
              {}
              <button onClick={() => { if ((activeCall as any)?.sharing) { callManager.stopScreenShare().catch((e: any) => setError(String(e?.message ?? e))); return } if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return } setShowScreenPicker(true) }} data-testid="mobile-screen-share" title={supportsScreenShare() ? 'Compartilhar tela (escolher fonte, áudio e qualidade)' : (screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG)} aria-label="Compartilhar tela" style={{ background: (activeCall as any)?.sharing ? t.green : t.input, border: `1px solid ${t.border}`, color: (activeCall as any)?.sharing ? '#fff' : t.text, opacity: supportsScreenShare() || (activeCall as any)?.sharing ? 1 : 0.5, borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon d={Icons.screen} size={12} /> {(activeCall as any)?.sharing ? 'compartilhando' : 'tela'}</button>
              <div style={{ position: 'relative', display: 'inline-flex' }}>
                <button onClick={() => setShowSoundboardMobile(v => !v)} data-testid="mobile-soundboard" aria-expanded={showSoundboardMobile} title="Efeitos sonoros da chamada (até 10s)" aria-label="Efeitos sonoros" style={{ background: showSoundboardMobile ? t.accent : t.input, border: `1px solid ${t.border}`, color: showSoundboardMobile ? '#fff' : t.text, borderRadius: 8, padding: '6px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Icon d={Icons.music} size={12} /> efeitos</button>
                {showSoundboardMobile && (
                  <SoundboardPanel
                    open
                    onClose={() => setShowSoundboardMobile(false)}
                    palette={{ input: t.input, border: t.border, text: t.text, muted: t.muted, accent: t.accent, panel: t.sidebar }}
                  />
                )}
              </div>
            </div>
            {}
            {renderCallTilesMobile(callPanelSize === 'compact', true)}
          </div>
        )}

        {}
        {stageTileMobile && (
          <ScreenStage
            tile={stageTileMobile}
            palette={{ heading: t.heading, muted: t.muted, green: t.green, red: t.red, accent: t.accent, border: t.border }}
            onCollapse={() => setExpandedTileId(null)}
            muted={!!activeCall?.muted}
            onToggleMute={() => { const nm = !isMuted; setIsMuted(nm); callManager.toggleMute() }}
            cameraOn={!!activeCall?.cameraOn}
            sharing={!!activeCall?.sharing}
            onToggleCamera={() => { void callManager.toggleCamera() }}
            onLeave={() => { void callManager.leave() }}
            callTitle={peerTitle ?? channelName ?? undefined}
          />
        )}

        {}
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

        {}
        {unreadMarkTs > 0 && messages.some((x) => x.ts > unreadMarkTs) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 14px', background: t.main, flexShrink: 0 }}>
            <span style={{ flex: 1, height: 1, background: t.red }} />
            <span style={{ fontSize: 10, fontWeight: 800, color: t.red, textTransform: 'uppercase' }}>novas mensagens</span>
            <span style={{ flex: 1, height: 1, background: t.red }} />
          </div>
        )}

        {}
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

        {}
        {replyToMsg && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: t.sidebar, borderTop: `1px solid ${t.border}`, padding: '6px 12px', flexShrink: 0 }}>
            <span style={{ flex: 1, minWidth: 0, borderLeft: `3px solid ${t.accent}`, paddingLeft: 8 }}>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 800, color: t.text }}>↩ {replyToMsg.name}</span>
              <span style={{ display: 'block', fontSize: 11, color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{replyToMsg.body || 'anexo'}</span>
            </span>
            <button onClick={() => setReplyToMsg(null)} aria-label="Cancelar resposta" style={{ background: 'transparent', border: 'none', color: t.muted, cursor: 'pointer', display: 'flex', padding: 4 }}><Icon d={Icons.x} size={16} /></button>
          </div>
        )}

        {}
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
          {intro?.hint && (
            <div
              role="status"
              style={{
                display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
                fontSize: 11, fontWeight: 700,
                color: intro.blocked ? t.red : t.muted,
                background: intro.blocked ? `${t.red}18` : t.main,
                border: `1px solid ${intro.blocked ? `${t.red}55` : t.border}`,
                borderRadius: 6, padding: '5px 8px',
              }}
            >
              <Icon d={Icons.lock} size={12} />
              <span style={{ flex: 1 }}>{intro.hint}</span>
              {selPeerFp && intro.blocked && selRelation === 'request_out' && (
                <span style={{ fontSize: 10, fontWeight: 700, color: t.muted }}>aguardando aceitação</span>
              )}
              {selPeerFp && intro.blocked && selRelation === 'request_in' && (
                <button
                  onClick={async () => { try { await services.friendRespond(selPeerFp, true); refreshFriends() } catch (e: any) { setError(String(e?.message ?? e)) } }}
                  style={{ background: t.green, color: '#fff', border: 'none', borderRadius: 5, padding: '3px 8px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}
                >
                  Aceitar amizade
                </button>
              )}
              {selPeerFp && intro.blocked && selRelation !== 'request_out' && selRelation !== 'request_in' && (
                <button
                  onClick={() => { setFriendsTab('adicionar'); setFriendFpInput(selPeerFp); setTab('friends') }}
                  style={{ background: t.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '3px 8px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}
                >
                  Pedir amizade
                </button>
              )}
            </div>
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
                notifyTyping(v)
              }}
              onPaste={handleComposerPaste}
              onKeyDown={e => {
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
            <button onClick={send} disabled={!input.trim() || !!intro?.blocked} aria-label="Enviar"
              style={{ background: input.trim() && !intro?.blocked ? t.accent : 'transparent', color: input.trim() && !intro?.blocked ? '#fff' : t.muted, border: 'none', borderRadius: 8, padding: '6px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, cursor: !input.trim() || intro?.blocked ? 'default' : 'pointer', opacity: !input.trim() || intro?.blocked ? 0.45 : 1 }}>
              <Icon d={Icons.send} size={16} />
            </button>
          </div>
          <div style={{ fontSize: 10, color: t.muted, marginTop: 6, textAlign: 'center', opacity: 0.7 }}>Enter envia • Shift+Enter quebra linha • offline: pendente → enviado → entregue</div>
        </div>

        {renderMobileSheets()}
      </div>
    )
  }

  return (
    <div className="m-root" style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: t.main, color: t.text, fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", overflow: 'hidden', position: 'relative' } as any}>

      {}
      <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10, paddingBottom: 0, paddingTop: 'env(safe-area-inset-top)', background: t.sidebar, borderBottom: `1px solid ${t.border}`, flexShrink: 0 }}>
        <button aria-label="Menu" className="m-iconbtn" onClick={() => setShowDrawer(v => !v)}>
          <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><span style={{ width: 16, height: 2, background: 'currentColor', borderRadius: 99 }} /><span style={{ width: 16, height: 2, background: 'currentColor', borderRadius: 99 }} /><span style={{ width: 10, height: 2, background: 'currentColor', borderRadius: 99 }} /></span>
        </button>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 800, fontSize: 16, color: t.heading, whiteSpace: 'nowrap' }}>DisTorrent</span>
          <span className="m-pill">
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: pillColor, boxShadow: netOnline && nativeKind ? `0 0 6px ${t.green}` : 'none', flexShrink: 0 }} />
            {onlineLabel}
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

      {}
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

      {}
      <div style={{ padding: '8px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px' }}>
          <span style={{ color: t.muted, display: 'flex', flexShrink: 0 }}><Icon d={Icons.search} size={15} /></span>
          <input value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder={tab === 'servers' ? 'Buscar servidores…' : tab === 'chats' ? 'Buscar conversas…' : 'Buscar…'} style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: t.text, fontSize: 14 }} />
          {searchQ && <button aria-label="Limpar" onClick={() => setSearchQ('')} style={{ color: t.muted, background: 'transparent', border: 'none', cursor: 'pointer', flexShrink: 0 }}>x</button>}
        </div>
      </div>

      {}
      {error && (
        <div className="m-err" style={{ margin: '0 12px 8px', flexShrink: 0 }}>
          {error}
          {}
          {/chamada em andamento/i.test(error) && (
            <button
              type="button"
              data-testid="force-reset-call"
              onClick={async () => {
                try { await callManager.forceReset() } catch {  }
                setError(null)
                setNotice('estado da chamada limpo — tente de novo')
              }}
              style={{ marginLeft: 8, background: '#f23f42', color: '#fff', border: 'none', padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}
            >
              Destravar
            </button>
          )}
          <button onClick={() => setError(null)} style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#ff9c9c', cursor: 'pointer' }}>x</button>
        </div>
      )}
      {notice && <div className="m-ok" style={{ margin: '0 12px 8px', flexShrink: 0 }}>{notice}</div>}

      {}
      <div className="hide-scrollbar" style={{ flex: 1, overflowY: 'auto', padding: '0 12px', paddingBottom: 'calc(76px + env(safe-area-inset-bottom))' }}>

        {tab === 'home' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 8, padding: '12px' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: pillColor, boxShadow: netOnline && nativeKind ? `0 0 6px ${t.green}` : 'none', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: t.heading }}>{netState ? stateLabel[netState as NetworkState] : 'INICIANDO…'}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>{linkedOnline.size} online entre amigos, grupos e servidor{status && status.listen_port > 0 ? ` • porta ${status.listen_port}` : ''}</div>
            </div>
            <span style={{ fontSize: 10, color: t.muted, fontFamily: MONO, flexShrink: 0 }}>{identity?.fingerprint.slice(0, 8)}</span>
          </div>

          {(() => {
            const amigos = new Set(friendsAccepted.map(f => f.fp))
            const vinculados = peers.filter(p => p.state === 'CONNECTED' && p.fp !== identity?.fingerprint)
            return (
              <>
                <Section variant="mobile" title={<span>ONLINE — {vinculados.length}</span>} maxVisible={8}>
                  {vinculados.length === 0
                    ? <EmptyBlock msg="Ninguém online agora — é silencioso demais aqui." sub={<span>Amigo, grupo ou servidor: quem estiver conectado aparece aqui. <button className="link-btn" onClick={() => setFriendsTab('adicionar')}>adicione alguém!</button></span>} />
                    : <div style={{ display: 'flex', flexDirection: 'column' }}>
                        {vinculados.map(p => {
                          const ehAmigo = amigos.has(p.fp)
                          const mesmoGrupo = groupMemberFps.some(([fp]) => fp === p.fp)
                          // Servidor em comum em QUALQUER comunidade: antes só o
                          // grupo contava e o contato de servidor não abria.
                          const mesmoServidor = communities.some((c) =>
                            (c.members ?? []).some(([fp]) => fp === p.fp),
                          )
                          const podeConversar = canOpenConversation({
                            relation: ehAmigo ? 'friend' : 'none',
                            sharedGroup: mesmoGrupo,
                            sharedCommunity: mesmoServidor,
                          })
                          const nome = resolveMemberName(p.fp) || p.nickname || p.fp.slice(0, 8)
                          const rotulo = ehAmigo ? 'amigo' : mesmoGrupo ? 'mesmo grupo' : mesmoServidor ? 'mesmo servidor' : 'contato'
                          return (
                            <div
                              key={p.fp}
                              className="friend-row"
                              onClick={() => { if (podeConversar) void openDm(p.fp, nome); else setNotice('Sem canal de contato — peça o fingerprint e adicione como amigo') }}
                              style={{ cursor: podeConversar ? 'pointer' : 'default' }}
                            >
                              <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                                <Avatar name={nome} fp={p.fp} size={32} avatarB64={profilesByFp[p.fp]?.avatar_b64} />
                                <PeerDot on ring={t.sidebar} />
                              </span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nome}</div>
                                <div style={{ fontSize: 11, color: t.muted }}>{rotulo}</div>
                              </div>
                            </div>
                          )
                        })}
                      </div>}
                </Section>
              </>
            )
          })()}

          <Section variant="mobile" title="CONVERSAS RECENTES" maxVisible={5}>
            {filteredConvs.length === 0
              ? <EmptyBlock msg="Nenhuma conversa" sub="Adicione amigos e comece a conversar." />
              : <div style={{ display: 'flex', flexDirection: 'column' }}>{filteredConvs.map(c => <ConvRow key={c.id} c={c} online={isPresenceOnline({ connected: onlineFps.has(c.peer_fp), chosen: presence.get(c.peer_fp)?.status })} selected={selConv === c.id} avatarB64={profilesByFp[c.peer_fp]?.avatar_b64} myFp={identity?.fingerprint} onOpen={openConv} onDelete={deleteConv} room={callRoomsMap.get(c.id) ?? null} onJoinRoom={joinRoom} />)}</div>}
          </Section>

          <Section variant="mobile" title={`SEUS SERVIDORES — ${filteredComms.length}`} maxVisible={6}>
            {filteredComms.length === 0
              ? <EmptyBlock msg="Nenhum servidor ainda" sub={<span>Tem um convite de amigo? <button className="link-btn" onClick={() => { setInviteInput(''); setShowInvite(true) }}>Entrar com convite</button></span>} />
              : <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{filteredComms.map(c => <ServerRow key={c.id} c={c} active={selCommunity === c.id} onSelect={setSelCommunity} />)}</div>}
          </Section>
        </>}

        {tab === 'servers' && (() => {
          const summaries: ServerSummary[] = filteredComms.map((c) => {
            const st = c.id === selCommunity ? memberPairing : []
            const s = summarize(st)
            const vivos = (c.members ?? []).filter(([fp]) => onlineFps.has(fp)).length
            return {
              community: c,
              online: Math.max(s.online, vivos),
              total: c.members.length || s.total,
              pending: s.pending,
            }
          })
          return (
            <>
              {}
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
                    aria-label="Membros e convite do servidor"
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

              {activeComm && (() => {
                const c = activeComm
                return (
                  <>
                    {}
                    <button
                      onClick={() => setShowServerDetails(true)}
                      aria-label={`Abrir o servidor ${c.name}`}
                      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', marginTop: 10, marginBottom: 10, padding: 10, background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 10, color: t.text, cursor: 'pointer', textAlign: 'left' }}
                    >
                      <Avatar name={c.name} fp={c.id} size={34} />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 800, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                        <span style={{ display: 'block', fontSize: 11, color: t.muted, marginTop: 2 }}>{c.channels.length} canais · {c.members.length} membros</span>
                      </span>
                      <Icon d={Icons.chevronRight} size={16} />
                    </button>
                    <div className="m-sec">CANAIS</div>
                    {
}
                    <MobileServerPanel
                      community={c}
                      myFp={identity?.fingerprint ?? ''}
                      selectedChannelId={selConv}
                      inCallChannelId={inCallChannelId}
                      onOpenText={(channelId) => { setSelCommunity(c.id); setSelConv(channelId); setSelPeerFp(null) }}
                      onJoinCall={(channelId) => void enterCallChannel(c.id, channelId)}
                      onLeaveCall={() => { void leaveCallChannel() }}
                      onError={(msg) => setError(msg)}
                    />
                  </>
                )
              })()}

              {
}
              {activeComm && showServerDetails && (
                <div
                  onClick={() => setShowServerDetails(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 320, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'flex-end' }}
                >
                  <div
                    role="dialog"
                    aria-label={`Servidor ${activeComm.name}`}
                    onClick={(e) => e.stopPropagation()}
                    style={{ width: '100%', maxHeight: '88dvh', overflowY: 'auto', background: t.panel, borderTop: `1px solid ${t.border}`, borderRadius: 16, padding: 12, paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <Avatar name={activeComm.name} fp={activeComm.id} size={40} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activeComm.name}</div>
                        <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>{activeComm.channels.length} canais · {activeComm.members.length} membros</div>
                      </div>
                      <button onClick={() => setShowServerDetails(false)} aria-label="Fechar" style={{ background: 'transparent', border: 'none', color: t.muted, display: 'flex', padding: 4, cursor: 'pointer' }}><Icon d={Icons.x} size={18} /></button>
                    </div>

                    <div className="m-sec">MEMBROS — pareamento</div>
                    <MemberPairingList
                      members={memberPairing}
                      emptyHint="Nenhum membro sincronizado. Se você acabou de entrar, aguarde a confirmação do dono."
                    />

                    <div className="m-sec">CONVITE</div>
                    <InvitePanel
                      communityId={activeComm.id}
                      canCreateInvite={activeComm.is_owner === true}
                      onError={(msg) => setError(msg)}
                    />
                  </div>
                </div>
              )}
            </>
          )
        })()}

        {tab === 'chats' && <>
          <div className="m-sec">CONVERSAS DIRETAS — {filteredConvs.length}</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', padding: '0 0 8px' }}>
            {([['todos', 'Todos'], ['amigos', 'Amigos'], ['contatos', 'Contatos'], ['grupos', 'Grupos']] as const).map(([id, label]) => (
              <button
                key={id}
                className={'m-tab' + (convFilter === id ? ' on' : '')}
                aria-pressed={convFilter === id}
                onClick={() => setConvFilter(id)}
              >{label}</button>
            ))}
          </div>
          {filteredConvs.length === 0
            ? <EmptyBlock msg="Nenhuma conversa" sub={<span>Adicione amigos em <button className="link-btn" onClick={() => setTab('friends')}>Amigos</button> e comece a conversar.</span>} />
            : <div style={{ display: 'flex', flexDirection: 'column' }}>{filteredConvs.map(c => <ConvRow key={c.id} c={c} online={isPresenceOnline({ connected: onlineFps.has(c.peer_fp), chosen: presence.get(c.peer_fp)?.status })} selected={selConv === c.id} avatarB64={profilesByFp[c.peer_fp]?.avatar_b64} onOpen={openConv} onDelete={deleteConv} room={callRoomsMap.get(c.id) ?? null} onJoinRoom={joinRoom} />)}</div>}
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
                  placeholder="Fingerprint (12) ou chave (64)"
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
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, padding: '10px 12px', background: t.input, border: `1px solid ${t.border}`, borderRadius: 10 }}>
                <input
                  type="checkbox"
                  checked={friendRequestsAllowed}
                  onChange={async e => {
                    const ligado = e.target.checked
                    setFriendRequestsAllowed(ligado)
                    try { await services.friendRequestsSet(ligado) }
                    catch (err: any) { setFriendRequestsAllowed(!ligado); setError(String(err?.message ?? err)) }
                  }}
                  style={{ marginTop: 2, accentColor: t.accent }}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: t.text }}>Aceitar solicitações de amizade</span>
                  <span style={{ display: 'block', fontSize: 11, color: t.muted, marginTop: 2, lineHeight: 1.5 }}>
                    Desligado, ninguém consegue te enviar pedido novo. Quem já é amigo continua amigo.
                  </span>
                </span>
              </label>
              {pendingOut.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: t.muted, marginBottom: 8 }}>ENVIADAS ({pendingOut.length}) — aguardando</div>
                  {pendingOut.map(r => (
                    <div key={r.fp} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, marginBottom: 6 }}>
                      <Avatar name={r.nickname || r.fp} fp={r.fp} size={28} avatarB64={profilesByFp[r.fp]?.avatar_b64} />
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
              <EmptyBlock
                msg={friendRequestsAllowed
                  ? 'Não há solicitações pendentes. Que pena.'
                  : 'Solicitações de amizade estão desligadas. Ninguém consegue te enviar pedido novo.'}
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {friendRequests.map(r => (
                  <div key={r.fp} className="friend-row">
                    <Avatar name={r.nickname || r.fp} fp={r.fp} size={32} avatarB64={profilesByFp[r.fp]?.avatar_b64} />
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
                    <Avatar name={f.nickname || f.fp} fp={f.fp} size={32} avatarB64={profilesByFp[f.fp]?.avatar_b64} />
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
            <div style={{ display: 'flex', flexDirection: 'column' }}>{shownFriends.map(f => <FriendRow key={f.fp} f={f} online={isPresenceOnline({ connected: onlineFps.has(f.fp), chosen: presence.get(f.fp)?.status })} avatarB64={profilesByFp[f.fp]?.avatar_b64} onOpen={openDm} onRemove={removeFriend} onBlock={blockFriend} />)}</div>
          )}
        </>}

        {tab === 'profile' && <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '16px 4px 8px' }}>
            {}
            {identity && <button
              type="button"
              aria-label="Editar meu perfil"
              onClick={() => setProfilePeer({ fp: identity.fingerprint, name: profilesByFp[identity.fingerprint]?.display_name || identity.nickname })}
              style={{ position: 'relative', display: 'inline-flex', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}
            >
              <Avatar
                name={profilesByFp[identity.fingerprint]?.display_name || identity.nickname}
                fp={identity.fingerprint}
                size={64}
                avatarB64={profilesByFp[identity.fingerprint]?.avatar_b64}
                accent={profilesByFp[identity.fingerprint]?.accent || undefined}
              />
              <PeerDot on={myPresence !== 'offline' && myPresence !== 'invisible'} ring={t.sidebar} />
              <span aria-hidden style={{ position: 'absolute', right: -2, top: -2, background: t.accent, color: '#fff', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${t.main}` }}>
                <Icon d={Icons.edit} size={11} />
              </span>
            </button>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 18, fontWeight: 900, color: profilesByFp[identity?.fingerprint ?? '']?.accent || t.heading }}>{profilesByFp[identity?.fingerprint ?? '']?.display_name || identity?.nickname}</div>
              <div style={{ fontSize: 11, color: t.muted, fontFamily: MONO, wordBreak: 'break-all', marginTop: 2 }}>{identity?.fingerprint}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 6 }}>{friendsAccepted.length} amigos • {communities.length} servidores • {status?.online_peers ?? 0} online</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 8 }}>
            <button className="nav-row" onClick={() => identity && setProfilePeer({ fp: identity.fingerprint, name: profilesByFp[identity.fingerprint]?.display_name || identity.nickname })}>
              <span style={{ display: 'flex', flexShrink: 0 }}><Icon d={Icons.edit} size={17} /></span>
              Editar perfil
              <span style={{ marginLeft: 'auto', fontSize: 11, color: t.muted }}>nome • foto • sobre</span>
            </button>
            <button className="nav-row" onClick={() => { services.privacyGet().then(s => setPrivacyMode(s.mode)).catch(() => {}); privacy.resetTransient(); void refreshPrivacyExtras(privacyMode); setShowPrivacy(true) }}>
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
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>MENSAGENS</div>
              <MessageRetentionSettings inputBg={t.input} borderColor={t.border} text={t.text} muted={t.muted} accent={t.accent} />
            </div>
            <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 14, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>ATUALIZAÇÕES</div>
              <UpdateSettingsBox api={updateGate} />
            </div>
            <div style={{ background: t.sidebar, border: `1px solid ${t.border}`, borderRadius: 14, padding: 12, marginTop: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 1.2, color: t.muted, marginBottom: 8 }}>COFRE &amp; BACKUP</div>
              <StormVaultPanel />
            </div>
            <button className="nav-row" style={{ color: t.red }} onClick={() => { setShowQuitConfirm(true) }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              Fechar o app
            </button>
            {}
            <button className="nav-row" style={{ color: t.muted }} onClick={() => { if (confirm('Sair da conta? Será preciso destravar de novo para voltar.')) { setPhase('lock'); setIdentity(null as any); setSelConv(null); setSelPeerFp(null); setSelCommunity(null) } }}>
              <Icon d={Icons.user} size={16} />
              Sair da conta
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

      {}
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

            {}
            <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 10, padding: '10px 12px', marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.5, color: t.muted }}>
                {(privacyMode === 'proxy' || privacyMode === 'full') ? (privacyProxyEffective ? 'PROXY: ATIVADO (efetivo)' : 'PROXY: OFFLINE — relay desligado (fail-closed)') : 'Proxy: Desativado'}
              </div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 2 }}>
                {(privacyMode === 'proxy' || privacyMode === 'full')
                  ? (privacyProxyEffective
                      ? `relay saindo por ${proxyAddr || '—'} (SOCKS5 — sem ntfy, sem HTTP externo)`
                      : 'o proxy não respondeu ou o endereço é inválido: o relay fica DESLIGADO até ele voltar (fail-closed, sem fallback direto)')
                  : 'nenhuma conexão passa por proxy — relay MQTT direto dos brokers públicos'}
              </div>
            </div>

             {}
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
                    onChange={e => { setProxyAddr(e.target.value); privacy.resetTransient() }}
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
                  <button className="m-btn ghost" style={{ flex: 1 }} onClick={() => privacy.resetTransient()}>Cancelar</button>
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

      {}
      {}

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
            {}
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

      {showQuitConfirm && (
        <QuitDialog
          canQuit={services.kind === 'native'}
          startedAtMs={appStartedAt.current}
          onClose={() => setShowQuitConfirm(false)}
          onMinimize={async () => {
            try { await callManager.leave() } catch {  }
            try { await services.appHideToTray() } catch {  }
          }}
          onQuit={async () => {
            try { await callManager.leave() } catch {  }
            try { await services.appQuit() } catch (e: any) { setError(String(e?.message ?? e)) }
          }}
        />
      )}

      {leaveTarget && (
        <GroupLeaveDialog
          title={leaveTarget.title}
          isOwner={leaveTarget.owner}
          onClose={() => setLeaveTarget(null)}
          onLeave={async () => {
            await services.groupLeave(leaveTarget.id)
            if (selConv === leaveTarget.id) setSelConv(null)
            refreshConvos()
            setNotice('Você saiu do grupo')
          }}
          onDeleteAll={async () => {
            await services.groupDelete(leaveTarget.id)
            if (selConv === leaveTarget.id) setSelConv(null)
            refreshConvos()
            setNotice('Grupo apagado para todos')
          }}
          onDeleteLocal={async () => {
            await services.groupDeleteLocal(leaveTarget.id)
            if (selConv === leaveTarget.id) setSelConv(null)
            refreshConvos()
            setNotice('Grupo apagado só para você')
          }}
        />
      )}

      {}
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
