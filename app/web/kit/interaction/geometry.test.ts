import { expect, test } from 'bun:test'
import {
  bottomAnchorRects,
  hitTestPill,
  hitTestPillGap,
  maxPillRowsForHeight,
  packedRows,
  packRowsWithOverflow,
  packWidths,
  type PillRect,
  pillProbe,
  pillRowsHeight,
} from './geometry'

const METRICS = { pillHeight: 22, gap: 4 }
const R = 11 // corner radius = pillHeight / 2 (rounded-full)

const pill = (index: number, x: number, y: number, w: number, kind: 'pill' | 'box' = 'pill'): PillRect => ({
  index,
  key: `k${index}`,
  x,
  y,
  w,
  h: 22,
  kind,
})

test('pillProbe: inside is negative, outside positive, vector points at the core', () => {
  const p = pill(0, 0, 0, 100)
  expect(pillProbe(p, 50, 11, R).distance).toBeLessThan(0)
  const outside = pillProbe(p, 50, 30, R)
  expect(outside.distance).toBeGreaterThan(0)
  expect(outside.vy).toBeLessThan(0) // pointer below the pill: core is upward
})

test('hitTestPill: rounded corners do not count, boxes are plain rects, first match wins', () => {
  const rects = [pill(0, 0, 0, 100), pill(1, 0, 26, 100, 'box')]
  expect(hitTestPill(rects, 1, 1, R)).toBeNull() // corner wedge of the rounded pill
  expect(hitTestPill(rects, 1, 27, R)?.index).toBe(1) // box corner DOES count
  expect(hitTestPill(rects, 50, 11, R)?.index).toBe(0)
  // overlapping rects: caller order decides
  const overlapping = [pill(0, 0, 0, 100), pill(1, 0, 0, 100)]
  expect(hitTestPill(overlapping, 50, 11, R)?.index).toBe(0)
})

test('hitTestPillGap: bridges the gap between two pills but not the outer rim', () => {
  const a = pill(0, 0, 0, 40)
  const b = pill(1, 44, 0, 40) // 4px gap between them
  // pointer mid-gap: nearest pill wins because the other sits on the opposing side
  expect(hitTestPillGap([a, b], 42, 11, R, 6)).not.toBeNull()
  // pointer just past the cluster's outer edge: within reach of b only -> no bridge
  expect(hitTestPillGap([a, b], 89, 11, R, 6)).toBeNull()
  // boxes never participate
  expect(hitTestPillGap([pill(0, 0, 0, 40, 'box'), pill(1, 44, 0, 40, 'box')], 42, 11, R, 6)).toBeNull()
})

test('packWidths mirrors flex-wrap with gap and sub-pixel tolerance', () => {
  // 100-wide container: 60 + 4 + 40 = 104 > 100.5 -> wraps
  expect(packWidths([60, 40], 100, 4)).toEqual([
    { x: 0, row: 0, w: 60 },
    { x: 0, row: 1, w: 40 },
  ])
  // 60 + 4 + 36 = 100 fits
  expect(packWidths([60, 36], 100, 4)).toEqual([
    { x: 0, row: 0, w: 60 },
    { x: 64, row: 0, w: 36 },
  ])
  // 0.4px overhang is forgiven
  expect(packedRows(packWidths([60, 36.4], 100, 4))).toBe(1)
  expect(packedRows(packWidths([], 100, 4))).toBe(0)
})

test('packRowsWithOverflow: everything fits -> no overflow pill', () => {
  const r = packRowsWithOverflow([40, 40], [0, 30, 30, 30], 100, 2, 4)
  expect(r).toEqual({ visibleCount: 2, hiddenCount: 0, rows: 1 })
})

test('packRowsWithOverflow: drops reals off the tail until reals + "+N more" fit', () => {
  // container 100, maxRows 1: [60, 40, 40] can't fit; with overflow pill width 30:
  // 2 visible -> 60+4+40=104 wraps; 1 visible -> 60+4+30=94 fits
  const r = packRowsWithOverflow([60, 40, 40], [0, 30, 30, 30], 100, 1, 4)
  expect(r).toEqual({ visibleCount: 1, hiddenCount: 2, rows: 1 })
})

test('packRowsWithOverflow: even zero visible leaves the overflow pill', () => {
  const r = packRowsWithOverflow([200, 200], [0, 90, 90], 100, 1, 4)
  expect(r.visibleCount).toBe(0)
  expect(r.hiddenCount).toBe(2)
  expect(r.rows).toBe(1)
})

test('bottomAnchorRects shares one baseline with the rendered block', () => {
  const packed = packWidths([40, 40, 40], 100, 4) // rows 0,0 wraps? 40+4+40=84 fits, +4+40=128 wraps -> [0,0,1]
  const rects = bottomAnchorRects(packed, ['a', 'b', 'c'], 2, 300, 8, METRICS)
  const blockH = 2 * 22 + 4
  expect(rects[0]!.y).toBe(300 - 8 - blockH)
  expect(rects[2]!.y).toBe(300 - 8 - blockH + 26)
  expect(rects[0]!.x).toBe(8)
  expect(rects.every((r) => r.kind === 'pill')).toBe(true)
})

test('pillRowsHeight and maxPillRowsForHeight', () => {
  expect(pillRowsHeight(0, METRICS)).toBe(0)
  expect(pillRowsHeight(2, METRICS)).toBe(48)
  // tall container: capped by maxRowsTall
  expect(maxPillRowsForHeight(600, 120, 2, 240, METRICS)).toBe(2)
  // short container: 1 row
  expect(maxPillRowsForHeight(100, 120, 2, 240, METRICS)).toBe(1)
  // height-constrained: 80% of 60 = 48 -> floor((48+4)/26) = 2, but maxRowsTall caps at 2
  expect(maxPillRowsForHeight(60, 50, 2, 240, METRICS)).toBe(2)
})
