# @kit/toplayer

Floating UI as data — the design-out for portals-as-architecture. Three pieces:

1. **The Z-ladder pattern** (docs, not machinery — it needs none): one module of
   sequential consts, `let d = 1; export const lightbox = d++; export const
   contextMenu = d++ …` — declaration order IS stacking order, removed slots keep
   incrementing to preserve values. The app's `src/MidUI/Z.ts` is the reference.
2. **The flat surface list**: the store computes `Surface<View>[]` per frame
   (`view` is your payload type, never a framework node); the binding renders
   `orderSurfaces(list)` once at the root. No per-surface portals, no mount gates,
   no selector queries.
3. **`placeAtCursor`** — the pure cursor-follow placement extracted from
   `positionCursorFollowPreview`: gap offset to the cursor's lower-right,
   horizontal viewport clamp with margin, above/below flip past a threshold with
   bottom-anchoring above (so growth doesn't shift the anchored corner). A surface
   wider than the available range keeps its left edge at the margin.

Freerange: 2/3 analyzed at 0 findings (pinned); `orderSurfaces` is the array-sort
exception. The chassis example (`kit/examples/chassis-notes`) uses `placeAtCursor`
(composed with the pointer store and the tooltip machine); the Z-ladder and the
flat surface list are documented patterns whose reference lives app-side.

## Geometry vs policy

Geometry: `placeAtCursor`'s clamp/flip math, `orderSurfaces`. Policy (`feel.ts`
`mjFeel`): 240px surface width, 18px cursor gap, 8px margin, 240px flip line.
