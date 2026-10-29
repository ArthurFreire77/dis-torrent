import React from 'react'
import { BrowserRouter, Routes, Route, Navigate, useParams, useLocation } from 'react-router-dom'
import ThemeShell from './designs/ThemeShell'
import MobileShell from './mobile/MobileShell'
import { NotificationPrompt } from './components/NotificationPrompt'
import { initAppState } from './services/appState'
import { initNotifications } from './services/notifications'
import { offerInvite, tokenFromInviteUrl } from './services/deepLink'

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

// Link de convite público: /invite/TOKEN.
//
// NÃO redireciona com `?invite=` na URL. O redirecionamento era o que quebrava
// o fluxo: o shell já estava montado, lia a query só na montagem e o convite
// se perdia. Agora o token vai para o store de convites e o shell o consome
// quando estiver pronto para abrir o modal.
function InviteRoute({ token }: { token: string }){
  const isMobile = useIsMobile()
  React.useEffect(() => {
    if (token) offerInvite(token)
  }, [token])
  return <Navigate to={isMobile ? '/m' : '/d/distorrent'} replace />
}

function AppRoutes(){
  // Uma vez só, para os DOIS shells: conexão × atividade × presença e o
  // ouvinte do clique na notificação (que abre a conversa certa).
  React.useEffect(() => {
    initAppState()
    initNotifications()
  }, [])

  // Convites por DEEP LINK (desktop + Android).
  //
  // O que estava errado: `navigate('/d/distorrent?invite=...')` com o shell já
  // montado não reexecutava nenhum efeito — o convite era descartado e a URL
  // ficava suja. Além disso a capability padrão não permitia `getCurrent`, e o
  // `.catch` engolia o erro.
  //
  // Agora todos os caminhos (boot, link com o app aberto, /invite/:token)
  // desembocam em `offerInvite`, que deduplica e notifica os shells via
  // `subscribeInvite`.
  React.useEffect(() => {
    // 1) query da URL atual (?invite= / ?token=) — cobre o modo navegador e o
    //    redirecionamento de instalações antigas.
    try {
      const params = new URLSearchParams(window.location.search)
      const fromQuery = params.get('invite') || params.get('token')
      if (fromQuery) {
        offerInvite(fromQuery)
        // Limpa a query para o convite não ser reprocessado num refresh.
        params.delete('invite')
        params.delete('token')
        const qs = params.toString()
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
        )
      }
    } catch { /* URL malformada não pode derrubar o boot */ }

    // 2) deep link do sistema. No Windows/Linux o single-instance entrega a
    //    URL à instância viva; no Android/macOS o plugin emite o evento.
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
        // NÃO silenciar: se o ACL negar `get_current`, o convite por link não
        // funciona e quem depura precisa ver por quê. O token manual segue.
        console.warn('[distorrent] deep link indisponível:', String(e))
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

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
      {/* Pergunta de notificações: uma vez, ~1 min após abrir, nunca repete. */}
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
