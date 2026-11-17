import { useMemo, useState } from 'react'
import { Ic } from '../../shared/icons'
import { setPrefs, usePrefs } from '../../shared/prefs'
import {
  PRESET_THEMES, THEME_CHOICES, normalizeHex, readableOn, resolveTheme, shade, type ThemeName, type Tokens,
} from '../../shared/theme'

/** Campos expostos no editor, do mais visível ao mais sutil. */
const COLOR_FIELDS: { key: keyof Tokens; label: string; hint: string }[] = [
  { key: 'accent', label: 'Cor de destaque', hint: 'botões, menções, foco' },
  { key: 'main', label: 'Fundo principal', hint: 'área das mensagens' },
  { key: 'sidebar', label: 'Barra lateral', hint: 'canais e conversas' },
  { key: 'rail', label: 'Coluna de servidores', hint: 'barra mais à esquerda' },
  { key: 'input', label: 'Campos e cartões', hint: 'caixa de texto, painéis' },
  { key: 'text', label: 'Texto', hint: 'corpo das mensagens' },
  { key: 'heading', label: 'Títulos', hint: 'nomes e cabeçalhos' },
  { key: 'muted', label: 'Texto secundário', hint: 'horários, legendas' },
  { key: 'link', label: 'Links', hint: 'endereços clicáveis' },
  { key: 'green', label: 'Sucesso/Online', hint: 'status e confirmações' },
  { key: 'yellow', label: 'Aviso', hint: 'alertas brandos' },
  { key: 'red', label: 'Erro/Perigo', hint: 'falhas e ações destrutivas' },
]

function parseTokens(raw: Record<string, string> | undefined): Partial<Tokens> {
  const out: Partial<Tokens> = {}
  for (const [k, v] of Object.entries(raw ?? {})) {
    const hex = normalizeHex(v)
    if (hex) out[k as keyof Tokens] = hex
  }
  return out
}

/** Gera um tema completo a partir de uma cor de destaque, mantendo contraste. */
export function themeFromAccent(accent: string, base: ThemeName = 'dark'): Partial<Tokens> {
  const baseTokens = resolveTheme(base)
  const isLight = readableOn(baseTokens.main) === '#111214'
  return {
    accent,
    accentHover: shade(accent, isLight ? -0.18 : -0.12),
    blurple: accent,
    link: isLight ? shade(accent, -0.28) : shade(accent, 0.35),
  }
}

