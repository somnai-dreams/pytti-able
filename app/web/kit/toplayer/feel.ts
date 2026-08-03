// @cs
// toplayer/feel: the Midjourney feel profile for cursor-follow placement (placeAtCursor
// args; see README "Geometry vs policy"). Mirrors cursorFollowPreview as of 2026-07.
// @/cs
export const mjFeel = {
  maxSizeX: 240, // preview surface max width
  cursorGap: 18, // offset from the cursor hotspot
  margin: 8, // viewport edge margin
  flipAboveY: 240, // cursor below this line -> surface flips above the cursor
} as const
