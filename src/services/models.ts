// Tipos espelhados do forge-core (Rust) — contrato único entre UI e motor.
// Nada aqui é mock: reflete exatamente o que o engine produce.

export type NetworkState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING'

export type MessageStatus = 'pending' | 'sending' | 'sent' | 'delivered' | 'failed' | 'ok'

// Modos de privacidade — minimalista.
// normal = sem cripto, encrypted = com cripto, proxy = com cripto + 1 proxy (esconde IP), full = Tor 7 nós

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
    description: 'Com criptografia + 1 proxy para esconder seu IP. Relay e descoberta desligados neste modo.',
    flags: { encryption: true, tor_proxy: false, udp_discovery: false, metadata_padding: false, traffic_obfuscation: true },
    crypto_chain: ['1 proxy + X25519 + ChaCha20'],
    data_flow: 'Você → Proxy → Peer',
    pros: [], cons: [], residual_risk: [],
  },
  {
    mode: 'full',
    label: 'Tor — 7 nós',
    description: 'Criptografia + 7 proxies Tor para esconder seu IP. Relay, descoberta e STUN do app não passam pelo Tor — chamadas usam STUN direto.',
    flags: { encryption: true, tor_proxy: true, udp_discovery: false, metadata_padding: true, traffic_obfuscation: true },
    crypto_chain: ['Tor 7 hops + X25519 + ChaCha20'],
    data_flow: 'Você → Tor ×7 → Peer',
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
  /** Diagnóstico real do motor (por que conecta ou não) */
  last_direct_error?: string | null
  last_relay_error?: string | null
  direct_attempts?: number
  relay_attempts?: number
  announce_seen_ms?: number
}

