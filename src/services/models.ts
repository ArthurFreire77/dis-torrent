export type NetworkState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING'

export type MessageStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'failed' | 'ok' | 'read'

export type PrivacyMode = 'normal' | 'encrypted' | 'proxy' | 'full'

export interface PrivacyModeInfo {
  mode: PrivacyMode
  label: string
  description: string
  flags: {
    encryption: boolean
    tor_proxy: boolean
    udp_discovery: boolean
    metadata_padding: boolean
    traffic_obfuscation: boolean
  }
  crypto_chain: string[]
  data_flow: string
  pros: string[]
  cons: string[]
  residual_risk: string[]
}

export const PRIVACY_MODES: PrivacyModeInfo[] = [
  {
    mode: 'normal',
    label: 'Sem segurança',
    description: 'Sem criptografia — texto puro.',
    flags: { encryption: false, tor_proxy: false, udp_discovery: true, metadata_padding: false, traffic_obfuscation: false },
    crypto_chain: ['Sem criptografia'],
    data_flow: 'Você → TCP → Peer',
    pros: [], cons: [], residual_risk: [],
  },
  {
    mode: 'encrypted',
    label: 'Seguro',
    description: 'Com criptografia (X25519 + ChaCha20Poly1305). Usa relay público e STUN como fallback — seu fp e IP podem ser vistos pelas infraestruturas de retransmissão, nunca o conteúdo.',
    flags: { encryption: true, tor_proxy: false, udp_discovery: true, metadata_padding: false, traffic_obfuscation: false },
    crypto_chain: ['X25519 + ChaCha20Poly1305'],
    data_flow: 'Você → cifrado → Peer',
    pros: [], cons: [], residual_risk: [],
  },
  {
    mode: 'proxy',
    label: 'Seguro +',
    description: 'Com criptografia + 1 proxy para esconder seu IP. Relay e descoberta desligados neste modo. Chamadas WebRTC não passam pelo proxy e não são anônimas.',
    flags: { encryption: true, tor_proxy: false, udp_discovery: false, metadata_padding: false, traffic_obfuscation: true },
    crypto_chain: ['1 proxy + X25519 + ChaCha20'],
    data_flow: 'Você → Proxy → Peer',
    pros: [], cons: [], residual_risk: [],
  },
  {
    mode: 'full',
    label: 'Tor',
    description: 'Criptografia + saída pelo SOCKS5 do Tor local (127.0.0.1:9050). Relay, descoberta LAN, DHT e STUN do app ficam OFF. O número de saltos é do seu daemon Tor (padrão: 3) — o app não controla nem verifica. Chamadas WebRTC NÃO passam pelo Tor e não são anônimas.',
    flags: { encryption: true, tor_proxy: true, udp_discovery: false, metadata_padding: true, traffic_obfuscation: true },
    crypto_chain: ['Tor (circuito do daemon local) + X25519 + ChaCha20'],
    data_flow: 'Você → Tor (daemon local) → Peer',
    pros: [], cons: [], residual_risk: [],
  },
]

export interface SavedAccount {
  nickname: string
  fingerprint: string
}

export interface PrivacySettings {
  mode: PrivacyMode
  encryption_enabled: boolean
  tor_proxy: boolean
  udp_discovery: boolean
  metadata_padding: boolean
  traffic_obfuscation: boolean
  proxy_effective: boolean
}

export interface ProxyConfig {
  addr: string
  is_default: boolean
}

export interface Identity {
  fingerprint: string
  pubkey_hex: string
  nickname: string
  created_at: number
}

export interface LocalAddresses {
  localhost: string
  lan: string | null
  lan_all: string[]
  port: number
}

/** Estado real do firewall do Windows (ver `src-tauri/src/firewall.rs`). */
export interface FirewallStatus {
  allowed: boolean
  profile: string
  program: string
  reason: string | null
}

export interface NetworkStatusView {
  state: NetworkState
  online_peers: number
  listen_port: number
}

export interface RelayLegStatus {
  name: string
  ok: boolean
  latency_ms: number | null
  last_error: string | null
}

export interface PeerView {
  fp: string
  pubkey_hex: string
  nickname: string
  addr: string | null
  last_seen: number
  origin: string
  state: NetworkState
  via_relay?: boolean
  last_direct_error?: string | null
  last_relay_error?: string | null
  direct_attempts?: number
  relay_attempts?: number
  announce_seen_ms?: number
  last_reject?: string | null
  last_reject_ms?: number
  send_gave_up?: number
}

export interface NetDiag {
  stun_ok: boolean | null
  stun_addr: string | null
  stun_ms: number
  announce_addr: string | null
  announce_ms: number
  nat_source: string | null
  dht_ok: boolean | null
  dht_ms: number
}

export interface Conversation {
  id: string
  kind: 'dm' | 'group' | string
  title: string
  peer_fp: string
  created_at: number
}

/** Conversa com o resumo que a lista mostra (prévia, horário, não lidas). */
export interface ConversationOverview extends Conversation {
  last_ts: number
  last_body: string
  unread_count: number
}

/** Quanto do limite de 3 mensagens iniciais já foi usado nesta direção. */
export interface DmIntroState {
  used: number
  limit: number
  is_friend: boolean
  remaining: number
}

export interface StoredMessage {
  id: string
  conv_id: string
  author_fp: string
  body: string
  ts: number
  sig: string
  direction: 'in' | 'out' | string
  status: MessageStatus
  bot_id?: string
}

