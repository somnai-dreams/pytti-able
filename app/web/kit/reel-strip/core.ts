// @cs
// reel-strip/core: film-strip navigation + wheel-swipe state machine + anchor-morph
// geometry for a lightbox reel over grouped items (a group = one generation job's
// images). Pure, immediate-mode; extracted from LightboxDesktop + dataHelpers.
//
// types:
//   ItemRef   = { group, item }                     // indices into the source's groups
//   ReelSource<G> = { groups, isGroupHidden(g), itemCount(g), isItemHidden(g, i),
//                     isItemHardHidden(g, i) }
//     accessor view over YOUR data (no adapter arrays — allocation-free navigation).
//     hidden: filtered; hardHidden: server-filtered — never anchor-exempt
//   SwipeDirection = 'still'|'0->up'|'up->0'|'0->down'|'down->0'
//   SwipeState = { direction, accumulated }         // accumulated deltaY, sign = direction
//
// navigation (visibility = !isGroupHidden && !isItemHidden):
//   reelNext(source, ref) / reelPrev(source, ref) -> ItemRef | null
//     next/prev visible item across groups; bounded loops (no while(true))
//   gridNext(groupCount, ref) / gridPrev(ref) -> ItemRef | null
//     grid mode steps whole GROUPS ({group±1, item:0}), ignoring visibility — preserved
//     app behavior, do not "fix" to skip hidden groups
//   isFirstVisibleOfGroup(source, ref) / isLastVisibleOfGroup(source, ref) -> boolean
//
// anchor scan (the strip's y-walk):
//   reelAnchorScan(source, anchorY, itemSize, groupGapY, anchor)
//     -> { positions: {ref, y}[], hit: ItemRef | null }
//     walks visible items accumulating y (groupGapY after each group's last visible item),
//     recording each item's strip y; early-returns with the item at y >= anchorY (positions
//     list is truncated at the hit — preserved behavior). THE ANCHOR EXEMPTION: the anchor
//     item is walked even when it (or its group) is hidden, UNLESS hardHidden — a focused
//     image that was just filtered must not vanish from the strip.
//
// swipe machine:
//   swipeStep(direction, accumulated, deltaY, next, prev, threshold)
//     -> { state: SwipeState, navigate: ItemRef | null }
//     direction transitions flip on |deltaY| >= 2 against the current direction; zero
//     deltaY decays accumulated by ±2 (ease). Crossing ±threshold with a candidate
//     navigates and resets; a null candidate pins accumulated at 0 (rubber-band stop).
//     Candidates are passed in as ItemRef | null so the caller picks reel vs grid mode.
//
// morph geometry:
//   anchorMorph(accumulated, threshold, anchorSize, itemSize) -> { current, incoming }
//     the focused thumbnail shrinks anchorSize -> itemSize as |accumulated| approaches the
//     threshold while the incoming one grows; current + incoming = anchorSize + itemSize
//     by construction (constant total prevents strip height jitter mid-swipe)
//   anchorTravelY(accumulated, threshold, centerY, itemSize, groupGapY, leavingGroupEdge)
//     the focused thumbnail's y during a swipe: eases from centered toward the incoming
//     item's slot, one extra groupGapY when crossing a group boundary
// @/cs

export type ItemRef = { group: number, item: number }

export type ReelSource<G> = {
  groups: readonly G[]
  isGroupHidden: (group: G) => boolean
  itemCount: (group: G) => number
  isItemHidden: (group: G, item: number) => boolean
  isItemHardHidden: (group: G, item: number) => boolean
}

export type SwipeDirection = 'still' | '0->up' | 'up->0' | '0->down' | 'down->0'

export type SwipeState = { direction: SwipeDirection, accumulated: number }

// Wheel deltas at or below this magnitude are treated as noise at rest, and this is also
// the per-frame ease that decays a released swipe back to rest. Input-hardware
// calibration, not product feel — hence a constant, not a mjFeel entry.
export const WHEEL_NOISE_FLOOR = 2

// --- same-file numeric kernel (freerange follows only same-file calls; the canonical
// copy lives in @kit/midui/num — keep byte-identical)
function remap(value: number, oldMin: number, oldMax: number, newMin: number, newMax: number): number {
  const oldSpan = oldMax - oldMin
  if (oldSpan === 0) return (newMin + newMax) / 2
  return (value - oldMin) / oldSpan * (newMax - newMin) + newMin
}
// ---

