// @cs
// create/core/mask: PURE mask-editor geometry (spec §15.7) in freerange's numeric
// subset — pinned in fr-audit.ts. The fit rect itself comes from kit/midui fit at the
// dom surface; this file owns only the pointer->image mapping, the stroke stamp
// interpolation, and the brush clamp. The canvas pixels are dom scratch, never state.
//
// functions:
//   viewToImage(px, py, fitX, fitY, fitSizeX, imgSizeX) -> {x, y}
//     view-space pointer -> image-pixel space; uniform scale (the fit rect preserves
//     the image aspect, so one axis ratio is THE ratio)
//   strokeStamps(fromX, fromY, toX, toY, spacing) -> number[]  flat x,y pairs
//     stamp centers from (exclusive) -> to (inclusive) so fast drags leave no gaps;
//     a zero-length drag yields the single endpoint stamp. Array producer — outside
//     freerange's subset (the masonry uniformColumnFractions precedent); mask.test.ts
//     checks the spacing invariant instead
//   clampBrushSize(raw, minSize, maxSize) -> number
// @/cs

export function viewToImage(
  px: number,
  py: number,
  fitX: number,
  fitY: number,
  fitSizeX: number,
  imgSizeX: number,
): { x: number; y: number } {
  console.assert(fitSizeX > 0)
  console.assert(imgSizeX > 0)
  const scale = imgSizeX / fitSizeX
  return { x: (px - fitX) * scale, y: (py - fitY) * scale }
}

// Caller contract (unverifiable here — array producer, outside the subset): spacing > 0.
export function strokeStamps(fromX: number, fromY: number, toX: number, toY: number, spacing: number): number[] {
  const dx = toX - fromX
  const dy = toY - fromY
  const dist = Math.sqrt(dx * dx + dy * dy)
  const count = Math.max(1, Math.ceil(dist / spacing))
  const out: number[] = []
  for (let i = 1; i <= count; i++) {
    const t = i / count
    out.push(fromX + dx * t)
    out.push(fromY + dy * t)
  }
  return out
}

// Caller contract beyond the leading asserts: minSize <= maxSize (a two-parameter
// relation the analyzable assert form cannot express; feel's constants satisfy it).
export function clampBrushSize(raw: number, minSize: number, maxSize: number): number {
  console.assert(minSize > 0)
  console.assert(maxSize > 0)
  return Math.min(maxSize, Math.max(minSize, raw))
}
