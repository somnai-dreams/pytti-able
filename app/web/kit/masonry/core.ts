// @cs
// masonry/core: greedy shortest-column masonry packing with occlusion culling, checked
// card-height rules, infinite-scroll and scroll-anchoring math. Pure, immediate-mode,
// ALLOCATION-FREE in the walk: the extraction preserves the original components'
// execution model — a tile's geometry exists only for the duration of one emit call,
// never as retained data. Per frame the walk allocates O(columns), not O(tiles).
//
// This file is deliberately SELF-CONTAINED (local copies of clamp/lessEqual/argMinRounded
// rather than @kit/midui imports): freerange follows calls only within one file, and this
// module's numeric per-step functions are its checked surface.
//
// types:
//   MasonrySource<G> = { groups, isGroupHidden(g), tileCount(g), isTileHidden(g, i),
//                        tileSizeY(g, i, columnSizeX) }
//     accessor view over YOUR data — no adapter arrays; height policy stays at the
//     surface (dispatch to the checked masonryCardHeight/masonryStyleCardHeight rules)
//   MasonryConfig = { colFractions: number[] (per-column share of availableSizeX),
//                     availableSizeX, originX, contentTop, gap }
//   MasonryViewport = { scrollTop, sizeY, lenienceY }   // lenience: cull window extension
//   MasonryTileCursor = { groupIndex, tileIndex, column, x, y, sizeX, sizeY, bottomY,
//                         inWindow, partiallyVisible, fullyVisible,
//                         topLeftCorner, topRightCorner }
//     ONE reused record: valid only during the emit call — copy what you keep, and never
//     capture the cursor itself in a closure. Two retention hazards: reading a retained
//     cursor AFTER the walk breaks loudly (every field is POISONED to NaN on return);
//     reading it during a LATER emit of the same walk silently shows the CURRENT tile's
//     values — poisoning cannot catch that class, which is why the never-capture rule
//     exists
//   MasonryResult = { contentHeight, columnBottoms, placedTileCount,
//                     lastInWindowOrdinal, firstPlacedGroupIndex }
//
// functions:
//   masonryColumnCount(naturalInnerSizeX, cardMinSizeX, minCols, maxCols)
//   uniformColumnFractions(cols) -> number[] summing to 1   (array producer: fr exception)
//   columnSizeX(colFractions, column, availableSizeX)
//   columnX(colFractions, column, availableSizeX, originX, gap)
//   masonryCardHeight(columnWidth, sourceSizeX, sourceSizeY)       // clamped rule, proven
//   masonryStyleCardHeight(columnWidth, sourceSizeX, sourceSizeY, infoBandY)
//   tileVisibility(y, bottomY, sizeY, scrollTop, viewportSizeY, lenienceY)
//     the proven visibility bands (the walk inlines the same expressions to stay
//     allocation-free — keep them in sync). NOTE the preserved quirk: a card taller than
//     the viewport covering it fully reports partiallyVisible=false AND
//     fullyVisible=false — in-window culling still renders it.
//   shouldFetchNextPage(lastInWindowOrdinal, totalTiles, cols, rowsAhead, hasNextPage, isFetching)
//   anchorScrollAdjustment(scrollTop, groupTopY, anchorPrevY)
//     the re-pin math when jobs stream in above the anchor group; caller keeps the
//     {anchorId, prevY} pair across frames and updates prevY after each application
//   placeMasonry(source, config, viewport, emitTile, emitGroupTop?) -> MasonryResult
//     the single walk. emitTile(cursor) fires for EVERY placed tile (in-window or not —
//     gate rendering on cursor.inWindow exactly like the original visibility check);
//     return false from emitTile to stop the walk early (anchor pre-passes).
//     emitGroupTop(groupIndex, topY) fires for EVERY group (hidden included) with the
//     smallest column bottom BEFORE the group places — the scroll-anchor read, delivered
//     inline where the original loops read Math.min(...ys).
//     Outside freerange's subset (mutating loop — documented exception); every numeric
//     step routes through the checked helpers above.
// @/cs

