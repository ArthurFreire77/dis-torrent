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
}: CallTilesGridProps) {
  const altura = minHeight ?? (compact ? 112 : 150)
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.min(Math.max(tiles.length, 1), compact ? 1 : 2)}, minmax(0, 1fr))`,
        gridAutoRows: `minmax(${altura}px, 1fr)`,
        alignContent: 'stretch',
        gap: 10,
        padding,
        overflowY: 'auto',
        background,
      }}
    >
      {tiles.map((tile) => (
        <CallTileComponent
          key={tile.id}
          tile={tile}
          pinned={tile.id === pinnedId}
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
      ))}
    </div>
  )
}
