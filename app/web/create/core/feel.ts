// @cs
// create/core/feel: Create-mode POLICY constants — gaps, card sizing, springs, timing,
// strip metrics. Everything the dom layer needs as a number lives here, named, so
// geometry always comes from data (kit doctrine rule 6). Values that adopt a kit
// mjFeel profile unchanged say so; the rest are Create's own calls.
// Constants only — no functions, nothing for freerange to analyze.
// @/cs
import { mjFeel as masonryFeel } from '@kit/masonry/feel'
import { mjFeel as reelFeel } from '@kit/reel-strip/feel'

export const feel = {
  // --- bar / shell
  barTop: 18, // px from viewport top to the bar
  barHeight: 46,
  barMaxX: 680,
  barSidePad: 16, // min gap between bar and viewport edge
  barAreaY: 78, // total fixed band above the gallery scroller (barTop + barHeight + breathing room)

  // --- popover (anchored to the bar's right edge, below the gear — layout data, never measured)
  popoverSizeX: 344,
  popoverGapY: 8,

  // --- gallery masonry
  galleryPadX: 24,
  galleryPadTop: 10,
  gap: 14,
  cardMinX: 220,
  minCols: 2,
  maxCols: 5,
  occlusionLenienceViewports: masonryFeel.occlusionLenienceViewports, // kit mjFeel: 2

  // --- lightbox reel strip (kit reel-strip mjFeel adopted unchanged)
  swipeThreshold: reelFeel.swipeThreshold, // 60
  anchorSize: reelFeel.anchorSize, // 68
  itemSize: reelFeel.itemSize, // 56
  groupGapY: reelFeel.groupGapY, // 8
  stripBandX: 104, // right band reserved for the strip (anchorSize + padding)
  stageMargin: 24, // stage inset from the viewport top/left
  chromeBandY: 148, // bottom band reserved for prompt + params + actions

  // --- springs (midui defaults k=333 b=33 adopted for all reveals)
  springK: 333,
  springB: 33,
  maxSpringStepsPerFrame: 60,

  // --- timing (deadlines as data, consumed by the wake loop)
  toastMs: 4000,
  startingGraceMs: 15000, // queued->starting grace: drop the pending tile if no SSE state claims it

  // --- tile entry animation
  tileEntryRiseY: 8,
} as const
