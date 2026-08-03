// @cs
// interaction/geometry: pill-cluster packing and rounded-rect hit-testing over
// PRE-MEASURED widths. Extracted from hoverPillLayout.ts minus its product half:
// text measurement (pretext), descriptors, and thumbnail policy stay app-side — widths
// enter as number[] (freerange cannot follow callbacks, and measurement is impure).
//
// types:
//   PillRect   = { index, key, x, y, w, h, kind: 'pill' | 'box' }
//   PackedPill = { x, row, w }
//   PillMetrics = { pillHeight, gap }        // gap also spaces rows
//
// hit-testing (local/cluster coordinates):
//   pillProbe(rect, lx, ly, cornerRadius) -> { vx, vy, distance }
//     signed distance to the rounded-rect surface (<= 0 inside) + vector toward the core;
//     the vector distinguishes "between two pills" from "outer rim of the cluster"
//   hitTestPill(rects, lx, ly, cornerRadius) -> PillRect | null
//     first-match by caller-ordered priority; 'box' rects use plain rectangle containment
//   hitTestPillGap(rects, lx, ly, cornerRadius, gapReach) -> PillRect | null
//     continue an already-acquired interaction through narrow BETWEEN-pill gaps only: the
//     closest pill wins when an opposing-side pill is also within reach (no outer halo)
//
// packing (mirrors flex-wrap with gap):
//   packWidths(widths, innerWidth, gap) -> PackedPill[]     (0.5px overhang tolerance)
//   packedRows(packed) -> number
//   packRowsWithOverflow(widths, overflowWidths, innerWidth, maxRows, gap)
//     -> { visibleCount, hiddenCount, rows }
//     THE visible/hidden split: when everything fits within maxRows, all visible;
//     otherwise drop reals off the TAIL one at a time until reals + the "+N more" pill
//     (whose width for hiddenCount = h is overflowWidths[h], pre-measured by the caller)
//     fit together. Requires overflowWidths.length > widths.length.
//   bottomAnchorRects(packed, keys, rows, containerH, inset, metrics) -> PillRect[]
//     bottom-anchor a packed set; `rows` is the FULL displayed row count (including the
//     "+N more" row) so hit rects share the render's baseline
//   pillRowsHeight(rows, metrics) -> painted block height
//   maxPillRowsForHeight(containerH, shortContainerH, maxRowsTall, blockMaxPx, metrics)
//     -> row budget: min(fixed ceiling, 80% of container height) floored to whole rows,
//        1 row under shortContainerH
// @/cs

export type PillRect = { index: number, key: string, x: number, y: number, w: number, h: number, kind: 'pill' | 'box' }

export type PackedPill = { x: number, row: number, w: number }

export type PillMetrics = { pillHeight: number, gap: number }

export function pillProbe(
  p: PillRect,
  lx: number,
  ly: number,
  cornerRadius: number,
): { vx: number, vy: number, distance: number } {
  console.assert(cornerRadius >= 0)
  const r = Math.min(cornerRadius, Math.min(p.w, p.h) / 2)
  const cx = lx < p.x + r ? p.x + r : lx > p.x + p.w - r ? p.x + p.w - r : lx
  const cy = ly < p.y + r ? p.y + r : ly > p.y + p.h - r ? p.y + p.h - r : ly
  const vx = cx - lx
  const vy = cy - ly
  return { vx, vy, distance: Math.sqrt(vx * vx + vy * vy) - r }
}

// Which region the pointer is INSIDE, or null. Pills use the visible rounded-rect (corner
// wedges don't count); 'box' regions use a plain rectangle. Returns the FIRST match, so
// callers order rects by priority.
export function hitTestPill(rects: readonly PillRect[], lx: number, ly: number, cornerRadius: number): PillRect | null {
  for (const p of rects) {
    const inside =
      p.kind === 'box'
        ? lx >= p.x && lx <= p.x + p.w && ly >= p.y && ly <= p.y + p.h
        : pillProbe(p, lx, ly, cornerRadius).distance <= 0
    if (inside) return p
  }
  return null
}

// Continue an ALREADY-ACQUIRED pill interaction only through the narrow gaps BETWEEN real
// pills. The closest pill wins, but only when another within-reach pill sits on the
// opposing side of the pointer — that opposing-vector test fills the packing gaps without
// growing a sticky halo around the outside of the cluster. Box regions never participate.
export function hitTestPillGap(
  rects: readonly PillRect[],
  lx: number,
  ly: number,
  cornerRadius: number,
  gapReach: number,
): PillRect | null {
  // Requires gapReach >= 0 (prose: the two-pass probe loop exceeds freerange's one-pass
  // requirement propagation, so a checked assert here would be reported unverified).
  // Index-tracked best (not object identity): number comparisons stay in freerange's subset.
  let bestIndex = -1
  let bestVx = 0
  let bestVy = 0
  let bestDistance = gapReach
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i]!
    if (rect.kind !== 'pill') continue
    const { vx, vy, distance } = pillProbe(rect, lx, ly, cornerRadius)
    if (distance <= bestDistance) {
      bestIndex = i
      bestVx = vx
      bestVy = vy
      bestDistance = distance
    }
  }
  if (bestIndex === -1) return null
  for (let i = 0; i < rects.length; i++) {
    if (i === bestIndex) continue
    const rect = rects[i]!
    if (rect.kind !== 'pill') continue
    const { vx, vy, distance } = pillProbe(rect, lx, ly, cornerRadius)
    if (distance <= gapReach && bestVx * vx + bestVy * vy < 0) return rects[bestIndex]!
  }
  return null
}

