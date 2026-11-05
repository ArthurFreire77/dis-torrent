import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Icons } from '../../shared/icons'
import { attachStream } from '../../shared/mediaAttach'
import type { CallTile as CallTileModel } from '../../services/callTiles'

export interface ScreenStagePalette {
  heading: string
  muted: string
  green: string
  red: string
  accent: string
  border: string
}

export interface ScreenStageProps {
  tile: CallTileModel
  palette: ScreenStagePalette
  onCollapse: () => void
  muted?: boolean
  onToggleMute?: () => void
  cameraOn?: boolean
  sharing?: boolean
  onToggleCamera?: () => void
  onLeave?: () => void
  callTitle?: string
}

const CHROME_HIDE_MS = 2600

export function ScreenStage({
  tile,
  palette: c,
  onCollapse,
  muted = false,
  onToggleMute,
  cameraOn = false,
  sharing = false,
  onToggleCamera,
  onLeave,
  callTitle,
}: ScreenStageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [chromeVisible, setChromeVisible] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setChromeVisible(false), CHROME_HIDE_MS)
  }, [])
  const showChrome = useCallback(() => {
    setChromeVisible(true)
    scheduleHide()
  }, [scheduleHide])

  useEffect(() => {
    scheduleHide()
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current) }
  }, [scheduleHide])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        try {
          if (document.fullscreenElement) void document.exitFullscreen?.()
        } catch {  }
        onCollapse()
        return
      }
      showChrome()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCollapse, showChrome])

  const showVideo = !!tile.stream
  const showImage = !showVideo && !!tile.videoUrl

  return (
    <div
      data-testid="call-screen-stage"
      data-call-stage-id={tile.id}
      role="dialog"
      aria-modal="true"
      aria-label={`Tela cheia: ${tile.label}`}
      onMouseMove={showChrome}
      onMouseEnter={showChrome}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 150,
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: chromeVisible ? 'default' : 'none',
      }}
    >
      {
}
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {showVideo ? (
          <video
            autoPlay
            playsInline
            muted
            ref={(el) => {
              videoRef.current = el
              attachStream(el, tile.stream)
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              background: '#000',
              display: 'block',
            }}
          />
        ) : showImage ? (
          <img
            src={tile.videoUrl}
            alt={tile.label}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <div style={{ textAlign: 'center', color: c.heading }}>
            <Icon d={Icons.screen} size={56} />
            <div style={{ marginTop: 14, fontSize: 15, fontWeight: 700 }}>{tile.label}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: c.muted }}>aguardando o primeiro quadro…</div>
          </div>
        )}
      </div>

      {
}

      {}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          paddingTop: 'max(10px, env(safe-area-inset-top))',
          background: 'linear-gradient(180deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,0) 100%)',
          opacity: chromeVisible ? 1 : 0,
          pointerEvents: chromeVisible ? 'auto' : 'none',
          transition: 'opacity 180ms ease',
        }}
      >
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0,
            color: '#fff', fontSize: 13, fontWeight: 700,
          }}
        >
          <span style={{ display: 'flex', color: c.green }}><Icon d={Icons.screen} size={16} /></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tile.label}{callTitle ? ` • ${callTitle}` : ''}
          </span>
        </span>

        <span style={{ flex: 1 }} />

        {onToggleMute && (
          <button
            type="button"
            onClick={onToggleMute}
            title={muted ? 'Ativar microfone' : 'Silenciar'}
            aria-label={muted ? 'Ativar microfone' : 'Silenciar'}
            style={{
              width: 38, height: 38, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: muted ? c.red : 'rgba(255,255,255,.14)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={muted ? Icons.micOff : Icons.mic} size={16} />
          </button>
        )}
        {onToggleCamera && (
          <button
            type="button"
            onClick={onToggleCamera}
            disabled={sharing && !cameraOn}
            title={sharing && !cameraOn ? 'Pare a tela para ligar a câmera' : (cameraOn ? 'Desligar câmera' : 'Ligar câmera')}
            aria-label={sharing && !cameraOn ? 'Câmera indisponível enquanto compartilha a tela' : (cameraOn ? 'Desligar câmera' : 'Ligar câmera')}
            style={{
              width: 38, height: 38, borderRadius: '50%', border: 'none',
              cursor: sharing && !cameraOn ? 'not-allowed' : 'pointer',
              opacity: sharing && !cameraOn ? 0.45 : 1,
              background: cameraOn ? c.green : 'rgba(255,255,255,.14)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={Icons.video} size={16} />
          </button>
        )}
        {onLeave && (
          <button
            type="button"
            onClick={onLeave}
            title="Sair da chamada"
            aria-label="Sair da chamada"
            style={{
              width: 38, height: 38, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: c.red, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={Icons.phone} size={16} rotate={135} />
          </button>
        )}

        {}
        <button
          type="button"
          onClick={onCollapse}
          title="Recolher (Esc)"
          aria-label="Recolher tela compartilhada"
          style={{
            height: 38, padding: '0 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,.28)',
            background: 'rgba(255,255,255,.14)', color: '#fff', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700,
          }}
        >
          <Icon d={Icons.collapse} size={15} /> Recolher
        </button>
      </div>

      {}
      <div
        style={{
          position: 'absolute',
          bottom: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 11,
          color: 'rgba(255,255,255,.62)',
          background: 'rgba(0,0,0,.55)',
          padding: '4px 10px',
          borderRadius: 99,
          opacity: chromeVisible ? 1 : 0,
          transition: 'opacity 180ms ease',
          pointerEvents: 'none',
        }}
      >
        Esc recolhe • a chamada continua
      </div>
    </div>
  )
}

// Seção 1: ScreenStage
export default ScreenStage
