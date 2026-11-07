import CallTileComponent from './CallTile'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallTile } from '../../services/callTiles'
import {
  bestGrid,
  maxColumnsFor,
  spotlightLayout,
  type CallGridSpec,
  type CallSpotlightSpec,
} from '../../services/callLayout'

export interface CallTilesGridProps {
  tiles: CallTile[]
  pinnedId: string | null
  onPin: (id: string) => void
  onExpand: (id: string) => void
  deafened: boolean
  compact?: boolean
  showAudioControls?: boolean
  minHeight?: number
  palette: { heading: string; muted: string; green: string; red: string; accent: string; border: string }
  avatarColor: (fp: string) => string
  avatarB64?: Record<string, string | undefined>
  onOpenProfile?: (fp: string) => void
  background?: string
  padding?: number
  maxTileHeight?: number
  fill?: boolean
  platform?: 'mobile' | 'desktop'
}

function useAreaSize() {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const medir = useCallback(() => {
    const el = ref.current
    if (!el) return
    const w = el.clientWidth
    const h = el.clientHeight
    setSize((cur) => (Math.abs(cur.width - w) < 4 && Math.abs(cur.height - h) < 4 ? cur : { width: w, height: h }))
  }, [])
  useEffect(() => {
    medir()
    let ro: ResizeObserver | null = null
    try {
      ro = new ResizeObserver(medir)
      if (ref.current) ro.observe(ref.current)
    } catch {
    }
    window.addEventListener('resize', medir)
    window.addEventListener('orientationchange', medir)
    return () => {
      try {
        ro?.disconnect()
      } catch {
      }
      window.removeEventListener('resize', medir)
      window.removeEventListener('orientationchange', medir)
    }
  }, [medir])
  return { ref, size }
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
  maxTileHeight = 420,
  fill = false,
  platform = 'desktop',
}: CallTilesGridProps) {
  const alturaMin = minHeight ?? (compact ? 112 : 150)
  const { ref: areaRef, size } = useAreaSize()
  const gap = compact ? 6 : 12

  const renderTile = (t: CallTile, alturaCard = alturaMin, thumbnail = false) => (
    <CallTileComponent
      tile={t}
      pinned={t.id === pinnedId}
      thumbnail={thumbnail}
      onPin={onPin}
      onExpand={thumbnail ? undefined : onExpand}
      showAudioControls={showAudioControls && !thumbnail}
      callDeafened={deafened}
      palette={palette}
      minHeight={alturaCard}
      avatarColor={avatarColor}
      avatarB64={avatarB64}
      onOpenProfile={onOpenProfile}
    />
  )

  if (!fill) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexWrap: 'wrap',
          alignContent: 'flex-start',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: compact ? 6 : 10,
          padding,
          overflowY: 'auto',
          background,
        }}
      >
        {tiles.map((tile) => (
          <div
            key={tile.id}
            style={{
              flex: `1 1 ${compact ? 220 : 300}px`,
              maxWidth: tiles.length === 1 ? 560 : undefined,
              height: 'auto',
              maxHeight: maxTileHeight,
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

  const innerW = Math.max(0, size.width - padding * 2)
  const innerH = Math.max(0, size.height - padding * 2)
  const fixado = pinnedId ? tiles.find((t) => t.id === pinnedId) ?? null : null
  const temDestaque = !!fixado && tiles.length > 1
  const outros = temDestaque && fixado ? tiles.filter((t) => t.id !== fixado.id) : tiles

  const minCard = platform === 'mobile' ? 130 : 240
  const spec: CallGridSpec = bestGrid({
    count: outros.length,
    width: innerW,
    height: innerH,
    gap,
    minTileWidth: minCard,
    maxColumns: maxColumnsFor(platform, innerW),
  })
  const spot: CallSpotlightSpec | null = temDestaque
    ? spotlightLayout({ count: outros.length, width: innerW, height: innerH, gap, aspect: 16 / 9 })
    : null

  const grade = (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))`,
        gap,
        width: '100%',
        height: '100%',
        justifyItems: 'center',
        alignItems: 'center',
        alignContent: spec.scroll ? 'start' : 'center',
        overflowY: spec.scroll ? 'auto' : 'hidden',
        overflowX: 'hidden',
      }}
    >
      {outros.map((t) => (
        <div
          key={t.id}
          style={{
            width: spec.tileWidth > 0 ? Math.round(spec.tileWidth) : '100%',
            height: spec.tileHeight > 0 ? Math.round(spec.tileHeight) : '100%',
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
          }}
        >
          {renderTile(t, 0)}
        </div>
      ))}
    </div>
  )

  const destaque = fixado ? (
    <div
      style={{
        width: spot && spot.main.width > 0 ? Math.round(spot.main.width) : '100%',
        height: spot && spot.main.height > 0 ? Math.round(spot.main.height) : '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        display: 'flex',
        flexShrink: 0,
      }}
    >
      {renderTile(fixado, 0)}
    </div>
  ) : null

  const faixa = spot ? (
    <div
      style={{
        display: 'flex',
        flexDirection: spot.strip === 'right' ? 'column' : 'row',
        gap,
        alignItems: 'center',
        justifyContent: spot.strip === 'right' ? 'flex-start' : 'center',
        flexShrink: 0,
        alignSelf: 'stretch',
        overflowY: spot.strip === 'right' && spot.scroll ? 'auto' : 'hidden',
        overflowX: spot.strip === 'bottom' && spot.scroll ? 'auto' : 'hidden',
        ...(spot.strip === 'right'
          ? { width: Math.min(spot.thumb.width + gap, Math.max(96, innerW * 0.3)) }
          : { width: '100%', height: spot.thumb.height + (spot.scroll ? 6 : 0) }),
      }}
    >
      {outros.map((t) => (
        <div
          key={t.id}
          style={{
            width: Math.round(spot.thumb.width),
            height: Math.round(spot.thumb.height),
            minWidth: 0,
            minHeight: 0,
            overflow: 'hidden',
            display: 'flex',
            flexShrink: 0,
          }}
        >
          {renderTile(t, 0, true)}
        </div>
      ))}
    </div>
  ) : null

  return (
    <div
      ref={areaRef}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: spot && spot.strip === 'bottom' ? 'column' : 'row',
        alignItems: spec.scroll || (spot ? spot.scroll : false) ? 'stretch' : 'center',
        justifyContent: 'center',
        gap,
        padding,
        overflow: 'hidden',
        background,
      }}
    >
      {temDestaque ? (
        <>
          {destaque}
          {faixa}
        </>
      ) : (
        grade
      )}
    </div>
  )
}
