import { expect, test } from 'bun:test'
import {
  clampPercent,
  argMinRounded,
  center,
  clamp,
  fit,
  fract,
  hash11,
  hash21,
  hash31,
  insideInclusive,
  lessEqual,
  minIndex,
  mix,
  overlapArea,
  overlapInclusive,
  remap,
  remapReverso,
} from './num'
import { msPerAnimationStep, spring, springGoToEnd, springMostlyDone, springStep, springStepCount } from './motion'

test('remap maps across ranges and handles a degenerate source span', () => {
  expect(remap(5, 0, 10, 0, 100)).toBe(50)
  expect(remap(0, 0, 10, 100, 200)).toBe(100)
  expect(remap(15, 0, 10, 0, 100)).toBe(150) // extrapolates, doesn't clamp
  expect(remap(3, 7, 7, 0, 100)).toBe(50) // zero span -> new midpoint, no NaN
})

test('remapReverso inverts remap', () => {
  const mapped = remap(3, 0, 10, 100, 200)
  expect(remapReverso(mapped, 0, 10, 100, 200)).toBeCloseTo(3)
  expect(remapReverso(5, 0, 10, 7, 7)).toBe(5) // zero new span -> old midpoint
})

test('clamp, mix, fract, lessEqual', () => {
  expect(clamp(0, -5, 10)).toBe(0)
  expect(clamp(0, 15, 10)).toBe(10)
  expect(clamp(0, 5, 10)).toBe(5)
  expect(mix(0, 10, 0.25)).toBe(2.5)
  expect(fract(3.75)).toBe(0.75)
  expect(fract(-0.25)).toBe(0.75)
  expect(lessEqual(1, 2, 3)).toBe(true)
  expect(lessEqual(1, 4, 3)).toBe(false)
})

test('clampPercent handles NaN and clamps to the percentage range', () => {
  expect(clampPercent(Number.NaN)).toBe(0)
  expect(clampPercent(-1)).toBe(0)
  expect(clampPercent(50)).toBe(50)
  expect(clampPercent(101)).toBe(100)
})

test('center accounts for asymmetric insets', () => {
  expect(center(50, 100)).toBe(25)
  // container 100 with insets 20/0: usable band is [20,100], center 50-wide at 35
  expect(center(50, 100, 20, 0)).toBe(35)
})

test('fit returns the widest x that preserves aspect ratio', () => {
  expect(fit(2, 100, 100)).toBe(100) // wide image, width-bound: 100 wide, 50 tall
  expect(fit(0.5, 100, 100)).toBe(50) // tall image, height-bound: 50 wide, 100 tall
})

test('point and rect predicates are edge-inclusive', () => {
  expect(insideInclusive(10, 10, 10, 10, 5, 5)).toBe(true) // corner
  expect(insideInclusive(15, 15, 10, 10, 5, 5)).toBe(true) // opposite corner
  expect(insideInclusive(16, 15, 10, 10, 5, 5)).toBe(false)
  expect(overlapInclusive(0, 0, 10, 10, 10, 10, 5, 5)).toBe(true) // touching edges count
  expect(overlapInclusive(0, 0, 10, 10, 11, 11, 5, 5)).toBe(false)
})

test('overlapArea returns intersection area, 0 when disjoint or merely touching', () => {
  const a = { left: 0, top: 0, right: 10, bottom: 10 }
  expect(overlapArea(a, { left: 5, top: 5, right: 15, bottom: 15 })).toBe(25)
  expect(overlapArea(a, { left: 10, top: 0, right: 20, bottom: 10 })).toBe(0) // touching
  expect(overlapArea(a, { left: 11, top: 11, right: 20, bottom: 20 })).toBe(0)
})

test('minIndex and argMinRounded', () => {
  expect(minIndex([3, 1, 2])).toBe(1)
  expect(minIndex([])).toBe(0)
  // 100.001 vs 100.0004: raw minIndex flips to the second, rounded comparison keeps the first
  expect(minIndex([100.001, 100.0004])).toBe(1)
  expect(argMinRounded([100.001, 100.0004])).toBe(0)
  expect(argMinRounded([3, 1, 2])).toBe(1)
})

test('hashes are deterministic and land in [0,1)', () => {
  for (const p of [0, 1, 42.5, 123456.789]) {
    const h1 = hash11(p)
    expect(h1).toBeGreaterThanOrEqual(0)
    expect(h1).toBeLessThan(1)
    expect(hash11(p)).toBe(h1)
    const h2 = hash21(p)
    const h3 = hash31(p)
    for (const v of [h2.x, h2.y, h3.x, h3.y, h3.z]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  }
})

test('spring converges to its destination', () => {
  const s = spring(0, 100)
  let steps = 0
  while (!springMostlyDone(s)) {
    springStep(s)
    steps++
    expect(steps).toBeLessThan(10_000) // must converge, not oscillate forever
  }
  expect(s.pos).toBeCloseTo(100, 1)
  expect(Math.abs(s.v)).toBeLessThan(0.01)
})

test('springGoToEnd snaps', () => {
  const s = spring(0, 100)
  springStep(s)
  springGoToEnd(s)
  expect(s.pos).toBe(100)
  expect(s.v).toBe(0)
  expect(springMostlyDone(s)).toBe(true)
})

test('springStepCount floors to whole steps and caps catch-up', () => {
  expect(springStepCount(0, 60)).toBe(0)
  expect(springStepCount(msPerAnimationStep - 0.1, 60)).toBe(0)
  expect(springStepCount(16.6, 60)).toBe(2) // one 60fps frame -> 2 whole 6ms steps
  expect(springStepCount(100_000, 60)).toBe(60) // long pause -> capped, not thousands
})
