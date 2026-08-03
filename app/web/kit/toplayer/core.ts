// @cs
// toplayer/core: floating UI as data. The doctrine (see README): the store computes ONE
// flat list of top-layer surfaces per frame — anchor geometry from layout data, stacking
// from a Z-ladder — and the binding renders that list once at the root. No per-surface
// portals, no mount-gated teleports, no selector queries.
//
// types:
//   Surface<View> = { key, layer, view }    view is YOUR payload type (never a framework node)
//   CursorPlacement = { side: 'below', left, top } | { side: 'above', left, bottom }
//     bottom is distance from the viewport bottom (bottom-anchored surfaces keep growing
//     upward from a fixed edge, so content height changes don't shift the anchor corner)
//
// functions:
//   orderSurfaces(surfaces) -> Surface[]   stable sort by layer; equal layers keep
//     insertion order (declaration order is stacking order, same as the ladder)
//   placeAtCursor(cursorX, cursorY, maxSizeX, viewportX, viewportY, cursorGap, margin,
//     flipAboveY) -> CursorPlacement
//     the cursor-follow placement (from positionCursorFollowPreview): sits cursorGap to
//     the cursor's lower-right, clamped into [margin, viewport - maxSizeX - margin]
//     horizontally; if the surface is wider than that range, its left edge stays at
//     margin; flips above the cursor once cursorY > flipAboveY
// @/cs

export type Surface<View> = { key: string; layer: number; view: View }

export type CursorPlacement =
  | { side: 'below'; left: number; top: number }
  | { side: 'above'; left: number; bottom: number }

// Stable sort by layer — an array producer, outside freerange's subset.
export function orderSurfaces<View>(surfaces: readonly Surface<View>[]): Surface<View>[] {
  return [...surfaces].sort((a, b) => a.layer - b.layer)
}

function clamp(min: number, v: number, max: number) {
  return v > max ? max : v < min ? min : v
}

export function placeAtCursor(
  cursorX: number,
  cursorY: number,
  maxSizeX: number,
  viewportX: number,
  viewportY: number,
  cursorGap: number,
  margin: number,
  flipAboveY: number,
): CursorPlacement {
  console.assert(maxSizeX >= 0)
  console.assert(cursorGap >= 0)
  console.assert(margin >= 0)
  const maxLeft = Math.max(margin, viewportX - maxSizeX - margin)
  const left = clamp(margin, cursorX + cursorGap, maxLeft)
  if (cursorY > flipAboveY) {
    return { side: 'above', left, bottom: viewportY - cursorY + cursorGap }
  }
  return { side: 'below', left, top: cursorY + cursorGap }
}
