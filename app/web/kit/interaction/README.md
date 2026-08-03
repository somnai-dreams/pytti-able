# @kit/interaction

The pointer/pill interaction system's pure core, in two halves:

- `machines.ts` — the cursor-bridge and tooltip dwell/warm/grace state machines,
  extracted **verbatim** from `pillInteractionState.ts` (now a re-export shim; the
  kit owns the tests too). Targets are opaque `{sourceId, ownerId, key}` — zero
  domain coupling. Deadlines are returned as data (`nextDeadline`) so the driving
  loop schedules wake-ups explicitly instead of setTimeout choreography.
  String-domain, so its checked surface is the ported test suite (fr coverage 4/8
  pinned — identity comparisons and switch shapes are outside the numeric subset).
- `geometry.ts` — pill-cluster packing and rounded-rect hit-testing over
  **pre-measured widths** (`number[]`): `packWidths`/`packRowsWithOverflow` (the
  visible/hidden "+N more" split with per-count pre-measured overflow widths),
  `bottomAnchorRects`, `pillRowsHeight`, `maxPillRowsForHeight`, `pillProbe`/
  `hitTestPill`/`hitTestPillGap` (the opposing-vector gap bridge). Text
  measurement (pretext), flag descriptors, and thumbnail policy stay app-side in
  `hoverPillLayout.ts`. 6/9 fr-analyzed at 0 findings; the three array producers
  are documented exceptions.

- `dom.ts` — the browser inputs, generalized: `createPointerStore` (one
  fine-pointer source; disabled wholesale on touch-primary devices so
  compatibility mouse events can't fake hover) and `createHoverBlocker` (the
  re-entrant blocked-hover latch). Both feed `createWakeLoop`
  (`../onestore/core`) as the recheck skeleton. View payloads stay generic —
  never `ReactNode`.

App adoption status: machines fully adopted (shim); `hoverPillLayout.ts`
delegates its packing/hit-test math here. The app's `ClientPointerContext` /
`PointerHoverBlocker` / `PillInteractionContext` still run their own copies of
the dom-layer patterns — adopting them onto `dom.ts` is remaining work.

## Geometry vs policy

Geometry: packing, hit-testing, the machine SHAPES (bridge, dwell/warm/grace).
Policy (`feel.ts` `mjFeel`): pill metrics 22/4, corner radius 11, gap reach 6,
block cap 240px/2 rows, and the timing — 200ms cursor bridge, 200ms tooltip
dwell, 2s warm grace.
