// @cs
// create/core/gallery: gallery derivations — the entry list (pending first, then the
// queued FIFO newest-enqueued-first so the head (#1, next to start) sits closest to the
// live render, then tiles newest-first; rebuilt each render: derived data is ephemeral)
// and the kit/masonry source over it (one group per entry so emitGroupTop gives
// per-entry anchor reads).
//
// String/JSON domain (union dispatch over entries) — outside freerange's numeric subset;
// gallery.test.ts is the checked surface. All numeric height policy delegates to the kit's
// checked masonryCardHeight.
//
// types:
//   GalleryEntry = { kind: 'pending', pending } | { kind: 'queued', item }
//                | { kind: 'session', tile }
//
// functions:
//   deriveGallery(pending, queue, tiles) -> GalleryEntry[]
//   entryKey(entry) -> 'pending' | item.id | tile.id   identity keys everything; a queued
//     item's id IS its future session id, so the DOM node carries over at start
//   entrySizeX/entrySizeY(entry) -> number             masonry heights come from data
//   makeMasonrySource(entries) -> MasonrySource<GalleryEntry>
// @/cs
import { masonryCardHeight, type MasonrySource } from '@kit/masonry/core'
import type { Pending, QueueItem, Tile } from './model'

export type GalleryEntry =
  | { kind: 'pending'; pending: Pending }
  | { kind: 'queued'; item: QueueItem }
  | { kind: 'session'; tile: Tile }

export function deriveGallery(
  pending: Pending | null,
  queue: readonly QueueItem[],
  tiles: readonly Tile[],
): GalleryEntry[] {
  const entries: GalleryEntry[] = []
  if (pending != null) entries.push({ kind: 'pending', pending })
  for (let i = queue.length - 1; i >= 0; i--) entries.push({ kind: 'queued', item: queue[i]! })
  for (const tile of tiles) entries.push({ kind: 'session', tile })
  return entries
}

export function entryKey(entry: GalleryEntry): string {
  switch (entry.kind) {
    case 'pending':
      return 'pending'
    case 'queued':
      return entry.item.id
    case 'session':
      return entry.tile.id
  }
}

export function entrySizeX(entry: GalleryEntry): number {
  switch (entry.kind) {
    case 'pending':
      return entry.pending.sizeX
    case 'queued':
      return entry.item.sizeX
    case 'session':
      return entry.tile.sizeX
  }
}

export function entrySizeY(entry: GalleryEntry): number {
  switch (entry.kind) {
    case 'pending':
      return entry.pending.sizeY
    case 'queued':
      return entry.item.sizeY
    case 'session':
      return entry.tile.sizeY
  }
}

export function makeMasonrySource(entries: GalleryEntry[]): MasonrySource<GalleryEntry> {
  return {
    groups: entries,
    isGroupHidden: () => false,
    tileCount: () => 1,
    isTileHidden: () => false,
    tileSizeY: (g, _i, colSizeX) => masonryCardHeight(colSizeX, entrySizeX(g), entrySizeY(g)),
  }
}