export interface NetDiag {
  stun_ok: boolean | null
  stun_addr: string | null
  stun_ms: number
  announce_addr: string | null
  announce_ms: number
  /** Origem do endpoint NAT: 'upnp' (local, sem servidor) | 'stun' | null */
  nat_source: string | null
  /** DHT mainline BitTorrent — null = desligada (testes/proxy/Tor) */
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

export interface StoredMessage {
  id: string
  conv_id: string
  author_fp: string
  body: string
  ts: number
  sig: string
  direction: 'in' | 'out' | string
  status: MessageStatus
  /** Não-vazio quando a mensagem foi postada POR UM BOT (id do BotRow). */
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
  /** Metadados do wizard (v6) — ausentes em comunidades legadas. */
  description?: string
  category?: string
  icon?: string
}

// --- Sistema de Canais / Cargos / Bots (estilo Discord) ---

export interface ChannelMeta {
  id: string
  name: string
  topic?: string
  category: string
  position: number
  /** "forum" = canal de fórum: só posts (threads) com título */
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
  /** Config JSON do runtime web (prefixo, comandos REST, escopos, webhook). */
  config?: string
}

/** Canal inicial do wizard: nome + tipo + categoria. */
export interface CommunityChannelSeed { name: string; kind: 'text' | 'voice' | 'video'; category: string }
/** Cargo inicial do wizard (presets admin/moderador/membro). */
export interface CommunityRoleSeed { name: string; color: string; permissions: number; hoist: boolean; mentionable: boolean }

/** Opções estendidas do createCommunity (wizard) — tudo opcional p/ compat. */
export interface CreateCommunityOptions {
  description?: string
  category?: string
  /** Emoji/ícone de 1-2 chars exibido no rail (vazio = inicial do nome). */
  icon?: string
  /** Texto de regras do servidor (vai para server_rules como moderadores=[]) */
  rulesText?: string
  /** Canais com tipo/categoria — quando presente substitui o CSV simples. */
  channelsMeta?: CommunityChannelSeed[]
  /** Cargos criados já no ato (ex.: Admin/Moderador/Membro). */
  roles?: CommunityRoleSeed[]
}

export interface MemberRoleAssignment {
  fp: string
  roleIds: string[]
}

// Bitmask de permissões (compatível com Discord para familiaridade)
export const PERMS = {
  ADMINISTRATOR: 1 << 0,   // 1
  MANAGE_CHANNELS: 1 << 1, // 2
  MANAGE_ROLES: 1 << 2,    // 4
  KICK_MEMBERS: 1 << 3,    // 8
  BAN_MEMBERS: 1 << 4,     // 16
  SEND_MESSAGES: 1 << 5,   // 32
  VIEW_CHANNEL: 1 << 6,    // 64
  MENTION_EVERYONE: 1 << 7, // 128
  MANAGE_BOT: 1 << 8,      // 256
  EMBED_LINKS: 1 << 9,     // 512
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


// =====================================================================
// CAMADA SOCIAL v3 — espelha `forge_core::social` (nada aqui é mock)
// =====================================================================

export interface ReactionSummary {
  msg_id: string
  emoji: string
  count: number
  reactors: string[]
  /** a reação inclui VOCÊ (contador destacado) */
  mine: boolean
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
}

export interface ThreadView {
  id: string
  community_id: string
  parent_channel: string
  name: string
  author_fp: string
  created_at: number
  archived: boolean
  /** "thread" (a partir de mensagem) | "forum" (post de fórum) */
  kind: string
  tags: string
}

export interface BanView {
  fp: string
  reason: string
  actor_fp: string
  created_at: number
  /** 0 = permanente */
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
  /** filtro from: */
  from: string
  /** filtro in: */
  conv: string
  /** has: link | file | mention */
  has: string
  /** filtro before: (ts) */
  before: number
  limit: number
}

export const EMPTY_SEARCH: SearchQuery = { text: '', from: '', conv: '', has: '', before: 0, limit: 50 }

export interface ForgeServices {
  kind: 'native' | 'browser'
  version(): Promise<string>
  identityGet(): Promise<Identity | null>
  identityCreate(nickname: string, password?: string | null): Promise<Identity>
  identityRename(nickname: string): Promise<Identity>
  vaultStatus(): Promise<{ has_identity: boolean; has_vault: boolean }>
  vaultUnlock(password: string): Promise<Identity>
  networkStatus(): Promise<NetworkStatusView>
  peersList(): Promise<PeerView[]>
  /** Diagnóstico global: STUN (binding NAT) e endpoint anunciado */
  netDiag(): Promise<NetDiag>
  /** Relata ao Rust o que a página enxerga de WebRTC (diagnóstico do WebKitGTK). */
  webrtcReport(info: string): Promise<void>
  relayStatus(): Promise<RelayLegStatus[]>
  connectAddr(addr: string, expectedFp?: string | null): Promise<void>
  disconnectPeer(fp: string): Promise<void>
  friendsList(status: string | null): Promise<FriendView[]>
  friendRequest(peerFp: string): Promise<FriendOutcome>
  friendRespond(peerFp: string, accept: boolean): Promise<void>
  friendRemove(peerFp: string): Promise<void>
  friendBlock(peerFp: string): Promise<void>
  friendUnblock(peerFp: string): Promise<void>
  vaultChange(oldPass: string, newPass: string): Promise<void>
  communitiesList(): Promise<CommunityView[]>
  createCommunity(name: string, channels: string[], opts?: CreateCommunityOptions): Promise<string>
  makeInvite(communityId: string, memberFp: string): Promise<string>
  joinCommunity(token: string): Promise<string>
  communityRename(communityId: string, name: string): Promise<void>
  /** Atualiza descrição/categoria/ícone (dono) — espelha o wizard. */
  communitySetMeta(communityId: string, patch: { description?: string; category?: string; icon?: string }): Promise<void>
  sendChannelMessage(communityId: string, channelId: string, body: string): Promise<StoredMessage>
  conversationsList(): Promise<Conversation[]>
  dmOpen(peerFp: string, peerNick: string): Promise<Conversation>
  conversationDelete(convId: string): Promise<void>
  messagesList(convId: string): Promise<StoredMessage[]>
  messageSend(convId: string, body: string): Promise<StoredMessage>
  sendTyping?(convId: string): Promise<void>
  subscribe(cb: (ev: EngineEvent) => void): () => void

  // Privacidade
  privacyGet(): Promise<PrivacySettings>
  privacySet(mode: PrivacyMode): Promise<PrivacySettings>
  proxyAddrGet(): Promise<ProxyConfig>
  proxyAddrSet(addr: string): Promise<void>
  /** Teste ONLINE do proxy: RTT do 1º circuito que abrir nos brokers do relay */
  proxyTest(addr: string): Promise<number>

  // Vault export/import
  vaultExport(): Promise<{ identity: Identity; vault_blob: string }>
  vaultImport(identityJson: string, vaultBlob: string): Promise<Identity>
  accountsList(): Promise<SavedAccount[]>
  accountSaveImported(identityJson: string, vaultBlob: string): Promise<void>
  accountSwitch(fingerprint: string): Promise<Identity>
  accountRemoveImported(fingerprint: string): Promise<void>

  // Canais — gestão completa
  channelCreate(communityId: string, name: string, opts?: { topic?: string; category?: string; kind?: 'text' | 'voice' | 'video' }): Promise<string>
  channelDelete(communityId: string, channelId: string): Promise<void>
  channelRename(communityId: string, channelId: string, newName: string): Promise<void>
  channelSetTopic(communityId: string, channelId: string, topic: string): Promise<void>
  channelSetCategory(communityId: string, channelId: string, category: string): Promise<void>
  channelList(communityId: string): Promise<ChannelMeta[]>

  // Cargos
  roleCreate(communityId: string, data: Omit<RoleView, 'id' | 'community_id' | 'position'> & { position?: number }): Promise<string>
  roleUpdate(communityId: string, roleId: string, patch: Partial<Omit<RoleView, 'id' | 'community_id'>>): Promise<void>
  roleDelete(communityId: string, roleId: string): Promise<void>
  rolesList(communityId: string): Promise<RoleView[]>
  memberRoles(communityId: string, fp: string): Promise<string[]>
  memberAssignRole(communityId: string, fp: string, roleId: string): Promise<void>
  memberUnassignRole(communityId: string, fp: string, roleId: string): Promise<void>
  memberKick(communityId: string, fp: string): Promise<void>

  // Bots
  botCreate(communityId: string, data: { name: string; avatar?: string; roleId?: string | null }): Promise<string>
  botUpdate(communityId: string, botId: string, patch: Partial<Pick<BotView, 'name' | 'avatar' | 'roleId' | 'online' | 'config'>>): Promise<void>
  botDelete(communityId: string, botId: string): Promise<void>
  botsList(communityId: string): Promise<BotView[]>
  /** Posta mensagem COMO O BOT (dono ou quem tem MANAGE_BOT). */
  botPostMessage(communityId: string, channelId: string, botId: string, body: string): Promise<StoredMessage>
  /** Gera novo token (dono) — invalida o antigo. */
  botRegenToken(communityId: string, botId: string): Promise<string>
  /** HTTP REST para o runtime de bots (nativo: reqwest no shell, sem CORS). */
  httpFetch(url: string, method: 'GET' | 'POST', headers: Record<string, string>, body: string | null, timeoutMs: number): Promise<{ status: number; body: string }>

  // Grupos DM (estilo Discord)
  createGroup(title: string, members: string[]): Promise<Conversation>
  groupMembers(convId: string): Promise<[string,string][]>
  groupAdd(convId: string, fp: string): Promise<void>

  // Chamadas (voice/video + screen share) — mesh P2P onde todos semeiam
  callInvite(targetFp: string, kind: string): Promise<string>
  callAccept(callId: string, fromFp: string): Promise<void>
  callReject(callId: string, fromFp: string, reason: string): Promise<void>
  callEnd(callId: string): Promise<void>
  callOffer(targetFp: string, callId: string, sdp: string): Promise<void>
  callAnswer(targetFp: string, callId: string, sdp: string): Promise<void>
  callIce(targetFp: string, callId: string, candidate: string, mid: string): Promise<void>
  /** Grupo: avisa o peer sobre novo participante da chamada (mesh real).
   *  `kind` não-vazio faz o receptor TOCAR (ring do novo convidado). */
  callAddParticipant(targetFp: string, callId: string, fp: string, kind: string): Promise<void>
  /** Sinal dedicado de tela: avisa o receptor que o vídeo é TELA (badge). */
  screenShareOffer(targetFp: string, callId: string, sdp: string): Promise<void>
  screenShareAnswer(targetFp: string, callId: string, sdp: string): Promise<void>

  // Voz em servidor
  voiceJoin(communityId: string, channelId: string): Promise<void>
  voiceLeave(communityId: string, channelId: string): Promise<void>
  voiceState(communityId: string, channelId: string, muted: boolean, deafened: boolean): Promise<void>
  voiceStates(communityId: string, channelId: string): Promise<[string,boolean,boolean][]>

  // Arquivos swarm (todos semeiam)
  fileAnnounce(fileId: string, fileName: string, size: number, chunks: number, hash: string, chunkHashes?: string[]): Promise<void>
  fileRequestChunk(fileId: string, index: number, holderFp: string): Promise<void>
  fileSendChunk(targetFp: string, fileId: string, index: number, dataB64: string): Promise<void>

  // Segurança / anti-spam / moderação (Storm)
  serverRulesGet(communityId: string): Promise<ServerRules>
  serverRulesSet(rules: ServerRules): Promise<void>
  auditList(communityId: string, limit?: number): Promise<AuditEntry[]>
  reputationGet(fp: string): Promise<ReputationView>
  safetyNumber(peerFp: string): Promise<string>
  moderate(communityId: string, action: ModerationAction, target: string, reason?: string): Promise<void>
  reportUser(targetFp: string, communityId?: string, reason?: string): Promise<void>
  validateName(kind: NameKind, raw: string, existing?: string[]): Promise<NameCheckView>
  randomName(): Promise<string>

  // Cofre portátil .stormvault (5.4) — conta inteira cifrada, sem servidor
  stormvaultExport(password: string, opts?: { includeSecret?: boolean; maxMessages?: number }): Promise<StormVaultExportResult>
  stormvaultImportFile(contentB64: string, password: string): Promise<VaultImportReport>
  stormvaultBackupsList(): Promise<VaultBackupInfo[]>
  stormvaultBackupNow(): Promise<VaultBackupInfo>
  stormvaultBackupRestore(file: string): Promise<VaultImportReport>
  stormvaultBackupSetRetention(days: number): Promise<void>
  stormvaultBackupGetRetention(): Promise<number>
  vaultWipe(confirm: string): Promise<WipeReport>
  // Mensagens — janela por timestamp (paginação; beforeTs=null = mais recentes)
  messagesWindow(convId: string, beforeTs: number | null, limit: number): Promise<StoredMessage[]>
  // Observabilidade (painel dev) + RTT por peer
  metricsSnapshot(): Promise<Record<string, unknown>>
  peerRtt(fp: string): Promise<number | null>
  // Cache LRU de disco (nativo; browser = localStorage)
  cacheGet(key: string): Promise<string | null>
  cachePut(key: string, dataB64: string): Promise<void>
  cacheDelete(key: string): Promise<void>
  cacheStats(): Promise<CacheStats>
  cacheSetCap(capMb: number): Promise<void>
  // Segurança de mídia
  mediaSafetyGet(): Promise<MediaSafetySettings>
  mediaSafetySet(stripExif: boolean, blockExecutables: boolean): Promise<void>

  // Voz NATIVA (webrtc-rs + cpal + Opus). Leitura/controle apenas: a
  // negociação acontece no core, em Rust. No browser (e em qualquer build sem
  // a camada) `voiceMediaAvailable` é false e os demais viram no-op, então o
  // WebRTC do navegador continua responsável — sem mudança de comportamento.
  voiceMediaAvailable(): Promise<boolean>
  voiceMediaStats(callId: string): Promise<VoiceMediaStats | null>
  voiceSetMuted(callId: string, muted: boolean): Promise<void>
  voiceHangup(callId: string): Promise<void>

  // ================= CAMADA SOCIAL v3 (paridade Discord) =================
  react(convId: string, msgId: string, emoji: string): Promise<boolean>
  reactions(msgId: string): Promise<ReactionSummary[]>
  reactionsBulk(msgIds: string[]): Promise<ReactionSummary[]>
  reply(convId: string, msgId: string, replyTo: string): Promise<void>
  editMessage(convId: string, msgId: string, body: string): Promise<void>
  deleteMessage(convId: string, msgId: string): Promise<void>
  pin(convId: string, msgId: string, pinned: boolean): Promise<void>
  pins(convId: string): Promise<MsgMetaView[]>
  metaBulk(msgIds: string[]): Promise<MsgMetaView[]>
  /** (msg_id, corpo efetivo) — edição aplicada, exclusão marcada */
  effectiveBodies(msgIds: string[]): Promise<[string, string][]>
  forward(srcMsgId: string, targetConv: string, targetChannel: string, fromLabel: string): Promise<StoredMessage>

  readSet(convId: string, ts: number): Promise<void>
  readAll(): Promise<ReadCursor[]>
  unreadCount(convId: string): Promise<number>
  unreadMentions(): Promise<number>

  presenceSet(status: PresenceStatus, custom: string, customEmoji: string): Promise<void>
  presenceList(): Promise<PresenceView[]>
  presenceGet(fp: string): Promise<PresenceView>
  profileSet(patch: { display_name: string; about: string; avatar_b64: string; banner_b64: string; accent: string }): Promise<ProfileView>
  profileGet(fp: string): Promise<ProfileView>
  profileList(): Promise<ProfileView[]>
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
}

export interface WipeReport {
  /** .stormvault exportados que sobrevivem em Downloads (apagar manualmente). */
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

export interface MediaSafetySettings {
  strip_exif: boolean
  block_executables: boolean
}

// --- Segurança (espelha forge-core moderation/names) ---

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

/**
 * Estado da camada de voz NATIVA (webrtc-rs + cpal + Opus), espelhando
 * `forge_core::net::media_voice::VoiceStats`. Nomes em snake_case porque o
 * struct é serializado direto pelo Rust.
 *
 * `null` em `voiceMediaStats` = a chamada NÃO é nativa (ou não há mídia
 * nativa neste aparelho). Nesse caso a UI usa o relatório de
 * `RTCPeerConnection` do navegador — o caminho que já funciona em
 * Windows/Android/macOS.
 */
export interface VoiceMediaStats {
  /** "idle" | "connecting" | "connected" | "failed" */
  state: string
  /** "LAN" | "STUN" | "TURN" | "n/d" */
  route: string
  /** Profundidade do jitter buffer em ms (50 = interativo). */
  jitter_depth_ms: number
  packets_in: number
  packets_out: number
  /** frames mascarados por perda (Opus PLC). */
  plc_frames: number
  decode_errors: number
  rtt_ms: number | null
}

export interface NameCheckView {
  ok: boolean
  normalized: string
  errors: string[]
  suggestions: string[]
}
