// Seletor de compartilhamento de tela (fonte, áudio, qualidade, FPS).
//
// Tudo que o sistema realmente suporta aparece; o que não existe na
// plataforma fica visivelmente desabilitado COM o motivo — nada de menu
// offering opção que ia falhar. A escolha vira uma chamada a
// `callManager.setScreenShareOptions`, que aplica na captura viva sem derrubar
// a chamada (trocar fonte/áudio recaptura, resolução/FPS não).

import { useEffect, useMemo, useState } from 'react'
import { callManager, screenShareUnavailableReason } from '../services/callManager'
import {
  detectScreenEnvironment,
  buildSourceChoices,
  supportsScreenSource,
  listShareableMonitors,
  SCREEN_QUALITY_STEPS,
  SCREEN_FPS_OPTIONS,
  type ScreenShareOptions,
  type ScreenSourceKind,
  type ScreenAudioMode,
  type ScreenQualityKey,
  type ScreenFpsKey,
  type MonitorInfo,
} from '../services/screenShare'
import { ui, labelStyle, helpStyle, errorStyle, Modal, Button, WIDTHS } from '../shared/ui'
import { Icon } from '../shared/icons'

const AUDIO_CHOICES: { value: ScreenAudioMode; label: string; needsSystem: boolean }[] = [
  { value: 'none', label: 'Somente tela', needsSystem: false },
  { value: 'system', label: 'Tela + áudio do sistema', needsSystem: true },
  { value: 'mic', label: 'Tela + microfone', needsSystem: false },
  { value: 'system+mic', label: 'Tela + sistema + microfone', needsSystem: true },
]

const QUALITY_CHOICES: { value: ScreenQualityKey; label: string }[] = [
  { value: 'auto', label: 'Automática' },
  { value: '480p', label: '480p (mínimo)' },
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
]

const FPS_LABELS: Record<ScreenFpsKey, string> = {
  auto: 'Automático',
  '30': '30 FPS',
  '60': '60 FPS',
  '120': '120 FPS (se o aparelho suportar)',
}
// A lista de opções vem de screenShare.ts (fonte única); aqui só o rótulo.
const FPS_CHOICES: { value: ScreenFpsKey; label: string }[] = SCREEN_FPS_OPTIONS.map(v => ({
  value: v,
  label: FPS_LABELS[v],
}))

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: ui.lg }}>
      <div style={labelStyle}>{label}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: ui.sm }}>{children}</div>
    </div>
  )
}

