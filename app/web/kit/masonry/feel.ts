// @cs
// masonry/feel: the Midjourney feel profile — POLICY constants, distinct from the
// module's geometry (see README "Geometry vs policy"). A new product adopts or replaces
// this profile consciously instead of inheriting buried defaults. Values mirror the
// app's tokens as of 2026-07.
// @/cs
import { masonryMaxHeightRatio, masonryMinHeightRatio } from './core'

export const mjFeel = {
  // card heights clamp to [9/16, 2]x column width (portrait crops via object-cover,
  // landscape floors so wide images don't become slivers) — baked into masonryCardHeight
  minHeightRatio: masonryMinHeightRatio,
  maxHeightRatio: masonryMaxHeightRatio,
  // cull window extension: 2 viewport heights above and below (compositor scroll leads JS)
  occlusionLenienceViewports: 2,
  // infinite scroll triggers within 20 rows of the last in-window tile
  fetchRowsAhead: 20,
} as const
