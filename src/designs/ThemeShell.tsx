import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { Icon, Icons } from '../shared/icons'
import { Section } from '../shared/Section'
import { activeToken, applyFormat } from '../shared/markdown'
import { NAMED_EMOJI } from '../shared/emojiSet'
import { EmojiPicker } from '../shared/EmojiPicker'
import MessageList, { type MessageListHandle } from '../components/social/MessageList'
import { BookmarksPanel, ChannelSettingsModal, CommandPalette, EventPanel, InboxPanel, ModerationPanel, PinsPanel, ProfileModal, SearchPanel, ThreadViewModal, useShortcuts, type Command, type InboxTab } from '../components/social/Social'
import { services } from '../services'
import type { Identity, NetworkState, PeerView, CommunityView, RoleView, BotView, ChannelMeta, StoredMessage, MemberPairing } from '../services/models'
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
import CallTilesGrid from '../components/calls/CallTilesGrid'
import VoiceStage from '../components/calls/VoiceStage'
import {
  resolveVoiceLayout,
  resolveCallDock,
  callPanelWidth,
  callScreenTitle,
  type CallPanelSize,
} from '../services/voiceLayout'
import { parseVoiceCallId } from '../services/voiceChannelRef'
import { resolveBootPhase } from '../services/bootPhase'
import { windowMembers, LIMITE_MEMBROS } from '../services/memberWindow'
import ScreenStage from '../components/calls/ScreenStage'
import { buildCallTiles, sortTilesForPin } from '../services/callTiles'
import { callIsActive, callMediaLive } from '../services/callUiState'
import { cameraCycleLabel, shouldShowCameraSwitch } from '../services/callCameras'
import { useCallCameras } from '../services/useCallCameras'
import { callRooms, roomSummary, syncCallRooms, ROOM_SYNC_MS, type CallRoomView } from '../services/callRooms'
import ScreenSharePicker from '../components/ScreenSharePicker'
import DownloadsPanel from '../components/DownloadsPanel'
import { FileCard } from '../components/FileCard'
import CreateServerWizard from '../components/CreateServerWizard'
import { DynamicStyles } from '../shared/dynamicStyles'
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
import { contactBadge, effectivePresence, introState, relationOf } from '../services/socialRules'
import { Modal, Notice, Button } from '../shared/ui'
import { WIDTHS } from '../shared/ui'
import { GroupPanel } from '../components/social/GroupPanel'
import { GroupLeaveDialog } from '../components/social/GroupLeaveDialog'
import { QuitDialog } from '../components/QuitDialog'
import { resolveSessionStart } from '../services/appUptime'
import { copyText } from '../shared/clipboard'
import { pastedImages } from '../shared/clipboardImage'
import { mergeChannels, isCallableChannel } from '../app/channels'
import CallPhaseBadge from '../components/CallPhaseBadge'
import { downloadManager } from '../services/downloadManager'
import { startDownload } from '../services/downloadAction'
import { botRuntime } from '../services/botRuntime'
import { StormVaultPanel } from '../components/vault/StormVaultPanel'
import { MetricsPanel } from '../components/dev/MetricsPanel'
import { callManager, setCallIdentity, supportsScreenShare, diagnoseCallsSupport, detectNativeVoice, getCallsSupport, getCallsUnavailableMessage, hasRelayConfigured, CALLS_UNAVAILABLE_MSG, SCREEN_UNAVAILABLE_MSG, screenShareUnavailableReason, ICE_RELAY_MSG, ICE_FAILED_MSG, getStoredQuality, getTurnUrl, isValidTurnUrl, getCallMediaPrefs, type CallQuality, type IncomingCall } from '../services/callManager'
import CallSettingsPanel from '../components/calls/CallSettingsPanel'
import { fileSwarm, encodeFileBody, parseFileBody } from '../services/fileSwarm'
import { isMediaName } from '../services/fileRules'
import { sfxMessage, sfxRingStart, sfxRingStop, sfxCallConnect, sfxCallEnd } from '../services/sfx'
import { throttleTrailing } from '../shared/perf'
import { addFolder, folderOf, isMutedServer, moveServerToFolder, removeFolder, renameFolder, shouldNotify, toggleMuteChannel, toggleMuteServer, usePrefs } from '../shared/prefs'
import { AppearanceSettings } from '../components/prefs/AppearanceSettings'
import { NotificationSettings } from '../components/prefs/NotificationSettings'
import { SystemNotificationSettings } from '../components/prefs/SystemNotificationSettings'
import {
  notifyMessage, notifyIncomingCall, notifyReaction, notifyFriend, endCallNotice, markCallHandled,
  setOpenConversation, onOpenConversation, onCallNotificationAction, registerConversationPeer,
} from '../services/notifications'
import { setDesiredPresence } from '../services/appState'
import { VoiceDeviceSettings } from '../components/prefs/VoiceDeviceSettings'
import { MessageRetentionSettings } from '../components/prefs/MessageRetentionSettings'
import { usePrivacySettings } from '../services/usePrivacySettings'
import { Avatar, PeerDot } from '../shared/avatarView'
import { avatarColor } from '../shared/theme'
import { BootScreen, CreateAccount, LockScreen } from './auth/AuthScreens'

const authPalette = {
  main: '#313338', sidebar: '#2b2d31', input: '#1e1f22', border: '#26272b',
  heading: '#f2f3f5', text: '#dbdee1', muted: '#949ba4', accent: '#5865f2', red: '#f23f42',
}

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

const stateLabel: Record<NetworkState, string> = {
  CONNECTED: 'CONECTADO', CONNECTING: 'CONECTANDO', RECONNECTING: 'RECONECTANDO', DISCONNECTED: 'OFFLINE',
}

export { BootScreen, CreateAccount, LockScreen } from './auth/AuthScreens'

