// CallTile — um QUADRADO da chamada: pessoa (câmera/avatar) ou tela.
//
// ## Por que um componente só para os dois tipos
//
// Antes cada shell (desktop e mobile) desenhava o tile inline e usava o MESMO
// `<video>`/`objectFit` para câmera e para tela. Consequências reais:
//
//  - a tela era esticada/cortada (`object-fit: cover`) porque telas têm
//    proporção diferente da câmera;
//  - quem transmitia não via a própria câmera (o tile local dependia de um
//    stream remoto que nunca chega por loopback);
//  - não existia quadrado separado para a tela, então `sharing` e `cameraOn`
//    brigavam pelo mesmo espaço.
//
// Aqui o tipo do quadrado decide a apresentação:
//  - `participant`: `object-fit: cover` (é uma pessoa, como no Discord);
//  - `screen`: `object-fit: contain` + `aspect-ratio` real da fonte — nada de
//    esticar, cortar ou forçar 16:9.
//
// O `aspect-ratio` vem do próprio vídeo (`videoWidth/videoHeight`) e é
// atualizado quando a resolução muda (`resize`), o que cobre troca de monitor
// e mudança de janela durante o compartilhamento.

import { useCallback, useEffect, useRef, useState } from 'react'
import { attachStream } from '../../shared/mediaAttach'
import { Icon, Icons } from '../../shared/icons'
import { ParticipantAudioControls } from './ParticipantAudioControls'
import { applyParticipantPlayback } from '../../services/callPlayback'
import type { CallTile as CallTileModel } from '../../services/callTiles'

export interface CallTilePalette {
  heading: string
  muted: string
  green: string
  red: string
  accent: string
  border: string
}

export interface CallTileProps {
  tile: CallTileModel
  pinned?: boolean
  expanded?: boolean
  /** Miniatura ao lado de um quadrado expandido: esconde rótulos e reduz controles. */
  thumbnail?: boolean
  onPin?: (id: string) => void
  onExpand?: (id: string) => void
  /** Volume/mute por participante (só desktop, e só para remoto). */
  showAudioControls?: boolean
  callDeafened?: boolean
  palette: CallTilePalette
  /** Altura mínima do quadrado no grid (px). */
  minHeight?: number
  /** `cover` para câmera, `contain` para tela — automático pelo tipo. */
  avatarColor: (fp: string) => string
}

/** `true` se o elemento tem dimensões de vídeo válidas. */
function readAspect(el: HTMLVideoElement | null): string | null {
  try {
    if (!el) return null
    const w = el.videoWidth
    const h = el.videoHeight
    if (!w || !h) return null
    return `${w} / ${h}`
  } catch {
    return null
  }
}