export function reelNext<G>(source: ReelSource<G>, ref: ItemRef): ItemRef | null {
  const groups = source.groups
  for (let g = ref.group; g < groups.length; g++) {
    const group = groups[g]!
    if (source.isGroupHidden(group)) continue
    const start = g === ref.group ? ref.item + 1 : 0
    const count = source.itemCount(group)
    for (let item = start; item < count; item++) {
      if (!source.isItemHidden(group, item)) return { group: g, item }
    }
  }
  return null
}

export function reelPrev<G>(source: ReelSource<G>, ref: ItemRef): ItemRef | null {
  const groups = source.groups
  for (let g = ref.group; g >= 0; g--) {
    const group = groups[g]!
    if (source.isGroupHidden(group)) continue
    const start = g === ref.group ? ref.item - 1 : source.itemCount(group) - 1
    for (let item = start; item >= 0; item--) {
      if (!source.isItemHidden(group, item)) return { group: g, item }
    }
  }
  return null
}

// Grid mode steps whole groups regardless of visibility — preserved app behavior.
export function gridNext(groupCount: number, ref: ItemRef): ItemRef | null {
  console.assert(Number.isInteger(groupCount))
  console.assert(groupCount >= 0)
  return ref.group < groupCount - 1 ? { group: ref.group + 1, item: 0 } : null
}

export function gridPrev(ref: ItemRef): ItemRef | null {
  return ref.group > 0 ? { group: ref.group - 1, item: 0 } : null
}

export function isLastVisibleOfGroup<G>(source: ReelSource<G>, ref: ItemRef): boolean {
  const next = reelNext(source, ref)
  return next == null || next.group !== ref.group
}

export function isFirstVisibleOfGroup<G>(source: ReelSource<G>, ref: ItemRef): boolean {
  const prev = reelPrev(source, ref)
  return prev == null || prev.group !== ref.group
}

export type ReelAnchorScan = {
  positions: { ref: ItemRef, y: number }[]
  hit: ItemRef | null
}

export function reelAnchorScan<G>(
  source: ReelSource<G>,
  anchorY: number,
  itemSize: number,
  groupGapY: number,
  anchor: ItemRef,
): ReelAnchorScan {
  const positions: { ref: ItemRef, y: number }[] = []
  const groups = source.groups
  let y = 0
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g]!
    const groupHidden = source.isGroupHidden(group)
    // A hidden group is skipped wholesale — unless it's the anchor's group, whose
    // exempted anchor item must still be walked.
    if (groupHidden && g !== anchor.group) continue

    const count = source.itemCount(group)
    for (let item = 0; item < count; item++) {
      const isAnchor = g === anchor.group && item === anchor.item
      const itemHidden = groupHidden || source.isItemHidden(group, item)
      const anchorExempt = isAnchor && !source.isItemHardHidden(group, item)
      if (itemHidden && !anchorExempt) continue

      positions.push({ ref: { group: g, item }, y })
      if (y >= anchorY) {
        return { positions, hit: { group: g, item } }
      }

      y += itemSize
      if (isLastVisibleOfGroup(source, { group: g, item })) {
        y += groupGapY
      }
    }
  }
  return { positions, hit: null }
}

// Direction transitions: from rest any |deltaY| > 2 starts a swipe; mid-swipe an
// opposing |deltaY| >= 2 flips into the returning phase. A returned-value helper rather
// than a `let` assigned in branches — uninitialized declarations are outside freerange's
// subset.
export function nextSwipeDirection(prevDirection: SwipeDirection, accumulated: number, deltaY: number): SwipeDirection {
  if (accumulated === 0) {
    if (Math.abs(deltaY) <= WHEEL_NOISE_FLOOR) return 'still'
    return deltaY > 0 ? '0->up' : '0->down'
  }
  if (prevDirection === '0->up' && deltaY <= -WHEEL_NOISE_FLOOR) return 'up->0'
  if (prevDirection === 'up->0' && deltaY >= WHEEL_NOISE_FLOOR) return '0->up'
  if (prevDirection === '0->down' && deltaY >= WHEEL_NOISE_FLOOR) return 'down->0'
  if (prevDirection === 'down->0' && deltaY <= -WHEEL_NOISE_FLOOR) return '0->down'
  return prevDirection
}

