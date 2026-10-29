import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation, useNavigate } from 'react-router-dom'
import ThemeShell from './designs/ThemeShell'
import MobileShell from './mobile/MobileShell'

// A largura decidia o shell só no primeiro render: quem abria no desktop e
// reduzia a janela (ou girava um tablet) ficava com o layout de PC espremido
// em 390px — abas de amigos saindo da tela e área preta sem conteúdo.
// Agora a troca reage ao resize, sem precisar recarregar a página.
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

// Rota do shell de PC: em largura de celular entrega o shell mobile no mesmo
// endereço, em vez de deformar o ThemeShell.
function DesktopRoute(){
  const isMobile = useIsMobile()
  if(isMobile) return <MobileShell />
  return <ThemeShell designId="distorrent" />
}

// Link de convite público: /invite/TOKEN → abre o shell com o token pré-preenchido
function InviteRoute({ token }: { token: string }){
  const isMobile = useIsMobile()
  const target = isMobile ? '/m' : '/d/distorrent'
  return <Navigate to={`${target}?invite=${encodeURIComponent(token)}`} replace />
}

function AppRoutes(){
  const navigate = useNavigate()

  React.useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    if (!('__TAURI_INTERNALS__' in w || '__TAURI__' in w || '__TAURI_IPC__' in w)) return

    let disposed = false
    let unlisten: (() => void) | undefined

    const openInvite = (urls: string[]) => {
      for (const raw of urls) {
        try {
          const url = new URL(raw)
          const invite = url.searchParams.get('invite') || url.searchParams.get('token')
            || url.pathname.split('/').filter(Boolean).pop()
          if (!invite) continue
          const target = window.innerWidth <= MOBILE_MAX_WIDTH ? '/m' : '/d/distorrent'
          navigate(`${target}?invite=${encodeURIComponent(invite)}`, { replace: false })
          break
        } catch { /* URL inválida: ignorar sem derrubar o shell */ }
      }
    }

    void import('@tauri-apps/plugin-deep-link')
      .then(async (deepLink) => {
        if (disposed) return
        const current = await deepLink.getCurrent()
        if (current?.length) openInvite(current)
        unlisten = await deepLink.onOpenUrl(openInvite)
      })
      .catch(() => { /* Deep-link indisponível em builds antigas */ })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [navigate])

  return (
    <Routes>
      <Route path="/" element={<AutoRoute />} />
      <Route path="/d/distorrent" element={<DesktopRoute />} />
      <Route path="/m" element={<MobileShell />} />
      <Route path="/mobile" element={<MobileShell />} />
      <Route path="/invite/:token" element={<InviteRouteWrapper />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App(){
  return (
    <BrowserRouter>
      <AppRoutes />
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
