// @cs
// midui/num: scalar + 2D geometry kernel. Pure, no DOM, freerange-analyzable.
//
// types:
//   Vec2 = {x, y}, Vec3 = {x, y, z}, Vec4 = {x, y, z, w}; vec2/vec3/vec4 constructors
//   Rect = {left, top, right, bottom} (corner-based)
//
// math:
//   clamp(min, v, max)
//   remap(value, oldMin, oldMax, newMin, newMax) -> linear remap, degenerate span -> new midpoint
//   remapReverso(value, oldMin, oldMax, newMin, newMax) -> inverse remap (value in NEW space)
//   mix(x, y, a) -> lerp, GLSL argument order
//   fract(x) -> x - floor(x)
//   easeOutQuad(x), easeOutQuart(x)
//   rem(x) -> x * 16 (CSS rem to px at default root font size)
//   minIndex(arr) -> index of smallest element (0 for empty)
//   argMinRounded(arr) -> minIndex with values rounded to 2 decimals first (float-jitter stable)
//
// geometry:
//   center(containee, container, insetStart=0, insetEnd=0) -> centered start position
//   fit(aspectRatio, containerSizeX, containerSizeY) -> fitted sizeX (get sizeY as sizeX / ar)
//   length(x, y) -> euclidean length
//   lessEqual(a, b, c) -> a <= b && b <= c
//   insideInclusive(px, py, rectX, rectY, sizeX, sizeY) -> point in size-based rect
//   overlapInclusive(x1,y1,w1,h1, x2,y2,w2,h2) -> size-based rect-rect overlap test
//   overlapArea(a: Rect, b: Rect) -> overlapped area (0 when disjoint)
//
// hash (deterministic, fract-based, from shadertoy 4djSRW):
//   requires 0 <= p <= 2^24 (checked contract — float precision degrades hash quality past it)
//   hash11(p) -> number in [0,1)
//   hash21(p) -> Vec2, each component in [0,1)
//   hash31(p) -> Vec3, each component in [0,1)
// @/cs

export type Vec2 = { x: number, y: number }
export type Vec3 = { x: number, y: number, z: number }
export type Vec4 = { x: number, y: number, z: number, w: number }

export function vec2(x: number, y: number): Vec2 {
  return { x, y }
}
export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z }
}
export function vec4(x: number, y: number, z: number, w: number): Vec4 {
  return { x, y, z, w }
}

export type Rect = { left: number, top: number, right: number, bottom: number }

// === GLSL equivalents
export function clamp(min: number, v: number, max: number) {
  return v > max ? max : v < min ? min : v
}

export function clampPercent(value: number) {
  if (Number.isNaN(value)) return 0
  const percent = clamp(0, value, 100)
  console.assert(percent >= 0)
  console.assert(percent <= 100)
  return percent
}
export function mix(x: number, y: number, a: number): number {
  return x * (1 - a) + y * a
}
export function fract(x: number) {
  return x - Math.floor(x)
}
// Written as multiplications, not `(1 - x) ** 2`: the exponent operator is outside
// freerange's analyzable subset.
export function easeOutQuad(x: number): number {
  const inv = 1 - x
  return 1 - inv * inv
}
export function easeOutQuart(x: number): number {
  const inv = 1 - x
  const inv2 = inv * inv
  return 1 - inv2 * inv2
}
// ===

// The divisor is named before it's checked so freerange can prove the division safe
// ([guard-derived-value]); a degenerate source span maps to the new range's midpoint.
export function remap(value: number, oldMin: number, oldMax: number, newMin: number, newMax: number): number {
  const oldSpan = oldMax - oldMin
  if (oldSpan === 0) return (newMin + newMax) / 2
  return (value - oldMin) / oldSpan * (newMax - newMin) + newMin
}

// Inverse of remap: value lives in the NEW range, result in the old one.
export function remapReverso(value: number, oldMin: number, oldMax: number, newMin: number, newMax: number): number {
  const newSpan = newMax - newMin
  if (newSpan === 0) return (oldMin + oldMax) / 2
  return (value - newMin) / newSpan * (oldMax - oldMin) + oldMin
}

