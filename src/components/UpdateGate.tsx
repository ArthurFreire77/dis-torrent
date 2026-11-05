import React from 'react'
import { services } from '../services'
import {
  FLAG_SKIP,
  formatBytes,
  isNewer,
  shortNotes,
  updateModeFor,
  type UpdateInfo,
  type UpdateOutcome,
} from '../services/updateRules'
import { nativeUpdateDeps } from '../services/updater'
import { runUpdateFlow } from '../services/updateRules'

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'later'
  | 'stalled'
  | 'error'

export interface UpdateGateState {
  phase: UpdatePhase
  info: UpdateInfo | null
  current: string
  message: string
  progress: number | null
}

export interface UpdateGateApi extends UpdateGateState {
  show: () => void
  apply: () => void
  skip: () => void
  dismiss: () => void
  openPage: () => void
}

const IDLE: UpdateGateState = {
  phase: 'idle',
  info: null,
  current: '',
  message: '',
  progress: null,
}

export function useUpdateGate(enabled = true): UpdateGateApi {
  const [state, setState] = React.useState<UpdateGateState>(IDLE)
  const started = React.useRef(false)
  const mounted = React.useRef(true)
  const depsRef = React.useRef(nativeUpdateDeps())
  const stateRef = React.useRef(state)
  stateRef.current = state
  const intervalRef = React.useRef<ReturnType<typeof setInterval> | null>(null)

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (intervalRef.current) clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  const set = React.useCallback((patch: Partial<UpdateGateState>) => {
    if (!mounted.current) return
    setState((s) => ({ ...s, ...patch }))
  }, [])

  const run = React.useCallback(
    async (opts: { autoApply: boolean; auto: boolean }): Promise<UpdateOutcome | null> => {
      const deps = depsRef.current
      if (!deps) return null
      set({ phase: 'checking', message: 'verificando se há versão nova…' })
      let outcome: UpdateOutcome
      try {
        outcome = await runUpdateFlow(deps, { autoApply: opts.autoApply })
      } catch (e) {
        if (!mounted.current) return { kind: 'error', message: String((e as Error)?.message ?? e) }
        setState({ ...IDLE, phase: 'error', message: String((e as Error)?.message ?? e) })
        return { kind: 'error', message: String((e as Error)?.message ?? e) }
      }
      if (!mounted.current) return outcome
      switch (outcome.kind) {
        case 'none':
          setState(IDLE)
          return outcome
        case 'later':
          setState({
            phase: 'later',
            info: outcome.info,
            current: outcome.info.current,
            message: '',
            progress: null,
          })
          return outcome
        case 'applied':
          setState({
            phase: 'installing',
            info: outcome.info,
            current: outcome.info.current,
            message:
              updateModeFor(outcome.info.platform, outcome.info.asset_name) === 'auto'
                ? 'instalador aberto — o app vai reiniciar sozinho'
                : 'instalador aberto — conclua e abra o app de novo',
            progress: null,
          })
          return outcome
        case 'stalled':
          setState({
            phase: 'stalled',
            info: outcome.info,
            current: outcome.info.current,
            message:
              'esta versão já foi instalada, mas o app continua na anterior — o instalador publicado não contém a versão que a release anuncia',
            progress: null,
          })
          return outcome
        case 'error':
          setState((s) =>
            s.info
              ? { ...s, phase: 'error', message: outcome.message }
              : { ...IDLE, phase: 'error', message: outcome.message },
          )
          return outcome
      }
    },
    [set],
  )

  React.useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    const deps = depsRef.current
    if (!deps) {
      return
    }
    void (async () => {
      let auto = false
      try {
        auto = await services.updateAutoGet()
      } catch {
        auto = false
      }

      let outcome = await run({ autoApply: auto, auto })
      for (let tentativa = 1; tentativa <= 3 && outcome?.kind === 'error'; tentativa++) {
        await new Promise((r) => setTimeout(r, 4000 * tentativa))
        if (!mounted.current) return
        outcome = await run({ autoApply: auto, auto })
      }

      if (mounted.current && stateRef.current.phase === 'checking') {
        setState((s) => (s.phase === 'checking' ? { ...s, phase: 'idle' } : s))
      }

      const intervalo = setInterval(() => {
        if (!mounted.current) return
        const p = stateRef.current.phase
        if (p !== 'idle' && p !== 'checking') return
        void run({ autoApply: auto, auto })
      }, 6 * 60 * 60 * 1000)
      intervalRef.current = intervalo
    })()
  }, [enabled, run])

  // Seção 1: apply
  const apply = React.useCallback(() => {
    const deps = depsRef.current
    if (!deps) return
    void (async () => {
      set({ phase: 'downloading', message: 'baixando o instalador…' })
      try {
        const info = state.info
        if (!info) return
        const path = await deps.download(info)
        set({ phase: 'installing', message: 'instalando — o app vai reiniciar sozinho' })
        await deps.apply(path)
      } catch (e) {
        set({ phase: 'error', message: String((e as Error)?.message ?? e) })
      }
    })()
  }, [set, state.info])

  const skip = React.useCallback(() => {
    const deps = depsRef.current
    const v = state.info?.latest
    if (deps && v) void deps.setFlag(FLAG_SKIP, v).catch(() => {})
    setState(IDLE)
  }, [state.info])

  const openPage = React.useCallback(() => {
    const url = state.info?.html_url
    if (!url) return
    void services.openReleasePage(url).catch(() => {})
  }, [state.info])

  return {
    ...state,
    show: () => set({ phase: 'later' }),
    apply,
    skip,
    dismiss: () => setState(IDLE),
    openPage,
  }
}

