// @cs
// create/core/lightbox: the reel source (one group: the session; items: frames 1..N),
// the 0-based-item <-> 1-based-frame conversion (which lives HERE only, asserted), and
// the scrub transitions with the pin/follow rule: setting frame to tile.frames while the
// session renders -> 'follow' (pin releases at the newest frame); any backward step pins.
//
// String/JSON domain (tagged Lightbox state) — outside freerange's numeric subset;
// lightbox.test.ts is the checked surface. Numeric swipe math delegates to the kit's
// checked swipeStep.
//
// functions:
//   makeReelSource(tile) -> ReelSource<Tile>
//   resolvedFrame(lightbox, tile) -> number          1-based; 'follow' -> tile.frames
//   applyWheel(lightbox, tile, deltaY) -> Lightbox   one swipe-machine step
//   stepFrame(lightbox, tile, delta: -1|1) -> Lightbox
//   jumpToFrame(lightbox, tile, frame) -> Lightbox
// @/cs
import { type ItemRef, reelNext, reelPrev, type ReelSource, swipeStep } from '@kit/reel-strip/core'
import { feel } from './feel'
import type { Lightbox, Tile } from './model'

export function makeReelSource(tile: Tile): ReelSource<Tile> {
  return {
    groups: [tile],
    isGroupHidden: () => false,
    itemCount: () => tile.frames,
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

export function applyWheel(lightbox: Lightbox, tile: Tile, deltaY: number): Lightbox {
  const source = makeReelSource(tile)
  const ref = refOf(resolvedFrame(lightbox, tile))
  const result = swipeStep(
    lightbox.swipe.direction,
    lightbox.swipe.accumulated,
    deltaY,
    reelNext(source, ref),
    reelPrev(source, ref),
    feel.swipeThreshold,
  )
  const frame = result.navigate == null ? lightbox.frame : frameStateFor(result.navigate.item + 1, tile)
  return { ...lightbox, frame, swipe: result.state }
}

export function stepFrame(lightbox: Lightbox, tile: Tile, delta: -1 | 1): Lightbox {
  const source = makeReelSource(tile)
  const ref = refOf(resolvedFrame(lightbox, tile))
  const target = delta === 1 ? reelNext(source, ref) : reelPrev(source, ref)
  if (target == null) return lightbox
  return { ...lightbox, frame: frameStateFor(target.item + 1, tile), swipe: { direction: 'still', accumulated: 0 } }
}

export function jumpToFrame(lightbox: Lightbox, tile: Tile, frame: number): Lightbox {
  // Caller contract (prose — the record-copy body is outside freerange's subset):
  // 1 <= frame <= tile.frames; callers pass strip indices scanned from this same tile.
  return { ...lightbox, frame: frameStateFor(frame, tile), swipe: { direction: 'still', accumulated: 0 } }
}
