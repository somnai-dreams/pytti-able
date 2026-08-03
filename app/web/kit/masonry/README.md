# @kit/masonry

Greedy shortest-column masonry packing with occlusion culling, checked card-height
rules, infinite-scroll and scroll-anchoring math — the geometry shared (with drift)
by the app's six packing loops, extracted as one immediate-mode walk that PRESERVES
the original components' execution model: `placeMasonry(source, config, viewport,
emitTile, emitGroupTop?)` drives an accessor view over your own data and delivers
each tile through ONE reused cursor — geometry exists only for the duration of the
emit call, O(columns) allocation per frame, never O(tiles). The `bun kit-bench`
gate holds that contract by sampling live objects inside the walk and proving a
deliberately materializing control crosses the same threshold at 10k tiles.
Scroll position is an input, not state; height policy stays at the surface,
dispatching to the checked `masonryCardHeight`/`masonryStyleCardHeight` rules.

- `core.ts` — `MasonrySource<G>` (group-aware accessor view: a group is one
  generation job), the emit walk `placeMasonry` (with `emitGroupTop` delivering the
  scroll-anchor read inline, where the original loops read `Math.min(...ys)`), and
  the checked scalars: `masonryColumnCount`, `uniformColumnFractions`,
  `columnSizeX`/`columnX`, `masonryCardHeight` (the 9/16..2x clamp)/
  `masonryStyleCardHeight`, `tileVisibility`, `shouldFetchNextPage`,
  `anchorScrollAdjustment`.

Freerange: 11/13 functions fully analyzed at 0 findings (pinned in
`scripts/fr-kit.ts`). The two documented exceptions are `placeMasonry` (the
mutating emit walk) and `uniformColumnFractions` (array producer); their numeric
steps all route through the analyzed helpers. The file is self-contained (local copies of `clamp`/`lessEqual`/
`argMinRounded`, byte-identical with `@kit/midui/num`) because freerange follows
calls only within one file.

Deliberately preserved app behaviors: the float-jitter-stable column tie-break
(compare rounded, place precise), the trailing gap in `contentHeight`, and the
taller-than-viewport visibility quirk (`partiallyVisible`/`fullyVisible` both false
while the card covers the screen). Deliberately parameterized drift: the gap
convention lives in `availableSizeX` (callers differ: `innerX - gap*(cols-1)` vs
`gap*cols`), the column-count policy in `masonryColumnCount` args, corner radius
*policy* stays app-side (`topLeftCorner`/`topRightCorner` flags are provided).

App adoption status: five of six loops run on this module — Explore `Masonry.tsx`,
`CreationMasonry` (whose inline clamp produced NaN heights for 0x0 sources — fixed
by adoption), `userMasonry` (both walks), `moodyMasonry`, and
`rank-aesthetic-scroll` (whose duplicated anchor pre-pass collapsed into reading
placement ys). The `MasonryCardSize.ts` shim is deleted. The holdout is
`StyleMasonry.tsx` (style-explorer): its walk mutates `scrollY.current` MID-WALK
(hotkey-row focus, per-tile anchor adjustments) so later tiles see different
viewport state than earlier ones — a mechanical swap would change that behavior.
Adopt only after untangling its scroll-mutation flow into an explicit
pre-placement step.

## Geometry vs policy

Geometry (always true): the packing loop, column math, visibility bands, anchor
adjustment. Policy (Midjourney's choices, collected in `feel.ts` as `mjFeel`): the
9/16–2x height clamp, the 2-viewport cull lenience, fetch-20-rows-ahead. Policy
also includes two preserved semantics a new product may not want: corner flags go
to the first IN-WINDOW tile per edge column, and a card taller than the viewport
reports neither partially nor fully visible. (One adopter quirk on record:
`moodyMasonry` rounds corners by first-placed ordinal, not the viewport-following
corner flags — pre-existing behavior, preserved verbatim; switching it to the
cursor flags is a pending design call, not a refactor.)

## Alternatives considered (reviewed 2026-07-22 — emit-with-cursor confirmed)

The walk's shape was stress-reviewed against three alternatives; read this before
proposing a reshape.

- **Scalar-args emit** (13 positional params replacing the cursor record): makes
  both retention hazards unrepresentable — including the one poisoning can't
  catch (a closure reading a captured cursor during a LATER emit of the same walk
  sees live values, silently; post-walk reads hit NaN loudly) — but installs a
  silent one: all 8 numeric params are `number`, 28 type-valid transpositions,
  and adopters ignoring fields carry dead positional slots. Named field reads
  beat positional order for this module's consumers. If the capture hazard ever
  fires in practice, the reviewed fallback is a hybrid (record for geometry,
  scalars for booleans), which halves rather than eliminates the hazard surface.
- **Caller-owned SoA buffers** (fill typed arrays, read back in a second pass):
  breaks placement→JSX fusion and fails on the real adopter set —
  rank-aesthetic's early-stopped anchor pre-pass has no fill analog, and
  CreationMasonry's `emitGroupTop` MUTATES scroll-time anchor state that cannot
  move to an offline fill. Measured reality: callback overhead is ~10–20% of the
  0.5ms walk (`argMinRounded`'s per-tile column scan dominates), not the 2x a
  fill promises.
- **Placement/visibility split** (cache placements per data+width, O(log n)
  window queries per scroll frame): the designated escape hatch IF feeds reach
  ~50k tiles, where the walk starts eating real 120Hz budget — and build it as a
  SIBLING module then, keeping this walk for everyone else. Rejected now because
  streaming job arrivals invalidate the cache every few seconds on the busiest
  surface (the win only exists for static feeds), and it is exactly the cache the
  recompute-over-cache doctrine exists to prevent.
