// @cs
// create/core/lightbox: the two reel sources (frames axis: one group = the open session,
// items = frames 1..N; jobs axis: one group per session in gallery order, frameless
// sessions hidden), the 0-based-item <-> 1-based-frame conversion (which lives HERE only,
// asserted), and the scrub transitions.
//
// The pin/follow rule: landing on frame tile.frames while the session renders -> 'follow'
// (pin releases at the newest frame); any backward step pins. Landing on a JOB always
// lands on its latest frame — so a rendering job lands following.
//
// The dominant-axis rule: one swipe machine per axis, and a live gesture owns its axis
// until its accumulator decays to rest — at most one accumulator is non-zero at a time.
// From rest, the larger |delta| picks the axis (ties go to the jobs axis: mouse wheels
// only emit deltaY, so a plain wheel pages jobs).
//
// String/JSON domain (tagged Lightbox state) — outside freerange's numeric subset;
// lightbox.test.ts is the checked surface. Numeric swipe math delegates to the kit's
// checked swipeStep.
//
// functions:
//   makeFramesSource(tile) -> ReelSource<Tile>
//   makeJobsSource(tiles) -> ReelSource<Tile>        frameless sessions hidden
//   resolvedFrame(lightbox, tile) -> number          1-based; 'follow' -> tile.frames
//   jobRef(tiles, sessionId) -> ItemRef              the open job's jobs-axis ref
//   dominantAxis(lightbox, deltaX, deltaY) -> 'x' | 'y'
//   applyWheel(lightbox, tiles, deltaX, deltaY) -> Lightbox   one swipe-machine step,
//                                                   dominant axis only
//   stepFrame(lightbox, tile, delta: -1|1) -> Lightbox
//   jumpToFrame(lightbox, tile, frame) -> Lightbox
//   stepJob(lightbox, tiles, delta: -1|1) -> Lightbox
//   jumpToJob(lightbox, tiles, sessionId) -> Lightbox
// @/cs
import { type ItemRef, reelNext, reelPrev, type ReelSource, swipeStep } from '@kit/reel-strip/core'
import { feel } from './feel'
import { findTile, type Lightbox, type LightboxSwipe, type Tile } from './model'

export function makeFramesSource(tile: Tile): ReelSource<Tile> {
  return {
    groups: [tile],
    isGroupHidden: () => false,
    itemCount: () => tile.frames,
    isItemHidden: () => false,
    isItemHardHidden: () => false,
  }
}

// The jobs axis: one group per session in gallery display order (tiles newest-first),
// one item each. A session without frames has nothing to show — hidden, so job
// navigation and the jobs reel skip it. Rendering sessions with frames are live jobs
// and stay in.
export function makeJobsSource(tiles: readonly Tile[]): ReelSource<Tile> {
  return {
    groups: tiles,
    isGroupHidden: (tile) => tile.frames < 1,
    itemCount: () => 1,
    isItemHidden: () => false,
    isItemHardHidden: () => false,
  }
}

// 'follow' tracks the newest frame. The lightbox only opens on frames >= 1 and frames
// never decreases, so a resolved frame is always a valid 1-based index.
export function resolvedFrame(lightbox: Lightbox, tile: Tile): number {
  // Caller contract (prose — the union-typed field is outside freerange's assert forms):
  // tile.frames >= 1 (the lightbox only opens on tiles with frames), and
  // 1 <= frame <= tile.frames holds by construction — every navigation routes through
  // the reel source, which only yields valid items.
  return lightbox.frame === 'follow' ? tile.frames : lightbox.frame
}

// The pin/follow rule, applied to every navigation result.
function frameStateFor(frame: number, tile: Tile): number | 'follow' {
  if (frame === tile.frames && tile.state === 'rendering') return 'follow'
  return frame
}

// frame (1-based) = item (0-based) + 1 — the conversion lives in this file only.
function refOf(frame: number): ItemRef {
  console.assert(frame >= 1)
  return { group: 0, item: frame - 1 }
}

// The open job's jobs-axis ref. The "open surface => its tile exists" invariant is
// modeled in core/model (removeTile / reconcileSessions close the lightbox), so a miss
// here is a bug.
export function jobRef(tiles: readonly Tile[], sessionId: string): ItemRef {
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i]!.id === sessionId) return { group: i, item: 0 }
  }
  throw new Error(`lightbox on unknown session ${sessionId}`)
}

function stillSwipe(): LightboxSwipe {
  return { direction: 'still', accumulated: 0 }
}

