import { describe, expect, test } from 'bun:test'
import { clampBrushSize, strokeStamps, viewToImage } from './mask'

describe('viewToImage', () => {
  test('identity when the image renders at natural size', () => {
    expect(viewToImage(10, 20, 0, 0, 512, 512)).toEqual({ x: 10, y: 20 })
  })
  test('offset + uniform scale (fit preserves aspect, one ratio is THE ratio)', () => {
    // 512px image fitted to 256px at (100, 50): scale 2
    expect(viewToImage(100, 50, 100, 50, 256, 512)).toEqual({ x: 0, y: 0 })
    expect(viewToImage(228, 114, 100, 50, 256, 512)).toEqual({ x: 256, y: 128 })
  })
  test('points left of / above the fit rect map negative (caller clips at the canvas)', () => {
    expect(viewToImage(90, 40, 100, 50, 256, 512)).toEqual({ x: -20, y: -20 })
  })
})

describe('strokeStamps', () => {
  test('zero-length drag -> the single endpoint stamp', () => {
    expect(strokeStamps(5, 5, 5, 5, 12)).toEqual([5, 5])
  })
  test('short drag under one spacing -> one stamp at the endpoint', () => {
    expect(strokeStamps(0, 0, 3, 4, 12)).toEqual([3, 4])
  })
  test('interpolated stamps end exactly at the endpoint, spaced <= spacing', () => {
    const stamps = strokeStamps(0, 0, 30, 40, 12) // dist 50, spacing 12 -> 5 stamps
    expect(stamps.length).toBe(10)
    expect(stamps[8]).toBe(30)
    expect(stamps[9]).toBe(40)
    // every consecutive pair is at most `spacing` apart
    let prevX = 0
    let prevY = 0
    for (let i = 0; i < stamps.length; i += 2) {
      const dx = stamps[i]! - prevX
      const dy = stamps[i + 1]! - prevY
      expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThanOrEqual(12 + 1e-9)
      prevX = stamps[i]!
      prevY = stamps[i + 1]!
    }
  })
  test('the start point is excluded (pointerdown stamps it separately)', () => {
    const stamps = strokeStamps(10, 10, 34, 10, 12)
    expect(stamps[0]).not.toBe(10)
    expect(stamps).toEqual([22, 10, 34, 10])
  })
})

describe('clampBrushSize', () => {
  test('clamps into [min, max]', () => {
    expect(clampBrushSize(4, 8, 160)).toBe(8)
    expect(clampBrushSize(48, 8, 160)).toBe(48)
    expect(clampBrushSize(500, 8, 160)).toBe(160)
  })
})
