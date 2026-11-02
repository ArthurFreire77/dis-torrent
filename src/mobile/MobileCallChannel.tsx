// Tela de um canal de VOZ/VÍDEO no celular.
//
// Antes, tocar num canal de voz abria o histórico de mensagens do canal e o
// compositor — não havia como entrar na chamada pelo celular. Esta tela é o
// equivalente mobile do painel de chamada do desktop: mostra quem está no
// canal, entra/sai e expõe mic/fone/câmera (câmera é OPCIONAL: o canal de
// vídeo usa o mesmo caminho do de voz).

import { Ic } from '../shared/icons'

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
  const m = Math.floor(s / 60).toString().padStart(2, '0')
  const sec = (s % 60).toString().padStart(2, '0')
  return `${m}:${sec}`
}

export default function MobileCallChannel({
  channelName,
  kind,
  communityName,
  inCall,
  connecting,
  seconds,
  participants,
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

  return (
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column', background: T.main, color: T.text, fontFamily: 'Inter', overflow: 'hidden' }}>
      <div style={{ height: 48, display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, paddingTop: 'env(safe-area-inset-top)', background: T.rail, borderBottom: `1px solid ${T.border}`, flexShrink: 0 }}>
        <button aria-label="Voltar" onClick={onBack} style={{ width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: T.text }}>
          <span style={{ display: 'flex', transform: 'rotate(90deg)' }}><Ic name="chevron" size={18} /></span>
        </button>
        <span style={{ display: 'flex', flexShrink: 0, color: T.muted }}>
          <Ic name={kind === 'video' ? 'video' : 'speaker'} size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 800, color: T.heading, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{channelName}</div>
          <div style={{ fontSize: 10.5, color: T.muted }}>
            {titulo}{communityName ? ` · ${communityName}` : ''}
          </div>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          background: T.panel, border: `1px solid ${inCall ? `${T.green}66` : T.border}`,
          borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
              background: inCall ? (connecting ? T.yellow : T.green) : T.muted,
            }} />
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 800, color: inCall ? T.green : T.text }}>
              {inCall ? (connecting ? 'Conectando…' : `Na chamada · ${fmtDuration(seconds)}`) : 'Você não está nesta chamada'}
            </span>
            <span style={{ fontSize: 11, color: T.muted }}>
              {participants.length} {participants.length === 1 ? 'pessoa' : 'pessoas'}
            </span>
          </div>

          {participants.length === 0 ? (
            <div style={{ fontSize: 12.5, color: T.muted, lineHeight: 1.6 }}>
              Ninguém no canal agora. Entrar abre a chamada para quem chegar depois —
              todos os membros pareiam direto entre si (mesh), sem servidor de mídia.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {participants.map((p) => {
                const eu = p.fp === myFp
                const mudo = !!(p.muted || p.deafened)
                return (
                  <div key={p.fp} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 4px', minWidth: 0 }}>
                    <span style={{ display: 'flex', flexShrink: 0, color: mudo ? T.red : T.green }}>
                      <Ic name={p.deafened ? 'volumeX' : p.muted ? 'micOff' : 'mic'} size={13} />
                    </span>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {eu ? 'você' : (p.nickname || p.fp.slice(0, 8))}
                    </span>
                  </div>
                )
              })}
            </div>
          )}

          <button
            type="button"
            onClick={inCall ? onLeave : onJoin}
            aria-label={inCall ? 'Sair da chamada' : 'Entrar na chamada'}
            style={{
              background: inCall ? T.red : T.green, border: 'none', color: '#fff',
              borderRadius: 10, padding: '13px', fontSize: 14, fontWeight: 800, cursor: 'pointer',
            }}
          >
            {inCall ? 'Sair da chamada' : 'Entrar na chamada'}
          </button>

          {inCall && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={onToggleMute}
                aria-label={muted ? 'Ativar microfone' : 'Silenciar microfone'}
                aria-pressed={muted}
                style={{ flex: 1, minHeight: 44, background: muted ? T.red : T.input, border: `1px solid ${T.border}`, color: muted ? '#fff' : T.text, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Ic name={muted ? 'micOff' : 'mic'} size={17} />
              </button>
              <button
                type="button"
                onClick={onToggleDeafen}
                aria-label={deafened ? 'Ativar áudio' : 'Ensurdecer'}
                aria-pressed={deafened}
                style={{ flex: 1, minHeight: 44, background: deafened ? T.red : T.input, border: `1px solid ${T.border}`, color: deafened ? '#fff' : T.text, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Ic name={deafened ? 'volumeX' : 'headphones'} size={17} />
              </button>
              <button
                type="button"
                onClick={onToggleCamera}
                aria-label={cameraOn ? 'Desligar câmera' : 'Ligar câmera (opcional)'}
                aria-pressed={cameraOn}
                style={{ flex: 1, minHeight: 44, background: cameraOn ? T.green : T.input, border: `1px solid ${T.border}`, color: cameraOn ? '#fff' : T.text, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <Ic name="video" size={17} />
              </button>
            </div>
          )}

          {error && (
            <div role="alert" style={{ fontSize: 11.5, color: '#ff9c9c', lineHeight: 1.5 }}>{error}</div>
          )}
        </div>

        <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.6 }}>
          A mídia vai direto entre os membros (P2P). Em redes com NAT fechado o app tenta relay;
          sem nenhum caminho a chamada falha com aviso — nunca fica “conectada” sem áudio.
        </div>
      </div>
    </div>
  )
}
