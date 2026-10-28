import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
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

export default function App(){
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AutoRoute />} />
        <Route path="/d/distorrent" element={<DesktopRoute />} />
        <Route path="/m" element={<MobileShell />} />
        <Route path="/mobile" element={<MobileShell />} />
        <Route path="/invite/:token" element={<InviteRouteWrapper />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
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