const MONO = "'JetBrains Mono', ui-monospace, monospace"

export function UpdateOverlay({ api }: { api: UpdateGateApi }) {
  if (api.phase === 'idle' || api.phase === 'checking') return null

  const blocking = api.phase === 'downloading' || api.phase === 'installing'
  const stalled = api.phase === 'stalled'
  const info = api.info
  const mode = info ? updateModeFor(info.platform, info.asset_name) : 'link'

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: blocking ? 'rgba(8,10,14,.92)' : 'rgba(8,10,14,.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <div
        style={{
          width: 460,
          maxWidth: '100%',
          maxHeight: '86vh',
          overflow: 'auto',
          background: '#161a21',
          border: '1px solid #2a313c',
          borderRadius: 14,
          padding: 22,
          boxShadow: '0 18px 48px rgba(0,0,0,.6)',
          color: '#dbe1ea',
        }}
      >
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: 1.4, color: '#8b95a6' }}>
          ATUALIZAÇÃO
        </div>
        <div style={{ fontSize: 22, fontWeight: 900, marginTop: 6, color: '#fff' }}>
          {api.phase === 'error'
            ? 'não deu para atualizar'
            : stalled
              ? 'atualização já aplicada'
              : info && isNewer(info.current, info.latest)
                ? `DisTorrent ${info.latest} disponível`
                : 'DisTorrent'}
        </div>

        {info && (
          <div style={{ fontSize: 12.5, color: '#98a2b3', marginTop: 6 }}>
            você está na {info.current || '?'} · instalador para {info.platform}
            {info.asset_size > 0 ? ` · ${formatBytes(info.asset_size)}` : ''}
          </div>
        )}

        {info?.notes && (
          <pre
            style={{
              marginTop: 14,
              padding: 12,
              background: '#0f1218',
              border: '1px solid #232a34',
              borderRadius: 10,
              fontSize: 11.5,
              lineHeight: 1.55,
              color: '#b9c2d0',
              whiteSpace: 'pre-wrap',
              fontFamily: MONO,
              maxHeight: 190,
              overflow: 'auto',
            }}
          >
            {shortNotes(info.notes)}
          </pre>
        )}

        {api.message && (
          <div
            style={{
              marginTop: 14,
              fontSize: 12.5,
              color: api.phase === 'error' ? '#ff8a8f' : stalled ? '#f0c264' : '#7fd1a6',
              lineHeight: 1.5,
            }}
          >
            {api.message}
          </div>
        )}

        {api.progress !== null && (
          <div style={{ marginTop: 12, height: 6, background: '#0f1218', borderRadius: 99 }}>
            <div
              style={{
                width: `${Math.round((api.progress ?? 0) * 100)}%`,
                height: '100%',
                background: '#4c8dff',
                borderRadius: 99,
                transition: 'width .2s ease',
              }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          {stalled && (
            <>
              <button onClick={api.openPage} style={primaryBtn}>
                Ver a versão publicada
              </button>
              <button onClick={api.dismiss} style={ghostBtn}>
                Entrar assim
              </button>
            </>
          )}

          {!blocking && !stalled && api.phase !== 'error' && (
            <>
              {mode === 'link' ? (
                <button onClick={api.openPage} style={primaryBtn}>
                  Abrir a página da versão
                </button>
              ) : (
                <button onClick={api.apply} style={primaryBtn}>
                  {mode === 'auto' ? 'Atualizar agora' : 'Baixar e abrir o instalador'}
                </button>
              )}
              <button
                onClick={api.skip}
                style={ghostBtn}
                title="não lembrar até sair uma versão mais nova"
              >
                Pular esta versão
              </button>
              <button onClick={api.dismiss} style={ghostBtn}>
                Depois
              </button>
            </>
          )}

          {api.phase === 'error' && (
            <>
              <button
                onClick={() => {
                  if (info && mode !== 'link') api.apply()
                  else api.openPage()
                }}
                style={primaryBtn}
              >
                Tentar de novo
              </button>
              <button onClick={api.dismiss} style={ghostBtn}>
                Entrar sem atualizar
              </button>
            </>
          )}

          {blocking && (
            <div style={{ fontSize: 11.5, color: '#8b95a6', lineHeight: 1.5 }}>
              não feche o app agora — se demorar, o instalador do sistema está esperando
              você.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Seção 2: ghostBtn
const ghostBtn: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 9,
  border: '1px solid #2f3742',
  background: 'transparent',
  color: '#b7c0cd',
  fontWeight: 700,
  fontSize: 12.5,
  cursor: 'pointer',
}

const primaryBtn: React.CSSProperties = {
  flex: 1,
  padding: '10px 14px',
  borderRadius: 9,
  border: 'none',
  background: '#4c8dff',
  color: '#04203f',
  fontWeight: 800,
  fontSize: 13,
  cursor: 'pointer',
}
