import { useState, type ReactNode } from 'react'
import { Ic } from '../shared/icons'
import { formatFileSize } from '../shared/bytes'
import { isVideoName } from '../services/fileRules'
import {
  downloadButtonLabel,
  downloadButtonState,
  formatSpeed,
  type FileCardProgress,
} from './fileCardRules'
import { MediaViewer } from './MediaViewer'

export type { FileCardProgress }
export { downloadButtonLabel, formatSpeed }

/** Selo de "abrir em tela cheia" no canto da prévia. */
const expandBadge: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 26,
  height: 26,
  borderRadius: 7,
  background: 'rgba(0,0,0,.62)',
  color: '#fff',
  pointerEvents: 'none',
  backdropFilter: 'blur(2px)',
}

export interface FileCardPalette {
  text: string
  heading: string
  muted: string
  accent: string
  input: string
  border: string
  main: string
  green: string
  red: string
  yellow: string
}

export function FileCard({
  name,
  size,
  chunks,
  mine,
  mstatus,
  announced,
  previewUrl,
  progress,
  pal,
  onDownload,
  onRetry,
  extra,
}: {
  name: string
  size: number
  chunks: number
  mine?: boolean
  mstatus?: string
  announced: boolean
  previewUrl?: string
  progress?: FileCardProgress
  pal: FileCardPalette
  onDownload: () => void
  onRetry?: () => void
  extra?: ReactNode
}) {
  const done = (progress?.pct ?? 0) >= 100 && progress?.status === 'completed'
  const pct = Math.round(progress?.pct ?? 0)
  const failed = progress?.status === 'failed'
  const paused = progress?.status === 'paused'
  const st = downloadButtonState(announced, done, progress)
  const showBar = !!announced && !done && (st.tone === 'busy' || failed || paused || pct > 0)
  const video = isVideoName(name)
  const [full, setFull] = useState(false)

  const openFull = () => {
    if (previewUrl) setFull(true)
  }

  // Azul = não iniciado, amarelo = em andamento, verde = baixado, vermelho = falhou.
  const toneColor =
    st.tone === 'done' ? pal.green : st.tone === 'failed' ? pal.red : st.tone === 'busy' ? pal.yellow : pal.accent

  return (
    <>
      {full && previewUrl && (
        <MediaViewer
          url={previewUrl}
          name={name}
          video={video}
          onSave={onDownload}
          saveLabel={done ? 'Salvar' : downloadButtonLabel(announced, done, progress, !!previewUrl)}
          onClose={() => setFull(false)}
        />
      )}
      <div
      style={{
        marginTop: 6,
        background: pal.input,
        border: `1px solid ${failed ? pal.red : pal.border}`,
        borderRadius: 12,
        padding: '10px 12px',
        maxWidth: 420,
        minWidth: 0,
      }}
    >
      {}
      {previewUrl && video && (
        <div
          role="button"
          tabIndex={0}
          title="Abrir em tela cheia"
          aria-label={`Abrir ${name} em tela cheia`}
          onClick={openFull}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openFull() }}
          style={{ position: 'relative', cursor: 'zoom-in', marginBottom: 10 }}
        >
          <video
            src={previewUrl}
            controls
            preload="metadata"
            style={{ width: '100%', maxHeight: 340, borderRadius: 10, display: 'block', background: '#000' }}
          />
          <span style={expandBadge} aria-hidden="true"><Ic name="expand" size={13} /></span>
        </div>
      )}
      {previewUrl && !video && (
        <div
          role="button"
          tabIndex={0}
          title="Abrir em tela cheia"
          aria-label={`Abrir ${name} em tela cheia`}
          onClick={openFull}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openFull() }}
          style={{ position: 'relative', cursor: 'zoom-in', marginBottom: 10, display: 'inline-block', maxWidth: '100%' }}
        >
          <img
            src={previewUrl}
            alt={name}
            style={{ maxWidth: '100%', maxHeight: 320, borderRadius: 10, display: 'block' }}
          />
          <span style={expandBadge} aria-hidden="true"><Ic name="expand" size={13} /></span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <span style={{ display: 'flex', flexShrink: 0, color: pal.muted }}>
          <Ic name="attach" size={20} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            title={name}
            style={{ fontSize: 13, fontWeight: 800, color: pal.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {name}
          </div>
          <div style={{ fontSize: 11, color: pal.muted, marginTop: 2 }}>
            {formatFileSize(size)} · {chunks} {chunks === 1 ? 'bloco' : 'blocos'}
          </div>
        </div>
      </div>

      {
}
      {showBar && (
        <div style={{ marginTop: 8 }}>
          <div style={{ height: 6, background: pal.main, borderRadius: 99, overflow: 'hidden' }}>
            <div
              className={st.tone === 'busy' ? 'dl-bar' : undefined}
              style={{
                width: `${Math.max(2, pct)}%`,
                height: '100%',
                background: failed ? pal.red : paused ? pal.yellow : pal.yellow,
                transition: 'width .3s',
              }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 11 }}>
            <span style={{ fontWeight: 800, color: failed ? pal.red : paused ? pal.yellow : pal.text, fontVariantNumeric: 'tabular-nums' }}>
              {pct}%
            </span>
            <span style={{ color: pal.muted }}>·</span>
            <span style={{ color: pal.muted, fontVariantNumeric: 'tabular-nums' }}>
              {paused ? 'pausado' : failed ? 'parou' : formatSpeed(progress?.speed ?? 0)}
            </span>
            {!failed && !paused && progress?.status === 'downloading' && (
              <span style={{ color: pal.muted, marginLeft: 'auto' }}>
                {formatFileSize(Math.round((size * pct) / 100))} de {formatFileSize(size)}
              </span>
            )}
          </div>
        </div>
      )}

      {done && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 11, color: pal.green, fontWeight: 700 }}>
          <Ic name="check" size={13} />
          completa e verificada
        </div>
      )}
      {!announced && (
        <div style={{ fontSize: 11, color: pal.muted, marginTop: 6 }}>
          aguardando o anúncio do arquivo…
        </div>
      )}
      {failed && progress?.error && (
        <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 6, lineHeight: 1.5 }}>{progress.error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          type="button"
          className={done ? 'dl-pop' : undefined}
          onClick={onDownload}
          disabled={!st.clickable}
          aria-busy={st.spinning}
          title={
            !announced
              ? 'o anúncio deste arquivo ainda não chegou'
              : done
                ? 'baixado e verificado'
                : st.tone === 'busy'
                  ? 'download em andamento'
                  : 'baixar do swarm e salvar em Downloads'
          }
          style={{
            background: toneColor,
            color: st.tone === 'busy' ? '#1e1f22' : '#fff',
            border: 'none',
            padding: '7px 12px',
            borderRadius: 8,
            cursor: st.clickable ? 'pointer' : 'default',
            fontSize: 12,
            fontWeight: 800,
            opacity: !announced ? 0.55 : 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            transition: 'background .25s, transform .12s',
          }}
        >
          <span className={st.spinning ? 'spin' : undefined} style={{ display: 'inline-flex' }}>
            <Ic name={st.icon} size={14} />
          </span>
          {st.label}
        </button>
        {st.showRedownload && (
          <button
            type="button"
            className="dl-pop"
            onClick={onDownload}
            title="baixar outra cópia do swarm e salvar em Downloads"
            style={{
              background: pal.red,
              color: '#fff',
              border: 'none',
              padding: '7px 12px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 800,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Ic name="download" size={14} />
            Baixar novamente
          </button>
        )}
        {extra}
        {mine && mstatus === 'failed' && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              background: 'transparent',
              color: pal.muted,
              border: `1px solid ${pal.border}`,
              padding: '7px 12px',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            Reenviar mensagem
          </button>
        )}
      </div>
      </div>
    </>
  )
}

export default FileCard