function Choice({
  active,
  disabled,
  onClick,
  children,
  testId,
  ariaLabel,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
  testId?: string
  ariaLabel?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      aria-pressed={active}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      style={{
        padding: '8px 12px',
        borderRadius: ui.radius,
        border: `1px solid ${active ? ui.accent : ui.border}`,
        background: active ? 'rgba(88,101,242,.18)' : ui.input,
        color: disabled ? ui.muted : active ? ui.heading : ui.text,
        fontSize: 12,
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  )
}

export default function ScreenSharePicker({
  open,
  onClose,
  onError,
}: {
  open: boolean
  onClose: () => void
  onError: (msg: string) => void
}) {
  const env = useMemo(() => detectScreenEnvironment(), [open])
  const [opts, setOpts] = useState<ScreenShareOptions>(() => callManager.getScreenShareOptions())
  const [busy, setBusy] = useState(false)
  const [monitors, setMonitors] = useState<MonitorInfo[]>([])
  const unavailable = !env.hasDisplayMedia ? screenShareUnavailableReason() : null

  // Monitores reais da máquina. Só faz sentido quando a fonte é "monitor
  // específico"; fora do app nativo (Android/browser) a lista fica vazia e a UI
  // não promete o que a plataforma não tem.
  useEffect(() => {
    let alive = true
    if (!open || opts.source !== 'monitor') { setMonitors([]); return }
    void listShareableMonitors().then(list => { if (alive) setMonitors(list) })
    return () => { alive = false }
  }, [open, opts.source])

  const choices = useMemo(() => buildSourceChoices(env, opts.source), [env, opts.source])

  async function apply(next: ScreenShareOptions, startNow: boolean) {
    setOpts(next)
    try {
      await callManager.setScreenShareOptions(next)
      if (startNow) await callManager.startScreenShare(next)
      onClose()
    } catch (e: any) {
      onError(String(e?.message ?? e))
    }
  }

  if (!open) return null

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compartilhar tela"
      subtitle="Captura local enviada direto para os participantes (P2P, sem servidor de vídeo)."
      width={WIDTHS.sm}
    >
      {unavailable && (
        <div style={{ ...errorStyle, marginBottom: ui.lg }}>
          <strong>Captura indisponível.</strong> {unavailable}
        </div>
      )}
      {env.notes.length > 0 && !unavailable && (
        <div style={{ ...helpStyle, marginTop: -4, marginBottom: ui.md }}>{env.notes.join(' · ')}</div>
      )}

      <Row label="O que compartilhar">
        {choices.map((c) => (
          <Choice
            key={c.kind}
            testId={`screen-source-${c.kind}`}
            ariaLabel={`${c.label}. ${c.detail}`}
            active={opts.source === c.kind}
            disabled={!c.available}
            onClick={() => apply({ ...opts, source: c.kind as ScreenSourceKind }, false)}
          >
            {c.label}
          </Choice>
        ))}
      </Row>

      {opts.source === 'monitor' && monitors.length > 0 && (
        <div style={{ marginTop: -8, marginBottom: ui.lg }} data-testid="screen-monitor-list">
          <div style={{ ...labelStyle, marginBottom: ui.xs }}>Monitores detectados ({monitors.length})</div>
          {monitors.map(m => (
            <div key={m.id} style={{ ...helpStyle, display: 'flex', gap: ui.sm, alignItems: 'center' }}>
              <span style={{ color: ui.text }}>
                {m.name ?? 'Monitor'} — {m.width}x{m.height}
              </span>
              {m.primary && <span style={{ color: ui.muted }}>(principal)</span>}
              {m.scale !== 1 && <span style={{ color: ui.muted }}>(escala {m.scale}×)</span>}
            </div>
          ))}
          <div style={{ ...helpStyle, marginTop: ui.xs }}>
            Escolha qual deles enviar na próxima etapa, no seletor do sistema.
          </div>
        </div>
      )}

      <Row label="Áudio">
        {AUDIO_CHOICES.map((a) => {
          const disabled = a.needsSystem && !env.systemAudio
          return (
            <Choice
              key={a.value}
              testId={`screen-audio-${a.value}`}
              ariaLabel={a.label}
              active={opts.audio === a.value}
              disabled={disabled}
              onClick={() => apply({ ...opts, audio: a.value }, false)}
            >
              {a.label}
            </Choice>
          )
        })}
      </Row>

      <Row label="Qualidade">
        {QUALITY_CHOICES.map((q) => (
          <Choice
            key={q.value}
            testId={`screen-quality-${q.value}`}
            ariaLabel={`Qualidade ${q.label}`}
            active={opts.quality === q.value}
            onClick={() => apply({ ...opts, quality: q.value }, false)}
          >
            {q.label}
          </Choice>
        ))}
      </Row>

      <Row label="Quadros por segundo">
        {FPS_CHOICES.map((f) => (
          <Choice
            key={f.value}
            testId={`screen-fps-${f.value}`}
            ariaLabel={`${f.label} de quadros por segundo`}
            active={opts.fps === f.value}
            onClick={() => apply({ ...opts, fps: f.value }, false)}
          >
            {f.label}
          </Choice>
        ))}
      </Row>

      <div style={{ ...helpStyle, marginTop: -4 }}>
        Piso operacional {SCREEN_QUALITY_STEPS[0].label}; o degrau muda sozinho se a rede cair.
        {opts.fps === '120' && ' 120 FPS só é atingido com monitor, encoder e placa que suportem.'}
      </div>

      <div style={{ display: 'flex', gap: ui.sm, marginTop: ui.lg, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={onClose} ariaLabel="Cancelar compartilhamento">
          Cancelar
        </Button>
        <Button
          variant="primary"
          icon="screen"
          busy={busy}
          disabled={!!unavailable}
          ariaLabel="Iniciar compartilhamento de tela"
          onClick={() => {
            setBusy(true)
            void apply(opts, true).finally(() => setBusy(false))
          }}
        >
          Compartilhar agora
        </Button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: ui.md, color: ui.muted, fontSize: 11 }}>
        <Icon d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 16v-4 M12 8h.01" size={12} />
        {supportsScreenSource(env, 'monitor')
          ? 'No próximo passo o sistema abre o seletor nativo: escolha lá qual monitor ou janela enviar.'
          : 'O sistema abre o seletor nativo de tela na próxima etapa.'}
      </div>
    </Modal>
  )
}