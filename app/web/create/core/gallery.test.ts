import { describe, expect, test } from 'bun:test'
import { masonryCardHeight, placeMasonry, uniformColumnFractions } from '@kit/masonry/core'
import { deriveGallery, entryKey, entrySizeX, entrySizeY, makeMasonrySource } from './gallery'
import type { Pending, QueueItem, Tile } from './model'

function tile(id: string, sizeX = 512, sizeY = 512): Tile {
  return {
    id, slug: id, scenes: 'p', state: 'done', seed: 1, startedAt: 0, endedAt: 1,
    frames: 5, stepsDone: 1, stepsTotal: 1, sizeX, sizeY, legacyDims: false,
    forkedFrom: null, imported: false, artifacts: [], failExcerpt: null, live: null, detail: null,
  }
}

function item(id: string, position: number, sizeX = 512, sizeY = 512): QueueItem {
  return { id, position, prompt: 'queued ' + id, sizeX, sizeY }
}

const pending: Pending = { kind: 'posting', prompt: 'p', sizeX: 640, sizeY: 360 }

describe('deriveGallery', () => {
  test('pending first, queue newest-enqueued-first (head #1 last), then tiles', () => {
    const entries = deriveGallery(pending, [item('q1', 1), item('q2', 2)], [tile('a'), tile('b')])
    expect(entries.map(entryKey)).toEqual(['pending', 'q2', 'q1', 'a', 'b'])
  })
  test('no pending, empty queue -> sessions only', () => {
    expect(deriveGallery(null, [], [tile('a')]).map(entryKey)).toEqual(['a'])
  })
  test('queue without pending derives queued entries directly', () => {
    const entries = deriveGallery(null, [item('q1', 1)], [])
    expect(entries).toEqual([{ kind: 'queued', item: item('q1', 1) }])
  })
})

describe('entry accessors', () => {
  test('sizes come from data for all three kinds', () => {
    const [p, q, s] = deriveGallery(pending, [item('q1', 1, 320, 180)], [tile('a', 448, 576)])
    expect(entrySizeX(p!)).toBe(640)
    expect(entrySizeY(p!)).toBe(360)
    expect(entrySizeX(q!)).toBe(320)
    expect(entrySizeY(q!)).toBe(180)
    expect(entrySizeX(s!)).toBe(448)
    expect(entrySizeY(s!)).toBe(576)
  })
})

describe('makeMasonrySource', () => {
  test('one group per entry, one tile per group, kit card-height rule', () => {
    const entries = deriveGallery(pending, [item('q1', 1, 320, 180)], [tile('a', 448, 576)])
    const source = makeMasonrySource(entries)
    expect(source.groups).toHaveLength(3)
    expect(source.tileCount(entries[0]!)).toBe(1)
    expect(source.tileSizeY(entries[0]!, 0, 280)).toBe(masonryCardHeight(280, 640, 360))
    expect(source.tileSizeY(entries[1]!, 0, 280)).toBe(masonryCardHeight(280, 320, 180))
    expect(source.tileSizeY(entries[2]!, 0, 280)).toBe(masonryCardHeight(280, 448, 576))
  })

  test('drives a full placeMasonry walk (integration smoke)', () => {
    const entries = deriveGallery(pending, [item('q1', 1)], [tile('a'), tile('b'), tile('c')])
    const emitted: string[] = []
    const result = placeMasonry(
      makeMasonrySource(entries),
      { colFractions: uniformColumnFractions(3), availableSizeX: 900, originX: 0, contentTop: 0, gap: 14 },
      { scrollTop: 0, sizeY: 800, lenienceY: 1600 },
      (cursor) => {
        emitted.push(entryKey(entries[cursor.groupIndex]!))
      },
    )
    expect(emitted).toEqual(['pending', 'q1', 'a', 'b', 'c'])
    expect(result.placedTileCount).toBe(5)
    expect(result.contentHeight).toBeGreaterThan(0)
  })
})
