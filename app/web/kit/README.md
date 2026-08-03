# kit/

Headless, copy-portable cores extracted from this codebase. Primary consumer: AI
agents prototyping — here or in a brand-new codebase.

## Hard rules

1. **No module imports from `src/`.** Ever. That rule is what makes a module
   copyable into a fresh codebase wholesale. The app imports the kit (via the
   `@kit/*` alias), never the reverse. Modules may import other kit modules
   (e.g. `@kit/midui`); keep that graph shallow and acyclic.
2. **Three layers, strictly ordered** (files or subdirectories as size demands):
   - **core** — pure TS in freerange's analyzable subset (see below). No DOM, no
     React, no env reads, no `Date.now`, no `Math.random`.
   - **dom** — the browser effects core deliberately excludes: rAF scheduling,
     listeners, measurement, WAAPI, AudioContext. Environment facts (viewport,
     pointer capability, reduced-motion, safe-area) are read here **once** and
     passed into core as plain data.
   - **react** — optional thin binding for this app. Nothing in core/dom may be
     hook-shaped or carry `ReactNode`.
   Core files never import dom/react files.
3. **Freerange subset in core**: named top-level synchronous functions; plain data
   (tagged unions, dense arrays, tuples); explicit branches and loops; no
   spread-copies; no mutation after creation; **no callback parameters in numeric
   functions** — measured values (text widths etc.) enter as `number[]` computed
   at the boundary. `console.assert` caller contracts at function tops; proven
   asserts after. Name a derived divisor before checking it
   (`const span = max - min`), per freerange's `[guard-derived-value]`.
   Deliberate exceptions (e.g. a hot-loop mutating spring stepper) are allowed but
   must be flagged in the file header as outside the analyzable subset. A core whose
   domain is strings/JSON rather than numbers (e.g. versioned-store) is outside
   freerange's scope entirely — it must say so in its header and carry a worked test
   suite as its checked surface instead.
4. **`@cs` spec headers**: every substantial kit source file starts with a
   `// @cs … // @/cs` compressed-spec block — the API summary an agent can
   consume without reading the implementation. Convention from vibescript. The
   specs live beside the code; module READMEs are prose orientation only.
5. **Fail loud.** No silent catches, no defensive `?.` chains, no
   fallback-that-hides-bugs. Parse & validate at boundaries; throw on invariant
   violations. See `docs/engineering.md` (mandatory read).
6. **Design out the React/Next-era patterns** — no hydration guards in core (the
   environment is parsed once at the boundary into `Env` data), no
   portals-as-architecture (floating UI is data: one top-layer list + Z-ladder),
   state keyed by domain identity (never view-tree position), handlers read state
   at event time (no render-scoped closures to go stale), explicit tagged-union
   state machines over effect choreography, geometry from a typed
   content/viewport model rather than DOM measurement round-trips, one store +
   one frame scheduler over provider pyramids.

## Checking

