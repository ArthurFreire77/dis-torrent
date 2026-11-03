// VoiceStage — a TELA ÚNICA de chamada (canal de voz/vídeo, DM e grupo).
//
// ## Por que existe
//
// Relato do dono (com print): "a interface tá uma merda na tela de servidores,
// unifica; faz um padrão que pega a tela do lado direito mais completa, tudo
// completo unificado". Antes existiam TRÊS desenhos para a mesma chamada:
//
//   1. `CallChannelStage` — cartão de 520 px no centro, fora da chamada;
//   2. palco de quadrados no centro + painel lateral fixo de 300 px (com
//      cabeçalho próprio, diagnóstico, qualidade, botões) — dentro da chamada
//      de canal;
//   3. painel lateral de até 56vw com OUTRO cabeçalho — chamada de DM/grupo.
//
// A mesma chamada mudava de forma ao entrar/sair, os controles pulavam de
// lugar e a mídia aparecia em dois tamanhos diferentes. Aqui há UM componente:
// palco (mídia) + coluna de controles, sempre com o mesmo cabeçalho e os
// mesmos botões. A regra de layout é pura (`services/voiceLayout.ts`).
//
// IMPORTANTE: os `<audio>` remotos vivem nos `CallTile` (via `CallTilesGrid`).
// Este componente NUNCA deve ser renderizado sem eles quando já há chamada —
// uma tela de chamada sem os tiles conecta, conta o tempo e fica muda.

import type { ReactNode } from 'react'
import { Icon, Icons } from '../../shared/icons'
import CallPhaseBadge from '../CallPhaseBadge'
import type { CallPhase } from '../../services/callPhases'
import { participantsLabel, type VoiceLayout } from '../../services/voiceLayout'

export interface VoiceStagePalette {
  /** Fundo do palco (área da mídia). */
  stage: string
  /** Fundo da coluna de controles. */
  panel: string
  /** Fundo de campos/botões secundários. */
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
  /** Estou eu nesta linha. */
  eu?: boolean
}

export interface VoiceStageProps {
  layout: VoiceLayout
  palette: VoiceStagePalette
  /** Nome do canal/conversa (título do cabeçalho). */
  title: string
  /** "3 pessoas na chamada", "Canal de voz", "conectando…". */
  subtitle?: string
  /** Ícone do tipo: canal de vídeo, de voz ou chamada direta. */
  kind: 'voice' | 'video'
  /** Dentro da chamada agora. */
  inCall: boolean
  /** Fase real (conectando, conectado, reconectando…). */
  phase: CallPhase
  startAt: number
  nowMs: number
  mediaLive: boolean
  ringing?: boolean
  /** Rota ICE resumida (LAN/STUN/TURN/sem rota). */
  route?: string
  /** Quadrados da chamada — obrigatórios dentro da chamada. */
  media?: ReactNode
  /** Quem está na chamada (lista lateral enquanto NÃO entrou). */
  peers?: VoiceStagePeer[]
  /** Motivo honesto de não poder entrar (null = pode). */
  unavailable?: string | null
  /** Outra chamada em andamento (não dá para entrar nesta). */
  busy?: boolean
  /** Aviso transitório (erro/qualidade) acima dos controles. */
  notice?: string | null
  /** Conteúdo extra no topo da coluna de controles (diagnóstico etc.). */
  extra?: ReactNode
  muted: boolean
  deafened: boolean
  cameraOn: boolean
  sharing: boolean
  /** Câmera indisponível enquanto a tela está no ar (mesma m-line). */
  cameraDisabled?: boolean
  onJoin: () => void
  onLeave: () => void
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
  onToggleScreen?: () => void
  screenAvailable?: boolean
  screenUnavailableReason?: string | null
  onOpenSettings?: () => void
  /** Painel de ajustes (já renderizado pelo shell) — aparece dentro da coluna. */
  settings?: ReactNode
  /** `true` no celular: controles viram barra inferior e o palco sobe. */
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

/** Botão redondo dos controles (o mesmo desenho em PC e celular). */
function ControlButton({
  label,
  icon,
  on,
  danger,
  disabled,
  onClick,
  size = 44,
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
        // Vermelho só quando é estado RUIM (mudo, surdo, sair). Ligado = verde.
        background: danger ? '#f23f42' : ativo ? '#23a559' : 'rgba(255,255,255,.12)',
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {children ?? (icon ? <Icon d={icon} size={Math.round(size * 0.42)} /> : null)}
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
  onOpenSettings,
  settings,
  compact = false,
}: VoiceStageProps) {
  const entrarBloqueado = !inCall && (busy || !!unavailable)
  const duracao = inCall ? fmtDuracao(Math.max(0, nowMs - startAt)) : ''

  const listaPeers = peers.length > 0 && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      {peers.map((p) => {
        const mudo = !!(p.muted || p.deafened)
        return (
          <span
            key={p.fp}
            title={p.deafened ? `${p.nome} — surdo` : p.muted ? `${p.nome} — microfone mudo` : p.nome}
            style={{
              display: 'flex', alignItems: 'center', gap: 7, minWidth: 0,
              fontSize: 12.5, fontWeight: 600, lineHeight: 1.5,
              color: mudo ? c.muted : c.text,
            }}
          >
            <span style={{ display: 'flex', flexShrink: 0, color: mudo ? c.red : c.green }}>
              <Icon d={p.deafened ? Icons.volumeX : p.muted ? Icons.micOff : Icons.mic} size={12} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {p.eu ? 'você' : p.nome}
            </span>
          </span>
        )
      })}
    </div>
  )