// Landing on a job always lands on its LATEST frame; a rendering job's latest is
// 'follow' (frameStateFor), so switching onto a live job tracks new frames as they land.
function landOnJob(lightbox: Lightbox, tile: Tile): Lightbox {
  return {
    ...lightbox,
    sessionId: tile.id,
    frame: frameStateFor(tile.frames, tile),
    swipeX: stillSwipe(),
    swipeY: stillSwipe(),
  }
}

// A live gesture owns its axis until its accumulator decays to rest (trackpads leak
// small cross-axis deltas mid-gesture — those must not hop jobs during a frame scrub).
// From rest, the larger |delta| wins; ties go to 'y' (mouse wheels emit deltaY only).
export function dominantAxis(lightbox: Lightbox, deltaX: number, deltaY: number): 'x' | 'y' {
  if (lightbox.swipeX.accumulated !== 0) return 'x'
  if (lightbox.swipeY.accumulated !== 0) return 'y'
  return Math.abs(deltaX) > Math.abs(deltaY) ? 'x' : 'y'
}

// One swipe-machine step (per frame: this frame's wheel input, or zero-delta decay) on
// the dominant axis only. The other axis's accumulator is zero by construction, so
// skipping it is not a dropped decay step; its wheel delta this frame is deliberately
// discarded (the dominance tradeoff).
export function applyWheel(lightbox: Lightbox, tiles: readonly Tile[], deltaX: number, deltaY: number): Lightbox {
  const tile = findTile(tiles, lightbox.sessionId)
  if (tile == null) throw new Error(`lightbox on unknown session ${lightbox.sessionId}`)
  switch (dominantAxis(lightbox, deltaX, deltaY)) {
    case 'x': {
      const source = makeFramesSource(tile)
      const ref = refOf(resolvedFrame(lightbox, tile))
      const result = swipeStep(
        lightbox.swipeX.direction,
        lightbox.swipeX.accumulated,
        deltaX,
        reelNext(source, ref),
        reelPrev(source, ref),
        feel.swipeThreshold,
      )
      const frame = result.navigate == null ? lightbox.frame : frameStateFor(result.navigate.item + 1, tile)
      return { ...lightbox, frame, swipeX: result.state }
    }
    case 'y': {
      const source = makeJobsSource(tiles)
      const ref = jobRef(tiles, lightbox.sessionId)
      const result = swipeStep(
        lightbox.swipeY.direction,
        lightbox.swipeY.accumulated,
        deltaY,
        reelNext(source, ref),
        reelPrev(source, ref),
        feel.jobSwipeThreshold,
      )
      if (result.navigate == null) return { ...lightbox, swipeY: result.state }
      // Navigate resets the machine to rest, and landOnJob resets both axes anyway.
      return landOnJob(lightbox, tiles[result.navigate.group]!)
    }
  }
}

export function stepFrame(lightbox: Lightbox, tile: Tile, delta: -1 | 1): Lightbox {
  const source = makeFramesSource(tile)
  const ref = refOf(resolvedFrame(lightbox, tile))
  const target = delta === 1 ? reelNext(source, ref) : reelPrev(source, ref)
  if (target == null) return lightbox
  return { ...lightbox, frame: frameStateFor(target.item + 1, tile), swipeX: stillSwipe(), swipeY: stillSwipe() }
}

export function jumpToFrame(lightbox: Lightbox, tile: Tile, frame: number): Lightbox {
  // Caller contract (prose — the record-copy body is outside freerange's subset):
  // 1 <= frame <= tile.frames; callers pass strip indices scanned from this same tile.
  return { ...lightbox, frame: frameStateFor(frame, tile), swipeX: stillSwipe(), swipeY: stillSwipe() }
}

export function stepJob(lightbox: Lightbox, tiles: readonly Tile[], delta: -1 | 1): Lightbox {
  const source = makeJobsSource(tiles)
  const ref = jobRef(tiles, lightbox.sessionId)
  const target = delta === 1 ? reelNext(source, ref) : reelPrev(source, ref)
  if (target == null) return lightbox
  return landOnJob(lightbox, tiles[target.group]!)
}

export function jumpToJob(lightbox: Lightbox, tiles: readonly Tile[], sessionId: string): Lightbox {
  const tile = findTile(tiles, sessionId)
  // Callers pass ids scanned from the jobs reel, which only renders sessions with
  // frames — a miss or a frameless target is a bug, not a UX state.
  if (tile == null || tile.frames < 1) throw new Error(`job jump to unavailable session ${sessionId}`)
  return landOnJob(lightbox, tile)
}
