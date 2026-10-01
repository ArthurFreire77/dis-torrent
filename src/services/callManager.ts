// CallManager — mesh WebRTC onde todos semeiam (relay) igual BitTorrent
// Cada peer mantém RTCPeerConnection para cada outro participante (full-mesh).
// Sinalização via forge-core SecureFrame (cifrado) — no browser fallback via localStorage/BroadcastChannel.

import { services } from './index'
import { hmac } from '@noble/hashes/hmac.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { type CallEvent, type CallPhase, nextCallPhase, isCallPhaseActive } from './callPhases'
import type { VoiceMediaStats } from './models'
import {
  detectScreenEnvironment,
  buildDisplayMediaConstraints,
  classifyScreenShareError,
  applyScreenConstraints,
  applySenderTuning,
  setScreenContentHint,
  ScreenShareError,
  ScreenCaptureMonitor,
  ScreenStatsCollector,
  normalizeOptions,
  isScreenSampleBad,
  lowerScreenQuality,
  SCREEN_DEFAULT_OPTIONS,
  type ScreenShareOptions,
  type ScreenShareMetrics,
  type ScreenShareErrorCode,
  type ScreenEnvironment,
  emptyScreenMetrics,
} from './screenShare'

export type CallKind = 'voice' | 'video' | 'screen'

/** Ring de chamada entrante. `nickname` é o que a UI mostra (nome > fp). */
export interface IncomingCall {
  call_id: string
  from_fp: string
  kind: string
  nickname?: string
}

export type CallQuality = '480p' | '720p' | '1080p' | '4K'

export const CALL_QUALITY_KEY = 'forge:call_quality'
export const TURN_URL_KEY = 'forge:turn_url'
export const QUALITY_ORDER: CallQuality[] = ['480p', '720p', '1080p', '4K']

export const QUALITY_CONSTRAINTS: Record<CallQuality, MediaTrackConstraints> = {
  // Piso 480p em todas: nunca abaixo de 640x480. Teto de FPS 120 — o browser
  // negocia o que o dispositivo/câmera/rede suportam (ideal alto, max 120);
  // estabilidade vem do monitor adaptativo (pollStats rebaixa se houver perda).
  '480p': { width: { min: 640, ideal: 640, max: 1280 }, height: { min: 480, ideal: 480, max: 720 }, frameRate: { min: 24, ideal: 60, max: 120 } },
  '720p': { width: { min: 640, ideal: 1280, max: 1920 }, height: { min: 480, ideal: 720, max: 1080 }, frameRate: { min: 24, ideal: 60, max: 120 } },
  '1080p': { width: { min: 640, ideal: 1920, max: 1920 }, height: { min: 480, ideal: 1080, max: 1080 }, frameRate: { min: 24, ideal: 60, max: 120 } },
  '4K': { width: { min: 640, ideal: 3840, max: 3840 }, height: { min: 480, ideal: 2160, max: 2160 }, frameRate: { min: 24, ideal: 60, max: 120 } },
}

/**
 * CÂMERA adaptativa: piso 480p, teto 1080p/120fps. `ideal` é pedido, não
 * ordem — o navegador entrega o mais próximo que câmera/driver suportar.
 * ideal 60 (não 120) de propósito: 120 força CPU/GPU e rede em celular;
 * com max:120 o dispositivo que SUPORTA sobe sozinho, e o diagnóstico mostra
 * o limite real via getCapabilities/getSettings (ver probeVideoLimits).
 * O seletor de qualidade vale para CÂMERA e TELA (antes era só tela).
 */
export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { min: 640, ideal: 1280, max: 1920 },
  height: { min: 480, ideal: 720, max: 1080 },
  frameRate: { min: 24, ideal: 60, max: 120 },
}

/**
 * Limite REAL do dispositivo (para exibir "seu aparelho entrega até X").
 * Lê capabilities/settings da track viva; sem track, tenta capabilities do
 * dispositivo via getUserMedia temporário? Não — sem track retorna null
 * honesto (diagnóstico mostra "desconhecido, sem câmera ativa").
 */
export interface VideoDeviceLimits {
  maxWidth: number | null
  maxHeight: number | null
  maxFrameRate: number | null
  curWidth: number | null
  curHeight: number | null
  curFrameRate: number | null
}
export function probeVideoLimits(track?: MediaStreamTrack | null): VideoDeviceLimits | null {
  try {
    if (!track || track.kind !== 'video' || track.readyState !== 'live') return null
    const caps: any = typeof (track as any).getCapabilities === 'function' ? (track as any).getCapabilities() : null
    const st: any = typeof track.getSettings === 'function' ? track.getSettings() : {}
    const num = (v: any): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    return {
      maxWidth: num(caps?.width?.max) ?? null,
      maxHeight: num(caps?.height?.max) ?? null,
      maxFrameRate: num(caps?.frameRate?.max) ?? null,
      curWidth: num(st?.width) ?? null,
      curHeight: num(st?.height) ?? null,
      curFrameRate: num(st?.frameRate) ?? null,
    }
  } catch { return null }
}
/** Texto honesto do limite: "até 1280x720@60" ou null se desconhecido. */
export function formatVideoLimits(l: VideoDeviceLimits | null): string | null {
  try {
    if (!l) return null
    const w = l.curWidth ?? l.maxWidth
    const h = l.curHeight ?? l.maxHeight
    const f = l.curFrameRate ?? l.maxFrameRate
    if (!w || !h) return null
    return `até ${w}x${h}${f ? `@${Math.round(f)}` : ''}`
  } catch { return null }
}

export function getStoredQuality(): CallQuality {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem(CALL_QUALITY_KEY) : null
    if (v === '480p' || v === '720p' || v === '1080p' || v === '4K') return v
  } catch { /* ignore */ }
  return '720p'
}

export function isValidTurnUrl(u: string): boolean {
  const v = (u ?? '').trim()
  if (!(v.startsWith('turn:') || v.startsWith('turns:'))) return false
  const rest = v.replace(/^turns?:/, '')
  // exige host após o esquema (ex.: turn:host:porta) e proíbe espaços
  return rest.length > 0 && !rest.startsWith('/') && !/\s/.test(v)
}

export function getTurnUrl(): string {
  try {
    return typeof localStorage !== 'undefined' ? (localStorage.getItem(TURN_URL_KEY) ?? '') : ''
  } catch { return '' }
}

export function lowerQuality(q: CallQuality): CallQuality | null {
  const i = QUALITY_ORDER.indexOf(q)
  return i > 0 ? QUALITY_ORDER[i - 1] : null
}

/** Amostra ruim quando há perda relevante ou jitter alto (valores por janela de 5s). */
export function isBadStatsSample(packetsLostDelta: number, jitter: number): boolean {
  return packetsLostDelta > 20 || jitter > 0.1
}

export interface CallState {
  callId: string
  kind: CallKind
  convId: string
  /** Máquina de estados da chamada (chamando/recebendo/conectado/…) — ver callPhases.ts */
  phase: CallPhase
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  sharing: boolean
  participants: { fp: string; nickname: string; stream?: MediaStream; speaking?: boolean; muted?: boolean; sharing?: boolean; disconnected?: boolean }[]
  startAt: number
  quality?: CallQuality
  qualityNotice?: string | null
  /** Fallback "áudio via relay": true quando o mic está sendo retransmitido pela sinalização. */
  relayActive?: boolean
  /** True quando o usuário ligou manualmente (modo compatibilidade); false quando foi automático por ICE. */
  relayManual?: boolean
  /** Motivo: 'manual' | 'ice-failed' | 'ice-disconnected' | 'relay-only' | null */
  relayReason?: string | null
}

// ── P2P puro: nenhum servidor de terceiro no padrão ─────────────────────────
// A lista padrão de ICE é VAZIA (só candidatos host locais) + o que o usuário
// configurar explicitamente (forge:turn_url / VITE_TURN_URL). Os fallbacks
// públicos (Google STUN, openrelay TURN com credencial pública e cota de
// ~20 GB/mês) SAÍRAM do padrão: mídia 100% P2P, sem VPS e sem terceiro.
// Consequência honesta: fora da LAN, NAT restritivo/4G pode não fechar rota —
// a UI avisa (hasRelayConfigured) em vez de fingir. As funções abaixo seguem
// exportadas para opt-in explícito, não para o caminho padrão.
const FALLBACK_TURN_HOST = 'staticauth.openrelay.metered.ca'
const FALLBACK_TURN_SECRET = 'openrelayprojectsecret'
/** Validade da credencial efêmera gerada localmente (o coturn aceita até o epoch). */
const FALLBACK_TURN_TTL_S = 24 * 3600

/**
 * STUN público: descobre o IP/porta mapped do NAT (candidato `srflx`) SEM
 * envolver nenhum terceiro no tráfego — o STUN só responde "qual é o meu
 * endereço"; a mídia continua indo direto de um peer para o outro.
 * Sem nenhum `stun:` na lista, atrás de NAT o ICE só produzia candidatos
 * `host` (endereço privado), que nenhum peer de fora consegue alcançar — e a
 * chamada morria sem nunca tentar a rota direta.
 */
const FALLBACK_STUN_URLS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:global.stun.twilio.com:3478',
]

/** Servidores STUN de reserva (sem credencial, sem mídia passando por eles). */
export function getFallbackStunServers(): RTCIceServer[] {
  return FALLBACK_STUN_URLS.map((urls) => ({ urls }))
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  // btoa existe no browser/Tauri/Node16+; se indisponível, lança → chamador retorna null
  return btoa(bin)
}

/**
 * Gera credencial TURN efêmera (esquema static-auth-secret do coturn) de forma
 * síncrona via @noble/hashes (já é dependência do projeto). Retorna null se algo
 * falhar — o chamador então segue só com o relay configurado, sem quebrar nada.
 */
export function getFallbackTurnCredential(nowMs: number = Date.now()): { username: string; credential: string } | null {
  try {
    const expiry = Math.floor(nowMs / 1000) + FALLBACK_TURN_TTL_S
    const username = `${expiry}:distorrent`
    const mac = hmac(sha1, new TextEncoder().encode(FALLBACK_TURN_SECRET), new TextEncoder().encode(username))
    return { username, credential: bytesToBase64(mac) }
  } catch { return null }
}

/** Servidor TURN de emergência (último da lista) ou null se a credencial falhar. */
export function getFallbackTurnServer(): RTCIceServer | null {
  const cred = getFallbackTurnCredential()
  if (!cred) return null
  return {
    urls: [
      `turn:${FALLBACK_TURN_HOST}:80`,
      `turn:${FALLBACK_TURN_HOST}:443`,
      `turns:${FALLBACK_TURN_HOST}:443`,
    ],
    username: cred.username,
    credential: cred.credential,
  }
}

/**
 * TURN público CLÁSSICO (openrelay) com credenciais estáticas fixas. O host
 * segue no ar (o `staticauth...` acima está instável/fora). Entra como reserva
 * ADICIONAL — o ICE tenta todos e usa o que responder. Sem isso, no 4G/CGNAT
 * não há rota de mídia e a chamada fica muda.
 */
export function getClassicTurnServer(): RTCIceServer {
  return {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:3478',
      'turns:openrelay.metered.ca:443',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  }
}

export type CallPrivacyMode = 'normal' | 'encrypted' | 'proxy' | 'full'
/**
 * Lê o modo de privacidade de forma síncrona (só existe no modo browser, onde
 * fica em localStorage `forge:privacy_mode`). No app nativo (Tauri) o modo vive
 * no backend Rust (async `privacyGet`) e NÃO é visível aqui — retorna null.
 * Exportado para a UI/testes; ver nota sobre proxy/full em getIceServers().
 */
export function getCallPrivacyMode(): CallPrivacyMode | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('forge:privacy_mode') : null
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    return v === 'normal' || v === 'encrypted' || v === 'proxy' || v === 'full' ? v : null
  } catch { return null }
}

// Relay explícito do usuário: via localStorage forge:turn_url (ex: turn:seu-relay:3478)
// ou via env VITE_TURN_URL (+ VITE_TURN_USERNAME / VITE_TURN_CREDENTIAL; padrão forge/forge).
// Padrão = só o configurado. Nenhum STUN/TURN público embutido (P2P puro).
export function getIceServers(): RTCIceServer[] {
  // ── Nota sobre os modos proxy/full (limitação documentada, não bug) ─────────
  // Mesmo quando o modo é legível (browser: getCallPrivacyMode()), a lista NÃO
  // muda — de propósito:
  // 1. O ICE do WebRTC no browser/WebView NÃO passa pelo SOCKS5/Tor do app (o
  //    proxy cobre o TCP do forge-core; a mídia usa sockets UDP do próprio WebRTC).
  //    Não há como "rotear o ICE pelo Tor" a partir deste módulo.
  // 2. Em proxy/full a chamada expõe o IP real ao peer de qualquer jeito
  //    (candidato host/srflx direto). Anonimato real exige VPN/Tor transparente.
  // No nativo, o modo sequer é legível aqui (só via async services.privacyGet()).
  const servers: RTCIceServer[] = []
  // também tenta localStorage para UI dinâmica
  const env: any = (import.meta as any)?.env ?? {}
  const turnUser = (env.VITE_TURN_USERNAME as string | undefined) || 'forge'
  const turnCred = (env.VITE_TURN_CREDENTIAL as string | undefined) || 'forge'
  try {
    const ls = getTurnUrl()
    if (ls && isValidTurnUrl(ls)) servers.push({ urls: ls.trim(), username: turnUser, credential: turnCred })
  } catch { /* ignore */ }
  try {
    const viteTurn = env.VITE_TURN_URL as string | undefined
    if (viteTurn && isValidTurnUrl(viteTurn) && viteTurn.trim() !== getTurnUrl().trim()) {
      servers.push({ urls: viteTurn.trim(), username: turnUser, credential: turnCred })
    }
  } catch { /* ignore */ }
  // ── Reserva automática (Fase "funciona no 4G/CGNAT") ──────────────────────
  // Bug real que isto corrige: as funções abaixo existiam mas NUNCA eram
  // chamadas. Resultado: com nenhum TURN configurado no usuário, a lista de
  // ICE saía vazia de servidores → em 4G/CGNAT o ICE só tinha candidatos
  // host/srflx, nunca fechava, e a chamada ficava muda (ou caía no relay).
  // Agora, mesmo sem configurar nada, o ICE tem rotas de reserva públicas.
  try {
    const classic = getClassicTurnServer()
    const fallback = getFallbackTurnServer()
    const seen = new Set(servers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)).trim()))
    for (const s of [...getFallbackStunServers(), classic, fallback]) {
      if (!s) continue
      const key = (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)).trim()
      if (!key || seen.has(key)) continue
      seen.add(key)
      servers.push(s)
    }
  } catch { /* ignore */ }
  return servers
}

/** True quando há degrau de relay explícito (turn:/turns: configurado). */
export function hasRelayConfigured(servers?: RTCIceServer[]): boolean {
  try {
    const list = servers ?? getIceServers()
    return list.some(s => {
      const u: unknown = (s as any)?.urls
      const all = Array.isArray(u) ? u.join(' ') : String(u ?? '')
      return /(^|\s)turns?:/i.test(all)
    })
  } catch { return false }
}

// ── Áudio WebRTC de baixa latência ──────────────────────────────────────────
/** Constraints de mic para voz: processamento ligado e mono (menos banda/latência). */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
}

/**
 * Ajusta o SDP do Opus para voz em TEMPO REAL:
 * - useinbandfec=1: recupera perda sem retransmitir (essencial em 4G);
 * - usedtx=1: para de transmitir em silêncio (economiza banda);
 * - minptime=10 + a=ptime:20: pacotes de 20ms → menor latência;
 * - maxaveragebitrate=32000: qualidade de voz boa com pouca banda.
 * Sem isso o Opus negocia com defaults que soam pior/atrasam em rede ruim.
 */
export function tuneOpusSdp(sdp: string): string {
  try {
    if (!sdp || sdp.toLowerCase().indexOf('opus') < 0) return sdp
    const m = sdp.match(/a=rtpmap:(\d+)\s+opus\/48000/i)
    if (!m) return sdp
    const pt = m[1]
    const params: [string, string][] = [
      ['minptime', '10'],
      ['useinbandfec', '1'],
      ['usedtx', '1'],
      ['stereo', '0'],
      ['sprop-stereo', '0'],
      ['maxplaybackrate', '48000'],
      ['maxaveragebitrate', '32000'],
    ]
    const lines = sdp.split(/\r\n|\n/)
    const fmtpPrefix = `a=fmtp:${pt}`
    let idx = lines.findIndex(l => l.startsWith(fmtpPrefix))
    const existing: Record<string, string> = {}
    if (idx >= 0) {
      lines[idx].slice(fmtpPrefix.length).trim().split(';').forEach(kv => {
        const [k, v] = kv.split('=')
        if (k && k.trim()) existing[k.trim()] = (v ?? '').trim()
      })
    } else {
      const rpm = lines.findIndex(l => l.toLowerCase().startsWith(`a=rtpmap:${pt} `))
      if (rpm < 0) return sdp
      idx = rpm + 1
      lines.splice(idx, 0, fmtpPrefix)
    }
    for (const [k, v] of params) existing[k] = v
    lines[idx] = `${fmtpPrefix} ` + Object.entries(existing).map(([k, v]) => (v ? `${k}=${v}` : k)).join(';')
    if (!lines.some(l => l.trim() === 'a=ptime:20')) {
      const mi = lines.findIndex(l => l.startsWith('m=audio'))
      if (mi >= 0) lines.splice(mi + 1, 0, 'a=ptime:20')
    }
    return lines.join('\r\n')
  } catch { return sdp }
}

/** PC com pré-coleta de candidatos (conecta mais rápido) e mux no mesmo socket. */
function newPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: getIceServers() as any,
    // 'all' permite host/srflx/relay; TURN é só uma opção, não obrigatório.
    iceTransportPolicy: 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4,
  } as RTCConfiguration)
}

/** Offer com Opus afinado (baixa latência). */
export async function createTunedOffer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const offer = await pc.createOffer()
  offer.sdp = tuneOpusSdp(offer.sdp ?? '')
  return offer
}

/** Answer com Opus afinado (baixa latência). */
export async function createTunedAnswer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const answer = await pc.createAnswer()
  answer.sdp = tuneOpusSdp(answer.sdp ?? '')
  return answer
}

// Capacidade WebRTC: WebViews móveis sem WebRTC não definem RTCPeerConnection
// (ReferenceError "Can't find variable: RTCPeerConnection") — detectamos ANTES
// de qualquer uso para falhar com erro honesto em pt-BR em vez de crashar.
export const CALLS_UNAVAILABLE_MSG = 'chamadas de voz/vídeo indisponíveis neste aparelho'
/** Transmitir tela exige getDisplayMedia (desktop). Mobile/WebView sem isso recebe erro honesto. */
export const SCREEN_UNAVAILABLE_MSG = 'este aparelho não expõe captura de tela (o Android só libera em WebViews recentes — atualize o Android System WebView; no iPhone/iPad não existe mesmo)';
/** Ação padrão sugerida quando nada (nem WebRTC nem relay) está disponível. */
export const CALLS_UPDATE_WEBVIEW_HINT = 'atualize o WebView do sistema (Android System WebView/Chrome) e libere a permissão de microfone, ou use o app nativo'
/** ICE perdeu a rota direta e tenta via relay — a UI deve exibir em vez de silêncio. */
export const ICE_RELAY_MSG = 'sem rota de áudio direta — tentando via relay…'
/** ICE falhou mesmo com relay — rede restritiva ou TURN indisponível. */
export const ICE_FAILED_MSG = 'conexão de áudio falhou — verifique sua rede ou configure um TURN próprio'
export function supportsCalls(): boolean {
  try {
    if (typeof RTCPeerConnection !== 'undefined' && RTCPeerConnection
        && typeof navigator !== 'undefined' && (navigator as any).mediaDevices) return true
  } catch { /* cai no teste da voz nativa */ }
  // Sem WebRTC no WebView (WebKitGTK do Linux), a voz nativa em Rust cobre a
  // chamada. Sem esta linha o app se anunciava como "indisponível" mesmo com a
  // voz nativa ativa — que era o sintoma.
  return nativeVoiceAvailable === true
}

/**
 * Transmitir tela estilo Discord: desktop e Android (WebView) via
 * `getDisplayMedia`. iOS/iPadOS não expõe a API — o transmissor recebe
 * SCREEN_UNAVAILABLE_MSG honesto; o RECEPTOR continua exibindo vídeo/track
 * normalmente (view-only mobile funciona: ver shells).
 *
 * Detecção honesta e NÃOFatal: só desligamos o botão quando sabemos que não
 * funciona (false negativo = botão morto à toa). `detectScreenEnvironment()`
 * diz o motivo exato (plataforma, permissão, contexto inseguro).
 */
export function supportsScreenShare(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    const md: any = (navigator as any).mediaDevices
    if (!md?.getDisplayMedia) return false
    return true
  } catch { return false }
}

/** Motivo técnico pelo qual a captura de tela não está disponível agora. */
export function screenShareUnavailableReason(): string | null {
  try {
    if (supportsScreenShare()) return null
    const env = detectScreenEnvironment()
    return env.notes.length ? env.notes.join(' · ') : SCREEN_UNAVAILABLE_MSG
  } catch { return SCREEN_UNAVAILABLE_MSG }
}