  // ── Controles ───────��────────────────────────────────────────────────────
  // Sempre os MESMOS botões, na MESMA ordem, nos dois estados: entrar (verde)
  // ou sair (vermelho) no fim. Antes o "Sair" morava em três lugares distintos.
  const controles = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        flexWrap: 'wrap',
        padding: compact ? '10px 8px' : 12,
        paddingBottom: compact ? 'calc(10px + env(safe-area-inset-bottom))' : 12,
        background: c.panel,
        borderTop: `1px solid ${c.border}`,
        flexShrink: 0,
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
            disabled={cameraDisabled}
            onClick={onToggleCamera}
          />
          {onToggleScreen && (
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
          {onOpenSettings && (
            <ControlButton
              label="Configurações da chamada (mic, câmera, resolução, FPS)"
              icon={Icons.gear}
              onClick={onOpenSettings}
            />
          )}
          <button
            type="button"
            onClick={onLeave}
            aria-label="Sair da chamada"
            title="Sair da chamada"
            style={{
              height: 44,
              minWidth: compact ? 96 : 104,
              padding: '0 18px',
              borderRadius: 22,
              border: 'none',
              background: c.red,
              color: '#fff',
              cursor: 'pointer',
              fontSize: 13.5,
              fontWeight: 800,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              flexShrink: 0,
            }}
          >
            <Icon d={Icons.phone} size={16} rotate={135} /> Sair
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={onJoin}
          disabled={entrarBloqueado}
          title={unavailable ?? undefined}
          aria-label={unavailable ? 'Chamada indisponível' : 'Entrar na chamada'}
          style={{
            height: 48,
            minWidth: 220,
            padding: '0 26px',
            borderRadius: 24,
            border: 'none',
            background: unavailable ? c.border : c.green,
            color: '#fff',
            cursor: entrarBloqueado ? 'not-allowed' : 'pointer',
            opacity: entrarBloqueado ? 0.7 : 1,
            fontSize: 14.5,
            fontWeight: 800,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 9,
          }}
        >
          <Icon d={kind === 'video' ? Icons.video : Icons.phone} size={18} />
          {unavailable ? 'Chamada indisponível' : busy ? 'Já existe uma chamada' : 'Entrar na chamada'}
        </button>
      )}
    </div>
  )

  // ── Cabeçalho (um só desenho nos dois estados) ───────────────────────────
  const cabecalho = (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        padding: compact ? '8px 12px' : '10px 16px',
        paddingTop: compact ? 'calc(8px + env(safe-area-inset-top))' : 10,
        background: c.panel,
        borderBottom: `1px solid ${c.border}`,
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 34, height: 34, borderRadius: 10, flexShrink: 0,
          background: `${c.accent}22`, color: c.accent,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Icon d={kind === 'video' ? Icons.video : Icons.phone} size={17} />
      </span>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{
          display: 'block', fontSize: compact ? 14.5 : 15, fontWeight: 800, color: c.heading,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{title}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, flexWrap: 'wrap' }}>
          {inCall ? (
            <>
              <CallPhaseBadge
                phase={phase}
                startAt={startAt}
                nowMs={nowMs}
                mediaLive={mediaLive}
                ringing={ringing}
              />
              <span style={{ fontSize: 11, color: c.muted, fontFamily: 'JetBrains Mono', fontWeight: 600 }}>
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
                fontSize: 10, fontWeight: 800, letterSpacing: 0.4,
                background: `${c.green}22`, color: c.green,
                padding: '2px 8px', borderRadius: 99,
              }}
            >rota {route}</span>
          )}
        </span>
      </span>
      {inCall && (
        <span style={{ fontSize: 11.5, color: c.muted, whiteSpace: 'nowrap' }}>
          {participantsLabel(peers.length)}
        </span>
      )}
    </div>
  )

  // ── Palco ────────────────────────────────────────────────────────────────
  const palco = inCall && layout.stageFill ? (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: c.stage }}>
      {media}
    </div>
  ) : null

  // ── Lobby (fora da chamada) ───────────────────────────────────────────────
  const lobby = !inCall && (
    <div
      style={{
        flex: 1, minHeight: 0, overflowY: 'auto', background: c.stage,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: compact ? 16 : 24,
      }}
    >
      <div style={{ width: '100%', maxWidth: compact ? 460 : 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, textAlign: 'center' }}>
          <span style={{
            width: 72, height: 72, borderRadius: 22,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: `${c.accent}22`, color: c.accent,
          }}>
            <Icon d={kind === 'video' ? Icons.video : Icons.speaker} size={32} />
          </span>
          <div style={{ fontSize: 19, fontWeight: 900, color: c.heading }}>{title}</div>
          <div style={{ fontSize: 12.5, color: c.muted, lineHeight: 1.6, maxWidth: 420 }}>
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
            <span style={{ flex: 1, fontSize: 12.5, fontWeight: 800, color: c.text }}>
              {participantsLabel(peers.length)}
            </span>
          </div>
          {peers.length === 0 ? (
            <div style={{ fontSize: 12, color: c.muted, lineHeight: 1.6 }}>
              Ninguém no canal agora. Entrar abre a chamada para quem chegar depois —
              todos os membros pareiam direto entre si (mesh), sem servidor de mídia.
            </div>
          ) : listaPeers}
          {peers.length > 0 && (
            <div style={{ fontSize: 11.5, color: c.muted, lineHeight: 1.5 }}>
              Todos pareiam direto entre si (mesh). Sem rota direta, o app tenta relay;
              se nada funcionar a chamada avisa em vez de ficar “conectada” sem áudio.
            </div>
          )}
          {notice && (
            <div role="status" style={{ fontSize: 11.5, color: c.yellow ?? '#ffe0a3', lineHeight: 1.5 }}>
              {notice}
            </div>
          )}
          {!inCall && unavailable && (
            <div role="alert" style={{ fontSize: 11.5, color: '#ff9c9c', lineHeight: 1.5 }}>
              {unavailable}
            </div>
          )}
        </div>
      </div>
    </div>
  )

  // ── Coluna de controles (só no PC, dentro da chamada) ─────────────────────
  const colunaControles = !compact && inCall && (
    <div
      style={{
        width: layout.controlsWidthPx,
        maxWidth: '46vw',
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: c.panel,
        borderLeft: `1px solid ${c.border}`,
        // Âncora dos painéis absolutos (ajustes/diagnóstico): sem isto eles se
        // posicionavam pela janela e cobriam o palco.
        position: 'relative',
      }}
    >
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {notice && (
          <div role="status" style={{
            fontSize: 11.5, lineHeight: 1.5, color: '#ffe0a3',
            background: `${c.yellow ?? '#f0b232'}18`,
            border: `1px solid ${(c.yellow ?? '#f0b232')}55`,
            borderRadius: 8, padding: '8px 10px',
          }}>{notice}</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 10.5, fontWeight: 900, letterSpacing: 0.8, color: c.accent }}>
            NA CHAMADA
          </span>
          {listaPeers}
        </div>
        {extra}
        {settings}
      </div>
      {/* Os controles ficam SEMPRE na mesma posição (rodapé da coluna), em
          qualquer entrada — é o "unificado" do pedido. */}
      {controles}
    </div>
  )

  return (
    <div
      data-testid="voice-stage"
      data-voice-mode={layout.mode}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        background: c.stage,
        color: c.text,
        overflow: 'hidden',
      }}
    >
      {layout.showChannelHeader && cabecalho}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: compact ? 'column' : 'row' }}>
        {compact ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {palco}
            {lobby}
          </div>
        ) : (
          <>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {palco}
              {lobby}
            </div>
            {colunaControles}
          </>
        )}
      </div>
      {compact && controles}
      {!compact && !inCall && controles}
    </div>
  )
}

export default VoiceStage
