import { expect, test } from 'bun:test'
import { orderSurfaces, placeAtCursor } from './core'

test('orderSurfaces sorts by layer, stable within a layer', () => {
  const ordered = orderSurfaces([
    { key: 'tooltip', layer: 3, view: 0 },
    { key: 'menu-a', layer: 2, view: 0 },
    { key: 'menu-b', layer: 2, view: 0 },
    { key: 'sheet', layer: 1, view: 0 },
  ])
  expect(ordered.map((s) => s.key)).toEqual(['sheet', 'menu-a', 'menu-b', 'tooltip'])
})

test('placeAtCursor: below by default, gap offset, horizontal clamp', () => {
  const p = placeAtCursor(100, 100, 240, 1280, 800, 18, 8, 240)
  expect(p).toEqual({ side: 'below', left: 118, top: 118 })
  // near the right edge, the surface clamps inside the margin
  const clamped = placeAtCursor(1270, 100, 240, 1280, 800, 18, 8, 240)
  expect(clamped.side).toBe('below')
  expect(clamped.left).toBe(1280 - 240 - 8)
  // near the left edge, margin floor
  expect(placeAtCursor(-30, 100, 240, 1280, 800, 18, 8, 240).left).toBe(8)
  // if the surface cannot fit, keep its left edge at the margin instead of returning a
  // negative coordinate from an inverted clamp range
  expect(placeAtCursor(100, 100, 400, 320, 800, 18, 8, 240).left).toBe(8)
})

test('placeAtCursor flips above past the threshold, bottom-anchored', () => {
  const p = placeAtCursor(100, 700, 240, 1280, 800, 18, 8, 240)
  expect(p).toEqual({ side: 'above', left: 118, bottom: 800 - 700 + 18 })
})