export function AppearanceSettings({ T, inputBg, borderColor, text, muted, hideTheme }: {
  T: Record<string, string>
  inputBg: string
  borderColor: string
  text: string
  muted: string
  hideTheme?: boolean
}) {
  const prefs = usePrefs()
  const [showCustom, setShowCustom] = useState(prefs.theme === 'custom')
  const [draft, setDraft] = useState<Partial<Tokens>>(() => parseTokens(prefs.customTheme))

  const customActive = prefs.theme === 'custom'
  const baseTheme: ThemeName = (customActive ? (prefs.customBase as ThemeName) : prefs.theme) || 'dark'
  /** Prévia ao vivo: aplica o rascunho sobre a base escolhida. */
  const preview = useMemo(
    () => resolveTheme('custom', draft, baseTheme === 'custom' ? 'dark' : baseTheme),
    [draft, baseTheme],
  )

  const head: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: muted, marginBottom: 8 }
  const card: React.CSSProperties = { background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16 }

  /** Aplica o rascunho e mantém a base, para o "voltar ao preset" funcionar. */
  const applyDraft = () => {
    setPrefs({ theme: 'custom', customTheme: draft as Record<string, string>, customBase: baseTheme === 'custom' ? 'dark' : baseTheme })
  }

  const choosePreset = (id: ThemeName) => {
    setPrefs({ theme: id, customTheme: {} })
    setDraft({})
    setShowCustom(false)
  }

  const setField = (key: keyof Tokens, value: string) => {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const resetCustom = () => {
    setPrefs({ theme: baseTheme === 'custom' ? 'dark' : baseTheme, customTheme: {} })
    setDraft({})
    setShowCustom(false)
  }

  const dirty = useMemo(() => {
    const current = parseTokens(prefs.customTheme)
    return JSON.stringify(current) !== JSON.stringify(parseTokens(draft as Record<string, string>))
  }, [prefs.customTheme, draft])

  return (
    <div>
      {!hideTheme && (
        <>
          <div style={head}>TEMA</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8, marginBottom: 12 }}>
            {THEME_CHOICES.map((id) => {
              const preset = PRESET_THEMES[id]
              if (!preset) return null
              const previewTokens = resolveTheme(id)
              const active = prefs.theme === id
              return (
                <button
                  key={id}
                  onClick={() => choosePreset(id)}
                  aria-pressed={active}
                  title={preset.name}
                  style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                    background: active ? `${previewTokens.accent}22` : inputBg,
                    border: `1px solid ${active ? previewTokens.accent : borderColor}`,
                    borderRadius: 10, padding: '10px 8px', cursor: 'pointer', color: text,
                    fontSize: 11, fontWeight: 800,
                  }}
                >
                  <span style={{ display: 'flex', gap: 3 }}>
                    <span style={{ width: 18, height: 18, borderRadius: 4, background: previewTokens.main, border: `1px solid ${borderColor}` }} />
                    <span style={{ width: 18, height: 18, borderRadius: 4, background: previewTokens.sidebar, border: `1px solid ${borderColor}` }} />
                    <span style={{ width: 18, height: 18, borderRadius: 4, background: previewTokens.accent, border: `1px solid ${borderColor}` }} />
                  </span>
                  <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' }}>{preset.name}</span>
                </button>
              )
            })}
            <button
              onClick={() => setShowCustom(v => !v)}
              aria-expanded={showCustom}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                background: customActive ? `${preview.accent}22` : inputBg,
                border: `1px dashed ${customActive ? preview.accent : borderColor}`,
                borderRadius: 10, padding: '10px 8px', cursor: 'pointer', color: text,
                fontSize: 11, fontWeight: 800,
              }}
            >
              <span style={{ width: 18, height: 18, borderRadius: 4, background: 'linear-gradient(135deg, #ff5757, #ffb703, #23a55a, #00a8fc, #5865f2, #eb459e)', border: `1px solid ${borderColor}` }} />
              Personalizado
            </button>
          </div>

          {showCustom && (
            <div style={card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: text }}>Tema personalizado</div>
                <button onClick={() => setShowCustom(false)} aria-label="Fechar editor" style={{ background: 'transparent', border: 'none', color: muted, cursor: 'pointer', fontSize: 16 }}>×</button>
              </div>
              <div style={{ fontSize: 11, color: muted, marginBottom: 12 }}>
                A prévia abaixo já usa estas cores. Aplique para manter em todo o app.
              </div>

              {/* Atalho: uma cor que se espalha com contraste garantido. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: text }}>Destaque rápido</span>
                <input
                  type="color"
                  aria-label="Escolher cor de destaque"
                  value={draft.accent ?? preview.accent}
                  onChange={(e) => setDraft(prev => ({ ...prev, ...themeFromAccent(e.target.value, baseTheme) }))}
                  style={{ width: 40, height: 30, border: 'none', borderRadius: 6, cursor: 'pointer', padding: 0, background: 'transparent' }}
                />
                {['#5865f2', '#23a559', '#f0b232', '#f23f42', '#eb459e', '#00a8fc', '#bd93f9', '#f97316'].map(c => (
                  <button
                    key={c}
                    onClick={() => setDraft(prev => ({ ...prev, ...themeFromAccent(c, baseTheme) }))}
                    aria-label={`Aplicar destaque ${c}`}
                    title={c}
                    style={{ width: 24, height: 24, borderRadius: 99, background: c, border: draft.accent === c ? `2px solid ${text}` : `1px solid ${borderColor}`, cursor: 'pointer', padding: 0 }}
                  />
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 10, marginBottom: 12 }}>
                {COLOR_FIELDS.map(({ key, label, hint }) => {
                  const value = draft[key] ?? preview[key]
                  const valid = normalizeHex(value) !== null
                  return (
                    <div key={key}>
                      <label style={{ fontSize: 10, color: muted, display: 'block', marginBottom: 3, fontWeight: 700 }}>
                        {label} <span style={{ opacity: 0.65, fontWeight: 500 }}>· {hint}</span>
                      </label>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <input
                          type="color"
                          aria-label={label}
                          value={valid ? value : preview[key]}
                          onChange={(e) => setField(key, e.target.value)}
                          style={{ width: 34, height: 32, border: `1px solid ${borderColor}`, borderRadius: 6, cursor: 'pointer', padding: 0, background: 'transparent', flexShrink: 0 }}
                        />
                        <input
                          type="text"
                          aria-label={`${label} em hexadecimal`}
                          value={value}
                          onChange={(e) => setField(key, e.target.value)}
                          spellCheck={false}
                          style={{
                            flex: 1, minWidth: 0, background: preview.input, color: preview.text,
                            border: `1px solid ${valid ? borderColor : preview.red}`,
                            borderRadius: 6, padding: '6px 8px', fontSize: 12, fontFamily: 'monospace',
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Prévia real: uma mensagem montada com os tokens do rascunho. */}
              <div style={{ border: `1px solid ${borderColor}`, borderRadius: 10, overflow: 'hidden', marginBottom: 12 }}>
                <div style={{ display: 'flex' }}>
                  <div style={{ width: 36, background: preview.rail, flexShrink: 0 }} />
                  <div style={{ width: 92, background: preview.sidebar, padding: '8px 6px', flexShrink: 0 }}>
                    <div style={{ fontSize: 9, fontWeight: 800, color: preview.muted, letterSpacing: 0.5, marginBottom: 4 }}>CANAIS</div>
                    <div style={{ fontSize: 10, color: preview.heading, background: preview.selected, borderRadius: 4, padding: '3px 5px', fontWeight: 700 }}># geral</div>
                  </div>
                  <div style={{ flex: 1, background: preview.main, padding: '8px 10px', minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                      <span style={{ width: 16, height: 16, borderRadius: '50%', background: preview.accent, flexShrink: 0 }} />
                      <span style={{ fontSize: 11, fontWeight: 800, color: preview.heading }}>amigo</span>
                      <span style={{ fontSize: 9, color: preview.muted }}>agora</span>
                    </div>
                    <div style={{ fontSize: 11, color: preview.text, marginTop: 2 }}>Ficou assim o seu tema.</div>
                    <div style={{ fontSize: 10, marginTop: 4, color: preview.link, textDecoration: 'underline' }}>um link</div>
                    <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                      <span style={{ fontSize: 9, fontWeight: 800, color: readableOn(preview.accent), background: preview.accent, borderRadius: 99, padding: '2px 8px' }}>Botão</span>
                      <span style={{ fontSize: 9, fontWeight: 800, color: preview.green, background: `${preview.green}22`, borderRadius: 99, padding: '2px 8px' }}>online</span>
                      <span style={{ fontSize: 9, fontWeight: 800, color: preview.red, background: `${preview.red}22`, borderRadius: 99, padding: '2px 8px' }}>erro</span>
                    </div>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  onClick={applyDraft}
                  disabled={!dirty && customActive}
                  style={{
                    flex: 1, minWidth: 140, background: preview.accent, color: readableOn(preview.accent), border: 'none', borderRadius: 8,
                    padding: '10px 0', fontSize: 13, fontWeight: 800,
                    cursor: !dirty && customActive ? 'default' : 'pointer', opacity: !dirty && customActive ? 0.6 : 1,
                  }}
                >
                  {dirty ? 'Aplicar tema' : 'Tema aplicado'}
                </button>
                <button
                  onClick={resetCustom}
                  style={{
                    background: 'transparent', border: `1px solid ${borderColor}`, color: muted,
                    borderRadius: 8, padding: '10px 16px', fontSize: 13, cursor: 'pointer',
                  }}
                >
                  Voltar ao {PRESET_THEMES[baseTheme]?.name ?? 'Escuro'}
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
