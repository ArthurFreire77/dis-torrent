// ScreenStage — TELA CHEIA de uma transmissão (tela ou câmera).
//
// ## Por que existe
//
// "Expandir" só aumentava o quadrado DENTRO do painel de chamada (no desktop o
// painel ocupa no máximo `min(56vw, 720px)`, então a tela compartilhada nunca
// passava disso). Para ler texto numa tela compartilhada isso não é tela cheia.
//
// Aqui a transmissão escolhida cobre a JANELA inteira (`position: fixed`), com:
//   - `object-fit: contain` da fonte: ocupa o máximo possível sem
//     esticar nem cortar (letterbox é o correto em tela cheia);
//   - barra de controles que some sozinha e volta no mouse/teclado (não cobre
//     conteúdo importante nem atrapalha a leitura);
//   - os controles essenciais da chamada (mic, câmera, sair) continuam
//     acessíveis, porque a reunião NÃO sai do ar;
//   - `Esc` recolhe; botão explícito de recolher sempre visível no hover.
//
// IMPORTANTE: o painel da chamada continua MONTADO atrás desta camada. Trocar
// o painel pela tela cheia desmontaria os `<audio>` remotos e a chamada ficaria
// muda — por isso é um overlay, não uma substituição.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, Icons } from '../../shared/icons'
import { attachStream } from '../../shared/mediaAttach'
import type { CallTile as CallTileModel } from '../../services/callTiles'

export interface ScreenStagePalette {
  heading: string
  muted: string
  green: string
  red: string
  accent: string
  border: string
}

export interface ScreenStageProps {
  tile: CallTileModel
  palette: ScreenStagePalette
  onCollapse: () => void
  /** Ações essenciais: continuam funcionando com a tela cheia aberta. */
  muted?: boolean
  onToggleMute?: () => void
  cameraOn?: boolean
  onToggleCamera?: () => void
  onLeave?: () => void
  /** Nome da chamada, para contexto no cabeçalho. */
  callTitle?: string
}

/** Quanto tempo a barra fica visível depois da última interação. */
const CHROME_HIDE_MS = 2600

