import { useState, type ReactNode } from 'react'
import { Icon, Icons } from '../../shared/icons'
import CallPhaseBadge from '../CallPhaseBadge'
import type { CallPhase } from '../../services/callPhases'
import { participantsLabel, type VoiceLayout } from '../../services/voiceLayout'
import { joinButtonState } from '../../services/callUiState'

export interface VoiceStagePalette {
  stage: string
  panel: string
  input: string
  border: string
  heading: string
  text: string
  muted: string
  green: string
  red: string
  yellow?: string
  accent: string
}

export interface VoiceStagePeer {
  fp: string
  nome: string
  muted?: boolean
  deafened?: boolean
  eu?: boolean
}

export interface VoiceStageProps {
  layout: VoiceLayout
  palette: VoiceStagePalette
  title: string
  subtitle?: string
  kind: 'voice' | 'video'
  inCall: boolean
  phase: CallPhase
  startAt: number
  nowMs: number
  mediaLive: boolean
  ringing?: boolean
  route?: string
  waitingAlone?: boolean
  media?: ReactNode
  peers?: VoiceStagePeer[]
  unavailable?: string | null
  busy?: boolean
  notice?: string | null
  extra?: ReactNode
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  sharing: boolean
  cameraDisabled?: boolean
  onJoin: () => void
  onLeave: () => void
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
  onToggleScreen?: () => void
  screenAvailable?: boolean
  screenUnavailableReason?: string | null
  onSwitchCamera?: () => void
  cameraSwitchLabel?: string | null
  cameraSwitchDisabled?: boolean
  onOpenSettings?: () => void
  settings?: ReactNode
  compact?: boolean
}

function fmtDuracao(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function ControlButton({
  label,
  icon,
  on,
  danger,
  disabled,
  onClick,
  size = 46,
  children,
}: {
  label: string
  icon?: string
  on?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  size?: number
  children?: ReactNode
}) {
  const ativo = !!on
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={ativo}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        background: danger ? '#ea4335' : on ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.10)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        transition: 'background 120ms ease',
      }}
    >
      {children ?? (icon ? <Icon d={icon} size={Math.round(size * 0.44)} /> : null)}
    </button>
  )
}