export type EngineEvent =
  | { type: 'state_changed'; state: NetworkState; online_peers: number }
  | { type: 'peer_online'; fp: string; nickname: string; via_relay?: boolean }
  | { type: 'peer_offline'; fp: string }
  | { type: 'peer_discovered'; fp: string; nickname: string; addr: string }
  | ({ type: 'message_new' } & StoredMessage)
  | { type: 'message_status'; msg_id: string; status: MessageStatus }
  | { type: 'friend_request_in'; fp: string; nickname: string }
  | { type: 'friend_accepted'; fp: string; nickname: string }
  | { type: 'friend_removed'; fp: string }
  | { type: 'community_joined'; community_id: string; name: string }
  | { type: 'community_removed'; community_id: string }
  | { type: 'group_synced'; conv_id: string; title: string }
  | { type: 'channel_created'; community_id: string; channel_id: string; name: string }
  | { type: 'channel_deleted'; community_id: string; channel_id: string }
  | { type: 'role_created'; community_id: string; role_id: string }
  | { type: 'role_deleted'; community_id: string; role_id: string }
  | { type: 'bot_created'; community_id: string; bot_id: string }
  | { type: 'call_incoming'; call_id: string; from_fp: string; kind: string }
  | { type: 'call_accepted'; call_id: string; from_fp: string }
  | { type: 'call_ringing'; call_id: string; from_fp: string }
  | { type: 'call_rejected'; call_id: string; from_fp: string; reason: string }
  | { type: 'call_ended'; call_id: string; from_fp: string }
  | { type: 'call_offer'; call_id: string; from_fp: string; sdp: string }
  | { type: 'call_answer'; call_id: string; from_fp: string; sdp: string }
  | { type: 'call_ice'; call_id: string; from_fp: string; candidate: string; mid: string }
  | { type: 'call_participant_added'; call_id: string; fp: string; kind?: string }
  | { type: 'nat_endpoint'; addr: string; source: string }
  | { type: 'voice_joined'; community_id: string; channel_id: string; fp: string }
  | { type: 'voice_left'; community_id: string; channel_id: string; fp: string }
  | { type: 'voice_state_changed'; community_id: string; channel_id: string; fp: string; muted: boolean; deafened: boolean }
  | { type: 'call_room'; call_id: string; conv_id: string; kind: string; state: 'open' | 'closed'; participants: string[]; host_fp: string }
  | { type: 'file_announce'; file_id: string; name: string; size: number; chunks: number; hash: string; from_fp: string; chunk_hashes?: string[] }
  | { type: 'file_chunk_request'; file_id: string; index: number; from_fp: string }
  | { type: 'file_chunk_data'; file_id: string; index: number; data_b64: string; from_fp: string }
  | { type: 'screen_share_offer'; call_id: string; from_fp: string; sdp: string }
  | { type: 'typing'; conv_id: string; fp: string; nickname: string }
  | { type: 'reaction_changed'; msg_id: string; conv_id: string; emoji: string; add: boolean; reactor_fp: string }
  | { type: 'message_edited'; msg_id: string; conv_id: string; body: string }
  | { type: 'message_deleted'; msg_id: string; conv_id: string }
  | { type: 'message_pinned'; msg_id: string; conv_id: string; pinned: boolean }
  | { type: 'message_reply'; msg_id: string; reply_to: string }
  | { type: 'presence_changed'; fp: string; status: string; custom: string; custom_emoji: string }
  | { type: 'profile_changed'; fp: string; profile: ProfileView }
  | { type: 'thread_created'; community_id: string; thread: ThreadView }
  | { type: 'moderation_applied'; community_id: string; target_fp: string; kind: string; until_ms: number; reason: string }
  | { type: 'poll_updated'; community_id: string; channel_id: string; poll_id: string }
  | { type: 'event_updated'; community_id: string; event_id: string }
  | { type: 'emoji_updated'; community_id: string; emoji_id: string }
  | { type: 'muted'; context: string; reason: string; until_ms: number }
  | { type: 'error'; context: string }

export interface FriendView {
  fp: string
  nickname: string
  addr: string | null
  pubkey_hex: string
  last_seen: number
}

export type FriendOutcome = 'sent' | 'queued_offline'

export interface CommunityView {
  id: string
  name: string
  owner_fp: string
  channels: [string, string][]
  members: [string, string, string][]
  description?: string
  category?: string
  icon?: string
  is_owner?: boolean
  /** `true` = qualquer um entra (com rate limit). `false`/ausente = só por convite. */
  is_public?: boolean
}

export type MemberPairingState =
  | 'connected'
  | 'relay'
  | 'connecting'
  | 'reconnecting'
  | 'pending_join'
  | 'offline'

export interface MemberPairing {
  fp: string
  nickname: string
  role: string
  state: MemberPairingState
  via_relay: boolean
  is_owner: boolean
  is_self: boolean
}

export interface InviteView {
  token: string
  link: string
  expires_at_ms: number
  scope: 'open' | 'fp'
}

export interface ChannelMeta {
  id: string
  name: string
  topic?: string
  category: string
  position: number
  kind: 'text' | 'voice' | 'video' | 'forum'
}

export interface RoleView {
  id: string
  community_id: string
  name: string
  color: string
  permissions: number
  hoist: boolean
  mentionable: boolean
  position: number
  botManaged?: boolean
}

export interface BotView {
  id: string
  community_id: string
  name: string
  discriminator: string
  avatar: string
  roleId: string | null
  token: string
  online: boolean
  ownerFp: string
  createdAt: number
  config?: string
  /** Permissões administrativas concedidas pelo dono (bitmask). */
  perms?: number
  /**
   * Segredo do HMAC do webhook — local do dono, nunca sincronizado para os
   * membros. Só chega aqui pelo `bots_list` (comando local do app).
   */
  webhook_secret?: string
}

