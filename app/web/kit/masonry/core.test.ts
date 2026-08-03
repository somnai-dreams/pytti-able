import { expect, test } from 'bun:test'
import {
  anchorScrollAdjustment,
  columnX,
  masonryCardHeight,
  masonryColumnCount,
  type MasonryConfig,
  type MasonrySource,
  masonryStyleCardHeight,
  type MasonryTileCursor,
  type MasonryViewport,
  placeMasonry,
  shouldFetchNextPage,
  tileVisibility,
  uniformColumnFractions,
} from './core'

// Array-backed source for tests; production surfaces provide accessor views over their
// own job arrays the same way.
type TestTile = { w: number, h: number, hidden?: boolean, fixed?: number }
type TestGroup = { hidden?: boolean, tiles: TestTile[] }
function src(groups: TestGroup[]): MasonrySource<TestGroup> {
  return {
    groups,
    isGroupHidden: (g) => g.hidden === true,
    tileCount: (g) => g.tiles.length,
    isTileHidden: (g, i) => g.tiles[i]!.hidden === true,
    tileSizeY: (g, i, w) => {
      const t = g.tiles[i]!
      return t.fixed ?? masonryCardHeight(w, t.w, t.h)
    },
  }
}

const tile = (w: number, h: number, hidden = false): TestTile => ({ w, h, hidden })

const twoCol: MasonryConfig = {
  colFractions: uniformColumnFractions(2),
  availableSizeX: 200,
  originX: 10,
  contentTop: 100,
  gap: 2,
}
const wideView: MasonryViewport = { scrollTop: 0, sizeY: 10_000, lenienceY: 0 }

// Collect COPIES of the cursor per emit (the cursor itself is reused).
function collect(groups: TestGroup[], config: MasonryConfig, viewport: MasonryViewport) {
  const tiles: MasonryTileCursor[] = []
  const groupTops: number[] = []
  const result = placeMasonry(
    src(groups),
    config,
    viewport,
    (c) => {
      tiles.push({ ...c })
    },
    (_g, topY) => {
      groupTops.push(topY)
    },
  )
  return { tiles, groupTops, result }
}

test('masonryColumnCount floors and clamps like the explore feed', () => {
  expect(masonryColumnCount(1000, 225, 2, 4)).toBe(4)
  expect(masonryColumnCount(500, 225, 2, 4)).toBe(2)
  expect(masonryColumnCount(5000, 225, 2, 5)).toBe(5)
  expect(masonryColumnCount(0, 225, 2, 4)).toBe(2)
})

test('uniformColumnFractions sums to 1', () => {
  for (const cols of [1, 2, 3, 4, 5]) {
    const sum = uniformColumnFractions(cols).reduce((a, b) => a + b, 0)
    expect(sum).toBeCloseTo(1)
  }
})

test('columnX matches the explicit per-column offset chain', () => {
  const fractions = uniformColumnFractions(4)
  expect(columnX(fractions, 0, 400, 10, 2)).toBe(10)
  expect(columnX(fractions, 1, 400, 10, 2)).toBe(10 + 2 + 100)
  expect(columnX(fractions, 2, 400, 10, 2)).toBe(10 + 4 + 200)
  expect(columnX(fractions, 3, 400, 10, 2)).toBe(10 + 6 + 300)
})

test('masonryCardHeight clamps to [9/16, 2]x column width and survives 0x0 sources', () => {
  expect(masonryCardHeight(100, 100, 100)).toBe(100)
  expect(masonryCardHeight(100, 100, 1000)).toBe(200)
  expect(masonryCardHeight(100, 1000, 100)).toBe(56.25)
  expect(masonryCardHeight(100, 0, 0)).toBe(100)
})

test('masonryStyleCardHeight keeps natural aspect and adds the info band', () => {
  expect(masonryStyleCardHeight(100, 300, 100, 40)).toBeCloseTo(100 / 3 + 40)
  expect(masonryStyleCardHeight(100, 0, 0, 40)).toBe(140)
})

test('tileVisibility: culled, partial, full, and the taller-than-viewport quirk', () => {
  const below = tileVisibility(5000, 5102, 100, 100, 300, 600)
  expect(below.inWindow).toBe(false)

  const topEdgeIn = tileVisibility(350, 452, 100, 100, 300, 600)
  expect(topEdgeIn).toEqual({ inWindow: true, partiallyVisible: true, fullyVisible: false })

  const fully = tileVisibility(150, 252, 100, 100, 300, 600)
  expect(fully).toEqual({ inWindow: true, partiallyVisible: true, fullyVisible: true })

  const covering = tileVisibility(0, 1002, 1000, 100, 300, 600)
  expect(covering).toEqual({ inWindow: true, partiallyVisible: false, fullyVisible: false })
})

test('shouldFetchNextPage mirrors the near-the-end predicate', () => {
  expect(shouldFetchNextPage(null, 100, 4, 20, true, false)).toBe(true)
  expect(shouldFetchNextPage(50, 100, 4, 20, true, false)).toBe(true)
  expect(shouldFetchNextPage(10, 100, 4, 20, true, false)).toBe(false)
  expect(shouldFetchNextPage(50, 100, 4, 20, false, false)).toBe(false)
  expect(shouldFetchNextPage(50, 100, 4, 20, true, true)).toBe(false)
})

