import { services } from './index'
import { isAndroidRuntime } from './screenShare'
import { isWindowsRuntime, isIOSRuntime } from '../shared/runtime'
import { setCallVideoSending } from './callMedia'
import { addVoiceParticipant, removeVoiceParticipant, updateVoiceParticipantState, type CallParticipantView } from './callParticipants'
import { isCollectiveRoom, leaveOutcome } from './callRoomRules'
import { shouldInitiatePair } from './callRepair'
import { shouldFallbackToRelay, shouldDropRelayAfterIceRecovered } from './callRelayFallback'
import { mergeRemoteStream, type RemoteStreamLike, type RemoteTrackLike } from './callRemoteTracks'
import { type CallEvent, type CallPhase, nextCallPhase, isCallPhaseActive } from './callPhases'
import type { VoiceMediaStats } from './models'
import {
  detectScreenEnvironment,
  buildDisplayMediaConstraints,
  derivedDisplayConstraints,
  classifyScreenShareError,
  applyScreenConstraints,
  applySenderTuning,
  applyCameraTuning,
  setScreenContentHint,
  setCameraContentHint,
  ScreenShareError,
  ScreenCaptureMonitor,
  ScreenStatsCollector,
  normalizeOptions,
  isScreenSampleBad,
  compareQuality,
  ceilingOf,
  lowerScreenQuality,
  raiseScreenQuality,
  SCREEN_DEFAULT_OPTIONS,
  type ScreenQualityKey,
  type ScreenShareOptions,
  type ScreenShareMetrics,
  type ScreenShareErrorCode,
  type ScreenEnvironment,
  emptyScreenMetrics,
} from './screenShare'

export type CallKind = 'voice' | 'video' | 'screen'

import { parseWireSdp, parseWireCandidate } from './callWire'
export { parseWireSdp, parseWireCandidate } from './callWire'
export type { WireSdp } from './callWire'

export interface IncomingCall {
  call_id: string
  from_fp: string
  kind: string
  nickname?: string
}

export {
  CALL_QUALITY_KEY,
  QUALITY_ORDER,
  QUALITY_CONSTRAINTS,
  CAMERA_CONSTRAINTS,
  probeVideoLimits,
  formatVideoLimits,
  getStoredQuality,
  lowerQuality,
  isBadStatsSample,
  type VideoDeviceLimits,
} from './callQuality'
import {
  CALL_QUALITY_KEY,
  CAMERA_CONSTRAINTS,
  QUALITY_CONSTRAINTS,
  getStoredQuality,
  lowerQuality,
  isBadStatsSample,
  type CallQuality,
} from './callQuality'
export type { CallQuality }
export {
  TURN_URL_KEY,
  isValidTurnUrl,
  getTurnUrl,
  getFallbackStunServers,
  getIceServers,
  hasRelayConfigured,
} from './callIce'
import { getIceServers, bytesToBase64 } from './callIce'
export { bytesToBase64 } from './callIce'

export interface CallState {
  callId: string
  kind: CallKind
  convId: string
  phase: CallPhase
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  sharing: boolean
  participants: CallParticipantView[]
  startAt: number
  quality?: CallQuality
  qualityNotice?: string | null
  relayActive?: boolean
  relayManual?: boolean
  relayReason?: string | null
  localScreenStream?: MediaStream | null
  localStream?: MediaStream | null
  nativeMedia?: boolean
  invited?: { fp: string; nickname: string }[]
  ringing?: boolean
}

export {
  getCallPrivacyMode,
  setCallPrivacyForIce,
  getCallPrivacyForIce,
  isIcePublicFallbackSuppressed,
  type CallPrivacyMode,
} from './callIcePrivacy'
import {
  CALL_MEDIA_PREFS_KEY,
  DEFAULT_CALL_MEDIA_PREFS,
  audioConstraintsFromPrefs,
  parseCallMediaPrefs,
  videoConstraintsFromPrefs,
  type CallMediaPrefs,
} from './callMediaPrefs'
import { cameraDevices, nextCameraId, sameCamera } from './callCameras'

let mediaPrefs: CallMediaPrefs = (() => {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(CALL_MEDIA_PREFS_KEY) : null
    const p = parseCallMediaPrefs(raw)
    try { localStorage.setItem(CALL_MEDIA_PREFS_KEY, JSON.stringify(p)) } catch {  }
    return p
  } catch { return { ...DEFAULT_CALL_MEDIA_PREFS } }
})()

export function getCallMediaPrefs(): CallMediaPrefs {
  return { ...mediaPrefs }
}

export function setCallMediaPrefs(patch: Partial<CallMediaPrefs>): CallMediaPrefs {
  mediaPrefs = parseCallMediaPrefs({ ...mediaPrefs, ...patch })
  try { localStorage.setItem(CALL_MEDIA_PREFS_KEY, JSON.stringify(mediaPrefs)) } catch {  }
  return { ...mediaPrefs }
}

export {
  newPeerConnection,
  tuneOpusSdp,
  createTunedOffer,
  createTunedAnswer,
} from './callPeer'
export { AUDIO_CONSTRAINTS } from './callMediaGate'
export { applyOfferInStable } from './callSdpTuning'
import { applyOfferInStable } from './callSdpTuning'
import { AUDIO_CONSTRAINTS } from './callMediaGate'
import { newPeerConnection, createTunedOffer, createTunedAnswer } from './callPeer'

export const CALLS_UNAVAILABLE_MSG = 'chamadas de voz/vídeo indisponíveis neste aparelho'
export const SCREEN_UNAVAILABLE_MSG = 'este aparelho não expõe captura de tela (o Android só libera em WebViews recentes — atualize o Android System WebView; no iPhone/iPad não existe mesmo)';
export const CALLS_UPDATE_WEBVIEW_HINT = 'atualize o WebView do sistema (Android System WebView/Chrome) e libere a permissão de microfone, ou use o app nativo'
export const ICE_RELAY_MSG = 'sem rota de áudio direta — tentando via relay…'
export const ICE_FAILED_MSG = 'conexão de áudio falhou — verifique sua rede ou configure um TURN próprio'
export function supportsCalls(): boolean {
  try {
    if (typeof RTCPeerConnection !== 'undefined' && RTCPeerConnection
        && typeof navigator !== 'undefined' && (navigator as any).mediaDevices) return true
  } catch {  }
  return nativeVoiceAvailable === true
}

export function supportsScreenShare(): boolean {
  try {
    if (typeof navigator === 'undefined') return false
    return getScreenShareBackend() !== 'none'
  } catch { return false }
}

export function screenShareUnavailableReason(): string | null {
  try {
    if (supportsScreenShare()) return null
    const env = detectScreenEnvironment(getScreenShareBackend() === 'native')
    return env.notes.length ? env.notes.join(' · ') : SCREEN_UNAVAILABLE_MSG
  } catch { return SCREEN_UNAVAILABLE_MSG }
}

export type ScreenShareBackend = 'display-media' | 'native' | 'none'
export function getScreenShareBackend(): ScreenShareBackend {
  try {
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

function hasLiveVideoTrack(stream: MediaStream | null | undefined): boolean {
  try {
    return !!stream?.getVideoTracks?.().some((t) => t.readyState === 'live')
  } catch {
    return false
  }
}

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
    const temVideo = hasLiveVideoTrack(stream)
    const telaAtual = (p as any).screenStream as MediaStream | null | undefined
    const ehTela = !!p.sharing && temVideo && !!p.stream && p.stream.id !== stream.id
    if (ehTela) {
      if (!telaAtual || telaAtual.id !== stream.id) {
        ;(p as any).screenStream = stream
        onUpdate({ ...state })
      }
      return
    }
    if (telaAtual && telaAtual.id === stream.id) {
      // Reentrega da MESMA tela (ontrack repetido): mantém no quadro da tela.
      p.sharing = true
      onUpdate({ ...state })
      return
    }
    if (!p.stream) {
      p.stream = stream
      onUpdate({ ...state })
      return
    }
    if (p.stream.id === stream.id) {
      p.stream = stream
      onUpdate({ ...state })
      return
    }
    try {
      mergeRemoteStream(
        p.stream as unknown as RemoteStreamLike<RemoteTrackLike>,
        stream as unknown as RemoteStreamLike<RemoteTrackLike>,
      )
      onUpdate({ ...state })
    } catch {
      p.stream = stream
      onUpdate({ ...state })
    }
  } catch {  }
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
export function diagnoseCallsSupport(): CallsDiagnosis {
  try {
    void services.webrtcReport(
      `RTC=${typeof RTCPeerConnection} md=${typeof (navigator as any).mediaDevices} VideoDecoder=${typeof (globalThis as any).VideoDecoder} VideoEncoder=${typeof (globalThis as any).VideoEncoder} EncodedVideoChunk=${typeof (globalThis as any).EncodedVideoChunk} VideoFrame=${typeof (globalThis as any).VideoFrame} gDM=${typeof (navigator as any).mediaDevices?.getDisplayMedia}`,
    )
  } catch {  }
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
    if (nativeVoiceAvailable === true) missing.push('WebRTC na página (a voz nativa em Rust cobre)')
    else missing.push('WebRTC (RTCPeerConnection ausente)')
  }
  if (!hasGetUserMedia) {
    missing.push(hasMediaDevices
      ? 'microfone (getUserMedia ausente)'
      : 'microfone (mediaDevices/getUserMedia ausente)')
  }
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
  } catch {  }
  return { hasRTC, hasMediaDevices, hasGetUserMedia, hasMediaRecorder, hasAudioContext, missing, isWebViewLike, level }
}
export function canUseRelayCalls(): boolean {
  try { return supportsRelayFallback() || supportsRelayPlayback() } catch { return false }
}
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

let localMediaNotice: ((msg: string) => void) | null = null
export function setLocalMediaNotice(cb: ((msg: string) => void) | null) {
  localMediaNotice = cb
}
export { describeMediaError, comFilaDeCaptura }
import { describeMediaError, comFilaDeCaptura } from './callMediaGate'

async function getLocalMedia(constraints: MediaStreamConstraints): Promise<MediaStream | null> {
  return comFilaDeCaptura(() => getLocalMediaInner(constraints))
}

async function getLocalMediaInner(constraints: MediaStreamConstraints): Promise<MediaStream | null> {
  try {
    const md: any = (typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : null)
    if (!md?.getUserMedia) {
      try { localMediaNotice?.('microfone indisponível neste aparelho (getUserMedia ausente)') } catch {  }
      return null
    }
    const merged: MediaStreamConstraints = { ...constraints }
    if (constraints.audio) {
      const baseAudio = audioConstraintsFromPrefs(mediaPrefs)
      merged.audio = constraints.audio === true
        ? baseAudio
        : { ...baseAudio, ...(constraints.audio as MediaTrackConstraints) }
    }
    if (constraints.video && typeof constraints.video === 'object') {
      const baseVideo = videoConstraintsFromPrefs(mediaPrefs)
      merged.video = { ...baseVideo, ...(constraints.video as MediaTrackConstraints) }
    }
    try {
      return await md.getUserMedia(merged)
    } catch (e) {
      const nome = (e as Error)?.name ?? ''
      const usaDeviceExato = !!mediaPrefs.videoInputId || !!mediaPrefs.audioInputId
      if (
        usaDeviceExato &&
        (nome === 'OverconstrainedError' || nome === 'NotFoundError' || nome === 'NotReadableError')
      ) {
        try {
          const s = await md.getUserMedia({
            ...merged,
            audio: merged.audio
              ? {
                  echoCancellation: mediaPrefs.echoCancellation,
                  noiseSuppression: mediaPrefs.noiseSuppression,
                  autoGainControl: mediaPrefs.autoGainControl,
                  channelCount: 1,
                }
              : merged.audio,
            video: merged.video
              ? { ...videoConstraintsFromPrefs({ ...mediaPrefs, videoInputId: '' }) }
              : merged.video,
          })
          setCallMediaPrefs({ audioInputId: '', videoInputId: '' })
          try { localMediaNotice?.('o aparelho salvo não está mais disponível — usei o microfone/câmera padrão') } catch {  }
          return s
        } catch {  }
      }
      if (merged.video && (e as Error)?.name === 'OverconstrainedError') {
        const quedas: MediaTrackConstraints[] = [
          { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 }, frameRate: { min: 15, ideal: 30 } },
          { width: { min: 640, ideal: 1280 }, height: { min: 480, ideal: 720 }, frameRate: { min: 15, ideal: 60, max: 60 } },
          { width: { min: 320, ideal: 640 }, height: { min: 240, ideal: 480 }, frameRate: { min: 15, ideal: 30 } },
        ]
        for (const q of quedas) {
          try {
            return await md.getUserMedia({ ...merged, video: q })
          } catch {  }
        }
        try {
          localMediaNotice?.('câmera não aceitou as resoluções pedidas — seguindo só com voz')
          return await md.getUserMedia({ ...merged, video: false })
        } catch {  }
      }
      if (merged.video && (e as Error)?.name === 'NotReadableError') {
        for (const espera of [300, 700, 1200, 2000]) {
          await new Promise((r) => setTimeout(r, espera))
          try {
            const s = await md.getUserMedia(merged)
            try { setLocalMediaNotice(null) } catch {  }
            return s
          } catch {  }
        }
      }
      if (merged.video && (e as Error)?.name !== 'OverconstrainedError') {
        try {
          const s = await md.getUserMedia({ ...merged, video: false })
          const why = describeMediaError(e)
          try { localMediaNotice?.(`${why ? `${why.split(' — ')[0]} — ` : ''}seguindo só com voz`) } catch {  }
          return s
        } catch {  }
      }
      if ((e as Error)?.name === 'AbortError') {
        for (const espera of [250, 900]) {
          await new Promise((r) => setTimeout(r, espera))
          try {
            return await md.getUserMedia(merged)
          } catch {  }
        }
        try {
          return await md.getUserMedia({ ...merged, video: false })
        } catch {  }
      }
      const honest = describeMediaError(e)
      try { localMediaNotice?.(honest ?? `falha ao abrir microfone/câmera (${(e as Error)?.name ?? 'erro'})`) } catch {  }
      return null
    }
  } catch { return null }
}

export {
  ICE_DISCONNECTED_GRACE_MS,
  RUNG_LABEL,
  buildPeerDiagnostics,
  type IceFailureState,
  type IceFailureInfo,
  type IceMediaReport,
  type DistorrentNatEndpoint,
  type MediaRung,
  type CallDiagnostics,
} from './callDiagnostics'
import {
  ICE_DISCONNECTED_GRACE_MS,
  buildPeerDiagnostics,
  type DistorrentNatEndpoint,
  type CallDiagnostics,
  type IceFailureInfo,
  type IceMediaReport,
} from './callDiagnostics'

type IceFailureListener = (info: IceFailureInfo) => void
const iceFailureListeners = new Set<IceFailureListener>()
export function subscribeIceFailures(cb: IceFailureListener): () => void {
  iceFailureListeners.add(cb)
  return () => { iceFailureListeners.delete(cb) }
}
function emitIceFailure(info: IceFailureInfo) {
  iceFailureListeners.forEach(cb => { try { cb(info) } catch {  } })
}

export interface IceRecoveredInfo { fp: string; callId: string }
type IceRecoveredListener = (info: IceRecoveredInfo) => void
const iceRecoveredListeners = new Set<IceRecoveredListener>()
export function subscribeIceRecovered(cb: IceRecoveredListener): () => void {
  iceRecoveredListeners.add(cb)
  return () => { iceRecoveredListeners.delete(cb) }
}
function emitIceRecovered(info: IceRecoveredInfo) {
  iceRecoveredListeners.forEach(cb => { try { cb(info) } catch {  } })
}
export {
  RELAY_TIMESLICE_MS,
  RELAY_ICE_FAIL_MS,
  RELAY_MAX_DELAY_MS,
  RELAY_MID,
  RELAY_VIA_LABEL,
  RELAY_BC_NAME,
  RELAY_WINDOW_EVENT,
  isRelayChunkPayload,
  supportsRelayPlayback,
  supportsRelayFallback,
  type RelayChunkPayload,
} from './callRelayCodec'
import {
  RELAY_TIMESLICE_MS,
  RELAY_MAX_DELAY_MS,
  RELAY_MID,
  RELAY_BC_NAME,
  RELAY_WINDOW_EVENT,
  isRelayChunkPayload,
  buildRelayRecorder,
  b64ToBytes,
  supportsRelayPlayback,
  supportsRelayFallback,
  type RelayChunkPayload,
} from './callRelayCodec'
export type CallsSupportLevel = 'full' | 'none'
let nativeVoiceAvailable: boolean | null = null
let nativeRoute: string | null = null

export async function detectNativeVoice(force?: boolean): Promise<boolean> {
  if (!force && nativeVoiceAvailable !== null) return nativeVoiceAvailable
  try {
    nativeVoiceAvailable = await services.voiceMediaAvailable()
  } catch {
    nativeVoiceAvailable = false
  }
  return nativeVoiceAvailable
}

export function resetNativeVoiceCache(): void {
  nativeVoiceAvailable = null
}

export function getCallsSupport(): CallsSupportLevel {
  try { if (supportsCalls()) return 'full' } catch {  }
  if (nativeVoiceAvailable === true) return 'full'
  return 'none'
}

function readIceReport(pc: RTCPeerConnection, stats: RTCStatsReport): IceMediaReport {
  const byId = new Map<string, any>()
  try { stats.forEach((r: any) => { if (r && r.id) byId.set(String(r.id), r) }) } catch {  }
  let pair: any = null
  try {
    stats.forEach((r: any) => {
      if (r && r.type === 'candidate-pair' && (r.nominated || r.selected)) pair = r
    })
    if (!pair) stats.forEach((r: any) => {
      if (!pair && r && r.type === 'candidate-pair' && r.state === 'succeeded') pair = r
    })
  } catch {  }
  const local = pair ? byId.get(String(pair.localCandidateId ?? '')) : null
  const remote = pair ? byId.get(String(pair.remoteCandidateId ?? '')) : null
  let bytesOut = 0
  try {
    stats.forEach((r: any) => {
      if (r && r.type === 'outbound-rtp' && typeof r.bytesSent === 'number') bytesOut += r.bytesSent
    })
  } catch {  }
  const rtt = pair && typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null
  return {
    iceState: String(pc.iceConnectionState ?? 'unknown'),
    localType: local ? String(local.candidateType ?? '') || null : null,
    remoteType: remote ? String(remote.candidateType ?? '') || null : null,
    rttMs: rtt,
    bytesOut,
  }
}