/** Linha do console de um bot. */
export interface BotLogView {
  id: number
  community_id: string
  bot_id: string
  level: string
  message: string
  created_at: number
}

export interface WarnView {
  id: string
  community_id: string
  fp: string
  reason: string
  actor_fp: string
  created_at: number
  active: boolean
}

/** Ponte local (`127.0.0.1`) aberta para um bot. */
export interface BotBridgeInfo {
  bot_id: string
  community_id: string
  /** URL completa e secreta: o plugin usa isso e nada mais. */
  url: string
  port: number
  started_at: number
}

export interface BotBridgeStatus {
  running: boolean
  url: string | null
  port: number | null
  events_pending: number
  requests: number
  dropped: number
}

export interface BotFolderInfo {
  dir: string
  name: string
  avatar: string
  config: string
  run: string | null
  requires: string[]
  description: string
  /** Permissões pedidas pelo autor do bot — o dono confirma, não são aplicadas sozinhas. */
  perms?: number
  files: string[]
}

export interface BotPluginLine {
  at: number
  level: string
  message: string
}

export interface BotPluginStatus {
  running: boolean
  pid: number | null
  command: string
  dir: string
  started_at: number
  exited_code: number | null
  lines: BotPluginLine[]
}

export interface CommunityChannelSeed { name: string; kind: 'text' | 'voice' | 'video'; category: string }
export interface CommunityRoleSeed { name: string; color: string; permissions: number; hoist: boolean; mentionable: boolean }

export interface CreateCommunityOptions {
  description?: string
  category?: string
  icon?: string
  rulesText?: string
  channelsMeta?: CommunityChannelSeed[]
  roles?: CommunityRoleSeed[]
  /** Servidor público: qualquer um entra, com rate limit. Padrão: privado. */
  isPublic?: boolean
}

export interface MemberRoleAssignment {
  fp: string
  roleIds: string[]
}

export const PERMS = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_CHANNELS: 1 << 1,
  MANAGE_ROLES: 1 << 2,
  KICK_MEMBERS: 1 << 3,
  BAN_MEMBERS: 1 << 4,
  SEND_MESSAGES: 1 << 5,
  VIEW_CHANNEL: 1 << 6,
  MENTION_EVERYONE: 1 << 7,
  MANAGE_BOT: 1 << 8,
  EMBED_LINKS: 1 << 9,
} as const

export const PERM_LABELS: Record<number, string> = {
  [PERMS.ADMINISTRATOR]: 'Administrador',
  [PERMS.MANAGE_CHANNELS]: 'Gerenciar canais',
  [PERMS.MANAGE_ROLES]: 'Gerenciar cargos',
  [PERMS.KICK_MEMBERS]: 'Expulsar membros',
  [PERMS.BAN_MEMBERS]: 'Banir membros',
  [PERMS.SEND_MESSAGES]: 'Enviar mensagens',
  [PERMS.VIEW_CHANNEL]: 'Ver canais',
  [PERMS.MENTION_EVERYONE]: 'Mencionar @everyone',
  [PERMS.MANAGE_BOT]: 'Gerenciar bots',
  [PERMS.EMBED_LINKS]: 'Enviar embeds/links',
}

export const DEFAULT_ROLE_COLORS = ['#5865f2','#57f287','#fee75c','#eb459e','#ed4245','#00a8fc','#f47fff','#ff73fa','#faa61a','#3ba55d']

export const BOT_AVATARS = ['🤖','⚙️','🧠','👾','🦾','💀','👁️','🔮']

export interface CallParticipant { fp: string; nickname: string; muted: boolean; deafened: boolean; speaking: boolean; video: boolean; sharing: boolean }
export interface CallView { call_id: string; kind: 'voice'|'video'|'screen'; conv_id: string; host_fp: string; participants: CallParticipant[]; started_at: number }
export interface GroupDmView { id: string; title: string; members: [string,string][] }
export interface FileSwarmView { file_id: string; name: string; size: number; chunks: number; hash: string; have: number; seeders: string[] }

export interface ReactionSummary {
  msg_id: string
  emoji: string
  count: number
  reactors: string[]
  mine: boolean
  /** Quantas dessas reações são "super" (efeito de brilho na UI). */
  super_count?: number
}

export interface MsgMetaView {
  msg_id: string
  conv_id: string
  reply_to: string
  forwarded_from: string
  edited_body: string
  edited_at: number
  deleted: boolean
  pinned: boolean
  pinned_by: string
  pinned_at: number
  mentioned: boolean
}

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'invisible' | 'offline'

export interface PresenceView {
  fp: string
  status: PresenceStatus
  custom: string
  custom_emoji: string
  updated_at: number
}

export interface ProfileView {
  fp: string
  display_name: string
  about: string
  avatar_b64: string
  banner_b64: string
  accent: string
  updated_at: number
  rev?: number
  content_hash?: string
  /** Gradiente do perfil: '' | 'aurora' | 'sunset' | 'ocean' | 'neon' | 'forest'. */
  profile_theme?: string
  /** Aura do avatar: '' | 'glow' | 'pulse' | 'rainbow' | 'sparkle'. */
  avatar_effect?: string
  /** Emoji de decoração exibido ao lado do nome. */
  decoration?: string
}

export interface ProfilePatch {
  display_name: string
  about: string
  avatar_b64: string
  banner_b64: string
  accent: string
  remove_avatar?: boolean
  remove_banner?: boolean
  profile_theme?: string
  avatar_effect?: string
  decoration?: string
}

