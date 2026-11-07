import { useCallback, useEffect, useState } from 'react'
import { services } from '../services'
import { isDeepLinkUrl } from './externalLinks'
import { Ic } from './icons'
import { Button, ui } from './ui'

export interface LocalAddresses {
  localhost: string
  lan: string | null
  lan_all: string[]
  port: number
}

function pathOf(url: string, fallback = '/'): string {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}` || fallback
  } catch {
    return fallback
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

export function LocalLink({
  url,
  label = 'Link local',
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

  const deepLink = isDeepLinkUrl(url)
  const lanUrl = !deepLink && lan ? `http://${lan}${route}` : null

  if (deepLink) {
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
        <LinkRow href={url} onCopy={() => copy(url)} copied={copied === 'ok'} display={url} />
        <div style={{ fontSize: 11, color: ui.muted, lineHeight: 1.5, marginTop: 8 }}>
          Este endereço abre o DisTorrent instalado (não é página de site). Para outra pessoa,
          mande o convite pelo próprio app.
        </div>
        {copied === 'fail' && (
          <div role="status" style={{ fontSize: 11, color: '#ffb3b3', marginTop: 10 }}>
            Não foi possível copiar automaticamente. Selecione o endereço acima e copie.
          </div>
        )}
      </div>
    )
  }

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

      {}
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

      {}
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
  const isDeepLink = isDeepLinkUrl(href)
  const textStyle = {
    flex: '1 1 180px',
    minWidth: 0,
    color: ui.link,
    fontFamily: 'JetBrains Mono, monospace',
    fontSize: 12,
    textDecoration: 'underline',
    wordBreak: 'break-all',
    lineHeight: 1.5,
  } as const
  const abrir = () => {
    if (isDeepLink) {
      void services.openExternal(href).catch(() => {  })
      return
    }
    window.open(href, '_blank', 'noopener')
  }
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
      {isDeepLink ? (
        <span style={textStyle} title={href}>{display}</span>
      ) : (
        <a href={href} target="_blank" rel="noreferrer noopener" style={textStyle}>
          {display}
        </a>
      )}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button icon="externalLink" onClick={abrir}>
          Abrir
        </Button>
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