export type { FormatMode, AutoItem } from './shellComposerData'
export {
  FORMAT_BUTTONS,
  composerMenuStyle,
  SLASH_BASE,
  fmtShortDuration,
  SECTION_IDA,
} from './shellComposerData'
import {
  FORMAT_BUTTONS,
  composerMenuStyle,
  SLASH_BASE,
  fmtShortDuration,
  SECTION_IDA,
  type FormatMode,
  type AutoItem,
} from './shellComposerData'

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

  const refreshUnread = useCallback(async () => {
    if (!selConv) return
    try {
      const [n, m] = await Promise.all([
        services.unreadCount(selConv).catch(() => 0),
        services.unreadMentions().catch(() => 0),
      ])
      setUnreadMap(prev => ({ ...prev, [selConv]: n }))
      setMentionTotal(m)
    } catch {  }
  }, [selConv])

  useEffect(() => { void refreshUnread() }, [refreshUnread, messages.length])
  useEffect(() => {
    const un = services.subscribe((ev: any) => {
      if (ev.type === 'message_new' || ev.type === 'message_deleted') void refreshUnread()
    })
    return un
  }, [refreshUnread])

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
    } catch {  }
  }, [messages, selConv])

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
    } catch {  }
  }, [input, selConv])
  const [showSettings, setShowSettings] = useState(false)
  const [showScreenPicker, setShowScreenPicker] = useState(false)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [showPrivacyModal, setShowPrivacyModal] = useState(false)
  const [addrInput, setAddrInput] = useState('')
  const [error, setError] = useState<string | null>(null)
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
  function closePrivacyModal() {
    setShowPrivacyModal(false)
    resetTransient()
  }
  const [friendFpInput, setFriendFpInput] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [communities, setCommunities] = useState<CommunityView[]>([])
  const [selCommunity, setSelCommunity] = useState<string | null>(null)
  const [view, setView] = useState<'amigos'|'servidores'>('amigos')
  const [showInvite, setShowInvite] = useState(false)
  const [showCreateServer, setShowCreateServer] = useState(false)
  const [showDownloads, setShowDownloads] = useState(false)
  const [dlCount, setDlCount] = useState(0)
  const [configBotId, setConfigBotId] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(() => Date.now())
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
  const [serverFlow, setServerFlow] = useState<'choose'|'create'|'join'|'invite'>('choose')
  const [friendsTab, setFriendsTab] = useState<'online'|'todos'|'pendentes'|'bloqueados'|'adicionar'>('online')
  const [unreadServers, setUnreadServers] = useState<Set<string>>(new Set())
  const [typingPeers, setTypingPeers] = useState<Record<string, { nick: string; at: number }>>({})
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastTypingSent = useRef(0)
  const [serverMenuOpen, setServerMenuOpen] = useState(false)
  const [inviteTokenError, setInviteTokenError] = useState<string | null>(null)
  const [inviteFromLink, setInviteFromLink] = useState<string | null>(null)
  const [memberPairing, setMemberPairing] = useState<MemberPairing[]>([])

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
        })
    }
    load()
    const t = window.setInterval(load, 5000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [selCommunity, communities.length])

  const serverSummaries = useMemo<ServerSummary[]>(() => {
    return communities.map((c) => {
      const st = c.id === selCommunity ? memberPairing : []
      const s = summarize(st)
      const vivos = (c.members ?? []).filter(([fp]) => peers.some((p) => p.fp === fp && p.state === 'CONNECTED')).length
      return {
        community: c,
        online: Math.max(s.online, vivos),
        total: c.members.length || s.total,
        pending: s.pending,
      }
    })
  }, [communities, selCommunity, memberPairing, peers])

  const [oldPass, setOldPass] = useState('')
  const [newPass, setNewPass] = useState('')
  const [friendRequests, setFriendRequests] = useState<{fp:string,nickname:string}[]>([])
  const [friendsAccepted, setFriendsAccepted] = useState<{fp:string,nickname:string}[]>([])
  const [friendsBlocked, setFriendsBlocked] = useState<{fp:string,nickname:string}[]>([])
  const [pendingOut, setPendingOut] = useState<{fp:string,nickname:string}[]>([])
  const [showProfile, setShowProfile] = useState(false)
  const [extraChannels, setExtraChannels] = useState<ChannelMeta[]>([])
  const [roles, setRoles] = useState<RoleView[]>([])
  const [bots, setBots] = useState<BotView[]>([])
  const [channelMenu, setChannelMenu] = useState<{ x: number; y: number; id: string } | null>(null)
  const [railMenu, setRailMenu] = useState<{ x: number; y: number; serverId: string } | null>(null)
  const [railFolderName, setRailFolderName] = useState('')
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set())
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [serverTab, setServerTab] = useState<'geral'|'canais'|'cargos'|'bots'|'membros'>('geral')
  const [pendingChannelEdit, setPendingChannelEdit] = useState<string | null>(null)
  const [pendingCategory, setPendingCategory] = useState<string | null>(null)
  const [memberRolesCache, setMemberRolesCache] = useState<Record<string, string[]>>({})
  const [activeCall, setActiveCall] = useState<any>(null)
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null)
  const [callActionBusy, setCallActionBusy] = useState(false)
  const peerNickCacheRef = useRef<Record<string, string>>({})
  const [callDuration, setCallDuration] = useState(0)
  const [callPanelSize, setCallPanelSize] = useState<CallPanelSize>('normal')
  const [callPanelHidden, setCallPanelHidden] = useState(false)
  const [pinnedTileId, setPinnedTileId] = useState<string | null>(null)
  const [expandedTileId, setExpandedTileId] = useState<string | null>(null)
  const [showAddToCall, setShowAddToCall] = useState(false)
  const [showCreateGroup, setShowCreateGroup] = useState(false)
  const [showGroupPanel, setShowGroupPanel] = useState(false)
  const [leaveTarget, setLeaveTarget] = useState<{ id: string; title: string; owner: boolean } | null>(null)
  const [showQuitMenu, setShowQuitMenu] = useState(false)
  const [groupRosters, setGroupRosters] = useState<Record<string, [string, string][]>>({})
  useEffect(() => {
    const grupos = conversations.filter((c) => c.kind === 'group')
    if (grupos.length === 0) return
    let vivo = true
    const ler = async () => {
      const next: Record<string, [string, string][]> = {}
      for (const g of grupos) {
        try { next[g.id] = await services.groupMembers(g.id) } catch {  }
      }
      if (vivo) setGroupRosters(next)
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
  const [groupMemberCount, setGroupMemberCount] = useState(0)
  const [groupTitle, setGroupTitle] = useState('')
  const [groupPick, setGroupPick] = useState<Set<string>>(new Set())
  const [voiceChannel, setVoiceChannel] = useState<{ communityId: string; channelId: string } | null>(null)
  const [voiceStates, setVoiceStates] = useState<[string,boolean,boolean][]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [callQuality, setCallQuality] = useState<CallQuality>(() => getStoredQuality())
  const [qualityError, setQualityError] = useState<string | null>(null)
  const [showCallSettings, setShowCallSettings] = useState(false)
  const [callMediaPrefsState, setCallMediaPrefsState] = useState(() => getCallMediaPrefs())
  const [, setScreenOptsTick] = useState(0)
  const [turnInput, setTurnInput] = useState(() => getTurnUrl())
  const [turnMsg, setTurnMsg] = useState<string | null>(null)
  const [showCallDiag, setShowCallDiag] = useState(false)
  const [fileList, setFileList] = useState<any[]>([])
  const [dlByFile, setDlByFile] = useState<Record<string, { pct: number; speed: number; status: string; error?: string }>>({})
  const [previews, setPreviews] = useState<Record<string, string>>({})
  const previewsRef = useRef<Record<string, string>>({})
  const previewUrlsRef = useRef<string[]>([])
  const previewFetchingRef = useRef<Map<string, number>>(new Map())
  const swarmNotifyRef = useRef<() => void>(() => {})
  const fileInputRef = useRef<HTMLInputElement | null>(null)

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
        // Tem identidade mas nenhum cofre: relê (o keyring pode responder depois).
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
    } catch {  }
  }

  async function refreshCommunities() {
    try {
      const list = await services.communitiesList() ?? []
      setCommunities(list)
    } catch {  }
  }

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
      const m = communities.find(c => c.id === cid)?.members ?? []
      const map: Record<string, string[]> = {}
      await Promise.all(m.map(async ([fp]) => {
        try { map[fp] = await services.memberRoles(cid, fp) } catch { map[fp] = [] }
      }))
      setMemberRolesCache(map)
    } catch {  }
  }
  useEffect(() => { refreshExtras(selCommunity) }, [selCommunity, communities.length])
  useEffect(() => {
    if (!selCommunity) return
    try { void services.communityPairNow?.(selCommunity)?.catch(() => {  }) } catch {  }
    try { void services.communitySyncNow?.(selCommunity)?.catch(() => {  }) } catch {  }
  }, [selCommunity])
  useEffect(() => { if (phase === 'app') { refreshFriends(); refreshCommunities() } }, [phase])

  useEffect(() => {
    callManager.bind((s: any) => {
      setActiveCall(s)
      if (!s || !String(s.callId ?? '').startsWith('voice-')) setVoiceChannel(null)
      if (s) {
        setIsMuted(!!s.muted)
        setIsDeafened(!!s.deafened)
      }
    })
    try { diagnoseCallsSupport() } catch {  }
    try {
      void services.identityGet()
        .then(() => console.info('[distorrent-probe] AppState OK — identity_get respondeu'))
        .catch((e) => console.warn('[distorrent-probe] AppState FALHOU:', String(e)))
    } catch (e) { console.warn('[distorrent-probe] AppState FALHOU:', String(e)) }
    let stopBots: (() => void) | undefined
    try { stopBots = botRuntime.start() } catch {  }
    try { downloadManager.load() } catch {  }
    let unCount = () => {}
    try {
      unCount = downloadManager.subscribe((items) => {
        try { setDlCount(items.filter(i => i.status === 'queued' || i.status === 'downloading' || i.status === 'verifying' || i.status === 'saving').length) } catch {  }
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
      setIncomingCall((cur) => (cur && cur.call_id === callId ? null : cur))
      try { sfxRingStop() } catch {  }
    }
    callManager.onRoomsChanged = () => { void syncCallRooms(() => services.callRoomsList()) }
    return () => {
      callManager.unbind()
      try { stopBots?.() } catch {  }
      try { unCount() } catch {  }
      callManager.onCallNotice = unNotice
      callManager.onIceFailed = unIce
      callManager.onIncomingGone = unIncomingGone
      callManager.onRoomsChanged = null
    }
  }, [])
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
    activeCall?.participants,
    activeCall?.sharing,
    activeCall?.cameraOn,
    activeCall?.muted,
    (activeCall as any)?.localStream,
    (activeCall as any)?.localScreenStream,
    (activeCall as any)?.nativeMedia,
    identity?.fingerprint,
  ])

  useEffect(() => {
    const st: any = activeCall
    if (!st?.participants?.length) return
    let mudou = false
    for (const p of st.participants as { fp: string; nickname?: string }[]) {
      if (!p?.fp || p.fp === identity?.fingerprint) continue
      const nome = nameOfFp(p.fp)
      if (nome && nome !== p.nickname && nome !== p.fp.slice(0, 8)) { p.nickname = nome; mudou = true }
    }
    if (mudou) setActiveCall((cur: any) => (cur ? { ...cur, participants: [...cur.participants] } : cur))
  }, [activeCall?.participants, identity?.fingerprint, socialProfiles, peers])

  const mediaLive = useMemo(() => (activeCall ? callMediaLive({
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

  useEffect(() => {
    if (activeCall) return
    setExpandedTileId(null)
    setPinnedTileId(null)
  }, [activeCall])

  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 0,
  )
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /**
   * Largura que a coluna principal realmente tem, medida no DOM.
   *
   * Estimar por `innerWidth - constantes` erra feio: com servidor aberto existe
   * a lista de membros (240px) além do rail e da lista de canais, e é essa
   * soma que decide se o painel da chamada cabe. Medir o container é a única
   * fonte honesta.
   */
  const mainColRef = useRef<HTMLDivElement | null>(null)
  const [chromeWidth, setChromeWidth] = useState(0)
  useEffect(() => {
    const el = mainColRef.current
    const pai = el?.parentElement ?? null
    if (!el || !pai) return
    const medir = () => {
      const w = Math.max(0, pai.clientWidth - el.clientWidth)
      setChromeWidth((cur) => (Math.abs(cur - w) < 2 ? cur : w))
    }
    medir()
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(medir)
      ro.observe(pai)
    } catch {  }
    window.addEventListener('resize', medir)
    return () => {
      try { ro?.disconnect() } catch {  }
      window.removeEventListener('resize', medir)
    }
  }, [])

  const visibleCallTiles = useMemo(() => {
    const valid = callTiles.map((tile) => tile.id)
    const pin = pinnedTileId && valid.includes(pinnedTileId) ? pinnedTileId : null
    return pin ? sortTilesForPin(callTiles, pin) : callTiles
  }, [callTiles, pinnedTileId])

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

  const camerasDisponiveis = useCallCameras(!!activeCall)
  const cameraSwitchLabel = cameraCycleLabel(camerasDisponiveis, callMediaPrefsState.videoInputId)
  const mostrarTrocaCamera = shouldShowCameraSwitch(camerasDisponiveis)
  const trocarCamera = async () => {
    try {
      setError(null)
      const r = await callManager.switchCamera()
      setCallMediaPrefsState(getCallMediaPrefs())
      if (r.available < 2) setError('só há uma câmera disponível neste aparelho')
    } catch (e: any) {
      setError(String(e?.message ?? e))
    }
  }
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
  useEffect(() => {
    const notify = throttleTrailing(() => setFileList([...fileSwarm.files.values()]), 300)
    swarmNotifyRef.current = notify
    const prev = fileSwarm.onChange
    fileSwarm.onChange = notify
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

  useEffect(() => {
    const un = downloadManager.subscribe((items) => {
      const next: Record<string, { pct: number; speed: number; status: string; error?: string }> = {}
      for (const it of items) {
        next[it.file_id] = { pct: it.progress, speed: it.speedBps, status: it.status, error: it.error }
      }
      setDlByFile(next)
    })
    return () => { try { un() } catch {  } }
  }, [])

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
      const blob = fileSwarm.blobFor(sf.file_id)
      if (blob) { mountPreview(sf.file_id, blob); continue }
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
  }, [fileList, mountPreview])
  useEffect(() => () => {
    for (const u of previewUrlsRef.current) { try { URL.revokeObjectURL(u) } catch {  } }
    previewUrlsRef.current = []
  }, [])

  useEngineEvents((ev) => {
    if (ev.type === 'state_changed' || ev.type === 'peer_online' || ev.type === 'peer_offline' || ev.type === 'peer_discovered') refreshNet()
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
    if (ev.type === 'friend_request_in' || ev.type === 'friend_accepted' || ev.type === 'friend_removed') {
      refreshFriends()
      refreshConvos()
      const nome = (ev as unknown as { nickname?: string }).nickname || String((ev as unknown as { fp?: string }).fp ?? '').slice(0, 8)
      if (ev.type === 'friend_request_in') notifyFriend({ kind: 'request', nome })
      else if (ev.type === 'friend_accepted') notifyFriend({ kind: 'accepted', nome })
      else notifyFriend({ kind: 'removed', nome })
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
      if (fp && identity?.fingerprint && fp === identity.fingerprint) return
      const known = peers.find((p) => p.fp === fp)?.nickname
        || friendsAccepted.find((f) => f.fp === fp)?.nickname
        || peerNickCacheRef.current[fp]
        || (ev as unknown as { nickname?: string }).nickname
      if (known && known !== fp) {
        peerNickCacheRef.current[fp] = known
        setIncomingCall({ ...ev, nickname: known })
      } else {
        setIncomingCall(ev)
      }
      if (socialPresence[identity?.fingerprint ?? ''] !== 'dnd') sfxRingStart()
      notifyIncomingCall({ callId: ev.call_id, title: known || fp.slice(0, 8) })
    }
    if (ev.type === 'call_ended') {
      const mine = activeCall?.callId === ev.call_id || incomingCall?.call_id === ev.call_id
      if (mine) { setActiveCall(null); setIncomingCall(null); sfxRingStop(); sfxCallEnd() }
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
      if (msg.includes('canal inexistente') || msg.includes('protocol: canal')) return
      if (msg.includes('no bootstrap') || msg.includes('DISCONNECTED')) return
      setError(msg)
    }
  })

  useEffect(() => { setOpenConversation(selConv) }, [selConv])
  useEffect(() => {
    for (const c of conversations) {
      if (c.peer_fp) registerConversationPeer(c.id, c.peer_fp)
    }
  }, [conversations])
  useEffect(() => onOpenConversation((conv) => { setSelConv(conv); setSelPeerFp(null) }), [])

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
  }), [incomingCall, selConv])

  const selPeer: PeerView | null = selPeerFp ? peers.find(p => p.fp === selPeerFp) ?? null : null
  const selConvObj = conversations.find(c => c.id === selConv) ?? null
  const peerTitle = selConvObj?.title || selPeer?.nickname || selPeer?.fp || ''
  const ehGrupo = selConvObj?.kind === 'group'

  const selPeerState = selPeerFp
    ? selPeerFp === identity?.fingerprint
      ? null
      : friendsAccepted.some(f => f.fp === selPeerFp)
        ? { fp: selPeerFp, status: 'accepted' }
        : friendRequests.some(f => f.fp === selPeerFp)
          ? { fp: selPeerFp, status: 'pending_in' }
          : pendingOut.some(f => f.fp === selPeerFp)
            ? { fp: selPeerFp, status: 'pending_out' }
            : friendsBlocked.some(f => f.fp === selPeerFp)
              ? { fp: selPeerFp, status: 'blocked' }
              : null
    : null
  const selRelation = relationOf(selPeerState, identity?.fingerprint ?? '')
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
  const onlinePeers = peers.filter(p => p.state === 'CONNECTED')
  const activeComm = view === 'servidores' && selCommunity ? communities.find(c => c.id === selCommunity) ?? null : null
  const mergedChannelsForLabel = (() => {
    if (!activeComm) return [] as { id: string; name: string; kind: ChannelMeta['kind'] }[]
    const base = activeComm.channels.map(([id, name]) => {
      const ov = extraChannels.find(c => c.id === id)
      return ov ? { id: ov.id, name: ov.name, kind: ov.kind } : { id, name, kind: 'text' as ChannelMeta['kind'] }
    })
    const extras = extraChannels
      .filter(ec => !activeComm.channels.some(([id]) => id === ec.id))
      .map(c => ({ id: c.id, name: c.name, kind: c.kind }))
    return [...base, ...extras]
  })()
  const channelLabel = mergedChannelsForLabel.find(c => c.id === selConv)?.name ?? (activeComm?.channels.find(([cid]) => cid === selConv)?.[1] ?? 'canal')
  const selCallChannel: ChannelMeta | null = (() => {
    if (!selCommunity || !selConv) return null
    const completo = extraChannels.find((c) => c.id === selConv)
    if (completo) return isCallableChannel(completo.kind) ? completo : null
    const naSidebar = mergedChannelsForLabel.find((c) => c.id === selConv)
    if (!naSidebar) return null
    const meta = { ...naSidebar, topic: '', category: '', position: 0 } as ChannelMeta
    return isCallableChannel(meta.kind) ? meta : null
  })()
  const inThisCall = !!activeCall && !!selCallChannel && activeCall.convId === selCallChannel.id
  const callViva = callIsActive(activeCall)
  const canalDaChamada = useMemo(
    () => parseVoiceCallId(activeCall?.callId, activeCall?.convId),
    [activeCall?.callId, activeCall?.convId],
  )
  const voiceLayout = resolveVoiceLayout({
    isChannel: !!selCallChannel,
    inThisCall,
    hasActiveCall: !!activeCall,
    widthPx: viewportWidth,
  })
  const inCallHere = inThisCall
  const callDock = resolveCallDock({
    hasActiveCall: callViva,
    inThisCall: inCallHere,
    panelSize: callPanelSize,
    chromePx: chromeWidth,
    widthPx: viewportWidth,
  })
  const painelLateralVisivel = callDock.panelVisible
  const painelChamadaVisivel = painelLateralVisivel && !callPanelHidden
  const reabrirChamada = callViva && !inThisCall && !painelChamadaVisivel
  useEffect(() => {
    if (!painelLateralVisivel) setCallPanelHidden(false)
  }, [painelLateralVisivel])
  const onlineFps = new Set(onlinePeers.map(p => p.fp))
  const groupMemberFps = useMemo<Set<string>>(() => {
    const s = new Set<string>()
    for (const c of conversations) {
      if (c.kind !== 'group') continue
      const mem = groupRosters[c.id]
      if (mem) for (const [fp] of mem) if (fp) s.add(fp)
    }
    s.delete(identity?.fingerprint ?? '')
    return s
  }, [conversations, groupRosters, identity?.fingerprint])
  const shownFriends = friendsTab === 'online'
    ? friendsAccepted.filter(f => effectivePresence({ connected: onlineFps.has(f.fp), chosen: socialPresence[f.fp] }) !== 'offline')
    : friendsAccepted
  const [, forceCallsRefresh] = useState(0)
  useEffect(() => {
    let alive = true
    void detectNativeVoice()
      .catch(() => false)
      .then((ok) => {
        try { void services.webrtcReport(`detectNativeVoice=${ok} getCallsSupport=${getCallsSupport()}`) } catch {  }
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
      setSelCommunity(null)
      setSelPeerFp(p.fp.trim())
      setSelConv(conv.id)
      refreshConvos()
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  const lastSendByConvRef = useRef<{ conv: string; at: number }>({ conv: '', at: 0 })
  const messagesEndRef = useRef<HTMLDivElement | null>(null)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = messagesScrollRef.current
    if (!el) { messagesEndRef.current?.scrollIntoView({ block: 'end' }); return }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, selConv])

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

  useEffect(() => { setComposerMenu(false); setShowEmojiPicker(false); setActiveAutocomplete(null) }, [selConv])

  async function send() {
    const body = input.trim()
    if (!body || !selConv) return

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
      } catch {  }
      return
    }

    const now = Date.now()
    const convId = selConv
    if (lastSendByConvRef.current.conv === convId && now - lastSendByConvRef.current.at < 300) return
    lastSendByConvRef.current = { conv: convId, at: now }
    const isChannelConv = !!selCommunity && communities.some(c =>
      c.id === selCommunity && c.channels.some(([cid]) => cid === selConv),
    )
    const communityId = isChannelConv ? selCommunity : null
    const myFp = identity?.fingerprint ?? ''
    const ts = Date.now()
    const tempId = `pending-${ts}`
    const optimistic: StoredMessage = { id: tempId, conv_id: convId, author_fp: myFp, body, ts, sig: 'pending', direction: 'out', status: 'sending' }
    append(optimistic)
    setInput('')
    setError(null)
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 30)
    try {
      const m = communityId
        ? await services.sendChannelMessage(communityId, convId, body)
        : await services.messageSend(convId, body)
      replaceOptimistic(tempId, m)
      if (replyTo) {
        services.reply(convId, m.id, replyTo.id).catch(() => {})
        setReplyTo(null)
      }
      if (!communityId) refreshConvos()
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: 'end' }), 50)
    } catch (e: any) {
      failOptimistic(tempId)
      setError(String(e?.message ?? e))
    }
  }

  async function resendMessage(m: StoredMessage) {
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
  }

  function handleComposerKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
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

  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const msgListRef = useRef<MessageListHandle | null>(null)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [composerMenu, setComposerMenu] = useState(false)
  const [autocompleteIdx, setAutocompleteIdx] = useState(0)
  const [activeAutocomplete, setActiveAutocomplete] = useState<{ kind: 'mention' | 'emoji' | 'slash'; query: string; start: number; end: number } | null>(null)
  const [serverEmojiMap, setServerEmojiMap] = useState<Record<string, string>>({})

  const communityMembers = useMemo<{ fp: string; nickname: string }[]>(() => {
    if (!activeComm) return []
    const janela = windowMembers(activeComm.members ?? [], LIMITE_MEMBROS, ([fp]) => fp === identity?.fingerprint)
    return janela.visiveis.map(([fp, nick]) => ({ fp, nickname: nick || nameOfFp(fp) }))
  }, [activeComm, socialProfiles, peers, identity?.fingerprint])

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
  const appStartedAt = useRef(resolveSessionStart(bootAt.current, typeof sessionStorage !== 'undefined' ? sessionStorage : null))

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
    const now = Date.now()
    if (selConv && now - lastTypingSent.current > 2000 && v.trim()) {
      lastTypingSent.current = now
      services.sendTyping?.(selConv).catch(() => {})
    }
  }

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

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const f11 = e.key === 'F11'
      const altEnter = e.altKey && e.key === 'Enter'
      if (!f11 && !altEnter) return
      e.preventDefault()
      e.stopPropagation()
      services.windowToggleFullscreen()
        .then((telaCheia) => setNotice(telaCheia ? 'tela cheia (F11 para sair)' : 'tela cheia desativada'))
        .catch(() => {  })
    }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [])

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
      try { const mems = await services.groupMembers(selConv); fps = mems.map(([fp]) => fp).filter(fp => fp !== identity?.fingerprint) } catch {  }
    } else if (selPeerFp) fps = [selPeerFp]
    else if (conv?.peer_fp) fps = [conv.peer_fp]
    if (fps.length === 0) { setError('selecione um amigo ou crie um grupo'); return }
    if (!callsOk) { setError(getCallsUnavailableMessage()); return }
    if (callViva) { setError('já existe uma chamada em andamento'); return }
    setCallActionBusy(true)
    try { await callManager.start(kind, selConv, fps, { group: isGroup }) } catch (e: any) { setError(String(e?.message ?? e)) }
    finally { setCallActionBusy(false) }
  }
  async function handleIncomingAccept() {
    if (!incomingCall || callActionBusy) return
    if (!callsOk) { setError(getCallsUnavailableMessage()); return }
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
    await sendFileNow(f)
    e.target.value = ''
  }

  async function sendFileNow(f: File) {
    try {
      const sf = await fileSwarm.shareFile(f)
      setFileList([...fileSwarm.files.values()])
      if (selConv) {
        const body = encodeFileBody(sf)
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
  }

  const [friendSuccess, setFriendSuccess] = useState<string | null>(null)

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

  function openInviteModal() {
    if (!selCommunity) return
    setServerMenuOpen(false)
    setInviteTokenError(null)
    setShowInvite(true)
  }

  async function copyServerToken() {
    if (!selCommunity) return
    setServerMenuOpen(false)
    try {
      const tok = await services.makeInvite(selCommunity)
      const ok = await copyText(tok)
      if (ok) setNotice('Token copiado — envie por qualquer mensageiro')
      else {
        setShowInvite(true)
        setError('não foi possível copiar automaticamente — copie o token do painel')
      }
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  function closeServerModal() {
    setShowCreateServer(false)
    setServerFlow('choose')
    setInviteFromLink(null)
  }

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

  const [callRoomsMap, setCallRoomsMap] = useState<Map<string, CallRoomView>>(() => callRooms.snapshot())
  const callAvatars = useMemo<Record<string, string | undefined>>(() => {
    const out: Record<string, string | undefined> = {}
    for (const [fp, p] of Object.entries(socialProfiles as Record<string, any>)) {
      if (p?.avatar_b64) out[fp] = p.avatar_b64
    }
    return out
  }, [socialProfiles])
  const selRoom = selConv ? callRoomsMap.get(selConv) ?? null : null
  const [showRoomMembers, setShowRoomMembers] = useState(false)
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
    const un = services.subscribe((ev: any) => {
      if (ev?.type === 'call_room') callRooms.apply(ev)
    })
    return () => { try { un() } catch {  } }
  }, [])

    async function enterRoomFromList(convId: string, sala: CallRoomView, nome: (fp: string) => string) {
    if (callActionBusy) return
    if (!callsOk) { setError(getCallsUnavailableMessage()); return }
    if (callViva) { setError('já existe uma chamada em andamento'); return }
    setCallActionBusy(true)
    try {
      const conv = conversations.find((c) => c.id === convId)
      setSelConv(convId)
      if (conv?.peer_fp) setSelPeerFp(conv.peer_fp)
      await callManager.enterRoom(convId, sala.kind)
      sfxCallConnect()
      setNotice(`entrou na chamada de ${nome(sala.hostFp) || conv?.title || 'grupo'}`)
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setCallActionBusy(false)
    }
  }

  useEffect(() => {
    return services.subscribe((ev: any) => {
      if (ev.type === 'profile_changed') setSocialProfiles(p => ({ ...p, [ev.fp]: ev.profile }))
      else if (ev.type === 'presence_changed') setSocialPresence(p => ({ ...p, [ev.fp]: ev.status }))
      else if (ev.type === 'muted') setNotice(ev.reason)
      else if (ev.type === 'moderation_applied') setNotice(`Moderação: ${ev.kind} aplicado a ${String(ev.target_fp).slice(0, 8)}${ev.reason ? ` — ${ev.reason}` : ''}`)
    })
  }, [selCommunity])

  const serverNicks = useMemo<Record<string, string>>(() => {
    const next: Record<string, string> = {}
    for (const m of (activeComm?.members ?? []) as [string, string, string][]) {
      if (m[0] && m[1]) next[m[0]] = m[1]
    }
    return next
  }, [activeComm?.members])

  const nameOfFp = (fp: string): string => {
    if (fp === identity?.fingerprint) return identity?.nickname ?? 'você'
    const sn = serverNicks[fp]
    if (sn) return sn
    const c = communities.find(x => x.owner_fp === fp)
    if (c) return c.name
    const f = peers.find(p => p.fp === fp)
    const nick = f?.nickname || (socialProfiles[fp]?.display_name ?? '')
    return nick || String(fp).slice(0, 8)
  }

  const channelCallPeers = useMemo(() => {
    const eu = identity?.fingerprint ?? ''
    const vivos = new Set(onlinePeers.filter((p) => p.state === 'CONNECTED').map((p) => p.fp))
    const estadoMotor = new Map(
      voiceStates.filter(([fp]) => !!fp).map(([fp, muted, deafened]) => [fp, { muted, deafened }]),
    )
    const vistos = new Map<string, { fp: string; nome: string; muted?: boolean; deafened?: boolean; eu?: boolean }>()

    for (const p of (activeCall?.participants ?? []) as any[]) {
      const fp = String(p?.fp ?? '')
      if (!fp) continue
      if (fp !== eu && vivos.size > 0 && !vivos.has(fp)) continue
      const motor = estadoMotor.get(fp)
      vistos.set(fp, {
        fp,
        nome: nameOfFp(fp) || p?.nickname || fp.slice(0, 8),
        muted: p?.muted ?? motor?.muted,
        deafened: p?.deafened ?? motor?.deafened,
        eu: fp === eu,
      })
    }
    if (eu && !vistos.has(eu)) {
      const motor = estadoMotor.get(eu)
      vistos.set(eu, { fp: eu, nome: nameOfFp(eu) || 'você', muted: motor?.muted, deafened: motor?.deafened, eu: true })
    }
    return [...vistos.values()].sort((a, b) => (a.eu === b.eu ? a.nome.localeCompare(b.nome) : a.eu ? -1 : 1))
  }, [voiceStates, activeCall?.participants, identity?.fingerprint, onlinePeers])

  const canalVazio = inThisCall && channelCallPeers.filter((p) => !p.eu).length === 0

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
    mute: () => { try { callManager.toggleMute() } catch {  } },
    next: () => { const i = conversations.findIndex(c => c.id === selConv); const nx = conversations[(i + 1) % Math.max(1, conversations.length)]; if (nx) { setSelConv(nx.id); setSelPeerFp(nx.peer_fp || null) } },
    prev: () => { const i = conversations.findIndex(c => c.id === selConv); const pv = conversations[(i - 1 + conversations.length) % Math.max(1, conversations.length)]; if (pv) { setSelConv(pv.id); setSelPeerFp(pv.peer_fp || null) } },
  })

  useEffect(() => {
    if (selConv && messages.length > 0) {
      const last = messages[messages.length - 1]
      if (last.direction === 'in') services.readSet(selConv, last.ts).catch(() => {  })
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
      msgListRef.current?.reloadPolls()
    } catch (e: any) { setError(String(e?.message ?? e)) }
  }

  const updateGate = useUpdateGate(true)

  if (phase === 'loading') return (<><UpdateBootScreen api={updateGate} fallback={<BootScreen />} /><UpdateOverlay api={updateGate} /></>)
  if (phase === 'create') return <CreateAccount palette={authPalette} onDone={(id) => { setIdentity(id); setPhase('app'); refreshNet(); refreshFriends() }} />
  if (phase === 'lock') return <LockScreen palette={authPalette} nickname={identity?.nickname ?? ''} onUnlock={(id) => { setIdentity(id); setPhase('app'); refreshNet(); refreshFriends() }} />

  const railStyle: any = {
    width: 72, background: railBg, borderRight: `1px solid ${borderColor}`,
    display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0', gap: 8, flexShrink: 0,
  }

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
    const hasPeers = count > 0
    const online = hasPeers && state === 'CONNECTED'
    const color = online ? t.green : state === 'DISCONNECTED' ? '#80848e' : t.yellow
    const label = online ? 'ONLINE' : stateLabel[state as NetworkState]
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
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: bg, color: text, fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", ['--sidebar' as any]: sidebarBg } as any}>
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <div style={railStyle} className="hide-mobile">
          {}
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
                            <button
                              className="dd-item"
                              title="Abre a tela de bots em janela própria (só no desktop)"
                              onClick={() => {
                                setServerMenuOpen(false)
                                if (services.openBotsWindow) {
                                  services.openBotsWindow().catch(() => {
                                    window.location.assign('/bots')
                                  })
                                } else {
                                  window.location.assign('/bots')
                                }
                              }}
                            >
                              <span style={{ display: 'flex' }}><Icon d={Icons.externalLink} size={14} /></span> Bots em janela
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
                                    if (isCallableChannel(ch.kind)) {
                                      if (callActionBusy) return
                                      if (getCallsSupport() === 'none') { setError(getCallsUnavailableMessage()); return }
                                      setCallActionBusy(true)
                                      const estouNesteCanal = canalDaChamada?.channelId === ch.id
                                      if (estouNesteCanal) {
                                        try {
                                          await callManager.leaveVoice(canalDaChamada.communityId, ch.id)
                                        } catch (e: any) { setError(String(e?.message ?? e)) }
                                        setVoiceChannel(null); setVoiceStates([])
                                      } else {
                                        setSelConv(ch.id)
                                        try {
                                          await callManager.joinVoice(selCommunity!, ch.id)
                                        } catch (e: any) { setError(String(e?.message ?? e)); setVoiceChannel(null); setCallActionBusy(false); return }
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
                                    <Icon d={ch.kind === 'voice' ? Icons.speaker : ch.kind === 'video' ? Icons.video : Icons.hash} size={16} />
                                  </span>
                                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, textAlign: 'left' }}>{ch.name}</span>
                                  {ch.topic && <span style={{ fontSize: 10, color: muted, maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ch.topic}</span>}
                                </button>
                                {isOwner && (
                                  <button
                                    className="chan-gear"
                                    onClick={e => { e.stopPropagation(); setChannelMenu({ x: e.clientX, y: e.clientY, id: ch.id }) }}
                                    title="Gerenciar canal"
                                  ><Icon d={Icons.settings} size={11} /></button>
                                )}
                                {
}
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
                <Section variant="desktop" title="" maxVisible={12} collapsible={false}>
                  {conversations.map(c => {
                    const sala = callRoomsMap.get(c.id) ?? null
                    return (
                    <div key={c.id} className={'nav-row' + (c.id === selConv ? ' active' : '')} onClick={() => { setSelConv(c.id); setSelPeerFp(c.peer_fp) }} style={{ cursor: 'pointer' }}>
                      {}
                      <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0, borderRadius: '50%', boxShadow: sala ? `0 0 0 2px ${t.green}, 0 0 8px ${t.green}66` : undefined }}>
                        <Avatar name={c.title} fp={c.peer_fp} size={28} avatarB64={socialProfiles[c.peer_fp]?.avatar_b64} />
                      </span>
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{c.title}</span>
                      {sala && (
                        <button
                          type="button"
                          title={roomSummary(sala, nameOfFp) ?? 'Entrar na chamada'}
                          aria-label={`Entrar na chamada de ${c.title}`}
                          aria-busy={callActionBusy || undefined}
                          disabled={callActionBusy}
                          onClick={(e) => { e.stopPropagation(); if (!callActionBusy) void enterRoomFromList(c.id, sala, nameOfFp) }}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: t.green, color: '#fff', border: 'none', borderRadius: 99, padding: '3px 8px', fontSize: 10, fontWeight: 800, cursor: callActionBusy ? 'wait' : 'pointer', flexShrink: 0, minHeight: 24, whiteSpace: 'nowrap', opacity: callActionBusy ? 0.7 : 1 }}
                        >
                          <Icon d={Icons.phone} size={11} /> {callActionBusy ? 'entrando…' : `Entrar ${sala.participants.length || ''}`}
                        </button>
                      )}
                      <button title={c.kind === 'group' ? 'Sair ou apagar o grupo' : 'Apagar conversa'} onClick={async (e) => { e.stopPropagation(); if (c.kind === 'group') { let owner = false; try { const mems = await services.groupMembers(c.id); owner = mems.length > 0 && mems[0][0] === identity?.fingerprint } catch {  } setLeaveTarget({ id: c.id, title: c.title, owner }); return } if (!confirm(`Apagar conversa com ${c.title}?`)) return; try { await services.conversationDelete(c.id); if (selConv === c.id) setSelConv(null); refreshConvos() } catch (err: any) { setError(String(err?.message ?? err)) } }} style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Icon d={c.kind === 'group' ? Icons.minus : Icons.trash} size={14} /></button>
                    </div>
                    )
                  })}
                </Section>

                {(() => {
                  const amigos = new Set(friendsAccepted.map(f => f.fp))
                  const vinculados = onlinePeers.filter(p => p.fp !== identity?.fingerprint)
                  if (vinculados.length === 0) return null
                  return (
                    <>
                      <Section variant="desktop" title={`ONLINE — ${vinculados.length}`} maxVisible={8}>
                        {vinculados.map(p => {
                          const ehAmigo = amigos.has(p.fp)
                          const mesmoGrupo = groupMemberFps.has(p.fp)
                          const mesmoServidor = (activeComm?.members ?? []).some(([fp]) => fp === p.fp)
                          const podeConversar = ehAmigo || mesmoGrupo || mesmoServidor
                          const badge = contactBadge({
                            relation: ehAmigo ? 'friend' : 'none',
                            sharedGroup: mesmoGrupo,
                            sharedCommunity: mesmoServidor,
                          })
                          return (
                            <button key={p.fp} onClick={() => { if (podeConversar) void openDm({ fp: p.fp, nickname: p.nickname }) }} className={'nav-row' + (p.fp === selPeerFp && !selConv ? ' active' : '')} title={podeConversar ? 'Abrir conversa' : 'Sem canal de contato — peça o fingerprint para adicionar'}>
                              <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                                <Avatar name={p.nickname || p.fp} fp={p.fp} size={28} avatarB64={socialProfiles[p.fp]?.avatar_b64} />
                                <PeerDot s={effectivePresence({ connected: p.state === 'CONNECTED', chosen: socialPresence[p.fp] }) === 'offline' ? 'DISCONNECTED' : 'CONNECTED'} />
                              </span>
                              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{p.nickname || p.fp}</span>
                              {!ehAmigo && <span style={{ fontSize: 10, color: muted, flexShrink: 0 }}>{badge}</span>}
                            </button>
                          )
                        })}
                      </Section>
                    </>
                  )
                })()}

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
          {
}
          {canalDaChamada && (
            <div style={{ background: '#232428', borderTop: `1px solid ${borderColor}`, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: t.green, boxShadow: `0 0 6px ${t.green}` }}/>
                <span style={{ fontSize: 11, fontWeight: 800, color: t.green, flex: 1 }}>Voz conectada</span>
                <span style={{ fontSize: 10, color: muted }}>/ {activeComm?.channels.find(([id])=>id===canalDaChamada.channelId)?.[1] ?? canalDaChamada.channelId.slice(0,8)}</span>
              </div>
              <div style={{ fontSize: 10, color: muted }}>{channelCallPeers.length} na voz • {channelCallPeers.filter(p=>!p.muted).length} com mic aberto • todos semeiam</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={() => { const nm=!isMuted; setIsMuted(nm); callManager.toggleMute(); services.voiceState(canalDaChamada.communityId, canalDaChamada.channelId, nm, isDeafened).catch(()=>{}) }} aria-label={isMuted ? 'Ativar microfone' : 'Silenciar'} style={{ flex: 1, background: isMuted ? t.red : inputBg, color: isMuted ? '#fff' : text, border: 'none', padding: '6px 0', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isMuted ? <Icon d={Icons.micOff} size={13} /> : <Icon d={Icons.mic} size={13} />}</button>
                <button onClick={() => { const nd=!isDeafened; setIsDeafened(nd); if(nd) setIsMuted(true); callManager.toggleDeafen(); services.voiceState(canalDaChamada.communityId, canalDaChamada.channelId, isMuted || nd, nd).catch(()=>{}) }} aria-label={isDeafened ? 'Ativar áudio' : 'Ensurdecer'} style={{ flex: 1, background: isDeafened ? t.red : inputBg, color: isDeafened ? '#fff' : text, border: 'none', padding: '6px 0', borderRadius: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isDeafened ? <Icon d={Icons.volumeX} size={13} /> : <Icon d={Icons.headphones} size={13} />}</button>
                <button onClick={async () => { try { await callManager.leaveVoice(canalDaChamada.communityId, canalDaChamada.channelId) } catch (e: any) { setError(String(e?.message ?? e)) } setVoiceChannel(null); setVoiceStates([]) }} style={{ background: t.red, color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 800 }}>Sair</button>
              </div>
              {channelCallPeers.length>0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{channelCallPeers.map((p) => <span key={p.fp} title={p.nome} style={{ fontSize: 10, background: inputBg, border: `1px solid ${borderColor}`, padding: '2px 6px', borderRadius: 99, color: p.muted? t.red : p.deafened? t.yellow : t.green }}>{p.eu ? 'você' : p.nome} {p.muted ? <Icon d={Icons.micOff} size={10} /> : p.deafened ? <Icon d={Icons.volumeX} size={10} /> : <Icon d={Icons.mic} size={10} />}</span>)}</div>}
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
            {}
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
                onClick={() => setShowQuitMenu(true)}
                title="Fechar o DisTorrent"
                aria-label="Fechar o DisTorrent"
                data-testid="app-quit"
                style={{ width: 34, height: 34, border: `1px solid ${borderColor}`, background: inputBg, cursor: 'pointer', color: t.red, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
              </button>
            </div>
          </div>
        </div>

        {
}
        <div ref={mainColRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden', background: bg, minWidth: 0, marginRight: painelChamadaVisivel ? callDock.mainInsetPx : 0, transition: 'margin-right 180ms ease' }}>
          {view === 'servidores' && selCommunity ? (
            <div style={{ height: 48, borderBottom: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10, flexShrink: 0, boxShadow: '0 1px 0 rgba(0,0,0,.2)' }}>
              <span style={{ color: muted, display: 'flex' }}>
                <Icon d={selCallChannel ? (selCallChannel.kind === 'video' ? Icons.video : Icons.speaker) : Icons.hash} size={20} />
              </span>
              <span style={{ fontWeight: 700, color: t.heading }}>{channelLabel}</span>
              <div style={{ width: 1, height: 20, background: borderColor, margin: '0 8px' }} />
              <span style={{ fontSize: 12, color: muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {extraChannels.find(c => c.id === selConv)?.topic
                  || (selCallChannel
                    ? (selCallChannel.kind === 'video' ? 'Canal de vídeo — a câmera é opcional' : 'Canal de voz')
                    : 'Bem-vindo ao canal')}
              </span>
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
                {}
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
            <div className="hide-scrollbar" style={{ minHeight: 48, height: 48, borderBottom: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10, flexShrink: 0, boxShadow: '0 1px 0 rgba(0,0,0,.2)', minWidth: 0, overflowX: 'auto', overflowY: 'hidden' }}>
              <span style={{ color: muted, fontWeight: 800, fontSize: 18, flexShrink: 0 }}>{conversations.find(c=>c.id===selConv)?.kind==='group' ? <Icon d={Icons.users} size={18}/> : '@'}</span>
              {}
              {ehGrupo ? (
                <button
                  onClick={() => setShowGroupPanel(true)}
                  title="Ver membros, renomear ou remover alguem"
                  aria-label={`${peerTitle} - ${groupMemberCount} membros. Abrir painel do grupo`}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', minWidth: 0, overflow: 'hidden', flex: 1, color: 'inherit', textAlign: 'left' }}
                >
                  <span style={{ fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{peerTitle}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: muted, whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {groupMemberCount} {groupMemberCount === 1 ? 'membro' : 'membros'}
                  </span>
                </button>
              ) : (
                <span style={{ fontWeight: 700, color: t.heading, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{peerTitle}</span>
              )}
              {}
              {selRoom && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0, minWidth: 0 }}>
                  <button
                    type="button"
                    onClick={() => setShowRoomMembers(true)}
                    title={roomSummary(selRoom, nameOfFp) ?? 'Quem está na chamada'}
                    aria-label="Ver quem está na chamada"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: `${t.green}22`, color: t.green, border: `1px solid ${t.green}66`, borderRadius: 99, padding: '3px 9px', fontSize: 11, fontWeight: 800, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: t.green, boxShadow: `0 0 6px ${t.green}`, flexShrink: 0 }} />
                    {selRoom.participants.length || 1}{viewportWidth >= 1080 ? ' na chamada' : ''}
                  </button>
                  {!callViva && (
                    <button
                      type="button"
                      onClick={() => void enterRoomFromList(selConv ?? selRoom.convId, selRoom, nameOfFp)}
                      disabled={callActionBusy || !callsOk}
                      title={callsOk ? 'Entrar na chamada que já está acontecendo' : callsUnavailableDetail}
                      aria-label="Entrar na chamada"
                      aria-busy={callActionBusy || undefined}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: t.green, color: '#fff', border: 'none', borderRadius: 99, padding: '4px 10px', fontSize: 11, fontWeight: 800, cursor: callActionBusy || !callsOk ? 'not-allowed' : 'pointer', opacity: callsOk ? 1 : 0.6, whiteSpace: 'nowrap' }}
                    >
                      <Icon d={Icons.phone} size={12} /> {callActionBusy ? 'entrando…' : 'Entrar'}
                    </button>
                  )}
                </span>
              )}
              {}
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, marginLeft: 'auto' }}>
                <button onClick={() => setShowDownloads(true)} title="Downloads" aria-label="Downloads" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', position: 'relative' }}>
                  <Icon d={Icons.download} size={18} />
                  {dlCount > 0 && <span style={{ position: 'absolute', top: 0, right: 0, background: t.accent, color: '#fff', fontSize: 9, fontWeight: 800, borderRadius: 99, minWidth: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{dlCount}</span>}
                </button>
                <button onClick={() => startCall('voice')} title={callsOk ? 'Iniciar chamada de voz' : `Iniciar chamada de voz — ${callsUnavailableDetail}`} aria-label="Iniciar chamada de voz" style={{ background: 'transparent', border: 'none', color: callsOk ? muted : t.red, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', opacity: callsOk ? 1 : 0.75 }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 1 1 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a1 1 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg></button>
                <button onClick={() => startCall('video')} title={callsOk ? 'Iniciar chamada de vídeo' : `Iniciar chamada de vídeo — ${callsUnavailableDetail}`} aria-label="Iniciar chamada de vídeo" style={{ background: 'transparent', border: 'none', color: callsOk ? muted : t.red, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex', opacity: callsOk ? 1 : 0.75 }}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><polygon points="23 7 13 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg></button>
                <button onClick={() => setShowAddToCall(true)} title="Adicionar amigos à chamada" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex' }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg></button>
                <button onClick={() => setShowCreateGroup(true)} title="Criar grupo (igual Discord)" style={{ background: inputBg, border: `1px solid ${borderColor}`, color: t.accent, cursor: 'pointer', padding: '4px 8px', borderRadius: 6, fontSize: 11, fontWeight: 800 }}>+ Grupo</button>
                <span style={{ width: 1, height: 20, background: borderColor, margin: '0 4px' }}/>
                {}
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
                {reabrirChamada && (
                  <button
                    type="button"
                    data-testid="call-panel-reopen"
                    onClick={() => { setCallPanelHidden(false); setCallPanelSize((s) => (s === 'compact' ? 'normal' : s)) }}
                    title="Voltar para a chamada em andamento"
                    aria-label="Voltar para a chamada em andamento"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0,
                      background: t.green, color: '#fff', border: 'none', borderRadius: 99,
                      padding: '4px 10px', fontSize: 11, fontWeight: 800, cursor: 'pointer',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff' }} />
                    chamada
                  </button>
                )}
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
                {}
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
              {
}
              {/chamada em andamento/i.test(error) && (
                <button
                  type="button"
                  data-testid="force-reset-call"
                  onClick={async () => {
                    try { await callManager.forceReset() } catch {  }
                    setError(null)
                    setNotice('estado da chamada limpo — tente de novo')
                  }}
                  style={{ marginLeft: 8, background: t.red, color: '#fff', border: 'none', padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 800, whiteSpace: 'nowrap' }}
                >
                  Destravar chamada
                </button>
              )}
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
                    <input value={friendFpInput} onChange={e => setFriendFpInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && addFriend()} placeholder="Fingerprint (12) ou chave pública (64)" style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: text, fontSize: 15, fontFamily: 'JetBrains Mono' }} />
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
                ) : (
                  <>
                    {friendRequests.map(r => (
                      <div key={`in-${r.fp}`} className="friend-row">
                        <Avatar name={r.nickname || r.fp} fp={r.fp} size={32} avatarB64={socialProfiles[r.fp]?.avatar_b64} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nickname || r.fp}</div>
                          <div style={{ fontSize: 11, color: muted }}>Solicitação de amizade recebida</div>
                        </div>
                        <button onClick={() => respondFriend(r.fp, true)} title="Aceitar" className="row-icon ok"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12l5 5L20 7"/></svg></button>
                        <button onClick={() => respondFriend(r.fp, false)} title="Recusar" className="row-icon no"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M6 6l12 12 M18 6L6 18"/></svg></button>
                      </div>
                    ))}
                    {pendingOut.map(r => (
                      <div key={`out-${r.fp}`} className="friend-row">
                        <Avatar name={r.nickname || r.fp} fp={r.fp} size={32} avatarB64={socialProfiles[r.fp]?.avatar_b64} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: t.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.nickname || r.fp}</div>
                          <div style={{ fontSize: 11, color: muted }}>Enviada — aguardando aceitação</div>
                        </div>
                        <button onClick={async () => { try { await services.friendRemove(r.fp); refreshFriends(); setFriendSuccess('Solicitação cancelada') } catch (e: any) { setError(String(e?.message ?? e)) } }} title="Cancelar solicitação" className="row-icon no" style={{ fontSize: 11, fontWeight: 800, width: 'auto', padding: '0 8px' }}>Cancelar</button>
                      </div>
                    ))}
                  </>
                )
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

          {
}
          {selConv && selCallChannel && (
            <VoiceStage
              layout={voiceLayout}
              palette={{
                stage: '#1f1f1f', panel: '#2a2a2a', input: '#333333', border: '#3c3c3c',
                heading: t.heading, text, muted, green: t.green, red: t.red,
                yellow: t.yellow, accent: t.accent,
              }}
              title={callScreenTitle({
                channelName: selCallChannel.name,
                conversationTitle: conversations.find((c) => c.id === activeCall?.convId)?.title,
                peerName: peerTitle,
              })}
              subtitle={
                selCallChannel.kind === 'video'
                  ? 'Canal de vídeo — a câmera é opcional'
                  : (selCallChannel.topic || 'Canal de voz')
              }
              kind={selCallChannel.kind === 'video' ? 'video' : 'voice'}
              inCall={inThisCall}
              phase={(activeCall?.phase ?? 'idle') as any}
              startAt={activeCall?.startAt ?? Date.now()}
              nowMs={nowMs}
              mediaLive={mediaLive}
              ringing={!!activeCall?.ringing}
              route={callManager.getRungSummary()}
              media={
                <CallTilesGrid
                  tiles={visibleCallTiles}
                  fill
                  pinnedId={pinnedTileId}
                  onPin={(id) => setPinnedTileId((cur) => (cur === id ? null : id))}
                  onExpand={(id) => setExpandedTileId((cur) => (cur === id ? null : id))}
                  deafened={!!activeCall?.deafened}
                  showAudioControls
                  minHeight={180}
                  palette={{ heading: t.heading, muted, green: t.green, red: t.red, accent: t.accent, border: borderColor }}
                  avatarColor={avatarColor}
                  avatarB64={callAvatars}
                  onOpenProfile={(fp) => setProfileFp(fp)}
                />
              }
              peers={channelCallPeers}
              waitingAlone={canalVazio}
              unavailable={!callsOk ? callsUnavailableDetail : null}
              busy={callViva && !inThisCall}
              notice={notice}
              muted={isMuted}
              deafened={isDeafened}
              cameraOn={!!activeCall?.cameraOn}
              sharing={!!activeCall?.sharing}
              cameraDisabled={!!activeCall?.sharing && !activeCall?.cameraOn}
              onJoin={() => {
                if (!selCommunity || !selCallChannel) return
                if (callActionBusy) return
                setCallActionBusy(true)
                void callManager.joinVoice(selCommunity, selCallChannel.id)
                  .catch((e: any) => setError(String(e?.message ?? e)))
                  .finally(() => setCallActionBusy(false))
              }}
              onLeave={() => {
                if (canalDaChamada) {
                  void callManager.leaveVoice(canalDaChamada.communityId, canalDaChamada.channelId)
                    .catch((e: any) => setError(String(e?.message ?? e)))
                } else {
                  void callManager.leave().catch((e: any) => setError(String(e?.message ?? e)))
                }
              }}
              onToggleMute={() => { setIsMuted((m) => !m); callManager.toggleMute() }}
              onToggleDeafen={() => {
                const nd = !isDeafened
                setIsDeafened(nd)
                if (nd) setIsMuted(true)
                callManager.toggleDeafen()
              }}
              onToggleCamera={() => { void callManager.toggleCamera().catch((e: any) => setError(String(e?.message ?? e))) }}
              onToggleScreen={() => {
                if (activeCall?.sharing) { void callManager.stopScreenShare().catch((e: any) => setError(String(e?.message ?? e))); return }
                if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return }
                setShowScreenPicker(true)
              }}
              screenAvailable={supportsScreenShare() || !!activeCall?.sharing}
              screenUnavailableReason={screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG}
              onSwitchCamera={mostrarTrocaCamera ? () => { void trocarCamera() } : undefined}
              cameraSwitchLabel={cameraSwitchLabel}
              onOpenSettings={() => setShowCallSettings((v) => !v)}
              settings={showCallSettings ? (
                <CallSettingsPanel
                  prefs={callMediaPrefsState}
                  onApply={async (patch) => {
                    const aplicado = await callManager.applyMediaPrefs(patch)
                    setCallMediaPrefsState(aplicado)
                    return aplicado
                  }}
                  onClose={() => setShowCallSettings(false)}
                  onError={(m) => setError(m)}
                  cameraOn={!!activeCall?.cameraOn}
                  sharing={!!activeCall?.sharing}
                  muted={!!activeCall?.muted}
                  onToggleCamera={() => callManager.toggleCamera().catch((e: any) => setError(String(e?.message ?? e)))}
                  onToggleScreen={() => {
                    if (activeCall?.sharing) return callManager.stopScreenShare().catch((e: any) => setError(String(e?.message ?? e)))
                    setShowScreenPicker(true)
                  }}
                  screenQuality={callManager.getScreenShareOptions().quality}
                  screenFps={callManager.getScreenShareOptions().fps}
                  onScreenQualityChange={(q) => { void callManager.setScreenShareOptions({ quality: q as any }).catch((e: any) => setError(String(e?.message ?? e))); setScreenOptsTick((v) => v + 1) }}
                  onScreenFpsChange={(f) => { void callManager.setScreenShareOptions({ fps: f as any }).catch((e: any) => setError(String(e?.message ?? e))); setScreenOptsTick((v) => v + 1) }}
                />
              ) : null}
              extra={(
                <>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      onClick={() => setShowCallDiag((v) => !v)}
                      title="Diagnóstico da chamada em tempo real (ICE, RTT, FPS, causa da falha)"
                      aria-label="Diagnóstico da chamada"
                      style={{ background: showCallDiag ? t.accent : inputBg, border: `1px solid ${borderColor}`, color: showCallDiag ? '#fff' : text, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11.5, fontWeight: 700 }}
                    >Diagnóstico</button>
                    <button
                      type="button"
                      onClick={() => setShowAddToCall(true)}
                      style={{ background: inputBg, border: `1px solid ${borderColor}`, color: text, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11.5, fontWeight: 700 }}
                    >+ Amigo</button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      style={{ background: inputBg, border: `1px solid ${borderColor}`, color: text, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 5 }}
                    ><Icon d={Icons.attach} size={12} /> Arquivo</button>
                  </div>
                  {((activeCall?.qualityNotice as string | undefined) || qualityError) && (
                    <div role="status" style={{ fontSize: 11, color: qualityError ? '#ff9c9c' : t.yellow, lineHeight: 1.5 }}>
                      {qualityError ?? (activeCall?.qualityNotice as string)}
                    </div>
                  )}
                  {showCallDiag && <CallDiagnostics compact />}
                </>
              )}
            />
          )}

          {selConv && !selCallChannel && (
              <>
              {}
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
                peerOnline={!ehGrupo && !!selPeerFp && onlineFps.has(selPeerFp)}
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
                  const sf = fileSwarm.files.get(fmeta.file_id) ?? null
                  const announced = !!sf
                  const complete = !!sf && sf.chunks > 0 && sf.have.size >= sf.chunks
                  const queued = dlByFile[fmeta.file_id]
                  const progress = queued ?? (announced
                    ? {
                        pct: complete ? 100 : sf && sf.chunks > 0 ? Math.round((100 * sf.have.size) / sf.chunks) : 0,
                        speed: 0,
                        status: complete ? 'completed' : 'idle',
                      }
                    : { pct: 0, speed: 0, status: 'idle' })
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

          {selConv && !selCallChannel && showSearch && (
            <SearchPanel
              convId={selConv}
              convLabel={view === 'servidores' ? '#' + channelLabel : (peerTitle || 'conversa')}
              profiles={socialProfiles}
              onClose={() => setShowSearch(false)}
              onJump={(hit) => { setShowSearch(false); void jumpToMessage(hit.conv_id || selConv, hit.id) }}
            />
          )}
          {selConv && !selCallChannel && showPins && (
            <PinsPanel
              convId={selConv}
              messages={messages}
              onClose={() => setShowPins(false)}
              onJump={(m) => { setShowPins(false); void jumpToMessage(m.conv_id || selConv, m.id) }}
            />
          )}
          {selConv && !selCallChannel && showBookmarks && (
            <BookmarksPanel
              convId={selConv}
              messages={messages}
              onClose={() => setShowBookmarks(false)}
              onJump={(id) => { setShowBookmarks(false); void jumpToMessage(selConv, id) }}
            />
          )}
          {!selCallChannel && showInbox && (
            <InboxPanel
              tab={inboxTab}
              onTab={setInboxTab}
              profiles={socialProfiles}
              onClose={() => setShowInbox(false)}
              onJump={(cid, mid) => { setShowInbox(false); void jumpToMessage(cid, mid) }}
            />
          )}
          {selConv && !selCallChannel && (
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
              {}
              {intro?.hint && (
                <div
                  role="status"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
                    fontSize: 11, fontWeight: 700,
                    color: intro.blocked ? t.red : muted,
                    background: intro.blocked ? `${t.red}18` : inputBg,
                    border: `1px solid ${intro.blocked ? `${t.red}55` : borderColor}`,
                    borderRadius: 6, padding: '5px 8px',
                  }}
                >
                  <Icon d={Icons.lock} size={12} />
                  <span style={{ flex: 1 }}>{intro.hint}</span>
                  {selPeerFp && intro.blocked && (
                    <button
                      onClick={() => { setFriendsTab('adicionar'); setFriendFpInput(selPeerFp) }}
                      style={{ background: t.accent, color: '#fff', border: 'none', borderRadius: 5, padding: '3px 8px', fontSize: 10, fontWeight: 800, cursor: 'pointer' }}
                    >
                      Pedir amizade
                    </button>
                  )}
                </div>
              )}
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
                  onPaste={handleComposerPaste}
                  rows={1}
                  placeholder={view === 'servidores' ? `Conversar em #${channelLabel}` : `Conversar com ${peerTitle || 'amigo'}`}
                  aria-label="Mensagem"
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: text, fontSize: 14, fontFamily: 'inherit', resize: 'none', maxHeight: 220, lineHeight: 1.375, padding: '4px 0' }}
                />
                {}
                {activeCall && <button onClick={async () => { try { if (!supportsScreenShare() && !activeCall.sharing) { setError(SCREEN_UNAVAILABLE_MSG); return } await callManager.toggleScreen(); setError(null) } catch (e: any) { setError(String(e?.message ?? e)) } }} disabled={!supportsScreenShare() && !activeCall.sharing} title={supportsScreenShare() ? 'Compartilhar sua tela com quem está na chamada (o vídeo da tela substitui o da câmera)' : 'Seu navegador não permite compartilhar tela — use a câmera'} aria-label="Compartilhar tela" style={{ background: activeCall.sharing ? t.green : 'transparent', border: `1px solid ${borderColor}`, color: activeCall.sharing ? '#fff' : (supportsScreenShare() ? muted : t.muted), opacity: supportsScreenShare() || activeCall.sharing ? 1 : 0.5, cursor: supportsScreenShare() || activeCall.sharing ? 'pointer' : 'not-allowed', padding: '5px 8px', borderRadius: 6, fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, alignSelf: 'center' }}><Icon d={Icons.screen} size={12} /> Tela</button>}
                <button onClick={() => { setShowEmojiPicker(true); setComposerMenu(v => !v) }} className="composer-icon" title="Emoji (Ctrl+E)" aria-label="Emoji" aria-expanded={composerMenu} style={{ alignSelf: 'center' }}><Icon d={Icons.smile} size={18} /></button>
                <button onClick={send} disabled={!input.trim() || !!intro?.blocked} title={intro?.blocked ? 'Limite de mensagens iniciais — peça amizade' : input.trim() ? 'Enviar (Enter)' : 'Digite uma mensagem'} aria-label="Enviar" style={{ opacity: !input.trim() || intro?.blocked ? 0.45 : 1, cursor: !input.trim() || intro?.blocked ? 'not-allowed' : 'pointer', background: input.trim() && !intro?.blocked ? t.accent : 'transparent', color: input.trim() && !intro?.blocked ? '#fff' : muted, borderRadius: 8, padding: '6px 10px', flexShrink: 0, alignSelf: 'flex-end' }}><Icon d={Icons.send} size={16} /></button>
              </div>
              {}
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
                <span>
                  {selPeer && effectivePresence({ connected: selPeer.state === 'CONNECTED', chosen: socialPresence[selPeer.fp] }) === 'offline'
                    ? 'offline — mensagens ficarão pendentes e entregarão ao voltar'
                    : socialPresence[selPeerFp ?? ''] === 'invisible'
                      ? 'contato invisível — pode receber mensagens mesmo sem aparecer online'
                      : '↵ Enter para enviar • Shift+Enter quebra linha'}
                </span>
                <span style={{ opacity: 0.7, display: 'none' } as any}></span>
              </div>
              <div style={{ fontSize: 10, color: muted, marginTop: 2, textAlign: 'center', opacity: 0.7 }}>Arquivos 256KB • todos semeiam • status: pending → sent → delivered</div>
            </div>
          )}
        </div>
        {
}
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
              const doCargo = windowMembers(
                activeComm?.members ?? [],
                LIMITE_MEMBROS,
                ([fp]) => fp === identity?.fingerprint,
              ).visiveis.filter(([fp]) => (memberRolesCache[fp] ?? []).includes(role.id))
              if (doCargo.length === 0) return null
              return (
                <div key={role.id} style={{ padding: '6px 8px' }}>
                  <div className="member-group-head" style={{ color: role.color }}>{role.name} — {doCargo.length}</div>
                  {doCargo.map(([fp, nick]) => (
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
              const janelaOnline = windowMembers(onlineMembers, LIMITE_MEMBROS)
              const janelaOffline = windowMembers(offlineMembers, LIMITE_MEMBROS)
              return (
                <div style={{ padding: '6px 8px' }}>
                  <Section variant="desktop" title={`ONLINE — ${onlineMembers.length}`} maxVisible={15}>
                    {janelaOnline.visiveis.map(memberRow)}
                  </Section>
                  {janelaOnline.restantes > 0 && (
                    <div style={{ fontSize: 10.5, color: muted, padding: '2px 8px 6px' }}>
                      +{janelaOnline.restantes.toLocaleString('pt-BR')} online não listados
                    </div>
                  )}
                  {offlineMembers.length > 0 && (
                    <Section variant="desktop" title={`OFFLINE — ${offlineMembers.length}`} maxVisible={15} defaultOpen={false}>
                      {janelaOffline.visiveis.map(memberRow)}
                    </Section>
                  )}
                  {janelaOffline.restantes > 0 && (
                    <div style={{ fontSize: 10.5, color: muted, padding: '2px 8px 6px' }}>
                      +{janelaOffline.restantes.toLocaleString('pt-BR')} offline não listados
                    </div>
                  )}
                  {bots.length === 0 && roles.filter(r => r.hoist).length === 0 && onlinePeers.length === 0 && (
                    <div style={{ fontSize: 11, color: muted, padding: '6px 8px', opacity: 0.7 }}>Nenhum membro extra — convide amigos com o token do servidor.</div>
                  )}
                </div>
              )
            })()}
          </div>
        )}
      </div>

      {}
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
        openJoin={serverFlow === 'join'}
        onError={(msg) => setError(msg)}
      />

      {}
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

      {}
      <CreateServerWizard
        open={showCreateServer && serverFlow === 'create'}
        onClose={closeServerModal}
        onJoinInstead={() => setServerFlow('join')}
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
        onDoneToast={(msg) => { try { setNotice(msg); window.setTimeout(() => setNotice(null), 6000) } catch {  } }}
      />

      {}

      {}
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

      {}
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
          isPublic={activeComm.is_public === true}
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
          onSetPublic={async (isPublic) => {
            await services.communitySetPublic(selCommunity, isPublic)
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
          onImportBotFolder={
            services.botFolderRead
              ? async (dir) => {
                  const info = await services.botFolderRead!(dir)
                  const id = await services.botCreate(selCommunity, {
                    name: info.name,
                    avatar: info.avatar,
                  })
                  await services.botUpdate(selCommunity, id, { config: info.config })
                  refreshExtras(selCommunity)
                  return info.name
                }
              : undefined
          }
          onConfigBot={setConfigBotId}
          configBotId={configBotId}
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

      {}
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

      {
}
      {painelLateralVisivel && (
        <div data-testid="call-panel" style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: callDock.sideBySide ? callDock.mainInsetPx || callPanelWidth(callPanelSize, viewportWidth) : Math.min(callPanelWidth(callPanelSize, viewportWidth), Math.max(360, viewportWidth - 96)), background: '#0f0f0f', zIndex: 88, display: painelChamadaVisivel ? 'flex' : 'none', flexDirection: 'column', borderLeft: `1px solid ${borderColor}`, boxShadow: '-8px 0 28px rgba(0,0,0,.2)', transition: 'width 180ms ease' }}>
          <div style={{ minHeight: 56, height: 'auto', background: '#232428', borderBottom: `1px solid ${borderColor}`, display: 'flex', flexWrap: 'wrap', alignItems: 'center', padding: '8px 12px', gap: 8 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0, flex: '1 1 220px' }}>
              <span style={{ width: 30, height: 30, borderRadius: 8, background: `${t.accent}22`, color: t.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{activeCall.kind === 'video' ? <Icon d={Icons.video} size={16} /> : <Icon d={Icons.phone} size={16} />}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: 'block', fontWeight: 800, color: t.heading, fontSize: 14, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{conversations.find(c=>c.id===activeCall.convId)?.title ?? peerTitle ?? 'Chamada'}</span>
                {}
                <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
                  <CallPhaseBadge phase={activeCall.phase} startAt={activeCall.startAt} nowMs={nowMs} mediaLive={mediaLive} ringing={activeCall.ringing} />
                {}
                  <span style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', fontWeight: 600 }}>{fmtDuration(callDuration)}</span>
                </span>
              </span>
              <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }} aria-label="Tamanho do painel da chamada">
                <button type="button" data-testid="call-panel-smaller" aria-label="Diminuir painel da chamada" title={callPanelSize === 'compact' ? 'Painel já está compacto' : 'Diminuir painel'} disabled={callPanelSize === 'compact'} onClick={() => setCallPanelSize(callPanelSize === 'expanded' ? 'normal' : 'compact')} style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${borderColor}`, background: inputBg, color: callPanelSize === 'compact' ? muted : text, opacity: callPanelSize === 'compact' ? 0.5 : 1, cursor: callPanelSize === 'compact' ? 'default' : 'pointer' }}>↑</button>
                <button type="button" data-testid="call-panel-larger" aria-label="Aumentar painel da chamada" title={callPanelSize === 'expanded' ? 'Painel já está expandido' : 'Aumentar painel'} disabled={callPanelSize === 'expanded'} onClick={() => setCallPanelSize(callPanelSize === 'compact' ? 'normal' : 'expanded')} style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${borderColor}`, background: inputBg, color: callPanelSize === 'expanded' ? muted : text, opacity: callPanelSize === 'expanded' ? 0.5 : 1, cursor: callPanelSize === 'expanded' ? 'default' : 'pointer' }}>↓</button>
                <button type="button" data-testid="call-panel-hide" aria-label="Esconder painel da chamada" title="Esconder o painel (a chamada continua)" onClick={() => setCallPanelHidden(true)} style={{ width: 28, height: 28, borderRadius: 6, border: `1px solid ${borderColor}`, background: inputBg, color: text, cursor: 'pointer' }}>✕</button>
              </span>
            </span>
            <span style={{ width: 1, height: 26, background: borderColor, flexShrink: 0 }} />
            {}
            <span style={{ fontSize: 12, color: muted, whiteSpace: 'nowrap' }}>{activeCall.participants.length} {activeCall.participants.length === 1 ? 'participante' : 'participantes'}</span>
            {}
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
          {}
          {showCallSettings && (
            <CallSettingsPanel
              prefs={callMediaPrefsState}
              onApply={async (patch) => {
                const aplicado = await callManager.applyMediaPrefs(patch)
                setCallMediaPrefsState(aplicado)
                return aplicado
              }}
              onClose={() => setShowCallSettings(false)}
              onError={(m) => setError(m)}
              cameraOn={!!activeCall?.cameraOn}
              sharing={!!activeCall?.sharing}
              muted={!!activeCall?.muted}
              onToggleCamera={() => callManager.toggleCamera().catch((e: any) => setError(String(e?.message ?? e)))}
              onToggleScreen={() => {
                if (activeCall?.sharing) return callManager.stopScreenShare().catch((e: any) => setError(String(e?.message ?? e)))
                setShowScreenPicker(true)
              }}
              screenQuality={callManager.getScreenShareOptions().quality}
              screenFps={callManager.getScreenShareOptions().fps}
              onScreenQualityChange={(q) => { void callManager.setScreenShareOptions({ quality: q as any }).catch((e: any) => setError(String(e?.message ?? e))); setScreenOptsTick((v) => v + 1) }}
              onScreenFpsChange={(f) => { void callManager.setScreenShareOptions({ fps: f as any }).catch((e: any) => setError(String(e?.message ?? e))); setScreenOptsTick((v) => v + 1) }}
            />
          )}
          {
}
          {!inThisCall && (
            <CallTilesGrid
              tiles={visibleCallTiles}
              pinnedId={pinnedTileId}
              onPin={(id) => setPinnedTileId((cur) => (cur === id ? null : id))}
              onExpand={(id) => setExpandedTileId((cur) => (cur === id ? null : id))}
              deafened={!!activeCall.deafened}
              compact={callPanelSize === 'compact'}
              showAudioControls
              palette={{ heading: t.heading, muted, green: t.green, red: t.red, accent: t.accent, border: borderColor }}
              avatarColor={avatarColor}
              avatarB64={callAvatars}
              onOpenProfile={(fp) => setProfileFp(fp)}
            />
          )}
          {}
          {((activeCall as any)?.invited?.length ?? 0) > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '6px 12px', borderTop: `1px solid ${borderColor}`, background: '#1a1a1a', fontSize: 11, color: muted, flexShrink: 0 }}>
              <span style={{ fontWeight: 700 }}>aguardando:</span>
              {((activeCall as any).invited as { fp: string; nickname: string }[]).map((i) => (
                <span key={i.fp} title={`${i.fp} ainda não entrou`} style={{ fontSize: 10, background: inputBg, border: `1px solid ${borderColor}`, padding: '2px 8px', borderRadius: 99 }}>
                  {nameOfFp(i.fp) || i.nickname}
                </span>
              ))}
            </div>
          )}
          {}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '8px 16px', fontSize: 11, color: muted, borderTop: `1px solid ${borderColor}`, background: '#1a1a1a', flexShrink: 0 }}>
            <Icon d={Icons.users} size={13} />
            <span>{activeCall.participants.length === 1 ? 'convide mais alguém para a mídia ir mais estável' : `mesh P2P • ${activeCall.participants.length} pessoas trocam áudio e tela entre si`}</span>
            <button onClick={() => fileInputRef.current?.click()} style={{ background: 'transparent', border: 'none', color: t.accent, cursor: 'pointer', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 6px' }}><Icon d={Icons.attach} size={12} /> enviar arquivo</button>
          </div>
          {}
          <div style={{ height: 76, background: '#232428', borderTop: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <button onClick={()=>{ setIsMuted(m=>!m); callManager.toggleMute() }} title={isMuted ? 'Ativar microfone' : 'Silenciar'} aria-label={isMuted ? 'Ativar microfone' : 'Silenciar'} style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: isMuted ? t.red : '#3a3a3c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isMuted ? <Icon d={Icons.micOff} size={18} /> : <Icon d={Icons.mic} size={18} />}</button>
            <button onClick={()=>{ setIsDeafened(d=>!d); callManager.toggleDeafen() }} title={isDeafened ? 'Ativar áudio' : 'Ensurdecer'} aria-label={isDeafened ? 'Ativar áudio' : 'Ensurdecer'} style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: isDeafened ? t.red : '#3a3a3c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{isDeafened ? <Icon d={Icons.volumeX} size={18} /> : <Icon d={Icons.headphones} size={18} />}</button>
            {
}
            <button
              onClick={()=> callManager.toggleCamera()}
              disabled={!!activeCall.sharing && !activeCall.cameraOn}
              title={activeCall.sharing && !activeCall.cameraOn ? 'Pare o compartilhamento de tela para ligar a câmera' : 'Câmera'}
              aria-label={activeCall.sharing && !activeCall.cameraOn ? 'Câmera indisponível enquanto compartilha a tela' : 'Câmera'}
              style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: activeCall.cameraOn ? t.green : '#3a3a3c', color: '#fff', cursor: activeCall.sharing && !activeCall.cameraOn ? 'not-allowed' : 'pointer', opacity: activeCall.sharing && !activeCall.cameraOn ? 0.45 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            ><Icon d={Icons.video} size={18} /></button>
            {}
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
                    onClick={() => {
                      if (!supportsScreenShare()) { setError(screenShareUnavailableReason() ?? SCREEN_UNAVAILABLE_MSG); return }
                      setShowScreenPicker(true)
                    }}
                    disabled={!supportsScreenShare()}
                    data-testid="call-screen-share"
                    title={supportsScreenShare() ? 'Compartilhar tela (fonte, áudio e qualidade)' : (screenShareUnavailableReason() ?? 'Este navegador não permite compartilhar tela')}
                    aria-label="Compartilhar tela"
                    style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: '#3a3a3c', color: '#fff', opacity: supportsScreenShare() ? 1 : 0.45, cursor: supportsScreenShare() ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  ><Icon d={Icons.screen} size={18} /></button>
                </>
              )}
            </div>
            {
}
            {mostrarTrocaCamera && (
              <button
                onClick={() => { void trocarCamera() }}
                data-testid="call-camera-switch"
                title={cameraSwitchLabel ? `Trocar de câmera (${cameraSwitchLabel})` : 'Trocar de câmera'}
                aria-label={cameraSwitchLabel ? `Trocar de câmera (${cameraSwitchLabel})` : 'Trocar de câmera'}
                style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: '#3a3a3c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              ><Icon d={Icons.cameraSwitch} size={18} /></button>
            )}
            <button
              onClick={() => setShowCallSettings(v => !v)}
              data-testid="call-settings"
              title="Configurações da chamada: câmera, tela, microfone, qualidade e FPS"
              aria-label="Configurações da chamada"
              aria-expanded={showCallSettings}
              style={{ width: 48, height: 48, borderRadius: '50%', border: 'none', background: showCallSettings ? t.accent : '#3a3a3c', color: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            ><Icon d={Icons.gear} size={18} /></button>
            <button onClick={() => { void callManager.leave() }} data-testid="call-leave" aria-label="Sair da chamada" title="Sair da chamada" style={{ width: 64, height: 48, borderRadius: 24, border: 'none', background: t.red, color: '#fff', cursor: 'pointer', fontWeight: 800, fontSize: 13 }}>Sair</button>
          </div>
        </div>
      )}

      {}
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

      {}
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
            onlineFps={onlineFps}
            onClose={() => setShowGroupPanel(false)}
            onRenamed={() => {
              refreshConvos()
            }}
            onChanged={() => {
              void services.groupMembers(selConv).then((m) => setGroupMemberCount(m.length)).catch(() => {})
              refreshConvos()
              services.conversationsList().then((l) => {
                if (!l.some((c) => c.id === selConv)) { setSelConv(null); setSelPeerFp(null) }
              }).catch(() => {  })
            }}
          />
        </Modal>
      )}

      {}
      {showRoomMembers && selRoom && (
        <Modal
          open
          onClose={() => setShowRoomMembers(false)}
          title={`Chamada — ${conversations.find((c) => c.id === selConv)?.title ?? 'conversa'}`}
          subtitle={roomSummary(selRoom, nameOfFp) ?? undefined}
          width={WIDTHS.sm}
          dialogLabel="Quem está na chamada"
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {selRoom.participants.length === 0 && (
              <div style={{ fontSize: 12, color: muted }}>O motor não informou quem está na sala ainda.</div>
            )}
            {selRoom.participants.map((fp) => (
              <div key={fp} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: inputBg, borderRadius: 8, border: `1px solid ${borderColor}` }}>
                <Avatar name={nameOfFp(fp)} fp={fp} size={26} avatarB64={socialProfiles[fp]?.avatar_b64} />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: t.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fp === identity?.fingerprint ? `${nameOfFp(fp)} (você)` : nameOfFp(fp)}
                </span>
                {selRoom.hostFp === fp && <span style={{ fontSize: 10, fontWeight: 800, color: t.accent }}>QUEM LIGOU</span>}
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }}>
              <Button onClick={() => setShowRoomMembers(false)}>Fechar</Button>
              {!callViva && (
                <Button variant="success" icon="phone" busy={callActionBusy} disabled={callActionBusy || !callsOk} onClick={() => { setShowRoomMembers(false); if (selRoom) void enterRoomFromList(selConv ?? selRoom.convId, selRoom, nameOfFp) }}>
                  Entrar na chamada
                </Button>
              )}
            </div>
          </div>
        </Modal>
      )}

      {}
      {showQuitMenu && (
        <QuitDialog
          canQuit={services.kind === 'native'}
          startedAtMs={appStartedAt.current}
          onClose={() => setShowQuitMenu(false)}
          onMinimize={async () => {
            try { await callManager.leave() } catch {  }
            try { await services.appHideToTray() } catch (e: any) { setError(String(e?.message ?? e)) }
          }}
          onQuit={async () => {
            try { await callManager.leave() } catch {  }
            try { await services.appQuit() } catch (e: any) { setError(String(e?.message ?? e)) }
          }}
        />
      )}

      {}
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
      {stageTile && (
        <ScreenStage
          tile={stageTile}
          palette={{ heading: t.heading, muted, green: t.green, red: t.red, accent: t.accent, border: borderColor }}
          onCollapse={() => setExpandedTileId(null)}
          muted={!!activeCall?.muted}
          onToggleMute={() => { callManager.toggleMute() }}
          cameraOn={!!activeCall?.cameraOn}
          sharing={!!activeCall?.sharing}
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
                  {}
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

            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: muted, marginBottom: 8 }}>MENSAGENS</div>
            <MessageRetentionSettings inputBg={inputBg} borderColor={borderColor} text={text} muted={muted} accent={t.accent} />

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
            <div onClick={() => { services.privacyGet().then(r => setPrivacyMode(r.mode)).catch(() => {}); privacy.resetTransient(); void refreshPrivacyExtras(privacyMode); setShowPrivacyModal(true) }}
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

      {}
      <ScreenSharePicker open={showScreenPicker} onClose={() => setShowScreenPicker(false)} onError={setError} />

      {}
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

            {}
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

            {}
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
                    onChange={e => { setProxyAddr(e.target.value); privacy.resetTransient() }}
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
                  <button onClick={() => privacy.resetTransient()} style={{ flex: 1, background: inputBg, border: `1px solid ${borderColor}`, color: muted, padding: 10, borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}>Cancelar</button>
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

      {}
      <DynamicStyles
        css={`
          .msg-row:hover .msg-tools{display:flex !important}
          mark{background:#f0b232;color:#1e1f22;border-radius:2px}
        `}
      />

      {}
      {profileFp && (
        <ProfileModal
          fp={profileFp}
          nickname={nameOfFp(profileFp)}
          myFp={identity?.fingerprint ?? ''}
          onClose={() => setProfileFp(null)}
          onMessage={fp => { setProfileFp(null); void openDm({ fp }) }}
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