export interface ThreadView {
  id: string
  community_id: string
  parent_channel: string
  name: string
  author_fp: string
  created_at: number
  archived: boolean
  kind: string
  tags: string
}

export interface BanView {
  fp: string
  reason: string
  actor_fp: string
  created_at: number
  until_ms: number
}

export interface PollView {
  id: string
  community_id: string
  channel_id: string
  question: string
  options: string[]
  multi: boolean
  author_fp: string
  created_at: number
  ends_at: number
  closed: boolean
}

export interface PollTally {
  counts: number[]
  total: number
  mine: number[]
}

export interface EventView {
  id: string
  community_id: string
  name: string
  description: string
  location: string
  starts_at: number
  ends_at: number
  channel_id: string
  entity_fp: string
  status: 'scheduled' | 'active' | 'completed' | 'canceled' | string
  interested: string[]
}

export interface EmojiView {
  id: string
  community_id: string
  name: string
  char: string
  created_at: number
}

export interface ReadCursor {
  conv_id: string
  last_read_ts: number
  updated_at: number
}

export interface SearchHit {
  id: string
  conv_id: string
  author_fp: string
  body: string
  ts: number
  direction: string
  community_id: string
  channel_id: string
}

export interface SearchQuery {
  text: string
  from: string
  conv: string
  has: string
  before: number
  limit: number
}

export const EMPTY_SEARCH: SearchQuery = { text: '', from: '', conv: '', has: '', before: 0, limit: 50 }

export interface BackgroundPrefsView {
  close_to_tray: boolean
  start_minimized: boolean
  autostart: boolean
  tray: boolean
  notification_permission: string
}

export interface DisTorrentServices {
  kind: 'native' | 'browser'
  version(): Promise<string>
  identityGet(): Promise<Identity | null>
  identityCreate(nickname: string, password?: string | null): Promise<Identity>
  identityRename(nickname: string): Promise<Identity>
  vaultStatus(): Promise<{ has_identity: boolean; has_vault: boolean; locked?: boolean }>
  vaultUnlock(password: string): Promise<Identity>
  localAddresses(port?: number): Promise<LocalAddresses>
  networkStatus(): Promise<NetworkStatusView>
  peersList(): Promise<PeerView[]>
  netDiag(): Promise<NetDiag>
  /** Estado real do firewall do Windows (só no app nativo). */
  firewallStatus(): Promise<FirewallStatus>
  /** Pede ao Windows para liberar o app; devolve o estado DEPOIS da tentativa. */
  firewallAllow(): Promise<FirewallStatus>
  /** Abre a tela "Permitir um aplicativo" do Firewall do Windows (sem UAC). */
  openFirewallConsole(): Promise<FirewallStatus>
  webrtcReport(info: string): Promise<void>

  updateCheck(): Promise<import('./updater').UpdateInfo>
  /** `force` ignora o intervalo de checagem (botão "verificar agora"). */
  updateCheckForce?(): Promise<import('./updater').UpdateInfo>
  /** `boot` = abriu o app: ignora cache e ETag e consulta o GitHub de verdade. */
  updateCheckBoot?(): Promise<import('./updater').UpdateInfo>
  updateDownload(name: string): Promise<string>
  updateApply(path: string): Promise<void>
  updateVerifyReady(path: string): Promise<import('./updater').PendingUpdate>
  updateTrustInfo(): Promise<import('./updater').TrustInfo>
  peerTrustInfo(): Promise<import('./updater').PeerTrustPolicyInfo>
  peerTrustPolicySet(policy: string): Promise<void>
  updateAutoGet(): Promise<boolean>
  updateAutoSet(enabled: boolean): Promise<void>
  updateFlagGet(key: string): Promise<string | null>
  updateFlagSet(key: string, value: string): Promise<void>
  updateCleanup(): Promise<number>
  openReleasePage(url: string): Promise<void>
  openExternal(url: string): Promise<void>
  relayStatus(): Promise<RelayLegStatus[]>
  connectAddr(addr: string, expectedFp?: string | null): Promise<void>
  disconnectPeer(fp: string): Promise<void>
  friendsList(status: string | null): Promise<FriendView[]>
  friendRequest(peerFp: string): Promise<FriendOutcome>
  friendRespond(peerFp: string, accept: boolean): Promise<void>
  friendRemove(peerFp: string): Promise<void>
  friendBlock(peerFp: string): Promise<void>
  friendUnblock(peerFp: string): Promise<void>
  /** Solicitações de amizade aceitas pelo usuário (não bloqueia; só ignora pedidos). */
  friendRequestsEnabled(): Promise<boolean>
  friendRequestsSet(enabled: boolean): Promise<void>
  vaultChange(oldPass: string, newPass: string): Promise<void>
  communitiesList(): Promise<CommunityView[]>
  communityMembers(communityId: string): Promise<MemberPairing[]>
  createCommunity(name: string, channels: string[], opts?: CreateCommunityOptions): Promise<string>
  makeInvite(communityId: string, memberFp?: string): Promise<string>
  makeInviteLink(communityId: string, memberFp?: string): Promise<InviteView>
  joinCommunity(token: string): Promise<string>
  /** Entra num servidor público sem convite (o host aceita direto). */
  joinPublicCommunity(hostFp: string, communityId: string): Promise<string>
  communityRename(communityId: string, name: string): Promise<void>
  communitySetMeta(communityId: string, patch: { description?: string; category?: string; icon?: string }): Promise<void>
  /** Liga/desliga "qualquer um entra". Só o dono muda. */
  communitySetPublic(communityId: string, isPublic: boolean): Promise<void>
  sendChannelMessage(communityId: string, channelId: string, body: string): Promise<StoredMessage>
  conversationsList(): Promise<Conversation[]>
  conversationsOverview(): Promise<ConversationOverview[]>
  dmOpen(peerFp: string, peerNick: string): Promise<Conversation>
  conversationDelete(convId: string): Promise<void>
  messagesList(convId: string): Promise<StoredMessage[]>
  messageSend(convId: string, body: string): Promise<StoredMessage>
  messageResend(msgId: string): Promise<StoredMessage>
  sendTyping?(convId: string): Promise<void>
  subscribe(cb: (ev: EngineEvent) => void): () => void

