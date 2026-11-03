export const TILE_ASPECT = 16 / 9

export interface Rect {
  width: number
  height: number
}

export interface CallGridSpec {
  columns: number
  rows: number
  tileWidth: number
  tileHeight: number
  scroll: boolean
}

export interface CallLayoutInput {
  count: number
  width: number
  height: number
  gap?: number
  aspect?: number
  minTileWidth?: number
  maxColumns?: number
}

function sane(v: number | undefined, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function fitCard(cellW: number, cellH: number, aspect: number): Rect {
  const w = Math.max(0, cellW)
  const h = Math.max(0, cellH)
  if (w <= 0 || h <= 0) return { width: 0, height: 0 }
  const byWidth = { width: w, height: w / aspect }
  if (byWidth.height <= h) return byWidth
  return { width: h * aspect, height: h }
}

export function bestGrid(input: CallLayoutInput): CallGridSpec {
  const count = Math.max(1, Math.floor(sane(input.count, 1)))
  const gap = Math.max(0, sane(input.gap, 12))
  const aspect = sane(input.aspect, TILE_ASPECT) || TILE_ASPECT
  const minTileWidth = Math.max(0, sane(input.minTileWidth, 160))
  const width = Math.max(0, sane(input.width, 0))
  const height = Math.max(0, sane(input.height, 0))
  const maxColumns = Math.max(1, Math.floor(sane(input.maxColumns, 8)))

  if (width <= 0 || height <= 0) {
    const columns = Math.max(1, Math.min(maxColumns, Math.ceil(Math.sqrt(count)), count))
    return { columns, rows: Math.ceil(count / columns), tileWidth: 0, tileHeight: 0, scroll: false }
  }

  let melhor: CallGridSpec | null = null
  for (let columns = 1; columns <= Math.min(count, maxColumns); columns++) {
    const rows = Math.ceil(count / columns)
    const cellW = (width - gap * (columns - 1)) / columns
    const cellH = (height - gap * (rows - 1)) / rows
    if (cellW <= 0 || cellH <= 0) continue
    const card = fitCard(cellW, cellH, aspect)
    const spec: CallGridSpec = { columns, rows, tileWidth: card.width, tileHeight: card.height, scroll: false }
    if (
      !melhor ||
      card.width * card.height > melhor.tileWidth * melhor.tileHeight + 0.5 ||
      (Math.abs(card.width * card.height - melhor.tileWidth * melhor.tileHeight) <= 0.5 && rows < melhor.rows)
    ) {
      melhor = spec
    }
  }

  if (!melhor) {
    return { columns: 1, rows: count, tileWidth: width, tileHeight: width / aspect, scroll: true }
  }

  if (melhor.tileWidth > 0 && melhor.tileWidth < minTileWidth) {
    const alturaNecessaria = melhor.rows * (minTileWidth / aspect) + gap * (melhor.rows - 1)
    if (alturaNecessaria > height) {
      melhor = { ...melhor, tileWidth: minTileWidth, tileHeight: minTileWidth / aspect, scroll: true }
    }
  }
  return melhor
}

export type SpotlightStrip = 'right' | 'bottom'

export interface CallSpotlightSpec {
  main: Rect
  strip: SpotlightStrip
  thumb: Rect
  perLine: number
  scroll: boolean
}

export function spotlightLayout(
  input: CallLayoutInput & { strip?: SpotlightStrip | 'auto' },
): CallSpotlightSpec {
  const count = Math.max(0, Math.floor(sane(input.count, 0)))
  const gap = Math.max(0, sane(input.gap, 12))
  const aspect = sane(input.aspect, TILE_ASPECT) || TILE_ASPECT
  const width = Math.max(0, sane(input.width, 0))
  const height = Math.max(0, sane(input.height, 0))
  const thumbW = Math.max(96, Math.min(220, Math.round(width * 0.18) || 160))
  const thumbH = thumbW / aspect

  const auto: SpotlightStrip = width >= height * 1.15 ? 'right' : 'bottom'
  const strip: SpotlightStrip =
    input.strip === 'right' || input.strip === 'bottom' ? input.strip : auto

  if (count <= 0) {
    return { main: { width, height }, strip, thumb: { width: thumbW, height: thumbH }, perLine: 1, scroll: false }
  }

  if (width <= 0 || height <= 0) {
    return {
      main: { width, height },
      strip,
      thumb: { width: thumbW, height: thumbH },
      perLine: strip === 'right' ? Math.max(1, Math.floor(height / (thumbH + gap))) : 1,
      scroll: false,
    }
  }

  if (strip === 'right') {
    const maxThumbsNaColuna = Math.max(1, Math.floor((height + gap) / (thumbH + gap)))
    const faixa = Math.min(width * 0.34, thumbW + gap * 2)
    return {
      main: fitCard(Math.max(0, width - faixa), height, aspect),
      strip,
      thumb: { width: thumbW, height: thumbH },
      perLine: Math.min(count, maxThumbsNaColuna),
      scroll: count > maxThumbsNaColuna,
    }
  }

  const maxThumbsNaLinha = Math.max(1, Math.floor((width + gap) / (thumbW + gap)))
  const linhas = Math.ceil(count / maxThumbsNaLinha)
  const faixa = Math.min(height * 0.42, linhas * (thumbH + gap) + gap)
  return {
    main: fitCard(width, Math.max(0, height - faixa), aspect),
    strip,
    thumb: { width: thumbW, height: thumbH },
    perLine: maxThumbsNaLinha,
    scroll: linhas > 2,
  }
}

export function gridColumns(input: CallLayoutInput): number {
  return bestGrid(input).columns
}

export function maxColumnsFor(platform: 'mobile' | 'desktop', width: number): number {
  if (platform === 'mobile') return width >= 620 ? 3 : 2
  if (width < 520) return 1
  if (width < 900) return 2
  return 4
}
