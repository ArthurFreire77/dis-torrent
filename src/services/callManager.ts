// CallManager — mesh WebRTC full-mesh; sinalização via core (SecureFrame) com fallback no browser.

import { services } from './index'
import { isAndroidRuntime } from './screenShare'
import { setCallVideoSending } from './callMedia'
import { addVoiceParticipant, removeVoiceParticipant, updateVoiceParticipantState, type CallParticipantView } from './callParticipants'
import { type CallEvent, type CallPhase, nextCallPhase, isCallPhaseActive } from './callPhases'
import type { VoiceMediaStats } from './models'
import {
  detectScreenEnvironment,
  buildDisplayMediaConstraints,
  derivedDisplayConstraints,
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

// ── Formato no fio: ver callWire.ts (navegador JSON ↔ nativo cru) ────────────
import { parseWireSdp, parseWireCandidate } from './callWire'
export { parseWireSdp, parseWireCandidate } from './callWire'
export type { WireSdp } from './callWire'

/** Ring de chamada entrante. `nickname` é o que a UI mostra (nome > fp). */
export interface IncomingCall {
  call_id: string
  from_fp: string
  kind: string
  nickname?: string
}

export type CallQuality = '480p' | '720p' | '1080p' | '4K'

export const CALL_QUALITY_KEY = 'distorrent:call_quality'
export const QUALITY_ORDER: CallQuality[] = ['480p', '720p', '1080p', '4K']

export const QUALITY_CONSTRAINTS: Record<CallQuality, MediaTrackConstraints> = {
  // Piso 480p/15fps: min 24 dava OverconstrainedError e a câmera nem abria em celular fraco.
  '480p': { width: { min: 640, ideal: 640, max: 1280 }, height: { min: 480, ideal: 480, max: 720 }, frameRate: { min: 15, ideal: 60, max: 120 } },
  '720p': { width: { min: 640, ideal: 1280, max: 1920 }, height: { min: 480, ideal: 720, max: 1080 }, frameRate: { min: 15, ideal: 60, max: 120 } },
  '1080p': { width: { min: 640, ideal: 1920, max: 1920 }, height: { min: 480, ideal: 1080, max: 1080 }, frameRate: { min: 15, ideal: 60, max: 120 } },
  '4K': { width: { min: 640, ideal: 3840, max: 3840 }, height: { min: 480, ideal: 2160, max: 2160 }, frameRate: { min: 15, ideal: 60, max: 120 } },
}

/** Câmera adaptativa: piso 480p, teto 1080p/60 — ideal é pedido, e o seletor vale p/ câmera e tela. */
export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { min: 640, ideal: 1280, max: 1920 },
  height: { min: 480, ideal: 720, max: 1080 },
  // min 15 (era 24): câmera frontal fraca de celular não entrega 24 fps e o
  // getUserMedia falhava com OverconstrainedError — câmera que não abre.
  frameRate: { min: 15, ideal: 60, max: 120 },
}

/** Limite REAL do dispositivo (capabilities/settings); sem track viva retorna null honesto. */
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

// ICE/TURN + privacidade: lógica em ./callIce (módulo standalone testável); reexportado daqui.
export {
  TURN_URL_KEY,
  isValidTurnUrl,
  getTurnUrl,
  getFallbackStunServers,
  getFallbackTurnCredential,
  getFallbackTurnServer,
  getClassicTurnServer,
  getIceServers,
  hasRelayConfigured,
} from './callIce'
import { getIceServers, bytesToBase64 } from './callIce'
export { bytesToBase64 } from './callIce'
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
  participants: CallParticipantView[]
  startAt: number
  quality?: CallQuality
  qualityNotice?: string | null
  /** Fallback "áudio via relay": true quando o mic está sendo retransmitido pela sinalização. */
  relayActive?: boolean
  /** True quando o usuário ligou manualmente (modo compatibilidade); false quando foi automático por ICE. */
  relayManual?: boolean
  /** Motivo: 'manual' | 'ice-failed' | 'ice-disconnected' | 'relay-only' | null */
  relayReason?: string | null
  /** Stream local de tela: prévia p/ todos, inclusive quem transmite (mesh não tem loopback). */
  localScreenStream?: MediaStream | null
  /** Stream local de câmera/mic: fonte da verdade da UI (roster pode não ter o stream ainda). */
  localStream?: MediaStream | null
  /** `true` = mídia no core Rust (Linux), sem MediaStream na página. */
  nativeMedia?: boolean
}

// Privacidade×ICE: lógica em ./callIcePrivacy (standalone testável); reexportado daqui.
export {
  getCallPrivacyMode,
  setCallPrivacyForIce,
  getCallPrivacyForIce,
  isIcePublicFallbackSuppressed,
  type CallPrivacyMode,
} from './callIcePrivacy'


// ── Áudio WebRTC de baixa latência ──────────────────────────────────────────
/** Constraints de mic para voz: processamento ligado e mono (menos banda/latência). */
export const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
}

/** Afina o SDP do Opus p/ voz em tempo real: FEC, DTX, ptime 20ms, 32kbps. */
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
export async function createTunedOffer(
  pc: RTCPeerConnection,
  opts?: { iceRestart?: boolean },
): Promise<RTCSessionDescriptionInit> {
  // iceRestart renova as credenciais ICE sem trocar a sessão — reparo de par half-open.
  const offer = await pc.createOffer(opts?.iceRestart ? { iceRestart: true } : undefined)
  offer.sdp = tuneOpusSdp(offer.sdp ?? '')
  return offer
}

/** Answer com Opus afinado (baixa latência). */
export async function createTunedAnswer(pc: RTCPeerConnection): Promise<RTCSessionDescriptionInit> {
  const answer = await pc.createAnswer()
  answer.sdp = tuneOpusSdp(answer.sdp ?? '')
  return answer
}

// Sem RTCPeerConnection no WebView, detecta ANTES do uso p/ falhar com erro honesto.
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
  // Sem WebRTC no WebView (WebKitGTK), a voz nativa em Rust cobre a chamada.
  return nativeVoiceAvailable === true
}

/** Screen share via getDisplayMedia (desktop/Android); detecção honesta via detectScreenEnvironment(). */
export function supportsScreenShare(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    // Android: getDisplayMedia existe mas lança TypeError; getScreenShareBackend já resolve a plataforma.
    return getScreenShareBackend() !== 'none'
  } catch { return false }
}

/** Motivo técnico pelo qual a captura de tela não está disponível agora. */
export function screenShareUnavailableReason(): string | null {
  try {
    if (supportsScreenShare()) return null
    const env = detectScreenEnvironment(getScreenShareBackend() === 'native')
    return env.notes.length ? env.notes.join(' · ') : SCREEN_UNAVAILABLE_MSG
  } catch { return SCREEN_UNAVAILABLE_MSG }
}

/** Quem captura a tela agora: WebView (getDisplayMedia) ou core nativo — capacidades distintas. */
export type ScreenShareBackend = 'display-media' | 'native' | 'none'
export function getScreenShareBackend(): ScreenShareBackend {
  try {
    // ANDROID PRIMEIRO: getDisplayMedia exposta lança TypeError (wry não mapeia display-capture).
    if (isAndroidRuntime()) {
      if (nativeVoiceAvailable === true) return 'native'
      return 'none'
    }
    const md: any = typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : null
    if (md?.getDisplayMedia) return 'display-media'
    if (nativeVoiceAvailable === true) return 'native'
    return 'none'
  } catch { return 'none' }
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
/** Diagnóstico item por item do suporte a chamadas; nunca lança (ausente vira false). */
export function diagnoseCallsSupport(): CallsDiagnosis {
  // Relata ao Rust o que a PÁGINA enxerga (WebKitGTK pode ter WebRTC desligado); usa services.
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
/** Mensagem detalhada p/ support==='none': lista o que falta + ação (começa com CALLS_UNAVAILABLE_MSG). */
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
    // FATO MEDIDO: WebKitGTK do Ubuntu vem SEM interface JS de WebRTC (toggle não resolve).
    if (native && isLinuxDesktop && !d.hasRTC) {
      return `${CALLS_UNAVAILABLE_MSG}: ${what}. Este é o WebKitGTK do Linux, que vem compilado sem WebRTC — não é falta de atualização, e não há como corrigir pelo app. A voz nativa em Rust também não subiu (sem dispositivo de áudio, ou desligada por DISTORRENT_NO_NATIVE_VOICE=1), então no desktop Linux resta a conversa por texto.`
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

// getUserMedia com erro honesto: sem mediaDevices → null; permissão/dispositivo → onCallNotice + null.
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
      // OverconstrainedError: degrada em ordem (720p/60 → … → 480p) — áudio nunca sai da jogada.
      if (merged.video && (e as Error)?.name === 'OverconstrainedError') {
        const quedas: MediaTrackConstraints[] = [
          { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 }, frameRate: { min: 15, ideal: 30 } },
          { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 }, frameRate: { min: 15, ideal: 60, max: 60 } },
          { width: { min: 320, ideal: 640 }, height: { min: 240, ideal: 480 }, frameRate: { min: 15, ideal: 30 } },
        ]
        for (const q of quedas) {
          try {
            return await md.getUserMedia({ ...merged, video: q })
          } catch { /* tenta a próxima degradação */ }
        }
        try {
          localMediaNotice?.('câmera não aceitou as resoluções pedidas — seguindo só com voz')
          return await md.getUserMedia({ ...merged, video: false })
        } catch { /* cai no erro honesto abaixo */ }
      }
      // getUserMedia({audio,video}) é atômico: câmera negada não pode deixar a chamada MUDA — tenta áudio puro.
      if (merged.video && (e as Error)?.name !== 'OverconstrainedError') {
        try {
          const s = await md.getUserMedia({ ...merged, video: false })
          const why = describeMediaError(e)
          try { localMediaNotice?.(`${why ? `${why.split(' — ')[0]} — ` : ''}seguindo só com voz`) } catch { /* ignore */ }
          return s
        } catch { /* nem áudio: cai no erro honesto abaixo */ }
      }
      const honest = describeMediaError(e)
      try { localMediaNotice?.(honest ?? `falha ao abrir microfone/câmera (${(e as Error)?.name ?? 'erro'})`) } catch { /* ignore */ }
      return null
    }
  } catch { return null }
}

// ── Estados ICE honestos ─────────────────────────────────────────────────────
// Barramento de falha ICE honesta: avisa failed imediato e disconnected >5s (pollStats não enxerga).
export type IceFailureState = 'failed' | 'disconnected'
export interface IceFailureInfo { fp: string; callId: string; state: IceFailureState }
/** disconnected precisa persistir 12s p/ avisar: no 4G o relay demora a alocar (5s era cedo demais). */
export const ICE_DISCONNECTED_GRACE_MS = 12000

// ── Medidor da mídia (Missão B, passo 1) ─────────────────────────────────────
// Degrau real por peer via pc.getStats; "relay" = só relay explícito do usuário (sem TURN embutido).
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
export interface DistorrentNatEndpoint { addr: string; source: string }

/** Diagnóstico por peer p/ painel em tempo real; numéricos null quando indisponíveis ("—"). */
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
      // Bitrate sem janela temporal não existe: null honesto (painel mostra "—"); pollStats fará real.
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
// Fallback sem TURN: mic em fatias webm/opus via callIce cifrado + jitter buffer no receptor.
export const RELAY_TIMESLICE_MS = 500
export const RELAY_ICE_FAIL_MS = 5000
export const RELAY_MAX_DELAY_MS = 2000
export const RELAY_MID = 'audio-relay'
export const RELAY_VIA_LABEL = 'via relay (latência alta)'
export const RELAY_BC_NAME = 'distorrent-call-relay-v1'
export const RELAY_WINDOW_EVENT = 'distorrent:call-relay'
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

/** Constrói MediaRecorder testando cada formato; catch antigo lançava de novo e o relay nunca subia. */
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
/** Suporte: 'full' (WebRTC) ou 'none' — relay-only removido de propósito (latência inaceitável). */
/** Voz nativa (Rust): quando presente, o core conduz offer/answer/ICE e a página não cria PC. */
let nativeVoiceAvailable: boolean | null = null
/** Rota da chamada NATIVA (iceReports fica vazio — mídia no Rust — e a tela mostrava "sem rota"). */
let nativeRoute: string | null = null

/** Consulta cacheada; `force` re-pergunta (dispositivo/engine podem subir depois). */
export async function detectNativeVoice(force?: boolean): Promise<boolean> {
  if (!force && nativeVoiceAvailable !== null) return nativeVoiceAvailable
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
  // Cache da detecção de voz nativa; chamada síncrona só enxerga o que já foi detectado.
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
        } else if (st === 'connected' || st === 'completed') {
          clearGrace()
          // WebRTC conectou: volta do áudio-via-relay. closed NÃO é recuperação (PC fechado de propósito).
          emitIceRecovered({ fp, callId })
        }
      } catch { /* monitor nunca derruba a chamada */ }
    }
  } catch { /* ignore */ }
}