  privacyGet(): Promise<PrivacySettings>
  privacySet(mode: PrivacyMode): Promise<PrivacySettings>
  proxyAddrGet(mode?: PrivacyMode): Promise<ProxyConfig>
  proxyAddrSet(addr: string, mode?: PrivacyMode): Promise<void>
  proxyTest(addr: string): Promise<number>

  vaultExport(): Promise<{ identity: Identity; vault_blob: string }>
  vaultImport(identityJson: string, vaultBlob: string): Promise<Identity>
  accountsList(): Promise<SavedAccount[]>
  accountSaveImported(identityJson: string, vaultBlob: string): Promise<void>
  accountSwitch(fingerprint: string): Promise<Identity>
  accountRemoveImported(fingerprint: string): Promise<void>

  channelCreate(communityId: string, name: string, opts?: { topic?: string; category?: string; kind?: 'text' | 'voice' | 'video' }): Promise<string>
  channelDelete(communityId: string, channelId: string): Promise<void>
  channelRename(communityId: string, channelId: string, newName: string): Promise<void>
  channelSetTopic(communityId: string, channelId: string, topic: string): Promise<void>
  channelSetCategory(communityId: string, channelId: string, category: string): Promise<void>
  channelList(communityId: string): Promise<ChannelMeta[]>

  roleCreate(communityId: string, data: Omit<RoleView, 'id' | 'community_id' | 'position'> & { position?: number }): Promise<string>
  roleUpdate(communityId: string, roleId: string, patch: Partial<Omit<RoleView, 'id' | 'community_id'>>): Promise<void>
  roleDelete(communityId: string, roleId: string): Promise<void>
  rolesList(communityId: string): Promise<RoleView[]>
  memberRoles(communityId: string, fp: string): Promise<string[]>
  memberAssignRole(communityId: string, fp: string, roleId: string): Promise<void>
  memberUnassignRole(communityId: string, fp: string, roleId: string): Promise<void>
  memberKick(communityId: string, fp: string): Promise<void>

  botCreate(communityId: string, data: { name: string; avatar?: string; roleId?: string | null }): Promise<string>
  botUpdate(communityId: string, botId: string, patch: Partial<Pick<BotView, 'name' | 'avatar' | 'roleId' | 'online' | 'config'>> & { perms?: number; webhookSecret?: string }): Promise<void>
  /** Só informa se o webhook está assinado; o valor do segredo fica no backend. */
  botWebhookSecretSet?(communityId: string, botId: string): Promise<boolean>
  botDelete(communityId: string, botId: string): Promise<void>
  botsList(communityId: string): Promise<BotView[]>
  botPostMessage(communityId: string, channelId: string, botId: string, body: string): Promise<StoredMessage>
  botRegenToken(communityId: string, botId: string): Promise<string>
  /** Execução administrativa validada pelo core. Só existe no app nativo. */
  botAdmin?(communityId: string, botId: string, action: string, target: string, reason: string, number: number | null, channel?: string): Promise<string>
  botLogAppend?(communityId: string, botId: string, level: string, message: string): Promise<void>
  botLogs?(communityId: string, botId: string, limit?: number): Promise<BotLogView[]>
  botLogsClear?(communityId: string, botId: string): Promise<number>
  botVarGet?(communityId: string, botId: string, key: string): Promise<string | null>
  botVarSet?(communityId: string, botId: string, key: string, value: string): Promise<void>
  botVarsList?(communityId: string, botId: string): Promise<[string, string][]>
  botConfigValidate?(config: string): Promise<Record<string, unknown>>
  botWarningsList?(communityId: string, fp: string): Promise<WarnView[]>
  /** Ponte local (`127.0.0.1`) do bot. Só desktop: no Android é ausente. */
  botBridgeStart?(communityId: string, botId: string, port?: number): Promise<BotBridgeInfo>
  botBridgeStop?(communityId: string, botId: string): Promise<boolean>
  botBridgeStatus?(communityId: string, botId: string): Promise<BotBridgeStatus | null>
  botBridgeList?(): Promise<BotBridgeInfo[]>
  /** Abre (ou foca) a janela separada de Bots. Só existe no desktop. */
  openBotsWindow?(): Promise<void>
  /**
   * Áudio do bot. Toca no alto-falante DESTE PC (`delivered: "local"`), não na
   * call. Só existe no Linux com mídia nativa; nas outras plataformas o comando
   * devolve erro explicando.
   */
  botAudioOpen?(communityId: string, botId: string): Promise<boolean>
  botAudioPush?(
    communityId: string,
    botId: string,
    pcmB64: string,
    gain?: number,
  ): Promise<{ accepted: number; dropped: number; delivered: string; to_call: boolean }>
  botAudioStatus?(
    communityId: string,
    botId: string,
  ): Promise<{ accepted: number; dropped: number; delivered: string } | null>
  botAudioClose?(communityId: string, botId: string): Promise<boolean>
  /** Lê uma pasta de bot (`bot.json`) sem gravar. */
  botFolderRead?(dir: string): Promise<BotFolderInfo>
  /** Executa o código do bot (plugin) com a ponte já aberta. */
  botPluginStart?(communityId: string, botId: string, dir: string, run: string): Promise<BotPluginStatus>
  botPluginStop?(communityId: string, botId: string): Promise<boolean>
  botPluginStatus?(communityId: string, botId: string): Promise<BotPluginStatus | null>
  botPluginList?(): Promise<BotPluginStatus[]>
  /** Abre o seletor de pasta do SO. */
  pickFolder?(): Promise<string | null>
  httpFetch(url: string, method: 'GET' | 'POST', headers: Record<string, string>, body: string | null, timeoutMs: number, allowPrivate?: boolean): Promise<{ status: number; body: string }>

