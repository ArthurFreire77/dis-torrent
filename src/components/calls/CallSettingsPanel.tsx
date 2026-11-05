import { useEffect, useMemo, useState } from 'react'
import {
  CALL_FPS_OPTIONS,
  CALL_VIDEO_QUALITIES,
  qualityLabel,
  type CallFps,
  type CallMediaPrefs,
  type CallVideoQuality,
} from '../../services/callMediaPrefs'

const T_INPUT = '#1e1f22'
const T_BORDER = '#3f4147'
const T_TEXT = '#dbdee1'
const T_HEADING = '#f2f3f5'
const T_MUTED = '#949ba4'
const T_ACCENT = '#5865f2'

interface DeviceOption { deviceId: string; label: string }

export interface CallSettingsPanelProps {
  prefs: CallMediaPrefs
  onApply: (patch: Partial<CallMediaPrefs>) => Promise<CallMediaPrefs>
  onClose: () => void
  onError?: (msg: string) => void
  cameraOn?: boolean
  sharing?: boolean
  muted?: boolean
  onToggleCamera?: () => void | Promise<void>
  onToggleScreen?: () => void | Promise<void>
  screenQuality?: string
  screenFps?: string
  onScreenQualityChange?: (q: string) => void | Promise<void>
  onScreenFpsChange?: (f: string) => void | Promise<void>
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 11, fontWeight: 800, color: T_MUTED, letterSpacing: 0.4 }}>{label}</span>
      {children}
      {hint ? <span style={{ fontSize: 10.5, color: T_MUTED }}>{hint}</span> : null}
    </label>
  )
}

