// Endereço local como link de verdade.
//
// O problema que isto resolve: a app mostrava `http://localhost:5173/invite/...`
// como texto puro. Três coisas erradas ao mesmo tempo:
//
//  1. Não era link. Sem `<a href>` nem botão de abrir, o celular não oferece
//     "abrir no navegador" — o usuário tinha que copiar e digitar à mão.
//  2. `localhost` no celular é O PRÓPRIO CELULAR. Copiar o link e mandar para o
//     celular não abre o computador; abre o celular e dá erro. Fingir que
//     localhost resolve para o computador é pior que não mostrar nada.
//  3. Não havia como saber o endereço certo. O IP de LAN era desconhecido da UI.
//
// A correção mostra as DUAS coisas, rotuladas:
//   - localhost — "só neste computador"
//   - IP de LAN — "use este no celular, na mesma rede Wi-Fi"
// E nunca inventa um domínio no lugar de localhost.

import { useCallback, useEffect, useState } from 'react'
import { services } from '../services'
import { Ic } from './icons'
import { Button, ui } from './ui'

export interface LocalAddresses {
  localhost: string
  lan: string | null
  lan_all: string[]
  port: number
}

/** Extrai a rota de `url` para montar os mesmos caminhos em outro host. */
function pathOf(url: string, fallback = '/'): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}` || fallback
  } catch {
    return fallback
  }
}

/**
 * Detecta se o navegador está vendo a página em loopback. Se estiver, o
 * endereço LAN é relevante; se a página já foi aberta pelo IP de LAN, não.
 */
function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

export function LocalLink({
  /** URL completa que o usuário quer compartilhar (convite, app, etc.). */
  url,
  label = 'Link local',
  /** Explica a situação específica (ex.: "convite para o servidor"). */
  context,
}: {
  url: string
  label?: string
  context?: string
}) {
  const [copied, setCopied] = useState<'none' | 'ok' | 'fail'>('none')
  const [addrs, setAddrs] = useState<LocalAddresses | null>(null)

  useEffect(() => {
    let alive = true
    services
      .localAddresses()
      .then((a) => alive && setAddrs(a))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // "Copiado" some sozinho: um feedback que não expira vira mentira.
  useEffect(() => {
    if (copied === 'none') return
    const t = setTimeout(() => setCopied('none'), 2200)
    return () => clearTimeout(t)
  }, [copied])

  const copy = useCallback(async (value: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('sem clipboard')
      await navigator.clipboard.writeText(value)
      setCopied('ok')
    } catch {
      // Fallback legado — e o único caminho em WebView sem permissão de
      // clipboard.
      try {
        const ta = document.createElement('textarea')
        ta.value = value
        ta.setAttribute('readonly', '')
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(ok ? 'ok' : 'fail')
      } catch {
        setCopied('fail')
      }
    }
  }, [])

  const route = pathOf(url)
  const onLoopback = typeof window !== 'undefined' && isLoopbackHost(window.location.host)
  const lan = addrs?.lan ?? null

  // Quando a página JÁ está sendo aberta pelo IP de LAN, o localhost não
  // interessa — o endereço certo é o que está na barra de endereços.
  const lanUrl = lan ? `http://${lan}${route}` : null

  return (
    <div
      style={{
        background: ui.surface,
        border: `1px solid ${ui.border}`,
        borderRadius: ui.radius,
        padding: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ color: ui.muted }}>
          <Ic name="globe" size={15} />
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: ui.heading, letterSpacing: 0.4 }}>
          {label.toUpperCase()}
        </span>
      </div>

      {context && (
        <div style={{ fontSize: 12, color: ui.muted, lineHeight: 1.5, marginBottom: 12 }}>
          {context}
        </div>
      )}

      {/* localhost — válido só aqui */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: ui.muted, marginBottom: 5 }}>
          NESTE COMPUTADOR
        </div>
        <LinkRow
          href={url}
          onCopy={() => copy(url)}
          copied={copied === 'ok'}
          display={url}
        />
      </div>

      {/* IP de LAN — o que funciona no celular */}
      {lanUrl ? (
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: ui.link, marginBottom: 5 }}>
            NO CELULAR (MESMA REDE WI-FI)
          </div>
          <LinkRow
            href={lanUrl}
            onCopy={() => copy(lanUrl)}
            copied={copied === 'ok'}
            display={lanUrl}
          />
          {onLoopback && (
            <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.5, marginTop: 7 }}>
              <code style={{ color: ui.warning }}>localhost</code> no celular aponta para o próprio
              celular, não para este computador. Use o endereço acima.
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.5 }}>
          Nenhum endereço de rede local detectado — este computador não está em uma rede
          Wi-Fi/cabeada, então o celular não consegue alcançá-lo.
        </div>
      )}

      {copied === 'fail' && (
        <div
          role="status"
          style={{ fontSize: 11, color: '#ffb3b3', marginTop: 10 }}
        >
          Não foi possível copiar automaticamente. Selecione o endereço acima e copie.
        </div>
      )}
    </div>
  )
}

/** Linha: link clicável + abrir + copiar, com feedback de cópia. */
function LinkRow({
  href,
  display,
  onCopy,
  copied,
}: {
  href: string
  display: string
  onCopy: () => void
  copied: boolean
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: ui.input,
        border: `1px solid ${ui.border}`,
        borderRadius: ui.radiusSm,
        padding: '9px 10px',
        flexWrap: 'wrap',
      }}
    >
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        style={{
          flex: '1 1 180px',
          minWidth: 0,
          color: ui.link,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 12,
          textDecoration: 'underline',
          wordBreak: 'break-all',
          lineHeight: 1.5,
        }}
      >
        {display}
      </a>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <a href={href} target="_blank" rel="noreferrer noopener" style={{ display: 'inline-flex' }}>
          <Button icon="externalLink" onClick={() => window.open(href, '_blank', 'noopener')}>
            Abrir
          </Button>
        </a>
        <Button
          icon={copied ? 'check' : 'copy'}
          onClick={onCopy}
          variant={copied ? 'success' : 'secondary'}
          ariaLabel={copied ? 'Endereço copiado' : 'Copiar endereço'}
        >
          {copied ? 'Copiado' : 'Copiar'}
        </Button>
      </div>
    </div>
  )
}