  createGroup(title: string, members: string[]): Promise<Conversation>
  groupMembers(convId: string): Promise<[string,string][]>
  groupPairNow?(convId: string): Promise<void>
  communityPairNow?(communityId: string): Promise<void>
  communitySyncNow?(communityId: string): Promise<void>
  groupAdd(convId: string, fp: string): Promise<void>
  groupRemove(convId: string, fp: string): Promise<void>
  groupRename(convId: string, title: string): Promise<void>
  groupLeave(convId: string): Promise<void>
  groupDelete(convId: string): Promise<void>
  groupDeleteLocal(convId: string): Promise<void>

  callRoomPublish(callId: string, convId: string, kind: string, participants: string[]): Promise<void>
  callRoomClose(convId: string): Promise<void>
  callRoomLeave(convId: string): Promise<void>
  callRoomJoin(convId: string, kind: string): Promise<[string, string[]]>
  callRoomsList(): Promise<any[]>

  callInvite(targetFp: string, kind: string): Promise<string>
  callRingRetry(callId: string, targetFp: string, kind: string): Promise<void>
  callAccept(callId: string, fromFp: string): Promise<void>
  callReject(callId: string, fromFp: string, reason: string): Promise<void>
  callEnd(callId: string): Promise<void>
  callOffer(targetFp: string, callId: string, sdp: string): Promise<void>
  callAnswer(targetFp: string, callId: string, sdp: string): Promise<void>
  callIce(targetFp: string, callId: string, candidate: string, mid: string): Promise<void>
  callAddParticipant(targetFp: string, callId: string, fp: string, kind: string): Promise<void>
  screenShareOffer(targetFp: string, callId: string, sdp: string): Promise<void>
  screenShareAnswer(targetFp: string, callId: string, sdp: string): Promise<void>

  voiceJoin(communityId: string, channelId: string): Promise<void>
  voiceLeave(communityId: string, channelId: string): Promise<void>
  voiceState(communityId: string, channelId: string, muted: boolean, deafened: boolean): Promise<void>
  voiceStates(communityId: string, channelId: string): Promise<[string,boolean,boolean][]>

  fileAnnounce(fileId: string, fileName: string, size: number, chunks: number, hash: string, chunkHashes?: string[]): Promise<void>
  fileRequestChunk(fileId: string, index: number, holderFp: string): Promise<void>
  fileSendChunk(targetFp: string, fileId: string, index: number, dataB64: string): Promise<void>

  /** Download em disco: retoma, não estoura a memória e pergunta onde salvar. */
  spoolBegin(fileId: string, size: number, name: string): Promise<{ have: number; bitmap_b64: string; dir: string }>
  spoolPut(fileId: string, index: number, dataB64: string, size: number): Promise<number>
  spoolPutBatch(fileId: string, size: number, entries: [number, string][]): Promise<number>
  spoolGet(fileId: string, index: number, size: number): Promise<string | null>
  spoolBitmap(fileId: string, size: number): Promise<{ have: number; bitmap_b64: string; dir: string }>
  spoolFinish(fileId: string, name: string, size: number, expectBlake3?: string | null): Promise<string>
  spoolDiscard(fileId: string): Promise<void>
  spoolStats(): Promise<{ bytes: number; entries: number }>
  spoolGc(): Promise<number>

  downloadDirGet(): Promise<DownloadDirView>
  downloadDirSet(path: string): Promise<DownloadDirView>
  downloadDirReset(): Promise<DownloadDirView>
  downloadDirBrowse(path?: string | null): Promise<DownloadBrowseView>
  downloadDirOpen(path?: string | null): Promise<void>
  downloadDirSpace(path?: string | null): Promise<{ free_bytes: number; total_bytes: number }>
  seedRegister(fileId: string, name: string, size: number, hash: string, path: string): Promise<SeedEntryView>
  seedUnregister(fileId: string): Promise<void>
  seedList(): Promise<SeedEntryView[]>
  seedReadChunk(fileId: string, index: number, size: number): Promise<string | null>
  cacheGetTtl(): Promise<number>
  cacheSetTtl(days: number): Promise<void>

  serverRulesGet(communityId: string): Promise<ServerRules>
  serverRulesSet(rules: ServerRules): Promise<void>
  auditList(communityId: string, limit?: number): Promise<AuditEntry[]>
  reputationGet(fp: string): Promise<ReputationView>
  safetyNumber(peerFp: string): Promise<string>
  moderate(communityId: string, action: ModerationAction, target: string, reason?: string): Promise<void>
  reportUser(targetFp: string, communityId?: string, reason?: string): Promise<void>
  validateName(kind: NameKind, raw: string, existing?: string[]): Promise<NameCheckView>
  randomName(): Promise<string>