function Secao({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${T_BORDER}`, paddingTop: 10 }}>
      <span style={{ fontSize: 10.5, fontWeight: 900, color: T_ACCENT, letterSpacing: 0.8 }}>{title}</span>
      {children}
    </div>
  )
}

function Toggle({ on, label, onChange, disabled }: { on: boolean; label: string; onChange: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        width: '100%', textAlign: 'left', cursor: disabled ? 'default' : 'pointer',
        background: on ? `${T_ACCENT}22` : T_INPUT,
        border: `1px solid ${on ? T_ACCENT : T_BORDER}`,
        color: on ? T_HEADING : T_MUTED,
        borderRadius: 8, padding: '8px 10px', fontSize: 12.5, fontWeight: 700,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 10, fontWeight: 900, letterSpacing: 0.5 }}>{on ? 'LIGADO' : 'DESLIGADO'}</span>
    </button>
  )
}

const selectStyle: React.CSSProperties = {
  background: T_INPUT,
  color: T_TEXT,
  border: `1px solid ${T_BORDER}`,
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 12.5,
  fontWeight: 600,
  width: '100%',
  minWidth: 0,
}

export default function CallSettingsPanel({
  prefs, onApply, onClose, onError,
  cameraOn, sharing, muted,
  onToggleCamera, onToggleScreen,
  screenQuality, screenFps, onScreenQualityChange, onScreenFpsChange,
}: CallSettingsPanelProps) {
  const [audioDevices, setAudioDevices] = useState<DeviceOption[]>([])
  const [videoDevices, setVideoDevices] = useState<DeviceOption[]>([])
  const [local, setLocal] = useState<CallMediaPrefs>(prefs)
  const [busy, setBusy] = useState(false)
  const [ouvinteDisponivel, setOuvinteDisponivel] = useState(true)

  useEffect(() => setLocal(prefs), [prefs])

  useEffect(() => {
    let vivo = true
    const ler = async () => {
      try {
        const md: any = (navigator as any)?.mediaDevices
        if (!md?.enumerateDevices) { setOuvinteDisponivel(false); return }
        const devs: MediaDeviceInfo[] = await md.enumerateDevices()
        if (!vivo) return
        const pick = (kind: string): DeviceOption[] => devs
          .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')
          .map((d, i) => ({ deviceId: d.deviceId, label: (d.label || '').trim() || `aparelho ${i + 1}` }))
        const audio = pick('audioinput')
        const video = pick('videoinput')
        setAudioDevices(audio)
        setVideoDevices(video)
        const semRotulo = [...audio, ...video].some((d) => /^aparelho \d+$/.test(d.label))
        if (semRotulo && md.getUserMedia) {
          try {
            const s: MediaStream = await md.getUserMedia({ audio: true })
            try { s.getTracks().forEach((t) => t.stop()) } catch {  }
            if (!vivo) return
            const devs2: MediaDeviceInfo[] = await md.enumerateDevices()
            const rotulo = (kind: string): DeviceOption[] => devs2
              .filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default')
              .map((d, i) => ({ deviceId: d.deviceId, label: (d.label || '').trim() || `aparelho ${i + 1}` }))
            setAudioDevices(rotulo('audioinput'))
            setVideoDevices(rotulo('videoinput'))
          } catch {  }
        }
      } catch { if (vivo) setOuvinteDisponivel(false) }
    }
    void ler()
    const md: any = (navigator as any)?.mediaDevices
    const onChange = () => { void ler() }
    try { md?.addEventListener?.('devicechange', onChange) } catch {  }
    return () => {
      vivo = false
      try { md?.removeEventListener?.('devicechange', onChange) } catch {  }
    }
  }, [])

  const aplicar = async (patch: Partial<CallMediaPrefs>) => {
    setBusy(true)
    try {
      const aplicado = await onApply(patch)
      setLocal(aplicado)
    } catch (e) {
      onError?.(String((e as Error)?.message ?? e))
      setLocal(prefs)
    } finally { setBusy(false) }
  }

  const audioChoices = useMemo(() => (
    [{ deviceId: '', label: 'padrão do sistema' }, ...audioDevices]
  ), [audioDevices])
  const videoChoices = useMemo(() => (
    [{ deviceId: '', label: 'padrão do sistema' }, ...videoDevices]
  ), [videoDevices])

  return (
    <div
      role="dialog"
      aria-label="Ajustes da chamada"
      style={{
        position: 'absolute', bottom: 86, right: 12, zIndex: 30, width: 320,
        maxHeight: 'calc(100% - 110px)', overflowY: 'auto',
        background: '#232428', border: `1px solid ${T_BORDER}`, borderRadius: 12,
        padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
        boxShadow: '0 12px 34px rgba(0,0,0,.55)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: T_HEADING }}>Configurações da chamada</span>
        <button
          onClick={onClose}
          aria-label="Fechar ajustes"
          style={{ background: 'transparent', border: 'none', color: T_MUTED, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
        >✕</button>
      </div>

      {}
      <Secao title="CÂMERA">
        {onToggleCamera && (
          <>
            <Toggle
              on={!!cameraOn}
              label={cameraOn ? 'Câmera ligada' : 'Câmera desligada'}
              disabled={busy || (!!sharing && !cameraOn)}
              onChange={() => { void onToggleCamera() }}
            />
            {
}
            {sharing && !cameraOn && (
              <span style={{ fontSize: 10.5, color: T_MUTED }}>
                Pare a transmissão de tela para ligar a câmera — as duas usam o mesmo vídeo.
              </span>
            )}
          </>
        )}
        <Row label="APARELHO" hint={videoDevices.length === 0 ? 'nenhuma câmera detectada (ou permissão ainda não concedida)' : `${videoDevices.length} câmera(s) encontrada(s)`}>
          <select
            style={selectStyle}
            // Seção 1: value
            value={local.videoInputId}
            disabled={busy || !ouvinteDisponivel}
            onChange={(e) => void aplicar({ videoInputId: e.target.value })}
          >
            {videoChoices.map((d) => <option key={d.deviceId || 'default'} value={d.deviceId}>{d.label}</option>)}
          </select>
        </Row>
        <Row label="QUALIDADE" hint={qualityLabel(local.quality, local.fps)}>
          <select
            style={selectStyle}
            value={local.quality}
            disabled={busy}
            onChange={(e) => void aplicar({ quality: e.target.value as CallVideoQuality })}
          >
            {CALL_VIDEO_QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
          </select>
        </Row>
        <Row label="FPS" hint="Automático deixa o aparelho escolher.">
          <select
            style={selectStyle}
            value={local.fps}
            disabled={busy}
            onChange={(e) => void aplicar({ fps: e.target.value as CallFps })}
          >
            {CALL_FPS_OPTIONS.map((f) => <option key={f} value={f}>{f === 'auto' ? 'Automático' : `${f} fps`}</option>)}
          </select>
        </Row>
      </Secao>

      {}
      {(onToggleScreen || onScreenQualityChange) && (
        <Secao title="TRANSMISSÃO DE TELA">
          {onToggleScreen && (
            <Toggle
              on={!!sharing}
              label={sharing ? 'Transmitindo' : 'Transmitir tela'}
              disabled={busy}
              onChange={() => { void onToggleScreen() }}
            />
          )}
          {onScreenQualityChange && (
            <Row label="QUALIDADE DA TELA" hint="Tela é texto: degrau próprio, não usa o da câmera.">
              <select
                style={selectStyle}
                value={screenQuality ?? '720p'}
                disabled={busy}
                onChange={(e) => void onScreenQualityChange(e.target.value)}
              >
                <option value="auto">Automática</option>
                <option value="480p">480p (econômica)</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="1440p">1440p (nítida)</option>
                <option value="4K">4K (máxima)</option>
                <option value="8K">8K (tela 8K)</option>
              </select>
            </Row>
          )}
          {onScreenFpsChange && (
            <Row label="FPS DA TELA">
              <select
                style={selectStyle}
                value={screenFps ?? '60'}
                disabled={busy}
                onChange={(e) => void onScreenFpsChange(e.target.value)}
              >
                <option value="auto">Automático</option>
                <option value="30">30 fps</option>
                <option value="60">60 fps</option>
                <option value="120">120 fps (se suportar)</option>
              </select>
            </Row>
          )}
        </Secao>
      )}

      {}
      <Secao title="MICROFONE">
        {onToggleCamera && muted !== undefined && (
          <span style={{ fontSize: 10.5, color: T_MUTED }}>
            {muted ? 'Seu microfone está silenciado (botão da barra).' : 'Microfone ativo.'}
          </span>
        )}
        <Row label="APARELHO" hint={audioDevices.length === 0 ? 'nenhum microfone detectado (ou permissão ainda não concedida)' : `${audioDevices.length} microfone(s) encontrado(s)`}>
          <select
            style={selectStyle}
            value={local.audioInputId}
            disabled={busy || !ouvinteDisponivel}
            onChange={(e) => void aplicar({ audioInputId: e.target.value })}
          >
            {audioChoices.map((d) => <option key={d.deviceId || 'default'} value={d.deviceId}>{d.label}</option>)}
          </select>
        </Row>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {([
            ['echoCancellation', 'Cancelamento de eco'],
            ['noiseSuppression', 'Supressão de ruído'],
            ['autoGainControl', 'Ganho automático'],
          ] as const).map(([key, label]) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: T_TEXT, cursor: busy ? 'default' : 'pointer' }}>
              <input
                type="checkbox"
                checked={local[key]}
                disabled={busy}
                onChange={(e) => void aplicar({ [key]: e.target.checked } as Partial<CallMediaPrefs>)}
                style={{ accentColor: T_ACCENT, width: 15, height: 15 }}
              />
              {label}
            </label>
          ))}
        </div>
      </Secao>

      <span style={{ fontSize: 10.5, color: T_MUTED, lineHeight: 1.4 }}>
        {ouvinteDisponivel
          ? 'Trocar de aparelho no meio da chamada renegocia só a fonte — a conversa não cai.'
          : 'Este aparelho não expõe a lista de microfones/câmeras. As opções abaixo continuam valendo.'}
      </span>
      {busy ? <span style={{ fontSize: 11, color: T_ACCENT, fontWeight: 700 }}>aplicando…</span> : null}
    </div>
  )
}
