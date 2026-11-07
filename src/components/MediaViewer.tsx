import { useEffect, useRef } from 'react'
import { Ic } from '../shared/icons'

export interface MediaViewerProps {
  url: string
  name: string
  video: boolean
  /** Rótulo do botão principal: "Salvar" quando o arquivo já foi baixado. */
  onSave?: () => void
  saveLabel?: string
  onClose: () => void
}

/**
 * Tela cheia para imagem/vídeo do card de arquivo.
 * Fecha com Esc ou clique fora; o vídeo toca no lugar (sem nova captura).
 */
export function MediaViewer({ url, name, video, onSave, saveLabel, onClose }: MediaViewerProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    closeRef.current?.focus()
    const before = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = before
    }
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-testid="media-viewer"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 300,
        background: 'rgba(0,0,0,.92)',
        display: 'flex',
        flexDirection: 'column',
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginBottom: 10 }}
      >
        <span
          title={name}
          style={{
            flex: 1,
            minWidth: 0,
            color: '#e6e8eb',
            fontSize: 13,
            fontWeight: 700,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
        {onSave && (
          <button
            type="button"
            onClick={onSave}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: '#5865f2',
              color: '#fff',
              border: 'none',
              padding: '8px 14px',
              borderRadius: 8,
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Ic name="download" size={14} />
            {saveLabel ?? 'Salvar'}
          </button>
        )}
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          title="Fechar (Esc)"
          aria-label="Fechar"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(255,255,255,.12)',
            color: '#e6e8eb',
            border: 'none',
            width: 34,
            height: 34,
            borderRadius: 8,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <Ic name="x" size={17} />
        </button>
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        {video ? (
          <video
            src={url}
            controls
            autoPlay
            playsInline
            style={{ maxWidth: '100%', maxHeight: '100%', borderRadius: 8, background: '#000' }}
          />
        ) : (
          <img
            src={url}
            alt={name}
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', borderRadius: 8 }}
          />
        )}
      </div>

      <div style={{ flexShrink: 0, textAlign: 'center', color: '#8e929b', fontSize: 11, marginTop: 8 }}>
        Esc ou clique fora para fechar
      </div>
    </div>
  )
}

export default MediaViewer