export function ScreenStage({
  tile,
  palette: c,
  onCollapse,
  muted = false,
  onToggleMute,
  cameraOn = false,
  onToggleCamera,
  onLeave,
  callTitle,
}: ScreenStageProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [chromeVisible, setChromeVisible] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Barra que some: só esconde quando o ponteiro SAIR da área, para não
  // desaparecer enquanto a pessoa procura o botão de recolher.
  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setChromeVisible(false), CHROME_HIDE_MS)
  }, [])
  const showChrome = useCallback(() => {
    setChromeVisible(true)
    scheduleHide()
  }, [scheduleHide])

  useEffect(() => {
    scheduleHide()
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current) }
  }, [scheduleHide])

  // Esc recolhe. Também sai da tela cheia do SO, se foi pedida (F11/duplo clique).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        try {
          if (document.fullscreenElement) void document.exitFullscreen?.()
        } catch { /* ignore */ }
        onCollapse()
        return
      }
      showChrome()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCollapse, showChrome])

  const showVideo = !!tile.stream
  const showImage = !showVideo && !!tile.videoUrl

  return (
    <div
      data-testid="call-screen-stage"
      data-call-stage-id={tile.id}
      role="dialog"
      aria-modal="true"
      aria-label={`Tela cheia: ${tile.label}`}
      onMouseMove={showChrome}
      onMouseEnter={showChrome}
      style={{
        position: 'fixed',
        // cobre a JANELA inteira, acima do painel (88) e dos modais (90-92),
        // abaixo dos menus/popovers da chamada (199+).
        inset: 0,
        zIndex: 150,
        background: '#000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: chromeVisible ? 'default' : 'none',
      }}
    >
      {/* Conteúdo: ocupa TODA a área e é o `object-fit: contain` que faz o
          letterbox — preserva a proporção sem esticar nem cortar.

          BUG REAL (a tela compartilhada aparecia pequena no meio de um mar de
          preto): o `<video>` estava com `width:auto/height:auto` e apenas
          `max-width/max-height:100%`. Com isso ele ficava no tamanho NATIVO do
          stream (um share 1280×720 desenhava 1280px e parava — não crescia até
          preencher a janela). O `aspectRatio` no wrapper também brigava com
          `width/height: 100%`: com as duas dimensões fixas o `aspect-ratio` é
          ignorado e o container não limitava nada.

          Agora o wrapper é só 100%/100% e o vídeo/imagem ocupam tudo com
          `object-fit: contain` — o dimensionamento é uma alavanca só, que é a
          regra do projeto (nada de aspect-ratio + max-width ao mesmo tempo). */}
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        {showVideo ? (
          <video
            autoPlay
            playsInline
            muted
            ref={(el) => {
              videoRef.current = el
              attachStream(el, tile.stream)
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              background: '#000',
              display: 'block',
            }}
          />
        ) : showImage ? (
          <img
            src={tile.videoUrl}
            alt={tile.label}
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
        ) : (
          <div style={{ textAlign: 'center', color: c.heading }}>
            <Icon d={Icons.screen} size={56} />
            <div style={{ marginTop: 14, fontSize: 15, fontWeight: 700 }}>{tile.label}</div>
            <div style={{ marginTop: 4, fontSize: 12, color: c.muted }}>aguardando o primeiro quadro…</div>
          </div>
        )}
      </div>

      {/* Áudio do participante continua saindo pelo <audio> do painel, que
          segue montado atrás. Nada de segundo <audio> aqui (voz duplicada). */}

      {/* Barra de controles: por cima do conteúdo, mas discreta e auto-oculta. */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          paddingTop: 'max(10px, env(safe-area-inset-top))',
          background: 'linear-gradient(180deg, rgba(0,0,0,.82) 0%, rgba(0,0,0,0) 100%)',
          opacity: chromeVisible ? 1 : 0,
          pointerEvents: chromeVisible ? 'auto' : 'none',
          transition: 'opacity 180ms ease',
        }}
      >
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0,
            color: '#fff', fontSize: 13, fontWeight: 700,
          }}
        >
          <span style={{ display: 'flex', color: c.green }}><Icon d={Icons.screen} size={16} /></span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tile.label}{callTitle ? ` • ${callTitle}` : ''}
          </span>
        </span>

        <span style={{ flex: 1 }} />

        {onToggleMute && (
          <button
            type="button"
            onClick={onToggleMute}
            title={muted ? 'Ativar microfone' : 'Silenciar'}
            aria-label={muted ? 'Ativar microfone' : 'Silenciar'}
            style={{
              width: 38, height: 38, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: muted ? c.red : 'rgba(255,255,255,.14)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={muted ? Icons.micOff : Icons.mic} size={16} />
          </button>
        )}
        {onToggleCamera && (
          <button
            type="button"
            onClick={onToggleCamera}
            title={cameraOn ? 'Desligar câmera' : 'Ligar câmera'}
            aria-label={cameraOn ? 'Desligar câmera' : 'Ligar câmera'}
            style={{
              width: 38, height: 38, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: cameraOn ? c.green : 'rgba(255,255,255,.14)', color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={Icons.video} size={16} />
          </button>
        )}
        {onLeave && (
          <button
            type="button"
            onClick={onLeave}
            title="Sair da chamada"
            aria-label="Sair da chamada"
            style={{
              width: 38, height: 38, borderRadius: '50%', border: 'none', cursor: 'pointer',
              background: c.red, color: '#fff',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            <Icon d={Icons.phone} size={16} rotate={135} />
          </button>
        )}

        {/* Recolher: botão explícito e sempre no mesmo lugar. */}
        <button
          type="button"
          onClick={onCollapse}
          title="Recolher (Esc)"
          aria-label="Recolher tela compartilhada"
          style={{
            height: 38, padding: '0 14px', borderRadius: 8, border: '1px solid rgba(255,255,255,.28)',
            background: 'rgba(255,255,255,.14)', color: '#fff', cursor: 'pointer',
            display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 700,
          }}
        >
          <Icon d={Icons.collapse} size={15} /> Recolher
        </button>
      </div>

      {/* Dica de atalho, só enquanto a barra está visível. */}
      <div
        style={{
          position: 'absolute',
          bottom: 14,
          left: '50%',
          transform: 'translateX(-50%)',
          fontSize: 11,
          color: 'rgba(255,255,255,.62)',
          background: 'rgba(0,0,0,.55)',
          padding: '4px 10px',
          borderRadius: 99,
          opacity: chromeVisible ? 1 : 0,
          transition: 'opacity 180ms ease',
          pointerEvents: 'none',
        }}
      >
        Esc recolhe • a chamada continua
      </div>
    </div>
  )
}

export default ScreenStage