  stormvaultExport(password: string, opts?: { includeSecret?: boolean; maxMessages?: number }): Promise<StormVaultExportResult>
  stormvaultImportFile(contentB64: string, password: string): Promise<VaultImportReport>
  stormvaultBackupsList(): Promise<VaultBackupInfo[]>
  stormvaultBackupNow(): Promise<VaultBackupInfo>
  stormvaultBackupRestore(file: string): Promise<VaultImportReport>
  stormvaultBackupSetRetention(days: number): Promise<void>
  stormvaultBackupGetRetention(): Promise<number>
  vaultWipe(confirm: string): Promise<WipeReport>
  messagesWindow(convId: string, beforeTs: number | null, limit: number): Promise<StoredMessage[]>
  metricsSnapshot(): Promise<Record<string, unknown>>
  peerRtt(fp: string): Promise<number | null>
  cacheGet(key: string): Promise<string | null>
  cachePut(key: string, dataB64: string): Promise<void>
  cacheDelete(key: string): Promise<void>
  cacheStats(): Promise<CacheStats>
  cacheSetCap(capMb: number): Promise<void>
  mediaSafetyGet(): Promise<MediaSafetySettings>
  mediaSafetySet(stripExif: boolean, blockExecutables: boolean): Promise<void>
  retentionGet(): Promise<import('./models').RetentionSettings>
  retentionSet(days: number, servers: boolean, groups: boolean, dms: boolean): Promise<import('./models').RetentionSettings>
  retentionRun(): Promise<number>

  voiceMediaAvailable(): Promise<boolean>
  voiceMediaStats(callId: string): Promise<VoiceMediaStats | null>
  voiceSetMuted(callId: string, muted: boolean): Promise<void>
  voiceSetDeafened(callId: string, deafened: boolean): Promise<void>
  voiceHangup(callId: string): Promise<void>
  voiceVideoStart(callId: string, peerFp: string, source: 'camera' | 'screen', monitorId?: number | null): Promise<string>
  voiceVideoStop(callId: string, peerFp: string): Promise<void>
  voiceVideoFrame(callId: string, peerFp: string, sinceSeq?: number | null): Promise<NativeVideoFrame | null>
  voiceMicTestStart(): Promise<number>
  voiceMicTestLevel(testId: number): Promise<number>
  voiceMicTestStop(testId: number): Promise<void>
  voiceMicName(): Promise<string>

  react(convId: string, msgId: string, emoji: string, superReact?: boolean): Promise<boolean>
  reactions(msgId: string): Promise<ReactionSummary[]>
  reactionsBulk(msgIds: string[]): Promise<ReactionSummary[]>
  reply(convId: string, msgId: string, replyTo: string): Promise<void>
  editMessage(convId: string, msgId: string, body: string): Promise<void>
  deleteMessage(convId: string, msgId: string): Promise<void>
  pin(convId: string, msgId: string, pinned: boolean): Promise<void>
  pins(convId: string): Promise<MsgMetaView[]>
  metaBulk(msgIds: string[]): Promise<MsgMetaView[]>
  /** [msg_id, fp, instante] — quem visualizou cada mensagem. */
  messageReceipts(msgIds: string[]): Promise<[string, string, number][]>
  effectiveBodies(msgIds: string[]): Promise<[string, string][]>
  forward(srcMsgId: string, targetConv: string, targetChannel: string, fromLabel: string): Promise<StoredMessage>

  readSet(convId: string, ts: number): Promise<void>
  readAll(): Promise<ReadCursor[]>
  unreadCount(convId: string): Promise<number>
  dmIntroState(convId: string): Promise<DmIntroState>
  unreadMentions(): Promise<number>

  presenceSet(status: PresenceStatus, custom: string, customEmoji: string): Promise<void>
  presenceList(): Promise<PresenceView[]>

  backgroundPrefs(): Promise<BackgroundPrefsView>
  backgroundPrefsSet(patch: { closeToTray?: boolean; startMinimized?: boolean }): Promise<void>
  autostartGet(): Promise<boolean>
  autostartSet(enabled: boolean): Promise<boolean>
  autostartEnsure(): Promise<boolean>
  notificationShow(args: {
    id: number
    title: string
    body: string
    conversation?: string | null
    silent?: boolean
  }): Promise<void>
  notificationCancel(id: number): Promise<void>
  notificationCancelAll(): Promise<void>
  notificationPermission(): Promise<string>
  notificationRequestPermission(): Promise<string>
  notifyPrefsSet(system: boolean, preview: boolean, policy?: string | null): Promise<void>
  /** Batida de vida: evita aviso duplicado entre o Rust e o frontend. */
  notifyUiAlive?(): Promise<void>
  backgroundServiceSet(on: boolean): Promise<boolean>
  callPendingAction(): Promise<{ action: string; call_id: string }>
  callNotifyShow(callId: string, title: string, body: string): Promise<void>
  callNotifyCancel(callId: string): Promise<void>
  appShowWindow(): Promise<void>
  appHideToTray(): Promise<void>
  hideShareBar(): Promise<void>
  shareBarWatch(ativo: boolean): Promise<void>
  appQuit(): Promise<void>
  windowToggleFullscreen(): Promise<boolean>
  backgroundSetConnection(state: string, onlinePeers: number, unread?: number): Promise<void>
  presenceGet(fp: string): Promise<PresenceView>
  profileSet(patch: ProfilePatch): Promise<ProfileView>
  profileGet(fp: string): Promise<ProfileView>
  profileList(): Promise<ProfileView[]>
  profileSyncNow(): Promise<void>
  nicknameSet(communityId: string, fp: string, nickname: string): Promise<void>
  nicknameGet(communityId: string, fp: string): Promise<string>

