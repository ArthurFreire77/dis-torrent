// Painel de AJUSTES DA CHAMADA (engrenagem no cabeçalho do painel).
//
// Por que existe: microfone, câmera, resolução, FPS e cancelamento de eco só
// eram escolhidos ANTES de entrar (ou nem existiam). No meio da chamada, o
// usuário não tinha como dizer "o som está vindo do microfone errado" nem
// "a tela está borrada". Tudo aqui chama `callManager.applyMediaPrefs`, que
// grava a preferência e aplica ao vivo — a UI mostra o que foi aplicado.
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
  /** Aplica e devolve o que ficou de fato; `null` = sem chamada ativa (só grava). */
  onApply: (patch: Partial<CallMediaPrefs>) => Promise<CallMediaPrefs>
  onClose: () => void
  /** Aviso honesto de erro (permissão, device ocupado). */
  onError?: (msg: string) => void
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

export default function CallSettingsPanel({ prefs, onApply, onClose, onError }: CallSettingsPanelProps) {
  const [audioDevices, setAudioDevices] = useState<DeviceOption[]>([])
  const [videoDevices, setVideoDevices] = useState<DeviceOption[]>([])
  const [local, setLocal] = useState<CallMediaPrefs>(prefs)
  const [busy, setBusy] = useState(false)
  const [ouvinteDisponivel, setOuvinteDisponivel] = useState(true)

  useEffect(() => setLocal(prefs), [prefs])

  // Lista de dispositivos. Os RÓTULOS só existem depois de uma permissão: se
  // vierem vazios, a UI diz "padrão do sistema" em vez de inventar nome.
  useEffect(() => {
    let vivo = true
    const ler = async () => {
      try {
        const md: any = (navigator as any)?.mediaDevices
        if (!md?.enumerateDevices) { setOuvinteDisponivel(false); return }
        const devs: MediaDeviceInfo[] = await md.enumerateDevices()
        if (!vivo) return
        const pick = (kind: string): DeviceOption[] => devs
          .filter((d) => d.kind === kind)
          .map((d, i) => ({ deviceId: d.deviceId, label: (d.label || '').trim() || `aparelho ${i + 1}` }))
        setAudioDevices(pick('audioinput'))
        setVideoDevices(pick('videoinput'))
      } catch { if (vivo) setOuvinteDisponivel(false) }
    }
    void ler()
    // Plug/unplug de fone/câmera: a lista se atualiza sem reabrir o painel.
    const md: any = (navigator as any)?.mediaDevices
    const onChange = () => { void ler() }
    try { md?.addEventListener?.('devicechange', onChange) } catch { /* ignore */ }
    return () => {
      vivo = false
      try { md?.removeEventListener?.('devicechange', onChange) } catch { /* ignore */ }
    }
  }, [])

  const aplicar = async (patch: Partial<CallMediaPrefs>) => {
    setBusy(true)
    try {
      const aplicado = await onApply(patch)
      setLocal(aplicado)
    } catch (e) {
      onError?.(String((e as Error)?.message ?? e))
      // Recarrega o que o manager conseguiu manter (ele reverte sozinho).
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
        position: 'absolute', top: 56, right: 12, zIndex: 30, width: 320,
        background: '#232428', border: `1px solid ${T_BORDER}`, borderRadius: 12,
        padding: 12, display: 'flex', flexDirection: 'column', gap: 10,
        boxShadow: '0 12px 34px rgba(0,0,0,.55)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 13, fontWeight: 800, color: T_HEADING }}>Ajustes da chamada</span>
        <button
          onClick={onClose}
          aria-label="Fechar ajustes"
          style={{ background: 'transparent', border: 'none', color: T_MUTED, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
        >✕</button>
      </div>

      <Row label="MICROFONE">
        <select
          style={selectStyle}
          value={local.audioInputId}
          disabled={busy || !ouvinteDisponivel}
          onChange={(e) => void aplicar({ audioInputId: e.target.value })}
        >
          {audioChoices.map((d) => <option key={d.deviceId || 'default'} value={d.deviceId}>{d.label}</option>)}
        </select>
      </Row>

      <Row label="CÂMERA">
        <select
          style={selectStyle}
          value={local.videoInputId}
          disabled={busy || !ouvinteDisponivel}
          onChange={(e) => void aplicar({ videoInputId: e.target.value })}
        >
          {videoChoices.map((d) => <option key={d.deviceId || 'default'} value={d.deviceId}>{d.label}</option>)}
        </select>
      </Row>

      <Row
        label="QUALIDADE DA CÂMERA"
        hint={qualityLabel(local.quality, local.fps)}
      >
        <select
          style={selectStyle}
          value={local.quality}
          disabled={busy}
          onChange={(e) => void aplicar({ quality: e.target.value as CallVideoQuality })}
        >
          {CALL_VIDEO_QUALITIES.map((q) => <option key={q} value={q}>{q}</option>)}
        </select>
      </Row>

      <Row label="FPS" hint="Automático deixa o aparelho escolher (sem teto artificial).">
        <select
          style={selectStyle}
          value={local.fps}
          disabled={busy}
          onChange={(e) => void aplicar({ fps: e.target.value as CallFps })}
        >
          {CALL_FPS_OPTIONS.map((f) => <option key={f} value={f}>{f === 'auto' ? 'Automático' : `${f} fps`}</option>)}
        </select>
      </Row>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${T_BORDER}`, paddingTop: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: T_MUTED, letterSpacing: 0.4 }}>PROCESSAMENTO DE VOZ</span>
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

      <span style={{ fontSize: 10.5, color: T_MUTED, lineHeight: 1.4 }}>
        {ouvinteDisponivel
          ? 'Trocar de aparelho no meio da chamada renegocia só a fonte — a conversa não cai.'
          : 'Este aparelho não expõe a lista de microfones/câmeras. As opções abaixo continuam valendo.'}
      </span>
      {busy ? <span style={{ fontSize: 11, color: T_ACCENT, fontWeight: 700 }}>aplicando…</span> : null}
    </div>
  )
}
