import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import { NotificationPrompt } from './components/NotificationPrompt'
import { initAppState } from './services/appState'
import { initNotifications } from './services/notifications'
import { offerInvite, tokenFromInviteUrl } from './services/deepLink'
import { installExternalLinkHandler, OPEN_EXTERNAL_FAILED_EVENT, type OpenExternalFailure } from './shared/installExternalLinks'

const ThemeShell = React.lazy(() => import('./designs/ThemeShell'))
const MobileShell = React.lazy(() => import('./mobile/MobileShell'))
const BotsApp = React.lazy(() => import('./routes/BotsApp'))

/**
 * A janela própria de bots abre em `index.html?bots=1` (ver `open_bots_window`
 * no Rust). O sinal evita que a segunda webview suba a interface inteira e
 * duplique efeitos globais: presença, notificações e deep link rodariam duas
 * vezes, com dois processos disputando a mesma conta.
 */
const MODO_JANELA_BOTS = (() => {
  try {
    return new URLSearchParams(window.location.search).get('bots') === '1'
  } catch {
    return false
  }
})()

const MOBILE_MAX_WIDTH = 768

function useIsMobile(){
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== 'undefined' && window.innerWidth <= MOBILE_MAX_WIDTH
  )
  React.useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= MOBILE_MAX_WIDTH)
    window.addEventListener('resize', onResize)
    window.addEventListener('orientationchange', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('orientationchange', onResize)
    }
  }, [])
  return isMobile
}

function AutoRoute(){
  const isMobile = useIsMobile()
  if(isMobile) return <Navigate to="/m" replace />
  return <Navigate to="/d/distorrent" replace />
}

/** Splash enquanto o chunk do shell baixa (não é tela branca). */
function ShellFallback(){
  return (
    <div className="boot" data-testid="shell-loading">
      <div className="boot-logo">DisTorrent</div>
      <div className="boot-bar"><i /></div>
      <div className="boot-sub">carregando a interface…</div>
    </div>
  )
}

function DesktopRoute(){
  const isMobile = useIsMobile()
  return (
    <React.Suspense fallback={<ShellFallback />}>
      {isMobile ? <MobileShell /> : <ThemeShell designId="distorrent" />}
    </React.Suspense>
  )
}

function InviteRoute({ token }: { token: string }){
  const isMobile = useIsMobile()
  React.useEffect(() => {
    if (token) offerInvite(token)
  }, [token])
  return <Navigate to={isMobile ? '/m' : '/d/distorrent'} replace />
}

function AppRoutes(){
  React.useEffect(() => {
    if (MODO_JANELA_BOTS) return
    initAppState()
    initNotifications()
  }, [])
  React.useEffect(() => (MODO_JANELA_BOTS ? undefined : installExternalLinkHandler()), [])

  // Falha ao abrir link: antes ia só para o console e o clique parecia morto.
  const [linkErro, setLinkErro] = React.useState<string | null>(null)
  React.useEffect(() => {
    const onFalha = (ev: Event) => {
      const det = (ev as CustomEvent<OpenExternalFailure>).detail
      setLinkErro(
        `não consegui abrir o navegador (${det?.message ?? 'sem navegador padrão'}). ` +
          'O endereço está no console; copie de lá ou defina um navegador padrão no sistema.',
      )
    }
    window.addEventListener(OPEN_EXTERNAL_FAILED_EVENT, onFalha as EventListener)
    return () => window.removeEventListener(OPEN_EXTERNAL_FAILED_EVENT, onFalha as EventListener)
  }, [])

  React.useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      const fromQuery = params.get('invite') || params.get('token')
      if (fromQuery) {
        offerInvite(fromQuery)
        params.delete('invite')
        params.delete('token')
        const qs = params.toString()
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
        )
      }
    } catch {  }

    const w = window as unknown as Record<string, unknown>
    if (!('__TAURI_INTERNALS__' in w || '__TAURI__' in w || '__TAURI_IPC__' in w)) return

    let disposed = false
    let unlisten: (() => void) | undefined

    const handleUrls = (urls: string[]) => {
      for (const raw of urls) {
        if (tokenFromInviteUrl(raw)) {
          offerInvite(raw)
          break
        }
      }
    }

    void import('@tauri-apps/plugin-deep-link')
      .then(async (deepLink) => {
        if (disposed) return
        const current = await deepLink.getCurrent()
        if (current?.length) handleUrls(current)
        unlisten = await deepLink.onOpenUrl((urls) => handleUrls(urls))
      })
      .catch((e) => {
        console.warn('[distorrent] deep link indisponível:', String(e))
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  return (
    <>
      <Routes>
        <Route path="/" element={<AutoRoute />} />
        <Route path="/d/distorrent" element={<DesktopRoute />} />
        <Route path="/m" element={<React.Suspense fallback={<ShellFallback />}><MobileShell /></React.Suspense>} />
        <Route path="/mobile" element={<React.Suspense fallback={<ShellFallback />}><MobileShell /></React.Suspense>} />
        <Route path="/invite/:token" element={<InviteRouteWrapper />} />
        <Route
          path="/bots"
          element={
            <React.Suspense fallback={<ShellFallback />}>
              <BotsApp />
            </React.Suspense>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {linkErro && (
        <div
          role="alert"
          data-testid="link-open-error"
          style={{
            position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 9999,
            background: '#2a2015', border: '1px solid #f0b232', borderRadius: 10,
            padding: '10px 12px', display: 'flex', alignItems: 'flex-start', gap: 10,
            boxShadow: '0 10px 30px rgba(0,0,0,.5)', fontSize: 12.5,
            color: '#f2f3f5', lineHeight: 1.5,
          }}
        >
          <span style={{ flex: 1, minWidth: 0 }}>{linkErro}</span>
          <button
            type="button"
            onClick={() => setLinkErro(null)}
            aria-label="Fechar aviso"
            style={{
              background: 'transparent', border: 'none', color: '#f0b232',
              cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: 2, flexShrink: 0,
            }}
          >×</button>
        </div>
      )}
    </>
  )
}
export default function App(){
  // Janela dedicada: nenhuma rota, nenhum prompt global. Só a tela de bots.
  if (MODO_JANELA_BOTS) {
    return (
      <React.Suspense fallback={<ShellFallback />}>
        <BotsApp />
      </React.Suspense>
    )
  }
  return (
    <BrowserRouter>
      <AppRoutes />
      {}
      <NotificationPrompt />
    </BrowserRouter>
  )
}

function InviteRouteWrapper(){
  const { token: pathToken } = useParams<{ token: string }>()
  const { search } = useLocation()
  const params = new URLSearchParams(search)
  const token = pathToken || params.get('invite') || ''
  return <InviteRoute token={token} />
}
