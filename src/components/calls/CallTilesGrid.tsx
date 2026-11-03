// Grade de quadrados da chamada — usada no painel lateral E na tela do canal.
//
// POR QUE EXISTE: os mesmos `CallTile` (e é neles que ficam o `<audio>` da voz
// e o `<video>` da câmera/tela) precisam aparecer em dois lugares. Duplicar o
// JSX fazia a tela do canal esquecer os tiles — chamada conectada e muda.

import CallTileComponent from './CallTile'
import { useCallback, useEffect, useRef, useState } from 'react'
import { colunasQueCabem } from '../../services/callGrid'
import type { CallTile } from '../../services/callTiles'

export interface CallTilesGridProps {
  tiles: CallTile[]
  pinnedId: string | null
  onPin: (id: string) => void
  onExpand: (id: string) => void
  deafened: boolean
  compact?: boolean
  /** Controles de volume por participante (só desktop). */
  showAudioControls?: boolean
  minHeight?: number
  palette: { heading: string; muted: string; green: string; red: string; accent: string; border: string }
  avatarColor: (fp: string) => string
  avatarB64?: Record<string, string | undefined>
  onOpenProfile?: (fp: string) => void
  /** Fundo fora dos tiles (o painel lateral usa um tom mais escuro). */
  background?: string
  padding?: number
  /** Altura máxima de cada quadrado — sem teto o card esticava a tela toda. */
  maxTileHeight?: number
  /**
   * Modo palco (canal de voz): a grade PREENCHE a área toda em vez de
   * soltar quadrados com teto no topo do espaço central.
   */
  fill?: boolean
}

export default function CallTilesGrid({
  tiles,
  pinnedId,
  onPin,
  onExpand,
  deafened,
  compact = false,
  showAudioControls = false,
  minHeight,
  palette,
  avatarColor,
  avatarB64,
  onOpenProfile,
  background = '#1a1a1a',
  padding = 12,
  /** Altura máxima de cada quadrado — sem teto o card esticava a tela toda. */
  maxTileHeight = 420,
  fill = false,
}: CallTilesGridProps) {
  const altura = minHeight ?? (compact ? 112 : 150)
  // LARGURA REAL da área do palco: decide quantas colunas cabem sem esmagar os
  // cards. Sem medir, `ceil(sqrt(n))` ignorava a janela (ver `callGrid.ts`).
  const areaRef = useRef<HTMLDivElement | null>(null)
  const [largura, setLargura] = useState(0)
  const medir = useCallback(() => {
    const el = areaRef.current
    if (!el) return
    const w = el.clientWidth
    setLargura((cur) => (Math.abs(cur - w) < 8 ? cur : w))
  }, [])
  useEffect(() => {
    medir()
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(medir)
      if (areaRef.current) ro.observe(areaRef.current)
    } catch { /* engine sem ResizeObserver: fica no primeiro cálculo */ }
    window.addEventListener('resize', medir)
    return () => {
      try { ro?.disconnect() } catch { /* ignore */ }
      window.removeEventListener('resize', medir)
    }
  }, [medir])

  // `alturaMin` é o mínimo do card; no palco o teto é a própria célula, então
  // o chamador pode baixar o mínimo para o card não ser cortado pela linha.
  const renderTile = (t: CallTile, alturaMin = altura) => (
    <CallTileComponent
      tile={t}
      pinned={t.id === pinnedId}
      onPin={onPin}
      onExpand={onExpand}
      showAudioControls={showAudioControls}
      callDeafened={deafened}
      palette={palette}
      minHeight={alturaMin}
      avatarColor={avatarColor}
      avatarB64={avatarB64}
      onOpenProfile={onOpenProfile}
    />
  )

  if (fill) {
    // PALCO do canal de voz: preenche a área toda.
    //
    // BUGS REAIS corrigidos aqui (prints do dono):
    // 1. `gridAutoRows: minmax(200px, 1fr)` esticava cada card até o rodapé —
    //    dois participantes viravam duas COLUNAS compridas de avatar.
    // 2. `ceil(sqrt(n))` fixava colunas pela contagem e ignorava a largura.
    // 3. Desalinhamento: `justifyContent: 'center'` fazia cada coluna encolher
    //    para o conteúdo e o conjunto sair torto.
    // 4. FIXAR não funcionava: a grade ignorava a ordem e o card fixado ficava
    //    do mesmo tamanho dos outros. Agora o fixado ocupa a LINHA INTEIRA
    //    (grande, como o "pin" do Meet) e os demais vão para a fileira de baixo.
    const cols = colunasQueCabem(tiles.length, largura, 12, padding)
    const larguraCol = cols > 0 ? (Math.max(0, largura - padding * 2) - (cols - 1) * 12) / cols : 0
    const alturaCard = larguraCol > 0
      ? Math.max(160, Math.min(420, Math.round((larguraCol * 9) / 16)))
      : 240

    // FIXADO: ele vem em `tiles[0]` (o shell ordena), então basta dar a ele a
    // largura de todas as colunas. `pin` só vale se houver mais de um card —
    // sozinho ele já ocupa a tela.
    const temFixado = !!pinnedId && tiles.length > 1 && tiles[0]?.id === pinnedId
    const alturaFixado = Math.max(200, Math.min(560, Math.round(((largura - padding * 2) * 9) / 16)))

    return (
      <div
        ref={areaRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gap: 12,
          padding,
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          // Linhas com a MESMA altura: nenhum card maior que o outro.
          gridAutoRows: `${alturaCard}px`,
          // Conjunto centralizado na área (como o Meet), sem esticar a grade.
          alignContent: 'center',
          justifyContent: 'stretch',
          overflowY: 'auto',
          background,
        }}
      >
        {tiles.map((t, i) => {
          const fixado = temFixado && i === 0
          // TELA junto de participantes: linha INTEIRA, na posição dela.
          // Antes ela dividia a célula com um participante e o card, com
          // `aspectRatio` próprio, crescia além da linha e cobria o vizinho.
          const telaCheia = t.kind === 'screen' && tiles.length > 1
          return (
            <div
              key={t.id}
              style={{
                minWidth: 0,
                minHeight: 0,
                // A célula RECORTA o card: nada vaza para a linha de baixo.
                overflow: 'hidden',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                // O fixado atravessa todas as colunas e ganha altura maior.
                ...(fixado
                  ? { gridColumn: `1 / -1`, height: alturaFixado }
                  : null),
                ...(telaCheia && !fixado ? { gridColumn: '1 / -1' } : null),
              }}
            >
              {/* Sem mínimo: a célula já define a altura (o card não pode
                  crescer além dela). */}
              {renderTile(t, 0)}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexWrap: 'wrap',
        alignContent: 'flex-start',
        justifyContent: 'center',
        gap: 10,
        padding,
        overflowY: 'auto',
        background,
      }}
    >
      {tiles.map((tile) => (
        <div
          key={tile.id}
          style={{
            // Quadrado com TETO de altura: antes `1fr` esticava um único card
            // por 600px de altura — a tela virava dois retângulos gigantes de
            // borda a borda (relato: "ficou péssimo o design").
            flex: `1 1 ${compact ? 240 : 320}px`,
            maxWidth: tiles.length === 1 ? 520 : undefined,
            height: maxTileHeight,
            maxHeight: '100%',
            minWidth: 0,
            display: 'flex',
          }}
        >
          {renderTile(tile)}
        </div>
      ))}
    </div>
  )
}