export function VoiceStage({
  layout,
  palette: c,
  title,
  subtitle,
  kind,
  inCall,
  phase,
  startAt,
  nowMs,
  mediaLive,
  ringing,
  route,
  waitingAlone,
  media,
  peers = [],
  unavailable,
  busy,
  notice,
  extra,
  muted,
  deafened,
  cameraOn,
  sharing,
  cameraDisabled,
  onJoin,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreen,
  screenAvailable = true,
  screenUnavailableReason,
  onSwitchCamera,
  cameraSwitchLabel = null,
  cameraSwitchDisabled = false,
  onOpenSettings,
  settings,
  compact = false,
}: VoiceStageProps) {
  const entrar = joinButtonState({
    inThisCall: inCall,
    busy,
    unavailable,
  })
  const entrarBloqueado = entrar.disabled
  const duracao = inCall ? fmtDuracao(Math.max(0, nowMs - startAt)) : ''
  const [painelAberto, setPainelAberto] = useState(false)

  const listaPeers = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {peers.map((p) => {
        const mudo = !!(p.muted || p.deafened)
        return (
          <span
            key={p.fp}
            title={p.deafened ? `${p.nome} — surdo` : p.muted ? `${p.nome} — microfone mudo` : p.nome}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
              padding: '7px 6px', borderRadius: 8,
              fontSize: 13, fontWeight: 500, lineHeight: 1.4,
              color: mudo ? c.muted : c.text,
            }}
          >
            <span style={{ display: 'flex', flexShrink: 0, color: mudo ? c.red : c.muted }}>
              <Icon d={p.deafened ? Icons.volumeX : p.muted ? Icons.micOff : Icons.mic} size={14} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              {p.eu ? 'você' : p.nome}
            </span>
            {p.eu && (
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: c.muted }}>EU</span>
            )}
          </span>
        )
      })}
    </div>
  )

  const controles = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        flexWrap: compact ? 'nowrap' : 'wrap',
        padding: compact ? '8px 10px' : '10px 16px',
        paddingBottom: compact ? 'calc(8px + env(safe-area-inset-bottom))' : 10,
        background: c.panel,
        border: `1px solid ${c.border}`,
        borderRadius: compact ? 0 : 999,
        boxShadow: compact ? 'none' : '0 6px 24px rgba(0,0,0,.45)',
        maxWidth: 'calc(100% - 24px)',
        boxSizing: 'border-box',
        ...(compact
          ? { flexShrink: 0, width: '100%' }
          : { position: 'absolute' as const, left: '50%', bottom: 20, transform: 'translateX(-50%)', zIndex: 3 }),
      }}
    >
      {inCall ? (
        <>
          <ControlButton
            label={muted ? 'Ativar microfone' : 'Silenciar microfone'}
            icon={muted ? Icons.micOff : Icons.mic}
            on={!muted}
            danger={muted}
            onClick={onToggleMute}
          />
          <ControlButton
            label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
            icon={deafened ? Icons.volumeX : Icons.headphones}
            on={!deafened}
            danger={deafened}
            onClick={onToggleDeafen}
          />
          <ControlButton
            label={
              cameraDisabled
                ? 'Câmera indisponível enquanto compartilha a tela'
                : cameraOn ? 'Desligar câmera' : 'Ligar câmera'
            }
            icon={Icons.video}
            on={cameraOn}
            danger={false}
            disabled={cameraDisabled}
            onClick={onToggleCamera}
          />
          {onSwitchCamera && !compact && (
            <ControlButton
              label={cameraSwitchLabel ?? 'Trocar de câmera'}
              icon={Icons.cameraSwitch}
              on={false}
              danger={false}
              disabled={cameraSwitchDisabled}
              onClick={onSwitchCamera}
            />
          )}
          {onToggleScreen && !compact && (
            <ControlButton
              label={
                sharing
                  ? 'Parar de compartilhar a tela'
                  : screenAvailable
                    ? 'Compartilhar tela'
                    : (screenUnavailableReason ?? 'Compartilhar tela indisponível neste aparelho')
              }
              icon={Icons.screen}
              on={sharing}
              danger={false}
              disabled={!sharing && !screenAvailable}
              onClick={onToggleScreen}
            />
          )}
          {onOpenSettings && !compact && (
            <ControlButton
              label="Configurações da chamada (mic, câmera, resolução, FPS)"
              icon={Icons.gear}
              on={false}
              danger={false}
              onClick={onOpenSettings}
            />
          )}
          <span style={{ width: 1, height: 32, background: c.border, margin: '0 2px' }} />
          <button
            type="button"
            onClick={onLeave}
            aria-label="Sair da chamada"
            title="Sair da chamada"
            style={{
              height: 46,
              minWidth: 84,
              padding: '0 20px',
              borderRadius: 23,
              border: 'none',
              background: '#ea4335',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              flexShrink: 0,
            }}
          >
            <Icon d={Icons.phone} size={17} rotate={135} /> Sair
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onJoin}
          disabled={entrarBloqueado}
          title={entrar.reason ?? undefined}
          aria-label={entrar.ariaLabel}
          style={{
            height: 48,
            minWidth: 220,
            padding: '0 26px',
            borderRadius: 24,
            border: 'none',
            background: entrar.tone === 'unavailable' ? c.border : '#1a73e8',
            color: '#fff',
            cursor: entrarBloqueado ? 'not-allowed' : 'pointer',
            opacity: entrarBloqueado ? 0.7 : 1,
            fontSize: 14.5,
            fontWeight: 700,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 9,
          }}
        >
          <Icon d={kind === 'video' ? Icons.video : Icons.phone} size={18} />
          {entrar.label}
        </button>
      )}
    </div>
  )

  const cabecalho = (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: compact ? '8px 12px' : '8px 16px',
        paddingTop: compact ? 'calc(8px + env(safe-area-inset-top))' : 8,
        background: c.panel,
        borderBottom: `1px solid ${c.border}`,
        flexShrink: 0,
        minHeight: 52,
      }}
    >
      <span
        style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'rgba(255,255,255,.1)', color: c.text,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon d={kind === 'video' ? Icons.video : Icons.phone} size={16} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontSize: compact ? 14 : 14.5, fontWeight: 600, color: c.heading,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 1, flexWrap: 'wrap' }}>
          {inCall ? (
            <>
              {waitingAlone ? (
                <span
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    fontSize: 11.5, fontWeight: 600, color: c.muted,
                  }}
                >
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: c.yellow ?? '#fdd663' }} />
                  Esperando alguém entrar
                </span>
              ) : (
                <CallPhaseBadge
                  phase={phase}
                  startAt={startAt}
                  nowMs={nowMs}
                  mediaLive={mediaLive}
                  ringing={ringing}
                />
              )}
              <span style={{ fontSize: 11, color: c.muted, fontVariantNumeric: 'tabular-nums' }}>
                {duracao}
              </span>
            </>
          ) : (
            <span style={{ fontSize: 11.5, color: c.muted }}>
              {subtitle ?? (kind === 'video' ? 'Canal de vídeo — a câmera é opcional' : 'Canal de voz')}
            </span>
          )}
          {route && route !== 'n/d' && (
            <span
              title="Rota real da mídia (ICE)"
              style={{
                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                color: c.muted, border: `1px solid ${c.border}`,
                padding: '1px 7px', borderRadius: 99,
              }}
            >rota {route}</span>
          )}
        </span>
      </span>

      {inCall && (
        <button
          type="button"
          onClick={() => setPainelAberto((v) => !v)}
          aria-label={`Quem está na chamada (${peers.length})`}
          aria-expanded={painelAberto}
          title="Pessoas na chamada"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, flexShrink: 0,
            height: 36, padding: '0 12px', borderRadius: 18,
            background: painelAberto ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.08)',
            border: `1px solid ${c.border}`,
            color: c.text, cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
          }}
        >
          <Icon d={Icons.users} size={15} />
          {peers.length}
        </button>
      )}
    </div>
  )

  const mediaTemConteudo = (() => {
    if (!media) return false
    const lista = Array.isArray(media) ? media : [media]
    return lista.some((m) => m != null)
  })()

  const palco = inCall && layout.stageFill ? (
    <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column', background: c.stage }}>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', paddingBottom: compact ? 0 : 92 }}>
        {media}
      </div>
      {waitingAlone && !mediaTemConteudo && (
        <div
          style={{
            position: 'absolute', left: 0, right: 0, top: 0, bottom: compact ? 0 : 92,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            pointerEvents: 'none', padding: 24,
            background: 'transparent',
          }}
        >
          <span style={{ fontSize: 13.5, color: c.muted, textAlign: 'center', lineHeight: 1.6, maxWidth: 360 }}>
            Você está na chamada. Quando alguém entrar, o áudio e o vídeo
            aparecem aqui — pode ficar o tempo que quiser.
          </span>
        </div>
      )}
      {!compact && controles}
    </div>
  ) : null

  const lobby = !inCall && (
    <div
      style={{
        flex: 1, minHeight: 0, background: c.stage,
        display: 'flex', flexDirection: 'column', alignItems: 'stretch',
        position: 'relative',
      }}
    >
      <div
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: compact ? 16 : 24,
          // Espaço para a pílula de controles em fluxo absoluto (desktop).
          paddingBottom: compact ? 16 : 104,
        }}
      >
        <div style={{ width: '100%', maxWidth: compact ? 460 : 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
            <span style={{
              width: 72, height: 72, borderRadius: 24,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(255,255,255,.1)', color: c.text,
            }}>
              <Icon d={kind === 'video' ? Icons.video : Icons.speaker} size={32} />
            </span>
            <div style={{ fontSize: 20, fontWeight: 500, color: c.heading }}>{title}</div>
            <div style={{ fontSize: 13, color: c.muted, lineHeight: 1.6, maxWidth: 420 }}>
              {kind === 'video'
                ? 'Canal de vídeo é uma chamada como a de voz. A câmera é opcional e liga no botão da chamada.'
                : 'Entre para falar com quem já está aqui. A mídia vai direto entre os membros (P2P).'}
            </div>
          </div>

          <div style={{
            background: c.input, border: `1px solid ${c.border}`,
            borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
                background: peers.length > 0 ? c.green : c.muted,
              }} />
              <span style={{ flex: 1, fontSize: 12.5, fontWeight: 700, color: c.text }}>
                {participantsLabel(peers.length)}
              </span>
            </div>
            {peers.length === 0 ? (
              <div style={{ fontSize: 12.5, color: c.muted, lineHeight: 1.6 }}>
                Ninguém no canal agora. Entre e fique à vontade: quando alguém
                chegar, a chamada conecta sozinha — todos pareiam direto entre si
                (mesh), sem servidor de mídia.
              </div>
            ) : listaPeers}
            {notice && (
              <div role="status" style={{ fontSize: 11.5, color: c.yellow ?? '#fdd663', lineHeight: 1.5 }}>
                {notice}
              </div>
            )}
            {!inCall && unavailable && (
              <div role="alert" style={{ fontSize: 11.5, color: '#f28b82', lineHeight: 1.5 }}>
                {unavailable}
              </div>
            )}
          </div>
        </div>
      </div>
      {compact ? (
        <div style={{ flexShrink: 0 }}>{controles}</div>
      ) : (
        controles
      )}
    </div>
  )

  const painelPessoas = painelAberto && inCall && (
    <>
      <div
        onClick={() => setPainelAberto(false)}
        style={{ position: 'absolute', inset: 0, zIndex: 4 }}
        aria-hidden
      />
      <div
        role="dialog"
        aria-label="Pessoas na chamada"
        style={{
          position: 'absolute', top: compact ? 0 : 60, right: 12, zIndex: 5,
          width: compact ? 'calc(100% - 24px)' : 300,
          maxHeight: compact ? '70%' : 'calc(100% - 150px)',
          overflowY: 'auto',
          background: c.panel,
          border: `1px solid ${c.border}`,
          borderRadius: 12,
          boxShadow: '0 12px 32px rgba(0,0,0,.55)',
          padding: 12,
          display: 'flex', flexDirection: 'column', gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: c.heading }}>
            Na chamada · {peers.length}
          </span>
          <button
            type="button"
            onClick={() => setPainelAberto(false)}
            aria-label="Fechar pessoas"
            style={{ background: 'transparent', border: 'none', color: c.muted, cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
          >✕</button>
        </div>
        {peers.length === 0 ? (
          <span style={{ fontSize: 12, color: c.muted }}>Só você por aqui.</span>
        ) : listaPeers}
        {extra && (
          <div style={{ borderTop: `1px solid ${c.border}`, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {extra}
          </div>
        )}
      </div>
    </>
  )

  return (
    <div
      data-testid="voice-stage"
      data-voice-mode={layout.mode}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        background: c.stage,
        color: c.text,
        overflow: 'hidden',
      }}
    >
      {layout.showChannelHeader && cabecalho}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {palco}
        {lobby}
      </div>
      {compact && inCall && controles}
      {painelPessoas}
      {settings}
    </div>
  )
}

export default VoiceStage