export function rem(x: number) {
  return x * 16
}

export function center(containee: number, container: number, containerInsetStart = 0, containerInsetEnd = 0) {
  // assuming container size already includes containerInsetStart and containerInsetEnd
  return containerInsetStart + (container - containerInsetStart - containerInsetEnd - containee) / 2
}

export function fit(ar: number, containerSizeX: number, containerSizeY: number) {
  // returns max size x that fits in the container without changing aspect ratio
  return Math.min(containerSizeX, containerSizeY * ar) // get fitted sizeY with sizeX / ar
}

export function length(x: number, y: number) {
  return Math.sqrt(x * x + y * y)
}

export function lessEqual(a: number, b: number, c: number) {
  return a <= b && b <= c
}

export function insideInclusive(
  x1: number, y1: number,
  x2: number, y2: number, sizeX: number, sizeY: number,
) {
  return x2 <= x1 && x1 <= x2 + sizeX && y2 <= y1 && y1 <= y2 + sizeY
}

export function overlapInclusive(
  x1: number, y1: number, sizeX1: number, sizeY1: number,
  x2: number, y2: number, sizeX2: number, sizeY2: number,
) {
  return x1 <= x2 + sizeX2 && x2 <= x1 + sizeX1 && y1 <= y2 + sizeY2 && y2 <= y1 + sizeY1
}

// returns the overlapped area size, 0 when disjoint
export function overlapArea(a: Rect, b: Rect): number {
  const left = Math.max(a.left, b.left)
  const right = Math.min(a.right, b.right)
  const top = Math.max(a.top, b.top)
  const bottom = Math.min(a.bottom, b.bottom)

  if (right > left && bottom > top) return (right - left) * (bottom - top)
  return 0
}

export function minIndex(arr: number[]) {
  let min = Infinity
  let minIndex = 0
  for (let i = 0; i < arr.length; i++) {
    const value = arr[i]!
    if (value < min) {
      minIndex = i
      min = value
    }
  }
  return minIndex
}

// Index of the smallest value, with values rounded to 2 decimal places before comparing.
// Avoids floating-point jitter causing e.g. masonry columns at nearly-equal heights to
// swap order across recomputes.
export function argMinRounded(arr: number[]) {
  let min = Infinity
  let minIndex = 0
  for (let i = 0; i < arr.length; i++) {
    const value = Math.round(arr[i]! * 100)
    if (value < min) {
      min = value
      minIndex = i
    }
  }
  return minIndex
}

// https://www.shadertoy.com/view/4djSRW
export function hash11(p: number): number {
  console.assert(p >= 0)
  console.assert(p <= 16777216)
  p = fract(p * 0.1031)
  p *= p + 33.33
  p *= p + p
  return fract(p)
}

export function hash21(p: number): Vec2 {
  console.assert(p >= 0)
  console.assert(p <= 16777216)
  const p3x = fract(p * 0.1031)
  const p3y = fract(p * 0.103)
  const p3z = fract(p * 0.0973)

  const dot = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33)

  const px = p3x + dot
  const py = p3y + dot
  const pz = p3z + dot

  return {
    x: fract((px + py) * pz),
    y: fract((px + pz) * py),
  }
}

export function hash31(p: number): Vec3 {
  console.assert(p >= 0)
  console.assert(p <= 16777216)
  const p3x = fract(p * 0.1031)
  const p3y = fract(p * 0.103)
  const p3z = fract(p * 0.0973)

  const dot = p3x * (p3y + 33.33) + p3y * (p3z + 33.33) + p3z * (p3x + 33.33)

  const px = p3x + dot
  const py = p3y + dot
  const pz = p3z + dot

  return {
    x: fract((px + py) * pz),
    y: fract((px + pz) * py),
    z: fract((py + pz) * px),
  }
}
