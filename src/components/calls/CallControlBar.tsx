import { useState, type ReactNode } from 'react'
import { Icon, Icons } from '../../shared/icons'

function ControlButton({
  label,
  icon,
  on,
  danger,
  disabled,
  onClick,
  size = 46,
  ariaExpanded,
  testId,
}: {
  label: string
  icon?: string
  on?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
  size?: number
  ariaExpanded?: boolean
  testId?: string
}) {
  const ativo = !!on
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-pressed={ativo}
      aria-expanded={ariaExpanded}
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
      {icon ? <Icon d={icon} size={Math.round(size * 0.44)} /> : null}
    </button>
  )
}

function MenuItem({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        color: '#fff',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        padding: '9px 10px',
        borderRadius: 7,
        fontSize: 12.5,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

export interface CallControlBarProps {
  variant: 'pill' | 'dock'
  inCall: boolean
  compact?: boolean
  palette?: { panel?: string; border?: string }
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  sharing: boolean
  cameraDisabled?: boolean
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
  onSoundboard?: () => void
  soundboardOpen?: boolean
  onLeave: () => void
  children?: ReactNode
}

export function CallControlBar({
  variant,
  inCall,
  compact = false,
  palette,
  muted,
  deafened,
  cameraOn,
  sharing,
  cameraDisabled,
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
  onSoundboard,
  soundboardOpen = false,
  onLeave,
  children,
}: CallControlBarProps) {
  const [menuAberto, setMenuAberto] = useState(false)
  const dock = variant === 'dock'
  const panel = palette?.panel ?? '#2a2a2a'
  const border = palette?.border ?? '#3c3c3c'
  const size = dock ? 44 : 46

  return (
    <div
      style={dock
        ? {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            flexWrap: 'wrap',
            padding: '10px 12px',
            paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
            width: '100%',
            boxSizing: 'border-box',
            background: '#232428',
            borderTop: `1px solid ${border}`,
            flexShrink: 0,
          }
        : {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            flexWrap: compact ? 'nowrap' : 'wrap',
            padding: compact ? '8px 10px' : '10px 16px',
            paddingBottom: compact ? 'calc(8px + env(safe-area-inset-bottom))' : 10,
            background: panel,
            border: `1px solid ${border}`,
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
            size={size}
            testId="call-mute"
            label={muted ? 'Ativar microfone' : 'Silenciar microfone'}
            icon={muted ? Icons.micOff : Icons.mic}
            on={!muted}
            danger={muted}
            onClick={onToggleMute}
          />
          {onSoundboard && (
            <ControlButton
              size={size}
              label={soundboardOpen ? 'Fechar efeitos sonoros' : 'Efeitos sonoros (até 10s)'}
              icon={Icons.music}
              on={soundboardOpen}
              danger={false}
              onClick={onSoundboard}
            />
          )}
          <ControlButton
            size={size}
            label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
            icon={deafened ? Icons.volumeX : Icons.headphones}
            on={!deafened}
            danger={deafened}
            onClick={onToggleDeafen}
          />
          <ControlButton
            size={size}
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
          {onToggleScreen && !compact && (
            <ControlButton
              size={size}
              testId={sharing ? 'call-screen-stop' : 'call-screen-share'}
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
          {(onSwitchCamera || onOpenSettings) && !compact && (
            <div style={{ position: 'relative', flexShrink: 0 }}>
              <ControlButton
                size={size}
                testId="call-more"
                label="Mais opções da chamada"
                icon={Icons.chevronRight}
                on={menuAberto}
                danger={false}
                ariaExpanded={menuAberto}
                onClick={() => setMenuAberto((v) => !v)}
              />
              {menuAberto && (
                <div
                  role="menu"
                  aria-label="Mais opções da chamada"
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 8px)',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    background: panel,
                    border: `1px solid ${border}`,
                    borderRadius: 10,
                    padding: 6,
                    minWidth: 220,
                    boxShadow: '0 10px 30px rgba(0,0,0,.5)',
                    zIndex: 5,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  {onSwitchCamera && (
                    <MenuItem
                      label={cameraSwitchLabel ?? 'Trocar de câmera'}
                      disabled={cameraSwitchDisabled}
                      onClick={() => {
                        setMenuAberto(false)
                        onSwitchCamera()
                      }}
                    />
                  )}
                  {onOpenSettings && (
                    <MenuItem
                      label="Configurações (mic, câmera, resolução)"
                      onClick={() => {
                        setMenuAberto(false)
                        onOpenSettings()
                      }}
                    />
                  )}
                </div>
              )}
            </div>
          )}
          <span style={{ width: 1, height: 32, background: border, margin: '0 2px' }} />
          <button
            type="button"
            onClick={onLeave}
            data-testid="call-leave"
            aria-label="Sair da chamada"
            title="Sair da chamada"
            style={{
              height: size,
              minWidth: dock ? 72 : 84,
              padding: '0 20px',
              borderRadius: size / 2,
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
        children
      )}
    </div>
  )
}

export default CallControlBar
