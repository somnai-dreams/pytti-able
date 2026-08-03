// @cs
// create/core/gallery: gallery derivations — the entry list (pending first, then tiles
// newest-first, rebuilt each render: derived data is ephemeral) and the kit/masonry
// source over it (one group per entry so emitGroupTop gives per-entry anchor reads).
//
// String/JSON domain (union dispatch over entries) — outside freerange's numeric subset;
// gallery.test.ts is the checked surface. All numeric height policy delegates to the kit's
// checked masonryCardHeight.
//
// types:
//   GalleryEntry = { kind: 'pending', pending } | { kind: 'session', tile }
//
// functions:
//   deriveGallery(pending, tiles) -> GalleryEntry[]
//   entryKey(entry) -> 'pending' | tile.id           tile identity keys everything
//   entrySizeX/entrySizeY(entry) -> number           masonry heights come from data
//   makeMasonrySource(entries) -> MasonrySource<GalleryEntry>
// @/cs
import { masonryCardHeight, type MasonrySource } from '@kit/masonry/core'
import type { Pending, Tile } from './model'

export type GalleryEntry = { kind: 'pending'; pending: Pending } | { kind: 'session'; tile: Tile }

export function deriveGallery(pending: Pending | null, tiles: readonly Tile[]): GalleryEntry[] {
  const entries: GalleryEntry[] = []
  if (pending != null) entries.push({ kind: 'pending', pending })
  for (const tile of tiles) entries.push({ kind: 'session', tile })
  return entries
}

export function entryKey(entry: GalleryEntry): string {
  switch (entry.kind) {
    case 'pending':
      return 'pending'
    case 'session':
      return entry.tile.id
  }
}

export function entrySizeX(entry: GalleryEntry): number {
  switch (entry.kind) {
    case 'pending':
      return entry.pending.sizeX
    case 'session':
      return entry.tile.sizeX
  }
}

export function entrySizeY(entry: GalleryEntry): number {
  switch (entry.kind) {
    case 'pending':
      return entry.pending.sizeY
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