  searchMessages(q: SearchQuery): Promise<SearchHit[]>
  messagesAround(convId: string, ts: number, limit: number): Promise<StoredMessage[]>

  threadCreate(communityId: string, parentChannel: string, name: string, kind?: string, tags?: string): Promise<ThreadView>
  threadList(communityId: string, parentChannel: string): Promise<ThreadView[]>
  threadMessages(threadId: string, limit?: number): Promise<StoredMessage[]>
  threadSend(communityId: string, threadId: string, body: string): Promise<StoredMessage>
  threadArchive(threadId: string, archived: boolean): Promise<void>

  ban(communityId: string, fp: string, untilMs: number, reason: string): Promise<void>
  unban(communityId: string, fp: string): Promise<void>
  timeout(communityId: string, fp: string, untilMs: number, reason: string): Promise<void>
  banList(communityId: string): Promise<BanView[]>
  timeoutList(communityId: string): Promise<BanView[]>
  channelCfgSet(communityId: string, channelId: string, slowmodeSecs: number, nsfw: boolean): Promise<void>
  channelCfgGet(channelId: string): Promise<number>

  pollCreate(communityId: string, channelId: string, question: string, options: string[], multi: boolean, endsAt: number): Promise<PollView>
  pollList(communityId: string, channelId: string): Promise<PollView[]>
  pollVote(communityId: string, channelId: string, pollId: string, optionIdx: number): Promise<void>
  pollTally(pollId: string): Promise<PollTally>

  eventUpsert(ev: EventView): Promise<void>
  eventList(communityId: string): Promise<EventView[]>
  eventInterest(communityId: string, eventId: string): Promise<void>
  eventDelete(communityId: string, eventId: string): Promise<void>

  emojiUpsert(e: EmojiView): Promise<void>
  emojiList(communityId: string): Promise<EmojiView[]>
  emojiDelete(communityId: string, id: string): Promise<void>

  bookmarkSet(convId: string, name: string, payload: string): Promise<void>
  bookmarkList(convId: string): Promise<[string, string][]>
}

export interface VaultHeaderInfo {
  fp: string
  nickname: string
  msg_count: number
  created_ms: number
  v: number
}

export interface StormVaultExportResult {
  path: string
  bytes: number
  header: VaultHeaderInfo
}

export interface VaultImportReport {
  fp: string
  nickname: string
  created_ms: number
  identity_installed: boolean
  messages_merged: number
  message_conflicts: number
  conversations_added: number
  friends_merged: number
  peers_merged: number
  communities_merged: number
  rules_merged: number
  reputations_merged: number
  audit_merged: number
  reports_merged: number
  groups_merged: number
  settings_imported: number
  messages_truncated: boolean
  /** Perfis sociais (avatar/banner/status) mesclados. */
  profiles_merged: number
  /** Reações, pins, reads, bookmarks, polls etc. mesclados. */
  social_merged: number
  /** Versão do CONTEÚDO do cofre: 1 = antigo (só histórico), 2 = completo. */
  data_version: number
}

export interface WipeReport {
  leftovers: string[]
}

export interface VaultBackupInfo {
  file: string
  created_ms: number
  bytes: number
}

export interface CacheStats {
  cap_mb: number
  total_bytes: number
  entries: number
}

/** Pasta escolhida para os downloads (vazia = Downloads do sistema). */
export interface DownloadDirView {
  dir: string
  is_default: boolean
}

export interface DownloadBrowseView {
  path: string
  parent: string | null
  dirs: { name: string; path: string }[]
  drives: string[]
}

/** Arquivo no disco que continua sendo semeado depois de reabrir o app. */
export interface SeedEntryView {
  file_id: string
  name: string
  size: number
  chunks: number
  hash: string
  path: string
}

export interface MediaSafetySettings {
  strip_exif: boolean
  block_executables: boolean
}

export interface RetentionSettings {
  days: number
  servers: boolean
  groups: boolean
  dms: boolean
}

export type SpamLevel = 'low' | 'medium' | 'high'
export type TrustLevel = 'new' | 'trusted' | 'suspicious' | 'banned'
export type NameKind = 'user' | 'server' | 'channel'
export type ModerationAction = 'ban' | 'unban' | 'mute' | 'unmute' | 'shadow_ban' | 'unshadow' | 'delete_msg'

export interface ServerRules {
  community_id: string
  spam_level: string
  banned_words: string[]
  blocked_domains: string[]
  moderators: string[]
  shadow_banned: string[]
  updated_at: number
}

export interface AuditEntry {
  id: string
  community_id: string
  actor_fp: string
  action: string
  target_fp: string
  reason: string
  created_at: number
}

export interface ReputationView {
  trust: TrustLevel
  score: number
  reports: number
}

export interface VoiceMediaStats {
  state: string
  route: string
  jitter_depth_ms: number
  packets_in: number
  packets_out: number
  plc_frames: number
  decode_errors: number
  rtt_ms: number | null
  mic_error?: string | null
  speaker_error?: string | null
  video_state?: string | null
  video_codec?: string | null
  video_source?: string | null
  video_error?: string | null
  video_packets_in?: number | null
  frames_in?: number | null
  frames_out?: number | null
  peers_connected?: number | null
  peers_total?: number | null
}

export interface NativeVideoFrame {
  jpeg?: string
  w: number
  h: number
  seq: number
}

export interface NameCheckView {
  ok: boolean
  normalized: string
  errors: string[]
  suggestions: string[]
}
