// @cs
// reel-strip/feel: the Midjourney feel profile — the swipe/strip POLICY values callers
// pass into the geometry (see README "Geometry vs policy"). swipeThreshold and groupGapY
// hold for both adopted lightboxes; anchorSize/itemSize mirror the JOB lightbox strip
// (MidUI/Layout tokens) — the style lightbox uses viewport-dependent 70/100 sizes with a
// x1.1 anchor morph instead. As of 2026-07; src/kitFeelParity.test.ts pins the mirror.
// The ±2px wheel-noise floor stays a core constant: it calibrates input hardware noise,
// not product feel.
// @/cs
export const mjFeel = {
  // accumulated wheel distance that commits a navigation (swipeStep threshold)
  swipeThreshold: 60,
  // focused thumbnail size vs resting thumbnail size (anchorMorph keeps their sum constant)
  anchorSize: 68,
  itemSize: 56,
  // vertical gap between job groups in the strip
  groupGapY: 8,
} as const
