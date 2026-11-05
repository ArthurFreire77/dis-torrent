import { services } from './index'
import type { NetworkState, PresenceStatus } from './models'
import { getPrefs, setPrefs, subscribePrefs, notificationPolicyJson } from '../shared/prefs'
import { derivePresence } from './notificationRules'
import { isTauriRuntime, isAndroidRuntime } from '../shared/runtime.ts'
import { createEmitter } from '../shared/emitter.ts'

export { derivePresence }

export type AppActivity = 'active' | 'background'

export interface AppStateSnapshot {
  connection: NetworkState
  onlinePeers: number
  activity: AppActivity
  desiredPresence: PresenceStatus
  presence: PresenceStatus
  backgroundSupported: boolean
}

type Listener = (s: AppStateSnapshot) => void

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

function syncPresence() {
  const keep = getPrefs().presenceInBackground === 'online'
  const next = derivePresence(desiredPresence, activity, keep)
  presence = next
  emit()
  if (lastAnnounced === next) return
  lastAnnounced = next
  void services.presenceSet(next, '', '').catch(() => {})
}

export function setDesiredPresence(status: PresenceStatus) {
  desiredPresence = status
  setPrefs({ myPresence: status })
  syncPresence()
}

export function desiredPresenceNow(): PresenceStatus {
  return desiredPresence
}

export function setActivity(next: AppActivity) {
  if (activity === next) return
  activity = next
  syncPresence()
}

function computeActivity(): AppActivity {
  try {
    if (typeof document === 'undefined') return 'active'
    if (document.visibilityState === 'hidden') return 'background'
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

function pushTray() {
  if (!backgroundSupported) return
  if (connection === lastTrayLabel && lastTrayUnread === trayUnread) return
  lastTrayLabel = connection
  lastTrayUnread = trayUnread
  void services.backgroundSetConnection(connection, onlinePeers, trayUnread).catch(() => {})
}

let trayUnread = 0
export function setTrayUnread(n: number) {
  trayUnread = Math.max(0, n)
  pushTray()
}

let netTimer: ReturnType<typeof setInterval> | null = null

async function refreshNetwork() {
  try {
    const st = await services.networkStatus()
    syncConnection(st.state, st.online_peers)
  } catch {  }
}

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
    if (isTauri()) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) => listen<{ active: boolean }>('distorrent://activity', (e) => {
          setActivity(e.payload?.active ? 'active' : 'background')
        }))
        .catch(() => {  })
    }
  }

  unsubEngine = services.subscribe((ev) => {
    if (ev.type === 'state_changed') syncConnection(ev.state, ev.online_peers)
  })
  void refreshNetwork()
  netTimer = setInterval(() => { void refreshNetwork() }, 20000)

  if (services.kind === 'native' && !isAndroid()) {    void services.backgroundPrefs()
      .then((p) => {
        backgroundSupported = p.tray
        // O SQLite é a fonte de verdade do "iniciar minimizado": o boot no
        // login acontece antes do webview, então quem decide é o core. Adotar
        // o valor nativo aqui (em vez de empurrar o localStorage por cima)
        // evita a opção "ligar e voltar a desligar" quando o perfil da WebView
        // é recriado — o localStorage zera, o banco não.
        const cur = getPrefs()
        if (cur.startMinimized !== p.start_minimized || cur.closeToTray !== p.close_to_tray) {
          setPrefs({ startMinimized: p.start_minimized, closeToTray: p.close_to_tray })
        }
        emit()
        pushTray()
      })
      .catch(() => { backgroundSupported = false })
    void services.autostartEnsure()
      .then((on) => {
        const cur = getPrefs()
        if (cur.autostart !== on) setPrefs({ autostart: on })
      })
      .catch(() => {  })
  }

  if (services.kind === 'native') {
    const p = getPrefs()
    void services
      .notifyPrefsSet(p.notifySystem, p.notifyPreview, notificationPolicyJson())
      .catch(() => {})
    const offPrefs = subscribePrefs(() => {
      const cur = getPrefs()
      void services
        .notifyPrefsSet(cur.notifySystem, cur.notifyPreview, notificationPolicyJson())
        .catch(() => {})
    })
    prefsUnsub = () => { try { offPrefs() } catch {  } }

    if (isAndroid()) {
      void services.backgroundServiceSet(p.notifySystem).catch(() => {})
    }
  }

  syncPresence()
}

// Seção 1: shutdownAppState
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

export async function quitApplication(): Promise<void> {
  await services.appQuit()
}
