import { useEffect, useRef, useState } from 'react'
import { downloadManager } from '../services/downloadManager'
import { formatFileSize } from '../services/fileSwarm'
import type { DownloadItem, DownloadStatus } from '../services/downloadQueue'

const t = {
  sidebar: '#2b2d31',
  input: '#1e1f22',
  border: '#26272b',
  panel: '#2b2d31',
  accent: '#5865f2',
  link: '#00a8fc',
  green: '#23a559',
  yellow: '#f0b232',
  red: '#f23f42',
  text: '#dbdee1',
  heading: '#f2f3f5',
  muted: '#949ba4',
}

const STATUS_LABEL: Record<DownloadStatus, string> = {
  queued: 'na fila',
  downloading: 'baixando',
  paused: 'pausado',
  verifying: 'verificando',
  saving: 'salvando',
  completed: 'concluído',
  failed: 'falhou',
  cancelled: 'cancelado',
}

function statusColor(status: DownloadStatus): string {
  if (status === 'downloading' || status === 'queued') return t.accent
  if (status === 'paused') return t.yellow
  if (status === 'verifying' || status === 'saving') return t.link
  if (status === 'completed') return t.green
  return t.red
}

/** Botões do manager nunca quebram a UI: try/catch silencioso. */
function safeCall(fn: () => void): void {
  try {
    fn()
  } catch {
    /* ignora: painel é só leitura+comando */
  }
}

function ActionButton({ title, onClick }: { title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{
        background: t.input,
        border: `1px solid ${t.border}`,
        borderRadius: 6,
        color: t.text,
        fontSize: 11,
        fontWeight: 700,
        padding: '4px 8px',
        cursor: 'pointer',
      }}
    >
      {title}
    </button>
  )
}

export default function DownloadsPanel({ open, onClose, onDoneToast }: {
  open: boolean
  onClose: () => void
  onDoneToast?: (msg: string) => void
}) {
  const [items, setItems] = useState<DownloadItem[]>(() => {
    try {
      return downloadManager.list()
    } catch {
      return []
    }
  })
  const toastRef = useRef(onDoneToast)
  toastRef.current = onDoneToast

  useEffect(() => {
    const cleanups: Array<() => void> = []
    try {
      setItems(downloadManager.list())
    } catch {
      /* lista indisponível */
    }
    try {
      cleanups.push(downloadManager.subscribe((next) => setItems(next)))
    } catch {
      /* sem assinatura */
    }
    try {
      cleanups.push(downloadManager.onDone((item) => {
        if (item.status !== 'completed') return
        const msg = item.savedPath ? `${item.name} salvo em ${item.savedPath}` : `${item.name} salvo`
        try {
          toastRef.current?.(msg)
        } catch {
          /* toast é best-effort */
        }
      }))
    } catch {
      /* sem assinatura */
    }
    return () => {
      for (const fn of cleanups) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    }
  }, [])

  if (!open) return null

  let active: number
  try {
    active = downloadManager.activeCount()
  } catch {
    active = items.filter((i) => i.status === 'downloading' || i.status === 'queued').length
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Downloads"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: t.panel,
          border: `1px solid ${t.border}`,
          borderRadius: 12,
          padding: 22,
          width: 520,
          maxHeight: '80vh',
          overflowY: 'auto',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ color: t.heading, fontWeight: 900, fontSize: 16 }}>Downloads</div>
          <button
            type="button"
            aria-label="Fechar downloads"
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: t.muted, fontSize: 16, cursor: 'pointer', padding: 4 }}
          >
            ✕
          </button>
        </div>
        {active > 0 && (
          <div style={{ fontSize: 12, color: t.green, fontWeight: 700, marginBottom: 12 }}>
            {active} ativos
          </div>
        )}

        {items.length === 0 ? (
          <div style={{ color: t.muted, padding: 24, textAlign: 'center', fontSize: 13 }}>
            Nenhum download na fila
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {items.map((item) => (
              <div
                key={item.id}
                style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 12px' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      color: t.heading,
                      fontWeight: 700,
                      fontSize: 13,
                      flex: 1,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                    title={item.name}
                  >
                    {item.name}
                  </div>
                  <span
                    style={{
                      background: statusColor(item.status),
                      color: '#fff',
                      borderRadius: 99,
                      padding: '2px 8px',
                      fontSize: 10,
                      fontWeight: 800,
                    }}
                  >
                    {STATUS_LABEL[item.status]}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, fontSize: 11, color: t.muted }}>
                  <span>{formatFileSize(item.size)}</span>
                  {item.speedBps > 0 && <span>{`${(item.speedBps / 1024).toFixed(0)} KB/s`}</span>}
                  <span>{`${item.progress}%`}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                  <div style={{ flex: 1, height: 6, background: t.sidebar, borderRadius: 99, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${item.progress}%`,
                        height: '100%',
                        background: t.accent,
                        borderRadius: 99,
                        transition: 'width .3s',
                      }}
                    />
                  </div>
                </div>
                {item.error && (
                  <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 6 }}>{item.error}</div>
                )}
                {item.status === 'completed' && (
                  <div style={{ fontSize: 11, color: t.green, marginTop: 6 }}>
                    {`salvo em ${item.savedPath ?? item.name}`}
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {(item.status === 'downloading' || item.status === 'queued') && (
                    <ActionButton title="Pausar" onClick={() => safeCall(() => downloadManager.pause(item.file_id))} />
                  )}
                  {(item.status === 'paused' || item.status === 'failed') && (
                    <ActionButton title="Retomar" onClick={() => safeCall(() => downloadManager.resume(item.file_id))} />
                  )}
                  {item.status !== 'completed' && item.status !== 'cancelled' && (
                    <ActionButton title="Cancelar" onClick={() => safeCall(() => downloadManager.cancel(item.file_id))} />
                  )}
                  {item.status === 'failed' && (
                    <ActionButton title="Tentar novamente" onClick={() => safeCall(() => downloadManager.retry(item.file_id))} />
                  )}
                  <ActionButton title="Remover da lista" onClick={() => safeCall(() => downloadManager.remove(item.file_id))} />
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button
            type="button"
            title="Limpar concluídos"
            aria-label="Limpar concluídos"
            onClick={() => safeCall(() => downloadManager.clearFinished())}
            style={{
              background: t.input,
              border: `1px solid ${t.border}`,
              borderRadius: 8,
              color: t.text,
              fontSize: 13,
              fontWeight: 700,
              padding: '8px 14px',
              cursor: 'pointer',
            }}
          >
            Limpar concluídos
          </button>
          <button
            type="button"
            title="Fechar downloads"
            aria-label="Fechar downloads"
            onClick={onClose}
            style={{
              background: t.accent,
              border: 'none',
              borderRadius: 8,
              color: '#fff',
              fontSize: 13,
              fontWeight: 800,
              padding: '8px 14px',
              cursor: 'pointer',
            }}
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  )
}
