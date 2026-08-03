import { expect, test } from 'bun:test'
import {
  anchorMorph,
  anchorTravelY,
  gridNext,
  gridPrev,
  isFirstVisibleOfGroup,
  isLastVisibleOfGroup,
  reelAnchorScan,
  reelNext,
  reelPrev,
  type ReelSource,
  type SwipeState,
  swipeStep,
} from './core'

// Array-backed source for tests; the lightboxes provide the same accessor view over
// their own job arrays.
type TestGroup = { hidden: boolean, items: { hidden: boolean, hardHidden: boolean }[] }
function src(groups: TestGroup[]): ReelSource<TestGroup> {
  return {
    groups,
    isGroupHidden: (g) => g.hidden,
    itemCount: (g) => g.items.length,
    isItemHidden: (g, i) => g.items[i]!.hidden,
    isItemHardHidden: (g, i) => g.items[i]!.hardHidden,
  }
}

const item = (hidden = false, hardHidden = false) => ({ hidden, hardHidden })

// 3 groups: [a0, a1], [b0(hidden), b1], [c0] with group 1... let's shape richer below
const groups = src([
  { hidden: false, items: [item(), item()] },
  { hidden: false, items: [item(true), item()] },
  { hidden: true, items: [item(), item()] },
  { hidden: false, items: [item()] },
])

test('reelNext/reelPrev skip hidden items and whole hidden groups', () => {
  expect(reelNext(groups, { group: 0, item: 0 })).toEqual({ group: 0, item: 1 })
  // skips group 1's hidden first item
  expect(reelNext(groups, { group: 0, item: 1 })).toEqual({ group: 1, item: 1 })
  // skips the fully hidden group 2
  expect(reelNext(groups, { group: 1, item: 1 })).toEqual({ group: 3, item: 0 })
  expect(reelNext(groups, { group: 3, item: 0 })).toBeNull()

  expect(reelPrev(groups, { group: 3, item: 0 })).toEqual({ group: 1, item: 1 })
  expect(reelPrev(groups, { group: 1, item: 1 })).toEqual({ group: 0, item: 1 })
  expect(reelPrev(groups, { group: 0, item: 0 })).toBeNull()
})

test('grid mode steps whole groups and ignores visibility (preserved behavior)', () => {
  expect(gridNext(4, { group: 1, item: 1 })).toEqual({ group: 2, item: 0 }) // group 2 is hidden — still stepped to
  expect(gridNext(4, { group: 3, item: 0 })).toBeNull()
  expect(gridPrev({ group: 2, item: 0 })).toEqual({ group: 1, item: 0 })
  expect(gridPrev({ group: 0, item: 0 })).toBeNull()
})

test('first/last visible of group', () => {
  expect(isFirstVisibleOfGroup(groups, { group: 0, item: 0 })).toBe(true)
  expect(isLastVisibleOfGroup(groups, { group: 0, item: 0 })).toBe(false)
  expect(isLastVisibleOfGroup(groups, { group: 0, item: 1 })).toBe(true)
  // group 1's only visible item is both first and last
  expect(isFirstVisibleOfGroup(groups, { group: 1, item: 1 })).toBe(true)
  expect(isLastVisibleOfGroup(groups, { group: 1, item: 1 })).toBe(true)
})

test('reelAnchorScan accumulates item sizes with group gaps', () => {
  // visible walk: (0,0) y=0, (0,1) y=56, gap after -> (1,1) y=120, gap -> (3,0) y=184
  const scan = reelAnchorScan(groups, Infinity, 56, 8, { group: 0, item: 0 })
  expect(scan.hit).toBeNull()
  expect(scan.positions).toEqual([
    { ref: { group: 0, item: 0 }, y: 0 },
    { ref: { group: 0, item: 1 }, y: 56 },
    { ref: { group: 1, item: 1 }, y: 120 },
    { ref: { group: 3, item: 0 }, y: 184 },
  ])
})

test('reelAnchorScan early-returns the item at anchorY (positions truncated)', () => {
  const scan = reelAnchorScan(groups, 100, 56, 8, { group: 0, item: 0 })
  expect(scan.hit).toEqual({ group: 1, item: 1 }) // first item whose y (120) >= 100
  expect(scan.positions.length).toBe(3)
})