// One step of the wheel-swipe machine. deltaY is this frame's (possibly zero) wheel
// input; next/prev are the navigation candidates for the CURRENT mode (reel or grid).
// direction/accumulated are flat parameters (not a SwipeState record): the app stores
// them as two separate states anyway, and parameter-level pixel bounds are what lets
// freerange verify the accumulation stays finite.
export function swipeStep(
  direction: SwipeDirection,
  accumulated: number,
  deltaY: number,
  next: ItemRef | null,
  prev: ItemRef | null,
  threshold: number,
): { state: SwipeState, navigate: ItemRef | null } {
  console.assert(accumulated >= -16777216)
  console.assert(accumulated <= 16777216)
  console.assert(deltaY >= -16777216)
  console.assert(deltaY <= 16777216)
  console.assert(threshold >= 1)
  console.assert(threshold <= 16777216)

  const newDirection = nextSwipeDirection(direction, accumulated, deltaY)

  // zero input decays toward the direction's resting point
  const ease =
    newDirection === 'still' ? 0 : newDirection === '0->up' || newDirection === 'down->0' ? WHEEL_NOISE_FLOOR : -WHEEL_NOISE_FLOOR
  const normalizedDeltaY = deltaY === 0 ? ease : deltaY

  const resolved = resolveSwipe(newDirection, accumulated + normalizedDeltaY, next, prev, threshold)
  return {
    state: { direction: resolved.accumulated === 0 ? 'still' : newDirection, accumulated: resolved.accumulated },
    navigate: resolved.navigate,
  }
}

// An if-return chain rather than the codebase-preferred exhaustive switch: freerange
// needs a syntactic return on every path (a fully-returning switch doesn't count), and
// switch breaks are outside its subset. The final branch is '0->down' by elimination.
function resolveSwipe(
  direction: SwipeDirection,
  accumulated: number,
  next: ItemRef | null,
  prev: ItemRef | null,
  threshold: number,
): { accumulated: number, navigate: ItemRef | null } {
  if (direction === 'still') return { accumulated: 0, navigate: null }
  if (direction === 'up->0') return { accumulated: accumulated <= 0 ? 0 : accumulated, navigate: null }
  if (direction === 'down->0') return { accumulated: accumulated >= 0 ? 0 : accumulated, navigate: null }
  if (direction === '0->up') {
    if (next == null) return { accumulated: 0, navigate: null } // rubber-band: nothing to navigate to
    if (accumulated >= threshold) return { accumulated: 0, navigate: next }
    return { accumulated, navigate: null }
  }
  if (prev == null) return { accumulated: 0, navigate: null }
  if (accumulated <= -threshold) return { accumulated: 0, navigate: prev }
  return { accumulated, navigate: null }
}

// The focused thumbnail shrinks toward itemSize as the swipe progresses while the
// incoming one grows from itemSize toward anchorSize; the two always sum to
// anchorSize + itemSize (constant total prevents strip height jitter mid-swipe).
export function anchorMorph(
  accumulated: number,
  threshold: number,
  anchorSize: number,
  itemSize: number,
): { current: number, incoming: number } {
  console.assert(threshold >= 1)
  const current = remap(Math.abs(accumulated), 0, threshold, anchorSize, itemSize)
  const incoming = anchorSize + itemSize - current
  return { current, incoming }
}

// The focused thumbnail's y during a swipe: centered at rest, easing toward the
// incoming item's slot — up past its own size (plus the group gap when it's the last
// visible of its group), or down past the anchor slot (plus the gap when first).
export function anchorTravelY(
  accumulated: number,
  threshold: number,
  centerY: number,
  itemSize: number,
  anchorSize: number,
  groupGapY: number,
  leavingGroupEdge: boolean,
): number {
  // Pixel-domain bounds double as the proof that the remap inputs below stay finite.
  console.assert(threshold >= 1)
  console.assert(centerY >= -16777216)
  console.assert(centerY <= 16777216)
  console.assert(itemSize >= 0)
  console.assert(itemSize <= 16777216)
  console.assert(anchorSize >= 0)
  console.assert(anchorSize <= 16777216)
  console.assert(groupGapY >= 0)
  console.assert(groupGapY <= 16777216)
  const edgeGap = leavingGroupEdge ? groupGapY : 0
  if (accumulated > 0) {
    return remap(accumulated, 0, threshold, centerY, centerY - edgeGap - itemSize)
  }
  if (accumulated < 0) {
    return remap(accumulated, 0, -threshold, centerY, centerY + anchorSize + edgeGap)
  }
  return centerY
}