export function CallTile({
  tile,
  pinned = false,
  expanded = false,
  thumbnail = false,
  onPin,
  onExpand,
  showAudioControls = false,
  callDeafened = false,
  palette: c,
  minHeight = 150,
  avatarColor,
}: CallTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [aspect, setAspect] = useState<string | null>(null)
  const isScreen = tile.kind === 'screen'

  // A proporção real da fonte: atualiza no primeiro frame e a cada mudança de
  // resolução (troca de monitor, redimensionar janela compartilhada).
  const syncAspect = useCallback(() => {
    const next = readAspect(videoRef.current)
    if (next) setAspect((cur) => (cur === next ? cur : next))
  }, [])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    syncAspect()
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(syncAspect)
      ro.observe(el)
    } catch { /* engine sem ResizeObserver: fica no loadedmetadata */ }
    el.addEventListener('loadedmetadata', syncAspect)
    el.addEventListener('resize', syncAspect)
    return () => {
      try { ro?.disconnect() } catch { /* ignore */ }
      el.removeEventListener('loadedmetadata', syncAspect)
      el.removeEventListener('resize', syncAspect)
    }
  }, [syncAspect, tile.stream])

  const showVideo = !!tile.stream
  const showImage = !showVideo && !!tile.videoUrl

  return (
    <div
      data-call-tile={tile.id}
      data-call-participant={tile.kind === 'participant' ? tile.fp : undefined}
      data-call-screen-fp={tile.kind === 'screen' ? tile.fp : undefined}
      style={{
        // A TELA tem fundo preto e o quadro é DELIMITADO pela proporção real:
        // `aspectRatio` na caixa faz a borda acompanhar o conteúdo, então não
        // sobram faixas mortas em volta e a escala é sempre a mesma do stream.
        // Pessoa continua no gradiente (é avatar/câmera, não conteúdo de tela).
        background: isScreen ? '#000' : `radial-gradient(120% 90% at 50% 20%, #31343a 0%, #22242a 70%)`,
        borderRadius: 12,
        overflow: 'hidden',
        position: 'relative',
        minHeight: expanded ? 0 : thumbnail ? 72 : minHeight,
        // Quadrado normal da tela: a borda acompanha a proporção REAL, então a
        // escala do conteúdo é a mesma e não sobra faixa morta. `alignSelf:start`
        // é necessário porque o grid estica os itens (stretch) e a altura
        // imposta pelo stretch anularia o `aspect-ratio`.
        //
        // EXPANDIDO: a caixa também abraça a proporção e é CENTRALIZADA na área
        // útil (`maxHeight: 100%`): o conteúdo cresce até o limite do painel sem
        // virar barras pretas nem esticar. É a "maior área útil preservando a
        // proporção" — a escala do que foi compartilhado não muda.
        ...(isScreen && aspect
          ? expanded
            ? {
                aspectRatio: aspect,
                width: '100%',
                height: 'auto',
                maxHeight: '100%',
                minHeight: 0,
                alignSelf: 'center',
                justifySelf: 'center',
              }
            : thumbnail
              ? null
              : { aspectRatio: aspect, minHeight: 0, alignSelf: 'start', width: '100%' }
          : null),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `2px solid ${
          tile.speaking && !isScreen ? c.green : tile.muted ? `${c.red}55` : isScreen ? `${c.accent}66` : 'transparent'
        }`,
        boxShadow: '0 2px 10px rgba(0,0,0,.35)',
      }}
    >
      {/* A TELA ocupa o quadrado SEM esticar em NENHUM modo:
          - normal: a caixa já tem a proporção do stream (`aspect-ratio` no
            artigo de cima), então `100%` preenche sem faixa morta;
          - expandido: a caixa é maior que o conteúdo e o `contain` mantém a
            proporção original (letterbox), que é o correto para "maior área útil";
          - miniatura: idem, sem cortar conteúdo importante. */}
      <div
        style={
          isScreen
            ? { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }
            : { width: '100%', height: '100%' }
        }
      >
        {showVideo ? (
          <video
            autoPlay
            playsInline
            // O vídeo é SEMPRE mudo: o som sai do <audio> do participante.
            // Sem isso a voz/tela do peer tocava duas vezes (eco/comb-filter).
            muted
            ref={(el) => {
              videoRef.current = el
              attachStream(el, tile.stream)
            }}
            style={
              isScreen
                ? {
                    // TELA: `max-*` + `auto` mantém a proporção INTRÍNSECA do
                    // stream em qualquer caixa. Com `width/height: 100%` o
                    // navegador esticava o quadro quando a caixa não era 16:9
                    // (medido: 1059x872 com conteúdo 1920x1080 = deformado).
                    maxWidth: '100%',
                    maxHeight: '100%',
                    width: 'auto',
                    height: 'auto',
                    objectFit: 'contain',
                    background: '#000',
                    display: 'block',
                  }
                : {
                    width: '100%',
                    height: '100%',
                    // cover = pessoa; a tela usa o ramo acima (contain).
                    objectFit: 'cover',
                    background: '#000',
                    display: 'block',
                  }
            }
          />
        ) : showImage ? (
          /* Caminho NATIVO (Linux): o core decodifica o RTP e entrega JPEG.
             Não existe MediaStream na página — um <img> é o honesto. */
          <img
            src={tile.videoUrl}
            alt={tile.label}
            style={
              isScreen
                ? { width: '100%', height: '100%', objectFit: 'contain', background: '#000' }
                : { width: '100%', height: '100%', objectFit: 'cover', background: '#000' }
            }
          />
        ) : (
          <div style={{ textAlign: 'center', padding: 8 }}>
            <div
              style={{
                width: isScreen ? 64 : 104,
                height: isScreen ? 64 : 104,
                borderRadius: isScreen ? 16 : '50%',
                background: isScreen ? `${c.accent}33` : avatarColor(tile.fp),
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fff',
                fontWeight: 800,
                fontSize: isScreen ? 26 : 40,
                boxShadow: '0 6px 24px rgba(0,0,0,.4)',
              }}
            >
              {isScreen ? <Icon d={Icons.screen} size={28} /> : (tile.nickname || tile.fp).charAt(0).toUpperCase()}
            </div>
            <div style={{ fontWeight: 700, color: c.heading, marginTop: 12, fontSize: 15 }}>{tile.label}</div>
            <div style={{ fontSize: 11, color: c.muted, marginTop: 2 }}>
              {isScreen
                ? 'aguardando o primeiro quadro…'
                : tile.localPreviewUnavailable
                  ? 'câmera ativa no motor nativo — prévia indisponível nesta tela'
                  : tile.isLocal
                    ? 'sua câmera está desligada'
                    : 'aguardando o vídeo…'}
            </div>
          </div>
        )}
      </div>

      {/* Selo de origem: identifica QUEM compartilha (item de produto) e não
          deixa confundir tela com câmera. */}
      {isScreen ? (
        <span
          title={`Tela compartilhada por ${tile.nickname}`}
          style={{
            position: 'absolute', top: 8, left: 8, background: c.green, color: '#fff',
            fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
          }}
        >
          {tile.isLocal ? 'SUA TELA' : `TELA • ${tile.nickname}`}
        </span>
      ) : (
        tile.cameraOn && (
          <span
            title="Câmera ativa"
            style={{
              position: 'absolute', top: 8, left: 8, background: '#5865f2', color: '#fff',
              fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4,
            }}
          >
            CÂMERA
          </span>
        )
      )}

      {!isScreen && !tile.cameraOn && (
        <span
          title="Câmera desligada"
          aria-label="Câmera desligada"
          style={{ position: 'absolute', top: 8, left: 8, background: '#111a', color: '#fff', fontSize: 10, padding: '3px 6px', borderRadius: 4 }}
        >
          ▣̸
        </span>
      )}

      {tile.disconnected && (
        <span style={{ position: 'absolute', top: 8, right: 8, background: '#faa61a', color: '#fff', fontSize: 10, fontWeight: 800, padding: '2px 6px', borderRadius: 4 }}>
          RECONECTANDO…
        </span>
      )}

      {/* Controles de fixar/expandir: existem para PESSOA e para TELA. Antes o
          botão só existia no tile do participante e a tela não podia ser
          fixada nem expandida. */}
      <div style={{ position: 'absolute', right: 8, top: 38, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {onPin && (
          <button
            type="button"
            aria-label={pinned ? `Desafixar ${tile.label}` : `Fixar ${tile.label}`}
            title={pinned ? 'Desafixar' : 'Fixar'}
            onClick={() => onPin(tile.id)}
            style={{
              border: '1px solid #ffffff44', borderRadius: 6,
              background: pinned ? c.accent : '#111c',
              color: '#fff', cursor: 'pointer',
              width: 26, height: 26, padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={Icons.pin} size={13} />
          </button>
        )}
        {onExpand && (
          <button
            type="button"
            aria-label={
              expanded
                ? (isScreen ? 'Recolher tela cheia' : 'Recolher participante')
                : (isScreen ? 'Ver tela compartilhada em tela cheia' : pinned ? 'Ampliar participante fixado' : `Ampliar ${tile.label}`)
            }
            title={expanded ? 'Recolher (Esc)' : 'Tela cheia'}
            onClick={() => onExpand(tile.id)}
            style={{
              border: '1px solid #ffffff44', borderRadius: 6,
              background: expanded ? c.accent : '#111c',
              color: '#fff', cursor: 'pointer',
              // Ícone SVG precisa de caixa própria: `padding` de glifo de texto
              // deixava o botão desalinhado dos vizinhos.
              width: 26, height: 26, padding: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={expanded ? Icons.collapse : Icons.expand} size={13} />
          </button>
        )}
      </div>

      {showAudioControls && !tile.isLocal && (
        <ParticipantAudioControls fp={tile.fp} nickname={tile.nickname} callDeafened={callDeafened} />
      )}

      {/* Áudio remoto SEMPRE presente (inclusive sem vídeo): antes ele vivia
          dentro do ramo do vídeo e a chamada de voz ficava muda. */}
      {!tile.isLocal && tile.stream && (
        <audio
          autoPlay
          playsInline
          hidden
          data-call-audio-fp={tile.fp}
          ref={(el: HTMLAudioElement | null) => {
            attachStream(el, tile.stream)
            if (el) applyParticipantPlayback(el, tile.fp, callDeafened)
          }}
        />
      )}

      {!isScreen && !thumbnail && (
        <div style={{ position: 'absolute', bottom: 8, left: 8, right: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.7)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tile.label} {tile.isLocal ? '(você)' : ''}{' '}
            <Icon d={tile.muted ? Icons.micOff : Icons.mic} size={12} />
          </span>
          {tile.speaking && <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.green, boxShadow: `0 0 6px ${c.green}` }} />}
        </div>
      )}
    </div>
  )
}

export default CallTile