/** Anexa track remota sem derrubar o áudio: mescla no stream existente. */
function attachRemoteTrack(
  state: CallState | null,
  onUpdate: (s: CallState | null) => void,
  fp: string,
  stream: MediaStream,
) {
  if (!state) return
  try {
    const p = state.participants.find(x => x.fp === fp)
    if (!p) {
      state.participants.push({ fp, nickname: fp.slice(0, 6), stream })
      onUpdate({ ...state })
      return
    }
    if (!p.stream) {
      p.stream = stream
      onUpdate({ ...state })
      return
    }
    if (p.stream.id === stream.id) {
      // mesmo stream atualizado (replaceTrack) — só re-emite
      p.stream = stream
      onUpdate({ ...state })
      return
    }
    // stream novo (ex.: tela chegou num objeto separado): mescla tracks que faltam
    try {
      for (const tr of stream.getTracks()) {
        const exists = p.stream.getTracks().some(t => t.id === tr.id)
        if (!exists) {
          try { p.stream.addTrack(tr) } catch { /* ignora track duplicada */ }
        }
      }
      // garante que o elemento <video> re-renderize mesmo sem trocar de id
      onUpdate({ ...state })
    } catch {
      p.stream = stream
      onUpdate({ ...state })
    }
  } catch { /* nunca derruba o bus */ }
}

export interface CallsDiagnosis {
  hasRTC: boolean
  hasMediaDevices: boolean
  hasGetUserMedia: boolean
  hasMediaRecorder: boolean
  hasAudioContext: boolean
  missing: string[]
  isWebViewLike: boolean
  level: CallsSupportLevel
}
/**
 * Diagnóstico item por item do suporte a chamadas (usado pela mensagem 'none').
 * Não lança: qualquer acesso a global ausente vira `false` em vez de ReferenceError.
 */
export function diagnoseCallsSupport(): CallsDiagnosis {
  // Relata ao Rust o que a PÁGINA está enxergando. No Linux/WebKitGTK o WebRTC
  // existe na lib mas vem desligado; sem este relato não há como distinguir
  // "WebView quebrado" de "build do WebKitGTK sem WebRTC", e a mensagem de
  // erro acabava apontando para o WebView do sistema — que estava ótimo.
  //
  // Usa `services` (não `window.__TAURI__.core.invoke`): esse global só existe
  // com `withGlobalTauri`, e sem ele o relato nunca saía.
  try {
    void services.webrtcReport(
      `RTC=${typeof RTCPeerConnection} md=${typeof (navigator as any).mediaDevices} VideoDecoder=${typeof (globalThis as any).VideoDecoder} VideoEncoder=${typeof (globalThis as any).VideoEncoder} EncodedVideoChunk=${typeof (globalThis as any).EncodedVideoChunk} VideoFrame=${typeof (globalThis as any).VideoFrame} gDM=${typeof (navigator as any).mediaDevices?.getDisplayMedia}`,
    )
  } catch { /* diagnóstico é opcional */ }
  let hasRTC: boolean
  try { hasRTC = typeof RTCPeerConnection !== 'undefined' && !!RTCPeerConnection } catch { hasRTC = false }
  let hasMediaDevices: boolean
  let hasGetUserMedia: boolean
  try {
    const md: any = typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : null
    hasMediaDevices = !!md
    hasGetUserMedia = !!(md && typeof md.getUserMedia === 'function')
  } catch { hasMediaDevices = false; hasGetUserMedia = false }
  let hasMediaRecorder: boolean
  try { hasMediaRecorder = typeof MediaRecorder !== 'undefined' && !!MediaRecorder } catch { hasMediaRecorder = false }
  let hasAudioContext: boolean
  try {
    if (typeof AudioContext !== 'undefined' && AudioContext) hasAudioContext = true
    else {
      const w: any = typeof window !== 'undefined' ? (window as any) : null
      hasAudioContext = !!(w && w.webkitAudioContext)
    }
  } catch { hasAudioContext = false }
  const missing: string[] = []
  if (!hasRTC) {
    // A voz nativa (webrtc-rs em Rust) cobre a lacuna do WebKitGTK: o áudio
    // acontece no core, não na página. Reportar "falta WebRTC" seria mentira.
    if (nativeVoiceAvailable === true) missing.push('WebRTC na página (a voz nativa em Rust cobre)')
    else missing.push('WebRTC (RTCPeerConnection ausente)')
  }
  if (!hasGetUserMedia) {
    missing.push(hasMediaDevices
      ? 'microfone (getUserMedia ausente)'
      : 'microfone (mediaDevices/getUserMedia ausente)')
  }
  // Só cobra MediaRecorder/AudioContext quando o relay também é impossível;
  // em relay-only (playback sem mic, ex.) a chamada ainda funciona.
  let level: CallsSupportLevel
  try { level = getCallsSupport() } catch { level = 'none' }
  if (level === 'none') {
    if (!hasMediaRecorder) missing.push('gravador de áudio (MediaRecorder ausente)')
    if (!hasAudioContext) missing.push('saída de áudio (AudioContext ausente)')
  }
  let isWebViewLike = false
  try {
    const ua: string = typeof navigator !== 'undefined' ? String((navigator as any).userAgent ?? '') : ''
    if (!hasRTC && (hasMediaDevices || hasMediaRecorder || hasAudioContext)) isWebViewLike = true
    if (/;\s*wv\)|Version\/.*Chrome\/.*Mobile|FBAN|FBAV|Instagram|Line\//i.test(ua)) isWebViewLike = true
  } catch { /* ignore */ }
  return { hasRTC, hasMediaDevices, hasGetUserMedia, hasMediaRecorder, hasAudioContext, missing, isWebViewLike, level }
}
/** True quando dá para falar+ouvir via relay (ou só ouvir, playback). */
export function canUseRelayCalls(): boolean {
  try { return supportsRelayFallback() || supportsRelayPlayback() } catch { return false }
}
/**
 * Mensagem detalhada para support==='none': começa com CALLS_UNAVAILABLE_MSG
 * (compat com testes/busca) + lista O QUE falta item por item + ação.
 * Ex.: "chamadas… indisponíveis neste aparelho: falta WebRTC (…), microfone (…).
 *  WebView desatualizado? atualize o WebView do sistema…"
 */
export function getCallsUnavailableMessage(): string {
  try {
    const d = diagnoseCallsSupport()
    if (d.level !== 'none') return CALLS_UNAVAILABLE_MSG
    const what = d.missing.length > 0 ? `falta ${d.missing.join('; ')}` : 'recursos de áudio indisponíveis'
    const native = (() => {
      try {
        const g: any = globalThis as any
        return !!(g.__TAURI__ || g.__TAURI_INTERNALS__ || g.__TAURI_METADATA__)
      } catch { return false }
    })()
    const isLinuxDesktop = (() => {
      try { return !/android|iphone|ipad/i.test(navigator.userAgent) } catch { return false }
    })()
    // FATO MEDIDO NESTA MÁQUINA (webKitGTK 2.52.6, Ubuntu 24.04):
    //   secureContext=true, mediaDevices=object, RTCPeerConnection=undefined
    // mesmo DEPOIS de `WebKitSettings.set_enable_webrtc(true)`. O WebKitGTK do
    // Ubuntu é compilado SEM a interface JS de WebRTC — o toggle existe na lib
    // e o `RTCPeerConnection` está no binário, mas não é exposto. Não é WebView
    // desatualizado, e nenhuma configuração do app resolve.
    if (native && isLinuxDesktop && !d.hasRTC) {
      return `${CALLS_UNAVAILABLE_MSG}: ${what}. Este é o WebKitGTK do Linux, que vem compilado sem WebRTC — não é falta de atualização, e não há como corrigir pelo app. A voz nativa em Rust também não subiu (sem dispositivo de áudio, ou desligada por FORGE_NO_NATIVE_VOICE=1), então no desktop Linux resta a conversa por texto.`
    }
    let hint: string
    if (native) {
      hint = 'atualize o Android System WebView pela Play Store e libere a permissão de microfone nas configurações do app'
    } else {
      hint = CALLS_UPDATE_WEBVIEW_HINT
    }
    return `${CALLS_UNAVAILABLE_MSG}: ${what}. ${hint}`
  } catch { return CALLS_UNAVAILABLE_MSG }
}