export type MasonrySource<G> = {
  groups: readonly G[]
  isGroupHidden: (group: G) => boolean
  tileCount: (group: G) => number
  isTileHidden: (group: G, tileIndex: number) => boolean
  tileSizeY: (group: G, tileIndex: number, columnSizeX: number) => number
}

export type MasonryConfig = {
  // Per-column width as a fraction of availableSizeX. Uniform today
  // (uniformColumnFractions), but weighted layouts fit the same shape.
  colFractions: number[]
  // Content width with gaps already subtracted — the caller owns the gap convention
  // (the app has both innerX - gap*(cols-1) and innerX - gap*cols in the wild).
  availableSizeX: number
  originX: number
  contentTop: number
  gap: number
}

export type MasonryViewport = {
  scrollTop: number
  sizeY: number
  // Cull window extension above and below the viewport (the app uses 2 viewport heights):
  // compositor scrolling paints before the next layout pass, so the window must lead it.
  lenienceY: number
}

export type MasonryTileCursor = {
  groupIndex: number
  tileIndex: number
  column: number
  x: number
  y: number
  sizeX: number
  sizeY: number
  bottomY: number
  inWindow: boolean
  partiallyVisible: boolean
  fullyVisible: boolean
  topLeftCorner: boolean
  topRightCorner: boolean
}

export type MasonryResult = {
  contentHeight: number
  // The final column bottoms (the walk's own array — do not mutate).
  columnBottoms: number[]
  placedTileCount: number
  lastInWindowOrdinal: number | null
  firstPlacedGroupIndex: number | null
}

// --- same-file numeric kernel (freerange follows only same-file calls; canonical copies
// live in @kit/midui/num — keep these three byte-identical with it)
function clamp(min: number, v: number, max: number) {
  return v > max ? max : v < min ? min : v
}

function lessEqual(a: number, b: number, c: number) {
  return a <= b && b <= c
}

// Index of the smallest value, with values rounded to 2 decimal places before comparing.
// Prevents float jitter from swapping near-equal columns on resize, which would make the
// next card ADHD-jump between them. Only the comparison rounds — placement math keeps
// full precision (don't lose information early).
function argMinRounded(arr: number[]) {
  let min = Infinity
  let minIndex = 0
  for (let i = 0; i < arr.length; i++) {
    const value = Math.round(arr[i]! * 100)
    if (value < min) {
      min = value
      minIndex = i
    }
  }
  return minIndex
}
// ---

export function masonryColumnCount(
  naturalInnerSizeX: number,
  cardMinSizeX: number,
  minCols: number,
  maxCols: number,
): number {
  console.assert(Number.isInteger(minCols))
  console.assert(minCols >= 1)
  console.assert(Number.isInteger(maxCols))
  console.assert(cardMinSizeX >= 1)
  // maxCols >= minCols is also required — a two-parameter relation is outside freerange's
  // leading-assert forms, so it lives here as prose.
  const ideal = Math.floor(Math.max(0, naturalInnerSizeX) / cardMinSizeX)
  return clamp(minCols, ideal, maxCols)
}

// Array producer — building an array is a write, outside freerange's subset entirely
// (documented exception; requires integer cols >= 1).
export function uniformColumnFractions(cols: number): number[] {
  const fractions: number[] = []
  for (let i = 0; i < cols; i++) {
    fractions[i] = 1 / cols
  }
  return fractions
}

export function columnSizeX(colFractions: number[], column: number, availableSizeX: number): number {
  console.assert(Number.isInteger(column))
  console.assert(column >= 0)
  return colFractions[column]! * availableSizeX
}

// The prefix-sum over colFractions is data-dependent, so freerange analyzes this with
// site-specific assumptions rather than caller contracts (requires integer column >= 0).
export function columnX(
  colFractions: number[],
  column: number,
  availableSizeX: number,
  originX: number,
  gap: number,
): number {
  let offsetFraction = 0
  for (let i = 0; i < column; i++) {
    offsetFraction += colFractions[i]!
  }
  return originX + gap * column + offsetFraction * availableSizeX
}

