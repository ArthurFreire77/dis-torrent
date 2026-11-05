import { Ic, type IconName } from '../shared/icons'
import type { ReactNode } from 'react'

const T = {
  rail: '#0f1115', main: '#14161a', panel: '#1e2128', input: '#23262f',
  border: '#242830', accent: '#5865f2', green: '#23a559', red: '#f23f42',
  text: '#f2f3f5', heading: '#ffffff', muted: '#8e929b', yellow: '#f0b232',
}

export interface CallChannelParticipant {
  fp: string
  nickname?: string
  muted?: boolean
  deafened?: boolean
}

function fmtDuration(s: number): string {
  const total = Math.max(0, Math.floor(s))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60).toString().padStart(2, '0')
  const sec = (total % 60).toString().padStart(2, '0')
  return h > 0 ? `${h}:${m}:${sec}` : `${m}:${sec}`
}

function Botao({
  label,
  icon,
  on,
  danger,
  disabled,
  onClick,
}: {
  label: string
  icon: IconName
  on?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={!!on}
      disabled={disabled}
      style={{
        width: 46,
        height: 46,
        borderRadius: '50%',
        border: 'none',
        flexShrink: 0,
        background: disabled ? 'rgba(255,255,255,.06)' : danger ? T.red : on ? T.green : 'rgba(255,255,255,.12)',
        color: disabled ? 'rgba(255,255,255,.4)' : '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.7 : 1,
      }}
    >
      <Ic name={icon} size={19} />
    </button>
  )
}

