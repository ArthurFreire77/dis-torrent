import { useState } from 'react'
import { Ic } from '../../shared/icons'
import { setPrefs, usePrefs } from '../../shared/prefs'
import { PRESET_THEMES, resolveTheme, type Tokens } from '../../shared/theme'

const COLOR_FIELDS: { key: keyof Tokens; label: string }[] = [
  { key: 'accent', label: 'Cor de destaque' },
  { key: 'main', label: 'Fundo principal' },
  { key: 'sidebar', label: 'Barra lateral' },
  { key: 'text', label: 'Texto' },
  { key: 'heading', label: 'Títulos' },
  { key: 'muted', label: 'Texto secundário' },
  { key: 'link', label: 'Links' },
  { key: 'green', label: 'Sucesso/Online' },
  { key: 'red', label: 'Erro/Perigo' },
  { key: 'yellow', label: 'Aviso' },
]

export function AppearanceSettings({ T, inputBg, borderColor, text, muted, hideTheme }: {
  T: Record<string, string>
  inputBg: string
  borderColor: string
  text: string
  muted: string
  hideTheme?: boolean
}) {
  const prefs = usePrefs()
  const [showCustom, setShowCustom] = useState(false)
  const [customColors, setCustomColors] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('distorrent:custom-theme') ?? '{}')
    } catch {
      return {}
    }
  })

  const head: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: muted, marginBottom: 8 }
  const card: React.CSSProperties = { background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16 }

  const applyCustomTheme = () => {
    const tokens: Partial<Tokens> = {}
    for (const [k, v] of Object.entries(customColors)) {
      if (v && /^#[0-9a-fA-F]{6}$/.test(v)) {
        tokens[k as keyof Tokens] = v
      }
    }
    setPrefs({ theme: 'custom', customTheme: tokens as Record<string, string> })
    try {
      localStorage.setItem('distorrent:custom-theme', JSON.stringify(customColors))
    } catch {}
  }

  const resetCustomTheme = () => {
    setCustomColors({})
    setPrefs({ theme: 'dark', customTheme: {} })
    try {
      localStorage.removeItem('distorrent:custom-theme')
    } catch {}
  }

  return (
    <div>
      {!hideTheme && (
        <>
          <div style={head}>TEMA</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 16 }}>
            {Object.entries(PRESET_THEMES).map(([id, preset]) => {
              const preview = resolveTheme(id as any)
              const active = prefs.theme === id
              return (
                <button
                  key={id}
                  onClick={() => setPrefs({ theme: id as any })}
                  aria-pressed={active}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    background: active ? `${T.accent}22` : inputBg,
                    border: `1px solid ${active ? T.accent : borderColor}`,
                    borderRadius: 10, padding: '10px 8px', cursor: 'pointer', color: text,
                    fontSize: 11, fontWeight: 800,
                  }}
                >
                  <div style={{ display: 'flex', gap: 3 }}>
                    <span style={{ width: 16, height: 16, borderRadius: 4, background: preview.main, border: `1px solid ${borderColor}` }} />
                    <span style={{ width: 16, height: 16, borderRadius: 4, background: preview.sidebar, border: `1px solid ${borderColor}` }} />
                    <span style={{ width: 16, height: 16, borderRadius: 4, background: preview.accent, border: `1px solid ${borderColor}` }} />
                  </div>
                  {preset.name}
                </button>
              )
            })}
            <button
              onClick={() => setShowCustom(true)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                background: prefs.theme === 'custom' ? `${T.accent}22` : inputBg,
                border: `1px dashed ${prefs.theme === 'custom' ? T.accent : borderColor}`,
                borderRadius: 10, padding: '10px 8px', cursor: 'pointer', color: text,
                fontSize: 11, fontWeight: 800,
              }}
            >
              <div style={{ display: 'flex', gap: 3 }}>
                <span style={{ width: 16, height: 16, borderRadius: 4, background: 'linear-gradient(135deg, #ff0000, #ff9900, #ffee00, #33cc33, #0099ff, #cc66ff)', border: `1px solid ${borderColor}` }} />
              </div>
              Personalizado
            </button>
          </div>

          {showCustom && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: text }}>Tema personalizado</div>
                <button onClick={() => setShowCustom(false)} style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', fontSize: 16 }}>×</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
                {COLOR_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <label style={{ fontSize: 10, color: muted, display: 'block', marginBottom: 4 }}>{label}</label>
                    <div style={{ display: 'flex', gap: 4 }}>
                      <input
                        type="color"
                        value={customColors[key] ?? '#5865f2'}
                        onChange={(e) => setCustomColors(prev => ({ ...prev, [key]: e.target.value }))}
                        style={{ width: 32, height: 32, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0 }}
                      />
                      <input
                        type="text"
                        value={customColors[key] ?? ''}
                        onChange={(e) => setCustomColors(prev => ({ ...prev, [key]: e.target.value }))}
                        placeholder="#5865f2"
                        style={{
                          flex: 1, background: T.input ?? '#1e1f22', border: `1px solid ${borderColor}`,
                          borderRadius: 6, padding: '6px 8px', color: text, fontSize: 12, fontFamily: 'monospace',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={applyCustomTheme}
                  style={{
                    flex: 1, background: T.accent, color: '#fff', border: 'none', borderRadius: 8,
                    padding: '10px 0', fontSize: 13, fontWeight: 800, cursor: 'pointer',
                  }}
                >
                  Aplicar tema
                </button>
                <button
                  onClick={resetCustomTheme}
                  style={{
                    background: 'transparent', border: `1px solid ${borderColor}`, color: muted,
                    borderRadius: 8, padding: '10px 16px', fontSize: 13, cursor: 'pointer',
                  }}
                >
                  Redefinir
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <div style={head}>TAMANHO DA FONTE · {Math.round(prefs.fontScale * 100)}%</div>
      <div style={card}>
        <input
          type="range" min={85} max={125} step={5} value={Math.round(prefs.fontScale * 100)}
          onChange={e => setPrefs({ fontScale: Number(e.target.value) / 100 })}
          aria-label="Tamanho da fonte das mensagens"
          style={{ width: '100%', accentColor: T.accent }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: muted, marginTop: 4 }}>
          <span>85%</span><span>100%</span><span>125%</span>
        </div>
        <div style={{ marginTop: 12, background: T.sidebar ?? '#2b2d31', borderRadius: 8, padding: '10px 12px' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span style={{ fontWeight: 700, fontSize: 14 * prefs.fontScale, color: text }}>amigo</span>
            <span style={{ fontSize: 11, color: muted }}>agora</span>
          </div>
          <div style={{ fontSize: 14 * prefs.fontScale, color: text, marginTop: 2 }}>Prévia do tamanho nas mensagens.</div>
        </div>
      </div>

      <div style={head}>DENSIDADE</div>
      <div style={card}>
        {([
          { id: false, label: 'Confortável', desc: 'Avatar grande, autor em cima da mensagem' },
          { id: true, label: 'Compacta', desc: 'Uma linha por mensagem, estilo IRC' },
        ] as const).map(o => (
          <button
            key={o.label}
            onClick={() => setPrefs({ compact: o.id })}
            aria-pressed={prefs.compact === o.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
              background: prefs.compact === o.id ? `${T.accent}22` : 'transparent',
              border: `1px solid ${prefs.compact === o.id ? T.accent : borderColor}`,
              borderRadius: 8, padding: '10px 12px', marginBottom: 8, cursor: 'pointer', color: text,
            }}
          >
            <span style={{ color: prefs.compact === o.id ? T.accent : muted, display: 'flex' }}>
              <Ic name={o.id ? 'grid' : 'smile'} size={16} />
            </span>
            <span>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 800 }}>{o.label}</span>
              <span style={{ display: 'block', fontSize: 11, color: muted, marginTop: 2 }}>{o.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
