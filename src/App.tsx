import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import ThemeShell from './designs/ThemeShell'
import MobileShell from './mobile/MobileShell'

function AutoRoute(){
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
  if(isMobile) return <Navigate to="/m" replace />
  return <Navigate to="/d/forge" replace />
}

// Link de convite público: /invite/TOKEN → abre o shell com o token pré-preenchido
function InviteRoute({ token }: { token: string }){
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 768
  const target = isMobile ? '/m' : '/d/forge'
  return <Navigate to={`${target}?invite=${encodeURIComponent(token)}`} replace />
}

export default function App(){
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AutoRoute />} />
        <Route path="/d/forge" element={<ThemeShell designId="forge" />} />
        <Route path="/m" element={<MobileShell />} />
        <Route path="/mobile" element={<MobileShell />} />
        <Route path="/invite/:token" element={<InviteRouteWrapper />} />
        <Route path="*" element={<Navigate to="/d/forge" replace />} />
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