// Aspect-ratio clamp bounds, shared with the CSS story: portrait images cap at 9:16
// (object-cover clips beyond), landscape at 2:1 so wide images don't shrink to slivers.
export const masonryMinHeightRatio = 9 / 16
export const masonryMaxHeightRatio = 2

export function masonryCardHeight(columnWidth: number, sourceSizeX: number, sourceSizeY: number): number {
  const width = Math.max(1, columnWidth)
  // Dividing by sourceSizeX directly (not by a precomputed sourceSizeX/sourceSizeY ratio)
  // keeps the divisor provably positive inside the guard — a ratio can underflow to zero
  // for extreme sizes. A degenerate source size (0x0 placeholder, missing metadata) falls
  // to a square card instead of dividing to Infinity or NaN.
  const natural = sourceSizeX > 0 && sourceSizeY > 0 ? (width * sourceSizeY) / sourceSizeX : width
  const minimumHeight = width * masonryMinHeightRatio
  const maximumHeight = width * masonryMaxHeightRatio
  const height = Math.min(Math.max(minimumHeight, natural), maximumHeight)
  console.assert(minimumHeight <= height)
  console.assert(height <= maximumHeight)
  return height
}

// Style cards keep their exact natural aspect — no clamp, by design — but follow the same
// degenerate-source rule, and add the info band below the image.
export function masonryStyleCardHeight(
  columnWidth: number,
  sourceSizeX: number,
  sourceSizeY: number,
  infoBandY: number,
): number {
  const width = Math.max(1, columnWidth)
  const natural = sourceSizeX > 0 && sourceSizeY > 0 ? (width * sourceSizeY) / sourceSizeX : width
  return natural + Math.max(0, infoBandY)
}

export type TileVisibility = {
  inWindow: boolean
  partiallyVisible: boolean
  fullyVisible: boolean
}

export function tileVisibility(
  y: number,
  bottomY: number,
  sizeY: number,
  scrollTop: number,
  viewportSizeY: number,
  lenienceY: number,
): TileVisibility {
  const inWindow = lessEqual(-sizeY - lenienceY, y - scrollTop, viewportSizeY + lenienceY)
  const partiallyVisible =
    lessEqual(scrollTop, y, scrollTop + viewportSizeY) || lessEqual(scrollTop, bottomY, scrollTop + viewportSizeY)
  const fullyVisible = scrollTop <= y && bottomY <= scrollTop + viewportSizeY
  return { inWindow, partiallyVisible, fullyVisible }
}

export function shouldFetchNextPage(
  lastInWindowOrdinal: number | null,
  totalTiles: number,
  cols: number,
  rowsAhead: number,
  hasNextPage: boolean,
  isFetching: boolean,
): boolean {
  if (!hasNextPage || isFetching) return false
  if (lastInWindowOrdinal == null) return true
  return lastInWindowOrdinal > totalTiles - cols * rowsAhead
}

// When jobs stream in ABOVE the anchor group, its top moves from anchorPrevY to
// groupTopY; shifting scrollTop by the same delta keeps the anchor visually pinned.
export function anchorScrollAdjustment(scrollTop: number, groupTopY: number, anchorPrevY: number): number {
  return scrollTop + groupTopY - anchorPrevY
}