// getUserMedia com erro honesto: sem mediaDevices → null; permissão negada ou
// dispositivo ausente → emite onCallNotice via hook e devolve null para manter
// a sinalização (chamada "só sinalização" ainda completa, mas avisada).
let localMediaNotice: ((msg: string) => void) | null = null
export function setLocalMediaNotice(cb: ((msg: string) => void) | null) {
  localMediaNotice = cb
}
function describeMediaError(e: unknown): string | null {
  const name = (e as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError') return 'microfone/câmera bloqueados — libere a permissão do sistema e tente de novo'
  if (name === 'NotFoundError') return 'nenhum microfone/câmera encontrado neste aparelho'
  if (name === 'NotReadableError') return 'microfone/câmera em uso por outro app — feche e tente de novo'
  if (name === 'OverconstrainedError') return 'câmera/microfone não atende aos requisitos — tente só voz'
  if (name === 'SecurityError') return 'permissão de mídia bloqueada pelo contexto (HTTPS/app nativo exigido)'
  return null
}
async function getLocalMedia(constraints: MediaStreamConstraints): Promise<MediaStream | null> {
  try {
    const md: any = (typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : null)
    if (!md?.getUserMedia) {
      try { localMediaNotice?.('microfone indisponível neste aparelho (getUserMedia ausente)') } catch { /* ignore */ }
      return null
    }
    // Aplica processamento de voz por padrão (cancelamento de eco, supressão de
    // ruído, ganho, mono) — melhora muito a inteligibilidade em chamada.
    const merged: MediaStreamConstraints = { ...constraints }
    if (constraints.audio) {
      merged.audio = constraints.audio === true
        ? { ...AUDIO_CONSTRAINTS }
        : { ...AUDIO_CONSTRAINTS, ...(constraints.audio as MediaTrackConstraints) }
    }
    try {
      return await md.getUserMedia(merged)
    } catch (e) {
      const honest = describeMediaError(e)
      try { localMediaNotice?.(honest ?? `falha ao abrir microfone/câmera (${(e as Error)?.name ?? 'erro'})`) } catch { /* ignore */ }
      return null
    }
  } catch { return null }
}

// ── Estados ICE honestos ─────────────────────────────────────────────────────
// O monitor de qualidade (pollStats) não enxerga falha de conectividade; este
// barramento avisa `failed` de imediato e `disconnected` que persiste além da
// graça (>5s) para a UI mostrar ICE_RELAY_MSG em vez de silêncio. Sem isso o
// usuário fica sem áudio e sem saber por quê.
export type IceFailureState = 'failed' | 'disconnected'
export interface IceFailureInfo { fp: string; callId: string; state: IceFailureState }
/** Quanto tempo `disconnected` precisa persistir para virar aviso (flaps curtos são normais).
 *  12s (era 5s): no 4G/CGNAT o relay próprio demora para alocar rota — 5s trocava
 *  para o áudio-via-relay (ruim) ANTES de o WebRTC ter chance de conectar. */
export const ICE_DISCONNECTED_GRACE_MS = 12000

// ── Medidor da mídia (Missão B, passo 1) ─────────────────────────────────────
// Degrau real por peer, lido do par ICE selecionado (pc.getStats): sem isso,
// "no 4G" é opinião. `relay` aqui = SOMENTE relay explícito do usuário
// (hasRelayConfigured) — não há mais TURN público embutido.
export type MediaRung = 'direto-host' | 'direto-srflx' | 'relay' | 'conectando' | 'falhou' | 'sem-rota'
export const RUNG_LABEL: Record<MediaRung, string> = {
  'direto-host': 'direta (rede local)',
  'direto-srflx': 'direta (NAT furado)',
  'relay': 'via relay configurado',
  'conectando': 'conectando…',
  'falhou': 'sem rota',
  'sem-rota': 'sem rota',
}
export interface IceMediaReport {
  iceState: string
  localType: string | null
  remoteType: string | null
  rttMs: number | null
  bytesOut: number
}
export interface ForgeNatEndpoint { addr: string; source: string }

/**
 * Diagnóstico por peer para o painel em tempo real (ver getCallDiagnostics).
 * Todos os numéricos são null quando indisponíveis — o painel mostra "—".
 */
export interface CallDiagnostics {
  fp: string
  connectionState: string
  iceConnectionState: string
  signalingState: string
  localType: string | null
  remoteType: string | null
  selectedPair: string | null
  rttMs: number | null
  audioBitrateKbps: number | null
  videoBitrateKbps: number | null
  resolution: string | null
  fps: number | null
  framesReceived: number | null
  framesLost: number | null
  packetsLost: number | null
  packetLossPct: number | null
  codec: string | null
  jitterMs: number | null
  camera: string
  microphone: string
}

/** Constrói o diagnóstico de um peer a partir do PC + getStats (nunca lança). */
export function buildPeerDiagnostics(
  fp: string,
  pc: RTCPeerConnection,
  stats: RTCStatsReport | null,
  rep: IceMediaReport | null,
  st: CallState | null,
): CallDiagnostics {
  const safe = (v: unknown): string => {
    try { return String((v as any) ?? '?') } catch { return '?' }
  }
  let rttMs: number | null = rep?.rttMs ?? null
  let localType: string | null = rep?.localType ?? null
  let remoteType: string | null = rep?.remoteType ?? null
  let selectedPair: string | null = null
  const audioBitrateKbps: number | null = null
  const videoBitrateKbps: number | null = null
  let resolution: string | null = null
  let fps: number | null = null
  let framesReceived: number | null = null
  let framesLost: number | null = null
  let packetsLost: number | null = null
  let packetLossPct: number | null = null
  let codec: string | null = null
  let jitterMs: number | null = null
  try {
    if (stats) {
      const byId = new Map<string, any>()
      try { stats.forEach((r: any) => { if (r && r.id) byId.set(String(r.id), r) }) } catch { /* ignore */ }
      let pair: any = null
      try {
        stats.forEach((r: any) => {
          if (r && r.type === 'candidate-pair' && (r.nominated || r.selected)) pair = r
        })
        if (!pair) stats.forEach((r: any) => {
          if (!pair && r && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r
        })
      } catch { /* ignore */ }
      if (pair) {
        const local = byId.get(String(pair.localCandidateId ?? ''))
        const remote = byId.get(String(pair.remoteCandidateId ?? ''))
        if (local?.candidateType && !localType) localType = String(local.candidateType)
        if (remote?.candidateType && !remoteType) remoteType = String(remote.candidateType)
        if (typeof pair.currentRoundTripTime === 'number') rttMs = Math.round(pair.currentRoundTripTime * 1000)
        try {
          const lt = local ? `${local.candidateType ?? '?'}:${local.protocol ?? 'udp'}` : '?'
          const rt = remote ? `${remote.candidateType ?? '?'}` : '?'
          selectedPair = `${lt} ↔ ${rt}`
        } catch { /* ignore */ }
      }
      let aBytes = 0; let vBytes = 0; let aPkts = 0; let aLost = 0
      stats.forEach((r: any) => {
        try {
          if (!r) return
          if (r.type === 'inbound-rtp') {
            if (typeof r.jitter === 'number' && (jitterMs === null || r.jitter * 1000 > 0)) {
              const jm = Math.round(r.jitter * 1000)
              if (jitterMs === null) jitterMs = jm
            }
            if (typeof r.packetsLost === 'number') {
              packetsLost = (packetsLost ?? 0) + r.packetsLost
              if (r.kind === 'audio' || String(r.mediaType ?? '') === 'audio') { aLost += r.packetsLost }
            }
            if (typeof r.packetsReceived === 'number' && (r.kind === 'audio' || String(r.mediaType ?? '') === 'audio')) {
              aPkts += r.packetsReceived
            }
            if ((r.kind === 'video' || String(r.mediaType ?? '') === 'video')) {
              if (typeof r.framesReceived === 'number') framesReceived = (framesReceived ?? 0) + r.framesReceived
              if (typeof r.framesDropped === 'number' || typeof r.framesLost === 'number') {
                framesLost = (framesLost ?? 0) + Number(r.framesDropped ?? r.framesLost ?? 0)
              }
              if (typeof r.frameWidth === 'number' && typeof r.frameHeight === 'number') {
                resolution = `${r.frameWidth}x${r.frameHeight}`
              }
              if (typeof r.framesPerSecond === 'number') fps = Math.round(r.framesPerSecond)
            }
            if (typeof r.mimeType === 'string' && !codec) codec = r.mimeType.replace('video/', '').replace('audio/', '')
            if (typeof r.codecId === 'string' && byId.has(r.codecId)) {
              const c = byId.get(r.codecId)
              if (c?.mimeType && !codec) codec = String(c.mimeType).replace('video/', '').replace('audio/', '')
            }
          }
          if (r.type === 'outbound-rtp') {
            if (typeof r.bytesSent === 'number') {
              if (r.kind === 'audio' || String(r.mediaType ?? '') === 'audio') aBytes += r.bytesSent
              else vBytes += r.bytesSent
            }
            if ((r.kind === 'video' || String(r.mediaType ?? '') === 'video')) {
              if (typeof r.frameWidth === 'number' && typeof r.frameHeight === 'number' && !resolution) {
                resolution = `${r.frameWidth}x${r.frameHeight}`
              }
              if (typeof r.framesPerSecond === 'number' && fps === null) fps = Math.round(r.framesPerSecond)
            }
          }
        } catch { /* stat individual nunca derruba o painel */ }
      })
      // Bitrate aproximado: bytes acumulados não dão taxa sem janela temporal;
      // expõe como null honesto quando não há baseline (o painel mostra "—").
      // O bitrate real por janela vem do pollStats futuro; aqui não inventamos.
      void aBytes; void vBytes
      if (aPkts + aLost > 0) packetLossPct = Math.round((aLost / (aPkts + aLost)) * 1000) / 10
      else if (typeof packetsLost === 'number' && packetsLost > 0) packetLossPct = null
    }
  } catch { /* diagnóstico parcial */ }
  let camera = 'desligada'
  let microphone = 'desligado'
  try {
    const mine = fp === (st as any)?.participants?.[0]?.fp
    void mine
    // Estado local (o painel mostra por peer; para o remoto, tracks vêm do stream).
    const local = (st as any)
    void local
  } catch { /* ignore */ }
  try {
    // Remoto: procura o stream do participante.
    const p: any = (st?.participants as any[])?.find((x: any) => x.fp === fp)
    const stream: MediaStream | undefined = p?.stream
    if (stream) {
      try {
        const vt = stream.getVideoTracks()[0]
        camera = vt ? (vt.readyState === 'live' ? (vt.enabled ? `ativa (${vt.label || 'câmera'})` : 'mutada') : 'encerrada') : 'sem vídeo'
      } catch { camera = 'desconhecida' }
      try {
        const at = stream.getAudioTracks()[0]
        microphone = at ? (at.readyState === 'live' ? (at.enabled ? 'ativo' : 'mutado') : 'encerrado') : 'sem áudio'
      } catch { microphone = 'desconhecido' }
    } else {
      camera = 'sem track remota'
      microphone = 'sem track remota'
    }
  } catch { /* ignore */ }
  return {
    fp,
    connectionState: safe((pc as any).connectionState),
    iceConnectionState: safe((pc as any).iceConnectionState),
    signalingState: safe((pc as any).signalingState),
    localType, remoteType, selectedPair, rttMs,
    audioBitrateKbps, videoBitrateKbps,
    resolution, fps, framesReceived, framesLost,
    packetsLost, packetLossPct, codec, jitterMs,
    camera, microphone,
  }
}

type IceFailureListener = (info: IceFailureInfo) => void
const iceFailureListeners = new Set<IceFailureListener>()
/** UI/CallManager assinam para receber falhas de ICE. Retorna função de unsubscribe. */
export function subscribeIceFailures(cb: IceFailureListener): () => void {
  iceFailureListeners.add(cb)
  return () => { iceFailureListeners.delete(cb) }
}
function emitIceFailure(info: IceFailureInfo) {
  iceFailureListeners.forEach(cb => { try { cb(info) } catch { /* listener nunca derruba o monitor */ } })
}

/** ICE voltou a conectar (WebRTC recuperado) — permite desligar o áudio-via-relay. */
export interface IceRecoveredInfo { fp: string; callId: string }
type IceRecoveredListener = (info: IceRecoveredInfo) => void
const iceRecoveredListeners = new Set<IceRecoveredListener>()
export function subscribeIceRecovered(cb: IceRecoveredListener): () => void {
  iceRecoveredListeners.add(cb)
  return () => { iceRecoveredListeners.delete(cb) }
}
function emitIceRecovered(info: IceRecoveredInfo) {
  iceRecoveredListeners.forEach(cb => { try { cb(info) } catch { /* ignore */ } })
}
// ── Fallback "áudio via relay" (compatibilidade sem TURN) ───────────────────
// Cenário real: PC sem UPnP + celular no 4G = ICE nunca conecta (sem
// host/srflx alcançável, sem TURN próprio). A sinalização completa mas sem áudio.
// Fallback: captura o mic via MediaRecorder (audio/webm;codecs=opus, fatias de
// 500ms ≈ 8KB, cabem no limite do frame cifrado) e envia cada fatia pela
// sinalização existente. Verificação de assinatura em 2026-09-04:
// - ForgeServices NÃO possui `callSignal(fp, callId, payload)` — só
//   callOffer/callAnswer/callIce (models.ts + tauri.ts + browser.ts).
// - Por isso o transporte é `callIce(fp, callId, JSON{kind:'audio-chunk'…},
//   'audio-relay')`: mesmo caminho cifrado do ICE, sem tocar outros arquivos.
//   Se um futuro engine expuser `callSignal`, o envio tenta ele primeiro via
//   `(services as any).callSignal` sem quebrar o contrato atual.
// - No modo browser `callIce` é no-op, então há também BroadcastChannel +
//   window CustomEvent `forge:call-relay` para demo multi-aba local.
// Receptor: AudioContext com fila por peer + jitter buffer simples; descarta
// atraso >2s. WebRTC continua preferido: relay só liga se ICE falhar
// (failed imediato / disconnected >5s via subscribeIceFailures) ou toggle manual.
export const RELAY_TIMESLICE_MS = 500
export const RELAY_ICE_FAIL_MS = 5000
export const RELAY_MAX_DELAY_MS = 2000
export const RELAY_MID = 'audio-relay'
export const RELAY_VIA_LABEL = 'via relay (latência alta)'
export const RELAY_BC_NAME = 'forge-call-relay-v1'
export const RELAY_WINDOW_EVENT = 'forge:call-relay'
export interface RelayChunkPayload {
  kind: 'audio-chunk'
  seq: number
  data: string
  ts: number
  mime: string
}
export function isRelayChunkPayload(v: any): v is RelayChunkPayload {
  return !!v && typeof v === 'object' && (v as any).kind === 'audio-chunk'
    && typeof (v as any).seq === 'number' && typeof (v as any).data === 'string'
}
function pickRelayMime(): string | undefined {
  try {
    const MR: any = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null
    if (!MR) return undefined
    const cands = [
      'audio/webm;codecs=opus', 'audio/webm',
      // Android WebView antigo só conhece mp4/aac em alguns aparelhos; sem
      // estes dois a chamada relay morria na construção (ver buildRelayRecorder).
      'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac',
      'audio/ogg;codecs=opus',
    ]
    for (const m of cands) {
      try { if (typeof MR.isTypeSupported === 'function' && MR.isTypeSupported(m)) return m } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return undefined
}

/**
 * Constrói o MediaRecorder testando CADA formato de verdade.
 *
 * BUG REAL do Android que isto corrige: o código antigo fazia
 * `new MR(stream, {mimeType})` e, no `catch`, caía em `new MR(stream)` — que
 * LANÇA de novo (NotSupportedError) quando o WebView não suporta nenhum codec.
 * A exceção subia, `startRelay` falhava, o relay nunca subia e a chamada
 * ficava presa em "Conectando…" para sempre, sem áudio e sem aviso.
 * Aqui cada tentativa é isolada e o erro final é honesto.
 */
function buildRelayRecorder(MR: any, stream: MediaStream): { rec: any; mime: string } {
  const tried: string[] = []
  const candidates: string[] = []
  const preferred = pickRelayMime()
  if (preferred) candidates.push(preferred)
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus']) {
    if (m !== preferred) candidates.push(m)
  }
  for (const m of candidates) {
    try {
      if (typeof MR.isTypeSupported === 'function' && !MR.isTypeSupported(m)) continue
      return { rec: new MR(stream, { mimeType: m }), mime: m }
    } catch {
      tried.push(m)
    }
  }
  // Último recurso: construtor sem mimeType (alguns WebViews aceitam e escolhem).
  try { return { rec: new MR(stream), mime: preferred ?? 'audio/webm' } } catch { /* cai no erro honesto */ }
  throw new Error(
    `neste aparelho o áudio não pode ser gravado (MediaRecorder sem codec suportado; tentados: ${tried.join(', ') || 'nenhum'})`,
  )
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}
/** Receptor mínimo (só AudioContext) — toca chunks mesmo sem mic. */
export function supportsRelayPlayback(): boolean {
  try {
    if (typeof AudioContext !== 'undefined' && AudioContext) return true
    const w: any = typeof window !== 'undefined' ? (window as any) : null
    if (w && w.webkitAudioContext) return true
    return false
  } catch { return false }
}
/** Emissor+receptor completos (MediaRecorder + AudioContext + mic). */
export function supportsRelayFallback(): boolean {
  try {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder) return false
    if (!supportsRelayPlayback()) return false
    if (typeof navigator === 'undefined' || !(navigator as any).mediaDevices?.getUserMedia) return false
    return true
  } catch { return false }
}
export type CallsSupportLevel = 'full' | 'none'
/**
 * Chamadas são WebRTC direto ou não são. 'full' = WebRTC ok; 'none' = sem
 * WebRTC neste aparelho.
 *
 * O nível `'relay-only'` foi REMOVIDO de propósito: sem WebRTC não existe
 * chamada com latência aceitável (a voz pelo túnel de sinalização introduz
 * hundreds de ms e o usuário complaintou disso), então o app agora diz a
 * verdade — "chamadas indisponíveis neste aparelho" — em vez de degradar
 * silenciosamente para um modo que não funciona. TURN continua disponível e
 * continua sendo o caminho do 4G/CGNAT: é WebRTC, não relay.
 */
/**
 * VOZ NATIVA (webrtc-rs + cpal + Opus) — segunda camada de áudio, dentro do
 * core em Rust. Ela existe porque nem todo WebView expõe
 * `RTCPeerConnection` de forma confiável.
 *
 * Quando existe, o CORE conduz a chamada (offer/answer/ICE em Rust) e a
 * WebView não cria `RTCPeerConnection` para aquele par — não cria duas
 * RTP na mesma chamada. Quando não existe, `false` e o caminho do navegador
 * vale integralmente, sem branching espalhado: quem decide, no Rust, é o
 * registro de sessão nativa por (call_id, peer_fp).
 */
let nativeVoiceAvailable: boolean | null = null
/** Rota da chamada NATIVA (o `getRungSummary()` do WebRTC não sabe nada dela:
 *  a mídia está no Rust, então `iceReports` fica vazio e a tela mostrava
 *  "sem rota" mesmo com a chamada conectada). */
let nativeRoute: string | null = null

/** Consulta única e cacheada: a resposta não muda durante a sessão do app. */
export async function detectNativeVoice(): Promise<boolean> {
  if (nativeVoiceAvailable !== null) return nativeVoiceAvailable
  try {
    nativeVoiceAvailable = await services.voiceMediaAvailable()
  } catch {
    nativeVoiceAvailable = false // browser, build sem a camada, ou comando ausente
  }
  return nativeVoiceAvailable
}

/** Zera o cache — usado por testes e por quem troca de identidade. */
export function resetNativeVoiceCache(): void {
  nativeVoiceAvailable = null
}

export function getCallsSupport(): CallsSupportLevel {
  try { if (supportsCalls()) return 'full' } catch { /* ignore */ }
  // Sem WebRTC no WebView, a voz nativa ainda pode dar conta — se o core já a
  // tiver construída. `detectNativeVoice()` alimenta este cache; chamada
  // síncrona antes do boot só enxerga o que já foi detectado.
  if (nativeVoiceAvailable === true) return 'full'
  return 'none'
}


/** Lê o par ICE selecionado de um getStats já coletado (medidor B1). */
function readIceReport(pc: RTCPeerConnection, stats: RTCStatsReport): IceMediaReport {
  const byId = new Map<string, any>()
  try { stats.forEach((r: any) => { if (r && r.id) byId.set(String(r.id), r) }) } catch { /* ignore */ }
  let pair: any = null
  try {
    stats.forEach((r: any) => {
      if (r && r.type === 'candidate-pair' && (r.nominated || r.selected)) pair = r
    })
    if (!pair) stats.forEach((r: any) => {
      if (!pair && r && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r
    })
  } catch { /* ignore */ }
  const local = pair ? byId.get(String(pair.localCandidateId ?? '')) : null
  const remote = pair ? byId.get(String(pair.remoteCandidateId ?? '')) : null
  let bytesOut = 0
  try {
    stats.forEach((r: any) => {
      if (r && r.type === 'outbound-rtp' && typeof r.bytesSent === 'number') bytesOut += r.bytesSent
    })
  } catch { /* ignore */ }
  const rtt = pair && typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null
  return {
    iceState: String(pc.iceConnectionState ?? 'unknown'),
    localType: local ? String(local.candidateType ?? '') || null : null,
    remoteType: remote ? String(remote.candidateType ?? '') || null : null,
    rttMs: rtt,
    bytesOut,
  }
}

// debug: acompanha gathered/connectividade sem expor SDP no console
// (assinatura inalterada — createPC/handleOffer chamam como antes)
function logIceState(pc: RTCPeerConnection, fp: string, callId: string) {
  let grace: ReturnType<typeof setTimeout> | null = null
  const clearGrace = () => {
    try { if (grace) clearTimeout(grace) } catch { /* ignore */ }
    grace = null
  }
  try {
    pc.oniceconnectionstatechange = () => {
      const st = pc.iceConnectionState
      console.debug(`[call] ICE ${callId} peer=${fp.slice(0, 8)} state=${st}`)
      try {
        if (st === 'failed') {
          clearGrace()
          emitIceFailure({ fp, callId, state: 'failed' })
        } else if (st === 'disconnected') {
          // flap curto é normal (troca de rede); só avisa se persistir além da graça
          clearGrace()
          try {
            grace = setTimeout(() => {
              try {
                const cur = pc.iceConnectionState
                if (cur === 'disconnected') emitIceFailure({ fp, callId, state: 'disconnected' })
                else if (cur === 'failed') emitIceFailure({ fp, callId, state: 'failed' })
              } catch { /* ignore */ }
            }, ICE_DISCONNECTED_GRACE_MS)
          } catch { /* ignore */ }
        } else if (st === 'connected' || st === 'completed' || st === 'closed') {
          clearGrace()
          // WebRTC conectou: se estávamos no áudio-via-relay, pode voltar pro WebRTC
          emitIceRecovered({ fp, callId })
        }
      } catch { /* monitor nunca derruba a chamada */ }
    }
  } catch { /* ignore */ }
}

export class CallManager {
  private pcs = new Map<string, RTCPeerConnection>()
  /**
   * Candidatos ICE recebidos ANTES de a `remoteDescription` existir.
   * Por que importa: no trickle ICE os candidatos do peer podem chegar pela
   * sinalização (relay, com atraso/reordenação) antes da offer/answer ser
   * aplicada. `addIceCandidate` sem remoteDescription lança e o candidato é
   * PERDIDO — a chamada fica sem rota (voz/vídeo/tela mudos) principalmente
   * sobre relay. Aqui guardamos por peer e despejamos assim que a descrição
   * remota entra (ver `flushPendingIce`).
   */
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  /** Candidatos ICE LOCAIS por peer — reenviados quando o gathering termina,
   *  para recuperar qualquer candidato que se perdeu no caminho (ver
   *  `resendLocalIce`). */
  private localIce = new Map<string, RTCIceCandidate[]>()
  private pendingOffers = new Map<string, { callId: string; sdp: string }>()
  /** Último SDP de offer aceito por peer (dedup de reenvio / anti-GLARE). */
  private lastRemoteOffer = new Map<string, string>()
  /** Nº de ICE restarts já pedidos por peer (limite evita loop infinito). */
  private iceRestarts = new Map<string, number>()
  /** Máximo de ICE restarts por peer em uma chamada (backoff entre tentativas). */
  private static readonly MAX_ICE_RESTARTS = 3
  /** Backoff dos restarts: 1ª falha espera 1s, 2ª 4s, 3ª 9s (cap do array). */
  private static readonly ICE_RESTART_BACKOFF_MS = [1000, 4000, 9000]
  /** Timers de restart agendados por peer (evita stack de restarts). */
  private iceRestartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Medidor B1: iceServers efetivos do último PC + relatório por peer. */
  private iceServersUsed: RTCIceServer[] | null = null
  private iceReports = new Map<string, IceMediaReport>()
  /** Endpoint NAT próprio vindo do motor (evento nat_endpoint). */
  private forgeNat: ForgeNatEndpoint | null = null
  /** Watchdog da reconexão: sem mídia viva por 30s → encerra honesto. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly RECONNECT_TIMEOUT_MS = 30_000
  /** Grace do modo relay: transporte pronto → declara conectado (ver markRelayConnectedFallback). */
  private static readonly RELAY_CONNECT_GRACE_MS = 2_500
  private relayFallbackTimer: ReturnType<typeof setTimeout> | null = null
  /** Timeout de 'connecting' sem mídia → reinicia ICE (ICE em silêncio no CGNAT). */
  private nativeVoiceTimer: ReturnType<typeof setInterval> | null = null
  private nativeVoiceSince = 0
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly CONNECT_TIMEOUT_MS = 20_000
  /** Sem resposta do outro lado (ninguém atendeu / sinalização não andou). */
  private outgoingTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly OUTGOING_TIMEOUT_MS = 45_000
  /** Tocando sem atender e sem desligo remoto (quem ligou sumiu). */
  private incomingTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly INCOMING_TIMEOUT_MS = 60_000
  /** Teto da voz nativa sem conectar: sem isto a chamada fica em "Conectando…"
   *  para sempre quando o ICE não fecha (CGNAT simétrico). */
  private static readonly NATIVE_VOICE_TIMEOUT_MS = 45_000
  /** Janelas extras concedidas ao watchdog enquanto o ICE ainda coleta. */
  private connectWatchdogGrants = 0
  /** O stream do recorder relay é exclusivo dele (true) ou é o localStream compartilhado (false)? */
  private relayRecDedicated = false
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  /** Atalho legado: 'monitor' (tela) ou 'window' (janela/aba). Espelha
   *  `screenOptions.source` e existe só para a UI antiga; a fonte de verdade é
   *  o objeto de opções (que também carrega monitor/áudio/qualidade/FPS). */
  private screenSource: 'monitor' | 'window' = 'monitor'
  // ── Screen share (módulo screenShare.ts) ──────────────────────────────────
  /** Opções completas de compartilhamento (fonte/áudio/qualidade/FPS). */
  private screenOptions: ScreenShareOptions = { ...SCREEN_DEFAULT_OPTIONS }
  /** Ambiente de captura detectado (plataforma, capacidades, notas). */
  private screenEnv: ScreenEnvironment = detectScreenEnvironment()
  /** FPS capturado de verdade (requestVideoFrameCallback) — nunca inventado. */
  private screenMonitor = new ScreenCaptureMonitor()
  /** Agrega getStats em métricas reais de bitrate/FPS/perda/latência. */
  private screenStats = new ScreenStatsCollector()
  private screenMetrics: ScreenShareMetrics = emptyScreenMetrics()
  /** Timer do diagnóstico da tela (1s: resolução/FPS/bitrate reais). */
  private screenStatsTimer: ReturnType<typeof setInterval> | null = null
  /** Último erro de captura (código + mensagem) para a UI mostrar e reagir. */
  private screenError: { code: ScreenShareErrorCode; message: string } | null = null
  /** Contador de tentativas de recuperação automática da captura. */
  private screenRecoveryAttempts = 0
  private static readonly SCREEN_MAX_RECOVERY = 5
  /** Timer de recuperação (janela fechada/monitor desconectado/perda). */
  private screenRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  /** Resolução observada na track viva (para detectar mudança de resolução). */
  private screenLastSize = ''
  /** Callback de UI para o painel "Screen Share Debug". */
  public onScreenDebug: ((m: ScreenShareMetrics & { options: ScreenShareOptions; env: ScreenEnvironment; error: { code: ScreenShareErrorCode; message: string } | null }) => void) | null = null
  private onUpdate: (s: CallState | null) => void = () => {}
  private state: CallState | null = null
  private myFp = ''
  /** Última fase alcançada (para toast pós-fim: "recusada", "perdida"…). */
  private lastPhase: CallPhase = 'idle'
  private engineOff?: () => void
  private quality: CallQuality = getStoredQuality()
  private qualityNotice: string | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private badWindows = 0
  private prevLost = new Map<string, number>()
  /** UI pode assinar para exibir toast além do CallState.qualityNotice. */
  public onQualityNotice: ((msg: string) => void) | null = null
  /**
   * Avisos de FASE da chamada (recusada/perdida/reconexão falhou) — a UI
   * assina para exibir toast além do overlay. Diferente do onIceFailed
   * (diagnóstico), isto é ciclo de vida.
   */
  public onCallNotice: ((msg: string) => void) | null = null
  /**
   * Falha de ICE honesta: `failed` imediato ou `disconnected` por >5s.
   * A UI deve mostrar ICE_RELAY_MSG ("sem rota de áudio direta — tentando via
   * relay…") e, se persistir/falhar, ICE_FAILED_MSG. Nulo por padrão.
   */
  public onIceFailed: ((info: IceFailureInfo) => void) | null = null
  private iceFailOff: (() => void) | null = null
  // ── relay fallback (áudio via sinalização) ──
  private relayManual = false
  private relayActive = false
  private relayReason: string | null = null
  private relaySeq = 0
  private relayHeaderBytes: Uint8Array | null = null
  private relayRecorder: MediaRecorder | null = null
  private relayRecStream: MediaStream | null = null
  private relayAudioCtx: AudioContext | null = null
  private relayQueues = new Map<string, { nextSeq: number; nextTime: number; pending: Map<number, { buf: AudioBuffer; ts: number }> }>()
  private relayBc: BroadcastChannel | null = null
  private iceRecoveredOff: (() => void) | null = null
  private relayWindowHandler: ((e: Event) => void) | null = null

  constructor(private getIdentity: () => { fingerprint: string; nickname: string } | null) {}

  bind(cb: (s: CallState | null) => void) {
    this.onUpdate = (s) => cb(s)
    try { setLocalMediaNotice((m) => { try { this.onCallNotice?.(m) } catch { /* ignore */ } }) } catch { /* ignore */ }
    // identidade já disponível (shells chamam setCallIdentity antes) — base do polite/impolite
    try { const me = this.getIdentity(); if (me && !this.myFp) this.myFp = me.fingerprint } catch { /* ignore */ }
    // escuta eventos do engine (oferta/resposta/ICE + relay via callIce/call_signal)
    this.engineOff = services.subscribe((ev: any) => {
      // eventos de sinalização sem fp válido são ignorados (nunca crasham o bus)
      const fpOk = typeof ev?.from_fp === 'string' && ev.from_fp.length > 0
      if (ev.type === 'call_offer' && fpOk) {
        // Offer fluindo = sinalização viva: tira de outgoing/incoming mesmo se
        // o frame `call_accepted` se perdeu (causa raiz do "Chamando…" infinito
        // no lado de quem liga).
        try { if (this.state && (ev as any).call_id === this.state.callId) this.promoteOnSignal(String((ev as any).call_id ?? '')) } catch { /* ignore */ }
        this.handleOffer(ev.from_fp, ev.call_id, ev.sdp)
      }
      if (ev.type === 'call_answer' && fpOk) {
        try { if (this.state && (ev as any).call_id === this.state.callId) this.promoteOnSignal(String((ev as any).call_id ?? '')) } catch { /* ignore */ }
        this.handleAnswer(ev.from_fp, ev.call_id, ev.sdp)
      }
      if (ev.type === 'call_ice' && fpOk) {
        try { if (this.state && (ev as any).call_id === this.state.callId) this.promoteOnSignal(String((ev as any).call_id ?? '')) } catch { /* ignore */ }
        this.handleIce(ev.from_fp, ev.call_id, ev.candidate, ev.mid)
      }
      // futuro engine com callSignal dedicado (hoje inexistente — ver nota do relay):
      // aceita `call_signal`/`call-signal`/`call_relay` com payload audio-chunk.
      if ((ev.type === 'call_signal' || ev.type === 'call-signal' || ev.type === 'call_relay') && fpOk) {
        try {
          const payload = (ev as any).payload ?? (ev as any).data ?? (ev as any).sdp ?? (ev as any).signal ?? ''
          if (typeof payload === 'string' && payload.indexOf('audio-chunk') >= 0) {
            this.handleRelayChunk(ev.from_fp, ev.call_id, payload)
          }
        } catch { /* nunca derruba o bus */ }
      }
      // NÃO adiciona participante em 'call_incoming': só aparece na chamada
      // quem REALMENTE entra (offer/answer/ICE). Antes o ring já listava o peer
      // antes de aceitar/conectar.
      if (ev.type === 'call_accepted') {
        // o outro lado atendeu → sinalização fluindo, mídia negociando
        if (this.state && this.state.callId === ev.call_id) this.applyPhase('accept')
      }
      if (ev.type === 'call_rejected') {
        if (this.state && this.state.callId === ev.call_id) {
          this.applyPhase('remote-reject')
          this.onCallNotice?.('chamada recusada')
          this.leave()
        }
      }
      if (ev.type === 'call_participant_added') {
        this.onParticipantAdded(String(ev.call_id ?? ''), String(ev.fp ?? ''))
      }
      if (ev.type === 'screen_share_offer') {
        this.onScreenShareSignal(String(ev.call_id ?? ''), String(ev.from_fp ?? ''), String(ev.sdp ?? ''))
      }
      // Reconexão automática: peer caiu → marca e vai pra 'reconnecting';
      // peer voltou → re-cria PC + nova offer (mesh volta a semear).
      if (ev.type === 'peer_offline' && typeof (ev as any).fp === 'string') this.onPeerGone((ev as any).fp)
      if (ev.type === 'peer_online' && typeof (ev as any).fp === 'string') this.onPeerBack((ev as any).fp)
      // Endpoint NAT do motor (upnp local sem servidor, ou reflexo stun).
      if ((ev as any).type === 'nat_endpoint') {
        try {
          const addr = String((ev as any).addr ?? '')
          const source = String((ev as any).source ?? '')
          if (addr && source) this.forgeNat = { addr, source }
        } catch { /* nunca derruba o bus */ }
      }
      if (ev.type === 'call_ended') {
        const st = this.state
        if (st && st.callId === ev.call_id) {
          // chamada perdida: desligaram enquanto tocava aqui
          const wasIncoming = st.phase === 'incoming'
          this.applyPhase('remote-ended')
          if (wasIncoming) this.onCallNotice?.('chamada perdida')
          this.leave()
        }
      }
    })
    // Repassa falhas de ICE (failed / disconnected >5s) para a UI via onIceFailed
    // E alimenta a máquina de fases (connected → reconnecting quando cai a rota).
    try { this.iceFailOff?.() } catch { /* ignore */ }
    this.iceFailOff = subscribeIceFailures((info) => {
      try { this.onIceFailed?.(info) } catch { /* ignore */ }
      try {
        const st = this.state
        if (st && info.callId === st.callId) {
          this.setFailureCause(
            info.state === 'failed'
              ? `ICE failed com ${info.fp.slice(0, 8)} (sem rota direta nem via TURN; NAT restritivo/CGNAT ou TURN fora)`
              : `rota com ${info.fp.slice(0, 8)} caiu (disconnected >12s; rede trocou/caiu — tentando ICE restart)`,
          )
          this.applyPhase('ice-failed')
          if (st.phase === 'reconnecting') this.startReconnectWatchdog()
        }
      } catch { /* fase nunca derruba o bus */ }
    })
    // Se o WebRTC conectar depois (TURN demorou), DESLIGA o áudio-via-relay
    // automaticamente — sem isso a chamada ficava presa em "via relay (latência
    // alta)" mesmo com rota direta disponível. Não mexe se foi ligado no manual.
    // Também promove a fase: ICE conectou = mídia ativa ('connected').
    try { this.iceRecoveredOff?.() } catch { /* ignore */ }
    try {
      this.iceRecoveredOff = subscribeIceRecovered((info) => {
        try {
          if (!this.state || info.callId !== this.state.callId) return
          const p = this.state.participants.find((x: any) => x.fp === info.fp)
          if (p) p.disconnected = false
          this.applyPhase('media-connected')
          if (this.relayActive && !this.relayManual) void this.setRelayMode(false)
        } catch { /* ignore */ }
      })
    } catch { this.iceRecoveredOff = null }
    this.ensureRelayTransport()
  }

  unbind() {
    this.engineOff?.()
    try { setLocalMediaNotice(null) } catch { /* ignore */ }
    try { this.iceFailOff?.() } catch { /* ignore */ }
    this.iceFailOff = null
    try { this.iceRecoveredOff?.() } catch { /* ignore */ }
    this.iceRecoveredOff = null
    this.teardownRelayTransport()
  }

  // ── Máquina de fases + reconexão automática ─────────────────────────────

  /** Última fase alcançada (idle no começo; pós-fim guarda o desfecho). */
  getPhase(): CallPhase {
    return this.state?.phase ?? this.lastPhase
  }

  /** Aplica um evento na máquina pura (callPhases.ts) e re-emite estado. */
  private applyPhase(ev: CallEvent): CallPhase | null {
    try {
      const st = this.state
      if (!st) return null
      const next = nextCallPhase(st.phase, ev)
      if (next !== st.phase) {
        st.phase = next
        this.lastPhase = next
        if (next === 'outgoing') this.startOutgoingWatchdog()
        else this.stopOutgoingWatchdog()
        if (next === 'incoming') this.startIncomingWatchdog()
        else this.stopIncomingWatchdog()
        if (next === 'reconnecting') this.startReconnectWatchdog()
        if (next === 'connected' || next === 'failed') this.stopReconnectWatchdog()
        if (next === 'connecting') this.startConnectWatchdog()
        if (next !== 'connecting') this.stopConnectWatchdog()
        // Saiu de outgoing/incoming para connecting/connected: os timers de
        // "sem resposta" não fazem mais sentido.
        if (next === 'connecting' || next === 'connected') {
          this.stopOutgoingWatchdog()
          this.stopIncomingWatchdog()
        }
        // Fase terminal: limpa todos os watchdogs de espera (não o de
        // reconexão, que já foi parado acima quando aplicável).
        if (next === 'ended' || next === 'rejected' || next === 'failed' || next === 'missed') {
          this.stopOutgoingWatchdog()
          this.stopIncomingWatchdog()
          this.stopConnectWatchdog()
        }
        this.onUpdate({ ...st })
      }
      return next
    } catch { /* fase nunca derruba a chamada */ }
    return null
  }

  /**
   * Watchdog de OUTGOING — corrige o "Chamando…" infinito.
   * Causa raiz: a fase só saía de `outgoing` via `call_accepted` (accept) ou
   * sinalização. Se o outro lado nunca atende, está offline, ou o frame de
   * aceite se perde, nada movia a máquina — overlay preso para sempre.
   * Aqui: após OUTGOING_TIMEOUT_MS sem sair de `outgoing`, encerra honesto.
   */
  private startOutgoingWatchdog() {
    this.stopOutgoingWatchdog()
    try {
      const callId = this.state?.callId
      this.outgoingTimer = setTimeout(() => {
        this.outgoingTimer = null
        try {
          const st = this.state
          if (!st || st.callId !== callId || st.phase !== 'outgoing') return
          this.setFailureCause('sem resposta do outro lado em 45s (peer offline, não atendeu, ou sinalização call_accepted/offer se perdeu)')
          this.onCallNotice?.('sem resposta — o outro lado não atendeu em 45s')
          this.applyPhase('reconnect-timeout') // outgoing → failed (ver callPhases)
          void this.leave()
        } catch { /* watchdog nunca derruba */ }
      }, CallManager.OUTGOING_TIMEOUT_MS)
    } catch { /* ignore */ }
  }
  private stopOutgoingWatchdog() {
    try { if (this.outgoingTimer) clearTimeout(this.outgoingTimer) } catch { /* ignore */ }
    this.outgoingTimer = null
  }
  /**
   * Watchdog de INCOMING — corrige o "Recebendo chamada" infinito.
   * Se quem ligou sumiu (rede caiu) sem `call_ended`, o telefone tocaria
   * para sempre. Após INCOMING_TIMEOUT_MS vira `missed` honesto.
   */
  private startIncomingWatchdog() {
    this.stopIncomingWatchdog()
    try {
      const callId = this.state?.callId
      this.incomingTimer = setTimeout(() => {
        this.incomingTimer = null
        try {
          const st = this.state
          if (!st || st.callId !== callId || st.phase !== 'incoming') return
          this.setFailureCause('chamada perdida: quem ligou sumiu sem enviar call_ended (rede caiu)')
          this.applyPhase('reconnect-timeout') // incoming → missed
          this.onCallNotice?.('chamada perdida')
          void this.leave()
        } catch { /* watchdog nunca derruba */ }
      }, CallManager.INCOMING_TIMEOUT_MS)
    } catch { /* ignore */ }
  }
  private stopIncomingWatchdog() {
    try { if (this.incomingTimer) clearTimeout(this.incomingTimer) } catch { /* ignore */ }
    this.incomingTimer = null
  }

  /** Sinalização fluindo (offer/answer/ICE) promove outgoing/incoming → connecting. */
  private promoteOnSignal(callId: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId) return
      if (st.phase === 'outgoing' || st.phase === 'incoming') this.applyPhase('signal')
    } catch { /* fase nunca derruba o bus */ }
  }

  /**
   * Watchdog de CONEXÃO — corrige o "Conectando…" infinito atrás de CGNAT.
   *
   * O que acontecia: atrás de NAT simétrico o ICE não falha (não chega
   * `ice-failed`), ele só fica em `checking` para sempre. Sem nenhum timeout, a
   * fase vivia em 'connecting' indefinidamente: usuário olhando "Conectando…"
   * com a chamada morta e nenhum aviso. Só o watchdog de RECONEXÃO existia, e
   * ele só arma quando a fase JÁ virou 'reconnecting'.
   *
   * Aqui: ao entrar em 'connecting', se em CONNECT_TIMEOUT_MS nenhum peer tiver
   * mídia viva, tratamos como rota ausente → reinício de ICE em todos os peers
   * + 'ice-failed' (→ 'reconnecting'). O orçamento de restarts é limitado e o
   * watchdog de reconexão encerra a chamada com aviso honesto: sem relay
   * automático, "não fecha" é uma resposta válida — "fica conectando para
   * sempre" não é.
   */
  private startConnectWatchdog() {
    this.stopConnectWatchdog()
    this.connectWatchdogGrants = 0
    try {
      this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(), CallManager.CONNECT_TIMEOUT_MS)
    } catch { /* ignore */ }
  }

  /** Corpo do watchdog de conexão (extraído para poder reagendar a si mesmo). */
  private onConnectWatchdogFire() {
    this.connectTimer = null
    try {
      const st = this.state
      if (!st || st.phase !== 'connecting') return
      if (this.relayActive) return // relay já é a rota viva
      let anyAlive = false
      for (const pc of this.pcs.values()) {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          anyAlive = true
          break
        }
      }
      if (anyAlive) return
      // Se algum PC ainda está COLETANDO candidatos, NÃO force nada: em 4G a
      // alocação no TURN leva segundos e um restart aqui jogaria fora o
      // gathering em andamento — trocando "demorou" por "nunca fecha". Dá mais
      // uma janela, com teto, para não virar espera infinita.
      let stillGathering = false
      for (const pc of this.pcs.values()) {
        if (pc.iceGatheringState === 'gathering') { stillGathering = true; break }
      }
      if (stillGathering && this.connectWatchdogGrants < 2) {
        this.connectWatchdogGrants++
        this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(), CallManager.CONNECT_TIMEOUT_MS)
        return
      }
      try { this.onCallNotice?.('sem rota de mídia direta — reiniciando ICE') } catch { /* ignore */ }
      this.setFailureCause('sem rota de mídia em 20s (ICE preso em checking/gathering sem par selecionado; NAT/CGNAT ou TURN inalcançável — ver painel)')
      this.restartIceAll(st.callId)
      this.applyPhase('ice-failed')
    } catch { /* watchdog nunca derruba */ }
  }

  private stopConnectWatchdog() {
    try { if (this.connectTimer) clearTimeout(this.connectTimer) } catch { /* ignore */ }
    this.connectTimer = null
  }

  /**
   * Watchdog da reconexão: se NENHUM PC tem mídia viva por RECONNECT_TIMEOUT_MS
   * (ICE restarts + re-invite falharam), encerra com aviso honesto em vez de
   * deixar o overlay "reconectando…" para sempre.
   */
  private startReconnectWatchdog() {
    this.stopReconnectWatchdog()
    try {
      this.reconnectTimer = setTimeout(() => {
        try {
          const st = this.state
          if (!st || !isCallPhaseActive(st.phase)) return
          let anyAlive = false
          for (const pc of this.pcs.values()) {
            const s = pc.iceConnectionState
            if (s === 'connected' || s === 'completed') { anyAlive = true; break }
          }
          if (anyAlive) {
            this.applyPhase('media-reconnected')
            return
          }
          this.setFailureCause('reconexão falhou — sem rota de mídia após 30s (ICE restarts esgotados; NAT/CGNAT sem TURN válido)')
          this.applyPhase('reconnect-timeout')
          this.onCallNotice?.('reconexão falhou — sem rota de mídia após 30s')
          void this.leave()
        } catch { /* watchdog nunca derruba */ }
      }, CallManager.RECONNECT_TIMEOUT_MS)
    } catch { /* ignore */ }
  }

  private stopReconnectWatchdog() {
    try { if (this.reconnectTimer) clearTimeout(this.reconnectTimer) } catch { /* ignore */ }
    this.reconnectTimer = null
  }

  /** Cancela todos os restarts de ICE agendados (fim de chamada/pausa). */
  private clearIceRestartTimers() {
    for (const t of this.iceRestartTimers.values()) {
      try { clearTimeout(t) } catch { /* ignore */ }
    }
    this.iceRestartTimers.clear()
  }

  /** Peer participante caiu (engine peer_offline): marca e entra em reconexão. */
  private onPeerGone(fp: string) {
    try {
      const st = this.state
      if (!st || !fp || fp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fp)
      if (!p) return // não é desta chamada
      p.disconnected = true
      if (st.phase === 'connected') this.applyPhase('ice-failed') // → reconnecting
      else this.onUpdate({ ...st })
    } catch { /* ignore */ }
  }

  /**
   * Peer voltou (engine peer_online): se é participante e o PC morreu,
   * re-cria o PC + dispara nova offer (ICE restart de verdade). O outro lado
   * (que também pode re-oferecer) resolve glare pelo polite/impolite.
   */
  private onPeerBack(fp: string) {
    try {
      const st = this.state
      if (!st || !fp || fp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fp)
      if (!p) return
      p.disconnected = false
      const pc = this.pcs.get(fp)
      const dead = !pc
        || pc.connectionState === 'closed'
        || pc.iceConnectionState === 'failed'
        || pc.iceConnectionState === 'closed'
        || pc.iceConnectionState === 'disconnected'
      if (dead && isCallPhaseActive(st.phase)) {
        try { pc?.close() } catch { /* ignore */ }
        this.pcs.delete(fp)
        this.iceRestarts.delete(fp)
        this.localIce.delete(fp)
        this.lastRemoteOffer.delete(fp)
        this.createPC(fp, st.callId, true).catch(() => {})
      }
      this.onUpdate({ ...st })
    } catch { /* ignore */ }
  }

  /** Grupo real: outro participante adicionou `fp` à chamada (mesh). */
  private onParticipantAdded(callId: string, fp: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId) return
      if (!fp || fp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fp)
      if (!p) {
        st.participants.push({ fp, nickname: fp.slice(0, 6) })
        // cada participante existente oferece conexão ao novo (anti-glare:
        // o novo peer só responde — todos os offers vêm de um lado só).
        this.createPC(fp, callId, true).catch(() => {})
      } else if (p.disconnected) {
        // Já estava na lista, mas marcado como desconectado (caiu e voltou):
        // antes ficava com o avatar cinza mesmo vivo. `onPeerBack` cuida da
        // reconexão; aqui só limpamos o estado visual.
        p.disconnected = false
      }
      this.onUpdate({ ...st })
    } catch { /* ignore */ }
  }

  /**
   * Sinal dedicado de TELA (frame ScreenShareOffer): o campo sdp carrega um
   * JSON de estado {screen:'on'|'off'} — quem compartilha fica com badge TELA
   * em todos os receptores, sem gambiarra nos m-lines de vídeo.
   */
  private onScreenShareSignal(callId: string, fromFp: string, sdpStr: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId || !fromFp || fromFp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fromFp)
      if (!p) return
      let on: boolean | null = null
      try {
        const parsed = JSON.parse(sdpStr)
        if (parsed && typeof parsed === 'object') on = (parsed as any).screen === 'on'
      } catch { /* sdp legado: ignora */ }
      if (on !== null) {
        p.sharing = on
        this.onUpdate({ ...st })
      }
    } catch { /* ignore */ }
  }

  /** Envia o sinal de TELA (on/off) para todos os participantes ativos. */
  private broadcastScreenSignal(on: boolean) {
    try {
      const st = this.state
      if (!st) return
      const payload = JSON.stringify({ screen: on ? 'on' : 'off' })
      for (const p of st.participants) {
        if (!p.fp || p.fp === this.myFp) continue
        services.screenShareOffer(p.fp, st.callId, payload).catch(() => {})
      }
    } catch { /* best-effort */ }
  }

  async start(kind: CallKind, convId: string, targetFps: string[]): Promise<CallState> {
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    const me = this.getIdentity()
    if (!me) throw new Error('sem identidade')
    this.myFp = me.fingerprint

    this.quality = getStoredQuality()
    this.qualityNotice = null
    this.badWindows = 0
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch { /* ignore */ }
    try { this.lastNativeStats = null } catch { /* ignore */ }
    this.prevLost.clear()
    // mídia local (mesmo em voice pedimos áudio para detectar falando)
    // sem mic/permissão → null; o PC sem tracks ainda completa a sinalização
    const qOrVideo: MediaTrackConstraints | boolean = kind === 'video' ? { ...CAMERA_CONSTRAINTS } : false
    const constraints: MediaStreamConstraints = kind === 'video' ? { audio: true, video: qOrVideo } : { audio: true, video: false }
    this.localStream = await getLocalMedia(constraints)

    const callId = await services.callInvite(targetFps[0] ?? convId, kind).catch(() => `call-${Math.random().toString(36).slice(2, 8)}`)
    for (const fp of targetFps.slice(1)) {
      if (fp === me.fingerprint) continue
      try { await services.callAddParticipant(fp, callId, fp, kind) } catch { /* ring best-effort */ }
    }
    // CHAMADA NATIVA (voz em Rust): o core cuida de offer/answer/ICE e da
    // mídia. Se eu tentasse seguir por aqui, `new RTCPeerConnection` explodiria
    // com ReferenceError no WebKitGTK (RTCPeerConnection não existe lá), e
    // `getUserMedia` abriria um segundo microfone competindo com o do core.
    if (nativeVoiceAvailable === true) {
      this.localStream = null
      this.screenStream = null
      this.resetRelayForNewCall()
      this.state = {
        callId,
        kind,
        convId,
        phase: 'connecting',
        startedAt: Date.now(),
        startAt: Date.now(),
        quality: this.quality,
        muted: false,
        deafened: false,
        cameraOn: false,
        screenOn: false,
        sharing: false,
        participants: [{ fp: me.fingerprint, nickname: me.nickname, muted: false }],
        nativeMedia: true,
      } as unknown as CallState
      this.startNativeVoiceMonitor(callId)
      this.onUpdate({ ...this.state })
      return this.state
    }

    this.resetRelayForNewCall()
    this.state = {
      callId,
      kind,
      convId,
      phase: 'outgoing',
      muted: false,
      deafened: false,
      cameraOn: kind === 'video',
      sharing: false,
      participants: [{ fp: me.fingerprint, nickname: me.nickname, stream: this.localStream ?? undefined }],
      startAt: Date.now(),
      quality: this.quality,
      qualityNotice: null,
      relayActive: false,
      relayManual: false,
      relayReason: null,
    }
    // Watchdogs ANTI-INFINITO: outgoing (sem resposta) + connecting (sem rota).
    // Antes só existia o de reconexão (que só arma em `reconnecting`) — por
    // isso "Chamando…"/"Conectando…" ficavam presos para sempre.
    this.startOutgoingWatchdog()
    this.ensureRelayTransport()
    this.startQualityMonitor()
    // mesh: cria PC para cada alvo
    for (const fp of targetFps) {
      if (fp === me.fingerprint) continue
      await this.createPC(fp, callId, true)
    }
    // para grupo >10, convida resto via CallAddParticipant (engine relay)
    this.onUpdate({ ...this.state })
    return this.state
  }

  async joinVoice(communityId: string, channelId: string) {
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    await services.voiceJoin(communityId, channelId)
    // também cria call de voz local (apenas áudio) para o canal — todos semeiam o áudio entre si
    const me = this.getIdentity()
    if (!me) return
    const callId = `voice-${communityId}-${channelId}`
    this.quality = getStoredQuality()
    this.qualityNotice = null
    this.badWindows = 0
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch { /* ignore */ }
    try { this.lastNativeStats = null } catch { /* ignore */ }
    this.prevLost.clear()
    this.localStream = await getLocalMedia({ audio: true })
    this.resetRelayForNewCall()
    this.state = {
      callId,
      kind: 'voice',
      convId: channelId,
      phase: 'connecting',
      muted: false,
      deafened: false,
      cameraOn: false,
      sharing: false,
      participants: [{ fp: me.fingerprint, nickname: me.nickname, stream: this.localStream ?? undefined }],
      startAt: Date.now(),
      quality: this.quality,
      qualityNotice: null,
      relayActive: false,
      relayManual: false,
      relayReason: null,
    }
    // Entrada direta em `connecting` (sem passar por applyPhase): arma o
    // watchdog aqui — senão "Conectando…" infinito se o ICE nunca fechar.
    this.startConnectWatchdog()
    this.ensureRelayTransport()
    this.startQualityMonitor()
    this.onUpdate({ ...this.state })
  }

  // ── joinVoiceRelayOnly REMOVIDO ──────────────────────────────────────────
  // Não existe mais modo relay-only: sem WebRTC a chamada falha honesto em vez
  // de degradar para áudio pelo túnel de sinalização (latência alta). Ver
  // `getCallsSupport`, que só devolve 'full' | 'none'.
  getQuality(): CallQuality { return this.quality }

  getQualityNotice(): string | null { return this.qualityNotice }
  // ── Relay fallback: API pública ──────────────────────────────────────────
  /** True quando o áudio está saindo/entrando via sinalização (não via WebRTC). */
  isRelayActive(): boolean { return this.relayActive }
  isRelayManual(): boolean { return this.relayManual }
  getRelayReason(): string | null { return this.relayReason }
  supportsRelay(): boolean {
    try { return supportsRelayFallback() || supportsRelayPlayback() } catch { return false }
  }

  /**
   * Toggle manual "modo compatibilidade" (UI da chamada).
   * Liga/desliga o relay sem derrubar o WebRTC (preferido continua ativo).
   * 3ª tier de áudio: WebRTC direto → TURN-localhost via relay → voz via relay.
   */
  async setRelayMode(on: boolean, reason?: string): Promise<boolean> {
    try {
      if (on) {
        if (!canUseRelayCalls()) return false
        await this.startRelay(reason ?? 'manual')
        this.relayManual = true
        this.syncRelayToState()
        return true
      }
      this.stopRelayFull()
      this.syncRelayToState()
      return true
    } catch { return false }
  }
  // ── toggleRelay/setCompatMode REMOVIDOS ──────────────────────────────────
  // O botão "R" (modo compatibilidade) saiu da tela de chamada: não existe mais
  // caminho para ligar o relay de voz a partir da UI. `setRelayMode` continua
  // aqui, agora inalcançável, caso o transporte volte a fazer sentido. O relay
  // de ARQUIVOS é outro caminho, intocado.

  /**
   * Resumo da rota ICE em uma linha, para a tela de chamada mostrar COMO a
   * mídia está indo. É a informação que responde "por que não conecta?" sem
   * obrigar o usuário a abrir o diagnóstico:
   *   - `host`    = IP privado dos dois lados: só funciona na LAN
   *   - `srflx`   = via STUN: saiu do NAT, mas CGNAT simétrico ainda barra
   *   - `relay`   = via TURN: é o caminho que fecha atrás de CGNAT
   *   - `n/d`     = ainda sem par escolhido (o sintoma do loop)
   */
  getRungSummary(): string {
    try {
      // Chamada NATIVA: a mídia está no Rust, então `iceReports` (do WebRTC do
      // navegador) fica vazio e a tela mostrava "sem rota" mesmo conectada.
      if (nativeRoute && nativeRoute !== 'n/d') return nativeRoute
      const reports = [...this.iceReports.values()]
      if (!reports.length) return 'n/d'
      const routes = reports.map((r) => {
        const t = r.remoteType || r.localType || 'host'
        return t === 'relay' ? 'TURN' : t === 'srflx' ? 'STUN' : t === 'prflx' ? 'P2P' : 'LAN'
      })
      const uniq = [...new Set(routes)]
      return uniq.join('+') || 'n/d'
    } catch { return 'n/d' }
  }

  /** Zera o estado de relay entre chamadas (o áudio-via-relay foi removido da
   *  UI, mas o transporte interno ainda existe — não pode vazar estado). */
  private resetRelayForNewCall() {
    try {
      this.clearRelayFallbackTimer()
      this.relayActive = false
      this.relayManual = false
      this.relayReason = null
    } catch { /* nunca derruba a chamada */ }
  }

  /**
   * Atende uma chamada entrante do lado answerer (a UI chamava só
   * services.callAccept + setActiveCall manual, sem estado no CallManager —
   * o relay e o mesh precisam deste estado para funcionar).
   */
  async acceptInbound(callId: string, kind: CallKind, convId: string, fromFp: string, nickname?: string): Promise<CallState> {
    const me = this.getIdentity()
    if (!me) throw new Error('sem identidade')
    this.myFp = me.fingerprint
    if (this.state && this.state.callId === callId) {
      if (this.state.phase === 'incoming') this.applyPhase('accept')
      if (!this.state.participants.find(p => p.fp === fromFp)) {
        this.state.participants.push({ fp: fromFp, nickname: nickname ?? fromFp.slice(0, 6) })
        this.syncRelayToState()
      }
      // Garante mic/câmera em todos os PCs (a offer pode ter chegado antes do accept).
      if (!this.localStream) {
        try {
          this.localStream = kind === 'video'
            ? await getLocalMedia({ audio: true, video: { ...CAMERA_CONSTRAINTS } })
            : await getLocalMedia({ audio: true })
        } catch { this.localStream = null }
      }
      await this.ensureMediaOnAllPCs()
      try {
        const pend = this.pendingOffers.get(fromFp)
        if (pend && pend.callId === callId) {
          this.pendingOffers.delete(fromFp)
          await this.handleOffer(fromFp, pend.callId, pend.sdp)
        }
      } catch { /* offer pendente nunca derruba o accept */ }
      return this.state
    }
    // mic do answerer (áudio sempre; vídeo só se for chamada de vídeo)
    if (!this.localStream) {
      try {
        this.localStream = kind === 'video'
          ? await getLocalMedia({ audio: true, video: { ...CAMERA_CONSTRAINTS } })
          : await getLocalMedia({ audio: true })
      } catch { this.localStream = null }
    }
    this.resetRelayForNewCall()
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch { /* ignore */ }
    try { this.lastNativeStats = null } catch { /* ignore */ }
    this.state = {
      callId,
      kind,
      convId,
      phase: 'connecting',
      muted: false,
      deafened: false,
      cameraOn: kind === 'video',
      sharing: false,
      participants: [
        { fp: me.fingerprint, nickname: me.nickname, stream: this.localStream ?? undefined },
        ...(fromFp === me.fingerprint ? [] : [{ fp: fromFp, nickname: nickname ?? fromFp.slice(0, 6) }]),
      ],
      startAt: Date.now(),
      quality: this.quality,
      qualityNotice: null,
      relayActive: false,
      relayManual: false,
      relayReason: null,
    }
    // Entrada direta em `connecting`: arma o watchdog (ver joinVoice/start).
    this.startConnectWatchdog()
    this.startQualityMonitor()
    this.ensureRelayTransport()
    this.syncRelayToState()
    // Sem degradação para áudio-via-relay: o fluxo é WebRTC direto (host/STUN/
    // TURN) ou falha honesta. Um WebView sem RTCPeerConnection nunca vai
    // "funcionar meio" — antes ele ficava preso em 'connecting' para sempre,
    // que era o sintoma reportado no celular.
    await this.ensureMediaOnAllPCs()
    try {
      const pend = this.pendingOffers.get(fromFp)
      if (pend && pend.callId === callId) {
        this.pendingOffers.delete(fromFp)
        await this.handleOffer(fromFp, pend.callId, pend.sdp)
      }
    } catch { /* offer pendente nunca derruba o accept */ }
    return this.state
  }

  // ── startRelayOnly REMOVIDO ──────────────────────────────────────────────
  // Sem WebRTC, `start()` agora lança com a mensagem honesta. Ver
  // `getCallsSupport`.

  private syncRelayToState() {
    if (!this.state) return
    try {
      this.state = {
        ...this.state,
        relayActive: this.relayActive,
        relayManual: this.relayManual,
        relayReason: this.relayReason,
      }
      this.onUpdate({ ...this.state })
    } catch { /* nunca derruba a chamada */ }
  }
  private async startRelay(reason: string): Promise<void> {
    // Manual tem precedência no motivo exibido.
    this.relayActive = true
    this.relayReason = reason
    if (reason === 'manual' || reason === 'relay-only') this.relayManual = true
    this.ensureRelayTransport()
    this.syncRelayToState()
    try {
      await this.ensureRelayRecorder()
    } catch (e) {
      // Falhou o microfone/codec: a chamada NÃO pode virar um beco sem saída
      // silencioso. Sem `relayActive` a fase nunca sairia de "Conectando…".
      // Ainda dá para RECEBER áudio (playback puro), então mantemos o relay de
      // pé e avisamos o usuário com o motivo real.
      this.relayActive = true
      try {
        this.onCallNotice?.(
          `só dá para OUVIR nesta chamada: ${(e as Error)?.message ?? 'microfone indisponível'}`,
        )
      } catch { /* ignore */ }
    }
    // Grace: quem está mudo (ou sem mic) nunca emite chunk — sem isto a fase
    // fica presa em "Chamando…" mesmo com o caminho relay de pé.
    this.markRelayConnectedFallback()
    this.syncRelayToState()
  }
  /**
   * Áudio relay está TOCANDO de verdade (primeiro chunk decodificado e
   * agendado). Move a fase para 'connected' — sem isto a chamada relay-only
   * fica presa em "Conectando…" para sempre, porque não existe
   * RTCPeerConnection emitindo ICE connected e o evento `media-connected`
   * nunca chega. Só marca se ainda não estiver connected (idempotente).
   */
  private markRelayAudioLive() {
    try {
      const st = this.state
      if (!st) return
      if (st.phase === 'connected') return
      this.applyPhase('relay-audio-live')
    } catch { /* fase nunca derruba a chamada */ }
  }

  /**
   * Fallback do relay: marca "conectado" mesmo sem áudio rodando.
   *
   * Motivo real: quem fica MUDO durante a chamada (ou com o microfone negado
   * no aparelho) nunca emite `ondataavailable`, e quem é muteado pelos dois
   * lados nunca recebe chunk — então o gatilho de áudio nunca dispara e a
   * chamada ficaria presa em "Chamando…"/"Conectando…" mesmo com o caminho
   * relay pronto. Aqui, com o transporte de áudio subido (relay ativo +
   * sinalização fechada), declaramos conectado após um grace curto.
   */
  private markRelayConnectedFallback() {
    try {
      const st = this.state
      if (!st || !this.relayActive) return
      if (st.phase === 'connected' || st.phase === 'ended' || st.phase === 'failed') return
      try { if (this.relayFallbackTimer) clearTimeout(this.relayFallbackTimer) } catch { /* ignore */ }
      this.relayFallbackTimer = setTimeout(() => {
        this.relayFallbackTimer = null
        try {
          const cur = this.state
          if (!cur || !this.relayActive) return
          if (cur.phase === 'connected' || cur.phase === 'ended' || cur.phase === 'failed') return
          this.markRelayAudioLive()
        } catch { /* nunca derruba */ }
      }, CallManager.RELAY_CONNECT_GRACE_MS)
    } catch { /* ignore */ }
  }

  private clearRelayFallbackTimer() {
    try { if (this.relayFallbackTimer) clearTimeout(this.relayFallbackTimer) } catch { /* ignore */ }
    this.relayFallbackTimer = null
  }

  private stopRelaySender() {
    try { this.relayRecorder?.stop() } catch { /* ignore */ }
    this.relayRecorder = null
    // BUG REAL que isto corrige: `ensureRelayRecorder` reaproveita `localStream`
    // quando ele já tem áudio (para não pedir o mic 2x). Ao desligar o relay,
    // parar os tracks daquele stream MATAVA o microfone que o WebRTC ainda
    // usava — a chamada continuava "conectada" mas silenciava para sempre
    // depois de um fallback de áudio. Agora só paramos os tracks de um stream
    // DEDICADO (criado só para o relay); o compartilhado fica intacto.
    const shared = !this.relayRecDedicated
    if (!shared) {
      try { this.relayRecStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
    }
    this.relayRecDedicated = false
    this.relayRecStream = null
  }
  private stopRelayFull() {
    this.stopRelaySender()
    this.relayHeaderBytes = null
    this.relayQueues.clear()
    this.relayActive = false
    this.relayReason = null
    // mantém relayManual? Não — saída limpa reseta tudo (nova chamada decide de novo).
    this.relayManual = false
    // grace pendente não pode sobreviver à desligar: senão ele acorda depois e
    // marca "connected" numa chamada já encerrada.
    this.clearRelayFallbackTimer()
  }
  private ensureRelayTransport() {
    // BroadcastChannel p/ demo multi-aba (browser: callIce é no-op)
    try {
      if (!this.relayBc && typeof BroadcastChannel !== 'undefined') {
        this.relayBc = new BroadcastChannel(RELAY_BC_NAME)
        this.relayBc.onmessage = (ev: MessageEvent) => {
          try {
            const d: any = (ev as any).data
            if (!d || d.type !== 'forge-call-relay') return
            if (typeof d.payload !== 'string') return
            if (d.from_fp === this.myFp) return
            this.handleRelayChunk(String(d.from_fp ?? ''), String(d.call_id ?? ''), d.payload)
          } catch { /* ignore */ }
        }
      }
    } catch { this.relayBc = null }
    try {
      if (typeof window !== 'undefined' && !this.relayWindowHandler) {
        this.relayWindowHandler = (e: Event) => {
          try {
            const d: any = (e as CustomEvent).detail
            if (!d || typeof d.payload !== 'string') return
            if (d.from_fp === this.myFp) return
            this.handleRelayChunk(String(d.from_fp ?? ''), String(d.call_id ?? ''), d.payload)
          } catch { /* ignore */ }
        }
        window.addEventListener(RELAY_WINDOW_EVENT, this.relayWindowHandler as EventListener)
      }
    } catch { /* ignore */ }
  }
  private teardownRelayTransport() {
    try { this.relayBc?.close() } catch { /* ignore */ }
    this.relayBc = null
    try {
      if (typeof window !== 'undefined' && this.relayWindowHandler) {
        window.removeEventListener(RELAY_WINDOW_EVENT, this.relayWindowHandler as EventListener)
      }
    } catch { /* ignore */ }
    this.relayWindowHandler = null
  }
  private async ensureRelayRecorder(): Promise<void> {
    if (this.relayRecorder) {
      try { if (this.relayRecorder.state === 'recording') return } catch { return }
    }
    const MR: any = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null
    if (!MR) throw new Error('MediaRecorder indisponível')
    // Prefere os tracks de áudio já capturados (sem pedir mic 2x); senão pede mic dedicado.
    // eslint-disable-next-line no-useless-assignment
    let stream: MediaStream | null = null
    try {
      const audioTracks = this.localStream?.getAudioTracks().filter(t => t.readyState === 'live') ?? []
      if (audioTracks.length > 0 && this.localStream) {
        // MediaRecorder precisa de um MediaStream — reusa o local (só áudio sai no opus).
        stream = this.localStream
      } else {
        stream = await getLocalMedia({ audio: true })
      }
    } catch { stream = null }
    if (!stream) throw new Error('sem microfone para o modo compatibilidade')
    // Se o localStream não tinha áudio mas conseguimos mic agora, anexa p/ WebRTC também.
    try {
      if (this.localStream && stream !== this.localStream) {
        const at = stream.getAudioTracks()[0]
        if (at && this.localStream.getAudioTracks().length === 0) {
          try { this.localStream.addTrack(at) } catch { /* ignore */ }
        }
      }
      if (!this.localStream) this.localStream = stream
    } catch { /* ignore */ }
    this.relayRecStream = stream
    // Marca se este stream é DEDICADO ao relay. Stop só pode matar tracks de
    // stream dedicado — see stopRelaySender (bug do microfone WebRTC calado).
    this.relayRecDedicated = stream !== this.localStream
    // buildRelayRecorder testa cada codec de verdade e, se nenhum funcionar,
    // lança erro HONESTO (o chamador avisa e a chamada segue só-recebendo).
    const { rec, mime: mimeUsed } = buildRelayRecorder(MR, stream)
    this.relaySeq = this.relaySeq || 0
    this.relayHeaderBytes = null
    rec.ondataavailable = (e: BlobEvent) => {
      try {
        const blob = e.data
        if (!blob || blob.size === 0) return
        if (this.state?.muted) return
        if (!this.relayActive) return
        void this.encodeRelayChunk(blob).then((b64) => {
          try {
            if (!b64) return
            if (!this.relayActive || !this.state) return
            if (this.state.muted) return
            this.relaySeq += 1
            const payload = JSON.stringify({
              kind: 'audio-chunk',
              seq: this.relaySeq,
              data: b64,
              ts: Date.now(),
              mime: mimeUsed,
            } satisfies RelayChunkPayload)
            const callId = this.state.callId
            const targets = new Set<string>()
            try {
              for (const p of this.state.participants) if (p.fp && p.fp !== this.myFp) targets.add(p.fp)
              for (const k of this.pcs.keys()) if (k !== this.myFp) targets.add(k)
            } catch { /* ignore */ }
            if (targets.size === 0) return
            for (const fp of targets) this.sendRelayPayload(fp, callId, payload)
            // Saída real de áudio relay: quem fala não ouve a si mesmo, então
            // precisa do mesmo gatilho de "conectado" que o receptor tem.
            this.markRelayAudioLive()
          } catch { /* ignore */ }
        }).catch(() => {})
      } catch { /* ignore */ }
    }
    try { rec.onerror = () => {} } catch { /* ignore */ }
    this.relayRecorder = rec
    try { rec.start(RELAY_TIMESLICE_MS) } catch { /* ignore */ }
  }
  /**
   * O MediaRecorder emite o 1º chunk COM o cabeçalho WebM e os seguintes SEM —
   * `decodeAudioData` só decodifica se o cabeçalho estiver presente. Guardamos o
   * 1º chunk e o prefixamos em todos os demais. Sem isso o fallback "toca
   * silêncio" no receptor (bug real do modo compatibilidade).
   */
  private async encodeRelayChunk(blob: Blob): Promise<string | null> {
    try {
      const buf = new Uint8Array(await blob.arrayBuffer())
      if (!this.relayHeaderBytes) this.relayHeaderBytes = buf
      const header = this.relayHeaderBytes
      let full = buf
      if (header && header !== buf) {
        full = new Uint8Array(header.length + buf.length)
        full.set(header, 0)
        full.set(buf, header.length)
      }
      return bytesToBase64(full)
    } catch { return null }
  }

  private sendRelayPayload(targetFp: string, callId: string, payload: string) {
    // 1) Futuro engine com callSignal dedicado (hoje inexistente — tenta sem quebrar).
    try {
      const anySvc: any = services as any
      if (typeof anySvc?.callSignal === 'function') {
        try { anySvc.callSignal(targetFp, callId, payload).catch(() => {}) } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    // 2) Sinalização existente: callIce com mid 'audio-relay' (cifrado via SecureFrame/relay).
    try { services.callIce(targetFp, callId, payload, RELAY_MID).catch(() => {}) } catch { /* ignore */ }
    // 3) Demo local multi-aba (browser: callIce é no-op) — BroadcastChannel + window event.
    try { this.relayBc?.postMessage({ type: 'forge-call-relay', call_id: callId, from_fp: this.myFp, payload }) } catch { /* ignore */ }
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(RELAY_WINDOW_EVENT, { detail: { call_id: callId, from_fp: this.myFp, payload } }))
      }
    } catch { /* ignore */ }
  }
  private handleRelayChunk(fromFp: string, callId: string, payloadStr: string) {
    try {
      if (!fromFp || !callId || typeof payloadStr !== 'string') return
      if (!this.state || this.state.callId !== callId) return
      if (fromFp === this.myFp) return
      if (this.state.deafened) return
      let parsed: any = null
      try { parsed = JSON.parse(payloadStr) } catch { return }
      if (!isRelayChunkPayload(parsed)) return
      const chunk = parsed as RelayChunkPayload
      // descarta atraso >2s (jitter buffer simples)
      try { if (Date.now() - Number(chunk.ts || 0) > RELAY_MAX_DELAY_MS) return } catch { /* segue */ }
      if (!chunk.data || chunk.data.length === 0) return
      void this.playRelayChunk(fromFp, chunk)
    } catch { /* nunca derruba o bus */ }
  }
  private ensureAudioCtx(): AudioContext | null {
    try {
      if (this.relayAudioCtx) {
        try { if (this.relayAudioCtx.state === 'suspended') void this.relayAudioCtx.resume().catch(() => {}) } catch { /* ignore */ }
        return this.relayAudioCtx
      }
      const AC: any = typeof AudioContext !== 'undefined' ? AudioContext : (typeof window !== 'undefined' ? (window as any).webkitAudioContext : null)
      if (!AC) return null
      this.relayAudioCtx = new AC()
      try { if (this.relayAudioCtx && this.relayAudioCtx.state === 'suspended') void this.relayAudioCtx.resume().catch(() => {}) } catch { /* ignore */ }
      return this.relayAudioCtx
    } catch { return null }
  }
  private async playRelayChunk(fromFp: string, chunk: RelayChunkPayload): Promise<void> {
    try {
      const ctx = this.ensureAudioCtx()
      if (!ctx) return
      // descarta atraso >2s também na hora de tocar (ficou enfileirado demais)
      try { if (Date.now() - Number(chunk.ts || 0) > RELAY_MAX_DELAY_MS) return } catch { /* segue */ }
      let bytes: Uint8Array
      try { bytes = b64ToBytes(chunk.data) } catch { return }
      if (bytes.length === 0) return
      let buf: AudioBuffer | null = null
      try {
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
        buf = await ctx.decodeAudioData(ab)
      } catch { return }
      if (!buf) return
      let entry = this.relayQueues.get(fromFp)
      if (!entry) {
        entry = { nextSeq: chunk.seq, nextTime: 0, pending: new Map() }
        this.relayQueues.set(fromFp, entry)
      }
      // jitter buffer simples: enfileira por seq; se lotar (>12 ≈ 6s), descarta o mais antigo.
      try {
        entry.pending.set(chunk.seq, { buf, ts: Number(chunk.ts || Date.now()) })
        if (entry.pending.size > 12) {
          const keys = [...entry.pending.keys()].sort((a, b) => a - b)
          const drop = keys.slice(0, entry.pending.size - 12)
          for (const k of drop) entry.pending.delete(k)
          if (entry.nextSeq < (keys[0] ?? entry.nextSeq)) entry.nextSeq = keys[0] ?? entry.nextSeq
        }
      } catch { /* ignore */ }
      this.scheduleRelayPlayback(fromFp)
    } catch { /* ignore */ }
  }
  /**
   * Agenda os chunks em sequência no AudioContext (GAPLESS): usa um "playhead"
   * (`nextTime`) e `src.start(quando)` para encostar um chunk no outro, sem o
   * silêncio que o encadeamento por `onended` causava. Buracos de seq (perda)
   * são pulados, e chunk atrasado (>2s) é descartado em vez de tocar velho.
   */
  private scheduleRelayPlayback(fp: string) {
    try {
      const entry = this.relayQueues.get(fp)
      const ctx = this.relayAudioCtx
      if (!entry || !ctx) return
      let guard = 0
      while (entry.pending.size > 0 && guard++ < 8) {
        const keys = [...entry.pending.keys()].sort((a, b) => a - b)
        const pick = keys.find(k => k >= entry.nextSeq) ?? null
        if (pick === null) break
        const item = entry.pending.get(pick)
        if (!item) break
        entry.pending.delete(pick)
        entry.nextSeq = pick + 1
        // descarta atraso >2s (não vale tocar áudio velho)
        if (Date.now() - item.ts > RELAY_MAX_DELAY_MS) continue
        const now = ctx.currentTime
        if (entry.nextTime < now + 0.02) entry.nextTime = now + 0.05 // underrun: reancora
        const src = ctx.createBufferSource()
        src.buffer = item.buf
        try { src.connect(ctx.destination) } catch { /* ignore */ }
        try { src.start(entry.nextTime) } catch { /* ignore */ }
        entry.nextTime += item.buf.duration
        // Áudio relay REAL em reprodução: sem isto a fase nunca sai de
        // 'connecting' (não existe ICE para reportar media-connected) e o
        // overlay fica "Conectando…" para sempre mesmo com áudio passando.
        this.markRelayAudioLive()
      }
    } catch { /* ignore */ }
  }

  /**
   * Troca a qualidade de vídeo em chamada (CÂMERA + TELA).
   * - aplica applyConstraints no track vivo (câmera e/ou tela)
   * - renegocia cada PC (novo offer) quando em chamada
   * - se falhar, mantém a qualidade atual e lança erro honesto em pt-BR
   */
  async setQuality(q: CallQuality): Promise<void> {
    const prev = this.quality
    try {
      const tracks: MediaStreamTrack[] = []
      // A TELA tem degrau próprio (screenShare.ts): trocar a qualidade da câmera
      // não pode sobrescrever a da tela com constraints de câmera. Quando está
      // compartilhando, o seletor da tela assume (ver adaptScreenQuality).
      const camTrack = this.localStream?.getVideoTracks()[0] ?? null
      if (camTrack && camTrack.readyState === 'live') tracks.push(camTrack)
      for (const track of tracks) {
        try {
          await track.applyConstraints({ ...QUALITY_CONSTRAINTS[q] } as MediaTrackConstraints)
        } catch { /* track individual pode recusar; segue as demais */ }
      }
      if (tracks.length > 0 && this.state && this.pcs.size > 0) {
        for (const [fp, pc] of this.pcs) {
          try {
            if (pc.signalingState !== 'stable') continue
            const offer = await createTunedOffer(pc)
            await pc.setLocalDescription(offer)
            // o answer remoto chega via handleAnswer → setRemoteDescription (renegociação completa)
            await services.callOffer(fp, this.state.callId, JSON.stringify(offer)).catch(() => {})
          } catch { /* falha por peer não derruba os demais */ }
        }
      }
      this.quality = q
      try { localStorage.setItem(CALL_QUALITY_KEY, q) } catch { /* ignore */ }
      this.badWindows = 0
      if (this.state) {
        this.state = { ...this.state, quality: q }
        this.onUpdate({ ...this.state })
      }
    } catch (e: any) {
      this.quality = prev
      const wrapped = new Error(`não foi possível aplicar ${q}: ${String(e?.message ?? e)}`)
      ;(wrapped as any).cause = e
      throw wrapped
    }
  }

  private startQualityMonitor() {
    this.stopQualityMonitor()
    this.badWindows = 0
    this.prevLost.clear()
    try {
      this.statsTimer = setInterval(() => { void this.pollStats() }, 5000)
    } catch { this.statsTimer = null }
  }

  private stopQualityMonitor() {
    try { if (this.statsTimer) clearInterval(this.statsTimer) } catch { /* ignore */ }
    this.statsTimer = null
  }

  /** Monitor adaptativo: 1x/5s lê RTCStats; 3 janelas ruins → desce um nível. */
  private async pollStats() {
    if (!this.state || this.pcs.size === 0) return
    try {
      let bad = false
      for (const [fp, pc] of this.pcs) {
        try {
          if (pc.connectionState === 'closed') continue
          const stats = await pc.getStats()
          // Medidor B1: par selecionado + rtt + bytes (mesma janela, sem timer novo).
          try { this.iceReports.set(fp, readIceReport(pc, stats)) } catch { /* stats parcial */ }
          // Cache completo para o painel de diagnóstico (ver getCallDiagnostics).
          try { this.lastStats.set(fp, stats) } catch { /* ignore */ }
          stats.forEach((r: any) => {
            if (r && r.type === 'inbound-rtp') {
              const lost = Number(r.packetsLost ?? 0)
              const jitter = Number(r.jitter ?? 0)
              const key = `${fp}`
              const prev = this.prevLost.has(key) ? (this.prevLost.get(key) ?? lost) : lost
              const delta = Math.max(0, lost - prev)
              this.prevLost.set(key, lost)
              if (isBadStatsSample(delta, jitter)) bad = true
            }
          })
        } catch { /* peer sem stats nesta janela */ }
      }
      if (bad) this.badWindows += 1
      else this.badWindows = 0
      if (this.badWindows >= 3) {
        this.badWindows = 0
        const next = lowerQuality(this.quality)
        if (!next) return
        try {
          await this.setQuality(next)
          const msg = `qualidade ajustada para ${next}`
          this.qualityNotice = msg
          if (this.state) {
            this.state = { ...this.state, qualityNotice: msg }
            this.onUpdate({ ...this.state })
          }
          try { this.onQualityNotice?.(msg) } catch { /* ignore */ }
        } catch { /* setQuality já reporta; mantém atual */ }
      }
    } catch { /* nunca derruba a chamada por causa do monitor */ }
  }

  // ── Diagnóstico WebRTC em tempo real (painel da chamada) ────────────────
  /** Último RTCStatsReport por peer (alimentado pelo pollStats + sob demanda). */
  private lastStats = new Map<string, RTCStatsReport>()
  /** Causa técnica da última falha (para exibir em vez de "erro na chamada"). */
  private lastFailureCause: string | null = null
  /** Define a causa técnica (chamado nos pontos de falha honesta). */
  private setFailureCause(cause: string) {
    try { this.lastFailureCause = cause } catch { /* ignore */ }
  }
  /** Última causa técnica registrada (null = sem falha nesta chamada). */
  getFailureCause(): string | null {
    try { return this.lastFailureCause } catch { return null }
  }
  /** Último VoiceStats da mídia nativa (alimentado pelo painel/monitor). */
  private lastNativeStats: VoiceMediaStats | null = null

  /** Causa técnica da mídia NATIVA (sem PCs no navegador — mensagem própria). */
  private nativeFailureReason(st: CallState): string {
    try {
      const s = this.lastNativeStats
      if (!s) {
        if (st.phase === 'outgoing') return 'voz nativa: aguardando o outro lado atender (mídia do Rust ainda sem sessão)'
        return 'voz nativa: mídia do Rust ainda sem sessão para esta chamada (offer nativa ainda não criada ou sem VoiceMedia)'
      }
      const io = `saída=${s.packets_out ?? 0} entrada=${s.packets_in ?? 0} plc=${s.plc_frames ?? 0} erros=${s.decode_errors ?? 0}`
      if (s.state === 'connected') return `voz nativa conectada via ${s.route} (${io})`
      if (s.state === 'failed') return `voz nativa: rota perdida (${s.route}; ${io}) — NAT/CGNAT sem TURN válido ou peer caiu`
      // connecting/idle: distingue "peer não responde" de "rede sem rota".
      if ((s.packets_out ?? 0) === 0 && (s.packets_in ?? 0) === 0) {
        return `voz nativa negociando (rota ${s.route}): nenhum pacote trocado ainda — outro lado pode não ter atendido ou SDP/ICE não chegou`
      }
      return `voz nativa conectando via ${s.route} (${io}) — ICE ainda sem par final`
    } catch { return 'voz nativa: falha ao inspecionar a mídia do Rust' }
  }

  /**
   * Causa técnica REAL do estado atual (nunca "erro na chamada" genérico).
   * Ordem de checagem: sem chamada → sem WebRTC → sem mic/câmera → ICE →
   * sinalização → gathering → rota. Usado pelo painel e pelos toasts.
   */
  getCallFailureReason(): string {
    try {
      if (this.lastFailureCause) return this.lastFailureCause
      const st = this.state
      if (!st) return 'sem chamada ativa'
      if (!supportsCalls()) {
        try { return getCallsUnavailableMessage() } catch { return 'WebRTC indisponível neste aparelho' }
      }
      // Chamada NATIVA (mídia no Rust, sem PCs no navegador): causa própria —
      // a mensagem de "nenhuma conexão WebRTC" abaixo seria enganosa aqui.
      try { if ((st as any)?.nativeMedia) return this.nativeFailureReason(st) } catch { /* segue no caminho WebRTC */ }
      if (this.pcs.size === 0) {
        if (st.phase === 'outgoing') return 'aguardando o outro lado atender (sinalização ainda não completou)'
        if (st.phase === 'incoming') return 'aguardando atendimento local'
        return 'nenhuma conexão WebRTC criada (offer ainda não enviada ou peer offline)'
      }
      // Resume por peer: o pior caso vira a causa.
      const parts: string[] = []
      for (const [fp, pc] of this.pcs) {
        try {
          const ice = String((pc as any).iceConnectionState ?? '?')
          const conn = String((pc as any).connectionState ?? '?')
          const sig = String((pc as any).signalingState ?? '?')
          const gath = String((pc as any).iceGatheringState ?? '?')
          const rep = this.iceReports.get(fp)
          const short = fp.slice(0, 8)
          if (ice === 'failed' || conn === 'failed') {
            parts.push(`${short}: ICE falhou (sem rota direta nem via TURN; NAT restritivo/CGNAT ou TURN fora)`)
          } else if (ice === 'disconnected') {
            parts.push(`${short}: rota caiu (rede trocou/caiu); tentando ICE restart`)
          } else if (ice === 'checking' || ice === 'new') {
            if (gath === 'gathering') parts.push(`${short}: coletando candidatos ICE (TURN pode demorar no 4G)`)
            else if (!pc.remoteDescription) parts.push(`${short}: aguardando SDP remoto (offer/answer ainda não aplicada)`)
            else if (sig !== 'stable') parts.push(`${short}: sinalização em ${sig} (renegociação em andamento)`)
            else parts.push(`${short}: ICE em ${ice} sem par selecionado (NAT/CGNAT sem rota — STUN/TURN tentados)`)
          } else if (!rep || (!rep.localType && !rep.remoteType)) {
            parts.push(`${short}: conectado (${ice}) mas sem par ICE selecionado ainda`)
          }
        } catch { /* peer isolado */ }
      }
      if (parts.length > 0) return parts.join(' | ')
      // Microfone/câmera?
      try {
        const micLive = this.localStream?.getAudioTracks().some(t => t.readyState === 'live') ?? false
        const camLive = this.localStream?.getVideoTracks().some(t => t.readyState === 'live') ?? false
        if (!micLive && st.kind !== 'video') return 'conectado, mas sem microfone ativo (permissão negada ou sem dispositivo)'
        if (st.kind === 'video' && st.cameraOn && !camLive) return 'conectado, mas sem câmera ativa (permissão negada, em uso ou sem dispositivo)'
      } catch { /* ignore */ }
      return 'sem falha detectada (mídia negociando ou conectada)'
    } catch { return 'falha desconhecida ao inspecionar a chamada' }
  }

  /**
   * Diagnóstico completo por peer para o painel em tempo real.
   * Nunca lança; campos ausentes viram null (painel mostra "—").
   */
  async getCallDiagnostics(): Promise<CallDiagnostics[]> {
    const out: CallDiagnostics[] = []
    try {
      const st = this.state
      if (!st) return out
      for (const [fp, pc] of this.pcs) {
        try {
          let stats: RTCStatsReport | null = this.lastStats.get(fp) ?? null
          try {
            if ((pc as any).connectionState !== 'closed') {
              stats = await pc.getStats()
              if (stats) this.lastStats.set(fp, stats)
            }
          } catch { /* mantém último cache */ }
          out.push(buildPeerDiagnostics(fp, pc, stats, this.iceReports.get(fp) ?? null, st))
        } catch { /* peer isolado não derruba o painel */ }
      }
      // Chamada nativa (mídia no Rust): sem PCs, mas com rota do core.
      if (out.length === 0 && (st as any)?.nativeMedia) {
        try {
          const s = await services.voiceMediaStats(st.callId).catch(() => null)
          if (s) { try { this.lastNativeStats = s } catch { /* ignore */ } }
          const io = s ? `out=${s.packets_out ?? 0} in=${s.packets_in ?? 0} plc=${s.plc_frames ?? 0} err=${s.decode_errors ?? 0}` : null
          out.push({
            fp: 'nativa (Rust)',
            connectionState: s ? s.state : 'desconhecida',
            iceConnectionState: s ? s.state : 'desconhecida',
            signalingState: 'estável (core)',
            localType: null, remoteType: null,
            selectedPair: s ? `rota ${s.route} • ${io}` : null,
            rttMs: s?.rtt_ms ?? null,
            audioBitrateKbps: null, videoBitrateKbps: null,
            resolution: null, fps: null,
            framesReceived: s ? Number(s.packets_in ?? 0) : null,
            framesLost: s ? Number(s.plc_frames ?? 0) : null,
            packetsLost: s ? Number(s.plc_frames ?? 0) : null,
            packetLossPct: null,
            codec: 'Opus (nativo)',
            jitterMs: s ? s.jitter_depth_ms : null,
            camera: 'n/d (nativa)',
            microphone: s ? ((s.packets_out ?? 0) > 0 ? 'enviando' : 'sem saída ainda') : 'n/d (nativa)',
          })
        } catch { /* ignore */ }
      }
    } catch { /* painel nunca derruba a chamada */ }
    return out
  }

  async leave() {
    if (!this.state) return
    const cid = this.state.callId
    this.applyPhase('hangup')
    this.stopReconnectWatchdog()
    this.clearIceRestartTimers()
    this.stopNativeVoiceMonitor()
    if (cid.startsWith('voice-')) {
      // voz: apenas limpa estado local, servidor já notificou via voiceLeave
      void cid // preserva sem var não usada
    } else {
      try { await services.callEnd(cid) } catch { /* silent */ }
    }
    this.cleanup()
  }

  async leaveVoice(communityId: string, channelId: string) {
    await services.voiceLeave(communityId, channelId)
    // apenas limpa estado local de voz — NÃO destrói conexões de DM calls ativos
    if (this.state?.callId.startsWith('voice-')) {
      this.stopQualityMonitor()
      this.stopReconnectWatchdog()
      this.stopConnectWatchdog()
      this.stopOutgoingWatchdog()
      this.stopIncomingWatchdog()
      this.clearIceRestartTimers()
      try { this.stopRelayFull() } catch { /* ignore */ }
      this.badWindows = 0
      this.prevLost.clear()
      try { this.lastStats.clear() } catch { /* ignore */ }
      this.lastFailureCause = null
      try { this.lastNativeStats = null } catch { /* ignore */ }
      this.qualityNotice = null
      this.pendingIce.clear()
      this.localIce.clear()
      this.pendingOffers.clear()
      this.lastRemoteOffer.clear()
      this.iceReports.clear()
      this.iceRestarts.clear()
      this.pcs.forEach(pc => { try { pc.close() } catch { /* ignore */ } })
      this.pcs.clear()
      this.localStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } })
      this.resetScreenRuntime()
      this.localStream = null
      this.state = null
      this.onUpdate(null as any)
    }
  }

  /**
   * Zera TODO o estado do compartilhamento (timer de métricas, monitor de FPS,
   * timer de recuperação, stream). Chamado em qualquer saída da chamada —
   * deixar timer vivo depois do `leave` é vazamento clássico de memória.
   */
  private resetScreenRuntime(): void {
    this.stopScreenStatsTimer()
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch { /* ignore */ }
    this.screenRecoveryTimer = null
    this.screenMonitor.detach()
    this.screenStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } })
    this.screenStream = null
    this.screenLastSize = ''
    this.screenMetrics = emptyScreenMetrics()
    this.screenError = null
    this.screenRecoveryAttempts = 0
    this.screenStats.reset()
  }

  toggleMute() {
    if (!this.state) return
    this.state.muted = !this.state.muted
    const muted = this.state.muted
    // Silencia o mic de TODOS os streams (o compartilhado e o dedicado do
    // relay). Antes só o `localStream` era silenciado: no modo compatibilidade
    // o recorder pode estar num stream DEDICADO, e aí o mutar não impedia a
    // saída de áudio pelo relay — a UI mostrava "mudo" e o outro ouvia.
    const seen = new Set<MediaStream>()
    for (const s of [this.localStream, this.relayRecStream]) {
      if (!s || seen.has(s)) continue
      seen.add(s)
      try { s.getAudioTracks().forEach(t => { t.enabled = !muted }) } catch { /* ignore */ }
    }
    this.onUpdate({ ...this.state })
  }

  toggleDeafen() {
    if (!this.state) return
    this.state.deafened = !this.state.deafened
    if (this.state.deafened) this.state.muted = true
    // Silencia o mic local também (bug: surdo mascontinuando a transmitir).
    try {
      const seen = new Set<MediaStream>()
      for (const s of [this.localStream, this.relayRecStream]) {
        if (!s || seen.has(s)) continue
        seen.add(s)
        s.getAudioTracks().forEach(t => { t.enabled = !this.state!.muted })
      }
    } catch { /* ignore */ }
    // todos os remote audios muted no DOM
    this.onUpdate({ ...this.state })
  }

  /**
   * Acha o sender de vídeo do PC mesmo quando ele está com track nulo
   * (câmera desligada via `replaceTrack(null)`). Sem isso, religar a câmera
   * criaria um m-line novo sem renegociação e o remoto não veria nada.
   */
  private findVideoSender(pc: RTCPeerConnection): RTCRtpSender | null {
    try {
      const direct = pc.getSenders().find(s => s.track?.kind === 'video')
      if (direct) return direct
      const tr = pc.getTransceivers().find(t => (t as any)?.receiver?.track?.kind === 'video')
      return tr?.sender ?? null
    } catch { return null }
  }

  async toggleCamera() {
    if (!this.state) return
    if (this.state.cameraOn) {
      // Desliga: para de ENVIAR vídeo (replaceTrack(null) mantém o m-line) e
      // solta os tracks locais. O remoto para de receber em vez de congelar.
      const mine = this.localStream
      if (mine) {
        const vids = mine.getVideoTracks()
        for (const pc of this.pcs.values()) {
          try {
            const sender = this.findVideoSender(pc)
            if (sender) await sender.replaceTrack(null)
          } catch { /* peer isolado não derruba os demais */ }
        }
        vids.forEach(t => {
          try { t.stop() } catch { /* ignore */ }
          try { mine.removeTrack(t) } catch { /* ignore */ }
        })
      }
      this.state.cameraOn = false
    } else {
      try {
        const vs = await getLocalMedia({ video: { ...CAMERA_CONSTRAINTS } })
        const track = vs?.getVideoTracks()[0]
        if (!track) return
        if (!this.localStream) {
          try { this.localStream = new MediaStream([track]) }
          catch { this.localStream = null }
        } else {
          try { this.localStream.addTrack(track) } catch { /* ignore */ }
        }
        if (!this.localStream) return
        // Por peer: se JÁ existe m-line de vídeo → replaceTrack (sem renegociar);
        // se NÃO existe (ex.: ligou a câmera numa chamada de voz) → addTrack +
        // renegociação (offer) para o remoto receber a nova track.
        for (const [fp, pc] of this.pcs) {
          try {
            const sender = this.findVideoSender(pc)
            if (sender) {
              await sender.replaceTrack(track)
            } else {
              pc.addTrack(track, this.localStream)
              const offer = await createTunedOffer(pc)
              await pc.setLocalDescription(offer)
              if (this.state) await services.callOffer(fp, this.state.callId, JSON.stringify(offer)).catch(() => {})
            }
          } catch { /* peer isolado não derruba os demais */ }
        }
        this.state.cameraOn = true
      } catch { /* silent */ }
    }
    this.onUpdate({ ...this.state })
  }

  /**
   * Transmissão estilo Discord (desktop): compartilha via getDisplayMedia e
   * renegocia o mesh para cada peer; o receptor exibe como track de vídeo
   * normal (desktop + mobile view-only). Mobile sem getDisplayMedia lança
   * SCREEN_UNAVAILABLE_MSG honesto em vez de crash/silêncio.
   */
  /** Última linha de texto do doc da função (substituído abaixo). */
  async toggleScreen(): Promise<void> {
    if (this.state?.sharing) {
      await this.stopScreenShare()
      return
    }
    await this.startScreenShare()
  }

  /**
   * Compartilhamento de tela P2P (sem servidor de mídia): captura local →
   * codificação nativa do engine → WebRTC direto peer-a-peer.
   *
   * Fontes: tela inteira, janela/aplicativo e monitor específico (o picker
   * nativo do sistema decide qual; nós dizemos QUAL tipo é permitido). O
   * áudio do sistema e o microfone são separados: cada um vira sua própria
   * trilha, então "tela + sistema + mic" funciona e "só tela" não trava.
   *
   * `opts` ausente = usa as opções salvas (ver setScreenShareOptions).
   */
  async startScreenShare(opts?: Partial<ScreenShareOptions>): Promise<void> {
    if (!this.state) return
    this.screenEnv = detectScreenEnvironment()
    if (!supportsScreenShare()) {
      const reason = screenShareUnavailableReason()
      this.setScreenError('unsupported', reason ?? SCREEN_UNAVAILABLE_MSG)
      throw new ScreenShareError('unsupported', reason ?? SCREEN_UNAVAILABLE_MSG, false)
    }
    // Voz nativa em Rust (webrtc-rs) NÃO cria RTCPeerConnection: o `pcs` fica
    // vazio e `seedScreenPeers` não teria para onde enviar. Sem esta guarda o
    // app anunciava "COMPARTILHANDO" e não transmitia nada — tela preta com
    //Status de sucesso. Aqui falhamos com o motivo real e retryable.
    if (this.pcs.size === 0) {
      const why = nativeVoiceAvailable === true
        ? 'esta chamada usa a voz nativa em Rust (sem WebRTC na página), que hoje não codifica vídeo — compartilhe a tela numa chamada com WebRTC'
        : 'nenhum participante conectado ainda — espere a chamada estabilizar e tente de novo'
      this.setScreenError('unavailable', why)
      throw new ScreenShareError('unavailable', why, true)
    }
    this.screenOptions = normalizeOptions(opts, this.screenOptions)

    let stream: MediaStream
    try {
      stream = await this.acquireScreenStream(this.screenOptions)
    } catch (e) {
      const err = classifyScreenShareError(e)
      this.setScreenError(err.code, err.message)
      throw err
    }
    const track = stream.getVideoTracks()[0]
    if (!track) {
      try { stream.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
      const err = new ScreenShareError('no-source', 'nenhuma trilha de vídeo na tela compartilhada', true)
      this.setScreenError(err.code, err.message)
      throw err
    }

    // Captura substitui a anterior sem derrubar a chamada.
    try { this.stopScreenStreamOnly() } catch { /* ignore */ }
    this.screenStream = stream
    this.state.sharing = true
    this.screenError = null
    this.screenRecoveryAttempts = 0
    this.screenStats.reset()
    this.screenMetrics = emptyScreenMetrics()
    this.watchScreenTrack(track)
    this.screenMonitor.attach(track)
    await this.tuneScreenTrack(track)
    await this.seedScreenPeers(stream, track)
    this.startScreenStatsTimer()
    this.broadcastScreenSignal(true)
    this.onUpdate({ ...this.state })
  }

  /** Pede a captura ao engine com as constraints de fonte/áudio corretas. */
  private async acquireScreenStream(opts: ScreenShareOptions): Promise<MediaStream> {
    const md: any = (typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : null)
    if (!md?.getDisplayMedia) throw new ScreenShareError('unsupported', SCREEN_UNAVAILABLE_MSG, false)
    const constraints = buildDisplayMediaConstraints(opts, this.screenEnv)
    return await md.getDisplayMedia(constraints) as MediaStream
  }

  /**
   * Reage ao fim/mute/unmute da track de tela — é o que cobre "usuário parou
   * pelo botão do sistema", "monitor desconectou" e "janela fechada".
   * `mute` é NORMAL (troca de monitor, janela minimizada); `ended` é o fim real.
   */
  private watchScreenTrack(track: MediaStreamTrack): void {
    try {
      track.onended = () => { void this.handleScreenEnded() }
      track.onmute = () => { this.noteScreenEvent('captura pausada pelo sistema (fonte oculta, monitor trocado ou app em segundo plano)') }
      track.onunmute = () => { this.noteScreenEvent('captura retomada') }
    } catch { /* engines sem onmute: só onended */ }
  }

  private async handleScreenEnded(): Promise<void> {
    if (!this.state?.sharing) return
    // Differencia "o sistema encerrou a projeção (Android/Android WebView,
    // barra do navegador, janela fechada)" de um stop explícito nosso.
    const msg = 'o compartilhamento de tela foi encerrado pelo sistema'
    this.setScreenError('ended', msg)
    try { this.onCallNotice?.(msg) } catch { /* ignore */ }
    await this.stopScreenShare()
  }

  /** Aplica resolução/FPS no track vivo e afina o encoder de cada sender. */
  private async tuneScreenTrack(track: MediaStreamTrack): Promise<void> {
    setScreenContentHint(track, this.screenOptions.source)
    await applyScreenConstraints(track, this.screenOptions)
    try {
      const st = track.getSettings()
      this.screenLastSize = `${st.width ?? 0}x${st.height ?? 0}`
    } catch { /* settings indisponível */ }
    await this.applyScreenSenderTuning()
  }

  /** Escala/bitrate/degradação por sender — a parte que segura 1080p60. */
  private async applyScreenSenderTuning(): Promise<void> {
    for (const pc of this.pcs.values()) {
      try {
        const sender = this.findVideoSender(pc)
        if (!sender) continue
        await applySenderTuning(sender, this.screenOptions)
      } catch { /* sender sem parâmetros: segue com o padrão */ }
    }
  }

  /** Semeia a track em todo o mesh (replaceTrack quando já existe m-line). */
  private async seedScreenPeers(stream: MediaStream, track: MediaStreamTrack): Promise<void> {
    for (const pc of this.pcs.values()) {
      try {
        const sender = this.findVideoSender(pc)
        if (sender) {
          await sender.replaceTrack(track)
          if (pc.signalingState !== 'stable') continue
        } else {
          pc.addTrack(track, stream)
        }
        const offer = await createTunedOffer(pc)
        await pc.setLocalDescription(offer)
        const fp = [...this.pcs.entries()].find(([, v]) => v === pc)?.[0]
        if (fp && this.state) await services.callOffer(fp, this.state.callId, JSON.stringify(offer)).catch(() => {})
      } catch { /* peer isolado não derruba os demais */ }
    }
    await this.seedScreenAudio(stream)
    await this.applyScreenSenderTuning()
  }

  /**
   * Áudio do compartilhamento nos 4 modos (só tela / +sistema / +mic / ambos).
   *
   * Sistema e microfone são trilhas SEPARADAS de propósito: nunca se misturam,
   * cada um é opcional e a falta de um NUNCA derruba o outro nem o vídeo.
   * `getDisplayMedia` só entrega o áudio do sistema; o mic vem sempre do
   * `getUserMedia` (é o mesmo mic da chamada, não um segundo dispositivo).
   */
  private async seedScreenAudio(stream: MediaStream): Promise<void> {
    const mode = this.screenOptions.audio
    if (mode === 'system' || mode === 'system+mic') {
      const atrack = stream.getAudioTracks()[0]
      if (!atrack) {
        this.noteScreenEvent('áudio do sistema indisponível nesta fonte — o vídeo continua normalmente')
      } else {
        await this.sendAudioTrackToPeers(atrack, stream)
      }
    }
    if (mode === 'mic' || mode === 'system+mic') {
      const mic = await this.ensureShareMicrophone()
      if (!mic) this.noteScreenEvent('microfone indisponível — compartilhando sem a sua voz')
    }
  }

  /**
   * Garante que exista um mic VIVO para o compartilhamento. Reaproveita o da
   * chamada quando ele já está no mesh (não abre um segundo microfone, o que
   * brigaria com o áudio da voz); senão captura um e semeia nos peers.
   */
  private async ensureShareMicrophone(): Promise<MediaStreamTrack | null> {
    const live = this.localStream?.getAudioTracks().find(t => t.readyState === 'live') ?? null
    if (live) return live
    let captured: MediaStream | null = null
    try {
      captured = await getLocalMedia({ audio: { ...AUDIO_CONSTRAINTS }, video: false })
    } catch { return null }
    const track = captured?.getAudioTracks()[0] ?? null
    if (!track) return null
    try {
      if (this.localStream) this.localStream.addTrack(track)
      else this.localStream = captured
    } catch { /* segue: o que importa é enviar o áudio */ }
    await this.sendAudioTrackToPeers(track, this.localStream ?? (captured as MediaStream))
    return track
  }

  /** Manda uma trilha de áudio a todo o mesh, renegociando só o necessário. */
  private async sendAudioTrackToPeers(track: MediaStreamTrack, stream: MediaStream): Promise<void> {
    for (const pc of this.pcs.values()) {
      try {
        if (pc.getSenders().some(x => x.track === track)) continue
        if (pc.signalingState !== 'stable') continue
        pc.addTrack(track, stream)
        const offer = await createTunedOffer(pc)
        await pc.setLocalDescription(offer)
        const fp = [...this.pcs.entries()].find(([, v]) => v === pc)?.[0]
        if (fp && this.state) await services.callOffer(fp, this.state.callId, JSON.stringify(offer)).catch(() => {})
      } catch { /* áudio opcional: vídeo continua */ }
    }
  }

  /** Para o compartilhamento e devolve a câmera (ou null) aos remotos. */
  async stopScreenShare(): Promise<void> {
    if (!this.state) return
    this.stopScreenStatsTimer()
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch { /* ignore */ }
    this.screenRecoveryTimer = null
    this.stopScreenStreamOnly()
    this.screenMonitor.detach()
    this.screenLastSize = ''
    this.screenMetrics = emptyScreenMetrics()
    this.state.sharing = false
    this.broadcastScreenSignal(false)
    await this.restoreCameraAfterScreen()
    this.onUpdate({ ...this.state })
  }

  /** Libera o stream de tela (sem tocar no estado da chamada). */
  private stopScreenStreamOnly(): void {
    try { this.screenStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
    this.screenStream = null
  }

  /** Receiveram a última tela; volta a câmera viva para não congelar. */
  private async restoreCameraAfterScreen(): Promise<void> {
    const cam = this.localStream?.getVideoTracks().find(tr => tr.readyState === 'live') ?? null
    if (!cam) return
    for (const pc of this.pcs.values()) {
      try {
        const sender = this.findVideoSender(pc)
        if (sender) await sender.replaceTrack(cam).catch(() => {})
        if (pc.signalingState !== 'closed' && pc.signalingState === 'stable') {
          const offer = await createTunedOffer(pc).catch(() => null)
          if (offer) {
            await pc.setLocalDescription(offer).catch(() => {})
            const fp = [...this.pcs.entries()].find(([, v]) => v === pc)?.[0]
            if (fp && this.state) await services.callOffer(fp, this.state.callId, JSON.stringify(offer)).catch(() => {})
          }
        }
      } catch { /* peer isolado não derruba os demais */ }
    }
  }

  /**
   * Aplica opções sem derrubar a captura: resolução/FPS vão na track viva e no
   * encoder (o receiver não vê interrupção). Trocar a FONTE ou o ÁUDIO exige
   * recapturar — o engine só permite isso no gesto do usuário.
   */
  async setScreenShareOptions(patch: Partial<ScreenShareOptions>): Promise<void> {
    const prev = this.screenOptions
    const next = normalizeOptions(patch, this.screenOptions)
    this.screenOptions = next
    this.screenEnv = detectScreenEnvironment()
    if (!this.state?.sharing) return
    const sourceChanged = next.source !== prev.source
    const audioChanged = next.audio !== prev.audio
    if (sourceChanged || audioChanged) {
      await this.recaptureScreen(next)
      return
    }
    const track = this.screenStream?.getVideoTracks()[0] ?? null
    if (track) {
      await applyScreenConstraints(track, next)
      setScreenContentHint(track, next.source)
    }
    await this.applyScreenSenderTuning()
    this.emitScreenDebug()
  }

  /** Recaptura mantendo a chamada viva (fonte/áudio mudaram). */
  private async recaptureScreen(opts: ScreenShareOptions): Promise<void> {
    const wasSharing = !!this.state?.sharing
    try {
      this.stopScreenStatsTimer()
      this.stopScreenStreamOnly()
      this.screenMonitor.detach()
      const stream = await this.acquireScreenStream(opts)
      const track = stream.getVideoTracks()[0]
      if (!track) {
        try { stream.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
        throw new ScreenShareError('no-source', 'nenhuma trilha de vídeo na tela compartilhada', true)
      }
      this.screenStream = stream
      this.watchScreenTrack(track)
      this.screenMonitor.attach(track)
      await this.tuneScreenTrack(track)
      await this.seedScreenPeers(stream, track)
      this.startScreenStatsTimer()
      if (!wasSharing && this.state) {
        this.state.sharing = true
        this.broadcastScreenSignal(true)
      }
      this.screenError = null
      if (this.state) this.onUpdate({ ...this.state })
    } catch (e) {
      const err = classifyScreenShareError(e)
      this.setScreenError(err.code, err.message)
      if (this.state) {
        this.state.sharing = false
        this.broadcastScreenSignal(false)
        this.onUpdate({ ...this.state })
      }
      throw err
    }
  }

  /**
   * Recuperação automática: resolução mudou, monitor trocou, encoder engasgou
   * ou a rede degradou. Nenhum desses casos exige o usuário sair da chamada.
   */
  private scheduleScreenRecovery(reason: string): void {
    if (!this.state?.sharing) return
    if (this.screenRecoveryAttempts >= CallManager.SCREEN_MAX_RECOVERY) {
      this.noteScreenEvent(`recuperação automática desistiu após ${CallManager.SCREEN_MAX_RECOVERY} tentativas (${reason})`)
      return
    }
    this.screenRecoveryAttempts += 1
    this.noteScreenEvent(`recuperando a captura (${reason}) — tentativa ${this.screenRecoveryAttempts}/${CallManager.SCREEN_MAX_RECOVERY}`)
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch { /* ignore */ }
    const delay = Math.min(8000, 800 * this.screenRecoveryAttempts)
    this.screenRecoveryTimer = setTimeout(() => {
      this.screenRecoveryTimer = null
      void this.recoverScreen(reason)
    }, delay)
  }

  private async recoverScreen(reason: string): Promise<void> {
    if (!this.state?.sharing) return
    try {
      const track = this.screenStream?.getVideoTracks()[0] ?? null
      if (!track || track.readyState !== 'live') {
        await this.recaptureScreen(this.screenOptions)
        return
      }
      // track viva mas ruim (mute/stall): reaplica constraints e reinicia
      // a estatística — o receiver volta a receber keyframes normais.
      await applyScreenConstraints(track, this.screenOptions)
      await this.applyScreenSenderTuning()
      this.screenStats.reset()
      this.noteScreenEvent(`captura recuperada (${reason})`)
    } catch {
      await this.recaptureScreen(this.screenOptions).catch(() => {})
    }
  }

  /** Detecta mudança de resolução/rotação e dispara a recuperação. */
  private checkScreenGeometry(): void {
    const track = this.screenStream?.getVideoTracks()[0] ?? null
    if (!track) return
    let size: string
    try {
      const st = track.getSettings()
      size = `${st.width ?? 0}x${st.height ?? 0}`
    } catch { return }
    if (!size || size === '0x0') return
    if (this.screenLastSize && size !== this.screenLastSize) {
      this.scheduleScreenRecovery(`a captura mudou de ${this.screenLastSize} para ${size}`)
    }
    this.screenLastSize = size
  }

  private startScreenStatsTimer(): void {
    this.stopScreenStatsTimer()
    try {
      this.screenStatsTimer = setInterval(() => { void this.sampleScreenStats() }, 1000)
    } catch { this.screenStatsTimer = null }
  }

  private stopScreenStatsTimer(): void {
    try { if (this.screenStatsTimer) clearInterval(this.screenStatsTimer) } catch { /* ignore */ }
    this.screenStatsTimer = null
  }

  /** Uma amostra REAL por segundo: FPS capturado, bitrate, perda, latência. */
  private async sampleScreenStats(): Promise<void> {
    if (!this.state?.sharing) return
    try {
      const capture = this.screenMonitor.sample()
      let stats: RTCStatsReport | null = null
      for (const pc of this.pcs.values()) {
        try {
          if (pc.connectionState === 'closed') continue
          stats = await pc.getStats()
          if (stats) break
        } catch { /* tenta o próximo peer */ }
      }
      const prevRtt = this.screenMetrics.rttMs
      this.screenMetrics = this.screenStats.read(stats, capture, prevRtt)
      this.checkScreenGeometry()
      this.adaptScreenQuality()
      this.emitScreenDebug()
    } catch { /* métrica nunca derruba a captura */ }
  }

  /**
   * Degradação adaptativa honesta: só desce um degrau quando a rede está
   * realmente ruim (perda, jitter alto ou FPS enviado bem abaixo do capturado).
   * 120 FPS só é pedido — nunca reportamos FPS que não foi capturado.
   */
  private adaptScreenQuality(): void {
    if (this.screenOptions.quality === 'auto') return
    const m = this.screenMetrics
    if (!isScreenSampleBad(m)) {
      if (this.screenRecoveryAttempts > 0) this.screenRecoveryAttempts = 0
      return
    }
    const next = lowerScreenQuality(this.screenOptions.quality)
    if (next === this.screenOptions.quality) return
    this.screenOptions = { ...this.screenOptions, quality: next }
    const track = this.screenStream?.getVideoTracks()[0] ?? null
    if (track) void applyScreenConstraints(track, this.screenOptions)
    void this.applyScreenSenderTuning()
    this.noteScreenEvent(`qualidade da tela ajustada para ${next} (rede ruim)`)
    this.emitScreenDebug()
  }

  private setScreenError(code: ScreenShareErrorCode, message: string): void {
    this.screenError = { code, message }
    this.emitScreenDebug()
  }

  private noteScreenEvent(_message: string): void {
    this.emitScreenDebug()
  }

  private emitScreenDebug(): void {
    try {
      this.onScreenDebug?.({
        ...this.screenMetrics,
        options: { ...this.screenOptions },
        env: this.screenEnv,
        error: this.screenError,
      })
    } catch { /* painel nunca derruba a captura */ }
  }

  /** Opções salvas de compartilhamento (fonte/áudio/qualidade/FPS). */
  getScreenShareOptions(): ScreenShareOptions {
    return { ...this.screenOptions }
  }

  /** Ambiente de captura detectado agora (plataforma + capacidades reais). */
  getScreenShareEnvironment(): ScreenEnvironment {
    this.screenEnv = detectScreenEnvironment()
    return this.screenEnv
  }

  /** Última amostra de métricas (mesma que o painel "Screen Share Debug"). */
  getScreenShareMetrics(): ScreenShareMetrics & { options: ScreenShareOptions; env: ScreenEnvironment; error: { code: ScreenShareErrorCode; message: string } | null } {
    return { ...this.screenMetrics, options: { ...this.screenOptions }, env: this.screenEnv, error: this.screenError }
  }

  /** Erro atual de captura (null = tudo certo). */
  getScreenShareError(): { code: ScreenShareErrorCode; message: string } | null {
    return this.screenError
  }

  /** Escolhe a fonte da próxima captura: tela inteira ('monitor') ou uma
   *  janela/aba ('window'). Só tem efeito na próxima vez que você compartilha. */
  setScreenSource(src: 'monitor' | 'window'): void {
    this.screenSource = src === 'window' ? 'window' : 'monitor'
    const source = src === 'window' ? 'window' : 'screen'
    this.screenOptions = { ...this.screenOptions, source }
  }

  /** Fonte configurada para a próxima captura. */
  getScreenSource(): 'monitor' | 'window' {
    return this.screenSource
  }

  /**
   * Grupo (mesh real): adiciona um peer à chamada ativa.
   * - cria PC iniciador com o novo peer (nossa offer conecta a mídia);
   * - toca o telefone dele (frame CallAddParticipant COM kind → CallIncoming
   *   no receptor, que atende normalmente via acceptInbound);
   * - avisa os demais participantes (frame SEM kind → cada um cria PC ao novo
   *   peer; o novo só responde offers → sem GLARE).
   */
  addParticipant(fp: string, nickname: string) {
    if (!this.state) return
    if (fp === this.myFp) return
    if (!this.state.participants.find(p => p.fp === fp)) {
      this.state.participants.push({ fp, nickname })
    }
    // mesh: nossa offer para o novo participante
    this.createPC(fp, this.state.callId, true).catch(() => {})
    // ring no novo + badge nos demais
    for (const p of this.state.participants) {
      if (!p.fp || p.fp === this.myFp) continue
      const kind = p.fp === fp ? (this.state.kind ?? 'voice') : ''
      services.callAddParticipant(p.fp, this.state.callId, fp, kind).catch(() => {})
    }
    this.onUpdate({ ...this.state })
  }

  /** Regra polite/impolite por fingerprint: fp menor = impolite; maior = polite. */
  private isPolite(peerFp: string): boolean {
    return this.myFp > peerFp
  }

  /** Anexa tracks locais (mic/câmera/tela) a um PC sem duplicar senders. */
  private attachLocalStreamToPC(pc: RTCPeerConnection) {
    try {
      const streams: MediaStream[] = []
      if (this.localStream) streams.push(this.localStream)
      if (this.screenStream && this.screenStream !== this.localStream) streams.push(this.screenStream)
      for (const s of streams) {
        for (const t of s.getTracks()) {
          try {
            const already = pc.getSenders().some(x => x.track === t)
            if (!already) pc.addTrack(t, s)
          } catch { /* track já anexada: ignora */ }
        }
      }
    } catch { /* nunca derruba a chamada */ }
    this.ensureMlines(pc)
  }

  /**
   * Garante que existam m-lines de áudio e vídeo mesmo sem track local.
   * Por que: com `bundlePolicy: 'max-bundle'`, o Chrome exige um grupo BUNDLE na
   * SDP — e grupo BUNDLE só é gerado quando existe m-line, que por sua vez só
   * nasce de uma track. Sem microfone (permissão negada, aparelho sem entrada)
   * a offer morria com "max-bundle configured but session description has no
   * BUNDLE group" e a chamada NUNCA saía. Um transceiver recvonly garante a
   * m-line: quem não tem mídia local ainda recebe a do outro, e quem tem mídia
   * continua enviando (o addTrack acima já ocupa o sender).
   */
  private ensureMlines(pc: RTCPeerConnection) {
    try {
      const kinds = new Set<string>()
      for (const t of pc.getTransceivers()) {
        const k = t.receiver?.track?.kind ?? t.sender?.track?.kind
        if (k) kinds.add(k)
      }
      for (const s of pc.getSenders()) {
        if (s.track?.kind) kinds.add(s.track.kind)
      }
      if (!kinds.has('audio')) pc.addTransceiver('audio', { direction: 'recvonly' })
      if (!kinds.has('video')) pc.addTransceiver('video', { direction: 'recvonly' })
    } catch { /* navegador sem addTransceiver: segue como está */ }
  }

  /** Anexa mídia local a TODOS os PCs e devolve os fps que ganharam tracks novas. */
  private attachMissingLocalTracks(): string[] {
    const changed: string[] = []
    for (const [fp, pc] of this.pcs) {
      try {
        const before = pc.getSenders().length
        this.attachLocalStreamToPC(pc)
        if (pc.getSenders().length > before) changed.push(fp)
      } catch { /* peer isolado não derruba os demais */ }
    }
    return changed
  }

  /** Anexa mídia local aos PCs existentes e renegocia os que ganharam tracks. */
  private async ensureMediaOnAllPCs(): Promise<void> {
    const changed = this.attachMissingLocalTracks()
    for (const fp of changed) {
      const pc = this.pcs.get(fp)
      if (pc && pc.remoteDescription && pc.signalingState === 'stable') await this.renegotiate(fp, pc)
    }
  }

  /** Fiação comum do PC: ontrack/onicecandidate + ICE restart com limite. */
  private wirePC(pc: RTCPeerConnection, fp: string, callId: string) {
    logIceState(pc, fp, callId)
    pc.ontrack = (e) => {
      // Receptor exibe tela compartilhada como vídeo normal: mescla a track
      // (tela costuma chegar em stream/objeto separado do áudio).
      try {
        const st = (e.streams && e.streams[0]) ?? (e.track ? new MediaStream([(e.track as MediaStreamTrack)]) : null)
        if (st && this.state) attachRemoteTrack(this.state, (s) => this.onUpdate(s), fp, st)
      } catch { /* nunca derruba o bus */ }
      // Mídia remota CHEGOU: se o ICE já está conectado, promove a fase.
      // Cobre o caso em que o `iceconnectionstatechange` disparou antes de o
      // estado da chamada existir (race offer→track→accept).
      try {
        const st2 = this.state
        if (st2 && st2.callId === callId) {
          const iceOk = pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed'
          const connOk = (pc as any).connectionState === 'connected'
          if (iceOk || connOk) this.applyPhase('media-connected')
          else this.promoteOnSignal(callId)
        }
      } catch { /* fase nunca derruba o bus */ }
    }
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        // Fim do gathering (candidate nulo): reenvia a lista COMPLETA. Se algum
        // candidato individual se perdeu no caminho (fila do motor cheia, peer
        // ainda subindo, link caiu), ele chega agora. O WebRTC ignora
        // candidato duplicado, então reenviar é sempre seguro.
        this.resendLocalIce(fp, pc, callId)
        return
      }
      this.sendLocalIce(fp, callId, e.candidate)
    }
    // ICE restart best-effort quando 'failed' (logIceState já emite o evento de UI).
    try {
      pc.addEventListener('iceconnectionstatechange', () => {
        try {
          if (pc.iceConnectionState === 'failed') void this.tryIceRestart(fp, pc, callId)
          // Promove para conectado também por aqui (além do subscribeIceRecovered
          // via logIceState): se o `bind()` ainda não assinou ou o evento se
          // perdeu, a fase não fica presa.
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            try {
              const st = this.state
              if (st && st.callId === callId) this.applyPhase('media-connected')
            } catch { /* ignore */ }
          }
        } catch { /* monitor nunca derruba a chamada */ }
      })
    } catch { /* ignore */ }
    // connectionState (nível PC) é mais confiável que iceConnectionState em
    // alguns WebViews móveis: cobre 'connected' mesmo quando o ICE reporta
    // 'checking' por alguns segundos.
    try {
      pc.addEventListener('connectionstatechange', () => {
        try {
          const cs = (pc as any).connectionState
          if (cs === 'connected') {
            const st = this.state
            if (st && st.callId === callId) this.applyPhase('media-connected')
          } else if (cs === 'failed') {
            void this.tryIceRestart(fp, pc, callId)
          }
        } catch { /* monitor nunca derruba a chamada */ }
      })
    } catch { /* navegador sem connectionstate: segue com ICE */ }
  }

  /** Envia um candidato ICE local, remembering-o para reenvio posterior. */
  private sendLocalIce(fp: string, callId: string, cand: RTCIceCandidate) {
    try {
      const list = this.localIce.get(fp) ?? []
      list.push(cand)
      this.localIce.set(fp, list)
      void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
    } catch { /* monitor nunca derruba a chamada */ }
  }

  /**
   * Reenvia TODOS os candidatos locais já coletados.
   *
   * Por que isso importa mais do que parece: cada `onicecandidate` dispara um
   * frame único pela fila de sinalização do motor. Se o peer ainda estiver
   * subindo (comum no CGNAT), o frame pode ser descartado/estourar a fila — e
   * o candidato perdido é perdido para sempre, porque o ICE local não o
   * reemite. O candidato de TURN é justamente o último e o mais crítico atrás
   * de CGNAT: perdê-lo era a diferença entre "às vezes pega" e "não pega".
   * Duplicata é ignorada pelo WebRTC, então reenviar o conjunto é idempotente.
   */
  private resendLocalIce(fp: string, pc: RTCPeerConnection, callId: string) {
    try {
      for (const cand of this.localIce.get(fp) ?? []) {
        void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
      }
      // Candidatos que o browser já gathered mas ainda não emitiu (pool
      // pré-coletado com iceCandidatePoolSize): manda também.
      // `getLocalCandidates` existe no WebRTC real mas não no lib.dom deste TS.
      const anyPc = pc as unknown as { getLocalCandidates?: () => Promise<RTCIceCandidate[]> }
      void anyPc.getLocalCandidates?.().then((rest: RTCIceCandidate[] | null | undefined) => {
        for (const cand of rest ?? []) {
          void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
        }
      }).catch(() => {})
    } catch { /* melhor esforço */ }
  }

  /**
   * CHAMADA NATIVA: o core Rust conduz a mídia e o estado dela vive lá
   * (`voice_media_stats`). Sem este monitor, a fase ficava presa em
   * "Conectando…" para sempre — o WebRTC do navegador é que emitia
   * `media-connected`, e no caminho nativo ninguém emitia nada.
   */
  private startNativeVoiceMonitor(callId: string) {
    this.stopNativeVoiceMonitor()
    this.nativeVoiceSince = Date.now()
    const t = setInterval(() => {
      const st = this.state
      if (!st || st.callId !== callId) { this.stopNativeVoiceMonitor(); return }
      const waited = Date.now() - (this.nativeVoiceSince ?? (this.nativeVoiceSince = Date.now()))
      void services.voiceMediaStats(callId).then((s) => {
        if (!s || !this.state || this.state.callId !== callId) return
        try { this.lastNativeStats = s } catch { /* ignore */ }
        if (nativeRoute !== s.route) { nativeRoute = s.route; this.onUpdate({ ...this.state }) }
        if (s.state === 'connected') {
          this.nativeVoiceSince = 0
          this.applyPhase('media-connected')
        } else if (s.state === 'failed' || waited > CallManager.NATIVE_VOICE_TIMEOUT_MS) {
          // O ICE que nunca fecha é o caso do CGNAT simétrico. Sem este
          // timeout a tela ficava em "Conectando…" indefinidamente — que é
          // exatamente o bug que a versão anterior resolveu no caminho do
          // WebRTC, e que voltou no caminho nativo.
          this.nativeVoiceSince = 0
          this.setFailureCause(
            s.state === 'failed'
              ? `rota de mídia nativa perdida (${s.route}; pacotes in=${s.packets_in} out=${s.packets_out} plc=${s.plc_frames})`
              : `sem rota de mídia nativa em ${Math.round(CallManager.NATIVE_VOICE_TIMEOUT_MS / 1000)}s (${s.route}) — CGNAT/NAT simétrico provável`,
          )
          this.onCallNotice?.(
            s.state === 'failed'
              ? `rota de mídia perdida (${s.route})`
              : `sem rota de mídia em ${Math.round(CallManager.NATIVE_VOICE_TIMEOUT_MS / 1000)}s (${s.route}) — sua rede ou a da outra pessoa está atrás de CGNAT`,
          )
          this.applyPhase('reconnect-timeout')
          this.leave()
        }
      }).catch(() => { /* poll best-effort */ })
    }, 700)
    this.nativeVoiceTimer = t
  }

  private stopNativeVoiceMonitor() {
    if (this.nativeVoiceTimer) { clearInterval(this.nativeVoiceTimer); this.nativeVoiceTimer = null }
  }

  /** ICE restart com BACKOFF: até MAX_ICE_RESTARTS por peer (1s/4s/9s entre
   *  tentativas). Antes era 1 tentativa imediata — no 4G/CGNAT o TURN demora
   *  a alocar e o restart único morria antes de ter rota.
   *  `force` pula o guard de 'failed': no CGNAT o ICE fica em 'checking'
   *  para sempre e nunca emite o evento, mas o re-gather ainda é a única
   *  chance de achar rota. */
  private async tryIceRestart(fp: string, pc: RTCPeerConnection, callId: string, force = false) {
    try {
      if (!force && pc.iceConnectionState !== 'failed') return
      if (pc.signalingState !== 'stable') return
      if (this.iceRestartTimers.has(fp)) return // já tem restart agendado
      const n = this.iceRestarts.get(fp) ?? 0
      if (n >= CallManager.MAX_ICE_RESTARTS) return
      this.iceRestarts.set(fp, n + 1)
      const wait = CallManager.ICE_RESTART_BACKOFF_MS[Math.min(n, CallManager.ICE_RESTART_BACKOFF_MS.length - 1)]
      const t = setTimeout(() => {
        this.iceRestartTimers.delete(fp)
        void this.doIceRestart(fp, callId, force).catch(() => {})
      }, wait)
      this.iceRestartTimers.set(fp, t)
    } catch { /* best-effort: a UI já avisa via ICE_FAILED_MSG */ }
  }

  /** Restart forçado em TODOS os PCs da chamada (usado pelo watchdog de
   *  'connecting', onde o ICE está mudo e nada mais dispara o re-gather). */
  private restartIceAll(callId: string) {
    for (const [fp, pc] of this.pcs) {
      try { void this.tryIceRestart(fp, pc, callId, true) } catch { /* melhor esforço */ }
    }
  }

  /** Executa um ICE restart de fato (chamado pelo timer de backoff). */
  private async doIceRestart(fp: string, callId: string, force = false) {
    const pc = this.pcs.get(fp)
    if (!pc || pc.signalingState !== 'stable') return
    if (!force && pc.iceConnectionState !== 'failed') return
    try { const anyPc = pc as any; if (typeof anyPc.restartIce === 'function') anyPc.restartIce() } catch { /* ignore */ }
    // restartIce() só marca "renegociar" — é preciso enviar um novo offer.
    if (pc.signalingState !== 'stable') return
    const offer = await createTunedOffer(pc)
    await pc.setLocalDescription(offer)
    await services.callOffer(fp, callId, JSON.stringify(offer)).catch(() => {})
  }

  /** Renegocia um PC já conectado (ex.: track anexada ao aceitar a chamada). */
  private async renegotiate(fp: string, pc: RTCPeerConnection) {
    try {
      if (!this.state || pc.signalingState !== 'stable') return
      const offer = await createTunedOffer(pc)
      await pc.setLocalDescription(offer)
      await services.callOffer(fp, this.state.callId, JSON.stringify(offer)).catch(() => {})
    } catch { /* peer isolado não derruba os demais */ }
  }

  private async createPC(fp: string, callId: string, initiator: boolean) {
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    // Medidor: registra os iceServers efetivos (o que foi tentado de verdade).
    try { this.iceServersUsed = getIceServers() } catch { this.iceServersUsed = null }
    const pc = newPeerConnection()
    this.pcs.set(fp, pc)
    this.wirePC(pc, fp, callId)
    // mic/câmera/tela sempre no MESMO stream do estado (item 3)
    this.attachLocalStreamToPC(pc)
    if (initiator) {
      try {
        const offer = await createTunedOffer(pc)
        await pc.setLocalDescription(offer)
        await services.callOffer(fp, callId, JSON.stringify(offer)).catch(() => {})
      } catch (e) {
        // oferta falhou (PC fechado, rede instável): fecha e remove — sem vazar PC travado
        try { pc.close() } catch { /* ignore */ }
        this.pcs.delete(fp)
        console.debug('[call] createOffer falhou, PC descartado:', String((e as any)?.message ?? e))
        throw e
      }
    }
  }

  /** Marca como participante SÓ quando o peer de fato entra (offer/answer/ICE). */
  private markJoined(fp: string) {
    try {
      if (!this.state || !fp || fp === this.myFp) return
      if (this.state.participants.find((p: any) => p.fp === fp)) return
      this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
      this.onUpdate({ ...this.state })
    } catch { /* ignore */ }
  }

  private async handleOffer(fromFp: string, callId: string, sdpStr: string) {
    if (!fromFp || fromFp === this.myFp) return
    if (!this.state || this.state.callId !== callId) {
      const me = this.getIdentity()
      if (!me) return
      if (!this.myFp) this.myFp = me.fingerprint
      if (typeof sdpStr === 'string' && sdpStr.indexOf('"offer"') >= 0) {
        this.pendingOffers.set(fromFp, { callId, sdp: sdpStr })
      }
      return
    }
    if (typeof sdpStr !== 'string') return
    let offer: RTCSessionDescriptionInit
    try { offer = JSON.parse(sdpStr) } catch { return }
    if (!offer || offer.type !== 'offer') return
    this.markJoined(fromFp) // peer mandou offer = está entrando na chamada

    let pc = this.pcs.get(fromFp)
    // PC morto (peer caiu e voltou): fecha e RE-CRIA antes de aplicar a offer —
    // senão setRemoteDescription lança em PC fechado e a reconexão nunca cola.
    if (pc && (pc.connectionState === 'closed' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed')) {
      try { pc.close() } catch { /* ignore */ }
      this.pcs.delete(fromFp)
      this.localIce.delete(fromFp)
      pc = undefined
    }
    if (!pc) {
      if (!supportsCalls()) { console.debug('[call] oferta ignorada: WebRTC indisponível neste aparelho'); return }
      pc = newPeerConnection()
      this.pcs.set(fromFp, pc)
      this.wirePC(pc, fromFp, callId)
      // anexa mic/câmera ANTES de aplicar a offer (answer já sai com as tracks)
      this.attachLocalStreamToPC(pc)
    }

    // Offer reenviada e link estável: já aplicada — ignora para não gerar loop.
    if (pc.signalingState === 'stable' && this.lastRemoteOffer.get(fromFp) === sdpStr) return

    const polite = this.isPolite(fromFp)
    // GLARE (renegociação simultânea de câmera/tela): só um lado cede.
    if (pc.signalingState === 'have-local-offer') {
      if (!polite) {
        // impolite: nossa offer vence — ignora a do peer.
        console.debug(`[call] GLARE ${callId}: impolite ignora offer de ${fromFp.slice(0, 8)}`)
        return
      }
      // polite: desfaz a offer local e aceita a remota.
      try { await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit) }
      catch { if ((pc.signalingState as string) !== 'stable') return }
    }
    try {
      await pc.setRemoteDescription(offer)
      this.lastRemoteOffer.set(fromFp, sdpStr)
      // candidatos do ofertante podem ter chegado antes desta offer (relay)
      await this.flushPendingIce(fromFp, pc)
      const answer = await createTunedAnswer(pc)
      await pc.setLocalDescription(answer)
      await services.callAnswer(fromFp, callId, JSON.stringify(answer)).catch(() => {})
    } catch (e) {
      // Antes era `/* silent */`: uma falha de setRemoteDescription/createAnswer
      // deixava o PC pela metade, sem erro e sem log — a chamada ficava muda em
      // "Conectando…" e não havia como saber por quê. Log honesto: falha de
      // sinalização é a pista nº1 de "às vezes não pega".
      console.warn(`[call] falha ao responder offer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
    }
  }

  private async handleAnswer(fromFp: string, callId: string, sdpStr: string) {
    if (!fromFp || fromFp === this.myFp) return
    const pc = this.pcs.get(fromFp)
    if (!pc) return
    this.markJoined(fromFp) // respondeu = entrou na chamada
    try {
      const ans = JSON.parse(sdpStr)
      if (!ans || ans.type !== 'answer') return
      // answer só vale se ainda temos offer local pendente (anti-GLARE/rollback).
      if (pc.signalingState !== 'have-local-offer') return
      await pc.setRemoteDescription(ans)
      // descrição remota pronta → candidatos ICE que chegaram cedo podem entrar
      await this.flushPendingIce(fromFp, pc)
    } catch (e) {
      // Idem handleOffer: sinalização que falha em silêncio é indistinguível
      // de "peer nunca respondeu" no log.
      console.warn(`[call] falha ao aplicar answer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
    }
  }

  private async handleIce(fromFp: string, callId: string, candidateStr: string, mid: string) {
    if (!fromFp || fromFp === this.myFp) return
    // Relay "áudio via sinalização" chega pelo mesmo callIce (mid 'audio-relay').
    // Detecta ANTES de tratar como candidato ICE — inclusive sem PC (relay-only).
    try {
      if ((mid === RELAY_MID || (typeof candidateStr === 'string' && candidateStr.indexOf('audio-chunk') >= 0)) && typeof candidateStr === 'string') {
        try {
          const parsed = JSON.parse(candidateStr)
          if (isRelayChunkPayload(parsed)) {
            this.handleRelayChunk(fromFp, callId, candidateStr)
            return
          }
        } catch { /* não é relay válido, segue como ICE */ }
        // mid audio-relay mas parse falhou como ICE? Tenta relay mesmo assim.
        if (mid === RELAY_MID) {
          try { this.handleRelayChunk(fromFp, callId, candidateStr) } catch { /* ignore */ }
          return
        }
      }
    } catch { /* nunca derruba o bus */ }
    const pc = this.pcs.get(fromFp)
    let cand: RTCIceCandidateInit
    try { cand = JSON.parse(candidateStr) } catch { return }
    // Sem PC ou sem remoteDescription: GUARDA (não descarta). O flush acontece
    // quando a offer/answer for aplicada — trickle ICE sobre relay chega antes.
    if (!pc || !pc.remoteDescription) {
      const q = this.pendingIce.get(fromFp) ?? []
      // cap defensivo (peer malicioso/rajada): mantém os mais recentes
      if (q.length >= 256) q.shift()
      q.push(cand)
      this.pendingIce.set(fromFp, q)
      return
    }
    try { await pc.addIceCandidate(cand) } catch { /* candidato tardio/inválido: ignora */ }
  }

  /** Despeja (em ordem) os candidatos ICE guardados antes da remoteDescription. */
  private async flushPendingIce(fp: string, pc: RTCPeerConnection) {
    const q = this.pendingIce.get(fp)
    if (!q || q.length === 0) return
    this.pendingIce.delete(fp)
    for (const cand of q) {
      try { await pc.addIceCandidate(cand) } catch { /* candidato individual inválido: segue os demais */ }
    }
  }

  private cleanup() {
    this.stopQualityMonitor()
    this.stopReconnectWatchdog()
    this.stopConnectWatchdog()
    this.stopOutgoingWatchdog()
    this.stopIncomingWatchdog()
    this.stopNativeVoiceMonitor()
    this.clearIceRestartTimers()
    try { this.lastStats.clear() } catch { /* ignore */ }
    try { this.lastNativeStats = null } catch { /* ignore */ }
    // Mantém lastFailureCause para o toast pós-fim (getPhase pós-leave);
    // nova chamada zera (ver start/acceptInbound/joinVoice).
    // Timer do grace relay antes do stopRelayFull (que já o cancela): garante
    // que nenhum "connected" chega depois da chamada encerrada.
    this.clearRelayFallbackTimer()
    try { this.stopRelayFull() } catch { /* ignore */ }
    this.badWindows = 0
    this.prevLost.clear()
    this.pendingIce.clear()
    this.localIce.clear()
    this.pendingOffers.clear()
    this.lastRemoteOffer.clear()
    this.iceReports.clear()
    this.iceRestarts.clear()
    this.qualityNotice = null
    this.pcs.forEach(pc => { try { pc.close() } catch { /* ignore */ } })
    this.pcs.clear()
    this.localStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } })
    this.resetScreenRuntime()
    this.localStream = null
    this.state = null
    this.onUpdate(null as any)
  }
}

// Detecta a voz nativa uma vez, no carregamento do módulo. Sem `await`: quem
// chama `getCallsSupport()` no mesmo tick ainda vê 'none' de forma síncrona,
// quem chama depois já vê 'full'. É fire-and-forget de propósito — não pode
// travar o boot nem rejeitar.
void detectNativeVoice()

export const callManager = new CallManager(() => {
  // 1) identidade injetada pelos shells (fonte da verdade — state React)
  if (cachedCallIdentity) return cachedCallIdentity
  // 2) fallback legado (nunca gravado pelo app — mantido por compat)
  try {
    const raw = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('forge:identity') : null)
      ?? localStorage.getItem('forge:identity') ?? localStorage.getItem('identity') ?? ''
    if (!raw) return null
    const j = JSON.parse(raw)
    return { fingerprint: j.fingerprint ?? 'local', nickname: j.nickname ?? 'você' }
  } catch { return null }
})

let cachedCallIdentity: { fingerprint: string; nickname: string } | null = null
/** Shells chamam ao carregar/trocar/limpar identidade — sem isso chamadas falham com "sem identidade". */
export function setCallIdentity(id: { fingerprint: string; nickname: string } | null) {
  cachedCallIdentity = id
}
