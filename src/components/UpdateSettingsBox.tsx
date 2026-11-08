import { useState } from 'react'
import type { UpdateGateApi } from './UpdateGate'
import { isNewer, updateModeFor } from '../services/updateRules'

const t = {
  input: '#1e1f22',
  border: '#26272b',
  text: '#dbdee1',
  muted: '#949ba4',
  accent: '#5865f2',
  green: '#23a559',
  red: '#f23f42',
  yellow: '#f0b232',
  heading: '#f2f3f5',
}

/**
 * Atualização nas Configurações: antes não havia NENHUM lugar para verificar à
 * mão, então uma release publicada depois do último check de 6 h ficava
 * invisível até o próximo boot.
 */
export function UpdateSettingsBox({ api }: { api: UpdateGateApi }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [erro, setErro] = useState<string | null>(null)

  const verificar = async () => {
    setBusy(true)
    setErro(null)
    setMsg(null)
    try {
      const info = await api.checkNow()
      if (!info) {
        setErro('não consegui verificar agora — veja o aviso acima')
        return
      }
      if (isNewer(info.current, info.latest)) {
        setMsg(`versão ${info.latest} disponível (você está na ${info.current})`)
      } else {
        setMsg(`você está na versão mais nova (${info.current})`)
      }
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const baixar = async () => {
    setBusy(true)
    setErro(null)
    try {
      await api.checkNow()
    } finally {
      setBusy(false)
    }
  }

  const info = api.info
  const temNova = !!info && isNewer(info.current, info.latest)
  const modo = info ? updateModeFor(info.platform, info.asset_name) : 'link'

  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>
        ATUALIZAÇÕES
      </div>

      <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.6, marginBottom: 10 }}>
        O app confere o GitHub a cada <b style={{ color: t.text }}>30 minutos</b> enquanto está aberto,
        e na abertura. A release é aceita só com <b style={{ color: t.text }}>2 de 3</b> assinaturas
        verificadas e o hash do instalador conferido antes de executar.
      </div>

      <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', fontSize: 11.5 }}>
          <span style={{ color: t.muted }}>versão instalada</span>
          <span style={{ color: t.heading, fontWeight: 800, fontFamily: 'JetBrains Mono' }}>
            {info?.current || '—'}
          </span>
        </div>
        {temNova && (
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', fontSize: 11.5, marginTop: 6 }}>
            <span style={{ color: t.muted }}>disponível</span>
            <span style={{ color: t.green, fontWeight: 800, fontFamily: 'JetBrains Mono' }}>{info?.latest}</span>
          </div>
        )}
        {info?.verification_note && (
          <div style={{ fontSize: 10.5, color: t.muted, marginTop: 8, lineHeight: 1.5 }}>
            procedência: {info.verification_note}
          </div>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: t.text, marginBottom: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={api.auto}
          onChange={(e) => api.setAuto(e.target.checked)}
          style={{ accentColor: t.accent, marginTop: 2 }}
        />
        <span>
          instalar sozinho quando sair versão nova
          <span style={{ display: 'block', color: t.muted, fontSize: 10.5, marginTop: 2, lineHeight: 1.5 }}>
            baixa o instalador, confere o hash assinado e abre — o app reinicia sozinho
          </span>
        </span>
      </label>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => void verificar()}
          disabled={busy}
          style={{
            background: t.accent, color: '#fff', border: 'none',
            padding: '8px 14px', borderRadius: 8, fontWeight: 800,
            cursor: busy ? 'progress' : 'pointer', fontSize: 12, opacity: busy ? 0.7 : 1,
          }}
        >
          {busy ? 'verificando…' : 'Verificar agora'}
        </button>
        {temNova && (
          <button
            type="button"
            onClick={() => void baixar()}
            disabled={busy}
            style={{
              background: t.green, color: '#fff', border: 'none',
              padding: '8px 14px', borderRadius: 8, fontWeight: 800,
              cursor: 'pointer', fontSize: 12,
            }}
          >
            {modo === 'auto' ? `Instalar ${info?.latest}` : 'Abrir a página da versão'}
          </button>
        )}
        {temNova && modo !== 'auto' && (
          <button
            type="button"
            onClick={api.openPage}
            style={{
              background: t.input, color: t.text, border: `1px solid ${t.border}`,
              padding: '8px 14px', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 12,
            }}
          >
            Baixar manualmente
          </button>
        )}
      </div>

      {msg && <div style={{ fontSize: 11, color: '#8cf5b8', marginTop: 8 }}>{msg}</div>}
      {erro && <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 8, lineHeight: 1.5 }}>{erro}</div>}
      {api.phase === 'error' && api.message && (
        <div style={{ fontSize: 11, color: '#ff9c9c', marginTop: 8, lineHeight: 1.5 }}>{api.message}</div>
      )}
    </div>
  )
}

export default UpdateSettingsBox
