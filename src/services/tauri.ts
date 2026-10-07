// Implementação NATIVA: Tauri 2 → forge-core (Rust).
// Toda operação sensível é validada no core — a UI apenas reflete estado real.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type {
  RelayLegStatus,
  AuditEntry,
  BotView,
  ChannelMeta,
  Conversation,
  EngineEvent,
  ForgeServices,
  FriendView,
  FriendOutcome,
  Identity,
  ModerationAction,
  NameCheckView,
  NameKind,
  NetworkStatusView,
  PeerView,
  PrivacyMode,
  PrivacySettings,
  ReputationView,
  RoleView,
  ServerRules,
  StoredMessage,
  VoiceMediaStats,
  ReactionSummary,
  MsgMetaView,
  PresenceView,
  ProfileView,
  ThreadView,
  BanView,
  PollView,
  PollTally,
  EventView,
  EmojiView,
  ReadCursor,
  SearchQuery,
  SearchHit,
} from './models'

export const tauriServices: ForgeServices = {
  kind: 'native',

  version: () => invoke<string>('get_app_version'),

  identityGet: () => invoke<Identity | null>('identity_get'),

  identityCreate: (nickname, password) =>
    invoke<Identity>('identity_create', { nickname, password: password ?? null }),

  vaultStatus: () => invoke<{ has_identity: boolean; has_vault: boolean }>('vault_status'),

  vaultUnlock: (password) => invoke<Identity>('vault_unlock', { password }),

  // Endereços locais — o IP de LAN vem do Rust (o JS não tem como descobrir).
  localAddresses: (port) => invoke<import('./models').LocalAddresses>('local_addresses', { port: port ?? null }),

  identityRename: (nickname) => invoke<Identity>('identity_rename', { nickname }),

  networkStatus: () => invoke<NetworkStatusView>('network_status'),

  peersList: () => invoke<PeerView[]>('peers_list'),

  netDiag: () => invoke<import('./models').NetDiag>('net_diag'),
  webrtcReport: (info: string) => invoke('webrtc_report', { info }),

  relayStatus: () => invoke<RelayLegStatus[]>('relay_status'),

  connectAddr: (addr, expectedFp) =>
    invoke<void>('connect_addr', { addr, expectedFp: expectedFp ?? null }),

  disconnectPeer: (fp) => invoke<void>('disconnect_peer', { fp }),

  friendsList: (status) => invoke<FriendView[]>('friends_list', { status: status ?? null }),

  friendRequest: (peerFp) => invoke<FriendOutcome>('friend_request', { peerFp }),

  friendRespond: (peerFp, accept) => invoke<void>('friend_respond', { peerFp, accept }),

  friendRemove: (peerFp) => {
    if (!peerFp || peerFp.trim() === '') throw new Error('fingerprint inválido')
    return invoke<void>('friend_remove', { peerFp: peerFp.trim() })
  },

  friendBlock: (peerFp) => invoke<void>('friend_block', { peerFp }),

  friendUnblock: (peerFp) => invoke<void>('friend_unblock', { peerFp }),

  vaultChange: (oldPass, newPass) => invoke<void>('vault_change', { old: oldPass, new: newPass }),

  communitiesList: () => invoke<import('./models').CommunityView[]>('communities_list'),

  createCommunity: (name, channels, opts) => invoke<string>('create_community', {
    name,
    channels: channels.length ? channels : null,
    options: opts ?? null,
  }),

  communitySetMeta: (communityId, patch) => invoke<void>('community_set_meta', {
    communityId,
    description: patch.description ?? null,
    category: patch.category ?? null,
    icon: patch.icon ?? null,
  }),

  makeInvite: (communityId, memberFp) => invoke<string>('make_invite', { communityId, memberFp }),

  joinCommunity: (token) => invoke<string>('join_community', { token }),

  communityRename: (communityId, name) => invoke<void>('community_rename', { communityId, name }),

  sendChannelMessage: (communityId, channelId, body) =>
    invoke<StoredMessage>('send_channel_message', { communityId, channelId, body }),

  conversationsList: () => invoke<Conversation[]>('conversations_list'),

  dmOpen: (peerFp, peerNick) => {
    if (!peerFp || typeof peerFp !== 'string' || peerFp.trim() === '') throw new Error('fingerprint inválido')
    return invoke<Conversation>('dm_open', { peerFp: peerFp.trim(), peerNick: peerNick ?? peerFp.trim() })
  },

  conversationDelete: (convId: string) => {
    if (!convId || convId.trim() === '') throw new Error('conversa inválida')
    return invoke<void>('delete_conversation', { convId: convId.trim() })
  },

  messagesList: (convId) => {
    if (!convId || convId.trim() === '') throw new Error('conversa inválida')
    return invoke<StoredMessage[]>('messages_list', { convId: convId.trim() })
  },

  messageSend: (convId, body) => {
    if (!convId || convId.trim() === '') throw new Error('conversa inválida — selecione um amigo aceito')
    if (!body || body.trim() === '') throw new Error('mensagem vazia')
    return invoke<StoredMessage>('message_send', { convId: convId.trim(), body })
  },

  sendTyping: async (convId) => {
    // Core ainda não tem frame Typing — best-effort: tenta invoke, ignora se não existir.
    // Quando o relay suportar, o peer recebe; local nunca ecoa para si.
    try { await invoke<void>('send_typing', { convId }) } catch { /* sem suporte no core — ok */ }
  },

  subscribe: (cb) => {
    const un = listen<EngineEvent>('forge://event', (e) => cb(normalizeNativeEvent(e.payload)))
    return () => {
      un.then((f) => f()).catch(() => {})
    }
  },

  privacyGet: () => invoke<PrivacySettings>('privacy_get'),

  privacySet: (mode: PrivacyMode) => invoke<PrivacySettings>('privacy_set', { mode }),

  proxyAddrGet: () => invoke<import('./models').ProxyConfig>('proxy_addr_get'),

  proxyAddrSet: (addr) => invoke<void>('proxy_addr_set', { addr }),

  proxyTest: (addr) => invoke<number>('proxy_test', { addr }),

  vaultExport: () => invoke<{ identity: Identity; vault_blob: string }>('vault_export'),
  vaultImport: (identityJson: string, vaultBlob: string) => invoke<Identity>('vault_import', { identityJson: identityJson, vaultBlob: vaultBlob }),
  accountsList: () => invoke<import('./models').SavedAccount[]>('accounts_list'),
  accountSaveImported: (identityJson: string, vaultBlob: string) => invoke<void>('account_save_imported', { identityJson: identityJson, vaultBlob: vaultBlob }),
  accountSwitch: (fingerprint: string) => invoke<Identity>('account_switch', { fingerprint }),
  accountRemoveImported: (fingerprint: string) => invoke<void>('account_remove_imported', { fingerprint }),

  // Canais — invoke direto no backend real; Rust retorna ChannelMetaRow, extrai id
  channelCreate: async (cid, name, opts) => {
    const row = await invoke<{ id: string }>('channel_create', { communityId: cid, name, topic: opts?.topic ?? null, category: opts?.category ?? null, kind: opts?.kind ?? null })
    return typeof row === 'string' ? row : (row as any).id ?? String(row)
  },
  channelDelete: (cid, channelId) =>
    invoke<void>('channel_delete', { communityId: cid, channelId: channelId }),
  channelRename: (cid, channelId, newName) =>
    invoke<void>('channel_rename', { communityId: cid, channelId: channelId, newName: newName }),
  channelSetTopic: (cid, channelId, topic) =>
    invoke<void>('channel_set_topic', { communityId: cid, channelId: channelId, topic }),
  channelSetCategory: (cid, channelId, category) =>
    invoke<void>('channel_set_category', { communityId: cid, channelId: channelId, category }),
  channelList: (cid) =>
    invoke<ChannelMeta[]>('channel_list', { communityId: cid }),

  // Cargos — Rust retorna RoleRow, extrai id
  roleCreate: async (cid, data) => {
    const row = await invoke<{ id: string }>('role_create', { communityId: cid, name: data.name, color: data.color, permissions: data.permissions, hoist: data.hoist, mentionable: data.mentionable })
    return typeof row === 'string' ? row : (row as any).id ?? String(row)
  },
  roleUpdate: (cid, roleId, patch) =>
    invoke<void>('role_update', { communityId: cid, roleId: roleId, name: patch.name ?? null, color: patch.color ?? null, permissions: patch.permissions ?? null, hoist: patch.hoist ?? null, mentionable: patch.mentionable ?? null, position: patch.position ?? null }),
  roleDelete: (cid, roleId) =>
    invoke<void>('role_delete', { communityId: cid, roleId: roleId }),
  rolesList: (cid) =>
    invoke<RoleView[]>('roles_list', { communityId: cid }),
  memberRoles: (cid, fp) =>
    invoke<string[]>('member_roles', { communityId: cid, fp }),
  memberAssignRole: (cid, fp, roleId) =>
    invoke<void>('member_assign_role', { communityId: cid, fp, roleId: roleId }),
  memberUnassignRole: (cid, fp, roleId) =>
    invoke<void>('member_unassign_role', { communityId: cid, fp, roleId: roleId }),
  memberKick: (cid, fp) =>
    invoke<void>('member_kick', { communityId: cid, fp }),

  // Bots — Rust retorna BotRow, extrai id
  botCreate: async (cid, data) => {
    const row = await invoke<{ id: string }>('bot_create', { communityId: cid, name: data.name, avatar: data.avatar ?? null, roleId: data.roleId ?? null })
    return typeof row === 'string' ? row : (row as any).id ?? String(row)
  },
  botUpdate: (cid, botId, patch) =>
    invoke<void>('bot_update', { communityId: cid, botId: botId, name: patch.name ?? null, avatar: patch.avatar ?? null, roleId: patch.roleId === undefined ? null : (patch.roleId ?? ''), online: patch.online ?? null, config: patch.config ?? null }),
  botDelete: (cid, botId) =>
    invoke<void>('bot_delete', { communityId: cid, botId: botId }),
  botsList: (cid) =>
    invoke<BotView[]>('bots_list', { communityId: cid }),
  botPostMessage: (cid, channelId, botId, body) =>
    invoke<StoredMessage>('bot_post_message', { communityId: cid, channelId, botId, body }),
  botRegenToken: (cid, botId) =>
    invoke<string>('bot_regen_token', { communityId: cid, botId }),
  // HTTP p/ bots — reqwest no shell (sem CORS do WebView), timeout e cap no Rust.
  // O Rust devolve {status, body_b64, body_text, truncated
// texto UTF-8 já vem
  // decodificado (caso comum: JSON de API), binário cai no atob do body_b64.
  httpFetch: async (url, method, headers, body, timeoutMs) => {
    const r = await invoke<{ status: number; body_b64: string; body_text: string | null; truncated: boolean }>('http_fetch', {
      url, method,
      headers: Object.entries(headers ?? {}),
      body: body ?? null,
      timeoutMs,
    })
    let out: string
    if (typeof r.body_text === 'string') out = r.body_text
    else {
      try { out = atob(r.body_b64) } catch { out = '' }
    }
    return { status: r.status, body: out }
  },

  // Grupos DM + chamadas + voz + arquivos
  createGroup: (title, members) => invoke<Conversation>('create_group', { title, members }),
  groupMembers: (cid) => invoke<[string, string][]>('group_members', { convId: cid }),
  groupAdd: (cid, fp) => invoke<void>('group_add', { convId: cid, fp }),
  callInvite: (targetFp, kind) => invoke<string>('call_invite', { targetFp: targetFp, kind }),
  callAccept: (callId, fromFp) => invoke<void>('call_accept', { callId: callId, fromFp: fromFp }),
  callReject: (callId, fromFp, reason) => invoke<void>('call_reject', { callId: callId, fromFp: fromFp, reason }),
  callEnd: (callId) => invoke<void>('call_end', { callId: callId }),
  callOffer: (targetFp, callId, sdp) => invoke<void>('call_offer', { targetFp: targetFp, callId: callId, sdp }),
  callAnswer: (targetFp, callId, sdp) => invoke<void>('call_answer', { targetFp: targetFp, callId: callId, sdp }),
  callIce: (targetFp, callId, candidate, mid) => invoke<void>('call_ice', { targetFp: targetFp, callId: callId, candidate, mid }),
  callAddParticipant: (targetFp, callId, fp, kind) => invoke<void>('call_add_participant', { targetFp, callId, fp, kind }),
  screenShareOffer: (targetFp, callId, sdp) => invoke<void>('screen_share_offer', { targetFp, callId, sdp }),
  screenShareAnswer: (targetFp, callId, sdp) => invoke<void>('screen_share_answer', { targetFp, callId, sdp }),
  voiceJoin: (cid, ch) => invoke<void>('voice_join', { communityId: cid, channelId: ch }),
  voiceLeave: (cid, ch) => invoke<void>('voice_leave', { communityId: cid, channelId: ch }),
  voiceState: (cid,ch,muted,deafened) => invoke<void>('voice_state', { communityId: cid, channelId: ch, muted, deafened }),
  voiceStates: (cid,ch) => invoke<[string,boolean,boolean][]>('voice_states', { communityId: cid, channelId: ch }).catch(()=>[]),
  fileAnnounce: (fid, name, size, chunks, hash, chunkHashes?: string[]) => invoke<void>('file_announce', { fileId: fid, name, size, chunks, hash, chunkHashes: chunkHashes ?? null }),
  fileRequestChunk: (fid,idx,holder) => invoke<void>('file_request_chunk', { fileId: fid, index: idx, holderFp: holder }),
  fileSendChunk: (target,fid,idx,b64) => invoke<void>('file_send_chunk', { targetFp: target, fileId: fid, index: idx, dataB64: b64 }),

  // Segurança / anti-spam / moderação — validado no core (Rust)
  serverRulesGet: (cid) => invoke<ServerRules>('server_rules_get', { communityId: cid }),
  serverRulesSet: (rules) => invoke<void>('server_rules_set', { rules }),
  auditList: (cid, limit) => invoke<AuditEntry[]>('audit_list', { communityId: cid, limit: limit ?? null }),
  reputationGet: (fp) => invoke<[string, number, number]>('reputation_get', { fp })
    .then(([trust, score, reports]) => ({ trust: trust as ReputationView['trust'], score, reports })),
  safetyNumber: (peerFp) => invoke<string>('safety_number', { peerFp }),
  moderate: (cid, action: ModerationAction, target, reason) =>
    invoke<void>('moderate', { communityId: cid, action, target, reason: reason ?? null }),
  reportUser: (targetFp, communityId, reason) =>
    invoke<void>('report_user', { targetFp, communityId: communityId ?? null, reason: reason ?? null }),
  validateName: (kind: NameKind, raw, existing) =>
    invoke<NameCheckView>('validate_name', { kind, raw, existing: existing ?? null }),
  randomName: () => invoke<string>('random_name'),

  // Cofre portátil .stormvault (5.4)
  stormvaultExport: (password, opts) =>
    invoke<import('./models').StormVaultExportResult>('stormvault_export', {
      password, includeSecret: opts?.includeSecret ?? true, maxMessages: opts?.maxMessages ?? null,
    }),
  stormvaultImportFile: (contentB64, password) =>
    invoke<import('./models').VaultImportReport>('stormvault_import', { contentB64, password }),
  stormvaultBackupsList: () => invoke<import('./models').VaultBackupInfo[]>('stormvault_backups_list'),
  stormvaultBackupNow: () => invoke<import('./models').VaultBackupInfo>('stormvault_backup_now'),
  stormvaultBackupRestore: (file) =>
    invoke<import('./models').VaultImportReport>('stormvault_backup_restore', { file }),
  stormvaultBackupSetRetention: (days) => invoke<void>('stormvault_backup_set_retention', { days }),
  stormvaultBackupGetRetention: () => invoke<number>('stormvault_backup_get_retention'),
  vaultWipe: (confirm) => invoke<import('./models').WipeReport>('vault_wipe', { confirm }),
  messagesWindow: (convId, beforeTs, limit) => {
    if (!convId || convId.trim() === '') throw new Error('conversa inválida')
    return invoke<StoredMessage[]>('messages_window', { convId: convId.trim(), beforeTs: beforeTs ?? null, limit })
  },
  metricsSnapshot: () => invoke<Record<string, unknown>>('metrics_snapshot'),
  peerRtt: (fp) => invoke<number | null>('peer_rtt', { fp }),
  cacheGet: (key) => invoke<string | null>('cache_get', { key }),
  cachePut: (key, dataB64) => invoke<void>('cache_put', { key, dataB64 }),
  cacheDelete: (key) => invoke<void>('cache_delete', { key }),
  cacheStats: () => invoke<import('./models').CacheStats>('cache_stats'),
  cacheSetCap: (capMb) => invoke<void>('cache_set_cap', { capMb }),
  mediaSafetyGet: () => invoke<import('./models').MediaSafetySettings>('media_safety_get'),
  mediaSafetySet: (stripExif, blockExecutables) =>
    invoke<void>('media_safety_set', { stripExif, blockExecutables }),

  // Voz nativa (webrtc-rs + cpal + Opus) — só existe onde o core a constrói
  // (Linux; desligável por FORGE_NO_NATIVE_VOICE=1). Onde não existe o comando
  // devolve false/null e o WebRTC do navegador segue intacto.
  voiceMediaAvailable: () => invoke<boolean>('voice_media_available'),
  voiceMediaStats: (callId) => invoke<VoiceMediaStats | null>('voice_media_stats', { callId }),
  voiceSetMuted: (callId, muted) => invoke<void>('voice_set_muted', { callId, muted }),
  voiceSetDeafened: (callId, deafened) => invoke<void>('voice_set_deafened', { callId, deafened }),
  voiceHangup: (callId) => invoke<void>('voice_hangup', { callId }),
  // Vídeo nativo (Linux): o core codifica câmera/tela (GStreamer) na MESMA
  // PeerConnection webrtc-rs da voz e decodifica o vídeo remoto em JPEG
  // para a UI — o WebKitGTK não expõe RTCPeerConnection, então é este o
  // único caminho de vídeo no desktop Linux.
  voiceVideoStart: (callId, peerFp, source, monitorId) =>
    invoke<string>('voice_video_start', { callId, peerFp, source, monitorId: monitorId ?? null }),
  voiceVideoStop: (callId, peerFp) => invoke<void>('voice_video_stop', { callId, peerFp }),
  voiceVideoFrame: (callId, peerFp, sinceSeq) =>
    invoke<import('./models').NativeVideoFrame | null>('voice_video_frame', { callId, peerFp, sinceSeq: sinceSeq ?? null }),
  // ================= CAMADA SOCIAL v3 =================
  react: (convId, msgId, emoji) => invoke<boolean>('social_react', { convId, msgId, emoji }),
  reactions: (msgId) => invoke<ReactionSummary[]>('social_reactions', { msgId }),
  reactionsBulk: (msgIds) => invoke<ReactionSummary[]>('social_reactions_bulk', { msgIds }),
  reply: (convId, msgId, replyTo) => invoke<void>('social_reply', { convId, msgId, replyTo }),
  editMessage: (convId, msgId, body) => invoke<void>('social_edit', { convId, msgId, body }),
  deleteMessage: (convId, msgId) => invoke<void>('social_delete', { convId, msgId }),
  pin: (convId, msgId, pinned) => invoke<void>('social_pin', { convId, msgId, pinned }),
  pins: (convId) => invoke<MsgMetaView[]>('social_pins', { convId }),
  metaBulk: (msgIds) => invoke<MsgMetaView[]>('social_meta_bulk', { msgIds }),
  effectiveBodies: (msgIds) => invoke<[string, string][]>('social_bodies', { msgIds }),
  forward: (srcMsgId, targetConv, targetChannel, fromLabel) =>
    invoke<StoredMessage>('social_forward', { srcMsgId, targetConv, targetChannel, fromLabel }),

  readSet: (convId, ts) => invoke<void>('read_set', { convId, ts }),
  readAll: () => invoke<ReadCursor[]>('read_all'),
  unreadCount: (convId) => invoke<number>('unread_count', { convId }),
  unreadMentions: () => invoke<number>('unread_mentions'),

  presenceSet: (status, custom, customEmoji) =>
    invoke<void>('presence_set', { status, custom, customEmoji }),
  presenceList: () => invoke<PresenceView[]>('presence_list'),
  presenceGet: (fp) => invoke<PresenceView>('presence_get', { fp }),
  profileSet: (p) => invoke<ProfileView>('profile_set', p),
  profileGet: (fp) => invoke<ProfileView>('profile_get', { fp }),
  profileList: () => invoke<ProfileView[]>('profile_list'),
  nicknameSet: (communityId, fp, nickname) => invoke<void>('nickname_set', { communityId, fp, nickname }),
  nicknameGet: (communityId, fp) => invoke<string>('nickname_get', { communityId, fp }),

  searchMessages: (q) => invoke<SearchHit[]>('message_search', { q }),
  messagesAround: (convId, ts, limit) => invoke<StoredMessage[]>('messages_around', { convId, ts, limit }),

  threadCreate: (communityId, parentChannel, name, kind = 'thread', tags = '') =>
    invoke<ThreadView>('thread_create', { communityId, parentChannel, name, kind, tags }),
  threadList: (communityId, parentChannel) => invoke<ThreadView[]>('thread_list', { communityId, parent: parentChannel }),
  threadMessages: (threadId, limit = 200) => invoke<StoredMessage[]>('thread_messages', { threadId, limit }),
  threadSend: (communityId, threadId, body) => invoke<StoredMessage>('thread_send', { communityId, threadId, body }),
  threadArchive: (threadId, archived) => invoke<void>('thread_archive', { threadId, archived }),

  ban: (communityId, fp, untilMs, reason) => invoke<void>('member_ban', { communityId, fp, untilMs, reason }),
  unban: (communityId, fp) => invoke<void>('member_unban', { communityId, fp }),
  timeout: (communityId, fp, untilMs, reason) => invoke<void>('member_timeout', { communityId, fp, untilMs, reason }),
  banList: (communityId) => invoke<BanView[]>('ban_list', { communityId }),
  timeoutList: (communityId) => invoke<BanView[]>('timeout_list', { communityId }),
  channelCfgSet: (communityId, channelId, slowmodeSecs, nsfw) =>
    invoke<void>('channel_cfg_set', { communityId, channelId, slowmodeSecs, nsfw }),
  channelCfgGet: (channelId) => invoke<number>('channel_cfg_get', { channelId }),

  pollCreate: (communityId, channelId, question, options, multi, endsAt) =>
    invoke<PollView>('poll_create', { communityId, channelId, question, options, multi, endsAt }),
  pollList: (communityId, channelId) => invoke<PollView[]>('poll_list', { communityId, channelId }),
  pollVote: (communityId, channelId, pollId, optionIdx) =>
    invoke<void>('poll_vote', { communityId, channelId, pollId, optionIdx }),
  pollTally: async (pollId) => {
    const [counts, total, mine] = await invoke<[number[], number, number[]]>('poll_tally', { pollId })
    return { counts, total, mine }
  },

  eventUpsert: (ev) => invoke<void>('event_upsert', { ev }),
  eventList: (communityId) => invoke<EventView[]>('event_list', { communityId }),
  eventInterest: (communityId, eventId) => invoke<void>('event_interest', { communityId, eventId }),
  eventDelete: (communityId, eventId) => invoke<void>('event_delete', { communityId, eventId }),

  emojiUpsert: (e) => invoke<void>('emoji_upsert', { e }),
  emojiList: (communityId) => invoke<EmojiView[]>('emoji_list', { communityId }),
  emojiDelete: (communityId, id) => invoke<void>('emoji_delete', { communityId, id }),

  bookmarkSet: (convId, name, payload) => invoke<void>('bookmark_set', { convId, name, payload }),
  bookmarkList: (convId) => invoke<[string, string][]>('bookmark_list', { convId }),
}

// forge-core serializa variantes *Ev com o sufixo (ex.: FileAnnounceEv ->
// 'file_announce_ev'), enquanto a UI/browser usa o nome curto ('file_announce').
// Sem este alias, no app nativo o anúncio de arquivo (e sinalização de chamada)
// nunca chegava aos handlers — arquivo não aparecia e download não iniciava.
const NATIVE_EV_ALIASES: Record<string, EngineEvent['type']> = {
  file_announce_ev: 'file_announce',
  file_chunk_request_ev: 'file_chunk_request',
  file_chunk_data_ev: 'file_chunk_data',
  call_accepted_ev: 'call_accepted',
  call_offer_ev: 'call_offer',
  call_answer_ev: 'call_answer',
  call_ice_ev: 'call_ice',
  screen_share_offer_ev: 'screen_share_offer',
}

function normalizeNativeEvent(ev: EngineEvent): EngineEvent {
  const t = (ev as { type: string }).type
  const alias = NATIVE_EV_ALIASES[t]
  if (!alias) return ev
  return { ...(ev as Record<string, unknown>), type: alias } as EngineEvent
}
