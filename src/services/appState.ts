// ESTADO DO APLICATIVO — conexão, atividade e presença são TRÊS coisas.
// O bug corrigido: "processo com socket aberto" era tratado como "usuário
// online" (mentia com o app minimizado). Aqui: `connection` = motor fala com
// a rede; `activity` = janela visível/em foco; `presence` = escolha do
// usuário. A presença EFETIVA deriva dos três (2º plano cai para "ausente").
// Nada inventa estado.

import { services } from './index'
import type { NetworkState, PresenceStatus } from './models'
import { getPrefs, setPrefs, subscribePrefs, notificationPolicyJson } from '../shared/prefs'
import { derivePresence } from './notificationRules'
import { isTauriRuntime, isAndroidRuntime } from '../shared/runtime.ts'
import { createEmitter } from '../shared/emitter.ts'

// `derivePresence` mora em `notificationRules.ts` (puro, testável em Node) e é
// reexportado aqui para quem já importa deste módulo.
export { derivePresence }

/** A janela está em uso (visível + em foco) ou não. */
export type AppActivity = 'active' | 'background'

export interface AppStateSnapshot {
  connection: NetworkState
  onlinePeers: number
  activity: AppActivity
  /** Presença escolhida pelo usuário (persistida). */
  desiredPresence: PresenceStatus
  /** Presença realmente anunciada aos peers agora. */
  presence: PresenceStatus
  /** Segundo plano suportado/ativo nesta plataforma (bandeja no desktop). */
  backgroundSupported: boolean
}

type Listener = (s: AppStateSnapshot) => void

// Emissor compartilhado: listener quebrado não derruba os outros.
const snapshotEmitter = createEmitter<AppStateSnapshot>()

let connection: NetworkState = 'DISCONNECTED'
let onlinePeers = 0
let activity: AppActivity = 'active'
let desiredPresence: PresenceStatus = 'online'
let presence: PresenceStatus = 'online'
let backgroundSupported = false
let started = false
let unsubEngine: (() => void) | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastAnnounced: PresenceStatus | null = null
let lastTrayLabel = ''
let lastTrayUnread = -1
/** Assinatura do espelho de preferências de aviso (desfeita no shutdown). */
let prefsUnsub: (() => void) | null = null

export function appStateSnapshot(): AppStateSnapshot {
  return { connection, onlinePeers, activity, desiredPresence, presence, backgroundSupported }
}

export function subscribeAppState(cb: Listener): () => void {
  return snapshotEmitter.subscribe(cb)
}

function emit() {
  snapshotEmitter.emit(appStateSnapshot())
}

function isTauri(): boolean {
  return isTauriRuntime()
}

function isAndroid(): boolean {
  return isAndroidRuntime()
}

/** Aplica a presença derivada no motor (uma vez por transição real). */
function syncPresence() {
  const keep = getPrefs().presenceInBackground === 'online'
  const next = derivePresence(desiredPresence, activity, keep)
  presence = next
  emit()
  if (lastAnnounced === next) return
  lastAnnounced = next
  // Best-effort: sem identidade/engine o core recusa; próxima transição tenta.
  void services.presenceSet(next, '', '').catch(() => {})
}

/** Presença escolhida pelo usuário nos menus/status. */
export function setDesiredPresence(status: PresenceStatus) {
  desiredPresence = status
  setPrefs({ myPresence: status })
  syncPresence()
}

export function desiredPresenceNow(): PresenceStatus {
  return desiredPresence
}

/** Chamado pelos shells quando a janela ganha/perde foco. */
export function setActivity(next: AppActivity) {
  if (activity === next) return
  activity = next
  syncPresence()
}

function computeActivity(): AppActivity {
  try {
    if (typeof document === 'undefined') return 'active'
    if (document.visibilityState === 'hidden') return 'background'
    // `hasFocus()` é o que separa "janela aberta atrás de outra" de "em uso".
    return document.hasFocus() ? 'active' : 'background'
  } catch { return 'active' }
}

function syncConnection(next: NetworkState, peers: number) {
  const changed = connection !== next || onlinePeers !== peers
  connection = next
  onlinePeers = peers
  if (changed) emit()
  pushTray()
}

/**
 * Reflete o estado da REDE na bandeja/tooltip (só desktop; tooltip mostra
 * conexão, nunca presença).
 */
function pushTray() {
  if (!backgroundSupported) return
  if (connection === lastTrayLabel && lastTrayUnread === trayUnread) return
  lastTrayLabel = connection
  lastTrayUnread = trayUnread
  void services.backgroundSetConnection(connection, onlinePeers, trayUnread).catch(() => {})
}

