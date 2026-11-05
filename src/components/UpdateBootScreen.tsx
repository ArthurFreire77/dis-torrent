import React from 'react'
import type { UpdateGateApi } from './UpdateGate'
import { formatBytes, isNewer, shortNotes, updateModeFor } from '../services/updateRules'

const MAX_ESPERA_MS = 12_000

const MONO = "'JetBrains Mono', ui-monospace, monospace"

export function UpdateBootScreen({ api, fallback }: { api: UpdateGateApi; fallback?: React.ReactNode }) {
  const [expirou, setExpirou] = React.useState(false)
  React.useEffect(() => {
    const t = setTimeout(() => setExpirou(true), MAX_ESPERA_MS)
    return () => clearTimeout(t)
  }, [])

  const info = api.info
  const temNova = !!info && isNewer(info.current, info.latest)
  const mode = info ? updateModeFor(info.platform, info.asset_name) : 'link'
  const rotuloErrado = !!info?.label_mismatch
  const ocupada = api.phase === 'checking' || api.phase === 'downloading' || api.phase === 'installing'
  const prender = ocupada && !expirou

  const titulo =
    api.phase === 'checking'
      ? 'procurando atualizações'
      : api.phase === 'downloading'
        ? 'baixando a versão nova'
        : api.phase === 'installing'
          ? 'instalando'
          : api.phase === 'stalled'
            ? 'atualização já aplicada'
            : api.phase === 'error'
              ? 'não deu para verificar'
              : temNova
                ? `versão ${info?.latest} disponível`
                : 'você está na versão mais nova'

  const detalhe =
    api.message ||
    (rotuloErrado
      ? `o instalador desta release é o da ${info?.asset_version || '?'} — a release anuncia ${info?.latest || '?'}`
      : api.phase === 'checking'
        ? 'conferindo o GitHub…'
        : api.phase === 'installing'
          ? mode === 'auto'
            ? 'o app vai reiniciar sozinho'
            : 'conclua no instalador do sistema'
          : info
            ? `instalada: ${info.current || '?'}`
            : '')

  if (api.phase === 'idle' && fallback) return <>{fallback}</>

  return (
    <div
      className="boot"
      style={{ position: 'fixed', inset: 0, zIndex: 9998, background: '#0d1015' }}
      data-testid="update-boot"
    >
      <div className="boot-logo">DisTorrent</div>

      {}
      <div className="boot-bar" aria-hidden="true">
        <i
          style={
            ocupada
              ? undefined
              : { animation: 'none', width: '100%', opacity: temNova ? 1 : 0.55 }
          }
        />
      </div>

      <div className="boot-sub" style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#dbe1ea' }}>{titulo}</div>
        {detalhe && (
          <div style={{ fontSize: 11.5, color: '#8f9aab', marginTop: 6, lineHeight: 1.5 }}>
            {detalhe}
          </div>
        )}

        {info && info.asset_size > 0 && ocupada && (
          <div style={{ fontSize: 11, color: '#6f7a8b', marginTop: 4, fontFamily: MONO }}>
            {formatBytes(info.asset_size)}
          </div>
        )}

        {temNova && info?.notes && api.phase === 'later' && (
          <pre
            style={{
              marginTop: 12,
              padding: 10,
              background: '#141821',
              border: '1px solid #232a34',
              borderRadius: 8,
              fontSize: 10.5,
              lineHeight: 1.5,
              color: '#a9b3c2',
              whiteSpace: 'pre-wrap',
              fontFamily: MONO,
              maxHeight: 120,
              overflow: 'auto',
              textAlign: 'left',
            }}
          >
            {shortNotes(info.notes, 4)}
          </pre>
        )}

        {
}
        {!prender && temNova && !rotuloErrado && (
          <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'center' }}>
            <button
              onClick={mode === 'link' ? api.openPage : api.apply}
              style={{
                padding: '9px 16px',
                borderRadius: 8,
                border: 'none',
                background: '#4c8dff',
                color: '#04203f',
                fontWeight: 800,
                fontSize: 12.5,
                cursor: 'pointer',
              }}
            >
              {mode === 'link' ? 'Abrir a página da versão' : 'Atualizar agora'}
            </button>
            <button
              onClick={api.skip}
              style={{
                padding: '9px 12px',
                borderRadius: 8,
                border: '1px solid #2f3742',
                background: 'transparent',
                color: '#b7c0cd',
                fontWeight: 700,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Pular esta versão
            </button>
          </div>
        )}

        {expirou && ocupada && (
          <div style={{ fontSize: 10.5, color: '#6f7a8b', marginTop: 10 }}>
            a rede está lenta — a verificação continua em segundo plano
          </div>
        )}

        {api.phase === 'error' && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#8f9aab' }}>
            segue para o app normalmente; a próxima abertura tenta de novo.
          </div>
        )}
      </div>
    </div>
  )
}