export class CallManager {
  private pcs = new Map<string, RTCPeerConnection>()
  /** Trava de reentrância da câmera (dois cliques = dois getUserMedia vivos). */
  private cameraBusy = false
  /** Candidatos ICE chegados antes da descrição remota; fila isolada por call_id (flush no apply). */
  private pendingIce = new Map<string, Map<string, RTCIceCandidateInit[]>>()
  /** Candidatos ICE LOCAIS por peer — reenviados quando o gathering termina (ver resendLocalIce). */
  private localIce = new Map<string, RTCIceCandidate[]>()
  private pendingOffers = new Map<string, { callId: string; sdp: string }>()
  /** Chamadas que ESTE lado aceitou/originou: offer chega antes do clique em Aceitar (bug do e2e). */
  private acceptedCalls = new Set<string>()
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
  private distorrentNat: DistorrentNatEndpoint | null = null
  /** Watchdog da reconexão: sem mídia viva por 30s → encerra honesto. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly RECONNECT_TIMEOUT_MS = 30_000
  /** Grace do modo relay: transporte pronto → declara conectado (ver markRelayConnectedFallback). */
  private static readonly RELAY_CONNECT_GRACE_MS = 2_500
  private relayFallbackTimer: ReturnType<typeof setTimeout> | null = null
  /** Timeout de 'connecting' sem mídia → reinicia ICE (ICE em silêncio no CGNAT). */
  private nativeVoiceTimer: ReturnType<typeof setInterval> | null = null
  private nativeVoiceSince = -1
  /** Chamadas JÁ acabadas: barra aceite tardio, chamada fantasma e duplo-clique em "Aceitar". */
  private endedCalls = new Set<string>()
  /** callIds com aceite em andamento (duplo clique). */
  private accepting = new Set<string>()
  /** Evita que o eco de `call_ended` execute `leave()` recursivamente. */
  private leavingCalls = new Set<string>()
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
  /** Sender de áudio da TELA por peer, REUSADO entre shares (sem ele o SDP crescia a cada ciclo). */
  private screenAudioSenders = new Map<RTCPeerConnection, RTCRtpSender>()
  /** Atalho legado 'monitor'/'window'; fonte de verdade é screenOptions.source. */
  private screenSource: 'monitor' | 'window' = 'monitor'
  // ── Screen share (módulo screenShare.ts) ──────────────────────────────────
  /** Opções completas de compartilhamento (fonte/áudio/qualidade/FPS). */
  private screenOptions: ScreenShareOptions = { ...SCREEN_DEFAULT_OPTIONS }
  /** Ambiente de captura detectado (plataforma, capacidades, notas). */
  private screenEnv: ScreenEnvironment = detectScreenEnvironment(getScreenShareBackend() === 'native')
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
  /** Reconciliação do roster a cada 10s: eventos perdidos não deixam o painel divergente. */
  private rosterTimer: ReturnType<typeof setInterval> | null = null
  /** Reparo periódico de par half-open no mesh (ver `repairHalfOpenPairs`). */
  private repairTimer: ReturnType<typeof setInterval> | null = null
  private badWindows = 0
  private prevLost = new Map<string, number>()
  /** UI pode assinar para exibir toast além do CallState.qualityNotice. */
  public onQualityNotice: ((msg: string) => void) | null = null
  /** Avisos de FASE (recusada/perdida/reconexão) — UI assina p/ toast; é ciclo de vida, não diagnóstico. */
  public onCallNotice: ((msg: string) => void) | null = null
  /** Falha de ICE honesta (failed imediato ou disconnected >5s) — UI mostra ICE_RELAY_MSG. */
  public onIceFailed: ((info: IceFailureInfo) => void) | null = null
  /** O ring de chamada entrante sumiu (watchdog/end/rejeição) — o shell limpa
   *  o overlay e para o sfx, que vivem em estado React separado. */
  public onIncomingGone: ((callId: string) => void) | null = null
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

  // Campo explícito (não parameter property): node --experimental-strip-types não suporta.
  private readonly getIdentity: () => { fingerprint: string; nickname: string } | null

  constructor(getIdentity: () => { fingerprint: string; nickname: string } | null) {
    this.getIdentity = getIdentity
  }

  bind(cb: (s: CallState | null) => void) {
    // Publica o stream local de TELA em CADA emissão de estado (um ponto só, sem call sites esquecidos).
    this.onUpdate = (s) => {
      if (s) {
        try {
          const withScreen = s as CallState
          if (withScreen.localScreenStream !== (this.screenStream ?? null)) {
            withScreen.localScreenStream = this.screenStream ?? null
          }
          // Mesma razão do stream de tela: quem transmite precisa do PRÓPRIO
          // stream, e não do roster (que pode não tê-lo no caminho nativo).
          if (withScreen.localStream !== (this.localStream ?? null)) {
            withScreen.localStream = this.localStream ?? null
          }
          // Clona o roster a cada emissão: cópia rasa deixava tiles memoizados presos ("conectado mas não vejo ninguém").
          withScreen.participants = (withScreen.participants ?? []).map((p) => ({ ...p }))
        } catch { /* estado sem o campo: nunca derruba o bus */ }
      }
      cb(s)
    }
    try { setLocalMediaNotice((m) => { try { this.onCallNotice?.(m) } catch { /* ignore */ } }) } catch { /* ignore */ }
    // identidade já disponível (shells chamam setCallIdentity antes) — base do polite/impolite
    try { const me = this.getIdentity(); if (me && !this.myFp) this.myFp = me.fingerprint } catch { /* ignore */ }
    // escuta eventos do engine (oferta/resposta/ICE + relay via callIce/call_signal)
    // Descarta o bind anterior: remount duplo vazava listener e processava eventos 2x.
    try { this.engineOff?.() } catch { /* ignore */ }
    this.engineOff = services.subscribe((ev: any) => {
      // eventos de sinalização sem fp válido são ignorados (nunca crasham o bus)
      const fpOk = typeof ev?.from_fp === 'string' && ev.from_fp.length > 0
      // SELF-ECHO (browser): promoteOnSignal rodava antes do filtro de fp próprio e o badge mentia "Conectando…".
      if (fpOk && (ev.type === 'call_offer' || ev.type === 'call_answer' || ev.type === 'call_ice')) {
        try {
          const meNow = this.getIdentity()
          if (meNow && ev.from_fp === meNow.fingerprint) return
        } catch { /* segue sem identidade */ }
      }
      if (ev.type === 'call_offer' && fpOk) {
        // Offer fluindo = sinalização viva: sai de outgoing/incoming mesmo sem call_accepted.
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
      if (ev.type === 'call_incoming' && typeof ev.call_id === 'string') {
        // SELF-RING (browser): callInvite ecoa o próprio call_incoming — filtrar o remetente.
        try {
          const meNow = this.getIdentity()
          if (meNow && ev.from_fp === meNow.fingerprint) return
        } catch { /* segue sem identidade */ }
        // Ring com estado no manager: watchdog de incoming (60s) em vez de timer só no React do shell.
        if (!this.state || !isCallPhaseActive(this.state.phase)) {
          const me = this.getIdentity()
          if (me) {
            this.myFp = me.fingerprint
            this.state = {
              callId: String(ev.call_id),
              kind: (ev.kind === 'video' ? 'video' : 'voice') as CallKind,
              convId: '',
              phase: 'incoming',
              muted: false,
              deafened: false,
              cameraOn: false,
              sharing: false,
              participants: [{ fp: me.fingerprint, nickname: me.nickname }],
              startAt: Date.now(),
              quality: this.quality,
              ...(nativeVoiceAvailable === true ? { nativeMedia: true } : {}),
            } as unknown as CallState
            this.startIncomingWatchdog()
            this.onUpdate({ ...this.state })
          }
        }
      }
      // Participante só entra de verdade com offer/answer/ICE — o ring lista
      // apenas o autor (ver acima).
      if (ev.type === 'call_accepted') {
        // o outro lado atendeu → sinalização fluindo, mídia negociando
        if (this.state && this.state.callId === ev.call_id) this.applyPhase('accept')
      }
      if (ev.type === 'call_rejected') {
        if (this.state && this.state.callId === ev.call_id) {
          // RECUSA EM GRUPO É INDIVIDUAL: solta só o PC de quem recusou (pcs é por peer).
          const fp = String((ev as { from_fp?: string }).from_fp ?? '')
          const coletiva = this.pcs.size > 1 || this.state.callId.startsWith('voice-')
          if (coletiva) {
            // Solta SÓ a mídia de quem recusou (mesma limpeza do
            // `onVoiceParticipantLeft`, que já é o caminho de saída de um par).
            if (fp && fp !== this.myFp) {
              this.pendingOffers.delete(fp)
              try { this.pcs.get(fp)?.close() } catch { /* fecha só este par */ }
              this.pcs.delete(fp)
              this.iceRestarts.delete(fp)
              this.localIce.delete(fp)
              this.lastRemoteOffer.delete(fp)
              this.pendingIce.delete(fp)
              const st = this.state
              if (st && removeVoiceParticipant(st.participants, fp)) {
                this.onUpdate({ ...st })
              } else if (st) {
                this.onUpdate({ ...st })
              }
              this.onCallNotice?.(`${fp.slice(0, 8)} não entrou na chamada`)
            }
          } else {
            this.applyPhase('remote-reject')
            this.onCallNotice?.('chamada recusada')
            this.leave()
          }
        }
      }
      if (ev.type === 'call_participant_added') {
        this.onParticipantAdded(String(ev.call_id ?? ''), String(ev.fp ?? ''))
      }
      if (ev.type === 'voice_joined' && typeof ev.community_id === 'string' && typeof ev.channel_id === 'string') {
        this.onVoiceParticipantJoined(`voice-${ev.community_id}-${ev.channel_id}`, String(ev.fp ?? ''))
      }
      if (ev.type === 'voice_left' && typeof ev.community_id === 'string' && typeof ev.channel_id === 'string') {
        this.onVoiceParticipantLeft(`voice-${ev.community_id}-${ev.channel_id}`, String(ev.fp ?? ''))
      }
      if (ev.type === 'voice_state_changed' && typeof ev.community_id === 'string' && typeof ev.channel_id === 'string') {
        this.onVoiceParticipantState(
          `voice-${ev.community_id}-${ev.channel_id}`,
          String(ev.fp ?? ''),
          !!ev.muted,
          !!ev.deafened,
        )
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
          if (addr && source) this.distorrentNat = { addr, source }
        } catch { /* nunca derruba o bus */ }
      }
      if (ev.type === 'call_ended') {
        const st = this.state
        if (st && st.callId === ev.call_id) {
          const wasIncoming = st.phase === 'incoming'
          // EM GRUPO, "DESLIGAR" É INDIVIDUAL: call_ended derruba só o par que saiu (mesh 3+).
          const fp = String((ev as { from_fp?: string }).from_fp ?? '')
          const coletiva = this.pcs.size > 1 || st.callId.startsWith('voice-')
          const saiuEu = !!fp && fp === this.myFp
          if (coletiva && !saiuEu && !wasIncoming) {
            if (fp && fp !== this.myFp) {
              this.pendingOffers.delete(fp)
              try { this.pcs.get(fp)?.close() } catch { /* fecha só este par */ }
              this.pcs.delete(fp)
              this.iceRestarts.delete(fp)
              this.localIce.delete(fp)
              this.lastRemoteOffer.delete(fp)
              this.pendingIce.delete(fp)
              const cur = this.state
              if (cur && removeVoiceParticipant(cur.participants, fp)) {
                this.onUpdate({ ...cur })
              }
              this.onCallNotice?.(`${fp.slice(0, 8)} saiu da chamada`)
            }
            return
          }
          this.applyPhase('remote-ended')
          if (wasIncoming) {
            this.onCallNotice?.('chamada perdida')
            this.onIncomingGone?.(st.callId)
          }
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
    // WebRTC conectou depois: desliga o áudio-via-relay automático e promove a fase p/ 'connected'.
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
    // Repõe o estado no novo assinante: troca de shell (768px) senão a UI ficava vazia ("chamada fantasma").
    try {
      // Via onUpdate (repõe streams e clona o roster), nunca callback direto.
      if (this.state) this.onUpdate({ ...this.state } as CallState)
    } catch { /* replay é conveniência: nunca derruba o bind */ }
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

  /** Watchdog de OUTGOING: encerra honesto se ninguém atende ("Chamando…" infinito). */
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
  /** Watchdog de INCOMING: quem ligou sumiu sem call_ended → 'missed' (ring eterno). */
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
          this.onIncomingGone?.(callId)
          void this.leave()
        } catch { /* watchdog nunca derruba */ }
      }, CallManager.INCOMING_TIMEOUT_MS)
    } catch { /* ignore */ }
  }