function logIceState(pc: RTCPeerConnection, fp: string, callId: string) {
  let grace: ReturnType<typeof setTimeout> | null = null
  const clearGrace = () => {
    try { if (grace) clearTimeout(grace) } catch {  }
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
          clearGrace()
          try {
            grace = setTimeout(() => {
              try {
                const cur = pc.iceConnectionState
                if (cur === 'disconnected') emitIceFailure({ fp, callId, state: 'disconnected' })
                else if (cur === 'failed') emitIceFailure({ fp, callId, state: 'failed' })
              } catch {  }
            }, ICE_DISCONNECTED_GRACE_MS)
          } catch {  }
        } else if (st === 'connected' || st === 'completed') {
          clearGrace()
          emitIceRecovered({ fp, callId })
        }
      } catch {  }
    }
  } catch {  }
}

export class CallManager {
  private pcs = new Map<string, RTCPeerConnection>()
  private cameraBusy = false
  private pendingIce = new Map<string, Map<string, RTCIceCandidateInit[]>>()
  private localIce = new Map<string, RTCIceCandidate[]>()
  private pendingOffers = new Map<string, { callId: string; sdp: string }>()
  private pendingVoiceJoins = new Map<string, Set<string>>()
  private acceptedCalls = new Set<string>()
  private lastRemoteOffer = new Map<string, string>()
  private iceRestarts = new Map<string, number>()
  private ultimaTrocaDeRede = 0
  private netOff: (() => void) | null = null
  private static readonly MAX_ICE_RESTARTS = 3
  private static readonly ICE_RESTART_BACKOFF_MS = [1000, 4000, 9000]
  private iceRestartTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private offerQueue = new Map<string, Promise<unknown>>()
  private iceServersUsed: RTCIceServer[] | null = null
  private iceReports = new Map<string, IceMediaReport>()
  private distorrentNat: DistorrentNatEndpoint | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly RECONNECT_TIMEOUT_MS = 30_000
  private static readonly RELAY_CONNECT_GRACE_MS = 2_500
  private relayFallbackTimer: ReturnType<typeof setTimeout> | null = null
  private nativeVoiceTimer: ReturnType<typeof setInterval> | null = null
  private nativeVoiceSince = -1
  private endedCalls = new Set<string>()
  private pairStuckSince = new Map<string, number>()
  private soloWaitSince = new Map<string, number>()
  private accepting = new Set<string>()
  private leavingCalls = new Set<string>()
  private roomConvId: string | null = null
  private collectiveRoom = false
  /** A chamada atual nasceu numa conversa de grupo: dura até o último sair. */
  private callIsGroup = false
  private micRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private micRecoveryAttempts = 0
  private roomTimer: ReturnType<typeof setInterval> | null = null
  private ringRetry: { callId: string; kind: CallKind; targets: string[] } | null = null
  private ringTimer: ReturnType<typeof setInterval> | null = null
  private static readonly RING_RETRY_MS = 6_000
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly CONNECT_TIMEOUT_MS = 20_000
  private outgoingTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly OUTGOING_TIMEOUT_MS = 45_000
  private incomingTimer: ReturnType<typeof setTimeout> | null = null
  private static readonly INCOMING_TIMEOUT_MS = 60_000
  private static readonly NATIVE_VOICE_TIMEOUT_MS = 45_000
  private connectWatchdogGrants = 0
  private relayRecDedicated = false
  private localStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  private screenAudioSenders = new Map<RTCPeerConnection, RTCRtpSender>()
  private screenOp: Promise<unknown> = Promise.resolve()
  private screenGen = 0
  private screenSource: 'monitor' | 'window' = 'monitor'
  private screenOptions: ScreenShareOptions = { ...SCREEN_DEFAULT_OPTIONS }
  private screenQualityCeiling: ScreenQualityKey = ceilingOf(SCREEN_DEFAULT_OPTIONS.quality)
  private screenEnv: ScreenEnvironment = detectScreenEnvironment(getScreenShareBackend() === 'native')
  private screenMonitor = new ScreenCaptureMonitor()
  private screenStats = new ScreenStatsCollector()
  private screenMetrics: ScreenShareMetrics = emptyScreenMetrics()
  private screenStatsTimer: ReturnType<typeof setInterval> | null = null
  private screenError: { code: ScreenShareErrorCode; message: string } | null = null
  private screenRecoveryAttempts = 0
  private screenBadSamples = 0
  private screenGoodSamples = 0
  private screenTrackMuted = false
  private static readonly SCREEN_MAX_RECOVERY = 5
  private screenRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private screenLastSize = ''
  public onScreenDebug: ((m: ScreenShareMetrics & { options: ScreenShareOptions; env: ScreenEnvironment; error: { code: ScreenShareErrorCode; message: string } | null }) => void) | null = null
  public onRoomsChanged: (() => void) | null = null
  private onUpdate: (s: CallState | null) => void = () => {}
  private state: CallState | null = null
  private myFp = ''
  private lastPhase: CallPhase = 'idle'
  private engineOff?: () => void
  private quality: CallQuality = getStoredQuality()
  private qualityNotice: string | null = null
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private rosterTimer: ReturnType<typeof setInterval> | null = null
  private repairTimer: ReturnType<typeof setInterval> | null = null
  private badWindows = 0
  private prevLost = new Map<string, number>()
  public onQualityNotice: ((msg: string) => void) | null = null
  public onCallNotice: ((msg: string) => void) | null = null
  public onIceFailed: ((info: IceFailureInfo) => void) | null = null
  public onIncomingGone: ((callId: string) => void) | null = null
  private iceFailOff: (() => void) | null = null
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

  private readonly getIdentity: () => { fingerprint: string; nickname: string } | null

  constructor(getIdentity: () => { fingerprint: string; nickname: string } | null) {
    this.getIdentity = getIdentity
  }

