import { describe, expect, test } from 'bun:test'
import { feel } from './feel'
import {
  applyWheel,
  dominantAxis,
  jobRef,
  jumpToFrame,
  jumpToJob,
  makeFramesSource,
  makeJobsSource,
  resolvedFrame,
  stepFrame,
  stepJob,
} from './lightbox'
import type { Lightbox, Tile } from './model'

function tile(over: Partial<Tile> = {}): Tile {
  return {
    id: 's-1', slug: 's-1', scenes: 'p', state: 'done', seed: 1, startedAt: 0, endedAt: 1,
    frames: 10, stepsDone: 1, stepsTotal: 1, sizeX: 512, sizeY: 512, legacyDims: false,
    forkedFrom: null, imported: false, artifacts: [], failExcerpt: null, live: null, detail: null,
    ...over,
  }
}

function lb(frame: number | 'follow', sessionId = 's-1'): Lightbox {
  return {
    sessionId,
    frame,
    swipeX: { direction: 'still', accumulated: 0 },
    swipeY: { direction: 'still', accumulated: 0 },
    anchor: { x: 0, y: 0, sizeX: 100, sizeY: 100 },
  }
}

// A gallery: s-1 (newest, done), s-2 (rendering, live job), s-3 (frameless — skipped),
// s-4 (oldest, done). Tiles are newest-first, matching the gallery display order.
function gallery(): Tile[] {
  return [
    tile({ id: 's-1', frames: 10 }),
    tile({ id: 's-2', frames: 4, state: 'rendering' }),
    tile({ id: 's-3', frames: 0, state: 'failed' }),
    tile({ id: 's-4', frames: 2 }),
  ]
}

describe('makeFramesSource / resolvedFrame', () => {
  test('one group, N frames', () => {
    const t = tile({ frames: 7 })
    const source = makeFramesSource(t)
    expect(source.groups).toHaveLength(1)
    expect(source.itemCount(t)).toBe(7)
  })
  test("'follow' resolves to the newest frame", () => {
    expect(resolvedFrame(lb('follow'), tile({ frames: 7 }))).toBe(7)
    expect(resolvedFrame(lb(3), tile({ frames: 7 }))).toBe(3)
  })
  test("'follow' tracks a live frame landing; a pinned frame stays put", () => {
    // The live-follow rule at the state level: tile.frames grew 7 -> 8.
    expect(resolvedFrame(lb('follow'), tile({ frames: 8, state: 'rendering' }))).toBe(8)
    expect(resolvedFrame(lb(5), tile({ frames: 8, state: 'rendering' }))).toBe(5)
  })
})