Kit files are covered by the root `tsconfig.json` (strict, noUncheckedIndexedAccess,
exactOptionalPropertyTypes) and `bun check` (tests + tsc + oxlint + fr-kit +
kit-bench). The import-graph halves of rules 1 and 2 (no `src/` imports; core files
don't import react or dom/react layer files) are enforced mechanically by
`kit/kit.test.ts`; the rest of those rules (no env reads / `Date.now` /
`Math.random` in core, data-not-hooks across layers) is review discipline.
`bun fr-kit` runs the freerange audit (`@chenglou/freerange` devDep) over the core
files and pins each file's coverage counts. `bun kit-bench` is the allocation
tripwire: it walks placeMasonry over 10k synthetic tiles for 100 frames and fails
on forced-GC retained-object growth — the emit-style cores must stay allocation-free
per frame. `bun kit-portability` (not in `bun check`; run when kit/ changes)
typechecks a bare copy of `kit/` in an empty temp project against pinned deps to
prove copy-portability. Deliberate freerange subset exceptions are documented in
file headers (see `midui/motion.ts`).

## Examples

`examples/` holds runnable, kit-only consumption tests — pages built from the
modules alone (no `src/`, no CSS framework), written from the `@cs` headers. Run
with `bun kit/examples/<name>/index.html`. If a page can't be written from the
headers alone, the headers are the bug. `grid-gallery` exercises the bricks under
React; `chassis-notes` is the FRAMEWORK-FREE one — env + onestore + interaction +
toplayer composed per the doctrine (13KB bundled vs the React example's ~1MB).

## Modules

- `midui/` — scalar/2D geometry + spring/scheduler kernel, reunified from the
  three drifted copies (the app's 2023 original — now deleted, this module is the
  sole owner — and vibescript's todos variants).
- `virtual-grid/` — uniform-cell grid virtualization (own-scroller and
  ancestor-viewport variants). Sole owner: the `src/` originals were migrated here.
- `versioned-store/` — versioned localStorage persistence + frozen daisy-chained
  migrations (the data-migration contract as machinery; schema-lib-agnostic).
  Extracted from the `src/settings/` pattern; that implementation stays in place.
- `masonry/` — greedy shortest-column packing, checked card-height rules, occlusion
  culling, scroll-anchor math. Adopted by five of the app's six packing loops.
- `reel-strip/` — lightbox film-strip navigation (reel + grid modes, the
  anchor-exemption rule), the wheel-swipe state machine, and anchor-morph geometry.
  Adopted by both desktop lightboxes (`LightboxDesktop`, `styleLightboxGangGang`).
- `interaction/` — the pill-interaction machines (cursor bridge, tooltip
  dwell/warm/grace — sole owner, `src/components/pillInteractionState.ts` is a shim)
  and pill-cluster packing/hit-test geometry over pre-measured widths.
- `history-tree/` — a true branching undo tree: HistoryPath cursor math
  (undo/redo/branch-on-append), tree walkers generic over any `{children: N[]}`
  node. Sole owner of the path machinery — `src/sessiontree.ts` is a shim.
- `chip-query/` — the structured-search numeric mini-language (`>500`, ranges,
  `NumericComparison`) + ratio matching helpers. Sole owner — `searchChips.ts`
  delegates. The registry-parameterized parse/stringify layer is future work.
- `onestore/` — the single-store render-loop chassis: rAF-coalesced
  `scheduleRender`, synchronous `renderNow` (the controlled-input answer),
  snapshot channels for per-frame input, and the deadline-driven wake loop
  (timing machines return deadlines as data). Deliberately not a framework.
- `env/` — the environment snapshot: viewport, pointer capability, reduced
  motion, safe-area insets — read once at the boundary (`dom.ts`, one listener
  set, documented CSS-var contract for safe areas), passed everywhere as data.
- `toplayer/` — floating UI as data: one flat surface list ordered by a Z-ladder
  (declaration order is stacking order) plus the pure cursor-follow placement.
  No portals-as-architecture.

## Remaining work

The surveyed tier-3 extractions were deliberately deferred; each has a documented
trap that makes it non-mechanical. Reassess them together when their surfaces are
next worked on:

- **louter** (router machinery; the app owns the route union): parsing is
  settings-dependent, so the codec needs an explicit parse context;
  history.state payloads need full-schema freshness validation.
- **media** (load-set reconcile, bitmap cache, decode-swap machine): parity rests
  on undocumented browser semantics (`removeAttribute('src')` aborts loads,
  206-stream cancel) with zero tests — write characterization tests FIRST. The
  blob-URL registry stays an app-wide singleton.
- **dnd** (payload layer only): the app's `Bucket` conflates picker category with
  tray role — needs a `PickerCategory`/`TrayRole` split; part of drop priority is
  CSS-implemented; `handleText` may not change observable prompt parsing in a
  refactor (client parse mirrors the backend).
- **Mobile lightbox** onto `reel-strip`: blocked on a behavior call — mobile
  keeps its reel anchor in state, desktop keeps it in the route.
- **StyleMasonry**: parked until style-explorer work resumes (untangle plan
  above in `masonry/README.md`'s adoption notes).
- **Editor shells** (`editorGangGang` and friends) still inline the history-tree
  cursor math — adopt-or-inventory call pending.
- **`fr --layout` contracts**: blocked on freerange's `cagedRange` branch
  publishing; numeric-only until then.
- **CI**: `bun check` (fr-kit + kit-bench) runs on PRs; `bun kit-portability` is
  manual — wiring it into CI is an open call. A kit repo split is proven possible
  by the portability gate; timing is a product decision.

`session-minimap` is skipped on this branch — the minimap only exists on its
unpushed feature branch. The sound system was cut from the kit by user decision
and stays app-only.
