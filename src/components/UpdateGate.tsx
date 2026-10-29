// TELA DE ATUALIZAÇÃO DO BOOT.
//
// POR QUE ELA EXISTE: o pedido é "sempre tentar atualizar antes de entrar". Só
// que atualizar não pode ser um bloqueio cego — se a rede falhar, o app tem que
// abrir igual. Então o desenho é:
//
//   1. A checagem roda EM PARALELO com o carregamento da identidade (não
//      adiciona espera no caminho bom).
//   2. Se não há versão nova (ou o usuário pulou, ou a checagem falhou), a
//      tela NÃO aparece e o boot segue normalmente.
//   3. Se há versão nova e a preferência `auto` está ligada, aparece um overlay
//      com progresso honesto: o Rust baixa o instalador, confere o SHA-256 e
//      executa; no Windows o Inno fecha este processo e reabre sozinho.
//   4. Se o modo é manual/link (Linux/Android) ou o usuário escolheu "depois",
//      aparece um cartão com botão — nunca um download silencioso.
//
// O texto de estado é sempre o que está ACONTECENDO: nada de "atualizando…"
// enquanto só verificamos, porque isso mente para o usuário e esconde falha.

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
  | 'error'

export interface UpdateGateState {
  phase: UpdatePhase
  info: UpdateInfo | null
  /** Versão do app em execução (mostrada no cartão). */
  current: string
  message: string
  /** 0..1 quando o Rust informar; `null` = indeterminado (honesto). */
  progress: number | null
}

export interface UpdateGateApi extends UpdateGateState {
  /** Mostra o cartão de update (usuário recusou o automático). */
  show: () => void
  /** Baixa/instala agora. */
  apply: () => void
  /** Pula ESTA versão (não incomoda mais até sair outra). */
  skip: () => void
  /** Fecha o cartão e segue para o app. */
  dismiss: () => void
  /** Abre a página da release no navegador. */
  openPage: () => void
}

const IDLE: UpdateGateState = {
  phase: 'idle',
  info: null,
  current: '',
  message: '',
  progress: null,
}

/**
 * Hook do gate. Barato quando não há update: uma chamada de rede com timeout de
 * 15 s no Rust, que não segura a UI.
 *
 * `enabled=false` (ex.: build de navegador, ou já passou do boot) desliga tudo.
 */
export function useUpdateGate(enabled = true): UpdateGateApi {
  const [state, setState] = React.useState<UpdateGateState>(IDLE)
  const started = React.useRef(false)
  const mounted = React.useRef(true)
  const depsRef = React.useRef(nativeUpdateDeps())

  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const set = React.useCallback((patch: Partial<UpdateGateState>) => {
    if (!mounted.current) return
    setState((s) => ({ ...s, ...patch }))
  }, [])

  const run = React.useCallback(
    async (opts: { autoApply: boolean; auto: boolean }) => {
      const deps = depsRef.current
      if (!deps) return
      set({ phase: 'checking', message: 'verificando se há versão nova…' })
      let outcome: UpdateOutcome
      try {
        outcome = await runUpdateFlow(deps, { autoApply: opts.autoApply })
      } catch (e) {
        if (!mounted.current) return
        setState({ ...IDLE, phase: 'error', message: String((e as Error)?.message ?? e) })
        return
      }
      if (!mounted.current) return
      switch (outcome.kind) {
        case 'none':
          // Sem update: volta para idle e o boot continua sem overlay.
          setState(IDLE)
          return
        case 'later':
          setState({
            phase: 'later',
            info: outcome.info,
            current: outcome.info.current,
            message: '',
            progress: null,
          })
          return
        case 'applied':
          setState({
            phase: 'installing',
            info: outcome.info,
            current: outcome.info.current,
            message:
              updateModeFor(outcome.info.platform) === 'auto'
                ? 'instalador aberto — o app vai reiniciar sozinho'
                : 'instalador aberto — conclua e abra o app de novo',
            progress: null,
          })
          return
        case 'error':
          // Falha de rede NÃO aparece como erro de tela cheia: o app abre.
          setState((s) =>
            s.info
              ? { ...s, phase: 'error', message: outcome.message }
              : { ...IDLE, phase: 'error', message: outcome.message },
          )
          return
      }
    },
    [set],
  )

  React.useEffect(() => {
    if (!enabled || started.current) return
    started.current = true
    const deps = depsRef.current
    if (!deps) {
      // Navegador puro: nada a fazer, e não inventamos "atualizado".
      return
    }
    void (async () => {
      // A preferência decide se o download+instalação é automático. Ela falhar
      // (banco trancado no boot) significa "não automático" — nunca o contrário:
      // executar instalador sem o usuário ter pedido é pior que atualizar depois.
      let auto = false
      try {
        auto = await services.updateAutoGet()
      } catch {
        auto = false
      }
      await run({ autoApply: auto, auto })
    })()
  }, [enabled, run])

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

/**
 * Overlay de atualização. `blocking` cobre a tela (durante download/instalação);
 * o cartão de "tem versão nova" é menor e tem botão de pular.
 *
 * Estilo inline porque os dois shells (desktop e mobile) já usam assim, e o CSS
 * global não tem classe de overlay — reaproveitar a `<div className="boot">`
 * faria a barra de progresso do boot aparecer atrás.
 */
export function UpdateOverlay({ api }: { api: UpdateGateApi }) {
  if (api.phase === 'idle' || api.phase === 'checking') return null

  const blocking = api.phase === 'downloading' || api.phase === 'installing'
  const info = api.info
  const mode = info ? updateModeFor(info.platform) : 'link'

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
              color: api.phase === 'error' ? '#ff8a8f' : '#7fd1a6',
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
          {!blocking && api.phase !== 'error' && (
            <>
              {mode === 'link' ? (
                <button
                  onClick={api.openPage}
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    borderRadius: 9,
                    border: 'none',
                    background: '#4c8dff',
                    color: '#04203f',
                    fontWeight: 800,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  Abrir a página da versão
                </button>
              ) : (
                <button
                  onClick={api.apply}
                  style={{
                    flex: 1,
                    padding: '10px 14px',
                    borderRadius: 9,
                    border: 'none',
                    background: '#4c8dff',
                    color: '#04203f',
                    fontWeight: 800,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
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
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: 9,
                  border: 'none',
                  background: '#4c8dff',
                  color: '#04203f',
                  fontWeight: 800,
                  fontSize: 13,
                  cursor: 'pointer',
                }}
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