describe('makeJobsSource / jobRef (job order derivation)', () => {
  test('one group per session, frameless sessions hidden', () => {
    const tiles = gallery()
    const source = makeJobsSource(tiles)
    expect(source.groups).toHaveLength(4)
    expect(source.isGroupHidden(tiles[2]!)).toBe(true) // s-3: no frames
    expect(source.isGroupHidden(tiles[1]!)).toBe(false) // s-2: rendering IS a live job
    expect(source.itemCount(tiles[0]!)).toBe(1)
  })
  test('jobRef finds the open session; unknown id throws', () => {
    expect(jobRef(gallery(), 's-2')).toEqual({ group: 1, item: 0 })
    expect(() => jobRef(gallery(), 'nope')).toThrow('unknown session')
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
  test('resets both axes to rest', () => {
    const primed: Lightbox = { ...lb(2), swipeX: { direction: '0->up', accumulated: 30 } }
    const next = jumpToFrame(primed, tile(), 5)
    expect(next.swipeX.accumulated).toBe(0)
    expect(next.swipeY.accumulated).toBe(0)
  })
})

describe('stepJob / jumpToJob (jobs axis)', () => {
  test('next/prev walk the gallery order', () => {
    expect(stepJob(lb(3, 's-1'), gallery(), 1).sessionId).toBe('s-2')
    expect(stepJob(lb('follow', 's-2'), gallery(), -1).sessionId).toBe('s-1')
  })
  test('frameless sessions are skipped', () => {
    expect(stepJob(lb('follow', 's-2'), gallery(), 1).sessionId).toBe('s-4') // over s-3
    expect(stepJob(lb(2, 's-4'), gallery(), -1).sessionId).toBe('s-2')
  })
  test('clamped at both ends of the job list', () => {
    expect(stepJob(lb(3, 's-1'), gallery(), -1).sessionId).toBe('s-1')
    expect(stepJob(lb(2, 's-4'), gallery(), 1).sessionId).toBe('s-4')
  })
  test('landing on a done job lands on its latest frame, pinned', () => {
    const next = stepJob(lb(3, 's-1'), gallery(), 1) // onto s-2 (rendering)
    expect(next.frame).toBe('follow')
    const back = stepJob(next, gallery(), -1) // back onto s-1 (done, 10 frames)
    expect(back.frame).toBe(10)
  })
  test('jumpToJob lands on the latest frame and resets both axes', () => {
    const primed: Lightbox = { ...lb(3, 's-1'), swipeY: { direction: '0->up', accumulated: 50 } }
    const next = jumpToJob(primed, gallery(), 's-4')
    expect(next.sessionId).toBe('s-4')
    expect(next.frame).toBe(2)
    expect(next.swipeX.accumulated).toBe(0)
    expect(next.swipeY.accumulated).toBe(0)
  })
  test('jumpToJob to a frameless or unknown session throws', () => {
    expect(() => jumpToJob(lb(3, 's-1'), gallery(), 's-3')).toThrow('unavailable')
    expect(() => jumpToJob(lb(3, 's-1'), gallery(), 'nope')).toThrow('unavailable')
  })
})

describe('dominantAxis', () => {
  test('at rest the larger delta wins; ties go to the jobs axis', () => {
    expect(dominantAxis(lb(3), 30, 4)).toBe('x')
    expect(dominantAxis(lb(3), 4, 30)).toBe('y')
    expect(dominantAxis(lb(3), 10, 10)).toBe('y')
    expect(dominantAxis(lb(3), 0, 0)).toBe('y')
  })
  test('a live gesture owns its axis even against a larger cross delta', () => {
    const liveX: Lightbox = { ...lb(3), swipeX: { direction: '0->up', accumulated: 20 } }
    expect(dominantAxis(liveX, 3, 500)).toBe('x')
    const liveY: Lightbox = { ...lb(3), swipeY: { direction: '0->up', accumulated: 20 } }
    expect(dominantAxis(liveY, 500, 3)).toBe('y')
  })
})

describe('applyWheel — frames axis (horizontal)', () => {
  test('accumulates below threshold without navigating', () => {
    const next = applyWheel(lb(5), gallery(), 20, 0)
    expect(next.frame).toBe(5)
    expect(next.swipeX.accumulated).toBe(20)
    expect(next.swipeX.direction).toBe('0->up')
    expect(next.swipeY.accumulated).toBe(0)
  })
  test('crossing the threshold navigates forward and resets', () => {
    const primed: Lightbox = { ...lb(5), swipeX: { direction: '0->up', accumulated: feel.swipeThreshold - 5 } }
    const next = applyWheel(primed, gallery(), 10, 0)
    expect(next.frame).toBe(6)
    expect(next.swipeX.accumulated).toBe(0)
  })
  test('backward navigation from follow pins to the previous frame', () => {
    const primed: Lightbox = {
      ...lb('follow', 's-2'),
      swipeX: { direction: '0->down', accumulated: -(feel.swipeThreshold - 5) },
    }
    const next = applyWheel(primed, gallery(), -10, 0) // s-2 renders with 4 frames
    expect(next.frame).toBe(3)
  })
  test('rubber-bands at the last frame', () => {
    const primed: Lightbox = { ...lb(10), swipeX: { direction: '0->up', accumulated: feel.swipeThreshold - 5 } }
    const next = applyWheel(primed, gallery(), 10, 0)
    expect(next.frame).toBe(10)
    expect(next.swipeX.accumulated).toBe(0) // null candidate pins accumulated at 0
  })
})

describe('applyWheel — jobs axis (vertical)', () => {
  test('accumulates below the job threshold without navigating', () => {
    const next = applyWheel(lb(5), gallery(), 0, 40)
    expect(next.sessionId).toBe('s-1')
    expect(next.frame).toBe(5)
    expect(next.swipeY.accumulated).toBe(40)
    expect(next.swipeX.accumulated).toBe(0)
  })
  test('crossing the job threshold lands on the next job at its latest frame', () => {
    const primed: Lightbox = { ...lb(5), swipeY: { direction: '0->up', accumulated: feel.jobSwipeThreshold - 5 } }
    const next = applyWheel(primed, gallery(), 0, 10)
    expect(next.sessionId).toBe('s-2') // rendering job — a live job counts
    expect(next.frame).toBe('follow') // latest frame of a rendering job follows
    expect(next.swipeY.accumulated).toBe(0)
  })
  test('navigation skips frameless sessions', () => {
    const primed: Lightbox = {
      ...lb('follow', 's-2'),
      swipeY: { direction: '0->up', accumulated: feel.jobSwipeThreshold - 5 },
    }
    const next = applyWheel(primed, gallery(), 0, 10)
    expect(next.sessionId).toBe('s-4') // s-3 has no frames
    expect(next.frame).toBe(2)
  })
  test('rubber-bands at the newest and oldest job', () => {
    const up: Lightbox = { ...lb(5, 's-1'), swipeY: { direction: '0->down', accumulated: -(feel.jobSwipeThreshold - 5) } }
    const stayNewest = applyWheel(up, gallery(), 0, -10)
    expect(stayNewest.sessionId).toBe('s-1')
    expect(stayNewest.swipeY.accumulated).toBe(0)
    const down: Lightbox = { ...lb(2, 's-4'), swipeY: { direction: '0->up', accumulated: feel.jobSwipeThreshold - 5 } }
    const stayOldest = applyWheel(down, gallery(), 0, 10)
    expect(stayOldest.sessionId).toBe('s-4')
    expect(stayOldest.swipeY.accumulated).toBe(0)
  })
  test('a single oversized vertical delta navigates one job and leaves the frame axis at rest', () => {
    const next = applyWheel(lb(5), gallery(), 0, feel.jobSwipeThreshold + 10)
    expect(next.sessionId).toBe('s-2')
    expect(next.swipeX.accumulated).toBe(0)
  })
})
