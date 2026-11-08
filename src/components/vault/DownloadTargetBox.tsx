import { useCallback, useEffect, useState } from 'react'
import { services } from '../../services'
import { formatFileSize } from '../../shared/bytes'
import type { DownloadBrowseView, DownloadDirView } from '../../services/models'

const t = {
  input: '#1e1f22',
  border: '#26272b',
  text: '#dbdee1',
  muted: '#949ba4',
  accent: '#5865f2',
  green: '#23a559',
  yellow: '#f0b232',
  red: '#f23f42',
  heading: '#f2f3f5',
}

const btn = (bg: string, fg = '#fff'): React.CSSProperties => ({
  background: bg,
  color: fg,
  border: 'none',
  padding: '8px 12px',
  borderRadius: 8,
  fontWeight: 800,
  cursor: 'pointer',
  fontSize: 12,
})

/**
 * Escolha da pasta de destino. Arquivo de 1 GB não pode cair no perfil do app
 * sem o usuário saber — esta tela grava a escolha e mostra o espaço livre.
 */
export function DownloadTargetBox() {
  const [dir, setDir] = useState<DownloadDirView | null>(null)
  const [browse, setBrowse] = useState<DownloadBrowseView | null>(null)
  const [aberto, setAberto] = useState(false)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [espaco, setEspaco] = useState<{ free_bytes: number; total_bytes: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const nativo = services.kind === 'native'

  const ler = useCallback(async () => {
    if (!nativo) return
    try {
      const d = await services.downloadDirGet()
      setDir(d)
      try {
        setEspaco(await services.downloadDirSpace(d.dir))
      } catch {
        setEspaco(null)
      }
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    }
  }, [nativo])

  useEffect(() => {
    void ler()
  }, [ler])

  const abrirNavegador = async (path?: string | null) => {
    setErro(null)
    try {
      const b = await services.downloadDirBrowse(path ?? dir?.dir ?? null)
      setBrowse(b)
      setAberto(true)
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    }
  }

  const escolher = async () => {
    if (!browse) return
    setBusy(true)
    setErro(null)
    setMsg(null)
    try {
      const d = await services.downloadDirSet(browse.path)
      setDir(d)
      setAberto(false)
      setMsg(`Download de agora em diante vai para ${d.dir}`)
      try {
        setEspaco(await services.downloadDirSpace(d.dir))
      } catch {
        setEspaco(null)
      }
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const restaurar = async () => {
    setBusy(true)
    setErro(null)
    setMsg(null)
    try {
      const d = await services.downloadDirReset()
      setDir(d)
      setMsg('Voltou para a pasta Downloads padrão')
      try {
        setEspaco(await services.downloadDirSpace(d.dir))
      } catch {
        setEspaco(null)
      }
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  const abrirPasta = async () => {
    setErro(null)
    try {
      await services.downloadDirOpen(dir?.dir ?? null)
    } catch (e) {
      setErro(String((e as Error)?.message ?? e))
    }
  }

  if (!nativo) {
    return (
      <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.5 }}>
        No navegador o arquivo vai para a pasta Downloads dele — escolher pasta exige o app nativo.
      </div>
    )
  }

  const livre = espaco && espaco.free_bytes > 0 ? formatFileSize(espaco.free_bytes) : null
  const total = espaco && espaco.total_bytes > 0 ? formatFileSize(espaco.total_bytes) : null

  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, color: t.muted, marginBottom: 6 }}>
        ONDE SALVAR OS DOWNLOADS
      </div>
      <div style={{ background: t.input, border: `1px solid ${t.border}`, borderRadius: 8, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 11, color: t.text, fontFamily: 'JetBrains Mono', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={dir?.dir ?? ''}>
          {dir?.dir ?? 'carregando…'}
        </div>
        <button type="button" onClick={() => void abrirPasta()} style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}`, padding: '4px 8px', fontSize: 11 }}>
          Abrir
        </button>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <button type="button" onClick={() => void abrirNavegador()} disabled={busy} style={{ ...btn(t.accent), padding: '6px 10px' }}>
          Escolher pasta…
        </button>
        {dir && !dir.is_default && (
          <button type="button" onClick={() => void restaurar()} disabled={busy} style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}`, padding: '6px 10px' }}>
            Usar Downloads padrão
          </button>
        )}
        {livre && (
          <span style={{ fontSize: 11, color: t.muted, alignSelf: 'center' }}>
            {livre} livre{total ? ` de ${total}` : ''}
          </span>
        )}
      </div>
      {dir && !dir.is_default && (
        <div style={{ fontSize: 10.5, color: t.muted, marginBottom: 6, lineHeight: 1.5 }}>
          Pasta escolhida por você. Se ela sumir (pen drive removido), o app volta para Downloads.
        </div>
      )}

      {aberto && browse && (
        <div style={{ border: `1px solid ${t.border}`, borderRadius: 8, background: t.input, padding: 10, marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            {browse.parent && (
              <button type="button" onClick={() => void abrirNavegador(browse.parent)} style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}`, padding: '3px 8px', fontSize: 11 }}>
                ↑ acima
              </button>
            )}
            <div style={{ flex: 1, minWidth: 0, fontSize: 10.5, fontFamily: 'JetBrains Mono', color: t.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={browse.path}>
              {browse.path}
            </div>
          </div>
          {browse.drives.length > 1 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
              {browse.drives.map((d) => (
                <button key={d} type="button" onClick={() => void abrirNavegador(d)} style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}`, padding: '3px 8px', fontSize: 11 }}>
                  {d}
                </button>
              ))}
            </div>
          )}
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {browse.dirs.length === 0 && <div style={{ fontSize: 11, color: t.muted }}>nenhuma subpasta aqui</div>}
            {browse.dirs.map((d) => (
              <button
                key={d.path}
                type="button"
                onClick={() => void abrirNavegador(d.path)}
                style={{ background: 'transparent', border: 'none', color: t.text, textAlign: 'left', padding: '5px 6px', borderRadius: 6, cursor: 'pointer', fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}
              >
                <span style={{ color: t.yellow }}>▸</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="button" onClick={() => void escolher()} disabled={busy} style={btn(t.green)}>
              Salvar aqui
            </button>
            <button type="button" onClick={() => setAberto(false)} style={{ ...btn(t.input, t.text), border: `1px solid ${t.border}` }}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {msg && <div style={{ fontSize: 11, color: '#8cf5b8', marginBottom: 4 }}>{msg}</div>}
      {erro && <div style={{ fontSize: 11, color: '#ff9c9c', lineHeight: 1.5 }}>{erro}</div>}
    </div>
  )
}

export default DownloadTargetBox
