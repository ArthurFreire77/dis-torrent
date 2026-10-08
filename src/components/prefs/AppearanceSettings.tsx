import { Ic } from '../../shared/icons'
import { setPrefs, usePrefs } from '../../shared/prefs'

export function AppearanceSettings({ T, inputBg, borderColor, text, muted, hideTheme }: {
  T: Record<string, string>
  inputBg: string
  borderColor: string
  text: string
  muted: string
  hideTheme?: boolean
}) {
  const prefs = usePrefs()
  const head: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: muted, marginBottom: 8 }
  const card: React.CSSProperties = { background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16 }
  return (
    <div>
      {!hideTheme && (
        <>
          <div style={head}>TEMA</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {(['dark', 'light'] as const).map(m => (
              <button
                key={m}
                onClick={() => setPrefs({ theme: m })}
                aria-pressed={prefs.theme === m}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  background: prefs.theme === m ? `${T.accent}22` : inputBg,
                  border: `1px solid ${prefs.theme === m ? T.accent : borderColor}`,
                  borderRadius: 10, padding: '12px 0', cursor: 'pointer', color: text,
                  fontSize: 13, fontWeight: 800,
                }}
              >
                <span style={{ width: 22, height: 22, borderRadius: 6, background: m === 'dark' ? '#313338' : '#ffffff', border: `1px solid ${borderColor}`, flexShrink: 0 }} />
                {m === 'dark' ? 'Escuro' : 'Claro'}
              </button>
            ))}
          </div>
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