test('anchorScrollAdjustment shifts scroll by the anchor drift', () => {
  expect(anchorScrollAdjustment(500, 320, 300)).toBe(520)
})

test('the walk packs greedily into the shortest column', () => {
  const { tiles, result } = collect(
    [
      { tiles: [tile(100, 100), tile(100, 100)] },
      { tiles: [tile(100, 300)] },
    ],
    twoCol,
    wideView,
  )
  expect(tiles.map((t) => [t.column, t.y, t.sizeY])).toEqual([
    [0, 100, 100],
    [1, 100, 100],
    [0, 202, 200], // portrait clamps to 2x width; equal columns tie-break to column 0
  ])
  expect(tiles.map((t) => t.x)).toEqual([10, 112, 10])
  expect(result.columnBottoms).toEqual([404, 202])
  expect(result.contentHeight).toBe(404)
  expect(result.placedTileCount).toBe(3)
  expect(result.firstPlacedGroupIndex).toBe(0)
})

test('near-equal column bottoms tie-break stably (no float jitter swap)', () => {
  const flat = collect([{ tiles: [tile(100, 100)] }], { ...twoCol, contentTop: 0 }, wideView)
  expect(flat.tiles[0]!.column).toBe(0)
  const jitter = collect([{ tiles: [tile(100, 100)] }], { ...twoCol, contentTop: 0.001 }, wideView)
  expect(jitter.tiles[0]!.column).toBe(0)
})

test('hidden groups and tiles are skipped but group tops stay index-aligned', () => {
  const { tiles, groupTops, result } = collect(
    [
      { tiles: [tile(100, 100)] },
      { hidden: true, tiles: [tile(100, 100)] },
      { tiles: [tile(100, 100, true), tile(100, 100)] },
    ],
    twoCol,
    wideView,
  )
  expect(tiles.length).toBe(2)
  expect(tiles[1]!.groupIndex).toBe(2)
  expect(tiles[1]!.tileIndex).toBe(1)
  // group 1 (hidden) still gets its top delivered at its turn
  expect(groupTops).toEqual([100, 100, 100])
  expect(result.placedTileCount).toBe(2)
})

test('emitGroupTop delivers the min column bottom BEFORE the group places (the anchor read)', () => {
  const { groupTops } = collect(
    [
      { tiles: [tile(100, 100), tile(100, 300)] },
      { tiles: [tile(100, 100)] },
    ],
    twoCol,
    wideView,
  )
  // after group 0: columns at [202, 302] -> group 1's top is 202
  expect(groupTops).toEqual([100, 202])
})

test('corner flags mark the first in-window tile of each edge column', () => {
  const groups = Array.from({ length: 6 }, () => ({ tiles: [tile(100, 100)] }))
  const { tiles, result } = collect(groups, twoCol, { scrollTop: 250, sizeY: 200, lenienceY: 0 })
  const inWindow = tiles.filter((t) => t.inWindow)
  expect(inWindow.length).toBeGreaterThan(0)
  const firstLeft = inWindow.find((t) => t.column === 0)
  expect(firstLeft?.topLeftCorner).toBe(true)
  expect(inWindow.filter((t) => t.column === 0 && t.topLeftCorner).length).toBe(1)
  expect(result.lastInWindowOrdinal).not.toBeNull()
})

test('the cursor is ONE reused record — consumers must copy; retention reads poison', () => {
  const raw: MasonryTileCursor[] = []
  placeMasonry(src([{ tiles: [tile(100, 100), tile(100, 100)] }]), twoCol, wideView, (c) => {
    raw.push(c) // deliberately NOT copying
  })
  expect(raw.length).toBe(2)
  const [first, second] = raw
  expect(first).toBe(second) // same object identity: retaining it is a bug in the consumer
  // ...and after the walk that object is poisoned, so the bug is LOUD, not subtle
  expect(Number.isNaN(raw[0]!.x)).toBe(true)
  expect(Number.isNaN(raw[0]!.groupIndex)).toBe(true)
})

test('early-stopped walks poison the cursor too', () => {
  const leaked: { current: MasonryTileCursor | null } = { current: null }
  placeMasonry(src([{ tiles: [tile(100, 100), tile(100, 100)] }]), twoCol, wideView, (c) => {
    leaked.current = c
    return false
  })
  expect(Number.isNaN(leaked.current!.y)).toBe(true)
})

test('returning false from emitTile stops the walk early (anchor pre-pass)', () => {
  let calls = 0
  const result = placeMasonry(
    src([{ tiles: [tile(100, 100), tile(100, 100)] }, { tiles: [tile(100, 100)] }]),
    twoCol,
    wideView,
    () => {
      calls++
      return calls >= 2 ? false : undefined
    },
  )
  expect(calls).toBe(2)
  expect(result.placedTileCount).toBe(2) // walk stopped; later tiles never placed
})
