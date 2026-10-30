// ESTADO DO APLICATIVO — conexão, atividade e presença são TRÊS coisas.
//
// O bug conceitual que este módulo corrige: o app tratava "o processo está com
// socket aberto" como "o usuário está online". Com segundo plano de verdade
// (bandeja/minimizado), isso mentia para os contatos: você ficava "online"
// para todo mundo enquanto estava dormindo com o app minimizado.
//
// Aqui:
//   • `connection`  = o motor P2P consegue falar com a rede? (fato técnico)
//   • `activity`    = a janela está visível e em foco? (fato técnico)
//   • `presence`    = o que o usuário escolheu mostrar (decisão dele)
//
// A presença EFETIVA é derivada dos três: em segundo plano, "online" cai para
// "ausente" (a menos que o usuário peça explicitamente para continuar online).
// Nada aqui inventa estado: se o motor está desconectado, `connection` é
// 'DISCONNECTED' e a UI mostra isso.

import { services } from './index'
import type { NetworkState, PresenceStatus } from './models'
import { getPrefs, setPrefs } from '../shared/prefs'
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

// Emissor compartilhado (`shared/emitter.ts`): um listener quebrado não pode
// derrubar os outros, e o cancelamento pode ser chamado duas vezes (StrictMode).
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
  // Best-effort: sem identidade/engine o core recusa e está tudo bem — a
  // próxima transição tenta de novo. Nunca "finge" que anunciou.
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
 * Reflete o estado da REDE na bandeja/tooltip. Só o desktop tem bandeja, e o
 * tooltip mostra conexão — nunca presença (ver `background.rs`).
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
 * Liga tudo. Idempotente: os dois shells (desktop e mobile) chamam, e só a
 * primeira chamada instala listeners.
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
    // Tauri: a janela escondida na bandeja não dispara `blur` em todo engine —
    // o evento nativo cobre o caso.
    if (isTauri()) {
      void import('@tauri-apps/api/event')
        .then(({ listen }) => listen<{ active: boolean }>('distorrent://activity', (e) => {
          setActivity(e.payload?.active ? 'active' : 'background')
        }))
        .catch(() => { /* versão antiga do shell — os listeners do DOM bastam */ })
    }
  }

  // Conexão: evento do motor (instantâneo) + sondagem periódica (convergência
  // depois de suspensão/rede nova).
  unsubEngine = services.subscribe((ev) => {
    if (ev.type === 'state_changed') syncConnection(ev.state, ev.online_peers)
  })
  void refreshNetwork()
  netTimer = setInterval(() => { void refreshNetwork() }, 20000)

  // Preferências de segundo plano reais (bandeja/autostart) — só no desktop
  // nativo. No navegador puro isso é tudo indisponível, e a UI diz isso.
  if (services.kind === 'native' && !isAndroid()) {
    void services.backgroundPrefs()
      .then((p) => { backgroundSupported = p.tray; emit(); pushTray() })
      .catch(() => { backgroundSupported = false })
    // O Rust precisa saber ANTES do primeiro fechamento de janela: quem guarda
    // "fechar para a bandeja" é ele (a preferência também fica no kv, mas o
    // cache do processo é atualizado aqui).
    const p = getPrefs()
    void services.backgroundPrefsSet({
      closeToTray: p.closeToTray,
      startMinimized: p.startMinimized,
    }).catch(() => {})
    // ABRIR JUNTO COM O WINDOWS.
    //
    // O Rust liga no boot (uma vez, respeitando a decisão do usuário). Aqui só
    // espelhamos o estado REAL do SO na preferência local — a UI nunca mostra
    // "ligado" se o Windows recusou (política de máquina/antivírus).
    void services.autostartEnsure()
      .then((on) => {
        const cur = getPrefs()
        if (cur.autostart !== on) setPrefs({ autostart: on })
      })
      .catch(() => { /* sem autostart nesta plataforma: a UI diz isso */ })
  }

  syncPresence()
}

/** Desliga listeners (usado em testes e no unmount do shell raiz). */
export function shutdownAppState() {
  unsubEngine?.()
  unsubEngine = null
  if (netTimer) { clearInterval(netTimer); netTimer = null }
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  snapshotEmitter.clear()
  started = false
}

/** Sair de verdade pelo botão de configurações (não é fechar a janela). */
export async function quitApplication(): Promise<void> {
  await services.appQuit()
}
