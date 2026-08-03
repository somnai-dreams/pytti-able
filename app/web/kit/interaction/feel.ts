// @cs
// interaction/feel: the Midjourney feel profile — pill metrics and interaction timing
// (see README "Geometry vs policy"). Mirrors the app's values as of 2026-07
// (PillInteractionContext timing, hoverPillLayout metrics).
// @/cs
const pillHeight = 22

export const mjFeel = {
  // pill cluster metrics (packing + hit rects share these with the renderer)
  metrics: { pillHeight, gap: 4 },
  cornerRadius: pillHeight / 2, // rounded-full — derived, so the two can't diverge
  // how far an acquired interaction bridges the gap BETWEEN pills (hitTestPillGap reach)
  gapReach: 6,
  // pill-block budget: hard pixel ceiling and row cap for tall cards (maxPillRowsForHeight)
  blockMaxPx: 240,
  maxRowsTall: 2,
  // machine timing: eyedropper bridge after leaving a target; tooltip dwell before opening;
  // grace before a warm tooltip cools
  cursorBridgeMs: 200,
  tooltipDwellMs: 200,
  tooltipWarmGraceMs: 2000,
} as const