  bind(cb: (s: CallState | null) => void) {
    try { this.netOff?.() } catch {  }
    const aoMudarRede = () => this.onNetworkChanged('sem conexão')
    const aoVoltar = () => this.onNetworkChanged('conexão de volta')
    try {
      window.addEventListener('online', aoVoltar)
      window.addEventListener('offline', aoMudarRede)
      this.netOff = () => {
        try { window.removeEventListener('online', aoVoltar) } catch {  }
        try { window.removeEventListener('offline', aoMudarRede) } catch {  }
      }
    } catch {
      this.netOff = null
    }
    this.onUpdate = (s) => {
      if (s) {
        try {
          const withScreen = s as CallState
          if (withScreen.localScreenStream !== (this.screenStream ?? null)) {
            withScreen.localScreenStream = this.screenStream ?? null
          }
          if (withScreen.localStream !== (this.localStream ?? null)) {
            withScreen.localStream = this.localStream ?? null
          }
          withScreen.participants = (withScreen.participants ?? []).map((p) => ({ ...p }))
        } catch {  }
      }
      cb(s)
    }
    try { setLocalMediaNotice((m) => { try { this.onCallNotice?.(m) } catch {  } }) } catch {  }
    try { const me = this.getIdentity(); if (me && !this.myFp) this.myFp = me.fingerprint } catch {  }
    try { this.engineOff?.() } catch {  }
    this.engineOff = services.subscribe((ev: any) => {
      const fpOk = typeof ev?.from_fp === 'string' && ev.from_fp.length > 0
      if (fpOk && (ev.type === 'call_offer' || ev.type === 'call_answer' || ev.type === 'call_ice')) {
        try {
          const meNow = this.getIdentity()
          if (meNow && ev.from_fp === meNow.fingerprint) return
        } catch {  }
      }
      if (ev.type === 'call_offer' && fpOk) {
        try { if (this.state && (ev as any).call_id === this.state.callId) this.promoteOnSignal(String((ev as any).call_id ?? '')) } catch {  }
        this.handleOffer(ev.from_fp, ev.call_id, ev.sdp)
      }
      if (ev.type === 'call_answer' && fpOk) {
        try { if (this.state && (ev as any).call_id === this.state.callId) this.promoteOnSignal(String((ev as any).call_id ?? '')) } catch {  }
        this.handleAnswer(ev.from_fp, ev.call_id, ev.sdp)
      }
      if (ev.type === 'call_ice' && fpOk) {
        try { if (this.state && (ev as any).call_id === this.state.callId) this.promoteOnSignal(String((ev as any).call_id ?? '')) } catch {  }
        this.handleIce(ev.from_fp, ev.call_id, ev.candidate, ev.mid)
      }
      if ((ev.type === 'call_signal' || ev.type === 'call-signal' || ev.type === 'call_relay') && fpOk) {
        try {
          const payload = (ev as any).payload ?? (ev as any).data ?? (ev as any).sdp ?? (ev as any).signal ?? ''
          if (typeof payload === 'string' && payload.indexOf('audio-chunk') >= 0) {
            this.handleRelayChunk(ev.from_fp, ev.call_id, payload)
          }
        } catch {  }
      }
      if (ev.type === 'call_incoming' && typeof ev.call_id === 'string') {
        try {
          const meNow = this.getIdentity()
          if (meNow && ev.from_fp === meNow.fingerprint) return
        } catch {  }
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
          this.collectiveRoom = false
          this.stopMicRecovery()
            this.startIncomingWatchdog()
            this.onUpdate({ ...this.state })
          }
        }
      }
      if (ev.type === 'call_accepted') {
        if (this.state && this.state.callId === ev.call_id) this.applyPhase('accept')
      }
      if (ev.type === 'call_ringing') {
        if (this.state && this.state.callId === ev.call_id) {
          this.state.ringing = true
          this.onUpdate({ ...this.state })
        }
      }
      if (ev.type === 'call_rejected') {
        if (this.state && this.state.callId === ev.call_id) {
          const fp = String((ev as { from_fp?: string }).from_fp ?? '')
          const coletiva = this.isCollectiveCall(this.state)
          if (coletiva) {
            if (fp && fp !== this.myFp) {
              this.pendingOffers.delete(fp)
              try { this.pcs.get(fp)?.close() } catch {  }
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
      if (ev.type === 'peer_offline' && typeof (ev as any).fp === 'string') this.onPeerGone((ev as any).fp)
      if (ev.type === 'peer_online' && typeof (ev as any).fp === 'string') this.onPeerBack((ev as any).fp)
      if ((ev as any).type === 'nat_endpoint') {
        try {
          const addr = String((ev as any).addr ?? '')
          const source = String((ev as any).source ?? '')
          if (addr && source) this.distorrentNat = { addr, source }
        } catch {  }
      }
      if (ev.type === 'call_ended') {
        const st = this.state
        if (st && st.callId === ev.call_id) {
          const wasIncoming = st.phase === 'incoming'
          const fp = String((ev as { from_fp?: string }).from_fp ?? '')
          if (this.isCollectiveCall(st)) this.collectiveRoom = true
          const saiuEu = !!fp && fp === this.myFp
          const outros = (st.participants ?? []).filter(
            (p) => !!p.fp && p.fp !== this.myFp && p.fp !== fp,
          )
          const decisao = leaveOutcome({
            collective: this.collectiveRoom,
            othersRemain: outros.length > 0,
          })
          if (decisao === 'keep' && !saiuEu) {
            if (fp && fp !== this.myFp) {
              this.pendingOffers.delete(fp)
              try { this.pcs.get(fp)?.close() } catch {  }
              this.pcs.delete(fp)
              this.iceRestarts.delete(fp)
              this.localIce.delete(fp)
              this.lastRemoteOffer.delete(fp)
              this.pendingIce.delete(fp)
              const cur = this.state
              if (cur && removeVoiceParticipant(cur.participants, fp)) {
                try { this.publishRoom() } catch {  }
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
    try { this.iceFailOff?.() } catch {  }
    this.iceFailOff = subscribeIceFailures((info) => {
      try { this.onIceFailed?.(info) } catch {  }
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
          if (shouldFallbackToRelay({
            relayActive: this.relayActive,
            relaySupported: this.supportsRelay(),
            phase: st.phase,
            relayManual: this.relayManual,
          })) {
            this.onCallNotice?.('sem rota direta — usando o áudio pela sinalização')
            void this.setRelayMode(true, 'ice-failed')
          }
        }
      } catch {  }
    })
    try { this.iceRecoveredOff?.() } catch {  }
    try {
      this.iceRecoveredOff = subscribeIceRecovered((info) => {
        try {
          if (!this.state || info.callId !== this.state.callId) return
          const p = this.state.participants.find((x: any) => x.fp === info.fp)
          if (p) p.disconnected = false
          this.applyPhase('media-connected')
          if (shouldDropRelayAfterIceRecovered({ relayActive: this.relayActive, relayManual: this.relayManual })) {
            void this.setRelayMode(false)
          }
        } catch {  }
      })
    } catch { this.iceRecoveredOff = null }
    this.ensureRelayTransport()
    try {
      if (this.state) this.onUpdate({ ...this.state } as CallState)
    } catch {  }
  }

  unbind() {
    this.engineOff?.()
    try { this.netOff?.() } catch {  }
    this.netOff = null
    try { setLocalMediaNotice(null) } catch {  }
    try { this.iceFailOff?.() } catch {  }
    this.iceFailOff = null
    try { this.iceRecoveredOff?.() } catch {  }
    this.iceRecoveredOff = null
    this.teardownRelayTransport()
  }

  getPhase(): CallPhase {
    return this.state?.phase ?? this.lastPhase
  }

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
        if (next !== 'outgoing' && next !== 'connecting') this.stopRingRetry()
        if (next === 'incoming') this.startIncomingWatchdog()
        else this.stopIncomingWatchdog()
        if (next === 'reconnecting') this.startReconnectWatchdog()
        if (next === 'connected' || next === 'failed') this.stopReconnectWatchdog()
        if (next === 'connecting') this.startConnectWatchdog()
        if (next !== 'connecting') this.stopConnectWatchdog()
        if (next === 'connecting' || next === 'connected') {
          this.stopOutgoingWatchdog()
          this.stopIncomingWatchdog()
        }
        if (next === 'ended' || next === 'rejected' || next === 'failed' || next === 'missed') {
          this.stopOutgoingWatchdog()
          this.stopIncomingWatchdog()
          this.stopConnectWatchdog()
        }
        this.onUpdate({ ...st })
      }
      return next
    } catch {  }
    return null
  }

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
          this.applyPhase('reconnect-timeout')
          void this.leave()
        } catch {  }
      }, CallManager.OUTGOING_TIMEOUT_MS)
    } catch {  }
  }
  private stopOutgoingWatchdog() {
    try { if (this.outgoingTimer) clearTimeout(this.outgoingTimer) } catch {  }
    this.outgoingTimer = null
  }

  private startRingRetry(callId: string, kind: CallKind, targets: string[]) {
    this.stopRingRetry()
    const alvos = targets.filter((fp) => !!fp && fp !== this.myFp)
    if (alvos.length === 0) return
    this.ringRetry = { callId, kind, targets: alvos }
    try {
      this.ringTimer = setInterval(() => {
        const r = this.ringRetry
        const st = this.state
        const buscando = !!st && (st.phase === 'outgoing' || st.phase === 'connecting')
        if (!r || !st || st.callId !== r.callId || !buscando) {
          this.stopRingRetry()
          return
        }
        for (const fp of r.targets) services.callRingRetry(r.callId, fp, r.kind).catch(() => {})
        void this.resendPendingOffers(r.callId)
      }, CallManager.RING_RETRY_MS)
    } catch { this.ringTimer = null }
  }

  private stopRingRetry() {
    try { if (this.ringTimer) clearInterval(this.ringTimer) } catch {  }
    this.ringTimer = null
    this.ringRetry = null
  }

  private async resendPendingOffers(callId: string): Promise<void> {
    for (const [fp, pc] of this.pcs) {
      try {
        if (this.state?.callId !== callId || pc.signalingState !== 'have-local-offer') continue
        const desc = pc.localDescription
        if (!desc || desc.type !== 'offer') continue
        await services.callOffer(fp, callId, JSON.stringify(desc)).catch(() => {})
      } catch {  }
    }
  }
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
          this.applyPhase('reconnect-timeout')
          this.onCallNotice?.('chamada perdida')
          this.onIncomingGone?.(callId)
          void this.leave()
        } catch {  }
      }, CallManager.INCOMING_TIMEOUT_MS)
    } catch {  }
  }

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
    try { if (this.incomingTimer) clearTimeout(this.incomingTimer) } catch {  }
    this.incomingTimer = null
  }

  private promoteOnSignal(callId: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId) return
      if (st.phase === 'outgoing') this.applyPhase('signal')
    } catch {  }
  }

  private startConnectWatchdog() {
    this.stopConnectWatchdog()
    this.connectWatchdogGrants = 0
    try {
      const callId = this.state?.callId
      this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(callId), CallManager.CONNECT_TIMEOUT_MS)
    } catch {  }
  }

  private onConnectWatchdogFire(callId?: string) {
    if (callId && (!this.state || this.state.callId !== callId)) return
    this.connectTimer = null
    try {
      const st = this.state
      if (!st || st.phase !== 'connecting') return
      if (this.relayActive) return
      if ((st as any)?.nativeMedia) return
      let anyAlive = false
      for (const pc of this.pcs.values()) {
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          anyAlive = true
          break
        }
      }
      if (anyAlive) return
      if (this.pcs.size === 0 && st.callId.startsWith('voice-')) {
        const sozinho = !(st.participants ?? []).some(
          (p: { fp?: string }) => !!p.fp && p.fp !== this.myFp,
        )
        if (sozinho) {
          this.connectWatchdogGrants = 0
          this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(callId), CallManager.CONNECT_TIMEOUT_MS)
          return
        }
        this.setFailureCause(
          'há gente na call mas nenhuma conexão abriu — o outro lado não mandou oferta ou a montagem da conexão falhou',
        )
        this.onCallNotice?.('não foi possível abrir a conexão com quem está na call')
        this.applyPhase('reconnect-timeout')
        return
      }
      let stillGathering = false
      for (const pc of this.pcs.values()) {
        if (pc.iceGatheringState === 'gathering') { stillGathering = true; break }
      }
      if (stillGathering && this.connectWatchdogGrants < 2) {
        this.connectWatchdogGrants++
        this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(callId), CallManager.CONNECT_TIMEOUT_MS)
        return
      }
      let negociando = false
      let algumPC = false
      for (const pc of this.pcs.values()) {
        algumPC = true
        const ice = pc.iceConnectionState
        if (ice === 'failed' || ice === 'disconnected') continue
        negociando = true
        break
      }
      if (algumPC && negociando && this.connectWatchdogGrants < 2) {
        this.connectWatchdogGrants++
        this.connectTimer = setTimeout(() => this.onConnectWatchdogFire(callId), CallManager.CONNECT_TIMEOUT_MS)
        return
      }
      try { this.onCallNotice?.('sem rota de mídia direta — reiniciando ICE') } catch {  }
      this.setFailureCause('sem rota de mídia em 20s (ICE preso em checking/gathering sem par selecionado; NAT/CGNAT ou TURN inalcançável — ver painel)')
      if (shouldFallbackToRelay({
        relayActive: this.relayActive,
        relaySupported: this.supportsRelay(),
        phase: st.phase,
        relayManual: this.relayManual,
      })) {
        this.onCallNotice?.('sem rota direta — usando o áudio pela sinalização')
        void this.setRelayMode(true, 'ice-failed')
      }
      this.restartIceAll(st.callId)
      this.applyPhase('ice-failed')
    } catch {  }
  }

  private stopConnectWatchdog() {
    try { if (this.connectTimer) clearTimeout(this.connectTimer) } catch {  }
    this.connectTimer = null
  }

  private startReconnectWatchdog() {
    this.stopReconnectWatchdog()
    try {
      const callId = this.state?.callId
      if (callId && callId.startsWith('voice-')) return
      this.reconnectTimer = setTimeout(() => {
        try {
          const st = this.state
          if (callId && (!st || st.callId !== callId)) return
          if (!st || !isCallPhaseActive(st.phase)) return
          if (st.callId.startsWith('voice-')) return
          let anyAlive = false
          for (const pc of this.pcs.values()) {
            const s = pc.iceConnectionState
            if (s === 'connected' || s === 'completed') { anyAlive = true; break }
          }
          if (anyAlive) {
            this.applyPhase('media-reconnected')
            return
          }
          if (shouldFallbackToRelay({
            relayActive: this.relayActive,
            relaySupported: this.supportsRelay(),
            phase: st.phase,
            relayManual: this.relayManual,
          })) {
            this.onCallNotice?.('sem rota de mídia — entrando pelo áudio da sinalização')
            void this.setRelayMode(true, 'ice-failed').then((ok) => {
              if (ok) return
              this.setFailureCause('reconexão falhou — sem rota de mídia e sem áudio de reserva')
              this.applyPhase('reconnect-timeout')
              this.onCallNotice?.('reconexão falhou — sem rota de mídia após 30s')
              void this.leave()
            })
            return
          }
          this.setFailureCause('reconexão falhou — sem rota de mídia após 30s (ICE restarts esgotados; NAT/CGNAT sem TURN válido)')
          this.applyPhase('reconnect-timeout')
          this.onCallNotice?.('reconexão falhou — sem rota de mídia após 30s')
          void this.leave()
        } catch {  }
      }, CallManager.RECONNECT_TIMEOUT_MS)
    } catch {  }
  }

  private stopReconnectWatchdog() {
    try { if (this.reconnectTimer) clearTimeout(this.reconnectTimer) } catch {  }
    this.reconnectTimer = null
  }

  private clearIceRestartTimers() {
    for (const t of this.iceRestartTimers.values()) {
      try { clearTimeout(t) } catch {  }
    }
    this.iceRestartTimers.clear()
  }

  private onPeerGone(fp: string) {
    try {
      const st = this.state
      if (!st || !fp || fp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fp)
      if (!p) return
      if ((st as any).nativeMedia) return
      p.disconnected = true
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
      if (st.phase === 'connected' || st.phase === 'connecting') this.applyPhase('ice-failed')
      else this.onUpdate({ ...st })
    } catch {  }
  }

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
      if (dead && isCallPhaseActive(st.phase)) {
        try { pc?.close() } catch {  }
        this.pcs.delete(fp)
        this.iceRestarts.delete(fp)
        this.localIce.delete(fp)
        this.lastRemoteOffer.delete(fp)
        this.createPC(fp, st.callId, true).catch(() => {})
      }
      this.onUpdate({ ...st })
    } catch {  }
  }

  private onParticipantAdded(callId: string, fp: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId) return
      if (!fp || fp === this.myFp) return
      const p = st.participants.find((x: any) => x.fp === fp)
      if (!p) {
        if (this.pcs.has(fp)) this.markJoined(fp)
        return
      }
      if (p.disconnected) {
        p.disconnected = false
        this.onUpdate({ ...st })
      }
      if (!this.pcs.has(fp) && isCallPhaseActive(st.phase)) {
        this.createPC(fp, callId, true).catch(() => {  })
      }
    } catch {  }
  }

  private onVoiceParticipantJoined(callId: string, fp: string) {
    try {
      const st = this.state
      if (!fp || fp === this.myFp) return
      if (!st || st.callId !== callId) {
        if (callId.startsWith('voice-')) {
          let set = this.pendingVoiceJoins.get(callId)
          if (!set) { set = new Set(); this.pendingVoiceJoins.set(callId, set) }
          set.add(fp)
        }
        return
      }
      const added = addVoiceParticipant(st.participants, fp)
      if (added) {
        this.dropInvite(fp)
        this.onUpdate({ ...st })
      }
      if (
        !(st as any).nativeMedia &&
        !this.pcs.has(fp) &&
        isCallPhaseActive(st.phase)
      ) {
        void this.createPC(fp, callId, true).catch(() => {  })
      }
    } catch {  }
  }

  private onVoiceParticipantLeft(callId: string, fp: string) {
    try {
      const st = this.state
      if (!st || st.callId !== callId || !fp || fp === this.myFp) return
      this.pendingOffers.delete(fp)
      if (!removeVoiceParticipant(st.participants, fp)) return
      try { this.pcs.get(fp)?.close() } catch {  }
      this.pcs.delete(fp)
      this.iceRestarts.delete(fp)
      this.localIce.delete(fp)
      this.lastRemoteOffer.delete(fp)
      this.pendingIce.delete(fp)
      this.renegociacaoPendente.delete(fp)
      this.onUpdate({ ...st })
    } catch {  }
  }

  private onVoiceParticipantState(callId: string, fp: string, muted: boolean, deafened: boolean) {
    try {
      const st = this.state
      if (!fp || fp === this.myFp) return
      if (!st || st.callId !== callId) {
        if (callId.startsWith('voice-')) {
          let set = this.pendingVoiceJoins.get(callId)
          if (!set) { set = new Set(); this.pendingVoiceJoins.set(callId, set) }
          set.add(fp)
        }
        return
      }
      const added = addVoiceParticipant(st.participants, fp)
      const changed = updateVoiceParticipantState(st.participants, fp, muted, deafened)
      if (added) this.dropInvite(fp)
      if (added || changed) this.onUpdate({ ...st })
      if (
        added &&
        !(st as any).nativeMedia &&
        !this.pcs.has(fp) &&
        isCallPhaseActive(st.phase) &&
        this.myFp &&
        this.myFp > fp
      ) {
        void this.createPC(fp, callId, true).catch(() => {  })
      }
    } catch {  }
  }

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
      } catch {  }
      if (on !== null) {
        p.sharing = on
        if (cameraOn !== null) p.cameraOn = cameraOn
        if (!on) {
          try { delete (p as any).videoUrl } catch {  }
          try { (p as any).videoSeq = -1 } catch {  }
          try { (p as any).screenStream = null } catch {  }
        }
        this.onUpdate({ ...st })
      }
    } catch {  }
  }

  private broadcastScreenSignal(on: boolean, cameraOn?: boolean) {
    try {
      const st = this.state
      if (!st) return
      const payload = JSON.stringify({ screen: on ? 'on' : 'off', ...(cameraOn === undefined ? {} : { cameraOn }) })
      for (const p of st.participants) {
        if (!p.fp || p.fp === this.myFp) continue
        services.screenShareOffer(p.fp, st.callId, payload).catch(() => {})
      }
    } catch {  }
  }

  async start(kind: CallKind, convId: string, targetFps: string[], opts?: { group?: boolean }): Promise<CallState> {
    if (this.state && isCallPhaseActive(this.state.phase)) {
      throw new Error('já existe uma chamada em andamento — encerre a atual antes')
    }
    await detectNativeVoice(true)
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    const me = this.getIdentity()
    if (!me) throw new Error('sem identidade')
    this.myFp = me.fingerprint
    this.callIsGroup = opts?.group === true
    this.collectiveRoom = this.callIsGroup

    this.quality = getStoredQuality()
    this.qualityNotice = null
    this.badWindows = 0
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch {  }
    try { this.lastNativeStats = null } catch {  }
    this.prevLost.clear()
    const callId = await services.callInvite(targetFps[0] ?? convId, kind)
    this.acceptedCalls.add(callId)
    for (const fp of targetFps.slice(1)) {
      if (fp === me.fingerprint) continue
      try { await services.callAddParticipant(fp, callId, fp, kind) } catch {  }
    }
    this.startRingRetry(callId, kind, targetFps)

    const convidados = [...new Set(
      [targetFps[0], ...targetFps.slice(1)]
        .filter((fp): fp is string => !!fp && fp !== me.fingerprint),
    )]
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
        invited: convidados.map(fp => ({ fp, nickname: fp.slice(0, 6) })),
        nativeMedia: true,
      } as unknown as CallState
      this.startNativeVoiceMonitor(callId)
      this.publishRoom()
      this.startMeshRepair(this.state.callId)
      this.onUpdate({ ...this.state })
      this.startCallForeground()
      return this.state
    }

    const qOrVideo: MediaTrackConstraints | boolean = kind === 'video' ? { ...CAMERA_CONSTRAINTS } : false
    const constraints: MediaStreamConstraints = kind === 'video' ? { audio: true, video: qOrVideo } : { audio: true, video: false }
    this.localStream = await getLocalMedia(constraints)
    if (!this.localStream?.getAudioTracks().some((t) => t.readyState === 'live')) {
      this.scheduleMicRecovery(callId)
    }

    this.resetRelayForNewCall()
    this.state = {
      callId,
      kind,
      convId,
      phase: 'outgoing',
      ringing: false,
      muted: false,
      deafened: false,
      cameraOn: this.hasLiveCamera(),
      sharing: false,
      participants: [
        { fp: me.fingerprint, nickname: me.nickname, stream: this.localStream ?? undefined },
      ],
      invited: convidados.map(fp => ({ fp, nickname: fp.slice(0, 6) })),
      startAt: Date.now(),
      quality: this.quality,
      qualityNotice: null,
      relayActive: false,
      relayManual: false,
      relayReason: null,
    }
    this.startOutgoingWatchdog()
    this.ensureRelayTransport()
    this.startQualityMonitor()
    for (const fp of targetFps) {
      if (fp === me.fingerprint) continue
      await this.createPC(fp, callId, true)
    }
    for (const alvo of convidados) {
      for (const outro of convidados) {
        if (outro === alvo) continue
        services.callAddParticipant(alvo, callId, outro, '').catch(() => {  })
      }
    }
    this.startMeshRepair(callId)
    this.publishRoom()
    this.startMeshRepair(this.state.callId)
    this.onUpdate({ ...this.state })
    this.startCallForeground()
    return this.state
  }

  async joinVoice(communityId: string, channelId: string) {
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    if (this.state && isCallPhaseActive(this.state.phase) && !this.state.callId.startsWith('voice-')) {
      throw new Error('já existe uma chamada em andamento — encerre a atual antes de entrar num canal de voz')
    }
    const alvo = `voice-${communityId}-${channelId}`
    if (
      this.state
      && this.state.callId === alvo
      && isCallPhaseActive(this.state.phase)
    ) {
      return this.state
    }
    if (
      this.state
      && this.state.callId.startsWith('voice-')
      && this.state.callId !== alvo
      && isCallPhaseActive(this.state.phase)
    ) {
      try { await this.leave() } catch {  }
    }
    await detectNativeVoice(true)
    await services.voiceJoin(communityId, channelId)
    const me = this.getIdentity()
    if (!me) return
    this.myFp = me.fingerprint
    const callId = `voice-${communityId}-${channelId}`
    this.acceptedCalls.add(callId)
    this.quality = getStoredQuality()
    this.qualityNotice = null
    this.badWindows = 0
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch {  }
    try { this.lastNativeStats = null } catch {  }
    this.prevLost.clear()
    this.resetRelayForNewCall()

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
      } catch {  }
      const adiantadosNativo = this.pendingVoiceJoins.get(callId)
      this.pendingVoiceJoins.delete(callId)
      if (adiantadosNativo) {
        for (const fp of adiantadosNativo) {
          if (!fp || fp === me.fingerprint) continue
          if (!this.state.participants.some((p: any) => p.fp === fp)) {
            this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
          }
        }
      }
      this.startRosterReconcile(callId, communityId, channelId)
      this.startNativeVoiceMonitor(callId)
      this.onUpdate({ ...this.state })
      return this.state
    }

    this.localStream = await getLocalMedia({ audio: true })
    if (!this.localStream?.getAudioTracks().some((t) => t.readyState === 'live')) {
      this.scheduleMicRecovery(callId)
    }
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
    try {
      const states = await services.voiceStates(communityId, channelId)
      for (const [fp] of states) {
        if (!fp || fp === me.fingerprint) continue
        if (!this.state.participants.some((p: any) => p.fp === fp)) {
          this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
        }
        try { await this.createPC(fp, callId, true) } catch {  }
      }
    } catch {  }
    const adiantados = this.pendingVoiceJoins.get(callId)
    this.pendingVoiceJoins.delete(callId)
    if (adiantados) {
      for (const fp of adiantados) {
        if (!fp || fp === me.fingerprint) continue
        if (!this.state.participants.some((p: any) => p.fp === fp)) {
          this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
        }
        if (!this.pcs.has(fp)) {
          try { await this.createPC(fp, callId, true) } catch {  }
        }
      }
    }
    this.startRosterReconcile(callId, communityId, channelId)
    this.catchUpVoiceRoster(callId, communityId, channelId)
    try {
      for (const fp of [...this.pendingOffers.keys()]) {
        const pend = this.pendingOffers.get(fp)
        if (!pend || pend.callId !== callId) continue
        this.pendingOffers.delete(fp)
        await this.handleOffer(fp, pend.callId, pend.sdp).catch(() => {  })
      }
    } catch {  }
    this.startConnectWatchdog()
    this.ensureRelayTransport()
    this.startQualityMonitor()
    this.publishRoom()
    this.startMeshRepair(this.state.callId)
    this.onUpdate({ ...this.state })
    this.startCallForeground()
    return this.state
  }

  private catchUpVoiceRoster(callId: string, communityId: string, channelId: string) {
    const delays = [1200, 3000, 6000, 10000, 16000, 25000]
    for (const ms of delays) {
      try {
        setTimeout(() => {
          const st = this.state
          if (!st || st.callId !== callId) return
          void services.voiceStates(communityId, channelId).then(async (states) => {
            const cur = this.state
            if (!cur || cur.callId !== callId) return
            for (const [fp] of states) {
              if (!fp || fp === this.myFp) continue
              if (!cur.participants.some((p: any) => p.fp === fp)) {
                cur.participants.push({ fp, nickname: fp.slice(0, 6) })
                this.onUpdate({ ...cur })
              }
              if (this.pcs.has(fp)) continue
              const euInicio = !!this.myFp && this.myFp > fp
              const esperouOsOutros = !!this.myFp && this.myFp < fp && ms >= 3500
              if (!euInicio && !esperouOsOutros) continue
              try { await this.createPC(fp, callId, true) } catch {  }
            }
          }).catch(() => {  })
        }, ms)
      } catch {  }
    }
  }

  getQuality(): CallQuality { return this.quality }

  getQualityNotice(): string | null { return this.qualityNotice }
  isRelayActive(): boolean { return this.relayActive }
  isRelayManual(): boolean { return this.relayManual }
  getRelayReason(): string | null { return this.relayReason }
  supportsRelay(): boolean {
    try { return supportsRelayFallback() || supportsRelayPlayback() } catch { return false }
  }

  async setRelayMode(on: boolean, reason?: string): Promise<boolean> {
    try {
      if (on) {
        if (!canUseRelayCalls()) return false
        this.relayManual = reason === 'manual'
        await this.startRelay(reason ?? 'manual')
        this.syncRelayToState()
        return true
      }
      this.stopRelayFull()
      this.syncRelayToState()
      return true
    } catch { return false }
  }

  getRungSummary(): string {
    try {
      if (nativeRoute && nativeRoute !== 'n/d') return nativeRoute
      const reports = [...this.iceReports.values()]
      if (!reports.length) return 'n/d'
      const comPar = reports.filter((r) => !!r.localType || !!r.remoteType)
      if (!comPar.length) return 'n/d'
      const routes = comPar.map((r) => {
        const t = r.remoteType || r.localType || 'host'
        return t === 'relay' ? 'TURN' : t === 'srflx' ? 'STUN' : t === 'prflx' ? 'P2P' : 'LAN'
      })
      const uniq = [...new Set(routes)]
      return uniq.join('+') || 'n/d'
    } catch { return 'n/d' }
  }

  private resetRelayForNewCall() {
    try {
      this.clearRelayFallbackTimer()
      this.relayActive = false
      this.relayManual = false
      this.relayReason = null
      this.collectiveRoom = false
      this.stopMicRecovery()
    } catch {  }
  }

  async acceptInbound(callId: string, kind: CallKind, convId: string, fromFp: string, nickname?: string): Promise<CallState> {
    const me = this.getIdentity()
    if (!me) throw new Error('sem identidade')
    this.myFp = me.fingerprint
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
    this.acceptedCalls.add(callId)
    await detectNativeVoice(true)
    if (nativeVoiceAvailable === true) {
      this.lastFailureCause = null
      if (this.state && this.state.callId === callId) {
        if (this.state.phase === 'incoming') this.applyPhase('accept')
        this.stopConnectWatchdog()
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
      this.publishRoom()
      this.onUpdate({ ...this.state })
      return this.state
    }
    if (this.state && this.state.callId === callId) {
      if (this.state.phase === 'incoming') this.applyPhase('accept')
      this.collectiveRoom = false
      if (!this.state.convId && convId) this.state.convId = convId
      if (!this.state.participants.find(p => p.fp === fromFp)) {
        this.state.participants.push({ fp: fromFp, nickname: nickname ?? fromFp.slice(0, 6) })
        this.syncRelayToState()
      }
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
      } catch {  }
      this.announceSelfToRoom(callId)
      return this.state
    }
    if (!this.localStream) {
      try {
        this.localStream = kind === 'video'
          ? await getLocalMedia({ audio: true, video: { ...CAMERA_CONSTRAINTS } })
          : await getLocalMedia({ audio: true })
      } catch { this.localStream = null }
    }
    this.resetRelayForNewCall()
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch {  }
    try { this.lastNativeStats = null } catch {  }
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
    this.startConnectWatchdog()
    this.startQualityMonitor()
    this.ensureRelayTransport()
    this.syncRelayToState()
    await this.ensureMediaOnAllPCs()
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
      for (const fp of alvos) {
        if (!fp || fp === me.fingerprint) continue
        if (!this.state.participants.some((p: any) => p.fp === fp)) {
          this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
        }
      }
      this.onUpdate({ ...this.state })
    } catch {  }
    this.announceSelfToRoom(callId)
    this.startMeshRepair(callId)
    this.publishRoom()
    this.startCallForeground()
    return this.state
  }

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
    } catch {  }
  }
  private async startRelay(reason: string): Promise<void> {
    this.relayActive = true
    this.relayReason = reason
    this.ensureRelayTransport()
    this.syncRelayToState()
    try {
      await this.ensureRelayRecorder()
    } catch (e) {
      this.relayActive = true
      try {
        this.onCallNotice?.(
          `só dá para OUVIR nesta chamada: ${(e as Error)?.message ?? 'microfone indisponível'}`,
        )
      } catch {  }
    }
    this.markRelayConnectedFallback()
    this.syncRelayToState()
  }
  private markRelayAudioLive() {
    try {
      const st = this.state
      if (!st) return
      if (st.phase === 'connected') return
      this.applyPhase('relay-audio-live')
    } catch {  }
  }

  private markRelayConnectedFallback() {
    try {
      const st = this.state
      if (!st || !this.relayActive) return
      if (st.phase === 'connected' || st.phase === 'ended' || st.phase === 'failed') return
      try { if (this.relayFallbackTimer) clearTimeout(this.relayFallbackTimer) } catch {  }
      this.relayFallbackTimer = setTimeout(() => {
        this.relayFallbackTimer = null
        try {
          const cur = this.state
          if (!cur || !this.relayActive) return
          if (cur.phase === 'connected' || cur.phase === 'ended' || cur.phase === 'failed') return
          this.markRelayAudioLive()
        } catch {  }
      }, CallManager.RELAY_CONNECT_GRACE_MS)
    } catch {  }
  }

  private clearRelayFallbackTimer() {
    try { if (this.relayFallbackTimer) clearTimeout(this.relayFallbackTimer) } catch {  }
    this.relayFallbackTimer = null
  }

  private stopRelaySender() {
    try { this.relayRecorder?.stop() } catch {  }
    this.relayRecorder = null
    const shared = !this.relayRecDedicated
    if (!shared) {
      try { this.relayRecStream?.getTracks().forEach(t => { try { t.stop() } catch {  } }) } catch {  }
    }
    this.relayRecDedicated = false
    this.relayRecStream = null
  }
  private stopRelayFull() {
    this.stopRelaySender()
    try { void this.relayAudioCtx?.close() } catch {  }
    this.relayAudioCtx = null
    this.relayHeaderBytes = null
    this.relayQueues.clear()
    this.relayActive = false
    this.relayReason = null
    this.relayManual = false
    this.clearRelayFallbackTimer()
  }
  private ensureRelayTransport() {
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
          } catch {  }
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
          } catch {  }
        }
        window.addEventListener(RELAY_WINDOW_EVENT, this.relayWindowHandler as EventListener)
      }
    } catch {  }
  }
  private teardownRelayTransport() {
    try { this.relayBc?.close() } catch {  }
    this.relayBc = null
    try {
      if (typeof window !== 'undefined' && this.relayWindowHandler) {
        window.removeEventListener(RELAY_WINDOW_EVENT, this.relayWindowHandler as EventListener)
      }
    } catch {  }
    this.relayWindowHandler = null
  }
  private async ensureRelayRecorder(): Promise<void> {
    if (this.relayRecorder) {
      try { if (this.relayRecorder.state === 'recording') return } catch { return }
    }
    const MR: any = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null
    if (!MR) throw new Error('MediaRecorder indisponível')
    let stream: MediaStream | null = null
    try {
      const audioTracks = this.localStream?.getAudioTracks().filter(t => t.readyState === 'live') ?? []
      if (audioTracks.length > 0 && this.localStream) {
        stream = this.localStream
      } else {
        stream = await getLocalMedia({ audio: true })
      }
    } catch { stream = null }
    if (!stream) throw new Error('sem microfone para o modo compatibilidade')
    try {
      if (this.localStream && stream !== this.localStream) {
        const at = stream.getAudioTracks()[0]
        if (at && this.localStream.getAudioTracks().length === 0) {
          try { this.localStream.addTrack(at) } catch {  }
        }
      }
      if (!this.localStream) this.localStream = stream
    } catch {  }
    this.relayRecStream = stream
    this.relayRecDedicated = stream !== this.localStream
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
            } catch {  }
            if (targets.size === 0) return
            for (const fp of targets) this.sendRelayPayload(fp, callId, payload)
            this.markRelayAudioLive()
          } catch {  }
        }).catch(() => {})
      } catch {  }
    }
    try { rec.onerror = () => {} } catch {  }
    this.relayRecorder = rec
    try { rec.start(RELAY_TIMESLICE_MS) } catch {  }
  }
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
    try {
      const anySvc: any = services as any
      if (typeof anySvc?.callSignal === 'function') {
        try { anySvc.callSignal(targetFp, callId, payload).catch(() => {}) } catch {  }
      }
    } catch {  }
    try { services.callIce(targetFp, callId, payload, RELAY_MID).catch(() => {}) } catch {  }
    try { this.relayBc?.postMessage({ type: 'distorrent-call-relay', call_id: callId, from_fp: this.myFp, payload }) } catch {  }
    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(RELAY_WINDOW_EVENT, { detail: { call_id: callId, from_fp: this.myFp, payload } }))
      }
    } catch {  }
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
      try { if (Date.now() - Number(chunk.ts || 0) > RELAY_MAX_DELAY_MS) return } catch {  }
      if (!chunk.data || chunk.data.length === 0) return
      void this.playRelayChunk(fromFp, chunk)
    } catch {  }
  }
  private ensureAudioCtx(): AudioContext | null {
    try {
      if (this.relayAudioCtx) {
        try { if (this.relayAudioCtx.state === 'suspended') void this.relayAudioCtx.resume().catch(() => {}) } catch {  }
        return this.relayAudioCtx
      }
      const AC: any = typeof AudioContext !== 'undefined' ? AudioContext : (typeof window !== 'undefined' ? (window as any).webkitAudioContext : null)
      if (!AC) return null
      this.relayAudioCtx = new AC()
      try { if (this.relayAudioCtx && this.relayAudioCtx.state === 'suspended') void this.relayAudioCtx.resume().catch(() => {}) } catch {  }
      return this.relayAudioCtx
    } catch { return null }
  }
  private async playRelayChunk(fromFp: string, chunk: RelayChunkPayload): Promise<void> {
    try {
      const ctx = this.ensureAudioCtx()
      if (!ctx) return
      try { if (Date.now() - Number(chunk.ts || 0) > RELAY_MAX_DELAY_MS) return } catch {  }
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
      try {
        entry.pending.set(chunk.seq, { buf, ts: Number(chunk.ts || Date.now()) })
        if (entry.pending.size > 12) {
          const keys = [...entry.pending.keys()].sort((a, b) => a - b)
          const drop = keys.slice(0, entry.pending.size - 12)
          for (const k of drop) entry.pending.delete(k)
          if (entry.nextSeq < (keys[0] ?? entry.nextSeq)) entry.nextSeq = keys[0] ?? entry.nextSeq
        }
      } catch {  }
      this.scheduleRelayPlayback(fromFp)
    } catch {  }
  }
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
        if (Date.now() - item.ts > RELAY_MAX_DELAY_MS) continue
        const now = ctx.currentTime
        if (entry.nextTime < now + 0.02) entry.nextTime = now + 0.05
        const src = ctx.createBufferSource()
        src.buffer = item.buf
        try { src.connect(ctx.destination) } catch {  }
        try { src.start(entry.nextTime) } catch {  }
        entry.nextTime += item.buf.duration
        this.markRelayAudioLive()
      }
    } catch {  }
  }

  async applyMediaPrefs(patch: Partial<CallMediaPrefs>): Promise<CallMediaPrefs> {
    const antes = getCallMediaPrefs()
    const depois = setCallMediaPrefs(patch)
    const trocouMic = !!antes.audioInputId !== !!depois.audioInputId || antes.audioInputId !== depois.audioInputId
    const trocouCam = antes.videoInputId !== depois.videoInputId

    const audioTrack = this.localStream?.getAudioTracks()[0] ?? null
    if (trocouMic) {
      try {
        const novo = await getLocalMedia({ audio: audioConstraintsFromPrefs(depois) })
        const track = novo?.getAudioTracks()[0]
        if (track) {
          if (this.localStream) {
            try { this.localStream.addTrack(track) } catch {  }
            if (audioTrack) { try { this.localStream.removeTrack(audioTrack); audioTrack.stop() } catch {  } }
          } else {
            try { this.localStream = new MediaStream([track]) } catch {  }
          }
          for (const pc of this.pcs.values()) {
            try {
              const sender = pc.getSenders().find((s) => s.track?.kind === 'audio') ?? null
              if (sender) await sender.replaceTrack(track)
            } catch {  }
          }
        }
      } catch (e) {
        setCallMediaPrefs({ audioInputId: antes.audioInputId })
        throw new Error(`não foi possível trocar o microfone: ${String((e as Error)?.message ?? e)}`)
      }
    } else if (audioTrack) {
      try {
        await audioTrack.applyConstraints(audioConstraintsFromPrefs(depois))
      } catch {  }
    }

    const camTrack = this.localStream?.getVideoTracks()[0] ?? null
    const trocouFacing = antes.facingMode !== depois.facingMode
    if ((trocouCam || trocouFacing) && camTrack && camTrack.readyState === 'live') {
      try {
        await this.trocarFeedDeCamera({
          soltarAntes: true,
          reverter: () => setCallMediaPrefs(antes),
        })
      } catch (e) {
        setCallMediaPrefs(antes)
        throw new Error(
          `não foi possível trocar a câmera: ${describeMediaError(e) ?? String((e as Error)?.message ?? e)}`,
        )
      }
    } else if (camTrack) {
      try {
        await camTrack.applyConstraints(videoConstraintsFromPrefs(depois))
      } catch {  }
    }

    if (this.state) this.onUpdate({ ...this.state })
    return getCallMediaPrefs()
  }

  async switchCamera(): Promise<{ deviceId: string; available: number }> {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
    if (!md || typeof md.enumerateDevices !== 'function') {
      throw new Error('este aparelho não expõe as câmeras para alternância')
    }
    if (this.cameraBusy) throw new Error('a câmera está trocando — aguarde um instante')
    const lista = cameraDevices(await md.enumerateDevices())
    if (lista.length < 2) {
      const brutos = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      const mobile = isAndroidRuntime() || isIOSRuntime()
      if (brutos.length < 2 && !mobile) {
        throw new Error('só há uma câmera disponível neste aparelho')
      }
      const antes = getCallMediaPrefs()
      const alvo: 'user' | 'environment' = antes.facingMode === 'user' ? 'environment' : 'user'
      const reverter = () => setCallMediaPrefs({ facingMode: antes.facingMode })
      setCallMediaPrefs({ videoInputId: '', facingMode: alvo })
      if (this.hasLiveCamera()) {
        const settingsAntes = this.localStream?.getVideoTracks()[0]?.getSettings?.() ?? null
        this.cameraBusy = true
        try {
          await this.trocarFeedDeCamera({ soltarAntes: false, reverter })
          const depois = this.localStream?.getVideoTracks()[0]?.getSettings?.() ?? null
          if (sameCamera(settingsAntes, depois)) {
            // O aparelho expôs uma câmera só: reabrir a mesma não é "inverter".
            try { this.onCallNotice?.('este aparelho não expôs uma segunda câmera') } catch {  }
          }
          if (this.state) this.onUpdate({ ...this.state })
        } catch (e) {
          reverter()
          throw new Error(
            `não foi possível inverter a câmera: ${describeMediaError(e) ?? String((e as Error)?.message ?? e)}`,
          )
        } finally {
          this.cameraBusy = false
        }
      }
      return { deviceId: alvo, available: Math.max(brutos.length, mobile ? 2 : 0) }
    }
    const atual = getCallMediaPrefs().videoInputId
    const proximo = nextCameraId(lista, atual)
    if (!proximo) throw new Error('não foi possível escolher a próxima câmera')
    if (!this.state) {
      setCallMediaPrefs({ videoInputId: proximo, facingMode: '' })
      return { deviceId: proximo, available: lista.length }
    }
    const camLive = this.hasLiveCamera()
    if (!camLive) {
      setCallMediaPrefs({ videoInputId: proximo, facingMode: '' })
      try {
        this.onCallNotice?.('câmera trocada — a próxima transmissão já usa a nova')
      } catch {  }
      return { deviceId: proximo, available: lista.length }
    }
    const antes = getCallMediaPrefs()
    const reverter = () => setCallMediaPrefs({ videoInputId: antes.videoInputId })
    setCallMediaPrefs({ videoInputId: proximo, facingMode: '' })
    this.cameraBusy = true
    try {
      await this.trocarFeedDeCamera({ soltarAntes: true, reverter })
      if (this.state) this.onUpdate({ ...this.state })
      return { deviceId: proximo, available: lista.length }
    } catch (e) {
      reverter()
      throw new Error(
        `não foi possível trocar a câmera: ${describeMediaError(e) ?? String((e as Error)?.message ?? e)}`,
      )
    } finally {
      this.cameraBusy = false
    }
  }

  async setQuality(q: CallQuality): Promise<void> {
    const prev = this.quality
    try {
      const tracks: MediaStreamTrack[] = []
      const camTrack = this.localStream?.getVideoTracks()[0] ?? null
      if (camTrack && camTrack.readyState === 'live') tracks.push(camTrack)
      for (const track of tracks) {
        try {
          await track.applyConstraints({ ...QUALITY_CONSTRAINTS[q] } as MediaTrackConstraints)
        } catch {  }
      }
      if (tracks.length > 0 && this.state && this.pcs.size > 0) {
        for (const fp of this.pcs.keys()) {
          try {
            await this.sendOffer(fp, this.state.callId)
          } catch {  }
        }
      }
      this.quality = q
      try { localStorage.setItem(CALL_QUALITY_KEY, q) } catch {  }
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
    try { if (this.statsTimer) clearInterval(this.statsTimer) } catch {  }
    this.statsTimer = null
  }

  private async pollStats() {
    if (!this.state || this.pcs.size === 0) return
    try {
      let bad = false
      let parSelecionado = false
      for (const [fp, pc] of this.pcs) {
        try {
          if (pc.connectionState === 'closed') continue
          const stats = await pc.getStats()
          try {
            const rep = readIceReport(pc, stats)
            this.iceReports.set(fp, rep)
            if (rep.localType || rep.remoteType) parSelecionado = true
          } catch {  }
          try { this.lastStats.set(fp, stats) } catch {  }
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
        } catch {  }
      }
      if (parSelecionado && this.state && this.state.phase !== 'connected') {
        this.applyPhase('media-connected')
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
          try { this.onQualityNotice?.(msg) } catch {  }
        } catch {  }
      }
    } catch {  }
  }

  private lastStats = new Map<string, RTCStatsReport>()
  private lastFailureCause: string | null = null
  private setFailureCause(cause: string | null) {
    try { this.lastFailureCause = cause } catch {  }
  }
  getFailureCause(): string | null {
    try { return this.lastFailureCause } catch { return null }
  }
  private lastNativeStats: VoiceMediaStats | null = null

  private nativeFailureReason(st: CallState): string {
    try {
      const s = this.lastNativeStats
      if (!s) {
        if (st.phase === 'outgoing') return 'voz nativa: aguardando o outro lado atender (mídia do Rust ainda sem sessão)'
        return 'voz nativa: mídia do Rust ainda sem sessão para esta chamada (offer nativa ainda não criada ou sem VoiceMedia)'
      }
      const io = `saída=${s.packets_out ?? 0} entrada=${s.packets_in ?? 0} plc=${s.plc_frames ?? 0} erros=${s.decode_errors ?? 0}`
      if (s.speaker_error) return `voz nativa: o alto-falante não abriu (${s.speaker_error}) - o áudio chega mas não sai desta máquina`
      if (s.mic_error && (s.packets_out ?? 0) === 0) return `voz nativa: o microfone não abriu (${s.mic_error}) - este lado está só recebendo`
      if (s.state === 'connected') return `voz nativa conectada via ${s.route} (${io})`
      if (s.state === 'failed') return `voz nativa: rota perdida (${s.route}; ${io}) — NAT/CGNAT sem TURN válido ou peer caiu`
      if ((s.packets_out ?? 0) === 0 && (s.packets_in ?? 0) === 0) {
        return `voz nativa negociando (rota ${s.route}): nenhum pacote trocado ainda — outro lado pode não ter atendido ou SDP/ICE não chegou`
      }
      return `voz nativa conectando via ${s.route} (${io}) — ICE ainda sem par final`
    } catch { return 'voz nativa: falha ao inspecionar a mídia do Rust' }
  }

  getCallFailureReason(): string {
    try {
      if (this.lastFailureCause) return this.lastFailureCause
      const st = this.state
      if (!st) return 'sem chamada ativa'
      if (!supportsCalls()) {
        try { return getCallsUnavailableMessage() } catch { return 'WebRTC indisponível neste aparelho' }
      }
      try { if ((st as any)?.nativeMedia) return this.nativeFailureReason(st) } catch {  }
      if (this.pcs.size === 0) {
        if (st.phase === 'outgoing') return 'aguardando o outro lado atender (sinalização ainda não completou)'
        if (st.phase === 'incoming') return 'aguardando atendimento local'
        return 'nenhuma conexão WebRTC criada (offer ainda não enviada ou peer offline)'
      }
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
        } catch {  }
      }
      if (parts.length > 0) return parts.join(' | ')
      try {
        const micLive = this.localStream?.getAudioTracks().some(t => t.readyState === 'live') ?? false
        const camLive = this.localStream?.getVideoTracks().some(t => t.readyState === 'live') ?? false
        if (!micLive && st.kind !== 'video') return 'conectado, mas sem microfone ativo (permissão negada ou sem dispositivo)'
        if (st.kind === 'video' && st.cameraOn && !camLive) return 'conectado, mas sem câmera ativa (permissão negada, em uso ou sem dispositivo)'
      } catch {  }
      return 'sem falha detectada (mídia negociando ou conectada)'
    } catch { return 'falha desconhecida ao inspecionar a chamada' }
  }

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
          } catch {  }
          out.push(buildPeerDiagnostics(fp, pc, stats, this.iceReports.get(fp) ?? null, st))
        } catch {  }
      }
      if (out.length === 0 && (st as any)?.nativeMedia) {
        try {
          const s = await services.voiceMediaStats(st.callId).catch(() => null)
          if (s) { try { this.lastNativeStats = s } catch {  } }
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
        } catch {  }
      }
    } catch {  }
    return out
  }

  canAccept(callId: string): string | null {
    if (this.accepting.has(callId)) return 'aceitando…'
    if (this.endedCalls.has(callId)) return 'essa chamada já foi encerrada'
    if (this.state && this.state.callId !== callId && isCallPhaseActive(this.state.phase)) {
      return 'já existe uma chamada em andamento — encerre a atual antes de atender outra'
    }
    return null
  }

  private scheduleMicRecovery(callId: string) {
    if (this.micRecoveryTimer || this.micRecoveryAttempts >= 4) return
    const atraso = [1500, 4000, 8000, 15000][this.micRecoveryAttempts] ?? 15000
    this.micRecoveryAttempts += 1
    this.micRecoveryTimer = setTimeout(async () => {
      this.micRecoveryTimer = null
      try {
        const st = this.state
        if (!st || st.callId !== callId) return
        if (st.phase === 'ended' || st.phase === 'failed' || st.phase === 'rejected') return
        if (this.localStream?.getAudioTracks().some((t) => t.readyState === 'live')) return
        const s = await getLocalMedia({ audio: true })
        const track = s?.getAudioTracks()[0]
        if (!track || track.readyState !== 'live') {
          this.scheduleMicRecovery(callId)
          return
        }
        if (this.localStream) {
          try { this.localStream.addTrack(track) } catch {  }
        } else {
          this.localStream = s
        }
        this.micRecoveryAttempts = 0
        const anexados = this.attachMissingLocalTracks()
        for (const fp of anexados) {
          const pc = this.pcs.get(fp)
          if (pc && pc.remoteDescription && pc.signalingState === 'stable') {
            await this.renegotiate(fp, pc).catch(() => {  })
          }
        }
        this.onCallNotice?.('microfone conectado — o áudio começou a sair agora')
        if (this.state) this.onUpdate({ ...this.state })
      } catch {  }
    }, atraso)
  }

  private stopMicRecovery() {
    if (this.micRecoveryTimer) {
      try { clearTimeout(this.micRecoveryTimer) } catch {  }
      this.micRecoveryTimer = null
    }
    this.micRecoveryAttempts = 0
  }

  async forceReset(): Promise<void> {
    const st = this.state
    const cid = st?.callId
    this.leavingCalls.add(cid ?? '__force__')
    try {
      if (cid) {
        try {
          if (cid.startsWith('voice-')) {
            const ch = st?.convId
            const community = ch && cid.endsWith(`-${ch}`)
              ? cid.slice('voice-'.length, cid.length - `-${ch}`.length)
              : ''
            if (community && ch) await services.voiceLeave(community, ch).catch(() => {})
          } else {
            await services.callEnd(cid).catch(() => {})
          }
        } catch {  }
      }
      this.stopOutgoingWatchdog()
      this.stopIncomingWatchdog()
      this.stopConnectWatchdog()
      this.stopReconnectWatchdog()
      this.clearIceRestartTimers()
      this.stopNativeVoiceMonitor()
      this.stopMicRecovery()
      this.stopQualityMonitor()
      this.stopRosterReconcile()
      this.stopRingRetry()
      this.stopCallForeground()
      this.pcs.forEach((pc) => { try { pc.close() } catch {  } })
      this.pcs.clear()
      this.localStream?.getTracks().forEach((t) => { try { t.stop() } catch {  } })
      this.localStream = null
      this.resetScreenRuntime()
      this.resetRelayForNewCall()
      this.pendingIce.clear()
      this.localIce.clear()
      this.pendingOffers.clear()
      this.pendingAnswers.clear()
      this.pendingVoiceJoins.clear()
      this.acceptedCalls.clear()
      this.lastRemoteOffer.clear()
      this.iceReports.clear()
      this.iceRestarts.clear()
      this.pairStuckSince.clear()
      this.soloWaitSince.clear()
      this.accepting.clear()
      this.closeRoom()
      if (cid) this.endedCalls.delete(cid)
      this.state = null
      this.lastPhase = 'ended'
      this.lastFailureCause = null
      this.qualityNotice = null
      this.onUpdate(null as any)
    } finally {
      this.leavingCalls.delete(cid ?? '__force__')
    }
  }

  async leave() {
    const st = this.state
    if (!st) {
      this.closeRoom()
      return
    }
    const cid = st.callId
    if (this.leavingCalls.has(cid)) return
    this.leavingCalls.add(cid)
    try {
      this.applyPhase('hangup')
      this.stopReconnectWatchdog()
      this.clearIceRestartTimers()
      this.stopNativeVoiceMonitor()

      let endSignal: Promise<unknown> = Promise.resolve()
      if (cid.startsWith('voice-')) {
        const ch = st.convId
        const community = ch && cid.endsWith(`-${ch}`)
          ? cid.slice('voice-'.length, cid.length - `-${ch}`.length)
          : ''
        if (community) endSignal = services.voiceLeave(community, ch as string).catch(() => {})
      } else {
        endSignal = services.callEnd(cid).catch(() => {})
      }

      try {
        if ((st as any).nativeMedia) {
          for (const p of st.participants ?? []) {
            if (p.fp && p.fp !== this.myFp) {
              try { void services.voiceVideoStop(cid, p.fp) } catch {  }
            }
          }
        }
      } catch {  }
      this.stopCallForeground()
      this.cleanup(cid)
      await endSignal
      this.refreshRooms()
    } finally {
      this.leavingCalls.delete(cid)
    }
  }

  private refreshRooms() {
    try { this.onRoomsChanged?.() } catch {  }
  }

  async leaveVoice(communityId: string, channelId: string) {
    await services.voiceLeave(communityId, channelId)
    if (this.state?.callId.startsWith('voice-')) {
      this.stopQualityMonitor()
      this.stopReconnectWatchdog()
      this.stopConnectWatchdog()
      this.stopOutgoingWatchdog()
      this.stopIncomingWatchdog()
      this.clearIceRestartTimers()
      this.stopMicRecovery()
      this.stopCallForeground()
      try { this.stopRelayFull() } catch {  }
      this.badWindows = 0
      this.prevLost.clear()
      try { this.lastStats.clear() } catch {  }
      this.lastFailureCause = null
      try { this.lastNativeStats = null } catch {  }
      this.qualityNotice = null
      this.pendingIce.clear()
      this.localIce.clear()
      this.pendingOffers.clear()
      this.pendingAnswers.clear()
      this.pendingVoiceJoins.clear()
      this.acceptedCalls.clear()
      this.lastRemoteOffer.clear()
      this.iceReports.clear()
      this.iceRestarts.clear()
      this.pairStuckSince.clear()
      this.soloWaitSince.clear()
      this.pcs.forEach(pc => { try { pc.close() } catch {  } })
      this.pcs.clear()
      this.localStream?.getTracks().forEach(t => { try { t.stop() } catch {  } })
      this.resetScreenRuntime()
      this.localStream = null
      this.closeRoom()
      this.state = null
      this.lastPhase = 'ended'
      this.leavingCalls.clear()
      this.accepting.clear()
      this.cameraBusy = false
      this.onUpdate(null as any)
    }
  }

  private resetScreenRuntime(): void {
    this.stopScreenStatsTimer()
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch {  }
    this.screenRecoveryTimer = null
    this.screenMonitor.detach()
    this.screenAudioSenders.clear()
    this.screenStream?.getTracks().forEach(t => { try { t.stop() } catch {  } })
    this.screenStream = null
    try {
      for (const p of this.state?.participants ?? []) {
        delete (p as any).videoUrl
        ;(p as any).videoSeq = -1
        ;(p as any).sharing = false
      }
    } catch {  }
    this.screenLastSize = ''
    this.screenMetrics = emptyScreenMetrics()
    this.screenError = null
    this.screenRecoveryAttempts = 0
    this.screenBadSamples = 0
    this.screenGoodSamples = 0
    this.screenStats.reset()
  }

  toggleMute() {
    if (!this.state) return
    this.state.muted = !this.state.muted
    const muted = this.state.muted
    const seen = new Set<MediaStream>()
    for (const s of [this.localStream, this.relayRecStream]) {
      if (!s || seen.has(s)) continue
      seen.add(s)
      try { s.getAudioTracks().forEach(t => { t.enabled = !muted }) } catch {  }
    }
    if ((this.state as any)?.nativeMedia) {
      services.voiceSetMuted(this.state.callId, muted).catch(() => {})
    }
    this.onUpdate({ ...this.state })
  }

  toggleDeafen() {
    if (!this.state) return
    this.state.deafened = !this.state.deafened
    if (this.state.deafened) this.state.muted = true
    try {
      const seen = new Set<MediaStream>()
      for (const s of [this.localStream, this.relayRecStream]) {
        if (!s || seen.has(s)) continue
        seen.add(s)
        s.getAudioTracks().forEach(t => { t.enabled = !this.state!.muted })
      }
    } catch {  }
    if ((this.state as any)?.nativeMedia) {
      services.voiceSetDeafened(this.state.callId, this.state.deafened).catch(() => {})
      if (this.state.deafened) services.voiceSetMuted(this.state.callId, true).catch(() => {})
    }
    this.onUpdate({ ...this.state })
  }

  private async toggleNativeVideo(source: 'camera' | 'screen'): Promise<void> {
    const st = this.state
    if (!st) return
    const on = source === 'camera' ? !st.cameraOn : !st.sharing
    const targets = st.participants.filter(p => p.fp && p.fp !== this.myFp)
    if (on) {
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
    } else {
      for (const p of targets) {
        try { await services.voiceVideoStop(st.callId, p.fp) } catch {  }
      }
      if (source === 'camera') st.cameraOn = false
      else {
        st.sharing = false
        this.broadcastScreenSignal(false)
      }
    }
    this.onUpdate({ ...st })
  }

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
            } catch {  }
          }).catch(() => {  })
        }
      }, 40)
    } catch { this.nativeVideoTimer = null }
  }
  private stopNativeVideoMonitor() {
    try { if (this.nativeVideoTimer) clearInterval(this.nativeVideoTimer) } catch {  }
    this.nativeVideoTimer = null
    this.nativeVideoSeqs.clear()
  }

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
      }).catch(() => {  })
    }
    try {
      this.rosterTimer = setInterval(tick, 10_000)
    } catch { this.rosterTimer = null }
    this.startMeshRepair(callId)
  }

  private startMeshRepair(callId: string) {
    this.stopMeshRepair()
    try {
      this.repairTimer = setInterval(() => {
        const st = this.state
        if (!st || st.callId !== callId) { this.stopMeshRepair(); return }
        if (!isCallPhaseActive(st.phase)) return
        if (st.phase === 'connecting') {
          for (const pc of this.pcs.values()) {
            const cs = (pc as any).connectionState
            const ice = pc.iceConnectionState
            if (cs === 'connected' || ice === 'connected' || ice === 'completed') {
              this.applyPhase('media-connected')
              break
            }
          }
        }
        this.announceSelfToRoom(callId)
        void this.repairHalfOpenPairs().catch(() => {  })
      }, 15_000)
    } catch { this.repairTimer = null }
  }

  private stopMeshRepair() {
    try { if (this.repairTimer) clearInterval(this.repairTimer) } catch {  }
    this.repairTimer = null
  }

  private stopRosterReconcile() {
    try { if (this.rosterTimer) clearInterval(this.rosterTimer) } catch {  }
    this.rosterTimer = null
    this.stopMeshRepair()
  }

  private findVideoTransceiver(pc: RTCPeerConnection): RTCRtpTransceiver | null {
    try {
      const withTrack = pc.getTransceivers().find(t => t.sender?.track?.kind === 'video')
      if (withTrack) return withTrack
      return pc.getTransceivers().find(t => (t as any)?.receiver?.track?.kind === 'video') ?? null
    } catch { return null }
  }

  private findVideoSender(pc: RTCPeerConnection): RTCRtpSender | null {
    try {
      return this.findVideoTransceiver(pc)?.sender
        ?? pc.getSenders().find(s => s.track?.kind === 'video')
        ?? null
    } catch { return null }
  }

  private hasLiveCamera(): boolean {
    try {
      return !!this.localStream?.getVideoTracks().some(t => t.readyState === 'live')
    } catch { return false }
  }

  /** Manda a track de câmera para TODOS os pares, promovendo a m-line de
   *  vídeo para envio. Devolve quantos pares confirmaram o envio. */
  private async publicarCameraEmTodos(track: MediaStreamTrack): Promise<number> {
    const st = this.state
    if (!st) return 0
    let ok = 0
    for (const [fp, pc] of this.pcs) {
      try {
        if (pc.signalingState === 'closed') continue
        const tr = this.findVideoTransceiver(pc)
        let precisaOffer = false
        if (tr) {
          const anterior = tr.sender?.track?.id ?? null
          precisaOffer = setCallVideoSending(tr, true)
          await tr.sender.replaceTrack(track)
          if (!precisaOffer && anterior !== track.id) precisaOffer = true
        } else {
          pc.addTrack(track, this.localStream ?? new MediaStream([track]))
          precisaOffer = true
        }
        if (precisaOffer) {
          const saiu = await this.enviarOfferComRetry(fp, st.callId)
          if (!saiu) {
            this.marcarRenegociacaoPendente(fp)
            continue
          }
        }
        const sender = tr?.sender ?? pc.getSenders().find((s) => s.track === track) ?? null
        if (sender) await applyCameraTuning(sender, this.cameraQuality())
        ok++
      } catch {  }
    }
    return ok
  }

  /** Renegociação que insiste um pouco: uma offer perdida deixava a câmera
   *  "ligada" sem vídeo saindo — e no canal de servidor há mais pares
   *  disputando a mesma fila de negociação. */
  private async enviarOfferComRetry(fp: string, callId: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      if (await this.sendOffer(fp, callId)) return true
      if (!this.state || this.state.callId !== callId) return false
      await new Promise<void>((r) => setTimeout(r, 350))
    }
    return false
  }

  /** Troca o feed da câmera AGORA, sem reiniciar a chamada.
   *  `reverter` devolve a preferência anterior e é chamado antes de reabrir. */
  private async trocarFeedDeCamera(opts: {
    soltarAntes: boolean
    reverter?: () => void
  }): Promise<boolean> {
    const st = this.state
    if (!st) return false
    const antigo = this.localStream?.getVideoTracks()[0] ?? null
    if (opts.soltarAntes) {
      try { antigo?.stop() } catch {  }
      if (antigo && this.localStream) try { this.localStream.removeTrack(antigo) } catch {  }
      await new Promise<void>((r) => setTimeout(r, 60))
    }
    const constraints: MediaTrackConstraints = {}
    let novo: MediaStream | null = null
    try {
      novo = await getLocalMedia({ video: constraints })
      const track = novo?.getVideoTracks()[0] ?? null
      if (!track) throw new Error('a câmera escolhida não entregou imagem')
      setCameraContentHint(track)
      if (!this.localStream) {
        try { this.localStream = new MediaStream([track]) } catch { this.localStream = null }
      } else {
        try { this.localStream.addTrack(track) } catch {  }
      }
      if (!this.localStream) throw new Error('não foi possível montar o stream local')
      await this.publicarCameraEmTodos(track)
      st.cameraOn = true
      if (!opts.soltarAntes) {
        try { antigo?.stop() } catch {  }
        if (antigo && this.localStream) try { this.localStream.removeTrack(antigo) } catch {  }
      }
      return true
    } catch (e) {
      try { novo?.getTracks().forEach((t) => { try { t.stop() } catch {  } }) } catch {  }
      if (antigo) {
        try { opts.reverter?.() } catch {  }
        try {
          const volta = await getLocalMedia({ video: constraints })
          const track = volta?.getVideoTracks()[0] ?? null
          if (track) {
            if (!this.localStream) this.localStream = new MediaStream([track])
            else try { this.localStream.addTrack(track) } catch {  }
            await this.publicarCameraEmTodos(track)
            st.cameraOn = true
          }
        } catch {  }
      }
      throw e
    }
  }

  async toggleCamera() {
    if (!this.state) return
    if ((this.state as any)?.nativeMedia) {
      await this.toggleNativeVideo('camera')
      return
    }
    if (this.cameraBusy) return
    if (!this.state.cameraOn && this.state.sharing) {
      try {
        this.onCallNotice?.('a tela está no ar — pare o compartilhamento para ligar a câmera')
      } catch {  }
      return
    }
    this.cameraBusy = true
    try {
      if (this.state.cameraOn) {
        const mine = this.localStream
        const camTrack = mine?.getVideoTracks()[0] ?? null
        if (mine) {
          if (!this.state.sharing) {
            for (const pc of this.pcs.values()) {
              try {
                const sender = this.findVideoSender(pc)
                if (!sender) continue
                if (sender.track && camTrack && sender.track.id !== camTrack.id) continue
                await sender.replaceTrack(null)
              } catch {  }
            }
          }
          for (const t of mine.getVideoTracks()) {
            try { t.stop() } catch {  }
            try { mine.removeTrack(t) } catch {  }
          }
        }
        this.state.cameraOn = false
      } else {
        const constraints: MediaTrackConstraints = {
          ...videoConstraintsFromPrefs(getCallMediaPrefs()),
          ...QUALITY_CONSTRAINTS[this.quality],
        }
        const vs = await getLocalMedia({ video: constraints })
        const track = vs?.getVideoTracks()[0]
        if (!track) {
          this.state.cameraOn = false
          return
        }
        try { vs?.getTracks().forEach((t) => { if (t !== track) t.stop() }) } catch {  }
        if (!this.localStream) {
          try { this.localStream = new MediaStream([track]) }
          catch { this.localStream = null }
        } else {
          try { this.localStream.addTrack(track) } catch {  }
        }
        setCameraContentHint(track)
        if (!this.localStream) return
        const sent = await this.publicarCameraEmTodos(track)
        if (this.pcs.size > 0 && sent === 0) {
          try { track.stop() } catch {  }
          try { this.localStream?.removeTrack(track) } catch {  }
          this.state.cameraOn = false
          try {
            this.onCallNotice?.('não foi possível enviar a câmera — a negociação com os outros não completou')
          } catch {  }
        } else {
          this.state.cameraOn = true
        }
      }
    } catch (e) {
      try { localMediaNotice?.(describeMediaError(e) ?? `falha ao abrir a câmera (${(e as Error)?.name ?? 'erro'})`) } catch {  }
    } finally {
      this.cameraBusy = false
    }
    this.onUpdate({ ...this.state })
  }

  async toggleScreen(): Promise<void> {
    return this.enqueueScreenOp(async () => {
      if (this.state?.sharing) await this.stopScreenShareNow()
      else await this.startScreenShareNow()
    })
  }

  private enqueueScreenOp<T>(op: () => Promise<T>): Promise<T> {
    const next = this.screenOp.then(op, op)
    this.screenOp = next.catch(() => {})
    return next
  }

  async startScreenShare(opts?: Partial<ScreenShareOptions>): Promise<void> {
    return this.enqueueScreenOp(() => this.startScreenShareNow(opts))
  }

  private async startScreenShareNow(opts?: Partial<ScreenShareOptions>): Promise<void> {
    if (!this.state) {
      throw new ScreenShareError('no-source', 'entre na chamada antes de compartilhar a tela', false)
    }
    const gen = ++this.screenGen
    if ((this.state as any)?.nativeMedia) {
      const next = normalizeOptions(opts, this.screenOptions)
      if (next.source === 'window' || next.source === 'monitor') {
        const msg = 'no caminho nativo a captura é sempre da tela inteira — janela ou monitor específico não é suportado'
        this.setScreenError('unsupported', msg)
        throw new ScreenShareError('unsupported', msg, false)
      }
      const wantsSystem = next.audio === 'system' || next.audio === 'system+mic'
      if (wantsSystem) {
        try { this.onCallNotice?.('o caminho nativo não captura áudio do sistema — compartilhando só a tela (o microfone da chamada continua ativo)') } catch {  }
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
    if (this.pcs.size === 0) {
      this.onCallNotice?.('preparando a tela — ela começa a ser enviada quando a chamada conectar')
    }
    this.screenOptions = normalizeOptions(opts, this.screenOptions)
    this.screenQualityCeiling = ceilingOf(this.screenOptions.quality)

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
      try { stream.getTracks().forEach(t => { try { t.stop() } catch {  } }) } catch {  }
      const err = new ScreenShareError('no-source', 'nenhuma trilha de vídeo na tela compartilhada', true)
      this.setScreenError(err.code, err.message)
      throw err
    }
    if (gen !== this.screenGen || !this.state) {
      try { stream.getTracks().forEach(t => { try { t.stop() } catch {  } }) } catch {  }
      return
    }

    try { this.stopScreenStreamOnly() } catch {  }
    this.screenStream = stream
    this.state.sharing = true
    this.onUpdate({ ...this.state })
    this.screenError = null
    try {
      const queriaAudio = this.screenOptions.audio === 'system' || this.screenOptions.audio === 'system+mic'
      if (queriaAudio && stream.getAudioTracks().length === 0) {
        this.noteScreenEvent('tela compartilhada SEM áudio do sistema (este WebView não entregou o áudio)')
      }
    } catch {  }
    this.screenRecoveryAttempts = 0
    this.screenBadSamples = 0
    this.screenGoodSamples = 0
    this.screenStats.reset()
    this.screenMetrics = emptyScreenMetrics()
    this.watchScreenTrack(track, gen)
    this.screenMonitor.attach(track)
    await this.tuneScreenTrack(track)
    try {
      const audioTracks = await this.collectScreenAudioTracks(stream)
      await this.seedScreenPeers(stream, track, audioTracks)
    } catch (e) {
      if (gen === this.screenGen) {
        this.stopScreenStatsTimer()
        try { await this.clearScreenAudioSenders() } catch {  }
        this.stopScreenStreamOnly()
        this.screenMonitor.detach()
        this.screenLastSize = ''
        this.state.sharing = false
        try { await this.restoreCameraAfterScreen() } catch {  }
      }
      const cameraOn = !!this.localStream?.getVideoTracks().some(cam => cam.readyState === 'live' && cam.enabled)
      this.broadcastScreenSignal(false, cameraOn)
      this.onUpdate({ ...this.state })
      const err = e instanceof ScreenShareError
        ? e
        : new ScreenShareError('unknown', String((e as Error)?.message ?? e), true, e)
      this.setScreenError(err.code, err.message)
      throw err
    }
    if (gen !== this.screenGen) return
    this.startScreenStatsTimer()
    this.broadcastScreenSignal(true, false)
    this.onUpdate({ ...this.state })
    void services.hideShareBar?.().catch(() => {})
  }

  async ensureShareBarHidden(): Promise<void> {
    try { await services.hideShareBar?.() } catch {  }
  }

  private async acquireScreenStream(opts: ScreenShareOptions): Promise<MediaStream> {
    const md: any = (typeof navigator !== 'undefined' ? (navigator as any).mediaDevices : null)
    if (!md?.getDisplayMedia) throw new ScreenShareError('unsupported', SCREEN_UNAVAILABLE_MSG, false)
    const constraints = buildDisplayMediaConstraints(opts, this.screenEnv)
    try {
      return await md.getDisplayMedia(constraints) as MediaStream
    } catch (e) {
      const derived = derivedDisplayConstraints(constraints)
      if (derived) {
        try {
          return await md.getDisplayMedia(derived) as MediaStream
        } catch { /* cai para o último degrau */ }
      }
      try {
        return await md.getDisplayMedia({ video: true, audio: false } as never) as MediaStream
      } catch {
        try {
          return await md.getDisplayMedia({ video: true } as never) as MediaStream
        } catch {
          throw e
        }
      }
    }
  }

  private watchScreenTrack(track: MediaStreamTrack, gen: number): void {
    try {
      const aindaAtual = () => gen === this.screenGen && this.screenStream?.getVideoTracks()[0] === track
      track.onended = () => {
        if (!aindaAtual()) return
        void this.handleScreenEnded(gen)
      }
      track.onmute = () => {
        if (!aindaAtual()) return
        this.screenTrackMuted = true
        this.noteScreenEvent('captura pausada pelo sistema (fonte oculta, monitor trocado ou app em segundo plano)')
      }
      track.onunmute = () => {
        if (!aindaAtual()) return
        this.screenTrackMuted = false
        this.screenStats.reset()
        this.screenBadSamples = 0
        this.noteScreenEvent('captura retomada')
      }
    } catch {  }
  }

  private async handleScreenEnded(gen: number): Promise<void> {
    if (!this.state?.sharing || gen !== this.screenGen) return
    const msg = 'o compartilhamento de tela foi encerrado pelo sistema'
    this.setScreenError('ended', msg)
    try { this.onCallNotice?.(msg) } catch {  }
    await this.stopScreenShare()
  }

  private async tuneScreenTrack(track: MediaStreamTrack): Promise<void> {
    setScreenContentHint(track, this.screenOptions.source)
    await applyScreenConstraints(track, this.screenOptions)
    try {
      const st = track.getSettings()
      this.screenLastSize = `${st.width ?? 0}x${st.height ?? 0}`
    } catch {  }
    await this.applyScreenSenderTuning()
  }

  private async applyScreenSenderTuning(): Promise<void> {
    for (const pc of this.pcs.values()) {
      try {
        const sender = this.findVideoSender(pc)
        if (!sender) continue
        await applySenderTuning(sender, this.screenOptions)
      } catch {  }
    }
  }

  private scheduleRetune(): void {
    try { if (this.retuneTimer) clearTimeout(this.retuneTimer) } catch {  }
    this.retuneTimer = setTimeout(() => {
      this.retuneTimer = null
      for (const pc of this.pcs.values()) void this.retuneSenders(pc).catch(() => {})
    }, 1500)
  }

  private retuneTimer: ReturnType<typeof setTimeout> | null = null

  private async retuneSenders(pc: RTCPeerConnection): Promise<void> {
    try {
      if (pc.signalingState === 'closed') return
      const sender = this.findVideoSender(pc)
      if (sender?.track) {
        if (this.state?.sharing) await applySenderTuning(sender, this.screenOptions)
        else await applyCameraTuning(sender, this.cameraQuality())
      }
      const audio = pc.getSenders().find((s) => s.track?.kind === 'audio') ?? null
      if (audio) await this.applyAudioBitrate(audio)
    } catch {  }
  }

  private cameraQuality(): '480p' | '720p' | '1080p' | '4K' {
    try { return getCallMediaPrefs().quality } catch { return this.quality }
  }

  private async applyAudioBitrate(sender: RTCRtpSender): Promise<boolean> {
    try {
      const params = sender.getParameters()
      if (!params.encodings || params.encodings.length === 0) return false
      const enc = params.encodings[0] as RTCRtpEncodingParameters & { maxBitrate?: number }
      enc.maxBitrate = 64000
      enc.priority = 'high'
      await sender.setParameters(params)
      return true
    } catch { return false }
  }

  private async seedScreenPeers(stream: MediaStream, track: MediaStreamTrack, audioTracks: MediaStreamTrack[] = []): Promise<void> {
    const failures: string[] = []
    let peersSeeded = 0
    for (const [fp, pc] of this.pcs) {
      try {
        if (pc.signalingState === 'closed') continue
        const transceiver = this.findVideoTransceiver(pc)
        let needsOffer = false
        if (transceiver) {
          const anterior = transceiver.sender?.track?.id ?? null
          needsOffer = setCallVideoSending(transceiver, true)
          await transceiver.sender.replaceTrack(track)
          if (!needsOffer && anterior !== track.id) needsOffer = true
        } else {
          pc.addTrack(track, stream)
          needsOffer = true
        }
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
          } catch {  }
        }
        if (needsOffer) {
          if (!this.state) throw new Error('chamada encerrada durante o compartilhamento')
          const saiu = await this.enviarOfferComRetry(fp, this.state.callId)
          if (!saiu) {
            this.marcarRenegociacaoPendente(fp)
            throw new Error('negociação ocupada; não foi possível enviar a nova track agora')
          }
        }
        peersSeeded++
      } catch (e) {
        failures.push(`${fp.slice(0, 6)}: ${String((e as Error)?.message ?? e)}`)
      }
    }
    if (failures.length) {
      const notice = `não foi possível negociar a tela com ${failures.join('; ')}`
      try { this.onCallNotice?.(notice) } catch {  }
      if (this.pcs.size > 0 && peersSeeded === 0) {
        throw new ScreenShareError('unknown', notice, true)
      }
    }
    await this.applyScreenSenderTuning()
    this.scheduleRetune()
  }

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
      if (!live) {
        const captured = await this.captureShareMicrophone()
        if (captured) {
          this.attachMissingLocalTracks()
        } else this.noteScreenEvent('microfone indisponível — compartilhando sem a sua voz')
      }
    }
    return out
  }

  private async captureShareMicrophone(): Promise<MediaStreamTrack | null> {
    let captured: MediaStream | null
    try {
      captured = await getLocalMedia({ audio: { ...AUDIO_CONSTRAINTS }, video: false })
    } catch { return null }
    const track = captured?.getAudioTracks()[0] ?? null
    if (!track) return null
    try { track.enabled = !this.state?.muted } catch {  }
    try {
      if (this.localStream) this.localStream.addTrack(track)
      else this.localStream = captured
    } catch {  }
    return track
  }

  private async clearScreenAudioSenders(): Promise<void> {
    for (const [pc, sender] of this.screenAudioSenders) {
      try {
        if (pc.signalingState !== 'closed' && pc.getSenders().includes(sender)) await sender.replaceTrack(null)
      } catch {  }
    }
    this.screenAudioSenders.clear()
  }

  async stopScreenShare(): Promise<void> {
    return this.enqueueScreenOp(() => this.stopScreenShareNow())
  }

  private async stopScreenShareNow(): Promise<void> {
    if (!this.state) return
    this.screenGen += 1
    if ((this.state as any)?.nativeMedia) {
      await this.toggleNativeVideo('screen')
      return
    }
    this.stopScreenStatsTimer()
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch {  }
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

  private stopScreenStreamOnly(): void {
    const tracks = this.screenStream?.getTracks() ?? []
    for (const t of tracks) {
      if (t.kind !== 'video') continue
      try { t.stop() } catch {  }
    }
    const micTrack = this.localStream?.getAudioTracks()[0] ?? null
    for (const t of tracks) {
      if (t.kind !== 'audio' || t === micTrack) continue
      try { t.stop() } catch {  }
    }
    this.screenStream = null
  }

  private async restoreCameraAfterScreen(): Promise<void> {
    const cam = this.localStream?.getVideoTracks().find(tr => tr.readyState === 'live') ?? null
    for (const [fp, pc] of this.pcs) {
      try {
        if (pc.signalingState === 'closed') continue
        const transceiver = this.findVideoTransceiver(pc)
        let needsOffer = false
        if (transceiver) {
          const anterior = transceiver.sender?.track?.id ?? null
          needsOffer = setCallVideoSending(transceiver, !!cam)
          await transceiver.sender.replaceTrack(cam)
          if (!needsOffer && (cam?.id ?? null) !== anterior) needsOffer = true
        } else if (cam && this.localStream) {
          pc.addTrack(cam, this.localStream)
          needsOffer = true
        }
        if (needsOffer && this.state) {
          const saiu = await this.enviarOfferComRetry(fp, this.state.callId)
          if (!saiu) this.marcarRenegociacaoPendente(fp)
        }
      } catch {  }
    }
  }

  async setScreenShareOptions(patch: Partial<ScreenShareOptions>): Promise<void> {
    const prev = this.screenOptions
    const next = normalizeOptions(patch, this.screenOptions)
    this.screenOptions = next
    if (patch.quality) this.screenQualityCeiling = ceilingOf(patch.quality)
    this.screenEnv = detectScreenEnvironment(getScreenShareBackend() === 'native')
    if (!this.state?.sharing) return
    const sourceChanged = next.source !== prev.source
    const audioChanged = next.audio !== prev.audio
    if (sourceChanged || audioChanged) {
      await this.enqueueScreenOp(() => this.recaptureScreen(next))
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

  private async recaptureScreen(opts: ScreenShareOptions): Promise<void> {
    const gen = ++this.screenGen
    const wasSharing = !!this.state?.sharing
    try {
      const stream = await this.acquireScreenStream(opts)
      const track = stream.getVideoTracks()[0]
      if (!track) {
        try { stream.getTracks().forEach(t => { try { t.stop() } catch {  } }) } catch {  }
        throw new ScreenShareError('no-source', 'nenhuma trilha de vídeo na tela compartilhada', true)
      }
      if (gen !== this.screenGen || !this.state) {
        try { stream.getTracks().forEach(t => { try { t.stop() } catch {  } }) } catch {  }
        return
      }
      this.stopScreenStatsTimer()
      await this.clearScreenAudioSenders()
      this.stopScreenStreamOnly()
      this.screenMonitor.detach()
      this.screenStream = stream
      this.watchScreenTrack(track, gen)
      this.screenMonitor.attach(track)
      await this.tuneScreenTrack(track)
      const audioTracks = await this.collectScreenAudioTracks(stream)
      await this.seedScreenPeers(stream, track, audioTracks)
      if (gen !== this.screenGen) return
      this.startScreenStatsTimer()
      if (!wasSharing && this.state) {
        this.state.sharing = true
        this.broadcastScreenSignal(true)
      }
      this.screenError = null
      if (this.state) this.onUpdate({ ...this.state })
      void services.hideShareBar?.().catch(() => {})
    } catch (e) {
      const err = classifyScreenShareError(e)
      this.setScreenError(err.code, err.message)
      if (this.state && !wasSharing && gen === this.screenGen) {
        this.state.sharing = false
        this.broadcastScreenSignal(false)
        this.onUpdate({ ...this.state })
      }
      throw err
    }
  }

  private scheduleScreenRecovery(reason: string): void {
    if (!this.state?.sharing) return
    if (this.screenRecoveryAttempts >= CallManager.SCREEN_MAX_RECOVERY) {
      this.noteScreenEvent(`recuperação automática desistiu após ${CallManager.SCREEN_MAX_RECOVERY} tentativas (${reason})`)
      return
    }
    this.screenRecoveryAttempts += 1
    this.noteScreenEvent(`recuperando a captura (${reason}) — tentativa ${this.screenRecoveryAttempts}/${CallManager.SCREEN_MAX_RECOVERY}`)
    try { if (this.screenRecoveryTimer) clearTimeout(this.screenRecoveryTimer) } catch {  }
    const delay = Math.min(8000, 800 * this.screenRecoveryAttempts)
    this.screenRecoveryTimer = setTimeout(() => {
      this.screenRecoveryTimer = null
      void this.recoverScreen(reason)
    }, delay)
  }

  private async recoverScreen(reason: string): Promise<void> {
    if (!this.state?.sharing) return
    try {
      await this.enqueueScreenOp(async () => {
        const track = this.screenStream?.getVideoTracks()[0] ?? null
        if (!track || track.readyState !== 'live') {
          await this.recaptureScreen(this.screenOptions)
          return
        }
        await applyScreenConstraints(track, this.screenOptions)
        await this.applyScreenSenderTuning()
        this.screenStats.reset()
        this.noteScreenEvent(`captura recuperada (${reason})`)
      })
    } catch {
      await this.enqueueScreenOp(() => this.recaptureScreen(this.screenOptions)).catch(() => {})
    }
  }

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
    this.startShareBarWatch()
  }

  private startShareBarWatch(): void {
    if (!isWindowsRuntime()) return
    try {
      void services.shareBarWatch?.(true).catch(() => {  })
      void services.hideShareBar?.().catch(() => {  })
    } catch {  }
  }

  private stopShareBarWatch(): void {
    try { void services.shareBarWatch?.(false).catch(() => {  }) } catch {  }
  }

  private stopScreenStatsTimer(): void {
    try { if (this.screenStatsTimer) clearInterval(this.screenStatsTimer) } catch {  }
    this.screenStatsTimer = null
    this.stopShareBarWatch()
  }

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
        } catch {  }
      }
      const prevRtt = this.screenMetrics.rttMs
      this.screenMetrics = this.screenStats.read(stats, capture, prevRtt)
      this.checkScreenGeometry()
      this.adaptScreenQuality()
      this.emitScreenDebug()
      void this.ensureShareBarHidden()
    } catch {  }
  }

  private adaptScreenQuality(): void {
    if (this.screenTrackMuted) return
    if (this.screenOptions.quality === 'auto') {
      if (!isScreenSampleBad(this.screenMetrics)) return
      this.screenOptions = { ...this.screenOptions, quality: this.screenQualityCeiling }
    }
    const m = this.screenMetrics
    if (isScreenSampleBad(m)) {
      this.screenGoodSamples = 0
      this.screenBadSamples += 1
      if (this.screenBadSamples < 2) return
      this.screenBadSamples = 0
      const next = lowerScreenQuality(this.screenOptions.quality)
      if (next === this.screenOptions.quality) return
      this.screenOptions = { ...this.screenOptions, quality: next }
      const track = this.screenStream?.getVideoTracks()[0] ?? null
      if (track) void applyScreenConstraints(track, this.screenOptions)
      void this.applyScreenSenderTuning()
      this.noteScreenEvent(`qualidade da tela ajustada para ${next} (rede ruim)`)
      this.emitScreenDebug()
      return
    }
    this.screenBadSamples = 0
    if (this.screenRecoveryAttempts > 0) this.screenRecoveryAttempts = 0
    if (this.screenOptions.quality === this.screenQualityCeiling) return
    this.screenGoodSamples += 1
    if (this.screenGoodSamples < 15) return
    this.screenGoodSamples = 0
    const up = raiseScreenQuality(this.screenOptions.quality)
    if (up === this.screenOptions.quality) return
    if (compareQuality(up, this.screenQualityCeiling) > 0) return
    this.screenOptions = { ...this.screenOptions, quality: up }
    const track = this.screenStream?.getVideoTracks()[0] ?? null
    if (track) void applyScreenConstraints(track, this.screenOptions)
    void this.applyScreenSenderTuning()
    this.noteScreenEvent(`qualidade da tela voltou para ${up}`)
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
    } catch {  }
  }

  getScreenShareOptions(): ScreenShareOptions {
    return { ...this.screenOptions }
  }

  getScreenShareEnvironment(): ScreenEnvironment {
    this.screenEnv = detectScreenEnvironment(getScreenShareBackend() === 'native')
    return this.screenEnv
  }

  getScreenShareMetrics(): ScreenShareMetrics & { options: ScreenShareOptions; env: ScreenEnvironment; error: { code: ScreenShareErrorCode; message: string } | null } {
    return { ...this.screenMetrics, options: { ...this.screenOptions }, env: this.screenEnv, error: this.screenError }
  }

  getScreenShareError(): { code: ScreenShareErrorCode; message: string } | null {
    return this.screenError
  }

  setScreenSource(src: 'monitor' | 'window'): void {
    this.screenSource = src === 'window' ? 'window' : 'monitor'
    const source = src === 'window' ? 'window' : 'screen'
    this.screenOptions = { ...this.screenOptions, source }
  }

  getScreenSource(): 'monitor' | 'window' {
    return this.screenSource
  }

  addParticipant(fp: string, nickname: string) {
    if (!this.state) return
    if (fp === this.myFp) return
    if (!this.state.participants.find(p => p.fp === fp)) {
      this.state.participants.push({ fp, nickname })
    }
    this.createPC(fp, this.state.callId, true).catch(() => {})
    for (const p of this.state.participants) {
      if (!p.fp || p.fp === this.myFp) continue
      const kind = p.fp === fp ? (this.state.kind ?? 'voice') : ''
      services.callAddParticipant(p.fp, this.state.callId, fp, kind).catch(() => {})
    }
    this.onUpdate({ ...this.state })
  }

  private announceSelfToRoom(callId: string) {
    const st = this.state
    if (!st || st.callId !== callId || !this.myFp) return
    const outros = st.participants
      .map(p => p.fp)
      .filter(fp => !!fp && fp !== this.myFp)
    if (outros.length === 0) return
    for (const porta of outros) {
      for (const fp of outros) {
        if (fp === porta) continue
        services.callAddParticipant(porta, callId, fp, '').catch(() => {})
      }
      if (!this.pcs.has(porta)) {
        void this.createPC(porta, callId, true).catch(() => {  })
      }
    }
  }

  private isPolite(peerFp: string): boolean {
    return this.myFp > peerFp
  }

  private attachLocalStreamToPC(pc: RTCPeerConnection) {
    try {
      const streams: MediaStream[] = []
      if (this.localStream) streams.push(this.localStream)
      if (this.screenStream && this.screenStream !== this.localStream) streams.push(this.screenStream)
      for (const s of streams) {
        for (const t of s.getTracks()) {
          try {
            const already = pc.getSenders().some(x => x.track === t)
            if (already) continue
            if (t.kind === 'video') {
              const tr = this.findVideoTransceiver(pc)
              if (tr && !tr.sender.track) {
                try { setCallVideoSending(tr, true) } catch {  }
                tr.sender.replaceTrack(t).catch(() => {  })
                continue
              }
            }
            pc.addTrack(t, s)
          } catch {  }
        }
      }
    } catch {  }
    this.ensureMlines(pc)
  }

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
    } catch {  }
  }

  private attachMissingLocalTracks(): string[] {
    const changed: string[] = []
    for (const [fp, pc] of this.pcs) {
      try {
        const antes = new Set(pc.getSenders().map((s) => s.track).filter(Boolean))
        this.attachLocalStreamToPC(pc)
        const ganhou = pc.getSenders().some((s) => s.track && !antes.has(s.track))
        if (ganhou) changed.push(fp)
      } catch {  }
    }
    return changed
  }

  private async ensureMediaOnAllPCs(): Promise<void> {
    const changed = this.attachMissingLocalTracks()
    for (const fp of changed) {
      const pc = this.pcs.get(fp)
      if (pc && pc.remoteDescription && pc.signalingState === 'stable') await this.renegotiate(fp, pc)
    }
  }

  private wirePC(pc: RTCPeerConnection, fp: string, callId: string) {
    logIceState(pc, fp, callId)
    pc.ontrack = (e) => {
      try {
        if (this.pcs.get(fp) !== pc) return
        const st = (e.streams && e.streams[0]) ?? (e.track ? new MediaStream([(e.track as MediaStreamTrack)]) : null)
        if (!st) return
        // Stream sem nenhuma trilha viva não é mídia: é resíduo de negociação.
        const temViva = (st.getTracks?.() ?? []).some((t) => t.readyState === 'live')
        if (!temViva) return
        if (this.state) attachRemoteTrack(this.state, (s) => this.onUpdate(s), fp, st)
      } catch {  }
      try {
        const st2 = this.state
        if (st2 && st2.callId === callId) {
          const connOk = (pc as any).connectionState === 'connected'
          if (connOk) this.applyPhase('media-connected')
          else this.promoteOnSignal(callId)
        }
      } catch {  }
    }
    pc.onicecandidate = (e) => {
      if (!e.candidate) {
        this.resendLocalIce(fp, pc, callId)
        return
      }
      this.sendLocalIce(fp, callId, e.candidate, pc)
    }
    try {
      pc.addEventListener('iceconnectionstatechange', () => {
        try {
          if (pc.iceConnectionState === 'failed') void this.tryIceRestart(fp, pc, callId)
          if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
            try {
              const st = this.state
              if (st && st.callId === callId) this.promoteOnSignal(callId)
            } catch {  }
          }
        } catch {  }
      })
    } catch {  }
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
        } catch {  }
      })
    } catch {  }
  }

  private sendLocalIce(fp: string, callId: string, cand: RTCIceCandidate, pc: RTCPeerConnection) {
    try {
      if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
      const list = this.localIce.get(fp) ?? []
      list.push(cand)
      this.localIce.set(fp, list)
      void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
    } catch {  }
  }

  private resendLocalIce(fp: string, pc: RTCPeerConnection, callId: string) {
    try {
      if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
      for (const cand of this.localIce.get(fp) ?? []) {
        void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
      }
      const anyPc = pc as unknown as { getLocalCandidates?: () => Promise<RTCIceCandidate[]> }
      void anyPc.getLocalCandidates?.().then((rest: RTCIceCandidate[] | null | undefined) => {
        if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
        for (const cand of rest ?? []) {
          void services.callIce(fp, callId, JSON.stringify(cand), cand.sdpMid ?? '0').catch(() => {})
        }
      }).catch(() => {})
    } catch {  }
  }

  private startNativeVoiceMonitor(callId: string) {
    this.stopNativeVoiceMonitor()
    this.nativeVoiceSince = -1
    this.startNativeVideoMonitor(callId)
    const t = setInterval(() => {
      const st = this.state
      if (!st || st.callId !== callId) { this.stopNativeVoiceMonitor(); return }
      if (this.nativeVoiceSince < 0) this.nativeVoiceSince = Date.now()
      const waited = this.nativeVoiceSince > 0 ? Date.now() - this.nativeVoiceSince : 0
      void services.voiceMediaStats(callId).then((s) => {
        if (!this.state || this.state.callId !== callId) return
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
        try { this.lastNativeStats = s } catch {  }
        if (nativeRoute !== s.route) { nativeRoute = s.route; this.onUpdate({ ...this.state }) }
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
        } catch {  }
        if (s.state === 'connected') {
          this.nativeVoiceSince = -1
          this.applyPhase('media-connected')
        } else if (this.nativeCallIsDead(s, waited)) {
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
          this.setFailureCause(
            `um participante sem rota de mídia (${s.route}; ${s.peers_connected ?? '?'}/${s.peers_total ?? '?'} conectados)`,
          )
        }
      }).catch(() => {  })
    }, 700)
    this.nativeVoiceTimer = t
  }

  private stopNativeVoiceMonitor() {
    if (this.nativeVoiceTimer) { clearInterval(this.nativeVoiceTimer); this.nativeVoiceTimer = null }
    this.stopNativeVideoMonitor()
  }

  private nativeCallIsDead(
    s: { state?: string | null; peers_connected?: number | null; peers_total?: number | null },
    waited: number,
  ): boolean {
    const connected = typeof s.peers_connected === 'number' ? s.peers_connected : null
    if (connected !== null && connected > 0) return false
    if (s.state === 'failed') return true
    return waited > CallManager.NATIVE_VOICE_TIMEOUT_MS
  }

  private async tryIceRestart(fp: string, pc: RTCPeerConnection, callId: string, force = false) {
    try {
      if (!force && pc.iceConnectionState !== 'failed') return
      if (pc.signalingState !== 'stable') return
      if (this.iceRestartTimers.has(fp)) return
      const n = this.iceRestarts.get(fp) ?? 0
      if (n >= CallManager.MAX_ICE_RESTARTS) return
      this.iceRestarts.set(fp, n + 1)
      const wait = CallManager.ICE_RESTART_BACKOFF_MS[Math.min(n, CallManager.ICE_RESTART_BACKOFF_MS.length - 1)]
      const t = setTimeout(() => {
        this.iceRestartTimers.delete(fp)
        void this.doIceRestart(fp, callId, force).catch(() => {})
      }, wait)
      this.iceRestartTimers.set(fp, t)
    } catch {  }
  }

  private restartIceAll(callId: string, forceAll = false) {
    for (const [fp, pc] of this.pcs) {
      try {
        if (!forceAll) {
          const s = pc.iceConnectionState
          if (s === 'connected' || s === 'completed') continue
        }
      } catch {  }
      try { void this.tryIceRestart(fp, pc, callId, true) } catch {  }
    }
  }

  /**
   * Troca de rede (Wi-Fi ↔ dados, troca de SSID, cabo): a rota ICE antiga morre
   * mas o `iceConnectionState` demora a virar `failed`, então o app ficava
   * "conectado" mudo. Aqui todo PC é renegociado de imediato.
   */
  private onNetworkChanged(motivo: string) {
    const st = this.state
    if (!st || !isCallPhaseActive(st.phase)) return
    const agora = Date.now()
    if (agora - this.ultimaTrocaDeRede < 4000) return
    this.ultimaTrocaDeRede = agora
    try { this.onCallNotice?.(`rede mudou (${motivo}) — refazendo a rota da chamada`) } catch {  }
    this.setFailureCause(null)
    this.restartIceAll(st.callId, true)
    if (this.state) this.onUpdate({ ...this.state })
  }

  private async doIceRestart(fp: string, callId: string, force = false) {
    const pc = this.pcs.get(fp)
    if (!pc || pc.signalingState !== 'stable') return
    if (!force && pc.iceConnectionState !== 'failed') return
    try { const anyPc = pc as any; if (typeof anyPc.restartIce === 'function') anyPc.restartIce() } catch {  }
    await this.sendOffer(fp, callId, { iceRestart: true })
  }

  private async renegotiate(fp: string, pc: RTCPeerConnection): Promise<boolean> {
    try {
      if (!this.state || this.pcs.get(fp) !== pc) return false
      const callId = this.state.callId
      return await this.sendOffer(fp, callId)
    } catch { return false }
  }

  private async waitForStable(pc: RTCPeerConnection, budgetMs = 3000): Promise<boolean> {
    const limite = Date.now() + budgetMs
    while (pc.signalingState !== 'stable' && pc.signalingState !== 'closed' && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 120))
    }
    return pc.signalingState === 'stable'
  }

  private async sendOffer(fp: string, callId: string, opts?: { iceRestart?: boolean }): Promise<boolean> {
    const anterior = this.offerQueue.get(fp) ?? Promise.resolve()
    const tarefa = anterior
      .catch(() => {  })
      .then(async () => {
        const pc = this.pcs.get(fp)
        if (!pc || pc.signalingState === 'closed') return false
        if (this.state && this.state.callId !== callId) return false
        if (!(await this.waitForStable(pc, 12_000))) return false
        const offer = await applyOfferInStable(pc, opts)
        if (!offer) return false
        if ((this.state && this.state.callId !== callId) || this.pcs.get(fp) !== pc) return false
        await services.callOffer(fp, callId, JSON.stringify(offer)).catch(() => {})
        await this.flushPendingAnswer(fp, pc, callId)
        return true
      })
    this.offerQueue.set(fp, tarefa)
    try {
      return await tarefa
    } finally {
      if (this.offerQueue.get(fp) === tarefa) this.offerQueue.delete(fp)
    }
  }

  private async createPC(fp: string, callId: string, initiator: boolean) {
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    try { this.iceServersUsed = getIceServers() } catch { this.iceServersUsed = null }
    const anterior = this.pcs.get(fp)
    if (anterior) {
      const cs = anterior.connectionState
      if (cs === 'connected' || cs === 'connecting' || cs === 'new') {
        return
      }
      try { anterior.close() } catch {  }
    }
    const pc = newPeerConnection()
    this.pcs.set(fp, pc)
    this.wirePC(pc, fp, callId)
    this.attachLocalStreamToPC(pc)
    if (initiator) {
      try {
        const offer = await createTunedOffer(pc)
        if (pc.signalingState === 'stable') {
          await pc.setLocalDescription(offer)
          await services.callOffer(fp, callId, JSON.stringify(offer)).catch(() => {})
          await this.flushPendingAnswer(fp, pc, callId)
        }
      } catch (e) {
        try { pc.close() } catch {  }
        this.pcs.delete(fp)
        console.debug('[call] createOffer falhou, PC descartado:', String((e as any)?.message ?? e))
        throw e
      }
    }
  }

  /** Pares com negociação pendente. `resend` reenvia a offer já criada (glare);
   *  `new` cria outra (a anterior se perdeu). Sem esta fila, a única forma de
   *  refazer a negociação era o usuário mexer de novo no botão. */
  private renegociacaoPendente = new Map<string, { since: number; mode: 'resend' | 'new'; tentativas: number }>()

  private static readonly MAX_RENEGOCIACOES = 6

  private marcarRenegociacaoPendente(fp: string, mode: 'resend' | 'new' = 'new'): void {
    const atual = this.renegociacaoPendente.get(fp)
    if (atual && atual.tentativas >= CallManager.MAX_RENEGOCIACOES) return
    if (!atual) {
      this.renegociacaoPendente.set(fp, { since: Date.now(), mode, tentativas: 0 })
    } else if (atual.mode === 'new' && mode === 'resend') {
      this.renegociacaoPendente.set(fp, { ...atual, mode, since: Date.now() })
    }
    if (this.renegociacaoTimer) return
    try {
      this.renegociacaoTimer = setTimeout(() => {
        this.renegociacaoTimer = null
        const st = this.state
        if (!st || !isCallPhaseActive(st.phase)) return
        void this.repairMidiaDivergente(st).catch(() => {  })
      }, 2_500)
    } catch { this.renegociacaoTimer = null }
  }

  private renegociacaoTimer: ReturnType<typeof setTimeout> | null = null

  private stopRenegociacaoRetry(): void {
    try { if (this.renegociacaoTimer) clearTimeout(this.renegociacaoTimer) } catch {  }
    this.renegociacaoTimer = null
    this.renegociacaoPendente.clear()
  }

  private async repairMidiaDivergente(st: CallState): Promise<void> {
    if (this.renegociacaoPendente.size === 0) return
    for (const [fp, pend] of [...this.renegociacaoPendente]) {
      try {
        const pc = this.pcs.get(fp)
        if (!pc || pc.signalingState === 'closed') {
          this.renegociacaoPendente.delete(fp)
          continue
        }
        if (Date.now() - pend.since < 2_000) continue

        if (pc.signalingState === 'have-local-offer') {
          if (pend.mode !== 'resend') {
            this.renegociacaoPendente.delete(fp)
            continue
          }
          const local = pc.localDescription
          if (!local?.sdp) {
            this.renegociacaoPendente.delete(fp)
            continue
          }
          await services.callOffer(fp, st.callId, JSON.stringify({ type: 'offer', sdp: local.sdp })).catch(() => {})
          const feitas = pend.tentativas + 1
          if (feitas >= CallManager.MAX_RENEGOCIACOES) this.renegociacaoPendente.delete(fp)
          else this.renegociacaoPendente.set(fp, { since: Date.now(), mode: 'new', tentativas: feitas })
          continue
        }

        if (pc.signalingState !== 'stable' || !pc.remoteDescription) continue
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') continue

        const temMidia = pc.getSenders().some((s) => s.track && s.track.readyState === 'live')
          || !!st.cameraOn || !!st.sharing
        if (!temMidia) {
          this.renegociacaoPendente.delete(fp)
          continue
        }
        if (await this.enviarOfferComRetry(fp, st.callId)) {
          this.renegociacaoPendente.delete(fp)
        } else {
          const feitas = pend.tentativas + 1
          if (feitas >= CallManager.MAX_RENEGOCIACOES) this.renegociacaoPendente.delete(fp)
          else this.renegociacaoPendente.set(fp, { since: Date.now(), mode: 'new', tentativas: feitas })
        }
      } catch {  }
    }
  }

  private async repairHalfOpenPairs(): Promise<void> {
    const st = this.state
    if (!st || !isCallPhaseActive(st.phase) || !this.myFp) return
    await this.repairMidiaDivergente(st)
    for (const p of st.participants) {
      const fp = p.fp
      if (!fp || fp === this.myFp) continue
      const pc = this.pcs.get(fp)
      const cs = pc?.connectionState
      if (cs === 'connected') {
        this.soloWaitSince.delete(fp)
        continue
      }
      if (!(this.myFp > fp) && !pc) {
        const desde = this.soloWaitSince.get(fp) ?? 0
        if (desde === 0) { this.soloWaitSince.set(fp, Date.now()); continue }
        if (!shouldInitiatePair({ myFp: this.myFp, peerFp: fp, hasPair: false, waitingSinceMs: desde, nowMs: Date.now() })) continue
      }
      if (pc && cs === 'failed') {
        try {
          const saiu = await this.sendOffer(fp, st.callId, { iceRestart: true })
          if (saiu) {
            this.setFailureCause(`reparando rota com ${fp.slice(0, 8)}…`)
            continue
          }
        } catch {  }
      }
      if (!pc || cs === 'failed' || cs === 'closed' || !cs) {
        this.soloWaitSince.delete(fp)
        this.restorePeerMedia(fp, st.callId)
        continue
      }
      const esperando = cs === 'new' || cs === 'connecting'
      if (esperando) {
        const desde = this.pairStuckSince.get(fp) ?? 0
        if (desde === 0) {
          this.pairStuckSince.set(fp, Date.now())
        } else if (Date.now() - desde > 25_000) {
          this.pairStuckSince.delete(fp)
          this.setFailureCause(`par com ${fp.slice(0, 8)} sem rota há 25s — refazendo a negociação`)
          try { pc.close() } catch {  }
          this.pcs.delete(fp)
          this.localIce.delete(fp)
          this.pendingIce.delete(fp)
          this.lastRemoteOffer.delete(fp)
          this.iceRestarts.delete(fp)
          this.restorePeerMedia(fp, st.callId)
        }
      } else {
        this.pairStuckSince.delete(fp)
      }
    }
  }

  private restorePeerMedia(fp: string, callId: string): void {
    void this.createPC(fp, callId, true)
      .then(async () => {
        const stream = this.screenStream
        const track = stream?.getVideoTracks()[0] ?? null
        if (!this.state?.sharing || !track || !stream) return
        const pc = this.pcs.get(fp)
        if (!pc || pc.signalingState === 'closed') return
        const tr = this.findVideoTransceiver(pc)
        if (!tr) return
        const precisaOffer = setCallVideoSending(tr, true)
        await tr.sender.replaceTrack(track)
        if (precisaOffer && this.state) await this.sendOffer(fp, this.state.callId).catch(() => false)
      })
      .catch(() => {  })
  }

  private isCollectiveCall(st: { callId: string; participants?: { fp: string }[]; invited?: { fp: string }[] }): boolean {
    return isCollectiveRoom({
      callId: st.callId,
      participants: (st.participants ?? []).map((p) => p.fp),
      invited: (st.invited ?? []).map((i) => i.fp),
      group: this.callIsGroup,
    })
  }

  private markJoined(fp: string) {
    try {
      if (!this.state || !fp || fp === this.myFp) return
      const eraConvidado = this.dropInvite(fp)
      if (this.state.participants.find((p: any) => p.fp === fp)) {
        if (eraConvidado) this.onUpdate({ ...this.state })
        return
      }
      this.state.participants.push({ fp, nickname: fp.slice(0, 6) })
      this.onUpdate({ ...this.state })
    } catch {  }
  }

  private dropInvite(fp: string): boolean {
    const st = this.state
    if (!st || !Array.isArray(st.invited)) return false
    const antes = st.invited.length
    st.invited = st.invited.filter((i) => i.fp !== fp)
    return st.invited.length !== antes
  }

  /** Reenvia a answer local quando a offer remota repete (answer perdida). */
  private async reenviarAnswerLocal(
    fp: string,
    callId: string,
    pc: RTCPeerConnection,
    offerSdp: string,
  ): Promise<void> {
    try {
      if (this.pcs.get(fp) !== pc || pc.signalingState !== 'stable') return
      if (this.state?.callId !== callId) return
      const local = pc.localDescription
      if (!local?.sdp || local.type !== 'answer') return
      const remote = pc.remoteDescription
      if (!remote?.sdp || remote.sdp !== offerSdp) return
      await services.callAnswer(fp, callId, JSON.stringify({ type: 'answer', sdp: local.sdp })).catch(() => {})
    } catch {  }
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
      if (nativeVoiceAvailable !== true) {
        this.pendingOffers.set(fromFp, { callId, sdp: sdpStr })
      }
      return
    }
    if (!this.acceptedCalls.has(callId)) {
      if (nativeVoiceAvailable !== true) {
        this.pendingOffers.set(fromFp, { callId, sdp: sdpStr })
        console.debug(`[call] offer de ${fromFp.slice(0, 8)} retida até o aceite (ring em andamento)`)
      }
      return
    }
    this.markJoined(fromFp)

    let pc = this.pcs.get(fromFp)
    if (pc && (pc.connectionState === 'closed' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed')) {
      try { pc.close() } catch {  }
      this.pcs.delete(fromFp)
      this.localIce.delete(fromFp)
      this.pendingIce.delete(fromFp)
      pc = undefined
    }
    if (!pc) {
      if (!supportsCalls()) { console.debug('[call] oferta ignorada: WebRTC indisponível neste aparelho'); return }
      try {
        pc = newPeerConnection()
      } catch (e) {
        console.warn(`[call] RTCPeerConnection indisponível para offer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
        return
      }
      this.pcs.set(fromFp, pc)
      this.wirePC(pc, fromFp, callId)
      this.attachLocalStreamToPC(pc)
    }

    if (pc.signalingState === 'stable' && this.lastRemoteOffer.get(fromFp) === sdpStr) {
      void this.reenviarAnswerLocal(fromFp, callId, pc, sdpStr)
      return
    }

    const polite = this.isPolite(fromFp)
    const anterior = this.offerQueue.get(fromFp)
    if (anterior) {
      try { await anterior.catch(() => {}) } catch {  }
      if (this.pcs.get(fromFp) !== pc) return
    }
    if (pc.signalingState === 'have-local-offer') {
      if (!polite) {
        console.debug(`[call] GLARE ${callId}: impolite ignora offer de ${fromFp.slice(0, 8)}`)
        this.marcarRenegociacaoPendente(fromFp, 'resend')
        return
      }
      try { await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit) }
      catch { if ((pc.signalingState as string) !== 'stable') return }
    }
    try {
      await pc.setRemoteDescription(offer)
      if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
      if (pc.signalingState !== 'have-remote-offer') return
      this.lastRemoteOffer.set(fromFp, sdpStr)
      await this.flushPendingIce(fromFp, pc, callId)
      const answer = await createTunedAnswer(pc)
      if (pc.signalingState !== 'have-remote-offer') return
      await pc.setLocalDescription(answer)
      if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
      await services.callAnswer(fromFp, callId, JSON.stringify(answer)).catch(() => {})
    } catch (e) {
      console.warn(`[call] falha ao responder offer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
    }
  }

  private async handleAnswer(fromFp: string, callId: string, sdpStr: string) {
    if (!fromFp || fromFp === this.myFp || this.state?.callId !== callId) return
    const pc = this.pcs.get(fromFp)
    if (!pc) {
      this.pendingAnswers.set(fromFp, { callId, sdp: sdpStr })
      return
    }
    const ans = parseWireSdp(sdpStr, 'answer')
    if (!ans) return
    this.markJoined(fromFp)
    try {
      if (pc.signalingState !== 'have-local-offer') {
        if (pc.signalingState !== 'stable') this.marcarRenegociacaoPendente(fromFp)
        return
      }
      await pc.setRemoteDescription(ans as RTCSessionDescriptionInit)
      if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
      await this.flushPendingIce(fromFp, pc, callId)
    } catch (e) {
      console.warn(`[call] falha ao aplicar answer de ${fromFp.slice(0, 8)}: ${(e as Error)?.message ?? e}`)
      this.marcarRenegociacaoPendente(fromFp)
    }
  }

  /** Answers que chegaram antes do PC (ou da offer local) estarem prontos. */
  private pendingAnswers = new Map<string, { callId: string; sdp: string }>()

  private async flushPendingAnswer(fp: string, pc: RTCPeerConnection, callId: string): Promise<void> {
    const pend = this.pendingAnswers.get(fp)
    if (!pend || pend.callId !== callId) return
    this.pendingAnswers.delete(fp)
    if (pc.signalingState !== 'have-local-offer') return
    const ans = parseWireSdp(pend.sdp, 'answer')
    if (!ans) return
    try {
      await pc.setRemoteDescription(ans as RTCSessionDescriptionInit)
      if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
      await this.flushPendingIce(fp, pc, callId)
    } catch {  }
  }

  private async handleIce(fromFp: string, callId: string, candidateStr: string, mid: string) {
    if (!fromFp || fromFp === this.myFp || this.endedCalls.has(callId)) return
    if (this.state && this.state.callId !== callId) return
    try {
      if ((mid === RELAY_MID || (typeof candidateStr === 'string' && candidateStr.indexOf('audio-chunk') >= 0)) && typeof candidateStr === 'string') {
        try {
          const parsed = JSON.parse(candidateStr)
          if (isRelayChunkPayload(parsed)) {
            this.handleRelayChunk(fromFp, callId, candidateStr)
            return
          }
        } catch {  }
        if (mid === RELAY_MID) {
          try { this.handleRelayChunk(fromFp, callId, candidateStr) } catch {  }
          return
        }
      }
    } catch {  }
    const pc = this.pcs.get(fromFp)
    const cand = parseWireCandidate(candidateStr, mid)
    if (!cand) return
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
        while (byCall.size > 4) {
          const oldest = byCall.keys().next().value
          if (!oldest) break
          byCall.delete(oldest)
        }
      }
      if (q.length >= 256) q.shift()
      q.push(cand)
      return
    }
    if (this.state?.callId !== callId || this.pcs.get(fromFp) !== pc) return
    try {
      await pc.addIceCandidate(cand)
    } catch (e) {
      console.debug(
        `[call] candidato ICE recusado (${cand.sdpMid ?? cand.sdpMLineIndex ?? '?'}): ${(e as Error)?.message ?? e}`,
      )
    }
  }

  private async flushPendingIce(fp: string, pc: RTCPeerConnection, callId: string) {
    const byCall = this.pendingIce.get(fp)
    const q = byCall?.get(callId)
    if (!q || q.length === 0) return
    byCall?.delete(callId)
    if (byCall?.size === 0) this.pendingIce.delete(fp)
    for (const cand of q) {
      if (this.state?.callId !== callId || this.pcs.get(fp) !== pc) return
      try { await pc.addIceCandidate(cand) } catch {  }
    }
  }

  private startCallForeground() {
    if (!isAndroidRuntime()) return
    try {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        void services.notificationPermission().then((state) => {
          if (state === 'prompt') void services.notificationRequestPermission().catch(() => {})
        }).catch(() => {})
        invoke('plugin:callfg|start').catch((e) => {
          this.onCallNotice?.(
            'não consegui manter a chamada em segundo plano — o microfone pode ser cortado ao minimizar',
          )
          void e
        })
      }).catch(() => {  })
    } catch {  }
  }

  private stopCallForeground() {
    if (!isAndroidRuntime()) return
    try {
      void import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('plugin:callfg|stop').catch(() => {  })
      }).catch(() => {  })
    } catch {  }
  }

  private publishRoom() {
    const st = this.state
    if (!st || !st.convId) return
    if (st.callId.startsWith('voice-')) return
    try {
      this.roomConvId = st.convId
      const participantes = st.participants.map((p) => p.fp).filter(Boolean)
      void services
        .callRoomPublish(st.callId, st.convId, st.kind, participantes)
        .catch(() => {  })
      if (!this.roomTimer) {
        this.roomTimer = setInterval(() => { try { this.publishRoom() } catch {  } }, 15_000)
      }
    } catch {  }
  }

  private closeRoom() {
    if (this.roomTimer) {
      try { clearInterval(this.roomTimer) } catch {  }
      this.roomTimer = null
    }
    const convId = this.roomConvId ?? this.state?.convId
    this.roomConvId = null
    if (!convId) return
    try {
      void services.callRoomLeave(convId).catch(() => {  })
    } catch {  }
  }

  getRoomConvId(): string | null {
    return this.roomConvId
  }

  async enterRoom(convId: string, kind: 'voice' | 'video' = 'voice', fps: string[] = []): Promise<CallState> {
    const me = this.getIdentity()
    if (!me) throw new Error('sem identidade')
    if (this.state && isCallPhaseActive(this.state.phase)) {
      throw new Error('já existe uma chamada em andamento — encerre a atual antes de entrar')
    }
    if (this.state) {
      try { await this.forceReset() } catch {  }
    }
    await detectNativeVoice(true)
    if (!supportsCalls()) throw new Error(getCallsUnavailableMessage())
    const [callId, alvos] = await services.callRoomJoin(convId, kind)
    if (!alvos.length) throw new Error('a chamada encerrou — ninguém mais está na sala')
    try { void services.groupPairNow?.(convId)?.catch(() => {  }) } catch {  }
    this.endedCalls.delete(callId)
    this.myFp = me.fingerprint
    this.quality = getStoredQuality()
    this.qualityNotice = null
    this.badWindows = 0
    this.lastFailureCause = null
    try { this.lastStats.clear() } catch {  }
    try { this.lastNativeStats = null } catch {  }
    this.prevLost.clear()
    this.resetRelayForNewCall()
    this.acceptedCalls.add(callId)
    this.roomConvId = convId

    if (nativeVoiceAvailable === true) {
      this.localStream = null
      this.screenStream = null
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
        participants: [
          { fp: me.fingerprint, nickname: me.nickname, muted: false },
          ...alvos.map((fp) => ({ fp, nickname: fp.slice(0, 6), muted: false })),
        ],
        nativeMedia: true,
      } as unknown as CallState
      this.startNativeVoiceMonitor(callId)
      this.announceSelfToRoom(callId)
      this.startMeshRepair(callId)
      this.publishRoom()
      this.onUpdate({ ...this.state })
      this.startCallForeground()
      return this.state
    }

    if (!this.localStream) {
      try {
        this.localStream = kind === 'video'
          ? await getLocalMedia({ audio: true, video: { ...CAMERA_CONSTRAINTS } })
          : await getLocalMedia({ audio: true })
      } catch { this.localStream = null }
    }
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
        ...alvos.map((fp) => ({ fp, nickname: fp.slice(0, 6) })),
      ],
      startAt: Date.now(),
      quality: this.quality,
      qualityNotice: null,
      relayActive: false,
      relayManual: false,
      relayReason: null,
    }
    this.startConnectWatchdog()
    this.startQualityMonitor()
    this.ensureRelayTransport()
    for (const fp of new Set([...alvos, ...fps.filter((f) => f && f !== me.fingerprint)])) {
      await this.createPC(fp, callId, true).catch(() => {  })
    }
    try {
      for (const fp of [...this.pendingOffers.keys()]) {
        const pend = this.pendingOffers.get(fp)
        if (!pend || pend.callId !== callId) continue
        this.pendingOffers.delete(fp)
        await this.handleOffer(fp, pend.callId, pend.sdp).catch(() => {  })
        if (!this.state?.participants.some((p) => p.fp === fp)) {
          this.state?.participants.push({ fp, nickname: fp.slice(0, 6) })
        }
      }
    } catch {  }
    this.announceSelfToRoom(callId)
    this.publishRoom()
    this.startMeshRepair(callId)
    this.onUpdate({ ...this.state })
    this.startCallForeground()
    return this.state
  }

  private cleanup(expectedCallId?: string) {
    if (expectedCallId && this.state?.callId !== expectedCallId) return
    this.stopRingRetry()
    this.stopCallForeground()
    this.stopRosterReconcile()
    try {
      const st = this.state
      if ((st as any)?.nativeMedia) {
        for (const p of st?.participants ?? []) {
          if (p.fp && p.fp !== this.myFp) {
            try { if (st) void services.voiceVideoStop(st.callId, p.fp) } catch {  }
          }
        }
      }
    } catch {  }
    this.stopQualityMonitor()
    this.stopReconnectWatchdog()
    this.stopConnectWatchdog()
    this.stopOutgoingWatchdog()
    this.stopIncomingWatchdog()
    this.stopNativeVoiceMonitor()
    this.clearIceRestartTimers()
    try { this.lastStats.clear() } catch {  }
    try { this.lastNativeStats = null } catch {  }
    this.clearRelayFallbackTimer()
    try { this.stopRelayFull() } catch {  }
    this.badWindows = 0
    this.prevLost.clear()
    this.pendingIce.clear()
    this.localIce.clear()
    this.pendingOffers.clear()
    this.pendingAnswers.clear()
    this.pendingVoiceJoins.clear()
    this.offerQueue.clear()
    this.acceptedCalls.clear()
    this.lastRemoteOffer.clear()
    this.iceReports.clear()
    this.iceRestarts.clear()
    this.pairStuckSince.clear()
    this.soloWaitSince.clear()
    this.qualityNotice = null
    this.renegociacaoPendente.clear()
    this.stopRenegociacaoRetry()
    this.pcs.forEach(pc => { try { pc.close() } catch {  } })
    this.pcs.clear()
    this.localStream?.getTracks().forEach(t => { try { t.stop() } catch {  } })
    this.resetScreenRuntime()
    this.localStream = null
    this.closeRoom()
    if (this.state) {
      if (!this.state.callId.startsWith('voice-')) {
        this.endedCalls.add(this.state.callId)
        if (this.endedCalls.size > 64) {
          const maisAntigo = this.endedCalls.values().next().value
          if (maisAntigo) this.endedCalls.delete(maisAntigo)
        }
      }
    }
    this.state = null
    nativeRoute = null
    this.onUpdate(null as any)
  }
}

void detectNativeVoice()

export const callManager = new CallManager(() => {
  if (cachedCallIdentity) return cachedCallIdentity
  try {
    const raw = (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('distorrent:identity') : null)
      ?? localStorage.getItem('distorrent:identity') ?? localStorage.getItem('identity') ?? ''
    if (!raw) return null
    const j = JSON.parse(raw)
    return { fingerprint: j.fingerprint ?? 'local', nickname: j.nickname ?? 'você' }
  } catch { return null }
})

let cachedCallIdentity: { fingerprint: string; nickname: string } | null = null
export function setCallIdentity(id: { fingerprint: string; nickname: string } | null) {
  cachedCallIdentity = id
  void detectNativeVoice(true)
}
