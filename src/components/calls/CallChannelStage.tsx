// Tela de um canal de VOZ/VÍDEO no desktop.
//
// POR QUE EXISTE: selecionar um canal de voz/vídeo caía na tela de mensagens —
// lista de mensagens e COMPOSITOR de texto de um canal onde ninguém digita. O
// canal é uma chamada: quem abre tem de ver quem está lá e o botão de entrar,
// não um campo de texto morto.

import { Ic } from '../../shared/icons'
import type { ChannelMeta } from '../../services/models'
import { useChannelVoicePeers } from './ChannelVoicePeers'

export interface CallChannelStageProps {
  communityId: string
  channel: ChannelMeta
  myFp: string
  /** Estou NESTE canal (chamada ativa nele). */
  inCall: boolean
  /** Chamada em andamento (em qualquer canal): não dá para entrar em outra. */
  busy: boolean
  /** Motivo de a chamada não estar disponível (null = disponível). */
  unavailable: string | null
  nameOf: (fp: string) => string
  onJoin: () => void
  onLeave: () => void
  palette: {
    panel: string
    input: string
    border: string
    heading: string
    text: string
    muted: string
    green: string
    red: string
    accent: string
  }
}

export default function CallChannelStage({
  communityId,
  channel,
  myFp,
  inCall,
  busy,
  unavailable,
  nameOf,
  onJoin,
  onLeave,
  palette: c,
}: CallChannelStageProps) {
  const peers = useChannelVoicePeers(communityId, channel.id, true)
  const isVideo = channel.kind === 'video'
  const outros = peers.filter((p) => p.fp !== myFp)

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: c.panel,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
          textAlign: 'center',
        }}
      >
        <span
          style={{
            width: 68,
            height: 68,
            borderRadius: 22,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${c.accent}22`,
            color: c.accent,
          }}
        >
          <Ic name={isVideo ? 'video' : 'speaker'} size={30} />
        </span>

        <div style={{ fontSize: 19, fontWeight: 900, color: c.heading }}>{channel.name}</div>
        <div style={{ fontSize: 12.5, color: c.muted, lineHeight: 1.6 }}>
          {isVideo
            ? 'Canal de vídeo: é uma chamada como a de voz. A câmera é opcional e liga no botão da chamada.'
            : 'Canal de voz: entre para falar com quem já está aqui.'}
        </div>

        <div
          style={{
            width: '100%',
            background: c.input,
            border: `1px solid ${inCall ? `${c.green}66` : c.border}`,
            borderRadius: 12,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: inCall ? c.green : peers.length > 0 ? c.green : c.muted,
                flexShrink: 0,
              }}
            />
            <span style={{ flex: 1, textAlign: 'left', fontSize: 12, fontWeight: 800, color: inCall ? c.green : c.text }}>
              {inCall
                ? 'Você está nesta chamada'
                : outros.length === 0
                  ? 'Ninguém na chamada agora'
                  : `${outros.length} ${outros.length === 1 ? 'pessoa' : 'pessoas'} na chamada`}
            </span>
            <span style={{ fontSize: 11, color: c.muted }}>
              {peers.length} {peers.length === 1 ? 'na sala' : 'na sala'}
            </span>
          </div>

          {peers.length === 0 ? (
            <div style={{ fontSize: 12, color: c.muted, lineHeight: 1.6, textAlign: 'left' }}>
              Entrar abre a chamada para quem chegar depois. Todos os membros conectam
              direto entre si (mesh), sem servidor de mídia.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, justifyContent: 'flex-start' }}>
              {peers.map((p) => {
                const eu = p.fp === myFp
                const mudo = p.muted || p.deafened
                return (
                  <span
                    key={p.fp}
                    title={p.deafened ? 'surdo' : p.muted ? 'microfone mudo' : 'microfone aberto'}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 11,
                      fontWeight: 700,
                      color: mudo ? c.muted : c.text,
                      background: c.panel,
                      border: `1px solid ${c.border}`,
                      borderRadius: 99,
                      padding: '3px 9px',
                    }}
                  >
                    <span style={{ display: 'flex', color: mudo ? c.red : c.green }}>
                      <Ic name={p.deafened ? 'volumeX' : p.muted ? 'micOff' : 'mic'} size={10} />
                    </span>
                    {eu ? 'você' : (nameOf(p.fp) || p.fp.slice(0, 8))}
                  </span>
                )
              })}
            </div>
          )}

          <button
            type="button"
            onClick={inCall ? onLeave : onJoin}
            disabled={!inCall && (busy || !!unavailable)}
            title={!inCall && unavailable ? unavailable : undefined}
            style={{
              marginTop: 2,
              background: inCall ? c.red : unavailable ? c.border : c.green,
              color: '#fff',
              border: 'none',
              borderRadius: 10,
              padding: '12px',
              fontSize: 13.5,
              fontWeight: 800,
              cursor: !inCall && (busy || unavailable) ? 'not-allowed' : 'pointer',
              opacity: !inCall && (busy || unavailable) ? 0.65 : 1,
            }}
          >
            {inCall ? 'Sair da chamada' : unavailable ? 'Chamada indisponível' : busy ? 'Já existe uma chamada' : 'Entrar na chamada'}
          </button>

          {!inCall && unavailable && (
            <div style={{ fontSize: 11, color: '#ffe0a3', lineHeight: 1.5, textAlign: 'left' }}>
              {unavailable}
            </div>
          )}
        </div>

        <div style={{ fontSize: 11, color: c.muted, lineHeight: 1.6, maxWidth: 460 }}>
          Canal de chamada não tem mensagens: quem quiser texto usa um canal de texto.
          A mídia vai direto entre os membros (P2P).
        </div>
      </div>
    </div>
  )
}