let trayUnread = 0
/** Não-lidas agregadas — a bandeja mostra o número sem expor conteúdo. */
export function setTrayUnread(n: number) {
  trayUnread = Math.max(0, n)
  pushTray()
}

let netTimer: ReturnType<typeof setInterval> | null = null

async function refreshNetwork() {
  try {
    const st = await services.networkStatus()
    syncConnection(st.state, st.online_peers)
  } catch { /* sem engine ainda (vault trancado) — mantém o último estado real */ }
}

/**
 * Liga tudo. Idempotente: só a primeira chamada instala listeners.
 */
export function initAppState() {
  if (started) return
  started = true
  desiredPresence = getPrefs().myPresence ?? 'online'
  activity = computeActivity()
  presence = derivePresence(desiredPresence, activity, getPrefs().presenceInBackground === 'online')

  if (typeof window !== 'undefined') {
    const onVis = () => setActivity(computeActivity())
    window.addEventListener('focus', onVis)
    window.addEventListener('blur', onVis)
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('beforeunload', () => setActivity('background'))
    // Tauri: janela na bandeja não dispara `blur` em todo engine — evento nativo cobre.
    if (isTauri()) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) => listen<{ active: boolean }>('distorrent://activity', (e) => {
          setActivity(e.payload?.active ? 'active' : 'background')
        }))
        .catch(() => { /* versão antiga do shell — os listeners do DOM bastam */ })
    }
  }

  // Conexão: evento do motor (instantâneo) + sondagem periódica (convergência).
  unsubEngine = services.subscribe((ev) => {
    if (ev.type === 'state_changed') syncConnection(ev.state, ev.online_peers)
  })
  void refreshNetwork()
  netTimer = setInterval(() => { void refreshNetwork() }, 20000)

  // Preferências de segundo plano reais (bandeja/autostart) — só desktop nativo.
  if (services.kind === 'native' && !isAndroid()) {    void services.backgroundPrefs()
      .then((p) => { backgroundSupported = p.tray; emit(); pushTray() })
      .catch(() => { backgroundSupported = false })
    // Rust precisa saber ANTES do primeiro fechamento de janela (cache do processo).
    const p = getPrefs()
    void services.backgroundPrefsSet({
      closeToTray: p.closeToTray,
      startMinimized: p.startMinimized,
    }).catch(() => {})
    // ABRIR JUNTO COM O WINDOWS: o Rust liga no boot; aqui só espelhamos o
    // estado REAL do SO na preferência local (nunca mostrar "ligado" se recusou).
    void services.autostartEnsure()
      .then((on) => {
        const cur = getPrefs()
        if (cur.autostart !== on) setPrefs({ autostart: on })
      })
      .catch(() => { /* sem autostart nesta plataforma: a UI diz isso */ })
  }

  // ESPELHO DAS PREFERÊNCIAS DE AVISO NO CORE: o aviso nativo é disparado pelo
  // MOTOR Rust (que não enxerga o localStorage) — sem este espelho, desligar
  // "notificações do sistema" não teria efeito fora da tela.
  if (services.kind === 'native') {
    const p = getPrefs()
    void services
      .notifyPrefsSet(p.notifySystem, p.notifyPreview, notificationPolicyJson())
      .catch(() => {})
    // E a cada mudança do checkbox (o motor precisa antes de esconder a janela).
    const offPrefs = subscribePrefs(() => {
      const cur = getPrefs()
      void services
        .notifyPrefsSet(cur.notifySystem, cur.notifyPreview, notificationPolicyJson())
        .catch(() => {})
    })
    prefsUnsub = () => { try { offPrefs() } catch { /* ignore */ } }

    // ANDROID: serviço em primeiro plano mantém o processo vivo com a tela
    // apagada; só sobe com notificações do sistema ligadas (poupar bateria).
    if (isAndroid()) {
      void services.backgroundServiceSet(p.notifySystem).catch(() => {})
    }
  }

  syncPresence()
}

/** Desliga listeners (usado em testes e no unmount do shell raiz). */
export function shutdownAppState() {
  unsubEngine?.()
  unsubEngine = null
  prefsUnsub?.()
  prefsUnsub = null
  if (netTimer) { clearInterval(netTimer); netTimer = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  snapshotEmitter.clear()
  started = false
}

/** Sair de verdade pelo botão de configurações (não é fechar a janela). */
export async function quitApplication(): Promise<void> {
  await services.appQuit()
}