export default function MobileCallChannel({
  channelName,
  kind,
  communityName,
  inCall,
  connecting,
  seconds,
  participants,
  media,
  myFp,
  muted,
  deafened,
  cameraOn,
  error,
  canSwitchCamera,
  onBack,
  onJoin,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
  onSwitchCamera,
}: {
  channelName: string
  kind: 'voice' | 'video'
  communityName?: string
  inCall: boolean
  connecting: boolean
  seconds: number
  participants: CallChannelParticipant[]
  media?: ReactNode
  myFp: string
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  error: string | null
  canSwitchCamera?: boolean
  onBack: () => void
  onJoin: () => void
  onLeave: () => void
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
  onSwitchCamera?: () => void
}) {
  const titulo = kind === 'video' ? 'Canal de vídeo' : 'Canal de voz'
  const outros = participants.filter((p) => p.fp !== myFp)

  const barraTopo = (
    <div style={{
      minHeight: 52, display: 'flex', alignItems: 'center', gap: 8,
      paddingLeft: 8, paddingRight: 10, paddingTop: 'env(safe-area-inset-top)',
      background: T.rail, borderBottom: `1px solid ${T.border}`, flexShrink: 0,
    }}>
      <button
        aria-label="Voltar"
        onClick={onBack}
        style={{
          width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', color: T.text, flexShrink: 0,
        }}
      >
        <span style={{ display: 'flex', transform: 'rotate(90deg)' }}><Ic name="chevron" size={18} /></span>
      </button>
      <span style={{ display: 'flex', flexShrink: 0, color: inCall ? T.green : T.muted }}>
        <Ic name={kind === 'video' ? 'video' : 'speaker'} size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14.5, fontWeight: 800, color: T.heading,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{channelName}</div>
        <div style={{ fontSize: 10.5, color: T.muted, display: 'flex', alignItems: 'center', gap: 6 }}>
          {inCall ? (
            <>
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: connecting ? T.yellow : T.green,
              }} />
              <span style={{ fontWeight: 700, color: connecting ? T.yellow : T.green }}>
                {connecting ? 'Conectando…' : `na chamada · ${fmtDuration(seconds)}`}
              </span>
              <span>· {participants.length} {participants.length === 1 ? 'pessoa' : 'pessoas'}</span>
            </>
          ) : (
            <span>{titulo}{communityName ? ` · ${communityName}` : ''}</span>
          )}
        </div>
      </div>
    </div>
  )

  if (inCall) {
    return (
      <div style={{
        height: '100dvh', display: 'flex', flexDirection: 'column',
        background: '#0b0c0f', color: T.text, fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", overflow: 'hidden',
      }}>
        {barraTopo}

        {}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 6 }}>
          {media ?? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ textAlign: 'center', color: T.muted, fontSize: 12.5, maxWidth: 280, lineHeight: 1.6 }}>
                <Ic name="speaker" size={34} />
                <div style={{ marginTop: 10 }}>
                  {outros.length === 0
                    ? 'Você está sozinho na chamada — quem entrar aparece aqui.'
                    : 'Conectando o vídeo dos participantes…'}
                </div>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div role="alert" style={{
            margin: '0 10px 6px', fontSize: 11.5, color: '#ff9c9c', lineHeight: 1.5,
            background: '#2a1518', border: `1px solid ${T.red}55`,
            borderRadius: 10, padding: '8px 10px', flexShrink: 0,
          }}>{error}</div>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          padding: '8px 10px', paddingBottom: 'calc(8px + env(safe-area-inset-bottom))',
          background: T.panel, borderTop: `1px solid ${T.border}`, flexShrink: 0,
        }}>
          <Botao
            label={muted ? 'Ativar microfone' : 'Silenciar microfone'}
            icon={muted ? 'micOff' : 'mic'}
            on={!muted}
            danger={muted}
            onClick={onToggleMute}
          />
          <Botao
            label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
            icon={deafened ? 'volumeX' : 'headphones'}
            on={!deafened}
            danger={deafened}
            onClick={onToggleDeafen}
          />
          <Botao
            label={cameraOn ? 'Desligar câmera' : 'Ligar câmera'}
            icon="video"
            on={cameraOn}
            onClick={onToggleCamera}
          />
          {canSwitchCamera && onSwitchCamera && (
            <Botao
              label={cameraOn ? 'Inverter câmera (frontal/traseira)' : 'Escolher a câmera da próxima transmissão'}
              icon="cameraSwitch"
              onClick={onSwitchCamera}
            />
          )}
          <button
            type="button"
            onClick={onLeave}
            aria-label="Sair da chamada"
            style={{
              height: 46, minWidth: 76, padding: '0 14px', borderRadius: 23,
              border: 'none', background: T.red, color: '#fff',
              fontSize: 14, fontWeight: 800, flexShrink: 0,
            }}
          >
            Sair
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      background: T.main, color: T.text, fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif", overflow: 'hidden',
    }}>
      {barraTopo}

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          background: T.panel, border: `1px solid ${T.border}`,
          borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
              background: participantesCount(participants) ? T.green : T.muted,
            }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 800, color: T.text }}>
              {participantesCount(participants) === 0
                ? 'Ninguém na chamada agora'
                : `${participantesCount(participants)} ${participantesCount(participants) === 1 ? 'pessoa' : 'pessoas'} na chamada`}
            </span>
          </div>

          {participants.length === 0 ? (
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6 }}>
              Entrar abre a chamada para quem chegar depois — todos os membros
              pareiam direto entre si (mesh), sem servidor de mídia.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {participants.map((p) => {
                // Seção 1: eu
                const eu = p.fp === myFp
                const mudo = !!(p.muted || p.deafened)
                return (
                  <span
                    key={p.fp}
                    title={p.deafened ? 'surdo' : p.muted ? 'microfone mudo' : 'microfone aberto'}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      fontSize: 11.5, fontWeight: 700, maxWidth: 170,
                      color: mudo ? T.muted : T.text,
                      background: T.input, border: `1px solid ${T.border}`,
                      borderRadius: 99, padding: '3px 9px',
                    }}
                  >
                    <span style={{ display: 'flex', color: mudo ? T.red : T.green }}>
                      <Ic name={p.deafened ? 'volumeX' : p.muted ? 'micOff' : 'mic'} size={10} />
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {eu ? 'você' : (p.nickname || p.fp.slice(0, 8))}
                    </span>
                  </span>
                )
              })}
            </div>
          )}

          {error && (
            <div role="alert" style={{ fontSize: 11.5, color: '#ff9c9c', lineHeight: 1.5 }}>{error}</div>
          )}
        </div>

        <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
          A mídia vai direto entre os membros (P2P). Em redes com NAT fechado o app tenta relay;
          sem nenhum caminho a chamada avisa — nunca fica “conectada” sem áudio.
        </div>
      </div>

      <div style={{
        padding: '10px 14px', paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
        background: T.panel, borderTop: `1px solid ${T.border}`, flexShrink: 0,
      }}>
        <button
          type="button"
          onClick={onJoin}
          aria-label="Entrar na chamada"
          style={{
            width: '100%', background: T.green, border: 'none', color: '#fff',
            borderRadius: 12, padding: '14px', fontSize: 15, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}
        >
          <Ic name={kind === 'video' ? 'video' : 'phone'} size={18} />
          Entrar na chamada
        </button>
      </div>
    </div>
  )
}

function participantesCount(participants: CallChannelParticipant[]): number {
  return Array.isArray(participants) ? participants.filter((p) => !!p?.fp).length : 0
}
