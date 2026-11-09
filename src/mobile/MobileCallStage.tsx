import CallTileComponent from '../components/calls/CallTile'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CallTile } from '../services/callTiles'
import { bestGrid, maxColumnsFor, spotlightLayout, type CallGridSpec, type CallSpotlightSpec } from '../services/callLayout'

export interface MobileCallStageProps {
  tiles: CallTile[]
  pinnedId: string | null
  expandedId: string | null
  onPin: (id: string) => void
  onExpand: (id: string) => void
  deafened: boolean
  palette: { heading: string; muted: string; green: string; red: string; accent: string; border: string }
  avatarColor: (fp: string) => string
  avatarB64?: Record<string, string | undefined>
  onOpenProfile?: (fp: string) => void
  maxHeight?: number
  /**
   * Tira horizontal de altura fixa, usada DENTRO da conversa (aba de amigos):
   * os vídeos viram uma faixa e as mensagens continuam visíveis embaixo.
   * Sem isto o palco pede a altura toda e espreme o histórico.
   */
  strip?: boolean
  stripHeight?: number
}

export default function MobileCallStage({
  tiles,
  pinnedId,
  expandedId,
  onPin,
  onExpand,
  deafened,
  palette,
  avatarColor,
  avatarB64,
  onOpenProfile,
  strip = false,
  stripHeight = 132,
}: MobileCallStageProps) {
  const areaRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const medir = useCallback(() => {
    const el = areaRef.current
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
      if (areaRef.current) ro.observe(areaRef.current)
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

  const gap = 6
  const fixado = pinnedId ? tiles.find((t) => t.id === pinnedId) ?? null : null
  const destaque = fixado && tiles.length > 1 ? fixado : null
  const outros = destaque ? tiles.filter((t) => t.id !== destaque.id) : tiles
  const spec: CallGridSpec = bestGrid({
    count: outros.length,
    width: size.width,
    height: size.height,
    gap,
    minTileWidth: 120,
    maxColumns: maxColumnsFor('mobile', size.width),
  })
  const destaqueSpec: CallSpotlightSpec | null = destaque
    ? spotlightLayout({ count: outros.length, width: size.width, height: size.height, gap, strip: 'bottom' })
    : null

  const tile = (t: CallTile, altura: number, thumbnail = false) => (
    <CallTileComponent
      tile={t}
      pinned={t.id === pinnedId}
      expanded={t.id === expandedId}
      thumbnail={thumbnail}
      touch
      onPin={onPin}
      onExpand={onExpand}
      showAudioControls={!thumbnail}
      callDeafened={deafened}
      palette={palette}
      minHeight={altura}
      avatarColor={avatarColor}
      avatarB64={avatarB64}
      onOpenProfile={onOpenProfile}
    />
  )

  if (strip) {
    return (
      <div
        style={{
          height: stripHeight,
          flexShrink: 0,
          display: 'flex',
          gap: 6,
          overflowX: 'auto',
          overflowY: 'hidden',
        }}
      >
        {tiles.map((t) => {
          const largura = Math.round(stripHeight * (16 / 9))
          return (
            <div
              key={t.id}
              style={{ width: largura, height: stripHeight, flexShrink: 0, display: 'flex' }}
            >
              {tile(t, 0)}
            </div>
          )
        })}
      </div>
    )
  }

  if (destaque && destaqueSpec) {
    const altMain = destaqueSpec.main.height > 0 ? Math.round(destaqueSpec.main.height) : Math.round(size.height * 0.55)
    return (
      <div
        ref={areaRef}
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          flexDirection: 'column',
          gap,
          padding: 4,
          overflow: 'hidden',
        }}
      >
        <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '100%', height: altMain, maxHeight: '100%', display: 'flex' }}>
            {tile(destaque, 0)}
          </div>
        </div>
        {outros.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap,
              flexShrink: 0,
              height: Math.max(84, Math.round(destaqueSpec.thumb.height)),
              overflowX: 'auto',
              overflowY: 'hidden',
              paddingBottom: 2,
            }}
          >
            {outros.map((t) => (
              <div
                key={t.id}
                style={{
                  width: Math.max(120, Math.round(destaqueSpec.thumb.width)),
                  height: '100%',
                  flexShrink: 0,
                  display: 'flex',
                }}
              >
                {tile(t, 0, true)}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      ref={areaRef}
      style={{
        flex: 1,
        minHeight: 0,
        display: 'grid',
        gridTemplateColumns: `repeat(${spec.columns}, minmax(0, 1fr))`,
        gap,
        padding: 4,
        alignContent: spec.scroll ? 'start' : 'center',
        justifyItems: 'center',
        alignItems: 'center',
        overflowY: spec.scroll ? 'auto' : 'hidden',
      }}
    >
      {outros.map((t) => (
        <div
          key={t.id}
          style={{
            width: spec.tileWidth > 0 ? Math.round(spec.tileWidth) : '100%',
            height: spec.tileHeight > 0 ? Math.round(spec.tileHeight) : 140,
            minWidth: 0,
            minHeight: 0,
            display: 'flex',
          }}
        >
          {tile(t, 0)}
        </div>
      ))}
    </div>
  )
}