test('anchor exemption: a hidden anchor is walked unless hardHidden', () => {
  // anchor (1,0) is hidden -> exempt, appears in the walk
  const exempt = reelAnchorScan(groups, Infinity, 56, 8, { group: 1, item: 0 })
  expect(exempt.positions.some((p) => p.ref.group === 1 && p.ref.item === 0)).toBe(true)

  // anchor inside a fully hidden group is walked too
  const hiddenGroupAnchor = reelAnchorScan(groups, Infinity, 56, 8, { group: 2, item: 0 })
  expect(hiddenGroupAnchor.positions.some((p) => p.ref.group === 2 && p.ref.item === 0)).toBe(true)

  // but a hardHidden (server-filtered) anchor stays gone
  const hard = src([{ hidden: false, items: [item(true, true), item()] }])
  const hardScan = reelAnchorScan(hard, Infinity, 56, 8, { group: 0, item: 0 })
  expect(hardScan.positions.some((p) => p.ref.item === 0)).toBe(false)
})

const still: SwipeState = { direction: 'still', accumulated: 0 }
const NEXT = { group: 1, item: 0 }
const PREV = { group: 0, item: 0 }

test('swipe: tiny deltas at rest stay still', () => {
  const r = swipeStep(still.direction, still.accumulated, 2, NEXT, PREV, 60)
  expect(r.state).toEqual({ direction: 'still', accumulated: 0 })
  expect(r.navigate).toBeNull()
})

test('swipe: accumulating up past the threshold navigates and resets', () => {
  let state = still
  let navigate = null
  for (let i = 0; i < 3; i++) {
    const r = swipeStep(state.direction, state.accumulated, 25, NEXT, PREV, 60)
    state = r.state
    navigate = r.navigate ?? navigate
  }
  expect(navigate).toEqual(NEXT)
  expect(state).toEqual({ direction: 'still', accumulated: 0 })
})

test('swipe: no candidate rubber-bands to zero', () => {
  const r = swipeStep(still.direction, still.accumulated, 25, null, PREV, 60)
  expect(r.state.accumulated).toBe(0)
  expect(r.state.direction).toBe('still')
  expect(r.navigate).toBeNull()
})

test('swipe: reversing mid-swipe enters the returning phase, ease decays to rest', () => {
  let state = swipeStep(still.direction, still.accumulated, 25, NEXT, PREV, 60).state
  expect(state.direction).toBe('0->up')
  // opposing wheel input flips to up->0
  state = swipeStep(state.direction, state.accumulated, -10, NEXT, PREV, 60).state
  expect(state.direction).toBe('up->0')
  // zero input then decays by -2/step until rest
  let guard = 0
  while (state.direction !== 'still') {
    state = swipeStep(state.direction, state.accumulated, 0, NEXT, PREV, 60).state
    expect(++guard).toBeLessThan(100)
  }
  expect(state.accumulated).toBe(0)
})

test('swipe: downward mirror navigates to prev', () => {
  let state = still
  let navigate = null
  for (let i = 0; i < 3; i++) {
    const r = swipeStep(state.direction, state.accumulated, -25, NEXT, PREV, 60)
    state = r.state
    navigate = r.navigate ?? navigate
  }
  expect(navigate).toEqual(PREV)
})

test('anchorMorph keeps a constant total size', () => {
  expect(anchorMorph(0, 60, 68, 56)).toEqual({ current: 68, incoming: 56 })
  expect(anchorMorph(60, 60, 68, 56)).toEqual({ current: 56, incoming: 68 })
  const mid = anchorMorph(30, 60, 68, 56)
  expect(mid.current + mid.incoming).toBe(68 + 56)
  expect(anchorMorph(-60, 60, 68, 56).current).toBe(56) // magnitude-based
})

test('anchorTravelY eases from center toward the incoming slot', () => {
  expect(anchorTravelY(0, 60, 300, 56, 68, 8, false)).toBe(300)
  expect(anchorTravelY(60, 60, 300, 56, 68, 8, false)).toBe(300 - 56)
  expect(anchorTravelY(60, 60, 300, 56, 68, 8, true)).toBe(300 - 8 - 56)
  expect(anchorTravelY(-60, 60, 300, 56, 68, 8, false)).toBe(300 + 68)
  expect(anchorTravelY(-60, 60, 300, 56, 68, 8, true)).toBe(300 + 68 + 8)
})