// Greedy pack of pre-measured widths into rows, mirroring flex-wrap with `gap`. The 0.5px
// tolerance forgives sub-pixel overhang so a measured width a hair over the container
// doesn't wrap a pill that visually fits.
export function packWidths(widths: readonly number[], innerWidth: number, gap: number): PackedPill[] {
  const out: PackedPill[] = []
  let x = 0
  let row = 0
  for (const w of widths) {
    if (x > 0 && x + gap + w > innerWidth + 0.5) {
      x = 0
      row += 1
    } else if (x > 0) {
      x += gap
    }
    out.push({ x, row, w })
    x += w
  }
  return out
}

export function packedRows(packed: readonly PackedPill[]): number {
  return packed.length === 0 ? 0 : packed[packed.length - 1]!.row + 1
}

// The visible/hidden split. overflowWidths[h] is the pre-measured width of the "+h more"
// pill — measurement is the caller's (impure) job, done once per possible count.
export function packRowsWithOverflow(
  widths: readonly number[],
  overflowWidths: readonly number[],
  innerWidth: number,
  maxRows: number,
  gap: number,
): { visibleCount: number, hiddenCount: number, rows: number } {
  // Requires integer maxRows >= 1 and overflowWidths.length > widths.length. (An array
  // producer — outside freerange's subset — so the requirements live here as prose.)
  if (widths.length === 0) return { visibleCount: 0, hiddenCount: 0, rows: 0 }

  const fullPacked = packWidths(widths, innerWidth, gap)
  if (packedRows(fullPacked) <= maxRows) {
    return { visibleCount: widths.length, hiddenCount: 0, rows: packedRows(fullPacked) }
  }
  // Overflow: start from the reals that fit on their own, then drop one at a time until the
  // reals + the "+N more" pill fit together — dropping a real frees more width than the
  // growing count costs, so the loop converges quickly.
  let startCount = 0
  for (const p of fullPacked) {
    if (p.row < maxRows) startCount += 1
  }
  for (let visibleCount = startCount; visibleCount >= 0; visibleCount--) {
    const hiddenCount = widths.length - visibleCount
    const trial: number[] = []
    for (let i = 0; i < visibleCount; i++) trial.push(widths[i]!)
    trial.push(overflowWidths[hiddenCount]!)
    const packed = packWidths(trial, innerWidth, gap)
    if (packedRows(packed) <= maxRows) return { visibleCount, hiddenCount, rows: packedRows(packed) }
  }
  return { visibleCount: 0, hiddenCount: widths.length, rows: 1 }
}

// Bottom-anchor a packed row set inside a container. `rows` is the FULL displayed row
// count (including the "+N more" pill's row), so the rects share one baseline with the
// render. keys is index-aligned with packed.
export function bottomAnchorRects(
  packed: readonly PackedPill[],
  keys: readonly string[],
  rows: number,
  containerH: number,
  inset: number,
  metrics: PillMetrics,
): PillRect[] {
  const flagsHeight = rows * metrics.pillHeight + (rows - 1) * metrics.gap
  const flagsTop = containerH - inset - flagsHeight
  const out: PillRect[] = []
  for (let i = 0; i < packed.length; i++) {
    const p = packed[i]!
    out.push({
      index: i,
      key: keys[i]!,
      x: inset + p.x,
      y: flagsTop + p.row * (metrics.pillHeight + metrics.gap),
      w: p.w,
      h: metrics.pillHeight,
      kind: 'pill',
    })
  }
  return out
}

// The painted height of `rows` pill rows in a flex-wrap with `gap` — budget text height
// from this and the block can't drift from the render.
export function pillRowsHeight(rows: number, metrics: PillMetrics): number {
  console.assert(Number.isInteger(rows))
  console.assert(rows >= 0)
  return rows <= 0 ? 0 : rows * metrics.pillHeight + (rows - 1) * metrics.gap
}

// Cap a pill block so a long list can't fill the whole container: the block maxes out at
// the SMALLER of a fixed pixel ceiling and 80% of the container height, rounded DOWN to
// whole rows, capped at maxRowsTall (1 row under shortContainerH).
export function maxPillRowsForHeight(
  containerH: number,
  shortContainerH: number,
  maxRowsTall: number,
  blockMaxPx: number,
  metrics: PillMetrics,
): number {
  console.assert(Number.isInteger(maxRowsTall))
  console.assert(maxRowsTall >= 1)
  const maxRows = containerH < shortContainerH ? 1 : maxRowsTall
  const cap = Math.min(blockMaxPx, containerH * 0.8)
  const heightRows = Math.max(1, Math.floor((cap + metrics.gap) / (metrics.pillHeight + metrics.gap)))
  return Math.min(maxRows, heightRows)
}
