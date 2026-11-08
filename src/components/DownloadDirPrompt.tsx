import { useEffect, useState } from 'react'
import { services } from '../services'
import { formatFileSize } from '../shared/bytes'
import { answerDownloadDir, type DownloadDirPromptInfo } from '../services/downloadDirPrompt'

const t = {
  input: '#1e1f22',
  border: '#26272b',
  text: '#dbdee1',
  muted: '#949ba4',
  accent: '#5865f2',
  green: '#23a559',
  heading: '#f2f3f5',
  yellow: '#f0b232',
}

/**
 * Modal "onde salvar?" para download grande. Monta nos dois shells e responde
 * pelo evento — cancelar é honesto: nada é baixado.
 */
export function DownloadDirPrompt() {
  const [info, setInfo] = useState<DownloadDirPromptInfo | null>(null)

  useEffect(() => {
    const onAsk = (ev: Event) => {
      const det = (ev as CustomEvent<DownloadDirPromptInfo>).detail
      if (det) setInfo(det)
    }
    window.addEventListener('distorrent:download-dir-ask', onAsk as EventListener)
    return () => window.removeEventListener('distorrent:download-dir-ask', onAsk as EventListener)
  }, [])

  if (!info) return null

  const livre = info.freeBytes > 0 ? formatFileSize(info.freeBytes) : null
  const cabe = info.freeBytes === 0 || info.freeBytes > info.size * 1.05

  const responder = (path: string | null) => {
    setInfo(null)
    answerDownloadDir(path)
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Escolher pasta do download"
      onClick={() => responder(null)}
      style={{
        position: 'fixed', inset: 0, zIndex: 120, background: 'rgba(0,0,0,.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#2b2d31', border: `1px solid ${t.border}`, borderRadius: 14,
          padding: 22, width: 440, maxWidth: '100%', boxSizing: 'border-box',
        }}
      >
        <div style={{ fontSize: 17, fontWeight: 900, color: t.heading, marginBottom: 4 }}>
          Onde salvar?
        </div>
        <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.6, marginBottom: 12 }}>
          <b style={{ color: t.text }}>{info.name}</b> tem {formatFileSize(info.size)} — grande.
          Confirme a pasta antes de começar; o download continua de onde parou se você fechar o app.
        </div>
        <div style={{
          background: t.input, border: `1px solid ${t.border}`, borderRadius: 8,
          padding: '10px 12px', fontSize: 11.5, fontFamily: 'JetBrains Mono', color: t.text,
          wordBreak: 'break-all', marginBottom: 8,
        }}>
          {info.dir}
        </div>
        <div style={{ fontSize: 11, color: cabe ? t.muted : '#faa61a', marginBottom: 14, lineHeight: 1.5 }}>
          {livre ? `${livre} livres neste disco${cabe ? '' : ' — pode não caber'}` : 'espaço livre desconhecido'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={() => responder(null)}
            style={{ background: t.input, color: t.text, border: `1px solid ${t.border}`, padding: '9px 14px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={() => {
              // Abrir o seletor de pasta nas configurações é o caminho honesto:
              // sem plugin de diálogo, não inventamos um caminho que não existe.
              void services.downloadDirOpen(info.dir).catch(() => {})
            }}
            style={{ background: t.input, color: t.text, border: `1px solid ${t.border}`, padding: '9px 14px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12 }}
          >
            Abrir pasta
          </button>
          <button
            type="button"
            onClick={() => responder(info.dir)}
            style={{ background: t.green, color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 8, fontWeight: 800, cursor: 'pointer', fontSize: 12 }}
          >
            Baixar aqui
          </button>
        </div>
        <div style={{ fontSize: 10.5, color: t.muted, marginTop: 10, lineHeight: 1.5 }}>
          Para trocar a pasta padrão: Cofre &amp; Backup → Onde salvar os downloads.
        </div>
      </div>
    </div>
  )
}

export default DownloadDirPrompt
