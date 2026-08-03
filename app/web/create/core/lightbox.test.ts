import { describe, expect, test } from 'bun:test'
import { feel } from './feel'
import { applyWheel, jumpToFrame, makeReelSource, resolvedFrame, stepFrame } from './lightbox'
import type { Lightbox, Tile } from './model'

function tile(over: Partial<Tile> = {}): Tile {
  return {
    id: 's-1', slug: 's-1', scenes: 'p', state: 'done', seed: 1, startedAt: 0, endedAt: 1,
    frames: 10, stepsDone: 1, stepsTotal: 1, sizeX: 512, sizeY: 512, legacyDims: false,
    forkedFrom: null, imported: false, artifacts: [], failExcerpt: null, live: null, detail: null,
    ...over,
  }
}

function lb(frame: number | 'follow'): Lightbox {
  return { sessionId: 's-1', frame, swipe: { direction: 'still', accumulated: 0 }, anchor: { x: 0, y: 0, sizeX: 100, sizeY: 100 } }
}

describe('makeReelSource / resolvedFrame', () => {
  test('one group, N frames', () => {
    const t = tile({ frames: 7 })
    const source = makeReelSource(t)
    expect(source.groups).toHaveLength(1)
    expect(source.itemCount(t)).toBe(7)
  })
  test("'follow' resolves to the newest frame", () => {
    expect(resolvedFrame(lb('follow'), tile({ frames: 7 }))).toBe(7)
    expect(resolvedFrame(lb(3), tile({ frames: 7 }))).toBe(3)
  })
})

describe('stepFrame (pin/follow rule)', () => {
  test('backward from follow pins', () => {
    const next = stepFrame(lb('follow'), tile({ frames: 10, state: 'rendering' }), -1)
    expect(next.frame).toBe(9)
  })
  test('forward to the newest frame while rendering refollows', () => {
    const next = stepFrame(lb(9), tile({ frames: 10, state: 'rendering' }), 1)
    expect(next.frame).toBe('follow')
  })
  test('forward to the newest frame when done stays a concrete pin', () => {
    const next = stepFrame(lb(9), tile({ frames: 10, state: 'done' }), 1)
    expect(next.frame).toBe(10)
  })
  test('clamped at both ends', () => {
    expect(stepFrame(lb(1), tile(), -1).frame).toBe(1)
    expect(stepFrame(lb(10), tile({ state: 'done' }), 1).frame).toBe(10)
  })
})

describe('jumpToFrame', () => {
  test('strip click jumps; newest-while-rendering follows', () => {
    expect(jumpToFrame(lb(2), tile(), 5).frame).toBe(5)
    expect(jumpToFrame(lb(2), tile({ state: 'rendering' }), 10).frame).toBe('follow')
  })
})

describe('applyWheel', () => {
  test('accumulates below threshold without navigating', () => {
    const next = applyWheel(lb(5), tile(), 20)
    expect(next.frame).toBe(5)
    expect(next.swipe.accumulated).toBe(20)
    expect(next.swipe.direction).toBe('0->up')
  })
  test('crossing the threshold navigates forward and resets', () => {
    const primed: Lightbox = { ...lb(5), swipe: { direction: '0->up', accumulated: feel.swipeThreshold - 5 } }
    const next = applyWheel(primed, tile(), 10)
    expect(next.frame).toBe(6)
    expect(next.swipe.accumulated).toBe(0)
  })
  test('backward navigation from follow pins to the previous frame', () => {
    const primed: Lightbox = { ...lb('follow'), swipe: { direction: '0->down', accumulated: -(feel.swipeThreshold - 5) } }
    const next = applyWheel(primed, tile({ frames: 10, state: 'rendering' }), -10)
    expect(next.frame).toBe(9)
  })
  test('rubber-bands at the last frame', () => {
    const primed: Lightbox = { ...lb(10), swipe: { direction: '0->up', accumulated: feel.swipeThreshold - 5 } }
    const next = applyWheel(primed, tile({ frames: 10, state: 'done' }), 10)
    expect(next.frame).toBe(10)
    expect(next.swipe.accumulated).toBe(0) // null candidate pins accumulated at 0
  })
})