  /** Recusa o ring atual (botão do overlay): avisa o chamador e limpa o estado
   *  de incoming do manager — o shell não precisa saber dos detalres. */
  rejectIncoming(callId: string, fromFp: string, reason = 'ocupado') {
    const st = this.state
    if (st && st.callId === callId && st.phase === 'incoming') {
      this.stopIncomingWatchdog()
      this.state = null
      this.lastPhase = 'rejected'
      this.onIncomingGone?.(callId)
      this.onUpdate(null as any)
    }
    services.callReject(callId, fromFp, reason).catch(() => {})
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
      // Só o CHAMADOR sai de 'outgoing' com sinalização; o ring 'incoming' continua tocando até Aceitar.
      if (st.phase === 'outgoing') this.applyPhase('signal')
    } catch { /* fase nunca derruba o bus */ }
  }

  /** Watchdog de CONEXÃO: CGNAT deixa o ICE em 'checking' p/ sempre → restart + 'ice-failed'. */
  private startConnectWatchdog() {
    this.stopConnectWatchdog()
    this.connectWatchdogGrants = 0
    try {
      // callId capturado no START: timer de chamada morta não pode agir na chamada nova.
      const callId = this.state?.callId
      this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(callId), CallManager.CONNECT_TIMEOUT_MS)
    } catch { /* ignore */ }
  }

  /** Corpo do watchdog de conexão (extraído para poder reagendar a si mesmo). */
  private onConnectWatchdogFire(callId?: string) {
    // Chamada TROCADA desde que o timer armou? O watchdog é da chamada velha.
    if (callId && (!this.state || this.state.callId !== callId)) return
    this.connectTimer = null
    try {
      const st = this.state
      if (!st || st.phase !== 'connecting') return
      if (this.relayActive) return // relay já é a rota viva
      if ((st as any)?.nativeMedia) return // nativo: o monitor da mídia Rust vigia
      let anyAlive = false
      for (const pc of this.pcs.values()) {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          anyAlive = true
          break
        }
      }
      if (anyAlive) return
      // CANAL VAZIO NÃO É FALHA: sala ociosa não é ICE travado — reagenda (teto de 3 postergações).
      if (this.pcs.size === 0 && st.callId.startsWith('voice-')) {
        if (this.connectWatchdogGrants < 3) {
          this.connectWatchdogGrants++
          this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(callId), CallManager.CONNECT_TIMEOUT_MS)
          return
        }
        // Mesmo teto atingido: avisa, mas NÃO sai do canal sozinho. Sair é
        // decisão do usuário; a sala continua disponível para quem chegar.
        this.setFailureCause('ninguém conectou a mídia ainda — o canal segue aberto aguardando participantes')
        return
      }
      // ICE ainda COLETANDO: não force restart (jogaria fora o gathering) — dá mais uma janela.
      let stillGathering = false
      for (const pc of this.pcs.values()) {
        if (pc.iceGatheringState === 'gathering') { stillGathering = true; break }
      }
      if (stillGathering && this.connectWatchdogGrants < 2) {
        this.connectWatchdogGrants++
        this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(callId), CallManager.CONNECT_TIMEOUT_MS)
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

  /** Watchdog da reconexão: sem mídia viva em RECONNECT_TIMEOUT_MS, encerra com aviso honesto. */
  private startReconnectWatchdog() {
    this.stopReconnectWatchdog()
    try {
      const callId = this.state?.callId
      this.reconnectTimer = setTimeout(() => {
        try {
          const st = this.state
          // Watchdog da chamada velha? Não mexe na nova.
          if (callId && (!st || st.callId !== callId)) return
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
      // TRANSPORTE ≠ MÍDIA: peer_offline (queda de transporte) não derruba chamada viva via ICE.
      const pc = this.pcs.get(fp)
      const midiaViva = !!pc && (
        pc.iceConnectionState === 'connected' ||
        pc.iceConnectionState === 'completed' ||
        pc.connectionState === 'connected'
      )
      if (midiaViva) {
        this.onUpdate({ ...st })
        return
      }
      if (st.phase === 'connected') this.applyPhase('ice-failed') // → reconnecting
      else this.onUpdate({ ...st })
    } catch { /* ignore */ }
  }

  /** Peer voltou (peer_online): re-cria PC + nova offer; glare resolvido por polite/impolite. */
  private onPeerBack(fp: string) {
    try {
      const st = this.state
      if (!st || !fp || fp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fp)
      if (!p) return
      p.disconnected = false
      const pc = this.pcs.get(fp)
      // ICE 'disconnected' é TRANSITÓRIO (navegador volta sozinho); só 'closed'/'failed' exigem PC nova.
      const dead = !pc
        || pc.connectionState === 'closed'
        || pc.iceConnectionState === 'failed'
        || pc.iceConnectionState === 'closed'
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
        // Já estava na lista mas desconectado (caiu e voltou): onPeerBack reconecta; limpa o visual.
        p.disconnected = false
      }
      this.onUpdate({ ...st })
    } catch { /* ignore */ }
  }

  private onVoiceParticipantJoined(callId: string, fp: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId || !fp || fp === this.myFp) return
      const added = addVoiceParticipant(st.participants, fp)
      if (added) this.onUpdate({ ...st })
      // MESH NO BROWSER: só o lado de fp MAIOR oferece ao novo (regra determinística, anti-glare).
      if (
        !(st as any).nativeMedia &&
        !this.pcs.has(fp) &&
        isCallPhaseActive(st.phase) &&
        this.myFp &&
        this.myFp > fp
      ) {
        void this.createPC(fp, callId, true).catch(() => { /* par best-effort */ })
      }
    } catch { /* evento de roster não derruba a chamada */ }
  }

  private onVoiceParticipantLeft(callId: string, fp: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId || !fp || fp === this.myFp) return
      // Offer retida de quem saiu nunca vai ser aplicada: sem isto ela ficava
      // em memória para sempre (e podia ser aplicada numa geração seguinte).
      this.pendingOffers.delete(fp)
      if (!removeVoiceParticipant(st.participants, fp)) return
      try { this.pcs.get(fp)?.close() } catch { /* encerra apenas a mídia deste participante */ }
      this.pcs.delete(fp)
      this.iceRestarts.delete(fp)
      this.localIce.delete(fp)
      this.lastRemoteOffer.delete(fp)
      this.pendingIce.delete(fp)
      this.onUpdate({ ...st })
    } catch { /* saída de participante não derruba a chamada */ }
  }

  private onVoiceParticipantState(callId: string, fp: string, muted: boolean, deafened: boolean) {
    try {
      const st = this.state
      if (!st || st.callId !== callId || !fp || fp === this.myFp) return
      const added = addVoiceParticipant(st.participants, fp)
      const changed = updateVoiceParticipantState(st.participants, fp, muted, deafened)
      if (added || changed) this.onUpdate({ ...st })
      // ANÚNCIO REVERSO do core: sem criar PC aqui, o joiner nunca abre mídia com quem chegou antes.
      if (
        added &&
        !(st as any).nativeMedia &&
        !this.pcs.has(fp) &&
        isCallPhaseActive(st.phase) &&
        this.myFp &&
        this.myFp > fp
      ) {
        void this.createPC(fp, callId, true).catch(() => { /* par best-effort */ })
      }
    } catch { /* estado remoto inválido não derruba a chamada */ }
  }

  /** Sinal dedicado de TELA: sdp carrega JSON {screen:'on'|'off'} — badge TELA sem gambiarra em m-lines. */
  private onScreenShareSignal(callId: string, fromFp: string, sdpStr: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId || !fromFp || fromFp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fromFp)
      if (!p) return
      let on: boolean | null = null
      let cameraOn: boolean | null = null
      try {
        const parsed = JSON.parse(sdpStr)
        if (parsed && typeof parsed === 'object') {
          on = (parsed as any).screen === 'on'
          if (typeof (parsed as any).cameraOn === 'boolean') cameraOn = (parsed as any).cameraOn
        }
      } catch { /* sdp legado: ignora */ }
      if (on !== null) {
        p.sharing = on
        if (cameraOn !== null) p.cameraOn = cameraOn
        if (!on) {
          // Não deixa o ÚLTIMO frame da tela congelado no tile depois que o
          // outro lado parou de compartilhar (parecia que ainda estava no ar).
          try { delete (p as any).videoUrl } catch { /* ignore */ }
          try { (p as any).videoSeq = -1 } catch { /* ignore */ }
        }
        this.onUpdate({ ...st })
      }
    } catch { /* ignore */ }
  }

  /** Envia o sinal de TELA (on/off) para todos os participantes ativos. */
  private broadcastScreenSignal(on: boolean, cameraOn?: boolean) {
    try {
      const st = this.state
      if (!st) return
      const payload = JSON.stringify({ screen: on ? 'on' : 'off', ...(cameraOn === undefined ? {} : { cameraOn }) })
      for (const p of st.participants) {
        if (!p.fp || p.fp === this.myFp) continue
        services.screenShareOffer(p.fp, st.callId, payload).catch(() => {})
      }
    } catch { /* best-effort */ }
  }

  async start(kind: CallKind, convId: string, targetFps: string[]): Promise<CallState> {
    // Chamada em andamento? Não pisa: o segundo start vazava PCs/mic/watchdogs
    // da primeira e fabricava dois invites (comportamento clássico de duplo-clique).
    if (this.state && isCallPhaseActive(this.state.phase)) {
      throw new Error('já existe uma chamada em andamento — encerre a atual antes')
    }
    // Re-confere a voz nativa AGORA: o engine pode ter re-armado a mídia depois
    // do boot (áudio subiu tarde) — o cache do boot dizia 'não' para sempre.
    await detectNativeVoice(true)
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
    // Sem callId inventado (chamada fantasma); invite vai ANTES da mídia local (ring imediato).
    const callId = await services.callInvite(targetFps[0] ?? convId, kind)
    this.acceptedCalls.add(callId) // eu originue: offers/respostas fluem já
    for (const fp of targetFps.slice(1)) {
      if (fp === me.fingerprint) continue
      try { await services.callAddParticipant(fp, callId, fp, kind) } catch { /* ring best-effort */ }
    }

    // O CHAMADOR JÁ CONHECE A SALA INTEIRA: roster nasce com todos os convidados (mesh em estrela era o bug).
    const convidados = [...new Set(
      [targetFps[0], ...targetFps.slice(1)]
        .filter((fp): fp is string => !!fp && fp !== me.fingerprint),
    )]

    // CHAMADA NATIVA: nada de getUserMedia aqui (mic da página competia com o do core e ficava preso).
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
        participants: [{ fp: me.fingerprint, nickname: me.nickname, muted: false }, ...convidados.map(fp => ({ fp, nickname: fp.slice(0, 6), muted: false }))],
        nativeMedia: true,
      } as unknown as CallState
      this.startNativeVoiceMonitor(callId)
      this.onUpdate({ ...this.state })
      this.startCallForeground()
      return this.state
    }

    // Caminho navegador: mídia local agora (sem mic/permissão → null; o PC
    // sem tracks ainda completa a sinalização).
    const qOrVideo: MediaTrackConstraints | boolean = kind === 'video' ? { ...CAMERA_CONSTRAINTS } : false
    const constraints: MediaStreamConstraints = kind === 'video' ? { audio: true, video: qOrVideo } : { audio: true, video: false }
    this.localStream = await getLocalMedia(constraints)

    this.resetRelayForNewCall()
    this.state = {
      callId,
      kind,
      convId,
      phase: 'outgoing',
      muted: false,
      deafened: false,
      // Deriva do track REAL: getLocalMedia pode ter degradado p/ só voz (UI mentia "câmera ligada").
      cameraOn: this.hasLiveCamera(),
      sharing: false,
      participants: [
        { fp: me.fingerprint, nickname: me.nickname, stream: this.localStream ?? undefined },
        // Convidados no roster desde o início (sem eles a malha ficava em estrela).
        ...convidados.map(fp => ({ fp, nickname: fp.slice(0, 6) })),
      ],
      startAt: Date.now(),
      quality: this.quality,
      qualityNotice: null,
      relayActive: false,
      relayManual: false,
      relayReason: null,
    }
    // Watchdogs ANTI-INFINITO: outgoing (sem resposta) + connecting (sem rota) — antes só o de reconexão.
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
    this.startCallForeground()
    return this.state
  }

  async joinVoice(communityId: string, channelId: string) {
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    // Entrar num canal com DM ativa sobrescrevia estado sem fechar PCs (mic preso até o watchdog do par).
    if (this.state && isCallPhaseActive(this.state.phase) && !this.state.callId.startsWith('voice-')) {
      throw new Error('já existe uma chamada em andamento — encerre a atual antes de entrar num canal de voz')
    }
    // Já em OUTRO canal de voz: sai antes de entrar (estado/mic do anterior ficavam vivos).
    const alvo = `voice-${communityId}-${channelId}`
    if (
      this.state
      && this.state.callId.startsWith('voice-')
      && this.state.callId !== alvo
      && isCallPhaseActive(this.state.phase)
    ) {
      try { await this.leave() } catch { /* melhor entrar do que travar no canal antigo */ }
    }
    // Re-confere a voz nativa AGORA (o engine re-arma a mídia se o áudio
    // subiu depois do boot) — o mesmo reset do start().
    await detectNativeVoice(true)
    // Anuncia a entrada PRIMEIRO (gate do auto-register nativo + roster da UI).
    await services.voiceJoin(communityId, channelId)
    const me = this.getIdentity()
    if (!me) return
    this.myFp = me.fingerprint
    const callId = `voice-${communityId}-${channelId}`
    this.acceptedCalls.add(callId) // quem entra no canal aceitou por definição
    this.quality = getStoredQuality()
    this.qualityNotice = null
    this.badWindows = 0
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch { /* ignore */ }
    try { this.lastNativeStats = null } catch { /* ignore */ }
    this.prevLost.clear()
    this.resetRelayForNewCall()

    // CANAL NATIVO (Linux): o core registrou as sessões e ofereceu a todos os
    // presentes no voice_join — aqui só monitoramos a mídia dele.
    if (nativeVoiceAvailable === true) {
      this.localStream = null
      this.screenStream = null
      this.state = {
        callId,
        kind: 'voice',
        convId: channelId,
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
      // Roster semeado pelo voiceStates (fonte de verdade): "entrei e não vejo as pessoas".
      try {
        const states = await services.voiceStates(communityId, channelId)
        for (const [fp, muted, deafened] of states) {
          if (!fp || fp === me.fingerprint) continue
          if (!this.state.participants.some((p: any) => p.fp === fp)) {
            this.state.participants.push({
              fp,
              nickname: fp.slice(0, 6),
              muted: !!muted,
              deafened: !!deafened,
            })
          }
        }
      } catch { /* roster best-effort: os eventos ainda chegam */ }
      // Reconciliador: eventos perdidos não deixam mais o painel divergente.
      this.startRosterReconcile(callId, communityId, channelId)
      this.startNativeVoiceMonitor(callId)
      this.onUpdate({ ...this.state })
      return this.state
    }

    // Caminho navegador: mic local + MESH com quem já está (sem isso os watchdogs matavam em ~50s).
    this.localStream = await getLocalMedia({ audio: true })
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
    // EU (joiner) ofereço a quem já está; quem entra depois oferece a nós (anti-glare resolve).
    try {
      const states = await services.voiceStates(communityId, channelId)
      for (const [fp] of states) {
        if (!fp || fp === me.fingerprint) continue
        if (!this.state.participants.some((p: any) => p.fp === fp)) {
          this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
        }
      }
      for (const [fp] of states) {
        if (!fp || fp === me.fingerprint) continue
        try { await this.createPC(fp, callId, true) } catch { /* par best-effort */ }
      }
    } catch { /* lista best-effort: voice_joined still wires latecomers */ }
    // Origem de verdade contínua para o roster (ver startRosterReconcile).
    this.startRosterReconcile(callId, communityId, channelId)
    // DRENA offers retidas durante o `getLocalMedia`/`voiceJoin`.
    // DRENA offers retidas: par pode oferecer antes de o estado nascer (participante "na lista" e mudo).
    try {
      for (const fp of [...this.pendingOffers.keys()]) {
        const pend = this.pendingOffers.get(fp)
        if (!pend || pend.callId !== callId) continue
        this.pendingOffers.delete(fp)
        await this.handleOffer(fp, pend.callId, pend.sdp).catch(() => { /* par best-effort */ })
      }
    } catch { /* offer pendente nunca derruba o join */ }
    // Entrada direta em `connecting` (sem passar por applyPhase): arma o
    // watchdog aqui — senão "Conectando…" infinito se o ICE nunca fechar.
    this.startConnectWatchdog()
    this.ensureRelayTransport()
    this.startQualityMonitor()
    this.onUpdate({ ...this.state })
    this.startCallForeground()
    return this.state
  }

  // ── joinVoiceRelayOnly REMOVIDO ──────────────────────────────────────────
  // Sem modo relay-only: sem WebRTC a chamada falha honesto (ver getCallsSupport).
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

  /** Toggle manual "modo compatibilidade": liga/desliga o relay sem derrubar o WebRTC. */
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
  // Botão "R" saiu da UI; setRelayMode inalcançável por segurança; relay de ARQUIVOS é outro caminho.

  /** Resumo da rota ICE em 1 linha (host/srflx/relay/n-d) — "por que não conecta?" sem abrir diagnóstico. */
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

  /** Atende do lado answerer: relay e mesh precisam do estado no CallManager (não só callAccept). */
  async acceptInbound(callId: string, kind: CallKind, convId: string, fromFp: string, nickname?: string): Promise<CallState> {
    const me = this.getIdentity()
    if (!me) throw new Error('sem identidade')
    this.myFp = me.fingerprint
    // Validação REAL (não só a do shell): duplo clique, toque já encerrado e
    // chamada ativa diferente. `accepting` trava os dois cliques simultâneos.
    const porquê = this.canAccept(callId)
    if (porquê) throw new Error(porquê)
    this.accepting.add(callId)
    try {
      return await this.acceptInboundInner(callId, kind, convId, fromFp, nickname, me)
    } finally {
      this.accepting.delete(callId)
    }
  }

  private async acceptInboundInner(
    callId: string,
    kind: CallKind,
    convId: string,
    fromFp: string,
    nickname: string | undefined,
    me: { fingerprint: string; nickname: string },
  ): Promise<CallState> {
    if (this.state && this.state.callId !== callId && isCallPhaseActive(this.state.phase)) {
      throw new Error('já existe uma chamada em andamento — encerre a atual antes de atender outra')
    }
    // ACEITOU: as offers retidas no ring agora podem negociar (ver handleOffer).
    this.acceptedCalls.add(callId)
    await detectNativeVoice(true)
    // NATIVA: a mídia é do core — nada de getUserMedia/RTCPeerConnection aqui
    // (a offer retida foi absorvida pelo engine no call_accept).
    if (nativeVoiceAvailable === true) {
      this.lastFailureCause = null
      if (this.state && this.state.callId === callId) {
        if (this.state.phase === 'incoming') this.applyPhase('accept')
        this.stopConnectWatchdog() // navegador não vigia mídia nativa
        if (!this.state.convId && convId) this.state.convId = convId
        if (!this.state.participants.find(p => p.fp === fromFp)) {
          this.state.participants.push({ fp: fromFp, nickname: nickname ?? fromFp.slice(0, 6) })
        }
        ;(this.state as any).nativeMedia = true
        this.localStream = null
        this.startNativeVoiceMonitor(callId)
        this.onUpdate({ ...this.state })
        this.startCallForeground()
        return this.state
      }
      this.state = {
        callId,
        kind,
        convId,
        phase: 'connecting',
        muted: false,
        deafened: false,
        cameraOn: false,
        sharing: false,
        participants: [
          { fp: me.fingerprint, nickname: me.nickname },
          ...(fromFp === me.fingerprint ? [] : [{ fp: fromFp, nickname: nickname ?? fromFp.slice(0, 6) }]),
        ],
        startAt: Date.now(),
        quality: this.quality,
        nativeMedia: true,
      } as unknown as CallState
      this.stopConnectWatchdog()
      this.startNativeVoiceMonitor(callId)
      this.onUpdate({ ...this.state })
      return this.state
    }
    if (this.state && this.state.callId === callId) {
      if (this.state.phase === 'incoming') this.applyPhase('accept')
      if (!this.state.convId && convId) this.state.convId = convId
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
      // MALHA COMPLETA: announceSelfToRoom apresenta os demais ao recém-chegado ("para ele só tem você").
      this.announceSelfToRoom(callId)
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
      cameraOn: this.hasLiveCamera(),
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
    // Sem degradação p/ relay: WebRTC direto ou falha honesta (WebView sem PC ficava em 'connecting' eterno).
    await this.ensureMediaOnAllPCs()
    // DRENA TODAS AS OFFERS RETIDAS (não só a do host): grupo ficava mudo com os outros membros.
    try {
      const alvos = [fromFp, ...this.pendingOffers.keys()].filter(
        (fp, i, arr) => fp && arr.indexOf(fp) === i,
      )
      for (const fp of alvos) {
        const pend = this.pendingOffers.get(fp)
        if (!pend || pend.callId !== callId) continue
        this.pendingOffers.delete(fp)
        await this.handleOffer(fp, pend.callId, pend.sdp).catch((e) => {
          console.warn(`[call] offer retida de ${fp.slice(0, 8)} falhou ao aplicar: ${(e as Error)?.message ?? e}`)
        })
      }
      // Offers de outras chamadas ficam p/ elas; as desta chamada entram no roster (tile aparece).
      for (const fp of alvos) {
        if (!fp || fp === me.fingerprint) continue
        if (!this.state.participants.some((p: any) => p.fp === fp)) {
          this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
        }
      }
      this.onUpdate({ ...this.state })
    } catch { /* offer pendente nunca derruba o accept */ }
    // MALHA COMPLETA: pede à sala que apresente quem já está dentro (cobre offer perdida).
    this.announceSelfToRoom(callId)
    this.startCallForeground()
    return this.state
  }

  // ── startRelayOnly REMOVIDO ──────────────────────────────────────────────
  // Sem WebRTC, start() lança com mensagem honesta (ver getCallsSupport).

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
      // Falha de mic não pode virar beco sem saída: mantém o relay (receber áudio) e avisa o motivo.
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
  /** Áudio relay TOCANDO de verdade → fase 'connected' (sem PC não há media-connected; idempotente). */
  private markRelayAudioLive() {
    try {
      const st = this.state
      if (!st) return
      if (st.phase === 'connected') return
      this.applyPhase('relay-audio-live')
    } catch { /* fase nunca derruba a chamada */ }
  }

  /** Grace do relay: mudo/negado nunca emite chunk — declara conectado após grace curto. */
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
    // BUG REAL: parar tracks do localStream reaproveitado MATAVA o mic do WebRTC — só stream DEDICADO pode parar.
    const shared = !this.relayRecDedicated
    if (!shared) {
      try { this.relayRecStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
    }
    this.relayRecDedicated = false
    this.relayRecStream = null
  }
  private stopRelayFull() {
    this.stopRelaySender()
    // O AudioContext do relay nunca era fechado: cada chamada deixava um grafo
    // de áudio vivo (memória + device preso) até reiniciar o app.
    try { void this.relayAudioCtx?.close() } catch { /* ignore */ }
    this.relayAudioCtx = null
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
            if (!d || d.type !== 'distorrent-call-relay') return
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
  /** 1º chunk do MediaRecorder traz o cabeçalho WebM: guarda e prefixa nos demais (senão toca silêncio). */
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
    try { this.relayBc?.postMessage({ type: 'distorrent-call-relay', call_id: callId, from_fp: this.myFp, payload }) } catch { /* ignore */ }
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
  /** Agenda chunks com playhead (GAPLESS): buracos de seq pulados, atraso >2s descartado. */
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
        // Áudio relay REAL em reprodução: sem isto a fase nunca sai de 'connecting'.
        this.markRelayAudioLive()
      }
    } catch { /* ignore */ }
  }

  /** Troca a qualidade de vídeo (câmera + tela): applyConstraints + renegocia; falha mantém atual. */
  async setQuality(q: CallQuality): Promise<void> {
    const prev = this.quality
    try {
      const tracks: MediaStreamTrack[] = []
      // TELA tem degrau próprio (screenShare.ts): qualidade da câmera não sobrescreve a da tela.
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
      // Erros de DEVICE vêm antes do estado: explica o "conectado e mudo".
      if (s.speaker_error) return `voz nativa: o alto-falante não abriu (${s.speaker_error}) - o áudio chega mas não sai desta máquina`
      if (s.mic_error && (s.packets_out ?? 0) === 0) return `voz nativa: o microfone não abriu (${s.mic_error}) - este lado está só recebendo`
      if (s.state === 'connected') return `voz nativa conectada via ${s.route} (${io})`
      if (s.state === 'failed') return `voz nativa: rota perdida (${s.route}; ${io}) — NAT/CGNAT sem TURN válido ou peer caiu`
      // connecting/idle: distingue "peer não responde" de "rede sem rota".
      if ((s.packets_out ?? 0) === 0 && (s.packets_in ?? 0) === 0) {
        return `voz nativa negociando (rota ${s.route}): nenhum pacote trocado ainda — outro lado pode não ter atendido ou SDP/ICE não chegou`
      }
      return `voz nativa conectando via ${s.route} (${io}) — ICE ainda sem par final`
    } catch { return 'voz nativa: falha ao inspecionar a mídia do Rust' }
  }

  /** Causa técnica REAL do estado (nunca genérica): checa chamada→WebRTC→mic→ICE→sinalização→rota. */
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

  /** Diagnóstico completo por peer; nunca lança, ausentes viram null ("—"). */
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
          const audioIo = s ? `audio out=${s.packets_out ?? 0} in=${s.packets_in ?? 0} plc=${s.plc_frames ?? 0}` : null
          const videoIo = s ? `vídeo RTP in=${s.video_packets_in ?? 0} frames in=${s.frames_in ?? 0} out=${s.frames_out ?? 0}` : null
          out.push({
            fp: 'nativa (Rust)',
            connectionState: s ? s.state : 'desconhecida',
            iceConnectionState: s ? s.state : 'desconhecida',
            signalingState: 'estável (core)',
            localType: null, remoteType: null,
            selectedPair: s ? `rota ${s.route} • ${audioIo} • ${videoIo}` : null,
            rttMs: s?.rtt_ms ?? null,
            audioBitrateKbps: null, videoBitrateKbps: null,
            resolution: null, fps: null,
            framesReceived: s?.frames_in ?? null,
            framesLost: null,
            packetsLost: s ? Number(s.plc_frames ?? 0) : null,
            packetLossPct: null,
            codec: s?.video_codec ? `Opus + ${s.video_codec}` : 'Opus (nativo)',
            jitterMs: s ? s.jitter_depth_ms : null,
            camera: s?.video_source === 'camera' && s.video_state === 'live' ? 'capturando' : 'n/d (nativa)',
            microphone: s ? ((s.packets_out ?? 0) > 0 ? 'enviando' : 'sem saída ainda') : 'n/d (nativa)',
          })
        } catch { /* ignore */ }
      }
    } catch { /* painel nunca derruba a chamada */ }
    return out
  }

  /** Valida "posso atender?" ANTES de falar com o peer (chamador conectava sozinho). */
  canAccept(callId: string): string | null {
    if (this.accepting.has(callId)) return 'aceitando…'
    if (this.endedCalls.has(callId)) return 'essa chamada já foi encerrada'
    if (this.state && this.state.callId !== callId && isCallPhaseActive(this.state.phase)) {
      return 'já existe uma chamada em andamento — encerre a atual antes de atender outra'
    }
    return null
  }

  async leave() {
    const st = this.state
    if (!st) return
    const cid = st.callId
    // No navegador `callEnd` também ecoa pelo event bus local. Sem esta trava,
    // o eco chamava `leave()` de novo antes do primeiro cleanup terminar.
    if (this.leavingCalls.has(cid)) return
    this.leavingCalls.add(cid)
    try {
      this.applyPhase('hangup')
      this.stopReconnectWatchdog()
      this.clearIceRestartTimers()
      this.stopNativeVoiceMonitor()

      // Emite o fim primeiro e limpa sem esperar o core (limpeza atrasada apagava chamada nova).
      let endSignal: Promise<unknown> = Promise.resolve()
      if (cid.startsWith('voice-')) {
        // CANAL DE VOZ: sem voiceLeave o core nunca fica sabendo (sessão nativa viva + mesh duplicado).
        const ch = st.convId
        const community = ch && cid.endsWith(`-${ch}`)
          ? cid.slice('voice-'.length, cid.length - `-${ch}`.length)
          : ''
        if (community) endSignal = services.voiceLeave(community, ch as string).catch(() => {})
      } else {
        endSignal = services.callEnd(cid).catch(() => {})
      }

      // Rede de segurança: derruba captura nativa que sobreviveu sem voice_leave/call_end (device preso).
      try {
        if ((st as any).nativeMedia) {
          for (const p of st.participants ?? []) {
            if (p.fp && p.fp !== this.myFp) {
              try { void services.voiceVideoStop(cid, p.fp) } catch { /* best-effort */ }
            }
          }
        }
      } catch { /* nunca impede o encerramento */ }
      this.stopCallForeground()
      this.cleanup(cid)
      await endSignal
    } finally {
      this.leavingCalls.delete(cid)
    }
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
      this.acceptedCalls.clear()
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

  /** Zera TODO o estado do compartilhamento (timers/stream) — deixar timer vivo é vazamento. */
  private resetScreenRuntime(): void {
    this.stopScreenStatsTimer()
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch { /* ignore */ }
    this.screenRecoveryTimer = null
    this.screenMonitor.detach()
    this.screenAudioSenders.clear()
    this.screenStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } })
    this.screenStream = null
    // Frames remotos de tela não sobrevivem ao fim/parada do compartilhamento.
    try {
      for (const p of this.state?.participants ?? []) {
        delete (p as any).videoUrl
        ;(p as any).videoSeq = -1
        ;(p as any).sharing = false
      }
    } catch { /* ignore */ }
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
    // Silencia o mic de TODOS os streams (compartilhado E dedicado do relay) — UI "mudo" mentia.
    const seen = new Set<MediaStream>()
    for (const s of [this.localStream, this.relayRecStream]) {
      if (!s || seen.has(s)) continue
      seen.add(s)
      try { s.getAudioTracks().forEach(t => { t.enabled = !muted }) } catch { /* ignore */ }
    }
    // Chamada NATIVA: os tracks do DOM não existem — o mute é no core (Rust).
    // Sem isto o botão de mudo mentia: o outro lado continuava ouvindo tudo.
    if ((this.state as any)?.nativeMedia) {
      services.voiceSetMuted(this.state.callId, muted).catch(() => {})
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
    // Chamada NATIVA: ensurdecer cala o playout no core (Rust).
    if ((this.state as any)?.nativeMedia) {
      services.voiceSetDeafened(this.state.callId, this.state.deafened).catch(() => {})
      if (this.state.deafened) services.voiceSetMuted(this.state.callId, true).catch(() => {})
    }
    this.onUpdate({ ...this.state })
  }

  // ── VÍDEO NATIVO (Linux): câmera/tela codificadas no core Rust ──────────
  // WebKitGTK sem RTCPeerConnection: mídia toda no core; Linux recebe frames JPEG via voiceVideoFrame.

  /** Liga/desliga vídeo nativo (câmera ou tela) para todos os pares da call. */
  private async toggleNativeVideo(source: 'camera' | 'screen'): Promise<void> {
    const st = this.state
    if (!st) return
    const on = source === 'camera' ? !st.cameraOn : !st.sharing
    const targets = st.participants.filter(p => p.fp && p.fp !== this.myFp)
    if (on) {
      // Monitor: id do xcap não é escolhível pela UI ainda — core captura o monitor PRIMÁRIO.
      const monitorId: number | null = null
      let ok = 0
      let lastErr: string | null = null
      for (const p of targets) {
        try {
          await services.voiceVideoStart(st.callId, p.fp, source, monitorId)
          ok++
        } catch (e) {
          lastErr = String((e as Error)?.message ?? e)
        }
      }
      if (ok === 0 && targets.length > 0) {
        this.onCallNotice?.(lastErr ? `vídeo nativo falhou: ${lastErr}` : 'vídeo nativo falhou')
        throw new Error(lastErr ? `não foi possível ligar o vídeo nativo: ${lastErr}` : 'não foi possível ligar o vídeo nativo')
      }
      // Comando aceito ≠ mídia no ar: UI/sinal esperam o primeiro frame (video_state = live).
    } else {
      for (const p of targets) {
        try { await services.voiceVideoStop(st.callId, p.fp) } catch { /* par best-effort */ }
      }
      if (source === 'camera') st.cameraOn = false
      else {
        st.sharing = false
        this.broadcastScreenSignal(false)
      }
    }
    this.onUpdate({ ...st })
  }

  /** Monitor de FRAMES REMOTOS decodificados pelo core (Linux nativo).
   *  A UI desenha p.videoUrl (data:image/jpeg) no tile do participante. */
  private nativeVideoTimer: ReturnType<typeof setInterval> | null = null
  private nativeVideoSeqs = new Map<string, number>()
  private startNativeVideoMonitor(callId: string) {
    this.stopNativeVideoMonitor()
    try {
      this.nativeVideoTimer = setInterval(() => {
        const st = this.state
        if (!st || st.callId !== callId) { this.stopNativeVideoMonitor(); return }
        for (const p of st.participants) {
          if (!p.fp || p.fp === this.myFp) continue
          const since = this.nativeVideoSeqs.get(p.fp) ?? null
          void services.voiceVideoFrame(callId, p.fp, since).then((f) => {
            try {
              const cur = this.state
              if (!f || !cur || cur.callId !== callId) return
              const part = cur.participants.find((x: any) => x.fp === p.fp)
              if (!part) return
              if (f.seq !== (this.nativeVideoSeqs.get(p.fp) ?? -1)) {
                this.nativeVideoSeqs.set(p.fp, f.seq)
                if (f.jpeg) {
                  ;(part as any).videoUrl = `data:image/jpeg;base64,${f.jpeg}`
                  ;(part as any).videoSeq = f.seq
                  this.onUpdate({ ...cur })
                }
              }
            } catch { /* frame nunca derruba o bus */ }
          }).catch(() => { /* poll best-effort */ })
        }
      // Poll de 40ms (~25fps): a UI era o gargalo visual (vídeo do Linux parecia slideshow).
      }, 40)
    } catch { this.nativeVideoTimer = null }
  }
  private stopNativeVideoMonitor() {
    try { if (this.nativeVideoTimer) clearInterval(this.nativeVideoTimer) } catch { /* ignore */ }
    this.nativeVideoTimer = null
    this.nativeVideoSeqs.clear()
  }

  /** Reconcilia o roster com o core a cada 10s: só ADICIONA/atualiza — remoção é só do voice_left. */
  private startRosterReconcile(callId: string, communityId: string, channelId: string) {
    this.stopRosterReconcile()
    const tick = () => {
      const st = this.state
      if (!st || st.callId !== callId) { this.stopRosterReconcile(); return }
      void services.voiceStates(communityId, channelId).then((states) => {
        const cur = this.state
        if (!cur || cur.callId !== callId) return
        let changed = false
        for (const [fp, muted, deafened] of states) {
          if (!fp || fp === this.myFp) continue
          if (addVoiceParticipant(cur.participants, fp)) changed = true
          if (updateVoiceParticipantState(cur.participants, fp, !!muted, !!deafened)) changed = true
        }
        if (changed) this.onUpdate({ ...cur })
      }).catch(() => { /* reconciliação best-effort */ })
    }
    try {
      this.rosterTimer = setInterval(tick, 10_000)
    } catch { this.rosterTimer = null }
    // REPARO DE PAR HALF-OPEN: tick de 15s refaz offer do lado de fp maior em par não conectado.
    try {
      this.repairTimer = setInterval(() => {
        const st = this.state
        if (!st || st.callId !== callId) { this.stopRosterReconcile(); return }
        // Reapresentação periódica: entrega perdida de CallAddParticipant deixava pares sem malha p/ sempre.
        this.announceSelfToRoom(callId)
        void this.repairHalfOpenPairs().catch(() => { /* reparo é best-effort */ })
      }, 15_000)
    } catch { this.repairTimer = null }
  }

  private stopRosterReconcile() {
    try { if (this.rosterTimer) clearInterval(this.rosterTimer) } catch { /* ignore */ }
    this.rosterTimer = null
    try { if (this.repairTimer) clearInterval(this.repairTimer) } catch { /* ignore */ }
    this.repairTimer = null
  }

  /** Acha a m-line de vídeo; se era recvonly, promove a sendrecv + renegocia (replaceTrack não muda direção). */
  private findVideoTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | null {
    try {
      const withTrack = pc.getTransceivers().find(t => t.sender?.track?.kind === 'video')
      if (withTrack) return withTrack
      return pc.getTransceivers().find(t => (t as any)?.receiver?.track?.kind === 'video') ?? null
    } catch { return null }
  }

  /** Acha o sender de vídeo mesmo com track nula (religar câmera sem m-line nova). */
  private findVideoSender(pc: RTCPeerConnection): RTCRtpSender | null {
    try {
      return this.findVideoTransceiver(pc)?.sender
        ?? pc.getSenders().find(s => s.track?.kind === 'video')
        ?? null
    } catch { return null }
  }

  /** `cameraOn` só é verdade quando existe track de vídeo VIVA de verdade. */
  private hasLiveCamera(): boolean {
    try {
      return !!this.localStream?.getVideoTracks().some(t => t.readyState === 'live')
    } catch { return false }
  }

  async toggleCamera() {
    if (!this.state) return
    // Chamada NATIVA (Linux): core captura/codifica; página não tem RTCPeerConnection/getUserMedia.
    if ((this.state as any)?.nativeMedia) {
      await this.toggleNativeVideo('camera')
      return
    }
    // Dois cliques rápidos abriam dois getUserMedia; a track perdedora ficava
    // viva (LED da câmera preso) e o sender oscilava.
    if (this.cameraBusy) return
    this.cameraBusy = true
    try {
      if (this.state.cameraOn) {
        // Desliga: replaceTrack(null) mantém a m-line; exceção — sender carregando TELA não é cortado.
        const mine = this.localStream
        const camTrack = mine?.getVideoTracks()[0] ?? null
        if (mine) {
          if (!this.state.sharing) {
            for (const pc of this.pcs.values()) {
              try {
                const sender = this.findVideoSender(pc)
                if (!sender) continue
                // Só derruba o que é NOSSA câmera (nunca a tela de outro fluxo).
                if (sender.track && camTrack && sender.track.id !== camTrack.id) continue
                await sender.replaceTrack(null)
              } catch { /* peer isolado não derruba os demais */ }
            }
          }
          for (const t of mine.getVideoTracks()) {
            try { t.stop() } catch { /* ignore */ }
            try { mine.removeTrack(t) } catch { /* ignore */ }
          }
        }
        this.state.cameraOn = false
      } else {
        const vs = await getLocalMedia({ video: { ...QUALITY_CONSTRAINTS[this.quality] } })
        const track = vs?.getVideoTracks()[0]
        if (!track) {
          // getLocalMedia já avisou o motivo via onCallNotice; não inventa
          // câmera ligada sem imagem.
          this.state.cameraOn = false
          return
        }
        if (!this.localStream) {
          try { this.localStream = new MediaStream([track]) }
          catch { this.localStream = null }
        } else {
          try { this.localStream.addTrack(track) } catch { /* ignore */ }
        }
        if (!this.localStream) return
        // Por peer: m-line existente → replaceTrack (+ renegociação se era
        // recvonly); sem m-line → addTrack + offer.
        let sent = 0
        let lastErr: unknown = null
        for (const [fp, pc] of this.pcs) {
          try {
            if (pc.signalingState === 'closed') continue
            const tr = this.findVideoTransceiver(pc)
            let needsOffer = false
            if (tr) {
              needsOffer = setCallVideoSending(tr, true)
              await tr.sender.replaceTrack(track)
            } else {
              pc.addTrack(track, this.localStream)
              needsOffer = true
            }
            if (needsOffer && pc.signalingState === 'stable') {
              const offer = await createTunedOffer(pc)
              await pc.setLocalDescription(offer)
              if (this.state) await services.callOffer(fp, this.state.callId, JSON.stringify(offer))
            }
            sent++
          } catch (e) {
            lastErr = e
          }
        }
        if (this.pcs.size > 0 && sent === 0) {
          // Nenhum peer aceitou: não finge câmera ligada.
          try { track.stop() } catch { /* ignore */ }
          try { this.localStream?.removeTrack(track) } catch { /* ignore */ }
          this.state.cameraOn = false
          try {
            this.onCallNotice?.(`não foi possível enviar a câmera${lastErr ? `: ${(lastErr as Error)?.message ?? lastErr}` : ''}`)
          } catch { /* ignore */ }
        } else {
          this.state.cameraOn = true
        }
      }
    } catch (e) {
      // Antes era `catch {}`: permissão negada não produzia NENHUMA mensagem e
      // o botão só "não mudava".
      try { localMediaNotice?.(describeMediaError(e) ?? `falha ao abrir a câmera (${(e as Error)?.name ?? 'erro'})`) } catch { /* ignore */ }
    } finally {
      this.cameraBusy = false
    }
    this.onUpdate({ ...this.state })
  }

  /** Transmissão estilo Discord (desktop): getDisplayMedia + renegociação por peer; mobile honesto. */
  /** Última linha de texto do doc da função (substituído abaixo). */
  async toggleScreen(): Promise<void> {
    if (this.state?.sharing) {
      await this.stopScreenShare()
      return
    }
    await this.startScreenShare()
  }

  /** Screen share P2P: captura local → encode nativo → WebRTC direto; tela/janela/monitor + áudio separado. */
  async startScreenShare(opts?: Partial<ScreenShareOptions>): Promise<void> {
    if (!this.state) return
    // Caminho NATIVO (Linux): xcap + GStreamer no core (antes caía no guard de pcs.size === 0 — mentira).
    if ((this.state as any)?.nativeMedia) {
      const next = normalizeOptions(opts, this.screenOptions)
      if (next.source === 'window' || next.source === 'monitor') {
        // Core só captura a tela INTEIRA: aceitar 'window' vazava o desktop completo.
        const msg = 'no caminho nativo a captura é sempre da tela inteira — janela ou monitor específico não é suportado'
        this.setScreenError('unsupported', msg)
        throw new ScreenShareError('unsupported', msg, false)
      }
      const wantsSystem = next.audio === 'system' || next.audio === 'system+mic'
      if (wantsSystem) {
        try { this.onCallNotice?.('o caminho nativo não captura áudio do sistema — compartilhando só a tela (o microfone da chamada continua ativo)') } catch { /* ignore */ }
      }
      this.screenOptions = { ...next, source: 'screen', audio: wantsSystem ? (next.audio === 'system+mic' ? 'mic' : 'none') : next.audio }
      await this.toggleNativeVideo('screen')
      return
    }
    this.screenEnv = detectScreenEnvironment(getScreenShareBackend() === 'native')
    if (!supportsScreenShare()) {
      const reason = screenShareUnavailableReason()
      this.setScreenError('unsupported', reason ?? SCREEN_UNAVAILABLE_MSG)
      throw new ScreenShareError('unsupported', reason ?? SCREEN_UNAVAILABLE_MSG, false)
    }
    // Voz nativa não cria PC — roteado acima p/ toggleNativeVideo; sem PCs não é erro (semeia depois).
    if (this.pcs.size === 0) {
      this.onCallNotice?.('preparando a tela — ela começa a ser enviada quando a chamada conectar')
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
    try {
      // O áudio é coletado ANTES de semear: assim ele entra na mesma oferta
      // do vídeo (antes ficava para depois e nunca era enviado).
      const audioTracks = await this.collectScreenAudioTracks(stream)
      await this.seedScreenPeers(stream, track, audioTracks)
    } catch (e) {
      // Não deixa captura local aberta nem UI dizendo "compartilhando" quando
      // nenhum peer aceitou a oferta; restaura a câmera antes de informar falha.
      this.stopScreenStatsTimer()
      try { await this.clearScreenAudioSenders() } catch { /* limpeza best-effort */ }
      this.stopScreenStreamOnly()
      this.screenMonitor.detach()
      this.screenLastSize = ''
      this.state.sharing = false
      try { await this.restoreCameraAfterScreen() } catch { /* falha original é a mais útil */ }
      const cameraOn = !!this.localStream?.getVideoTracks().some(cam => cam.readyState === 'live' && cam.enabled)
      this.broadcastScreenSignal(false, cameraOn)
      this.onUpdate({ ...this.state })
      const err = e instanceof ScreenShareError
        ? e
        : new ScreenShareError('unknown', String((e as Error)?.message ?? e), true, e)
      this.setScreenError(err.code, err.message)
      throw err
    }
    this.startScreenStatsTimer()
    this.broadcastScreenSignal(true, false)
    this.onUpdate({ ...this.state })
  }

  /** Pede a captura ao engine com as constraints de fonte/áudio corretas. */
  private async acquireScreenStream(opts: ScreenShareOptions): Promise<MediaStream> {
    const md: any = (typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : null)
    if (!md?.getDisplayMedia) throw new ScreenShareError('unsupported', SCREEN_UNAVAILABLE_MSG, false)
    const constraints = buildDisplayMediaConstraints(opts, this.screenEnv)
    try {
      return await md.getDisplayMedia(constraints) as MediaStream
    } catch (e) {
      // Chromium recusa min/displaySurface em getDisplayMedia: degrada (sem frameRate → {video,audio}).
      const derived = derivedDisplayConstraints(constraints)
      if (!derived) throw e
      try {
        return await md.getDisplayMedia(derived) as MediaStream
      } catch {
        const minimal = { video: true, audio: !!constraints.audio }
        return await md.getDisplayMedia(minimal) as MediaStream
      }
    }
  }

  /** Reage a fim/mute da track de tela: mute é NORMAL (troca de monitor), ended é fim real. */
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

  /** Semeia a track em todo o mesh e negocia envio quando o m-line era recvonly. */
  private async seedScreenPeers(stream: MediaStream, track: MediaStreamTrack, audioTracks: MediaStreamTrack[] = []): Promise<void> {
    const failures: string[] = []
    let peersSeeded = 0
    for (const [fp, pc] of this.pcs) {
      try {
        if (pc.signalingState === 'closed') continue
        const transceiver = this.findVideoTransceiver(pc)
        let needsOffer = false
        if (transceiver) {
          // O transceiver criado para chamadas de voz é recvonly. Apenas
          // substituir sua track não muda o SDP e fazia a tela ficar local.
          needsOffer = setCallVideoSending(transceiver, true)
          await transceiver.sender.replaceTrack(track)
        } else {
          pc.addTrack(track, stream)
          needsOffer = true
        }
        // Áudio entra no MESMO offer do vídeo: depois de have-local-offer o addTrack era pulado (som mudo).
        for (const atrack of audioTracks) {
          try {
            if (pc.getSenders().some(x => x.track === atrack)) continue
            const reusable = this.screenAudioSenders.get(pc)
            if (reusable && pc.getSenders().includes(reusable)) {
              await reusable.replaceTrack(atrack)
              continue
            }
            const audioSender = pc.addTrack(atrack, stream)
            this.screenAudioSenders.set(pc, audioSender)
            needsOffer = true
          } catch { /* áudio é opcional: o vídeo continua */ }
        }
        if (needsOffer) {
          if (pc.signalingState !== 'stable' || !this.state) {
            throw new Error('negociação ocupada; não foi possível enviar a nova track agora')
          }
          const offer = await createTunedOffer(pc)
          await pc.setLocalDescription(offer)
          await services.callOffer(fp, this.state.callId, JSON.stringify(offer))
        }
        peersSeeded++
      } catch (e) {
        failures.push(`${fp.slice(0, 6)}: ${String((e as Error)?.message ?? e)}`)
      }
    }
    if (failures.length) {
      const notice = `não foi possível negociar a tela com ${failures.join('; ')}`
      try { this.onCallNotice?.(notice) } catch { /* o aviso não derruba a chamada */ }
      // Se todos os peers falharam, propaga para o fluxo desfazer a captura em
      // vez de manter o estado local de compartilhamento como sucesso falso.
      if (this.pcs.size > 0 && peersSeeded === 0) {
        throw new ScreenShareError('unknown', notice, true)
      }
    }
    await this.applyScreenSenderTuning()
  }

  /** Áudio do share nos 4 modos: sistema e mic são TRILHAS SEPARADAS — falta de um nunca derruba o outro. */
  private async collectScreenAudioTracks(stream: MediaStream): Promise<MediaStreamTrack[]> {
    const mode = this.screenOptions.audio
    const out: MediaStreamTrack[] = []
    if (mode === 'system' || mode === 'system+mic') {
      const atrack = stream.getAudioTracks()[0]
      if (!atrack) {
        this.noteScreenEvent('áudio do sistema indisponível nesta fonte — o vídeo continua normalmente')
      } else {
        out.push(atrack)
      }
    }
    if (mode === 'mic' || mode === 'system+mic') {
      const live = this.localStream?.getAudioTracks().find(t => t.readyState === 'live') ?? null
      if (live) {
        // O mic da chamada já vai pelo sender de voz; reenviar a mesma trilha
        // duplicaria a voz do usuário (eco/comb-filter).
      } else {
        const captured = await this.captureShareMicrophone()
        if (captured) out.push(captured)
        else this.noteScreenEvent('microfone indisponível — compartilhando sem a sua voz')
      }
    }
    return out
  }

  /** Captura um mic quando a chamada não tem um vivo e o guarda em localStream. */
  private async captureShareMicrophone(): Promise<MediaStreamTrack | null> {
    let captured: MediaStream | null
    try {
      captured = await getLocalMedia({ audio: { ...AUDIO_CONSTRAINTS }, video: false })
    } catch { return null }
    const track = captured?.getAudioTracks()[0] ?? null
    if (!track) return null
    try {
      if (this.localStream) this.localStream.addTrack(track)
      else this.localStream = captured
    } catch { /* segue: o que importa é enviar o áudio */ }
    return track
  }

  /** Zera o áudio da tela nos senders reusáveis, sem fechar a m-line. */
  private async clearScreenAudioSenders(): Promise<void> {
    for (const [pc, sender] of this.screenAudioSenders) {
      try {
        if (pc.signalingState !== 'closed' && pc.getSenders().includes(sender)) await sender.replaceTrack(null)
      } catch { /* peer já fechado: nada a limpar */ }
    }
    this.screenAudioSenders.clear()
  }

  /** Para o compartilhamento e devolve a câmera (ou null) aos remotos. */
  async stopScreenShare(): Promise<void> {
    if (!this.state) return
    // NATIVO: para o encoder no core (sem isto o xcap/GStreamer continuava
    // capturando e codificando uma tela que ninguém assiste).
    if ((this.state as any)?.nativeMedia) {
      await this.toggleNativeVideo('screen') // sharing=true → desliga
      return
    }
    this.stopScreenStatsTimer()
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch { /* ignore */ }
    this.screenRecoveryTimer = null
    await this.clearScreenAudioSenders()
    this.stopScreenStreamOnly()
    this.screenMonitor.detach()
    this.screenLastSize = ''
    this.screenMetrics = emptyScreenMetrics()
    this.state.sharing = false
    await this.restoreCameraAfterScreen()
    const cameraOn = !!this.localStream?.getVideoTracks().some(track => track.readyState === 'live' && track.enabled)
    this.broadcastScreenSignal(false, cameraOn)
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
    for (const [fp, pc] of this.pcs) {
      try {
        if (pc.signalingState === 'closed') continue
        const transceiver = this.findVideoTransceiver(pc)
        let needsOffer = false
        if (transceiver) {
          needsOffer = setCallVideoSending(transceiver, !!cam)
          await transceiver.sender.replaceTrack(cam)
        } else if (cam && this.localStream) {
          pc.addTrack(cam, this.localStream)
          needsOffer = true
        }
        if (needsOffer && pc.signalingState === 'stable' && this.state) {
          const offer = await createTunedOffer(pc).catch(() => null)
          if (offer) {
            await pc.setLocalDescription(offer).catch(() => {})
            await services.callOffer(fp, this.state.callId, JSON.stringify(offer)).catch(() => {})
          }
        }
      } catch { /* peer isolado não derruba os demais */ }
    }
  }

  /** Aplica opções sem derrubar a captura (track viva + encoder); fonte/áudio exigem recaptura. */
  async setScreenShareOptions(patch: Partial<ScreenShareOptions>): Promise<void> {
    const prev = this.screenOptions
    const next = normalizeOptions(patch, this.screenOptions)
    this.screenOptions = next
    this.screenEnv = detectScreenEnvironment(getScreenShareBackend() === 'native')
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
      // Captura a NOVA fonte ANTES de tocar na atual: cancelar o seletor não derruba o share no ar.
      const stream = await this.acquireScreenStream(opts)
      const track = stream.getVideoTracks()[0]
      if (!track) {
        try { stream.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
        throw new ScreenShareError('no-source', 'nenhuma trilha de vídeo na tela compartilhada', true)
      }
      this.stopScreenStatsTimer()
      await this.clearScreenAudioSenders()
      this.stopScreenStreamOnly()
      this.screenMonitor.detach()
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
      // NÃO marca sharing=false: a captura anterior (se havia) segue no ar.
      if (this.state && !wasSharing) {
        this.state.sharing = false
        this.broadcastScreenSignal(false)
        this.onUpdate({ ...this.state })
      }
      throw err
    }
  }

  /** Recuperação automática: resolução/monitor/encoder/rede — nenhum caso exige sair da chamada. */
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

  /** Degradação honesta: só desce degrau com perda/jitter/FPS real abaixo do capturado; FPS nunca inventado. */
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
    this.screenEnv = detectScreenEnvironment(getScreenShareBackend() === 'native')
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

  /** Grupo (mesh): adiciona peer — PC iniciador + ring nele + aviso aos demais (sem kind → anti-glare). */
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

  /** Pede que a sala se apresente p/ a malha fechar: o NOVO precisa saber dos antigos (idempotente). */
  private announceSelfToRoom(callId: string) {
    const st = this.state
    if (!st || st.callId !== callId || !this.myFp) return
    const outros = st.participants
      .map(p => p.fp)
      .filter(fp => !!fp && fp !== this.myFp)
    if (outros.length === 0) return
    for (const porta of outros) {
      // Peço a `porta` que anuncie, para MIM, todos os outros que ela conhece.
      for (const fp of outros) {
        if (fp === porta) continue
        services.callAddParticipant(porta, callId, fp, '').catch(() => {})
      }
      // E abro a mídia com quem eu já conheço (o outro lado responde).
      if (!this.pcs.has(porta)) {
        void this.createPC(porta, callId, true).catch(() => { /* par best-effort */ })
      }
    }
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

  /** Garante m-lines a/v mesmo sem track: max-bundle sem BUNDLE group matava a offer (recvonly cobre). */
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
      // Mídia remota CHEGOU: promove a fase se ICE já conectou (race offer→track→accept).
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
        // Fim do gathering: reenvia a lista COMPLETA de candidatos (perdidos no caminho chegam agora).
        this.resendLocalIce(fp, pc, callId)
        return
      }
      this.sendLocalIce(fp, callId, e.candidate, pc)
    }
    // ICE restart best-effort quando 'failed' (logIceState já emite o evento de UI).
    try {
      pc.addEventListener('iceconnectionstatechange', () => {
        try {
          if (pc.iceConnectionState === 'failed') void this.tryIceRestart(fp, pc, callId)
          // Promove p/ conectado por aqui também (bind pode ainda não ter assinado / evento perdido).
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            try {
              const st = this.state
              if (st && st.callId === callId) this.applyPhase('media-connected')
            } catch { /* ignore */ }
          }
        } catch { /* monitor nunca derruba a chamada */ }
      })
    } catch { /* ignore */ }
    // connectionState (PC) é mais confiável que iceConnectionState em alguns WebViews móveis.
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
  private sendLocalIce(fp: string, callId: string, cand: RTCIceCandidate, pc: RTCPeerConnection) {
    try {
      // close() não cancela callbacks de ICE enfileirados: confere chamada e instância.
      if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
      const list = this.localIce.get(fp) ?? []
      list.push(cand)
      this.localIce.set(fp, list)
      void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
    } catch { /* monitor nunca derruba a chamada */ }
  }

  /** Reenvia TODOS os candidatos locais: frame único pode se perder (TURN é o último e o mais crítico). */
  private resendLocalIce(fp: string, pc: RTCPeerConnection, callId: string) {
    try {
      if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
      for (const cand of this.localIce.get(fp) ?? []) {
        void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
      }
      // Candidatos pré-coletados (iceCandidatePoolSize): manda também; getLocalCandidates não está no lib.dom.
      const anyPc = pc as unknown as { getLocalCandidates?: () => Promise<RTCIceCandidate[]> }
      void anyPc.getLocalCandidates?.().then((rest: RTCIceCandidate[] | null | undefined) => {
        if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
        for (const cand of rest ?? []) {
          void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
        }
      }).catch(() => {})
    } catch { /* melhor esforço */ }
  }

  /**
  /** Monitor da chamada NATIVA: sem ele a fase ficava presa em "Conectando…" (ninguém emite media-connected). */
  private startNativeVoiceMonitor(callId: string) {
    this.stopNativeVoiceMonitor()
    // -1 = "ainda não conectou". NUNCA 0: Date.now()-0 virava timeout instantâneo ao trocar de rede.
    this.nativeVoiceSince = -1
    // Vídeo remoto (frames JPEG do core) na MESMA vida do monitor de voz.
    this.startNativeVideoMonitor(callId)
    const t = setInterval(() => {
      const st = this.state
      if (!st || st.callId !== callId) { this.stopNativeVoiceMonitor(); return }
      // Só espera timeout com mídia pendente; BUG CORRIGIDO: nativeVoiceSince nunca era setado (waited sempre 0).
      if (this.nativeVoiceSince < 0) this.nativeVoiceSince = Date.now()
      const waited = this.nativeVoiceSince > 0 ? Date.now() - this.nativeVoiceSince : 0
      void services.voiceMediaStats(callId).then((s) => {
        if (!this.state || this.state.callId !== callId) return
        // CRÍTICO: timeout vale TAMBÉM sem sessão no core (stats null) — senão "Conectando…" eterno.
        if (!s) {
          if (waited > CallManager.NATIVE_VOICE_TIMEOUT_MS) {
            this.nativeVoiceSince = -1
            this.setFailureCause(
              `sem rota de midia nativa em ${Math.round(CallManager.NATIVE_VOICE_TIMEOUT_MS / 1000)}s — a oferta nao virou sessao (SDP recusado ou offer perdida)`,
            )
            this.onCallNotice?.('sem rota de midia nativa — a chamada nao conseguiu negociar')
            this.applyPhase('reconnect-timeout')
            this.leave()
          }
          return
        }
        try { this.lastNativeStats = s } catch { /* ignore */ }
        if (nativeRoute !== s.route) { nativeRoute = s.route; this.onUpdate({ ...this.state }) }
        // VÍDEO NATIVO: estado honesto do core ("live" = no ar; "failed" = aviso com o erro real).
        try {
          const vs = (s as any).video_state as string | null | undefined
          const vsrc = (s as any).video_source as string | null | undefined
          const verr = (s as any).video_error as string | null | undefined
          const cur = this.state
          if (cur && vs) {
            if (vs === 'live') {
              if (vsrc === 'camera' && !cur.cameraOn) { cur.cameraOn = true; this.onUpdate({ ...cur }) }
              if (vsrc === 'screen' && !cur.sharing) {
                cur.sharing = true
                this.broadcastScreenSignal(true)
                this.onUpdate({ ...cur })
              }
            } else if (vs === 'starting') {
              // Mantém os controles desligados até o core escrever o primeiro
              // frame codificado no sender; pipeline aberto não prova mídia.
            } else if (vs === 'failed') {
              if (verr) { this.onCallNotice?.(verr); this.setFailureCause(verr) }
              if (vsrc === 'camera') { cur.cameraOn = false; this.onUpdate({ ...cur }) }
              if (vsrc === 'screen' && cur.sharing) {
                cur.sharing = false
                this.broadcastScreenSignal(false)
                this.onUpdate({ ...cur })
              }
            } else if (vs === 'off') {
              if (vsrc === 'camera' && cur.cameraOn) { cur.cameraOn = false; this.onUpdate({ ...cur }) }
              if (vsrc === 'screen' && cur.sharing) {
                cur.sharing = false
                this.broadcastScreenSignal(false)
                this.onUpdate({ ...cur })
              }
            }
          }
        } catch { /* estado de vídeo nunca derruba a chamada */ }
        if (s.state === 'connected') {
          this.nativeVoiceSince = -1
          this.applyPhase('media-connected')
        } else if (this.nativeCallIsDead(s, waited)) {
          // ICE que nunca fecha (CGNAT simétrico): sem este timeout, "Conectando…" indefinido no caminho nativo.
          // BUG CORRIGIDO ("cai sozinho"): agregado do core é o PIOR par — um peer failed não derruba a chamada.
          this.nativeVoiceSince = -1
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
        } else if (s.state === 'failed' || s.state === 'connecting' || s.state === 'reconnecting') {
          // Um par com problema num mesh: avisa (diagnóstico honesto) mas NÃO
          // sai do canal. Antes da correção este era o caminho do `leave()`.
          this.setFailureCause(
            `um participante sem rota de mídia (${s.route}; ${s.peers_connected ?? '?'}/${s.peers_total ?? '?'} conectados)`,
          )
        }
      }).catch(() => { /* poll best-effort */ })
    }, 700)
    this.nativeVoiceTimer = t
  }

  private stopNativeVoiceMonitor() {
    if (this.nativeVoiceTimer) { clearInterval(this.nativeVoiceTimer); this.nativeVoiceTimer = null }
    this.stopNativeVideoMonitor()
  }

  /** Nativa morta só quando NENHUM par conecta (agregado do core é o pior par). */
  private nativeCallIsDead(
    s: { state?: string | null; peers_connected?: number | null; peers_total?: number | null },
    waited: number,
  ): boolean {
    const connected = typeof s.peers_connected === 'number' ? s.peers_connected : null
    // Mídia comprovadamente fluindo: a chamada está viva, ponto.
    if (connected !== null && connected > 0) return false
    if (s.state === 'failed') return true
    return waited > CallManager.NATIVE_VOICE_TIMEOUT_MS
  }

  /** ICE restart com BACKOFF (1s/4s/9s, até MAX_ICE_RESTARTS); force pula guard de 'failed' (CGNAT). */
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

  /** Cria/renegocia PC de UM par; PC já conectado NÃO é fechado (bug "um escuta, o outro não"). */
  private async createPC(fp: string, callId: string, initiator: boolean) {
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    // Medidor: registra os iceServers efetivos (o que foi tentado de verdade).
    try { this.iceServersUsed = getIceServers() } catch { this.iceServersUsed = null }
    const anterior = this.pcs.get(fp)
    // Sessão VIVA e saudável: não recriar. Fechar e refazer aqui derrubava
    // justamente o par que já estava ouvindo (o "um escuta, o outro não").
    if (anterior) {
      const st = anterior.connectionState
      if (st === 'connected') {
        return
      }
      try { anterior.close() } catch { /* já fechado */ }
    }
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

  /** Re-par half-open: lado de fp MAIOR refaz a offer (mesma regra do voice_joined); par conectado intocado. */
  private async repairHalfOpenPairs(): Promise<void> {
    const st = this.state
    if (!st || !isCallPhaseActive(st.phase) || !this.myFp) return
    for (const p of st.participants) {
      const fp = p.fp
      if (!fp || fp === this.myFp) continue
      const pc = this.pcs.get(fp)
      const cs = pc?.connectionState
      // RTCPeerConnection.connectionState n�o tem 'completed' (isso � do
      // iceConnectionState): s� 'connected' significa m�dia fluindo.
      if (cs === 'connected') continue
      // Só o lado MAIOR inicia (o menor espera a offer).
      if (!(this.myFp > fp)) continue
      // Um ICE restart é mais barato que um PC novo e resolve o caso half-open.
      if (pc && cs === 'failed') {
        try {
          const offer = await createTunedOffer(pc, { iceRestart: true })
          await pc.setLocalDescription(offer)
          await services.callOffer(fp, st.callId, JSON.stringify(offer)).catch(() => {})
          this.setFailureCause(`reparando rota com ${fp.slice(0, 8)}…`)
          continue
        } catch { /* cai para recriar abaixo */ }
      }
      if (!pc || cs === 'failed' || cs === 'closed') {
        void this.createPC(fp, st.callId, true).catch(() => { /* par best-effort */ })
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
    if (this.endedCalls.has(callId)) return
    const offer = parseWireSdp(sdpStr, 'offer')
    if (!offer) return
    if (!this.state || this.state.callId !== callId) {
      const me = this.getIdentity()
      if (!me) return
      if (!this.myFp) this.myFp = me.fingerprint
      // NATIVA: a offer pré-aceite foi retida no ENGINE (voice_gate) — aqui
      // não há o que guardar. Só o caminho navegador bufferiza.
      if (nativeVoiceAvailable !== true) {
        this.pendingOffers.set(fromFp, { callId, sdp: sdpStr })
      }
      return
    }
    // RING EM ANDAMENTO: offer chega antes do Aceitar — retém (critério = registro de aceite, não fase).
    if (!this.acceptedCalls.has(callId)) {
      if (nativeVoiceAvailable !== true) {
        this.pendingOffers.set(fromFp, { callId, sdp: sdpStr })
        console.debug(`[call] offer de ${fromFp.slice(0, 8)} retida até o aceite (ring em andamento)`)
      }
      return
    }
    this.markJoined(fromFp) // peer mandou offer = está entrando na chamada

    let pc = this.pcs.get(fromFp)
    // PC morto (peer caiu e voltou): fecha e RE-CRIA antes de aplicar a offer —
    // senão setRemoteDescription lança em PC fechado e a reconexão nunca cola.
    if (pc && (pc.connectionState === 'closed' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed')) {
      try { pc.close() } catch { /* ignore */ }
      this.pcs.delete(fromFp)
      this.localIce.delete(fromFp)
      // pendingIce da geração ANTERIOR (ufrag antigo): descarta, senão candidatos são rejeitados em silêncio.
      this.pendingIce.delete(fromFp)
      pc = undefined
    }
    if (!pc) {
      if (!supportsCalls()) { console.debug('[call] oferta ignorada: WebRTC indisponível neste aparelho'); return }
      // RTCPeerConnection pode não existir (WebKitGTK): sem try/catch a
      // exceção subia no bus de eventos e matava os handlers seguintes.
      try {
        pc = newPeerConnection()
      } catch (e) {
        console.warn(`[call] RTCPeerConnection indisponível para offer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
        return
      }
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
      // Renegociação pode terminar após a chamada já ter mudado: confere ID e instância do PC.
      if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
      this.lastRemoteOffer.set(fromFp, sdpStr)
      // candidatos do ofertante podem ter chegado antes desta offer (relay)
      await this.flushPendingIce(fromFp, pc, callId)
      const answer = await createTunedAnswer(pc)
      await pc.setLocalDescription(answer)
      if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
      await services.callAnswer(fromFp, callId, JSON.stringify(answer)).catch(() => {})
    } catch (e) {
      // Log honesto de falha de sinalização (antes era silêncio total — "às vezes não pega").
      console.warn(`[call] falha ao responder offer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
    }
  }

  private async handleAnswer(fromFp: string, callId: string, sdpStr: string) {
    // ICE/SDP atrasados da chamada anterior não podem usar o PC novo do mesmo
    // peer. O mapa é por fingerprint, então o call_id também precisa bater.
    if (!fromFp || fromFp === this.myFp || this.state?.callId !== callId) return
    const pc = this.pcs.get(fromFp)
    if (!pc) return
    const ans = parseWireSdp(sdpStr, 'answer')
    if (!ans) return
    this.markJoined(fromFp) // respondeu = entrou na chamada
    try {
      // answer só vale se ainda temos offer local pendente (anti-GLARE/rollback).
      if (pc.signalingState !== 'have-local-offer') return
      await pc.setRemoteDescription(ans as RTCSessionDescriptionInit)
      if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
      // descrição remota pronta → candidatos ICE que chegaram cedo podem entrar
      await this.flushPendingIce(fromFp, pc, callId)
    } catch (e) {
      // Idem handleOffer: sinalização que falha em silêncio é indistinguível
      // de "peer nunca respondeu" no log.
      console.warn(`[call] falha ao aplicar answer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
    }
  }

  private async handleIce(fromFp: string, callId: string, candidateStr: string, mid: string) {
    // Callbacks de chamada encerrada não contaminam a seguinte (fila por call_id).
    if (!fromFp || fromFp === this.myFp || this.endedCalls.has(callId)) return
    if (this.state && this.state.callId !== callId) return
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
    // O mid do frame separa o candidato cru do Rust — sem ele, m-lines diferentes caíam na primeira.
    const cand = parseWireCandidate(candidateStr, mid)
    if (!cand) return
    // Sem PC ou sem remoteDescription: GUARDA (não descarta). O flush acontece
    // quando a offer/answer for aplicada — trickle ICE sobre relay chega antes.
    if (!pc || !pc.remoteDescription) {
      let byCall = this.pendingIce.get(fromFp)
      if (!byCall) {
        byCall = new Map()
        this.pendingIce.set(fromFp, byCall)
      }
      let q = byCall.get(callId)
      if (!q) {
        q = []
        byCall.set(callId, q)
        // Callbacks atrasados nunca devem transformar o buffer de ICE em
        // armazenamento sem limite quando não há sessão ativa.
        while (byCall.size > 4) {
          const oldest = byCall.keys().next().value
          if (!oldest) break
          byCall.delete(oldest)
        }
      }
      // cap defensivo (peer malicioso/rajada): mantém os mais recentes
      if (q.length >= 256) q.shift()
      q.push(cand)
      return
    }
    if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
    try {
      await pc.addIceCandidate(cand)
    } catch (e) {
      // Log curto de candidato recusado (antes sumia sem rastro; diagnóstico provava formato/mid errado).
      console.debug(
        `[call] candidato ICE recusado (${cand.sdpMid ?? cand.sdpMLineIndex ?? '?'}): ${(e as Error)?.message ?? e}`,
      )
    }
  }

  /** Despeja (em ordem) os candidatos ICE guardados antes da remoteDescription. */
  private async flushPendingIce(fp: string, pc: RTCPeerConnection, callId: string) {
    const byCall = this.pendingIce.get(fp)
    const q = byCall?.get(callId)
    if (!q || q.length === 0) return
    byCall?.delete(callId)
    if (byCall?.size === 0) this.pendingIce.delete(fp)
    for (const cand of q) {
      if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
      try { await pc.addIceCandidate(cand) } catch { /* candidato individual inválido: segue os demais */ }
    }
  }

  /** Inicia o foreground service de chamada no Android (mantém mic/camera em background).
   *  Best-effort: falha silenciosa em outras plataformas ou se o plugin não existir. */
  private startCallForeground() {
    if (!isAndroidRuntime()) return
    try {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        // Android 13+: POST_NOTIFICATIONS é exigida p/ o FGS mostrar notificação (pede no momento da chamada).
        void services.notificationPermission().then((state) => {
          if (state === 'prompt') void services.notificationRequestPermission().catch(() => {})
        }).catch(() => {})
        invoke('plugin:callfg|start').catch((e) => {
          // FGS que não sobe (Android 14) cortava o mic ao minimizar SEM aviso — log honesto.
          this.onCallNotice?.(
            'não consegui manter a chamada em segundo plano — o microfone pode ser cortado ao minimizar',
          )
          void e
        })
      }).catch(() => { /* sem Tauri: browser, ignora */ })
    } catch { /* ignore */ }
  }

  /** Para o foreground service de chamada no Android. */
  private stopCallForeground() {
    if (!isAndroidRuntime()) return
    try {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('plugin:callfg|stop').catch(() => { /* ignore */ })
      }).catch(() => { /* ignore */ })
    } catch { /* ignore */ }
  }

  private cleanup(expectedCallId?: string) {
    // Protege uma chamada nova de uma limpeza antiga que terminou atrasada.
    if (expectedCallId && this.state?.callId !== expectedCallId) return
    this.stopCallForeground()
    // O roster é da chamada que está terminando: sem parar o timer, ele
    // continuaria consultando um canal do qual já saímos.
    this.stopRosterReconcile()
    // Captura NATIVA antes de tudo: encoder aberto segura o device até reiniciar o app ("device busy").
    try {
      const st = this.state
      if ((st as any)?.nativeMedia) {
        for (const p of st?.participants ?? []) {
          if (p.fp && p.fp !== this.myFp) {
            try { if (st) void services.voiceVideoStop(st.callId, p.fp) } catch { /* best-effort */ }
          }
        }
      }
    } catch { /* nunca impede o encerramento */ }
    this.stopQualityMonitor()
    this.stopReconnectWatchdog()
    this.stopConnectWatchdog()
    this.stopOutgoingWatchdog()
    this.stopIncomingWatchdog()
    this.stopNativeVoiceMonitor()
    this.clearIceRestartTimers()
    try { this.lastStats.clear() } catch { /* ignore */ }
    try { this.lastNativeStats = null } catch { /* ignore */ }
    // Mantém lastFailureCause p/ toast pós-fim; timer do grace relay cancelado antes do stopRelayFull.
    this.clearRelayFallbackTimer()
    try { this.stopRelayFull() } catch { /* ignore */ }
    this.badWindows = 0
    this.prevLost.clear()
    this.pendingIce.clear()
    this.localIce.clear()
    this.pendingOffers.clear()
    this.acceptedCalls.clear()
    this.lastRemoteOffer.clear()
    this.iceReports.clear()
    this.iceRestarts.clear()
    this.qualityNotice = null
    this.pcs.forEach(pc => { try { pc.close() } catch { /* ignore */ } })
    this.pcs.clear()
    this.localStream?.getTracks().forEach(t => { try { t.stop() } catch { /* ignore */ } })
    this.resetScreenRuntime()
    this.localStream = null
    // Guarda o callId encerrado para `canAccept` barar aceite tardio. Com teto:
    // uma sessão longa não deveria acumular milhares de ids.
    if (this.state) {
      this.endedCalls.add(this.state.callId)
      if (this.endedCalls.size > 64) {
        const maisAntigo = this.endedCalls.values().next().value
        if (maisAntigo) this.endedCalls.delete(maisAntigo)
      }
    }
    this.state = null
    // `nativeRoute` e' global de MODULO: sem zerar, uma chamada nativa seguida
    // de uma pelo navegador mostrava a rota da chamada anterior para sempre.
    nativeRoute = null
    this.onUpdate(null as any)
  }
}

// Detecta a voz nativa uma vez no boot, fire-and-forget (não trava nem rejeita).
void detectNativeVoice()

export const callManager = new CallManager(() => {
  // 1) identidade injetada pelos shells (fonte da verdade — state React)
  if (cachedCallIdentity) return cachedCallIdentity
  // 2) fallback legado (nunca gravado pelo app — mantido por compat)
  try {
    const raw = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('distorrent:identity') : null)
      ?? localStorage.getItem('distorrent:identity') ?? localStorage.getItem('identity') ?? ''
    if (!raw) return null
    const j = JSON.parse(raw)
    return { fingerprint: j.fingerprint ?? 'local', nickname: j.nickname ?? 'você' }
  } catch { return null }
})

let cachedCallIdentity: { fingerprint: string; nickname: string } | null = null
/** Shells chamam ao carregar/trocar/limpar identidade — sem isso chamadas falham com "sem identidade". */
export function setCallIdentity(id: { fingerprint: string; nickname: string } | null) {
  cachedCallIdentity = id
  // Identidade nova = engine novo: re-pergunta a voz nativa em vez de confiar no cache do boot.
  void detectNativeVoice(true)
}