// The single walk. Mutating loop with a reused cursor — outside freerange's analyzable
// subset (documented exception); every numeric step routes through the checked helpers.
// Visibility expressions are inlined (not calls to tileVisibility) so the walk allocates
// nothing per tile — keep them in sync with tileVisibility above.
export function placeMasonry<G>(
  source: MasonrySource<G>,
  config: MasonryConfig,
  viewport: MasonryViewport,
  emitTile: (cursor: MasonryTileCursor) => boolean | void,
  emitGroupTop?: (groupIndex: number, topY: number) => void,
): MasonryResult {
  const cols = config.colFractions.length
  const ys: number[] = []
  for (let i = 0; i < cols; i++) ys.push(config.contentTop)

  const cursor: MasonryTileCursor = {
    groupIndex: 0,
    tileIndex: 0,
    column: 0,
    x: 0,
    y: 0,
    sizeX: 0,
    sizeY: 0,
    bottomY: 0,
    inWindow: false,
    partiallyVisible: false,
    fullyVisible: false,
    topLeftCorner: false,
    topRightCorner: false,
  }

  let placedTileCount = 0
  let lastInWindowOrdinal: number | null = null
  let firstPlacedGroupIndex: number | null = null
  let placedTopLeft = false
  let placedTopRight = false
  const groups = source.groups

  outer: for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex]!

    if (emitGroupTop != null) {
      // The group's top is the smallest column bottom BEFORE any of its tiles place —
      // what scroll anchoring pins to; delivered for every group so indices stay aligned.
      let groupTopY = Infinity
      for (let i = 0; i < cols; i++) {
        const columnBottom = ys[i]!
        if (columnBottom < groupTopY) groupTopY = columnBottom
      }
      emitGroupTop(groupIndex, groupTopY)
    }
    if (source.isGroupHidden(group)) continue

    const tileCount = source.tileCount(group)
    for (let tileIndex = 0; tileIndex < tileCount; tileIndex++) {
      if (source.isTileHidden(group, tileIndex)) continue
      firstPlacedGroupIndex ??= groupIndex

      const column = argMinRounded(ys)
      const sizeX = columnSizeX(config.colFractions, column, config.availableSizeX)
      const sizeY = source.tileSizeY(group, tileIndex, sizeX)
      const y = ys[column]!
      const bottomY = y + sizeY + config.gap

      // Inlined tileVisibility (allocation-free; keep in sync with the checked function).
      const scrollTop = viewport.scrollTop
      const inWindow = lessEqual(-sizeY - viewport.lenienceY, y - scrollTop, viewport.sizeY + viewport.lenienceY)
      const partiallyVisible =
        lessEqual(scrollTop, y, scrollTop + viewport.sizeY) ||
        lessEqual(scrollTop, bottomY, scrollTop + viewport.sizeY)
      const fullyVisible = scrollTop <= y && bottomY <= scrollTop + viewport.sizeY

      let topLeftCorner = false
      let topRightCorner = false
      if (inWindow) {
        if (column === 0 && !placedTopLeft) {
          placedTopLeft = true
          topLeftCorner = true
        }
        if (column === cols - 1 && !placedTopRight) {
          placedTopRight = true
          topRightCorner = true
        }
        lastInWindowOrdinal = placedTileCount
      }

      cursor.groupIndex = groupIndex
      cursor.tileIndex = tileIndex
      cursor.column = column
      cursor.x = columnX(config.colFractions, column, config.availableSizeX, config.originX, config.gap)
      cursor.y = y
      cursor.sizeX = sizeX
      cursor.sizeY = sizeY
      cursor.bottomY = bottomY
      cursor.inWindow = inWindow
      cursor.partiallyVisible = partiallyVisible
      cursor.fullyVisible = fullyVisible
      cursor.topLeftCorner = topLeftCorner
      cursor.topRightCorner = topRightCorner

      ys[column] = bottomY // adds a trailing gap after the last row; matches the app
      placedTileCount++

      if (emitTile(cursor) === false) break outer
    }
  }

  // Poison the cursor: it was only ever valid during an emit call. A retained reference
  // now reads NaN everywhere — loudly broken geometry instead of subtly wrong geometry.
  cursor.groupIndex = NaN
  cursor.tileIndex = NaN
  cursor.column = NaN
  cursor.x = NaN
  cursor.y = NaN
  cursor.sizeX = NaN
  cursor.sizeY = NaN
  cursor.bottomY = NaN

  let contentHeight = 0
  for (let i = 0; i < cols; i++) {
    const columnBottom = ys[i]!
    if (columnBottom > contentHeight) contentHeight = columnBottom
  }

  return { contentHeight, columnBottoms: ys, placedTileCount, lastInWindowOrdinal, firstPlacedGroupIndex }
}
