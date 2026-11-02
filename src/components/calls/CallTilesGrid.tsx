// Grade de quadrados da chamada — usada no painel lateral E na tela do canal.
//
// POR QUE EXISTE: os mesmos `CallTile` (e é neles que ficam o `<audio>` da voz
// e o `<video>` da câmera/tela) precisam aparecer em dois lugares. Duplicar o
// JSX fazia a tela do canal esquecer os tiles — chamada conectada e muda.

import CallTileComponent from './CallTile'
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
  const renderTile = (t: CallTile) => (
    <CallTileComponent
      tile={t}
      pinned={t.id === pinnedId}
      onPin={onPin}
      onExpand={onExpand}
      showAudioControls={showAudioControls}
      callDeafened={deafened}
      palette={palette}
      minHeight={altura}
      avatarColor={avatarColor}
      avatarB64={avatarB64}
      onOpenProfile={onOpenProfile}
    />
  )

  if (fill) {
    // PALCO do canal de voz: preenche a área toda (pedido do dono — "completar
    // a tela como nos amigos, num espaço maior"). Colunas por raiz quadrada:
    // 1→1, 2→2, 3-4→2, 5-6→3…
    const colunas = Math.max(1, Math.ceil(Math.sqrt(tiles.length)))
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gap: 10,
          padding,
          gridTemplateColumns: `repeat(${colunas}, minmax(0, 1fr))`,
          // Piso de 200px: com muita gente as linhas rolam em vez de colapsar.
          gridAutoRows: 'minmax(200px, 1fr)',
          overflowY: 'auto',
          background,
        }}
      >
        {tiles.map((t) => (
          <div key={t.id} style={{ minWidth: 0, minHeight: 0, display: 'flex' }}>
            {renderTile(t)}
          </div>
        ))}
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
