import { useEffect, useRef, useState } from 'react'
import { Icon, Icons } from '../../shared/icons'
import { setPrefs, usePrefs } from '../../shared/prefs'
import { AUDIO_CONSTRAINTS } from '../../services/callManager'

interface Dev { id: string; label: string }

function applyAudio() {
  try {
    const p = JSON.parse(localStorage.getItem('forge:prefs:v1') ?? '{}')
    const next: MediaTrackConstraints = {
      echoCancellation: p.echo !== false,
      noiseSuppression: p.noise !== false,
      autoGainControl: p.gain !== false,
      channelCount: 1,
    }
    if (p.audioIn) (next as Record<string, unknown>).deviceId = { exact: p.audioIn }
    else delete (AUDIO_CONSTRAINTS as Record<string, unknown>).deviceId
    Object.assign(AUDIO_CONSTRAINTS, next)
  } catch { /* noop */ }
}

export function applySavedAudio() {
  applyAudio()
}

export function VoiceDeviceSettings({ T, inputBg, borderColor, text, muted }: {
  T: Record<string, string>
  inputBg: string
  borderColor: string
  text: string
  muted: string
}) {
  const prefs = usePrefs()
  const [mics, setMics] = useState<Dev[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const stopRef = useRef<(() => void) | null>(null)
  const head: React.CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: muted, marginBottom: 8 }
  const card: React.CSSProperties = { background: inputBg, border: `1px solid ${borderColor}`, borderRadius: 10, padding: '12px 14px', marginBottom: 16 }
  const sel: React.CSSProperties = { width: '100%', background: T.input ?? inputBg, border: `1px solid ${borderColor}`, borderRadius: 8, padding: '10px 12px', color: text, fontSize: 13 }

  useEffect(() => {
    applyAudio()
    return () => stopRef.current?.()
  }, [])

  async function refresh() {
    setErr(null)
    try {
      const md = navigator.mediaDevices
      if (!md?.enumerateDevices) { setErr('Este aparelho não lista dispositivos de áudio.'); return }
      const list = await md.enumerateDevices()
      const ins = list.filter(d => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Microfone ${i + 1}` }))
      setMics(ins)
      if (ins.length === 0) setErr('Nenhum microfone encontrado.')
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Falha ao listar dispositivos.')
    }
  }

  async function test() {
    if (testing) { stopRef.current?.(); return }
    setErr(null)
    try {
      const md = navigator.mediaDevices
      if (!md?.getUserMedia) { setErr('Captura indisponível neste aparelho.'); return }
      const stream = await md.getUserMedia({ audio: { ...(prefs.audioIn ? { deviceId: { exact: prefs.audioIn } } : {}) } })
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) { stream.getTracks().forEach(t => t.stop()); setErr('Sem AudioContext para medir o nível.'); return }
      const ctx = new AC()
      const src = ctx.createMediaStreamSource(stream)
      const an = ctx.createAnalyser()
      an.fftSize = 512
      src.connect(an)
      const buf = new Uint8Array(an.frequencyBinCount)
      let raf = 0
      let alive = true
      const tick = () => {
        if (!alive) return
        an.getByteTimeDomainData(buf)
        let peak = 0
        for (let i = 0; i < buf.length; i++) {
          const v = Math.abs(buf[i] - 128) / 128
          if (v > peak) peak = v
        }
        setLevel(Math.round(peak * 100))
        raf = requestAnimationFrame(tick)
      }
      tick()
      setTesting(true)
      stopRef.current = () => {
        alive = false
        cancelAnimationFrame(raf)
        stream.getTracks().forEach(t => t.stop())
        void ctx.close().catch(() => {})
        setTesting(false)
        setLevel(0)
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Microfone bloqueado.')
    }
  }

  function toggle(key: 'echo' | 'noise' | 'gain') {
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs({ [key]: next[key] })
    applyAudio()
  }

  const toggles = [
    { key: 'echo' as const, label: 'Cancelamento de eco', desc: 'corta o retorno do alto-falante' },
    { key: 'noise' as const, label: 'Supressão de ruído', desc: 'teclado, vento, fundo' },
    { key: 'gain' as const, label: 'Ganho automático', desc: 'nivela o volume da voz' },
  ]

  return (
    <div>
      <div style={head}>ENTRADA</div>
      <div style={card}>
        <select value={prefs.audioIn} onChange={e => { setPrefs({ audioIn: e.target.value }); applyAudio() }} onFocus={() => { if (mics.length === 0) void refresh() }} aria-label="Microfone" style={sel}>
          <option value="">Padrão do sistema</option>
          {mics.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <button onClick={() => void refresh()} style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, background: 'transparent', border: 'none', cursor: 'pointer', color: muted, fontSize: 12, fontWeight: 700 }}>
          <Icon d={Icons.refresh} size={13} /> Listar microfones
        </button>
        {err && <div style={{ fontSize: 12, color: '#ff9c9c', marginTop: 8 }}>{err}</div>}
      </div>
      <div style={head}>PROCESSAMENTO</div>
      <div style={card}>
        {toggles.map(o => (
          <button key={o.key} onClick={() => toggle(o.key)} aria-pressed={prefs[o.key]} style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'transparent', border: 'none', cursor: 'pointer', color: text, padding: '8px 0' }}>
            <span style={{
              width: 36, height: 20, borderRadius: 99, flexShrink: 0, position: 'relative',
              background: prefs[o.key] ? T.accent : '#4a4d55', transition: 'background .15s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: prefs[o.key] ? 18 : 2, width: 16, height: 16,
                borderRadius: '50%', background: '#fff', transition: 'left .15s',
              }} />
            </span>
            <span>
              <span style={{ display: 'block', fontSize: 13, fontWeight: 700 }}>{o.label}</span>
              <span style={{ display: 'block', fontSize: 11, color: muted }}>{o.desc}</span>
            </span>
          </button>
        ))}
        <div style={{ fontSize: 11, color: muted, marginTop: 8, lineHeight: 1.5 }}>Vale para a próxima chamada. No Linux o áudio pode sair do motor nativo.</div>
      </div>
      <div style={head}>TESTE DE MICROFONE</div>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => void test()} style={{ background: testing ? T.red : T.accent, color: '#fff', border: 'none', borderRadius: 8, padding: '9px 16px', fontWeight: 800, fontSize: 12, cursor: 'pointer', flexShrink: 0 }}>
            {testing ? 'Parar' : 'Testar'}
          </button>
          <div style={{ flex: 1, height: 8, background: '#1e1f22', borderRadius: 99, overflow: 'hidden' }} role="meter" aria-valuenow={level} aria-valuemin={0} aria-valuemax={100} aria-label="Nível do microfone">
            <div style={{ width: `${Math.min(100, level)}%`, height: '100%', background: level > 80 ? T.red : level > 40 ? T.green : T.yellow, transition: 'width .08s' }} />
          </div>
          <span style={{ fontSize: 11, color: muted, fontFamily: 'JetBrains Mono', minWidth: 34, textAlign: 'right' }}>{level}%</span>
        </div>
      </div>
    </div>
  )
}
