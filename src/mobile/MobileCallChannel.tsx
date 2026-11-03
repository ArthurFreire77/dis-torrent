// Tela de um canal de VOZ/VÍDEO no celular.
//
// Antes, tocar num canal de voz abria o histórico de mensagens do canal e o
// compositor — não havia como entrar na chamada pelo celular. Esta tela é o
// equivalente mobile do painel de chamada do desktop: mostra quem está no
// canal, entra/sai e expõe mic/fone/câmera (câmera é OPCIONAL: o canal de
// vídeo usa o mesmo caminho do de voz).
//
// ## Layout (unificado com o desktop)
//
// DENTRO da chamada a mídia ocupa a tela toda e os controles ficam numa barra
// fixa embaixo — o mesmo desenho do `VoiceStage` no PC. Antes os quadrados de
// 124 px ficavam no topo de uma lista rolável: numa chamada de vídeo sobrava
// espaço morto e o vídeo do outro aparecia pequeno no meio do nada.
//
// FORA da chamada, um cartão central (lobby) com quem está e o botão Entrar.

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

/** Botão redondo de controle (mesmo desenho dos dois shells). */
function Botao({
  label,
  icon,
  on,
  danger,
  onClick,
}: {
  label: string
  icon: IconName
  on?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={!!on}
      style={{
        width: 46,
        height: 46,
        borderRadius: '50%',
        border: 'none',
        flexShrink: 0,
        // Vermelho = estado ruim (mudo/surdo). Ligado = verde, igual ao PC.
        background: danger ? T.red : on ? T.green : 'rgba(255,255,255,.12)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
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
  onBack,
  onJoin,
  onLeave,
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
}: {
  channelName: string
  kind: 'voice' | 'video'
  communityName?: string
  /** Estou dentro desta chamada agora. */
  inCall: boolean
  /** Entrei e o ICE ainda não fechou. */
  connecting: boolean
  seconds: number
  participants: CallChannelParticipant[]
  /**
   * Quadrados da chamada (`CallTile`) — OBRIGATÓRIO quando `inCall`.
   *
   * Eles não são decoração: o `<audio>` que toca a voz remota e o `<video>` da
   * câmera/tela vivem DENTRO do `CallTile`. Uma tela de chamada sem eles
   * conecta, conta o tempo e fica muda e sem imagem — foi exatamente o bug do
   * canal de voz no celular.
   */
  media?: ReactNode
  myFp: string
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  error: string | null
  onBack: () => void
  onJoin: () => void
  onLeave: () => void
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
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
          width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
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

  // ── DENTRO DA CHAMADA: mídia domina a tela; controles na barra inferior ──
  if (inCall) {
    return (
      <div style={{
        height: '100dvh', display: 'flex', flexDirection: 'column',
        background: '#0b0c0f', color: T.text, fontFamily: 'Inter', overflow: 'hidden',
      }}>
        {barraTopo}

        {/* Palco: os tiles ocupam todo o espaço livre. `minHeight: 0` é o que
            permite o flex encolher em vez de estourar a tela do celular. */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {media}
          {error && (
            <div role="alert" style={{
              fontSize: 11.5, color: '#ff9c9c', lineHeight: 1.5,
              background: '#2a1518', border: `1px solid ${T.red}55`,
              borderRadius: 10, padding: '8px 10px',
            }}>{error}</div>
          )}
          {outros.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingBottom: 4 }}>
              {outros.map((p) => {
                const mudo = !!(p.muted || p.deafened)
                return (
                  <span
                    key={p.fp}
                    title={p.deafened ? 'surdo' : p.muted ? 'microfone mudo' : 'microfone aberto'}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      fontSize: 11, fontWeight: 700, maxWidth: 160,
                      color: mudo ? T.muted : T.text,
                      background: T.input, border: `1px solid ${T.border}`,
                      borderRadius: 99, padding: '3px 9px',
                    }}
                  >
                    <span style={{ display: 'flex', color: mudo ? T.red : T.green }}>
                      <Ic name={p.deafened ? 'volumeX' : p.muted ? 'micOff' : 'mic'} size={10} />
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.nickname || p.fp.slice(0, 8)}
                    </span>
                  </span>
                )
              })}
            </div>
          )}
        </div>

        {/* Controles: mesma ordem do desktop (mic, áudio, câmera, sair). */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          padding: '10px 12px', paddingBottom: 'calc(10px + env(safe-area-inset-bottom))',
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
          <button
            type="button"
            onClick={onLeave}
            aria-label="Sair da chamada"
            style={{
              height: 46, minWidth: 92, padding: '0 18px', borderRadius: 23,
              border: 'none', background: T.red, color: '#fff',
              fontSize: 14, fontWeight: 800,
            }}
          >
            Sair
          </button>
        </div>
      </div>
    )
  }

  // ── FORA DA CHAMADA: lobby com quem está e o botão Entrar ────────────────
  return (
    <div style={{
      height: '100dvh', display: 'flex', flexDirection: 'column',
      background: T.main, color: T.text, fontFamily: 'Inter', overflow: 'hidden',
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

/** Conta quem está de fato no canal (usado no lobby). */
function participantesCount(participants: CallChannelParticipant[]): number {
  return Array.isArray(participants) ? participants.filter((p) => !!p?.fp).length : 0
}
